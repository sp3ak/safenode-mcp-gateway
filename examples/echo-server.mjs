#!/usr/bin/env node
// Minimal downstream MCP server used to prove the gateway end to end without a network call.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'Echo back the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `echo: ${req.params.arguments?.text ?? ''}` }],
}));

await server.connect(new StdioServerTransport());
