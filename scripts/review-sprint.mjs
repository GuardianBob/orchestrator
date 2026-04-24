#!/usr/bin/env node
// review-sprint.mjs --sprint <N>  [--latest]
//
// Gathers all artifacts from a completed sprint to feed the orchestrator's
// "review-sprint" workflow. Surfaces deferred items, bugs, follow-ups, and
// security backlog items from sprint completion reports + review logs that
// would otherwise be lost when the sprint merges to main.
//
// Outputs a JSON bundle the orchestrator skill consumes to interactively
// propose new tasks (with user Q&A) and append them to TASKLIST.md.
//
// Inputs scanned (best-effort, all optional):
//   .orchestrator/sprints/sprint-<N>-complete.md   (preferred)
//   .orchestrator/sprints/sprint-<N>-*.md           (any sprint artifacts)
//   .orchestrator/reviews/task-*-attempt-*-*.json   (raw reviewer findings)
//   .orchestrator/gates/task-*-attempt-*.json       (gate results w/ failures)
//   REVIEW_LOG.md                                   (aggregated history)
//   STATUS_SUMMARY.md, MEMORY.md                    (recent context)
//   TASKLIST.md                                     (existing task IDs to dedupe)

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));

const cwd = process.cwd();
const cfgPath = path.join(cwd, '.orchestrator.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const prefix = cfg.branchPrefix || 'sprint';

function shSafe(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function listSafe(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// ── Resolve sprint number ──────────────────────────────────────────────────
let sprintNum = args.sprint;
if (!sprintNum || args.latest) {
  // Try state.json first
  const state = readSafe(path.join(cwd, '.orchestrator', 'state.json'));
  if (state) {
    try {
      const j = JSON.parse(state);
      if (j.currentSprint) sprintNum = String(j.currentSprint);
      else if (j.lastCompletedSprint) sprintNum = String(j.lastCompletedSprint);
    } catch {}
  }
  // Fallback: highest sprint-N-complete.md in .orchestrator/sprints/
  if (!sprintNum) {
    const sprintsDir = path.join(cwd, '.orchestrator', 'sprints');
    const files = listSafe(sprintsDir);
    const nums = files
      .map(f => f.match(/sprint-(\d+)-complete\.md$/i))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => b - a);
    if (nums.length) sprintNum = String(nums[0]);
  }
  // Fallback: highest sprint-N branch in git
  if (!sprintNum) {
    const branches = shSafe('git branch --list "sprint-*"') || '';
    const nums = branches.split(/\r?\n/)
      .map(b => b.replace(/^\*?\s+/, '').trim().match(/^sprint-(\d+)$/))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => b - a);
    if (nums.length) sprintNum = String(nums[0]);
  }
}

if (!sprintNum) {
  console.error(JSON.stringify({
    error: 'no-sprint-resolved',
    message: 'Could not auto-detect sprint number. Pass --sprint <N> explicitly.',
  }));
  process.exit(2);
}

// ── Gather sprint artifacts ────────────────────────────────────────────────
const sprintsDir = path.join(cwd, '.orchestrator', 'sprints');
const sprintFiles = listSafe(sprintsDir)
  .filter(f => new RegExp(`^sprint-${sprintNum}(-|\\.|$)`, 'i').test(f))
  .map(f => ({ name: f, path: path.join(sprintsDir, f) }));

const completeReportPath = sprintFiles.find(f => /complete\.md$/i.test(f.name))?.path
  || path.join(sprintsDir, `sprint-${sprintNum}-complete.md`);
const completeReport = readSafe(completeReportPath);

// ── Gather reviewer findings for this sprint's tasks ───────────────────────
const reviewsDir = path.join(cwd, '.orchestrator', 'reviews');
const gatesDir = path.join(cwd, '.orchestrator', 'gates');

const reviewFiles = listSafe(reviewsDir)
  .filter(f => /^task-.+-attempt-\d+-.+\.json$/i.test(f))
  .map(f => path.join(reviewsDir, f));

const findings = [];
for (const rf of reviewFiles) {
  try {
    const j = JSON.parse(fs.readFileSync(rf, 'utf8'));
    const taskId = path.basename(rf).match(/^task-(.+?)-attempt-/)?.[1];
    if (Array.isArray(j.findings)) {
      for (const f of j.findings) {
        findings.push({
          taskId,
          reviewer: j.reviewer || path.basename(rf, '.json'),
          severity: f.severity || 'info',
          file: f.file || null,
          line: f.line || 0,
          message: f.message || String(f),
          source: path.basename(rf),
        });
      }
    }
  } catch {}
}

const gateFiles = listSafe(gatesDir)
  .filter(f => /^task-.+-attempt-\d+\.json$/i.test(f))
  .map(f => path.join(gatesDir, f));

const gateFailures = [];
for (const gf of gateFiles) {
  try {
    const j = JSON.parse(fs.readFileSync(gf, 'utf8'));
    if (j.passed === false && Array.isArray(j.failures) && j.failures.length) {
      const taskId = path.basename(gf).match(/^task-(.+?)-attempt-/)?.[1];
      gateFailures.push({ taskId, failures: j.failures, source: path.basename(gf) });
    }
  } catch {}
}

// ── Pull deferred-section excerpts from the completion report ──────────────
function extractDeferredSections(md) {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const sections = [];
  let cur = null;
  const deferredHeaderRe = /^#{2,6}\s+.*\b(deferred|backlog|follow[-\s]?up|known[-\s]?issues?|tech[-\s]?debt|cleanup|punt(ed)?|to[-\s]?do)\b/i;
  const anyHeaderRe = /^#{2,6}\s+/;
  for (const line of lines) {
    if (deferredHeaderRe.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line.replace(/^#+\s+/, '').trim(), bullets: [] };
      continue;
    }
    if (cur && anyHeaderRe.test(line)) {
      sections.push(cur);
      cur = null;
      continue;
    }
    if (cur) {
      const b = line.match(/^\s*[-*]\s+(.+)/);
      if (b) cur.bullets.push(b[1].trim());
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

const deferredSections = extractDeferredSections(completeReport);

// ── Existing task IDs (so orchestrator can avoid collisions) ───────────────
const tasklist = readSafe(path.join(cwd, cfg.tasksSource?.primary || 'TASKLIST.md')) || '';
const existingIds = Array.from(tasklist.matchAll(/task-(\d{2,})/gi)).map(m => m[1]);
const maxId = existingIds.length
  ? Math.max(...existingIds.map(n => parseInt(n, 10)).filter(Number.isFinite))
  : 0;
const nextProposedId = String(maxId + 1).padStart(3, '0');

// ── Recent context (small slices, not full files) ──────────────────────────
function tail(s, n) { if (!s) return null; const L = s.split(/\r?\n/); return L.slice(-n).join('\n'); }
const reviewLogTail = tail(readSafe(path.join(cwd, 'REVIEW_LOG.md')), 60);
const statusTail = tail(readSafe(path.join(cwd, 'STATUS_SUMMARY.md')), 40);

// ── Output bundle ──────────────────────────────────────────────────────────
const bundle = {
  sprint: sprintNum,
  resolution: {
    completionReport: completeReport ? path.relative(cwd, completeReportPath) : null,
    completionReportFound: !!completeReport,
    sprintArtifacts: sprintFiles.map(f => path.relative(cwd, f.path)),
  },
  taskCount: {
    existingTasksInList: existingIds.length,
    highestExistingId: maxId,
    nextProposedId,
  },
  deferredSections,
  reviewerFindings: {
    count: findings.length,
    bySeverity: findings.reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a; }, {}),
    items: findings.slice(0, 200),
  },
  gateFailures: {
    count: gateFailures.length,
    items: gateFailures.slice(0, 50),
  },
  recentContext: {
    reviewLogTail,
    statusTail,
  },
  instructions: {
    summary: 'Cross-reference deferredSections + reviewerFindings + gateFailures against existing tasks in TASKLIST.md to surface any work that has no task yet.',
    nextSteps: [
      '1. For each candidate item, check if a matching task already exists (by title keywords or referenced file).',
      '2. Group cohesive items into bundled tasks where appropriate.',
      '3. Ask the user (via the question tool) to confirm: which to add, sprint placement, bundle vs split.',
      '4. Append confirmed tasks to TASKLIST.md under the chosen sprint header, starting at id=' + nextProposedId + '.',
      '5. Update the Summary table in TASKLIST.md with the new task count.',
    ],
  },
};

console.log(JSON.stringify(bundle, null, 2));
