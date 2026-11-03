import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readPane } from './panes.mjs';

const PLUGIN_ID = 'herdr-permissions';
const ENTRYPOINT = 'history';

function herdr(args) {
  return execFileSync(process.env.HERDR_BIN_PATH ?? 'herdr', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
}

// A saved pane is reused only while Herdr still reports it, so a closed or
// crashed pane cannot block the next open.
function isLive(pane, run) {
  try {
    const info = JSON.parse(run(['pane', 'get', pane]));
    return info?.result?.pane?.pane_id === pane;
  } catch { return false; }
}

export async function openApprover({ stateDir = process.env.HERDR_PLUGIN_STATE_DIR, run = herdr } = {}) {
  const saved = stateDir ? await readPane(stateDir) : null;
  if (saved && isLive(saved, run)) {
    try {
      run(['plugin', 'pane', 'focus', saved]);
      return { reused: saved };
    } catch { /* The pane can close between the check and the focus. */ }
  }
  const output = run([
    'plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', ENTRYPOINT,
    '--placement', 'split', '--direction', 'right', '--focus',
  ]);
  let opened = null;
  try { opened = JSON.parse(output)?.result?.plugin_pane?.pane?.pane_id ?? null; } catch { /* Keep the raw output. */ }
  return { opened, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openApprover().then((result) => {
    if (!result.reused) process.stdout.write(result.output ?? '');
  }).catch((error) => {
    process.stderr.write(`Permission approver pane unavailable: ${String(error?.stderr ?? error?.message ?? error).trim()}\n`);
    process.exitCode = 1;
  });
}
