import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function reviewWithCodex(prompt, policy, run = execFileSync) {
  try {
    const output = run('codex', [
      '--no-daemon', 'exec', '--model', 'gpt-6-luna', '--sandbox', 'read-only',
      '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--json', '--color', 'never',
      '--output-schema', fileURLToPath(new URL('./decision.schema.json', import.meta.url)),
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
      '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
      '-c', 'history.persistence="none"',
      '-c', 'model_reasoning_effort="low"',
      '-c', `developer_instructions=${JSON.stringify(`${policy.instructions}\nReview only. Do not execute the request or use tools. Approve only when the true criteria apply. Otherwise return approve=false.\nTrue criteria: ${policy.criteria.true}\nFalse criteria: ${policy.criteria.false}`)}`,
      // A review must not execute commands or load integrations and hooks.
      ...['shell_tool', 'shell_snapshot', 'apps', 'plugins', 'hooks', 'multi_agent',
        'browser_use', 'computer_use', 'image_generation', 'view_image', 'skill_search', 'goals']
        .flatMap((feature) => ['--disable', feature]),
      '-',
    ], {
      input: JSON.stringify({ agent: prompt.agent, permission_request: prompt.text }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], cwd: tmpdir(),
      timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64_000,
    });
    const events = output.trim().split('\n').map((line) => JSON.parse(line));
    if (events.at(-1)?.type !== 'turn.completed'
      || events.some((event) => ['error', 'turn.failed'].includes(event?.type)
        || (event?.item && !['agent_message', 'reasoning'].includes(event.item.type)))) {
      return { approve: false, reason: 'codex-invalid-decision' };
    }
    const message = events.filter((event) => event?.type === 'item.completed' && event.item?.type === 'agent_message').at(-1);
    const decision = JSON.parse(message?.item.text ?? 'null');
    if (typeof decision?.approve !== 'boolean') return { approve: false, reason: 'codex-invalid-decision' };
    return { approve: decision.approve, reason: decision.approve ? 'reversible' : 'human-review' };
  } catch {
    return { approve: false, reason: 'codex-unavailable' };
  }
}
