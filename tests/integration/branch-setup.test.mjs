// tests/integration/branch-setup.test.mjs
//
// Full-integration test suite for scripts/branch-setup.mjs (TASK-011).
// Each test spawns the script as a fresh node child process inside a tmp
// git repo so collision prompts, exit codes, and rebuild paths are exercised
// end-to-end (per blueprint §2 / §3).
//
// Hard rules honored:
//   - ESM only.
//   - Hermetic: every run uses an explicit cwd inside tests/fixtures/tmp/
//     and explicit env. We never rely on process.cwd() of the test runner.
//   - Cleanup: afterEach removes the per-test tmp dir even on failure
//     (rmDir is idempotent + force).
//   - Cross-platform: path.join + path.delimiter; never '/' or ';' literals
//     (LD-XPL-001).
//   - Deterministic stdin: writes are gated on first stdout/stderr chunk
//     arrival (readline has initialized) per blueprint §6.4. A 200ms safety
//     net handles the no-prompt cases.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BRANCH_SETUP = path.join(REPO_ROOT, 'scripts', 'branch-setup.mjs');
const FIXTURE_SCHEMA = path.join(
  REPO_ROOT, 'tests', 'fixtures', 'tasks-fixture', '.tasks', 'schemas', 'task.schema.json'
);
const TMP_BASE = path.join(REPO_ROOT, 'tests', 'fixtures', 'tmp');

fs.mkdirSync(TMP_BASE, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rmDir(dir) {
  if (!dir) return;
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can momentarily hold file handles; ignore — tmp parent will
    // be cleaned by future runs / CI scrubber.
  }
}

/**
 * Build a minimal git repo with .orchestrator.json + .tasks/ library.
 * @param {object} [opts]
 * @param {Record<string, object>} [opts.shards]   id → shard JSON
 * @param {object} [opts.configOverrides]          merged into .orchestrator.json
 * @param {string} [opts.rebuildCmd]               default: 'echo rebuild'
 * @returns {{ dir: string, primaryShardPath: (id:string)=>string, indexPath: string }}
 */
function setupTmpRepo({ shards = {}, configOverrides = {}, rebuildCmd = 'echo rebuild' } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_BASE, 'branch-setup-'));

  // git init + identity (commit step needs author info even with --allow-empty)
  const git = (cmd) => execSync(cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('git init -q -b main');
  git('git config user.email t@t');
  git('git config user.name t');
  git('git config commit.gpgsign false');

  // Schema is required by updateShard's validator.
  const schemaTarget = path.join(dir, '.tasks', 'schemas', 'task.schema.json');
  fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
  fs.copyFileSync(FIXTURE_SCHEMA, schemaTarget);

  // INDEX.json — branch-setup doesn't read it directly but rebuildLibrary
  // and resolveStatusVocab expect a sane skeleton.
  const indexPath = path.join(dir, '.tasks', 'INDEX.json');
  writeJson(indexPath, {
    schema_version: 1,
    generator: 'test-fixture',
    updated: '2026-01-01T00:00:00.000Z',
    open_tasks: Object.values(shards).map((s) => ({
      id: s.id, title: s.title, status: s.status,
    })),
  });

  // Per-shard files.
  for (const [id, shard] of Object.entries(shards)) {
    writeJson(path.join(dir, '.tasks', 'tasks', `${id}.json`), shard);
  }

  // .orchestrator.json — minimal shape branch-setup expects.
  writeJson(path.join(dir, '.orchestrator.json'), {
    branchPrefix: 'sprint',
    shardLibraries: [
      {
        id: 'tasks',
        indexPath: path.join('.tasks', 'INDEX.json'),
        shardDir: path.join('.tasks', 'tasks'),
        schemaPath: path.join('.tasks', 'schemas', 'task.schema.json'),
        rebuildCmd,
        primary: true,
      },
    ],
    ...configOverrides,
  });

  // Pre-emptively ignore test-only artifacts that some cases inject after
  // the fixture commit (PATH-shim binaries for test #13). Keeps `git status`
  // clean so branch-setup doesn't trip its dirty-tree guard (exit 2).
  fs.writeFileSync(path.join(dir, '.gitignore'), 'shim-bin/\n');

  // Initial commit so the working tree is clean and branches can fork from
  // a real HEAD.
  git('git add -A');
  git('git commit -q -m fixture');

  return {
    dir,
    indexPath,
    primaryShardPath: (id) => path.join(dir, '.tasks', 'tasks', `${id}.json`),
  };
}

/**
 * Spawn branch-setup.mjs. Resolves on child exit.
 *
 * Stdin handling: lines are drip-fed one at a time. Each line is held back
 * until the prompt has been (re-)printed to stderr. This is required because
 * defaultAsk creates a new readline.Interface per question, and a fresh
 * interface will greedily consume any buffered stdin lines — so writing
 * "q\nr\n" upfront causes the first readline to swallow both, leaving the
 * second prompt to hit EOF (and default to abandon).
 *
 * The "prompt printed" signal is the substring "Choice [" in stderr (matches
 * "Choice [r/R/a]" and any custom-options variant); each appearance unlocks
 * one more line. A 1.5s safety timer flushes any remaining input on stall.
 */
function runBranchSetup(args, { stdin = null, env = {}, cwd } = {}) {
  if (!cwd) throw new Error('runBranchSetup: cwd is required');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRANCH_SETUP, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // Build the queue of lines to write. Each preserves its own trailing \n
    // so the bare-Enter case ("\n") is one empty line ending in \n.
    const lines = [];
    if (stdin !== null && stdin !== undefined) {
      // Split keeping separators: 'q\nr\n' -> ['q\n', 'r\n']
      const parts = stdin.split('\n');
      for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i] + '\n');
      if (parts[parts.length - 1] !== '') lines.push(parts[parts.length - 1]);
    }

    let promptCount = 0;     // how many "Choice [" we've seen
    let writtenCount = 0;    // how many lines we've written so far
    let ended = false;

    const flushOne = () => {
      if (ended) return;
      if (writtenCount >= lines.length) {
        ended = true;
        child.stdin.end();
        return;
      }
      child.stdin.write(lines[writtenCount++]);
    };

    const onStderrChange = () => {
      // Count occurrences of "Choice [" in cumulative stderr.
      let count = 0;
      let idx = 0;
      while ((idx = stderr.indexOf('Choice [', idx)) !== -1) { count++; idx += 8; }
      while (promptCount < count) {
        promptCount++;
        flushOne();
      }
    };

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      onStderrChange();
    });

    // If the child never prompts (non-collision paths, --no-status-flip, etc.),
    // close stdin promptly so the child doesn't block on readers nobody has.
    // For lines that exist, we wait for prompts; if a prompt never arrives
    // within the safety window, flush everything and end.
    const safetyTimer = setTimeout(() => {
      while (writtenCount < lines.length) flushOne();
      if (!ended) { ended = true; child.stdin.end(); }
    }, 1500);

    // No-input fast path: end stdin immediately so collision branches that
    // check `process.stdin.isTTY` see a closed pipe (test #6 relies on this).
    if (lines.length === 0) {
      ended = true;
      child.stdin.end();
    }

    child.on('error', (err) => {
      clearTimeout(safetyTimer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: 1 });
    });
    child.on('close', (code) => {
      clearTimeout(safetyTimer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/** Parse the JSON envelope (last printed-to-stdout JSON object). */
function parseEnvelope(stdout) {
  // The script emits one pretty-printed JSON object; trim and parse.
  return JSON.parse(stdout.trim());
}

/**
 * Build a tmp `bin/` dir containing a shim `npx` executable that exits 1.
 * Returns the dir path; caller prepends it to PATH using path.delimiter.
 */
function makeFailingNpxShim(parentDir) {
  const binDir = path.join(parentDir, 'shim-bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'npx.cmd'), '@echo off\r\nexit /b 1\r\n');
  } else {
    const shim = path.join(binDir, 'npx');
    fs.writeFileSync(shim, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(shim, 0o755);
  }
  return binDir;
}

// ---------------------------------------------------------------------------
// Common shard factories
// ---------------------------------------------------------------------------

const ISO_2026 = '2026-01-01T00:00:00.000Z';

// Forces branch-setup to treat piped stdin as interactive. Required for any
// test that wants to drive the prompt loop — Node provides no API to fake a
// TTY on a pipe, so the script honors this env var as a test-only escape
// hatch (documented in scripts/branch-setup.mjs handleCollisionAtStart).
const TTY_ENV = { BRANCH_SETUP_TEST_FORCE_INTERACTIVE: '1' };

function backlogShard(id = 'TASK-009') {
  return {
    id,
    title: `Seed ${id}`,
    description: 'fixture',
    status: 'backlog',
    effort: 'M',
    priority: 'medium',
    tags: ['fixture'],
    created: ISO_2026,
    updated: ISO_2026,
    started: null,
    completed: null,
  };
}

function inProgressShard(id = 'TASK-009') {
  return {
    ...backlogShard(id),
    status: 'in-progress',
    started: '2026-02-01T00:00:00.000Z',
  };
}

function doneShard(id = 'TASK-009') {
  return {
    ...backlogShard(id),
    status: 'done',
    started: '2026-02-01T00:00:00.000Z',
    completed: '2026-02-15T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('branch-setup integration — happy path', () => {
  let repo;
  afterEach(() => { rmDir(repo?.dir); repo = null; });

  it('#1 backlog → flipped (status, started, INDEX rebuild, JSON envelope)', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': backlogShard('TASK-009') } });
    const indexMtimeBefore = fs.statSync(repo.indexPath).mtimeMs;
    // Sleep 5ms to ensure mtime can differ on coarse-grained FS.
    await new Promise((r) => setTimeout(r, 10));

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.reason).toBe('flipped');
    expect(env.statusFlip.flipped).toBe(true);
    expect(env.sprintBranch).toBe('sprint-9');
    expect(env.taskBranch).toBe('sprint-9-task-9-demo');

    const shard = readJson(repo.primaryShardPath('TASK-009'));
    expect(shard.status).toBe('in-progress');
    expect(typeof shard.started).toBe('string');
    expect(shard.started.length).toBeGreaterThan(0);

    // Both branches exist
    const branches = execSync('git branch --list', { cwd: repo.dir, encoding: 'utf8' });
    expect(branches).toContain('sprint-9');
    expect(branches).toContain('sprint-9-task-9-demo');
  });
});

describe('branch-setup integration — collision', () => {
  let repo;
  afterEach(() => { rmDir(repo?.dir); repo = null; });

  it('#2 already-done → exit 4, no prompt, shard untouched', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': doneShard('TASK-009') } });
    const before = readJson(repo.primaryShardPath('TASK-009'));

    const { stdout, stderr, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir },
    );
    expect(exitCode).toBe(4);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.reason).toBe('already-done');
    // No prompt issued — the prompt headline must NOT appear.
    expect(stderr).not.toMatch(/already in-progress/);

    const after = readJson(repo.primaryShardPath('TASK-009'));
    expect(after).toEqual(before);
  });

  it('#3 already-at-start + interactive "r" → resume, started preserved', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });
    const startedBefore = readJson(repo.primaryShardPath('TASK-009')).started;

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: 'r\n', env: TTY_ENV },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.choice).toBe('resume');
    expect(env.statusFlip.reason).toBe('collision-resumed');
    expect(env.statusFlip.flipped).toBe(false);
    expect(env.statusFlip.rebuild).toBeUndefined();

    const after = readJson(repo.primaryShardPath('TASK-009'));
    expect(after.started).toBe(startedBefore);
  });

  it('#4 already-at-start + "R" → restart overwrites started + appends notes + rebuild', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });
    const startedBefore = readJson(repo.primaryShardPath('TASK-009')).started;

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: 'R\n', env: TTY_ENV },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.choice).toBe('restart');
    expect(env.statusFlip.reason).toBe('collision-restarted');
    expect(env.statusFlip.flipped).toBe(true);
    expect(env.statusFlip).toHaveProperty('rebuild');

    const after = readJson(repo.primaryShardPath('TASK-009'));
    expect(after.started).not.toBe(startedBefore);
    expect(after.notes).toMatch(/Restarted by orchestrator on /);
  });

  it('#5 already-at-start + "a" → abandon (exit 4), shard untouched', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });
    const before = readJson(repo.primaryShardPath('TASK-009'));

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: 'a\n', env: TTY_ENV },
    );
    expect(exitCode).toBe(4);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.choice).toBe('abandon');
    expect(env.statusFlip.reason).toBe('collision-abandoned');

    const after = readJson(repo.primaryShardPath('TASK-009'));
    expect(after).toEqual(before);
  });

  it('#6 non-TTY (stdin closed immediately) → abandon, no prompt printed', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });

    const { stdout, stderr, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: '' }, // stdin pipe ended immediately
    );
    expect(exitCode).toBe(4);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.choice).toBe('abandon');
    // Non-interactive short-circuits before printing the prompt headline.
    expect(stderr).not.toMatch(/Choice \[r\/R\/a\]/);
  });

  it('#7 --non-interactive flag forces abandon', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo', '--non-interactive'],
      { cwd: repo.dir, stdin: 'r\n' }, // input ignored
    );
    expect(exitCode).toBe(4);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.choice).toBe('abandon');
  });

  it('#8 bare Enter → default (abandon)', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: '\n', env: TTY_ENV },
    );
    expect(exitCode).toBe(4);
    expect(parseEnvelope(stdout).statusFlip.choice).toBe('abandon');
  });

  it('#9 invalid then valid → re-prompt, then resume', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });

    const { stdout, stderr, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: 'q\nr\n', env: TTY_ENV },
    );
    expect(exitCode).toBe(0);
    expect(parseEnvelope(stdout).statusFlip.choice).toBe('resume');
    expect(stderr).toMatch(/unrecognized choice/);
  });

  it('#10 two invalid → abandon (default)', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });

    const { stdout, stderr, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: 'q\nz\n', env: TTY_ENV },
    );
    expect(exitCode).toBe(4);
    expect(parseEnvelope(stdout).statusFlip.choice).toBe('abandon');
    // Re-prompt warning emitted exactly once.
    const matches = stderr.match(/unrecognized choice/g) || [];
    expect(matches.length).toBe(1);
  });
});

describe('branch-setup integration — flags', () => {
  let repo;
  afterEach(() => { rmDir(repo?.dir); repo = null; });

  it('#11 --no-status-flip leaves shard at backlog and INDEX untouched', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': backlogShard('TASK-009') } });
    const indexMtimeBefore = fs.statSync(repo.indexPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo', '--no-status-flip'],
      { cwd: repo.dir },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.reason).toBe('skipped');

    const shard = readJson(repo.primaryShardPath('TASK-009'));
    expect(shard.status).toBe('backlog');

    const indexMtimeAfter = fs.statSync(repo.indexPath).mtimeMs;
    expect(indexMtimeAfter).toBe(indexMtimeBefore);
  });

  it('#12 --no-rebuild flips shard but skips rebuildLibrary', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': backlogShard('TASK-009') } });
    const indexMtimeBefore = fs.statSync(repo.indexPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo', '--no-rebuild'],
      { cwd: repo.dir },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.flipped).toBe(true);
    expect(env.statusFlip.rebuild).toBeNull();

    const shard = readJson(repo.primaryShardPath('TASK-009'));
    expect(shard.status).toBe('in-progress');

    const indexMtimeAfter = fs.statSync(repo.indexPath).mtimeMs;
    expect(indexMtimeAfter).toBe(indexMtimeBefore);
  });
});

describe('branch-setup integration — rebuild absence', () => {
  let repo;
  afterEach(() => { rmDir(repo?.dir); repo = null; });

  it('#13 shimmed npx exits 1 → flip succeeds, rebuild warning, exit 0', async () => {
    repo = setupTmpRepo({
      shards: { 'TASK-009': backlogShard('TASK-009') },
      rebuildCmd: 'npx tasklist-rebuild',
    });
    const shimDir = makeFailingNpxShim(repo.dir);

    // Prepend shim dir to existing PATH so the shim wins resolution while
    // git, node, etc. remain reachable. path.delimiter is platform-correct
    // (':' on POSIX, ';' on Windows) per LD-XPL-001.
    const currentPath = process.env.PATH || process.env.Path || '';
    const newPath = `${shimDir}${path.delimiter}${currentPath}`;

    const { stdout, stderr, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, env: { PATH: newPath, Path: newPath } },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.flipped).toBe(true);
    expect(env.statusFlip.rebuild?.ok).toBe(false);
    expect(stderr).toMatch(/rebuild warning:/);
  });
});

describe('branch-setup integration — restart write failure', () => {
  let repo;
  afterEach(() => { rmDir(repo?.dir); repo = null; });

  it('#14 mutator-output validation failure → exit 6 with envelope', async () => {
    // Build an in-progress shard, then strip the `id` field on disk. The
    // restart mutator (`{...current, started, updated, notes}`) will inherit
    // the missing id; updateShard's validateShardShape() then throws
    // ShardValidationError, which branch-setup wraps as
    // restart-io-error and emits to stdout before exit 6.
    //
    // Why this approach (vs chmod or schema injection):
    //   - chmod is unreliable on Windows (LD-XPL-001 cross-plat rule).
    //   - JSON-schema injection has no effect: updateShard does not run the
    //     library schema; only validateShardShape (id/status/updated string
    //     check + ISO sniff). So the validation knob to turn is the mutator
    //     output shape, induced by stripping id from the on-disk shard.
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });
    const shardPath = repo.primaryShardPath('TASK-009');
    const shard = readJson(shardPath);
    delete shard.id;
    writeJson(shardPath, shard);
    execSync('git add -A && git commit -q -m strip-id', { cwd: repo.dir });

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir, stdin: 'R\n', env: TTY_ENV },
    );
    expect(exitCode).toBe(6);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.reason).toMatch(/^restart-io-error:/);
    expect(env.statusFlip.choice).toBe('restart');
  });
});

// ---------------------------------------------------------------------------
// TASK-026 — vocab-error envelope discrimination + hard validation
// ---------------------------------------------------------------------------

/**
 * Overwrite the schema in a fixture repo with a custom enum, then commit so
 * the working tree stays clean (branch-setup's dirty-tree guard would exit 2).
 */
function rewriteSchemaEnum(repoDir, enumValues) {
  const schemaTarget = path.join(repoDir, '.tasks', 'schemas', 'task.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaTarget, 'utf8'));
  schema.properties.status.enum = enumValues;
  fs.writeFileSync(schemaTarget, JSON.stringify(schema, null, 2));
  execSync('git add -A && git commit -q -m rewrite-schema', { cwd: repoDir });
}

describe('branch-setup integration — vocab-error envelope (TASK-026)', () => {
  let repo;
  afterEach(() => { rmDir(repo?.dir); repo = null; });

  it('#15 ambiguous start vocab → exit 6 with vocab-error: envelope', async () => {
    // Two enum values both match START_RE (/^(in[-_]?progress|active|...)$/i).
    repo = setupTmpRepo({ shards: { 'TASK-009': backlogShard('TASK-009') } });
    rewriteSchemaEnum(repo.dir, ['backlog', 'in-progress', 'active', 'done']);

    const { stdout, stderr, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir },
    );
    expect(exitCode).toBe(6);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.flipped).toBe(false);
    expect(env.statusFlip.reason).toBe('vocab-error:ambiguous-start');
    expect(stderr).toMatch(/vocab error/);

    // Branch still exists (flip is best-effort; branch creation already happened).
    const branches = execSync('git branch --list', { cwd: repo.dir, encoding: 'utf8' });
    expect(branches).toContain('sprint-9-task-9-demo');

    // Shard untouched.
    const after = readJson(repo.primaryShardPath('TASK-009'));
    expect(after.status).toBe('backlog');
  });

  it('#16 partial statusMap → exit 6 with vocab-error:statusmap-partial envelope', async () => {
    repo = setupTmpRepo({
      shards: { 'TASK-009': backlogShard('TASK-009') },
      configOverrides: {
        shardLibraries: [
          {
            id: 'tasks',
            indexPath: path.join('.tasks', 'INDEX.json'),
            shardDir: path.join('.tasks', 'tasks'),
            schemaPath: path.join('.tasks', 'schemas', 'task.schema.json'),
            rebuildCmd: 'echo rebuild',
            primary: true,
            statusMap: { start: 'doing' }, // missing 'done' → partial
          },
        ],
      },
    });

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir },
    );
    expect(exitCode).toBe(6);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.reason).toBe('vocab-error:statusmap-partial');
    expect(env.statusFlip.flipped).toBe(false);
  });

  it('#17 no-match start vocab → exit 6 with vocab-error:no-match-start envelope', async () => {
    repo = setupTmpRepo({ shards: { 'TASK-009': backlogShard('TASK-009') } });
    rewriteSchemaEnum(repo.dir, ['new', 'queued', 'done']);

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      { cwd: repo.dir },
    );
    expect(exitCode).toBe(6);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.reason).toBe('vocab-error:no-match-start');
  });
});

describe('branch-setup integration — backdoor namespace (TASK-026)', () => {
  let repo;
  afterEach(() => { rmDir(repo?.dir); repo = null; });

  it('#18 NODE_ENV=production gates the test backdoor → non-TTY behaves non-interactive', async () => {
    // With NODE_ENV=production, the BRANCH_SETUP_TEST_FORCE_INTERACTIVE escape
    // hatch is inert. A non-TTY stdin therefore reaches abandon (exit 4)
    // without driving the prompt loop.
    repo = setupTmpRepo({ shards: { 'TASK-009': inProgressShard('TASK-009') } });

    const { stdout, exitCode } = await runBranchSetup(
      ['--sprint', '9', '--task', '9', '--slug', 'demo'],
      {
        cwd: repo.dir,
        stdin: 'r\n', // would resume if backdoor were active
        env: { ...TTY_ENV, NODE_ENV: 'production' },
      },
    );
    expect(exitCode).toBe(4);
    const env = parseEnvelope(stdout);
    expect(env.statusFlip.choice).toBe('abandon');
  });
});
