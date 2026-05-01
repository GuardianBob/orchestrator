#!/usr/bin/env node
// branch-setup.mjs --sprint <N> --task <id> --slug <slug> [--no-status-flip] [--no-rebuild]
//
// Creates the sprint + task git branches, then flips the primary library's shard
// from its initial status into vocab.start (e.g. "in-progress") and triggers an
// INDEX rebuild. The flip is best-effort: a flip failure leaves the branch
// checked out so the operator can rerun with --no-status-flip or hand-fix.
//
// Exit codes:
//   0  success (flip happened, or skipped for documented soft reasons)
//   2  working tree dirty
//   3  CLI usage error (missing flag value)
//   4  shard already at vocab.done — refusing to start
//   5  config error (loadLibraries threw — bad shardLibraries[] / no primary)
//   6  shard write/IO failure mid-flip (branch still exists)
//   1  any other unexpected error

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  loadLibraries,
  locateShard,
  updateShard,
  rebuildLibrary,
  resolveStatusVocab,
  ShardLibraryError,
  ShardValidationError,
} from './shard-library.mjs';
import { promptCollisionChoice, buildRestartedShard } from '../lib/collision-prompt.mjs';

// ---------------------------------------------------------------------------
// LD-PAT-005 — isMain guard (ported inline; no lib/is-main.mjs in repo)
// ---------------------------------------------------------------------------

function isMain(metaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const resolved = pathToFileURL(realpathSync(argv1)).href;
    return resolved === metaUrl;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// LD-CLI-003 — required-value enforcement
// ---------------------------------------------------------------------------

class UsageError extends Error {
  constructor(msg) { super(msg); this.name = 'UsageError'; }
}

function requireValue(flag, value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.startsWith('--'))) {
    throw new UsageError(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const flags = {
    sprint: null,
    task: null,
    slug: null,
    'no-status-flip': false,
    'no-rebuild': false,
    'non-interactive': false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--sprint':         flags.sprint = requireValue('--sprint', argv[++i]); break;
      case '--task':           flags.task   = requireValue('--task',   argv[++i]); break;
      case '--slug':           flags.slug   = requireValue('--slug',   argv[++i]); break;
      case '--no-status-flip': flags['no-status-flip'] = true; break;
      case '--no-rebuild':     flags['no-rebuild']     = true; break;
      case '--non-interactive': flags['non-interactive'] = true; break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        if (a.startsWith('--')) throw new UsageError(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

function printHelp() {
  process.stderr.write(
    'Usage: branch-setup.mjs --sprint <N> --task <id> --slug <slug> [--no-status-flip] [--no-rebuild] [--non-interactive]\n' +
    '\n' +
    'Creates sprint + task git branches and flips the primary shard library\n' +
    '(default: tasks) from its initial status into vocab.start (e.g. in-progress).\n' +
    '\n' +
    'Required:\n' +
    '  --sprint <N>          sprint number (e.g. 2)\n' +
    '  --task <id>           task numeric id (e.g. 9 → TASK-009)\n' +
    '  --slug <slug>         short kebab slug for the branch name\n' +
    '\n' +
    'Optional:\n' +
    '  --no-status-flip      skip the entire shard-flip + rebuild step\n' +
    '  --no-rebuild          flip the shard but skip rebuildLibrary()\n' +
    '  --non-interactive     refuse all prompts; abandon on collision (exit 4)\n' +
    '  -h, --help            print this help\n'
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — TASK-011)
// ---------------------------------------------------------------------------

/**
 * Classify a shard's current status against its resolved vocab.
 * @param {string} currentStatus
 * @param {{ start: string, done: string }} vocab
 * @returns {'initial' | 'start' | 'done' | 'other'}
 */
export function classifyShardStatus(currentStatus, vocab) {
  if (typeof currentStatus !== 'string' || currentStatus.length === 0) return 'other';
  if (!vocab || typeof vocab.start !== 'string' || typeof vocab.done !== 'string') return 'other';
  if (currentStatus === vocab.done)  return 'done';
  if (currentStatus === vocab.start) return 'start';
  // Anything that isn't start or done is treated as flippable "initial".
  // The collision prompt in TASK-010 will refine this; for now we err on the
  // side of flipping (status === 'backlog' / 'ready' / etc.).
  return 'initial';
}

/**
 * Build the next shard for the flip. Pure mutator — no I/O.
 * Sets status = vocab.start, updated = nowIso, started = nowIso (only if absent/null).
 * Preserves all other fields verbatim.
 * @param {object} current
 * @param {{ start: string, done: string }} vocab
 * @param {string} nowIso
 * @returns {object}
 */
export function buildFlippedShard(current, vocab, nowIso) {
  const next = { ...current, status: vocab.start, updated: nowIso };
  if (current.started === undefined || current.started === null) {
    next.started = nowIso;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Orchestration helper — locate → read → classify → flip → rebuild
// Returns a result object; never calls process.exit; throws only on hard
// failures (FS write error, malformed library, unsafe ID).
// ---------------------------------------------------------------------------

/**
 * @param {Array} libraries  Output of loadLibraries(); may be empty.
 * @param {string} taskId    Shard ID (e.g. "TASK-009").
 * @param {object} [opts]
 * @param {boolean} [opts.skipFlip]    If true, return {flipped:false, reason:'skipped'}.
 * @param {boolean} [opts.skipRebuild] If true, do not invoke rebuildLibrary().
 * @param {() => string} [opts.now]    Injectable clock (default: ISO of new Date()).
 * @returns {{ flipped: boolean, reason: string, rebuild?: object|null }}
 */
export function flipPrimaryShardStatus(libraries, taskId, opts = {}) {
  const { skipFlip = false, skipRebuild = false, now = () => new Date().toISOString() } = opts;

  if (skipFlip) return { flipped: false, reason: 'skipped' };

  if (!Array.isArray(libraries) || libraries.length === 0) {
    return { flipped: false, reason: 'no-primary' };
  }
  const primary = libraries.find((l) => l && l.primary === true);
  if (!primary) return { flipped: false, reason: 'no-primary' };

  const shardPath = locateShard(primary, taskId);
  if (shardPath === null) return { flipped: false, reason: 'not-found' };

  const vocab = resolveStatusVocab(primary);

  // Read current shard for classification (cheap; updateShard re-reads under the lock).
  let current;
  try {
    current = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
  } catch (e) {
    throw new ShardLibraryError(`Failed to read shard ${shardPath}: ${e.message}`);
  }

  const klass = classifyShardStatus(current.status, vocab);
  if (klass === 'done')  return { flipped: false, reason: 'already-done' };
  if (klass === 'start') return { flipped: false, reason: 'already-at-start' };
  if (klass === 'other') return { flipped: false, reason: `unexpected-status:${current.status}` };

  // klass === 'initial' — perform the flip.
  const nowIso = now();
  updateShard(primary, taskId, (cur) => buildFlippedShard(cur, vocab, nowIso));

  let rebuild = null;
  if (!skipRebuild) {
    rebuild = rebuildLibrary(primary); // never throws; warns on its own
  }
  return { flipped: true, reason: 'flipped', rebuild };
}

// ---------------------------------------------------------------------------
// handleCollisionAtStart — extracted from main() in TASK-011.
//
// Owns the 'already-at-start' branch: prompt the operator, dispatch on
// resume / restart / abandon, perform the restart write + rebuild if chosen,
// and emit the JSON envelope + process.exit on the terminal paths
// (abandon → exit 4, restart-io-error → exit 6).
//
// Lives in scripts/, NOT lib/, because it owns I/O and exit codes
// (LD-BUG-010 forbids process.exit in lib/ only).
//
// On the non-terminal paths (resume / restart-success) the function returns a
// new statusFlip object and the caller emits the envelope + exits 0.
// ---------------------------------------------------------------------------

async function handleCollisionAtStart(ctx) {
  const { libraries, taskId, args, sprintBranch, taskBranch, baseBranch } = ctx;
  // Test escape hatch (LD-CI-* — deterministic interactive simulation):
  //   BRANCH_SETUP_FORCE_INTERACTIVE=1 forces isInteractive=true regardless of
  //   the stdin TTY state. Used by tests/integration/branch-setup.test.mjs to
  //   exercise the prompt loop via piped stdin (Node has no built-in pty).
  //   Production callers never set this env var.
  const ttyOk = process.stdin.isTTY === true
    || process.env.BRANCH_SETUP_FORCE_INTERACTIVE === '1';
  const isInteractive = ttyOk && !args['non-interactive'];
  const primary = libraries.find((l) => l && l.primary === true);
  const shardPath = primary ? locateShard(primary, taskId) : null;
  let current = null;
  if (shardPath) {
    try {
      current = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
    } catch {
      current = null;
    }
  }
  const choice = await promptCollisionChoice({
    taskId,
    currentStarted: current ? current.started : null,
    currentStatus: current ? current.status : null,
    isInteractive,
  });

  if (choice === 'resume') {
    process.stderr.write(
      `[branch-setup] collision: resuming ${taskId} (preserving started timestamp)\n`
    );
    return { flipped: false, reason: 'collision-resumed', choice };
  }

  if (choice === 'restart') {
    const nowIso = new Date().toISOString();
    try {
      updateShard(primary, taskId, (cur) => buildRestartedShard(cur, nowIso));
    } catch (e) {
      process.stderr.write(`[branch-setup] restart write failed: ${e.message}\n`);
      const statusFlip = { flipped: false, reason: `restart-io-error:${e.message}`, choice };
      console.log(JSON.stringify(
        { sprintBranch, taskBranch, baseBranch,
          current: sh('git branch --show-current'), statusFlip },
        null, 2));
      process.exit(6);
    }
    let rebuild = null;
    if (!args['no-rebuild']) rebuild = rebuildLibrary(primary);
    process.stderr.write(`[branch-setup] collision: restarted ${taskId}\n`);
    return { flipped: true, reason: 'collision-restarted', choice, rebuild };
  }

  // choice === 'abandon'
  process.stderr.write(
    `[branch-setup] collision: abandoning ${taskId} per operator choice\n`
  );
  const statusFlip = { flipped: false, reason: 'collision-abandoned', choice };
  console.log(JSON.stringify(
    { sprintBranch, taskBranch, baseBranch,
      current: sh('git branch --show-current'), statusFlip },
    null, 2));
  process.exit(4);
}

// ---------------------------------------------------------------------------
// Git helpers (existing behavior preserved)
// ---------------------------------------------------------------------------

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function shSafe(cmd) {
  try { return sh(cmd); } catch { return null; }
}
function branchExists(name) {
  return shSafe(`git rev-parse --verify ${name}`) !== null;
}

// ---------------------------------------------------------------------------
// Zero-pad task id to TASK-NNN (≥3 digits; larger naturally widen)
// ---------------------------------------------------------------------------

function deriveTaskId(rawTaskArg) {
  const s = String(rawTaskArg);
  // Already a full ID? Accept verbatim if it matches the safe pattern.
  if (/^[A-Z][A-Z0-9_]*-\d+$/.test(s)) return s;
  // Pure digits → zero-pad to 3.
  if (/^\d+$/.test(s)) return `TASK-${s.padStart(3, '0')}`;
  // Anything else: pass through and let validateShardId throw downstream.
  return `TASK-${s}`;
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      printHelp();
      process.exit(3);
    }
    throw e;
  }

  if (args.help) { printHelp(); process.exit(0); }

  for (const f of ['sprint', 'task', 'slug']) {
    if (args[f] === null || args[f] === undefined) {
      process.stderr.write(`Missing required flag: --${f}\n`);
      printHelp();
      process.exit(3);
    }
  }

  const cfgPath = path.join(process.cwd(), '.orchestrator.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const prefix = cfg.branchPrefix || 'sprint';
  // Flat hyphenated naming — git refs cannot have a branch and a sub-namespace
  // with the same root, so we keep everything as siblings.
  const sprintBranch = `${prefix}-${args.sprint}`;
  const taskBranch = `${sprintBranch}-task-${args.task}-${args.slug}`;

  // Load libraries up-front so config errors fail before any git mutation.
  // (Empty / legacy configs are tolerated; loadLibraries throws only on
  // genuinely broken state.)
  let libraries = [];
  try {
    libraries = loadLibraries(cfgPath);
  } catch (e) {
    if (e instanceof ShardLibraryError) {
      process.stderr.write(`[branch-setup] config error: ${e.message}\n`);
      process.exit(5);
    }
    throw e;
  }

  const baseBranch =
    shSafe('git symbolic-ref --short refs/remotes/origin/HEAD')?.replace('origin/', '') || 'main';

  // Stash guard — orchestrator must control commits.
  const status = shSafe('git status --porcelain') || '';
  if (status.trim()) {
    console.error(JSON.stringify({ error: 'Working tree dirty. Commit or stash before orchestrating.', status }));
    process.exit(2);
  }

  if (!branchExists(sprintBranch)) {
    sh(`git checkout ${baseBranch}`);
    shSafe('git pull --ff-only');
    sh(`git checkout -b ${sprintBranch}`);
  }

  if (branchExists(taskBranch)) {
    sh(`git checkout ${taskBranch}`);
  } else {
    sh(`git checkout ${sprintBranch}`);
    sh(`git checkout -b ${taskBranch}`);
  }

  // ─── SAFE POINT: branch is live; flip is best-effort below ─────────────────

  const taskId = deriveTaskId(args.task);
  let statusFlip;
  try {
    statusFlip = flipPrimaryShardStatus(libraries, taskId, {
      skipFlip: args['no-status-flip'],
      skipRebuild: args['no-rebuild'],
    });
  } catch (e) {
    if (e instanceof ShardValidationError) {
      process.stderr.write(`[branch-setup] shard validation error: ${e.message}\n`);
      statusFlip = { flipped: false, reason: `validation-error:${e.message}` };
    } else if (e instanceof ShardLibraryError) {
      process.stderr.write(`[branch-setup] shard write error: ${e.message}\n`);
      console.log(JSON.stringify(
        { sprintBranch, taskBranch, baseBranch,
          current: sh('git branch --show-current'),
          statusFlip: { flipped: false, reason: `io-error:${e.message}` } },
        null, 2));
      process.exit(6);
    } else {
      throw e;
    }
  }

  // Map result.reason → log line (stderr) and exit-code decision.
  switch (statusFlip.reason) {
    case 'flipped':
      process.stderr.write(`[branch-setup] flipped ${taskId} → in-progress\n`);
      break;
    case 'skipped':
      process.stderr.write(`[branch-setup] --no-status-flip set; shard ${taskId} untouched\n`);
      break;
    case 'no-primary':
      process.stderr.write('[branch-setup] no primary library configured; skipping status flip\n');
      break;
    case 'not-found':
      process.stderr.write(`[branch-setup] shard ${taskId} not found in primary library; skipping status flip\n`);
      break;
    case 'already-at-start':
      statusFlip = await handleCollisionAtStart({
        libraries, taskId, args, sprintBranch, taskBranch, baseBranch,
      });
      break;
    case 'already-done':
      process.stderr.write(`[branch-setup] shard ${taskId} is done; refusing to start\n`);
      console.log(JSON.stringify(
        { sprintBranch, taskBranch, baseBranch,
          current: sh('git branch --show-current'), statusFlip },
        null, 2));
      process.exit(4);
    default:
      if (statusFlip.reason && statusFlip.reason.startsWith('unexpected-status:')) {
        process.stderr.write(
          `[branch-setup] shard ${taskId} at unexpected status; skipping flip (not in startable bucket)\n`
        );
      } else if (statusFlip.reason && statusFlip.reason.startsWith('validation-error:')) {
        // already logged above
      } else {
        process.stderr.write(`[branch-setup] flip skipped: ${statusFlip.reason}\n`);
      }
  }

  if (statusFlip.flipped && statusFlip.rebuild && statusFlip.rebuild.ok === false) {
    process.stderr.write(`[branch-setup] rebuild warning: ${statusFlip.rebuild.reason}\n`);
  }

  console.log(JSON.stringify(
    { sprintBranch, taskBranch, baseBranch,
      current: sh('git branch --show-current'), statusFlip },
    null, 2));
}

if (isMain(import.meta.url)) {
  await main();
}
