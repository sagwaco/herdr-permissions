import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { classify, localReason, policyText } from './policy.mjs';
import { readScripts, verifyScripts } from './scripts.mjs';
import { codexPreviewClipped, expandCodexPreview, parsePrompt } from './prompts.mjs';
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

async function readPane(call, target) {
  const read = (await call('agent.read', {
    target, source: 'detection', strip_ansi: true, format: 'text',
  })).read;
  if (!read || typeof read.truncated !== 'boolean' || read.pane_id !== target || read.source !== 'detection' || !Number.isSafeInteger(read.revision)) {
    return null;
  }
  return read;
}

const PAGER_STATUS = /^─+ (\d+)% ─$/;
// The history pane polls pending requests. Reuse a successful expansion until
// the agent redraws, so an unresolved long prompt does not keep paging the UI.
const previewCache = new WeakMap();

function pagerPage(text) {
  const lines = text.split('\n');
  if (!/^\/ .*\/ /.test(lines[0])) return null;
  // The last status line is the pager footer; earlier matches can be command text.
  const status = lines.findLastIndex((line) => PAGER_STATUS.test(line));
  if (status < 1) return null;
  return { lines: lines.slice(1, status), percent: Number(PAGER_STATUS.exec(lines[status])[1]) };
}

function mergePagerPages(pages) {
  let lines = pages[0].lines;
  for (const page of pages.slice(1)) {
    let overlap = Math.min(lines.length, page.lines.length);
    while (overlap > 0 && !lines.slice(-overlap).every((line, i) => line === page.lines[i])) overlap--;
    if (overlap === 0) return null;
    lines = lines.concat(page.lines.slice(overlap));
  }
  return lines;
}

// Long Codex command previews open a pager with ctrl+a. Read every page,
// restore the dialog, and only accept the expansion when the dialog is unchanged.
async function readCodexPreview(call, target, original) {
  let opened = false;
  let closed = false;
  let result = null;
  try {
    await call('agent.send_keys', { target, keys: ['ctrl+a'] });
    opened = true;
    const pages = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(120);
      const read = await readPane(call, target);
      if (!read || read.truncated) break;
      const page = pagerPage(read.text);
      if (!page) break;
      pages.push(page);
      if (page.percent === 100) break;
      await call('agent.send_keys', { target, keys: ['ctrl+f'] });
    }
    if (pages.at(-1)?.percent !== 100) throw new Error('preview-incomplete');
    const command = mergePagerPages(pages);
    if (!command) throw new Error('preview-discontinuous');
    result = expandCodexPreview(original, command);
  } catch { result = null; }
  finally {
    if (opened) {
      try { await call('agent.send_keys', { target, keys: ['q'] }); closed = true; }
      catch { /* A failed close keeps the request manual. */ }
    }
  }
  if (!result || !closed) return null;
  try {
    await sleep(120);
    const restored = await readPane(call, target);
    if (!restored || restored.truncated || restored.text !== original) return null;
  } catch { return null; }
  return result;
}

export async function snapshot(call, target, attempts = 5) {
  const before = (await call('agent.get', { target })).agent;
  if (before?.agent_status !== 'blocked' || before.pane_id !== target) return { reason: 'agent-not-blocked' };
  if (!before.terminal_id || !Number.isSafeInteger(before.state_change_seq) || !Number.isSafeInteger(before.revision)) {
    return { reason: 'invalid-agent-identity' };
  }
  const read = await readPane(call, target);
  if (!read) return { reason: 'invalid-pane-read' };
  if (read.truncated) return { reason: 'pane-read-truncated' };
  let prompt = parsePrompt(before.agent, read.text);
  let text = read.text;
  let expanded = false;
  let cache = null;
  let cacheKey = null;
  let previewResult = null;
  if (!prompt && before.agent === 'codex' && codexPreviewClipped(read.text)) {
    cacheKey = identity(before) + '\0' + read.text;
    cache = previewCache.get(call);
    if (!cache) { cache = new Map(); previewCache.set(call, cache); }
    const cached = cache.get(cacheKey);
    let preview = cached?.revision === before.revision ? cached.preview : null;
    if (!preview) {
      preview = await readCodexPreview(call, target, read.text);
      if (preview) expanded = true;
    }
    if (!preview) return { reason: 'prompt-format-unrecognized' };
    previewResult = preview;
    prompt = preview.prompt;
    text = preview.text;
  }
  if (!prompt) return { reason: 'prompt-format-unrecognized' };
  const after = (await call('agent.get', { target })).agent;
  if (after?.agent_status !== 'blocked' || identity(before) !== identity(after)) return { reason: 'agent-changed-during-read' };
  // Herdr 0.9.3 sets agent.read.revision to zero; compare the two agent.get counters.
  // Codex redraws often change the counter, so read again a few times before giving up.
  // Our own pager open/close changes the counter, and the restored dialog was
  // already compared with the clipped screen before returning.
  if (!expanded && before.revision !== after.revision) {
    return attempts > 1 ? snapshot(call, target, attempts - 1) : { reason: 'output-changed-during-read' };
  }
  if (expanded && previewResult) {
    if (cache.size >= 50) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { preview: previewResult, revision: after.revision });
  }
  return { identity: identity(after), agent: after, text, prompt, cwd: after.foreground_cwd ?? after.cwd };
}

export async function review(target, { call, getKey = readKeychain, decide = classify, claim, release, decline = async () => {}, expectedIdentity, precedent, record = async () => {} }) {
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
  // Only approved-once and approval-delivery-unknown follow a send attempt.
  // Every other outcome sent no key, so a human can still approve the request.
  const markDeclined = async () => {
    try { await decline(fingerprint); }
    catch { console.error(JSON.stringify({ pane: target, reason: 'claim-decline-unavailable' })); }
  };
  let scripts;
  try { scripts = (await readScripts(initial.prompt.text, initial.cwd)).scripts; }
  catch { scripts = null; }
  if (!scripts) {
    await markDeclined();
    await save({ reason: 'script-unreadable', reviewer: 'local' });
    return { reason: 'script-unreadable' };
  }
  let result;
  try { result = await decideAndSend(target, initial, { call, getKey, decide, precedent, scripts, release: () => release(fingerprint) }); }
  catch (error) {
    const sent = error.message === 'approval-delivery-unknown';
    if (!sent) await markDeclined();
    await save({ reviewer: 'unknown', reason: sent ? error.message : 'unavailable-human-review' });
    throw error;
  }
  if (result.reason !== 'approved-once') await markDeclined();
  await save(result);
  return result;
}

async function decideAndSend(target, initial, { call, getKey, decide, precedent, release, scripts = [] }) {
  const request = scripts.length ? { ...initial.prompt, scripts } : initial.prompt;
  const reason = localReason(policyText(request));
  if (reason) return { reason };
  // A user label for the exact same request replaces the classifier decision.
  // Local checks above still win, so secrets and human-only actions stay manual.
  // A text-only approval label must not approve different script contents.
  const prior = precedent?.(initial.prompt.text, initial.cwd) ?? null;
  const usesPrior = Boolean(prior && (!prior.approve || scripts.length === 0));
  const decision = usesPrior ? prior : await decide(request, getKey());
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
  if (scripts.length) {
    const changed = await verifyScripts(scripts);
    if (changed) return { ...decision, approve: false, reason: changed.reason };
  }
  try { await call('agent.send_keys', { target, keys: initial.prompt.keys }); }
  catch { throw new Error('approval-delivery-unknown'); }
  return { ...decision, reason: 'approved-once', ...(usesPrior ? { detail: 'user-precedent' } : {}) };
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

const DECLINED = 'declined:';

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
    // Replace atomically so migration cannot erase an existing send marker.
    const write = async (content) => {
      const temporary = claimedPath + '.' + randomUUID() + '.tmp';
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(content); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, claimedPath);
      } finally {
        try { await unlink(temporary); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    };
    const read = async () => {
      try { return await readFile(claimedPath, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    // A declined claim records that the review sent no key. Only a human
    // approval (afterDecline) can claim the same request again.
    return await task(async (fingerprint, legacyFingerprint, { afterDecline = false } = {}) => {
      const previous = await read();
      if (previous === fingerprint) return false;
      if (previous === DECLINED + fingerprint && !afterDecline) return false;
      await write(fingerprint);
      return legacyFingerprint === undefined || previous !== legacyFingerprint;
    }, async (fingerprint) => {
      try { if ((await readFile(claimedPath, 'utf8')) === fingerprint) await unlink(claimedPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, async (fingerprint) => {
      if ((await read()) === fingerprint) await write(DECLINED + fingerprint);
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
      await withLock(env.HERDR_PLUGIN_STATE_DIR, env.HERDR_SOCKET_PATH, requestKey, async (claim, release, decline) => {
        // Allow the permission dialog to finish drawing after the status event.
        await sleep(350);
        return drain(target, {
          call, claim, release, decline, expectedIdentity: identity(agent), precedent,
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
