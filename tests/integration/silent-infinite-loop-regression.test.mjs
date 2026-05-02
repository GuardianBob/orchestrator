// tests/integration/silent-infinite-loop-regression.test.mjs
// TASK-016 — Canonical fix-validation regression test for the silent
// infinite loop documented in FEAT_FIXES.md §"The actual problem".
//
// Drives a full pre-build → fake-builder-commit → merge cycle through the
// real CLI scripts (branch-setup.mjs → merge-task.mjs) in a tmp git repo,
// then re-invokes resolve-tasks.mjs sprint-3 and asserts the queue is
// empty (AC #1) AND the shard file on disk has status:done with the
// merge-note appended (AC #2). Filename is verbatim per AC #3.
//
// Full subprocess invocation (no in-process imports of scripts/) — hence
// no shared shard-library cache to reset between tests. See blueprint
// .orchestrator/blueprints/TASK-016-blueprint.md §6.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const BRANCH_SETUP   = path.join(REPO_ROOT, 'scripts', 'branch-setup.mjs');
const MERGE_TASK     = path.join(REPO_ROOT, 'scripts', 'merge-task.mjs');
const RESOLVE_TASKS  = path.join(REPO_ROOT, 'scripts', 'resolve-tasks.mjs');
const TASK_SCHEMA_SRC = path.join(REPO_ROOT, 'tests', 'fixtures', 'tasks-fixture', '.tasks', 'schemas', 'task.schema.json');
const FAKE_REBUILD   = path.join(REPO_ROOT, 'tests', 'fixtures', 'silent-loop-regression', 'fake-rebuild.mjs');

// ---------------------------------------------------------------------------
// Helpers (copied from merge-task.test.mjs for single-file readability —
// blueprint §3 explicitly prefers copy/adapt over shared extraction)
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

function buildOrchestratorConfig() {
  // rebuildCmd points at a hermetic Node script that re-derives INDEX.open_tasks
  // by scanning the shard directory and filtering DONE_STATUSES — modeling a
  // working `npx tasklist-rebuild`. CRITICAL: the production resolver
  // (scripts/resolve-tasks.mjs:155) filters on INDEX row.status, NOT on
  // shard.status. A no-op rebuild leaves INDEX stale and the silent loop
  // PERSISTS — contradicting blueprint §8 ¶2. See deliverable §10/§11.
  // JSON.stringify quotes the path correctly across platforms (handles \\ on
  // Windows). execSync runs cwd=.tasks/, so process.cwd() inside the helper
  // resolves to the indexDir as expected.
  const rebuildCmd =
    `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_REBUILD)}`;
  return {
    branchPrefix: 'sprint',
    mergeStrategy: 'no-ff',
    livingDocs: [],
    shardLibraries: [{
      id: 'tasks',
      name: 'Tasks',
      indexPath: '.tasks/INDEX.json',
      shardDir: '.tasks/tasks',
      schemaPath: '.tasks/schemas/task.schema.json',
      rebuildCmd,
      primary: true,
    }],
  };
}

function buildTaskShard() {
  return {
    id: 'TASK-001',
    title: 'Demo task for regression test',
    description: 'Trigger the full pre-build → merge cycle.',
    status: 'backlog',
    effort: 'S',
    priority: 'medium',
    tags: ['sprint-3'],
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    started: null,
    completed: null,
  };
}

/**
 * Build a tmp repo modeling the exact pre-fix scenario from
 * FEAT_FIXES.md §"The actual problem":
 *   - TASK-001 shard status: backlog
 *   - INDEX.json open_tasks lists it
 *   - tagged sprint-3 (resolver target)
 *   - no sprint/task branches yet (branch-setup creates them)
 */
function setupTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-loop-regression-'));

  git(dir, 'init -q -b main');
  git(dir, 'config user.email t@t');
  git(dir, 'config user.name t');
  git(dir, 'config commit.gpgsign false');

  fs.writeFileSync(path.join(dir, '.gitignore'), 'shim-bin/\n', 'utf8');
  writeJson(path.join(dir, '.orchestrator.json'), buildOrchestratorConfig());

  fs.mkdirSync(path.join(dir, '.tasks', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.tasks', 'schemas'), { recursive: true });
  fs.copyFileSync(TASK_SCHEMA_SRC, path.join(dir, '.tasks', 'schemas', 'task.schema.json'));
  writeJson(path.join(dir, '.tasks', 'INDEX.json'), {
    schema_version: 1,
    generator: 'test-fixture',
    updated: new Date().toISOString(),
    open_tasks: [{
      id: 'TASK-001',
      title: 'Demo task for regression test',
      status: 'backlog',
      tags: ['sprint-3'],
    }],
  });
  writeJson(path.join(dir, '.tasks', 'tasks', 'TASK-001.json'), buildTaskShard());

  git(dir, 'add -A');
  git(dir, 'commit -q -m fixture');

  return { dir };
}

// ---------------------------------------------------------------------------
// CLI subprocess wrappers (blueprint §7)
// ---------------------------------------------------------------------------
function runBranchSetup(dir, { sprint, task, slug }) {
  const r = spawnSync(process.execPath, [
    BRANCH_SETUP, '--sprint', String(sprint), '--task', String(task), '--slug', slug,
    '--non-interactive',
  ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

function runMergeTask(dir, { sprint, task, slug }) {
  const r = spawnSync(process.execPath, [
    MERGE_TASK, '--sprint', String(sprint), '--task', String(task), '--slug', slug,
  ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

function runResolveTasks(dir, target) {
  const r = spawnSync(process.execPath, [
    RESOLVE_TASKS, String(target),
  ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

function parseJsonStdout(stdout, label) {
  try { return JSON.parse(stdout); }
  catch {
    throw new Error(`${label}: stdout was not JSON. stdout=${stdout.slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Test suite — describe text contains "silent infinite loop" verbatim
// for grep-ability beyond the filename (AC #3 reinforced).
// ---------------------------------------------------------------------------
describe('integration: silent infinite loop regression (TASK-016)', () => {
  let repo = null;

  afterEach(() => {
    rmDir(repo?.dir);
    repo = null;
  });

  // -------------------------------------------------------------------------
  // Test 1 — SANITY: pre-cycle queue is non-empty.
  // Without this, a vacuous setup could silently mask AC #1.
  // -------------------------------------------------------------------------
  it('SANITY: resolve-tasks sprint-3 returns TASK-001 before the cycle runs', () => {
    repo = setupTmpRepo();

    const { stdout, stderr, exitCode } = runResolveTasks(repo.dir, 'sprint-3');
    expect(exitCode, `resolve-tasks failed; stderr=${stderr}`).toBe(0);

    const env = parseJsonStdout(stdout, 'resolve-tasks (pre-cycle)');
    expect(env.queue).toHaveLength(1);
    expect(env.queue[0].id).toBe('TASK-001');
    expect(env.queue[0].sprintId).toBe('3');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 2 — MAIN: full cycle leaves shard done + queue empty (AC #1, #2)
  // -------------------------------------------------------------------------
  it('MAIN: full pre-build → merge cycle closes shard and re-resolve queue is empty', () => {
    repo = setupTmpRepo();

    // ---- Phase 1: branch-setup (Fix 1 — backlog → in-progress) ------------
    const setup = runBranchSetup(repo.dir, { sprint: 3, task: 1, slug: 'demo' });
    expect(setup.exitCode, `branch-setup failed; stderr=${setup.stderr}`).toBe(0);
    const setupEnv = parseJsonStdout(setup.stdout, 'branch-setup');
    expect(setupEnv.statusFlip).toMatchObject({ flipped: true, reason: 'flipped' });

    // Shard now in-progress, task branch checked out.
    const shardAfterSetup = readJson(path.join(repo.dir, '.tasks', 'tasks', 'TASK-001.json'));
    expect(shardAfterSetup.status).toBe('in-progress');
    expect(shardAfterSetup.started).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // ---- Phase 2: simulated builder commit on task branch -----------------
    fs.mkdirSync(path.join(repo.dir, 'work'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'work', 'done.txt'), 'fake builder work\n', 'utf8');
    git(repo.dir, 'add -A');
    git(repo.dir, 'commit -q -m feat(task-1):work');

    // ---- Phase 3: gate file (merge-task CLI requires it) ------------------
    writeGateFile(repo.dir, 'task-1-attempt-1', { passed: true });

    // ---- Phase 4: merge-task (Fix 2 — in-progress → done) -----------------
    const merge = runMergeTask(repo.dir, { sprint: 3, task: 1, slug: 'demo' });
    expect(merge.exitCode, `merge-task failed; stderr=${merge.stderr}`).toBe(0);
    const mergeEnv = parseJsonStdout(merge.stdout, 'merge-task');
    expect(mergeEnv).toMatchObject({
      merged: 'sprint-3-task-1-demo',
      into: 'sprint-3',
      mergeSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      shardClose: { closed: true, reason: 'closed', libraryId: 'tasks' },
      commit: { committed: true, sha: expect.stringMatching(/^[0-9a-f]{12}$/), reason: 'commit-ok' },
    });

    // ---- AC #2: assert directly on the shard file on disk -----------------
    const shardAfterMerge = readJson(path.join(repo.dir, '.tasks', 'tasks', 'TASK-001.json'));
    expect(shardAfterMerge.status).toBe('done');
    expect(shardAfterMerge.completed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(shardAfterMerge.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/Merged into sprint-3 at [0-9a-f]{12}/),
    ]));

    // ---- AC #1: re-resolve returns empty queue ----------------------------
    const reresolve = runResolveTasks(repo.dir, 'sprint-3');
    expect(reresolve.exitCode, `resolve-tasks (post) failed; stderr=${reresolve.stderr}`).toBe(0);
    const reEnv = parseJsonStdout(reresolve.stdout, 'resolve-tasks (post-cycle)');
    expect(reEnv.queue).toEqual([]);
    expect(reEnv.totalAvailable).toBe(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Test 3 — OPTIONAL: INDEX projection updated by the rebuild step.
  // Per blueprint §5 Test 3: confirm the rebuild fired and INDEX no longer
  // lists TASK-001 in open_tasks. NOTE: blueprint §8 ¶2 + §123 claimed
  // resolve-tasks.mjs has a per-shard status safety net — IT DOES NOT
  // (scripts/resolve-tasks.mjs:155 filters on row.status only). With a
  // working rebuildCmd both INDEX and shard are consistent; the resolver
  // sees an empty open_tasks. See deliverable for the architectural finding.
  // -------------------------------------------------------------------------
  it('OPTIONAL: post-cycle INDEX.open_tasks no longer contains TASK-001 (rebuild fired)', () => {
    repo = setupTmpRepo();

    const setup = runBranchSetup(repo.dir, { sprint: 3, task: 1, slug: 'demo' });
    expect(setup.exitCode, `branch-setup failed; stderr=${setup.stderr}`).toBe(0);

    fs.mkdirSync(path.join(repo.dir, 'work'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'work', 'done.txt'), 'work\n', 'utf8');
    git(repo.dir, 'add -A');
    git(repo.dir, 'commit -q -m feat(task-1):work');
    writeGateFile(repo.dir, 'task-1-attempt-1', { passed: true });

    const merge = runMergeTask(repo.dir, { sprint: 3, task: 1, slug: 'demo' });
    expect(merge.exitCode, `merge-task failed; stderr=${merge.stderr}`).toBe(0);

    const index = readJson(path.join(repo.dir, '.tasks', 'INDEX.json'));
    expect(Array.isArray(index.open_tasks)).toBe(true);
    const ids = index.open_tasks.map((r) => r.id);
    expect(ids).not.toContain('TASK-001');
    expect(index.open_tasks).toHaveLength(0);
  }, 60_000);
});
