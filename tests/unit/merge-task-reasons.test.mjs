// tests/unit/merge-task-reasons.test.mjs
// Unit tests for lib/merge-task-reasons.mjs.
// Asserts:
//   - All 9 static constants are unique kebab-case wire strings.
//   - All 9 builders are functions returning <prefix>:<arg> shape.
//   - REASON_CONSTANTS and REASON_BUILDERS aggregates contain exactly 9 entries each.

import { describe, it, expect } from 'vitest';
import * as registry from '../../lib/merge-task-reasons.mjs';

const {
  REASON_NO_PRIMARY,
  REASON_SHARD_NOT_FOUND,
  REASON_IO_ERROR_READ,
  REASON_ALREADY_DONE,
  REASON_CLOSED,
  REASON_UNKNOWN_LIBRARY,
  REASON_NOT_ATTEMPTED,
  REASON_SKIPPED_NO_CHANGES,
  REASON_PRIMARY_SHARD_MISSING,
  REASON_COMMIT_OK,
  REASON_COMMIT_NO_CHANGES,
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
  reasonCommitAddFailed,
  reasonCommitDiffFailed,
  reasonCommitFailed,
  REASON_CONSTANTS,
  REASON_BUILDERS,
} = registry;

// kebab segments separated by colons; each segment lowercase-letter-led.
const WIRE_SHAPE = /^[a-z][a-z-]*(:[a-z0-9-]+)*$/;

describe('merge-task-reasons registry', () => {
  describe('static constants', () => {
    const constants = [
      REASON_NO_PRIMARY,
      REASON_SHARD_NOT_FOUND,
      REASON_IO_ERROR_READ,
      REASON_ALREADY_DONE,
      REASON_CLOSED,
      REASON_UNKNOWN_LIBRARY,
      REASON_NOT_ATTEMPTED,
      REASON_SKIPPED_NO_CHANGES,
      REASON_PRIMARY_SHARD_MISSING,
      REASON_COMMIT_OK,
      REASON_COMMIT_NO_CHANGES,
      REASON_COMMIT_NOT_ATTEMPTED,
    ];

    it('exposes 12 static constants', () => {
      expect(constants.length).toBe(12);
    });

    it('all values are non-empty strings matching wire shape', () => {
      for (const v of constants) {
        expect(typeof v).toBe('string');
        expect(v.length).toBeGreaterThan(0);
        expect(v).toMatch(WIRE_SHAPE);
      }
    });

    it('all constant values are unique', () => {
      expect(new Set(constants).size).toBe(constants.length);
    });
  });

  describe('builders', () => {
    const builderEntries = [
      ['reasonVocabError',      reasonVocabError,      'vocab-error'],
      ['reasonLocateError',     reasonLocateError,     'locate-error'],
      ['reasonUpdateFailed',    reasonUpdateFailed,    'update-failed'],
      ['reasonIoError',         reasonIoError,         'io-error'],
      ['reasonReloadError',     reasonReloadError,     'reload-error'],
      ['reasonScanlinksFailed', reasonScanlinksFailed, 'scanlinks-failed'],
      ['reasonRebuildFailed',   reasonRebuildFailed,   'rebuild-failed'],
      ['reasonConfigError',     reasonConfigError,     'config-error'],
      ['reasonUncaught',        reasonUncaught,        'uncaught'],
      ['reasonCommitAddFailed', reasonCommitAddFailed, 'commit-add-failed'],
      ['reasonCommitDiffFailed',reasonCommitDiffFailed,'commit-diff-failed'],
      ['reasonCommitFailed',    reasonCommitFailed,    'commit-failed'],
    ];

    it('exposes 12 builders', () => {
      expect(builderEntries.length).toBe(12);
    });

    it('every builder is a function', () => {
      for (const [, fn] of builderEntries) expect(typeof fn).toBe('function');
    });

    it('every builder returns "<prefix>:<arg>" shape matching wire regex', () => {
      for (const [name, fn, prefix] of builderEntries) {
        const out = fn('sample-code');
        expect(out, `${name} sample`).toMatch(WIRE_SHAPE);
        expect(out, `${name} prefix`).toBe(`${prefix}:sample-code`);
      }
    });

    it('builder prefixes are unique', () => {
      const prefixes = builderEntries.map(([, , p]) => p);
      expect(new Set(prefixes).size).toBe(prefixes.length);
    });
  });

  describe('frozen aggregates', () => {
    it('REASON_CONSTANTS contains exactly 12 entries', () => {
      expect(Object.keys(REASON_CONSTANTS).length).toBe(12);
    });

    it('REASON_BUILDERS contains exactly 12 entries', () => {
      expect(Object.keys(REASON_BUILDERS).length).toBe(12);
    });

    it('REASON_CONSTANTS is frozen', () => {
      expect(Object.isFrozen(REASON_CONSTANTS)).toBe(true);
    });

    it('REASON_BUILDERS is frozen', () => {
      expect(Object.isFrozen(REASON_BUILDERS)).toBe(true);
    });

    it('total identifier count >= 24 (covers commit-deltas additions)', () => {
      expect(Object.keys(REASON_CONSTANTS).length + Object.keys(REASON_BUILDERS).length).toBeGreaterThanOrEqual(24);
    });
  });
});
