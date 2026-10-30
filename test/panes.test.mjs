import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPane, readPane, savePane } from '../panes.mjs';

async function state(t) {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-panes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the interface pane is saved, read, and cleared as private state', async (t) => {
  const dir = await state(t);
  assert.equal(await readPane(dir), null);
  assert.equal(await savePane(dir, 'not-a-pane'), false);
  assert.equal(await savePane(dir, 'w1:p2'), true);
  assert.equal(await readPane(dir), 'w1:p2');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'pane.json'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(dir, 'pane.json'), 'utf8'), /"pane":"w1:p2"/);
  chmod(join(dir, 'pane.json'), 0o644);
  await savePane(dir, 'w1:p3');
  assert.equal((await stat(join(dir, 'pane.json'))).mode & 0o777, 0o600);
  assert.equal(await readPane(dir), 'w1:p3');
});

test('cleanup removes only the record of its own pane', async (t) => {
  const dir = await state(t);
  await savePane(dir, 'w1:p2');
  clearPane(dir, 'w1:p9');
  assert.equal(await readPane(dir), 'w1:p2');
  clearPane(dir, 'w1:p2');
  assert.equal(await readPane(dir), null);
  clearPane(dir, 'w1:p2');
});

test('a damaged or linked record reads as absent', async (t) => {
  const dir = await state(t);
  await writeFile(join(dir, 'pane.json'), '{broken');
  assert.equal(await readPane(dir), null);
  await writeFile(join(dir, 'pane.json'), JSON.stringify({ pane: 'w1:p2' }));
  const other = join(dir, 'other.json');
  await writeFile(other, JSON.stringify({ pane: 'w1:p5' }));
  await rm(join(dir, 'pane.json'));
  await symlink(other, join(dir, 'pane.json'));
  assert.equal(await readPane(dir), null);
  await assert.rejects(savePane(dir, 'w1:p2'), { code: 'ELOOP' });
  assert.match(await readFile(other, 'utf8'), /w1:p5/);
});
