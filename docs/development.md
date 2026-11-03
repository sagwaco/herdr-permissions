# Development

[Back to overview](../README.md)

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
