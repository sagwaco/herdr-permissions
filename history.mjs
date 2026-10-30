import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { localReason } from './policy.mjs';

const HISTORY_FILE = 'requests.jsonl';
const MAX_READ_BYTES = 32 * 1024 * 1024;

export const HIDDEN_REQUEST = '[Hidden: request contains credentials]';
export const HIDDEN_PATH = '[Hidden: path contains credentials]';
// Reasons that delivered a one-time approval key.
const APPROVED = new Set(['approved-once', 'approved-by-human']);

export async function recordHistory(stateDir, entry) {
  const directory = join(stateDir, 'history');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const sensitive = localReason(entry.request) === 'sensitive-content';
  const row = {
    id: entry.id, processedAt: new Date().toISOString(), pane: entry.pane,
    agent: entry.agent,
    cwd: localReason(entry.cwd ?? '') === 'sensitive-content' ? HIDDEN_PATH : entry.cwd,
    request: sensitive ? HIDDEN_REQUEST : entry.request,
    outcome: APPROVED.has(entry.reason) ? 'approved'
      : entry.reason === 'approval-delivery-unknown' ? 'unknown' : 'manual',
    reason: entry.reason, detail: entry.detail,
    reviewer: entry.reviewer ?? (['sensitive-content', 'human-only-action'].includes(entry.reason) ? 'local' : 'jev'),
    probability: entry.probability,
  };
  const file = await open(join(directory, HISTORY_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    // A leading newline separates the next record from an interrupted write.
    const buffer = Buffer.from('\n' + JSON.stringify(row) + '\n');
    const { bytesWritten } = await file.write(buffer);
    if (bytesWritten !== buffer.length) throw new Error('history-write-incomplete');
  } finally { await file.close(); }
}

export async function readHistory(stateDir) {
  let file;
  try { file = await open(join(stateDir, 'history', HISTORY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW); }
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
        if (typeof row?.id === 'string' && typeof row.request === 'string' && row.request.length <= 24_000
          && typeof row.processedAt === 'string' && Number.isFinite(Date.parse(row.processedAt))
          && ['approved', 'manual', 'unknown'].includes(row.outcome)
          && ['pane', 'agent', 'cwd', 'reason', 'detail', 'reviewer'].every((key) => row[key] == null || (typeof row[key] === 'string' && row[key].length <= 24_000))
          && (row.probability === undefined || (Number.isFinite(row.probability) && row.probability >= 0 && row.probability <= 1))) rows.push(row);
      } catch { /* A partial record must not hide the rest of the history. */ }
    }
    // shortcut: show the latest 1000 records from the last 32 MiB; add paging if needed.
    return rows.reverse().sort((a, b) => Date.parse(b.processedAt) - Date.parse(a.processedAt)).slice(0, 1000);
  } finally { await file.close(); }
}
