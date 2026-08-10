import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
  mcpName: string;
};
const server = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8')) as {
  name: string;
  title: string;
  description: string;
  websiteUrl: string;
  version: string;
  repository: { url: string };
  packages: Array<{ identifier: string; version: string }>;
};

describe('version', () => {
  it('matches package.json', () => {
    // The version appears in the CLI banner, the User-Agent sent to SafeNode, and the MCP client
    // identity. All three read src/version.ts; this is the one place that could drift from the
    // published package, and the publish workflow will happily ship the mismatch.
    expect(VERSION).toBe(pkg.version);
  });
});

describe('MCP registry manifest', () => {
  // The registry cross-checks server.json against the published npm package. A mismatch fails the
  // release *after* npm has already published, which cannot be undone — so catch it here.
  it('server.json version matches package.json', () => {
    expect(server.version).toBe(pkg.version);
  });

  it('the npm package entry matches package.json', () => {
    expect(server.packages[0]?.version).toBe(pkg.version);
    expect(server.packages[0]?.identifier).toBe('safenode-mcp-gateway');
  });

  it('mcpName matches the registry server name', () => {
    // This is the ownership check: the registry reads mcpName from the published npm package and
    // requires it to equal the name being claimed.
    expect(pkg.mcpName).toBe(server.name);
  });

  it('claims a namespace we can actually authenticate for', () => {
    // GitHub OIDC auth only permits io.github.<owner>/*.
    expect(server.name.startsWith('io.github.sp3ak/')).toBe(true);
  });
});

describe('MCP registry schema limits', () => {
  // These mirror server.schema.json. The registry only enforces them at publish time, which is
  // after npm has already published and cannot be undone — a 145-character description cost a
  // release once. Check them here, where failing is free.
  it('description is within 100 characters', () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('title is within 100 characters', () => {
    expect(server.title.length).toBeGreaterThan(0);
    expect(server.title.length).toBeLessThanOrEqual(100);
  });

  it('name is within 200 characters and matches the required pattern', () => {
    expect(server.name.length).toBeLessThanOrEqual(200);
    expect(server.name.length).toBeGreaterThanOrEqual(3);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  });

  it('urls are absolute', () => {
    expect(() => new URL(server.websiteUrl)).not.toThrow();
    expect(() => new URL(server.repository.url)).not.toThrow();
  });
});
