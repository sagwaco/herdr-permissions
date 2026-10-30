import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  labelFor, labelIndex, localPrecedent, readFeedback, recordFeedback,
} from '../feedback.mjs';
import { HIDDEN_PATH, HIDDEN_REQUEST } from '../history.mjs';

async function state(t) {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-feedback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const row = (request, label, cwd, recordedAt = new Date().toISOString()) => ({ request, label, cwd, recordedAt });

test('labels are stored and the latest label for a request wins', async (t) => {
  const dir = await state(t);
  assert.deepEqual(await readFeedback(dir), []);
  await recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'approve' });
  await recordFeedback(dir, { request: '$ npm run build', cwd: '/project', label: 'manual' });
  await recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'manual' });
  const rows = await readFeedback(dir);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cwd, '/project');
  const index = labelIndex(rows);
  assert.equal(labelFor(index, '$ npm test', '/project'), 'manual');
  // A no-action label is not scoped to a directory.
  assert.equal(labelFor(index, '$ npm test', '/other'), 'manual');
  assert.equal(labelFor(index, '$ npm test'), 'manual');
  await recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'clear' });
  assert.equal(labelFor(labelIndex(await readFeedback(dir)), '$ npm test', '/project'), undefined);
  assert.equal(labelFor(labelIndex(await readFeedback(dir)), '$ npm test', '/other'), undefined);
});

test('an approval label applies only to the same text in the same directory', async (t) => {
  const dir = await state(t);
  await recordFeedback(dir, { request: '$ rm -rf build', cwd: '/scratch', label: 'approve' });
  const rows = await readFeedback(dir);
  const index = labelIndex(rows);
  assert.equal(labelFor(index, '$ rm -rf build', '/scratch'), 'approve');
  assert.equal(labelFor(index, '$ rm -rf build', '/project'), undefined);
  assert.deepEqual(localPrecedent(rows, '$ rm -rf build', '/scratch'), { approve: true, reason: 'reversible', reviewer: 'user' });
  assert.equal(localPrecedent(rows, '$ rm -rf build', '/project'), null);
  assert.equal(localPrecedent(rows, '$ rm -rf build/ ', '/scratch'), null);
  assert.equal(localPrecedent(rows, '$   rm   -rf build', '/scratch'), null);
  assert.deepEqual(localPrecedent([row('$ npm publish', 'manual')], '$ npm publish', '/anywhere'), {
    approve: false, reason: 'user-precedent-manual', reviewer: 'user',
  });
});

test('a no-action label wins over an approval label for the same request', (t) => {
  const index = labelIndex([
    row('$ npm test', 'approve', '/project', '2026-10-30T10:00:00.000Z'),
    row('$ npm test', 'manual', undefined, '2026-10-30T11:00:00.000Z'),
  ]);
  assert.equal(labelFor(index, '$ npm test', '/project'), 'manual');
});

test('labels never include a credential and stored sensitive rows are ignored', async (t) => {
  const dir = await state(t);
  const file = join(dir, 'history', 'feedback.jsonl');
  await assert.rejects(recordFeedback(dir, { request: 'GITHUB_TOKEN=private-value npm test', cwd: '/project', label: 'approve' }), /feedback-sensitive-content/);
  await assert.rejects(recordFeedback(dir, { request: '--token private-value', label: 'manual' }), /feedback-sensitive-content/);
  await recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'approve' });
  assert.equal((await readFile(file, 'utf8')).includes('private-value'), false);
  await appendFile(file, JSON.stringify(row('DB_PASSWORD=private-value', 'approve', '/project')) + '\n');
  const rows = await readFeedback(dir);
  assert.equal(rows.length, 1);
  assert.equal(labelFor(labelIndex(rows), 'DB_PASSWORD=private-value', '/project'), undefined);
});

test('labels reject hidden requests, empty text, unknown labels, and long paths', async (t) => {
  const dir = await state(t);
  await recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'approve' });
  await assert.rejects(recordFeedback(dir, { request: HIDDEN_REQUEST, cwd: '/project', label: 'approve' }), /invalid-feedback-request/);
  await assert.rejects(recordFeedback(dir, { request: '   ', label: 'approve' }), /invalid-feedback-request/);
  await assert.rejects(recordFeedback(dir, { request: '$ npm test', label: 'maybe' }), /invalid-feedback-label/);
  await assert.rejects(recordFeedback(dir, { request: '$ npm test', cwd: '/'.repeat(4_097), label: 'approve' }), /invalid-feedback-cwd/);
  assert.equal((await readFeedback(dir)).length, 1);
  assert.equal(labelFor(labelIndex(await readFeedback(dir)), HIDDEN_REQUEST, '/project'), undefined);
});

test('human-only requests can be labeled, but an approval needs a directory', async (t) => {
  const dir = await state(t);
  await recordFeedback(dir, { request: 'git push origin main', cwd: '/project', label: 'manual' });
  assert.equal(labelFor(labelIndex(await readFeedback(dir)), 'git push origin main', '/project'), 'manual');
  await recordFeedback(dir, { request: '$ npm test', label: 'manual' });
  for (const cwd of [undefined, '', HIDDEN_PATH]) {
    await assert.rejects(recordFeedback(dir, { request: '$ npm test', cwd, label: 'approve' }), /feedback-cwd-required/);
  }
  await appendFile(join(dir, 'history', 'feedback.jsonl'), JSON.stringify(row('$ no directory', 'approve')) + '\n');
  const index = labelIndex(await readFeedback(dir));
  assert.equal(labelFor(index, '$ no directory'), undefined);
  assert.equal(labelFor(index, '$ no directory', '/project'), undefined);
});

test('clearing a label keeps approval labels for other directories', async (t) => {
  const dir = await state(t);
  await recordFeedback(dir, { request: '$ rm -rf build', cwd: '/a', label: 'approve' });
  await recordFeedback(dir, { request: '$ rm -rf build', cwd: '/b', label: 'approve' });
  await recordFeedback(dir, { request: '$ rm -rf build', cwd: '/a', label: 'manual' });
  await recordFeedback(dir, { request: '$ rm -rf build', cwd: '/a', label: 'clear' });
  const index = labelIndex(await readFeedback(dir));
  assert.equal(labelFor(index, '$ rm -rf build', '/a'), undefined);
  assert.equal(labelFor(index, '$ rm -rf build', '/b'), 'approve');
});

test('feedback files stay private and reject symlinks', async (t) => {
  const dir = await state(t);
  await recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'approve' });
  const directory = join(dir, 'history');
  const file = join(directory, 'feedback.jsonl');
  await chmod(directory, 0o755);
  await chmod(file, 0o644);
  await recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'approve' });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await rm(file);
  const other = join(dir, 'other');
  await writeFile(other, 'untouched');
  await symlink(other, file);
  await assert.rejects(readFeedback(dir), { code: 'ELOOP' });
  await assert.rejects(recordFeedback(dir, { request: '$ npm test', cwd: '/project', label: 'approve' }), { code: 'ELOOP' });
  assert.equal(await readFile(other, 'utf8'), 'untouched');
});

test('parallel writers append complete rows and broken rows are skipped', async (t) => {
  const dir = await state(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordFeedback(dir, { request: `$ command ${i}`, cwd: '/project', label: 'approve' })));
  const file = join(dir, 'history', 'feedback.jsonl');
  assert.equal((await readFeedback(dir)).length, 20);
  await appendFile(file, '{broken\n' + JSON.stringify(row('$ npm test', 'maybe')) + '\n');
  await appendFile(file, JSON.stringify({ request: '$ npm test', label: 'approve', recordedAt: 1 }) + '\n');
  await appendFile(file, JSON.stringify({ request: '$ npm test', label: 'approve', cwd: 7, recordedAt: new Date().toISOString() }) + '\n');
  assert.equal((await readFeedback(dir)).length, 20);
  assert.equal(labelIndex(await readFeedback(dir)).size, 20);
  assert.deepEqual((await readFeedback(dir)).map((entry) => entry.cwd), Array(20).fill('/project'));
});

test('the index keeps the newest labels and evicts the least recently changed', () => {
  const rows = [];
  for (let i = 0; i < 5_001; i++) rows.push(row(`$ command ${i}`, 'manual', undefined));
  // The oldest key is evicted first, but a new decision for it keeps it.
  rows.push(row('$ command 0', 'manual', undefined));
  const index = labelIndex(rows);
  assert.equal(index.size, 5_000);
  assert.equal(labelFor(index, '$ command 0'), 'manual');
  assert.equal(labelFor(index, '$ command 1'), undefined);
  assert.equal(labelFor(index, '$ command 5000'), 'manual');
});
