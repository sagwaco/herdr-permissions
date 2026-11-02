import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

const MAX_SCRIPTS = 4;
const MAX_SCRIPT_BYTES = 32_000;
const MAX_TOTAL_BYTES = 64_000;
// Only interpreters whose next argument is a readable local script file.
const INTERPRETER = /^(?:python(?:3(?:\.\d+)?)?|node|deno|bun|bash|sh|zsh|ruby|perl|php)\b(.*)$/;
const SCRIPT_EXTENSION = /\.(?:py|pyw|js|mjs|cjs|ts|sh|bash|zsh|rb|pl|php)$/i;

function tokens(text) {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^['"]|['"]$/g, ''));
}

// Match interpreter commands at the start of a shell segment, not prose that
// merely mentions a script path in the reason or conversation.
export function scriptPaths(text) {
  const paths = [];
  for (const line of text.split('\n')) {
    for (const segment of line.replace(/^\s*\$\s+/, '').split(/&&|\|\||;|\|/)) {
      const match = INTERPRETER.exec(segment.trim());
      if (!match) continue;
      for (const raw of tokens(match[1])) {
        if (raw.startsWith('-')) continue;
        const token = raw.replace(/[),;&|]+$/, '');
        if (!SCRIPT_EXTENSION.test(token)) continue;
        if (!paths.includes(token)) paths.push(token);
        break;
      }
    }
  }
  return paths;
}

async function rootsFor(cwd) {
  const roots = [];
  for (const candidate of [tmpdir(), '/tmp', '/private/tmp', cwd]) {
    if (!candidate) continue;
    try { roots.push(await realpath(candidate)); } catch { /* A missing root cannot contain a script. */ }
  }
  return roots;
}

function within(path, roots) {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

async function readOne(path, roots) {
  let real;
  try { real = await realpath(path); } catch { return { reason: 'script-unreadable' }; }
  if (!within(real, roots)) return { reason: 'script-unreadable' };
  let file;
  try {
    file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_SCRIPT_BYTES) return { reason: 'script-unreadable' };
    const bytes = await file.readFile();
    if (bytes.length > MAX_SCRIPT_BYTES || bytes.includes(0)) return { reason: 'script-unreadable' };
    return {
      path: real,
      text: bytes.toString('utf8'),
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return { reason: 'script-unreadable' };
  } finally {
    await file?.close();
  }
}

// Read only scripts in a temporary directory or the agent's project directory.
// The contents are sent to both reviewers as untrusted data.
export async function readScripts(text, cwd) {
  const targets = scriptPaths(text).map((path) => (isAbsolute(path) ? path : cwd ? resolve(cwd, path) : null));
  if (targets.some((path) => path === null)) return { reason: 'script-unreadable' };
  if (targets.length === 0) return { scripts: [] };
  if (targets.length > MAX_SCRIPTS) return { reason: 'script-unreadable' };
  const roots = await rootsFor(cwd);
  const scripts = [];
  let total = 0;
  for (const target of targets) {
    const script = await readOne(target, roots);
    if (script.reason) return script;
    total += script.text.length;
    if (total > MAX_TOTAL_BYTES) return { reason: 'script-unreadable' };
    scripts.push(script);
  }
  return { scripts };
}

// The reviewed contents must be the contents that run. A script that changed
// after classification stays for a human.
export async function verifyScripts(scripts) {
  for (const script of scripts) {
    const current = await readOne(script.path, [script.path]);
    if (current.reason || current.path !== script.path || current.digest !== script.digest) {
      return { reason: 'script-changed' };
    }
  }
  return null;
}
