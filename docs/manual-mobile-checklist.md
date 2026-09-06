# Manual Mobile Checklist

## Setup

- [ ] Phone and Debian machine are on the same VPN or use a private HTTPS proxy.
- [ ] Backend remains on `HOST=127.0.0.1`.
- [ ] Private URL is protected by VPN/Access and has valid HTTPS.
- [ ] `CLIENT_ORIGIN` includes a separate frontend origin only when needed.
- [ ] `AUTH_TOKEN` is set and not shared.
- [ ] At least one project exists in `ALLOWED_PROJECT_DIRS`.

## Login

- [ ] Open the configured private HTTPS URL.
- [ ] Login screen appears.
- [ ] Wrong token is rejected.
- [ ] Correct token opens controller.

## Agent/project selection

- [ ] Agent tabs visible and tappable.
- [ ] Project selector shows only allowlisted directories.
- [ ] No free-form path input exists.

## Session control

- [ ] Start creates session.
- [ ] Status changes to running or shows clear spawn error.
- [ ] Kill terminates running session.
- [ ] Restart creates a fresh session.

## Terminal

- [ ] Terminal output is readable on phone.
- [ ] Terminal scroll works.
- [ ] Bottom input sends text to agent.
- [ ] Browser rotation or resize does not break terminal.

## Quick actions

- [ ] Enter works.
- [ ] Tab works.
- [ ] Ctrl+C interrupts.
- [ ] Ctrl+D sends EOF.
- [ ] Arrow Up/Down navigate history or menu where supported.
- [ ] Yes/No buttons send expected input.
- [ ] Abort sends Ctrl+C.

## Error states

- [ ] Stop backend and confirm UI shows disconnected/error.
- [ ] Reopen app and confirm token can be re-used.
- [ ] Start agent command not installed and confirm error is visible.

## Security

- [ ] Exact `/api/health` without token returns 200.
- [ ] Private API such as `/api/agents` without token returns 401.
- [ ] WebSocket cannot attach without ticket.
- [ ] Server logs do not print auth token.
- [ ] Terminal output is not logged by default.
- [ ] App is not exposed directly to public internet.
