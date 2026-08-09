import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('version', () => {
  it('matches package.json', () => {
    // The version appears in the CLI banner, the User-Agent sent to SafeNode, and the MCP client
    // identity. All three read src/version.ts; this is the one place that could drift from the
    // published package, and the publish workflow will happily ship the mismatch.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
