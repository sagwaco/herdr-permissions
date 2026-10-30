import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { classify, localReason } from './policy.mjs';
import { parsePrompt } from './prompts.mjs';
import { recordHistory } from './history.mjs';
import { labelFor, labelIndex, precedentDecision, readFeedback } from './feedback.mjs';

export const PLUGIN_ID = 'sang.permissions';

export function readKeychain() {
  if (process.platform !== 'darwin') throw new Error('keychain-unavailable');
  try {
    const key = execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', 'model-router-typesafe', '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    if (key) return key;
  } catch { /* Keychain errors must not expose a credential or block the agent. */ }
  throw new Error('keychain-unavailable');
}

export function rpc(socketPath, method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('herdr-timeout')), 3_000);
    function finish(error, result) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.setEncoding('utf8');
    socket.on('error', () => finish(new Error('herdr-unavailable')));
    socket.on('end', () => finish(new Error('herdr-disconnected')));
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 256_000) return finish(new Error('herdr-response-too-large'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id || response.error || !response.result) throw new Error();
        finish(null, response.result);
      } catch { finish(new Error('herdr-invalid-response')); }
    });
  });
}

function identity(agent) {
  return JSON.stringify([
    agent.agent, agent.pane_id, agent.terminal_id, agent.agent_session,
    agent.state_change_seq, agent.cwd, agent.foreground_cwd,
  ]);
}

export async function snapshot(call, target, attempts = 5) {
  const before = (await call('agent.get', { target })).agent;
  if (before?.agent_status !== 'blocked' || before.pane_id !== target) return { reason: 'agent-not-blocked' };
  if (!before.terminal_id || !Number.isSafeInteger(before.state_change_seq) || !Number.isSafeInteger(before.revision)) {
    return { reason: 'invalid-agent-identity' };
  }
  const read = (await call('agent.read', {
    target, source: 'detection', strip_ansi: true, format: 'text',
  })).read;
  if (!read || typeof read.truncated !== 'boolean' || read.pane_id !== target || read.source !== 'detection' || !Number.isSafeInteger(read.revision)) {
    return { reason: 'invalid-pane-read' };
  }
  if (read.truncated) return { reason: 'pane-read-truncated' };
  const prompt = parsePrompt(before.agent, read.text);
  if (!prompt) return { reason: 'prompt-format-unrecognized' };
  const after = (await call('agent.get', { target })).agent;
  if (after?.agent_status !== 'blocked' || identity(before) !== identity(after)) return { reason: 'agent-changed-during-read' };
  // Herdr 0.9.3 sets agent.read.revision to zero; compare the two agent.get counters.
  // Codex redraws often change the counter, so read again a few times before giving up.
  if (before.revision !== after.revision) {
    return attempts > 1 ? snapshot(call, target, attempts - 1) : { reason: 'output-changed-during-read' };
  }
  return { identity: identity(after), agent: after, text: read.text, prompt, cwd: after.foreground_cwd ?? after.cwd };
}

export async function review(target, { call, getKey = readKeychain, decide = classify, claim, release, expectedIdentity, precedent, record = async () => {} }) {
  const initial = await snapshot(call, target);
  if (initial.reason) return { reason: 'unrecognized-or-changed-prompt', detail: initial.reason };
  if (expectedIdentity !== undefined && initial.identity !== expectedIdentity) return { reason: 'agent-transitioned' };
  // Claim before external calls. An interrupted attempt leaves this request for a human.
  const fingerprint = createHash('sha256').update(initial.identity + '\0' + JSON.stringify(initial.prompt)).digest('hex');
  const legacyFingerprint = createHash('sha256').update(initial.identity + initial.text).digest('hex');
  if (!(await claim(fingerprint, legacyFingerprint))) return { reason: 'already-reviewed' };
  const entry = { id: randomUUID(), pane: target, agent: initial.prompt.agent, cwd: initial.cwd, request: initial.prompt.text };
  const save = async (result) => {
    try { await record({ ...entry, ...result }); }
    catch { console.error(JSON.stringify({ pane: target, reason: 'history-unavailable' })); }
  };
  let result;
  try { result = await decideAndSend(target, initial, { call, getKey, decide, precedent, release: () => release(fingerprint) }); }
  catch (error) {
    await save({ reviewer: 'unknown', reason: error.message === 'approval-delivery-unknown' ? error.message : 'unavailable-human-review' });
    throw error;
  }
  await save(result);
  return result;
}

async function decideAndSend(target, initial, { call, getKey, decide, precedent, release }) {
  const reason = localReason(initial.prompt.text);
  if (reason) return { reason };
  // A user label for the exact same request replaces the classifier decision.
  // Local checks above still win, so secrets and human-only actions stay manual.
  const prior = precedent?.(initial.prompt.text, initial.cwd) ?? null;
  const decision = prior ?? await decide(initial.prompt, getKey());
  if (!decision.approve) return decision;
  // Disabling the plugin must stop an approval that is already in progress.
  const registry = await call('plugin.list', { plugin_id: PLUGIN_ID });
  if (!registry.plugins?.some((plugin) => plugin.plugin_id === PLUGIN_ID && plugin.enabled === true)) {
    return { ...decision, approve: false, reason: 'plugin-disabled' };
  }
  const current = await snapshot(call, target);
  // Compare the request and its one-time keys, not surrounding conversation text.
  if (current.reason || current.identity !== initial.identity || JSON.stringify(current.prompt) !== JSON.stringify(initial.prompt)) {
    // No key has been sent. Keep the claim if its release fails.
    try { await release(); }
    catch { console.error(JSON.stringify({ pane: target, reason: 'claim-release-unavailable' })); }
    return { ...decision, approve: false, reason: 'prompt-changed', ...(current.reason ? { detail: current.reason } : {}) };
  }
  try { await call('agent.send_keys', { target, keys: initial.prompt.keys }); }
  catch { throw new Error('approval-delivery-unknown'); }
  return { ...decision, reason: 'approved-once', ...(prior ? { detail: 'user-precedent' } : {}) };
}

export async function drain(target, dependencies, { pause = sleep, report = () => {} } = {}) {
  let unchanged = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await review(target, dependencies);
    report(result);
    if (['already-reviewed', 'unrecognized-or-changed-prompt'].includes(result.reason)) {
      if (++unchanged === 4) return;
    } else {
      unchanged = 0;
      if (!['approved-once', 'prompt-changed'].includes(result.reason)) return;
    }
    // A queued approval can replace the dialog without a blocked-state transition.
    await pause(350);
  }
}

export function eventTarget(raw) {
  try {
    const event = JSON.parse(raw);
    const data = event.data;
    if (['pane_agent_status_changed', 'pane.agent_status_changed'].includes(event.event)
      && (data?.type === undefined || data.type === 'pane_agent_status_changed') && data?.agent_status === 'blocked') {
      return /^w[\w-]+:p[\w-]+$/.test(data.pane_id) ? data.pane_id : null;
    }
  } catch { /* Unrecognized events need no action. */ }
  return null;
}

export async function withLock(stateDir, socketPath, target, task) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(socketPath + ':' + target).digest('hex');
  const lockPath = join(stateDir, name + '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return { reason: 'review-in-progress' };
    throw error;
  }
  try {
    const claimedPath = join(stateDir, name + '.json');
    return await task(async (fingerprint, legacyFingerprint) => {
      let previous;
      try {
        previous = await readFile(claimedPath, 'utf8');
        if (previous === fingerprint) return false;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Replace atomically so migration cannot erase an existing send marker.
      const temporary = claimedPath + '.' + randomUUID() + '.tmp';
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(fingerprint); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, claimedPath);
      } finally {
        try { await unlink(temporary); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return legacyFingerprint === undefined || previous !== legacyFingerprint;
    }, async (fingerprint) => {
      try { if ((await readFile(claimedPath, 'utf8')) === fingerprint) await unlink(claimedPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function main(mode, env = process.env) {
  if (env.HERDR_ENV !== '1' || !env.HERDR_SOCKET_PATH || !env.HERDR_PLUGIN_STATE_DIR) {
    throw new Error('plugin-context-required');
  }
  const call = (method, params) => rpc(env.HERDR_SOCKET_PATH, method, params);
  if (mode === 'check') {
    const result = await classify({ agent: 'codex', text: 'Would you like to run the following command?\n\n$ git status --short' }, readKeychain());
    console.log(JSON.stringify({ ...result, connected: result.probability !== undefined }));
    return;
  }
  let targets;
  if (mode === 'event') {
    const target = eventTarget(env.HERDR_PLUGIN_EVENT_JSON);
    targets = target ? [target] : [];
  } else if (mode === 'scan') {
    targets = (await call('agent.list', {})).agents.filter((a) => a.agent_status === 'blocked').map((a) => a.pane_id);
  } else throw new Error('unknown-command');
  // Labels are a local hint. A read failure must not block permission work.
  let labels = [];
  try { labels = await readFeedback(env.HERDR_PLUGIN_STATE_DIR); } catch { /* Use no precedents. */ }
  const precedents = labelIndex(labels);
  const precedent = (text, cwd) => precedentDecision(labelFor(precedents, text, cwd));
  for (const target of targets) {
    try {
      const agent = (await call('agent.get', { target })).agent;
      if (agent?.agent_status !== 'blocked') continue;
      const requestKey = `${target}:${agent.terminal_id}:${agent.state_change_seq}`;
      await withLock(env.HERDR_PLUGIN_STATE_DIR, env.HERDR_SOCKET_PATH, requestKey, async (claim, release) => {
        // Allow the permission dialog to finish drawing after the status event.
        await sleep(350);
        return drain(target, {
          call, claim, release, expectedIdentity: identity(agent), precedent,
          record: (entry) => recordHistory(env.HERDR_PLUGIN_STATE_DIR, entry),
        }, {
          report: (result) => console.log(JSON.stringify({ pane: target, ...result })),
        });
      });
    } catch {
      console.log(JSON.stringify({ pane: target, reason: 'unavailable-human-review' }));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(() => {
    console.error('Permission Approver is unavailable. The prompt remains for human review.');
    process.exitCode = 1;
  });
}
