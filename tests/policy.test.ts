import { describe, expect, it } from 'vitest';
import { applyFailMode, buildEnvelope, DEGRADED_REASON, redact } from '../src/policy.js';

describe('redaction', () => {
  it('redacts an email', () => {
    const { data, counts } = redact({ to: 'alice@example.com' });
    expect(data).toEqual({ to: '[REDACTED:email]' });
    expect(counts).toEqual({ email: 1 });
  });

  it('redacts a Luhn-valid card', () => {
    const { data } = redact({ card: '4111111111111111' });
    expect(data.card).toBe('[REDACTED:credit_card]');
  });

  it('leaves a Luhn-invalid digit string alone', () => {
    // An order number that happens to be 16 digits must survive, or we corrupt real payloads.
    const { data, counts } = redact({ order: '1234567890123456' });
    expect(data.order).toBe('1234567890123456');
    expect(counts).toEqual({});
  });

  it.each([
    ['sk-abcdefghijklmnopqrstuvwx', 'api_key'],
    [`ghp_${'a'.repeat(36)}`, 'api_key'],
    ['AKIAIOSFODNN7EXAMPLE', 'api_key'],
    ['xoxb-123456789012-abcdefg', 'api_key'],
    ['123-45-6789', 'us_ssn'],
    ['555-867-5309', 'phone'],
    ['Bearer abcdefghijklmnop', 'bearer_token'],
  ])('redacts %s as %s', (secret, rule) => {
    const { data } = redact({ v: secret });
    expect(data.v).toBe(`[REDACTED:${rule}]`);
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redact({ k: pem }).data.k).toBe('[REDACTED:private_key]');
  });

  it('walks nested structures and counts every hit', () => {
    const { counts } = redact({ a: { b: [{ email: 'x@y.com' }, { email: 'p@q.com' }] } });
    expect(counts).toEqual({ email: 2 });
  });

  it('never redacts keys, only values', () => {
    // SafeNode's sensitive_data rule can match on key names; destroying them would disable it.
    const { data } = redact({ 'user@example.com': 'safe' });
    expect(Object.keys(data)).toEqual(['user@example.com']);
  });

  it('does not mutate the input', () => {
    const original = { to: 'a@b.com' };
    redact(original);
    expect(original.to).toBe('a@b.com');
  });

  it('terminates on a self-referencing object', () => {
    const node: Record<string, unknown> = {};
    node.self = node;
    expect(() => redact(node)).not.toThrow();
  });
});

describe('buildEnvelope', () => {
  it('sends values verbatim in full mode', () => {
    const body = buildEnvelope({
      actionType: 'mcp_tool_call',
      payload: { to: 'a@b.com' },
      context: {},
      payloadMode: 'full',
    });
    expect(body.payload).toEqual({ to: 'a@b.com' });
  });

  it('always reports payload mode and redaction counts', () => {
    // Load-bearing: without counts, client-side redaction silently disables the server's
    // sensitive_data rule.
    const body = buildEnvelope({
      actionType: 'mcp_tool_call',
      payload: { to: 'a@b.com' },
      context: {},
      payloadMode: 'redacted',
    });
    const ctx = body.context as Record<string, unknown>;
    expect(ctx.safenode_payload_mode).toBe('redacted');
    expect(ctx.safenode_redactions).toEqual({ email: 1 });
  });

  it('reports counts even in full mode, as an empty object', () => {
    const body = buildEnvelope({
      actionType: 'x',
      payload: { a: 1 },
      context: {},
      payloadMode: 'full',
    });
    expect((body.context as Record<string, unknown>).safenode_redactions).toEqual({});
  });

  it('sends no values at all in metadata_only mode', () => {
    const body = buildEnvelope({
      actionType: 'x',
      payload: { to: 'alice@example.com', secret: 'hunter2' },
      context: {},
      payloadMode: 'metadata_only',
    });
    const serialised = JSON.stringify(body.payload);
    expect(serialised).not.toContain('alice@example.com');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).toContain('sha256:');
  });

  it('preserves key names in metadata_only mode', () => {
    // Key-name policy rules must keep working when values are withheld.
    const body = buildEnvelope({
      actionType: 'x',
      payload: { ssn: '123-45-6789', nested: { card: '4111111111111111' } },
      context: {},
      payloadMode: 'metadata_only',
    });
    const payload = body.payload as Record<string, Record<string, unknown>>;
    expect(Object.keys(payload).sort()).toEqual(['nested', 'ssn']);
    expect(Object.keys(payload.nested!)).toEqual(['card']);
  });

  it('still reports redaction counts in metadata_only mode', () => {
    const body = buildEnvelope({
      actionType: 'x',
      payload: { to: 'a@b.com' },
      context: {},
      payloadMode: 'metadata_only',
    });
    expect((body.context as Record<string, unknown>).safenode_redactions).toEqual({ email: 1 });
  });

  it('never redacts context', () => {
    // Vendor, region and spend gating all read context; scrubbing it would break them.
    const body = buildEnvelope({
      actionType: 'x',
      payload: {},
      context: { vendor_id: 'sk-abcdefghijklmnopqrstuvwx' },
      payloadMode: 'redacted',
    });
    expect((body.context as Record<string, unknown>).vendor_id).toBe(
      'sk-abcdefghijklmnopqrstuvwx',
    );
  });
});

describe('applyFailMode', () => {
  it('fail_open synthesises an allow', () => {
    const result = applyFailMode('fail_open', new Error('boom'));
    expect(result.decision).toBe('allow');
    expect(result.degraded).toBe(true);
  });

  it('fail_closed synthesises a deny', () => {
    expect(applyFailMode('fail_closed', new Error('boom')).decision).toBe('deny');
  });

  it('raise rethrows', () => {
    expect(() => applyFailMode('raise', new Error('boom'))).toThrow('boom');
  });

  it('marks synthesised decisions three independent ways', () => {
    // Any one of these is enough to filter a degraded result out of policy reporting.
    const result = applyFailMode('fail_open', new Error('boom'));
    expect(result.degraded).toBe(true);
    expect(result.traceId).toBeNull();
    expect(result.reasons).toContain(DEGRADED_REASON);
  });
});
