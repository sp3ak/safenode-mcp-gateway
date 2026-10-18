# SafeNode MCP Gateway

An MCP proxy that enforces policy on every tool call. The agent cannot route around it.

```bash
npx safenode-mcp-gateway
```

## Why a proxy

An MCP server that exposes an `evaluate_action` tool is theatre. The model can choose not to call
it, which means it enforces nothing.

This is a **proxy**. It sits between your MCP client (Claude Desktop, Claude Code, Cursor, any MCP
host) and the MCP servers you already use. `tools/list` passes straight through, so the model sees
exactly the tools it saw before. Every `tools/call` is evaluated against SafeNode *first*. A denial
means the call never reaches the downstream server at all.

```
Claude Desktop ──► safenode-mcp-gateway ──► filesystem server
                          │                   github server
                          ▼                   postgres server
                    SafeNode API
                  allow/warn/review/deny
```

Your agent needs no code changes. It does not know the gateway is there.

[Get an API key — free tier, no card](https://safenode.tech) ·
[Docs](https://safenode.tech/docs) ·
[Python SDK](https://pypi.org/project/safenode-sdk/)

---

## Setup

### 1. Get an API key

Free at [safenode.tech](https://safenode.tech). Keys look like `sn_...`.

### 2. Write a config

`safenode-gateway.json` — take the servers straight out of your existing MCP client config:

```json
{
  "failMode": "fail_closed",
  "payloadMode": "redacted",
  "logFile": "./safenode-decisions.jsonl",
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
    }
  ],
  "tools": {
    "read_file": { "failMode": "fail_open" },
    "write_file": { "payloadMode": "metadata_only" }
  }
}
```

Do **not** put your API key in this file. Set `SAFENODE_API_KEY` in the environment — it takes
precedence over the config, so the file stays safe to commit.

### 3. See what would be sent, before sending anything

```bash
SAFENODE_API_KEY=sn_... npx safenode-mcp-gateway --dry-run
```

Prints the exact JSON body that an evaluation would POST. No network call. This is the fastest way
to satisfy yourself about what leaves your machine.

### 4. Point your MCP client at the gateway

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "safenode": {
      "command": "npx",
      "args": ["-y", "safenode-mcp-gateway", "--config", "/absolute/path/to/safenode-gateway.json"],
      "env": { "SAFENODE_API_KEY": "sn_..." }
    }
  }
}
```

**Claude Code** — `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "safenode": {
      "command": "npx",
      "args": ["-y", "safenode-mcp-gateway", "--config", "./safenode-gateway.json"],
      "env": { "SAFENODE_API_KEY": "sn_..." }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json`, same shape as Claude Desktop.

Replace your existing server entries with this one. The gateway spawns them itself, so listing them
in both places would run each server twice.

---

## What each decision does

| Decision | Behaviour |
| --- | --- |
| `allow` | Forwarded. The downstream result is returned unchanged. |
| `warn` | Forwarded, with a `[SafeNode warning]` line prepended so the model *and* the human see it. |
| `review` | **Not forwarded.** Returns a message saying approval is needed. |
| `deny` | **Not forwarded.** Returns the human-readable reasons and the `trace_id`. |

Denials come back as MCP tool *errors*, not transport failures, so the model sees why and can try
something else instead of the host surfacing an opaque crash.

## Fail behaviour

`failMode` decides what happens when SafeNode itself is unreachable.

| | |
| --- | --- |
| `fail_closed` **(default)** | Block the call. |
| `fail_open` | Forward it, unevaluated. |
| `raise` | Crash the gateway. |

**The gateway defaults to `fail_closed`, unlike the SafeNode SDKs, which default to `fail_open`.**
That difference is deliberate. An SDK wraps a developer's own code, where taking production down
during a SafeNode outage loses the user forever. The gateway fronts arbitrary MCP tools it knows
nothing about — filesystem writes, shell commands, payments — and silently letting all of that
through the moment SafeNode is unreachable defeats the point of installing it.

Loosen it per tool for the read-only ones:

```json
"tools": {
  "read_file":   { "failMode": "fail_open" },
  "list_files":  { "failMode": "fail_open" }
}
```

Degraded decisions are logged to stderr and marked `"degraded": true` with a null `traceId` in the
decision log, so they can never be counted as real policy decisions.

## What data leaves your machine

For every tool call, the gateway sends: the tool name, the downstream server name, a session id,
any static context from your config, and the **tool arguments** as the payload.

`payloadMode` controls the arguments:

| | |
| --- | --- |
| `full` | Sent verbatim. |
| `redacted` **(default)** | Scrubbed client-side first. |
| `metadata_only` | No values at all — key names and hashes only. |

Redaction covers emails, Luhn-validated credit cards, US SSNs, provider API key prefixes (`sk-`,
`ghp_`, `xoxb-`, `AKIA`, `AIza`), bearer tokens, and PEM private key blocks. Values become
`[REDACTED:<type>]`.

### Why redaction counts are always sent

Alongside the redacted payload, the gateway sends counts of what it removed:

```json
"safenode_redactions": { "email": 2, "credit_card": 1 }
```

This is load-bearing. SafeNode's server-side `sensitive_data` rule matches patterns against payload
*values*. If the gateway scrubbed those values and said nothing, a policy of "deny any action
containing a card number" would silently start passing — the client-side privacy feature would have
disabled the server-side security control. Reporting counts closes that: policy can act on the
*presence* of a card number without ever receiving one.

If you use `sensitive_data` with `patterns`, pair it with a `redaction_metadata` rule.

These counts are self-reported. They raise the floor for an honest client; they are not a defence
against a hostile one.

### No telemetry

The gateway talks to exactly two things: the downstream MCP servers you configured, and the SafeNode
API. No analytics, no phone-home, no postinstall scripts.

## Local decision log

Set `logFile` to get a JSONL record of every decision, independent of the server-side audit trail —
so you still have evidence of what your agent tried to do when the network was down:

```json
{"timestamp":"2026-08-08T04:12:09.412Z","server":"filesystem","tool":"write_file","decision":"deny","degraded":false,"traceId":"9f1c…","reasons":["Path is outside the approved workspace."],"forwarded":false,"durationMs":143,"sessionId":"a3f1…"}
```

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | — | Prefer `SAFENODE_API_KEY` in the environment |
| `baseUrl` | `https://safenode.tech` | For staging |
| `failMode` | `fail_closed` | `fail_closed` \| `fail_open` \| `raise` |
| `payloadMode` | `redacted` | `full` \| `redacted` \| `metadata_only` |
| `timeoutMs` | `5000` | Evaluation request budget |
| `logFile` | `null` | JSONL decision log path |
| `prefixTools` | `false` | Force `<server>__<tool>` naming |
| `servers[]` | required | Downstream MCP servers |
| `tools{}` | `{}` | Per-tool overrides |
| `context{}` | `{}` | Static context on every evaluation |

`failMode`, `payloadMode` and `context` can be set globally, per server, or per tool. Most specific
wins.

`tools.<name>.bypass: true` skips evaluation entirely for one tool. It does what it says — the call
is forwarded with no policy check at all.

### Tool name collisions

If two downstream servers export the same tool name, the gateway prefixes **every** tool with
`<server>__` and logs a warning. Silently picking a winner would apply one server's policy to
another server's tool, which is a security bug rather than a cosmetic one.

## What this is not

- **Not a sandbox.** It decides whether a call is forwarded. It does not contain the downstream
  server, restrict syscalls, or limit what that server can do once the call reaches it.
- **Not a prompt-injection detector.** It evaluates the *action*, not the reasoning that produced
  it. If your agent has been talked into deleting a table, this can stop the delete — it will not
  tell you the agent was manipulated.
- **Not offline.** Every tool call costs a round trip to the SafeNode API. There is no local policy
  evaluation.
- **Not a substitute for scoping the underlying servers.** Still pass a filesystem server the
  narrowest root directory that works.
- **Not free of side effects.** Every evaluation is recorded server-side and counts against your
  monthly quota.

## Latency

Each gated tool call adds one round trip to the SafeNode API, with a 5000ms budget by default.
Bypassed tools add nothing.

A measured p99 for the evaluate endpoint is not published yet, because it has not been measured
under realistic load. When it has been, it will go here and in the docs rather than being estimated.

## Docker

```bash
docker build -t safenode-mcp-gateway .
```

Running it with no arguments starts against a bundled demo config that proxies an included echo
server, so you can see the proxy work without any setup:

```bash
docker run -i --rm safenode-mcp-gateway
```

The demo key is a placeholder, so `tools/list` passes through while any real tool call is denied by
the `fail_closed` policy. For real use, mount your own config and supply a key:

```bash
docker run -i --rm \
  -e SAFENODE_API_KEY=sn_... \
  -v /path/to/safenode-gateway.json:/app/config.json \
  safenode-mcp-gateway --config /app/config.json
```

`-i` is required. MCP speaks JSON-RPC over stdio, so without stdin attached the gateway has nothing
to talk to.

## Agent skill

[`SKILL.md`](SKILL.md) teaches an agent to set
the gateway up for you, moving your existing servers behind it, and how to behave when a call is
blocked or held for review. Drop the folder into your agent's skills directory (for Claude Code,
`~/.claude/skills/safenode-mcp-gateway/`). The policy-authoring companion is in [`skill/safenode-policies/`](skill/safenode-policies/SKILL.md).

## Requirements

Node 18+. One runtime dependency: `@modelcontextprotocol/sdk`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports about enforcement gaps — anything that reaches a
downstream server when it should have been blocked — are the most valuable thing you can file.

## Security

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.

## License

MIT. See [LICENSE](LICENSE).
