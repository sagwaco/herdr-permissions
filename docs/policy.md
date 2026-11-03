# Review policy

[Back to overview](../README.md)

- Routine file reads, searches, local tests, builds, recoverable source edits,
  removable development dependencies, and local development processes can pass.
  This includes local dev or preview servers, copies from a temporary directory
  into a project or worktree, installing a reviewed build artifact into a local
  distribution directory or a mounted removable device when the command asserts
  a backup and verifies the copied bytes, new Git worktrees on new local
  branches, read-only commands such as `tail`, `ps`, `rg`, and `gh pr view`, and local test or program
  runs such as `cargo test` and `cargo run`, also with GPU access. The same
  checks can pass in a disposable `docker run --rm` container with a local or
  project image and bind mounts of the project or a temporary directory. Scratch
  scripts that the agent writes to a temporary directory and then runs can pass.
  Containers with `--privileged`, host namespaces, the Docker socket, home or
  system mounts, or an unfamiliar remote image stay manual. Dry runs, such
  as `--dry-run`, `git clean -n`, and `rsync -n`, can pass when every other command
  in the request is also safe. The local push and publish rules still apply to
  dry runs.
- When a command runs a local script, such as
  `python3 -I /private/tmp/install.py`, the plugin reads the script and sends its
  contents to both reviewers. They judge the script's operations against the
  stated reason and the same decision rules. A script can pass when its stated
  purpose matches what it does and its effects are reversible, for example when
  it checks a backup, verifies hashes, stages replacements, and restores the
  previous files after a failure. Common interpreters such as `python3`, `node`,
  `bash`, `sh`, `zsh`, `ruby`, `perl`, and `php` are recognized when their
  script path has a matching extension. The plugin re-reads the script before
  sending the approval key, so a script that changed during review stays manual.
- Herdr commands that inspect the session or manage panes and tabs can pass:
  list, get, read, wait, and status commands, pane splits, and tab creation or
  closure. `herdr pane run` can pass when the command that it runs is safe. Agent
  launches and prompts, such as `herdr agent prompt`, can pass because the agent
  asks for its own permissions later.
- `herdr server stop`, workspace closure, plugin, integration, or configuration
  changes, input that could answer the permission dialog of another agent, and
  agents started without permission checks stay with a human.
- Destruction of unique data, production disruption, disk or database erasure,
  secret disclosure, messages, purchases, publishing, and actions without a
  concrete recovery path stay with a human.
- Git pushes always stay with a human. The plugin also applies local checks for
  recognizable credentials and some destructive commands before it calls TypeSafe.
- Jev approves requests with a valid approval probability at or above the
  threshold (0.80 by default). Every valid score below the threshold goes to the
  agent review with the same policy.
  Without a key, or with Jev off, every request that passes the filters and
  labels goes to the agent review. The review must return a structured boolean
  approval. Its decisions on borderline requests vary between runs, so a plain
  rejection gets one more review. Either approval approves the request once. An
  agent error is not reviewed again. With the agent review off, a score below
  the threshold stays manual (`below-threshold`). With both off, the result is
  `no-reviewer`.
- Network failures, malformed responses, uncertain decisions, hidden command
  text, and unknown prompt formats leave the prompt untouched. A TypeSafe
  failure does not call the agent review. Agent errors or rejection leave the
  prompt for a human.

The plugin sends the visible permission request to `api.typesafe.ai`. This can
include paths, commands, and source code. For a command that runs a local script,
it also sends that script's contents. Script contents are read only from a
temporary directory or the agent's project directory, are included only when the
command clearly runs them, and are bounded to 32 KiB per script and 64 KiB in
total. A script that is larger, unreadable, or outside those directories leaves
the request for a human. It excludes preceding conversation text and permission
menu choices. The API key is sent only in the HTTPS authorization header. Recognizable credentials in a prompt
or script stop the request locally. That check cannot identify every possible
secret format. History stores the request text but not the script contents.

The agent review sends the request to the chosen CLI. It does not send the
TypeSafe key or the Jev score. Each CLI runs one print-mode review from the
temporary directory, with the request on standard input as untrusted data and
the policy in the system prompt or task:

- Pi: no session file, no built-in, extension, custom, or MCP tools, no
  extensions, skills, prompt templates, or project context files, thinking off.
- Claude Code: `--print --safe-mode --tools "" --strict-mcp-config
  --no-session-persistence` with `--system-prompt`.
- Codex: `codex exec --ephemeral --skip-git-repo-check --ignore-user-config
  --ignore-rules --sandbox read-only` with `approval_policy="never"`, and with
  the shell tools, apps, plugins, hooks, browser use, and computer use disabled.

The answer must contain a JSON boolean `approve`; anything else is rejected.
Standard usage limits and charges of the chosen CLI apply.
