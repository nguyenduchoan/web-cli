# Solution Design

## Architecture overview

The app is a private web controller with a TypeScript backend and React frontend.

```text
Mobile Browser
  |
  | HTTPS/HTTP in LAN or VPN
  v
React + Vite Web UI
  |
  | REST API with Bearer token
  | WebSocket with short-lived ticket
  v
Fastify Backend
  |
  | node-pty spawn from server-side config
  v
Configured Codex/OpenCode/terminal CLI
  |
  v
Allowlisted Project Directory
```

## Folder structure

```text
server/
  src/
    config.ts
    auth.ts
    errors.ts
    sessionManager.ts
    websocket.ts
    index.ts
web/
  src/
    components/
    lib/
    App.tsx
    main.tsx
    index.css
docs/
```

## Config design

Environment variables:

- `AUTH_TOKEN`: required token for API access.
- `HOST`: backend bind host, default `127.0.0.1`.
- `PORT`: backend port, default `3001`.
- `CLIENT_ORIGIN`: allowed CORS origin, default Vite dev origin.
- `ALLOWED_PROJECT_DIRS`: comma-separated absolute project directories.
- `AGENTS_CONFIG_JSON`: optional JSON array overriding default agent command config.
- `OUTPUT_BUFFER_LIMIT`: bounded terminal output buffer size.
- `LOG_TERMINAL_OUTPUT`: default `false`.
- `MAX_SESSIONS`, `SESSION_IDLE_TTL_MS`, `SESSION_RETENTION_MS`: lifecycle limits.
- `MAX_WS_CONNECTIONS`, `MAX_WS_BUFFERED_BYTES`: WebSocket capacity/backpressure limits.
- `AGENT_ENV_ALLOWLIST`: the only parent environment names inherited by PTY children.

Agent config shape:

```json
{
  "id": "claude",
  "label": "Claude Code",
  "command": "claude",
  "args": [],
  "quickActions": {
    "yesAll": "a\r",
    "skip": "s\r",
    "editFirst": "e\r"
  }
}
```

## REST API

- `GET /api/health`
- `GET /api/agents`
- `GET /api/projects`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/kill`
- `POST /api/sessions/:id/restart`
- `POST /api/sessions/:id/ws-ticket`

`/api/health` is intentionally public for local health checks. Every other
`/api/*` route requires `Authorization: Bearer <AUTH_TOKEN>`.

## WebSocket protocol

Path:

```text
/api/sessions/:id/ws?ticket=<short-lived-ticket>
```

Client to server:

```json
{ "type": "input", "data": "text or key sequence" }
{ "type": "resize", "cols": 100, "rows": 30 }
{ "type": "ping", "nonce": "optional" }
```

Server to client:

```json
{ "type": "output", "data": "terminal data" }
{ "type": "state", "session": {} }
{ "type": "error", "message": "..." }
{ "type": "exit", "exitCode": 0, "signal": null }
{ "type": "pong", "ts": 1234567890 }
```

Unsupported event types are rejected. There is no `spawnRawCommand`.

## PTY session lifecycle

```text
create session -> spawn PTY -> running -> output/input streaming
                              -> exit -> exited
                              -> kill -> exited
                              -> spawn error -> error
```

Session fields:

- `id`
- `agentId`
- `projectId`
- `state`
- `createdAt`
- `updatedAt`
- `exitCode`
- `signal`
- `error`

## Error handling

- Validation errors return 400.
- Unauthorized returns 401.
- Unknown agent/project/session returns 404.
- PTY spawn failure returns session `error`.
- WS invalid ticket rejects upgrade.
- WS invalid payload returns `error` event and keeps connection open if possible.

## Observability/logging

- Log session create, start, exit, kill, restart.
- Do not log auth token.
- Do not log terminal output by default.
- If output logging is enabled later, warn that terminal content may contain secret.

## Local development flow

1. Configure `.env` from `.env.example`.
2. Install dependencies with npm workspaces.
3. Run backend dev server.
4. Run Vite web dev server.
5. Open web UI from desktop or mobile browser in LAN.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Arbitrary command execution | Only spawn server-configured agent command |
| Path traversal | Client sends projectId, server maps to resolved allowlist path |
| Token exposure | `sessionStorage`, redacted Bearer header, one-time short-lived WS ticket |
| Secret in terminal output | Bounded memory buffer, no output logging by default |
| Long-running process leak | Session cap, idle timeout, kill endpoint and graceful shutdown |
| Parent secret inheritance | Explicit child environment allowlist |
| Slow WebSocket client | Buffered-byte cap and connection close with backpressure |
| Public exposure | Loopback bind; require VPN/Access or another private authenticated layer |
