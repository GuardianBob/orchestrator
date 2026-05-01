#!/usr/bin/env node
/**
 * import-tasks.mjs — Parse TASKS_PROPOSED.md and pipe each task to `tasklist-add --stdin`.
 *
 * Usage:
 *   node import-tasks.mjs                  # apply (creates shards)
 *   node import-tasks.mjs --dry-run        # parse + print JSON, do not invoke CLI
 *   node import-tasks.mjs --file <path>    # source file (default: TASKS_PROPOSED.md)
 *
 * Notes:
 *   - Skips the "Depends on:" field on first pass (because TASK-NNN IDs are
 *     forward-refs — gen-tasklist rejects them). After all tasks land, run
 *     a second pass to patch dependencies (see end of script).
 *   - Maps the proposed TASK-NNN numbers to whatever IDs gen-tasklist assigns
 *     (it auto-assigns from INDEX.next_task_id).
 *   - Tags are normalized to ^[a-z0-9][a-z0-9-]*$ (lowercase, dashes only).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.indexOf('--file');
const sourcePath = fileArg >= 0 ? args[fileArg + 1] : 'TASKS_PROPOSED.md';

if (!existsSync(sourcePath)) {
  console.error(`Source file not found: ${sourcePath}`);
  process.exit(2);
}

const md = readFileSync(sourcePath, 'utf8');

/**
 * Split markdown into task blocks. Each block starts with "### TASK-NNN — <title>".
 */
function splitBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^### (TASK-\d+) — (.+)$/);
    if (m) {
      if (current) blocks.push(current);
      current = { proposedId: m[1], title: m[2].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Parse a single task block. Extracts metadata line, dependencies,
 * description paragraph, and acceptance-criteria bullet list.
 */
function parseBlock(block) {
  const text = block.lines.join('\n');

  // Metadata line: **Priority:** high · **Effort:** S · **Tags:** foundation, sprint-shard-a
  const metaMatch = text.match(/\*\*Priority:\*\*\s*(\S+)\s*·\s*\*\*Effort:\*\*\s*(\S+)\s*·\s*\*\*Tags:\*\*\s*([^\n]+)/);
  if (!metaMatch) throw new Error(`${block.proposedId}: missing metadata line`);
  const [, priority, effort, tagsRaw] = metaMatch;
  const tags = tagsRaw
    .split(',')
    .map(t => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);

  // Dependencies: **Depends on:** TASK-006, TASK-008  (or "none")
  const depsMatch = text.match(/\*\*Depends on:\*\*\s*([^\n]+)/);
  const dependsOn = (depsMatch && !/^none$/i.test(depsMatch[1].trim()))
    ? depsMatch[1].split(',').map(s => s.trim()).filter(s => /^TASK-\d+$/.test(s))
    : [];

  // Description: paragraph following "**Description:**"
  const descMatch = text.match(/\*\*Description:\*\*\s*\n([\s\S]+?)(?=\n\*\*Acceptance Criteria:\*\*)/);
  if (!descMatch) throw new Error(`${block.proposedId}: missing description`);
  const description = descMatch[1].trim();

  // Acceptance criteria: bullet list following "**Acceptance Criteria:**"
  const acMatch = text.match(/\*\*Acceptance Criteria:\*\*\s*\n([\s\S]+?)(?=\n---|\n##|$)/);
  if (!acMatch) throw new Error(`${block.proposedId}: missing acceptance criteria`);
  const acceptance_criteria = acMatch[1]
    .split('\n')
    .map(l => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);

  return {
    proposedId: block.proposedId,
    dependsOn, // tracked separately for second pass
    payload: {
      title: block.title,
      priority,
      effort,
      tags,
      description,
      acceptance_criteria,
    },
  };
}

/**
 * Pipe one task payload to `tasklist-add --stdin` and return the assigned ID.
 * Parses the CLI's stdout for "Created TASK-NNN" or similar.
 */
function addTask(payload) {
  const result = spawnSync('npx', ['tasklist-add', '--stdin'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`FAILED to add "${payload.title}":`);
    console.error(result.stderr || result.stdout);
    return null;
  }
  // tasklist-add typically prints the created task ID; capture it generously
  const idMatch = (result.stdout + result.stderr).match(/TASK-\d+/);
  return idMatch ? idMatch[0] : null;
}

// --- main ---
const blocks = splitBlocks(md);
console.log(`Parsed ${blocks.length} task blocks from ${sourcePath}`);

const parsed = blocks.map(parseBlock);

if (dryRun) {
  for (const t of parsed) {
    console.log('---', t.proposedId, '---');
    console.log(JSON.stringify(t.payload, null, 2));
    if (t.dependsOn.length) console.log('  (deferred deps:', t.dependsOn.join(', '), ')');
  }
  console.log(`\nDry run complete. ${parsed.length} tasks would be created.`);
  process.exit(0);
}

const idMap = {}; // proposedId -> assignedId
const depsToPatch = []; // { assignedId, dependsOn: [proposedIds] }

for (const t of parsed) {
  const assignedId = addTask(t.payload);
  if (!assignedId) {
    console.error(`Aborting at ${t.proposedId}.`);
    process.exit(1);
  }
  idMap[t.proposedId] = assignedId;
  console.log(`  ${t.proposedId} → ${assignedId} (${t.payload.title})`);
  if (t.dependsOn.length) {
    depsToPatch.push({ assignedId, dependsOn: t.dependsOn });
  }
}

// Second pass: patch depends_on after all IDs are known
if (depsToPatch.length) {
  console.log(`\nPatching dependencies on ${depsToPatch.length} tasks...`);
  for (const { assignedId, dependsOn } of depsToPatch) {
    const resolvedDeps = dependsOn.map(p => idMap[p]).filter(Boolean);
    const shardPath = path.join('.tasks', 'tasks', `${assignedId}.json`);
    if (!existsSync(shardPath)) {
      console.error(`  Shard not found for ${assignedId}, skipping deps.`);
      continue;
    }
    const shard = JSON.parse(readFileSync(shardPath, 'utf8'));
    shard.depends_on = resolvedDeps;
    shard.updated = new Date().toISOString();
    writeFileSync(shardPath, JSON.stringify(shard, null, 2));
    console.log(`  ${assignedId}: depends_on = [${resolvedDeps.join(', ')}]`);
  }
  console.log('Running tasklist-rebuild to refresh INDEX...');
  spawnSync('npx', ['tasklist-rebuild'], { stdio: 'inherit', shell: true });
}

console.log('\nDone.');
console.log('ID mapping:', JSON.stringify(idMap, null, 2));
