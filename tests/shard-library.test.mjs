// tests/shard-library.test.mjs
//
// Unit tests for lib/shard-library.mjs — covers all 6 public APIs
// (loadLibraries, locateShard, updateShard, rebuildLibrary,
//  resolveStatusVocab, scanLinks). The 3 error classes are tested
// implicitly via thrown errors. __resetCache is used as test
// infrastructure to guarantee isolation between cases.
//
// Hard rules honored:
//   - ESM only (LD-PAT-001 — pure lib, thin CLI; this file is pure test).
//   - No mocks of fs — real FS in tmp dirs only.
//   - Committed fixtures under tests/fixtures/{tasks,issues}-fixture/
//     are NEVER mutated. Writes go to tests/fixtures/tmp/<unique>/.
//   - Every path via path.join / path.resolve (LD-XPL-001).
//   - LD-BUG-009: every error path is exercised (no zero-coverage helpers).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadLibraries,
  locateShard,
  updateShard,
  rebuildLibrary,
  resolveStatusVocab,
  scanLinks,
  ShardLibraryError,
  ShardNotFoundError,
  ShardValidationError,
  __resetCache,
} from '../lib/shard-library.mjs';

// ---------------------------------------------------------------------------
// Path helpers (no string concat — LD-XPL-001)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures');
const TASKS_FIXTURE = path.join(FIXTURES_DIR, 'tasks-fixture');
const ISSUES_FIXTURE = path.join(FIXTURES_DIR, 'issues-fixture');
const TMP_ROOT = path.join(FIXTURES_DIR, 'tmp');

/**
 * Build a real ShardLibrary handle pointing at the committed tasks fixture.
 * Mirrors the shape produced by _normalizeLibrary so we can exercise the
 * pure-API functions (locateShard, resolveStatusVocab, scanLinks) without
 * round-tripping through a config file.
 */
function tasksLibrary(overrides = {}) {
  const indexDir = path.join(TASKS_FIXTURE, '.tasks');
  return {
    id: 'tasks',
    name: 'Tasks',
    indexPath: path.join(indexDir, 'INDEX.json'),
    indexDir,
    shardDir: path.join(indexDir, 'tasks'),
    schemaPath: path.join(indexDir, 'schemas', 'task.schema.json'),
    statusMap: null,
    linkField: 'resolves',
    primary: true,
    rebuildCmd: null,
    ...overrides,
  };
}

function issuesLibrary(overrides = {}) {
  const indexDir = path.join(ISSUES_FIXTURE, '.issues');
  return {
    id: 'issues',
    name: 'Issues',
    indexPath: path.join(indexDir, 'INDEX.json'),
    indexDir,
    shardDir: path.join(indexDir, 'issues'),
    schemaPath: path.join(indexDir, 'schemas', 'issue.schema.json'),
    statusMap: null,
    linkField: 'resolves',
    primary: false,
    rebuildCmd: null,
    ...overrides,
  };
}

// Per-test unique temp dir under tests/fixtures/tmp/. Cleaned up in afterEach.
let _tmpDirs = [];
function makeTmpDir(label = 'case') {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(TMP_ROOT, `${label}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  _tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  __resetCache();
});

afterEach(() => {
  for (const d of _tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  _tmpDirs = [];
  vi.restoreAllMocks();
});

// ===========================================================================
// loadLibraries
// ===========================================================================

describe('loadLibraries', () => {
  it('synthesizes a default tasks library when shardLibraries is absent (legacy tasksSource.primary as Markdown)', () => {
    const dir = makeTmpDir('legacy-md');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      tasksSource: { primary: 'TASKS.md' },
    }));

    const libs = loadLibraries(cfgPath);
    expect(libs).toHaveLength(1);
    const [lib] = libs;
    expect(lib.id).toBe('tasks');
    expect(lib.primary).toBe(true);
    expect(lib.linkField).toBe('resolves');
    expect(lib.rebuildCmd).toBe('npx tasklist-rebuild');
    // Path resolution must be relative to configDir (LD-CLI-001).
    expect(lib.indexDir).toBe(path.join(dir, '.tasks'));
    expect(lib.shardDir).toBe(path.join(dir, '.tasks', 'tasks'));
    expect(lib.schemaPath).toBe(path.join(dir, '.tasks', 'schemas', 'task.schema.json'));
  });

  it('synthesizes a tasks library when tasksSource.primary points at a JSON index', () => {
    const dir = makeTmpDir('legacy-json');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      tasksSource: { primary: '.tasks/INDEX.json' },
    }));

    const libs = loadLibraries(cfgPath);
    expect(libs).toHaveLength(1);
    expect(libs[0].indexPath).toBe(path.join(dir, '.tasks', 'INDEX.json'));
    expect(libs[0].shardDir).toBe(path.join(dir, '.tasks', 'tasks'));
  });

  it('loads a multi-library config (tasks + issues) with explicit fields', () => {
    const dir = makeTmpDir('multi');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      shardLibraries: [
        {
          id: 'tasks',
          name: 'Tasks',
          indexPath: '.tasks/INDEX.json',
          shardDir: '.tasks/tasks',
          schemaPath: '.tasks/schemas/task.schema.json',
          linkField: 'resolves',
          primary: true,
          rebuildCmd: 'npx tasklist-rebuild',
        },
        {
          id: 'issues',
          indexPath: '.issues/INDEX.json',
          shardDir: '.issues/issues',
          rebuildCmd: 'npx issues-rebuild',
        },
      ],
    }));

    const libs = loadLibraries(cfgPath);
    expect(libs).toHaveLength(2);
    expect(libs[0].id).toBe('tasks');
    expect(libs[0].primary).toBe(true);
    expect(libs[0].schemaPath).toBe(path.join(dir, '.tasks', 'schemas', 'task.schema.json'));
    expect(libs[1].id).toBe('issues');
    expect(libs[1].primary).toBe(false);
    // Default schemaPath fallback when not supplied.
    expect(libs[1].schemaPath).toBe(path.join(dir, '.issues', 'schemas', 'task.schema.json'));
    expect(libs[1].name).toBe('issues'); // name defaults to id
  });

  it('throws ShardValidationError on a malformed entry — missing shardDir', () => {
    const dir = makeTmpDir('bad-shardDir');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      shardLibraries: [
        { id: 'tasks', indexPath: '.tasks/INDEX.json', rebuildCmd: 'noop' },
      ],
    }));

    expect(() => loadLibraries(cfgPath)).toThrow(ShardValidationError);
    expect(() => loadLibraries(cfgPath)).toThrow(/shardDir/);
  });

  it('throws ShardLibraryError when config file is unreadable', () => {
    const missing = path.join(TMP_ROOT, 'nope-this-does-not-exist.json');
    expect(() => loadLibraries(missing)).toThrow(ShardLibraryError);
  });

  it('throws ShardValidationError on invalid JSON in config', () => {
    const dir = makeTmpDir('bad-json');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, '{ not valid json');
    expect(() => loadLibraries(cfgPath)).toThrow(ShardValidationError);
  });

  it('throws ShardLibraryError when no shardLibraries and no tasksSource.primary', () => {
    const dir = makeTmpDir('empty-cfg');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, JSON.stringify({}));
    expect(() => loadLibraries(cfgPath)).toThrow(ShardLibraryError);
    expect(() => loadLibraries(cfgPath)).toThrow(/No shardLibraries/);
  });

  it('throws ShardValidationError when entry is not an object', () => {
    const dir = makeTmpDir('non-obj');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      shardLibraries: ['not-an-object'],
    }));
    expect(() => loadLibraries(cfgPath)).toThrow(ShardValidationError);
  });

  it('caches by absolute config path — same call returns same object reference', () => {
    const dir = makeTmpDir('cache');
    const cfgPath = path.join(dir, '.orchestrator.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      tasksSource: { primary: 'TASKS.md' },
    }));

    const a = loadLibraries(cfgPath);
    const b = loadLibraries(cfgPath);
    expect(a).toBe(b); // identity, not just equality
    expect(a[0]).toBe(b[0]);
  });
});

// ===========================================================================
// locateShard
// ===========================================================================

describe('locateShard', () => {
  it('returns the absolute path when the shard exists', () => {
    const lib = tasksLibrary();
    const found = locateShard(lib, 'TASK-001');
    expect(found).toBe(path.join(lib.shardDir, 'TASK-001.json'));
    expect(fs.existsSync(found)).toBe(true);
  });

  it('returns null when the shard does not exist (never throws on missing)', () => {
    const lib = tasksLibrary();
    expect(locateShard(lib, 'TASK-999')).toBeNull();
  });

  it.each([
    ['lowercase', 'task-001'],
    ['no hyphen', 'TASK001'],
    ['path traversal', '../foo'],
    ['extension included', 'TASK-1.json'],
    ['separator', 'TASK-1/x'],
    ['empty string', ''],
  ])('throws ShardLibraryError on invalid id (%s)', (_label, badId) => {
    const lib = tasksLibrary();
    expect(() => locateShard(lib, badId)).toThrow(ShardLibraryError);
  });

  it('throws when id is not a string', () => {
    const lib = tasksLibrary();
    expect(() => locateShard(lib, 123)).toThrow(ShardLibraryError);
  });

  it('throws when library is missing shardDir', () => {
    expect(() => locateShard({ id: 'tasks' }, 'TASK-001'))
      .toThrow(/missing shardDir/);
    expect(() => locateShard(null, 'TASK-001')).toThrow(ShardLibraryError);
  });
});

// ===========================================================================
// updateShard
// ===========================================================================

describe('updateShard', () => {
  /**
   * Copy the committed tasks fixture into a fresh tmp dir so writes never
   * touch the canonical files. Returns a library handle pointing at the copy.
   */
  function copyTasksFixtureToTmp() {
    const dir = makeTmpDir('upd');
    const indexDir = path.join(dir, '.tasks');
    const shardDir = path.join(indexDir, 'tasks');
    fs.mkdirSync(shardDir, { recursive: true });
    // Only need one shard for these tests; copy TASK-001.
    const src = path.join(TASKS_FIXTURE, '.tasks', 'tasks', 'TASK-001.json');
    fs.copyFileSync(src, path.join(shardDir, 'TASK-001.json'));
    return tasksLibrary({ indexDir, shardDir });
  }

  it('atomic write happy path — mutator return value is persisted and returned', () => {
    const lib = copyTasksFixtureToTmp();
    const newTimestamp = '2026-02-01T00:00:00.000Z';

    const written = updateShard(lib, 'TASK-001', (shard) => ({
      ...shard,
      status: 'in-progress',
      updated: newTimestamp,
    }));

    expect(written.status).toBe('in-progress');
    expect(written.updated).toBe(newTimestamp);

    const onDisk = JSON.parse(fs.readFileSync(path.join(lib.shardDir, 'TASK-001.json'), 'utf8'));
    expect(onDisk.status).toBe('in-progress');
    expect(onDisk.updated).toBe(newTimestamp);
    expect(onDisk.id).toBe('TASK-001'); // untouched

    // No orphan tmp left behind.
    const remaining = fs.readdirSync(lib.shardDir);
    expect(remaining.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('throws ShardValidationError when mutator drops a required field (status)', () => {
    const lib = copyTasksFixtureToTmp();
    expect(() =>
      updateShard(lib, 'TASK-001', (shard) => {
        const next = { ...shard, updated: '2026-02-01T00:00:00.000Z' };
        delete next.status;
        return next;
      })
    ).toThrow(ShardValidationError);

    // Original untouched.
    const onDisk = JSON.parse(fs.readFileSync(path.join(lib.shardDir, 'TASK-001.json'), 'utf8'));
    expect(onDisk.status).toBe('done');
  });

  it('throws ShardValidationError when mutator returns a non-object', () => {
    const lib = copyTasksFixtureToTmp();
    expect(() => updateShard(lib, 'TASK-001', () => null)).toThrow(ShardValidationError);
  });

  it('throws ShardValidationError when "updated" is not ISO-8601', () => {
    const lib = copyTasksFixtureToTmp();
    expect(() =>
      updateShard(lib, 'TASK-001', (s) => ({ ...s, updated: 'yesterday' }))
    ).toThrow(/ISO-8601/);
  });

  it('throws ShardNotFoundError when the shard does not exist', () => {
    const lib = copyTasksFixtureToTmp();
    expect(() => updateShard(lib, 'TASK-999', (s) => s)).toThrow(ShardNotFoundError);
  });

  it('throws before any FS access on invalid id (path-traversal guard)', () => {
    const lib = copyTasksFixtureToTmp();
    const before = fs.readdirSync(lib.shardDir).slice().sort();
    expect(() => updateShard(lib, '../foo', (s) => s)).toThrow(ShardLibraryError);
    const after = fs.readdirSync(lib.shardDir).slice().sort();
    expect(after).toEqual(before);
  });

  it('cleans up .tmp file when validation fails after write attempt', () => {
    // Validation runs BEFORE any tmp write — so no .tmp can exist.
    // This case asserts the shardDir is clean of .tmp after a failed mutation.
    const lib = copyTasksFixtureToTmp();
    expect(() =>
      updateShard(lib, 'TASK-001', (s) => ({ ...s, status: '' }))
    ).toThrow(ShardValidationError);

    const remaining = fs.readdirSync(lib.shardDir);
    expect(remaining.some((f) => f.endsWith('.tmp'))).toBe(false);
    // Original byte-identical.
    const original = fs.readFileSync(
      path.join(TASKS_FIXTURE, '.tasks', 'tasks', 'TASK-001.json'),
      'utf8'
    );
    const live = fs.readFileSync(path.join(lib.shardDir, 'TASK-001.json'), 'utf8');
    expect(live).toBe(original);
  });

  it('throws ShardValidationError on invalid JSON on disk', () => {
    const lib = copyTasksFixtureToTmp();
    fs.writeFileSync(path.join(lib.shardDir, 'TASK-001.json'), '{ not json');
    expect(() => updateShard(lib, 'TASK-001', (s) => s)).toThrow(ShardValidationError);
  });
});

// ===========================================================================
// rebuildLibrary
// ===========================================================================

describe('rebuildLibrary', () => {
  it('returns { ok: false, reason: /no rebuildCmd/ } when rebuildCmd is null (silent — no warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = tasksLibrary({ rebuildCmd: null });
    const res = rebuildLibrary(lib);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no rebuildCmd/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns { ok: false } when rebuildCmd is empty string', () => {
    const lib = tasksLibrary({ rebuildCmd: '' });
    const res = rebuildLibrary(lib);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no rebuildCmd/);
  });

  it('returns { ok: true } when the command exits zero', () => {
    const lib = tasksLibrary({ rebuildCmd: 'node -e "process.exit(0)"' });
    const res = rebuildLibrary(lib);
    expect(res).toEqual({ ok: true });
  });

  it('returns { ok: false, reason: /install/ } on ENOENT, never throws, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = tasksLibrary({ rebuildCmd: 'this-binary-xyz-nope-12345' });
    let res;
    expect(() => { res = rebuildLibrary(lib); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/install/i);
    expect(warn).toHaveBeenCalled();
  });

  it('returns { ok: false, reason: /exited 1/ } on non-zero exit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = tasksLibrary({ rebuildCmd: 'node -e "process.exit(1)"' });
    const res = rebuildLibrary(lib);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/exited 1/);
    expect(warn).toHaveBeenCalled();
  });
});

// ===========================================================================
// resolveStatusVocab
// ===========================================================================

describe('resolveStatusVocab', () => {
  it('infers { start: "in-progress", done: "done" } from the tasks-fixture schema', () => {
    const lib = tasksLibrary();
    expect(resolveStatusVocab(lib)).toEqual({ start: 'in-progress', done: 'done' });
  });

  it('infers { start: "in-progress", done: "resolved" } from the issues-fixture schema', () => {
    const lib = issuesLibrary();
    expect(resolveStatusVocab(lib)).toEqual({ start: 'in-progress', done: 'resolved' });
  });

  it('returns library.statusMap as-is when both start and done are non-empty strings', () => {
    const lib = tasksLibrary({ statusMap: { start: 'doing', done: 'shipped' } });
    expect(resolveStatusVocab(lib)).toEqual({ start: 'doing', done: 'shipped' });
  });

  it('throws ShardLibraryError on partial statusMap (only start) with an actionable message', () => {
    const lib = tasksLibrary({ statusMap: { start: 'doing' } });
    expect(() => resolveStatusVocab(lib)).toThrow(ShardLibraryError);
    expect(() => resolveStatusVocab(lib)).toThrow(/both 'start' and 'done'/);
  });

  it('throws when statusMap is non-object', () => {
    const lib = tasksLibrary({ statusMap: 'in-progress' });
    expect(() => resolveStatusVocab(lib)).toThrow(/must be an object/);
  });

  it('throws when schema file is missing', () => {
    const lib = tasksLibrary({ schemaPath: path.join(TMP_ROOT, 'no-such.schema.json') });
    expect(() => resolveStatusVocab(lib)).toThrow(/schema not found/);
  });

  it('throws when library has no schemaPath', () => {
    const lib = tasksLibrary({ schemaPath: '' });
    expect(() => resolveStatusVocab(lib)).toThrow(/no schemaPath/);
  });

  it('throws when schema lacks properties.status.enum', () => {
    const dir = makeTmpDir('bad-schema');
    const schemaPath = path.join(dir, 'bad.schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify({ type: 'object' }));
    const lib = tasksLibrary({ schemaPath });
    expect(() => resolveStatusVocab(lib)).toThrow(/properties\.status\.enum/);
  });

  it('throws ShardValidationError on malformed schema JSON', () => {
    const dir = makeTmpDir('bad-schema-json');
    const schemaPath = path.join(dir, 'bad.schema.json');
    fs.writeFileSync(schemaPath, '{ not json');
    const lib = tasksLibrary({ schemaPath });
    expect(() => resolveStatusVocab(lib)).toThrow(ShardValidationError);
  });

  it('throws when no enum value matches the start heuristic', () => {
    const dir = makeTmpDir('no-start');
    const schemaPath = path.join(dir, 'no-start.schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify({
      properties: { status: { enum: ['planning', 'done'] } },
    }));
    const lib = tasksLibrary({ schemaPath });
    expect(() => resolveStatusVocab(lib)).toThrow(/Cannot infer 'start'/);
  });

  it('throws when multiple enum values match the same heuristic (ambiguous)', () => {
    const dir = makeTmpDir('amb');
    const schemaPath = path.join(dir, 'amb.schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify({
      properties: { status: { enum: ['done', 'completed', 'in-progress'] } },
    }));
    const lib = tasksLibrary({ schemaPath });
    expect(() => resolveStatusVocab(lib)).toThrow(/Ambiguous 'done'/);
  });

  it('throws when library is not an object', () => {
    expect(() => resolveStatusVocab(null)).toThrow(/must be an object/);
  });

  it('caches per-library: second call returns same reference even if statusMap mutated', () => {
    const lib = tasksLibrary();
    const a = resolveStatusVocab(lib);
    // Mutate statusMap between calls — cache must win.
    lib.statusMap = { start: 'X', done: 'Y' };
    const b = resolveStatusVocab(lib);
    expect(b).toBe(a);

    // After __resetCache, the new statusMap takes effect.
    __resetCache();
    const c = resolveStatusVocab(lib);
    expect(c).toEqual({ start: 'X', done: 'Y' });
    expect(c).not.toBe(a);
  });

  // TASK-026 — error.code discriminator (vocab-error: prefix)
  it('tags ambiguous start vocab errors with code "vocab-error:ambiguous-start"', () => {
    const dir = makeTmpDir('amb-code');
    const schemaPath = path.join(dir, 'amb.schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify({
      properties: { status: { enum: ['backlog', 'in-progress', 'active', 'done'] } },
    }));
    const lib = tasksLibrary({ schemaPath });
    try {
      resolveStatusVocab(lib);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ShardLibraryError);
      expect(e.code).toBe('vocab-error:ambiguous-start');
    }
  });

  it('tags partial statusMap errors with code "vocab-error:statusmap-partial"', () => {
    const lib = tasksLibrary({ statusMap: { start: 'doing' } });
    try {
      resolveStatusVocab(lib);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ShardLibraryError);
      expect(e.code).toBe('vocab-error:statusmap-partial');
    }
  });
});

// ===========================================================================
// scanLinks
// ===========================================================================

describe('scanLinks', () => {
  it('returns an empty Map when the shard has no description, notes, or linkField hits', () => {
    const tasks = tasksLibrary();
    const issues = issuesLibrary();
    const result = scanLinks({ id: 'TASK-001' }, [tasks, issues]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('routes explicit linkField (array) to the owning library regardless of prefix', () => {
    const tasks = tasksLibrary();
    const issues = issuesLibrary({ linkField: 'resolves' });
    // tasks.linkField is also 'resolves'; the explicit pass routes by library
    // owning the field, so each library claims its own copy of the array. To
    // avoid double-counting we configure tasks with a different field.
    const tasksNoLink = tasksLibrary({ linkField: null });
    const result = scanLinks(
      { id: 'TASK-002', resolves: ['ISSUE-001'] },
      [tasksNoLink, issues]
    );
    expect(result.size).toBe(1);
    expect(Array.from(result.get('issues'))).toEqual(['ISSUE-001']);
  });

  it('accepts a string linkField value (not array) as a single element', () => {
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: 'resolves' });
    const result = scanLinks(
      { id: 'TASK-002', resolves: 'ISSUE-001' },
      [tasksNoLink, issues]
    );
    expect(Array.from(result.get('issues'))).toEqual(['ISSUE-001']);
  });

  it('keyword regex is case-insensitive and matches "fix(es|ed)?", "close[sd]?", "resolve[sd]?"', () => {
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: null });
    const result = scanLinks(
      {
        id: 'TASK-002',
        description: 'Fixes ISSUE-001 and CLOSED issue-001',
        notes: 'resolved ISSUE-001',
      },
      [tasksNoLink, issues]
    );
    // All three matches collapse to ISSUE-001 (uppercased + deduped).
    expect(Array.from(result.get('issues'))).toEqual(['ISSUE-001']);
  });

  it('explicit + keyword union deduplicates', () => {
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: 'resolves' });
    const result = scanLinks(
      {
        id: 'TASK-002',
        resolves: ['ISSUE-001'],
        description: 'closes ISSUE-001',
      },
      [tasksNoLink, issues]
    );
    const ids = Array.from(result.get('issues'));
    expect(ids).toEqual(['ISSUE-001']); // deduped
  });

  it('emits a warning + drops the link when ID prefix matches no library', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: null });
    const result = scanLinks(
      { id: 'TASK-002', description: 'fixes FOO-001' },
      [tasksNoLink, issues]
    );
    expect(result.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(msg).toMatch(/unknown ID prefix 'FOO'/);
  });

  it('drops self-references via keyword scanning', () => {
    const tasks = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: null });
    const result = scanLinks(
      { id: 'TASK-001', description: 'fixes TASK-001 (self ref)' },
      [tasks, issues]
    );
    expect(result.size).toBe(0);
  });

  it('drops self-references via explicit linkField too', () => {
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: 'resolves' });
    const result = scanLinks(
      { id: 'ISSUE-001', resolves: ['ISSUE-001', 'ISSUE-002'] },
      [tasksNoLink, issues]
    );
    // Only ISSUE-002 survives. (Even though no ISSUE-002 exists on disk —
    // explicit pass routes by library ownership, not by prefix sampling.)
    expect(Array.from(result.get('issues'))).toEqual(['ISSUE-002']);
  });

  it('warns on non-array, non-string linkField values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: 'resolves' });
    const result = scanLinks(
      { id: 'TASK-002', resolves: 42 },
      [tasksNoLink, issues]
    );
    expect(result.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('warns on non-string array entries and on invalid shard IDs in the array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issues = issuesLibrary({ linkField: 'resolves' });
    const result = scanLinks(
      { id: 'TASK-002', resolves: [42, 'not-a-valid-id', 'ISSUE-009', '   '] },
      [tasksNoLink, issues]
    );
    expect(Array.from(result.get('issues'))).toEqual(['ISSUE-009']);
    expect(warn).toHaveBeenCalled();
  });

  it('skips libraries with no linkField in the explicit pass', () => {
    const tasksNoLink = tasksLibrary({ linkField: null });
    const issuesNoLink = issuesLibrary({ linkField: null });
    const result = scanLinks(
      { id: 'TASK-002', resolves: ['ISSUE-001'] },
      [tasksNoLink, issuesNoLink]
    );
    // No keyword text, no library will claim explicit field.
    expect(result.size).toBe(0);
  });

  it('returns an empty Map when allLibraries is empty', () => {
    const result = scanLinks({ id: 'TASK-001', description: 'fixes ISSUE-001' }, []);
    expect(result.size).toBe(0);
  });

  it('throws when taskShard is not an object', () => {
    expect(() => scanLinks(null, [])).toThrow(ShardLibraryError);
    expect(() => scanLinks('nope', [])).toThrow(ShardLibraryError);
  });

  it('throws when taskShard.id is missing', () => {
    expect(() => scanLinks({}, [])).toThrow(/taskShard\.id/);
  });

  it('throws when allLibraries is not an array', () => {
    expect(() => scanLinks({ id: 'TASK-001' }, 'nope')).toThrow(/must be an array/);
  });

  it('silently skips libraries whose shardDir cannot be read (no crash)', () => {
    const tasksNoLink = tasksLibrary({ linkField: null });
    // Library pointing at a non-existent shardDir — readdirSync throws,
    // _resolveLibraryPrefix swallows + returns null prefix, _buildPrefixIndex
    // skips it. Keyword "fixes ISSUE-001" then has no library to route to,
    // and the unknown-prefix warning fires for ISSUE.
    const issuesGhost = issuesLibrary({
      linkField: null,
      shardDir: path.join(TMP_ROOT, 'no-such-dir-zzz'),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = scanLinks(
      { id: 'TASK-002', description: 'fixes ISSUE-001' },
      [tasksNoLink, issuesGhost]
    );
    expect(result.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('silently skips libraries whose shardDir contains no matching shard files', () => {
    const dir = makeTmpDir('empty-shards');
    const shardDir = path.join(dir, 'tasks');
    fs.mkdirSync(shardDir, { recursive: true });
    // Create a non-matching file so readdir returns entries but none match SHARD_FILE_RE.
    fs.writeFileSync(path.join(shardDir, 'README.md'), '# nope\n');
    const tasksOnlyEmpty = tasksLibrary({ linkField: null, shardDir });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = scanLinks(
      { id: 'BUG-001', description: 'fixes TASK-003' },
      [tasksOnlyEmpty]
    );
    // Prefix unresolved → no library indexed → unknown-prefix warning.
    expect(result.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('warns when two libraries claim the same prefix (first declared wins)', () => {
    // Build a second tmp library whose shards also start with TASK-.
    const dir = makeTmpDir('dup-prefix');
    const shardDir = path.join(dir, 'tasks');
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(path.join(shardDir, 'TASK-500.json'), JSON.stringify({ id: 'TASK-500' }));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tasksA = tasksLibrary({ linkField: null });
    const tasksB = tasksLibrary({ id: 'tasks-alt', linkField: null, shardDir });

    const result = scanLinks(
      { id: 'TASK-002', description: 'closes TASK-003' },
      [tasksA, tasksB]
    );
    // Routes to first declared (tasksA).
    expect(Array.from(result.get('tasks'))).toEqual(['TASK-003']);
    expect(result.has('tasks-alt')).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/claimed by both libraries/);
  });
});
