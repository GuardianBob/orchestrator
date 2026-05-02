// lib/is-main.mjs
// Per LD-PAT-005. Handles Windows drive letters, file:// URL, and npm-link
// junctions via realpathSync on both sides.
//
// Pure, sync, no top-level side effects. Single named export.
//
// Cross-platform footguns covered:
//   1. Windows drive-letter case ('C:' vs 'c:') — normalized by pathToFileURL.
//   2. file:// URL scheme presence/absence — normalized by pathToFileURL.
//   3. npm-link junctions on win32 — argv[1] is the junction path, but
//      import.meta.url is the realpath. realpathSync resolves both sides.
//
// Returns false on any error (missing argv[1], realpathSync ENOENT, …) so
// importing the module from a test/REPL never accidentally runs the CLI.

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

/**
 * @param {string} importMetaUrl  Pass `import.meta.url` from the calling module.
 * @returns {boolean}             True iff this module is the process entry-point.
 */
export function isMain(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const resolved = pathToFileURL(realpathSync(argv1)).href;
    return resolved === importMetaUrl;
  } catch {
    return false;
  }
}
