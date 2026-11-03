# Supported prompts and troubleshooting

[Back to overview](../README.md)

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
manual. Claim files contain hashes. See [history storage](usage.md) for the stored request data.
Command logs contain pane IDs and decision codes, not prompt text or credentials.
The TypeSafe request has an eight-second timeout. Pi has a thirty-second
timeout, and Claude Code and Codex have a sixty-second timeout. Each Herdr request has a three-second timeout.

A `script-unreadable` result means the command runs a local script that the
plugin could not read within the temporary or project directories, or that
exceeds the [script review limits](policy.md). A `script-changed` result means the reviewed script no longer
matches the file on disk, so no key was sent. Both stay with a human.

An `unrecognized-or-changed-prompt` log entry includes a `detail` field.
`prompt-format-unrecognized` means the menu did not match a supported layout.
`pane-read-truncated` means Herdr omitted some text.
`output-changed-during-read` means the output changed during five reads in a row.
These entries occur before a TypeSafe call. Empty event logs are normal for state
changes that do not need permission review, such as an agent starting work.
