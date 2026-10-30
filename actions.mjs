import { createHash, randomUUID } from 'node:crypto';
import { rpc, snapshot, withLock } from './index.mjs';
import { recordHistory } from './history.mjs';

const PANE_ID = /^w[\w-]+:p[\w-]+$/;

export function herdrCall(socketPath) {
  return (method, params) => rpc(socketPath, method, params);
}

// List agents that are waiting for permission, with the same checks that an
// automatic approval uses. A failed snapshot stays visible but not approvable.
export async function loadPending(call) {
  const response = await call('agent.list', {});
  const agents = Array.isArray(response?.agents) ? response.agents : [];
  const blocked = agents.filter((agent) => agent?.agent_status === 'blocked' && typeof agent.pane_id === 'string' && PANE_ID.test(agent.pane_id));
  return Promise.all(blocked.map(async (agent) => {
    const base = { pane: agent.pane_id, agent: typeof agent.agent === 'string' ? agent.agent : 'agent', cwd: agent.foreground_cwd ?? agent.cwd, live: true };
    try {
      const current = await snapshot(call, agent.pane_id);
      if (current.reason) return { ...base, reason: current.reason };
      return {
        ...base, identity: current.identity, request: current.prompt.text,
        agent: current.prompt.agent, cwd: current.cwd,
      };
    } catch { return { ...base, reason: 'unavailable' }; }
  }));
}

// Send one one-time approval key for a request that the user selected in the
// interface. The snapshot and every comparison happen after the claim, so a
// request that changed while the user looked at the list is never approved.
export async function approveRequest({
  call, stateDir, socketPath, target, expectedIdentity, expectedText,
  record = (entry) => recordHistory(stateDir, entry), id = randomUUID(),
}) {
  let agent;
  try { agent = (await call('agent.get', { target })).agent; }
  catch { return { ok: false, reason: 'agent-unavailable' }; }
  // Use the same lock and claim as the automatic review for this transition.
  // A changed transition takes its own lock; the checks inside it still apply.
  if (!agent || typeof agent.terminal_id !== 'string' || !Number.isSafeInteger(agent.state_change_seq)) {
    return { ok: false, reason: 'invalid-agent-identity' };
  }
  let current;
  let result;
  try {
    result = await withLock(stateDir, socketPath, `${target}:${agent.terminal_id}:${agent.state_change_seq}`, async (claim) => {
      current = await snapshot(call, target);
      if (current.reason) return { ok: false, reason: current.reason };
      if (expectedIdentity !== undefined && current.identity !== expectedIdentity) return { ok: false, reason: 'agent-transitioned' };
      if (typeof expectedText === 'string' && current.prompt.text !== expectedText) return { ok: false, reason: 'prompt-changed' };
      const fingerprint = createHash('sha256').update(current.identity + '\0' + JSON.stringify(current.prompt)).digest('hex');
      // A claim from an older version also blocks a human send, because that
      // attempt may already have delivered a key.
      const legacyFingerprint = createHash('sha256').update(current.identity + current.text).digest('hex');
      if (!(await claim(fingerprint, legacyFingerprint, { afterDecline: true }))) return { ok: false, reason: 'already-reviewed' };
      try { await call('agent.send_keys', { target, keys: current.prompt.keys }); }
      catch { return { ok: false, reason: 'approval-delivery-unknown' }; }
      return { ok: true, reason: 'approved-by-human' };
    });
  } catch { return { ok: false, reason: 'state-unavailable' }; }
  if (!result) return { ok: false, reason: 'state-unavailable' };
  if (!result.ok) {
    // An uncertain send is recorded so the interface can show it in history.
    if (result.reason === 'approval-delivery-unknown' && current?.prompt) {
      try {
        await record({ id, pane: target, agent: current.prompt.agent, cwd: current.cwd, request: current.prompt.text, reason: result.reason, reviewer: 'unknown' });
      } catch { /* History is optional. */ }
    }
    return result;
  }
  try {
    await record({
      id, pane: target, agent: current.prompt.agent, cwd: current.cwd,
      request: current.prompt.text, reason: 'approved-by-human', reviewer: 'human',
    });
  } catch { /* History is optional; the approval already happened. */ }
  return result;
}

export async function focusRequest(call, target) {
  try {
    await call('agent.focus', { target });
    return { ok: true };
  } catch { return { ok: false, reason: 'focus-unavailable' }; }
}
