# Test fixtures

Synthetic `.tasks/` and `.issues/` trees used by orchestrator unit/integration tests.
Treat as **read-only test data** — never mutate at runtime; copy to a tmp dir if a test
needs to write.

## Provenance

| Fixture | Source repo | Source commit | Source path | Derivation |
|---|---|---|---|---|
| `tasks-fixture/.tasks/schemas/task.schema.json`  | `gen-tasklist` (`C:/Coding/ai_dev/tasklist-plugin`) | `73a757bfd4de524e7ca5aed777c34b8a38719797` | `templates/schemas/task.schema.json`  | byte-identical |
| `tasks-fixture/.tasks/schemas/index.schema.json` | `gen-tasklist` | `73a757bfd4de524e7ca5aed777c34b8a38719797` | `templates/schemas/index.schema.json` | byte-identical |
| `tasks-fixture/.tasks/config.json`               | `gen-tasklist` | `73a757bfd4de524e7ca5aed777c34b8a38719797` | `.tasks/config.json` (canonical `effort_hours`) | byte-identical values |
| `tasks-fixture/.tasks/tasks/TASK-*.json`         | hand-authored | n/a | n/a | inert seed data covering `done` / `in-progress` / `backlog` lifecycle states |
| `tasks-fixture/.tasks/INDEX.json`                | hand-authored | n/a | n/a | derived view consistent with the three task shards |
| `issues-fixture/.issues/schemas/issue.schema.json` | derived | `73a757bfd4de524e7ca5aed777c34b8a38719797` (base) | `templates/schemas/task.schema.json` | derived from gen-tasklist `task.schema.json` @ `73a757b` with status vocab swap (`open / triage / in-progress / blocked / resolved / wontfix / duplicate`) and ID prefix swap (`ISSUE-` instead of `TASK-`); `$id` host changed to `https://schemas.gen-issues.dev/issue.schema.json`; `title` → `Issue Shard` |
| `issues-fixture/.issues/schemas/index.schema.json` | derived | `73a757bfd4de524e7ca5aed777c34b8a38719797` (base) | `templates/schemas/index.schema.json` | same derivation rules: `next_task_id` → `next_issue_id`, `previous_task` / `current_task` / `next_task` → `previous_issue` / `current_issue` / `next_issue`, `open_tasks` → `open_issues`, `blocked_tasks` → `blocked_issues`, status enums updated to issue vocab, `counts.required` → issue vocab |
| `issues-fixture/.issues/issues/ISSUE-001.json`   | hand-authored | n/a | n/a | inert seed in `open` state |
| `issues-fixture/.issues/INDEX.json`              | hand-authored | n/a | n/a | derived view consistent with `ISSUE-001` |

> No upstream `gen-issues` plugin exists yet (`issues-plugin/` dogfoods gen-tasklist).
> When a canonical `gen-issues` ships with its own `templates/`, replace the derived
> schemas above with byte-identical copies and bump this README.

## Refreshing fixtures from upstream

A `scripts/refresh-fixtures.mjs` helper is **not yet implemented** (tracked as a
follow-up task). Until then, refresh manually:

1. `cd ../tasklist-plugin && git rev-parse HEAD` — record the new SHA.
2. Copy `templates/schemas/task.schema.json` and `templates/schemas/index.schema.json`
   into `tests/fixtures/tasks-fixture/.tasks/schemas/` (use `node` or your editor —
   no `cp`, no shell-specific path separators).
3. Re-apply the issue-schema derivation transform (status / ID / key renames listed in
   the table above) to produce the two files under
   `tests/fixtures/issues-fixture/.issues/schemas/`.
4. Update the **Source commit** column above to the new SHA.
5. Run `npm run validate:fixtures` and confirm exit code `0`.

## Validating fixtures

Acceptance gate for TASK-002:

```sh
npm run validate:fixtures
```

Validates every shard against its schema, validates each `INDEX.json` against its
`index.schema.json`, and exits non-zero on any error.
