import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveRequest, focusRequest, loadPending } from '../actions.mjs';
import { readHistory } from '../history.mjs';
import { parsePrompt } from '../prompts.mjs';
import { review, withLock } from '../index.mjs';

const CODEX = `Would you like to run the following command?

Reason: Run the local test suite
  $ npm test

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with npm test (p)
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel`;

function harness() {
  const state = {
    agent: {
      agent: 'codex', pane_id: 'w1:p1', terminal_id: 'term-1', agent_session: { value: 'session-1' },
      agent_status: 'blocked', state_change_seq: 2, revision: 3, cwd: '/project',
    },
    text: CODEX, keys: [], focuses: [],
  };
  const call = async (method, params) => {
    if (method === 'agent.list') return { agents: [structuredClone(state.agent)] };
    if (method === 'agent.get') return { agent: structuredClone(state.agent) };
    if (method === 'agent.read') return { read: { text: state.text, source: 'detection', pane_id: 'w1:p1', revision: 0, truncated: false } };
    if (method === 'agent.send_keys') { state.keys.push(params); return { type: 'ok' }; }
    if (method === 'agent.focus') { state.focuses.push(params.target); return { type: 'ok' }; }
    assert.fail(`unexpected ${method}`);
  };
  return { state, call };
}

async function stateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-actions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a user approval sends one key, claims the request, and records a human outcome', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  const result = await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1', expectedText: parsePrompt('codex', CODEX).text });
  assert.deepEqual(result, { ok: true, reason: 'approved-by-human' });
  assert.deepEqual(state.keys, [{ target: 'w1:p1', keys: ['y'] }]);
  const rows = await readHistory(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'approved');
  assert.equal(rows[0].reviewer, 'human');
  assert.equal(rows[0].reason, 'approved-by-human');
  assert.equal(rows[0].pane, 'w1:p1');
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'already-reviewed');
  assert.equal(state.keys.length, 1);
});

test('approval stops when the request, identity, or agent state changed', async (t) => {
  const dir = await stateDir(t);
  for (const [change, reason] of [
    [(s) => { s.text = CODEX.replace('$ npm test', '$ rm -rf ~/Documents'); }, 'prompt-changed'],
    [(s) => { s.agent.state_change_seq++; }, 'agent-transitioned'],
    [(s) => { s.agent.agent_status = 'working'; }, 'agent-not-blocked'],
  ]) {
    const { state, call } = harness();
    const identity = JSON.stringify(['codex', 'w1:p1', 'term-1', { value: 'session-1' }, 2, '/project', undefined]);
    change(state);
    const result = await approveRequest({
      call, stateDir: dir, socketPath: '/socket', target: 'w1:p1',
      expectedIdentity: identity, expectedText: 'Would you like to run the following command?',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(state.keys, []);
  }
  assert.deepEqual(await readHistory(dir), []);
});

test('a failed send never repeats a key', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  let rejectSend = true;
  const failing = async (method, params) => {
    if (method === 'agent.send_keys') { rejectSend = false; throw new Error('socket closed'); }
    return call(method, params);
  };
  assert.equal((await approveRequest({ call: failing, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'approval-delivery-unknown');
  assert.equal(rejectSend, false);
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'already-reviewed');
  assert.deepEqual(state.keys, []);
  const rows = await readHistory(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'unknown');
  assert.equal(rows[0].reason, 'approval-delivery-unknown');
  assert.equal(rows[0].reviewer, 'unknown');
});

test('a request that changes after the selection is checked again inside the claim', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  let touched = false;
  const changing = async (method, params) => {
    // The pane redraws with another command between the pre-lock read and the claim.
    if (method === 'agent.get' && !touched) { touched = true; state.text = CODEX.replace('$ npm test', '$ rm -rf ~/Documents'); state.agent.revision++; }
    return call(method, params);
  };
  const expectedText = parsePrompt('codex', CODEX).text;
  const result = await approveRequest({ call: changing, stateDir: dir, socketPath: '/socket', target: 'w1:p1', expectedText });
  assert.deepEqual(result, { ok: false, reason: 'prompt-changed' });
  assert.deepEqual(state.keys, []);
  assert.deepEqual(await readHistory(dir), []);
  // The claim was not consumed by the rejected request.
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'approved-by-human');
  assert.deepEqual(state.keys, [{ target: 'w1:p1', keys: ['y'] }]);
});

test('an approval without a selected identity or text is still bound to the live prompt', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  const result = await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' });
  assert.deepEqual(result, { ok: true, reason: 'approved-by-human' });
  assert.deepEqual(state.keys, [{ target: 'w1:p1', keys: ['y'] }]);
});

test('an approval does not send while another review holds the claim', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  await withLock(dir, '/socket', 'w1:p1:term-1:2', async () => {
    const result = await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' });
    assert.deepEqual(result, { reason: 'review-in-progress' });
  });
  assert.deepEqual(state.keys, []);
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'approved-by-human');
  assert.deepEqual(state.keys, [{ target: 'w1:p1', keys: ['y'] }]);
});

test('a claim from an older version blocks a human send for the same request', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  const identity = JSON.stringify(['codex', 'w1:p1', 'term-1', { value: 'session-1' }, 2, '/project', null]);
  const legacy = createHash('sha256').update(identity + CODEX).digest('hex');
  await withLock(dir, '/socket', 'w1:p1:term-1:2', async (claim) => { assert.equal(await claim(legacy), true); });
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'already-reviewed');
  assert.deepEqual(state.keys, []);
});

test('live pending requests include parsed prompts and keep unparsed panes visible', async () => {
  const { state, call } = harness();
  const pending = await loadPending(call);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].pane, 'w1:p1');
  assert.equal(pending[0].agent, 'codex');
  assert.equal(pending[0].live, true);
  assert.match(pending[0].request, /\$ npm test/);
  assert.ok(pending[0].identity);
  state.text = 'A private prompt that Herdr cannot parse';
  const [unparsed] = await loadPending(call);
  assert.equal(unparsed.request, undefined);
  assert.equal(unparsed.reason, 'prompt-format-unrecognized');
  state.text = CODEX;
  state.agent.agent_status = 'idle';
  assert.deepEqual(await loadPending(call), []);
  state.agent.agent_status = 'blocked';
  state.agent.pane_id = '../file';
  assert.deepEqual(await loadPending(call), []);
});

test('a pane without an agent fails an approval without sending input', async (t) => {
  const dir = await stateDir(t);
  const failing = async (method) => { throw new Error(`herdr-unavailable ${method}`); };
  assert.deepEqual(await approveRequest({ call: failing, stateDir: dir, socketPath: '/socket', target: 'w1:p1' }), { ok: false, reason: 'agent-unavailable' });
  assert.deepEqual(await readHistory(dir), []);
});

test('focus requests target the recorded pane and report failure safely', async () => {
  const { state, call } = harness();
  assert.deepEqual(await focusRequest(call, 'w1:p1'), { ok: true });
  assert.deepEqual(state.focuses, ['w1:p1']);
  const failing = async () => { throw new Error('private failure'); };
  assert.deepEqual(await focusRequest(failing, 'w1:p1'), { ok: false, reason: 'focus-unavailable' });
});

// Run one automatic review with the real lock and claim files.
async function autoReview(dir, call, decision) {
  const { agent } = await call('agent.get', { target: 'w1:p1' });
  return withLock(dir, '/socket', `w1:p1:${agent.terminal_id}:${agent.state_change_seq}`, (claim, release, decline) => review('w1:p1', {
    call, claim, release, decline, getKey: () => 'key', decide: async () => decision,
  }));
}

test('a user can approve a request that the automatic review left for a human', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  assert.equal((await autoReview(dir, call, { approve: false, reason: 'human-review', reviewer: 'codex' })).reason, 'human-review');
  assert.deepEqual(state.keys, []);
  // The automatic review does not decide the same request twice.
  assert.equal((await autoReview(dir, call, { approve: true, reason: 'reversible' })).reason, 'already-reviewed');
  assert.deepEqual(state.keys, []);
  assert.deepEqual(await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' }), { ok: true, reason: 'approved-by-human' });
  assert.deepEqual(state.keys, [{ target: 'w1:p1', keys: ['y'] }]);
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'already-reviewed');
  assert.equal((await autoReview(dir, call, { approve: true, reason: 'reversible' })).reason, 'already-reviewed');
  assert.equal(state.keys.length, 1);
});

test('a user cannot approve a request after the automatic review sent its key', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  const enabled = async (method, params) => method === 'plugin.list'
    ? { plugins: [{ plugin_id: 'herdr-permissions', enabled: true }] } : call(method, params);
  assert.equal((await autoReview(dir, enabled, { approve: true, reason: 'reversible' })).reason, 'approved-once');
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'already-reviewed');
  assert.equal(state.keys.length, 1);
});

test('a user can approve a request after the automatic review failed before a send', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  const { agent } = await call('agent.get', { target: 'w1:p1' });
  await assert.rejects(withLock(dir, '/socket', `w1:p1:${agent.terminal_id}:${agent.state_change_seq}`, (claim, release, decline) => review('w1:p1', {
    call, claim, release, decline, getKey: () => { throw new Error('keychain-unavailable'); }, decide: async () => assert.fail('no key'),
  })), /keychain-unavailable/);
  assert.deepEqual(await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' }), { ok: true, reason: 'approved-by-human' });
  assert.equal(state.keys.length, 1);
});

test('an uncertain automatic delivery blocks later automatic and human sends', async (t) => {
  const dir = await stateDir(t);
  const { state, call } = harness();
  const failing = async (method, params) => {
    if (method === 'plugin.list') return { plugins: [{ plugin_id: 'herdr-permissions', enabled: true }] };
    // The key arrives, but the reply is lost.
    if (method === 'agent.send_keys') { state.keys.push(params); throw new Error('socket closed'); }
    return call(method, params);
  };
  await assert.rejects(autoReview(dir, failing, { approve: true, reason: 'reversible' }), /approval-delivery-unknown/);
  assert.equal(state.keys.length, 1);
  assert.equal((await autoReview(dir, failing, { approve: true, reason: 'reversible' })).reason, 'already-reviewed');
  assert.equal((await approveRequest({ call, stateDir: dir, socketPath: '/socket', target: 'w1:p1' })).reason, 'already-reviewed');
  assert.equal(state.keys.length, 1);
});
