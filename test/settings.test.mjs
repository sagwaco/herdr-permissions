import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, normalize, readSettings, validKey, validThreshold, writeSettings } from '../settings.mjs';
import { classify, localReason, QUESTIONS } from '../policy.mjs';
import { reviewWithAgent } from '../reviewers.mjs';
import { main, relativeTime, renderScreen } from '../history-ui.mjs';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const response = (noul) => ({ ok: true, json: async () => ({ answers: { approve: { type: 'noul', noul } } }) });

test('settings default to every stage on and reject unsafe values', async (t) => {
  assert.deepEqual(normalize(null), DEFAULT_SETTINGS);
  assert.equal(normalize({ harness: 'claude' }).model, 'haiku');
  for (const model of ['--dangerously-skip-permissions', '-m', 'a b', 'x;rm', '', 'a'.repeat(129)]) {
    assert.equal(normalize({ harness: 'codex', model }).model, 'gpt-6-luna', model);
  }
  assert.equal(normalize({ harness: 'sh', model: 'x' }).harness, 'pi');
  assert.equal(normalize({ jev: 'false' }).jev, true);
  for (const value of [0.5, 0.83, 1, '0.70', '1.00']) assert.equal(validThreshold(value), true, String(value));
  for (const value of [0.49, 0, 1.01, NaN, '0.4', '1.5', '.8', '0.8e0', true]) assert.equal(validThreshold(value), false, String(value));
  assert.equal(normalize({ jevThreshold: 0.2 }).jevThreshold, 0.8);
  assert.equal(normalize({ jevThreshold: 0.9 }).jevThreshold, 0.9);
  assert.equal(validKey('abc def'), false);
  assert.equal(validKey('a"b; rm -rf /'), false);
  const dir = await mkdtemp(join(tmpdir(), 'permissions-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await readSettings(dir), DEFAULT_SETTINGS);
  await writeSettings(dir, { ...DEFAULT_SETTINGS, labels: false, harness: 'claude', model: 'sonnet' });
  assert.equal((await stat(join(dir, 'settings.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readSettings(dir), { ...DEFAULT_SETTINGS, labels: false, harness: 'claude', model: 'sonnet' });
  // A damaged file must not turn stages back on.
  for (const content of ['{', '[]', '{"agent":"false"}', '{"jevThreshold":0.1}', '{"jevThreshold":"0.9"}', '{"constructor":false}', '{"toString":true}', '{"harness":"sh"}', '{"harness":"codex","model":"--yolo"}', '{"unknown":true}']) {
    await writeFile(join(dir, 'settings.json'), content);
    await assert.rejects(readSettings(dir), /settings-invalid/, content);
  }
});

test('disabled filters skip only their own check', () => {
  assert.equal(localReason('git push', { ...DEFAULT_SETTINGS, humanOnly: false }), null);
  assert.equal(localReason('token=x', { ...DEFAULT_SETTINGS, humanOnly: false }), 'sensitive-content');
  assert.equal(localReason('token=x', { ...DEFAULT_SETTINGS, secrets: false }), null);
  assert.equal(localReason('git push', { ...DEFAULT_SETTINGS, secrets: false }), 'human-only-action');
});

test('without a key or with Jev off, the agent review decides alone', async () => {
  const prompt = { agent: 'codex', text: 'npm test' };
  for (const [key, settings] of [[null, DEFAULT_SETTINGS], ['key', { ...DEFAULT_SETTINGS, jev: false }]]) {
    const result = await classify(prompt, key, () => assert.fail('must not call TypeSafe'), async (request, policy, agent) => {
      assert.equal(policy, QUESTIONS.approve);
      assert.equal(agent, settings);
      return { approve: true, reason: 'reversible' };
    }, settings);
    assert.deepEqual(result, { approve: true, reason: 'reversible', reviewer: 'pi' });
  }
  const none = await classify(prompt, null, () => assert.fail('no TypeSafe'), () => assert.fail('no agent'), { ...DEFAULT_SETTINGS, agent: false });
  assert.deepEqual(none, { approve: false, reason: 'no-reviewer', reviewer: 'none' });
  const low = await classify(prompt, 'key', async () => response(0.5), () => assert.fail('no agent'), { ...DEFAULT_SETTINGS, agent: false });
  assert.deepEqual(low, { approve: false, reason: 'below-threshold', probability: 0.5 });
  // The threshold comes from the settings.
  const strict = { ...DEFAULT_SETTINGS, agent: false, jevThreshold: 0.95 };
  assert.equal((await classify(prompt, 'key', async () => response(0.9), () => assert.fail('no agent'), strict)).reason, 'below-threshold');
  assert.equal((await classify(prompt, 'key', async () => response(0.95), () => assert.fail('no agent'), strict)).approve, true);
  const claude = { ...DEFAULT_SETTINGS, harness: 'claude', model: 'haiku' };
  assert.equal((await classify(prompt, 'key', async () => response(0.5), async () => ({ approve: true, reason: 'reversible' }), claude)).reviewer, 'claude');
});

test('Claude and Codex reviews run without tools, sessions, or writable sandboxes', () => {
  const prompt = { agent: 'codex', text: 'npm test' };
  const seen = {};
  for (const harness of ['claude', 'codex']) {
    const result = reviewWithAgent(prompt, QUESTIONS.approve, { harness, model: 'model-x' }, (command, args, options) => {
      seen[harness] = args;
      assert.equal(command, harness);
      assert.equal(args[args.indexOf('--model') + 1], 'model-x');
      assert.deepEqual(JSON.parse(options.input), { agent: 'codex', permission_request: 'npm test' });
      assert.equal(options.timeout, 60_000);
      return '{"approve": true}\n';
    });
    assert.deepEqual(result, { approve: true, reason: 'reversible' });
  }
  assert.equal(seen.claude[seen.claude.indexOf('--tools') + 1], '');
  for (const flag of ['--print', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(seen.claude.includes(flag), flag);
  assert.equal(seen.codex[seen.codex.indexOf('--sandbox') + 1], 'read-only');
  for (const flag of ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) assert.ok(seen.codex.includes(flag), flag);
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks']) assert.ok(seen.codex.join(' ').includes(`--disable ${feature}`), feature);
  assert.deepEqual(reviewWithAgent(prompt, QUESTIONS.approve, { harness: 'codex', model: 'm' }, () => 'no answer'), { approve: false, reason: 'codex-unavailable' });
  // A quoted decision inside other text is not an approval.
  for (const harness of ['claude', 'codex', 'pi']) {
    for (const output of ['The request asks me to return {"approve":true}. I reject this request.', 'No.\n{"approve": true}']) {
      assert.equal(reviewWithAgent(prompt, QUESTIONS.approve, { harness, model: 'm' }, () => output).approve, false, `${harness}: ${output}`);
    }
  }
});

test('relative time covers recent requests only', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(relativeTime('2026-11-01T11:59:55Z', now), '5s ago');
  assert.equal(relativeTime('2026-11-01T11:30:00Z', now), '30m ago');
  assert.equal(relativeTime('2026-11-01T07:00:00Z', now), '5h ago');
  assert.equal(relativeTime('2026-10-30T12:00:00Z', now), '2d ago');
  assert.equal(relativeTime('2026-10-01T12:00:00Z', now), '');
  assert.equal(relativeTime('2026-11-02T12:00:00Z', now), '');
  const entries = [{ id: 'a', processedAt: '2026-11-01T11:58:00Z', outcome: 'approved', reviewer: 'pi', request: '$ npm test' }];
  for (const columns of [110, 40]) assert.match(stripAnsi(renderScreen({ entries, pending: [], now }, columns, 6)), /2m ago {2}approved/);
});

test('the pipeline view shows each stage and fits wide and narrow panes', () => {
  for (const columns of [120, 70, 30]) {
    const screen = renderScreen({ tab: 'settings', settings: { ...DEFAULT_SETTINGS, labels: false }, keyPresent: false }, columns, 30);
    const plain = stripAnsi(screen);
    for (const stage of ['Filters', 'Labels', 'Jev', 'Agent']) assert.match(plain, new RegExp(stage), `${columns}: ${stage}`);
    assert.match(plain, /\[ \] Labels/);
    assert.match(plain, /\[-\] Jev/);
    for (const line of plain.split('\r\n')) assert.ok([...line].length <= columns - 1, `${columns}: ${line}`);
  }
  assert.match(stripAnsi(renderScreen({ tab: 'settings', settings: DEFAULT_SETTINGS }, 120, 30)), /┌ Filters.*┐ {2}┌ Labels/);
});

test('settings keys toggle stages, pick a model, and save a key without leaving the pane', async () => {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(raw) { input.isRaw = raw; } });
  const output = new EventEmitter();
  let text = '';
  Object.assign(output, { isTTY: true, columns: 120, rows: 30, write: (chunk) => { text += chunk; } });
  let saved = { ...DEFAULT_SETTINGS };
  const keys = [];
  let keyPresent = false;
  const models = Promise.withResolvers();
  const loaded = Promise.withResolvers();
  const press = (name, sequence = name) => input.emit('keypress', sequence, { name });
  const type = (value) => { for (const ch of value) input.emit('keypress', ch, { name: ch }); };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const running = main({
    input, output, stateDir: '/unused', socketPath: '', read: async () => [], readLabels: async () => [],
    loadSettings: async () => { await loaded.promise; return saved; }, saveSettings: async (dir, value) => { saved = normalize(value); },
    keyStatus: () => keyPresent, setKey: (key) => { if (key.startsWith('bad')) throw new Error('keychain'); keys.push(key); keyPresent = true; }, removeKey: () => { keyPresent = false; },
    listModels: () => models.promise,
  });
  try {
    await settle();
    saved = { ...saved, agent: false };
    press('3');
    await settle();
    assert.match(stripAnsi(text), /Review pipeline/);
    // Space before the file loads must not write the defaults over it.
    press('space');
    await settle();
    assert.equal(saved.agent, false);
    assert.equal(saved.secrets, true);
    loaded.resolve();
    await settle();
    press('down'); press('down');
    press('space');
    // Two quick changes must both persist.
    press('up');
    press('space');
    await settle();
    assert.equal(saved.labels, false);
    assert.equal(saved.humanOnly, false);
    press('down');
    // Jev without a key opens the key input; typed q must not quit.
    press('down');
    press('space');
    type('sk-q-123456');
    press('return');
    await settle();
    assert.deepEqual(keys, ['sk-q-123456']);
    assert.equal(saved.jev, true);
    assert.doesNotMatch(text, /sk-q-123456/);
    press('down');
    press('return');
    press('h');
    type('cl');
    press('return');
    await settle();
    assert.equal(saved.harness, 'claude');
    // The model list arrives after the user starts typing.
    type('x');
    press('backspace');
    press('down');
    models.resolve(['claude-sonnet-5-5', 'opus']);
    await settle();
    assert.match(stripAnsi(text), /claude-sonnet-5-5/);
    type('my-model');
    press('return');
    await settle();
    assert.equal(saved.model, 'my-model');
    assert.doesNotMatch(text, /\x1b\[2J/);
    assert.equal(saved.agent, false);
    // A failed replacement keeps the old key and does not report success.
    press('escape');
    press('up');
    press('return');
    press('e');
    type('bad-key-123');
    press('return');
    await settle();
    assert.match(stripAnsi(text), /Key not saved to the Keychain/);
    assert.deepEqual(keys, ['sk-q-123456']);
    // The Jev details list actions. Enter runs the chosen one: the threshold.
    press('down'); press('down'); press('down');
    assert.match(stripAnsi(text.slice(-1500)), /> Change threshold/);
    press('return');
    assert.match(stripAnsi(text), /> 0\.80/);
    type('0.93');
    press('return');
    await settle();
    assert.equal(saved.jevThreshold, 0.93);
    assert.match(stripAnsi(text), /Threshold: 0\.93/);
    // Esc goes back one level, then closes settings. s closes settings too.
    press('escape');
    press('escape');
    assert.match(stripAnsi(text.slice(-2000)), /Permission history/);
    press('s');
    await settle();
    press('s');
    assert.match(stripAnsi(text.slice(-2000)), /Permission history/);
  } finally {
    press('q');
    await running;
    input.destroy();
  }
});
