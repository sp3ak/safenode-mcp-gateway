# Marketplace listing copy

For skill marketplaces such as Agensi. Upload `safenode-mcp-gateway.zip`, built from the
`safenode-mcp-gateway/` folder next to this file:

```bash
cd skill && zip -r safenode-mcp-gateway.zip safenode-mcp-gateway
```

**Price:** free. The skill brings people to the gateway and the hosted service; it isn't the
product being sold.

**Title:** SafeNode MCP Gateway: policy enforcement for every MCP tool call

**Short description:**
Put allow / warn / review / deny policy in front of your agent's MCP tools. A proxy, not a tool
the model can skip, so the agent cannot route around it.

**Long description:**
This skill sets up the open-source SafeNode MCP Gateway (MIT, `npx safenode-mcp-gateway`) and
teaches your agent how to behave when the gateway stops a call.

- Moves your existing MCP servers behind the gateway. The agent sees the same tools, but every
  `tools/call` is evaluated against your SafeNode policy before it reaches the server.
- Dry-runs first, so you see the exact payload that would leave your machine before anything is
  sent.
- Safe defaults: blocks calls when SafeNode is unreachable, and redacts payloads on your machine
  (emails, card numbers, API keys, tokens) before they are sent.
- Covers what the agent does next: report blocked or held-for-review actions to you, and never retry
  them through another tool.

Needs Node 18+ and a SafeNode API key (free tier at safenode.tech). Every gated call makes one
request to the SafeNode API. The gateway is not a sandbox and does not detect prompt injection.

**Tags / category:** security, MCP, guardrails, policy, agent safety, audit

**Works with:** Claude Code, Claude Desktop, Cursor, and any MCP host that uses an `mcpServers`
config.

**Links:** https://github.com/sp3ak/safenode-mcp-gateway · https://safenode.tech
