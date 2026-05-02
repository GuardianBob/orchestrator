# Task Breakdown — Generic Shard-Library Integration

> Companion to `PLAN.md`. 22 tasks across 4 phases. Each task is sized XS–M, has explicit acceptance criteria, and is shaped to feed straight into `tasklist-add --stdin`.
> Sprint mapping: Phase A → sprint-shard-A, Phase B → sprint-shard-B, Phase C → sprint-shard-C, Phase D → sprint-shard-D.
> Dependency notation: `← TASK-N` means depends on TASK-N completing first.

---

## Sprint 1 — Foundation (no behavior change)

### TASK-001 — Bootstrap test infrastructure (vitest)
**Priority:** high · **Effort:** S · **Tags:** foundation, sprint-shard-a, testing
**Depends on:** none

**Description:**
Add `vitest` as a devDependency. Create `vitest.config.mjs` with `testMatch: ["tests/**/*.test.mjs"]`, coverage thresholds `scripts/ >= 80%`, `lib/ >= 90%` (when `lib/` exists). Add npm scripts: `test`, `test:watch`, `test:coverage`. Update `package.json` `engines.node >= 20`. Verify `npx vitest run` exits 0 on empty test set.

**Acceptance Criteria:**
- `npx vitest run` exits 0 (no tests yet, no failure)
- `npm test` is wired to `vitest run`
- `package.json` engines.node is `>=20`
- `vitest.config.mjs` is valid ESM (no CJS require)

---

### TASK-002 — Create test fixtures for `.tasks/` and `.issues/`
**Priority:** high · **Effort:** S · **Tags:** foundation, sprint-shard-a, testing
**Depends on:** TASK-001

**Description:**
Create `tests/fixtures/tasks-fixture/.tasks/` with: `INDEX.json` (3 sample tasks: backlog, in-progress, done), `tasks/TASK-001.json` through `TASK-003.json`, `schemas/task.schema.json` copied verbatim from `gen-tasklist`, `config.json`. Mirror under `tests/fixtures/issues-fixture/.issues/` with issue vocabulary (`open` / `in-progress` / `resolved`) and a sample issue. Document fixture provenance in `tests/fixtures/README.md`.

**Acceptance Criteria:**
- Both fixture directories validate against their respective schemas via ajv
- Fixture schemas are byte-identical to upstream gen-tasklist + gen-issues source (provenance noted)
- README documents how to refresh fixtures from upstream

---

### TASK-003 — Implement `shard-library.mjs` core: `loadLibraries`, `locateShard`, `updateShard`
**Priority:** high · **Effort:** M · **Tags:** lib-core, sprint-shard-a
**Depends on:** TASK-001

**Description:**
Create `scripts/shard-library.mjs`. Implement three of six public APIs per PLAN.md §3a: `loadLibraries(configPath)` (parses `shardLibraries[]`, synthesizes from legacy `tasksSource.primary` if absent, validates shape), `locateShard(library, id)` (returns absolute path or null), `updateShard(library, id, mutator)` (atomic `.tmp + rename` write, throws on missing file or mutator returning invalid shape). All exports use JSDoc with `@param`/`@returns`. No side effects on import.

**Acceptance Criteria:**
- All three functions exported and callable
- `loadLibraries` synthesizes legacy config + emits debug warning naming the assumed defaults
- `updateShard` is atomic — write failure leaves original file intact
- Module has no top-level side effects (importable in tests safely)

---

### TASK-004 — Implement `shard-library.mjs` rebuild + status inference
**Priority:** high · **Effort:** M · **Tags:** lib-core, sprint-shard-a
**Depends on:** TASK-003

**Description:**
Add `rebuildLibrary(library)` (execSync with `library.rebuildCmd`, captures stderr, returns `{ ok, reason }` — never throws — emits actionable warning on non-zero exit suggesting install command). Add `resolveStatusVocab(library)` per PLAN.md §3b: if `library.statusMap` set → use it; else load schema, extract `status` enum, apply heuristic regex (`/^(in[-_]?progress|active|started|wip)$/i` for start, `/^(done|completed?|closed|resolved|fixed)$/i` for done); require exactly one match per role; throw actionable error otherwise. Cache result per library on first call.

**Acceptance Criteria:**
- `rebuildLibrary` never throws — returns `{ ok: false, reason }` on missing CLI
- `resolveStatusVocab` returns `{ start: "in-progress", done: "done" }` for gen-tasklist schema
- `resolveStatusVocab` returns `{ start: "in-progress", done: "resolved" }` for gen-issues schema
- Throws with actionable message when 0 or >1 enum matches a role
- Per-library cache survives multiple calls in same process

---

### TASK-005 — Implement `shard-library.mjs` link scanner
**Priority:** high · **Effort:** S · **Tags:** lib-core, sprint-shard-a
**Depends on:** TASK-003

**Description:**
Add `scanLinks(taskShard, allLibraries)` per PLAN.md §3c. Extract IDs from `taskShard[library.linkField]` (when defined) AND from keyword regex `/\b(fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+(ISSUE|TASK|BUG|FEAT)-\d+/gi` over `description + notes`. Return `Map<libraryId, Set<shardId>>`. Match ID prefix against each library's shard naming convention (e.g., `ISSUE-NNN` belongs to library whose shards match that prefix). Skip + log unknown prefixes.

**Acceptance Criteria:**
- Returns empty map when no links found
- Detects explicit `resolves: ["ISSUE-042"]` field correctly
- Detects keyword phrases case-insensitively across description + notes
- Unknown ID prefix (e.g., `FOO-001`) is skipped + logged at warn level
- Union of explicit + keyword sources deduplicates

---

### TASK-006 — Unit tests for `shard-library.mjs` (all 6 APIs)
**Priority:** high · **Effort:** M · **Tags:** testing, sprint-shard-a
**Depends on:** TASK-002, TASK-003, TASK-004, TASK-005

**Description:**
Create `tests/shard-library.test.mjs`. Cover every public API: `loadLibraries` (legacy synth, multi-library, malformed), `locateShard` (found, missing, wrong dir), `updateShard` (atomic write, mutator returning invalid shape, file-not-found), `rebuildLibrary` (success path mocked, failure path with non-zero exit), `resolveStatusVocab` (gen-tasklist, gen-issues, ambiguous enum, missing schema, statusMap override), `scanLinks` (explicit field, keyword scan, union, unknown prefix). Aim for ≥90% coverage on the helper module.

**Acceptance Criteria:**
- `npx vitest run tests/shard-library.test.mjs` exits 0
- Coverage report shows ≥90% lines + branches for `scripts/shard-library.mjs`
- Every error path has a negative test
- Tests use fixtures from TASK-002, no external network

---

### TASK-007 — Update `load-config.mjs` to expose `shardLibraries`
**Priority:** high · **Effort:** S · **Tags:** integration, sprint-shard-a
**Depends on:** TASK-003

**Description:**
Modify `scripts/load-config.mjs`. After existing config load, call `loadLibraries(configPath)` from `shard-library.mjs` and attach result as `config.shardLibraries`. Preserve legacy `config.tasksSource` for any other consumer that may read it. Document the new field in inline comments.

**Acceptance Criteria:**
- Existing callers of `load-config.mjs` see no change in legacy fields
- `config.shardLibraries` is always an array (length ≥ 1) after load
- A config with neither `shardLibraries` nor `tasksSource.primary` throws a clear error

---

### TASK-008 — Migrate `resolve-tasks.mjs` to use `loadLibraries()`
**Priority:** high · **Effort:** S · **Tags:** integration, sprint-shard-a
**Depends on:** TASK-007

**Description:**
Modify `scripts/resolve-tasks.mjs`. Replace hardcoded `parseTasklistIndex` invocation with: find `library = config.shardLibraries.find(l => l.primary)`, read `library.indexPath`, iterate `open_tasks`, open shards from `library.shardDir/{id}.json`. Behavior is identical for default `.tasks/` config. Add regression test that resolves the same sprint as before and gets identical output.

**Acceptance Criteria:**
- `resolve-tasks.mjs sprint-4` against the issues-plugin produces byte-identical output to current behavior
- Throws clear error if no library has `primary: true`
- Throws clear error if multiple libraries have `primary: true`

---

## Sprint 2 — Pre-build write-back (Fixes 1, 3, 4)

### TASK-009 — Add status flip to `branch-setup.mjs`
**Priority:** high · **Effort:** M · **Tags:** integration, sprint-shard-b
**Depends on:** TASK-006, TASK-008

**Description:**
Modify `scripts/branch-setup.mjs`. After branch creation succeeds: locate primary-library shard via `locateShard`, read it, check status. If status is the inferred `done` value → exit non-zero with clear message. If status is the inferred `start` value → trigger collision prompt (TASK-010). Otherwise: call `updateShard` to set `status = start`, `started = now`, `updated = now`. Then call `rebuildLibrary` (resilient — Fix 3 already in helper).

**Acceptance Criteria:**
- New shard transitions backlog → in-progress with timestamps
- Already-done shard exits with code 4 + clear message
- Rebuild failure emits warning but doesn't block builder dispatch
- Atomic write — interrupted run leaves shard either fully old or fully new, never partial

---

### TASK-010 — Implement collision prompt (resume / restart / abandon)
**Priority:** high · **Effort:** S · **Tags:** integration, sprint-shard-b
**Depends on:** TASK-009

**Description:**
When `branch-setup.mjs` finds shard already at the inferred start status: invoke the existing `notify.mjs` + question-tool pattern (mirrors `review-sprint.mjs`). Three options per PLAN.md §3e: **resume** (preserve `started`, proceed), **restart** (overwrite `started`, append notes entry "Restarted by orchestrator on <date>"), **abandon** (exit non-zero, no dispatch). Non-interactive default = abandon (matches FEAT_FIXES.md hard-refuse fallback).

**Acceptance Criteria:**
- Prompt fires only when shard is at inferred start status (not other states)
- All three options behave correctly (verified via integration test)
- Non-interactive run defaults to abandon with code 4
- Restart appends notes entry without overwriting prior notes

---

### TASK-011 — Integration test for `branch-setup.mjs`
**Priority:** high · **Effort:** S · **Tags:** testing, sprint-shard-b
**Depends on:** TASK-009, TASK-010

**Description:**
Create `tests/integration/branch-setup.test.mjs`. Set up tmp git repo with `.tasks/` fixture. Run `branch-setup.mjs` against a backlog task → assert shard status, started timestamp, INDEX rebuild called. Run again with collision (manually flip shard to in-progress) → simulate user picking each of resume/restart/abandon → assert behavior. Run with rebuild CLI absent → assert warning but no failure.

**Acceptance Criteria:**
- All three collision branches verified
- Rebuild-absence test passes (mock `npx tasklist-rebuild` to fail)
- Test cleans up tmp git repo on completion (no test pollution)

---

## Sprint 3 — Post-merge close (Fix 2 + linkage)

### TASK-012 — Add primary-shard close to `merge-task.mjs`
**Priority:** high · **Effort:** M · **Tags:** integration, sprint-shard-c
**Depends on:** TASK-006, TASK-008

**Description:**
Modify `scripts/merge-task.mjs`. After `git merge` succeeds (after current line ~53), before living-docs commit (before current line ~113): locate primary shard via `locateShard`, call `updateShard` to set `status = done`, `completed = now`, `updated = now`, append `notes` entry `[<YYYY-MM-DD>] Merged into <sprintBranch> at <mergeSha>`. Call `rebuildLibrary`.

**Acceptance Criteria:**
- Shard transitions in-progress → done with completed timestamp
- Notes entry appends without overwriting existing notes
- Rebuild failure emits warning but doesn't block subsequent steps
- Runs only on successful merge (skip on merge conflict)

---

### TASK-013 — Add cross-library link closing to `merge-task.mjs`
**Priority:** high · **Effort:** M · **Tags:** integration, sprint-shard-c
**Depends on:** TASK-012, TASK-005

**Description:**
After TASK-012's primary close: call `scanLinks(taskShard, config.shardLibraries)` to find all referenced linked-library shards. For each `(libraryId, shardId)` in the result map: validate the shard exists in the linked library's INDEX (skip + warn on unknown), call `updateShard` with mutator that sets the inferred done status, sets `completed = now`, appends `notes` entry `[<date>] Resolved by <taskId> @ <mergeSha>`. After all linked shards updated, call `rebuildLibrary` once per affected library.

**Acceptance Criteria:**
- Task with `Resolves ISSUE-042` keyword closes ISSUE-042
- Task with explicit `resolves: ["ISSUE-073"]` closes ISSUE-073
- Both sources combined dedupe correctly
- Unknown linked ID logs warning but doesn't fail merge
- Each linked library rebuilt at most once per merge (not once per shard)

---

### TASK-014 — Commit `.tasks/` and `.issues/` deltas onto sprint branch
**Priority:** high · **Effort:** S · **Tags:** integration, sprint-shard-c
**Depends on:** TASK-013

**Description:**
After TASK-012 + TASK-013 mutations: stage all modified shard library directories (any `.{plugin}/` whose `library.indexPath` was touched). Commit with message `chore(orchestrator): close <taskId> + linked shards [<sha>]`. This is a separate commit on the sprint branch, after the merge commit, before the existing living-docs commit.

**Acceptance Criteria:**
- Single commit captures all shard + INDEX changes from both TASK-012 + TASK-013
- Commit message includes task ID + merge SHA for traceability
- No-op commit suppressed (e.g., when nothing changed because rebuild failed and shards are already correct)
- Living-docs commit (existing behavior) still runs after

---

### TASK-015 — Integration test for `merge-task.mjs` with linkage
**Priority:** high · **Effort:** M · **Tags:** testing, sprint-shard-c
**Depends on:** TASK-014

**Description:**
Create `tests/integration/merge-task.test.mjs`. Set up tmp git repo with both `.tasks/` and `.issues/` fixtures + matching `.orchestrator.json`. Create a task whose description contains `Resolves ISSUE-042`. Run full merge-task flow against a fake merged branch. Assert: task shard is done + completed + notes; ISSUE-042 shard is resolved + completed + notes; both INDEX files regenerated; single commit captures both changes.

**Acceptance Criteria:**
- All assertions pass
- Test handles both keyword + explicit-field linkage
- Test verifies the single-commit semantic (TASK-014)
- Test verifies non-linked task path (no .issues/ touched if no link)

---

### TASK-016 — Regression test: re-run sprint completes 0 tasks
**Priority:** high · **Effort:** S · **Tags:** testing, sprint-shard-c
**Depends on:** TASK-015

**Description:**
Add a test that reproduces the exact silent-infinite-loop scenario from FEAT_FIXES.md §"The actual problem". Set up fixture, run full pre-build → merge-task cycle on TASK-001, then re-run `resolve-tasks.mjs sprint-4` and assert the queue is empty. This is the canonical fix-validation test.

**Acceptance Criteria:**
- Re-resolve returns `{ queue: [] }` after one full cycle
- Asserts shard `status: done` directly, not just resolver output
- Test is named `silent-infinite-loop-regression.test.mjs` for grep-ability

---

## Sprint 5 — Documentation + Live acceptance

### TASK-017 — Rewrite `skill/SKILL.md` Configuration section
**Priority:** medium · **Effort:** M · **Tags:** docs, sprint-shard-d
**Depends on:** TASK-016

**Description:**
Update `skill/SKILL.md` §"Configuration reference" with the new `shardLibraries[]` config shape. Add new top-level §"Shard Library Integration" covering: status inference rules + heuristics + override path; cross-library link detection (explicit field + keyword regex); resilience model when rebuild CLI is absent; troubleshooting table for common errors (ambiguous status enum, unknown link target, missing schema). Include a complete `.orchestrator.json` example with both `tasks` and `issues` libraries.

**Acceptance Criteria:**
- New §"Shard Library Integration" present
- Config example is valid JSON + matches the schema in TASK-007
- Troubleshooting table covers: ambiguous-enum, missing-schema, unknown-link, missing-rebuild-CLI
- Backward-compat note explains legacy `tasksSource.primary` still works

---

### TASK-018 — Update `README.md`
**Priority:** medium · **Effort:** S · **Tags:** docs, sprint-shard-d
**Depends on:** TASK-017

**Description:**
Update `README.md` feature list to mention multi-library support + automatic shard write-back. Update Quickstart to show the new minimum config (single primary library). Add a "Multi-library example" snippet referencing `gen-tasklist` + `gen-issues` together.

**Acceptance Criteria:**
- Feature list mentions: multi-library, status write-back, cross-library linkage
- Quickstart config example is valid + minimal
- Multi-library example snippet matches TASK-017's example for consistency

---

### TASK-019 — Audit `commands/*.md` for behavior changes
**Priority:** medium · **Effort:** S · **Tags:** docs, sprint-shard-d
**Depends on:** TASK-017

**Description:**
Audit every file under `commands/`. For any slash command whose behavior changed (likely `/orchestrate`, anything that triggers `merge-task`): update help text to describe the new pre-build prompt (resume/restart/abandon), the post-merge linkage closure, and the multi-library support. Leave unchanged commands alone.

**Acceptance Criteria:**
- Every changed command's help text reflects new behavior
- Diff of `commands/` is reviewed and committed
- No command file references removed/renamed scripts

---

### TASK-020 — Live acceptance test against `issues-plugin` sprint-4
**Priority:** high · **Effort:** S · **Tags:** acceptance, sprint-shard-d
**Depends on:** TASK-016, TASK-017, TASK-018, TASK-019

**Description:**
Run the 5-step FEAT_FIXES.md acceptance test against `C:/Coding/ai_dev/issues-plugin`: clean slate (`git checkout main && git branch -D sprint-4`); `/orchestrate sprint-4`; verify TASK-001 + TASK-002 shards show `done` + timestamps + notes; verify INDEX no longer lists them; re-run `/orchestrate sprint-4` → assert 0 tasks resolved. Capture full output to `acceptance-results-<date>.md`.

**Acceptance Criteria:**
- All 5 FEAT_FIXES.md test steps pass
- If TASK-001 or TASK-002 references an ISSUE, the issue is also marked closed
- Output captured to a dated file in repo root (gitignored)
- Any deviation triggers a new bug task before closing this one

---

### TASK-021 — Tag release v1.x.0
**Priority:** medium · **Effort:** XS · **Tags:** release, sprint-shard-d
**Depends on:** TASK-020

**Description:**
After live acceptance passes: bump `package.json` version (minor bump — additive backward-compat feature). Commit. Tag `v1.x.0`. Push tag. Update `CHANGELOG.md` (or create one) with summary of the change + decision-log link.

**Acceptance Criteria:**
- `package.json` version bumped per semver (minor)
- Tag pushed to remote
- CHANGELOG entry summarizes user-facing changes only (no implementation detail)

---

### TASK-022 — Post-launch monitoring task (placeholder)
**Priority:** low · **Effort:** XS · **Tags:** post-launch, sprint-shard-d
**Depends on:** TASK-021

**Description:**
Placeholder backlog task: monitor first 3 real `/orchestrate` runs against `issues-plugin` after release. Capture any unexpected behavior (status inference misses, link scanner false positives, rebuild failures in unusual env) and create follow-up bug tasks. Close this task after 3 successful runs OR after 7 days, whichever comes first.

**Acceptance Criteria:**
- 3 real-world orchestrator runs documented OR 7-day window elapsed
- Any anomaly captured as a separate bug task
- Closure note summarizes "shipped clean" or lists follow-ups

---

## Summary

- **22 tasks** across 4 phases
- **Phase A (8 tasks):** foundation — helper module + tests + config plumbing. No behavior change.
- **Phase B (3 tasks):** pre-build write-back. Fixes silent-loop start side.
- **Phase C (5 tasks):** post-merge write-back + linkage. Fixes silent-loop end + closes issues automatically.
- **Phase D (6 tasks):** docs + live acceptance + release.
- **Critical path:** TASK-001 → 003 → 006 → 008 → 009 → 012 → 013 → 014 → 015 → 016 → 020 (11 tasks)
- **Parallelizable within phases:** A2/A3/A4/A5 partially; B and C tasks largely sequential due to shared file edits; D17/D18/D19 fully parallel.

Feed each task to `tasklist-add --stdin` against the `orchestrator` repo's `.tasks/` library (run `tasklist-bootstrap` first if not already initialized).
