#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Everything diagnostic goes to stderr. stdout carries the MCP JSON-RPC stream, and a single stray
 * byte on it corrupts the protocol for the host.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfigFile } from './config.js';
import { Gateway } from './gateway.js';
import { logToStderr } from './logging.js';
import { buildEnvelope, SafeNodeEvaluator } from './policy.js';

export const VERSION = '0.1.0';

const USAGE = `safenode-mcp-gateway ${VERSION}

  MCP proxy that enforces SafeNode policy on every tool call.

Usage
  npx safenode-mcp-gateway [--config <path>]

Options
  --config <path>   Config file (default: ./safenode-gateway.json)
  --dry-run         Print the evaluation envelope for a sample call and exit.
                    Makes no network call. Use it to see exactly what would be sent.
  --version
  --help

Environment
  SAFENODE_API_KEY   API key. Takes precedence over the config file, so no key
                     has to be committed to disk.
  SAFENODE_BASE_URL  Override the API base URL.

Docs: https://safenode.tech/docs
`;

function parseArgs(argv: string[]): { config: string; dryRun: boolean } {
  let config = 'safenode-gateway.json';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stderr.write(USAGE);
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      process.stderr.write(`${VERSION}\n`);
      process.exit(0);
    } else if (arg === '--config' || arg === '-c') {
      const next = argv[++i];
      if (!next) {
        process.stderr.write('--config needs a path.\n');
        process.exit(2);
      }
      config = next;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return { config, dryRun };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { config: configPath, dryRun } = parseArgs(argv);

  let config;
  try {
    config = loadConfigFile(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nConfig error: ${error.message}\n\n`);
      process.exit(2);
    }
    throw error;
  }

  if (dryRun) {
    const envelope = buildEnvelope({
      actionType: 'mcp_tool_call',
      payload: { path: '/etc/passwd', note: 'contact alice@example.com' },
      context: {
        ...config.context,
        tool_name: 'read_file',
        server_name: config.servers[0]?.name ?? 'example',
        session_id: '00000000-0000-0000-0000-000000000000',
      },
      payloadMode: config.payloadMode,
    });
    process.stderr.write(
      `Sample envelope for payloadMode="${config.payloadMode}".\n` +
        'This is exactly what would be POSTed to /api/v1/evaluate. No request was made.\n\n',
    );
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  const gateway = new Gateway(config, {
    version: VERSION,
    evaluator: new SafeNodeEvaluator({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      payloadMode: config.payloadMode,
      version: VERSION,
    }),
  });

  await gateway.start();

  const server = new Server(
    { name: 'safenode-mcp-gateway', version: VERSION },
    { capabilities: { tools: {} } },
  );
  gateway.register(server);

  const shutdown = async (signal: string): Promise<void> => {
    logToStderr(`${signal} — shutting down`);
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  logToStderr(
    `ready — ${gateway.listTools().length} tools behind policy ` +
      `(failMode=${config.failMode}, payloadMode=${config.payloadMode})`,
  );
}

// Only auto-run as a CLI, so the module can be imported by tests without starting a server.
//
// pathToFileURL rather than string-building the URL: on Windows a hand-built `file://D:/...` has
// two slashes where Node's import.meta.url has three (`file:///D:/...`), so the comparison silently
// fails and the CLI does nothing at all — which breaks `npx safenode-mcp-gateway` completely.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`\nsafenode-mcp-gateway failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}

export { Gateway } from './gateway.js';
export { buildConfig, loadConfigFile } from './config.js';
export { buildEnvelope, redact, SafeNodeEvaluator } from './policy.js';
export type * from './types.js';
