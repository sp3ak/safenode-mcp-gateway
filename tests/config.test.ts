import { describe, expect, it } from 'vitest';
import { buildConfig, ConfigError, resolveToolSettings } from '../src/config.js';

const MINIMAL = { apiKey: 'sn_test', servers: [{ name: 'fs', command: 'npx' }] };

describe('validation', () => {
  it('accepts a minimal config', () => {
    const config = buildConfig(MINIMAL, {});
    expect(config.servers).toHaveLength(1);
    expect(config.apiKey).toBe('sn_test');
  });

  it('requires an api key and says where to get one', () => {
    expect(() => buildConfig({ servers: MINIMAL.servers }, {})).toThrow(/SAFENODE_API_KEY/);
  });

  it('prefers the env var over the file, so no key need be committed', () => {
    const config = buildConfig(MINIMAL, { SAFENODE_API_KEY: 'sn_from_env' });
    expect(config.apiKey).toBe('sn_from_env');
  });

  it('requires at least one downstream server', () => {
    expect(() => buildConfig({ apiKey: 'k', servers: [] }, {})).toThrow(/non-empty array/);
  });

  it('rejects a server with no command', () => {
    expect(() => buildConfig({ apiKey: 'k', servers: [{ name: 'x' }] }, {})).toThrow(/command/);
  });

  it('rejects duplicate server names, which would make routing ambiguous', () => {
    expect(() =>
      buildConfig(
        { apiKey: 'k', servers: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] },
        {},
      ),
    ).toThrow(/Duplicate server name/);
  });

  it('rejects an unknown fail mode rather than silently defaulting', () => {
    expect(() => buildConfig({ ...MINIMAL, failMode: 'fail_sideways' }, {})).toThrow(ConfigError);
  });

  it('rejects an unknown payload mode', () => {
    expect(() => buildConfig({ ...MINIMAL, payloadMode: 'raw' }, {})).toThrow(ConfigError);
  });

  it('rejects a non-positive timeout', () => {
    expect(() => buildConfig({ ...MINIMAL, timeoutMs: 0 }, {})).toThrow(/positive/);
  });

  it('strips a trailing slash from the base url', () => {
    expect(buildConfig({ ...MINIMAL, baseUrl: 'https://x.test/' }, {}).baseUrl).toBe('https://x.test');
  });
});

describe('defaults', () => {
  it('defaults to fail_closed and redacted', () => {
    const config = buildConfig(MINIMAL, {});
    expect(config.failMode).toBe('fail_closed');
    expect(config.payloadMode).toBe('redacted');
  });

  it('defaults to no local log file', () => {
    expect(buildConfig(MINIMAL, {}).logFile).toBeNull();
  });
});

describe('override precedence', () => {
  const config = buildConfig(
    {
      apiKey: 'k',
      failMode: 'fail_closed',
      payloadMode: 'redacted',
      context: { env: 'prod' },
      servers: [{ name: 'fs', command: 'x', failMode: 'fail_open', context: { tier: 'a' } }],
      tools: { danger: { payloadMode: 'metadata_only', context: { tier: 'b' } } },
    },
    {},
  );
  const server = config.servers[0]!;

  it('server settings beat global', () => {
    expect(resolveToolSettings(config, 'read_file', server).failMode).toBe('fail_open');
  });

  it('tool settings beat server', () => {
    expect(resolveToolSettings(config, 'danger', server).payloadMode).toBe('metadata_only');
  });

  it('merges context global -> server -> tool, most specific winning', () => {
    expect(resolveToolSettings(config, 'danger', server).context).toEqual({
      env: 'prod',
      tier: 'b',
    });
  });

  it('falls back cleanly for a tool with no override', () => {
    const settings = resolveToolSettings(config, 'read_file', server);
    expect(settings.payloadMode).toBe('redacted');
    expect(settings.bypass).toBe(false);
    expect(settings.context).toEqual({ env: 'prod', tier: 'a' });
  });
});
