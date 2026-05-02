// lib/commit-shard-deltas.mjs
//
// Pure helper: stage and commit shard-library directories touched by the
// post-merge close phases. Sibling-pattern peer of closePrimaryShardOnMerge /
// closeLinkedShardsOnMerge (TASK-013/014, currently inlined in
// scripts/merge-task.mjs). Extracted from scripts/merge-task.mjs in TASK-029
// for size discipline (LD-PAT-001 + LD-ARC-001).
//
// Pure-lib invariant (LD-PAT-001 / LD-BUG-010): no top-level side effects,
// no process.exit, no console.*, no isMain runner. All output goes through
// the caller-supplied `log` callback. Stderr discipline (SEC-W-012-1):
// opaque tokens only — never raw subprocess stderr, never absolute paths.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  REASON_COMMIT_OK,
  REASON_COMMIT_NO_CHANGES,
  reasonCommitAddFailed,
  reasonCommitDiffFailed,
  reasonCommitFailed,
} from './merge-task-reasons.mjs';

/**
 * Stage and commit all shard-library directories touched by the post-merge
 * close phases. Sibling to closePrimaryShardOnMerge / closeLinkedShardsOnMerge.
 *
 * Posture: best-effort, never throws, never exits non-zero. The merge commit
 * already exists; aborting after-the-fact would leave the repo in a worse
 * state than completing with a warning (mirrors TASK-012/013 precedent).
 *
 * No-op detection (AC #3): after `git add`, runs `git diff --cached --quiet`.
 * Exit 0 ⇒ nothing was actually staged ⇒ returns committed:false WITHOUT
 * invoking `git commit`. Avoids empty commits on the sprint branch.
 *
 * Directory deduplication: primary + linked libraryIds are deduped via Set
 * before resolving to filesystem directories. Each unique library directory
 * (path.dirname(library.indexPath)) is staged once.
 *
 * Subprocess: spawnSync (NOT execSync) — argv arrays bypass shell quoting,
 * and `git diff --cached --quiet` exit 1 (changes present) is a normal signal
 * that execSync would treat as a throw.
 *
 * DI seam: `run` parameter is caller-replaceable for tests (no vi.mock of
 * node:child_process needed). Defaults to a real spawnSync wrapper.
 *
 * @returns {{ committed: boolean, sha: string|null, reason: string,
 *             files: number, libraries: string[] }}
 */
export function commitShardDeltas({ taskId, mergeSha, shardClose, linkedShardClose,
                                    libraries, cwd, log = (m) => process.stderr.write(m),
                                    run } = {}) {
  const realRun = (file, argv, opts = {}) => spawnSync(file, argv, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  const exec = run || realRun;

  // 1. Collect unique libraryIds from primary + linked sources.
  const libIds = new Set();
  if (shardClose && typeof shardClose.libraryId === 'string') libIds.add(shardClose.libraryId);
  if (linkedShardClose && Array.isArray(linkedShardClose.perLibrary)) {
    for (const p of linkedShardClose.perLibrary) {
      if (p && typeof p.libraryId === 'string') libIds.add(p.libraryId);
    }
  }

  // 2. Resolve to filesystem directories (deduped).
  const dirSet = new Set();
  const stagedLibIds = [];
  const dirs = [];
  for (const libId of libIds) {
    const lib = Array.isArray(libraries) ? libraries.find((l) => l && l.id === libId) : null;
    if (!lib) {
      log(`[merge-task] commit-deltas: skip unknown library '${libId}'\n`);
      continue;
    }
    const dir = path.dirname(lib.indexPath);
    if (dirSet.has(dir)) continue;
    dirSet.add(dir);
    stagedLibIds.push(libId);
    dirs.push(dir);
  }

  // 3. Empty dirSet shortcut (degenerate but legal).
  if (dirs.length === 0) {
    return { committed: false, sha: null, reason: REASON_COMMIT_NO_CHANGES, files: 0, libraries: [] };
  }

  // 4. Stage each directory; abort early on first non-zero (avoid partial commit).
  for (let i = 0; i < dirs.length; i++) {
    const r = exec('git', ['add', '--', dirs[i]]);
    if (r.status !== 0) {
      log(`[merge-task] commit-deltas: add failed for '${stagedLibIds[i]}' (exit:${r.status})\n`);
      return {
        committed: false, sha: null,
        reason: reasonCommitAddFailed(r.status),
        files: 0, libraries: stagedLibIds,
      };
    }
  }

  // 5. No-op detection: `git diff --cached --quiet` → 0=no diff, 1=diff present, other=error.
  const diff = exec('git', ['diff', '--cached', '--quiet']);
  if (diff.status === 0) {
    return { committed: false, sha: null, reason: REASON_COMMIT_NO_CHANGES, files: 0, libraries: stagedLibIds };
  }
  if (diff.status !== 1) {
    log(`[merge-task] commit-deltas: diff probe failed (exit:${diff.status})\n`);
    return {
      committed: false, sha: null,
      reason: reasonCommitDiffFailed(diff.status),
      files: 0, libraries: stagedLibIds,
    };
  }

  // 6. Count staged files (best-effort).
  let files = 0;
  const numstat = exec('git', ['diff', '--cached', '--numstat']);
  if (numstat.status === 0 && typeof numstat.stdout === 'string') {
    const out = numstat.stdout.trim();
    files = out === '' ? 0 : out.split('\n').length;
  }

  // 7. Commit.
  const shortSha = (mergeSha || '').slice(0, 12) || '<unknown>';
  const commitMsg = `chore(orchestrator): close ${taskId} + linked shards [${shortSha}]`;
  const commit = exec('git', ['commit', '-m', commitMsg]);
  if (commit.status !== 0) {
    log(`[merge-task] commit-deltas: commit failed (exit:${commit.status})\n`);
    return {
      committed: false, sha: null,
      reason: reasonCommitFailed(commit.status),
      files, libraries: stagedLibIds,
    };
  }

  // 8. Capture new SHA (best-effort; commit IS on disk regardless).
  let sha = null;
  const rev = exec('git', ['rev-parse', '--short=12', 'HEAD']);
  if (rev.status === 0 && typeof rev.stdout === 'string') {
    sha = rev.stdout.trim() || null;
  } else {
    log(`[merge-task] commit-deltas: rev-parse post-commit failed (exit:${rev.status})\n`);
  }

  return { committed: true, sha, reason: REASON_COMMIT_OK, files, libraries: stagedLibIds };
}
