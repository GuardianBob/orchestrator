# gen-tasklist — Agent Quick Reference

This repo uses `gen-tasklist`. CLI is the source of truth; never edit `INDEX.json` or `TASKS.md` (derived from `tasks/*.json`).

## Read order

1. `.tasks/INDEX.json` → `next_task`, `current_task`, `next_task_id`, `open_tasks`. Sufficient for ~95% of queries. `INDEX.json` scales linearly (~250–400 B/task). At <50 tasks read in full; at scale use `.tasks/INDEX.compact.json` + `tasklist-show --json` (see "Paged viewing at scale").
2. `.tasks/tasks/TASK-NNN.json` → only when user asks for a specific task's full detail.

NEVER glob `.tasks/tasks/*.json`.

## Paged viewing at scale

At >50 tasks skip full `INDEX.json`:

- `.tasks/INDEX.compact.json` (~600 B fixed): `counts`, pointers, top-5 `blocked_top`, `truncated` — routine queries.
- `tasklist-show` pages `open_tasks` (INDEX-only, never shards): `npx tasklist-show --status open --limit 50 --offset 50 --json`.

Defaults `--status open`, `--limit 50` (max 500). Exit: 0 OK · 2 USAGE · 3 NO_TASKS_DIR · 4 INTERNAL.

## When to add a task

- User asks → add it
- You discover scope mid-implementation → add it (do NOT write `// TODO:`)
- You find a missing prerequisite → add it AND set current task to depend on it
- You're deferring work → add it with `status: "backlog"`

## Add a task — default (effort ≥ S, or non-trivial)

```bash
echo '{
  "title": "Add OAuth refresh token rotation",
  "effort": "M",
  "priority": "high",
  "tags": ["auth", "security"],
  "description": "Current refresh tokens never rotate; a stolen token grants indefinite access. Implement rotation on every /token refresh: issue a new refresh token, invalidate the previous one, and reject reuse with token_reuse_detected error.",
  "acceptance_criteria": [
    "POST /token with grant_type=refresh_token returns a new access_token AND a new refresh_token",
    "The previous refresh_token is rejected on subsequent use with HTTP 400 + error=invalid_grant",
    "Reuse of an invalidated refresh_token revokes the entire token family",
    "Unit + integration tests cover happy path, reuse, and family revocation"
  ]
}' | npx tasklist-add --stdin
```

## Add a task — fast path (trivial only: ≤30 min, self-explanatory title)

```bash
npx tasklist-add "Bump axios from 1.7.2 to 1.7.4" --effort XS --priority low
```

Use this only when the title alone is fully self-explanatory AND the work is ≤30 minutes. If you'd write more than one sentence in the PR description, you owe the task a real `description`.

### Anti-pattern: bare-floor non-trivial tasks

```bash
# DON'T — title only, M effort, no description, no AC
npx tasklist-add "Refactor auth module" --effort M
```

Future-you opens this shard and sees no scope, no exit criteria, no decisions. **If effort ≥ S and not a one-liner, use the stdin JSON form with `description` + `acceptance_criteria`.**

## Field reference

| Field | Values / pattern |
|---|---|
| `effort` | `XS` ≤30m · `S` ≤2h · `M` ≤1d · `L` ≤3d · `XL` (split) |
| `status` | `backlog` (default) · `ready` · `in-progress` · `blocked` · `review` · `done` · `cancelled` |
| `priority` | `low` · `medium` · `high` · `urgent` (default `medium`) |
| `tags` | `^[a-z0-9][a-z0-9-]*$` — lowercase + dashes only. `SEC-004` → `sec-004`, `v1.2` → `v1-2` |
| `depends_on` | array of existing `TASK-NNN` IDs only — forward-refs rejected |
| `id` | auto from `INDEX.next_task_id` — do not invent |
| `created` / `updated` | ISO-8601 UTC, e.g. `2026-04-30T12:34:56Z` |

Optional but high-value: `description`, `acceptance_criteria`, `notes`, `assignee`. Validator errors report the exact offending value (e.g. `pattern mismatch (got "SEC-004", expected ^[a-z0-9][a-z0-9-]*$)`) — read it carefully before retrying.

## Progressive enrichment over the task lifetime

A task accumulates context over its lifetime. Use the right field at the right stage.

| Stage | Field | Content |
|---|---|---|
| 1. Create | `description` + `acceptance_criteria` | Why this exists; what "done" looks like |
| 2. Pick up | append `description` (or refine `acceptance_criteria`) | Newly-uncovered constraints, design decisions before coding |
| 3. Work | append `notes` | Running log: commit hashes, surprises, links to PRs. Free-form. |
| 4. Close | final `notes` entry + `status: "done"` | One-line outcome; what shipped, what was deferred (as a new task) |

Read the closeout note 6 months from now and you should know what happened without opening git.

## Editing existing tasks

1. Read `.tasks/tasks/TASK-NNN.json`.
2. Edit field(s); update `updated` to now.
3. Status → `in-progress`: set `started`. Status → `done`/`cancelled`: set `completed`.
4. Atomic write (`.tmp` + rename), then `npx tasklist-rebuild`.

Do NOT edit `INDEX.json` or `TASKS.md` directly — they are derived and will be overwritten.

## Status flow

```
backlog → ready → in-progress → review → done
                ↘            ↗
                  blocked ──┘   (when depends_on resolves)
                                (cancelled is terminal from anywhere)
```

## Starting work after fresh bootstrap

`current_task` is `null`; rebuilder elects `next_task` from `ready` → `backlog` → priority → ID. To start:

1. Read `INDEX.next_task`.
2. Edit that shard: `status: "in-progress"`, set `started`, bump `updated`.
3. `npx tasklist-rebuild`.

If you want to **groom** rather than start (review-then-commit workflow), set `status: "ready"` instead — the rebuilder prefers `ready` over `backlog`, so groomed work surfaces first.

## Batch from a spec

Read `INDEX.next_task_id`, plan, **show user the plan and get confirmation**, then loop:

```bash
echo '{"title":"X","effort":"S","tags":["auth"]}' | npx tasklist-add --stdin
echo '{"title":"Y","effort":"M","depends_on":["TASK-042"]}' | npx tasklist-add --stdin
```

Each add increments `next_task_id` atomically — `depends_on` chains work as you write them. For forward-references unknown at first-pass, use `depends_on: []` then patch in a second pass once IDs are assigned. Final `npx tasklist-rebuild` is idempotent; show the user the new `TASKS.md`.

NEVER write shards directly via `fs.writeFileSync` to `.tasks/tasks/`. ALWAYS use `tasklist-add --stdin`.

## Migration (opt-in)

Agent NEVER auto-runs `tasklist-migrate`. If the user asks, OR if you notice legacy files (`TASKS.md`, `TODO.md`, `BACKLOG.md`, `tasks.md`, `todo.txt`, `TODOS.md`) at the repo root with no `.tasks/`:

1. Mention ONCE: "I see a TODO.md / TASKS.md at the repo root. Want me to port it via `tasklist-migrate`? (Optional — you can also start fresh.)"
2. If yes: `npx tasklist-bootstrap` (if needed) → `npx tasklist-migrate --dry-run` → show report → confirm → re-run without `--dry-run`.
3. If no: drop it. Do NOT re-prompt.

## Hooks

- **Stop hook** (`hooks/stop.mjs`): scans the assistant's last message for unfiled TODO patterns ("we also need…", "TODO:", "next we should…") and emits a non-blocking suggestion to run `tasklist-add`. Suggest-only, never blocks.
- (Future) PreToolUse warnings on direct edits to `INDEX.json`/`TASKS.md` are advisory.

## Hard rules

- NEVER edit `.tasks/INDEX.json` or `.tasks/TASKS.md` (regenerated)
- NEVER write `// TODO:` as a substitute for adding a task
- NEVER invent `TASK-NNN` IDs that don't exist
- NEVER glob `.tasks/tasks/*.json` — read `INDEX.json` first
- NEVER bypass `tasklist-add --stdin` by writing shards via `fs` directly
- NEVER auto-run `tasklist-migrate` — always ask the user

## Cross-reference: living-docs

If both skills are active: task IDs (`TASK-NNN`) are the linkage. Living-docs memory shards reference task IDs in `task_id`. Order of operations when finishing work: edit shard → `tasklist-rebuild` → write memory shard (if narrative-worthy) → `living-docs-rebuild`. Two independent atomic chains.

## Debugging

- `TASKLIST_DEBUG=1`: surface project-root resolution and other silent notes.
- `TASKLIST_LOCK_STALE_MS=N`: stale-lock threshold in ms (default 60000).

## For maintainers

Copy-paste snippet for your project's `AGENTS.md` lives in the plugin `README.md` ("Adding to a project's AGENTS.md").
