#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function validateFixture({ kind }) {
  const base = join(ROOT, 'tests', 'fixtures', `${kind}s-fixture`, `.${kind}s`);
  const shardDir = join(base, `${kind}s`);
  const schemaPath = join(base, 'schemas', `${kind}.schema.json`);
  const indexPath = join(base, 'INDEX.json');
  const indexSchemaPath = join(base, 'schemas', 'index.schema.json');

  const ajv = makeAjv();
  const validateShard = ajv.compile(loadJson(schemaPath));
  const validateIndex = ajv.compile(loadJson(indexSchemaPath));

  let failed = 0;
  for (const f of readdirSync(shardDir).filter((n) => n.endsWith('.json'))) {
    const data = loadJson(join(shardDir, f));
    if (!validateShard(data)) {
      console.error(`FAIL ${kind}/${f}:`, validateShard.errors);
      failed++;
    }
  }
  const idx = loadJson(indexPath);
  if (!validateIndex(idx)) {
    console.error(`FAIL ${kind}s INDEX.json:`, validateIndex.errors);
    failed++;
  }
  console.log(`${kind}s-fixture: ${failed === 0 ? 'OK' : `${failed} failures`}`);
  return failed;
}

const total = validateFixture({ kind: 'task' }) + validateFixture({ kind: 'issue' });
process.exit(total === 0 ? 0 : 1);
