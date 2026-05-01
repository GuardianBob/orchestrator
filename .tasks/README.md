# `.tasks/` — Sharded Task List

This directory is managed by [`@GuardianBob/gen-tasklist`](https://www.npmjs.com/package/@GuardianBob/gen-tasklist).

## Layout

```
.tasks/
├── INDEX.json                # Derived. Regenerated on every write.
├── TASKS.md                  # Derived. Human-facing status table.
├── README.md                 # This file.
├── AGENT_GUIDE.md            # Agent quick reference (~500 tokens).
├── config.json               # Effort → hours overrides.
├── tasks/
│   ├── TASK-001.json         # Source of truth: one shard per task.
│   └── TASK-NNN.json
├── schemas/
│   ├── task.schema.json
│   └── index.schema.json
└── archive/
    └── YYYY-Q<N>/tasks/      # Done/cancelled tasks moved here by tasklist-archive.
```

## Source of Truth

`tasks/TASK-NNN.json` shards are the source of truth. `INDEX.json` and `TASKS.md`
are **derived** — regenerated atomically by `tasklist-rebuild`. **Do not edit
them by hand.**

## Quick Commands

```bash
npx tasklist-add "Add OAuth refresh token rotation" --effort L --priority high
npx tasklist-rebuild
npx tasklist-archive --older-than-days 90 --dry-run
```

For agent-specific workflow (when to add tasks, batch generation, dependency
chains), read `AGENT_GUIDE.md` in this directory.

## Schemas

`schemas/task.schema.json` and `schemas/index.schema.json` are JSON Schema
2020-12 documents. Every shard is validated against `task.schema.json` on every
rebuild. Validation failures abort the rebuild without touching `INDEX.json` or
`TASKS.md` — the last good state remains visible.

## Concurrency

`.rebuild.lock` and `.migrate.lock` use a 60-second stale threshold. Concurrent
rebuilds are detected and exit with code 2.
