# Changelog

All notable changes to the orchestrator skill are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] — 2026-05-04

### Added — Sprint-4 (multi-library + collision prompt)

- **Multi-library shard support**: orchestrator now reads multiple shard libraries declared in `.orchestrator.json` `tasksSource.libraries[]`. Each library has its own schema, status vocabulary, and rebuild command. Cross-library task linkage via `links[]` field or note keyword scan.
- **Pre-build collision prompt**: when a task branch already exists at orchestrate-time, the operator is prompted to choose: resume in-place, abort, or force-recreate. Eliminates silent overwrites of in-progress work.
- **Post-merge cross-library link closure**: when a task that links to shards in other libraries (e.g. `.tasks/` → `.issues/`) is merged, those linked shards are closed automatically with a "Resolved by `<taskId>` @ `<sha12>`" note. Symmetric to primary-shard close; idempotent via marker substring dedupe.

### Added — Sprint-5 (docs + acceptance + release)

- **`skill/SKILL.md`**: rewrote Configuration section + added Shard Library Integration section documenting multi-library schema, status vocab resolution, cross-library link mechanics. (TASK-017)
- **`README.md`**: documented multi-library setup, shard write-back, cross-library linkage, with a 15-line single-library Quickstart and a 30-line multi-library example. (TASK-018)
- **`commands/orchestrate.md`**: new bullets for collision prompt, post-merge link closure, multi-library mode. (TASK-019)
- **End-to-end acceptance test against second consumer project** (`issues-plugin`) — full multi-agent loop validated for two real tasks. Acceptance docs at `acceptance-runbook-2026-05-04.md` + `acceptance-results-2026-05-04.md`. (TASK-020)

### Fixed — Sprint-5

- **`install.ps1`**: previously skipped copying `lib/` and shallow-copied `templates/`, leaving installed skills missing modules. Now performs full recursive copy of all source assets, drops the `-not $Force` skip clause, prints a summary line + post-install verification block. (TASK-037)
- **`scripts/merge-task.mjs`**: previously wrote shard `notes` field as a JSON array, violating the `notes: string` schema invariant. Both `buildClosedShard` and `buildLinkedClosedShard` now always emit string; legacy array-shaped priors are coerced via `.join('\n')` for backward compatibility. New unit test `tests/unit/merge-task-notes-shape.test.mjs` (8 cases) locks the invariant. (TASK-038)

### Test count

- Pre-sprint-5: 187 / 187 passing
- Post-sprint-5: 195 / 195 passing (+8 notes-shape unit tests)

### Known follow-ups (post-v0.2.0)

- Hardcoded `DONE_STATUSES` in `scripts/resolve-tasks.mjs:153` — should derive from per-library status vocab instead of a fixed set. Filed as post-sprint-5 follow-up.
- Branch-name doubled `TASK-` prefix (e.g. `sprint-4-task-TASK-001-...`) — cosmetic; orchestrator interpolates `{taskId}` which already contains `TASK-`. Strip prefix before interpolation in a future cleanup.
- Inconsistent `started` timestamp on shards — present after retry path, absent on first-attempt success. Probe `branch-setup.mjs` status-flip behavior.

---

### Added — Sprint-3 (shard-library write path)

- **merge-task.mjs**: closes the primary task shard on merge — flips `status` to `done`, stamps ISO-8601 `completed`, appends merge note with 12-char SHA prefix. Emits structured JSON envelope key `shardClose` with `{ changed, shard, libraryId, reason, files? }`. Posture is *warn-and-continue*: shard-close failures never abort the merge. (TASK-012)
- **merge-task.mjs**: closes linked shards in sibling libraries (e.g., `.issues/` linked from `.tasks/`) discovered via shard `links[]` field or keyword scan of `notes[]`. Symmetric to primary-shard close; emits envelope key `linkedShardClose` with per-library results. Cross-library links are validated via `validateShardId` to block path-traversal. (TASK-013)
- **merge-task.mjs**: commits shard deltas to the sprint branch in a dedicated post-merge commit. Detects no-op cases (no diff staged) via three-way exit-code split on `git diff --cached --quiet`. Emits envelope key `commit` with `{ committed, sha, reason, files, libraries }`. (TASK-014)
- **lib/**: canonical library directory with five modules — `is-main.mjs`, `merge-task-reasons.mjs` (12 reason constants + 12 builders), `task-id.mjs`, `shard-library.mjs`, `collision-prompt.mjs` — plus `lib/README.md` documenting boundaries and conventions. Replaces 22 free-form reason strings across `merge-task.mjs` with typed registry exports. (TASK-027)
- **tests/integration/merge-task.test.mjs**: end-to-end test harness (4 scenarios) validating the full merge-task pipeline — subprocess CLI invocation + in-process helper composition. Establishes the `tests/integration/` convention: tmp-repo fixture via `mkdtempSync`, `spawnSync(process.execPath, ...)`, per-repo git config, `livingDocs: []` suppression, `rebuildCmd` config, JSON envelope assertions. (TASK-015)
- **tests/integration/silent-infinite-loop-regression.test.mjs**: regression test that locks in the silent-infinite-loop bug fix across all three failure surfaces (Fix 1 status-flip + Fix 2 shard-close + working rebuild). Three orthogonal tests: sanity (pre-cycle queue non-empty), main (full cycle → re-resolve queue empty + shard `done` on disk), INDEX-projection (rebuild ran correctly). Hermetic `tests/fixtures/silent-loop-regression/fake-rebuild.mjs` faithfully models `npx tasklist-rebuild`. (TASK-016)

### Fixed — Sprint-3

- **Silent infinite loop in `/orchestrate` workflow**: previously, after `merge-task.mjs` merged a task branch, the task shard was never flipped to `done`, leaving INDEX summary stale; the next `resolve-tasks.mjs` cycle would re-emit the same task indefinitely without surfacing an error. Sprint-3 closes the loop end-to-end: branch-setup flips shard to `in-progress` (sprint-1 carryover), merge-task flips to `done` and commits the delta, INDEX is rebuilt via `rebuildCmd`, resolver returns empty queue. Full FEAT_FIXES.md Fix 1 / Fix 2 / Fix 3 arc complete. (TASK-012, TASK-013, TASK-014, TASK-016)

### Test count

- Pre-sprint-3: 122 / 122 passing
- Post-sprint-3: 166 / 166 passing (44 new tests across 6 tasks)

### Known follow-ups (sprint-4)

- Resolver `shard.status` defense-in-depth filter at `scripts/resolve-tasks.mjs:174` — currently the resolver filters on INDEX `row.status` only; if `tasklist-rebuild` silently fails, a stale INDEX could re-queue a closed shard. Adding a per-shard status check + loud stderr warning on INDEX/shard drift would make the system resilient to rebuild failures rather than dependent on them. The TASK-016 regression test models a working rebuild; production hardening is sprint-4 scope.
- Extract `commitShardDeltas` → `lib/commit-shard-deltas.mjs` — `scripts/merge-task.mjs` is at 671 LOC, at the sub-extraction threshold.
- Reasons registry family aggregates — at 26 exports, past the 25-builder soft threshold.
- Document `merge-task` JSON envelope schema (`.d.ts` or `lib/README.md`) before adding a 6th structured key.
- Programmatic `lib/tasklist-rebuild.mjs` API — would eliminate the `npx tasklist-rebuild` shell-out and the `rebuildCmd` config burden.
- Sanitize `e.message` stderr leaks in `closePrimaryShardOnMerge` (SEC-W-012-1) before resolver safety-net adds new error sites.
