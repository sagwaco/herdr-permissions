# Setup

[Back to overview](../README.md)

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
