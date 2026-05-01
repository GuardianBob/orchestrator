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
      // Thresholds intentionally OMITTED in this task to satisfy
      // acceptance: "exits 0 on empty test set". Re-enable once
      // first test files exist.
    },
  },
});
