/**
 * The proxy.
 *
 * Sits between an MCP client (Claude Desktop, Claude Code, Cursor, …) and one or more downstream
 * MCP servers. `tools/list` is forwarded transparently; every `tools/call` is evaluated against
 * SafeNode *before* it reaches the downstream server.
 *
 * Why a proxy rather than an `evaluate_action` tool: a tool the model can choose not to call
 * enforces nothing. Here a denial means the call never reaches the downstream server at all, which
 * is enforcement the agent cannot route around.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { resolveToolSettings } from './config.js';
import { buildLogEntry, DecisionLog, logToStderr } from './logging.js';
import { applyFailMode } from './policy.js';
import type {
  DownstreamServerConfig,
  EvaluationResult,
  GatewayConfig,
  PolicyEvaluator,
} from './types.js';

interface DownstreamConnection {
  config: DownstreamServerConfig;
  client: Client;
  tools: Tool[];
}

/** Maps an exposed tool name back to the downstream server that owns it. */
interface ToolRoute {
  connection: DownstreamConnection;
  /** The name the downstream server knows, which differs from the exposed one when prefixing. */
  downstreamName: string;
}

export interface GatewayDeps {
  evaluator: PolicyEvaluator;
  version: string;
  /** Injectable for tests; production spawns real subprocesses. */
  connect?: (config: DownstreamServerConfig) => Promise<{ client: Client; tools: Tool[] }>;
}

export class Gateway {
  private readonly connections: DownstreamConnection[] = [];
  private readonly routes = new Map<string, ToolRoute>();
  private readonly log: DecisionLog;
  private readonly sessionId = randomUUID();

  constructor(
    private readonly config: GatewayConfig,
    private readonly deps: GatewayDeps,
  ) {
    this.log = new DecisionLog(config.logFile);
  }

  /** Spawn and initialise every downstream server, then build the tool routing table. */
  async start(): Promise<void> {
    for (const serverConfig of this.config.servers) {
      const connect = this.deps.connect ?? defaultConnect;
      try {
        const { client, tools } = await connect(serverConfig);
        this.connections.push({ config: serverConfig, client, tools });
        logToStderr(`connected to "${serverConfig.name}" (${tools.length} tools)`);
      } catch (error) {
        // One broken downstream server must not take the whole gateway down — the others are
        // still worth protecting.
        logToStderr(
          `FAILED to connect to "${serverConfig.name}": ${(error as Error).message}. ` +
            'Its tools will not be available.',
        );
      }
    }

    if (this.connections.length === 0) {
      throw new Error('No downstream MCP servers could be started. Check the "servers" config.');
    }

    this.buildRoutes();
  }

  /**
   * Build the exposed tool list.
   *
   * Collisions are the interesting case: two servers can legitimately both export `read_file`, and
   * silently routing to whichever connected first would be a security bug, not just a bug — the
   * user's policy for one server would be applied to the other's tool. So a collision forces
   * prefixing for everything, which is visible and correct, rather than picking a winner.
   */
  private buildRoutes(): void {
    const counts = new Map<string, number>();
    for (const connection of this.connections) {
      for (const tool of connection.tools) {
        counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
      }
    }

    const collisions = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    const prefix = this.config.prefixTools || collisions.length > 0;

    if (collisions.length > 0) {
      logToStderr(
        `tool name collision across servers (${collisions.join(', ')}) — ` +
          'prefixing all tools with "<server>__" so each call routes to the right server.',
      );
    }

    for (const connection of this.connections) {
      for (const tool of connection.tools) {
        const exposed = prefix ? `${connection.config.name}__${tool.name}` : tool.name;
        this.routes.set(exposed, { connection, downstreamName: tool.name });
      }
    }
  }

  /** The aggregated tool list, with names rewritten if prefixing is active. */
  listTools(): Tool[] {
    const tools: Tool[] = [];
    for (const [exposed, route] of this.routes) {
      const original = route.connection.tools.find((t) => t.name === route.downstreamName);
      if (original) tools.push({ ...original, name: exposed });
    }
    return tools;
  }

  /**
   * Evaluate, then forward or block.
   *
   * Returns an MCP tool result. Denials are returned as `isError` results rather than thrown
   * protocol errors so the model *sees* the reason and can adapt, instead of the host surfacing an
   * opaque transport failure.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const route = this.routes.get(name);
    if (!route) {
      return errorResult(`Unknown tool "${name}". It is not exported by any configured server.`);
    }

    const settings = resolveToolSettings(this.config, name, route.connection.config);

    if (settings.bypass) {
      logToStderr(`"${name}" bypasses policy by config`);
      return this.forward(route, args);
    }

    const started = Date.now();
    let result: EvaluationResult;
    try {
      result = await this.deps.evaluator.evaluate({
        actionType: 'mcp_tool_call',
        payload: args,
        context: {
          ...settings.context,
          tool_name: route.downstreamName,
          exposed_tool_name: name,
          server_name: route.connection.config.name,
          session_id: this.sessionId,
        },
      });
    } catch (error) {
      // `raise` rethrows here and takes the gateway down deliberately.
      result = applyFailMode(settings.failMode, error);
    }
    const durationMs = Date.now() - started;

    const forwarded = result.decision === 'allow' || result.decision === 'warn';
    this.log.record(
      buildLogEntry({
        server: route.connection.config.name,
        tool: name,
        result,
        forwarded,
        durationMs,
        sessionId: this.sessionId,
      }),
    );

    if (result.degraded) {
      logToStderr(
        `SafeNode unreachable — "${name}" ${forwarded ? 'ALLOWED' : 'BLOCKED'} by the ` +
          `${settings.failMode} policy, without evaluation.`,
      );
    }

    switch (result.decision) {
      case 'allow':
        return this.forward(route, args);

      case 'warn': {
        // Forward, but make the warning visible to both the model and the human reading the
        // transcript. A warning nobody sees is not a warning.
        const downstream = await this.forward(route, args);
        return prependWarning(downstream, result);
      }

      case 'review':
        return errorResult(
          `Held for human review.\n\n${formatReasons(result)}\n\n` +
            'This action needs approval before it can run. Ask the user to approve it in the ' +
            'SafeNode dashboard, then try again.',
        );

      case 'deny':
      default:
        return errorResult(`Blocked by policy.\n\n${formatReasons(result)}`);
    }
  }

  private async forward(route: ToolRoute, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await route.connection.client.callTool({
        name: route.downstreamName,
        arguments: args,
      });
    } catch (error) {
      return errorResult(
        `The "${route.connection.config.name}" server failed to run "${route.downstreamName}": ` +
          `${(error as Error).message}`,
      );
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.client.close()));
  }

  /** Wire this gateway into an MCP Server instance. */
  register(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return (await this.callTool(request.params.name, args)) as never;
    });
  }
}

async function defaultConnect(
  config: DownstreamServerConfig,
): Promise<{ client: Client; tools: Tool[] }> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    // Inherit the parent environment so downstream servers keep their own credentials, with
    // config-supplied vars layered on top.
    env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    cwd: config.cwd,
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'safenode-mcp-gateway', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  const listed = await client.listTools();
  return { client, tools: listed.tools };
}

function formatReasons(result: EvaluationResult): string {
  const lines: string[] = [];
  if (result.reasons.length > 0) {
    lines.push(result.reasons.map((r) => `- ${r}`).join('\n'));
  } else {
    lines.push('- No reason was supplied by the policy.');
  }
  if (result.alternatives?.length) {
    lines.push('', 'Suggestions:', ...result.alternatives.map((a) => `- ${a.description}`));
  }
  // The trace id is the join key to the dashboard's Decision Feed, so it belongs in anything a
  // human might have to explain later.
  lines.push('', result.traceId ? `trace: ${result.traceId}` : 'trace: none (SafeNode unreachable)');
  return lines.join('\n');
}

function errorResult(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: true };
}

function prependWarning(downstream: unknown, result: EvaluationResult): unknown {
  const banner = `[SafeNode warning] ${result.reasons.join('; ') || 'flagged by policy'}${
    result.traceId ? ` (trace ${result.traceId})` : ''
  }`;

  if (
    downstream !== null &&
    typeof downstream === 'object' &&
    Array.isArray((downstream as { content?: unknown }).content)
  ) {
    const record = downstream as { content: unknown[] };
    return { ...record, content: [{ type: 'text', text: banner }, ...record.content] };
  }
  return { content: [{ type: 'text', text: banner }] };
}
