# Contributing

Thanks for looking. This is maintained by one person, so a few notes on what helps.

## Most useful contribution

**Enforcement gaps.** Any path where a tool call reaches a downstream server when policy said it
should not. That is the single guarantee this project makes, and a hole in it is the highest-value
bug you can file. See [SECURITY.md](SECURITY.md) — report those privately, not as an issue.

Second most useful: **compatibility reports**. "Server X does not work behind the gateway" with the
config and stderr output.

## Setup

```bash
npm install
npm test
```

```bash
npm run build && npm run typecheck
```

All must pass before a PR. CI runs the same on Node 18, 20 and 22.

## Trying it against a real MCP server

```bash
cp safenode-gateway.example.json safenode-gateway.json
# edit the filesystem path, then:
SAFENODE_API_KEY=sn_... node dist/index.js --dry-run
```

`--dry-run` needs no network and is the quickest way to check envelope changes.

## House rules

- **stdout is the JSON-RPC channel.** Never write to it. Every diagnostic goes to stderr via
  `logToStderr`. One stray byte on stdout corrupts the protocol for the host, and the failure looks
  nothing like its cause.
- **Keep the runtime dependency list at one.** The pitch is `npx` with nothing to install, and every
  dependency is cold-start latency a user pays before their agent can call a tool.
- **Redaction must stay identical to the Python SDK's.** Same rule names, same order, same
  behaviour. If you change one, change both — the same payload redacting differently depending on
  which client sent it is a bug that will take someone a very long day to find.
- **Never silently skip evaluation.** If a code path can forward without a decision, it needs a
  test proving it cannot happen by accident.
- **A failure in the gateway must not be silent.** Degraded decisions get logged and marked.
- Tests use fakes for both the evaluator and the downstream client. No live API calls, ever.

## Commit and PR style

Small PRs, one concern each. In the description, say what breaks if the change is wrong — that is
more useful than describing what it does.
