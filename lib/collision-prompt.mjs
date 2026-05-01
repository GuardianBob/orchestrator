// lib/collision-prompt.mjs
// Pure-ish prompt helper for branch-setup collision handling.
// Returns the chosen option's `label` (e.g. 'resume' | 'restart' | 'abandon').
// Never calls process.exit (LD-BUG-010).
// Stream-injectable for deterministic tests (LD-PAT-001).
//
// Parameterized in TASK-011 so future consumers (merge-task, etc.) can supply
// custom headlines + options without forking the prompt loop. Defaults
// reproduce the TASK-010 behavior byte-for-byte (regression-locked by
// tests/unit/collision-prompt.test.mjs #16).

import readline from 'node:readline';

// ---------------------------------------------------------------------------
// Defaults — frozen so consumers cannot mutate the shared array.
// ---------------------------------------------------------------------------

export const DEFAULT_COLLISION_HEADLINE = 'already in-progress';

export const DEFAULT_COLLISION_OPTIONS = Object.freeze([
  Object.freeze({ key: 'r', label: 'resume',  desc: 'keep started timestamp, proceed' }),
  Object.freeze({ key: 'R', label: 'restart', desc: 'reset started to now, append notes entry', destructive: true }),
  Object.freeze({ key: 'a', label: 'abandon', desc: 'exit without creating branch (default)', default: true }),
]);

// ---------------------------------------------------------------------------
// Validation (LD-PAT-007 — validate-all-or-abort).
// Throws TypeError on any invariant violation; never returns partial state.
// ---------------------------------------------------------------------------

function validateOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new TypeError('collision-prompt: options must be a non-empty array');
  }
  const seenKeys = new Set();
  let defaults = 0;
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (!o || typeof o !== 'object') {
      throw new TypeError(`collision-prompt: options[${i}] must be an object`);
    }
    if (typeof o.key !== 'string' || o.key.length === 0) {
      throw new TypeError(`collision-prompt: options[${i}].key must be a non-empty string`);
    }
    if (typeof o.label !== 'string' || o.label.length === 0) {
      throw new TypeError(`collision-prompt: options[${i}].label must be a non-empty string`);
    }
    if (seenKeys.has(o.key)) {
      throw new TypeError(`collision-prompt: duplicate option key "${o.key}"`);
    }
    seenKeys.add(o.key);
    if (o.default === true) defaults++;
  }
  if (defaults !== 1) {
    throw new TypeError(
      `collision-prompt: exactly one option must have default:true (got ${defaults})`
    );
  }
}

// ---------------------------------------------------------------------------
// parseChoice — returns the matched option's label, or null if unrecognized.
// EOF (null/undefined) and empty input both resolve to the default option.
// ---------------------------------------------------------------------------

/**
 * @param {string|null|undefined} raw
 * @param {ReadonlyArray<{key:string,label:string,default?:boolean}>} [options]
 * @returns {string|null}  The matched option's label, or null if unrecognized.
 */
export function parseChoice(raw, options = DEFAULT_COLLISION_OPTIONS) {
  validateOptions(options);
  const defaultOpt = options.find((o) => o.default === true);

  if (raw === null || raw === undefined) return defaultOpt.label;
  const s = String(raw);
  if (s === '') return defaultOpt.label;

  // Case-sensitive exact match first (preserves r vs R distinction).
  const exact = options.find((o) => o.key === s);
  if (exact) return exact.label;

  // Case-insensitive fallback ONLY when exactly one option uses that letter.
  // Preserves TASK-010 behavior where 'A' → abandon (a's only-case sibling).
  const lower = s.toLowerCase();
  const candidates = options.filter((o) => o.key.toLowerCase() === lower);
  if (candidates.length === 1) return candidates[0].label;
  return null;
}

// ---------------------------------------------------------------------------
// buildPromptText — constructs the full multi-line prompt shown to the operator.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.taskId
 * @param {string|null} [args.currentStarted]
 * @param {string} [args.headline]
 * @param {ReadonlyArray<{key:string,label:string,desc?:string,default?:boolean}>} [args.options]
 * @returns {string}
 */
export function buildPromptText({
  taskId,
  currentStarted = null,
  headline = DEFAULT_COLLISION_HEADLINE,
  options = DEFAULT_COLLISION_OPTIONS,
} = {}) {
  validateOptions(options);
  const defaultOpt = options.find((o) => o.default === true);
  const startedSuffix = currentStarted ? ` (started ${currentStarted})` : '';

  // Width-pad labels for column alignment (matches TASK-010 layout, which
  // padded to 7 chars — the width of "abandon").
  const labelWidth = options.reduce((max, o) => Math.max(max, o.label.length), 0);

  let out = `[branch-setup] ${taskId} ${headline}${startedSuffix}.\n`;
  for (const o of options) {
    const desc = o.desc ? ` — ${o.desc}` : '';
    out += `  [${o.key}] ${o.label.padEnd(labelWidth)}${desc}\n`;
  }
  const keyList = options.map((o) => o.key).join('/');
  out += `Choice [${keyList}] (default: ${defaultOpt.key}): `;
  return out;
}

// ---------------------------------------------------------------------------
// Default ask wrapper around node:readline. Resolves to the trimmed-of-CR
// line the user typed, or null on EOF.
// ---------------------------------------------------------------------------

function defaultAsk(question, input, output) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: false });
    let answered = false;
    rl.on('close', () => {
      if (!answered) resolve(null); // EOF before any line
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      // Strip trailing CR (Windows pipes deliver \r\n; readline strips \n).
      resolve(answer.replace(/\r$/, ''));
    });
  });
}

// ---------------------------------------------------------------------------
// promptCollisionChoice — orchestrates one re-prompt on invalid input.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string|null} [opts.currentStarted]
 * @param {string} [opts.currentStatus]
 * @param {boolean} [opts.isInteractive]
 * @param {boolean} [opts.nonInteractive]
 * @param {string} [opts.headline]
 * @param {ReadonlyArray} [opts.options]
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 * @param {(q:string, input:any, output:any)=>Promise<string|null>} [opts.askFn]
 * @returns {Promise<string>}  The chosen option's `label`.
 */
export async function promptCollisionChoice(opts) {
  const {
    taskId,
    currentStarted = null,
    isInteractive,
    nonInteractive,
    headline = DEFAULT_COLLISION_HEADLINE,
    options = DEFAULT_COLLISION_OPTIONS,
    input = process.stdin,
    output = process.stderr,
    askFn = defaultAsk,
  } = opts || {};

  validateOptions(options);
  const defaultOpt = options.find((o) => o.default === true);

  const interactive = (typeof isInteractive === 'boolean')
    ? isInteractive
    : !nonInteractive;

  if (!interactive) return defaultOpt.label;

  const promptText = buildPromptText({ taskId, currentStarted, headline, options });

  // First attempt.
  const first = await askFn(promptText, input, output);
  const firstChoice = parseChoice(first, options);
  if (firstChoice !== null) return firstChoice;

  // One re-prompt on invalid input, then default (avoid infinite loop).
  const keyList = options.map((o) => o.key).join(', ');
  output.write(`[branch-setup] unrecognized choice; please enter ${keyList}.\n`);
  const second = await askFn(promptText, input, output);
  const secondChoice = parseChoice(second, options);
  if (secondChoice !== null) return secondChoice;
  return defaultOpt.label;
}

// ---------------------------------------------------------------------------
// buildRestartedShard — pure mutator (unchanged from TASK-010).
// ---------------------------------------------------------------------------

/**
 * @param {object} current
 * @param {string} nowIso
 * @returns {object}
 */
export function buildRestartedShard(current, nowIso) {
  const entry = `Restarted by orchestrator on ${nowIso}`;
  const hasNotes = typeof current.notes === 'string' && current.notes.length > 0;
  const nextNotes = hasNotes
    ? current.notes.replace(/\s+$/, '') + '\n' + entry
    : entry;
  return { ...current, started: nowIso, updated: nowIso, notes: nextNotes };
}
