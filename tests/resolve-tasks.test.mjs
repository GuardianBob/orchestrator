// tests/resolve-tasks.test.mjs
//
// Full-integration test suite for scripts/resolve-tasks.mjs (TASK-008).
// Each test invokes the resolver via execSync (fresh node process) so the
// shard-library module cache cannot leak between cases.
//
// Groups:
//   A. Snapshot regression  — 6 byte-identical baselines from tests/snapshots/.
//   B. Sharded library      — synthesized configs in tests/fixtures/tmp/.
//   C. Multi-library        — tasks + issues fixtures coexisting.
//   D. Error paths          — 0-primary and >1-primary configs.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RESOLVER = path.join(REPO_ROOT, 'scripts', 'resolve-tasks.mjs');
const SNAPSHOTS_DIR = path.join(REPO_ROOT, 'tests', 'snapshots');
const TMP_BASE = path.join(REPO_ROOT, 'tests', 'fixtures', 'tmp');

// Ensure the gitignored tmp parent exists.
fs.mkdirSync(TMP_BASE, { recursive: true });

/** Run the resolver. Returns { stdout, stderr, status }.
 *  Uses spawnSync so we always get stderr regardless of exit code. */
function runResolver(target, cwd = REPO_ROOT) {
  const args = [RESOLVER, ...String(target).split(/\s+/).filter(Boolean)];
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? 1,
  };
}

/** Make a fresh tmp dir for a single test. */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(TMP_BASE, 'resolve-'));
}

/** Recursively remove a directory if it exists. */
function rmDir(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Write JSON to a path, ensuring parent dirs exist. */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** Write raw text to a path, ensuring parent dirs exist. */
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------
// A. Snapshot regression — locks post-migration output as the contract.
// ---------------------------------------------------------------------------
describe('resolve-tasks snapshot regression', () => {
  const targets = ['next', 'sprint-1', 'sprint-4', 'task-001', 'count:3', 'count:50'];
  for (const t of targets) {
    test(`target "${t}" matches snapshot byte-for-byte`, () => {
      const safe = t.replace(/:/g, '_');
      const snapPath = path.join(SNAPSHOTS_DIR, `resolve-${safe}.json`);
      const expected = fs.readFileSync(snapPath, 'utf8');
      const { stdout, status } = runResolver(t);
      expect(status).toBe(0);
      // Snapshots include a trailing newline (file convention); resolver output
      // does not. Normalise by trimming both to a JSON-only comparison string.
      expect(stdout.replace(/\s+$/, '')).toBe(expected.replace(/\s+$/, ''));
    });
  }
});

// ---------------------------------------------------------------------------
// B. Sharded library loading — all in fresh tmp dirs with controlled configs.
// ---------------------------------------------------------------------------
describe('resolve-tasks sharded library loading', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  /** Convenience: write .orchestrator.json + a single shardLibraries entry. */
  function setupSingleLib(libId = 'tasks') {
    const indexPath = path.join('.tasks', 'INDEX.json');
    const shardDir = path.join('.tasks', 'tasks');
    writeJson(path.join(tmpDir, '.orchestrator.json'), {
      shardLibraries: [
        {
          id: libId,
          indexPath,
          shardDir,
          rebuildCmd: 'echo rebuild',
          primary: true,
        },
      ],
    });
    return { indexPath: path.join(tmpDir, indexPath), shardDir: path.join(tmpDir, shardDir) };
  }

  test('1. single sharded lib, 2 open tasks → both emit with source = lib id', () => {
    const { indexPath, shardDir } = setupSingleLib('tasks');
    writeJson(indexPath, {
      open_tasks: [
        { id: 'TASK-100', title: 'first open', status: 'backlog' },
        { id: 'TASK-101', title: 'second open', status: 'in-progress' },
      ],
    });
    writeJson(path.join(shardDir, 'TASK-100.json'), {
      id: 'TASK-100', title: 'first open', description: 'desc 100',
      acceptance_criteria: ['ac one'], priority: 'high', effort: 'M', tags: [],
    });
    writeJson(path.join(shardDir, 'TASK-101.json'), {
      id: 'TASK-101', title: 'second open', description: 'desc 101',
      acceptance_criteria: ['ac two'], priority: 'low', effort: 'S', tags: [],
    });

    const { stdout, status } = runResolver('count:10', tmpDir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.queue).toHaveLength(2);
    expect(parsed.queue.map(q => q.id)).toEqual(['TASK-100', 'TASK-101']);
    expect(parsed.queue.every(q => q.source === 'tasks')).toBe(true);
    expect(parsed.queue[0].body).toContain('desc 100');
    expect(parsed.queue[0].body).toContain('ac one');
  });

  test('2. done statuses (done/completed/archived/cancelled/closed) are filtered', () => {
    const { indexPath, shardDir } = setupSingleLib();
    const doneStatuses = ['done', 'completed', 'archived', 'cancelled', 'closed'];
    const open = [{ id: 'TASK-OPEN', title: 'survivor', status: 'backlog' }];
    const closed = doneStatuses.map((s, i) => ({
      id: `TASK-D${i}`, title: `dead-${s}`, status: s,
    }));
    writeJson(indexPath, { open_tasks: [...closed, ...open] });
    writeJson(path.join(shardDir, 'TASK-OPEN.json'), {
      id: 'TASK-OPEN', title: 'survivor', description: 'lives on',
      acceptance_criteria: [], tags: [],
    });

    const { stdout, status } = runResolver('count:50', tmpDir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.queue.map(q => q.id)).toEqual(['TASK-OPEN']);
  });

  test('3. missing shard file → warn to stderr, task emits with title-only body', () => {
    const { indexPath } = setupSingleLib();
    writeJson(indexPath, {
      open_tasks: [{ id: 'TASK-200', title: 'orphan', status: 'backlog' }],
    });
    // No shard file written.

    const { stdout, stderr, status } = runResolver('next', tmpDir);
    expect(status).toBe(0);
    expect(stderr).toMatch(/shard.*missing|TASK-200.*title-only/i);
    const parsed = JSON.parse(stdout);
    expect(parsed.queue[0].id).toBe('TASK-200');
    expect(parsed.queue[0].title).toBe('orphan');
    // Title-only body has no Description/Acceptance Criteria sections.
    expect(parsed.queue[0].body).not.toMatch(/## Description/);
    expect(parsed.queue[0].body).not.toMatch(/## Acceptance Criteria/);
  });

  test('4. invalid shard JSON → warn, task emits with title-only body', () => {
    const { indexPath, shardDir } = setupSingleLib();
    writeJson(indexPath, {
      open_tasks: [{ id: 'TASK-300', title: 'broken shard', status: 'backlog' }],
    });
    writeText(path.join(shardDir, 'TASK-300.json'), '{ this is not valid json');

    const { stdout, stderr, status } = runResolver('next', tmpDir);
    expect(status).toBe(0);
    expect(stderr).toMatch(/failed to parse shard/i);
    const parsed = JSON.parse(stdout);
    expect(parsed.queue[0].id).toBe('TASK-300');
    expect(parsed.queue[0].title).toBe('broken shard');
    expect(parsed.queue[0].body).not.toMatch(/## Description/);
  });

  test('5. sprint tag inference: sprint-3 tag → sprintId "3"; no tag → "1"', () => {
    const { indexPath, shardDir } = setupSingleLib();
    writeJson(indexPath, {
      open_tasks: [
        { id: 'TASK-S3', title: 'tagged', status: 'backlog', tags: ['sprint-3'] },
        { id: 'TASK-NO', title: 'untagged', status: 'backlog' },
      ],
    });
    for (const id of ['TASK-S3', 'TASK-NO']) {
      writeJson(path.join(shardDir, `${id}.json`), {
        id, title: id, description: 'd', acceptance_criteria: [], tags: [],
      });
    }

    const { stdout, status } = runResolver('count:10', tmpDir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const byId = Object.fromEntries(parsed.queue.map(q => [q.id, q]));
    expect(byId['TASK-S3'].sprintId).toBe('3');
    expect(byId['TASK-NO'].sprintId).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// C. Multi-library coexistence.
// ---------------------------------------------------------------------------
describe('resolve-tasks multi-library', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  function setupTwoLibs({ tasksPrimary = true, issuesPrimary = false } = {}) {
    const tasksIndex = path.join('.tasks', 'INDEX.json');
    const tasksShards = path.join('.tasks', 'tasks');
    const issuesIndex = path.join('.issues', 'INDEX.json');
    const issuesShards = path.join('.issues', 'issues');

    writeJson(path.join(tmpDir, '.orchestrator.json'), {
      shardLibraries: [
        {
          id: 'tasks',
          indexPath: tasksIndex,
          shardDir: tasksShards,
          rebuildCmd: 'echo rebuild',
          primary: tasksPrimary,
        },
        {
          id: 'issues',
          indexPath: issuesIndex,
          shardDir: issuesShards,
          rebuildCmd: 'echo rebuild',
          primary: issuesPrimary,
        },
      ],
    });

    // Both libraries use `open_tasks` (the resolver's contract — issues fixture
    // uses `open_issues` in its real INDEX, but the resolver only knows
    // `open_tasks`. Since the blueprint's multi-lib test wants tasks from both,
    // we write a tasks-shaped INDEX in each.).
    writeJson(path.join(tmpDir, tasksIndex), {
      open_tasks: [{ id: 'TASK-A1', title: 'from tasks', status: 'backlog' }],
    });
    writeJson(path.join(tmpDir, tasksShards, 'TASK-A1.json'), {
      id: 'TASK-A1', title: 'from tasks', description: 'd', acceptance_criteria: [], tags: [],
    });
    writeJson(path.join(tmpDir, issuesIndex), {
      open_tasks: [{ id: 'ISSUE-B1', title: 'from issues', status: 'open' }],
    });
    writeJson(path.join(tmpDir, issuesShards, 'ISSUE-B1.json'), {
      id: 'ISSUE-B1', title: 'from issues', description: 'd', acceptance_criteria: [], tags: [],
    });
  }

  test('1. two libs, both with INDEX.json → tasks ordered by config array order', () => {
    setupTwoLibs();
    const { stdout, status } = runResolver('count:10', tmpDir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.queue.map(q => q.id)).toEqual(['TASK-A1', 'ISSUE-B1']);
    expect(parsed.queue.map(q => q.source)).toEqual(['tasks', 'issues']);
  });

  test('2. tasks lib marked primary → both load, primary lookup resolves to tasks', () => {
    // We can't introspect the loaded library list directly via execSync, but
    // exit code 0 (no "no primary" / "multiple primary" throw) plus both
    // libs contributing tasks proves the primary check passed with tasks=primary.
    setupTwoLibs({ tasksPrimary: true, issuesPrimary: false });
    const { stdout, status } = runResolver('count:10', tmpDir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const sources = new Set(parsed.queue.map(q => q.source));
    expect(sources.has('tasks')).toBe(true);
    expect(sources.has('issues')).toBe(true);
  });

  test('3. markdown + sharded coexistence: both load, no duplicate from same path', () => {
    setupTwoLibs();
    // Add a TASKLIST.md with a single heading-style task. The resolver loads
    // it via the markdown branch and dedups by indexPath only (not by title),
    // so both shard tasks and the markdown task should appear.
    writeText(
      path.join(tmpDir, 'TASKLIST.md'),
      '## Sprint 1\n\n### task-md1 — markdown only task\n\nbody line\n',
    );
    // Point tasksSource.primary at TASKLIST.md so the resolver finds it.
    const cfgPath = path.join(tmpDir, '.orchestrator.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.tasksSource = { primary: 'TASKLIST.md' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const { stdout, status } = runResolver('count:10', tmpDir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const ids = parsed.queue.map(q => q.id);
    // Expect both shard libs + markdown task; no duplicate ids.
    expect(ids).toContain('TASK-A1');
    expect(ids).toContain('ISSUE-B1');
    expect(ids.some(id => /md1/i.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// D. Error paths — primary-count validation.
// ---------------------------------------------------------------------------
describe('resolve-tasks error paths', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  test('1. shardLibraries: [] (zero primaries) → exits non-zero with exact message', () => {
    // An empty array bypasses the synthesizer (length > 0 is required for
    // synthesis to be skipped) — but loadLibraries treats `length > 0` as the
    // explicit-config branch. An empty array hits synthesis. To force the
    // 0-primary path we need a non-empty array with no primary:true entries.
    writeJson(path.join(tmpDir, '.orchestrator.json'), {
      shardLibraries: [
        {
          id: 'tasks',
          indexPath: path.join('.tasks', 'INDEX.json'),
          shardDir: path.join('.tasks', 'tasks'),
          rebuildCmd: 'echo rebuild',
          // primary intentionally omitted — defaults to false.
        },
      ],
    });
    const { stderr, status } = runResolver('next', tmpDir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      'resolve-tasks: no shardLibraries entry has primary:true. ' +
      'Mark exactly one library as primary in .orchestrator.json.',
    );
  });

  test('2. two primary:true libraries → exits non-zero, lists offending ids', () => {
    writeJson(path.join(tmpDir, '.orchestrator.json'), {
      shardLibraries: [
        {
          id: 'tasks',
          indexPath: path.join('.tasks', 'INDEX.json'),
          shardDir: path.join('.tasks', 'tasks'),
          rebuildCmd: 'echo rebuild',
          primary: true,
        },
        {
          id: 'issues',
          indexPath: path.join('.issues', 'INDEX.json'),
          shardDir: path.join('.issues', 'issues'),
          rebuildCmd: 'echo rebuild',
          primary: true,
        },
      ],
    });
    const { stderr, status } = runResolver('next', tmpDir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('resolve-tasks: multiple primary libraries:');
    expect(stderr).toContain('tasks');
    expect(stderr).toContain('issues');
  });
});
