// tests/unit/merge-task-notes-shape.test.mjs
// TASK-038 — guard that buildClosedShard / buildLinkedClosedShard always
// emit notes as a string (per .tasks/schemas/task.schema.json), regardless
// of whether prior notes were missing, string-shaped, or legacy array-shaped.

import { describe, it, expect } from 'vitest';
import {
  buildClosedShard,
  buildLinkedClosedShard,
} from '../../scripts/merge-task.mjs';

const VOCAB = { done: 'done' };
const NOW = '2026-05-04T12:00:00.000Z';
const TASK_ID = 'TASK-101';
const NOTE = '[2026-05-04] Merged into sprint-3 at deadbeef1234';
const LINK_NOTE = '[2026-05-04] Resolved by TASK-101 @ deadbeef1234';

describe('TASK-038: notes is always a string', () => {
  describe('buildClosedShard', () => {
    it('no prior notes → string', () => {
      const out = buildClosedShard({ id: 'X' }, VOCAB, NOW, NOTE);
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(NOTE);
    });

    it('string prior → string with newline append', () => {
      const out = buildClosedShard({ id: 'X', notes: 'old' }, VOCAB, NOW, NOTE);
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(`old\n${NOTE}`);
    });

    it('legacy array prior → string joined with newline', () => {
      const out = buildClosedShard({ id: 'X', notes: ['a', 'b'] }, VOCAB, NOW, NOTE);
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(`a\nb\n${NOTE}`);
    });
  });

  describe('buildLinkedClosedShard', () => {
    it('no prior notes → string', () => {
      const out = buildLinkedClosedShard({ id: 'X' }, VOCAB, NOW, LINK_NOTE, TASK_ID);
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(LINK_NOTE);
    });

    it('string prior → string with newline append', () => {
      const out = buildLinkedClosedShard(
        { id: 'X', notes: 'old' }, VOCAB, NOW, LINK_NOTE, TASK_ID,
      );
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(`old\n${LINK_NOTE}`);
    });

    it('legacy array prior → string joined with newline', () => {
      const out = buildLinkedClosedShard(
        { id: 'X', notes: ['a', 'b'] }, VOCAB, NOW, LINK_NOTE, TASK_ID,
      );
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(`a\nb\n${LINK_NOTE}`);
    });

    it('dedupe: prior string already contains marker → no append, string preserved', () => {
      const prior = `something\n${LINK_NOTE}`;
      const out = buildLinkedClosedShard(
        { id: 'X', notes: prior }, VOCAB, NOW, LINK_NOTE, TASK_ID,
      );
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(prior);
    });

    it('dedupe: legacy array prior containing marker → joined string, no duplicate append', () => {
      const out = buildLinkedClosedShard(
        { id: 'X', notes: ['intro', LINK_NOTE] }, VOCAB, NOW, LINK_NOTE, TASK_ID,
      );
      expect(typeof out.notes).toBe('string');
      expect(out.notes).toBe(`intro\n${LINK_NOTE}`);
    });
  });
});
