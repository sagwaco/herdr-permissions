import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { API_URL, classify, localReason, QUESTIONS } from '../policy.mjs';
import { reviewWithPi } from '../pi.mjs';
import { drain, eventTarget, main, PLUGIN_ID, review, rpc, withLock } from '../index.mjs';
import { parsePrompt } from '../prompts.mjs';
import { readHistory, recordHistory } from '../history.mjs';
import { localPrecedent, recordFeedback } from '../feedback.mjs';

const CLAUDE = `Some earlier conversation, excluded from the API request.
Bash command
  npm test
  Run the local test suite
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for npm test
  3. No
Esc to cancel · Tab to amend`;

const CODEX = `Would you like to run the following command?

Reason: Run the local test suite
  $ npm test

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with npm test (p)
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel`;

test('only explicit one-time choices are used, with no trailing Enter', () => {
  assert.deepEqual(parsePrompt('claude', CLAUDE)?.keys, ['1']);
  assert.deepEqual(parsePrompt('codex', CODEX)?.keys, ['y']);
  assert.deepEqual(parsePrompt('codex', CODEX.replace('(y)', '(a)'))?.keys, ['a']);
  assert.ok(!parsePrompt('claude', CLAUDE).text.includes('earlier conversation'));
  assert.ok(!parsePrompt('claude', CLAUDE).text.includes("don't ask again"));
  assert.ok(parsePrompt('claude', CLAUDE.replace('Bash command', 'Bash command · from a subagent')));
  assert.ok(parsePrompt('claude', CLAUDE.replace('Bash command', 'Bash command (unsandboxed)')));
  assert.ok(parsePrompt('codex', CODEX.replace('npm test', 'git diff main...HEAD')));
});

test('edits include the visible patch in the classification', () => {
  const claude = CLAUDE.replace('Bash command', 'Edit file').replace('npm test', 'src/app.js\n- const x = 1;\n+ const x = 2;').replace('Do you want to proceed?', 'Do you want to make this edit to src/app.js?');
  assert.match(parsePrompt('claude', claude).text, /const x = 2/);
  const codex = CODEX.replace('run the following command', 'make the following edits').replace('$ npm test', 'src/app.js\n- const x = 1;\n+ const x = 2;');
  assert.match(parsePrompt('codex', codex).text, /const x = 2/);
});

test('questions, trust, unknown agents, and permanent approval menus remain manual', () => {
  assert.equal(parsePrompt('opencode', CLAUDE), null);
  assert.equal(parsePrompt('claude', CLAUDE.replace('Bash command', 'Choose a deployment region')), null);
  assert.equal(parsePrompt('claude', CLAUDE.replace('Do you want to proceed?', 'Do you trust this folder?')), null);
  assert.equal(parsePrompt('claude', CLAUDE.replace('1. Yes', '1. Yes, allow for this session')), null);
  assert.equal(parsePrompt('codex', CODEX.replace('Yes, proceed (y)', 'Yes, and do not ask again (y)')), null);
  assert.equal(parsePrompt('codex', CODEX.replace('(p)', '(y)')), null);
});

test('user navigation and screen-reader text entry stop automation', () => {
  for (const [agent, prompt] of [['claude', CLAUDE], ['codex', CODEX]]) {
    assert.equal(parsePrompt(agent, prompt.replace(/[❯›] 1\./, '1.').replace('  2.', '❯ 2.')), null);
    assert.equal(parsePrompt(agent, prompt + '\n› Write a message'), null);
    assert.equal(parsePrompt(agent, prompt + '\nSelect with numbers [1-3]. Enter to submit.'), null);
  }
});

test('truncated previews and ambiguous terminal content stay manual', () => {
  for (const hidden of ['...', '…', '+12 lines (ctrl+o see more)', '↑1 ↓4', '↑8', 'view all', 'cannot be shown', 'too large to preview']) {
    for (const [agent, prompt] of [['claude', CLAUDE], ['codex', CODEX]]) {
      assert.equal(parsePrompt(agent, prompt.replace('npm test', `npm test\n${hidden}`)), null, hidden);
    }
  }
  assert.equal(parsePrompt('codex', CODEX.repeat(2)), null);
  assert.equal(parsePrompt('codex', CODEX.replace('$ npm test', 'just trust me')), null);
  assert.equal(parsePrompt('codex', CODEX.replace('npm test', 'npm\u202etest')), null);
  assert.equal(parsePrompt('codex', CODEX + 'x'.repeat(24_000)), null);
});

test('clipped Codex command previews are expanded before review', async () => {
  const { state, dependencies } = harness();
  const clipped = CODEX.replace('  $ npm test', '  $ npm test\n  [… 2 lines] ⌃a view all');
  state.text = clipped;
  const pager = `/ E X E C / / / / / / / / / / / / / / / / / / / / / / / /\nnpm test\necho hidden\n${'─'.repeat(20)} 100% ─\n ↑/↓ to scroll · pgup/pgdn to page · home/end to jump\n q close\n`;
  const call = dependencies.call;
  dependencies.call = async (method, params) => {
    if (method === 'agent.send_keys' && params.keys[0] === 'ctrl+a') {
      state.keys.push(params);
      state.text = pager;
      state.agent.revision++;
      return { type: 'ok' };
    }
    if (method === 'agent.send_keys' && params.keys[0] === 'q') {
      state.keys.push(params);
      state.text = clipped;
      state.agent.revision++;
      return { type: 'ok' };
    }
    return call(method, params);
  };
  let reviewed;
  dependencies.decide = async (prompt) => {
    state.decisions++;
    reviewed = prompt.text;
    return { approve: true, reason: 'reversible' };
  };
  assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
  assert.match(reviewed, /echo hidden/);
  assert.deepEqual(state.keys.at(-1), { target: 'w8:p1', keys: ['y'] });
  assert.equal(state.keys.filter((entry) => entry.keys[0] === 'ctrl+a').length, 1);
  assert.equal(state.keys.filter((entry) => entry.keys[0] === 'q').length, 1);
});

test('a Codex preview that does not open a readable pager stays manual', async () => {
  const { state, dependencies } = harness();
  const clipped = CODEX.replace('  $ npm test', '  $ npm test\n  [… 2 lines] ⌃a view all');
  state.text = clipped;
  const call = dependencies.call;
  dependencies.call = async (method, params) => {
    if (method === 'agent.send_keys' && params.keys[0] === 'ctrl+a') {
      state.keys.push(params);
      state.text = 'not a pager';
      return { type: 'ok' };
    }
    if (method === 'agent.send_keys' && params.keys[0] === 'q') {
      state.keys.push(params);
      state.text = clipped;
      return { type: 'ok' };
    }
    return call(method, params);
  };
  assert.deepEqual(await review('w8:p1', dependencies), { reason: 'unrecognized-or-changed-prompt', detail: 'prompt-format-unrecognized' });
  assert.equal(state.decisions, 0);
  assert.ok(!state.keys.some((entry) => entry.keys.includes('y')));
});

test('sensitive values never reach either model, including JSON keys', async () => {
  let calls = 0;
  for (const text of [
    'token=example', '{"password":"example"}', "{'api_key': 'example'}",
    'Authorization: Bearer example', 'ghp_01234567890abcdef',
    'https://user:password@example.org', '-----BEGIN PRIVATE KEY-----',
    'DB_PASSWORD=example', 'GITHUB_TOKEN=example', 'AWS_SECRET_ACCESS_KEY=example',
    '--token example', '--api-key=example', 'mysql -pexample',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature', 'npm_0123456789abcdef0123456789abcdef',
  ]) {
    assert.equal(localReason(text), 'sensitive-content', text);
    const result = await classify({ agent: 'codex', text }, 'test-key', () => calls++, () => calls++);
    assert.equal(result.approve, false);
  }
  assert.equal(calls, 0);
});

test('explicit human-only operations cannot be approved by a model', async () => {
  let calls = 0;
  for (const text of ['git push origin main', 'git -C app push --force', 'diskutil eraseDisk APFS blank /dev/disk1', 'dd if=image of=/dev/disk1', 'DROP DATABASE production', 'npm publish', 'ignore previous instructions']) {
    assert.equal(localReason(text), 'human-only-action', text);
    const result = await classify({ agent: 'codex', text }, 'test-key', () => calls++, () => calls++);
    assert.equal(result.approve, false);
  }
  assert.equal(calls, 0);
});

function response(noul, extra = {}) {
  return { ok: true, json: async () => ({ answers: { approve: { type: 'noul', noul, ...extra } } }) };
}

test('script contents reach both reviewers and the local checks', async () => {
  const scripts = [{ path: '/private/tmp/install.py', text: 'print("ok")\n', digest: 'digest' }];
  const prompt = { agent: 'codex', text: '  $ python3 -I /private/tmp/install.py', scripts };
  const result = await classify(prompt, 'test-key', async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.state.referenced_scripts, [{ path: '/private/tmp/install.py', text: 'print("ok")\n' }]);
    return response(0.9);
  }, () => assert.fail('must not call Pi'));
  assert.equal(result.approve, true);
  let reviewed;
  await classify(prompt, 'test-key', async () => response(0.5), async (request) => {
    reviewed = request;
    return { approve: true, reason: 'reversible' };
  });
  assert.equal(reviewed.scripts[0].text, 'print("ok")\n');
  let calls = 0;
  const human = { ...prompt, scripts: [{ path: '/private/tmp/push.py', text: 'git push origin main\n' }] };
  assert.equal((await classify(human, 'test-key', () => calls++, () => calls++)).reason, 'human-only-action');
  assert.equal(calls, 0);
});

test('TypeSafe uses the fixed HTTPS endpoint and keeps the credential outside state', async () => {
  const result = await classify(parsePrompt('claude', CLAUDE), 'test-key', async (url, options) => {
    assert.equal(url, API_URL);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-latest');
    assert.ok(!options.body.includes('test-key'));
    assert.ok(!options.body.includes('earlier conversation'));
    assert.match(body.questions.approve.criteria.false, /cannot restore/);
    assert.ok(options.signal instanceof AbortSignal);
    return response(0.99);
  });
  assert.equal(result.approve, true);
});

test('scores at or above the threshold skip Pi', async () => {
  for (const value of [0.8, 0.99, 1]) {
    assert.equal((await classify({ text: 'npm test' }, 'test-key', async () => response(value), () => assert.fail('must not call Pi'))).approve, true);
  }
});

test('every valid score below the threshold uses the Pi decision and the same policy', async () => {
  const prompt = parsePrompt('codex', CODEX);
  for (const probability of [0, 0.2, 0.79, 0.799999]) {
    for (const approve of [true, false]) {
      let calls = 0;
      const result = await classify(prompt, 'test-key', async () => response(probability), async (request, policy) => {
        calls++;
        assert.equal(request, prompt);
        assert.equal(policy, QUESTIONS.approve);
        assert.ok(!JSON.stringify(request).includes('test-key'));
        return { approve, reason: approve ? 'reversible' : 'human-review' };
      });
      assert.equal(calls, approve ? 1 : 2);
      assert.deepEqual(result, { approve, reason: approve ? 'reversible' : 'human-review', probability, reviewer: 'pi' });
    }
  }
});

test('a Pi decline gets one second review, and only a plain decline does', async () => {
  const prompt = parsePrompt('codex', CODEX);
  const answers = [{ approve: false, reason: 'human-review' }, { approve: true, reason: 'reversible' }];
  assert.deepEqual(await classify(prompt, 'test-key', async () => response(0.5), async () => answers.shift()),
    { approve: true, reason: 'reversible', probability: 0.5, reviewer: 'pi' });
  for (const reason of ['pi-unavailable', 'pi-invalid-decision']) {
    let calls = 0;
    const result = await classify(prompt, 'test-key', async () => response(0.5), async () => { calls++; return { approve: false, reason }; });
    assert.equal(calls, 1);
    assert.equal(result.approve, false);
  }
});

test('TypeSafe errors and malformed answers never invoke Pi or approve', async () => {
  let calls = 0;
  const noReview = () => { calls++; return { approve: true }; };
  for (const value of [undefined, null, '1', NaN, Infinity, -1, 1.1]) {
    assert.equal((await classify({ text: 'npm test' }, 'test-key', async () => response(value), noReview)).approve, false);
  }
  for (const fetchImpl of [
    async () => ({ ok: false, status: 429 }),
    async () => response(1, { type: 'choice' }),
    async () => { throw new Error('secret server error'); },
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
  ]) assert.equal((await classify({ text: 'npm test' }, 'test-key', fetchImpl, noReview)).approve, false);
  assert.equal(calls, 0);
});

test('Pi failures and non-boolean approvals stay manual', async () => {
  for (const reviewer of [
    async () => { throw new Error('private error'); },
    async () => null,
    async () => ({ approve: 'true', reason: 'invalid' }),
    async () => ({ approve: false, reason: 'pi-unavailable' }),
  ]) {
    const result = await classify({ text: 'npm test' }, 'test-key', async () => response(0.7), reviewer);
    assert.equal(result.approve, false);
    assert.equal(result.reviewer, 'pi');
    assert.equal(result.probability, 0.7);
  }
});

function piResponse(approve) {
  return JSON.stringify({ approve }) + '\n';
}

test('Pi runs without tools or integrations on the chosen model with thinking off and receives the request and policy', () => {
  const prompt = parsePrompt('claude', CLAUDE);
  let calls = 0;
  const result = reviewWithPi(prompt, QUESTIONS.approve, (command, args, options) => {
    calls++;
    assert.equal(command, 'pi');
    for (const flag of ['--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '--no-approve']) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf('--model') + 1], 'deepseek/deepseek-v4.1-flash-1017');
    assert.equal(args[args.indexOf('--thinking') + 1], 'off');
    const policy = args[args.indexOf('--append-system-prompt') + 1];
    assert.ok(policy.includes(QUESTIONS.approve.instructions));
    assert.ok(policy.includes(QUESTIONS.approve.criteria.true));
    assert.ok(policy.includes(QUESTIONS.approve.criteria.false));
    assert.ok(!policy.includes('earlier conversation'));
    assert.deepEqual(JSON.parse(options.input), { agent: prompt.agent, permission_request: prompt.text });
    assert.ok(!options.input.includes('earlier conversation'));
    assert.ok(!options.input.includes("don't ask again"));
    assert.equal(options.cwd, tmpdir());
    assert.equal(options.timeout, 30_000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 64_000);
    return piResponse(true);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { approve: true, reason: 'reversible' });
});

test('Pi receives referenced script contents without their local digests', () => {
  const prompt = {
    agent: 'codex', text: '  $ python3 /private/tmp/x.py',
    scripts: [{ path: '/private/tmp/x.py', text: 'print(1)\n', digest: 'local-only' }],
  };
  let input;
  reviewWithPi(prompt, QUESTIONS.approve, (command, args, options) => {
    input = JSON.parse(options.input);
    return piResponse(true);
  });
  assert.deepEqual(input, {
    agent: 'codex', permission_request: prompt.text,
    referenced_scripts: [{ path: '/private/tmp/x.py', text: 'print(1)\n' }],
  });
});

test('Pi requires a structured boolean answer, also inside a JSON code fence', () => {
  const prompt = { text: 'npm test' };
  for (const output of ['approve', '{']) {
    assert.deepEqual(reviewWithPi(prompt, QUESTIONS.approve, () => output), { approve: false, reason: 'pi-unavailable' });
  }
  for (const output of [
    'null', '{}', JSON.stringify({ result: '{"approve":true}' }),
    JSON.stringify({ approve: 'true' }), JSON.stringify({ approve: 1 }), JSON.stringify({ approve: null }),
  ]) assert.deepEqual(reviewWithPi(prompt, QUESTIONS.approve, () => output), { approve: false, reason: 'pi-invalid-decision' }, output);
  assert.deepEqual(reviewWithPi(prompt, QUESTIONS.approve, () => '```json\n{"approve":true}\n```'), { approve: true, reason: 'reversible' });
  assert.deepEqual(reviewWithPi(prompt, QUESTIONS.approve, () => piResponse(false)), { approve: false, reason: 'human-review' });
  for (const code of ['ENOENT', 'ETIMEDOUT', 'ENOBUFS', 'auth-error']) {
    assert.deepEqual(reviewWithPi(prompt, QUESTIONS.approve, () => { throw Object.assign(new Error('private error'), { code }); }), { approve: false, reason: 'pi-unavailable' });
  }
});

function harness() {
  const state = {
    agent: { agent: 'codex', pane_id: 'w8:p1', terminal_id: 'term-1', agent_session: { value: 'session-1' }, agent_status: 'blocked', state_change_seq: 2, revision: 3 },
    text: CODEX, readRevision: 0, truncated: false, enabled: true, keys: [], decisions: 0, claimed: new Set(),
  };
  const dependencies = {
    call: async (method, params) => {
      if (method === 'agent.get') return { agent: structuredClone(state.agent) };
      if (method === 'agent.read') return { read: { text: state.text, source: 'detection', pane_id: 'w8:p1', revision: state.readRevision, truncated: state.truncated } };
      if (method === 'plugin.list') return { plugins: [{ plugin_id: PLUGIN_ID, enabled: state.enabled }] };
      if (method === 'agent.send_keys') { state.keys.push(params); return { type: 'ok' }; }
      assert.fail(method);
    },
    getKey: () => 'test-key',
    decide: async () => { state.decisions++; return { approve: true, reason: 'reversible' }; },
    claim: async (fingerprint, legacyFingerprint) => {
      if (state.claimed.has(fingerprint) || state.claimed.has(legacyFingerprint)) return false;
      state.claimed.add(fingerprint);
      return true;
    },
    release: async (fingerprint) => { state.claimed.delete(fingerprint); },
  };
  return { state, dependencies };
}

test('a referenced local script is reviewed with its contents and stays out of history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'install.py');
  await writeFile(script, 'print("install")\n');
  const { state, dependencies } = harness();
  state.text = CODEX.replace('$ npm test', `$ python3 -I ${script}`);
  const entries = [];
  dependencies.record = async (entry) => entries.push(entry);
  dependencies.decide = async (prompt) => {
    state.decisions++;
    assert.equal(prompt.scripts.length, 1);
    assert.equal(prompt.scripts[0].path, await realpath(script));
    assert.equal(prompt.scripts[0].text, 'print("install")\n');
    return { approve: true, reason: 'reversible' };
  };
  assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
  assert.deepEqual(state.keys, [{ target: 'w8:p1', keys: ['y'] }]);
  assert.equal(entries[0].request, parsePrompt('codex', state.text).text);
  assert.equal(JSON.stringify(entries).includes('print("install")'), false);
});

test('a script changed after review or outside the allowed roots stays manual', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'install.py');
  await writeFile(script, 'print("before")\n');
  {
    const { state, dependencies } = harness();
    state.text = CODEX.replace('$ npm test', `$ python3 -I ${script}`);
    const entries = [];
    dependencies.record = async (entry) => entries.push(entry);
    dependencies.decide = async () => {
      await writeFile(script, 'print("after")\n');
      return { approve: true, reason: 'reversible' };
    };
    assert.equal((await review('w8:p1', dependencies)).reason, 'script-changed');
    assert.deepEqual(state.keys, []);
    assert.equal(entries[0].reason, 'script-changed');
  }
  {
    const outside = await mkdtemp(join(process.cwd(), '.permissions-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const path = join(outside, 'install.py');
    await writeFile(path, 'print("outside")\n');
    const { state, dependencies } = harness();
    state.agent.cwd = '/nonexistent-project-root';
    state.text = CODEX.replace('$ npm test', `$ python3 ${path}`);
    const entries = [];
    dependencies.record = async (entry) => entries.push(entry);
    dependencies.decide = () => assert.fail('must not classify an unreadable script');
    dependencies.getKey = () => assert.fail('must not read credentials');
    assert.equal((await review('w8:p1', dependencies)).reason, 'script-unreadable');
    assert.deepEqual(state.keys, []);
    assert.equal(entries[0].reviewer, 'local');
  }
});

test('an approval label does not skip script review, and local checks inspect scripts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'install.py');
  await writeFile(script, 'print("install")\n');
  {
    const { state, dependencies } = harness();
    state.text = CODEX.replace('$ npm test', `$ python3 -I ${script}`);
    dependencies.precedent = () => ({ approve: true, reason: 'reversible', reviewer: 'user' });
    dependencies.decide = async () => { state.decisions++; return { approve: true, reason: 'reversible' }; };
    const result = await review('w8:p1', dependencies);
    assert.equal(result.reason, 'approved-once');
    assert.equal(result.detail, undefined);
    assert.equal(state.decisions, 1);
  }
  {
    await writeFile(script, 'token = "ghp_0123456789abcdef"\n');
    const { state, dependencies } = harness();
    state.text = CODEX.replace('$ npm test', `$ python3 -I ${script}`);
    dependencies.decide = () => assert.fail('must not classify a script with a credential');
    assert.equal((await review('w8:p1', dependencies)).reason, 'sensitive-content');
    assert.deepEqual(state.keys, []);
  }
});

test('history records one claimed request and keeps its text out of command logs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'permissions-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, dependencies } = harness();
  state.agent.cwd = '/project';
  dependencies.record = (entry) => recordHistory(directory, entry);
  const result = await review('w8:p1', dependencies);
  assert.equal(result.reason, 'approved-once');
  assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
  const entries = await readHistory(directory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].request, parsePrompt('codex', CODEX).text);
  assert.equal(entries[0].cwd, '/project');
  assert.equal(entries[0].agent, 'codex');
  assert.equal(entries[0].pane, 'w8:p1');
  assert.equal(entries[0].reason, 'approved-once');
  assert.equal(JSON.stringify(result).includes('npm test'), false);
});

test('manual decisions, changed prompts, and local denials reach history once', async () => {
  for (const reason of ['human-review', 'prompt-changed', 'human-only-action']) {
    const { state, dependencies } = harness();
    const entries = [];
    dependencies.record = async (entry) => entries.push(entry);
    if (reason === 'human-only-action') state.text = CODEX.replaceAll('npm test', 'git push');
    else dependencies.decide = async () => {
      if (reason === 'prompt-changed') state.text = CODEX.replaceAll('npm test', 'rm -rf ~/Documents');
      return { approve: reason === 'prompt-changed', reason: 'human-review', reviewer: 'pi', probability: 0.7 };
    };
    assert.equal((await review('w8:p1', dependencies)).reason, reason);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, reason);
    assert.equal(state.keys.length, 0);
    if (reason !== 'human-only-action') {
      assert.equal(entries[0].probability, 0.7);
      assert.equal(entries[0].reviewer, 'pi');
    }
  }
});

test('a should-approve label replaces the classifier for the exact same request', async () => {
  const { state, dependencies } = harness();
  const entries = [];
  dependencies.record = async (entry) => entries.push(entry);
  const request = parsePrompt('codex', CODEX).text;
  state.agent.cwd = '/project';
  dependencies.precedent = (text, cwd) => localPrecedent([{ request, label: 'approve', cwd: '/project' }], text, cwd);
  dependencies.decide = () => assert.fail('the classifier must not run');
  dependencies.getKey = () => assert.fail('the Keychain must not be read');
  assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
  assert.deepEqual(state.keys, [{ target: 'w8:p1', keys: ['y'] }]);
  assert.equal(entries[0].reviewer, 'user');
  assert.equal(entries[0].detail, 'user-precedent');
  assert.equal(entries[0].outcome, undefined);
  assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
  assert.equal(state.keys.length, 1);
});

test('an approval label for another directory does not replace the classifier', async () => {
  for (const cwd of [undefined, '/other']) {
    const { state, dependencies } = harness();
    state.agent.cwd = cwd;
    const request = parsePrompt('codex', CODEX).text;
    dependencies.precedent = (text, current) => localPrecedent([{ request, label: 'approve', cwd: '/project' }], text, current);
    dependencies.decide = async () => { state.decisions++; return { approve: false, reason: 'human-review' }; };
    assert.equal((await review('w8:p1', dependencies)).reason, 'human-review');
    assert.equal(state.decisions, 1);
    assert.deepEqual(state.keys, []);
  }
});

test('a should-take-no-action label keeps the exact request for a human', async () => {
  const { state, dependencies } = harness();
  const entries = [];
  dependencies.record = async (entry) => entries.push(entry);
  const request = parsePrompt('codex', CODEX).text;
  dependencies.precedent = (text, cwd) => localPrecedent([{ request, label: 'manual' }], text, cwd);
  dependencies.decide = () => assert.fail('the classifier must not run');
  assert.equal((await review('w8:p1', dependencies)).reason, 'user-precedent-manual');
  assert.deepEqual(state.keys, []);
  assert.equal(entries[0].reviewer, 'user');
  assert.equal(entries[0].detail, undefined);
});

test('local checks, changed prompts, and a disabled plugin still win over a label', async () => {
  const request = parsePrompt('codex', CODEX).text;
  const approve = (text, cwd) => localPrecedent([{ request, label: 'approve', cwd: '/project' }], text, cwd);
  {
    const { state, dependencies } = harness();
    state.text = CODEX.replaceAll('npm test', 'git push');
    dependencies.precedent = approve;
    dependencies.decide = () => assert.fail('the classifier must not run');
    assert.equal((await review('w8:p1', dependencies)).reason, 'human-only-action');
    assert.deepEqual(state.keys, []);
  }
  {
    const { state, dependencies } = harness();
    state.agent.cwd = '/project';
    dependencies.precedent = approve;
    dependencies.decide = () => assert.fail('the classifier must not run');
    const call = dependencies.call;
    dependencies.call = async (method, params) => {
      if (method === 'plugin.list') state.enabled = false;
      return call(method, params);
    };
    assert.equal((await review('w8:p1', dependencies)).reason, 'plugin-disabled');
    assert.deepEqual(state.keys, []);
  }
  {
    const { state, dependencies } = harness();
    state.agent.cwd = '/project';
    dependencies.precedent = approve;
    const call = dependencies.call;
    dependencies.call = async (method, params) => {
      if (method === 'plugin.list') { state.text = CODEX.replace('$ npm test', '$ rm -rf ~/Documents'); state.agent.revision++; }
      return call(method, params);
    };
    assert.equal((await review('w8:p1', dependencies)).reason, 'prompt-changed');
    assert.deepEqual(state.keys, []);
  }
});

test('errors after the claim record manual or uncertain outcomes without error text', async () => {
  for (const failAt of ['keychain', 'decision', 'plugin.list', 'agent.send_keys']) {
    const { dependencies } = harness();
    const entries = [];
    dependencies.record = async (entry) => entries.push(entry);
    if (failAt === 'keychain') dependencies.getKey = () => { throw new Error('private failure'); };
    else if (failAt === 'decision') dependencies.decide = async () => { throw new Error('private failure'); };
    else {
      const call = dependencies.call;
      dependencies.call = async (method, params) => {
        if (method === failAt) throw new Error('private failure');
        return call(method, params);
      };
    }
    await assert.rejects(review('w8:p1', dependencies));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, failAt === 'agent.send_keys' ? 'approval-delivery-unknown' : 'unavailable-human-review');
    assert.equal(JSON.stringify(entries).includes('private failure'), false);
  }
});

test('history write failures do not change approvals or permit a second send', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (text) => errors.push(JSON.parse(text)));
  const { state, dependencies } = harness();
  dependencies.record = async () => { throw new Error('private storage failure'); };
  assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
  assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
  assert.equal(state.keys.length, 1);
  assert.deepEqual(errors, [{ pane: 'w8:p1', reason: 'history-unavailable' }]);
});

test('Pi approvals use the final prompt and plugin checks before sending one key', async () => {
  for (const change of [
    () => {},
    (s) => s.text = CODEX.replace('npm test', 'rm -rf ~/Documents'),
    (s) => s.enabled = false,
    (s) => s.agent.state_change_seq++,
  ]) {
    const { state, dependencies } = harness();
    dependencies.decide = (prompt, key) => classify(prompt, key, async () => response(0.7), async () => {
      change(state);
      return { approve: true, reason: 'reversible' };
    });
    const result = await review('w8:p1', dependencies);
    const unchanged = state.text === CODEX && state.enabled && state.agent.state_change_seq === 2;
    assert.equal(state.keys.length, unchanged ? 1 : 0);
    if (unchanged) {
      assert.equal(result.reason, 'approved-once');
      assert.equal(result.reviewer, 'pi');
      assert.equal(result.probability, 0.7);
    }
  }
});

test('stable approval accepts the zero read revision from Herdr 0.9.3', async () => {
  const { state, dependencies } = harness();
  assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
  assert.deepEqual(state.keys, [{ target: 'w8:p1', keys: ['y'] }]);
  assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
  assert.equal(state.decisions, 1);
});

test('redraws that keep the prompt text do not stop approval', async () => {
  for (const changedRead of [1, 2]) {
    const { state, dependencies } = harness();
    const call = dependencies.call;
    let reads = 0;
    dependencies.call = async (method, params) => {
      const result = await call(method, params);
      if (method === 'agent.read' && ++reads === changedRead) state.agent.revision++;
      return result;
    };
    assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
    assert.deepEqual(state.keys, [{ target: 'w8:p1', keys: ['y'] }]);
  }
});

test('a redraw during classification with the same prompt text is approved', async () => {
  const { state, dependencies } = harness();
  dependencies.decide = async () => { state.agent.revision++; return { approve: true }; };
  assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
  assert.equal(state.keys.length, 1);
});

test('conversation redraws do not block approval or repeat a completed approval', async () => {
  for (const [agent, text, key] of [['claude', CLAUDE, '1'], ['codex', CODEX, 'y']]) {
    const { state, dependencies } = harness();
    state.agent.agent = agent;
    state.text = 'Old conversation\n' + text;
    dependencies.decide = async () => {
      state.decisions++;
      state.text = 'Updated conversation\n' + text;
      state.agent.revision++;
      return { approve: true };
    };
    assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
    state.text = 'Another redraw\n' + text;
    assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
    assert.deepEqual(state.keys, [{ target: 'w8:p1', keys: [key] }]);
    assert.equal(state.decisions, 1);
  }
});

test('a changed one-time shortcut stops approval even when the command is unchanged', async () => {
  const { state, dependencies } = harness();
  dependencies.decide = async () => {
    state.text = CODEX.replace('(y)', '(a)');
    return { approve: true };
  };
  assert.equal((await review('w8:p1', dependencies)).reason, 'prompt-changed');
  assert.deepEqual(state.keys, []);
});

test('a final check failure releases the claim and safely retries the same request', async () => {
  for (const change of [
    (s) => s.truncated = true,
    (s) => s.text = CODEX.replace('npm test', 'npm run build'),
    (s) => s.text = CODEX.replace('› 1.', '1.').replace('  2.', '› 2.'),
  ]) {
    const { state, dependencies } = harness();
    const decide = dependencies.decide;
    dependencies.decide = async (...args) => { change(state); return decide(...args); };
    assert.equal((await review('w8:p1', dependencies)).reason, 'prompt-changed');
    assert.equal(state.claimed.size, 0);
    assert.deepEqual(state.keys, []);
    state.text = CODEX;
    state.truncated = false;
    dependencies.decide = decide;
    assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
    assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
    assert.equal(state.keys.length, 1);
    assert.equal(state.decisions, 2);
  }
});

test('a failed claim release stays manual without another classification or send', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (text) => errors.push(JSON.parse(text)));
  const { state, dependencies } = harness();
  dependencies.decide = async () => { state.decisions++; state.truncated = true; return { approve: true }; };
  dependencies.release = async () => { throw new Error('storage unavailable'); };
  assert.equal((await review('w8:p1', dependencies)).reason, 'prompt-changed');
  state.truncated = false;
  assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
  assert.equal(state.decisions, 1);
  assert.deepEqual(state.keys, []);
  assert.deepEqual(errors, [{ pane: 'w8:p1', reason: 'claim-release-unavailable' }]);
});

test('constant output changes stop approval', async () => {
  const { state, dependencies } = harness();
  const call = dependencies.call;
  dependencies.call = async (method, params) => {
    const result = await call(method, params);
    if (method === 'agent.read') state.agent.revision++;
    return result;
  };
  assert.equal((await review('w8:p1', dependencies)).detail, 'output-changed-during-read');
  assert.equal(state.decisions, 0);
});

test('a dialog swap right after the final read is not approved', async () => {
  const { state, dependencies } = harness();
  const call = dependencies.call;
  let reads = 0;
  dependencies.call = async (method, params) => {
    const result = await call(method, params);
    if (method === 'agent.read' && ++reads === 2) {
      state.text = CODEX.replace('npm test', 'rm -rf ~/Documents');
      state.agent.revision++;
    }
    return result;
  };
  assert.equal((await review('w8:p1', dependencies)).reason, 'prompt-changed');
  assert.deepEqual(state.keys, []);
});

test('snapshot rejections log specific reasons without prompt contents', async () => {
  for (const [change, detail] of [
    [(s) => s.truncated = true, 'pane-read-truncated'],
    [(s) => s.text = 'A private unknown prompt', 'prompt-format-unrecognized'],
    [(s) => s.agent.agent_status = 'working', 'agent-not-blocked'],
    [(s) => s.agent.revision = undefined, 'invalid-agent-identity'],
    [(s) => s.readRevision = undefined, 'invalid-pane-read'],
  ]) {
    const { state, dependencies } = harness();
    change(state);
    const result = await review('w8:p1', dependencies);
    assert.deepEqual(result, { reason: 'unrecognized-or-changed-prompt', detail });
    assert.equal(state.decisions, 0);
    assert.deepEqual(state.keys, []);
  }
});

test('changes during classification stop a pending approval', async () => {
  for (const change of [
    (s) => s.text = CODEX.replace('npm test', 'rm -rf ~/Documents'),
    (s) => s.agent.agent_status = 'working',
    (s) => s.agent.terminal_id = 'term-2',
    (s) => s.agent.agent_session.value = 'session-2',
    (s) => s.agent.state_change_seq++,
    (s) => s.enabled = false,
    (s) => s.truncated = true,
  ]) {
    const { state, dependencies } = harness();
    dependencies.decide = async () => { change(state); return { approve: true }; };
    assert.notEqual((await review('w8:p1', dependencies)).reason, 'approved-once');
    assert.deepEqual(state.keys, []);
  }
});

test('unknown and truncated prompts do not call the classifier or Keychain', async () => {
  for (const change of [(s) => s.truncated = true, (s) => s.text = 'Ask a question?', (s) => s.agent.agent_status = 'working']) {
    const { state, dependencies } = harness();
    change(state);
    dependencies.getKey = () => assert.fail('must not read credentials');
    assert.equal((await review('w8:p1', dependencies)).reason, 'unrecognized-or-changed-prompt');
    assert.equal(state.decisions, 0);
  }
});

test('an ambiguous send failure is never retried for the same request', async () => {
  const { state, dependencies } = harness();
  const call = dependencies.call;
  dependencies.call = async (method, params) => {
    const result = await call(method, params);
    if (method === 'agent.send_keys') throw new Error('socket closed after delivery');
    return result;
  };
  await assert.rejects(review('w8:p1', dependencies));
  state.text = 'A new conversation redraw\n' + CODEX;
  assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
  assert.equal(state.keys.length, 1);
});

test('manual decisions and classifier errors remain claimed across redraws', async () => {
  for (const fails of [false, true]) {
    const { state, dependencies } = harness();
    dependencies.decide = async () => {
      state.decisions++;
      if (fails) throw new Error('classifier unavailable');
      return { approve: false, reason: 'human-review' };
    };
    if (fails) await assert.rejects(review('w8:p1', dependencies));
    else assert.equal((await review('w8:p1', dependencies)).reason, 'human-review');
    state.text = 'Redrawn conversation\n' + CODEX;
    assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
    assert.equal(state.decisions, 1);
    assert.deepEqual(state.keys, []);
  }
});

test('queued prompts are reviewed even while the agent stays blocked', async () => {
  const { state, dependencies } = harness();
  let pauses = 0;
  await drain('w8:p1', dependencies, { pause: async () => {
    if (++pauses === 2) { state.text = CODEX.replaceAll('npm test', 'npm run build'); state.agent.revision++; }
  } });
  assert.equal(state.keys.length, 2);
  assert.equal(state.decisions, 2);
});

test('a delayed event cannot review an approval from a later agent transition', async () => {
  const { state, dependencies } = harness();
  dependencies.expectedIdentity = JSON.stringify([
    state.agent.agent, state.agent.pane_id, state.agent.terminal_id,
    state.agent.agent_session, state.agent.state_change_seq, null, null,
  ]);
  assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
  state.agent.state_change_seq++;
  state.agent.revision++;
  state.text = CODEX.replaceAll('npm test', 'npm run build');
  assert.equal((await review('w8:p1', dependencies)).reason, 'agent-transitioned');
  assert.equal(state.keys.length, 1);
});

test('only the documented blocked event starts an automatic review', () => {
  const event = { event: 'pane_agent_status_changed', data: { type: 'pane_agent_status_changed', pane_id: 'w8:p1', agent_status: 'blocked' } };
  assert.equal(eventTarget(JSON.stringify(event)), 'w8:p1');
  assert.equal(eventTarget(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w8:p1', agent_status: 'blocked' } })), 'w8:p1');
  event.data.agent_status = 'idle';
  assert.equal(eventTarget(JSON.stringify(event)), null);
  event.data.agent_status = 'blocked';
  event.data.pane_id = '../file';
  assert.equal(eventTarget(JSON.stringify(event)), null);
  assert.equal(eventTarget('{'), null);
  assert.equal(eventTarget(undefined), null);
});

test('the file lock serializes reviewers and remembers a claim after release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-permissions-test-'));
  try {
    await withLock(dir, '/socket', 'w8:p1:term:seq', async (claim) => {
      assert.equal(await claim('fingerprint'), true);
      const other = await withLock(dir, '/socket', 'w8:p1:term:seq', () => assert.fail('lock held'));
      assert.equal(other.reason, 'review-in-progress');
    });
    await withLock(dir, '/socket', 'w8:p1:term:seq', async (claim) => assert.equal(await claim('fingerprint'), false));
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.equal(await readFile(join(dir, files[0]), 'utf8'), 'fingerprint');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('claim release is conditional, persists safe retries, and respects legacy claims', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-claims-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await withLock(dir, '/socket', 'request', async (claim) => {
    assert.equal(await claim('legacy'), true);
  });
  await withLock(dir, '/socket', 'request', async (claim, release) => {
    assert.equal(await claim('current', 'legacy'), false);
    await release('legacy');
    assert.equal(await claim('current', 'redrawn-legacy'), false);
    await release('current');
    assert.equal(await claim('current', 'legacy'), true);
    await release('current');
    await release('current');
  });
  await withLock(dir, '/socket', 'request', async (claim) => {
    assert.equal(await claim('current'), true);
  });
});

test('review migrates real legacy fingerprints without replaying them after a redraw', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'permissions-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { state, dependencies } = harness();
  const identity = JSON.stringify([
    state.agent.agent, state.agent.pane_id, state.agent.terminal_id,
    state.agent.agent_session, state.agent.state_change_seq, state.agent.cwd, state.agent.foreground_cwd,
  ]);
  const legacy = createHash('sha256').update(identity + CODEX).digest('hex');
  const current = createHash('sha256').update(identity + '\0' + JSON.stringify(parsePrompt('codex', CODEX))).digest('hex');
  await withLock(dir, '/socket', 'request', async (claim, release) => {
    assert.equal(await claim(legacy), true);
    dependencies.claim = claim;
    dependencies.release = release;
    assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
    state.text = 'Redrawn conversation\n' + CODEX;
    assert.equal((await review('w8:p1', dependencies)).reason, 'already-reviewed');
    const [file] = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    assert.equal(await readFile(join(dir, file), 'utf8'), current);
  });
  assert.deepEqual(state.keys, []);
  assert.equal(state.decisions, 0);
});

test('the socket transport carries a complete review without live agent input', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-permissions-rpc-'));
  const socketPath = join(dir, 'test.sock');
  const { state, dependencies } = harness();
  const handle = dependencies.call;
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.trim());
      const result = await handle(request.method, request.params);
      const response = JSON.stringify({ id: request.id, result }) + '\n';
      socket.write(response.slice(0, 8));
      socket.end(response.slice(8));
    });
  });
  try {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('This sandbox does not permit local sockets.');
      throw error;
    }
    dependencies.call = (method, params) => rpc(socketPath, method, params);
    assert.equal((await review('w8:p1', dependencies)).reason, 'approved-once');
    assert.deepEqual(state.keys, [{ target: 'w8:p1', keys: ['y'] }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('the event hook applies stored labels before the classifier over the socket', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-permissions-labels-'));
  const socketPath = join(dir, 'labels.sock');
  const { state, dependencies } = harness();
  const handle = dependencies.call;
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.trim());
      const result = await handle(request.method, request.params);
      socket.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  try {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('This sandbox does not permit local sockets.');
      throw error;
    }
    await recordFeedback(dir, { request: parsePrompt('codex', CODEX).text, label: 'manual' });
    const env = {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: socketPath, HERDR_PLUGIN_STATE_DIR: dir,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'pane_agent_status_changed', data: { type: 'pane_agent_status_changed', pane_id: 'w8:p1', agent_status: 'blocked' } }),
    };
    t.mock.method(console, 'log', () => {});
    await main('event', env);
    assert.equal(state.decisions, 0);
    assert.deepEqual(state.keys, []);
    const rows = await readHistory(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'user-precedent-manual');
    assert.equal(rows[0].reviewer, 'user');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
