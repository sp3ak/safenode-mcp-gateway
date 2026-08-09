# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below 1.0.0, minor releases may change the config schema.

## [Unreleased]

## [0.1.1] - 2026-08-09

No functional change to the gateway itself. Released to verify that publishing works over OIDC
trusted publishing rather than a long-lived npm token.

### Changed

- Publishes via OIDC trusted publishing. No npm token exists to leak or rotate.
- The publish job runs Node 24 and pins `npm@latest`. Node 22 ships npm 10.9.x, which predates OIDC
  support (needs >= 11.5.1); without this the publish fails with an auth error that mentions
  nothing about versions.

### Fixed

- The version is now defined once in `src/version.ts` and read by the CLI banner, the User-Agent,
  and the MCP client identity. Previously it was duplicated across three files, so a release could
  ship reporting the wrong version. A test asserts it matches `package.json`.

## [0.1.0] - 2026-08-08

First release.

### Added

- stdio MCP proxy that forwards `tools/list` transparently and evaluates every `tools/call` against
  SafeNode before it reaches the downstream server. A denial means the call is never forwarded,
  which is enforcement the agent cannot route around.
- Multiple downstream servers behind one gateway. If two export the same tool name, every tool is
  prefixed `<server>__` and a warning is logged — silently picking a winner would apply one
  server's policy to another server's tool.
- Decision handling: `allow` forwards unchanged; `warn` forwards with a visible warning prepended;
  `review` and `deny` are not forwarded and return the reasons plus the `trace_id`.
- `failMode` (`fail_closed` default), `payloadMode`, `timeoutMs` and `context`, settable globally,
  per server, or per tool. Most specific wins. `bypass` skips evaluation for a named tool.
- Client-side redaction matching the Python SDK's ruleset exactly, with redaction counts reported
  in `context.safenode_redactions` so client-side scrubbing cannot silently disable the server-side
  `sensitive_data` rule.
- `metadata_only` payload mode: key structure preserved, every value hashed.
- `--dry-run` prints the exact evaluation envelope without making a network call.
- Local JSONL decision log, so there is a record even when the network is down. Degraded decisions
  are marked `degraded: true` with a null `traceId` and can never be mistaken for real ones.
- One downstream server failing to start no longer takes the gateway down; the rest stay protected.

### Notes

- Published as `safenode-mcp-gateway` (unscoped). The `@safenode` npm scope belongs to an unrelated
  project.
- No telemetry, no phone-home, no postinstall scripts.

[Unreleased]: https://github.com/sp3ak/safenode-mcp-gateway/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sp3ak/safenode-mcp-gateway/releases/tag/v0.1.1
[0.1.0]: https://github.com/sp3ak/safenode-mcp-gateway/releases/tag/v0.1.0
