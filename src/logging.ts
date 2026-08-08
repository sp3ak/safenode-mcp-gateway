/**
 * Local JSONL decision log.
 *
 * The server keeps the authoritative audit trail, but a local record means a user still has
 * evidence of what their agent tried to do when the network was down — which is exactly when a
 * degraded fail-open decision would otherwise be invisible.
 *
 * Everything here is best-effort. A gateway that crashes because a log file is unwritable is worse
 * than one that stops logging.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvaluationResult } from './types.js';

export interface DecisionLogEntry {
  timestamp: string;
  server: string;
  tool: string;
  decision: string;
  degraded: boolean;
  traceId: string | null;
  reasons: string[];
  forwarded: boolean;
  durationMs: number;
  sessionId: string;
}

/** stderr, never stdout — stdout is the MCP JSON-RPC channel and any stray byte corrupts it. */
export function logToStderr(message: string): void {
  process.stderr.write(`[safenode] ${message}\n`);
}

export class DecisionLog {
  private failed = false;

  constructor(private readonly path: string | null) {
    if (path) {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        // Directory creation failure surfaces on first write; nothing useful to do here.
      }
    }
  }

  record(entry: DecisionLogEntry): void {
    if (!this.path || this.failed) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      // Warn exactly once, then stay quiet — a broken log must not produce a line per tool call.
      this.failed = true;
      logToStderr(
        `Could not write the decision log at ${this.path} (${(error as Error).message}). ` +
          'Continuing without local logging; the server-side audit trail is unaffected.',
      );
    }
  }
}

export function buildLogEntry(params: {
  server: string;
  tool: string;
  result: EvaluationResult;
  forwarded: boolean;
  durationMs: number;
  sessionId: string;
}): DecisionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    server: params.server,
    tool: params.tool,
    decision: params.result.decision,
    degraded: params.result.degraded,
    traceId: params.result.traceId,
    reasons: params.result.reasons,
    forwarded: params.forwarded,
    durationMs: Math.round(params.durationMs),
    sessionId: params.sessionId,
  };
}
