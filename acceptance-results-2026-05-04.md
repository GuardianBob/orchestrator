# TASK-020 — Live Acceptance Results (2026-05-04)

**Verdict: ✅ PASS** — End-to-end orchestrator validated against `C:/Coding/ai_dev/issues-plugin` sprint-4. Two tasks dispatched, built, reviewed, gated, merged, and closed via the full multi-agent loop. One orchestrator bug surfaced (TASK-038, fixed mid-acceptance). Four issues-plugin-internal findings filed for the consumer project (NOT orchestrator's responsibility).

---

## Test target

- **Project:** `C:/Coding/ai_dev/issues-plugin`
- **Project HEAD pre-test:** `6257237` (`.orchestrator.json` config aligned with sprint-1/2/3 conventions)
- **Branch under test:** local `sprint-4` (10 commits ahead of main, unpushed by design)
- **Tasks attempted:** `TASK-001` (bootstrap repo scaffold), `TASK-002` (create JSON schemas)
- **Driver:** user invoked `/orchestrate sprint-4` in a separate opencode session targeting issues-plugin

## Outcome — both tasks merged successfully

```
git log --oneline sprint-4 (issues-plugin):
  9fff926 fix(tasks): coerce TASK-002 notes array to string per schema   ← manual coerce (TASK-038 root cause)
  4ec1083 docs(task-TASK-002): update living docs
  7af1507 chore(orchestrator): close TASK-002 + linked shards [b7cc417f2537]
  b7cc417 merge(task-TASK-002): into sprint-4                            ← auto-merge succeeded
  bc5b04c chore(orchestrator): record TASK-002 in-progress + gate verdict
  1563c08 feat(task-TASK-002): Add JSON schemas for issue, index, config (draft 2020-12)
  d258e71 fix(tasks): coerce TASK-001 notes array to string per schema   ← manual coerce (TASK-038 root cause)
  d5ce7dd docs(task-TASK-001): update living docs
  9f9afe1 chore(orchestrator): close TASK-001 + linked shards [0cafe362a916]
  0cafe36 merge(task-TASK-001): into sprint-4                            ← auto-merge succeeded
  f570b08 chore(orchestrator): record TASK-001 attempt-2 review log + commits
  1e0b21a feat(task-TASK-001): Align bin map to .docs/ canonical surface (issues-* prefix, 10 entries)
```

Final shard state:
```
TASK-001 status=done completed=2026-05-04T15:09:28.306Z notes_type=string
TASK-002 status=done completed=2026-05-04T15:28:05.880Z notes_type=string
```
Counts: `done=2, open=36, next_task_id=TASK-039`.

All six reviewer JSONs at `C:/Coding/ai_dev/issues-plugin/.orchestrator/reviews/` — all `verdict=approve`.

---

## Acceptance criteria — point-by-point

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `/orchestrate sprint-4` invocation succeeds without operator intervention | ✅ PASS | TASK-001 + TASK-002 both auto-dispatched, retried where needed (TASK-001 needed attempt-2, recorded at `f570b08`), and merged via the configured agent roster. |
| 2 | Multi-library shard discovery works | ✅ PASS | Both tasks read from `.tasks/INDEX.json` per `tasksSource.primary`. No phantom-library errors. |
| 3 | Pre-build collision prompt fires for active branches | ✅ N/A (clean slate) | No collision triggered — clean slate test. Sprint-1 collision-prompt code path covered separately by unit/integration tests. |
| 4 | Post-merge cross-library link closure | ✅ PASS | Both `chore(orchestrator): close ... + linked shards` commits present. `closeLinkedShardsOnMerge` ran without failures (no `failures: N>0` in output). |
| 5 | Reviewers use canonical verdict vocab | ✅ PASS | All six review JSONs verified `verdict=approve`. |
| 6 | Living-doc updates emitted post-merge | ✅ PASS | `docs(task-TASK-001)` + `docs(task-TASK-002)` commits present. |
| 7 | Idempotent re-run resolves zero tasks | ⏭ DEFERRED | Skipped per operator decision. Both shards already `status=done`; `/orchestrate sprint-4` re-invocation would short-circuit on `resolveTasks`. Not blocking. |
| 8 | Schema-valid output | ⚠ PASS-AFTER-MANUAL-FIX | Both shards now valid (`notes` is string). Required two manual coercion commits (`d258e71`, `9fff926`) due to **TASK-038 bug** — fixed in orchestrator at commit `d6d3148`, propagated to installed skill. Future runs unaffected. |

---

## Findings

### F1 — `merge-task.mjs` writes shard `notes` as JSON array (orchestrator bug) ✅ FIXED
- **Severity:** high (schema-violating output)
- **Discovery:** First shard close after TASK-001 merge produced `notes: ["[2026-05-04] Merged into sprint-4 at ..."]`. Same again for TASK-002.
- **Operator workaround during test:** two manual coerce-to-string commits.
- **Root cause:** `scripts/merge-task.mjs` lines 47-50 + 77-94 emitted array literals despite `.tasks/schemas/task.schema.json` declaring `notes: { type: "string" }`. Header comment at line 43 had inverted polarity.
- **Resolution:** Filed and fixed as **TASK-038**. Both `buildClosedShard` and `buildLinkedClosedShard` now always emit string; legacy array prior coerced via `.join('\n')`. New unit test `tests/unit/merge-task-notes-shape.test.mjs` (8 cases) locks invariant. Vitest 195/195 passing. Skill re-installed; verified at `~/.config/opencode/skills/orchestrator/scripts/merge-task.mjs`.
- **Self-validation:** TASK-038's own shard `notes` is now a clean string (`"[2026-05-04] Merged into sprint-5 at ea2c1d204209"`).

### F2 — `.tasks/TASK-001` spec drift on `gen-issues-*` prefix vs `.docs/05` (issues-plugin internal)
- **Severity:** med
- **Surface:** TASK-001 spec required `gen-issues-*` bin prefix; `.docs/05-cli.md` lines 18 + 532 still reference older `issues-*` flat names.
- **Resolution path:** issues-plugin team to file follow-up task. NOT orchestrator's concern.

### F3 — `.docs/05` L18+L532 vs `.docs/11` L176 `issues-show` housekeeping (issues-plugin internal)
- **Severity:** low
- **Surface:** Inconsistent command naming across CLI and command-reference docs.
- **Resolution path:** issues-plugin team. NOT orchestrator's concern.

### F4 — `archive_after_days` flat vs `archive.older_than_days` nested config drift (issues-plugin internal)
- **Severity:** low
- **Surface:** TASK-002 schema work surfaced two competing conventions in code+spec.
- **Resolution path:** issues-plugin team. NOT orchestrator's concern.

### F5 — `ajv-cli@^5` ESM packaging broken (issues-plugin internal)
- **Severity:** med (blocks issues-plugin TASK-003 if not addressed)
- **Surface:** code-reviewer noted `ajv-cli@^5` cannot be invoked as ESM dep; suggests calling `ajv` programmatically from `lib/` instead.
- **Resolution path:** issues-plugin team to incorporate into TASK-003. NOT orchestrator's concern.

### Observations (non-findings)
- **Branch naming cosmetic:** orchestrator created `sprint-4-task-TASK-001-bootstrap-repo-scaffold` — doubled `TASK-` prefix because `taskId` already contains the prefix and branch template is `sprint-{N}-task-{taskId}-{slug}`. Cosmetic; consider stripping `TASK-` from `taskId` before interpolation in a future cleanup.
- **Inconsistent `started` timestamp:** TASK-001 has `started`; TASK-002 does not. Both have `completed`. Likely related to retry-vs-first-attempt path (TASK-001 needed attempt-2). Worth a probe into `branch-setup.mjs` status flip behavior post-sprint-5.

---

## Decision

- **TASK-020 → done.** Acceptance test passed. The single orchestrator-side issue (notes-as-array) was discovered, filed as TASK-038, fixed, tested, merged, and propagated to the installed skill — all within the same sprint-5 session.
- **Idempotent re-run skipped** per operator decision (manifest is already done; re-run would be theater).
- **Findings F2-F5 + observations** referred back to issues-plugin team; not blocking sprint-5.
- **Post-sprint-5 follow-ups already on backlog:** hardcoded `DONE_STATUSES` in `resolve-tasks.mjs:153`, `started`-timestamp inconsistency probe, branch-name `TASK-` doubling cleanup.

---

## Artifacts

- Runbook: `acceptance-runbook-2026-05-04.md` (sibling file)
- TASK-038 fix: orchestrator commit `d6d3148`, merged into sprint-5 at `ea2c1d2`
- Installed skill: `~/.config/opencode/skills/orchestrator/scripts/merge-task.mjs` contains TASK-038 markers (verified)
- Issues-plugin sprint-4 branch: `C:/Coding/ai_dev/issues-plugin` local `sprint-4`, 10 commits, unmerged to main (operator's call when to merge)
