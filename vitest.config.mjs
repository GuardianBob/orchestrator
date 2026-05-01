// ESM only — no require(), no __dirname tricks.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // Explicitly enabled: vitest 2.1.x exits 1 on empty test set otherwise.
    // Acceptance for TASK-001 requires exit 0 on empty test set.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['scripts/**/*.mjs', 'lib/**/*.mjs'],
      exclude: ['tests/**', 'node_modules/**', 'coverage/**'],
      // Per-file thresholds: enabled for files that have first-class
      // unit-test coverage. Other source files remain unthresholded
      // (they are exercised via integration paths) so that the
      // empty-test-set acceptance from TASK-001 still holds when
      // no test file exists. See TASK-006.
      thresholds: {
        'scripts/shard-library.mjs': {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
