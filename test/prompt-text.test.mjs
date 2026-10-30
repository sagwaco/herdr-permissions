import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUESTIONS } from '../policy.mjs';
import { parsePrompt } from '../prompts.mjs';

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
