# Frontend Spec

## Visual thesis

Một control panel mobile-first kiểu terminal cockpit: tối, tập trung, nhiều không gian cho terminal, các nút hành động lớn và rõ để thao tác nhanh bằng ngón tay.

## Information architecture

- Login screen
  - Token input
  - Login action
  - Error message
- Main controller
  - Header/status
  - Agent tabs
  - Project selector
  - Session controls
  - Terminal output
  - Confirm/action panel
  - Shortcut row
  - Bottom input

## Mobile layout

1. Header sticky ở trên cùng.
2. Agent tabs cuộn ngang nếu màn hình hẹp.
3. Project selector và session controls ngay dưới tabs.
4. Terminal chiếm phần lớn chiều cao còn lại.
5. Quick actions và shortcut row nằm gần đáy, có touch target lớn.
6. Bottom input cố định ở dưới trong vùng app, không che terminal quá mức.

## Component list

- `LoginScreen`
- `AgentTabs`
- `ProjectSelector`
- `SessionControls`
- `StatusBadge`
- `TerminalPane`
- `QuickActions`
- `CommandInput`
- `ErrorBanner`

## State list

- Unauthenticated
- Loading config
- Ready without session
- Starting session
- Running
- Exited
- Error
- WebSocket connected
- WebSocket disconnected

## Interaction flow

1. User enters token.
2. Frontend calls `/api/health`.
3. If valid, frontend loads agents and projects.
4. User selects agent/project.
5. User starts session.
6. Frontend requests WebSocket ticket.
7. Frontend opens WebSocket and attaches xterm.js.
8. User types in bottom input or xterm, or presses quick actions.
9. Frontend sends validated event payload to backend.

## Empty/loading/error states

- No projects: show message requiring `ALLOWED_PROJECT_DIRS`.
- No agents: show config error.
- Session not started: terminal area shows short operational hint.
- Spawn failed: show error banner and session state.
- WebSocket disconnected: show reconnect action by restarting attach.

## Accessibility notes

- Touch target minimum 44px height.
- Buttons have visible focus style.
- Status changes have text labels, not color only.
- Form inputs have labels.
- Terminal region has `aria-label`.
- Avoid tiny controls near viewport edge.

## Terminal interaction behavior

- xterm.js receives PTY output.
- xterm keyboard input sends `input` events to backend.
- Resize sends `resize` event with cols/rows.
- On attach, backend replays bounded output buffer.
- Terminal should not clear on transient WebSocket reconnect unless a new session starts.

## Quick action behavior

- Enter: `\r`
- Tab: `\t`
- Ctrl+C: `\x03`
- Ctrl+D: `\x04`
- Arrow Up: `\x1b[A`
- Arrow Down: `\x1b[B`
- Yes: `y\r`
- No: `n\r`
- Abort: `\x03`
- Yes to all, Skip, Edit first: server-provided mapping, fallback default.

## FE acceptance criteria

- UI usable at 360px width.
- Terminal occupies primary screen area.
- Buttons remain tappable on mobile.
- User can operate session without hardware keyboard.
- Error state is visible and actionable.
- No feature outside MVP appears in navigation.

