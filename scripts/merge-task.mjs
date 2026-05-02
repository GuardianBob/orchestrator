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
  scanLinks,
} from '../lib/shard-library.mjs';
import { normalizeTaskId } from '../lib/task-id.mjs';
import { isMain } from '../lib/is-main.mjs';
import {
  REASON_NO_PRIMARY,
  REASON_SHARD_NOT_FOUND,
  REASON_IO_ERROR_READ,
  REASON_ALREADY_DONE,
  REASON_CLOSED,
  REASON_UNKNOWN_LIBRARY,
  REASON_NOT_ATTEMPTED,
  REASON_SKIPPED_NO_CHANGES,
  REASON_PRIMARY_SHARD_MISSING,
  REASON_COMMIT_NOT_ATTEMPTED,
  reasonVocabError,
  reasonLocateError,
  reasonUpdateFailed,
  reasonIoError,
  reasonReloadError,
  reasonScanlinksFailed,
  reasonRebuildFailed,
  reasonConfigError,
  reasonUncaught,
} from '../lib/merge-task-reasons.mjs';
import { commitShardDeltas } from '../lib/commit-shard-deltas.mjs';
import { sanitizeErrorMessage } from '../lib/sanitize-error.mjs';

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

// ---------------------------------------------------------------------------
// Pure mutator for cross-library linked-shard close (TASK-013).
//
// Distinct from buildClosedShard in TWO ways:
//   1. Note text is "Resolved by <taskId> @ <sha12>" (vs "Merged into ...").
//   2. `completed` is preserved if already truthy — linked shards may have
//      been resolved by a prior task; we record only the *first* resolver.
//
// Notes polymorphism (W3 carryover, mirrors buildClosedShard):
//   - Array → spread + push, stays array.
//   - Non-empty string → newline-concat, stays string.
//   - Missing/null/empty → new single-element array.
// Coercion to a uniform array shape is deferred post-sprint-3.
//
// Note dedupe (defensive): if the most recent note already references the
// same `Resolved by <taskId>`, skip the append (corner case: operator re-run
// after partial failure within the same minute). The caller's `'already-done'`
// short-circuit covers the common path; this is belt-and-suspenders.
// ---------------------------------------------------------------------------
export function buildLinkedClosedShard(current, vocab, nowIso, noteEntry, taskId) {
  const next = { ...current, status: vocab.done, updated: nowIso };
  if (!current.completed) next.completed = nowIso;       // preserve first resolver

  const prev = current.notes;
  const dedupeMarker = `Resolved by ${taskId}`;

  if (Array.isArray(prev)) {
    const last = prev.length > 0 ? prev[prev.length - 1] : null;
    if (typeof last === 'string' && last.includes(dedupeMarker)) {
      next.notes = prev;                                 // dedupe: no-op append
    } else {
      next.notes = [...prev, noteEntry];
    }
  } else if (typeof prev === 'string' && prev.length > 0) {
    if (prev.includes(dedupeMarker)) {
      next.notes = prev;                                 // dedupe: no-op append
    } else {
      next.notes = `${prev}\n${noteEntry}`;
    }
  } else {
    next.notes = [noteEntry];
  }
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
 * Drive-by exported for TASK-013 test-symmetry with closeLinkedShardsOnMerge
 * (per blueprint §12 Q2 — sprint-3 prep flag, accepted by orchestrator).
 *
 * @returns {{ closed: boolean, reason: string, status?: string,
 *             completed?: string, sha?: string, rebuild?: object|null }}
 */
export function closePrimaryShardOnMerge({ libraries, taskId, sprintBranch, mergeSha,
                                           now = () => new Date().toISOString() }) {
  if (!Array.isArray(libraries) || libraries.length === 0)
    return { closed: false, reason: REASON_NO_PRIMARY };
  const primary = libraries.find((l) => l && l.primary === true);
  if (!primary) return { closed: false, reason: REASON_NO_PRIMARY };

  let vocab;
  try { vocab = resolveStatusVocab(primary); }
  catch (e) {
    process.stderr.write(`[merge-task] vocab error (${e.code || 'vocab'}): ${sanitizeErrorMessage(e)}\n`);
    return { closed: false, reason: reasonVocabError(e.code || 'unknown') };
  }

  let shardPath;
  try { shardPath = locateShard(primary, taskId); }
  catch (e) {
    process.stderr.write(`[merge-task] locate failed (${e.code || e.name}): ${sanitizeErrorMessage(e)}\n`);
    return { closed: false, reason: reasonLocateError(e.code || e.name) };
  }
  if (shardPath === null) {
    process.stderr.write(
      `[merge-task] merge succeeded but task shard ${taskId} not found in library '${primary.id}' — skipping shard-close\n`
    );
    return { closed: false, reason: REASON_SHARD_NOT_FOUND };
  }

  // Idempotency check — read current shard cheaply before attempting any write.
  let current;
  try { current = JSON.parse(fs.readFileSync(shardPath, 'utf8')); }
  catch (e) {
    process.stderr.write(`[merge-task] shard read failed: ${sanitizeErrorMessage(e)}\n`);
    return { closed: false, reason: REASON_IO_ERROR_READ };
  }
  if (current.status === vocab.done) {
    process.stderr.write(`[merge-task] ${taskId} already at status=${vocab.done}; skipping close\n`);
    return { closed: false, reason: REASON_ALREADY_DONE };
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
    process.stderr.write(`[merge-task] shard close failed (${e.code || e.name}): ${sanitizeErrorMessage(e)}\n`);
    return { closed: false, reason: reasonUpdateFailed(e.code || e.name) };
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
    reason: REASON_CLOSED,
    status: vocab.done,
    completed: nowIso,
    sha: shortSha,
    rebuild,
    libraryId: primary.id,                                 // TASK-014 Q15.1(a): symmetry with linkedShardClose.perLibrary[].libraryId
  };
}

/**
 * Close every linked-library shard referenced by the primary task shard.
 *
 * SIBLING (not nested under) closePrimaryShardOnMerge — runs after primary
 * close succeeds. Re-loads the primary shard from disk via locateShard +
 * fs.readFileSync (decouples from closePrimaryShardOnMerge's return shape;
 * adds one cheap FS read; documented decision in blueprint §15).
 *
 * Posture mirrors closePrimaryShardOnMerge: best-effort, never throws, never
 * exits non-zero. Each library is processed independently — one library's
 * failures do not abort other libraries.
 *
 * AC #5: rebuildLibrary is called AT MOST ONCE per library, AFTER the inner
 * per-shard loop completes, gated by closedIds.length > 0.
 *
 * Stderr discipline (SEC-W-012-1): every log line uses err.code || err.name,
 * never err.message. FS paths never reach stderr; only opaque <libId>/<id>
 * tokens.
 *
 * @param {object} args
 * @param {ShardLibrary[]} args.libraries  Output of loadLibraries().
 * @param {ShardLibrary} args.primary      Primary library (for re-loading the task shard).
 * @param {string} args.taskId             Normalized primary task id (e.g. 'TASK-013').
 * @param {string} args.mergeSha           Merge commit SHA (sliced to 12 chars).
 * @param {(msg:string)=>void} [args.log]  stderr writer; defaults to process.stderr.write.
 * @param {() => string} [args.now]        Clock injection for tests.
 * @returns {{
 *   closed: number,
 *   skipped: number,
 *   failures: number,
 *   perLibrary: Array<object>,
 *   scanError?: string
 * }}
 */
export function closeLinkedShardsOnMerge({ libraries, primary, taskId, mergeSha,
                                           log = (m) => process.stderr.write(m),
                                           now = () => new Date().toISOString() }) {
  const aggregate = { closed: 0, skipped: 0, failures: 0, perLibrary: [] };

  // Re-load primary shard from disk (blueprint §15 decision: re-load over
  // capturing updateShard return value; one extra FS read, decoupled).
  let taskShard;
  try {
    const primaryPath = locateShard(primary, taskId);
    if (primaryPath === null) {
      log(`[merge-task] linked-close: primary shard '${taskId}' missing post-merge; skipping linked-close\n`);
      aggregate.scanError = REASON_PRIMARY_SHARD_MISSING;
      return aggregate;
    }
    taskShard = JSON.parse(fs.readFileSync(primaryPath, 'utf8'));
  } catch (e) {
    log(`[merge-task] linked-close: primary re-load failed (${e.code || e.name})\n`);
    aggregate.scanError = reasonReloadError(e.code || e.name);
    return aggregate;
  }

  let linkMap;
  try {
    linkMap = scanLinks(taskShard, libraries);
  } catch (e) {
    log(`[merge-task] linked-close: scanLinks failed (${e.code || e.name})\n`);
    aggregate.scanError = reasonScanlinksFailed(e.code || e.name);
    return aggregate;
  }

  for (const [libId, idSet] of linkMap.entries()) {
    const library = libraries.find((l) => l && l.id === libId);
    if (!library) {
      log(`[merge-task] linked-close: unknown library '${libId}' in scanLinks result; skipping\n`);
      aggregate.perLibrary.push({
        libraryId: libId,
        closedIds: [],
        skippedIds: [],
        failures: [{ id: '*', reason: REASON_UNKNOWN_LIBRARY }],
        rebuilt: null,
      });
      aggregate.failures += 1;
      continue;
    }

    let vocab;
    try { vocab = resolveStatusVocab(library); }
    catch (e) {
      log(`[merge-task] linked-close: vocab error for '${libId}' (${e.code || 'vocab'}); skipping library\n`);
      aggregate.perLibrary.push({
        libraryId: libId,
        closedIds: [],
        skippedIds: [],
        failures: [{ id: '*', reason: reasonVocabError(e.code || 'unknown') }],
        rebuilt: null,
      });
      aggregate.failures += 1;
      continue;                                          // do NOT rebuild on vocab failure
    }

    const perLib = {
      libraryId: libId,
      closedIds: [],
      skippedIds: [],
      failures: [],
      rebuilt: null,
    };
    const dedupedIds = new Set(idSet);                   // belt-and-suspenders (scanLinks already Set)

    for (const id of dedupedIds) {
      let shardPath;
      try { shardPath = locateShard(library, id); }
      catch (e) {
        log(`[merge-task] linked-close: locate failed for '${libId}/${id}' (${e.code || e.name})\n`);
        perLib.failures.push({ id, reason: reasonLocateError(e.code || e.name) });
        aggregate.failures += 1;
        continue;
      }
      if (shardPath === null) {
        log(`[merge-task] linked-close: shard '${libId}/${id}' not found in INDEX; skipping (AC #4)\n`);
        perLib.skippedIds.push({ id, reason: REASON_SHARD_NOT_FOUND });
        aggregate.skipped += 1;
        continue;
      }

      let current;
      try { current = JSON.parse(fs.readFileSync(shardPath, 'utf8')); }
      catch (e) {
        log(`[merge-task] linked-close: read failed for '${libId}/${id}' (${e.code || 'io'})\n`);
        perLib.failures.push({ id, reason: reasonIoError(e.code || 'read') });
        aggregate.failures += 1;
        continue;
      }
      if (current.status === vocab.done) {
        perLib.skippedIds.push({ id, reason: REASON_ALREADY_DONE });
        aggregate.skipped += 1;
        continue;
      }

      const nowIso = now();
      const dateOnly = nowIso.slice(0, 10);
      const shortSha = (mergeSha || '').slice(0, 12) || '<unknown>';
      const noteEntry = `[${dateOnly}] Resolved by ${taskId} @ ${shortSha}`;

      try {
        updateShard(library, id, (cur) => buildLinkedClosedShard(cur, vocab, nowIso, noteEntry, taskId));
        perLib.closedIds.push(id);
        aggregate.closed += 1;
      } catch (e) {
        log(`[merge-task] linked-close: update failed for '${libId}/${id}' (${e.code || e.name})\n`);
        perLib.failures.push({ id, reason: reasonUpdateFailed(e.code || e.name) });
        aggregate.failures += 1;
        // continue — atomic write means shard is whole-old or whole-new
      }
    }

    // ── REBUILD ONCE per library, AFTER inner loop completes ────────────────
    // AC #5: NOT inside the for-id loop. Even if all shards skipped/failed,
    // rebuild iff at least one shard was successfully closed.
    if (perLib.closedIds.length > 0) {
      perLib.rebuilt = rebuildLibrary(library);          // {ok, reason}; never throws
      if (!perLib.rebuilt.ok) {
        log(`[merge-task] linked-close: rebuild failed for '${libId}' (${perLib.rebuilt.reason})\n`);
        perLib.failures.push({ id: '*', reason: reasonRebuildFailed(perLib.rebuilt.reason) });
        // failures counter not bumped: rebuild is a library-level event,
        // aggregate counters track shard-level events.
      }
    } else {
      perLib.rebuilt = { ok: true, reason: REASON_SKIPPED_NO_CHANGES };
    }

    aggregate.perLibrary.push(perLib);
  }

  return aggregate;
}

// ---------------------------------------------------------------------------
// CLI entry — only runs when executed directly (not when imported by tests).
// ---------------------------------------------------------------------------

if (isMain(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, []));
  const cwd = process.cwd();
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestrator.json'), 'utf8'));
  const prefix = cfg.branchPrefix || 'sprint';
  const sprintBranch = `${prefix}-${args.sprint}`;
  const taskBranch = `${sprintBranch}-task-${args.task}-${args.slug}`;

  const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
  const shSafe = (cmd) => { try { return sh(cmd); } catch { return null; } };

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
    console.error(JSON.stringify({ error: 'merge failed', detail: sanitizeErrorMessage(e) }));
    process.exit(2);
  }

  // Capture merge commit SHA immediately (sprint branch HEAD now points to it).
  const mergeSha = shSafe('git rev-parse HEAD') || '';

  // Close primary-library shard. Best-effort: never blocks living-docs commit.
  let shardClose = { closed: false, reason: REASON_NOT_ATTEMPTED };
  // Uniform shape: linkedShardClose always present in stdout (W1 carryover).
  let linkedShardClose = { closed: 0, skipped: 0, failures: 0, perLibrary: [], reason: REASON_NOT_ATTEMPTED };
  let libraries = null;
  let primaryLib = null;
  try {
    libraries = loadLibraries(path.join(cwd, '.orchestrator.json'));
    primaryLib = libraries.find((l) => l && l.primary === true) || null;
    shardClose = closePrimaryShardOnMerge({
      libraries,
      taskId: normalizeTaskId(args.task),
      sprintBranch,
      mergeSha,
    });
  } catch (e) {
    // loadLibraries is the only outer-throw path (config error). Warn + continue.
    process.stderr.write(`[merge-task] shard-close skipped: ${sanitizeErrorMessage(e)}\n`);
    shardClose = { closed: false, reason: reasonConfigError(e.code || 'unknown') };
  }

  // Cross-library linked-shard close (TASK-013). Only attempt if primary close
  // succeeded (which implies libraries+primary loaded successfully).
  if (shardClose.closed === true && libraries !== null && primaryLib !== null) {
    try {
      linkedShardClose = closeLinkedShardsOnMerge({
        libraries,
        primary: primaryLib,
        taskId: normalizeTaskId(args.task),
        mergeSha,
      });
    } catch (e) {
      // closeLinkedShardsOnMerge is best-effort and should not throw, but
      // belt-and-suspenders: warn-and-continue using opaque .code only.
      process.stderr.write(`[merge-task] linked-close uncaught (${e.code || e.name})\n`);
      linkedShardClose = { closed: 0, skipped: 0, failures: 0, perLibrary: [], reason: reasonUncaught(e.code || e.name) };
    }
  }

  // TASK-014: commit shard + INDEX deltas onto the sprint branch.
  // Sibling to closePrimaryShardOnMerge / closeLinkedShardsOnMerge.
  // Best-effort: never blocks living-docs commit.
  let commit = { committed: false, sha: null, reason: REASON_COMMIT_NOT_ATTEMPTED, files: 0, libraries: [] };
  if (libraries !== null) {
    try {
      commit = commitShardDeltas({
        taskId: normalizeTaskId(args.task),
        mergeSha,
        shardClose,
        linkedShardClose,
        libraries,
        cwd,
      });
    } catch (e) {
      // Defense-in-depth: helper is best-effort and should not throw.
      process.stderr.write(`[merge-task] commit-deltas uncaught (${e.code || e.name})\n`);
      commit = { committed: false, sha: null, reason: reasonUncaught(e.code || e.name), files: 0, libraries: [] };
    }
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

  console.log(JSON.stringify({ merged: taskBranch, into: sprintBranch, mergeSha, docsUpdated, shardClose, linkedShardClose, commit }, null, 2));
}
