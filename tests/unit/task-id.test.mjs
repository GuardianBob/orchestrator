// tests/unit/task-id.test.mjs
// Unit tests for normalizeTaskId — must match scripts/branch-setup.mjs:306
// deriveTaskId byte-for-byte. Any divergence is a bug.

import { describe, it, expect } from 'vitest';
import { normalizeTaskId } from '../../scripts/lib/task-id.mjs';

describe('normalizeTaskId', () => {
  it('zero-pads pure digit string to TASK-NNN', () => {
    expect(normalizeTaskId('13')).toBe('TASK-013');
  });

  it('zero-pads single digit to TASK-001', () => {
    expect(normalizeTaskId('1')).toBe('TASK-001');
  });

  it('preserves TASK-N verbatim (does NOT re-pad)', () => {
    // Matches branch-setup.mjs:309 — short ID matches PREFIX-N regex and
    // returns verbatim. Documents intentional shape.
    expect(normalizeTaskId('TASK-13')).toBe('TASK-13');
  });

  it('is idempotent for canonical TASK-NNN', () => {
    expect(normalizeTaskId('TASK-013')).toBe('TASK-013');
  });

  it('preserves cross-library prefix (ISSUE-N)', () => {
    expect(normalizeTaskId('ISSUE-7')).toBe('ISSUE-7');
  });

  it('coerces numeric input via String()', () => {
    expect(normalizeTaskId(13)).toBe('TASK-013');
  });

  it('passes through lowercase as TASK-<input> (footgun documented)', () => {
    // Matches branch-setup.mjs:313 fall-through. validateShardId downstream
    // will reject this — pure normalization layer does not validate.
    expect(normalizeTaskId('task-013')).toBe('TASK-task-013');
  });
});
