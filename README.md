# Orchestrator — Sub-Agent Team Loop

A reusable, project-agnostic build → review → merge → next-task system for opencode/Claude Code.

## What it does

1. You invoke `/orchestrate <target>` (target = task ID, sprint, `count:N`, or `next`).
2. **Builder team** (configurable agents) implements the task on a sub-branch.
3. Work is auto-committed to `sprint-<N>-task-<id>-<slug>` (flat hyphenated naming — avoids git ref-tree namespace collisions).
4. **Reviewer team** (different agents) audits the diff; gate runner executes configured tests/lint/build.
5. If gates pass → merge into `sprint-<N>`, update living docs, advance to next task.
6. If gates fail → loop back to builders with findings (up to `maxRetries`), then desktop notification.
7. When sprint queue empties → notify and **wait for human approval** before merging sprint→main.

## Files

| Path | Purpose |
|---|---|
| `skill/SKILL.md` | The skill prompt — drives the orchestration loop |
| `commands/orchestrate.md` | The `/orchestrate` slash command |
| `scripts/*.mjs` | Pure-Node helpers (no npm deps, Node ≥18) |
| `templates/orchestrator.json` | Default per-project config |
| `install.ps1` | Copies everything into `~/.config/opencode/` |

## Install

```powershell
powershell -File C:\Coding\ai_dev\orchestrator\install.ps1
# (re-install with -Force to overwrite)
```

Then once-per-machine:

```powershell
Install-Module -Name BurntToast -Scope CurrentUser -Force
```

## Usage

```
/orchestrate init             # one-shot project setup, then stop (no task work)
/orchestrate next             # one task, then stop
/orchestrate task-42          # one specific task (or bare: /orchestrate 42)
/orchestrate sprint-3         # every task under "## Sprint 3" / "## Phase 3" header
/orchestrate count:5          # the next five tasks
/orchestrate JIRA-101         # ticket-style IDs supported
/orchestrate review-sprint    # post-sprint audit: cross-reference latest sprint-N-complete.md against TASKLIST.md, propose new tasks, ask for confirmation, append. No agents dispatched.
/orchestrate review-sprint-2  # same, but explicitly target sprint 2
```

### Sprint review (`/orchestrate review-sprint`)

Sprint completion reports (`.orchestrator/sprints/sprint-N-complete.md`) and reviewer findings frequently surface deferred items, missed bugs, security backlog entries, and follow-up work that never get a task entry. The `review-sprint` target reads those artifacts, cross-references against `TASKLIST.md`, and **interactively** (via the `question` tool) proposes new tasks for you to confirm — including bundle/split decisions and target-sprint placement. Nothing is added without your approval. No code is written, no branches are created, no builders/reviewers are dispatched.

The orchestrator also **automatically offers** a sprint review when a sprint completes, before asking you to approve the sprint→main merge. If you decline, it reminds you of the slash command.

### First-time project setup (`/orchestrate init`)

Run this once per project before the first real task. It is idempotent and safe to re-run.

It will:
- Create `.orchestrator.json` with `commands.test|lint|build` auto-detected from `package.json` / `pyproject.toml` / `Cargo.toml`.
- Create `.orchestrator/`, `.orchestrator/reviews/`, `.orchestrator/gates/` state directories.
- Scaffold any missing living docs listed in `livingDocs[]` (`MEMORY.md`, `STATUS_SUMMARY.md`, `TASKLIST.md`, `GIT_COMMITS.md`, `REVIEW_LOG.md`) from `templates/living-docs/`.
- Append `.orchestrator/` to `.gitignore` if not already present.

After init, edit `.orchestrator.json` to map `builderAgents` / `reviewerAgents` to real agent names on your machine, then add tasks to `TASKLIST.md` under a `## Sprint 1` header.

First run in a project auto-creates `.orchestrator.json` with detected commands. Edit it to map agents to roles.

## Per-project config (`.orchestrator.json`)

```json
{
  "branchPrefix": "sprint",
  "builderAgents": [
    { "role": "architect", "agent": "code-architect" },
    { "role": "coder",     "agent": "fullstack-developer" },
    { "role": "tester",    "agent": "test-automator", "parallel": true }
  ],
  "reviewerAgents": [
    { "role": "code-review", "agent": "code-reviewer" },
    { "role": "security",    "agent": "security-auditor" }
  ],
  "maxRetries": 2,
  "commands": {
    "test":  "npm test",
    "lint":  "npm run lint",
    "build": "npm run build"
  },
  "tasksSource": {
    "primary": "TASKLIST.md",
    "phasePattern": "PHASE_*_PLAN.md",
    "fallback": "github"
  },
  "livingDocs": [
    "MEMORY.md", "STATUS_SUMMARY.md", "GIT_COMMITS.md",
    "REVIEW_LOG.md", "TASKLIST.md", "ADVENTURES_IN_CODING.md"
  ],
  "mergeStrategy": "no-ff",
  "notifications": {
    "progress": "silent",
    "approval": "toast",
    "blocked": "toast"
  }
}
```

Set `commands.*` to `null` to skip that gate. Any agent name from your global agents folder is valid.

## Task list format

Markdown checklist anywhere in `TASKLIST.md` or `PHASE_<N>_PLAN.md`:

```
- [ ] task-42: Add OAuth login flow
- [ ] #43 Refactor user service
- [ ] JIRA-101: Wire up webhook handler
- [x] task-41: Setup CI (already done — skipped)
```

If neither file exists, falls back to `gh issue list` (open issues with `sprint-N` / `phase-N` labels).

## Living docs touched

| Doc | When |
|---|---|
| `GIT_COMMITS.md` | Appended after each task commit |
| `REVIEW_LOG.md` | Row added after every gate run (pass or fail) |
| `STATUS_SUMMARY.md` | Bullet appended after each merge |
| `MEMORY.md` | `next_task_id` bumped, recent_changes prepended |
| `TASKLIST.md` / `PHASE_*_PLAN.md` | Task checked off |
| `ADVENTURES_IN_CODING.md` | Only if `ORCHESTRATOR_PERSONA_NARRATED=1` env set |

Drop any doc from `livingDocs[]` to disable updates for it.

## Notifications

Windows toast via BurntToast → falls back to `msg.exe` → falls back to `.orchestrator/notifications.log`. Three reasons:
- `progress` — task merged (default: silent)
- `approval` — sprint complete, waiting for human
- `blocked` — max retries reached or human decision required

## State / resume

`.orchestrator/state.json` tracks current sprint, task, attempt count, queue, history. Re-running `/orchestrate next` picks up where it left off.

## Reviewer output schema

Save each reviewer's response to `.orchestrator/reviews/task-<id>-attempt-<n>-<reviewer>.json` before invoking `run-gates.mjs`. Canonical shape:

```json
{
  "reviewer": "code-reviewer",
  "verdict": "approve",
  "requires_human_decision": false,
  "findings": [
    { "severity": "warn", "file": "src/x.ts", "line": 42, "message": "..." }
  ]
}
```

`verdict` is one of `approve`, `request_changes`, `block`. The legacy `{ "approved": true|false }` shape is also accepted by the gate runner for backward compatibility.

## Artifacts written under `.orchestrator/`

| Path | Written by | Purpose |
|---|---|---|
| `state.json` | various | Current sprint, task, attempt, queue (resume support) |
| `reviews/task-<id>-attempt-<n>-<reviewer>.json` | main thread | One file per reviewer, per attempt |
| `gates/task-<id>-attempt-<n>.json` | `run-gates.mjs` | Aggregated gate result; consumed by `merge-task.mjs` |
| `notifications.log` | `notify.mjs` | Fallback log when toast/msg both unavailable |

All files are UTF-8.

## Safety guarantees

- Refuses to start with a dirty working tree.
- **Never** merges to `main` automatically.
- `merge-task.mjs` refuses to merge (exit 3) unless the latest gate result file shows `passed: true`. Override only with `--force`.
- Flat branch naming (`sprint-N`, `sprint-N-task-...`) prevents git ref-tree collisions where a branch named `sprint/N` would block creation of `sprint/N/task-...`.
- Each task = exactly one sub-branch + one merge commit (`--no-ff`).
- Reviewer outputs persisted to `.orchestrator/reviews/` for audit.
- All gate failures logged to `REVIEW_LOG.md`.

## Dev / test in this folder

The skill and scripts live here as the source of truth. `install.ps1` copies them into `~/.config/opencode/`. Edit here, re-run install, restart opencode session.
