import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readPane } from '../panes.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  sanitize, clip, detailLines, entryActions, textRows, actionIndex, replaceHistory, replacePending, annotate, selectedEntry, switchTab,
  navigate, requestSummary, renderPlain, renderScreen, approveMessage, main,
} from '../history-ui.mjs';

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); }

const entry = (id, extra = {}) => ({
  id, processedAt: '2026-10-16T18:00:00.000Z', pane: 'w1:p1', agent: 'codex', cwd: '/tmp',
  request: `request ${id}`, outcome: 'approved', reviewer: 'jev', reason: 'approved-once', ...extra,
});
const state = (entries, extra = {}) => ({ entries, selected: 0, detail: false, offset: 0, error: '', ...extra });

test('sanitization removes terminal escapes, all control and format characters, and line separators', () => {
  const attack = '\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\'
    + '\x9b2J\x00\x07\x08\x0d\x0a\x7f\x85\u200b\u200d\u202e\u2066\u2028\u2029';
  const clean = sanitize(attack);
  assert.match(clean, /^redlink/);
  assert.doesNotMatch(clean, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.doesNotMatch(clean, /example\.com|31m|2J/);
});

test('every stored field is sanitized in details, list, and plain output', () => {
  const attack = '\x1b[2Junsafe\u202e\u200b\x85\u2028';
  const row = Object.fromEntries(Object.keys(entry('id', { detail: '', probability: 0 })).map((key) => [key, attack]));
  for (const output of [renderPlain([row]), renderScreen(state([row]), 80, 24), detailLines(row, 79).join('\n')]) {
    const plain = stripAnsi(output);
    assert.doesNotMatch(plain, /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/u);
    assert.doesNotMatch(plain, /\[2J/);
  }
  assert.doesNotMatch(renderPlain([row]), /[\x1b\p{Cf}]/u);
});

test('rendering keeps the newest-first order supplied by readHistory', () => {
  const entries = [entry('new', { processedAt: '2026-10-16T18:00:00Z' }), entry('old', { processedAt: '2026-10-15T18:00:00Z' })];
  for (const output of [renderPlain(entries), renderScreen(state(entries), 120, 8)]) {
    assert.ok(output.indexOf('request new') < output.indexOf('request old'));
    assert.match(output, /Latest 1000 records/);
  }
});

test('real Codex and Claude requests summarize the command or edit path', () => {
  const codex = 'Would you like to run the following command?\n\nReason: Run the local test suite\n  $ npm test';
  const claude = 'Bash command\n  npm test\n  Run the local test suite\nDo you want to proceed?';
  assert.equal(requestSummary(codex), '$ npm test');
  assert.match(requestSummary(claude), /^npm test /);
  assert.match(requestSummary('Edit file\n\nsrc/app.js\n- old\n+ new'), /^src\/app\.js /);
  assert.match(requestSummary('Would you like to make the following edits?\n\nsrc/app.js\n+ new'), /^src\/app\.js /);
  assert.equal(requestSummary('[Hidden: request contains credentials]'), '[Hidden: request contains credentials]');
  assert.match(renderPlain([entry('a', { request: codex })]), /jev  \$ npm test/);
});

test('refresh preserves selection by ID and clamps it when records disappear', () => {
  const before = state([entry('a'), entry('b')], { selected: 1, detail: true, offset: 5, error: 'old error' });
  const updated = replaceHistory(before, [entry('new'), entry('a'), entry('b')]);
  assert.equal(updated.selected, 2);
  assert.equal(updated.offset, 5);
  assert.equal(updated.error, '');
  const removed = replaceHistory(updated, [entry('a')]);
  assert.equal(removed.selected, 0);
  assert.equal(removed.offset, 0);
  assert.equal(removed.detail, false);
  assert.equal(replaceHistory(removed, []).detail, false);
});

test('list and detail navigation support arrows, j/k, pages, home/end, Enter, and Escape', () => {
  const initial = state(Array.from({ length: 12 }, (_, i) => entry(String(i))));
  let current = navigate(initial, 'pagedown', 4);
  assert.equal(current.selected, 4);
  current = navigate(current, 'j', 4);
  assert.equal(current.selected, 5);
  current = navigate(current, 'up', 4);
  assert.equal(current.selected, 4);
  assert.equal(navigate(current, 'k', 4).selected, 3);
  assert.equal(navigate(current, 'down', 4).selected, 5);
  assert.equal(navigate(current, 'pageup', 4).selected, 0);
  assert.equal(navigate(initial, 'end', 4).selected, 11);
  assert.equal(navigate(current, 'home', 4).selected, 0);
  current = navigate(current, 'return', 4);
  assert.equal(current.detail, true);
  current = navigate(current, 'end', 4, 20);
  assert.equal(current.offset, 16);
  assert.equal(navigate(current, 'down', 4, 20).offset, 16);
  assert.equal(navigate(current, 'pageup', 4, 20).offset, 12);
  assert.equal(navigate(current, 'home', 4, 20).offset, 0);
  // In details, line keys choose an action and do not scroll.
  const actions = [['a', 'Approve once'], ['f', 'Focus pane'], ['escape', 'Back']];
  assert.equal(navigate(current, 'down', 4, 20, actions).action, 'escape');
  assert.equal(navigate({ ...current, action: 'escape' }, 'j', 4, 20, actions).action, 'escape');
  assert.equal(navigate({ ...current, action: 'f' }, 'k', 4, 20, actions).action, 'a');
  assert.equal(navigate(current, 'escape', 4).detail, false);
  assert.equal(navigate(state([]), 'return', 4).detail, false);
});

test('details contain the full request and optional fields and scroll to the end', () => {
  const row = entry('a', { request: 'first line\n' + 'wide 界😀 '.repeat(30) + '\nLAST LINE', probability: 0, detail: 'reason-code' });
  const details = detailLines(row, 30);
  assert.match(details.join('\n'), /Jev score: 0/);
  assert.match(details.join('\n'), /Detail: reason-code/);
  assert.match(details.join('\n'), /first line/);
  const current = navigate(state([row], { detail: true }), 'end', textRows(5, entryActions(row)), details.length);
  assert.match(renderScreen(current, 31, 8), /LAST LINE/);
});

test('empty history and read errors remain readable', () => {
  assert.match(renderPlain([]), /No permission history yet/);
  assert.match(renderScreen(state([]), 80, 8), /No permission history yet/);
  assert.match(renderScreen(state([], { error: '\x1b[2Jpermission denied' }), 80, 8), /Read error: permission denied/);
});

function displayWidth(s) {
  let width = 0;
  for (const ch of stripAnsi(s)) width += ch.codePointAt(0) > 0x7e ? 2 : 1;
  return width;
}

test('narrow and short windows never overflow, including wide characters', () => {
  const row = entry('界😀', { request: '界😀e\u0301'.repeat(20), reason: '界'.repeat(20) });
  for (const columns of [1, 2, 3, 10, 40]) {
    for (const rows of [1, 2, 3, 8]) {
      for (const detail of [false, true]) {
        const lines = renderScreen(state([row], { detail }), columns, rows).split('\r\n');
        assert.ok(lines.length <= rows);
        for (const line of lines) {
          assert.ok(displayWidth(line) <= Math.max(1, columns - 1), `${columns} columns: ${line}`);
        }
      }
    }
  }
  assert.equal(clip('界a', 2), '界');
});

test('non-TTY CLI reads real history newest first and emits no terminal controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-ui-'));
  try {
    await mkdir(join(directory, 'history'));
    await writeFile(join(directory, 'history', 'requests.jsonl'), [
      entry('old', { processedAt: '2026-10-15T18:00:00Z' }),
      entry('new', { request: 'request new\x1b[2J\u202e' }),
    ].map(JSON.stringify).join('\n') + '\n');
    const result = spawnSync(process.execPath, ['history-ui.mjs'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, HERDR_PLUGIN_STATE_DIR: directory }, timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.indexOf('request new') < result.stdout.indexOf('request old'));
    assert.doesNotMatch(result.stdout, /[\x1b\p{Cf}]/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('non-TTY read errors reject without entering terminal mode', async () => {
  let output = '';
  await assert.rejects(main({
    stateDir: '/unused', input: {}, output: { write: (text) => { output += text; } },
    read: async () => { throw new Error('read denied'); },
  }), /read denied/);
  assert.equal(output, '');
});

test('interactive refresh, resize, details, and exit restore terminal state', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  const output = new EventEmitter();
  Object.assign(output, { isTTY: true, columns: 100, rows: 8 });
  let text = '';
  output.write = (chunk) => { text += chunk; };
  let reads = 0;
  const before = process.listenerCount('SIGTERM');
  const running = main({ input, output, stateDir: '/unused', socketPath: '', read: async () => {
    reads++;
    if (reads === 2) throw new Error('\x1b[2Jtemporary failure');
    return reads > 2 ? [entry('new'), entry('a'), entry('b')] : [entry('a'), entry('b')];
  } });
  // History, labels, and live panes load in parallel; wait for the whole refresh.
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
// Wait for real work instead of a fixed number of ticks, so file and socket
// work from earlier tests cannot make a keypress arrive before the first render.
const until = async (predicate, what) => {
  for (let i = 0; i < 2_000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const ready = (box) => until(() => box.text.includes('q quit'), 'the first render');
  try {
    await settle();
    assert.equal(input.isRaw, true);
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });
    input.emit('keypress', '', { name: 'end' });
    assert.match(text, /Request:/);
    t.mock.timers.tick(2_000);
    await settle();
    assert.match(text, /Read error: temporary failure/);
    input.emit('keypress', 'r', { name: 'r' });
    await settle();
    assert.match(stripAnsi(text), /3\/3 \| Details/);
    const previousScreen = text;
    t.mock.timers.tick(2_000);
    await settle();
    assert.equal(text, previousScreen);
    input.emit('keypress', '', { name: 'escape' });
    output.columns = 20;
    output.emit('resize');
    assert.equal(reads, 4);
  } finally {
    input.emit('keypress', 'q', { name: 'q' });
    await running;
    input.destroy();
  }
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.ok(text.endsWith('\x1b[?25h\x1b[?1049l'));
  assert.equal(process.listenerCount('SIGTERM'), before);
  assert.equal(output.listenerCount('resize'), 0);
});

function terminal(columns = 110, rows = 12) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  const output = new EventEmitter();
  Object.assign(output, { isTTY: true, columns, rows });
  const box = { input, output, text: '' };
  output.write = (chunk) => { box.text += chunk; };
  return box;
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
// Wait for real work instead of a fixed number of ticks, so file and socket
// work from earlier tests cannot make a keypress arrive before the first render.
const until = async (predicate, what) => {
  for (let i = 0; i < 2_000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const ready = (box) => until(() => box.text.includes('q quit'), 'the first render');
const label = (request, value, cwd) => ({ request, label: value, cwd, recordedAt: '2026-10-30T10:00:00.000Z' });

test('labels and live requests are marked in both lists and in plain output', () => {
  const rows = [
    entry('a', { request: '$ npm test' }),
    entry('b', { request: '$ npm run build', processedAt: '2026-10-16T17:00:00.000Z' }),
  ];
  const pending = [{ pane: 'w1:p1', agent: 'claude', request: '$ npm test', live: true, identity: 'identity-1' }];
  const marked = annotate(rows, [label('$ npm test', 'approve', '/tmp'), label('$ npm run build', 'manual')], pending);
  assert.equal(marked[0].label, 'approve');
  assert.equal(marked[0].live, true);
  assert.equal(marked[0].identity, 'identity-1');
  assert.equal(marked[1].identity, undefined);
  assert.equal(marked[1].label, 'manual');
  assert.equal(marked[1].live, false);
  const history = renderScreen(state(marked, { pending: [] }), 110, 10);
  const plainHistory = stripAnsi(history);
  assert.match(plainHistory, /> \*\+ /);
  assert.match(plainHistory, / .- 10-16 17:00/);
  assert.match(renderPlain(marked), /\+ 10-16 18:00:00  approved  jev  \$ npm test/);
  const pendingScreen = renderScreen(state(marked, { tab: 'pending', pending }), 110, 10);
  const plainPending = stripAnsi(pendingScreen);
  assert.match(plainPending, /Pending requests \| Live/);
  assert.match(plainPending, /w1:p1  claude  \$ npm test/);
});

test('each list keeps its own selection and Tab switches between them', () => {
  const rows = [entry('a'), entry('b')];
  const pending = [
    { pane: 'w2:p1', agent: 'claude', request: '$ one', live: true },
    { pane: 'w2:p2', agent: 'codex', request: '$ two', live: true },
  ];
  let current = state(rows, { pending });
  current = navigate(current, 'down', 5);
  assert.equal(current.selected, 1);
  // Tab goes 1, 2, 3, then back to 1. Shift+Tab goes back.
  assert.equal(switchTab(current).tab, 'settings');
  assert.equal(switchTab(switchTab(current)).tab, 'pending');
  current = switchTab(current, -1);
  assert.equal(current.tab, 'pending');
  assert.equal(current.pendingSelected, 0);
  assert.equal(selectedEntry(current).pane, 'w2:p1');
  current = navigate(current, 'down', 5);
  assert.equal(current.pendingSelected, 1);
  current = navigate(current, 'return', 5);
  assert.match(stripAnsi(renderScreen(current, 110, 10)), /2\/2 \| Details/);
  current = switchTab(current);
  assert.equal(current.tab, 'history');
  assert.equal(current.detail, false);
  assert.equal(current.selected, 1);
  assert.equal(replacePending(current, [pending[0]]).pendingSelected, 0);
  assert.equal(replacePending(current, []).pendingSelected, 0);
  // A row keeps its place only while it shows the same request; otherwise the
  // cursor follows the pane and never silently approves different text.
  const samePane = replacePending(state(rows, { pending, tab: 'pending', pendingSelected: 1 }), [
    { ...pending[1], request: '$ three' }, pending[0],
  ]);
  assert.equal(samePane.pendingSelected, 0);
  const sameRequest = replacePending(state(rows, { pending, tab: 'pending', pendingSelected: 1 }), [pending[1], pending[0]]);
  assert.equal(sameRequest.pendingSelected, 0);
  assert.equal(sameRequest.pending[0].pane, 'w2:p2');
  // Open details close when the request in the pane changes.
  const open = state(rows, { pending, tab: 'pending', pendingSelected: 1, detail: true });
  assert.equal(replacePending(open, [{ ...pending[1], request: '$ three' }]).detail, false);
  assert.equal(replacePending(open, [{ ...pending[1], identity: 'new' }]).detail, false);
  assert.equal(replacePending(open, [pending[1]]).detail, true);
});

test('the chosen action follows its key when the action list changes', () => {
  const idle = entryActions({ pane: 'w1:p1', request: 'x' });
  const live = entryActions({ pane: 'w1:p1', request: 'x', live: true, label: 'approve' });
  assert.equal(idle[actionIndex(idle, undefined)][0], 'f');
  assert.equal(live[actionIndex(live, undefined)][0], 'f');
  assert.equal(live[actionIndex(live, 'f')][0], 'f');
  // A removed action selects Back, not the action that took its place.
  assert.equal(idle[actionIndex(idle, 'u')][0], 'escape');
  assert.equal(idle[actionIndex(idle, 'a')][0], 'escape');
  // A very short pane still shows the chosen action.
  for (const rows of [4, 5]) {
    const screen = stripAnsi(renderScreen({ tab: 'settings', settingsDetail: true, settingsSelected: 0, settings: undefined }, 60, rows));
    assert.match(screen, /Action 1\/2: > Turn off Space/, String(rows));
  }
});

test('detail view shows the user label, liveness, missing fields, and scrolls', () => {
  const row = annotate([entry('a', { request: 'Edit file\n\nsrc/app.js' })], [label('Edit file\n\nsrc/app.js', 'manual')], [])[0];
  const details = detailLines(row, 80).join('\n');
  assert.match(details, /Label: should take no action/);
  assert.doesNotMatch(details, /Live:/);
  const live = detailLines({ pane: 'w2:p4', agent: 'codex', request: '$ npm test', live: true, reason: 'pane-read-truncated' }, 80).join('\n');
  assert.match(live, /Live: yes/);
  assert.match(live, /Reason: pane-read-truncated/);
  const colored = detailLines(row, 80, true);
  assert.match(colored.join('\n'), /\x1b\[90mLabel:\x1b\[0m/);
  assert.equal(colored.length, detailLines(row, 80).length);
  assert.ok(colored.every((line) => displayWidth(line) <= 80));
  assert.equal(detailLines({ request: '$ npm test' }, 80).join('\n').includes('Time:'), false);
});

test('approve results map to short status messages', () => {
  assert.equal(approveMessage({ ok: true }), 'Approved once');
  assert.equal(approveMessage({ ok: false, reason: 'already-reviewed' }), 'Already reviewed');
  assert.equal(approveMessage({ ok: false, reason: 'approval-delivery-unknown' }), 'Delivery unknown; check the pane');
  assert.match(approveMessage({ ok: false, reason: '\x1b[2Jodd' }), /^Cannot approve: odd/);
});

test('keys approve a live request, record labels, and focus another pane', async () => {
  const box = terminal();
  const { input, output } = box;
  const calls = [];
  const pending = [{ pane: 'w2:p4', agent: 'claude', cwd: '/project', request: '$ npm run lint', live: true, identity: 'identity-1' }];
  const running = main({
    input, output, stateDir: '/unused', socketPath: '', paneId: '',
    read: async () => [entry('a', { request: '$ npm test' })],
    readLabels: async () => [label('$ npm test', 'approve')],
    pending: async () => pending,
    approve: async (row) => { calls.push(['approve', row.pane, row.request, row.identity]); return { ok: true }; },
    focus: async (pane) => { calls.push(['focus', pane]); return { ok: true }; },
    label: async (row, value) => { calls.push(['label', row.request, value, row.cwd]); },
  });
  try {
    await ready(box);
    assert.match(box.text, /Tab views/);
    input.emit('keypress', '', { name: 'tab' });
    assert.match(stripAnsi(box.text), /Review pipeline/);
    input.emit('keypress', '', { name: 'tab' });
    assert.match(stripAnsi(box.text), /Pending requests \| Live/);
    input.emit('keypress', 'a', { name: 'a' });
    await until(() => /Approved once/.test(box.text), 'the approval status');
    input.emit('keypress', 'y', { name: 'y' });
    await until(() => /Marked should approve/.test(box.text), 'the approval label');
    input.emit('keypress', 'n', { name: 'n' });
    await until(() => /Marked should take no action/.test(box.text), 'the no-action label');
    input.emit('keypress', 'u', { name: 'u' });
    await until(() => /Label cleared/.test(box.text), 'the cleared label');
    // The detail view lists actions. Enter runs the chosen one.
    input.emit('keypress', '', { name: 'return' });
    // The first choice never approves, so a double Enter cannot approve.
    assert.match(stripAnsi(box.text), /Action 2\/5: > Focus pane f/);
    input.emit('keypress', 'k', { name: 'k' });
    assert.match(stripAnsi(box.text), /Action 1\/5: > Approve once a/);
    input.emit('keypress', 'j', { name: 'j' });
    assert.match(stripAnsi(box.text), /Action 2\/5: > Focus pane f/);
    input.emit('keypress', '', { name: 'return' });
    await running;
  } finally { input.destroy(); }
  assert.deepEqual(calls, [
    ['approve', 'w2:p4', '$ npm run lint', 'identity-1'],
    ['label', '$ npm run lint', 'approve', '/project'],
    ['label', '$ npm run lint', 'manual', '/project'],
    ['label', '$ npm run lint', 'clear', '/project'],
    ['focus', 'w2:p4'],
  ]);
});

test('the interface refuses to approve a request without a parsed prompt', async () => {
  const box = terminal(110, 10);
  const { input, output } = box;
  const calls = [];
  const running = main({
    input, output, stateDir: '/unused', socketPath: '',
    read: async () => [],
    readLabels: async () => [],
    pending: async () => [{ pane: 'w2:p4', agent: 'codex', reason: 'pane-read-truncated', live: true }],
    approve: async () => calls.push('approve'),
    focus: async (pane) => calls.push(['focus', pane]),
    label: async () => calls.push('label'),
  });
  try {
    await ready(box);
    input.emit('keypress', '', { name: 'tab', shift: true });
    input.emit('keypress', 'a', { name: 'a' });
    await until(() => /no approvable prompt/.test(box.text), 'the refusal status');
    input.emit('keypress', 'q', { name: 'q' });
    await running;
  } finally { input.destroy(); }
  assert.deepEqual(calls, []);
});

test('the history list approves only a row that still waits for the same request', async () => {
  const calls = [];
  const run = async (pending) => {
    const box = terminal(110, 10);
    const running = main({
      input: box.input, output: box.output, stateDir: '/unused', socketPath: '',
      read: async () => [entry('a', { request: '$ npm test' })],
      readLabels: async () => [],
      pending: async () => pending,
      approve: async (row) => { calls.push([row.pane, row.identity]); return { ok: true }; },
    });
    await ready(box);
    box.input.emit('keypress', 'a', { name: 'a' });
    await until(() => /not waiting|Approved once/.test(box.text), 'the approval status');
    box.input.emit('keypress', 'q', { name: 'q' });
    await running;
    box.input.destroy();
    return box.text;
  };
  assert.match(await run([]), /This request is not waiting/);
  assert.match(await run([{ pane: 'w1:p1', agent: 'codex', request: '$ npm test', live: true, identity: 'identity-9' }]), /Approved once/);
  assert.deepEqual(calls, [['w1:p1', 'identity-9']]);
});

test('a pane placement keeps the interface open after it focuses another pane', async () => {
  const box = terminal(110, 10);
  const calls = [];
  const directory = await mkdtemp(join(tmpdir(), 'history-pane-'));
  const running = main({
    input: box.input, output: box.output, stateDir: directory, socketPath: '', paneId: 'w1:p9',
    read: async () => [entry('a')],
    readLabels: async () => [],
    pending: async () => [],
    focus: async (pane) => { calls.push(pane); return { ok: true }; },
  });
  await ready(box);
  box.input.emit('keypress', 'f', { name: 'f' });
  await until(() => /Focused w1:p1/.test(box.text), 'the focus status');
  assert.equal(box.input.isRaw, true);
  assert.equal(await readPane(directory), 'w1:p9');
  box.input.emit('keypress', 'q', { name: 'q' });
  await running;
  box.input.destroy();
  assert.equal(await readPane(directory), null);
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(calls, ['w1:p1']);
});
