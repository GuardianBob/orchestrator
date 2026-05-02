// tests/fixtures/silent-loop-regression/fake-rebuild.mjs
// Minimal stand-in for `npx tasklist-rebuild`, used only by
// tests/integration/silent-infinite-loop-regression.test.mjs.
//
// Runs from the library indexDir (cwd = .tasks/, per
// lib/shard-library.mjs rebuildLibrary()). Re-derives INDEX.open_tasks by
// scanning ./tasks/*.json and excluding shards whose status is in
// DONE_STATUSES. Mirrors the production rebuild contract: INDEX is the
// projection, shard files are the source of truth.
//
// Hermetic: zero deps, no network, no npx. See blueprint §8 risk note —
// production resolver filters on INDEX row.status, so a working rebuild
// is required to close the silent-infinite-loop. This script provides it.

import fs from 'node:fs';
import path from 'node:path';

const DONE = new Set(['done', 'completed', 'archived', 'cancelled', 'closed']);
const indexDir = process.cwd();
const indexPath = path.join(indexDir, 'INDEX.json');
const shardDir = path.join(indexDir, 'tasks');

let prev = {};
try { prev = JSON.parse(fs.readFileSync(indexPath, 'utf8')) || {}; }
catch { /* fresh INDEX */ }

const open = [];
for (const name of fs.readdirSync(shardDir)) {
  if (!name.endsWith('.json')) continue;
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(shardDir, name), 'utf8')); }
  catch { continue; }
  if (!s || !s.id) continue;
  if (DONE.has(String(s.status || '').toLowerCase())) continue;
  open.push({
    id: s.id,
    title: s.title || s.id,
    status: s.status || 'backlog',
    tags: Array.isArray(s.tags) ? s.tags : [],
  });
}

const next = {
  schema_version: prev.schema_version || 1,
  generator: 'fake-rebuild (test fixture)',
  updated: new Date().toISOString(),
  open_tasks: open,
};
fs.writeFileSync(indexPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
