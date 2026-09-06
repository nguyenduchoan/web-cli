# Test Plan

## Scope

Test Web CLI private service trên Debian, gồm build, runtime cô lập và cấu hình
triển khai production.

## In scope

- Auth.
- Agent selection.
- Project allowlist.
- Session lifecycle.
- WebSocket streaming.
- Quick actions.
- Mobile UI.
- Security negative cases.
- Error handling.
- Resource limits, child environment isolation and graceful shutdown.
- Nginx/systemd deployment smoke checks.

## Out of scope

- Multi-user.
- RBAC.
- Full IDE/file explorer.
- Exact prompt parsing for every CLI.

## Test strategy

Risk-based testing:

- Security controls first: auth, no raw command, allowlist.
- Session correctness: start, stream, input, kill, restart.
- Mobile usability: button size, layout, input.
- Error handling: missing config, command not found, disconnected WebSocket.

## Test environment

- Debian machine with Node.js and npm.
- Runtime env configured with `AUTH_TOKEN` and `ALLOWED_PROJECT_DIRS`.
- At least one installed CLI agent.
- Browser desktop and phone browser in LAN/VPN.

## Entry criteria

- Dependencies installed.
- Backend and frontend dev servers start.
- At least one allowlisted project exists.

## Exit criteria

- Must-have test cases pass or have documented exception.
- No blocker security control missing.
- Automated tests/check/build/audit and deployment smoke test pass.
- Live systemd/Nginx verification passes before final production sign-off.

## Regression scope

- Auth middleware.
- Config loader.
- Project validation.
- Session manager.
- WebSocket protocol.
- Terminal input/output.
- Quick action mapping.
- Child env allowlist, session capacity/idle cleanup and shutdown.
- WebSocket Origin, one-time ticket, payload/rate/backpressure limits.
- Public artifact allowlist and Nginx forbidden paths.

## Definition of Done validation

- Backend has auth.
- Backend validates allowlist.
- Backend does not accept raw command.
- WebSocket streams PTY output.
- Frontend sends quick action mapping.
- UI is mobile-first.
- README and `.env.example` exist.
- Security review and QA artifacts exist.
- No hard-coded secret.
