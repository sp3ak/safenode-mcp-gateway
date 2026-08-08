# Examples

## `echo-server.mjs`

A minimal downstream MCP server with one `echo` tool. It exists so you can watch the gateway work
without wiring up a real server, and the end-to-end tests spawn it.

```bash
cat > /tmp/gw.json <<'EOF'
{
  "failMode": "fail_closed",
  "servers": [{ "name": "echo", "command": "node", "args": ["examples/echo-server.mjs"] }]
}
EOF

SAFENODE_API_KEY=sn_... node dist/index.js --config /tmp/gw.json
```

Point Claude Desktop or Claude Code at that and ask it to use the `echo` tool. Then set a policy in
the dashboard that denies `mcp_tool_call` and watch the call stop reaching the server.

## Seeing what leaves your machine

No key needed, no network call:

```bash
node dist/index.js --config /tmp/gw.json --dry-run
```

Run it once per `payloadMode` (`full`, `redacted`, `metadata_only`) to see the difference.

## Client configs

Ready-to-paste blocks for Claude Desktop, Claude Code, and Cursor are in the
[main README](../README.md#4-point-your-mcp-client-at-the-gateway).

The important part: **replace** your existing server entries with the gateway entry rather than
adding to them. The gateway spawns those servers itself, so leaving them in both places runs each
one twice.
