# STATUS_SUMMARY

## Sprint 1 — Complete (2026-05-01)

- Shipped pure, side-effect-free `scripts/shard-library.mjs` (10 exports, 6 PLAN-mandated public APIs: `loadLibraries`, `locateShard`, `updateShard`, `rebuildLibrary`, `resolveStatusVocab`, `scanLinks`) plus typed error hierarchy (`ShardLibraryError` → `ShardNotFoundError`/`ShardValidationError`).
- Migrated `load-config.mjs` and `resolve-tasks.mjs` to consume `cfg.shardLibraries[]` with backward-compat synthesis from legacy `tasksSource.primary`.
- Hardened path-traversal defense: `validateShardId` regex guard applied transitively to every shard-path construction.
- 80 vitest tests passing (63 unit + 17 integration), with ≥90% per-file coverage threshold on `shard-library.mjs` (~98% achieved); JSON-schema-validated fixtures for `.tasks/` and `.issues/`.
- Write-side integrations (`branch-setup`, `merge-task`) and live acceptance against `issues-plugin` deferred to sprint-2/3 — the 3 unused exports (`rebuildLibrary`, `resolveStatusVocab`, `scanLinks`) are wired-in for those consumers.

- [2026-05-01] Completed task-001: Bootstrap test infrastructure (vitest)

- [2026-05-01] Completed task-002: Create test fixtures for .tasks/ and .issues/

- [2026-05-01] Completed task-003: fix(task-003): validate shard id against safe regex (path-traversal hardening)

- [2026-05-01] Completed task-004: add rebuildLibrary + resolveStatusVocab to shard-library

- [2026-05-01] Completed task-005: add scanLinks to shard-library

- [2026-05-01] Completed task-006: test(task-006): unit tests for shard-library.mjs (10 exports, 6 APIs)

- [2026-05-01] Completed task-007: expose shardLibraries on loaded config

- [2026-05-01] Completed task-008: test(task-008): migrate snapshot tests to controlled fixture

- [2026-05-01] Completed task-009: Add status flip to branch-setup.mjs

- [2026-05-02] Completed task-012: Add primary-shard close to merge-task.mjs

- [2026-05-02] Completed task-013: Add cross-library link closing to merge-task.mjs

- [2026-05-02] Completed task-027: refactor(task-027): consolidate lib/, extract is-main, add reasons registry

- [2026-05-02] Completed task-014: feat(orchestrator): TASK-014 commit shard deltas on merge

- [2026-05-02] Completed task-015: test(orchestrator): TASK-015 integration test for merge-task workflow

- [2026-05-02] Completed task-028: Resolver: add per-shard status safety net + drift warning

- [2026-05-02] Completed task-029: Extract commitShardDeltas to lib/commit-shard-deltas.mjs

- [2026-05-02] Completed task-033: Sanitize stderr warnings in closePrimaryShardOnMerge (close SEC-W-012-1)

- [2026-05-02] Completed task-036: Apply sanitizeErrorMessage to branch-setup.mjs + resolve-tasks.mjs (close SEC-W-012-1 cross-cutting)

- [2026-05-02] Completed task-017: Rewrite skill/SKILL.md Configuration section + add Shard Library Integration

- [2026-05-02] Completed task-018: Update README.md for multi-library + write-back + cross-library linkage

- [2026-05-02] Completed task-019: Audit commands/orchestrate.md for new sprint-1/2/3 behaviors

- [2026-05-04] Completed task-037: Fix install.ps1: install lib/, recurse templates/, drop dir-exists skip
