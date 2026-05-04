# TASK-020 — Live Acceptance Runbook (2026-05-04)

**Target project:** `C:/Coding/ai_dev/issues-plugin`
**Test goal:** End-to-end validation of `/orchestrate sprint-4` against a real second project, exercising the new sprint-1/2/3 features (multi-library, pre-build collision prompt, post-merge cross-library link closure).

---

## Pre-flight (already done by orchestrator project)

- [x] `issues-plugin` `.orchestrator.json` fixed and committed on `main` (commit `6257237`):
  - `tasksSource.primary` → `.tasks/INDEX.json`
  - Removed phantom `TASKLIST.md` from `livingDocs`
  - Added `coder=fullstack-developer` + `tester=test-automator` to `builderAgents`
- [x] Working tree clean. No `sprint-4` branch yet (correct for clean slate).
- [x] `.tasks/INDEX.json` shows TASK-001 + TASK-002 in `backlog` status, both tagged `sprint-4`.
- [x] No stale `.orchestrator/` artifacts to interfere.

---

## Step 1 — You: clean-slate verification (manual sanity check)

Open a shell in `C:/Coding/ai_dev/issues-plugin` and run:

```bash
git checkout main
git status                                    # MUST be clean
git rev-parse HEAD                            # should be 6257237 or descendant
git branch --list sprint-4                    # MUST print nothing
node -e "const j=require('./.tasks/INDEX.json'); console.log('open:', j.open_tasks.filter(t=>(t.tags||[]).includes('sprint-4')).map(t=>t.id+'='+t.status).join(','))"
# expected: open: TASK-001=backlog,TASK-002=backlog
```

If any check fails, **STOP** and tell me — do not proceed.

---

## Step 2 — You: open `issues-plugin` in opencode

In a **separate opencode session** (so this orchestrator session stays alive to receive your report):

1. Open `C:/Coding/ai_dev/issues-plugin` as the workspace root.
2. Confirm the orchestrator skill is available (the same `opencode/skills/orchestrator` install).
3. At the prompt, run exactly:

   ```
   /orchestrate sprint-4
   ```

4. The skill should:
   - Show you the loaded `.orchestrator.json`
   - Resolve sprint-4 → 2-task queue: TASK-001, TASK-002
   - For each task: `branch-setup` → architect → coder → tester → docs → 3 reviewers → gates → merge
   - Update living docs after each merge
   - Send a "sprint complete" notification when both are done
   - **OFFER a sprint review** before asking about merge to main (it's the last step)

---

## Step 3 — You: capture the results

When `/orchestrate sprint-4` returns control to you:

1. **Decline** the sprint review offer for now (we'll do that separately if needed).
2. **Decline** the "merge sprint-4 to main" prompt — I want to inspect the sprint branch first.
3. **Copy the final summary message** the skill produced (the one that lists merged tasks, gate status, notifications sent).
4. Paste it into this orchestrator session as your reply, prefixed with `=== /orchestrate sprint-4 OUTPUT ===`.
5. Also paste the output of these post-run probes (run them in `C:/Coding/ai_dev/issues-plugin`):

   ```bash
   git branch --list 'sprint-4*'
   git log sprint-4 --oneline -20
   node -e "const fs=require('fs'); for(const id of ['001','002']){const t=JSON.parse(fs.readFileSync('.tasks/tasks/TASK-'+id+'.json','utf8'));console.log('TASK-'+id,'status='+t.status,'completed='+(t.completed||'(none)'),'started='+(t.started||'(none)'),'notes='+(t.notes?.length||0));}"
   node -e "const j=require('./.tasks/INDEX.json'); console.log('open count:', j.open_tasks.length, '| done count:', (j.done_tasks||[]).length, '| TASK-001 in open:', j.open_tasks.some(t=>t.id==='TASK-001'), '| TASK-001 in done:', (j.done_tasks||[]).some(t=>t.id==='TASK-001'))"
   ```

---

## Step 4 — You: idempotent re-run

After pasting Step 3 output, run `/orchestrate sprint-4` **a second time** in the same opencode session.

**Expected:** the skill resolves the queue → sees 0 backlog tasks tagged `sprint-4` → reports "0 tasks to run" or equivalent → exits without dispatching anything, without creating new branches, without modifying any shard.

Paste the second-run summary back here, prefixed with `=== /orchestrate sprint-4 RE-RUN OUTPUT ===`.

---

## Step 5 — Me: post-state verification + acceptance report

When you've pasted both outputs + the probe results, I will:

1. Verify TASK-001 + TASK-002 shard JSON: `status === "done"`, `completed` timestamp present, at least one note appended.
2. Verify `.tasks/INDEX.json`: TASK-001 + TASK-002 moved from `open_tasks` to `done_tasks`.
3. Verify `sprint-4` branch exists, contains 2 task merge commits + living-doc updates per merge.
4. Verify the re-run did NOT create new branches or modify shards.
5. **Acceptance criteria checklist** (from FEAT_FIXES.md original test):
   - [ ] Both tasks merged into `sprint-4` branch
   - [ ] Both shards `status=done` with `completed` + reconciliation notes
   - [ ] INDEX no longer lists them in `open_tasks`
   - [ ] Re-run resolves 0 tasks (idempotent)
   - [ ] `livingDocs` were updated on each merge
   - [ ] Sprint-complete notification fired
6. Write `acceptance-results-2026-05-04.md` with the full transcript + verdict.
7. Commit on this branch (`sprint-5-task-020-live-acceptance-test`).
8. Run reviewers (gate is content review — no code changed in orchestrator repo).
9. Merge to `sprint-5`.

---

## Bonus checks I'll do (not strict acceptance, but useful)

- **Pre-build collision prompt** — if the build dispatcher correctly inferred a start status and prompted on a re-run of the same task that's already in-progress (probably won't trigger here since clean slate, but I'll note if it did).
- **Post-merge link closure** — sprint-4 tasks don't reference any cross-library IDs, so this won't fire. Will note as "not exercised by this test" in the report.
- **Multi-library** — issues-plugin uses legacy `tasksSource` (no `shardLibraries[]` array), so this exercises the `_synthesizeLegacyLibrary` backward-compat path at `lib/shard-library.mjs:427`. Will confirm the synthesizer worked.

---

## If something goes wrong during your run

- **Builder fails / reviewer requests changes / gate fails after maxRetries** — paste the full transcript anyway. A blocked task is also a valid acceptance result (tests notification path); we just record it as "blocked, see notes" rather than "passed".
- **Skill crashes** — paste the stack trace + the last 20 lines of `.orchestrator/` artifacts. We'll diagnose.
- **You want to abort mid-run** — Ctrl+C is fine. Then run `git status` and `git branch -a` in issues-plugin and paste the output so I know what state to roll back.

---

**This runbook is committed on `sprint-5-task-020-live-acceptance-test`.** When the live test passes, I'll commit `acceptance-results-2026-05-04.md` next to it, then run reviewers + merge.
