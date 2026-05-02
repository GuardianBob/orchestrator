// lib/merge-task-reasons.mjs
// Registry of envelope `reason` codes emitted by scripts/merge-task.mjs.
// Pure constants + pure builder functions — no I/O, no exit, no console.
// LD-PAT-001 / LD-BUG-010 compliant.
//
// Naming: UPPER_SNAKE_CASE constant whose value is the kebab-case wire string.
// Builder functions are camelCase prefixed with `reason` and return the
// kebab-string; they enforce the colon-separator and pass the inner code
// through verbatim (callers already coalesce e.code || e.name || 'unknown').

// ── Static reasons (9) ──────────────────────────────────────────────────────
export const REASON_NO_PRIMARY            = 'no-primary';
export const REASON_SHARD_NOT_FOUND       = 'shard-not-found';
export const REASON_IO_ERROR_READ         = 'io-error:read';
export const REASON_ALREADY_DONE          = 'already-done';
export const REASON_CLOSED                = 'closed';
export const REASON_UNKNOWN_LIBRARY       = 'unknown-library';
export const REASON_NOT_ATTEMPTED         = 'not-attempted';
export const REASON_SKIPPED_NO_CHANGES    = 'skipped-no-changes';
export const REASON_PRIMARY_SHARD_MISSING = 'primary-shard-missing';

// ── Builders (9) ────────────────────────────────────────────────────────────
export const reasonVocabError      = (code) => `vocab-error:${code}`;
export const reasonLocateError     = (code) => `locate-error:${code}`;
export const reasonUpdateFailed    = (code) => `update-failed:${code}`;
export const reasonIoError         = (code) => `io-error:${code}`;
export const reasonReloadError     = (code) => `reload-error:${code}`;
export const reasonScanlinksFailed = (code) => `scanlinks-failed:${code}`;
export const reasonRebuildFailed   = (code) => `rebuild-failed:${code}`;
export const reasonConfigError     = (code) => `config-error:${code}`;
export const reasonUncaught        = (code) => `uncaught:${code}`;

// ── Aggregates (frozen) ────────────────────────────────────────────────────
export const REASON_CONSTANTS = Object.freeze({
  REASON_NO_PRIMARY,
  REASON_SHARD_NOT_FOUND,
  REASON_IO_ERROR_READ,
  REASON_ALREADY_DONE,
  REASON_CLOSED,
  REASON_UNKNOWN_LIBRARY,
  REASON_NOT_ATTEMPTED,
  REASON_SKIPPED_NO_CHANGES,
  REASON_PRIMARY_SHARD_MISSING,
});

export const REASON_BUILDERS = Object.freeze({
  reasonVocabError,
  reasonLocateError,
  reasonUpdateFailed,
  reasonIoError,
  reasonReloadError,
  reasonScanlinksFailed,
  reasonRebuildFailed,
  reasonConfigError,
  reasonUncaught,
});
