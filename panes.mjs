import { constants, readFileSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export const PANE_ID = /^w[\w-]+:p[\w-]+$/;
const FILE = 'pane.json';

function parsePane(text) {
  try {
    const row = JSON.parse(text);
    return typeof row?.pane === 'string' && PANE_ID.test(row.pane) ? row.pane : null;
  } catch { return null; }
}

// Remember the pane that runs the interface so a later action can return to it
// instead of opening another copy.
export async function savePane(stateDir, pane) {
  if (typeof pane !== 'string' || !PANE_ID.test(pane)) return false;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const file = await open(join(stateDir, FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify({ pane, recordedAt: new Date().toISOString() }));
  } finally { await file.close(); }
  return true;
}

export async function readPane(stateDir) {
  try {
    const file = await open(join(stateDir, FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return parsePane(await file.readFile('utf8')); } finally { await file.close(); }
  } catch { return null; }
}

// Cleanup runs while the process exits, so this variant is synchronous. It
// removes only its own record, so a newer pane keeps its entry.
export function clearPane(stateDir, pane) {
  if (!stateDir || typeof pane !== 'string') return;
  try {
    const path = join(stateDir, FILE);
    if (parsePane(readFileSync(path, 'utf8')) !== pane) return;
    unlinkSync(path);
  } catch { /* Stale or missing state needs no cleanup. */ }
}
