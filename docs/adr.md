# Architecture Decision Records

## ADR-001: Use node-pty for CLI agent sessions

Status: Accepted

Context: AI CLI agents expect a TTY, interactive input, control sequences and terminal behavior.

Decision: Use `node-pty` to spawn configured CLI commands.

Consequences:

- Positive: Real terminal behavior, supports xterm.js streaming.
- Negative: Native dependency may require Debian build tools.
- Risk: PTY process has OS user permissions.

## ADR-002: Use WebSocket for realtime terminal streaming

Status: Accepted

Context: Terminal output and input are bidirectional and latency-sensitive.

Decision: Use `ws` WebSocket server attached to Fastify's HTTP server.

Consequences:

- Positive: Simple bidirectional protocol.
- Negative: Requires reconnect handling.
- Risk: WS auth must be explicit.

## ADR-003: Use xterm.js for terminal UI

Status: Accepted

Context: Browser needs to display ANSI terminal output correctly.

Decision: Use `@xterm/xterm` and `@xterm/addon-fit`.

Consequences:

- Positive: Mature terminal rendering and keyboard support.
- Negative: Mobile keyboard behavior still depends on browser.
- Risk: Need custom quick actions for better mobile use.

## ADR-004: Server-side command config only

Status: Accepted

Context: Allowing client to send raw command would create command execution risk.

Decision: Client sends only `agentId`; backend maps it to configured `command` and `args`.

Consequences:

- Positive: Reduces arbitrary command execution surface.
- Negative: Adding a new agent requires server config change.
- Risk: Misconfigured server command can still be dangerous.

## ADR-005: Project allowlist

Status: Accepted

Context: User wants project selection but not arbitrary path entry.

Decision: Client selects only `projectId` from backend allowlist. Backend resolves and validates directories at startup.

Consequences:

- Positive: Prevents path traversal and accidental arbitrary cwd.
- Negative: New project requires env config update.
- Risk: CLI agent can still access files according to OS permissions after spawn.

## ADR-006: WebSocket ticket instead of auth token in URL

Status: Accepted

Context: Browser WebSocket cannot set arbitrary Authorization headers portably.

Decision: Authenticated API call issues a short-lived ticket. Client uses ticket in WebSocket URL.

Consequences:

- Positive: Avoids long-lived token in WS URL.
- Negative: Adds one API call before WS attach.
- Risk: Ticket leakage remains possible but limited by short TTL and one-time use.

