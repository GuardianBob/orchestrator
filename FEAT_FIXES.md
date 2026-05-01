# Orchestrator — Feature Gaps & Recommended Fixes

> **Status:** Open. Discovered during sprint-4 setup for `issues-plugin` (2026-05-01).
> **Scope:** Compatibility between the `orchestrator` skill and projects using the `gen-tasklist` library (`.tasks/` directory) as their primary task source.

---

## Context

`issues-plugin` was configured with `.orchestrator.json`:

```json
"tasksSource": { "primary": ".tasks/INDEX.json", ... }
```

This required two changes to the orchestrator skill:

1. **`scripts/resolve-tasks.mjs`** — added `parseTasklistIndex()` to read `INDEX.json` + sibling `tasks/TASK-NNN.json` shards. Also made task-ID matching case-insensitive and zero-pad-tolerant (so `task-1`, `task-001`, `TASK-001`, and bare `1` all resolve to `TASK-001`). Added stderr warnings for missing/corrupt shards.
2. **`.orchestrator.json`** — pointed `tasksSource.primary` at `.tasks/INDEX.json`, removed `TASKLIST.md` from `livingDocs`.

**Result:** the **read path** now works correctly. `sprint-4` resolves to TASK-001 + TASK-002 with full descriptions and acceptance criteria.

The **write-back path is missing entirely** — that is the subject of this document.

---

## Compliance audit against `.tasks/AGENT_GUIDE.md`

| Guide rule | Orchestrator behavior | Verdict |
|---|---|---|
| §Read order — read `INDEX.json` first, shards only when needed | `parseTasklistIndex()` reads INDEX → iterates `open_tasks[]` → opens shard per row | ✅ |
| NEVER glob `.tasks/tasks/*.json` | Resolver only reads `tasks/${row.id}.json` for IDs in `open_tasks` — no glob | ✅ |
| NEVER edit `INDEX.json` or `TASKS.md` | No orchestrator script writes anywhere under `.tasks/` | ✅ |
| NEVER write shards via `fs` directly | Orchestrator never creates new tasks (transitively depends on builder/reviewer agent discipline) | ✅ |
| NEVER auto-run `tasklist-migrate` | Orchestrator never invokes any `tasklist-*` CLI | ✅ |
| NEVER invent `TASK-NNN` IDs | Resolver only emits IDs present in `INDEX.open_tasks` | ✅ |
| §Status flow: `backlog → ready → in-progress → review → done` | **Orchestrator never transitions shard status.** TASK-001 stays `backlog` forever in the shard after merge | ❌ |
| §Editing tasks — set `started` on in-progress, `completed` on done, bump `updated`, atomic write, then `tasklist-rebuild` | Not done by any orchestrator script | ❌ |
| §Progressive enrichment — append `notes` during work; final `notes` on close | Not done | ❌ |
| §Cross-reference order — `edit shard → tasklist-rebuild → write memory → living-docs-rebuild` | Orchestrator does the inverse (writes living docs, never touches shards) | ❌ |
| §Done detection in resolver | Skips shards with status `done|completed|archived|cancelled|closed` (logic correct) — but **never fires** because the gap above means status never changes | ⚠️ |

---

## The actual problem

After `merge-task.mjs` successfully merges TASK-001 into `sprint-4`:

1. `.tasks/tasks/TASK-001.json` still has `"status": "backlog"`, no `started`, no `completed`.
2. `.tasks/INDEX.json` still lists TASK-001 under `open_tasks`.
3. The next `/orchestrate sprint-4` invocation **re-resolves TASK-001 and dispatches builders to rebuild it from scratch**.
4. `branch-setup.mjs` may collide with the prior task branch (deleted locally but possibly still present in reflog/remote), or worse, succeed against a stale branch and re-merge already-merged code.

**This is a silent infinite loop.** Without write-back, the orchestrator cannot run more than one task per sprint without manual shard editing between runs.

---

## Recommended fix — three changes to the orchestrator skill

All three are small, additive, no new dependencies. `npx tasklist-rebuild` is already available in any project using the `.tasks/` library.

### Fix 1 — Pre-build status flip (`branch-setup.mjs` or new `start-task.mjs`)

**When:** between Step 3a (branch creation) and Step 3b (builder dispatch).

**Behavior:**
- If `tasksSource.primary` ends in `.json` and is a gen-tasklist INDEX → locate sibling shard `${dir}/tasks/${task-id}.json`.
- Refuse to proceed if shard status is already `in-progress` or `done` (safety check — prevents double-build on a stale resume).
- Edit shard:
  - `status: "in-progress"`
  - `started: <ISO-8601 UTC now>`
  - `updated: <same>`
- Atomic write (`.tmp` + `fs.renameSync`).
- Run `npx tasklist-rebuild` (silent on success).
- If anything fails, abort the orchestrator loop with a clear error; do **not** dispatch builders against an unmarked shard.

**Pseudocode:**
```mjs
if (cfg.tasksSource?.primary?.toLowerCase().endsWith('.json')) {
  const indexFile = path.join(cwd, cfg.tasksSource.primary);
  const shardPath = path.join(path.dirname(indexFile), 'tasks', `${args.task}.json`);
  if (fs.existsSync(shardPath)) {
    const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
    if (['in-progress', 'done'].includes(shard.status)) {
      console.error(`[branch-setup] WARN: ${args.task} status is already ${shard.status}; refusing to start.`);
      process.exit(4);
    }
    const now = new Date().toISOString();
    const updated = { ...shard, status: 'in-progress', started: now, updated: now };
    const tmp = shardPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
    fs.renameSync(tmp, shardPath);
    execSync('npx tasklist-rebuild', { cwd, stdio: 'pipe' });
  }
}
```

### Fix 2 — Post-merge close (`merge-task.mjs`)

**When:** after the `git merge` succeeds (after line 53), before the living-docs commit (before line 113).

**Behavior:**
- Same shard-locate logic as Fix 1.
- Edit shard:
  - `status: "done"`
  - `completed: <ISO-8601 UTC now>`
  - `updated: <same>`
  - Append a `notes` entry: `[<date>] Merged into <sprintBranch> at <merge commit short SHA>`
- Atomic write.
- Run `npx tasklist-rebuild`.
- Stage `.tasks/` changes into the existing docs commit at line 115–117 (they're already running `git add -A`, so `.tasks/INDEX.json`, `.tasks/INDEX.compact.json`, `.tasks/TASKS.md`, and the modified shard get included automatically).

**Pseudocode:**
```mjs
if (cfg.tasksSource?.primary?.toLowerCase().endsWith('.json')) {
  const indexFile = path.join(cwd, cfg.tasksSource.primary);
  const shardPath = path.join(path.dirname(indexFile), 'tasks', `${args.task}.json`);
  if (fs.existsSync(shardPath)) {
    const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
    const now = new Date().toISOString();
    const mergeSha = sh('git rev-parse --short HEAD');
    const note = `[${now.slice(0,10)}] Merged into ${sprintBranch} at ${mergeSha}`;
    const notes = shard.notes ? `${shard.notes}\n${note}` : note;
    const updated = { ...shard, status: 'done', completed: now, updated: now, notes };
    const tmp = shardPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
    fs.renameSync(tmp, shardPath);
    execSync('npx tasklist-rebuild', { cwd, stdio: 'pipe' });
  }
}
```

### Fix 3 — Resilience: tolerate `tasklist-rebuild` absence

**When:** in both fixes above, wrap the `execSync('npx tasklist-rebuild', ...)` call.

**Behavior:**
- If `npx tasklist-rebuild` exits non-zero (e.g., gen-tasklist not installed), emit a clear stderr warning instead of hard-failing.
- Suggest the user run `npm install gen-tasklist` or invoke the rebuild manually.
- Leave the shard atomic write in place — the data is correct, only the derived index is stale until the user rebuilds.

**Rationale:** the orchestrator skill should not assume gen-tasklist is npm-installed. The shard edit is the source of truth; the rebuild is recovery-friendly cleanup.

---

## Why all three matter

- **Fix 1 alone** solves resume safety (no double-builds) but leaves shards `in-progress` forever after merge.
- **Fix 2 alone** solves the infinite loop but leaves a window where, between branch creation and merge, a parallel orchestrator run could pick up the same task.
- **Fix 3 alone** is just hardening but matters for adoption: skills should not silently fail in projects missing optional CLIs.

All three together restore full conformance with `.tasks/AGENT_GUIDE.md` §Status flow, §Editing tasks, §Progressive enrichment, and §Cross-reference: living-docs.

---

## Out of scope for this document

- **Auto-creating new tasks from reviewer findings.** Guide §"When to add a task" says agents should `tasklist-add --stdin`. Today, reviewer agents are expected to create their own tasks via the `gen-tasklist` skill when needed. Whether the orchestrator should automate this (e.g., turn `requires_human_decision: true` findings into auto-filed `backlog` tasks) is a separate design question.
- **Living-docs ordering.** Guide §"Cross-reference: living-docs" prescribes `edit shard → tasklist-rebuild → write memory → living-docs-rebuild`. Today `merge-task.mjs` writes living docs first. Fixing this requires reordering the bottom half of `merge-task.mjs` — straightforward but not behavior-critical until a `living-docs-rebuild` integration exists.
- **Pre-build dependency check.** Guide allows shards with `depends_on: ["TASK-001"]`. Orchestrator currently dispatches in INDEX order without verifying dependencies are `done`. For sprint-4 this happens to be correct (TASK-001 before TASK-002), but a sprint with cross-sprint dependencies could fail. Worth adding but not urgent.

---

## Files affected by recommended fixes

| File | Change |
|---|---|
| `<skills>/orchestrator/scripts/branch-setup.mjs` | Add Fix 1 block at end |
| `<skills>/orchestrator/scripts/merge-task.mjs` | Add Fix 2 block after `git merge` |
| `<skills>/orchestrator/SKILL.md` | Document gen-tasklist integration in §"Configuration reference" |

Estimated effort: **Fix 1 + Fix 2 + Fix 3 ≈ 80–100 lines total**, one afternoon of work plus testing against `issues-plugin` sprint-4 as the acceptance harness.

---

## Acceptance test for the fix bundle

Against `issues-plugin` after the fix lands:

1. `git checkout main && git branch -D sprint-4` (clean slate).
2. `/orchestrate sprint-4` → completes TASK-001 and TASK-002.
3. After completion, `cat .tasks/tasks/TASK-001.json` shows `"status": "done"`, `started` and `completed` timestamps, and a `notes` entry referencing the merge SHA.
4. `cat .tasks/INDEX.json | jq '.open_tasks | map(.id)'` no longer contains `TASK-001` or `TASK-002`.
5. Re-running `/orchestrate sprint-4` resolves to **0 tasks** (because both are now `done`) and stops cleanly without dispatching builders.

If all five steps pass, the orchestrator is fully `.tasks/AGENT_GUIDE.md`-compliant.

---

## Related artifacts

- Read-path fix already landed: `<skills>/orchestrator/scripts/resolve-tasks.mjs` (parseTasklistIndex, case-insensitive ID matching, missing-shard warnings).
- Project config: `C:/Coding/ai_dev/issues-plugin/.orchestrator.json` (`tasksSource.primary: ".tasks/INDEX.json"`, `TASKLIST.md` removed from `livingDocs`).
- Reference contract: `C:/Coding/ai_dev/issues-plugin/.tasks/AGENT_GUIDE.md`.
