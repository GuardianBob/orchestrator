## Lessons library — MANDATORY pre-reading

Before writing **any plugin code or design doc**, consult `C:\Coding\ai_dev\knowledgebase\.plugin-lessons`.

**Entry point:** `C:\Coding\ai_dev\knowledgebase\.plugin-lessons\AGENT_GUIDE.md`. It defines the controlled vocabulary of nine **concerns** (`repo-meta`, `design-docs`, `lib-core`, `skill-package`, `cli-scripts`, `hooks`, `install`, `ci-tests`, `loader-integration`) and tells you how to look up the lessons that apply to your task.

**Lesson lookup workflow:** follow `C:\Coding\ai_dev\knowledgebase\.plugin-lessons\AGENT_GUIDE.md` §§ 1–4.

**Pre-merge gate:** every lesson under your task's concerns must pass its `acceptance_test`. The orchestrator records this in `.orchestrator/gates/task-NNN-attempt-N.json`.

**Adding a lesson:** create `LD-<CAT>-NNN-<slug>.json` (categories: `ARC`, `BUG`, `CLI`, `LDR`, `PAT`, `TOK`, `XPL`). See `AGENT_GUIDE.md` § 8 for schema; regenerate indexes after — **do not hand-edit `INDEX.json` or `INDEX.md`**.

---

## Orchestrator workflow

Tasks are executed by the sub-agent team defined in `.orchestrator.json`. See that file for agent roster, branch config, retry policy, and living-doc list.

When the user says "/orchestrate" or "have the team complete the next N tasks", load the `orchestrator` skill and follow its build → review → merge → next-task loop.

---

## Task tracking — .tasks/ library

This project uses `gen-tasklist` for sharded task tracking. Full reference: **`.tasks/AGENT_GUIDE.md`** (read order, CLI usage, field reference, status flow, hard rules).

Use `.tasks/` for all implementation work on this plugin — features, bugs, spikes, refactors.

---

## Absolute prohibitions

These are hard rules. Do not break them, ever:

1. **Hand-edit `C:\Coding\ai_dev\knowledgebase\.plugin-lessons\INDEX.json` or `C:\Coding\ai_dev\knowledgebase\.plugin-lessons\INDEX.md`** — derived views, regenerated from `LD-*.json` files. See `AGENT_GUIDE.md` § 9.
2. **Hardcode path separators** — always `path.join` / `path.resolve`. Never `/` or `\\` as a literal.