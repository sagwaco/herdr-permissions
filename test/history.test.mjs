import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory, recordHistory } from '../history.mjs';

async function state(t) {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const entry = {
  id: 'request-1', pane: 'w1:p1', agent: 'codex', cwd: '/project',
  request: 'npm test', reason: 'approved-once', probability: 0.95,
};

test('new history is empty and records contain the final outcome and model', async (t) => {
  const dir = await state(t);
  assert.deepEqual(await readHistory(dir), []);
  await recordHistory(dir, entry);
  await recordHistory(dir, { ...entry, id: 'request-2', reason: 'human-review', reviewer: 'sonnet', probability: 0.7 });
  await recordHistory(dir, { ...entry, id: 'request-3', reason: 'human-review', reviewer: 'codex', probability: 0.7 });
  await recordHistory(dir, { ...entry, id: 'request-4', reason: 'approval-delivery-unknown', reviewer: 'unknown' });
  const rows = await readHistory(dir);
  assert.deepEqual(rows.map((row) => row.id), ['request-4', 'request-3', 'request-2', 'request-1']);
  assert.deepEqual(rows.map((row) => row.outcome), ['unknown', 'manual', 'manual', 'approved']);
  assert.deepEqual(rows.map((row) => row.reviewer), ['unknown', 'codex', 'sonnet', 'jev']);
  assert.equal(rows[1].probability, 0.7);
  assert.equal(rows[3].request, 'npm test');
  assert.equal(rows[3].cwd, '/project');
  assert.ok(Number.isFinite(Date.parse(rows[0].processedAt)));
});

test('history hides the whole request when it contains a known credential', async (t) => {
  const dir = await state(t);
  for (const request of [
    'GITHUB_TOKEN=private-value npm test', '--token private-value', 'DB_PASSWORD=private-value',
    'https://user:private-value@example.org', 'mysql -pprivate-value',
    'npm_0123456789abcdef0123456789abcdef',
  ]) await recordHistory(dir, { ...entry, request, reason: 'sensitive-content', error: 'private-value' });
  await recordHistory(dir, { ...entry, cwd: '/project/token=private-value', request: 'DB_PASSWORD=private-value', reason: 'sensitive-content' });
  const raw = await readFile(join(dir, 'history', 'requests.jsonl'), 'utf8');
  assert.equal(raw.includes('private-value'), false);
  assert.equal(raw.includes('npm_0123456789abcdef0123456789abcdef'), false);
  for (const row of await readHistory(dir)) {
    assert.equal(row.request, '[Hidden: request contains credentials]');
    assert.equal(row.reviewer, 'local');
    assert.equal(row.outcome, 'manual');
  }
});

test('parallel hooks append complete records without losing requests', async (t) => {
  const dir = await state(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordHistory(dir, {
    ...entry, id: String(i), request: 'npm test\n' + 'x'.repeat(23_000),
  })));
  const rows = await readHistory(dir);
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((row) => row.id)).size, 20);
  for (const row of rows) assert.equal(row.request.length, 23_009);
});

test('history and directory stay private even when their modes were changed', async (t) => {
  const dir = await state(t);
  await recordHistory(dir, entry);
  const directory = join(dir, 'history');
  const file = join(directory, 'requests.jsonl');
  await chmod(directory, 0o755);
  await chmod(file, 0o644);
  await recordHistory(dir, entry);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('reader sorts by processing time, handles ties, and skips broken records', async (t) => {
  const dir = await state(t);
  await recordHistory(dir, entry);
  const file = join(dir, 'history', 'requests.jsonl');
  const row = { ...entry, outcome: 'approved', reviewer: 'jev' };
  await writeFile(file, [
    JSON.stringify({ ...row, id: 'new', processedAt: '2026-10-16T20:00:00.000Z' }),
    '{broken', JSON.stringify({ ...row, processedAt: 1 }), 'null',
    JSON.stringify({ ...row, processedAt: '2026-10-16T20:00:00.000Z', reviewer: {} }),
    JSON.stringify({ ...row, processedAt: '2026-10-16T20:00:00.000Z', probability: '0.99' }),
    JSON.stringify({ ...row, id: 'old', processedAt: '2026-10-16T19:00:00.000Z' }),
    JSON.stringify({ ...row, id: 'no-path', cwd: null, processedAt: '2026-10-16T18:00:00.000Z' }),
    JSON.stringify({ ...row, id: 'new-tied', processedAt: '2026-10-16T20:00:00.000Z' }),
    '{unfinished',
  ].join('\n'));
  assert.deepEqual((await readHistory(dir)).map((row) => row.id), ['new-tied', 'new', 'old', 'no-path']);
  await recordHistory(dir, { ...entry, id: 'after-interruption' });
  assert.ok((await readHistory(dir)).some((row) => row.id === 'after-interruption'));
});

test('reader limits the view to the newest 1000 records without deleting history', async (t) => {
  const dir = await state(t);
  await recordHistory(dir, entry);
  const file = join(dir, 'history', 'requests.jsonl');
  const records = Array.from({ length: 1002 }, (_, i) => JSON.stringify({
    ...entry, id: String(i), outcome: 'approved', processedAt: new Date(1792180000000 + i).toISOString(),
  }));
  await writeFile(file, records.join('\n') + '\n');
  const rows = await readHistory(dir);
  assert.equal(rows.length, 1000);
  assert.equal(rows[0].id, '1001');
  assert.equal(rows.at(-1).id, '2');
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1002);
});

test('bounded tail reads keep complete recent records and do not follow file symlinks', async (t) => {
  const dir = await state(t);
  await recordHistory(dir, entry);
  const file = join(dir, 'history', 'requests.jsonl');
  await writeFile(file, 'x'.repeat(32 * 1024 * 1024 + 32));
  await appendFile(file, '\n' + JSON.stringify({ ...entry, outcome: 'approved', processedAt: new Date().toISOString() }) + '\n');
  assert.equal((await readHistory(dir))[0].id, entry.id);
  await rm(file);
  const other = join(dir, 'other');
  await writeFile(other, 'untouched');
  await symlink(other, file);
  await assert.rejects(readHistory(dir), { code: 'ELOOP' });
  await assert.rejects(recordHistory(dir, entry), { code: 'ELOOP' });
  assert.equal(await readFile(other, 'utf8'), 'untouched');
});
