/**
 * Talks to the SafeNode evaluate API.
 *
 * Self-contained rather than depending on the JS SDK: the gateway's whole pitch is
 * `npx safenode-mcp-gateway` with nothing to install, so every dependency is cold-start latency a
 * user pays before their agent can call a single tool. The surface used here is small — one POST
 * and a redactor — and the behaviour it must match is pinned by the tests.
 */

import { createHash } from 'node:crypto';
import type { Decision, EvaluationResult, FailMode, PayloadMode, PolicyEvaluator } from './types.js';

/** Marker on every locally-synthesised decision. Must never collide with a server reason. */
export const DEGRADED_REASON = 'safenode_unavailable';

interface RedactionRule {
  name: string;
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Ordered most-specific first, matching the Python SDK's ruleset exactly. Divergence between the
 * two would mean the same payload redacts differently depending on which client sent it.
 */
const RULES: RedactionRule[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },
  {
    name: 'api_key',
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|sn_[A-Za-z0-9]{16,})\b/g,
  },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: 'email', pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'credit_card', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhnValid },
  { name: 'us_ssn', pattern: /\b(?!000|666|9\d\d)\d{3}-\d{2}-\d{4}\b/g },
  {
    name: 'phone',
    pattern: /(?<![\w-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?![\w-])/g,
  },
];

const MAX_DEPTH = 64;

function scrubString(text: string, counts: Record<string, number>): string {
  let out = text;
  for (const rule of RULES) {
    let hits = 0;
    out = out.replace(rule.pattern, (match) => {
      if (rule.validate && !rule.validate(match)) return match;
      hits++;
      return `[REDACTED:${rule.name}]`;
    });
    if (hits > 0) counts[rule.name] = (counts[rule.name] ?? 0) + hits;
  }
  return out;
}

function walk(node: unknown, counts: Record<string, number>, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[REDACTED:truncated]';
  if (typeof node === 'string') return scrubString(node, counts);
  if (Array.isArray(node)) return node.map((item) => walk(item, counts, depth + 1));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    // Keys are never redacted — SafeNode's sensitive_data rule can match on key names, and
    // destroying them would disable it.
    for (const [key, value] of Object.entries(node)) {
      out[key] = walk(value, counts, depth + 1);
    }
    return out;
  }
  return node;
}

export function redact(payload: Record<string, unknown>): {
  data: Record<string, unknown>;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const data = walk(payload, counts, 0) as Record<string, unknown>;
  return { data, counts };
}

function hashTree(node: unknown, salt: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return 'sha256:truncated';
  if (Array.isArray(node)) return node.map((item) => hashTree(item, salt, depth + 1));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    // Key structure is preserved on purpose: key-name policy rules must keep working.
    for (const [key, value] of Object.entries(node)) out[key] = hashTree(value, salt, depth + 1);
    return out;
  }
  const digest = createHash('sha256').update(salt + JSON.stringify(node ?? null)).digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}

/**
 * Build the request body. Exported so `--dry-run` can show exactly what would be sent without
 * sending it.
 */
export function buildEnvelope(input: {
  actionType: string;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
  payloadMode: PayloadMode;
  hashSalt?: string;
}): Record<string, unknown> {
  let outPayload: unknown;
  let counts: Record<string, number> = {};

  if (input.payloadMode === 'full') {
    outPayload = input.payload;
  } else if (input.payloadMode === 'redacted') {
    const report = redact(input.payload);
    outPayload = report.data;
    counts = report.counts;
  } else {
    // Count what *would* have been redacted so policy keeps the same signal, then send hashes.
    counts = redact(input.payload).counts;
    outPayload = hashTree(input.payload, input.hashSalt ?? '');
  }

  return {
    action_type: input.actionType,
    payload: outPayload,
    // Context is never redacted: vendor, region and spend rules all depend on it.
    context: {
      ...input.context,
      safenode_payload_mode: input.payloadMode,
      safenode_redactions: counts,
    },
  };
}

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly used?: number,
    readonly cap?: number,
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SafeNodeClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  payloadMode: PayloadMode;
  version: string;
}

/** Live evaluator that calls the SafeNode API. */
export class SafeNodeEvaluator implements PolicyEvaluator {
  constructor(private readonly options: SafeNodeClientOptions) {}

  async evaluate(input: {
    actionType: string;
    payload: Record<string, unknown>;
    context: Record<string, unknown>;
    payloadMode?: PayloadMode;
  }): Promise<EvaluationResult> {
    const body = buildEnvelope({
      actionType: input.actionType,
      payload: input.payload,
      context: input.context,
      payloadMode: input.payloadMode ?? this.options.payloadMode,
    });

    const response = await fetch(`${this.options.baseUrl}/api/v1/evaluate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `safenode-mcp-gateway/${this.options.version}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (response.status === 401) {
      throw new AuthError('SafeNode rejected the API key (401). Check SAFENODE_API_KEY.');
    }

    if (response.status === 429) {
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      // Two unrelated conditions share this status. Only throttling is retryable; quota
      // exhaustion stays failing until the next billing month, so it must not be retried.
      if ('evaluations_cap' in payload) {
        throw new QuotaExceededError(
          String(payload.message ?? 'Monthly evaluation limit reached.'),
          payload.evaluations_used as number | undefined,
          payload.evaluations_cap as number | undefined,
        );
      }
      throw new Error(`SafeNode rate limit reached (429). ${String(payload.message ?? '')}`.trim());
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`SafeNode returned HTTP ${response.status}. ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      decision: (data.decision as Decision) ?? 'deny',
      reasons: Array.isArray(data.reasons) ? data.reasons.map(String) : [],
      traceId: typeof data.trace_id === 'string' ? data.trace_id : null,
      degraded: false,
      impactScore: typeof data.impact_score === 'number' ? data.impact_score : undefined,
      riskScore: typeof data.risk_score === 'number' ? data.risk_score : undefined,
      alternatives: Array.isArray(data.alternatives)
        ? (data.alternatives as Array<Record<string, unknown>>).map((a) => ({
            type: String(a.type ?? 'general'),
            description: String(a.description ?? ''),
          }))
        : [],
    };
  }
}

/**
 * Apply the configured fail mode to an evaluation error.
 *
 * Synthesised decisions are marked three independent ways — `degraded: true`, `traceId: null`, and
 * the `safenode_unavailable` reason — so they can never be mistaken for a real policy decision in
 * the log or the audit trail.
 */
export function applyFailMode(failMode: FailMode, error: unknown): EvaluationResult {
  if (failMode === 'raise') throw error;
  return {
    decision: failMode === 'fail_open' ? 'allow' : 'deny',
    reasons: [DEGRADED_REASON, error instanceof Error ? error.message : String(error)],
    traceId: null,
    degraded: true,
  };
}
