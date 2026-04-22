#!/usr/bin/env node
// run-gates.mjs --task <id> [--attempt <n>]
// Runs configured test/lint/build, aggregates reviewer JSON outputs, writes REVIEW_LOG.md row.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const cwd = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestrator.json'), 'utf8'));
const taskId = args.task;
const attempt = parseInt(args.attempt || '1', 10);

function runCmd(cmd) {
  if (!cmd) return { skipped: true };
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd });
  return { cmd, exitCode: r.status, stdout: (r.stdout || '').slice(-2000), stderr: (r.stderr || '').slice(-2000), passed: r.status === 0 };
}

const gates = {
  test: runCmd(cfg.commands?.test),
  lint: runCmd(cfg.commands?.lint),
  build: runCmd(cfg.commands?.build),
};

// Load reviewer outputs
const reviewsDir = path.join(cwd, '.orchestrator', 'reviews');
const reviews = [];
if (fs.existsSync(reviewsDir)) {
  for (const f of fs.readdirSync(reviewsDir)) {
    if (f.startsWith(`task-${taskId}-attempt-${attempt}`) && f.endsWith('.json')) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(reviewsDir, f), 'utf8'));
        reviews.push({ file: f, ...r });
      } catch (e) {
        reviews.push({ file: f, parseError: e.message });
      }
    }
  }
}

// Reviewer schema (canonical):
//   { reviewer: "<name>", verdict: "approve" | "request_changes" | "block",
//     requires_human_decision?: bool, findings?: [{severity, message, file?, line?}] }
// Also accepted (legacy): { approved: true|false }
function reviewApproved(r) {
  if (r.verdict) return r.verdict === 'approve';
  if (typeof r.approved === 'boolean') return r.approved;
  return false;
}
function reviewLabel(r) {
  if (r.verdict) return r.verdict;
  if (typeof r.approved === 'boolean') return r.approved ? 'approve' : 'request_changes';
  return 'unknown';
}

const reviewerVerdicts = reviews.map(reviewLabel);
const reviewerPassed = reviews.length > 0 && reviews.every(reviewApproved);
const requiresHuman = reviews.some(r => r.requires_human_decision === true);

const failures = [];
if (gates.test.passed === false) failures.push('test');
if (gates.lint.passed === false) failures.push('lint');
if (gates.build.passed === false) failures.push('build');
if (!reviewerPassed) failures.push('review');
if (requiresHuman) failures.push('human-decision');

const passed = failures.length === 0;

// Append REVIEW_LOG.md
const log = path.join(cwd, 'REVIEW_LOG.md');
if (!fs.existsSync(log)) fs.writeFileSync(log, '# Review Log\n\n| Date | Task | Attempt | Test | Lint | Build | Review | Verdict | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
const fmt = g => g.skipped ? 'skip' : (g.passed ? 'pass' : 'FAIL');
const notes = reviews.flatMap(r => (r.findings || []).slice(0, 3).map(f => `${f.severity || '?'}:${f.message || ''}`)).join('; ').slice(0, 200);
const row = `| ${new Date().toISOString().slice(0,16)} | ${taskId} | ${attempt} | ${fmt(gates.test)} | ${fmt(gates.lint)} | ${fmt(gates.build)} | ${reviewerVerdicts.join(',') || 'none'} | ${passed ? 'PASS' : 'FAIL'} | ${notes.replace(/\|/g,'\\|')} |\n`;
fs.appendFileSync(log, row);

console.log(JSON.stringify({ passed, failures, requiresHuman, gates, reviews }, null, 2));

// Persist gate result so merge-task can verify before merging
const gatesDir = path.join(cwd, '.orchestrator', 'gates');
if (!fs.existsSync(gatesDir)) fs.mkdirSync(gatesDir, { recursive: true });
fs.writeFileSync(
  path.join(gatesDir, `task-${taskId}-attempt-${attempt}.json`),
  JSON.stringify({ passed, failures, requiresHuman, attempt, taskId, timestamp: new Date().toISOString() }, null, 2)
);

process.exit(passed ? 0 : 1);
