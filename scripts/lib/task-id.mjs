// scripts/lib/task-id.mjs
// Pure, sync, no I/O. No process.exit. No console.* (LD-PAT-001 / LD-BUG-010).
//
// Extracted from scripts/branch-setup.mjs:306 (deriveTaskId) and
// scripts/merge-task.mjs:19 (normalizeTaskId) — TASK-013 introduces a third
// caller (linked-shard close), so the trivial 9-line utility now warrants
// deduplication. Single named export; no default; no top-level I/O.
//
// TODO(sprint-4): refactor scripts/branch-setup.mjs to import normalizeTaskId
// from this module and remove its local deriveTaskId (currently duplicated —
// left as carryover to keep TASK-013 diff focused). See TASK-013 blueprint §4a.

/**
 * Zero-pad a raw task argument to TASK-NNN form.
 * - 'TASK-013'  → 'TASK-013'   (already valid PREFIX-N → returned verbatim)
 * - 'ISSUE-7'   → 'ISSUE-7'    (any PREFIX-N pattern returned verbatim)
 * - '13'        → 'TASK-013'   (pure digits → zero-pad to 3)
 * - '1'         → 'TASK-001'
 * - 'foo'       → 'TASK-foo'   (pass-through; downstream validateShardId throws)
 *
 * @param {string|number} rawTaskArg
 * @returns {string}
 */
export function normalizeTaskId(rawTaskArg) {
  const s = String(rawTaskArg);
  if (/^[A-Z][A-Z0-9_]*-\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return `TASK-${s.padStart(3, '0')}`;
  return `TASK-${s}`;
}
