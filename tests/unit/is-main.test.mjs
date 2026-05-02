// tests/unit/is-main.test.mjs
// Unit tests for lib/is-main.mjs — covers LD-PAT-005 acceptance:
//   1. Direct invocation (Windows-style path) → true
//   2. Imported (different argv1) → false
//   3. npm-link junction (realpathSync resolves to different path than argv[1]) → true
//   4. Missing argv[1] → false
//   5. realpathSync throws ENOENT → false (caught)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pathToFileURL } from 'node:url';

// Mock node:fs.realpathSync so we can control what argv[1] resolves to.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    default: actual.default,
    realpathSync: vi.fn(),
  };
});

const fs = await import('node:fs');
const { isMain } = await import('../../lib/is-main.mjs');

const ORIGINAL_ARGV = process.argv;

beforeEach(() => {
  vi.mocked(fs.realpathSync).mockReset();
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
});

describe('isMain (LD-PAT-005)', () => {
  it('returns true when argv[1] realpath matches importMetaUrl (direct invocation, Windows path)', () => {
    const realPath = process.platform === 'win32' ? 'C:\\real\\script.mjs' : '/real/script.mjs';
    process.argv = [process.argv[0], realPath];
    vi.mocked(fs.realpathSync).mockReturnValue(realPath);
    const metaUrl = pathToFileURL(realPath).href;
    expect(isMain(metaUrl)).toBe(true);
  });

  it('returns false when importMetaUrl points to a different file (imported, not main)', () => {
    const argv1 = process.platform === 'win32' ? 'C:\\real\\runner.mjs' : '/real/runner.mjs';
    const otherFile = process.platform === 'win32' ? 'C:\\real\\other.mjs' : '/real/other.mjs';
    process.argv = [process.argv[0], argv1];
    vi.mocked(fs.realpathSync).mockReturnValue(argv1);
    const metaUrl = pathToFileURL(otherFile).href;
    expect(isMain(metaUrl)).toBe(false);
  });

  it('returns true under npm-link junction (argv[1] is junction path; realpathSync resolves to target)', () => {
    const junctionPath = process.platform === 'win32'
      ? 'C:\\junction\\script.mjs'
      : '/junction/script.mjs';
    const realTarget = process.platform === 'win32'
      ? 'C:\\real\\script.mjs'
      : '/real/script.mjs';
    process.argv = [process.argv[0], junctionPath];
    vi.mocked(fs.realpathSync).mockReturnValue(realTarget);
    // import.meta.url side is already the realpath (ESM loader resolves symlinks).
    const metaUrl = pathToFileURL(realTarget).href;
    expect(isMain(metaUrl)).toBe(true);
  });

  it('returns false when process.argv[1] is undefined', () => {
    process.argv = [process.argv[0]];
    expect(isMain('file:///anything.mjs')).toBe(false);
  });

  it('returns false when realpathSync throws (e.g. ENOENT)', () => {
    process.argv = [process.argv[0], '/nonexistent/script.mjs'];
    vi.mocked(fs.realpathSync).mockImplementation(() => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    expect(isMain('file:///nonexistent/script.mjs')).toBe(false);
  });
});
