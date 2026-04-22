---
description: Orchestrate sub-agent teams to complete tasks/tickets with peer review, auto-merge, and notifications. Usage — /orchestrate init  |  /orchestrate task-42  |  /orchestrate sprint-3  |  /orchestrate count:5  |  /orchestrate next
agent: build
---

Activate the **orchestrator** skill for target: **$ARGUMENTS**.

Targets supported:
- `init` — one-shot project setup: writes `.orchestrator.json` with auto-detected commands, scaffolds missing living docs from templates, adds `.orchestrator/` to `.gitignore`. Does NOT start any task work. Idempotent.
- `task-<id>` (or bare `<id>`) — run one specific task
- `sprint-<N>` — run every task under `## Sprint N` / `## Phase N`
- `count:<N>` — run the next N tasks
- `next` — run one task, then stop

If target is `init`, run `node {SKILL_DIR}/../scripts/init-project.mjs`, show me the result, suggest fields to review in `.orchestrator.json` (especially `builderAgents` and `reviewerAgents`), and STOP. Do not resolve tasks, do not branch, do not dispatch agents.

Otherwise follow the skill's step-by-step workflow exactly:
1. Load `.orchestrator.json` (create with defaults if missing) and SHOW me the config before starting.
2. Resolve the target into an ordered task queue.
3. For each task: create `sprint-<N>-task-<id>-<slug>` branch off `sprint-<N>` → dispatch builders via Task tool → commit → dispatch reviewers via Task tool (canonical JSON: `{reviewer, verdict, requires_human_decision?, findings?}`) → save each reviewer's output to `.orchestrator/reviews/task-<id>-attempt-<n>-<reviewer>.json` → run gates → loop on failure (up to `maxRetries`) or merge into sprint branch on success. `merge-task.mjs` will refuse to merge unless gates passed.
4. Update all configured living docs after every merge.
5. Send desktop notifications on: blocked task, human-decision-required (`verdict: block` or explicit flag), sprint complete.
6. STOP after the queue is exhausted, or after a sprint completes (do not merge sprint→main without my approval).

Project root: !`pwd`
Current branch: !`git branch --show-current 2>$null`
Existing config: !`if (Test-Path .orchestrator.json) { Get-Content .orchestrator.json -Raw } else { 'NONE — will be auto-created' }`
