# lib/ — pure, importable modules

Per **LD-PAT-001** (pure-lib + thin-CLI separation) and **LD-BUG-010** (no
`process.exit` in `lib/`):

> Modules under `lib/` are **pure**: no top-level side effects, no
> `process.exit`, no `console.*` (debug output gated behind `DEBUG_*` env
> vars only). They are importable in any context — scripts, tests, hooks,
> future plugin entry-points — with zero behavior.

**Allowed:** synchronous imports of `node:*` built-ins; throwing typed errors
with a `.code` discriminator; pure data transforms; one-shot reads of
operator-controlled config when explicitly requested by the caller.

**Forbidden:** top-level `await`; CLI argv parsing; reading `process.env`
beyond opt-in debug flags; calling `process.exit`; writing to `process.stdout`
or `process.stderr` outside of debug-gated paths.

**Dependency rule:** `lib/` modules MUST NOT import from `scripts/` or
`hooks/`. Direction is one-way: `scripts/` and `hooks/` consume `lib/`.
Verify with: `grep -rn "from '\.\./scripts/" lib/` (must return zero).

## Current modules

| Module | Purpose |
|--------|---------|
| `collision-prompt.mjs`   | Branch-setup collision UX (prompt + parse + restart-shard mutator). |
| `is-main.mjs`            | LD-PAT-005 — `isMain(import.meta.url)` guard for CLI entrypoints. |
| `merge-task-reasons.mjs` | Central registry for `merge-task.mjs` envelope reason codes. |
| `shard-library.mjs`      | Sharded-library I/O (load, locate, update, rebuild, scan-links). |
| `task-id.mjs`            | Pure `normalizeTaskId(rawArg) → 'TASK-NNN'`. |
