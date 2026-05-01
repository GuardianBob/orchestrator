// lib/collision-prompt.mjs
// Pure-ish prompt helper for branch-setup collision handling.
// Returns 'resume' | 'restart' | 'abandon'. Never calls process.exit (LD-BUG-010).
// Stream-injectable for deterministic tests (LD-PAT-001).

import readline from 'node:readline';

/**
 * Parse a single raw answer line into a collision choice.
 * Case-sensitive on r/R per blueprint §1.
 *   'r'                       -> 'resume'
 *   'R'                       -> 'restart'
 *   'a' | 'A' | '' | null/EOF -> 'abandon'
 *   anything else             -> null  (caller decides whether to re-prompt)
 * @param {string|null|undefined} raw
 * @returns {'resume'|'restart'|'abandon'|null}
 */
export function parseChoice(raw) {
  if (raw === null || raw === undefined) return 'abandon';
  const s = String(raw);
  if (s === 'r') return 'resume';
  if (s === 'R') return 'restart';
  if (s === '' || s === 'a' || s === 'A') return 'abandon';
  return null;
}

/**
 * Build the multi-line prompt text shown to the operator.
 * @param {string} taskId
 * @param {string|null} [currentStarted]
 * @returns {string}
 */
export function buildPromptText(taskId, currentStarted) {
  const startedSuffix = currentStarted ? ` (started ${currentStarted})` : '';
  return (
    `[branch-setup] ${taskId} already in-progress${startedSuffix}.\n` +
    '  [r] resume   — keep started timestamp, proceed\n' +
    '  [R] restart  — reset started to now, append notes entry\n' +
    '  [a] abandon  — exit without creating branch (default)\n' +
    'Choice [r/R/a] (default: a): '
  );
}

/**
 * Default ask wrapper around node:readline. Resolves to the trimmed-of-CRLF
 * line the user typed, or null on EOF.
 */
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
      // Strip trailing CR (Windows pipes deliver \r\n; readline already strips \n).
      resolve(answer.replace(/\r$/, ''));
    });
  });
}

/**
 * Prompt the operator for collision resolution.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string|null} [opts.currentStarted]   ISO of existing started field.
 * @param {string} [opts.currentStatus]         Currently-set status string (informational).
 * @param {boolean} [opts.isInteractive]        Inverse of nonInteractive. If false → abandon immediately.
 * @param {boolean} [opts.nonInteractive]       Alias inverse of isInteractive. Either may be supplied.
 * @param {NodeJS.ReadableStream} [opts.input]  Default: process.stdin
 * @param {NodeJS.WritableStream} [opts.output] Default: process.stderr
 * @param {(q:string, input:any, output:any)=>Promise<string|null>} [opts.askFn]
 * @returns {Promise<'resume'|'restart'|'abandon'>}
 */
export async function promptCollisionChoice(opts) {
  const {
    taskId,
    currentStarted = null,
    isInteractive,
    nonInteractive,
    input = process.stdin,
    output = process.stderr,
    askFn = defaultAsk,
  } = opts || {};

  const interactive = (typeof isInteractive === 'boolean')
    ? isInteractive
    : !nonInteractive;

  if (!interactive) return 'abandon';

  const promptText = buildPromptText(taskId, currentStarted);

  // First attempt.
  const first = await askFn(promptText, input, output);
  const firstChoice = parseChoice(first);
  if (firstChoice !== null) return firstChoice;

  // One re-prompt on invalid input, then abandon (avoid infinite loop).
  output.write(`[branch-setup] unrecognized choice; please enter r, R, or a.\n`);
  const second = await askFn(promptText, input, output);
  const secondChoice = parseChoice(second);
  if (secondChoice !== null) return secondChoice;
  return 'abandon';
}

/**
 * Build the next shard for restart. Pure mutator — no I/O.
 * Sets started = nowIso, updated = nowIso, appends a restart note.
 * Preserves all other fields (including status — caller is responsible for state semantics).
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
