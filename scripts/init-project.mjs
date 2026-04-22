#!/usr/bin/env node
// init-project.mjs — initialize a project for orchestrator use.
// Creates .orchestrator.json (with auto-detected commands), scaffolds missing
// living docs from templates, ensures .gitignore has .orchestrator/ entry.
// One-shot, idempotent. Safe to re-run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const tplDir = path.join(__dirname, '..', 'templates');
const cfgPath = path.join(cwd, '.orchestrator.json');
const cfgTplPath = path.join(tplDir, 'orchestrator.json');
const docsTplDir = path.join(tplDir, 'living-docs');

const result = {
  configPath: cfgPath,
  configCreated: false,
  configExisted: false,
  livingDocsCreated: [],
  livingDocsSkipped: [],
  gitignoreUpdated: false,
  gitignoreAlreadyHadEntry: false,
  stateDirsCreated: [],
  config: null,
  warnings: [],
};

function detectCommands() {
  const out = { test: null, lint: null, build: null };
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '');
      const pkg = JSON.parse(raw);
      const s = pkg.scripts || {};
      if (s.test) out.test = 'npm test';
      if (s.lint) out.lint = 'npm run lint';
      if (s.build) out.build = 'npm run build';
      return out;
    }
  } catch (e) { result.warnings.push(`package.json detect: ${e.message}`); }
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
    const url = execSync('git config --get remote.origin.url', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

// 1. Config file
try {
  if (fs.existsSync(cfgPath)) {
    result.config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    result.configExisted = true;
  } else {
    const tpl = JSON.parse(fs.readFileSync(cfgTplPath, 'utf8'));
    tpl.commands = detectCommands();
    tpl.githubRepo = detectGithubRepo();
    fs.writeFileSync(cfgPath, JSON.stringify(tpl, null, 2), 'utf8');
    result.config = tpl;
    result.configCreated = true;
  }
} catch (e) {
  result.warnings.push(`config: ${e.message}`);
}

// 2. State dirs
try {
  for (const sub of ['', 'reviews', 'gates']) {
    const dir = sub ? path.join(cwd, '.orchestrator', sub) : path.join(cwd, '.orchestrator');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      result.stateDirsCreated.push(path.relative(cwd, dir).replace(/\\/g, '/'));
    }
  }
} catch (e) {
  result.warnings.push(`state dirs: ${e.message}`);
}

// 3. Living docs — only create those listed in config.livingDocs that we have templates for
try {
  const livingDocs = (result.config && Array.isArray(result.config.livingDocs)) ? result.config.livingDocs : [];
  const available = fs.existsSync(docsTplDir) ? fs.readdirSync(docsTplDir) : [];
  for (const doc of livingDocs) {
    const target = path.join(cwd, doc);
    if (fs.existsSync(target)) {
      result.livingDocsSkipped.push({ doc, reason: 'already exists' });
      continue;
    }
    if (!available.includes(doc)) {
      result.livingDocsSkipped.push({ doc, reason: 'no template' });
      continue;
    }
    const content = fs.readFileSync(path.join(docsTplDir, doc), 'utf8');
    fs.writeFileSync(target, content, 'utf8');
    result.livingDocsCreated.push(doc);
  }
} catch (e) {
  result.warnings.push(`living docs: ${e.message}`);
}

// 4. .gitignore
try {
  const giPath = path.join(cwd, '.gitignore');
  const entry = '.orchestrator/';
  let lines = [];
  if (fs.existsSync(giPath)) {
    lines = fs.readFileSync(giPath, 'utf8').split(/\r?\n/);
  }
  const has = lines.some(l => l.trim() === entry || l.trim() === '.orchestrator' || l.trim() === '/.orchestrator/' || l.trim() === '/.orchestrator');
  if (has) {
    result.gitignoreAlreadyHadEntry = true;
  } else {
    const block = (lines.length && lines[lines.length - 1] !== '' ? '\n' : '') + '# orchestrator state (reviews, gates, notifications, resume snapshot)\n' + entry + '\n';
    fs.appendFileSync(giPath, block, 'utf8');
    result.gitignoreUpdated = true;
  }
} catch (e) {
  result.warnings.push(`.gitignore: ${e.message}`);
}

console.log(JSON.stringify(result, null, 2));
