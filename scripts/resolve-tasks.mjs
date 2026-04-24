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

// Parse a markdown file into tasks. Tracks `## Sprint N` / `## Phase N` headers
// so tasks under each section inherit that sprint id. Falls back to defaultSprintId.
function parseMarkdownTasks(file, defaultSprintId) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  let currentSprint = defaultSprintId;
  for (const line of lines) {
    const h = line.match(/^#{1,6}\s+(?:sprint|phase)\s*[-_]?\s*(\d+)/i);
    if (h) { currentSprint = h[1]; continue; }
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s+(?:task-|#)?(\d+|[A-Z]+-\d+)[:\s-]+(.+)$/);
    if (!m) continue;
    const done = m[1].toLowerCase() === 'x';
    if (done) continue;
    const id = m[2];
    const title = m[3].trim();
    out.push({ id, slug: slugify(title), title, source: path.basename(file), sprintId: currentSprint, body: title });
  }
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
  queue = all.filter(t => t.sprintId === mSprint[1]);
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
