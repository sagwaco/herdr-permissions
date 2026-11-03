# Permission Approver for Herdr

A [Herdr](https://herdr.dev) plugin that approves agent permission prompts in
Claude Code and Codex, one request at a time. Each request passes local
filters and your labels. Then it goes to [TypeSafe AI](https://typesafe.ai) (the
Jev model) when you supply a TypeSafe API key, and to an agent review with the
harness and model that you choose: [Pi](https://pi.dev), Claude Code, or Codex.
You can turn each stage on or off in the settings view. It has no package
dependencies.

The policy approves ordinary development work when its effects are clear and the
agent can reverse them. It leaves catastrophic actions and changes that the agent
cannot reverse for a human. It never selects a permanent or session-wide grant.

## Setup

Requirements:

- macOS
- Node.js 22 or later
- Herdr 0.9.3 or later
- An authenticated agent CLI for the agent review. The default is Pi with
  `deepseek/deepseek-v4.1-flash-1017` and thinking off. Claude Code and Codex
  are also supported.
- Optional: a TypeSafe API key. Jev is off until a key is present.

Node and the chosen agent CLI must be on the Herdr server's `PATH`.

To use Jev, set the key in the settings view (`3`, then Enter on Jev and choose Set API key),
or store it in the Keychain service `model-router-typesafe`:

```sh
security add-generic-password -U -a "$USER" -s model-router-typesafe -w
```

Then install the plugin and check the connection:

```sh
herdr plugin install sagwaco/herdr-permissions
herdr plugin action invoke check --plugin herdr-permissions
herdr plugin log list --plugin herdr-permissions --limit 10
```

To work on the source, link a local clone instead:

```sh
git clone https://github.com/sagwaco/herdr-permissions.git
cd herdr-permissions
npm test
herdr plugin link "$PWD"
```

Installation enables the event hook for new permission prompts in all local Herdr
sessions. To activate a disabled plugin:

```sh
herdr plugin enable herdr-permissions
```

The connection check sends one synthetic read-only request through the enabled
stages: to TypeSafe when Jev has a key, and to the agent review when Jev is off
or the score is below the threshold. The log field `jev` is `on`, `off`, or `no-key`. It does not read a pane or approve an
agent request. Check the command log for `"connected":true`. Standard TypeSafe API charges apply.

To review prompts that were already open before activation:

```sh
herdr plugin action invoke review-pending --plugin herdr-permissions
```

To stop automatic approvals:

```sh
herdr plugin disable herdr-permissions
```

Use `herdr plugin uninstall herdr-permissions` (or `herdr plugin unlink herdr-permissions`
for a linked clone) to remove the registration. Plugin state remains on disk.

## Request history and approvals

Open the permission interface from a shell inside Herdr:

```sh
herdr plugin action invoke herdr-permissions
```

The action opens the interface in a normal pane, split to the right of the
calling pane. The pane belongs to the tab like any other split pane, so it stays
open while you work in other panes and returns with the session. Your other keys
keep working in the panes around it. Press `q` in the interface to close that
pane.

The action remembers the pane that it opened. Invoking it again focuses that pane
instead of opening a second copy. When the recorded pane is gone, the action opens
a new one. Several running interfaces share one record, so the action returns to
the most recently started one. To open a full tab instead:

```sh
herdr plugin pane open --plugin herdr-permissions --entrypoint history --placement tab --focus
```

The interface records its pane in `pane.json` in the plugin state directory. The
file mode is 0600. The record is removed when the interface exits.

The pane has two lists and a settings view. `1 Pending` lists agents that are
waiting for permission now. `2 History` lists processed requests with the newest
first. `3 Settings` shows the review pipeline. Press `1`, `2`, or `3` (or `s`) to
open a view, or `Tab` and Shift+Tab to go to the next or previous view, and use the arrow keys or `j` and `k` to move. Page Up and Page Down
scroll, and Home and End jump. Press Enter to inspect a request and Escape to
return to the list. The detail view lists the actions for the request: approve
once (when an agent still waits for it), focus the pane, set or clear a label,
and back. Use `j` and `k` or the arrow keys to choose one and Enter to run it.
The first choice is never Approve once, so a quick second Enter cannot approve.
If the request in a pending row changes, its details close.
The shortcut keys also work. Page Up and Page Down scroll the details. A short
pane shows only the chosen action, as `Action 1/5`. Press `r` to refresh or `q` to close. Both lists refresh every
two seconds and keep the selected row. If the socket is not available, the
interface shows history only.

Each history row shows a two-character mark, the processing time, the age of a
request from the last seven days (for example `5m ago`), result, reviewer, and
request summary. In a pane narrower than 73 columns, a row shows the age (or the
date for an older request), result, and request, and the header and key help get
shorter. The first character is `*` when an agent still
waits for that exact request, otherwise a space. The second character is `+` for
a `should approve` label, `-` for a `should take no action` label, and `.` when
the request has no label. Pending rows show the pane, agent, and request.

### Settings

The settings view draws the pipeline as columns from left to right: Filters
(Secrets and Human-only), Labels, Jev, and Agent review. Connectors show the
order, and the line under each column shows where a request goes next. A narrow
pane stacks the stages vertically. Use `j` and `k` or the arrow keys to select a
switch, Space to turn it on or off, and Enter to inspect a stage. The detail view
lists the actions for the stage; choose one and press Enter. Escape goes back one
level. `s` or Escape on the pipeline closes settings and returns to the list that
opened it.

- Jev shows `[-]` when it is on but has no key. Space or Set API key (`e`) on
  Jev asks for the key. The key is masked, is sent to `security -i` on standard
  input, and is stored in the Keychain service `model-router-typesafe`. Remove
  API key (`x`) removes it.
- Change threshold (`t`) on Jev sets the lowest score that Jev approves. Choose
  a value from 0.50 to 1.00 in steps of 0.05, or type a value in that range with
  up to two decimals. The default is 0.80. A higher value sends more requests to
  the agent review.
- On Agent review, Change harness (`h`) selects the harness (`pi`, `claude`, or
  `codex`) and Change model (`m`) selects the model. The model list comes from `pi --list-models`,
  `codex debug models`, or a fixed list of Claude aliases and IDs. Type to filter
  the list; a model that is not in the list can be typed and chosen as
  `Use "name"`. Names that start with `-` or contain spaces or shell characters
  are rejected.
- Turning off Secrets lets credentials reach Jev and the agent review. Turning
  off Human-only lets a reviewer approve Git pushes and the other listed
  actions. With Jev and the agent review both off, only `should approve` labels
  approve requests.

Settings are stored in `settings.json` in the plugin state directory with mode
0600. The hook reads the file for each request, so the next request uses a
change. A missing file gives the defaults. A damaged file, or one with an
unknown value, leaves every request for a human until a change in the settings
view saves the file again.

Keys that act on the selected row:

- `a` approves the request once. The key is only sent for a row that still waits
  for the same request, marked with `*` in the history list. The interface takes
  the same claim as an automatic review, reads the prompt inside that claim, and
  compares the agent session and full request before it sends the one-time
  approval key. A request that the automatic review left for a human can be
  approved, because that review marks its claim as declined when it sends no
  key. A request whose key was sent, or may have been sent, is not sent again. A human
  approval is recorded in the history with the reviewer `human`. A failed send
  is recorded as `unknown`. A pane whose dialog is not a supported permission
  prompt, or whose clipped preview cannot be expanded safely, cannot be approved
  with `a`. Use `f` for that pane.
- `f` moves focus to the pane that owns the request. An agent keeps its prompt,
  so you can answer it yourself. In a split or tab pane the interface stays open
  for your return. A popup, if you open one with `--placement popup`, closes. If
  Herdr does not accept the focus request, the interface reports the failure and
  stays open.
- `y` marks the request `should approve`, `n` marks it `should take no action`,
  and `u` clears the label.

History starts when the plugin is installed. It records supported requests
after the plugin claims them. Repeated polls and unrecognized dialogs do not add
rows. Results are `approved`, `manual`, or `unknown`. An `unknown` result means
the approval key may have been delivered but Herdr did not confirm delivery.
An interrupted hook can leave its last request without a history record.

History is stored in `history/requests.jsonl` inside the plugin state directory.
The directory mode is 0700 and the file mode is 0600. It contains request text,
paths, and decision metadata. A request with a recognizable credential is hidden
in full before storage. This check cannot detect every possible secret format.
The pane shows up to 1000 recent records from the last 32 MiB. Older records stay
in the file. If a history write fails, the plugin logs `history-unavailable` and
continues permission processing; that request can be absent from the list.

## Labels and learning

A label is a decision for one exact request text. Labels are stored in
`history/feedback.jsonl` with the same private directory and file modes as the
history. The file contains request text and the working directory. Clear a label
with `u` when a decision was wrong. The labels change later decisions in these
ways:

- `should approve` applies to the same request text in the same working
  directory. That request is approved once when it arrives. Jev and the agent review are
  not called, and the Keychain is not read. The history reviewer is `user` and
  the detail is `user-precedent`. The directory is part of the key, because the
  same command text can be harmless in a scratch checkout and destructive in a
  project. A row without a usable directory, including one whose path was
  hidden, cannot receive this label.
- `should take no action` applies to the same request text in every directory.
  That request stays for a human. Jev and the agent review are not called, and the result
  reason is `user-precedent-manual`. A no-action label wins over an approval
  label for the same request.
- The local checks still run first. A request that contains a recognizable
  credential (`sensitive-content`) or a human-only action stays with a human even
  when it has a `should approve` label. Changing the plugin to a disabled state
  also stops a labeled approval, and the final prompt check still applies. For a
  request that runs a local script, an approval label does not skip the script
  review, because the label only covers the request text and not the script
  contents. A no-action label still applies.
- Matching is exact. A request that differs in one character, one path, one flag,
  or one space has no effect. Pending rows can be labeled before approval.

A request that contains a recognizable credential cannot be labeled, because the
label file would store the credential. A human-only request, such as a Git push,
can be labeled. Hidden history rows never match a label. Pressing `u` removes the
no-action label everywhere and the approval label for that row's directory; an
approval label for the same request in another directory stays. A label is
bounded to the newest 5000 requests, and the interface reads the last 8 MiB of
the file. The least recently changed label is dropped first. The interface
sanitizes stored text before it draws, so terminal control characters in stored
data cannot move the cursor.

A label is not a permanent grant. It repeats one decision for one request, and
`u` removes it so that later requests wait for a human again.

## Decision rules

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

## Supported prompts and limits

Claude Code: command and file permission dialogs with the first `Yes` row selected.
Codex: command and edit dialogs with the first one-time approval row selected and
its letter shortcut visible. A long Codex command preview that ends with the
`view all` hint is expanded through Codex's pager, read page by page, and closed
again before review. The expansion is used only when the restored dialog matches
the original clipped screen. These layouts were checked against Claude Code
2.1.296 and Codex 0.162.1. Custom layouts can require an adapter update.

Questions, repository trust, screen-reader input menus, clipped previews that
cannot be restored, and unsupported agents remain manual. OpenCode remains manual
because its selection uses color and its terminal dialog has no direct one-time
approval shortcut.

Each hook checks the agent identity, session, state, revision, and full prompt again
before it sends one key. It compares the `agent.get` revision before and after each
text read, and reads again up to five times when a redraw changes it. Herdr 0.9.3
returns a fixed zero from `agent.read.revision`, so that field cannot identify a
change. The revision can differ between classification and the final check, because
Codex redraws change it while the prompt text stays the same. The final check and
the request fingerprint use the parsed permission request and one-time approval
keys. They exclude surrounding conversation text. A lock prevents concurrent
reviews of the same agent transition. A saved fingerprint prevents a second send
after an uncertain result. Matching fingerprints from older versions are updated
under the lock without repeating the approval.
If the final check fails before any key is sent, the plugin releases that claim
so the request can be checked again. It keeps claims after a rejection, an error,
or an attempted key send. A failed release leaves the request for a human.
The hook briefly checks for queued dialogs that keep the same blocked state.
It stops when the agent enters another state. A new event handles that transition.

Herdr 0.9.3 has no atomic request-specific approval operation. There is a small
interval between the final check and key delivery. A user or another tool can
change the prompt in that interval. A screen can also contain misleading text.
Jev and the agent review can make classification errors. This plugin reduces manual approvals;
it cannot guarantee that every irreversible action will reach a human.

An interrupted hook leaves its current request for a human. A new agent transition
gets a new lock. An identical queued dialog without a state change also stays
manual. Claim files contain hashes. History stores request text as described above.
Command logs contain pane IDs and decision codes, not prompt text or credentials.
The TypeSafe request has an eight-second timeout. Pi has a thirty-second
timeout, and Claude Code and Codex have a sixty-second timeout. Each Herdr request has a three-second timeout.

A `script-unreadable` result means the command runs a local script that the
plugin could not read inside those directories, or that is too many or too large
to send for review. A `script-changed` result means the reviewed script no longer
matches the file on disk, so no key was sent. Both stay with a human.

An `unrecognized-or-changed-prompt` log entry includes a `detail` field.
`prompt-format-unrecognized` means the menu did not match a supported layout.
`pane-read-truncated` means Herdr omitted some text.
`output-changed-during-read` means the output changed during five reads in a row.
These entries occur before a TypeSafe call. Empty event logs are normal for state
changes that do not need permission review, such as an agent starting work.

## Development

```sh
npm test
npm run check
```

Tests use synthetic permission dialogs, mock TypeSafe and agent responses, and a
local mock Herdr socket. They do not send input to live agents. They cover policy
failures, agent routing, settings, harness commands, script review and script changes, hidden
content, secrets, duplicate events, conversation redraws, safe retries, claim migration, queued dialogs, agent changes,
Codex pager expansion, and an uncertain send result.
History tests cover private file modes, concurrent writes, credential hiding,
ordering, damaged records, bounded reads, and failures after a request is claimed.
Interface tests cover both lists, labels, row marks, approval and focus keys,
selection across refreshes, and narrow or short windows. Label tests cover
storage privacy, exact matching, hidden requests, damaged rows, and size limits.
Approval tests cover the claim, a changed request or agent, an uncertain send,
and a disabled plugin.

References: [Herdr plugins](https://herdr.dev/docs/plugins/),
[Herdr socket API](https://herdr.dev/docs/socket-api/),
[TypeSafe API](https://docs.typesafe.ai/api), and
[Pi CLI reference](https://pi.dev/docs/latest/cli).

## License

[MIT](LICENSE)
