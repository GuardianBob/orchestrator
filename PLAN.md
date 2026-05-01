# Orchestrator — Generic Shard-Library Integration Plan

> **Status:** Proposed. 2026-05-01.
> **Goal:** Make the orchestrator a first-class consumer of any plugin that follows the `gen-tasklist`-style **sharded library pattern** (`.{plugin}/items/{ID}.json` shards + `INDEX.json` materialized view + `{plugin}-rebuild` CLI). Today the orchestrator can **read** `.tasks/INDEX.json` but never writes back, causing silent infinite-loops on re-runs. After this plan: write-back is generic, multi-library, and supports task→issue linkage.
> **Source documents:** `FEAT_FIXES.md`, `issues-orchestrator-task-break.md`, `issues-plugin/.docs/00_OVERVIEW.md`, `tasklist-plugin/README.md`.

---

## 1. Problem Statement

### 1a. The immediate bug
The orchestrator's read path (`resolve-tasks.mjs`) correctly parses `.tasks/INDEX.json` and emits open task IDs. But the write-back path is missing entirely:

- **Pre-build:** shard status never flips from `backlog` → `in-progress`. No `started` timestamp set.
- **Post-merge:** shard status never flips to `done`. No `completed` timestamp. No `notes` entry. `tasklist-rebuild` never invoked.
- **Result:** `INDEX.json` continues to list completed tasks under `open_tasks`. Next `/orchestrate sprint-N` resolves the same task again → dispatches builders → re-merges already-merged code → silent infinite loop.

### 1b. The bigger gap
`issues-plugin` (`gen-issues`) is being built with the **same shard library pattern** as `gen-tasklist`. Future plugins will follow it too. The orchestrator should not hardcode `.tasks/` knowledge — it should treat any shard library that declares itself in `.orchestrator.json` as a writable consumer surface.

### 1c. Linkage requirement
A task that fixes an issue must close the issue automatically post-merge. Today, no linkage between libraries exists.

---

## 2. Solution Overview

Three layered changes:

1. **New `shard-library.mjs` helper module** — single source of truth for: locate shard, atomic write, status-flow inference (with config override), invoke rebuild CLI (with resilience), scan for cross-library links. Pure module, no side effects on import.
2. **Multi-library config** — `.orchestrator.json` gains a `shardLibraries[]` array. One library marked `primary: true` (drives resolution + dispatch). Others are "linked libraries" — only written when a task references them. Backward compat: synthesize from legacy `tasksSource.primary` if `shardLibraries` absent.
3. **Three orchestrator-script integrations** — `branch-setup.mjs` flips primary shard `in-progress` (with user prompt on collision). `merge-task.mjs` flips primary shard `done` AND closes any linked library shards (issues, etc.) referenced by `resolves` field or keyword scan. Both use `shard-library.mjs` for all I/O.

---

## 3. Architecture

### 3a. `shard-library.mjs` — public API

```js
// Locate a shard file under a library by ID.
// Returns absolute path or null if not found.
export function locateShard(library, id) { ... }

// Atomic read → mutate → write. Mutator is `(shard) => updatedShard`.
// Throws on schema violation, missing file, or write failure.
export function updateShard(library, id, mutator) { ... }

// Resolve the start/done status values for a library.
// 1. If library.statusMap is set in config → use it.
// 2. Else load library.schemaPath (or default <indexPath dir>/schemas/<shardKind>.schema.json),
//    extract status enum, run heuristic regex match.
// 3. If heuristic returns exactly one match per role → cache + return.
// 4. If 0 or >1 matches → throw with actionable error pointing user to set statusMap.
export function resolveStatusVocab(library) { ... }

// Run library.rebuildCmd via execSync. On non-zero exit, emit stderr warning,
// suggest install command, return { ok: false, reason }. Never throws.
export function rebuildLibrary(library) { ... }

// Scan a task shard for linked-library references.
// Checks shard[library.linkField] (if defined) AND keyword regex
// (Fixes/Resolves/Closes <ID>) across description + notes.
// Returns Map<libraryId, Set<shardId>>.
export function scanLinks(taskShard, allLibraries) { ... }

// Load shardLibraries from .orchestrator.json. If absent, synthesize
// single-entry array from legacy tasksSource.primary. Validate shape.
export function loadLibraries(configPath) { ... }
```

### 3b. Status vocabulary inference (Q3=C)

Heuristic regex applied to status enum values from `<library>/schemas/<kind>.schema.json`:

| Role | Regex (case-insensitive) | Matches in gen-tasklist | Matches in gen-issues |
|---|---|---|---|
| `start` | `/^(in[-_]?progress\|active\|started\|wip)$/i` | `in-progress` ✓ | `in-progress` ✓ |
| `done`  | `/^(done\|completed?\|closed\|resolved\|fixed)$/i` | `done` ✓ | `resolved` or `closed` (depends on enum) |

Fallback: if 0 or >1 matches per role, **throw with actionable error** instructing user to set `statusMap` in `.orchestrator.json` for that library. Per-library cache so we only do schema parse once per orchestrator run.

### 3c. Cross-library link detection (Q7=C)

For each task being closed, scan against **all non-primary libraries**:

1. **Explicit field:** if `taskShard[library.linkField]` exists (e.g., `resolves: ["ISSUE-042", "ISSUE-073"]`), parse as array of IDs.
2. **Keyword scan:** regex over `description + notes + git commit body`:
   `/\b(fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+(ISSUE|TASK|BUG|FEAT)-\d+/gi`
   ID prefix must match a known library's shard naming convention.
3. **Union the results.** Validate each linked ID exists in target library's INDEX. Skip + warn on unknown IDs.

For each linked shard: `updateShard(linkedLib, linkedId, ...)` to flip its done status, append `resolved_by: TASK-NNN @ <merge-sha>` to its notes, then `rebuildLibrary(linkedLib)`.

### 3d. Multi-library config shape (Q8)

```json
{
  "shardLibraries": [
    {
      "id": "tasks",
      "indexPath": ".tasks/INDEX.json",
      "shardDir": ".tasks/tasks",
      "shardIdField": "id",
      "rebuildCmd": "npx tasklist-rebuild",
      "primary": true,
      "statusMap": null,
      "schemaPath": ".tasks/schemas/task.schema.json",
      "linkField": "resolves"
    },
    {
      "id": "issues",
      "indexPath": ".issues/INDEX.json",
      "shardDir": ".issues/issues",
      "shardIdField": "id",
      "rebuildCmd": "npx gen-issues-rebuild",
      "primary": false,
      "statusMap": null,
      "schemaPath": ".issues/schemas/issue.schema.json",
      "linkField": null
    }
  ]
}
```

**Backward-compat synthesizer:** if `shardLibraries` is absent and `tasksSource.primary` ends in `.json`, build a single-entry array with sensible defaults (`shardDir` = `<indexDir>/tasks`, `rebuildCmd` = `npx tasklist-rebuild`, `primary: true`). Old configs keep working without edits.

### 3e. Pre-build collision prompt (Q4)

When `branch-setup.mjs` finds the shard already at `in-progress` or `done`:

1. Call `notify.mjs` with title `"Task <id> not in startable state"` and structured payload.
2. Use the existing `question` tool / agent prompt mechanism (same path as `review-sprint.mjs`) to ask the user:
   - **Resume** — keep current `started` timestamp, proceed to builder dispatch.
   - **Restart** — overwrite `started` to now, append a `notes` entry `"Restarted by orchestrator on <date>"`.
   - **Abandon** — exit non-zero, do not dispatch builders.
3. No prompt = no dispatch. Default if user is non-interactive: hard-refuse (matches FEAT_FIXES.md original behavior).

---

## 4. File-Level Changes

| File | Change Type | Purpose |
|---|---|---|
| `scripts/shard-library.mjs` | **NEW** (~250 lines) | Generic helper. All shard I/O routes through this. |
| `scripts/branch-setup.mjs` | MODIFY | After branch creation, locate primary-library shard for task, flip `in-progress` (with collision prompt), set `started`, atomic write, rebuild. |
| `scripts/merge-task.mjs` | MODIFY | After `git merge` succeeds, flip primary shard `done` + `completed` + notes entry. Then scan for cross-library links and close those too. Then rebuild all touched libraries. Then commit `.tasks/` + `.issues/` deltas onto sprint branch. |
| `scripts/load-config.mjs` | MODIFY | Parse + validate `shardLibraries[]`. Synthesize from legacy `tasksSource.primary` if absent. |
| `scripts/resolve-tasks.mjs` | MODIFY (small) | Switch from hardcoded `parseTasklistIndex` to `loadLibraries()` + iterate primary. Behavior unchanged for default case. |
| `tests/fixtures/tasks-fixture/` | **NEW** | Mock `.tasks/` dir with INDEX, schema, sample shards (backlog, in-progress, done states). |
| `tests/fixtures/issues-fixture/` | **NEW** | Mock `.issues/` dir mirroring same structure with issue vocabulary. |
| `tests/shard-library.test.mjs` | **NEW** | Unit tests for every public API in §3a. |
| `tests/integration/branch-setup.test.mjs` | **NEW** | End-to-end: fixture project → branch-setup → assert shard + INDEX state. |
| `tests/integration/merge-task.test.mjs` | **NEW** | End-to-end: task that resolves issue → merge-task → assert both shards updated. |
| `skill/SKILL.md` | MODIFY | New §"Shard Library Integration" — config shape, status inference rules, link detection, troubleshooting. |
| `README.md` | MODIFY | Update feature list + Quickstart to mention multi-library support. |
| `commands/*.md` | MODIFY (audit) | Update slash-command help text where behavior changed (likely `/orchestrate`, `/merge-task`). |
| `package.json` | MODIFY | Add `vitest` devDep + test scripts. Engines `>=20`. |
| `vitest.config.mjs` | **NEW** | Test runner config. Coverage threshold scripts/ ≥ 80%, lib/ ≥ 90%. |

**Estimated effort:** 600–800 lines of code + 400–500 lines of tests + doc updates. ~2–3 days.

---

## 5. Phased Execution

### Phase A — Foundation (no behavior change yet)
A1. Create `scripts/shard-library.mjs` with all six exported functions + JSDoc.
A2. Wire vitest. Create test fixtures for `.tasks/` and `.issues/`.
A3. Unit tests for `shard-library.mjs` — every public API, every error path.
A4. Modify `load-config.mjs` to parse `shardLibraries[]` + backward-compat synthesizer. Tests.
A5. Modify `resolve-tasks.mjs` to use `loadLibraries()`. Existing behavior preserved. Regression test.

**Exit criterion:** Phase A merges with all existing orchestrator runs working unchanged. New helper module exists but no orchestrator script calls it yet.

### Phase B — Pre-build write-back (Fix 1 + 3 + 4)
B1. Integrate `shard-library.mjs` into `branch-setup.mjs`. Add status flip + `started` timestamp + atomic write.
B2. Add collision-detection prompt (Q4) — resume / restart / abandon flow.
B3. Wrap `rebuildLibrary` call with resilience (Fix 3) — non-zero exit emits warning, doesn't fail orchestrator.
B4. Integration test: `branch-setup` against fixture project → assert shard status, started, INDEX, rebuild called.

**Exit criterion:** `/orchestrate sprint-N` correctly flips first task to `in-progress` before builders dispatch. Resume/restart/abandon prompt works.

### Phase C — Post-merge close (Fix 2)
C1. Integrate `shard-library.mjs` into `merge-task.mjs`. After git merge success: flip primary shard `done` + `completed` + notes entry with sprint branch + merge SHA.
C2. Scan task for cross-library links (Q7=C — explicit `resolves` field + keyword regex).
C3. For each linked library shard: flip done status, append `resolved_by` notes entry, rebuild.
C4. Stage + commit `.tasks/` AND `.issues/` deltas onto the sprint branch in a single follow-up commit.
C5. Integration test: task with `Resolves ISSUE-042` in description → merge-task → both shards transition correctly.

**Exit criterion:** Re-running `/orchestrate sprint-N` after a successful task closes resolves to **0 tasks** for that task (silent infinite loop fixed). Linked issues marked resolved.

### Phase D — Documentation + Live acceptance (Q5=C + Q6)
D1. Rewrite `skill/SKILL.md` §"Configuration reference" with new config shape + examples. Add §"Shard Library Integration" with status inference rules, link detection, troubleshooting.
D2. Update `README.md` feature list + Quickstart.
D3. Audit `commands/*.md` — update help text wherever behavior changed.
D4. Live acceptance: run the 5-step `FEAT_FIXES.md` test against `issues-plugin` sprint-4. Capture output.
D5. If acceptance passes, tag release. If anything fails, fix forward + re-test.

**Exit criterion:** Live `/orchestrate sprint-4` against `issues-plugin` completes TASK-001 + TASK-002, both marked `done` in shards, no double-build on re-run.

---

## 6. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Status inference picks wrong enum value silently | Medium | Heuristic requires **exactly one match per role**. 0 or >1 → throw with actionable error pointing at `statusMap` config. Cache per-run to surface error once, not per-task. |
| Plugin schema absent or malformed | Medium | If `schemaPath` missing → fall back to checking `library.statusMap`. If both missing → hard error with message `"Cannot determine status vocab for library '<id>'. Set statusMap in .orchestrator.json or provide schemaPath."` |
| `tasklist-rebuild` / `gen-issues-rebuild` not installed | High in dev | Resilience wrapper (Fix 3) — warn but don't fail. Shard write is source of truth. User can rebuild manually. |
| Cross-library link points at non-existent ID (typo in `resolves`) | Medium | Validate against target library's INDEX before mutating. Skip + warn on unknown. Surface in merge commit message. |
| Backward-compat synthesizer produces wrong defaults for unusual layouts | Low | Synthesizer logs the synthesized config at debug level. Users see exactly what was assumed. Easy to override by adding explicit `shardLibraries[]`. |
| Atomic write fails mid-sprint (disk full, permission) | Low | `.tmp + rename` pattern is atomic on POSIX + Windows NTFS. Failure throws before INDEX rebuild — no partial state. |
| Concurrent orchestrator runs collide on shard | Low | Out of scope for this plan. Document in SKILL.md that orchestrator is single-instance per repo. Future work: file lock under `.orchestrator/lock`. |
| Test fixtures drift from real plugin schemas | Medium | Fixture schemas copied verbatim from `gen-tasklist` + `gen-issues` source. CI step (future) to diff fixture schemas against upstream. |

---

## 7. Out of Scope

- **Auto-task creation from review findings** — separate orchestrator feature, deferred.
- **Living-docs ordering changes** — explicitly excluded by FEAT_FIXES.md "Out of scope".
- **Dependency checks before task dispatch** (`depends_on` field) — separate task; this plan only handles status + linkage.
- **Concurrent orchestrator instance locking** — see Risk table.
- **Automatic plugin discovery** (no need to declare in config; auto-detect `.{anything}/INDEX.json`) — explicitly rejected for safety. Plugins must be opt-in via config.
- **Living docs for the orchestrator project itself** — per Q6, skipped.

---

## 8. Acceptance Criteria

### 8a. Unit (Phase A–C)
- [ ] `vitest run` exits 0 with ≥80% coverage on `scripts/`, ≥90% on new helper module.
- [ ] All public API functions in `shard-library.mjs` have positive + negative tests.
- [ ] `loadLibraries()` correctly synthesizes from legacy config + emits warning.
- [ ] Status inference heuristic matches gen-tasklist `in-progress`/`done` and gen-issues `in-progress`/`resolved` without explicit `statusMap`.
- [ ] Status inference throws actionable error on ambiguous enums.

### 8b. Integration (Phase B–C)
- [ ] `branch-setup` against fixture flips shard to `in-progress`, sets `started`, runs rebuild, INDEX reflects change.
- [ ] Collision prompt fires when shard is already `in-progress`. Resume/restart/abandon all behave correctly.
- [ ] `merge-task` against fixture flips shard `done`, sets `completed`, appends notes with merge SHA.
- [ ] Task with `Resolves ISSUE-042` → ISSUE-042 transitions to `resolved` AND gets `resolved_by` notes entry.
- [ ] Both `.tasks/` AND `.issues/` deltas committed in single follow-up commit on sprint branch.

### 8c. Live (Phase D — FEAT_FIXES.md acceptance test)
- [ ] `git checkout main && git branch -D sprint-4` (clean slate against `issues-plugin`).
- [ ] `/orchestrate sprint-4` completes TASK-001 and TASK-002.
- [ ] `cat .tasks/tasks/TASK-001.json` shows `"status": "done"`, `started` + `completed` timestamps, `notes` entry with merge SHA.
- [ ] `jq '.open_tasks | map(.id)' .tasks/INDEX.json` no longer contains `TASK-001` or `TASK-002`.
- [ ] Re-running `/orchestrate sprint-4` resolves to **0 tasks** and stops cleanly.
- [ ] If TASK-001 or TASK-002 happens to reference an ISSUE-NNN, that issue's shard is also marked closed.

---

## 9. Decision Log

| Q | Decision | Rationale |
|---|---|---|
| Q1 | (B) Generalize now via `shardLibraries[]` config | Future plugins follow same pattern; one-shot design avoids retrofit. |
| Q2 | Orchestrator flips issue status too | Closes the loop — task done = referenced bug resolved automatically. |
| Q3 | (C) Inference with config override | Zero-config for well-named schemas; explicit fallback when ambiguous. |
| Q4 | Prompt user (resume / restart / abandon) | Friendly on resume; hard-refuse only as non-interactive default. |
| Q5 | (C) Both unit + live acceptance | Helper drives every plugin — must be unit-tested. Live run is the FEAT_FIXES.md gate. |
| Q6 | Update SKILL.md, README.md, commands/. Skip orchestrator living docs. | User-facing surfaces only. |
| Q7 | (C) Explicit `resolves` field + keyword scan | Hybrid mirrors GitHub convention while supporting machine-checkable explicit declarations. |
| Q8 | Confirmed config shape | Backward-compat synthesizer keeps old configs working. |
