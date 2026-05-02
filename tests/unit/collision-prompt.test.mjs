// tests/unit/collision-prompt.test.mjs
//
// Pure unit tests for lib/collision-prompt.mjs parameterization (TASK-011).
// Covers blueprint cases #15-#18:
//   #15 — parseChoice parameterized
//   #16 — buildPromptText parameterized + byte-for-byte regression guard
//   #17 — DEFAULT_COLLISION_OPTIONS export shape
//   #18 — promptCollisionChoice defaults backward-compat
//
// All tests are pure (no I/O, no spawn). LD-PAT-001: lib stays pure;
// LD-PAT-007: validation invariants enforced via direct assertions.

import { describe, it, expect } from 'vitest';
import {
  parseChoice,
  buildPromptText,
  promptCollisionChoice,
  buildRestartedShard,
  DEFAULT_COLLISION_HEADLINE,
  DEFAULT_COLLISION_OPTIONS,
} from '../../lib/collision-prompt.mjs';

// ---------------------------------------------------------------------------
// #17 — DEFAULT_COLLISION_OPTIONS export shape
// ---------------------------------------------------------------------------

describe('DEFAULT_COLLISION_OPTIONS export', () => {
  it('is a frozen array of 3 entries with keys r/R/a', () => {
    expect(Array.isArray(DEFAULT_COLLISION_OPTIONS)).toBe(true);
    expect(DEFAULT_COLLISION_OPTIONS).toHaveLength(3);
    expect(DEFAULT_COLLISION_OPTIONS.map((o) => o.key)).toEqual(['r', 'R', 'a']);
    expect(Object.isFrozen(DEFAULT_COLLISION_OPTIONS)).toBe(true);
  });

  it('has exactly one default:true entry, which is "abandon"', () => {
    const defaults = DEFAULT_COLLISION_OPTIONS.filter((o) => o.default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].key).toBe('a');
    expect(defaults[0].label).toBe('abandon');
  });

  it('exports DEFAULT_COLLISION_HEADLINE as a non-empty string', () => {
    expect(typeof DEFAULT_COLLISION_HEADLINE).toBe('string');
    expect(DEFAULT_COLLISION_HEADLINE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #15 — parseChoice parameterized
// ---------------------------------------------------------------------------

describe('parseChoice (parameterized)', () => {
  it('default options: "r" → "resume", "R" → "restart"', () => {
    expect(parseChoice('r')).toBe('resume');
    expect(parseChoice('R')).toBe('restart');
  });

  it('default options: "" / null / undefined → default ("abandon")', () => {
    expect(parseChoice('')).toBe('abandon');
    expect(parseChoice(null)).toBe('abandon');
    expect(parseChoice(undefined)).toBe('abandon');
  });

  it('default options: case-insensitive only when no sibling — "A" → "abandon"', () => {
    // 'a' has no uppercase sibling so 'A' falls through to case-insensitive match.
    expect(parseChoice('A')).toBe('abandon');
  });

  it('default options: garbage input returns null', () => {
    expect(parseChoice('q')).toBeNull();
    expect(parseChoice('xyz')).toBeNull();
  });

  it('custom options: {y:yes, n:no(default)} returns labels by key', () => {
    const opts = [
      { key: 'y', label: 'yes' },
      { key: 'n', label: 'no', default: true },
    ];
    expect(parseChoice('y', opts)).toBe('yes');
    expect(parseChoice('n', opts)).toBe('no');
    expect(parseChoice('', opts)).toBe('no'); // empty → default
    expect(parseChoice(null, opts)).toBe('no'); // EOF → default
    expect(parseChoice('q', opts)).toBeNull(); // unknown
    // Case-insensitive match: only one option uses 'y' / 'n'.
    expect(parseChoice('Y', opts)).toBe('yes');
    expect(parseChoice('N', opts)).toBe('no');
  });

  it('case-sensitive when both r and R distinct: "r" ≠ "R"', () => {
    // With default options, r and R are siblings → exact match wins.
    expect(parseChoice('r')).toBe('resume');
    expect(parseChoice('R')).toBe('restart');
  });

  it('throws TypeError on invalid options array (LD-PAT-007)', () => {
    expect(() => parseChoice('r', [])).toThrow(TypeError);
    expect(() => parseChoice('r', null)).toThrow(TypeError);
    expect(() => parseChoice('r', [{ key: 'x', label: 'X' }])).toThrow(/default:true/);
    expect(() => parseChoice('r', [
      { key: 'a', label: 'A', default: true },
      { key: 'a', label: 'B' },
    ])).toThrow(/duplicate/);
    expect(() => parseChoice('r', [{ key: '', label: 'X', default: true }])).toThrow(/key/);
    expect(() => parseChoice('r', [{ key: 'x', label: '', default: true }])).toThrow(/label/);
  });
});

// ---------------------------------------------------------------------------
// #16 — buildPromptText parameterized + regression guard
// ---------------------------------------------------------------------------

describe('buildPromptText (parameterized)', () => {
  it('default headline + options reproduces TASK-010 layout byte-for-byte', () => {
    // Frozen literal — regression guard. If you intentionally change the
    // prompt layout, update this string AND audit downstream parsers.
    const expected =
      '[branch-setup] TASK-009 already in-progress.\n' +
      '  [r] resume  — keep started timestamp, proceed\n' +
      '  [R] restart — reset started to now, append notes entry\n' +
      '  [a] abandon — exit without creating branch (default)\n' +
      'Choice [r/R/a] (default: a): ';
    expect(buildPromptText({ taskId: 'TASK-009' })).toBe(expected);
  });

  it('emits "(started <iso>)" suffix when currentStarted is set', () => {
    const out = buildPromptText({
      taskId: 'TASK-009',
      currentStarted: '2026-01-01T00:00:00.000Z',
    });
    expect(out).toContain('TASK-009 already in-progress (started 2026-01-01T00:00:00.000Z).');
  });

  it('substitutes a custom headline', () => {
    const out = buildPromptText({ taskId: 'TASK-X', headline: 'already merged' });
    expect(out.startsWith('[branch-setup] TASK-X already merged.\n')).toBe(true);
  });

  it('lists every option key in the choice line', () => {
    const opts = [
      { key: 'y', label: 'yes' },
      { key: 'n', label: 'no', default: true },
    ];
    const out = buildPromptText({ taskId: 'TASK-X', options: opts });
    expect(out).toContain('Choice [y/n] (default: n):');
    expect(out).toContain('[y] yes');
    expect(out).toContain('[n] no');
  });

  it('marks the default option in the choice line', () => {
    const out = buildPromptText({ taskId: 'TASK-X' });
    expect(out).toMatch(/\(default: a\): $/);
  });
});

// ---------------------------------------------------------------------------
// #18 — promptCollisionChoice defaults backward-compat
// ---------------------------------------------------------------------------

describe('promptCollisionChoice (defaults backward-compat)', () => {
  it('with injected askFn returning "r" → resolves "resume"', async () => {
    const askFn = async () => 'r';
    const choice = await promptCollisionChoice({
      taskId: 'TASK-001',
      isInteractive: true,
      askFn,
    });
    expect(choice).toBe('resume');
  });

  it('with injected askFn returning "" → resolves to default ("abandon")', async () => {
    const askFn = async () => '';
    const choice = await promptCollisionChoice({
      taskId: 'TASK-001',
      isInteractive: true,
      askFn,
    });
    expect(choice).toBe('abandon');
  });

  it('non-interactive → returns default label without calling askFn', async () => {
    let called = false;
    const askFn = async () => { called = true; return 'r'; };
    const choice = await promptCollisionChoice({
      taskId: 'TASK-001',
      isInteractive: false,
      askFn,
    });
    expect(choice).toBe('abandon');
    expect(called).toBe(false);
  });

  it('invalid then valid input → resumes after second prompt', async () => {
    const answers = ['q', 'R'];
    const askFn = async () => answers.shift();
    const writes = [];
    const output = { write: (s) => writes.push(s) };
    const choice = await promptCollisionChoice({
      taskId: 'TASK-001',
      isInteractive: true,
      askFn,
      output,
    });
    expect(choice).toBe('restart');
    expect(writes.join('')).toMatch(/unrecognized choice/);
  });

  it('custom options: {y,n(default)} respected end-to-end', async () => {
    const opts = [
      { key: 'y', label: 'yes' },
      { key: 'n', label: 'no', default: true },
    ];
    const askFn = async () => 'y';
    const choice = await promptCollisionChoice({
      taskId: 'X',
      isInteractive: true,
      headline: 'merge?',
      options: opts,
      askFn,
    });
    expect(choice).toBe('yes');
  });
});

// ---------------------------------------------------------------------------
// buildRestartedShard — quick sanity (unchanged from TASK-010 but re-exported)
// ---------------------------------------------------------------------------

describe('buildRestartedShard', () => {
  it('overwrites started + updated, appends notes entry', () => {
    const cur = { id: 'TASK-X', started: '2024-01-01T00:00:00.000Z', notes: 'prior' };
    const nowIso = '2026-05-01T12:00:00.000Z';
    const next = buildRestartedShard(cur, nowIso);
    expect(next.started).toBe(nowIso);
    expect(next.updated).toBe(nowIso);
    expect(next.notes).toBe('prior\nRestarted by orchestrator on 2026-05-01T12:00:00.000Z');
  });

  it('creates notes field if absent', () => {
    const next = buildRestartedShard({ id: 'X' }, '2026-05-01T00:00:00.000Z');
    expect(next.notes).toBe('Restarted by orchestrator on 2026-05-01T00:00:00.000Z');
  });
});
