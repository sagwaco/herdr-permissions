import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUESTIONS } from '../policy.mjs';
import { codexPreviewClipped, expandCodexPreview, parsePrompt } from '../prompts.mjs';

const CODEX_INDENTED = `  Would you like to run the following command?

  Reason: Install the reviewed artifact to the mounted card
  $ python3 - <<'PY'
  from pathlib import Path
  for name in ('a', 'b'):
      print(name)
  PY

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

const CODEX_CLIPPED = `Would you like to run the following command?

Reason: Run the local test suite
  $ npm test
  [… 2 lines] ⌃a view all

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel`;

test('clipped Codex command previews expand from the pager content', () => {
  assert.equal(parsePrompt('codex', CODEX_CLIPPED), null);
  assert.equal(codexPreviewClipped(CODEX_CLIPPED), true);
  const expanded = expandCodexPreview(CODEX_CLIPPED, ['npm test', 'echo hidden']);
  assert.ok(expanded);
  assert.match(expanded.prompt.text, /echo hidden/);
  assert.deepEqual(expanded.prompt.keys, ['y']);
  assert.equal(expandCodexPreview(CODEX_CLIPPED, []), null);
});

test('codex requests keep command indentation for classification', () => {
  const parsed = parsePrompt('codex', CODEX_INDENTED);
  assert.ok(parsed);
  assert.match(parsed.text, /\n    print\(name\)/);
  assert.ok(!parsed.text.includes('› 1.'));
});

test('policy allows a reviewed artifact install to a mounted device with a verified backup', () => {
  assert.match(QUESTIONS.approve.criteria.true, /mounted removable device/);
  assert.match(QUESTIONS.approve.criteria.true, /backup of the destination exists/);
  assert.match(QUESTIONS.approve.criteria.true, /verifies the copied bytes/);
});

test('policy allows project checks in a disposable container and scratch scripts, but not risky containers', () => {
  assert.match(QUESTIONS.approve.criteria.true, /docker run --rm with a local or project image/);
  assert.match(QUESTIONS.approve.criteria.true, /scratch script or data file in a temporary directory/);
  assert.match(QUESTIONS.approve.criteria.true, /review sandbox, workspace root, and file permissions do not describe the request/);
  assert.match(QUESTIONS.approve.criteria.false, /--privileged/);
  assert.match(QUESTIONS.approve.criteria.false, /mounting the Docker socket/);
  assert.match(QUESTIONS.approve.criteria.false, /--network=host/);
  assert.match(QUESTIONS.approve.criteria.true, /newline that separates shell commands/);
});
