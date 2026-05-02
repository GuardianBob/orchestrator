// tests/unit/sanitize-error.test.mjs
// Unit tests for lib/sanitize-error.mjs (TASK-033 / SEC-W-012-1).
// 8 test blocks, 12 sub-cases — exceeds AC's 6+ requirement.

import { describe, it, expect, afterEach } from 'vitest';
import {
  sanitizeErrorMessage,
  MAX_LEN,
  MAX_LEN_DEBUG,
  UNKNOWN,
  REDACTED_PATH,
} from '../../lib/sanitize-error.mjs';

const ESC = '\x1b';

afterEach(() => { delete process.env.DEBUG_MERGE_TASK; });

describe('sanitizeErrorMessage', () => {
  it('a. plain message passes through unchanged', () => {
    expect(sanitizeErrorMessage(new Error('hello world'))).toBe('hello world');
  });

  describe('b. path redaction (cross-platform)', () => {
    it('b1. Win32 drive path is redacted', () => {
      const out = sanitizeErrorMessage(new Error('ENOENT: C:\\Users\\foo\\.tasks\\bar.json'));
      expect(out).toContain(REDACTED_PATH);
      expect(out).not.toContain('C:\\');
      expect(out).not.toContain('Users');
    });

    it('b2. Win32 UNC path is redacted', () => {
      const out = sanitizeErrorMessage(new Error('open \\\\server\\share\\x failed'));
      expect(out).toContain(REDACTED_PATH);
      expect(out).not.toContain('\\\\server');
      expect(out).not.toContain('share');
    });

    it('b3. POSIX absolute path is redacted', () => {
      const out = sanitizeErrorMessage(new Error('ENOENT /home/user/.tasks/x.json'));
      expect(out).toContain(REDACTED_PATH);
      expect(out).not.toContain('/home/user');
    });

    it('b3-neg. POSIX regex does not eat fractions / URLs', () => {
      // "1/2" must NOT match (no leading absolute slash + lookbehind blocks digits).
      expect(sanitizeErrorMessage('ratio 1/2 failed')).toBe('ratio 1/2 failed');
    });

    it('b4. file:// URL is redacted', () => {
      const out = sanitizeErrorMessage(new Error('failed to load file:///c:/foo/bar.json'));
      expect(out).toContain(REDACTED_PATH);
      expect(out).not.toContain('file://');
    });
  });

  it('c. ANSI escape sequences are stripped', () => {
    const out = sanitizeErrorMessage(new Error(`${ESC}[31mred${ESC}[0m text`));
    expect(out).toBe('red text');
    expect(out).not.toContain(ESC);
  });

  it('d. multi-line input collapses to one line with marker', () => {
    const out = sanitizeErrorMessage(new Error('line1\nline2\r\nline3'));
    expect(out).toContain(' ⏎ ');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
  });

  it('e. length cap at MAX_LEN with ellipsis', () => {
    const out = sanitizeErrorMessage(new Error('x'.repeat(500)));
    expect(out).toHaveLength(MAX_LEN);
    expect(out.endsWith('…')).toBe(true);
  });

  describe('f. null-safety / non-Error inputs', () => {
    it('f1. null returns UNKNOWN', () => {
      expect(sanitizeErrorMessage(null)).toBe(UNKNOWN);
    });
    it('f2. undefined returns UNKNOWN', () => {
      expect(sanitizeErrorMessage(undefined)).toBe(UNKNOWN);
    });
    it('f3. non-Error object returns non-empty string without throwing', () => {
      const out = sanitizeErrorMessage({ code: 'X', toString() { return 'X-thing'; } });
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });
    it('f4. plain string input is sanitized in place', () => {
      expect(sanitizeErrorMessage('raw')).toBe('raw');
    });
  });

  it('g. DEBUG_MERGE_TASK=1 restores raw message (no path redaction)', () => {
    process.env.DEBUG_MERGE_TASK = '1';
    const raw = 'C:\\Users\\foo\\bar.json failed';
    const out = sanitizeErrorMessage(new Error(raw));
    expect(out).toBe(raw);
    expect(out).toContain('C:\\');
    // Still capped at MAX_LEN_DEBUG to prevent runaway log lines.
    const big = 'x'.repeat(MAX_LEN_DEBUG + 500);
    const outBig = sanitizeErrorMessage(new Error(big));
    expect(outBig.length).toBeLessThanOrEqual(MAX_LEN_DEBUG);
  });

  it('h. combined attack: path + ANSI + newlines all sanitized, ≤ MAX_LEN, single line', () => {
    const attack = `${ESC}[31mboom\nat C:\\Users\\victim\\secret.json\r\nstack: /home/x/y.js`;
    const out = sanitizeErrorMessage(new Error(attack));
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('C:\\');
    expect(out).not.toContain('/home/x');
    expect(out).toContain(REDACTED_PATH);
    expect(out.length).toBeLessThanOrEqual(MAX_LEN);
  });
});
