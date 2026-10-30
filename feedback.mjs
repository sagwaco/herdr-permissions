import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { HIDDEN_PATH, HIDDEN_REQUEST } from './history.mjs';
import { localReason } from './policy.mjs';

export const FEEDBACK_LABELS = {
  approve: 'should approve',
  manual: 'should take no action',
};

const FEEDBACK_FILE = 'feedback.jsonl';
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST = 24_000;
const MAX_CWD = 4_096;
const MAX_LABELS = 5_000;

// The request text is used exactly as the parser produced it. Collapsing
// whitespace would merge different arguments such as quoted values.
function requestKey(value) {
  if (typeof value !== 'string' || value === HIDDEN_REQUEST || !value.trim()) return '';
  return value;
}

// An approval label is scoped to the working directory, because the same
// command text can be harmless in a scratch checkout and destructive in a
// project. A no-action label is not scoped, so it can only make review more
// conservative. An approval label without a usable directory is never stored.
function usableCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 && cwd.length <= MAX_CWD && cwd !== HIDDEN_PATH;
}

function keyFor(label, text, cwd) {
  if (label !== 'approve') return text;
  return usableCwd(cwd) ? `${cwd}\0${text}` : null;
}

// A label is a user decision for one request. Later rows replace older rows for
// the same key; "clear" removes the decision.
export async function recordFeedback(stateDir, entry) {
  const label = entry?.label;
  const request = entry?.request;
  const cwd = entry?.cwd;
  if (!['approve', 'manual', 'clear'].includes(label)) throw new Error('invalid-feedback-label');
  if (!requestKey(request) || request.length > MAX_REQUEST) throw new Error('invalid-feedback-request');
  if (localReason(request) === 'sensitive-content') throw new Error('feedback-sensitive-content');
  if (cwd != null && (typeof cwd !== 'string' || cwd.length > MAX_CWD)) throw new Error('invalid-feedback-cwd');
  if (keyFor(label, request, cwd) === null) throw new Error('feedback-cwd-required');
  const directory = join(stateDir, 'history');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const row = { request, cwd: cwd ?? undefined, label, recordedAt: new Date().toISOString() };
  const file = await open(join(directory, FEEDBACK_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    // A leading newline separates the next record from an interrupted write.
    const buffer = Buffer.from('\n' + JSON.stringify(row) + '\n');
    const { bytesWritten } = await file.write(buffer);
    if (bytesWritten !== buffer.length) throw new Error('feedback-write-incomplete');
  } finally { await file.close(); }
}

export async function readFeedback(stateDir) {
  let file;
  try { file = await open(join(stateDir, 'history', FEEDBACK_FILE), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    const { size } = await file.stat();
    const offset = Math.max(0, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset) text = text.slice(text.indexOf('\n') + 1);
    const rows = [];
    for (const line of text.split('\n')) {
      try {
        const row = JSON.parse(line);
        if (typeof row?.request === 'string' && row.request.length <= MAX_REQUEST && requestKey(row.request)
          && (row.cwd == null || (typeof row.cwd === 'string' && row.cwd.length <= MAX_CWD))
          && ['approve', 'manual', 'clear'].includes(row.label)
          && keyFor(row.label, requestKey(row.request), row.cwd) !== null
          && localReason(row.request) !== 'sensitive-content'
          && typeof row.recordedAt === 'string' && Number.isFinite(Date.parse(row.recordedAt))) rows.push(row);
      } catch { /* A partial record must not hide the rest of the feedback. */ }
    }
    return rows;
  } finally { await file.close(); }
}

// The index keeps the newest label for each key and is bounded so a long
// history cannot grow memory without limit. Re-setting a key moves it to the
// newest position so eviction drops the least recently changed label.
export function labelIndex(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    const text = requestKey(row?.request);
    if (!text) continue;
    if (row.label === 'clear') {
      // Clear the label that this row shows: the global no-action label and
      // the approval label for its own directory.
      index.delete(text);
      const scoped = keyFor('approve', text, row.cwd);
      if (scoped) index.delete(scoped);
    } else if (['approve', 'manual'].includes(row.label)) {
      const key = keyFor(row.label, text, row.cwd);
      if (key === null) continue;
      index.delete(key);
      index.set(key, row.label);
    }
  }
  while (index.size > MAX_LABELS) index.delete(index.keys().next().value);
  return index;
}

export function labelFor(index, request, cwd) {
  const text = requestKey(request);
  if (!text) return undefined;
  if (index.get(text) === 'manual') return 'manual';
  const scoped = keyFor('approve', text, cwd);
  return scoped === null ? undefined : index.get(scoped);
}

export function precedentDecision(label) {
  if (label === 'approve') return { approve: true, reason: 'reversible', reviewer: 'user' };
  if (label === 'manual') return { approve: false, reason: 'user-precedent-manual', reviewer: 'user' };
  return null;
}

export function localPrecedent(rows, request, cwd) {
  return precedentDecision(labelFor(labelIndex(rows), request, cwd));
}
