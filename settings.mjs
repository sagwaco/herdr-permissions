import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const KEYCHAIN_SERVICE = 'model-router-typesafe';

// Each harness runs one review without tools. `models` returns choices for the
// settings list; free text is always accepted too.
export const HARNESSES = {
  pi: {
    name: 'Pi', defaultModel: 'deepseek/deepseek-v4.1-flash-1017',
    models: async (run = execText) => (await run('pi', ['--list-models'])).split('\n').slice(1)
      .map((line) => line.trim().split(/\s+/)).filter((cols) => cols.length >= 2).map(([provider, id]) => `${provider}/${id}`),
  },
  claude: {
    name: 'Claude Code', defaultModel: 'haiku',
    models: async () => ['haiku', 'sonnet', 'opus', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],
  },
  codex: {
    name: 'Codex', defaultModel: 'gpt-6-luna',
    models: async (run = execText) => JSON.parse(await run('codex', ['debug', 'models'])).models
      .filter((model) => model.visibility === 'list').map((model) => model.slug),
  },
};

export const DEFAULT_SETTINGS = {
  secrets: true, humanOnly: true, labels: true, jev: true, agent: true,
  jevThreshold: 0.8, harness: 'pi', model: HARNESSES.pi.defaultModel,
};

// Jev approves a request when its score is at or above the threshold. A value
// below 0.50 would approve requests that Jev thinks need a human.
export function validThreshold(value) {
  const number = typeof value === 'string' && /^[01](\.\d{1,2})?$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && number >= 0.5 && number <= 1;
}

// A model name goes into a command argument. It must not look like a flag.
export const validModel = (value) => typeof value === 'string' && /^[\w./:@[\]-]{1,128}$/.test(value) && !value.startsWith('-');

export function normalize(raw) {
  const result = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return result;
  for (const key of ['secrets', 'humanOnly', 'labels', 'jev', 'agent']) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key];
  }
  if (typeof raw.jevThreshold === 'number' && validThreshold(raw.jevThreshold)) result.jevThreshold = raw.jevThreshold;
  if (Object.hasOwn(HARNESSES, raw.harness)) {
    result.harness = raw.harness;
    result.model = validModel(raw.model) ? raw.model : HARNESSES[raw.harness].defaultModel;
  }
  return result;
}

const settingsPath = (stateDir) => join(stateDir, 'settings.json');

// A missing file gives the defaults. A damaged file throws, so the hook
// leaves requests for a human instead of turning stages back on.
export async function readSettings(stateDir) {
  let raw;
  try { raw = JSON.parse(await readFile(settingsPath(stateDir), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw new Error('settings-invalid');
  }
  const settings = normalize(raw);
  const valid = raw && typeof raw === 'object' && !Array.isArray(raw)
    && Object.entries(raw).every(([key, value]) => Object.hasOwn(DEFAULT_SETTINGS, key)
      && (['harness', 'model', 'jevThreshold'].includes(key) ? settings[key] === value : typeof value === 'boolean'));
  if (!valid) throw new Error('settings-invalid');
  return settings;
}

export async function writeSettings(stateDir, settings) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = settingsPath(stateDir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(normalize(settings), null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, target); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function execText(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 4_000_000, cwd: '/',
  }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
}

// Read the TypeSafe key. Return null when it is missing, so Jev is skipped.
export function readKeychain(run = execFileSync) {
  if (process.platform !== 'darwin') return null;
  try {
    const key = run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    return key || null;
  } catch { return null; }
}

// Check for the key without reading the secret.
export function hasKey(run = execFileSync) {
  if (process.platform !== 'darwin') return false;
  try {
    run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch { return false; }
}

export const validKey = (key) => typeof key === 'string' && /^[\w.~+/=-]{8,512}$/.test(key);

// Send the key on stdin to `security -i`, so it never shows in the process list.
export function storeKey(key, run = execFileSync) {
  if (!validKey(key)) throw new Error('invalid-key');
  run('/usr/bin/security', ['-i'], {
    input: `add-generic-password -U -a "${/^[\w.-]+$/.test(process.env.USER ?? '') ? process.env.USER : 'user'}" -s ${KEYCHAIN_SERVICE} -w "${key}"\n`,
    stdio: ['pipe', 'ignore', 'ignore'], timeout: 5_000,
  });
}

export function deleteKey(run = execFileSync) {
  try { run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE], { stdio: 'ignore', timeout: 5_000 }); }
  catch { /* A missing key needs no removal. */ }
}
