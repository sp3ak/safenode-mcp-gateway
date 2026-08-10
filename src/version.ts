/**
 * Single source of truth for the gateway's version.
 *
 * Kept in its own module so the CLI banner, the User-Agent sent to SafeNode, and the MCP client
 * identity cannot drift from each other or from package.json. `tests/version.test.ts` asserts this
 * matches package.json, so a release that bumps one and forgets the others fails CI.
 */
export const VERSION = '0.1.2';
