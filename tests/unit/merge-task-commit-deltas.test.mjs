// tests/unit/merge-task-commit-deltas.test.mjs
// Smoke tests for commitShardDeltas (TASK-014).
// Asserts:
//   1. Happy path: 2 libraries → stage both, diff=1 (changes), commit succeeds.
//   2. No-op path: stage succeeds, diff=0 → no commit invoked, REASON_COMMIT_NO_CHANGES.
//   3. git add failure → early abort, no diff/commit invoked.
//   4. git diff returns 128 (broken) → reasonCommitDiffFailed.
//   5. git commit fails (status 1) → reasonCommitFailed; no rev-parse called.
//   6. Empty libIds (both shardClose.libraryId missing AND linkedShardClose empty) → shortcut no-op.
//   7. Unknown libraryId in linkedShardClose.perLibrary[] → logged + skipped, others proceed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, spawnSync: vi.fn(), execSync: actual.execSync };
});

const cp = await import('node:child_process');
const { commitShardDeltas } = await import('../../scripts/merge-task.mjs');

const tasksLib  = { id: 'tasks',  primary: true,  indexPath: '/repo/.tasks/INDEX.json' };
const issuesLib = { id: 'issues', primary: false, indexPath: '/repo/.issues/INDEX.json' };
const libraries = [tasksLib, issuesLib];

const ARGV = (calls) => calls.map(c => c[1]);
const callsFor = (verb) => cp.spawnSync.mock.calls.filter(c => c[1] && c[1][0] === verb);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('commitShardDeltas', () => {
  it('happy path: two libraries staged, diff has changes, commit succeeds', () => {
    cp.spawnSync.mockImplementation((file, argv) => {
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
    });

    expect(result.committed).toBe(true);
    expect(result.sha).toBe('abc123def456');
    expect(result.reason).toBe('commit-ok');
    expect(result.files).toBe(3);
    expect(result.libraries).toEqual(['tasks', 'issues']);

    const adds = callsFor('add');
    expect(adds).toHaveLength(2);
    expect(adds[0][1]).toEqual(['add', '--', '/repo/.tasks']);
    expect(adds[1][1]).toEqual(['add', '--', '/repo/.issues']);

    const commitCalls = callsFor('commit');
    expect(commitCalls).toHaveLength(1);
    const commitArgv = commitCalls[0][1];
    expect(commitArgv[0]).toBe('commit');
    expect(commitArgv[1]).toBe('-m');
    expect(commitArgv[2]).toBe('chore(orchestrator): close TASK-014 + linked shards [deadbeefcafe]');
  });

  it('no-op path: diff returns status 0 → suppress commit', () => {
    cp.spawnSync.mockImplementation((file, argv) => {
      if (argv[0] === 'add')  return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: () => {},
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
    cp.spawnSync.mockImplementation((file, argv) => {
      if (argv[0] === 'add') return { status: 128, stdout: '', stderr: 'fatal' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });
    const logged = [];

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [{ libraryId: 'issues' }] },
      libraries, cwd: '/repo', log: (m) => logged.push(m),
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-add-failed:128');
    expect(callsFor('add')).toHaveLength(1);                // aborted after first failure
    expect(callsFor('diff')).toHaveLength(0);
    expect(callsFor('commit')).toHaveLength(0);
    expect(logged.join('')).toMatch(/add failed for 'tasks'/);
  });

  it('git diff broken (status 128) → reasonCommitDiffFailed', () => {
    cp.spawnSync.mockImplementation((file, argv) => {
      if (argv[0] === 'add')  return { status: 0, stdout: '', stderr: '' };
      if (argv[0] === 'diff') return { status: 128, stdout: '', stderr: 'broken' };
      throw new Error(`unexpected call: ${argv.join(' ')}`);
    });

    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: true, libraryId: 'tasks' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: () => {},
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-diff-failed:128');
    expect(callsFor('commit')).toHaveLength(0);
  });

  it('git commit failure (status 1) → reasonCommitFailed; no rev-parse', () => {
    cp.spawnSync.mockImplementation((file, argv) => {
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
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-failed:1');
    expect(result.files).toBe(1);
    expect(callsFor('rev-parse')).toHaveLength(0);
  });

  it('empty libIds: no shardClose.libraryId AND empty linkedShardClose → shortcut no-op', () => {
    const result = commitShardDeltas({
      taskId: 'TASK-014', mergeSha: 'abcdef123456',
      shardClose: { closed: false, reason: 'no-primary' },
      linkedShardClose: { perLibrary: [] },
      libraries, cwd: '/repo', log: () => {},
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('commit-no-changes');
    expect(result.libraries).toEqual([]);
    expect(cp.spawnSync).not.toHaveBeenCalled();
  });

  it('unknown libraryId in linkedShardClose → logged + skipped, valid libraries proceed', () => {
    cp.spawnSync.mockImplementation((file, argv) => {
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
    });

    expect(result.committed).toBe(true);
    expect(result.libraries).toEqual(['tasks', 'issues']);   // ghost-lib skipped
    expect(callsFor('add')).toHaveLength(2);
    expect(logged.join('')).toMatch(/skip unknown library 'ghost-lib'/);
  });
});
