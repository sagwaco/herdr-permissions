import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readHistory } from './history.mjs';
import { FEEDBACK_LABELS, labelFor, labelIndex, readFeedback, recordFeedback } from './feedback.mjs';
import { approveRequest, focusRequest, herdrCall, loadPending } from './actions.mjs';
import { clearPane, savePane } from './panes.mjs';

const LABEL_MARKS = { approve: '+', manual: '-' };

// ANSI color helpers for TTY screen output.
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
function c(text, code) { return `${code}${text}${RESET}`; }
function bold(text) { return c(text, BOLD); }
function dim(text) { return c(text, DIM); }
function red(text) { return c(text, RED); }
function green(text) { return c(text, GREEN); }
function yellow(text) { return c(text, YELLOW); }
function cyan(text) { return c(text, CYAN); }
function gray(text) { return c(text, GRAY); }

export function sanitize(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
}

// Reserve two columns for non-ASCII characters so wide text cannot overflow.
const cellWidth = (character) => character.codePointAt(0) > 0x7e ? 2 : 1;

export function clip(value, width) {
  let result = '';
  let used = 0;
  let inEscape = false;
  for (const character of String(value ?? '')) {
    if (inEscape) {
      result += character;
      if ((character >= '@' && character <= '~') || (character >= ' ' && character <= '/')) inEscape = false;
      continue;
    }
    if (character === '\x1b') {
      inEscape = true;
      result += character;
      continue;
    }
    const clean = character.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
    if (clean !== character) {
      result += clean;
      continue;
    }
    const cells = cellWidth(character);
    if (used + cells > width) break;
    result += character;
    used += cells;
  }
  return result;
}

function wrap(value, width) {
  const result = [];
  const lines = stripVTControlCharacters(String(value ?? '')).split(/\r\n?|\n|\u2028|\u2029/);
  for (const line of lines) {
    let part = '';
    let used = 0;
    for (let character of sanitize(line)) {
      if (cellWidth(character) > width) character = '?';
      const cells = cellWidth(character);
      if (used + cells > width) {
        result.push(part);
        part = '';
        used = 0;
      }
      part += character;
      used += cells;
    }
    result.push(part);
  }
  return result;
}

export function labelText(label) {
  return FEEDBACK_LABELS[label] ?? 'none';
}

export function detailLines(entry, width, color = false) {
  if (!entry) return [];
  const fields = [
    ['Time', entry.processedAt], ['Result', entry.outcome], ['Reviewer', entry.reviewer],
    ['Jev score', entry.probability], ['Reason', entry.reason], ['Detail', entry.detail],
    ['Label', entry.label ? labelText(entry.label) : undefined],
    ['Live', entry.live ? 'yes' : undefined],
    ['Pane', entry.pane], ['Agent', entry.agent], ['Directory', entry.cwd], ['ID', entry.id],
  ];
  const lines = [
    ...fields.filter(([, value]) => value !== undefined && value !== null)
      .map(([label, value]) => `${label}: ${value}`),
    '', 'Request:', entry.request,
  ].flatMap((line) => wrap(line, width));
  if (!color) return lines;
  // Color after wrapping so escape codes never count toward the line width.
  return lines.map((line) => {
    if (line === 'Request:') return cyan(line);
    const split = line.indexOf(': ');
    const paint = split < 0 ? undefined : DETAIL_COLORS[line.slice(0, split)];
    return paint ? `${gray(`${line.slice(0, split)}:`)} ${paint(line.slice(split + 2))}` : line;
  });
}

export function listEntries(state) {
  return state.tab === 'pending' ? state.pending : state.entries;
}

export function selectionField(state) {
  return state.tab === 'pending' ? 'pendingSelected' : 'selected';
}

export function selectedEntry(state) {
  return listEntries(state)?.[state[selectionField(state)]];
}

export function switchTab(state) {
  return {
    ...state, tab: state.tab === 'pending' ? 'history' : 'pending',
    pendingSelected: state.pendingSelected ?? 0, detail: false, offset: 0,
  };
}

export function replaceHistory(state, entries) {
  const selectedId = state.entries[state.selected]?.id;
  const match = selectedId === undefined ? -1 : entries.findIndex((entry) => entry.id === selectedId);
  return {
    ...state, entries,
    selected: match >= 0 ? match : Math.max(0, Math.min(state.selected, entries.length - 1)),
    detail: state.detail && match >= 0,
    offset: match >= 0 ? state.offset : 0,
    error: '',
  };
}

export function replacePending(state, pending) {
  const previous = state.pending[state.pendingSelected ?? 0];
  // Keep the row under the cursor only while it still shows the same request.
  let match = previous === undefined ? -1
    : pending.findIndex((entry) => entry.pane === previous.pane && entry.request === previous.request);
  // Keep the cursor on the same pane when its text changed; otherwise start at
  // the top instead of landing on an unrelated row by position.
  if (match < 0 && previous) match = pending.findIndex((entry) => entry.pane === previous.pane);
  return { ...state, pending, pendingSelected: match >= 0 ? match : 0 };
}

// Add user labels and mark rows that still wait for this exact request. A live
// history row receives the identity of the waiting request, so an approval from
// the history list is bound to the same agent transition.
export function annotate(entries, labels, pending = []) {
  const index = labelIndex(labels);
  const waiting = new Map((pending ?? []).map((entry) => [`${entry.pane}\0${entry.request}`, entry]));
  return entries.map((entry) => {
    const live = waiting.get(`${entry.pane}\0${entry.request}`) ?? (entry.live === true ? entry : undefined);
    return {
      ...entry,
      label: labelFor(index, entry.request, entry.cwd),
      live: Boolean(live),
      identity: live?.identity ?? entry.identity,
    };
  });
}

export function navigate(state, key, pageSize, lineCount = 0) {
  const items = listEntries(state);
  const field = selectionField(state);
  if (key === 'return' && items.length) return { ...state, detail: true, offset: 0 };
  if (key === 'escape') return { ...state, detail: false, offset: 0 };
  const target = state.detail ? 'offset' : field;
  const maximum = state.detail ? Math.max(0, lineCount - pageSize) : Math.max(0, items.length - 1);
  let value = state[target];
  if (key === 'up' || key === 'k') value--;
  if (key === 'down' || key === 'j') value++;
  if (key === 'pageup') value -= pageSize;
  if (key === 'pagedown') value += pageSize;
  if (key === 'home') value = 0;
  if (key === 'end') value = maximum;
  return { ...state, [target]: Math.max(0, Math.min(value, maximum)) };
}

export function requestSummary(request) {
  const lines = stripVTControlCharacters(String(request ?? '')).split(/\r\n?|\n|\u2028|\u2029/)
    .map((line) => sanitize(line).trim()).filter(Boolean);
  const command = lines.find((line) => /^\$\s+\S/.test(line));
  if (command) return command;
  if (/^(?:Would you like to (?:run the following command|make the following edits)\?|Bash command(?: \(.*\))?|Read file|Edit file|Overwrite file|Create file|Write file|Edit notebook)(?: · from .+)?$/.test(lines[0] ?? '')) lines.shift();
  return lines.join(' ').replace(/\s+/gu, ' ');
}

function outcomeColor(value) {
  return value === 'approve' ? green(value)
    : value === 'reject' ? red(value)
    : value === 'manual' ? yellow(value)
    : gray(value);
}

const DETAIL_COLORS = {
  Time: gray, Result: outcomeColor, Reviewer: yellow, 'Jev score': gray, Reason: yellow,
  Detail: gray, Label: yellow, Live: yellow, Pane: cyan, Agent: yellow, Directory: gray, ID: gray,
};

function summary(entry, color = false) {
  const time = sanitize(entry.processedAt).replace('T', ' ').slice(5, 19);
  const outcome = sanitize(entry.outcome);
  const reviewer = sanitize(entry.reviewer);
  const req = requestSummary(entry.request);
  if (!color) return `${time}  ${outcome}  ${reviewer}  ${req}`;
  return `${gray(time)}  ${outcomeColor(outcome)}  ${yellow(reviewer)}  ${req}`;
}

function mark(entry, color = false) {
  const live = entry.live ? (color ? yellow('*') : '*') : ' ';
  const label = LABEL_MARKS[entry.label] ?? '.';
  const coloredLabel = color
    ? (label === '+' ? green(label) : label === '-' ? red(label) : gray(label))
    : label;
  return `${live}${coloredLabel}`;
}

function pendingSummary(entry, color = false) {
  const request = requestSummary(entry.request) || `(${sanitize(entry.reason ?? 'unknown prompt')})`;
  if (!color) return `${sanitize(entry.pane)}  ${sanitize(entry.agent)}  ${request}`;
  return `${cyan(sanitize(entry.pane))}  ${yellow(sanitize(entry.agent))}  ${request}`;
}

function rowText(entry, tab, color = false) {
  return `${mark(entry, color)} ${tab === 'pending' ? pendingSummary(entry, color) : summary(entry, color)}`;
}

const LIST_HELP = 'j/k Enter | a approve f focus | y should approve n no action u clear | Tab lists | r refresh q quit';
const DETAIL_HELP = 'Esc back | j/k PgUp/PgDn scroll | a approve f focus y/n/u label | Tab lists | r refresh q quit';

export function renderPlain(entries) {
  return 'Permission history | Latest 1000 records | Time: UTC\n'
    + (entries.length ? entries.map((entry) => `${mark(entry)} ${summary(entry)}`).join('\n') : 'No permission history yet.') + '\n';
}

export function renderScreen(state, columns, rows) {
  const width = Math.max(1, columns - 1);
  const height = Math.max(1, rows);
  const pageSize = Math.max(1, height - 3);
  const tab = state.tab === 'pending' ? 'pending' : 'history';
  const view = {
    entries: [], selected: 0, pendingSelected: 0, ...state, tab,
    pending: state.pending ?? [],
  };
  const pendingTab = view.tab === 'pending' ? bold(`1 Pending ${view.pending.length}`) : dim(`1 Pending ${view.pending.length}`);
  const historyTab = view.tab === 'history' ? bold(`2 History ${view.entries.length}`) : dim(`2 History ${view.entries.length}`);
  const tabs = `${pendingTab} | ${historyTab}`;
  const items = listEntries(view);
  const liveness = bold('live label');
  const lines = [tab === 'pending'
    ? `${bold('Pending requests')} | ${bold('Live')} | Time: UTC | ${tabs}`
    : `${bold('Permission history')} | Latest 1000 records | Time: UTC | ${tabs}`];
  const selected = view[selectionField(view)];
  const position = items.length ? `${selected + 1}/${items.length}` : '0/0';
  const head = `${position} | ${view.detail ? bold('Details')
    : tab === 'pending' ? `${liveness} | ${cyan('Pane')}  ${yellow('Agent')}  Request` : `${liveness} | ${gray('Time')}  ${bold('Result')}  ${yellow('Reviewer')}  Request`}`;
  lines.push(view.error ? `Read error: ${sanitize(view.error)} | r retry`
    : view.status ? `${sanitize(view.status)} | ${head}` : head);
  if (view.detail) {
    const details = detailLines(items[selected], width, true);
    const offset = Math.min(view.offset, Math.max(0, details.length - pageSize));
    lines.push(...details.slice(offset, offset + pageSize));
  } else if (!items.length) {
    lines.push(tab === 'pending' ? dim('No agent is waiting for permission.') : dim('No permission history yet.'));
  } else {
    const start = Math.floor(selected / pageSize) * pageSize;
    lines.push(...items.slice(start, start + pageSize)
      .map((entry, index) => `${start + index === selected ? '>' : ' '} ${rowText(entry, tab, true)}`));
  }
  while (lines.length < height - 1) lines.push('');
  lines.push(view.detail ? DETAIL_HELP : LIST_HELP);
  return lines.slice(0, height).map((line) => clip(line, width)).join('\r\n');
}

const APPROVE_MESSAGES = {
  'already-reviewed': 'Already reviewed',
  'review-in-progress': 'Review in progress; retry shortly',
  'prompt-changed': 'Request changed; refresh',
  'agent-transitioned': 'Agent moved to a new request',
  'agent-not-blocked': 'Agent is not waiting',
  'agent-unavailable': 'Agent is unavailable',
  'approval-delivery-unknown': 'Delivery unknown; check the pane',
};

export function approveMessage(result) {
  if (result?.ok) return 'Approved once';
  const reason = result?.reason ?? 'unknown';
  return APPROVE_MESSAGES[reason] ?? `Cannot approve: ${sanitize(reason)}`;
}

export async function main({
  input = process.stdin, output = process.stdout,
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  socketPath = process.env.HERDR_SOCKET_PATH,
  read = readHistory, readLabels = readFeedback,
  // A popup has no pane ID. Any other placement is a normal pane that stays open.
  paneId = process.env.HERDR_PANE_ID,
  pending, approve, focus, label,
} = {}) {
  if (!stateDir) throw new Error('HERDR_PLUGIN_STATE_DIR is not set.');
  const call = socketPath ? herdrCall(socketPath) : null;
  const persistent = Boolean(paneId);
  const readPending = pending ?? (call ? () => loadPending(call) : async () => []);
  const approveEntry = approve ?? (call ? (entry) => approveRequest({
    call, stateDir, socketPath, target: entry.pane,
    expectedIdentity: entry.identity, expectedText: entry.request,
  }) : null);
  const focusEntry = focus ?? (call ? (target) => focusRequest(call, target) : null);
  const labelEntry = label ?? ((entry, value) => recordFeedback(stateDir, { request: entry.request, cwd: entry.cwd, label: value }));
  const readLabelsSafe = async () => { try { return await readLabels(stateDir); } catch { return []; } };

  if (!input.isTTY || !output.isTTY) {
    const [entries, labels] = await Promise.all([read(stateDir), readLabelsSafe()]);
    output.write(renderPlain(annotate(entries, labels)));
    return;
  }

  let state = {
    tab: 'history', entries: [], pending: [], selected: 0, pendingSelected: 0,
    detail: false, offset: 0, error: '', status: '',
  };
  // Let the plugin action find this pane again instead of opening a copy.
  if (persistent) { try { await savePane(stateDir, paneId); } catch { /* Reuse is optional. */ } }
  let loading = false;
  let refreshQueued = false;
  let acting = false;
  let finished = false;
  let timer;
  let finish;
  const wasRaw = Boolean(input.isRaw);
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 };
  const signalHandlers = new Map();
  let lastScreen;
  const draw = () => {
    const screen = renderScreen(state, output.columns || 80, output.rows || 24);
    if (screen !== lastScreen) {
      output.write('\x1b[H\x1b[2J' + screen);
      lastScreen = screen;
    }
  };
  const setStatus = (message) => {
    state = { ...state, status: message };
    draw();
  };
  const onError = (error) => finish(error);
  const onEnd = () => finish();
  const onResize = () => {
    try { draw(); } catch (error) { finish(error); }
  };

  async function refresh() {
    if (finished) return;
    // A refresh requested during a read runs after it, so an action is not missed.
    if (loading) { refreshQueued = true; return; }
    loading = true;
    try {
      const [history, labels, live] = await Promise.allSettled([read(stateDir), readLabelsSafe(), readPending()]);
      if (finished) return;
      const labelRows = labels.status === 'fulfilled' ? labels.value : [];
      const pendingRows = live.status === 'fulfilled' ? live.value : state.pending;
      let next = state;
      if (history.status === 'fulfilled') next = replaceHistory(next, annotate(history.value, labelRows, pendingRows));
      else next = { ...next, error: sanitize(history.reason?.message ?? history.reason) };
      if (live.status === 'fulfilled') next = replacePending(next, annotate(live.value, labelRows, live.value));
      state = next;
    } finally { loading = false; }
    if (finished) return;
    onResize();
    if (refreshQueued) { refreshQueued = false; await refresh(); }
  }

  async function approveSelected() {
    const entry = selectedEntry(state);
    if (!entry || acting) return;
    if (!approveEntry) return setStatus('Approve needs the Herdr socket.');
    if (typeof entry.request !== 'string') return setStatus('This request has no approvable prompt.');
    // Bind the approval to the request that the list showed, not to a newer one.
    if (entry.identity === undefined) return setStatus('This request is not waiting; press r to refresh.');
    acting = true;
    setStatus('Approving...');
    try {
      const result = await approveEntry(entry);
      if (finished) return;
      setStatus(approveMessage(result));
      if (result?.ok) await refresh();
    } catch { if (!finished) setStatus('Approve failed.'); }
    finally { acting = false; }
  }

  async function mark(labelValue) {
    const entry = selectedEntry(state);
    if (!entry || acting) return;
    if (typeof entry.request !== 'string') return setStatus('This request has no label target.');
    acting = true;
    try {
      await labelEntry(entry, labelValue);
      await refresh();
      if (finished) return;
      setStatus(labelValue === 'approve' ? 'Marked should approve; this request in this directory is approved automatically. u clears it.'
        : labelValue === 'manual' ? 'Marked should take no action; this request stays for a human everywhere. u clears it.'
          : 'Label cleared.');
    } catch (error) {
      if (finished) return;
      const reason = error?.message;
      setStatus(reason === 'feedback-sensitive-content' ? 'Cannot label a request with credentials.'
        : reason === 'feedback-cwd-required' ? 'Cannot approval-label a request without a working directory.'
          : 'Label not saved.');
    }
    finally { acting = false; }
  }

  async function focusSelected() {
    const entry = selectedEntry(state);
    if (!entry || acting) return;
    if (!focusEntry) return setStatus('Focus needs the Herdr socket.');
    acting = true;
    try {
      const result = await focusEntry(entry.pane);
      if (finished) return;
      if (result?.ok) {
        // The pane stays open in its tab so the user can come back to it.
        if (persistent) return setStatus(`Focused ${sanitize(entry.pane)}. Press q to close this pane.`);
        return finish();
      }
      setStatus(`Cannot focus: ${sanitize(result?.reason ?? 'unavailable')}`);
    } catch { if (!finished) setStatus('Cannot focus the pane.'); }
    finally { acting = false; }
  }

  const onKey = (text, key = {}) => {
    const name = key.name ?? text;
    if (name === 'q' || (key.ctrl && name === 'c')) return finish();
    if (name === 'r') return void refresh();
    if (name === 'tab') {
      state = { ...switchTab(state), status: '' };
      return onResize();
    }
    if (name === 'a') return void approveSelected();
    if (name === 'f') return void focusSelected();
    if (name === 'y') return void mark('approve');
    if (name === 'n') return void mark('manual');
    if (name === 'u') return void mark('clear');
    const width = Math.max(1, (output.columns || 80) - 1);
    const pageSize = Math.max(1, (output.rows || 24) - 3);
    const lines = state.detail ? detailLines(selectedEntry(state), width).length : 0;
    state = { ...navigate(state, name, pageSize, lines), status: '' };
    onResize();
  };
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    finished = true;
    clearInterval(timer);
    input.off('keypress', onKey);
    input.off('end', onEnd);
    input.off('error', onError);
    output.off('error', onError);
    output.off('resize', onResize);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    process.off('exit', cleanup);
    clearPane(stateDir, paneId);
    try { input.setRawMode(wasRaw); } catch { /* The terminal can close before cleanup. */ }
    input.pause();
    try { output.write('\x1b[?25h\x1b[?1049l'); } catch { /* The output can already be closed. */ }
  }

  try {
    await new Promise((resolve, reject) => {
      finish = (error) => {
        if (finished) return;
        finished = true;
        if (error) reject(error);
        else resolve();
      };
      process.on('exit', cleanup);
      for (const [signal, code] of Object.entries(signals)) {
        const handler = () => { process.exitCode = code; finish(); };
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }
      emitKeypressEvents(input);
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('error', onError);
      output.on('error', onError);
      output.on('resize', onResize);
      input.setRawMode(true);
      input.resume();
      output.write('\x1b[?1049h\x1b[?25l');
      timer = setInterval(refresh, 2_000);
      void refresh();
    });
  } finally { cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Permission history unavailable: ${sanitize(error.message ?? error)}`);
    process.exitCode = 1;
  });
}
