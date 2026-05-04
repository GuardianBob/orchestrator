---
name: orchestrator
description: Sub-agent team orchestration for build → review → merge → next-task loops. Use when the user invokes `/orchestrate`, says "have the team complete...", "run the next N tasks", "execute sprint X", "ticket-driven development", or any phrasing involving sub-agent teams completing tickets/tasks/issues with peer review and auto-merge. Coordinates a builder team and a reviewer team across task/sprint branches with desktop notifications and living-doc updates.
---

# Orchestrator — Builder/Reviewer Team Loop

You are running a multi-agent ticket-completion loop. Your job is to coordinate, not to write the code yourself. The **builder team** writes code. The **reviewer team** verifies it. You merge, notify, and advance.

## Activation

This skill activates when:
- User runs `/orchestrate <target>` (target = task ID like `task-42` or bare `42`, `sprint-N`, `count:N`, `next`, `review-sprint`, or `review-sprint-N`).
- User says: "have the team build…", "run next N tickets", "execute sprint 3", "complete the next task and stop", "review the last sprint", "look at sprint-2 for missed tasks", etc.

If the slash command was used, the target argument is already in the prompt. Otherwise extract the target from the user's message and confirm if ambiguous.

## Step 0 — Init shortcut

If the target is `init`, this is a setup-only invocation. Do NOT start any task work.

```
node {SKILL_DIR}/../scripts/init-project.mjs
```

This is idempotent and will:
- Create `.orchestrator.json` with auto-detected `commands` (or leave existing one untouched).
- Create the `.orchestrator/`, `.orchestrator/reviews/`, `.orchestrator/gates/` state dirs.
- Scaffold missing living docs (`MEMORY.md`, `STATUS_SUMMARY.md`, `TASKLIST.md`, `GIT_COMMITS.md`, `REVIEW_LOG.md`) from templates — only docs listed in `config.livingDocs` and not already present.
- Append `.orchestrator/` to `.gitignore` if missing.

Show the user the JSON result, then advise them to:
1. Review `builderAgents` and `reviewerAgents` arrays in `.orchestrator.json` — these are placeholders until mapped to real agents on their machine.
2. Verify `commands.test|lint|build` match their project; set any to `null` to skip that gate.
3. Add tasks to `TASKLIST.md` under a `## Sprint N` header before running `/orchestrate sprint-N`.

Then **STOP.** Do not proceed to Step 1.

## Step 0b — Review-sprint shortcut

If the target is `review-sprint` (latest completed sprint) or `review-sprint-<N>`, this is a **post-sprint audit** invocation. You are NOT dispatching builders or reviewers. You are reading sprint artifacts, finding work that has no task yet, and interactively adding it to `TASKLIST.md`.

```
node {SKILL_DIR}/../scripts/review-sprint.mjs --sprint <N>
```

(Omit `--sprint` to auto-detect the latest sprint from `.orchestrator/state.json`, then `.orchestrator/sprints/sprint-*-complete.md`, then git branches.)

The script returns a JSON bundle with:
- `deferredSections[]` — every "Deferred", "Backlog", "Follow-up", "Known Issues", "Tech Debt", "Cleanup", "TODO" section parsed out of `sprint-<N>-complete.md`.
- `reviewerFindings[]` — every finding from `.orchestrator/reviews/task-*-attempt-*-*.json` for this sprint.
- `gateFailures[]` — any failed-gate residue from `.orchestrator/gates/`.
- `taskCount.nextProposedId` — the next free task id, zero-padded.

**Then follow this workflow** (this is the proven pattern from prior sessions):

1. **Cross-reference** every deferred bullet, finding, and gate failure against existing tasks in `TASKLIST.md`. Group items into three buckets:
   - **Already covered** — note the existing task id, skip.
   - **Gaps requiring new tasks** — list with proposed id, severity, target sprint, location.
   - **Out-of-scope** — bugs in the orchestrator skill itself, or items the user has explicitly punted; note but don't propose.
2. **Group cohesive items into bundles** where they touch the same files or share a dependency chain (e.g., 3 small CI hardening items → one bundled task). Atomic items stay atomic.
3. **Propose target sprint** for each new task: highest-severity items that block the *next* sprint's exit criteria → next sprint; medium → sprint after; low → final cleanup phase.
4. **Use the `question` tool** to ask the user (one batched call, multiple questions when sensible):
   - Confirm: which proposed tasks to add (all / Sprint-N only / show diff first).
   - Confirm: bundle vs split for any borderline groupings.
   - Ask any task-specific clarifications you genuinely need (severity, owner, dependency ordering). **Do not invent answers** — if the deferred bullet is ambiguous, ask.
5. **Apply the additions** to `TASKLIST.md` using the `edit` tool, inserting each new task under its target sprint header in the standard task body format (Maps to / Severity / Owner / Effort / Location / Detail / Steps / Depends on). Update the Summary table totals.
6. **Notify completion**: `node {SKILL_DIR}/../scripts/notify.mjs --title "Sprint <N> review complete" --body "Added <count> new tasks to TASKLIST.md" --reason approval`.

**Critical constraints for review-sprint:**
- **Never auto-add tasks without user confirmation.** The proven pattern is: propose → ask → apply.
- **Never modify code, branches, or living docs other than TASKLIST.md** during a review-sprint pass. This is a planning operation.
- **Never dispatch builder/reviewer agents** during review-sprint.
- **If the bundle returns `completionReportFound: false`**, tell the user the report is missing, ask whether they want you to (a) generate one from `STATUS_SUMMARY.md` + `REVIEW_LOG.md` + reviewer JSON, or (b) abort.
- **STOP** after the additions are applied (or the user declines). Do not chain into a sprint run.

## Step 1 — Load project config

Run the helper to load (or create) `.orchestrator.json` in the project root:

```
node {SKILL_DIR}/../scripts/load-config.mjs
```

It outputs JSON with: `branchPrefix`, `builderAgents[]`, `reviewerAgents[]`, `maxRetries`, `commands.test|lint|build`, `tasksSource`, `livingDocs[]`, `mergeStrategy`, `githubRepo`. If the file does not exist, the script auto-detects defaults from `package.json`/`pyproject.toml`/`Cargo.toml` and writes a starter file. **Show the user the config it loaded** before the first task.

## Step 2 — Resolve task list

Run:

```
node {SKILL_DIR}/../scripts/resolve-tasks.mjs "<TARGET>"
```

(`--target "<TARGET>"` is also accepted.) Returns an ordered JSON array: `[{id, slug, title, source, sprintId, body, resolution}]`. Sources checked in order: `TASKLIST.md`, `PHASE_*_PLAN.md`, then `gh issue list` if available. Sprint scoping in markdown is parsed from `## Sprint N` / `## Phase N` headers. If zero tasks resolve, stop and ask the user to clarify.

## Step 3 — The loop

For each task, in order:

### 3a. Branch setup

Ensure the sprint umbrella branch exists, then create the task sub-branch:

```
node {SKILL_DIR}/../scripts/branch-setup.mjs --sprint <N> --task <id> --slug <slug>
```

Creates flat-named branches: `sprint-<N>` (off `main` if missing) and `sprint-<N>-task-<id>-<slug>` (off `sprint-<N>`), then checks out the task branch. Flat hyphenated naming avoids the git ref-tree namespace collision that nested naming (`sprint/N` blocking `sprint/N/task-...`) would cause. **Never** auto-create branches off `main` for individual tasks — they must come off the sprint branch.

### 3b. Dispatch builder team

Use the **Task tool** to dispatch each builder agent from `config.builderAgents` in parallel when their roles are independent (architect → coder → tester is sequential; coder + doc-writer can be parallel). Pass them:
- The full task body and acceptance criteria
- The list of `livingDocs` they must update on completion
- Explicit instruction: "Do not commit. Do not merge. Stop when done and report what changed."

Recommended roles to map in config: `architect`, `coder`, `tester`, `docs`. Common picks: `@code-architect`, `@fullstack-developer`, `@test-automator`, `@technical-writer`. The user's project config decides.

### 3c. Commit task work

Once builders return:

```
node {SKILL_DIR}/../scripts/commit-task.mjs --task <id> --slug <slug> --title "<title>"
```

Stages all changes, generates a conventional commit message (`feat(task-<id>): <title>`), commits to the task branch, and appends to `GIT_COMMITS.md`.

### 3d. Dispatch reviewer team

Use the **Task tool** to dispatch each reviewer agent from `config.reviewerAgents`. Pass them:
- The task description and acceptance criteria
- The diff (`git diff sprint-<N>...HEAD`)
- The configured `commands.test|lint|build` to run (these are the *gate* commands; reviewers may inspect results but don't need to re-run them)
- Required output schema (canonical):
  ```json
  {
    "reviewer": "<agent-name>",
    "verdict": "approve" | "request_changes" | "block",
    "requires_human_decision": false,
    "findings": [{ "severity": "info|warn|error", "file": "...", "line": 0, "message": "..." }]
  }
  ```
  The legacy shape `{ "approved": true|false, ... }` is still accepted by `run-gates.mjs`, but emit the canonical schema for new work.

Common reviewer picks: `@code-reviewer`, `@security-auditor`, `@architect-reviewer`. Run them in parallel.

### 3e. Aggregate review + run gates

```
node {SKILL_DIR}/../scripts/run-gates.mjs --task <id>
```

This script:
1. Runs configured `test`, `lint`, `build` commands (skips any not configured — unconfigured ≠ failed), captures pass/fail.
2. Reads every reviewer file matching `.orchestrator/reviews/task-<id>-attempt-<n>-*.json`.
3. Appends a row to `REVIEW_LOG.md`.
4. **Persists the aggregated result to `.orchestrator/gates/task-<id>-attempt-<n>.json`** (consumed by `merge-task.mjs` for safety verification).
5. Returns `{passed: bool, failures: [...], notifyReason?: string}` and exits non-zero on failure.

**Before running this script:** save each reviewer's structured output to `.orchestrator/reviews/task-<id>-attempt-<n>-<reviewer>.json` (one file per reviewer, with the reviewer agent name in the filename).

### 3f. Decision tree

- **All gates pass** → go to 3g.
- **Gates fail AND attempt < maxRetries** → notify reviewer findings to builder team via Task tool with prompt: "Review feedback on task-<id>. Address every finding. Do not commit until done." Then loop back to 3c. Increment attempt counter.
- **Gates fail AND attempt >= maxRetries** → Run `node {SKILL_DIR}/../scripts/notify.mjs --title "Task <id> blocked" --body "Max retries reached. <summary>" --reason blocked`. STOP the loop. Wait for user.
- **Any reviewer emits `verdict: "block"` or `requires_human_decision: true`** → notify and stop, regardless of attempt count.

### 3g. Merge task → sprint

```
node {SKILL_DIR}/../scripts/merge-task.mjs --sprint <N> --task <id> --slug <slug>
```

**Safety:** this script refuses to merge (exit code 3) unless `.orchestrator/gates/task-<id>-attempt-<n>.json` exists AND its latest attempt shows `passed: true`. Pass `--force` only to override in an emergency (logs a warning).

Switches to `sprint-<N>`, merges `sprint-<N>-task-<id>-<slug>` with `--no-ff` to keep history visible, deletes the task branch locally. Updates living docs:
- `MEMORY.md` — bumps `next_task_id`, prepends recent_changes bullet
- `STATUS_SUMMARY.md` — appends 1–3 factual change bullets
- `TASKLIST.md` / `PHASE_*_PLAN.md` — checks off the task
- `ADVENTURES_IN_CODING.md` — only if `narrated_dev` persona is active (script detects via persona-mcp or env var)

### 3h. Advance

Run `node {SKILL_DIR}/../scripts/notify.mjs --title "Task <id> merged" --body "<title>" --reason progress` (low-priority toast). Move to next task in the queue.

## Step 4 — Sprint completion

When all tasks in a sprint are done:
1. Run `node {SKILL_DIR}/../scripts/notify.mjs --title "Sprint <N> complete" --body "All <count> tasks merged into sprint-<N>. Approve merge to main?" --reason approval`.
2. **Offer a sprint review BEFORE asking about merge to main.** Use the `question` tool with this exact pattern:
   ```
   Sprint <N> is complete (<count> tasks merged). Before approving the merge to main,
   would you like me to review sprint-<N> for any deferred items, missed bugs, or
   follow-up tasks that should be added to TASKLIST.md?

   Options:
   - "Yes — review now" → run Step 0b workflow against sprint-<N>, then return here for the merge decision.
   - "No — skip review" → proceed to merge approval. Reminder: you can run /orchestrate review-sprint-<N> later.
   - "Skip review and merge to main now" → proceed straight to merge.
   ```
3. If the user picks "Yes", execute Step 0b for `sprint-<N>` end-to-end, then return to this step and re-ask about the merge.
4. If the user picks "No" or "Skip review and merge", **explicitly remind them** in your response: "You can review this sprint later with `/orchestrate review-sprint-<N>` to surface any work that didn't get a task entry."
5. **STOP.** Do not auto-merge sprint into main. Wait for user. When user approves, run `node {SKILL_DIR}/../scripts/merge-sprint.mjs --sprint <N>`.

## Step 5 — Idle

When the queue is empty (or user said "do 1 task"), notify completion and **stop generating**. Do not start anything new.

## Critical rules

- **You orchestrate. You do not write feature code.** Builder agents do that.
- **One task = one sub-branch = one merge commit into the sprint branch.** No exceptions.
- **Never merge to main automatically.** Sprint→main is always human-gated.
- **Always notify on**: blocked task (max retries), human decision required, sprint complete. Never spam (no toast for routine merges if `--reason progress` is configured silent).
- **Living docs are non-negotiable.** If the merge script reports a doc update failed, treat it as a gate failure.
- **Persist state**: `.orchestrator/state.json` tracks current sprint, current task, attempt count, queue. Resume from this on re-invocation.
- **All `.orchestrator/` artifacts are UTF-8.** Reviewer JSON, gate results, state, notification logs.

## Helper scripts

All scripts live in the skill's adjacent `scripts/` directory. Resolve `{SKILL_DIR}` from the skill's location. They take JSON-friendly args, print structured JSON to stdout, exit non-zero on hard failure.

| Script | Purpose |
|---|---|
| `init-project.mjs` | One-shot setup: config + living docs + .gitignore (Step 0 only) |
| `load-config.mjs` | Load/create `.orchestrator.json` |
| `resolve-tasks.mjs` | Expand `<target>` into task array |
| `branch-setup.mjs` | Create sprint + task branches |
| `commit-task.mjs` | Stage + commit task work, update GIT_COMMITS.md |
| `run-gates.mjs` | Run test/lint/build, aggregate review verdicts |
| `merge-task.mjs` | Merge task→sprint, update living docs |
| `merge-sprint.mjs` | Merge sprint→main (only after user approval) |
| `review-sprint.mjs` | Gather sprint artifacts (deferred items, findings, gate failures) for Step 0b post-sprint audit |
| `notify.mjs` | Desktop notification via BurntToast |
| `state.mjs` | Read/write `.orchestrator/state.json` |

## Configuration reference

Project-specific overrides go in `.orchestrator.json` at project root. Full schema in `templates/orchestrator.json`.

### Top-level keys

| Field | Notes |
|---|---|
| `branchPrefix` | Sprint branch prefix (e.g. `"sprint"` → `sprint/2025-W42`). |
| `builderAgents[]` | Ordered roles `{role, agent, parallel?}`; serial unless `parallel: true`. |
| `reviewerAgents[]` | Reviewer roles `{role, agent}`; all run in parallel. |
| `maxRetries` | Retry attempts per task before deferral. |
| `commands.{test,lint,build}` | Shell commands for gates; `null` skips. |
| `tasksSource` | `{primary, phasePattern?, fallback?}`. Legacy single-source pointer. |
| `livingDocs[]` | Files updated on each merge (MEMORY.md, STATUS_SUMMARY.md, etc.). |
| `mergeStrategy` | `"no-ff"` or `"squash"`. |
| `githubRepo` | `owner/repo` for issue/PR fallback. |
| `notifications.{progress,approval,blocked}` | Toggle BurntToast events. |
| `shardLibraries[]` | Multi-library shard config; see §below. |

### `shardLibraries[]` schema

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | **yes** | — | Stable identifier (e.g. `"tasks"`, `"issues"`). Used as `source` in resolver output. |
| `name` | string | no | `entry.id` | Human label for log lines. |
| `indexPath` | string (path) | **yes** | — | Path to `INDEX.json`. Resolved relative to `.orchestrator.json`. |
| `shardDir` | string (path) | **yes** | — | Per-shard `.json` directory. Resolved relative to `.orchestrator.json`. |
| `schemaPath` | string (path) | no | `<dirname(indexPath)>/schemas/task.schema.json` | JSON Schema with `properties.status.enum` (string array, no `$ref`/`oneOf`). |
| `statusMap` | `{start,done}` or `null` | no | `null` | Operator override for status vocab. Both keys required if set. See §Shard Library Integration. |
| `linkField` | string or `null` | no | `null` | Shard field name listing linked IDs (e.g. `"resolves"`). |
| `primary` | boolean | no | `false` | Exactly one library MUST set `primary: true`. |
| `rebuildCmd` | string | **yes** | — | Shell command to rebuild `INDEX.json`. Set to `""` to opt out silently. |

Validation is all-or-abort: one bad entry rejects the whole array. Schema enforced in `lib/shard-library.mjs:394-425`.

### Backward-compatibility: `tasksSource.primary`

If `shardLibraries[]` is absent or empty, `loadLibraries` synthesizes a single entry from `tasksSource.primary` (`lib/shard-library.mjs:_synthesizeLegacyLibrary`). `.json` paths become an `indexPath` with `shardDir` inferred as `<indexDir>/tasks`; Markdown paths get a default `.tasks/` library. A `DEBUG_SHARD_LIBRARY=1` warn is emitted in either case. Supported, no deprecation timeline — synthesis has full feature parity for single-library projects.

## Shard Library Integration

### Status inference

Resolved by `resolveStatusVocab` (`lib/shard-library.mjs:323-364`). Resolution order:

1. **Override path** — `library.statusMap = { start, done }`. Both must be non-empty strings; partial = hard error (code `vocab-error:statusmap-partial`). NOT cross-checked against the schema enum (operator is authoritative).
2. **Heuristic path** — load `library.schemaPath`, read `properties.status.enum`, apply regexes from `lib/shard-library.mjs:379-380`:
   - `START_RE = /^(in[-_]?progress|active|started|wip)$/i`
   - `DONE_RE  = /^(done|completed?|closed|resolved|fixed)$/i`
   - Exactly one match per role required. Zero → `vocab-error:no-match-<role>`. >1 → `vocab-error:ambiguous-<role>`.

**Override path:** set `statusMap` on the library entry (NOT a top-level config key).

**Drift-warning behavior** (per-shard safety net, `scripts/resolve-tasks.mjs:182-197`): when a shard's own `status` is terminal (`done|completed|archived|cancelled|closed`) but `INDEX.json` still lists it as open, the resolver skips the task and emits:

`[resolver] shard drift: <ID> status=<shard> in shard but INDEX says <index>; skipping. Run: npx tasklist-rebuild`

Per-shard status is authoritative; INDEX is the derived projection.

### Cross-library link detection

Implemented in `scanLinks` (`lib/shard-library.mjs:615-670`).

**Explicit field:** `taskShard[library.linkField]`. Accepts `string` or `string[]`. IDs validated against `/^[A-Z][A-Z0-9_]*-\d+$/i`. Routes to the owning library regardless of ID prefix. Invalid entries warn and skip.

`linkField` is the field name the library exposes for explicit link arrays. `scanLinks` reads it from the *current* (primary) shard; a non-primary library's `linkField` documents the field name that library would expose if it ever became primary.

**Keyword regex** (`lib/shard-library.mjs:583`):

```
/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+([A-Z][A-Z0-9_]*-\d+)/gi
```

Scanned over `(description ?? '') + '\n' + (notes ?? '')`. Matched IDs are routed to a library by sampling each library's existing shard filenames for a leading prefix. Unknown prefixes warn (`[shard-library] scanLinks: unknown ID prefix '...'`) and drop.

**Multi-library link closing on merge** (`scripts/merge-task.mjs:closeLinkedShardsOnMerge`, lines 221-357): after the primary shard is closed, the merge script re-loads the primary, runs `scanLinks`, and for each linked library: resolves vocab → flips each linked shard to `vocab.done` with note `[YYYY-MM-DD] Resolved by <taskId> @ <sha12>`. Idempotent (dedupes by `Resolved by <taskId>` marker). Best-effort: never throws, never blocks the merge. `rebuildLibrary` is invoked AT MOST ONCE per linked library, only if ≥1 shard closed.

### Resilience: rebuild CLI absent

`rebuildLibrary` (`lib/shard-library.mjs:257-298`) is **never-throws**:

- `rebuildCmd` empty/null → `{ ok: false, reason: "library '<id>' has no rebuildCmd configured" }`. Silent (no warn) — operator opt-out.
- `ENOENT` / "not recognized" / "not found" → `{ ok: false, reason: "rebuild CLI not found ... Install it (e.g. \`npm i -g <guess>\`) or fix rebuildCmd" }`. Warns to stderr.
- Non-zero exit → `{ ok: false, reason: "rebuild ... exited <N>: <stderr-tail-500>" }`. Warns.
- Success → `{ ok: true }`.

**Soft-fail rule:** rebuild failure NEVER aborts the orchestrator loop. `branch-setup.mjs` and `merge-task.mjs` log a warning and continue. Operator must run the rebuild CLI manually.

**Hard-fail rule:** absence of `rebuildCmd` is NOT an error. Absence of the underlying CLI is NOT an error. The only hard failures are config-shape errors (caught by `loadLibraries` validation) — those exit 5 in `branch-setup.mjs`.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Ambiguous '<role>' status for library '<id>'` (code `vocab-error:ambiguous-<role>`) | Schema `enum` has >1 values matching the start/done heuristic regex (e.g. both `done` and `closed`). | Set `statusMap: { "start": "...", "done": "..." }` on the library entry to bypass the heuristic. |
| `Schema at <path> has no `properties.status.enum` string array` (`vocab-error:enum-missing`) or `schema not found at <path>` (`vocab-error:schema-missing`) | `schemaPath` is wrong, file deleted, or schema lacks a status enum (or uses `$ref`/`oneOf`). | Set `schemaPath` correctly, OR set `statusMap` to skip schema reads. |
| `scanLinks: unknown ID prefix '<X>' in '<X-N>'` | Keyword reference (e.g. "fixes ISSUE-42") points at a prefix no library claims; `shardDir` is empty so prefix sampling failed. | Add a `shardLibraries[]` entry whose `shardDir` already contains a `<X>-NNN.json` shard, OR remove the stale reference. |
| `rebuild CLI not found for library '<id>'. Install it (e.g. `npm i -g <guess>`)` | `rebuildCmd` points at a binary not on `PATH`. | Install the rebuild package, fix the path in `rebuildCmd`, or set `rebuildCmd: ""` to silently opt out (INDEX will drift until rebuilt manually). |
| Drift warn never fires for library whose terminal status is `"resolved"` (or anything outside `{done, completed, archived, cancelled, closed}`) | The resolver drift check uses a hardcoded `DONE_STATUSES` set in `scripts/resolve-tasks.mjs:153`, NOT `resolveStatusVocab(library).done`. | Known limitation. Use `done`, `completed`, `archived`, `cancelled`, or `closed` as the terminal status for libraries that need drift detection, OR rebuild the index manually after every merge. |

### Complete `.orchestrator.json` example

```json
{
  "branchPrefix": "sprint",
  "builderAgents": [
    { "role": "architect", "agent": "code-architect", "parallel": false },
    { "role": "coder", "agent": "fullstack-developer", "parallel": false },
    { "role": "tester", "agent": "test-automator", "parallel": true }
  ],
  "reviewerAgents": [
    { "role": "code-review", "agent": "code-reviewer" },
    { "role": "security", "agent": "security-auditor" }
  ],
  "maxRetries": 2,
  "commands": { "test": "npm test", "lint": "npm run lint", "build": null },
  "tasksSource": { "primary": "TASKLIST.md", "phasePattern": "PHASE_*_PLAN.md", "fallback": "github" },
  "livingDocs": ["MEMORY.md", "STATUS_SUMMARY.md", "GIT_COMMITS.md", "REVIEW_LOG.md", "TASKLIST.md"],
  "mergeStrategy": "no-ff",
  "githubRepo": "acme/widget",
  "shardLibraries": [
    {
      "id": "tasks",
      "name": "Tasks",
      "indexPath": ".tasks/INDEX.json",
      "shardDir": ".tasks/tasks",
      "schemaPath": ".tasks/schemas/task.schema.json",
      "linkField": "resolves",
      "primary": true,
      "rebuildCmd": "npx tasklist-rebuild"
    },
    {
      "id": "issues",
      "name": "Issues",
      "indexPath": ".issues/INDEX.json",
      "shardDir": ".issues/issues",
      "statusMap": { "start": "in-progress", "done": "resolved" },
      "linkField": null,
      "primary": false,
      "rebuildCmd": "npx issuelist-rebuild"
    }
  ]
}
```

All paths resolve relative to `.orchestrator.json` location. The `tasks` entry uses the heuristic path (no `statusMap`); `issues` uses the override path (`statusMap` set, `schemaPath` omitted to use the default). Exactly one entry must set `primary: true`.
