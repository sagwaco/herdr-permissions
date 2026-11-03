# Interface and settings

[Back to overview](../README.md)

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

## Settings

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
