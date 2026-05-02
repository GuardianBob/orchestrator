#!/usr/bin/env node
// resolve-tasks.mjs <target>  OR  resolve-tasks.mjs --target <target>
// target = task-id | sprint-N | phase-N | count:N | <number> | next | <fuzzy title>
//
// Loads tasks from (in order):
//   1. cfg.shardLibraries[] — gen-tasklist style INDEX.json + per-id JSON shards
//      (consumed in config array order; primary should be first by convention).
//   2. cfg.tasksSource.primary — markdown task list (skipped if equal to any
//      lib.indexPath already consumed).
//   3. cfg.tasksSource.phasePattern matches in cwd — markdown phase plans.
//   4. github fallback (only if nothing else produced tasks).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ShardLibraryError, loadLibraries, locateShard } from '../lib/shard-library.mjs';

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf('--target');
let target;
if (flagIdx !== -1 && argv[flagIdx + 1]) target = argv[flagIdx + 1];
else target = argv.find(a => !a.startsWith('--')) || 'next';
target = target.trim();
const cwd = process.cwd();
const cfgPath = path.join(cwd, '.orchestrator.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
// Attach shardLibraries the same way load-config.mjs does — single source of truth.
cfg.shardLibraries = loadLibraries(cfgPath);

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
  let currentSprintRangeEnd = null;
  let pending = null;

  function flushPending() {
    if (!pending) return;
    pending.body = pending.bodyLines.join('\n').trim() || pending.title;
    delete pending.bodyLines;
    out.push(pending);
    pending = null;
  }

  for (const line of lines) {
    const sh = line.match(SPRINT_HEADER_RE);
    if (sh) {
      flushPending();
      currentSprint = sh[1];
      currentSprintRangeEnd = sh[2] || null;
      continue;
    }

    const th = line.match(TASK_HEADING_RE) || line.match(JIRA_HEADING_RE);
    if (th) {
      flushPending();
      const id = th[1];
      const rawTitle = th[2];
      const isStrikethrough = /^#{2,6}\s+~~/.test(line);
      const isDoneMarker = DONE_MARKERS_RE.test(rawTitle);
      if (isStrikethrough || isDoneMarker) {
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

    if (pending) {
      if (/^---+\s*$/.test(line) || /^#{1,2}\s+/.test(line)) {
        flushPending();
      } else {
        pending.bodyLines.push(line);
        continue;
      }
    }

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

// gen-tasklist style: INDEX.json with `open_tasks[]`, sibling shard files at
// `<library.shardDir>/<id>.json`. Sprint membership encoded as `sprint-N` tag.
// `source` field is set to `library.id` (unique by validation contract).
function parseShardLibrary(lib) {
  const out = [];
  let idx;
  try { idx = JSON.parse(fs.readFileSync(lib.indexPath, 'utf8')); }
  catch (e) {
    console.error(`[resolve-tasks] WARN: failed to read/parse ${lib.indexPath}: ${e.message}. Library '${lib.id}' will contribute zero tasks.`);
    return out;
  }
  if (!idx || !Array.isArray(idx.open_tasks)) {
    console.error(`[resolve-tasks] WARN: ${lib.indexPath} has no \`open_tasks\` array; library '${lib.id}' will contribute zero tasks.`);
    return out;
  }
  const DONE_STATUSES = new Set(['done', 'completed', 'archived', 'cancelled', 'closed']);
  for (const row of idx.open_tasks) {
    if (!row || !row.id) continue;
    if (DONE_STATUSES.has(String(row.status || '').toLowerCase())) continue;
    const sprintTag = (row.tags || []).find(t => /^sprint-\d+$/i.test(t));
    const sprintId = sprintTag ? sprintTag.replace(/[^\d]/g, '') : '1';
    // Delegate path resolution to locateShard — routes through validateShardId
    // (TASK-003) to block path-traversal IDs (e.g. '../../etc/passwd') from
    // escaping lib.shardDir. Returns null on missing; throws ShardLibraryError
    // (incl. ShardValidationError) on invalid id.
    let shardPath;
    try {
      shardPath = locateShard(lib, row.id);
    } catch (e) {
      if (e instanceof ShardLibraryError) {
        console.error(`[resolve-tasks] WARN: skipping task with unsafe id "${row.id}" in ${lib.indexPath}: ${e.message}`);
        continue;
      }
      throw e;
    }
    let shard = null;
    if (shardPath !== null) {
      try { shard = JSON.parse(fs.readFileSync(shardPath, 'utf8')); }
      catch (e) {
        console.error(`[resolve-tasks] WARN: failed to parse shard ${shardPath}: ${e.message}. Falling back to INDEX summary (no description, no acceptance criteria).`);
      }
    } else {
      console.error(`[resolve-tasks] WARN: shard for ${row.id} is missing under ${lib.shardDir}; will dispatch with title-only body (no description, no acceptance criteria). Run \`npx tasklist-rebuild\` to repair.`);
    }
    // --- TASK-028: shard-status safety net (LD-ARC-002) -----------------------
    // shard.status is authoritative; INDEX row.status is a derived projection
    // that can drift when `npx tasklist-rebuild` fails or is skipped. If the
    // shard says terminal but INDEX still lists the row as open, refuse to
    // re-queue the task and warn loudly to stderr (LD-PAT-007).
    if (shard && shard.status) {
      const shardStatus = String(shard.status).toLowerCase();
      if (DONE_STATUSES.has(shardStatus)) {
        const indexStatus = String(row.status || 'unknown').toLowerCase();
        console.warn(
          `[resolver] shard drift: ${row.id} status=${shardStatus} in shard but INDEX says ${indexStatus}; skipping. Run: npx tasklist-rebuild`
        );
        continue;
      }
    }
    // --------------------------------------------------------------------------
    const title = (shard && shard.title) || row.title || row.id;
    const bodyParts = [`# ${row.id}: ${title}`, ''];
    if (shard?.priority) bodyParts.push(`**Priority:** ${shard.priority}  **Effort:** ${shard.effort || '?'}`);
    if (shard?.tags?.length) bodyParts.push(`**Tags:** ${shard.tags.join(', ')}`);
    if (shard?.depends_on?.length) bodyParts.push(`**Depends on:** ${shard.depends_on.join(', ')}`);
    if (shard?.description) { bodyParts.push('', '## Description', '', shard.description); }
    if (shard?.acceptance_criteria?.length) {
      bodyParts.push('', '## Acceptance Criteria', '');
      for (const ac of shard.acceptance_criteria) bodyParts.push(`- ${ac}`);
    }
    out.push({
      id: row.id,
      slug: slugify(title),
      title,
      source: lib.id,
      sprintId,
      sprintRangeEnd: null,
      body: bodyParts.join('\n').trim(),
    });
  }
  return out;
}

function loadAllTasks() {
  const tasks = [];
  const consumedIndexPaths = new Set();

  // 1. Sharded libraries — primary-count validation (LD-PAT-007)
  const primaries = cfg.shardLibraries.filter(l => l.primary === true);
  if (primaries.length === 0) {
    throw new ShardLibraryError(
      'resolve-tasks: no shardLibraries entry has primary:true. ' +
      'Mark exactly one library as primary in .orchestrator.json.'
    );
  }
  if (primaries.length > 1) {
    throw new ShardLibraryError(
      `resolve-tasks: multiple primary libraries: ${primaries.map(l => l.id).join(', ')}. ` +
      'Exactly one library must have primary:true.'
    );
  }

  for (const lib of cfg.shardLibraries) {
    if (fs.existsSync(lib.indexPath)) {
      tasks.push(...parseShardLibrary(lib));
    }
    consumedIndexPaths.add(path.resolve(lib.indexPath));
  }

  // 2. Markdown primary (dedup against any shard library indexPath)
  const primary = path.resolve(cwd, cfg.tasksSource?.primary || 'TASKLIST.md');
  if (!consumedIndexPaths.has(primary) && fs.existsSync(primary)) {
    tasks.push(...parseMarkdownTasks(primary, '1'));
  }

  // 3. Phase-pattern files
  const phasePattern = cfg.tasksSource?.phasePattern || 'PHASE_*_PLAN.md';
  const re = new RegExp('^' + phasePattern.replace(/\*/g, '.*').replace(/\./g, '\\.') + '$');
  for (const f of fs.readdirSync(cwd)) {
    if (re.test(f)) tasks.push(...parseMarkdownTasks(path.join(cwd, f), detectSprintFromFile(f)));
  }

  // 4. GitHub fallback
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
  const t = all.find(x => x.id === mPlainNum[1]);
  if (t) { queue = [t]; resolution = 'task-id'; }
  else { queue = all.slice(0, parseInt(mPlainNum[1], 10)); resolution = 'count'; }
} else {
  const lc = target.toLowerCase();
  const t = all.find(x => x.title.toLowerCase().includes(lc));
  if (t) { queue = [t]; resolution = 'fuzzy-title'; }
}

console.log(JSON.stringify({ target, resolution, totalAvailable: all.length, queue }, null, 2));
