import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readHistory } from './history.mjs';
import { FEEDBACK_LABELS, labelFor, labelIndex, readFeedback, recordFeedback } from './feedback.mjs';
import { approveRequest, focusRequest, herdrCall, loadPending } from './actions.mjs';
import { clearPane, savePane } from './panes.mjs';
import { DEFAULT_SETTINGS, HARNESSES, deleteKey, hasKey, normalize, readSettings, storeKey, validKey, validModel, validThreshold, writeSettings } from './settings.mjs';

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
// The box, arrow, and dot characters that this interface draws use one column.
const NARROW = /[\u00b7\u2022\u2026\u2190-\u21ff\u2264\u2265\u2500-\u25ff]/u;
const cellWidth = (character) => character.codePointAt(0) > 0x7e && !NARROW.test(character) ? 2 : 1;

export function textWidth(value) {
  return [...stripVTControlCharacters(String(value ?? ''))].reduce((sum, character) => sum + cellWidth(character), 0);
}

// Clip, then pad with spaces to exactly `width` columns.
export function pad(value, width) {
  const text = clip(value, width);
  return text + ' '.repeat(Math.max(0, width - textWidth(text)));
}

// Use the first variant that fits, or clip the last one.
const fit = (variants, width) => variants.find((text) => textWidth(text) <= width) ?? variants.at(-1);

// Show the age of recent requests. Older requests show only the absolute time.
export function relativeTime(iso, now = Date.now()) {
  const seconds = Math.floor((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return '';
}

export function clip(value, width) {
  let result = '';
  let used = 0;
  // 'escape' follows ESC; 'csi' is inside ESC [ ... until its final byte.
  let inEscape = false;
  for (const character of String(value ?? '')) {
    if (inEscape) {
      result += character;
      if (inEscape === 'escape' && character === '[') inEscape = 'csi';
      else if (inEscape === 'csi' ? character >= '@' && character <= '~'
        : (character >= '@' && character <= '~') || (character >= ' ' && character <= '/')) inEscape = false;
      continue;
    }
    if (character === '\x1b') {
      inEscape = 'escape';
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

export function detailLines(entry, width, color = false, now = Date.now()) {
  if (!entry) return [];
  const age = entry.processedAt ? relativeTime(entry.processedAt, now) : '';
  const fields = [
    ['Time', entry.processedAt && age ? `${entry.processedAt} (${age})` : entry.processedAt], ['Result', entry.outcome], ['Reviewer', entry.reviewer],
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

// Tab goes to the next view in the order 1, 2, 3. Shift+Tab goes back.
const TABS = ['pending', 'history', 'settings'];
export function switchTab(state, direction = 1) {
  // A state with no known tab shows the history.
  const index = TABS.includes(state.tab) ? TABS.indexOf(state.tab) : 1;
  return {
    ...state, tab: TABS[(index + direction + TABS.length) % TABS.length],
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
  // Open details stay only for the same request, so an action cannot reach a new one.
  const same = match >= 0 && pending[match].request === previous.request && pending[match].identity === previous.identity;
  const detail = state.tab === 'pending' && state.detail ? same : state.detail;
  return { ...state, pending, pendingSelected: match >= 0 ? match : 0, detail };
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

// Move a cursor or a scroll offset. Line keys step 1, page keys step `page`.
export function step(value, key, page, maximum, lines = ['up', 'k', 'down', 'j'], pages = ['pageup', 'pagedown', 'home', 'end']) {
  if (key === lines[0] || key === lines[1]) value--;
  if (key === lines[2] || key === lines[3]) value++;
  if (key === pages[0]) value -= page;
  if (key === pages[1]) value += page;
  if (key === pages[2]) value = 0;
  if (key === pages[3]) value = maximum;
  return Math.max(0, Math.min(value, maximum));
}

// The chosen action is stored by its key, so a changed list cannot move the
// cursor onto another action. With no choice yet, select the first action that
// does not approve. A key that left the list selects Back, which is last.
export function actionIndex(actions, key) {
  const index = actions.findIndex(([name]) => (key === undefined ? name !== 'a' : name === key));
  return index >= 0 ? index : actions.length - 1;
}

const moveAction = (actions, key, name) => actions[step(actionIndex(actions, key), name, 0, actions.length - 1, undefined, [])][0];

// In a detail view, line keys choose an action and page keys scroll the text.
// `pageSize` is the number of text rows above the actions.
export function navigate(state, key, pageSize, lineCount = 0, actions = [['escape', 'Back']]) {
  const items = listEntries(state);
  const field = selectionField(state);
  if (key === 'return' && items.length) return { ...state, detail: true, offset: 0, action: undefined };
  if (key === 'escape') return { ...state, detail: false, offset: 0 };
  if (!state.detail) return { ...state, [field]: step(state[field], key, pageSize, Math.max(0, items.length - 1)) };
  return {
    ...state,
    action: moveAction(actions, state.action, key),
    offset: step(state.offset, key, pageSize, Math.max(0, lineCount - pageSize), []),
  };
}

const KEY_NAMES = { escape: 'Esc', space: 'Space', return: 'Enter' };

// The actions for one history or pending entry, as [key, label] pairs.
export function entryActions(entry) {
  if (!entry) return [['escape', 'Back']];
  return [
    ...(entry.live ? [['a', 'Approve once']] : []),
    ...(entry.pane ? [['f', 'Focus pane']] : []),
    ['y', 'Label: should approve'],
    ['n', 'Label: should take no action'],
    ...(entry.label ? [['u', 'Clear label']] : []),
    ['escape', 'Back'],
  ];
}

// A short pane shows only the chosen action on one line, so the text keeps room.
const compact = (pageSize, actions) => pageSize < actions.length * 2 + 4;

// Rows of detail text that fit above the action list.
export const textRows = (pageSize, actions) => Math.max(0, compact(pageSize, actions) ? pageSize - 1 : pageSize - actions.length - 2);

// Detail text that scrolls, then a list of actions to choose with Enter.
export function withActions(content, actions, selected, offset, pageSize) {
  const rows = textRows(pageSize, actions);
  const start = Math.min(offset ?? 0, Math.max(0, content.length - rows));
  const at = actionIndex(actions, selected);
  const text = content.slice(start, start + rows);
  const name = ([key, label]) => `${label} ${dim(KEY_NAMES[key] ?? key)}`;
  if (compact(pageSize, actions)) {
    while (text.length < rows) text.push('');
    return [...text, `${cyan(`Action ${at + 1}/${actions.length}:`)} ${bold('>')} ${name(actions[at])}`];
  }
  return [
    ...text, '', cyan('Actions'),
    ...actions.map((action, index) => (index === at ? `${bold('>')} ${bold(action[1])} ${dim(KEY_NAMES[action[0]] ?? action[0])}` : `  ${name(action)}`)),
  ];
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

// A wide row adds the age of a recent request. A narrow row shows the age, or
// the date for an older request, and drops the reviewer.
const WIDE = 72;

function summary(entry, color = false, width, now) {
  const time = sanitize(entry.processedAt).replace('T', ' ').slice(5, 19);
  const outcome = sanitize(entry.outcome);
  const reviewer = sanitize(entry.reviewer);
  const req = requestSummary(entry.request);
  if (width === undefined) {
    if (!color) return `${time}  ${outcome}  ${reviewer}  ${req}`;
    return `${gray(time)}  ${outcomeColor(outcome)}  ${yellow(reviewer)}  ${req}`;
  }
  const age = relativeTime(entry.processedAt, now);
  if (width >= WIDE) return `${gray(time)} ${cyan(age.padStart(7))}  ${outcomeColor(outcome)}  ${yellow(reviewer)}  ${req}`;
  return `${age ? cyan(age.padStart(7)) : gray(time.slice(0, 5).padStart(7))}  ${outcomeColor(outcome)}  ${req}`;
}

function mark(entry, color = false) {
  const live = entry.live ? (color ? yellow('*') : '*') : ' ';
  const label = LABEL_MARKS[entry.label] ?? '.';
  const coloredLabel = color
    ? (label === '+' ? green(label) : label === '-' ? red(label) : gray(label))
    : label;
  return `${live}${coloredLabel}`;
}

function pendingSummary(entry, color = false, width = Infinity) {
  const request = requestSummary(entry.request) || `(${sanitize(entry.reason ?? 'unknown prompt')})`;
  if (!color) return `${sanitize(entry.pane)}  ${sanitize(entry.agent)}  ${request}`;
  if (width < WIDE / 2) return `${cyan(sanitize(entry.pane))}  ${request}`;
  return `${cyan(sanitize(entry.pane))}  ${yellow(sanitize(entry.agent))}  ${request}`;
}

function rowText(entry, tab, color = false, width, now) {
  return `${mark(entry, color)} ${tab === 'pending' ? pendingSummary(entry, color, width) : summary(entry, color, width, now)}`;
}

const LIST_HELP = [
  'j/k Enter | a approve f focus | y approve n no action u clear | Tab views s settings | r refresh q quit',
  'j/k Enter | a f | y n u label | Tab s settings | r q quit',
  'Enter a f y n u Tab s q quit',
];
const DETAIL_HELP = [
  'j/k choose Enter run | PgUp/PgDn scroll | Esc back | Tab views s settings | r refresh q quit',
  'j/k Enter | PgUp/PgDn scroll | Esc back | q quit',
  'j/k Enter Esc q quit',
];

export function renderPlain(entries) {
  return 'Permission history | Latest 1000 records | Time: UTC\n'
    + (entries.length ? entries.map((entry) => `${mark(entry)} ${summary(entry)}`).join('\n') : 'No permission history yet.') + '\n';
}

// The review pipeline in request order. Each node is one switch in settings.json.
export const NODES = [
  {
    id: 'secrets', stage: 0, label: 'Secrets',
    about: 'Stops a request that contains a recognizable credential, such as an API key, token, password, or private key. The request stays for a human and is not sent to Jev or the agent review.',
    off: 'When off, credentials in a request can go to TypeSafe and to the agent review. History still hides them.',
  },
  {
    id: 'humanOnly', stage: 0, label: 'Human-only',
    about: 'Stops actions that always need a human: git push, package publish, disk erasure, dd to a device, DROP DATABASE or TRUNCATE, and text that asks a reviewer to ignore its rules.',
    off: 'When off, Jev or the agent review can approve these actions.',
  },
  {
    id: 'labels', stage: 1, label: 'Labels',
    about: 'Repeats your y and n labels for the exact same request. "should approve" approves it in the same directory; "should take no action" keeps it for a human everywhere. Later stages are skipped.',
    off: 'When off, labels stay stored but have no effect.',
  },
  {
    id: 'jev', stage: 2, label: 'Jev',
    about: 'Sends the request to TypeSafe AI (model jev-latest). A score at or above the threshold approves the request once. A lower score goes to the agent review. A TypeSafe error leaves the request for a human. Jev runs only with an API key in the macOS Keychain.',
    off: 'When off, the agent review decides alone.',
  },
  {
    id: 'agent', stage: 3, label: 'Agent',
    about: 'Runs one print-mode review with the chosen harness and model, without tools, sessions, or project context. A plain decline gets one more review. A yes approves the request once.',
    off: 'When off, only Jev can approve. A low Jev score leaves the request for a human.',
  },
];
const threshold = (settings) => (settings.jevThreshold ?? DEFAULT_SETTINGS.jevThreshold).toFixed(2);
const STAGES = [
  { name: 'Filters', exits: () => ['match: human'] },
  { name: 'Labels', exits: () => ['label: decides'] },
  { name: 'Jev', exits: (settings) => [`≥${threshold(settings)}: approve`, `<${threshold(settings)}: agent`] },
  { name: 'Agent review', exits: () => ['yes: approve', 'no: human'] },
];
const THRESHOLDS = Array.from({ length: 11 }, (_, index) => (0.5 + index * 0.05).toFixed(2));

// Jev is on only when it is enabled and a key is present.
export function nodeStatus(node, view) {
  const settings = view.settings ?? DEFAULT_SETTINGS;
  const enabled = settings[node.id];
  if (node.id === 'jev' && enabled && view.keyPresent === false) return { box: yellow('[-]'), note: yellow('needs API key') };
  if (node.id === 'agent' && enabled) return { box: green('[x]'), note: `${HARNESSES[settings.harness].name} · ${sanitize(settings.model)}` };
  return enabled ? { box: green('[x]'), note: '' } : { box: gray('[ ]'), note: gray('off') };
}

function nodeRow(node, view, index) {
  const { box } = nodeStatus(node, view);
  const cursor = index === (view.settingsSelected ?? 0) ? bold('>') : ' ';
  return `${cursor}${box} ${index === (view.settingsSelected ?? 0) ? bold(node.label) : node.label}`;
}

// Extra lines under the switches of a stage.
function stageNotes(stage, view) {
  const notes = [];
  for (const node of NODES.filter((item) => item.stage === stage)) {
    const { note } = nodeStatus(node, view);
    if (note && node.id === 'agent') {
      const settings = view.settings ?? DEFAULT_SETTINGS;
      notes.push(`  ${HARNESSES[settings.harness].name}`, `  ${dim(sanitize(settings.model))}`);
    } else if (note && note !== gray('off')) notes.push(`  ${note}`);
  }
  return notes;
}

function pipelineLines(view, width) {
  const gap = 2;
  const boxWidth = Math.floor((width - gap * (STAGES.length - 1)) / STAGES.length);
  if (boxWidth >= 17) {
    const inner = boxWidth - 2;
    const content = STAGES.map((stage, index) => [
      ...NODES.map((node, i) => [node, i]).filter(([node]) => node.stage === index).map(([node, i]) => nodeRow(node, view, i)),
      ...stageNotes(index, view),
    ]);
    const rows = Math.max(...content.map((lines) => lines.length));
    const join = (parts, connector) => parts.join(connector);
    const lines = [dim('Request ▶ each stage can stop it for a human; an approval sends one key')];
    lines.push(join(STAGES.map((stage) => `┌ ${bold(stage.name)} ${'─'.repeat(Math.max(0, inner - textWidth(stage.name) - 2))}┐`), '  '));
    for (let row = 0; row < rows; row++) {
      lines.push(join(content.map((lines) => `│${pad(lines[row] ?? '', inner)}│`), row === 0 ? cyan('─▶') : '  '));
    }
    lines.push(join(STAGES.map(() => `└${'─'.repeat(inner)}┘`), '  '));
    const exits = STAGES.map((stage) => stage.exits(view.settings ?? DEFAULT_SETTINGS));
    for (let row = 0; row < 2; row++) lines.push(join(exits.map((list) => pad(dim(` ${list[row] ?? ''}`), boxWidth)), '  '));
    return lines;
  }
  // Narrow panes stack the stages vertically.
  const lines = [dim('Request')];
  STAGES.forEach((stage, index) => {
    const title = `${cyan('├─')} ${bold(stage.name)}`;
    const exits = dim(stage.exits(view.settings ?? DEFAULT_SETTINGS).join(', '));
    if (textWidth(`${title} ${exits}`) <= width) lines.push(`${title} ${exits}`);
    else lines.push(title, `${cyan('│')}  ${exits}`);
    NODES.forEach((node, i) => { if (node.stage === index) lines.push(`${cyan('│')} ${nodeRow(node, view, i)}`); });
    for (const note of stageNotes(index, view)) lines.push(`${cyan('│')}   ${note}`);
  });
  lines.push(`${cyan('▼')} ${dim('Approve once')}`);
  return lines;
}

// Wrap prose at spaces. A word longer than the width is split.
function wrapAll(texts, width) {
  return texts.flatMap((text) => {
    const lines = [''];
    for (const word of text.split(' ')) {
      const last = lines.at(-1);
      if (!last) lines[lines.length - 1] = word;
      else if (textWidth(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    return lines.flatMap((line) => wrap(line, width));
  });
}

export function nodeDetailLines(node, view, width) {
  const settings = view.settings ?? DEFAULT_SETTINGS;
  const enabled = settings[node.id];
  const stage = STAGES[node.stage].name;
  const title = stage === node.label ? bold(stage) : `${bold(stage)} › ${bold(node.label)}`;
  const lines = [`${title}  ${enabled ? green('on') : gray('off')}`, ''];
  if (node.id === 'jev') {
    lines.push(`${gray('API key:')} ${view.keyPresent === undefined ? 'checking' : view.keyPresent ? green('stored in Keychain') : yellow('missing')}`,
      `${gray('Threshold:')} ${threshold(settings)}`, `${gray('Endpoint:')} api.typesafe.ai`, '');
  }
  if (node.id === 'agent') {
    lines.push(`${gray('Harness:')} ${HARNESSES[settings.harness].name} (${settings.harness})`,
      `${gray('Model:')} ${sanitize(settings.model)}`, '');
  }
  return [...lines, ...wrapAll([node.about, '', node.off], width)];
}

// The actions for one pipeline stage, as [key, label] pairs.
export function nodeActions(node, view) {
  const settings = view.settings ?? DEFAULT_SETTINGS;
  const on = node.id === 'jev' ? settings.jev && Boolean(view.keyPresent) : settings[node.id];
  return [
    ['space', on ? 'Turn off' : 'Turn on'],
    ...(node.id === 'jev' ? [
      ['e', view.keyPresent ? 'Replace API key' : 'Set API key'],
      ...(view.keyPresent ? [['x', 'Remove API key']] : []),
      ['t', 'Change threshold'],
    ] : []),
    ...(node.id === 'agent' ? [['h', 'Change harness'], ['m', 'Change model']] : []),
    ['escape', 'Back'],
  ];
}

export function pickerOptions(picker) {
  const filter = picker.filter.toLowerCase();
  const matches = picker.options.filter((option) => option.toLowerCase().includes(filter));
  // Typed text is a valid choice when it is not in the list.
  const custom = picker.custom && picker.filter && (picker.valid ?? validModel)(picker.filter) && !picker.options.includes(picker.filter);
  return custom ? [...matches, picker.filter] : matches;
}

export function settingsLines(view, width) {
  if (view.input) {
    return {
      head: bold('TypeSafe API key'),
      lines: wrapAll(['Paste the key. It is stored in the macOS Keychain service model-router-typesafe and turns Jev on.', ''], width)
        .concat(`Key: ${'•'.repeat(Math.min(view.input.value.length, Math.max(0, width - 6)))}${view.input.value.length ? '' : dim('(empty)')}`),
      help: ['Enter save | Esc cancel | Backspace delete', 'Enter Esc'],
    };
  }
  if (view.picker) {
    const options = pickerOptions(view.picker);
    const selected = Math.min(view.picker.selected, Math.max(0, options.length - 1));
    const size = Math.max(1, (view.pageSize ?? 10) - 2);
    const start = Math.floor(selected / size) * size;
    const lines = [`Filter: ${sanitize(view.picker.filter)}${dim('_')}`, view.picker.loading ? dim('Loading models...') : dim(`${options.length} choices`)];
    lines.push(...options.slice(start, start + size).map((option, index) => {
      const text = view.picker.custom && option === view.picker.filter && !view.picker.options.includes(option) ? `Use "${sanitize(option)}"` : sanitize(option);
      return `${start + index === selected ? '>' : ' '} ${start + index === selected ? bold(text) : text}`;
    }));
    return {
      head: bold(view.picker.title),
      lines,
      help: ['Type to filter | Up/Down move | Enter choose | Esc cancel', 'Enter Esc'],
    };
  }
  const node = NODES[view.settingsSelected ?? 0];
  if (view.settingsDetail) {
    return {
      head: bold('Details'),
      lines: withActions(nodeDetailLines(node, view, width), nodeActions(node, view), view.settingsAction, view.settingsOffset ?? 0, view.pageSize ?? 20),
      help: ['j/k choose Enter run | PgUp/PgDn scroll | Esc back | s close settings | q quit', 'j/k Enter | Esc back | s close | q quit', 'j/k Enter Esc s q'],
    };
  }
  const lines = pipelineLines(view, width);
  // Keep the selected switch visible in a short pane.
  const at = lines.findIndex((line) => line.includes(bold('>')));
  const room = Math.max(1, (view.pageSize ?? lines.length));
  const start = at < room ? 0 : at - room + 1;
  return {
    head: fit([dim('Each request passes the enabled stages from left to right.'), dim('Requests pass enabled stages in order.')], width),
    lines: lines.slice(start),
    help: ['j/k ←/→ move | Space toggle | Enter details | s/Esc close | q quit', 'j/k Space Enter Esc q'],
  };
}

export function renderScreen(state, columns, rows) {
  const width = Math.max(1, columns - 1);
  const height = Math.max(1, rows);
  const pageSize = Math.max(1, height - 3);
  const now = state.now ?? Date.now();
  const tab = ['pending', 'settings'].includes(state.tab) ? state.tab : 'history';
  const view = {
    entries: [], selected: 0, pendingSelected: 0, ...state, tab,
    pending: state.pending ?? [],
  };
  const tabName = (id, long, short) => (view.tab === id ? bold : dim)(width >= 60 ? long : short);
  const tabs = `${tabName('pending', `1 Pending ${view.pending.length}`, `1 Pend ${view.pending.length}`)} | ${tabName('history', `2 History ${view.entries.length}`, `2 Hist ${view.entries.length}`)} | ${tabName('settings', '3 Settings', '3 Set')}`;
  const titles = {
    pending: [`${bold('Pending requests')} | ${bold('Live')} | Time: UTC | ${tabs}`, `${bold('Pending')} | ${tabs}`],
    history: [`${bold('Permission history')} | Latest 1000 records | Time: UTC | ${tabs}`, `${bold('History')} | ${tabs}`],
    settings: [`${bold('Review pipeline')} | Changes apply to the next request | ${tabs}`, `${bold('Pipeline')} | ${tabs}`],
  };
  const lines = [fit([...titles[tab], tabs], width)];
  if (tab === 'settings') {
    const body = settingsLines({ ...view, pageSize }, width);
    lines.push(view.status ? sanitize(view.status) : body.head);
    lines.push(...body.lines.slice(0, pageSize));
    while (lines.length < height - 1) lines.push('');
    lines.push(fit(body.help, width));
    return lines.slice(0, height).map((line) => clip(line, width)).join('\r\n');
  }
  const items = listEntries(view);
  const liveness = bold('live label');
  const selected = view[selectionField(view)];
  const position = items.length ? `${selected + 1}/${items.length}` : '0/0';
  const columnsHead = tab === 'pending'
    ? (width < WIDE / 2 ? `${cyan('Pane')}  Request` : `${cyan('Pane')}  ${yellow('Agent')}  Request`)
    : (width >= WIDE ? `${gray('Time')}  ${cyan('Age')}  ${bold('Result')}  ${yellow('Reviewer')}  Request` : `${cyan('Age')}  ${bold('Result')}  Request`);
  const head = view.detail ? `${position} | ${bold('Details')}` : fit([`${position} | ${liveness} | ${columnsHead}`, `${position} | ${columnsHead}`], width);
  lines.push(view.error ? `Read error: ${sanitize(view.error)} | r retry`
    : view.status ? `${sanitize(view.status)} | ${head}` : head);
  if (view.detail) {
    const entry = items[selected];
    lines.push(...withActions(detailLines(entry, width, true, now), entryActions(entry), view.action, view.offset, pageSize));
  } else if (!items.length) {
    lines.push(tab === 'pending' ? dim('No agent is waiting for permission.') : dim('No permission history yet.'));
  } else {
    const start = Math.floor(selected / pageSize) * pageSize;
    lines.push(...items.slice(start, start + pageSize)
      .map((entry, index) => `${start + index === selected ? '>' : ' '} ${rowText(entry, tab, true, width, now)}`));
  }
  while (lines.length < height - 1) lines.push('');
  lines.push(fit(view.detail ? DETAIL_HELP : LIST_HELP, width));
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
  loadSettings = readSettings, saveSettings = writeSettings,
  keyStatus = hasKey, setKey = storeKey, removeKey = deleteKey,
  listModels = (harness) => HARNESSES[harness].models(),
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
    settings: DEFAULT_SETTINGS, settingsSelected: 0, settingsDetail: false,
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
      // Overwrite each line in place and erase only what is left over. A full
      // clear before each frame makes the whole view flash.
      output.write('\x1b[H' + screen.split('\r\n').map((line) => line + RESET + '\x1b[K').join('\r\n') + '\x1b[J');
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

  async function openSettings() {
    const returnTab = state.tab === 'settings' ? state.returnTab : state.tab;
    state = { ...state, tab: 'settings', returnTab, detail: false, offset: 0, status: '', settingsLoaded: false };
    onResize();
    let settings = state.settings;
    let status = '';
    try { settings = await loadSettings(stateDir); }
    catch { status = 'settings.json is damaged; requests stay manual until a change saves it again.'; }
    if (finished) return;
    state = { ...state, settings, status, settingsLoaded: true, keyPresent: Boolean(keyStatus()) };
    onResize();
  }

  // Apply each change to the state at once and write in order, so a quick
  // second change cannot write an older snapshot over the first one.
  let saving = Promise.resolve();
  function saveWith(changes, message = 'Saved. The next request uses this setting.') {
    const settings = normalize({ ...state.settings, ...changes });
    state = { ...state, settings };
    onResize();
    saving = saving.then(() => saveSettings(stateDir, settings)).then(() => {
      if (!finished) setStatus(message);
    }, async () => {
      if (finished) return;
      // Show what the hook will use.
      try { state = { ...state, settings: await loadSettings(stateDir) }; } catch { /* Keep the shown state. */ }
      setStatus('Settings not saved.');
    });
    return saving;
  }

  function openPicker(picker) {
    state = { ...state, picker: { filter: '', selected: 0, ...picker }, status: '' };
    onResize();
  }

  function openModelPicker() {
    const { harness, model } = state.settings;
    // Typing replaces the picker object, so match the load by its session.
    const session = Symbol('picker');
    openPicker({ title: `Model for ${HARNESSES[harness].name}`, options: [model], custom: true, loading: true, field: 'model', session });
    const current = { session };
    Promise.resolve().then(() => listModels(harness)).then((list) => {
      if (finished || state.picker?.session !== current.session) return;
      const options = [...new Set([model, ...list.filter(validModel)])];
      state = { ...state, picker: { ...state.picker, options, loading: false } };
      onResize();
    }, () => {
      if (finished || state.picker?.session !== current.session) return;
      state = { ...state, picker: { ...state.picker, loading: false }, status: 'Model list unavailable; type a model name.' };
      onResize();
    });
  }

  async function choose(option) {
    const field = state.picker.field;
    state = { ...state, picker: null };
    if (field === 'harness') {
      await saveWith({ harness: option, model: HARNESSES[option].defaultModel });
      if (!finished) openModelPicker();
    } else if (field === 'jevThreshold') {
      await saveWith({ jevThreshold: Number(option) }, `Saved. Jev approves a score of ${Number(option).toFixed(2)} or higher.`);
    } else await saveWith({ model: option });
  }

  function openThresholdPicker() {
    const current = state.settings.jevThreshold.toFixed(2);
    const options = THRESHOLDS.includes(current) ? THRESHOLDS : [current, ...THRESHOLDS];
    openPicker({
      title: 'Jev threshold (0.50 to 1.00)', options, custom: true, valid: validThreshold,
      field: 'jevThreshold', selected: options.indexOf(current),
    });
  }

  // Rows of the screen body, as renderScreen computes them.
  const screenSize = () => ({ width: Math.max(1, (output.columns || 80) - 1), pageSize: Math.max(1, (output.rows || 24) - 3) });

  function onPickerKey(text, name) {
    const picker = state.picker;
    const options = pickerOptions(picker);
    if (name === 'escape') { state = { ...state, picker: null }; return onResize(); }
    if (name === 'return') return options.length ? void choose(options[Math.min(picker.selected, options.length - 1)]) : undefined;
    let next = picker;
    if (name === 'up') next = { ...picker, selected: Math.max(0, picker.selected - 1) };
    else if (name === 'down') next = { ...picker, selected: Math.min(options.length - 1, picker.selected + 1) };
    else if (name === 'backspace') next = { ...picker, filter: picker.filter.slice(0, -1), selected: 0 };
    else if (/^[\x21-\x7e]+$/.test(text ?? '') && picker.filter.length < 128) next = { ...picker, filter: picker.filter + text, selected: 0 };
    state = { ...state, picker: next };
    onResize();
  }

  async function onInputKey(text, name) {
    const input = state.input;
    if (name === 'escape') { state = { ...state, input: null }; return onResize(); }
    if (name === 'return') {
      state = { ...state, input: null };
      if (!validKey(input.value)) return setStatus('That key has unsupported characters; nothing saved.');
      try { setKey(input.value); }
      catch { return setStatus('Key not saved to the Keychain.'); }
      const keyPresent = Boolean(keyStatus());
      state = { ...state, keyPresent };
      if (!keyPresent) return setStatus('Key not saved to the Keychain.');
      return saveWith({ jev: true }, 'API key saved. Jev is on.');
    }
    let value = input.value;
    if (name === 'backspace') value = value.slice(0, -1);
    else if (/^[\x21-\x7e]+$/.test(text ?? '') && value.length < 512) value += text;
    state = { ...state, input: { value } };
    onResize();
  }

  function onSettingsKey(name) {
    const index = state.settingsSelected ?? 0;
    const node = NODES[index];
    // A change before the file loads would write the defaults over it.
    if (!state.settingsLoaded && !['up', 'down', 'j', 'k', 'left', 'right', 'home', 'end'].includes(name)) return setStatus('Loading settings...');
    const move = (to) => { state = { ...state, settingsSelected: Math.max(0, Math.min(NODES.length - 1, to)), status: '' }; onResize(); };
    if (name === 'space') {
      // Jev is on only with a key. Without one, Space asks for the key.
      const enable = node.id === 'jev' ? !(state.settings.jev && state.keyPresent) : !state.settings[node.id];
      if (node.id === 'jev' && enable && !state.keyPresent) { state = { ...state, input: { value: '' }, status: '' }; return onResize(); }
      return void saveWith({ [node.id]: enable });
    }
    if (state.settingsDetail) {
      const actions = nodeActions(node, state);
      if (name === 'return') return onSettingsKey(actions[actionIndex(actions, state.settingsAction)][0]);
      if (name === 'escape') { state = { ...state, settingsDetail: false, status: '' }; return onResize(); }
      if (['up', 'down', 'j', 'k', 'pageup', 'pagedown', 'home', 'end'].includes(name)) {
        const { width, pageSize } = screenSize();
        const rows = textRows(pageSize, actions);
        const lines = nodeDetailLines(node, state, width).length;
        state = {
          ...state, status: '',
          settingsAction: moveAction(actions, state.settingsAction, name),
          settingsOffset: step(Math.min(state.settingsOffset ?? 0, Math.max(0, lines - rows)), name, rows, Math.max(0, lines - rows), []),
        };
        return onResize();
      }
      if (node.id === 'jev' && name === 'e') { state = { ...state, input: { value: '' }, status: '' }; return onResize(); }
      if (node.id === 'jev' && name === 't') return openThresholdPicker();
      if (node.id === 'jev' && name === 'x') {
        try { removeKey(); } catch { /* Checked below. */ }
        state = { ...state, keyPresent: Boolean(keyStatus()) };
        return setStatus(state.keyPresent ? 'Key not removed.' : 'API key removed. Jev is inactive.');
      }
      if (node.id === 'agent' && name === 'h') return openPicker({ title: 'Agent harness', options: Object.keys(HARNESSES), field: 'harness' });
      if (node.id === 'agent' && name === 'm') return openModelPicker();
      return;
    }
    if (name === 'return') { state = { ...state, settingsDetail: true, settingsAction: undefined, settingsOffset: 0, status: '' }; return onResize(); }
    if (name === 'up' || name === 'k') return move(index - 1);
    if (name === 'down' || name === 'j') return move(index + 1);
    if (name === 'home') return move(0);
    if (name === 'end') return move(NODES.length - 1);
    if (name === 'left') return move(NODES.findIndex((item) => item.stage === Math.max(0, node.stage - 1)));
    if (name === 'right') return move(NODES.findIndex((item) => item.stage === Math.min(STAGES.length - 1, node.stage + 1)));
  }

  const onKey = (text, key = {}) => {
    const name = key.name ?? text;
    if (key.ctrl && name === 'c') return finish();
    if (state.input) return void onInputKey(text, name);
    if (state.picker) return onPickerKey(text, name);
    if (name === 'q') return finish();
    if (name === '1' || name === '2') {
      state = { ...state, tab: name === '1' ? 'pending' : 'history', detail: false, offset: 0, status: '' };
      return onResize();
    }
    // s or Esc closes settings and returns to the list that opened it.
    if (state.tab === 'settings' && (name === 's' || (name === 'escape' && !state.settingsDetail))) {
      state = { ...state, tab: state.returnTab ?? 'history', settingsDetail: false, status: '' };
      return onResize();
    }
    if (name === '3' || name === 's') return void openSettings();
    if (name === 'tab') {
      const next = switchTab(state, key.shift ? -1 : 1);
      if (next.tab === 'settings') return void openSettings();
      state = { ...next, settingsDetail: false, status: '' };
      return onResize();
    }
    if (state.tab === 'settings') {
      return onSettingsKey(name);
    }
    if (name === 'r') return void refresh();
    if (name === 'a') return void approveSelected();
    if (name === 'f') return void focusSelected();
    if (name === 'y') return void mark('approve');
    if (name === 'n') return void mark('manual');
    if (name === 'u') return void mark('clear');
    const { width, pageSize } = screenSize();
    if (state.detail) {
      const actions = entryActions(selectedEntry(state));
      const chosen = actions[actionIndex(actions, state.action)][0];
      if (name === 'return' && chosen !== 'escape') return onKey(chosen, { name: chosen });
      const lines = detailLines(selectedEntry(state), width).length;
      state = { ...navigate(state, name === 'return' ? 'escape' : name, textRows(pageSize, actions), lines, actions), status: '' };
      return onResize();
    }
    state = { ...navigate(state, name, pageSize), status: '' };
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
