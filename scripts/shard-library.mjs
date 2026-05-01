#!/usr/bin/env node
// shard-library.mjs — Generic helper for sharded-library I/O (tasks, issues, etc.)
//
// PURITY CONTRACT (LD-PAT-001 / LD-BUG-010):
//   - No top-level side effects. Importable in tests with zero I/O.
//   - No process.exit anywhere. Throws typed errors; callers map to exit codes.
//   - No console.log. Debug output gated on DEBUG_SHARD_LIBRARY env var.
//
// WRITE CONTRACT (LD-ARC-002):
//   - This module writes individual shard files only. It NEVER writes INDEX.json.
//   - INDEX.json is a derived view; rebuild it via library.rebuildCmd (TASK-004).
//
// PATH CONTRACT (LD-XPL-001):
//   - Every path constructed via path.join / path.resolve. No string concat.
//
// I/O choice — synchronous fs (not fs/promises). Rationale:
//   1. Matches existing scripts/load-config.mjs style — single I/O paradigm.
//   2. renameSync is the POSIX/NTFS atomic primitive; async offers no atomicity benefit.
//   3. Callers (branch-setup.mjs, merge-task.mjs) are short-lived CLI scripts.
//   4. Simpler error semantics (no unhandled rejections).

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class ShardLibraryError extends Error {
  constructor(msg) { super(msg); this.name = 'ShardLibraryError'; }
}
export class ShardNotFoundError extends ShardLibraryError {
  constructor(msg) { super(msg); this.name = 'ShardNotFoundError'; }
}
export class ShardValidationError extends ShardLibraryError {
  constructor(msg) { super(msg); this.name = 'ShardValidationError'; }
}

// ---------------------------------------------------------------------------
// Typedefs (see TASK-003 blueprint §2)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ShardLibrary
 * @property {string} id           Stable identifier (e.g. "tasks", "issues").
 * @property {string} name         Human label for log messages.
 * @property {string} indexPath    Absolute path to INDEX.json (materialized view).
 * @property {string} indexDir     Absolute path to the directory containing INDEX.json.
 * @property {string} shardDir     Absolute path to the per-item shard directory.
 * @property {string} schemaPath   Absolute path to the shard JSON schema (may not exist).
 * @property {Object|null} statusMap   Optional `{ start, done }` override; null = infer.
 * @property {string|null} linkField   Field name listing linked IDs (e.g. "resolves").
 * @property {boolean} primary     True for the single primary library.
 * @property {string} rebuildCmd   Shell command to rebuild INDEX.json (TASK-004).
 */

// ---------------------------------------------------------------------------
// Private cache (blueprint §5)
// ---------------------------------------------------------------------------

const _cache = new Map(); // absoluteConfigPath -> ShardLibrary[]

/**
 * Test-only: clear the loadLibraries cache. Do not call from production code.
 * @returns {void}
 */
export function __resetCache() { _cache.clear(); }

function debugWarn(...args) {
  if (process.env.DEBUG_SHARD_LIBRARY) console.warn('[shard-library]', ...args);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate the shardLibraries[] array from an .orchestrator.json file.
 * If absent, synthesizes a single-entry array from legacy tasksSource.primary
 * per the rules in TASK-003 blueprint §3.
 *
 * Resolves all relative paths against the directory containing configPath
 * (LD-CLI-001 — never against process.cwd()). Caches the result per absolute
 * configPath for the process lifetime.
 *
 * @param {string} configPath  Absolute or relative path to .orchestrator.json.
 * @returns {ShardLibrary[]}   Validated, path-resolved libraries. Callers must NOT mutate.
 * @throws {ShardLibraryError}     Config file unreadable, or no libraries can be derived.
 * @throws {ShardValidationError}  Invalid JSON in config, or any library entry fails validation.
 */
export function loadLibraries(configPath) {
  const abs = path.resolve(configPath);
  if (_cache.has(abs)) return _cache.get(abs);

  // 1. Read + parse config (guarded — LD-BUG-004)
  let cfg;
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new ShardLibraryError(`Failed to read config ${abs}: ${e.message}`);
  }
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new ShardValidationError(`Invalid JSON in ${abs}: ${e.message}`);
  }

  const configDir = path.dirname(abs);
  let libs;

  if (Array.isArray(cfg.shardLibraries) && cfg.shardLibraries.length > 0) {
    // Explicit config — validate-all-or-abort (LD-PAT-007)
    const errors = [];
    const out = [];
    for (let i = 0; i < cfg.shardLibraries.length; i++) {
      try {
        out.push(_normalizeLibrary(cfg.shardLibraries[i], configDir, i));
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (errors.length > 0) {
      throw new ShardValidationError(
        `Invalid shardLibraries[] in ${abs}:\n  - ${errors.join('\n  - ')}`
      );
    }
    libs = out;
  } else {
    // Synthesize from legacy tasksSource.primary (blueprint §3)
    libs = [_synthesizeLegacyLibrary(cfg, configDir, abs)];
  }

  _cache.set(abs, libs);
  return libs;
}

/**
 * Locate a shard JSON file by ID under a library.
 *
 * Convention: `<library.shardDir>/<id>.json` (e.g. `.tasks/tasks/TASK-001.json`).
 * Returns null if the file does not exist — never throws on missing.
 *
 * @param {ShardLibrary} library  Library handle from loadLibraries.
 * @param {string} id             Shard ID (e.g. "TASK-001"). Used verbatim as filename stem.
 * @returns {string|null}         Absolute path to the shard file, or null if not found.
 * @throws {ShardLibraryError}    If library is malformed (missing shardDir) or id is invalid.
 */
export function locateShard(library, id) {
  if (!library || typeof library.shardDir !== 'string') {
    throw new ShardLibraryError('locateShard: library is missing shardDir');
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new ShardLibraryError('locateShard: id must be a non-empty string');
  }
  const candidate = path.join(library.shardDir, `${id}.json`);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Atomically read → mutate → write a shard. Mutator receives the parsed shard
 * and must return the new shard. On any failure between locate and rename,
 * the original file is left byte-identical and the .tmp file is best-effort
 * cleaned up (LD-PAT-002).
 *
 * Validation is intentionally cheap (presence of id/status/updated). Full
 * schema validation belongs to the rebuild CLI (library.rebuildCmd) — see
 * LD-ARC-002. This module never writes INDEX.json.
 *
 * @param {ShardLibrary} library                       Library handle from loadLibraries.
 * @param {string} id                                  Shard ID (e.g. "TASK-001").
 * @param {(shard: object) => object} mutator          Pure function returning the new shard.
 * @returns {object}                                   The written shard.
 * @throws {ShardNotFoundError}    Shard file does not exist.
 * @throws {ShardValidationError}  Mutator returned an invalid shape, or file contained invalid JSON.
 * @throws {ShardLibraryError}     Read/write/rename failure.
 */
export function updateShard(library, id, mutator) {
  // 1. Locate
  const target = locateShard(library, id);
  if (target === null) {
    throw new ShardNotFoundError(
      `Shard ${id} not found in library ${library.id} (looked under ${library.shardDir})`
    );
  }

  // 2. Read + parse (guarded — LD-BUG-004)
  let raw, current;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (e) {
    throw new ShardLibraryError(`Failed to read ${target}: ${e.message}`);
  }
  try {
    current = JSON.parse(raw);
  } catch (e) {
    throw new ShardValidationError(`Invalid JSON in ${target}: ${e.message}`);
  }

  // 3. Mutate + validate shape
  const next = mutator(current);
  validateShardShape(next, target);

  // 4. Atomic write (LD-PAT-002)
  const tmp = path.join(path.dirname(target), path.basename(target) + '.tmp');
  const payload = JSON.stringify(next, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, target); // atomic on same filesystem (POSIX + NTFS)
  } catch (e) {
    // Best-effort cleanup of orphan tmp; ignore unlink failures.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new ShardLibraryError(`Atomic write failed for ${target}: ${e.message}`);
  }

  return next;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _normalizeLibrary(entry, configDir, indexHint) {
  if (!entry || typeof entry !== 'object') {
    throw new ShardValidationError(`shardLibraries[${indexHint}]: entry must be an object`);
  }
  const required = ['id', 'indexPath', 'shardDir', 'rebuildCmd'];
  for (const f of required) {
    if (typeof entry[f] !== 'string' || entry[f].length === 0) {
      throw new ShardValidationError(
        `shardLibraries[${indexHint}]: missing or invalid required field "${f}"`
      );
    }
  }
  const indexPath = path.resolve(configDir, entry.indexPath);
  const shardDir = path.resolve(configDir, entry.shardDir);
  const indexDir = path.dirname(indexPath);
  const schemaPath = entry.schemaPath
    ? path.resolve(configDir, entry.schemaPath)
    : path.join(indexDir, 'schemas', 'task.schema.json');

  return {
    id:         entry.id,
    name:       entry.name || entry.id,
    indexPath,
    indexDir,
    shardDir,
    schemaPath,
    statusMap:  entry.statusMap ?? null,
    linkField:  entry.linkField ?? null,
    primary:    entry.primary === true,
    rebuildCmd: entry.rebuildCmd,
  };
}

function _synthesizeLegacyLibrary(cfg, configDir, configPath) {
  const primary = cfg?.tasksSource?.primary ?? null;

  if (primary === null) {
    throw new ShardLibraryError(
      `No shardLibraries configured and no tasksSource.primary in ${configPath}. ` +
      `Add a shardLibraries[] entry to enable shard I/O.`
    );
  }

  if (typeof primary === 'string' && primary.endsWith('.json')) {
    const indexPath = path.resolve(configDir, primary);
    const indexDir = path.dirname(indexPath);
    const lib = {
      id: 'tasks',
      name: 'Tasks',
      indexPath,
      indexDir,
      shardDir:   path.join(indexDir, 'tasks'),
      schemaPath: path.join(indexDir, 'schemas', 'task.schema.json'),
      statusMap:  null,
      linkField:  'resolves',
      primary:    true,
      rebuildCmd: 'npx tasklist-rebuild',
    };
    debugWarn(
      `Synthesized "tasks" library from tasksSource.primary=${primary}. ` +
      `Defaults: shardDir=${lib.shardDir}, schemaPath=${lib.schemaPath}, ` +
      `rebuildCmd="${lib.rebuildCmd}", linkField="resolves". ` +
      `Set shardLibraries[] in .orchestrator.json to silence.`
    );
    return lib;
  }

  // CASE B — Markdown primary (current orchestrator state)
  const indexDir = path.join(configDir, '.tasks');
  const lib = {
    id: 'tasks',
    name: 'Tasks',
    indexPath:  path.join(indexDir, 'INDEX.json'),
    indexDir,
    shardDir:   path.join(indexDir, 'tasks'),
    schemaPath: path.join(indexDir, 'schemas', 'task.schema.json'),
    statusMap:  null,
    linkField:  'resolves',
    primary:    true,
    rebuildCmd: 'npx tasklist-rebuild',
  };
  debugWarn(
    `tasksSource.primary points at Markdown "${primary}"; ` +
    `synthesizing default .tasks/ library. Defaults: indexPath=${lib.indexPath}, ` +
    `shardDir=${lib.shardDir}, rebuildCmd="${lib.rebuildCmd}". ` +
    `Set shardLibraries[] in .orchestrator.json to silence.`
  );
  return lib;
}

function validateShardShape(shard, sourcePath) {
  if (!shard || typeof shard !== 'object') {
    throw new ShardValidationError(`Mutator returned non-object for ${sourcePath}`);
  }
  for (const f of ['id', 'status', 'updated']) {
    if (typeof shard[f] !== 'string' || shard[f].length === 0) {
      throw new ShardValidationError(
        `Mutator returned shard missing required field "${f}" for ${sourcePath}`
      );
    }
  }
  // Cheap ISO-8601 sniff — full validation is the rebuild CLI's job.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(shard.updated)) {
    throw new ShardValidationError(
      `Field "updated" must be ISO-8601 timestamp, got "${shard.updated}" in ${sourcePath}`
    );
  }
}
