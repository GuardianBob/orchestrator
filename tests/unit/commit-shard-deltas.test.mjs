// tests/unit/commit-shard-deltas.test.mjs
// TASK-029 — Unit tests for commitShardDeltas, now living in
// lib/commit-shard-deltas.mjs. Uses the `run` dependency-injection seam
// instead of vi.mock('node:child_process', ...) — cleaner and the seam was
// designed for it.
//
// Eight scenarios:
//   1. Happy path: 2 libraries → stage both, diff=1, commit ok, sha captured.
//   2. No-op: stage succeeds, diff=0 → no commit invoked.
//   3. git add failure → early abort.
//   4. git diff broken (status 128) → reasonCommitDiffFailed.
//   5. git commit fails → reasonCommitFailed; no rev-parse called.
//   6. Empty libIds → shortcut no-op, run never invoked.
//   7. Unknown libraryId in linkedShardClose → logged + skipped.
//   8. Atomic-write semantics: rev-parse fails post-commit → committed:true,
//      reason:commit-ok, sha:null, log records rev-parse failure.

import { describe, it, expect } from 'vitest';
import { commitShardDeltas } from '../../lib/commit-shard-deltas.mjs';

const tasksLib  = { id: 'tasks',  primary: true,  indexPath: '/repo/.tasks/INDEX.json' };
const issuesLib = { id: 'issues', primary: false, indexPath: '/repo/.issues/INDEX.json' };
const libraries = [tasksLib, issuesLib];

// Build a `run` mock that records calls and dispatches by verb (argv[0]).
// Returns { run, calls, callsFor }.
function mkRun(handler) {
  const calls = [];
  const run = (file, argv, opts) => {
    calls.push({ file, argv, opts });
    return handler(file, argv, opts);
  };
  const callsFor = (verb) => calls.filter((c) => c.argv && c.argv[0] === verb);
  return { run, calls, callsFor };
}

describe('commitShardDeltas (lib)', () => {
  it('happy path: two libraries staged, diff has changes, commit succeeds', () => {
    const { run, calls, callsFor } = mkRun((file, argv) => {
      const verb = argv[0];
      if (verb === 'add')        return { status: 0, stdout: '', stderr: '' };
      if (verb === 'diff' && argv.includes('--quiet'))   return { status: 1, stdout: '', stderr: '' };
      if (verb === 'diff' && argv.includes('--numstat')) return { status: 0, stdout: '2\t0\t.tasks/INDEX.json\n1\t1\t.tasks/tasks/TASK-014.json\n3\t0\t.issues/INDEX.json\n', stderr: '' };
      if (verb === 'commit')     return { status: 0, stdout: '', stderr: '' };
      if (verb === 'rev-parse')  return { status: 0, stdout: 'abc123def456\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = commitShardDeltas({
      taskId: 'TASK-014',
      mergeSha: 'deadbeefcafe1234567',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [{ libraryId: 'issues', closedIds: ['ISSUE-1'] }] },
      libraries, cwd: '/repo', log: () => {},
      run,
    });

    expect(result.committed).toBe(true);
    expect(result.sha).toBe('abc123def456');
    expect(result.reason).toBe('commit-ok');
    expect(result.files).toBe(3);
    expect(result.libraries).toEqual(['tasks', 'issues']);

    const adds = callsFor('add');
    expect(adds).toHaveLength(2);
    // Path comparison is platform-tolerant: both candidates use POSIX-style
    // separators in test fixtures, but path.dirname on Windows may emit '\'.
    // Normalize before comparing.
    const norm = (s) => s.replace(/\\/g, '/');
    expect(norm(adds[0].argv[2])).toBe('/repo/.tasks');
    expect(norm(adds[1].argv[2])).toBe('/repo/.issues');

    const commitCalls = callsFor('commit');
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0].argv[0]).toBe('commit');
    expect(commitCalls[0].argv[1]).toBe('-m');
    expect(commitCalls[0].argv[2]).toBe('chore(orchestrator): close TASK-014 + linked shards [deadbeefcafe]');

    // belt-and-suspenders: total subprocess invocations match the pipeline:
    // 2 adds + 1 diff --quiet + 1 diff --numstat + 1 commit + 1 rev-parse = 6
    expect(calls).toHaveLength(6);
  });

  it('no-op path: diff returns status 0 → suppress commit', () => {
    const { run, callsFor } = mkRun((file, argv) => {
      if (argv[0] === 'add')  return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: () => {},
      run,
    });

    expect(result.committed).toBe(false);
    expect(result.sha).toBeNull();
    expect(result.reason).toBe('commit-no-changes');
    expect(result.files).toBe(0);
    expect(result.libraries).toEqual(['tasks']);
    expect(callsFor('commit')).toHaveLength(0);
    expect(callsFor('rev-parse')).toHaveLength(0);
  });

  it('git add failure: early abort, no diff/commit invoked', () => {
    const { run, callsFor } = mkRun((file, argv) => {
      if (argv[0] === 'add') return { status: 128, stdout: '', stderr: 'fatal' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });
    const logged = [];

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [{ libraryId: 'issues' }] },
      libraries, cwd: '/repo', log: (m) => logged.push(m),
      run,
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-add-failed:128');
    expect(callsFor('add')).toHaveLength(1);
    expect(callsFor('diff')).toHaveLength(0);
    expect(callsFor('commit')).toHaveLength(0);
    expect(logged.join('')).toMatch(/add failed for 'tasks'/);
  });

  it('git diff broken (status 128) → reasonCommitDiffFailed', () => {
    const { run, callsFor } = mkRun((file, argv) => {
      if (argv[0] === 'add')  return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'diff') return { status: 128, stdout: '', stderr: 'broken' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: () => {},
      run,
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-diff-failed:128');
    expect(callsFor('commit')).toHaveLength(0);
  });

  it('git commit failure (status 1) → reasonCommitFailed; no rev-parse', () => {
    const { run, callsFor } = mkRun((file, argv) => {
      if (argv[0] === 'add')      return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'diff' && argv.includes('--quiet'))   return { status: 1, stdout: '', stderr: '' };
      if (argv[0] === 'diff' && argv.includes('--numstat')) return { status: 0, stdout: '1\t0\tfile\n', stderr: '' };
      if (argv[0] === 'commit')   return { status: 1, stdout: '', stderr: 'hook rejected' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: () => {},
      run,
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-failed:1');
    expect(result.files).toBe(1);
    expect(callsFor('rev-parse')).toHaveLength(0);
  });

  it('empty libIds: no shardClose.libraryId AND empty linkedShardClose → shortcut no-op', () => {
    const { run, calls } = mkRun(() => {
      throw new Error('run must not be invoked when libIds set is empty');
    });

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: false, reason: 'no-primary' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: () => {},
      run,
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-no-changes');
    expect(result.libraries).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('unknown libraryId in linkedShardClose → logged + skipped, valid libraries proceed', () => {
    const { run, callsFor } = mkRun((file, argv) => {
      if (argv[0] === 'add')      return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'diff' && argv.includes('--quiet'))   return { status: 1, stdout: '', stderr: '' };
      if (argv[0] === 'diff' && argv.includes('--numstat')) return { status: 0, stdout: '1\t0\tx\n', stderr: '' };
      if (argv[0] === 'commit')   return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'rev-parse')return { status: 0, stdout: 'aaaabbbbcccc\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const logged = [];

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [{ libraryId: 'ghost-lib' }, { libraryId: 'issues' }] },
      libraries, cwd: '/repo', log: (m) => logged.push(m),
      run,
    });

    expect(result.committed).toBe(true);
    expect(result.libraries).toEqual(['tasks', 'issues']);
    expect(callsFor('add')).toHaveLength(2);
    expect(logged.join('')).toMatch(/skip unknown library 'ghost-lib'/);
  });

  it('atomic-write: rev-parse fails post-commit → committed:true, sha:null, reason commit-ok', () => {
    const { run, callsFor } = mkRun((file, argv) => {
      if (argv[0] === 'add')      return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'diff' && argv.includes('--quiet'))   return { status: 1, stdout: '', stderr: '' };
      if (argv[0] === 'diff' && argv.includes('--numstat')) return { status: 0, stdout: '1\t0\tx\n', stderr: '' };
      if (argv[0] === 'commit')   return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'rev-parse')return { status: 128, stdout: '', stderr: 'rev-parse died' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });
    const logged = [];

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: (m) => logged.push(m),
      run,
    });

    // Commit IS on disk; rev-parse failure is informational only.
    expect(result.committed).toBe(true);
    expect(result.reason).toBe('commit-ok');
    expect(result.sha).toBeNull();
    expect(result.files).toBe(1);
    expect(callsFor('rev-parse')).toHaveLength(1);
    expect(logged.join('')).toMatch(/rev-parse post-commit failed/);
  });
});
