// tests/unit/merge-task-linked-close.test.mjs
// Smoke tests for closeLinkedShardsOnMerge — mocks shard-library.mjs.
// Asserts:
//   1. Happy path: rebuildLibrary called ONCE per affected library (AC #5).
//   2. Unknown linked ID (locateShard → null) → skipped, no rebuild.
//   3. Idempotency (current.status === vocab.done) → skipped, no rebuild.
//   4. updateShard throws → failures, no rebuild for that library.
//   5. Empty scanLinks result → no calls, zero aggregate.
//   6. Unknown library in scanLinks result → skipped, no rebuild.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs.readFileSync so the per-shard idempotency check returns the
// status we want for each test. We only mock the read of the linked-shard
// content; the primary-shard re-load is mocked via locateShard returning
// the marker path '__primary__' which our readFileSync hook recognizes.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    default: {
      ...actual.default,
      readFileSync: vi.fn(),
    },
    readFileSync: vi.fn(),
  };
});

vi.mock('../../lib/shard-library.mjs', () => ({
  scanLinks: vi.fn(),
  locateShard: vi.fn(),
  updateShard: vi.fn(),
  rebuildLibrary: vi.fn(),
  resolveStatusVocab: vi.fn(),
  loadLibraries: vi.fn(),
}));

const fs = await import('node:fs');
const shardLib = await import('../../lib/shard-library.mjs');
const { closeLinkedShardsOnMerge } = await import('../../scripts/merge-task.mjs');

const PRIMARY_SHARD = { id: 'TASK-013', resolves: ['ISSUE-1', 'ISSUE-2'], description: '' };
const PRIMARY_PATH = '/fake/primary/TASK-013.json';

const issuesLib = { id: 'issues', primary: false };
const epicsLib = { id: 'epics', primary: false };
const primaryLib = { id: 'tasks', primary: true };
const libraries = [primaryLib, issuesLib, epicsLib];

beforeEach(() => {
  vi.clearAllMocks();
  // Default: primary re-load returns PRIMARY_SHARD
  shardLib.locateShard.mockImplementation((lib, id) => {
    if (lib === primaryLib && id === 'TASK-013') return PRIMARY_PATH;
    return `/fake/${lib.id}/${id}.json`;
  });
  fs.default.readFileSync.mockImplementation((p) => {
    if (p === PRIMARY_PATH) return JSON.stringify(PRIMARY_SHARD);
    // Default linked-shard payload: status=open (not done → will be closed)
    return JSON.stringify({ id: 'X', status: 'open', updated: '2026-05-01T00:00:00.000Z' });
  });
  shardLib.resolveStatusVocab.mockReturnValue({ start: 'in-progress', done: 'done' });
  shardLib.rebuildLibrary.mockReturnValue({ ok: true, reason: null });
  shardLib.updateShard.mockImplementation((lib, id, mut) => mut({ id, status: 'open', updated: '2026-05-01T00:00:00.000Z' }));
});

describe('closeLinkedShardsOnMerge', () => {
  it('happy path: 2 libraries × 2 shards → 4 updateShard, ONE rebuild per library (AC #5)', () => {
    shardLib.scanLinks.mockReturnValue(new Map([
      ['issues', new Set(['ISSUE-1', 'ISSUE-2'])],
      ['epics',  new Set(['EPIC-1',  'EPIC-2'])],
    ]));

    const result = closeLinkedShardsOnMerge({
      libraries, primary: primaryLib, taskId: 'TASK-013',
      mergeSha: 'deadbeefcafe1234567', log: () => {},
    });

    expect(shardLib.updateShard).toHaveBeenCalledTimes(4);
    expect(shardLib.rebuildLibrary).toHaveBeenCalledTimes(2);     // AC #5: once per library
    expect(shardLib.rebuildLibrary).toHaveBeenCalledWith(issuesLib);
    expect(shardLib.rebuildLibrary).toHaveBeenCalledWith(epicsLib);
    expect(result.closed).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.failures).toBe(0);
    expect(result.perLibrary).toHaveLength(2);
  });

  it('unknown library in scanLinks result → recorded as failure, NOT rebuilt', () => {
    shardLib.scanLinks.mockReturnValue(new Map([
      ['ghost-lib', new Set(['GHOST-1'])],
    ]));

    const result = closeLinkedShardsOnMerge({
      libraries, primary: primaryLib, taskId: 'TASK-013',
      mergeSha: 'abc123', log: () => {},
    });

    expect(shardLib.updateShard).not.toHaveBeenCalled();
    expect(shardLib.rebuildLibrary).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(result.perLibrary[0].failures[0]).toEqual({ id: '*', reason: 'unknown-library' });
    expect(result.perLibrary[0].rebuilt).toBeNull();
  });

  it('locateShard returns null (shard-not-found, AC #4) → skipped, no rebuild', () => {
    shardLib.scanLinks.mockReturnValue(new Map([
      ['issues', new Set(['ISSUE-9999'])],
    ]));
    shardLib.locateShard.mockImplementation((lib, id) => {
      if (lib === primaryLib && id === 'TASK-013') return PRIMARY_PATH;
      return null;                                       // missing in INDEX
    });

    const result = closeLinkedShardsOnMerge({
      libraries, primary: primaryLib, taskId: 'TASK-013',
      mergeSha: 'abc', log: () => {},
    });

    expect(shardLib.updateShard).not.toHaveBeenCalled();
    expect(shardLib.rebuildLibrary).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.perLibrary[0].skippedIds).toEqual([{ id: 'ISSUE-9999', reason: 'shard-not-found' }]);
    expect(result.perLibrary[0].rebuilt).toEqual({ ok: true, reason: 'skipped-no-changes' });
  });

  it('updateShard throws → failures++, no rebuild for that library if no successes', () => {
    shardLib.scanLinks.mockReturnValue(new Map([
      ['issues', new Set(['ISSUE-1'])],
    ]));
    const err = Object.assign(new Error('disk full'), { code: 'io-error:write', name: 'ShardLibraryError' });
    shardLib.updateShard.mockImplementation(() => { throw err; });

    const result = closeLinkedShardsOnMerge({
      libraries, primary: primaryLib, taskId: 'TASK-013',
      mergeSha: 'abc', log: () => {},
    });

    expect(shardLib.updateShard).toHaveBeenCalledTimes(1);
    expect(shardLib.rebuildLibrary).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(result.perLibrary[0].failures[0]).toEqual({ id: 'ISSUE-1', reason: 'update-failed:io-error:write' });
  });

  it('idempotency: shard already at vocab.done → skipped, NOT rebuilt (gated by closedIds.length > 0)', () => {
    shardLib.scanLinks.mockReturnValue(new Map([
      ['issues', new Set(['ISSUE-1'])],
    ]));
    fs.default.readFileSync.mockImplementation((p) => {
      if (p === PRIMARY_PATH) return JSON.stringify(PRIMARY_SHARD);
      return JSON.stringify({ id: 'ISSUE-1', status: 'done', updated: '2026-05-01T00:00:00.000Z' });
    });

    const result = closeLinkedShardsOnMerge({
      libraries, primary: primaryLib, taskId: 'TASK-013',
      mergeSha: 'abc', log: () => {},
    });

    expect(shardLib.updateShard).not.toHaveBeenCalled();
    expect(shardLib.rebuildLibrary).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.perLibrary[0].skippedIds[0]).toEqual({ id: 'ISSUE-1', reason: 'already-done' });
  });

  it('empty scanLinks result → no calls, zero aggregate', () => {
    shardLib.scanLinks.mockReturnValue(new Map());

    const result = closeLinkedShardsOnMerge({
      libraries, primary: primaryLib, taskId: 'TASK-013',
      mergeSha: 'abc', log: () => {},
    });

    expect(shardLib.updateShard).not.toHaveBeenCalled();
    expect(shardLib.rebuildLibrary).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: 0, skipped: 0, failures: 0, perLibrary: [] });
  });
});
