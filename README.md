# Permission manager for Herdr

A [Herdr](https://herdr.dev) plugin that reviews permission prompts from Claude
Code and Codex and approves routine, reversible development work one request at
a time. Requests that fail review remain open for a human. The plugin never
selects a permanent or session-wide permission grant.

## Install

Requires macOS, Node.js 22 or later, Herdr 0.9.3 or later, and an authenticated
reviewer CLI: Pi (the default), Claude Code, or Codex. Node.js and the reviewer
CLI must be on the Herdr server's `PATH`.

```sh
herdr plugin install sagwaco/herdr-permissions
herdr plugin action invoke check --plugin herdr-permissions
```

Installation enables automatic review of new permission prompts in all local
Herdr sessions. The connection check uses a synthetic request and does not
approve a live request. Standard reviewer usage limits and charges apply.

See [setup](docs/setup.md) for the optional TypeSafe API key, connection logs,
existing prompts, and removal instructions.

## Use

Open the interface to view pending requests, inspect history, approve a request
once, or change settings:

```sh
herdr plugin action invoke herdr-permissions
```

Use `1` for Pending, `2` for History, and `3` for Settings. Press Enter to inspect
a request or setting, and `q` to close the interface. Settings control the review
stages, reviewer CLI, model, and approval threshold. Labels let you reuse a
decision for an exact request.

See [interface and settings](docs/usage.md) for controls, labels, and history storage.

To stop automatic approvals:

```sh
herdr plugin disable herdr-permissions
```

## How review works

Requests pass through local credential and human-only action filters, saved
labels, optional TypeSafe Jev review, and an agent review. Jev requires a TypeSafe
API key. Without a key, requests that pass the filters and labels go to the agent
review. Each stage can be enabled or disabled in Settings.

By default, Git pushes, publishing, destructive operations without a recovery
path, and other human-only actions remain manual. Unknown prompt formats and
review errors also remain manual. Disabling filters changes these protections.

Enabled reviewers receive request text, which can include paths, commands, source
code, and the contents of local scripts. Local history stores request text.
Credential detection cannot identify every secret format.

Reviewers can make errors, and a prompt can change between the final check and
approval. The plugin cannot guarantee that every irreversible action reaches a
human. See the [review policy](docs/policy.md) and
[supported prompts and limitations](docs/limits.md) before enabling it.

## Development

Run `npm test` and `npm run check`. See [development](docs/development.md) for
test coverage and [setup](docs/setup.md) to link a local clone.

## License

[MIT](LICENSE)
