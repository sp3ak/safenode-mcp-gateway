/**
 * End-to-end: a real MCP client speaking to a real gateway process, which spawns a real downstream
 * MCP server over stdio.
 *
 * The unit tests use fakes for both the evaluator and the downstream client, which means they
 * cannot catch anything in the actual wiring — transports, JSON-RPC framing, subprocess spawning,
 * or the CLI entry point. That gap is exactly where the `npx` invocation bug lived: the code was
 * correct and every unit test passed, but the binary produced no output at all.
 *
 * SafeNode itself is not reachable in CI, so these run with `failMode` set explicitly and assert on
 * the resulting degraded behaviour. That still exercises the whole real path.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const gatewayEntry = join(root, 'dist', 'index.js');
const echoServer = join(root, 'examples', 'echo-server.mjs');

function writeConfig(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sn-gw-'));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      apiKey: 'sn_e2e_not_a_real_key',
      // Unroutable host, so evaluation always fails fast and the fail mode is what gets tested.
      baseUrl: 'http://127.0.0.1:9',
      timeoutMs: 1500,
      servers: [{ name: 'echo', command: process.execPath, args: [echoServer] }],
      ...overrides,
    }),
    'utf8',
  );
  return path;
}

async function connectGateway(configPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [gatewayEntry, '--config', configPath],
    env: { ...(process.env as Record<string, string>), SAFENODE_API_KEY: 'sn_e2e_not_a_real_key' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'e2e-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

let open: Client | null = null;
afterEach(async () => {
  await open?.close().catch(() => {});
  open = null;
});

describe('end to end over real stdio transports', () => {
  it('exposes the downstream server tools through the proxy', async () => {
    open = await connectGateway(writeConfig({ failMode: 'fail_open' }));
    const listed = await open.listTools();

    expect(listed.tools.map((t) => t.name)).toContain('echo');
  }, 30000);

  it('forwards a call to the real downstream server when allowed', async () => {
    // fail_open + unreachable SafeNode means the gateway allows without evaluating, which is what
    // lets this assert the forwarding path without a live API.
    open = await connectGateway(writeConfig({ failMode: 'fail_open' }));
    const result = (await open.callTool({ name: 'echo', arguments: { text: 'hello' } })) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]!.text).toBe('echo: hello');
  }, 30000);

  it('blocks the call when fail-closed and SafeNode is unreachable', async () => {
    open = await connectGateway(writeConfig({ failMode: 'fail_closed' }));
    const result = (await open.callTool({ name: 'echo', arguments: { text: 'hello' } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    // The downstream server must not have run at all.
    expect(result.content[0]!.text).not.toContain('echo: hello');
    expect(result.content[0]!.text).toMatch(/Blocked by policy/i);
  }, 30000);

  it('a bypassed tool still reaches the downstream server under fail-closed', async () => {
    open = await connectGateway(
      writeConfig({ failMode: 'fail_closed', tools: { echo: { bypass: true } } }),
    );
    const result = (await open.callTool({ name: 'echo', arguments: { text: 'through' } })) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]!.text).toBe('echo: through');
  }, 30000);
});
