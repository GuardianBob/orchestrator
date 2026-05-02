#!/usr/bin/env node
// merge-task.mjs --sprint <N> --task <id> --slug <slug>
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadLibraries,
  locateShard,
  updateShard,
  rebuildLibrary,
  resolveStatusVocab,
} from './shard-library.mjs';

// ---------------------------------------------------------------------------
// Zero-pad task id to TASK-NNN — duplicated from branch-setup.mjs:306
// (deriveTaskId). Trivial 9-line utility; extract to scripts/lib/task-id.mjs
// in a future cleanup task if a third caller appears.
// ---------------------------------------------------------------------------
function normalizeTaskId(rawTaskArg) {
  const s = String(rawTaskArg);
  if (/^[A-Z][A-Z0-9_]*-\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return `TASK-${s.padStart(3, '0')}`;
  return `TASK-${s}`;
}

// ---------------------------------------------------------------------------
// Pure mutator — exported so TASK-015 can import-and-test directly.
// Sets status=vocab.done, completed=nowIso, updated=nowIso, and appends a
// note. Tolerates legacy notes-as-string and missing notes.
// ---------------------------------------------------------------------------
export function buildClosedShard(current, vocab, nowIso, noteEntry) {
  const next = { ...current, status: vocab.done, updated: nowIso, completed: nowIso };
  const prev = current.notes;
  if (Array.isArray(prev))                                 next.notes = [...prev, noteEntry];
  else if (typeof prev === 'string' && prev.length > 0)    next.notes = `${prev}\n${noteEntry}`;
  else                                                     next.notes = [noteEntry];
  return next;
}

/**
 * Close the primary-library shard for taskId after a successful merge.
 *
 * Asymmetry vs branch-setup.mjs: branch-setup treats a failed shard write as
 * a hard exit (no branch yet → safe to abort). merge-task is the opposite —
 * the merge commit already exists on the sprint branch, so aborting after
 * the fact would leave the repo in a worse state than completing with a
 * warning. Hence: best-effort, never throw, never exit non-zero.
 *
 * @returns {{ closed: boolean, reason: string, status?: string,
 *             completed?: string, sha?: string, rebuild?: object|null }}
 */
function closePrimaryShardOnMerge({ libraries, taskId, sprintBranch, mergeSha,
                                    now = () => new Date().toISOString() }) {
  if (!Array.isArray(libraries) || libraries.length === 0)
    return { closed: false, reason: 'no-primary' };
  const primary = libraries.find((l) => l && l.primary === true);
  if (!primary) return { closed: false, reason: 'no-primary' };

  let vocab;
  try { vocab = resolveStatusVocab(primary); }
  catch (e) {
    process.stderr.write(`[merge-task] vocab error (${e.code || 'vocab'}): ${e.message}\n`);
    return { closed: false, reason: `vocab-error:${e.code || 'unknown'}` };
  }

  let shardPath;
  try { shardPath = locateShard(primary, taskId); }
  catch (e) {
    process.stderr.write(`[merge-task] locate failed (${e.code || e.name}): ${e.message}\n`);
    return { closed: false, reason: `locate-error:${e.code || e.name}` };
  }
  if (shardPath === null) {
    process.stderr.write(
      `[merge-task] merge succeeded but task shard ${taskId} not found in library '${primary.id}' — skipping shard-close\n`
    );
    return { closed: false, reason: 'shard-not-found' };
  }

  // Idempotency check — read current shard cheaply before attempting any write.
  let current;
  try { current = JSON.parse(fs.readFileSync(shardPath, 'utf8')); }
  catch (e) {
    process.stderr.write(`[merge-task] shard read failed: ${e.message}\n`);
    return { closed: false, reason: 'io-error:read' };
  }
  if (current.status === vocab.done) {
    process.stderr.write(`[merge-task] ${taskId} already at status=${vocab.done}; skipping close\n`);
    return { closed: false, reason: 'already-done' };
  }

  const nowIso = now();
  const dateOnly = nowIso.slice(0, 10);                    // UTC YYYY-MM-DD
  const shortSha = (mergeSha || '').slice(0, 12) || '<unknown>';
  const noteEntry = `[${dateOnly}] Merged into ${sprintBranch} at ${shortSha}`;

  try {
    updateShard(primary, taskId, (cur) => buildClosedShard(cur, vocab, nowIso, noteEntry));
  } catch (e) {
    // ShardNotFoundError / ShardValidationError / ShardLibraryError all share
    // a `code` discriminator. Atomic write means the shard is either fully
    // old or fully new — never half-written (LD-PAT-002).
    process.stderr.write(`[merge-task] shard close failed (${e.code || e.name}): ${e.message}\n`);
    return { closed: false, reason: `update-failed:${e.code || e.name}` };
  }

  // Rebuild — already resilient (returns {ok,reason}; never throws per its contract).
  const rebuild = rebuildLibrary(primary);
  if (!rebuild.ok) {
    process.stderr.write(
      `[merge-task] shard library rebuild failed: ${rebuild.reason} — operator should re-run rebuild manually\n`
    );
  }

  return {
    closed: true,
    reason: 'closed',
    status: vocab.done,
    completed: nowIso,
    sha: shortSha,
    rebuild,
  };
}

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const cwd = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestrator.json'), 'utf8'));
const prefix = cfg.branchPrefix || 'sprint';
const sprintBranch = `${prefix}-${args.sprint}`;
const taskBranch = `${sprintBranch}-task-${args.task}-${args.slug}`;

function sh(cmd) { return execSync(cmd, { encoding: 'utf8' }).trim(); }
function shSafe(cmd) { try { return sh(cmd); } catch (e) { return null; } }

// Verify gates passed before merging (unless --force).
const force = process.argv.includes('--force');
const gatesDir = path.join(cwd, '.orchestrator', 'gates');
let latestGate = null;
if (fs.existsSync(gatesDir)) {
  const files = fs.readdirSync(gatesDir)
    .filter(f => f.startsWith(`task-${args.task}-attempt-`) && f.endsWith('.json'))
    .sort();
  if (files.length) {
    latestGate = JSON.parse(fs.readFileSync(path.join(gatesDir, files[files.length - 1]), 'utf8'));
  }
}
if (!force) {
  if (!latestGate) {
    console.error(JSON.stringify({ error: 'No gate result found for task. Run run-gates.mjs first or pass --force.' }));
    process.exit(3);
  }
  if (!latestGate.passed) {
    console.error(JSON.stringify({ error: 'Gates failed for latest attempt. Refusing to merge.', gate: latestGate }));
    process.exit(3);
  }
}

// Fetch task title from commit
const taskTitle = shSafe(`git log -1 --format=%s ${taskBranch}`) || `task-${args.task}`;

sh(`git checkout ${sprintBranch}`);
const mergeStrategy = cfg.mergeStrategy === 'no-ff' ? '--no-ff' : '';
try {
  sh(`git merge ${mergeStrategy} ${taskBranch} -m "merge(task-${args.task}): into ${sprintBranch}"`);
} catch (e) {
  console.error(JSON.stringify({ error: 'merge failed', detail: e.message.slice(0, 500) }));
  process.exit(2);
}

// Capture merge commit SHA immediately (sprint branch HEAD now points to it).
const mergeSha = shSafe('git rev-parse HEAD') || '';

// Close primary-library shard. Best-effort: never blocks living-docs commit.
let shardClose = { closed: false, reason: 'not-attempted' };
try {
  const libraries = loadLibraries(path.join(cwd, '.orchestrator.json'));
  shardClose = closePrimaryShardOnMerge({
    libraries,
    taskId: normalizeTaskId(args.task),
    sprintBranch,
    mergeSha,
  });
} catch (e) {
  // loadLibraries is the only outer-throw path (config error). Warn + continue.
  process.stderr.write(`[merge-task] shard-close skipped: ${e.message}\n`);
  shardClose = { closed: false, reason: `config-error:${e.code || 'unknown'}` };
}

// Update living docs
const docsUpdated = [];
const livingDocs = cfg.livingDocs || [];
const stamp = new Date().toISOString().slice(0, 10);

function appendIfListed(file, content) {
  if (!livingDocs.includes(file)) return;
  const p = path.join(cwd, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, `# ${file.replace('.md','')}\n\n`);
  fs.appendFileSync(p, content);
  docsUpdated.push(file);
}

appendIfListed('STATUS_SUMMARY.md', `\n- [${stamp}] Completed task-${args.task}: ${taskTitle.replace(/^feat\(task-\d+\):\s*/, '')}\n`);

// MEMORY.md — update next_task_id + recent_changes
if (livingDocs.includes('MEMORY.md')) {
  const p = path.join(cwd, 'MEMORY.md');
  let content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# Memory\n\nnext_task_id: 1\n\n## recent_changes\n';
  // bump next_task_id if numeric
  content = content.replace(/next_task_id:\s*(\d+)/, (_, n) => `next_task_id: ${parseInt(n,10) + 1}`);
  // prepend bullet under recent_changes
  if (/##\s*recent_changes/i.test(content)) {
    content = content.replace(/(##\s*recent_changes\s*\n)/i, `$1- [${stamp}] task-${args.task} merged → ${sprintBranch}\n`);
  } else {
    content += `\n## recent_changes\n- [${stamp}] task-${args.task} merged → ${sprintBranch}\n`;
  }
  fs.writeFileSync(p, content);
  docsUpdated.push('MEMORY.md');
}

// TASKLIST.md / PHASE_*_PLAN.md — check off the task
if (livingDocs.includes('TASKLIST.md')) {
  const candidates = [path.join(cwd, 'TASKLIST.md')];
  for (const f of fs.readdirSync(cwd)) {
    if (/^PHASE_\d+_PLAN\.md$/i.test(f)) candidates.push(path.join(cwd, f));
  }
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let content = fs.readFileSync(p, 'utf8');
    const re = new RegExp(`(^\\s*-\\s*\\[)\\s(\\]\\s+(?:task-|#)?${args.task}[:\\s-])`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `$1x$2`);
      fs.writeFileSync(p, content);
      docsUpdated.push(path.basename(p));
    }
  }
}

// ADVENTURES_IN_CODING.md — only if narrated_dev persona is active (env var set by user/skill)
if (livingDocs.includes('ADVENTURES_IN_CODING.md') && process.env.ORCHESTRATOR_PERSONA_NARRATED === '1') {
  const p = path.join(cwd, 'ADVENTURES_IN_CODING.md');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '# Adventures in Coding\n\n');
  fs.appendFileSync(p, `\n## Chapter — task-${args.task} (${stamp})\n\n_${taskTitle}_ — merged into ${sprintBranch}.\n`);
  docsUpdated.push('ADVENTURES_IN_CODING.md');
}

// Commit doc updates if any
const dirty = shSafe('git status --porcelain') || '';
if (dirty.trim()) {
  sh('git add -A');
  sh(`git commit -m "docs(task-${args.task}): update living docs"`);
}

// Delete task branch locally
shSafe(`git branch -d ${taskBranch}`);

console.log(JSON.stringify({ merged: taskBranch, into: sprintBranch, mergeSha, docsUpdated, shardClose }, null, 2));
