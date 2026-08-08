# Security Policy

## Reporting a vulnerability

Email **security@safenode.tech**. Please do not open a public issue.

Include the affected version, reproduction steps, and impact. If you have a `trace_id` from an
affected evaluation, include it.

Acknowledgement within 3 business days, assessment within 10. If a fix is warranted we will
coordinate disclosure timing with you, and credit you unless you prefer otherwise.

## Highest-value reports

**Anything that reaches a downstream MCP server when policy said it should not.** That is the one
guarantee this project makes. Specifically:

- A `deny` or `review` decision that still forwards the call
- A path through the proxy that skips evaluation without `bypass` being configured
- Tool-name routing that sends a call to a server other than the one whose policy was applied
- Sensitive values leaving the process in a mode that should have withheld them
- A degraded (SafeNode-unreachable) decision that is indistinguishable from a real one

## Supported versions

Pre-1.0, only the latest minor version receives fixes.

## Known limitations (not vulnerabilities)

Documented design boundaries. Discussion welcome; they are not treated as vulnerabilities:

- **`bypass: true` does exactly what it says.** A tool configured to bypass is forwarded with no
  policy check.
- **Redaction counts are self-reported.** They raise the floor for an honest client. A hostile
  client would not use this gateway at all.
- **Not a sandbox.** The gateway decides whether a call is forwarded. It does not contain the
  downstream server or limit what that server does once the call arrives. Scope your underlying
  servers narrowly regardless.
- **`fail_open`, where configured, allows unevaluated calls** when SafeNode is unreachable. That is
  the stated purpose of the setting. The default is `fail_closed`.
- **Downstream servers inherit the parent environment**, including credentials, as they would if
  the MCP host had spawned them directly.
- **`context` is never redacted**, in any payload mode. Do not put secrets in it.
- **The full envelope is stored server-side.** Assume anything sent is retained.
