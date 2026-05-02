# Changelog

All notable changes to the orchestrator skill are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
