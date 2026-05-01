#!/usr/bin/env node
// resolve-tasks.mjs <target>  OR  resolve-tasks.mjs --target <target>
// target = task-id | sprint-N | phase-N | count:N | <number> | next | <fuzzy title>
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf('--target');
let target;
if (flagIdx !== -1 && argv[flagIdx + 1]) target = argv[flagIdx + 1];
else target = argv.find(a => !a.startsWith('--')) || 'next';
target = target.trim();
const cwd = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestrator.json'), 'utf8'));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Header regexes — tolerant of em/en dashes and ranges (e.g. "Sprint 3–6 — Phase 3")
const SPRINT_HEADER_RE = /^#{1,6}\s+(?:sprint|phase)\s*[-_]?\s*(\d+)(?:\s*[-–—_]\s*(\d+))?/i;
// Heading-style task: "### task-001 — title", "## task-008a - title", optional ✅ or strikethrough.
const TASK_HEADING_RE = /^#{2,6}\s+(?:~~)?task[-_\s]?([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)?)\s*[—\-–:]\s*(.+?)\s*(?:~~)?\s*$/i;
// JIRA-style heading: "### ABC-123 — title"
const JIRA_HEADING_RE = /^#{2,6}\s+(?:~~)?([A-Z]{2,}-\d+)\s*[—\-–:]\s*(.+?)\s*(?:~~)?\s*$/;
// Checkbox bullet: "- [ ] task-42: title"  (legacy format)
const CHECKBOX_TASK_RE = /^\s*-\s*\[( |x|X)\]\s+(?:task[-_\s]?|#)?(\d+|[A-Z]+-\d+)[:\s—\-–]+(.+)$/;
// Done markers in heading titles
const DONE_MARKERS_RE = /(?:✅|✔️|☑|\bDONE\b|\bCOMPLETE(?:D)?\b|\[x\]|\[X\])/;

// Parse a markdown file into tasks. Tracks `## Sprint N` / `## Phase N` (and ranges
// like `## Sprint 3–6`) so tasks under each section inherit that sprint id.
// Supports two task formats:
//   1. Heading style: `### task-001 — title` (or `### ABC-123 — title`)
//      → body = all lines until the next task heading, next sprint heading, or
//        a `---` horizontal rule.
//   2. Checkbox style (legacy): `- [ ] task-42: title`
//      → body = title only.
// `~~task-N~~`, `✅`, `[x]` in title, or `~~`-wrapped headings = done (skipped).
function parseMarkdownTasks(file, defaultSprintId) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  let currentSprint = defaultSprintId;
  let currentSprintRangeEnd = null; // for "Sprint 3–6" — tasks inherit primary id but range is recorded
  let pending = null; // accumulating-body state for heading-style tasks

  function flushPending() {
    if (!pending) return;
    pending.body = pending.bodyLines.join('\n').trim() || pending.title;
    delete pending.bodyLines;
    out.push(pending);
    pending = null;
  }

  for (const line of lines) {
    // Sprint header → flush, switch context, continue
    const sh = line.match(SPRINT_HEADER_RE);
    if (sh) {
      flushPending();
      currentSprint = sh[1];
      currentSprintRangeEnd = sh[2] || null;
      continue;
    }

    // Heading-style task (### task-NNN — title)
    const th = line.match(TASK_HEADING_RE) || line.match(JIRA_HEADING_RE);
    if (th) {
      flushPending();
      const id = th[1];
      const rawTitle = th[2];
      const isStrikethrough = /^#{2,6}\s+~~/.test(line);
      const isDoneMarker = DONE_MARKERS_RE.test(rawTitle);
      if (isStrikethrough || isDoneMarker) {
        // Skip done tasks but don't open a pending block
        pending = null;
        continue;
      }
      const title = rawTitle.replace(DONE_MARKERS_RE, '').trim();
      pending = {
        id,
        slug: slugify(title),
        title,
        source: path.basename(file),
        sprintId: currentSprint,
        sprintRangeEnd: currentSprintRangeEnd,
        bodyLines: [],
      };
      continue;
    }

    // Horizontal rule or new top-level section → close pending body
    if (pending) {
      if (/^---+\s*$/.test(line) || /^#{1,2}\s+/.test(line)) {
        flushPending();
        // Don't `continue` — let the line still be evaluated (e.g. ## Sprint headers
        // already returned above; remaining headings just terminate the pending body)
      } else {
        pending.bodyLines.push(line);
        continue;
      }
    }

    // Checkbox-style task (legacy)
    const cb = line.match(CHECKBOX_TASK_RE);
    if (cb) {
      const done = cb[1].toLowerCase() === 'x';
      if (done) continue;
      const id = cb[2];
      const title = cb[3].trim();
      out.push({
        id,
        slug: slugify(title),
        title,
        source: path.basename(file),
        sprintId: currentSprint,
        sprintRangeEnd: currentSprintRangeEnd,
        body: title,
      });
    }
  }
  flushPending();
  return out;
}

function detectSprintFromFile(file) {
  const m = file.match(/PHASE_(\d+)_PLAN/i) || file.match(/SPRINT[-_]?(\d+)/i);
  return m ? m[1] : '1';
}

function loadAllTasks() {
  const tasks = [];
  const primary = path.join(cwd, cfg.tasksSource?.primary || 'TASKLIST.md');
  if (fs.existsSync(primary)) tasks.push(...parseMarkdownTasks(primary, '1'));
  const phasePattern = cfg.tasksSource?.phasePattern || 'PHASE_*_PLAN.md';
  const re = new RegExp('^' + phasePattern.replace(/\*/g, '.*').replace(/\./g, '\\.') + '$');
  for (const f of fs.readdirSync(cwd)) {
    if (re.test(f)) tasks.push(...parseMarkdownTasks(path.join(cwd, f), detectSprintFromFile(f)));
  }
  if (tasks.length === 0 && cfg.tasksSource?.fallback === 'github') {
    try {
      const json = execSync('gh issue list --state open --json number,title,labels --limit 100', { encoding: 'utf8' });
      const issues = JSON.parse(json);
      for (const i of issues) {
        const sprintLbl = (i.labels || []).find(l => /^(sprint|phase)-\d+$/i.test(l.name));
        const sprintId = sprintLbl ? sprintLbl.name.replace(/[^\d]/g, '') : '1';
        tasks.push({ id: String(i.number), slug: slugify(i.title), title: i.title, source: 'github', sprintId, body: i.title });
      }
    } catch {}
  }
  return tasks;
}

const all = loadAllTasks();
let queue = [];
let resolution = 'none';

const mReviewSprint = target.match(/^review-sprint(?:-(\d+))?$/i);
const mCount = target.match(/^count:(\d+)$/i);
const mSprint = target.match(/^(?:sprint|phase)-(\d+)$/i);
const mTask = target.match(/^task-(.+)$/i);
const mJira = target.match(/^([A-Z]+-\d+)$/);
const mPlainNum = target.match(/^(\d+)$/);

if (mReviewSprint) {
  // Non-task target: orchestrator skill handles via review-sprint.mjs.
  // Return empty queue + signal so the caller doesn't try to dispatch builders.
  queue = [];
  resolution = 'review-sprint';
  console.log(JSON.stringify({
    target,
    resolution,
    sprintId: mReviewSprint[1] || null,
    handler: 'review-sprint.mjs',
    queue: [],
    note: 'Non-task target. Orchestrator should invoke scripts/review-sprint.mjs and follow its instructions.',
  }, null, 2));
  process.exit(0);
}

if (target === 'next') {
  queue = all.slice(0, 1);
  resolution = 'next';
} else if (mCount) {
  queue = all.slice(0, parseInt(mCount[1], 10));
  resolution = 'count';
} else if (mSprint) {
  const want = parseInt(mSprint[1], 10);
  queue = all.filter(t => {
    const start = parseInt(t.sprintId, 10);
    const end = t.sprintRangeEnd ? parseInt(t.sprintRangeEnd, 10) : start;
    return Number.isFinite(start) && want >= start && want <= end;
  });
  resolution = 'sprint';
} else if (mTask) {
  const t = all.find(x => x.id === mTask[1]);
  if (t) { queue = [t]; resolution = 'task-id'; }
} else if (mJira) {
  const t = all.find(x => x.id === mJira[1]);
  if (t) { queue = [t]; resolution = 'jira-id'; }
} else if (mPlainNum) {
  // bare number: try as task ID first, then as count
  const t = all.find(x => x.id === mPlainNum[1]);
  if (t) { queue = [t]; resolution = 'task-id'; }
  else { queue = all.slice(0, parseInt(mPlainNum[1], 10)); resolution = 'count'; }
} else {
  const lc = target.toLowerCase();
  const t = all.find(x => x.title.toLowerCase().includes(lc));
  if (t) { queue = [t]; resolution = 'fuzzy-title'; }
}

console.log(JSON.stringify({ target, resolution, totalAvailable: all.length, queue }, null, 2));
