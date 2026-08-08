/**
 * Config loading and validation.
 *
 * Everything is validated up front and fails loudly at startup. A policy gateway that boots with a
 * broken config and silently forwards everything is worse than one that refuses to start.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  DownstreamServerConfig,
  FailMode,
  GatewayConfig,
  PayloadMode,
  ToolOverride,
} from './types.js';

const FAIL_MODES: FailMode[] = ['fail_open', 'fail_closed', 'raise'];
const PAYLOAD_MODES: PayloadMode[] = ['full', 'redacted', 'metadata_only'];

export class ConfigError extends Error {}

const DEFAULTS = {
  baseUrl: 'https://safenode.tech',
  /**
   * Writes default to fail-closed, unlike the SDKs.
   *
   * The SDK defaults to fail-open because it wraps a developer's own code, and taking their
   * production down during a SafeNode outage loses the user forever. The gateway is different: it
   * exists specifically to stop an agent doing something it should not, and it sits in front of
   * arbitrary MCP tools it knows nothing about — filesystem writes, shell commands, payments.
   * Silently letting all of that through the moment SafeNode is unreachable defeats the point of
   * installing it. Override per server or per tool for read-only ones.
   */
  failMode: 'fail_closed' as FailMode,
  payloadMode: 'redacted' as PayloadMode,
  /** Generous relative to the SDK's 2s: an MCP tool call is already interactive-latency. */
  timeoutMs: 5000,
  reviewTimeoutMs: 0,
};

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: T[],
  path: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ConfigError(`${path} must be one of ${allowed.join(', ')} — got ${JSON.stringify(value)}.`);
  }
  return value as T;
}

function parseServer(raw: unknown, index: number): DownstreamServerConfig {
  const server = asRecord(raw, `servers[${index}]`);

  const name = server.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ConfigError(`servers[${index}].name is required and must be a non-empty string.`);
  }

  const command = server.command;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ConfigError(`servers[${index}].command is required (the executable to spawn).`);
  }

  if (server.args !== undefined && !Array.isArray(server.args)) {
    throw new ConfigError(`servers[${index}].args must be an array of strings.`);
  }

  return {
    name,
    command,
    args: (server.args as string[] | undefined)?.map(String),
    env: server.env ? (asRecord(server.env, `servers[${index}].env`) as Record<string, string>) : undefined,
    cwd: typeof server.cwd === 'string' ? server.cwd : undefined,
    failMode: optionalEnum(server.failMode, FAIL_MODES, `servers[${index}].failMode`),
    payloadMode: optionalEnum(server.payloadMode, PAYLOAD_MODES, `servers[${index}].payloadMode`),
    context: server.context ? asRecord(server.context, `servers[${index}].context`) : undefined,
  };
}

function parseToolOverrides(raw: unknown): Record<string, ToolOverride> {
  if (raw === undefined) return {};
  const tools = asRecord(raw, 'tools');
  const out: Record<string, ToolOverride> = {};

  for (const [toolName, value] of Object.entries(tools)) {
    const override = asRecord(value, `tools["${toolName}"]`);
    if (override.bypass !== undefined && typeof override.bypass !== 'boolean') {
      throw new ConfigError(`tools["${toolName}"].bypass must be a boolean.`);
    }
    out[toolName] = {
      failMode: optionalEnum(override.failMode, FAIL_MODES, `tools["${toolName}"].failMode`),
      payloadMode: optionalEnum(override.payloadMode, PAYLOAD_MODES, `tools["${toolName}"].payloadMode`),
      bypass: override.bypass === true,
      context: override.context ? asRecord(override.context, `tools["${toolName}"].context`) : undefined,
    };
  }
  return out;
}

/**
 * Build a validated config from an already-parsed object.
 *
 * `env` is injected rather than read from the global so this is testable without mutating
 * process.env.
 */
export function buildConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const root = asRecord(raw, 'config');

  // The env var wins over the file, so a key never has to be committed to disk.
  const apiKey = env.SAFENODE_API_KEY ?? (typeof root.apiKey === 'string' ? root.apiKey : '');
  if (!apiKey) {
    throw new ConfigError(
      'No API key. Set SAFENODE_API_KEY in the environment (preferred), or "apiKey" in the config file.\n' +
        'Create one at https://safenode.tech — free tier, no card.',
    );
  }

  const serversRaw = root.servers;
  if (!Array.isArray(serversRaw) || serversRaw.length === 0) {
    throw new ConfigError('"servers" must be a non-empty array of downstream MCP servers to proxy.');
  }
  const servers = serversRaw.map(parseServer);

  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.name)) {
      throw new ConfigError(`Duplicate server name "${server.name}". Names must be unique.`);
    }
    seen.add(server.name);
  }

  const timeoutMs = root.timeoutMs === undefined ? DEFAULTS.timeoutMs : Number(root.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError('"timeoutMs" must be a positive number.');
  }

  const reviewTimeoutMs =
    root.reviewTimeoutMs === undefined ? DEFAULTS.reviewTimeoutMs : Number(root.reviewTimeoutMs);
  if (!Number.isFinite(reviewTimeoutMs) || reviewTimeoutMs < 0) {
    throw new ConfigError('"reviewTimeoutMs" must be zero or a positive number.');
  }

  return {
    apiKey,
    baseUrl: (typeof root.baseUrl === 'string' ? root.baseUrl : env.SAFENODE_BASE_URL ?? DEFAULTS.baseUrl).replace(
      /\/+$/,
      '',
    ),
    failMode: optionalEnum(root.failMode, FAIL_MODES, 'failMode') ?? DEFAULTS.failMode,
    payloadMode: optionalEnum(root.payloadMode, PAYLOAD_MODES, 'payloadMode') ?? DEFAULTS.payloadMode,
    timeoutMs,
    servers,
    tools: parseToolOverrides(root.tools),
    context: root.context ? asRecord(root.context, 'context') : {},
    logFile: typeof root.logFile === 'string' && root.logFile !== '' ? root.logFile : null,
    prefixTools: root.prefixTools === true,
    reviewTimeoutMs,
  };
}

export function loadConfigFile(path: string, env?: Record<string, string | undefined>): GatewayConfig {
  const absolute = resolve(path);
  let contents: string;
  try {
    contents = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `Could not read config file at ${absolute}: ${(error as Error).message}\n` +
        'Pass --config <path>, or create safenode-gateway.json in the working directory.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new ConfigError(`${absolute} is not valid JSON: ${(error as Error).message}`);
  }

  return buildConfig(parsed, env);
}

/** Resolve the effective settings for one tool, applying tool > server > global precedence. */
export function resolveToolSettings(
  config: GatewayConfig,
  toolName: string,
  server: DownstreamServerConfig,
): { failMode: FailMode; payloadMode: PayloadMode; bypass: boolean; context: Record<string, unknown> } {
  const override = config.tools[toolName] ?? {};
  return {
    failMode: override.failMode ?? server.failMode ?? config.failMode,
    payloadMode: override.payloadMode ?? server.payloadMode ?? config.payloadMode,
    bypass: override.bypass === true,
    context: { ...config.context, ...(server.context ?? {}), ...(override.context ?? {}) },
  };
}
