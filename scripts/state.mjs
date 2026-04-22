#!/usr/bin/env node
// state.mjs --get | --set <json> | --update <key=value>
import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const stateDir = path.join(cwd, '.orchestrator');
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir);
const statePath = path.join(stateDir, 'state.json');

function load() {
  if (!fs.existsSync(statePath)) return { sprintId: null, currentTask: null, attempt: 0, queue: [], history: [] };
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function save(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }

const args = process.argv.slice(2);
if (args[0] === '--get') {
  console.log(JSON.stringify(load(), null, 2));
} else if (args[0] === '--set') {
  const next = JSON.parse(args[1]);
  save(next);
  console.log(JSON.stringify(next, null, 2));
} else if (args[0] === '--update') {
  const s = load();
  for (const kv of args.slice(1)) {
    const [k, ...rest] = kv.split('=');
    let v = rest.join('=');
    try { v = JSON.parse(v); } catch {}
    s[k] = v;
  }
  save(s);
  console.log(JSON.stringify(s, null, 2));
} else if (args[0] === '--reset') {
  save({ sprintId: null, currentTask: null, attempt: 0, queue: [], history: [] });
  console.log(JSON.stringify(load(), null, 2));
} else {
  console.error('usage: state.mjs --get | --set <json> | --update key=value... | --reset');
  process.exit(1);
}
