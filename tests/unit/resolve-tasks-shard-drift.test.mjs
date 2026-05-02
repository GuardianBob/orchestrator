// tests/unit/resolve-tasks-shard-drift.test.mjs
// TASK-028 — Resolver shard-status safety net + drift warning.
//
// Subprocess-driven (mirrors silent-infinite-loop-regression.test.mjs) so the
// resolver's module-init reads of .orchestrator.json/INDEX/shards happen in a
// clean process per test. Fixture is minimal: no `git init` needed — resolver
// is read-only and never invokes git for the sprint-N target path.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RESOLVE_TASKS = path.join(REPO_ROOT, 'scripts', 'resolve-tasks.mjs');
const TASK_SCHEMA_SRC = path.join(
  REPO_ROOT, 'tests', 'fixtures', 'tasks-fixture', '.tasks', 'schemas', 'task.schema.json'
);

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function rmDir(dir) {
  if (!dir) return;
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* best-effort on Windows */ }
}

/**
 * Build a tmp repo with one shardLibrary at .tasks/, INDEX rows + shard files
 * derived from `tasks` (each entry: { id, indexStatus, shardStatus, sprintTag }).
 */
function setupTmpRepo(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-drift-'));
  const tasksDir = path.join(dir, '.tasks');
  const shardsDir = path.join(tasksDir, 'tasks');
  const schemasDir = path.join(tasksDir, 'schemas');
  fs.mkdirSync(shardsDir, { recursive: true });
  fs.mkdirSync(schemasDir, { recursive: true });
  fs.copyFileSync(TASK_SCHEMA_SRC, path.join(schemasDir, 'task.schema.json'));

  writeJson(path.join(dir, '.orchestrator.json'), {
    branchPrefix: 'sprint',
    mergeStrategy: 'no-ff',
    livingDocs: [],
    shardLibraries: [{
      id: 'tasks',
      name: 'Tasks',
      indexPath: '.tasks/INDEX.json',
      shardDir: '.tasks/tasks',
      schemaPath: '.tasks/schemas/task.schema.json',
      rebuildCmd: 'node -e "0"',
      primary: true,
    }],
  });

  writeJson(path.join(tasksDir, 'INDEX.json'), {
    schema_version: 1,
    generator: 'test-fixture',
    updated: new Date().toISOString(),
    open_tasks: tasks.map(t => ({
      id: t.id,
      title: `Demo ${t.id}`,
      status: t.indexStatus,
      tags: [t.sprintTag],
    })),
  });

  for (const t of tasks) {
    writeJson(path.join(shardsDir, `${t.id}.json`), {
      id: t.id,
      title: `Demo ${t.id}`,
      description: 'fixture',
      status: t.shardStatus,
      effort: 'S',
      priority: 'medium',
      tags: [t.sprintTag],
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      started: null,
      completed: null,
    });
  }

  return dir;
}

function runResolveTasks(dir, target) {
  const r = spawnSync(process.execPath, [RESOLVE_TASKS, String(target)], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, shell: false,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

describe('resolver shard.status safety net (TASK-028)', () => {
  let repoDir = null;
  afterEach(() => { rmDir(repoDir); repoDir = null; });

  it('A: aligned backlog status — task is enqueued, no drift warning', () => {
    repoDir = setupTmpRepo([
      { id: 'TASK-001', indexStatus: 'backlog', shardStatus: 'backlog', sprintTag: 'sprint-1' },
    ]);
    const r = runResolveTasks(repoDir, 'sprint-1');
    expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.queue).toHaveLength(1);
    expect(env.queue[0].id).toBe('TASK-001');
    expect(r.stderr).not.toMatch(/shard drift/);
  });

  it('B: drift (INDEX backlog, shard done) — task dropped + warning emitted', () => {
    repoDir = setupTmpRepo([
      { id: 'TASK-001', indexStatus: 'backlog', shardStatus: 'done', sprintTag: 'sprint-1' },
    ]);
    const r = runResolveTasks(repoDir, 'sprint-1');
    expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.queue).toEqual([]);
    expect(r.stderr).toMatch(/\[resolver\] shard drift:/);
    expect(r.stderr).toMatch(/TASK-001/);
    expect(r.stderr).toMatch(/status=done/);
    expect(r.stderr).toMatch(/INDEX says backlog/);
    expect(r.stderr).toMatch(/Run: npx tasklist-rebuild/);
  });

  it('C: multiple drifts + one healthy — only healthy enqueued, two warnings', () => {
    repoDir = setupTmpRepo([
      { id: 'TASK-001', indexStatus: 'backlog', shardStatus: 'done',      sprintTag: 'sprint-1' },
      { id: 'TASK-002', indexStatus: 'backlog', shardStatus: 'backlog',   sprintTag: 'sprint-1' },
      { id: 'TASK-003', indexStatus: 'backlog', shardStatus: 'cancelled', sprintTag: 'sprint-1' },
    ]);
    const r = runResolveTasks(repoDir, 'sprint-1');
    expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.queue).toHaveLength(1);
    expect(env.queue[0].id).toBe('TASK-002');
    const driftLines = r.stderr.split(/\r?\n/).filter(l => /\[resolver\] shard drift:/.test(l));
    expect(driftLines).toHaveLength(2);
    const driftBlob = driftLines.join('\n');
    expect(driftBlob).toMatch(/TASK-001/);
    expect(driftBlob).toMatch(/TASK-003/);
    expect(driftBlob).toMatch(/status=cancelled/);
    expect(driftBlob).not.toMatch(/TASK-002/);
  });

  it('D: stdout JSON integrity under drift', () => {
    repoDir = setupTmpRepo([
      { id: 'TASK-001', indexStatus: 'backlog', shardStatus: 'done',      sprintTag: 'sprint-1' },
      { id: 'TASK-002', indexStatus: 'backlog', shardStatus: 'backlog',   sprintTag: 'sprint-1' },
      { id: 'TASK-003', indexStatus: 'backlog', shardStatus: 'cancelled', sprintTag: 'sprint-1' },
    ]);
    const r = runResolveTasks(repoDir, 'sprint-1');
    expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    const env = JSON.parse(r.stdout);
    expect(env.target).toBe('sprint-1');
    expect(env.resolution).toBe('sprint');
    expect(env.queue).toHaveLength(1);
  });
});
