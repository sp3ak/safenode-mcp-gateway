import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import type { EvaluationResult, GatewayConfig, PolicyEvaluator } from '../src/types.js';

/** A downstream server that records what it was asked to run. */
function fakeDownstream(tools: string[], onCall?: (name: string) => unknown) {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const client = {
    callTool: vi.fn(async (params: { name: string; arguments: unknown }) => {
      calls.push(params);
      return onCall?.(params.name) ?? { content: [{ type: 'text', text: `ran ${params.name}` }] };
    }),
    close: vi.fn(async () => {}),
  };
  return {
    calls,
    client,
    tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
  };
}

function evaluatorReturning(result: Partial<EvaluationResult>): PolicyEvaluator {
  return {
    evaluate: vi.fn(async () => ({
      decision: 'allow',
      reasons: [],
      traceId: 'trace-1',
      degraded: false,
      ...result,
    })) as PolicyEvaluator['evaluate'],
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): GatewayConfig {
  return buildConfig(
    {
      apiKey: 'sn_test',
      servers: [{ name: 'fs', command: 'noop' }],
      ...overrides,
    },
    {},
  );
}

describe('tool routing', () => {
  it('exposes downstream tools transparently when there is no collision', async () => {
    const down = fakeDownstream(['read_file', 'write_file']);
    const gateway = new Gateway(makeConfig(), {
      version: 't',
      evaluator: evaluatorReturning({}),
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();

    expect(gateway.listTools().map((t) => t.name).sort()).toEqual(['read_file', 'write_file']);
  });

  it('prefixes every tool when two servers export the same name', async () => {
    // Routing the wrong server's policy to a tool would be a security bug, not just a bug.
    const a = fakeDownstream(['read_file']);
    const b = fakeDownstream(['read_file']);
    const config = makeConfig({
      servers: [
        { name: 'alpha', command: 'noop' },
        { name: 'beta', command: 'noop' },
      ],
    });
    const gateway = new Gateway(config, {
      version: 't',
      evaluator: evaluatorReturning({}),
      connect: async (server) =>
        server.name === 'alpha'
          ? { client: a.client as never, tools: a.tools }
          : { client: b.client as never, tools: b.tools },
    });
    await gateway.start();

    expect(gateway.listTools().map((t) => t.name).sort()).toEqual([
      'alpha__read_file',
      'beta__read_file',
    ]);
  });

  it('routes a prefixed call to the owning server under its original name', async () => {
    const a = fakeDownstream(['read_file']);
    const b = fakeDownstream(['read_file']);
    const config = makeConfig({
      servers: [
        { name: 'alpha', command: 'noop' },
        { name: 'beta', command: 'noop' },
      ],
    });
    const gateway = new Gateway(config, {
      version: 't',
      evaluator: evaluatorReturning({ decision: 'allow' }),
      connect: async (server) =>
        server.name === 'alpha'
          ? { client: a.client as never, tools: a.tools }
          : { client: b.client as never, tools: b.tools },
    });
    await gateway.start();

    await gateway.callTool('beta__read_file', { path: '/tmp/x' });

    expect(a.calls).toHaveLength(0);
    expect(b.calls).toEqual([{ name: 'read_file', arguments: { path: '/tmp/x' } }]);
  });

  it('returns an error for an unknown tool instead of throwing', async () => {
    const down = fakeDownstream(['read_file']);
    const gateway = new Gateway(makeConfig(), {
      version: 't',
      evaluator: evaluatorReturning({}),
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();

    const result = (await gateway.callTool('nope', {})) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});

describe('enforcement', () => {
  let down: ReturnType<typeof fakeDownstream>;

  beforeEach(() => {
    down = fakeDownstream(['read_file']);
  });

  async function gatewayWith(result: Partial<EvaluationResult>, config = makeConfig()) {
    const gateway = new Gateway(config, {
      version: 't',
      evaluator: evaluatorReturning(result),
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();
    return gateway;
  }

  it('allow forwards and returns the downstream result untouched', async () => {
    const gateway = await gatewayWith({ decision: 'allow' });
    const result = await gateway.callTool('read_file', { path: '/x' });

    expect(down.calls).toHaveLength(1);
    expect(result).toEqual({ content: [{ type: 'text', text: 'ran read_file' }] });
  });

  it('deny does NOT forward — this is the whole point of the proxy', async () => {
    const gateway = await gatewayWith({ decision: 'deny', reasons: ['no shell access'] });
    const result = (await gateway.callTool('read_file', { path: '/etc/passwd' })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };

    expect(down.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no shell access');
  });

  it('a denial surfaces the trace id so a human can look it up later', async () => {
    const gateway = await gatewayWith({ decision: 'deny', reasons: ['nope'], traceId: 'abc-123' });
    const result = (await gateway.callTool('read_file', {})) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('abc-123');
  });

  it('review does not forward and explains that approval is needed', async () => {
    const gateway = await gatewayWith({ decision: 'review', reasons: ['needs approval'] });
    const result = (await gateway.callTool('read_file', {})) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };

    expect(down.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/review|approv/i);
  });

  it('warn forwards but prepends a visible warning', async () => {
    const gateway = await gatewayWith({ decision: 'warn', reasons: ['unusual path'] });
    const result = (await gateway.callTool('read_file', {})) as {
      content: Array<{ text: string }>;
    };

    expect(down.calls).toHaveLength(1);
    expect(result.content[0]!.text).toContain('SafeNode warning');
    expect(result.content[0]!.text).toContain('unusual path');
    // The downstream payload must survive underneath the banner.
    expect(result.content[1]!.text).toBe('ran read_file');
  });

  it('bypassed tools skip evaluation entirely', async () => {
    const evaluator = evaluatorReturning({ decision: 'deny' });
    const config = makeConfig({ tools: { read_file: { bypass: true } } });
    const gateway = new Gateway(config, {
      version: 't',
      evaluator,
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();

    await gateway.callTool('read_file', {});

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(down.calls).toHaveLength(1);
  });
});

describe('fail modes', () => {
  function explodingEvaluator(): PolicyEvaluator {
    return { evaluate: vi.fn(async () => { throw new Error('network down'); }) };
  }

  async function gatewayFailing(failMode: string) {
    const down = fakeDownstream(['read_file']);
    const gateway = new Gateway(makeConfig({ failMode }), {
      version: 't',
      evaluator: explodingEvaluator(),
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();
    return { gateway, down };
  }

  it('defaults to fail_closed, unlike the SDK', async () => {
    // The gateway fronts arbitrary tools it knows nothing about; letting everything through the
    // moment SafeNode is unreachable would defeat the point of installing it.
    expect(makeConfig().failMode).toBe('fail_closed');
  });

  it('fail_closed blocks the call when SafeNode is unreachable', async () => {
    const { gateway, down } = await gatewayFailing('fail_closed');
    const result = (await gateway.callTool('read_file', {})) as { isError: boolean };

    expect(down.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  it('fail_open forwards when SafeNode is unreachable', async () => {
    const { gateway, down } = await gatewayFailing('fail_open');
    await gateway.callTool('read_file', {});
    expect(down.calls).toHaveLength(1);
  });

  it('a per-tool override beats the global fail mode', async () => {
    const down = fakeDownstream(['read_file']);
    const config = makeConfig({
      failMode: 'fail_closed',
      tools: { read_file: { failMode: 'fail_open' } },
    });
    const gateway = new Gateway(config, {
      version: 't',
      evaluator: explodingEvaluator(),
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();

    await gateway.callTool('read_file', {});
    expect(down.calls).toHaveLength(1);
  });
});

describe('resilience', () => {
  it('survives one downstream server failing to start', async () => {
    const good = fakeDownstream(['ok_tool']);
    const config = makeConfig({
      servers: [
        { name: 'broken', command: 'noop' },
        { name: 'good', command: 'noop' },
      ],
    });
    const gateway = new Gateway(config, {
      version: 't',
      evaluator: evaluatorReturning({}),
      connect: async (server) => {
        if (server.name === 'broken') throw new Error('spawn failed');
        return { client: good.client as never, tools: good.tools };
      },
    });

    await gateway.start();
    expect(gateway.listTools().map((t) => t.name)).toEqual(['ok_tool']);
  });

  it('refuses to start when no downstream server comes up', async () => {
    const gateway = new Gateway(makeConfig(), {
      version: 't',
      evaluator: evaluatorReturning({}),
      connect: async () => { throw new Error('nope'); },
    });

    await expect(gateway.start()).rejects.toThrow(/No downstream MCP servers/);
  });

  it('turns a downstream tool failure into an error result, not a crash', async () => {
    const down = fakeDownstream(['read_file']);
    down.client.callTool = vi.fn(async () => { throw new Error('disk on fire'); });
    const gateway = new Gateway(makeConfig(), {
      version: 't',
      evaluator: evaluatorReturning({ decision: 'allow' }),
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();

    const result = (await gateway.callTool('read_file', {})) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('disk on fire');
  });
});

describe('evaluation envelope', () => {
  it('sends the tool arguments as payload and identifies the tool and server', async () => {
    const down = fakeDownstream(['read_file']);
    const evaluator = evaluatorReturning({ decision: 'allow' });
    const gateway = new Gateway(makeConfig(), {
      version: 't',
      evaluator,
      connect: async () => ({ client: down.client as never, tools: down.tools }),
    });
    await gateway.start();

    await gateway.callTool('read_file', { path: '/etc/passwd' });

    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'mcp_tool_call',
        payload: { path: '/etc/passwd' },
        context: expect.objectContaining({ tool_name: 'read_file', server_name: 'fs' }),
      }),
    );
  });
});
