#!/usr/bin/env node
// merge-sprint.mjs --sprint <N>   (only run AFTER user approval)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeErrorMessage } from '../lib/sanitize-error.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const cwd = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestrator.json'), 'utf8'));
const prefix = cfg.branchPrefix || 'sprint';
const sprintBranch = `${prefix}-${args.sprint}`;

function sh(cmd) { return execSync(cmd, { encoding: 'utf8' }).trim(); }
function shSafe(cmd) { try { return sh(cmd); } catch { return null; } }

const baseBranch = shSafe('git symbolic-ref --short refs/remotes/origin/HEAD')?.replace('origin/', '') || 'main';

sh(`git checkout ${baseBranch}`);
shSafe('git pull --ff-only');
try {
  sh(`git merge --no-ff ${sprintBranch} -m "merge(${sprintBranch}): sprint complete"`);
} catch (e) {
  console.error(JSON.stringify({ error: 'sprint merge failed', detail: sanitizeErrorMessage(e) }));
  process.exit(2);
}

console.log(JSON.stringify({ merged: sprintBranch, into: baseBranch, current: sh('git branch --show-current') }, null, 2));
