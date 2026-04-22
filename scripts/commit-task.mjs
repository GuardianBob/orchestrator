#!/usr/bin/env node
// commit-task.mjs --task <id> --slug <slug> --title <title>
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const cwd = process.cwd();

function sh(cmd) { return execSync(cmd, { encoding: 'utf8' }).trim(); }
function shSafe(cmd) { try { return sh(cmd); } catch { return null; } }

const status = shSafe('git status --porcelain') || '';
if (!status.trim()) {
  console.log(JSON.stringify({ skipped: true, reason: 'no changes to commit' }));
  process.exit(0);
}

sh('git add -A');
const msg = `feat(task-${args.task}): ${args.title}`;
const tmp = path.join(cwd, '.orchestrator', `commit-msg-${args.task}.txt`);
fs.writeFileSync(tmp, msg + '\n\nAuto-committed by orchestrator skill.\n');
sh(`git commit -F "${tmp}"`);
fs.unlinkSync(tmp);

const sha = sh('git rev-parse --short HEAD');
const branch = sh('git branch --show-current');

// Append to GIT_COMMITS.md
const gc = path.join(cwd, 'GIT_COMMITS.md');
const entry = `\n## ${new Date().toISOString().slice(0, 10)} \`${sha}\` ${branch}\n${msg}\n`;
fs.appendFileSync(gc, entry);

console.log(JSON.stringify({ sha, branch, message: msg }, null, 2));
