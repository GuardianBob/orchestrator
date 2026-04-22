#!/usr/bin/env node
// notify.mjs --title <t> --body <b> --reason <progress|approval|blocked>
// Uses BurntToast on Windows; falls back to msg.exe; writes to .orchestrator/notifications.log always.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const title = args.title || 'Orchestrator';
const body = args.body || '';
const reason = args.reason || 'progress';
const cwd = process.cwd();

// Always log
const stateDir = path.join(cwd, '.orchestrator');
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir);
fs.appendFileSync(path.join(stateDir, 'notifications.log'),
  `[${new Date().toISOString()}] [${reason.toUpperCase()}] ${title} — ${body}\n`);

// Read project notification config
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestrator.json'), 'utf8')); } catch {}
const mode = cfg.notifications?.[reason] ?? 'toast';
if (mode === 'silent') {
  console.log(JSON.stringify({ delivered: 'log-only', reason, mode }));
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ delivered: 'log-only', reason, note: 'non-windows platform; install node-notifier for cross-platform toast' }));
  process.exit(0);
}

function tryBurntToast() {
  // Build PowerShell command. Escape single quotes by doubling them.
  const t = title.replace(/'/g, "''");
  const b = body.replace(/'/g, "''");
  const ps = `if (Get-Module -ListAvailable -Name BurntToast) { Import-Module BurntToast; New-BurntToastNotification -Text '${t}','${b}'; 'OK' } else { 'NOMODULE' }`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  return r.status === 0 && /OK/.test(r.stdout || '');
}

function tryMsg() {
  const r = spawnSync('msg', ['*', `${title}: ${body}`], { encoding: 'utf8' });
  return r.status === 0;
}

let delivered = 'none';
if (tryBurntToast()) delivered = 'burnttoast';
else if (tryMsg()) delivered = 'msg.exe';
else delivered = 'log-only';

console.log(JSON.stringify({ delivered, reason, title, body }));
