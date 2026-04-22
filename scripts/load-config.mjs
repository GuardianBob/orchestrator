#!/usr/bin/env node
// load-config.mjs — load or auto-create .orchestrator.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const cfgPath = path.join(cwd, '.orchestrator.json');
const tplPath = path.join(__dirname, '..', 'templates', 'orchestrator.json');

function detectCommands() {
  const out = { test: null, lint: null, build: null };
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const s = pkg.scripts || {};
      if (s.test) out.test = 'npm test';
      if (s.lint) out.lint = 'npm run lint';
      if (s.build) out.build = 'npm run build';
      return out;
    }
  } catch {}
  try {
    if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
      out.test = 'pytest';
      out.lint = 'ruff check .';
      return out;
    }
  } catch {}
  try {
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
      out.test = 'cargo test';
      out.lint = 'cargo clippy -- -D warnings';
      out.build = 'cargo build';
      return out;
    }
  } catch {}
  return out;
}

function detectGithubRepo() {
  try {
    const url = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

let cfg;
let created = false;
if (fs.existsSync(cfgPath)) {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} else {
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  tpl.commands = detectCommands();
  tpl.githubRepo = detectGithubRepo();
  fs.writeFileSync(cfgPath, JSON.stringify(tpl, null, 2));
  cfg = tpl;
  created = true;
}

const stateDir = path.join(cwd, '.orchestrator');
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir);
const reviewsDir = path.join(stateDir, 'reviews');
if (!fs.existsSync(reviewsDir)) fs.mkdirSync(reviewsDir);

console.log(JSON.stringify({ created, configPath: cfgPath, config: cfg }, null, 2));
