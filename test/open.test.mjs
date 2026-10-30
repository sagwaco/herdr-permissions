import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApprover } from '../open.mjs';
import { savePane } from '../panes.mjs';

async function state(t) {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runner({ live = [], output = '{"result":{"plugin_pane":{"pane":{"pane_id":"w9:p9"}}}}' } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pane' && args[1] === 'get') {
      if (!live.includes(args[2])) throw new Error('pane_not_found');
      return JSON.stringify({ result: { pane: { pane_id: args[2] } } });
    }
    if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'focus') return '{}';
    if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open') return output;
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { calls, run };
}

test('a saved live pane is focused instead of opening another copy', async (t) => {
  const dir = await state(t);
  await savePane(dir, 'w1:p2');
  const { calls, run } = runner({ live: ['w1:p2'] });
  assert.deepEqual(await openApprover({ stateDir: dir, run }), { reused: 'w1:p2' });
  assert.deepEqual(calls, ['pane get w1:p2', 'plugin pane focus w1:p2']);
});

test('a closed or replaced pane opens one split pane in the caller tab', async (t) => {
  const dir = await state(t);
  await savePane(dir, 'w1:p2');
  const { calls, run } = runner();
  assert.deepEqual(await openApprover({ stateDir: dir, run }), { opened: 'w9:p9', output: '{"result":{"plugin_pane":{"pane":{"pane_id":"w9:p9"}}}}' });
  assert.deepEqual(calls, ['pane get w1:p2', 'plugin pane open --plugin sang.permissions --entrypoint history --placement split --direction right --focus']);
});

test('no saved pane opens a pane and an unreadable state directory is tolerated', async (t) => {
  const { calls, run } = runner();
  assert.equal((await openApprover({ stateDir: '/nonexistent-directory', run })).opened, 'w9:p9');
  assert.deepEqual(calls, ['plugin pane open --plugin sang.permissions --entrypoint history --placement split --direction right --focus']);
  const { run: broken } = runner({ output: 'not json' });
  const result = await openApprover({ stateDir: '', run: broken });
  assert.equal(result.opened, null);
  assert.equal(result.output, 'not json');
});
