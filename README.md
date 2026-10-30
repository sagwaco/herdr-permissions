# Permission Approver for Herdr

This plugin uses TypeSafe AI and Codex to approve one request at a time in
Claude Code and Codex. It reads the TypeSafe API key from the macOS Keychain service
`model-router-typesafe`. It has no package dependencies.

The policy approves ordinary development work when its effects are clear and the
agent can reverse them. It leaves catastrophic actions and changes that the agent
cannot reverse for a human. It never selects a permanent or session-wide grant.

## Setup

Requirements: macOS, Node.js 22 or later, Herdr 0.9.3 or later, and the existing
Keychain entry. Node and an authenticated Codex CLI 0.163.0 or later
must be on the Herdr server's PATH. The fallback uses the existing Codex login.

```sh
cd /Users/sang/Developer/herdr-permissions
npm test
herdr plugin link "$PWD"
herdr plugin action invoke sang.permissions.check
herdr plugin log list --plugin sang.permissions --limit 10
```

Linking enables the event hook for new permission prompts in all local Herdr
sessions. Add `--disabled` to link without activation. To activate a disabled link:

```sh
herdr plugin enable sang.permissions
```

The connection check sends one synthetic read-only request to TypeSafe. If the
score is below 0.80, it also calls Codex. It does not read a pane or approve an
agent request. Check the command log for
`"connected":true`. Standard TypeSafe API charges apply.

To review prompts that were already open before activation:

```sh
herdr plugin action invoke sang.permissions.review-pending
```

To stop automatic approvals:

```sh
herdr plugin disable sang.permissions
```

Use `herdr plugin unlink sang.permissions` to remove the registration. Source
files and plugin state remain on disk.

## Request history and approvals

Open the permission interface from a shell inside Herdr:

```sh
herdr plugin action invoke sang.permissions.history
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
herdr plugin pane open --plugin sang.permissions --entrypoint history --placement tab --focus
```

The interface records its pane in `pane.json` in the plugin state directory. The
file mode is 0600. The record is removed when the interface exits.

The pane has two lists. `1 Pending` lists agents that are waiting for permission
now. `2 History` lists processed requests with the newest first. Press `Tab` to
switch lists, and use the arrow keys or `j` and `k` to move. Page Up and Page Down
scroll, and Home and End jump. Press Enter to inspect a request and Escape to
return to the list. Press `r` to refresh or `q` to close. Both lists refresh every
two seconds and keep the selected row. If the socket is not available, the
interface shows history only.

Each history row shows a two-character mark, the processing time, result,
reviewer, and request summary. The first character is `*` when an agent still
waits for that exact request, otherwise a space. The second character is `+` for
a `should approve` label, `-` for a `should take no action` label, and `.` when
the request has no label. Pending rows show the pane, agent, and request.

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
  prompt, or whose text is clipped, cannot be approved with `a`. Use `f` for
  that pane.
- `f` moves focus to the pane that owns the request. An agent keeps its prompt,
  so you can answer it yourself. In a split or tab pane the interface stays open
  for your return. A popup, if you open one with `--placement popup`, closes. If
  Herdr does not accept the focus request, the interface reports the failure and
  stays open.
- `y` marks the request `should approve`, `n` marks it `should take no action`,
  and `u` clears the label.

History starts when this version is installed. It records supported requests
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
  directory. That request is approved once when it arrives. Jev and Codex are
  not called, and the Keychain is not read. The history reviewer is `user` and
  the detail is `user-precedent`. The directory is part of the key, because the
  same command text can be harmless in a scratch checkout and destructive in a
  project. A row without a usable directory, including one whose path was
  hidden, cannot receive this label.
- `should take no action` applies to the same request text in every directory.
  That request stays for a human. Jev and Codex are not called, and the result
  reason is `user-precedent-manual`. A no-action label wins over an approval
  label for the same request.
- The local checks still run first. A request that contains a recognizable
  credential (`sensitive-content`) or a human-only action stays with a human even
  when it has a `should approve` label. Changing the plugin to a disabled state
  also stops a labeled approval, and the final prompt check still applies.
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
  a backup and verifies the copied bytes, new Git worktrees on new local branches, read-only
  commands such as `tail`, `ps`, `rg`, and `gh pr view`, and local test or program
  runs such as `cargo test` and `cargo run`, also with GPU access. The same
  checks can pass in a disposable `docker run --rm` container with a local or
  project image and bind mounts of the project or a temporary directory. Scratch
  scripts that the agent writes to a temporary directory and then runs can pass.
  Containers with `--privileged`, host namespaces, the Docker socket, home or
  system mounts, or an unfamiliar remote image stay manual. Dry runs, such
  as `--dry-run`, `git clean -n`, and `rsync -n`, can pass when every other command
  in the request is also safe. The local push and publish rules still apply to
  dry runs.
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
- Jev approves requests with a valid approval probability of at least 0.80.
  Every valid score below 0.80 goes to Codex for a second review with the
  same policy. Codex must return a successful structured boolean approval.
  Codex decisions on borderline requests vary between runs, so a plain Codex
  rejection gets one more Codex review. Either approval approves the request
  once. A Codex error is not reviewed again.
- Missing credentials, network failures, malformed responses, uncertain decisions,
  hidden command text, and unknown prompt formats leave the prompt untouched.
  A TypeSafe failure does not call Codex. Codex errors or rejection leave the
  prompt for a human.

The plugin sends the visible permission request to `api.typesafe.ai`. This can
include paths, commands, and source code. It excludes preceding conversation text
and permission menu choices. The API key is sent only in the HTTPS authorization
header. Recognizable credentials in a prompt stop the request locally. That check
cannot identify every possible secret format.

For scores below 0.80, the plugin also sends the request to Codex through
the Codex CLI with `gpt-6-luna` and low reasoning effort. It does not send the
TypeSafe key or the Jev score to Codex. The CLI runs in an ephemeral read-only session, with command
execution, browser and computer access, app and plugin integrations, hooks, and
`config.toml` configuration disabled. Project instructions and skill instructions
are excluded. Codex still reads its global `AGENTS.md`; the review policy is
supplied as higher-priority developer instructions. The CLI runs without the
shared daemon, with session and history persistence disabled. A response that
contains a tool action is rejected. Standard Codex
usage limits and charges apply.

## Supported prompts and limits

Claude Code: command and file permission dialogs with the first `Yes` row selected.
Codex: command and edit dialogs with the first one-time approval row selected and
its letter shortcut visible. These layouts were checked against Claude Code
2.1.296 and Codex 0.162.1. Custom layouts can require an adapter update.

Questions, repository trust, screen-reader input menus, clipped previews, and
unsupported agents remain manual. OpenCode remains manual because its selection
uses color and its terminal dialog has no direct one-time approval shortcut.

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
Jev and Codex can make classification errors. This plugin reduces manual approvals;
it cannot guarantee that every irreversible action will reach a human.

An interrupted hook leaves its current request for a human. A new agent transition
gets a new lock. An identical queued dialog without a state change also stays
manual. Claim files contain hashes. History stores request text as described above.
Command logs contain pane IDs and decision codes, not prompt text or credentials.
The TypeSafe request has an eight-second timeout;
Codex has a thirty-second timeout. Each Herdr request has a three-second timeout.

An `unrecognized-or-changed-prompt` log entry now includes a `detail` field.
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

Tests use synthetic permission dialogs, mock TypeSafe and Codex responses, and a
local mock Herdr socket. They do not send input to live agents. They cover policy
failures, Codex routing and responses, hidden content, secrets, duplicate events,
conversation redraws, safe retries, claim migration, queued dialogs, agent changes,
and an uncertain send result.
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
[Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
