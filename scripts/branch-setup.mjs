#!/usr/bin/env node
// branch-setup.mjs --sprint <N> --task <id> --slug <slug>
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.orchestrator.json'), 'utf8'));
const prefix = cfg.branchPrefix || 'sprint';
// Flat hyphenated naming — git refs cannot have a branch and a sub-namespace
// with the same root, so we keep everything as siblings.
const sprintBranch = `${prefix}-${args.sprint}`;
const taskBranch = `${sprintBranch}-task-${args.task}-${args.slug}`;

function sh(cmd) { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function shSafe(cmd) { try { return sh(cmd); } catch (e) { return null; } }

function branchExists(name) {
  return shSafe(`git rev-parse --verify ${name}`) !== null;
}

const baseBranch = shSafe('git symbolic-ref --short refs/remotes/origin/HEAD')?.replace('origin/', '') || 'main';

// Stash any dirty changes — orchestrator must control commits
const status = shSafe('git status --porcelain') || '';
if (status.trim()) {
  console.error(JSON.stringify({ error: 'Working tree dirty. Commit or stash before orchestrating.', status }));
  process.exit(2);
}

if (!branchExists(sprintBranch)) {
  sh(`git checkout ${baseBranch}`);
  shSafe(`git pull --ff-only`);
  sh(`git checkout -b ${sprintBranch}`);
}

if (branchExists(taskBranch)) {
  sh(`git checkout ${taskBranch}`);
} else {
  sh(`git checkout ${sprintBranch}`);
  sh(`git checkout -b ${taskBranch}`);
}

console.log(JSON.stringify({ sprintBranch, taskBranch, baseBranch, current: sh('git branch --show-current') }, null, 2));
