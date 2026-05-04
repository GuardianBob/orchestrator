// tests/integration/merge-task.test.mjs
// TASK-015 — Integration test for the four-phase post-merge pipeline in
// scripts/merge-task.mjs against a real on-disk tmp git repo with two
// configured shard libraries (tasks + issues).
//
// 1 subprocess scenario (A) + 3 in-process scenarios (B/C/D). See blueprint
// .orchestrator/blueprints/TASK-015-blueprint.md for AC mapping.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  closePrimaryShardOnMerge,
  closeLinkedShardsOnMerge,
} from '../../scripts/merge-task.mjs';
import { commitShardDeltas } from '../../lib/commit-shard-deltas.mjs';
import { loadLibraries, __resetCache } from '../../lib/shard-library.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const MERGE_TASK_PATH = path.join(REPO_ROOT, 'scripts', 'merge-task.mjs');
const TASK_SCHEMA_SRC  = path.join(REPO_ROOT, 'tests', 'fixtures', 'tasks-fixture',  '.tasks',  'schemas', 'task.schema.json');
const ISSUE_SCHEMA_SRC = path.join(REPO_ROOT, 'tests', 'fixtures', 'issues-fixture', '.issues', 'schemas', 'issue.schema.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function git(repoDir, argsStr) {
  const r = spawnSync('git', argsStr.split(' ').filter(Boolean), {
    cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`git ${argsStr} failed (exit:${r.status}) — stderr: ${r.stderr}`);
  }
  return r.stdout;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }

function rmDir(dir) {
  if (!dir) return;
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* Windows .git/objects/pack handle holds — best-effort */ }
}

function writeGateFile(repoDir, name, payload) {
  const gatesDir = path.join(repoDir, '.orchestrator', 'gates');
  fs.mkdirSync(gatesDir, { recursive: true });
  writeJson(path.join(gatesDir, `${name}.json`), payload);
}

function buildTaskShard(variant) {
  const base = {
    id: 'TASK-101',
    title: 'Wire X to Y',
    description: 'Implement X→Y.',
    status: 'in-progress',
    effort: 'M',
    priority: 'medium',
    tags: ['fixture'],
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    started: '2026-02-01T00:00:00.000Z',
    completed: null,
  };
  if (variant === 'keyword') {
    base.description = 'Implement X→Y. Resolves ISSUE-042 along the way.';
  } else if (variant === 'explicit') {
    base.resolves = ['ISSUE-042'];
  } // 'unlinked' — no edits
  return base;
}

function buildIssueShard() {
  return {
    id: 'ISSUE-042',
    title: 'Y emits noisy logs',
    description: 'Repro steps...',
    status: 'open',
    effort: 'S',
    priority: 'medium',
    tags: ['fixture'],
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    started: null,
    completed: null,
  };
}

function buildOrchestratorConfig() {
  return {
    branchPrefix: 'sprint',
    mergeStrategy: 'no-ff',
    livingDocs: [],
    shardLibraries: [
      {
        id: 'tasks',
        name: 'Tasks',
        indexPath: '.tasks/INDEX.json',
        shardDir:  '.tasks/tasks',
        schemaPath: '.tasks/schemas/task.schema.json',
        rebuildCmd: 'node -e "process.exit(0)"',
        primary: true,
      },
      {
        id: 'issues',
        name: 'Issues',
        indexPath: '.issues/INDEX.json',
        shardDir:  '.issues/issues',
        schemaPath: '.issues/schemas/issue.schema.json',
        rebuildCmd: 'node -e "process.exit(0)"',
        primary: false,
        linkField: 'resolves',
      },
    ],
  };
}

/**
 * Build a tmp repo with two shard libraries, sprint+task branches, and a
 * simulated work commit. Variants: 'keyword' | 'explicit' | 'unlinked'.
 *
 * Returns { dir, sprintBranch, taskBranch }.
 */
function setupTmpRepo({ taskVariant }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-task-it-'));

  // Initialize git on `main` (require git ≥ 2.28 — same as branch-setup test).
  git(dir, 'init -q -b main');
  git(dir, 'config user.email t@t');
  git(dir, 'config user.name t');
  git(dir, 'config commit.gpgsign false');

  // .gitignore (parity with branch-setup test).
  fs.writeFileSync(path.join(dir, '.gitignore'), 'shim-bin/\n', 'utf8');

  // .orchestrator.json.
  writeJson(path.join(dir, '.orchestrator.json'), buildOrchestratorConfig());

  // .tasks/ tree.
  fs.mkdirSync(path.join(dir, '.tasks', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.tasks', 'schemas'), { recursive: true });
  fs.copyFileSync(TASK_SCHEMA_SRC, path.join(dir, '.tasks', 'schemas', 'task.schema.json'));
  writeJson(path.join(dir, '.tasks', 'INDEX.json'), {
    schema_version: 1, generator: 'test-fixture', updated: new Date().toISOString(),
    open_tasks: [{ id: 'TASK-101', title: 'Wire X to Y', status: 'in-progress' }],
  });
  writeJson(path.join(dir, '.tasks', 'tasks', 'TASK-101.json'), buildTaskShard(taskVariant));

  // .issues/ tree — CRITICAL: ISSUE-042 must exist before scanLinks reads dir.
  fs.mkdirSync(path.join(dir, '.issues', 'issues'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.issues', 'schemas'), { recursive: true });
  fs.copyFileSync(ISSUE_SCHEMA_SRC, path.join(dir, '.issues', 'schemas', 'issue.schema.json'));
  writeJson(path.join(dir, '.issues', 'INDEX.json'), {
    schema_version: 1, generator: 'test-fixture', updated: new Date().toISOString(),
    open_issues: [{ id: 'ISSUE-042', title: 'Y emits noisy logs', status: 'open' }],
  });
  writeJson(path.join(dir, '.issues', 'issues', 'ISSUE-042.json'), buildIssueShard());

  // Initial commit on main.
  git(dir, 'add -A');
  git(dir, 'commit -q -m fixture');

  // Sprint branch + task branch.
  const sprintBranch = 'sprint-3';
  const taskBranch = 'sprint-3-task-101-demo';
  git(dir, `checkout -q -b ${sprintBranch}`);
  git(dir, `checkout -q -b ${taskBranch}`);

  // Simulated work on task branch.
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'done.txt'), 'work\n', 'utf8');
  git(dir, 'add -A');
  git(dir, 'commit -q -m feat(task-101):work');

  // Back on sprint branch — orchestrator hands this state to merge-task.
  git(dir, `checkout -q ${sprintBranch}`);

  return { dir, sprintBranch, taskBranch };
}

/**
 * Mirrors the CLI block's merge step (lines 531–541 of merge-task.mjs):
 * checkout sprint branch + `git merge --no-ff <taskBranch>`. Used by
 * in-process scenarios so the post-merge helpers see a real merge commit.
 */
function performFakeMerge(repoDir, sprintBranch, taskBranch) {
  git(repoDir, `checkout -q ${sprintBranch}`);
  git(repoDir, `merge --no-ff --no-edit -m merge(task-101):into-${sprintBranch} ${taskBranch}`);
}

function runMergeTaskCli(repoDir, { sprint, task, slug }) {
  const r = spawnSync(process.execPath, [
    MERGE_TASK_PATH, '--sprint', String(sprint), '--task', String(task), '--slug', slug,
  ], { cwd: repoDir, encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('integration: merge-task post-merge pipeline (TASK-015)', () => {
  let repo = null;

  afterEach(() => {
    __resetCache();             // clear shard-library WeakMaps between tests
    rmDir(repo?.dir);
    repo = null;
  });

  // -------------------------------------------------------------------------
  // Scenario A — CLI subprocess, keyword linkage (AC #1, #2)
  // -------------------------------------------------------------------------
  it('A. CLI subprocess: keyword-linked task — full envelope, both libraries closed', () => {
    repo = setupTmpRepo({ taskVariant: 'keyword' });
    writeGateFile(repo.dir, 'task-101-attempt-1', { passed: true });

    const { stdout, stderr, exitCode } = runMergeTaskCli(repo.dir, {
      sprint: 3, task: 101, slug: 'demo',
    });

    expect(exitCode, `cli failed; stderr=${stderr}`).toBe(0);

    let env;
    try { env = JSON.parse(stdout); }
    catch (e) { throw new Error(`stdout was not JSON. stdout=${stdout.slice(0, 500)}`); }

    expect(env).toMatchObject({
      merged: 'sprint-3-task-101-demo',
      into: 'sprint-3',
      mergeSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      shardClose: { closed: true, reason: 'closed', libraryId: 'tasks' },
      linkedShardClose: { closed: 1, skipped: 0, failures: 0 },
      commit: { committed: true, sha: expect.stringMatching(/^[0-9a-f]{12}$/), reason: 'commit-ok' },
    });
    expect(env.commit.libraries).toEqual(expect.arrayContaining(['tasks', 'issues']));
    expect(env.commit.libraries).toHaveLength(2);

    // Shard mutations on disk
    const taskShard = readJson(path.join(repo.dir, '.tasks', 'tasks', 'TASK-101.json'));
    expect(taskShard.status).toBe('done');
    expect(taskShard.completed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof taskShard.notes).toBe('string');
    expect(taskShard.notes).toMatch(/Merged into sprint-3 at [0-9a-f]{12}/);

    const issueShard = readJson(path.join(repo.dir, '.issues', 'issues', 'ISSUE-042.json'));
    expect(issueShard.status).toBe('resolved');
    expect(issueShard.completed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof issueShard.notes).toBe('string');
    expect(issueShard.notes).toMatch(/Resolved by TASK-101 @ [0-9a-f]{12}/);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Scenario B — In-process, explicit-field linkage (AC #2)
  // -------------------------------------------------------------------------
  it('B. in-process: explicit "resolves" field — issues library closed', () => {
    repo = setupTmpRepo({ taskVariant: 'explicit' });
    performFakeMerge(repo.dir, 'sprint-3', 'sprint-3-task-101-demo');
    const mergeSha = git(repo.dir, 'rev-parse HEAD').trim();

    __resetCache();
    const libraries = loadLibraries(path.join(repo.dir, '.orchestrator.json'));
    const primary = libraries.find((l) => l.primary);

    const shardClose = closePrimaryShardOnMerge({
      libraries, taskId: 'TASK-101', sprintBranch: 'sprint-3', mergeSha,
    });
    expect(shardClose).toMatchObject({ closed: true, reason: 'closed', libraryId: 'tasks' });

    const linkedShardClose = closeLinkedShardsOnMerge({
      libraries, primary, taskId: 'TASK-101', mergeSha, log: () => {},
    });
    expect(linkedShardClose).toMatchObject({ closed: 1, skipped: 0, failures: 0 });
    expect(linkedShardClose.perLibrary[0]).toMatchObject({
      libraryId: 'issues', closedIds: ['ISSUE-042'],
    });

    const commit = commitShardDeltas({
      taskId: 'TASK-101', mergeSha, shardClose, linkedShardClose,
      libraries, cwd: repo.dir, log: () => {},
    });
    expect(commit).toMatchObject({ committed: true, reason: 'commit-ok' });
    expect(commit.libraries).toEqual(expect.arrayContaining(['tasks', 'issues']));
    expect(commit.libraries).toHaveLength(2);

    const issueShard = readJson(path.join(repo.dir, '.issues', 'issues', 'ISSUE-042.json'));
    expect(issueShard.status).toBe('resolved');
    expect(issueShard.completed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // -------------------------------------------------------------------------
  // Scenario C — In-process, single-commit semantic (AC #3)
  // -------------------------------------------------------------------------
  it('C. in-process: commitShardDeltas produces ONE commit covering both libraries', () => {
    repo = setupTmpRepo({ taskVariant: 'keyword' });
    performFakeMerge(repo.dir, 'sprint-3', 'sprint-3-task-101-demo');
    const mergeSha = git(repo.dir, 'rev-parse HEAD').trim();

    const headBefore = git(repo.dir, 'rev-parse HEAD').trim();
    const logCountBefore = parseInt(git(repo.dir, 'rev-list --count HEAD').trim(), 10);

    __resetCache();
    const libraries = loadLibraries(path.join(repo.dir, '.orchestrator.json'));
    const primary = libraries.find((l) => l.primary);

    const shardClose = closePrimaryShardOnMerge({
      libraries, taskId: 'TASK-101', sprintBranch: 'sprint-3', mergeSha,
    });
    const linkedShardClose = closeLinkedShardsOnMerge({
      libraries, primary, taskId: 'TASK-101', mergeSha, log: () => {},
    });
    const commit = commitShardDeltas({
      taskId: 'TASK-101', mergeSha, shardClose, linkedShardClose,
      libraries, cwd: repo.dir, log: () => {},
    });

    expect(commit.committed).toBe(true);

    const headAfter = git(repo.dir, 'rev-parse HEAD').trim();
    const logCountAfter = parseInt(git(repo.dir, 'rev-list --count HEAD').trim(), 10);

    expect(headAfter).not.toBe(headBefore);
    expect(logCountAfter - logCountBefore).toBe(1); // EXACTLY one new commit

    // Files in the new commit: both libraries, nothing outside.
    const files = git(repo.dir, `show --name-only --pretty=format: ${headAfter}`)
      .trim().split('\n').filter(Boolean).sort();

    const expectTaskShard  = path.join('.tasks',  'tasks',  'TASK-101.json' ).replace(/\\/g, '/');
    const expectIssueShard = path.join('.issues', 'issues', 'ISSUE-042.json').replace(/\\/g, '/');
    expect(files).toEqual(expect.arrayContaining([expectTaskShard, expectIssueShard]));

    for (const f of files) {
      expect(
        f.startsWith('.tasks/') || f.startsWith('.issues/'),
        `unexpected file outside .tasks/ or .issues/: ${f}`,
      ).toBe(true);
    }

    // Commit subject matches documented format.
    const subject = git(repo.dir, `log -1 --format=%s ${headAfter}`).trim();
    expect(subject).toMatch(/^chore\(orchestrator\): close TASK-101 \+ linked shards \[[0-9a-f]{12}\]$/);
  });

  // -------------------------------------------------------------------------
  // Scenario D — In-process, non-linked path (AC #4)
  // -------------------------------------------------------------------------
  it('D. in-process: task with NO links — issues library untouched', () => {
    repo = setupTmpRepo({ taskVariant: 'unlinked' });
    performFakeMerge(repo.dir, 'sprint-3', 'sprint-3-task-101-demo');
    const mergeSha = git(repo.dir, 'rev-parse HEAD').trim();

    const issueIndexBefore = fs.readFileSync(path.join(repo.dir, '.issues', 'INDEX.json'));
    const issueShardBefore = fs.readFileSync(path.join(repo.dir, '.issues', 'issues', 'ISSUE-042.json'));

    __resetCache();
    const libraries = loadLibraries(path.join(repo.dir, '.orchestrator.json'));
    const primary = libraries.find((l) => l.primary);

    const shardClose = closePrimaryShardOnMerge({
      libraries, taskId: 'TASK-101', sprintBranch: 'sprint-3', mergeSha,
    });
    const linkedShardClose = closeLinkedShardsOnMerge({
      libraries, primary, taskId: 'TASK-101', mergeSha, log: () => {},
    });
    const commit = commitShardDeltas({
      taskId: 'TASK-101', mergeSha, shardClose, linkedShardClose,
      libraries, cwd: repo.dir, log: () => {},
    });

    expect(linkedShardClose).toMatchObject({ closed: 0, failures: 0, perLibrary: [] });
    expect(commit.libraries).toEqual(['tasks']);                        // ONLY tasks
    expect(commit.libraries).not.toContain('issues');

    // .issues/ untouched byte-for-byte.
    expect(fs.readFileSync(path.join(repo.dir, '.issues', 'INDEX.json'))).toEqual(issueIndexBefore);
    expect(fs.readFileSync(path.join(repo.dir, '.issues', 'issues', 'ISSUE-042.json'))).toEqual(issueShardBefore);

    // The new commit must not stage anything from .issues/.
    const files = git(repo.dir, `show --name-only --pretty=format: ${commit.sha || 'HEAD'}`)
      .trim().split('\n').filter(Boolean);
    for (const f of files) {
      expect(f.startsWith('.issues/'), `unexpected .issues/ file in commit: ${f}`).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario E — TASK-033: closePrimaryShardOnMerge sanitizes thrown error
  // (SEC-W-012-1). Forces a vocab error by writing a malformed schema, then
  // asserts stderr contains the warning prefix but NOT the absolute repo path
  // and NOT a raw drive letter prefix from the thrown ENOENT.
  // -------------------------------------------------------------------------
  it('E. closePrimaryShardOnMerge sanitizes thrown error in stderr (no path leak)', () => {
    repo = setupTmpRepo({ taskVariant: 'unlinked' });
    performFakeMerge(repo.dir, 'sprint-3', 'sprint-3-task-101-demo');
    const mergeSha = git(repo.dir, 'rev-parse HEAD').trim();

    // Corrupt the task schema so resolveStatusVocab throws with a path-bearing message.
    fs.writeFileSync(
      path.join(repo.dir, '.tasks', 'schemas', 'task.schema.json'),
      '{ this is not valid json',
      'utf8',
    );

    __resetCache();
    const libraries = loadLibraries(path.join(repo.dir, '.orchestrator.json'));

    // Capture stderr
    const chunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
    let result;
    try {
      result = closePrimaryShardOnMerge({
        libraries, taskId: 'TASK-101', sprintBranch: 'sprint-3', mergeSha,
      });
    } finally {
      process.stderr.write = origWrite;
    }
    const stderr = chunks.join('');

    // Either vocab error OR shard read failed — both are sanitizer call sites.
    expect(stderr).toMatch(/\[merge-task\] (vocab error|shard read failed)/);
    expect(result.closed).toBe(false);

    // No absolute repo path leaks. repo.dir is an absolute tmp path.
    expect(stderr).not.toContain(repo.dir);
    // The drive-letter portion (e.g., "C:\Users") should be redacted to <path>.
    if (process.platform === 'win32') {
      expect(stderr).not.toMatch(/[A-Z]:\\[A-Za-z]/);
    } else {
      // POSIX tmpdirs usually start with /tmp or /var — redacted form ≠ raw.
      expect(stderr).not.toMatch(/\/tmp\/merge-task-it-/);
      expect(stderr).not.toMatch(/\/var\/folders/);
    }
    // If anything was redacted, the visible token should appear.
    // (At minimum, message length on a single warning line stays bounded.)
    const warnLines = stderr.split('\n').filter((l) => l.startsWith('[merge-task]'));
    for (const line of warnLines) {
      // 200-char message cap + ~50-char prefix budget = generous 280 char ceiling.
      expect(line.length).toBeLessThan(300);
    }
  });
});
