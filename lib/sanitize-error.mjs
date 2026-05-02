// lib/sanitize-error.mjs
//
// Pure helper: sanitize an error value before it reaches stderr. Strips
// absolute filesystem paths (Win32 drive, Win32 UNC, POSIX, file:// URLs),
// ANSI escape sequences, collapses newlines, and caps at MAX_LEN chars.
// Safe for null/undefined/non-Error. Closes SEC-W-012-1.
//
// Pure-lib invariant (LD-PAT-001 / LD-BUG-010 / LD-PAT-005): no top-level
// side effects, no I/O, no process.exit, no console.*. The only environment
// touch is one read of process.env.DEBUG_MERGE_TASK inside the function body.
//
// Cross-platform path stripping (LD-XPL-001): four distinct regex shapes so
// the sanitizer behaves identically on windows-latest and ubuntu-latest CI.

export const MAX_LEN = 200;
export const MAX_LEN_DEBUG = 2000;
export const UNKNOWN = '<unknown error>';
export const REDACTED_PATH = '<path>';

// CSI (SGR/colors), C0 control chars except \t \n \r, then 4 path shapes.
const ANSI_CSI    = /\x1b\[[0-9;]*[A-Za-z]/g;
const C0_CTRL     = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const WIN32_DRIVE = /[A-Za-z]:[\\/](?:[^\s"'<>|?*]+[\\/])*[^\s"'<>|?*]*/g;
const WIN32_UNC   = /\\\\[^\\/\s]+\\[^\s"'<>|?*]+(?:\\[^\s"'<>|?*]+)*/g;
// Lookbehind blocks intra-word matches (1/2, https://) — requires ≥1 segment.
const POSIX_ABS   = /(?<![A-Za-z0-9:])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*/g;
const FILE_URL    = /file:\/\/[^\s'"]+/g;

/**
 * Sanitize an error for stderr emission. Steps: null-guard → extract message →
 * DEBUG escape → strip ANSI+C0 → strip 4 path shapes → collapse newlines (' ⏎ ')
 * → collapse whitespace → cap at MAX_LEN with '…' → empty fallback.
 *
 * If process.env.DEBUG_MERGE_TASK === '1', the raw message is returned
 * unchanged (still capped at MAX_LEN_DEBUG to prevent runaway log lines).
 * Dev-only opt-in — do NOT set in CI.
 *
 * @param {unknown} err - Anything thrown; typically an Error instance.
 * @returns {string} One-line sanitized summary, never empty, never contains
 *                   absolute paths or ANSI codes (unless DEBUG_MERGE_TASK=1).
 */
export function sanitizeErrorMessage(err) {
  if (err === null || err === undefined) return UNKNOWN;

  let raw;
  if (typeof err === 'string') raw = err;
  else if (typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) raw = err.message;
  else { try { raw = String(err); } catch { return UNKNOWN; } }
  if (typeof raw !== 'string') raw = String(raw);

  if (process.env.DEBUG_MERGE_TASK === '1') {
    return raw.length > MAX_LEN_DEBUG ? raw.slice(0, MAX_LEN_DEBUG - 1) + '…' : raw;
  }

  let out = raw
    .replace(ANSI_CSI, '')
    .replace(C0_CTRL, '')
    .replace(FILE_URL, REDACTED_PATH)
    .replace(WIN32_UNC, REDACTED_PATH)
    .replace(WIN32_DRIVE, REDACTED_PATH)
    .replace(POSIX_ABS, REDACTED_PATH)
    .replace(/[\r\n]+/g, ' ⏎ ')
    .replace(/\s+/g, ' ')
    .trim();

  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN - 1) + '…';
  return out.length === 0 ? UNKNOWN : out;
}
