/** Shared types for the gateway. */

/** The four decisions the SafeNode API can return. Closed set. */
export type Decision = 'allow' | 'warn' | 'review' | 'deny';

/** What the gateway does when SafeNode itself cannot be reached. */
export type FailMode = 'fail_open' | 'fail_closed' | 'raise';

/** How much of the tool arguments leave the machine. */
export type PayloadMode = 'full' | 'redacted' | 'metadata_only';

/**
 * The subset of a SafeNode evaluation the gateway actually uses.
 *
 * Deliberately a local interface rather than a direct import: it lets the policy layer be tested
 * against a fake, and keeps the gateway from breaking if the SDK adds fields.
 */
export interface EvaluationResult {
  decision: Decision;
  reasons: string[];
  traceId: string | null;
  /** True when SafeNode was unreachable and this decision was synthesised locally. */
  degraded: boolean;
  impactScore?: number;
  riskScore?: number;
  alternatives?: Array<{ type: string; description: string }>;
}

/** What the gateway asks of a policy backend. One method, so it is trivial to fake in tests. */
export interface PolicyEvaluator {
  evaluate(input: {
    actionType: string;
    payload: Record<string, unknown>;
    context: Record<string, unknown>;
  }): Promise<EvaluationResult>;
}

/** A downstream MCP server the gateway proxies to. */
export interface DownstreamServerConfig {
  /** Identifier used in logs, policy context, and tool prefixes. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Overrides for tools served by this server. */
  failMode?: FailMode;
  payloadMode?: PayloadMode;
  /** Extra context merged into every evaluation for this server's tools. */
  context?: Record<string, unknown>;
}

/** Per-tool overrides, keyed by tool name. */
export interface ToolOverride {
  failMode?: FailMode;
  payloadMode?: PayloadMode;
  /** Skip evaluation entirely for this tool. Use sparingly and knowingly. */
  bypass?: boolean;
  context?: Record<string, unknown>;
}

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  failMode: FailMode;
  payloadMode: PayloadMode;
  timeoutMs: number;
  servers: DownstreamServerConfig[];
  tools: Record<string, ToolOverride>;
  context: Record<string, unknown>;
  /** Path to a JSONL decision log. Null disables local logging. */
  logFile: string | null;
  /**
   * Prefix aggregated tool names with `<server>__`. Off by default so the proxy is transparent;
   * turned on automatically when two downstream servers export the same tool name.
   */
  prefixTools: boolean;
  /** How long to wait for a `review` decision to be resolved before giving up. 0 disables polling. */
  reviewTimeoutMs: number;
}
