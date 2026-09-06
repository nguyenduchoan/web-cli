# User Stories

## US-01: Authenticate before access

As a mobile developer  
I want to log in with a token  
So that only authorized users can access the controller

### Acceptance criteria

- Given I open the app without a token, when the app loads, then I see the login screen.
- Given I call an API without token, when the request reaches backend, then the backend returns 401.
- Given I open a WebSocket without a valid ticket, when upgrade is attempted, then the backend rejects it.
- Given I enter a valid token, when the token is verified, then I can access the control panel.

## US-02: Select configured agent and allowed project

As a mobile developer  
I want to choose an agent and project from server-provided lists  
So that I do not accidentally spawn arbitrary commands or unsafe paths

### Acceptance criteria

- Given I am authenticated, when the app loads, then I can see configured agents.
- Given I am authenticated, when the app loads, then I can see allowed projects.
- Given client sends unknown agentId, when creating session, then backend rejects it.
- Given client sends unknown projectId, when creating session, then backend rejects it.
- Given an allowlisted path no longer exists, when config loads, then backend excludes or fails validation clearly.

## US-03: Start and control PTY session

As a mobile developer  
I want to start a PTY-backed session for a selected agent  
So that I can interact with the real CLI agent

### Acceptance criteria

- Given selected agent and project are valid, when I press Start, then backend spawns the configured command in that project directory.
- Given session starts successfully, when I view status, then state is `running`.
- Given I press Kill, when process is running, then backend terminates it and state becomes `exited`.
- Given I press Restart, when a session exists, then backend kills old process if needed and starts a new one with the same agent/project.

## US-04: Stream terminal realtime

As a mobile developer  
I want terminal output to stream realtime to browser  
So that I can monitor the agent and respond quickly

### Acceptance criteria

- Given session is running, when PTY writes output, then browser displays it in xterm.js.
- Given browser sends input event, when backend validates it, then PTY receives the input.
- Given browser disconnects, when session keeps running, then backend does not kill process automatically.
- Given browser reconnects to session, when attach succeeds, then bounded buffered output is replayed.

## US-05: Use mobile quick actions

As a mobile developer  
I want large buttons for common actions  
So that I can respond to CLI prompts without typing special keys manually

### Acceptance criteria

- Given I press Enter, then frontend sends `\r`.
- Given I press Tab, then frontend sends `\t`.
- Given I press Ctrl+C, then frontend sends `\x03`.
- Given I press Ctrl+D, then frontend sends `\x04`.
- Given I press Arrow Up, then frontend sends `\x1b[A`.
- Given I press Arrow Down, then frontend sends `\x1b[B`.
- Given I press Yes, then frontend sends `y\r`.
- Given I press No, then frontend sends `n\r`.
- Given I press Yes to all, Skip, or Edit first, then frontend uses server-provided mapping or fallback mapping.

## Business rules

- Client never sends command to spawn.
- Backend only spawns agent command from config.
- Backend only spawns inside allowlisted project id.
- Auth is required for every `/api/*` route and WebSocket attach.
- Session output buffer is bounded.
- Terminal output is not logged by default.

## Error states

- Invalid token.
- Missing or invalid project.
- Missing or invalid agent.
- Spawn failed.
- WebSocket disconnected.
- Session exited.
- Unsupported WS event.

## Traceability

| Story | Acceptance Criteria | Test Cases |
| --- | --- | --- |
| US-01 | Auth required | TC-AUTH-01, TC-AUTH-02, TC-SEC-01 |
| US-02 | Agent/project allowlist | TC-AGENT-01, TC-PROJ-01, TC-SEC-02 |
| US-03 | Session lifecycle | TC-SESSION-01, TC-SESSION-02 |
| US-04 | WebSocket stream | TC-WS-01, TC-WS-02 |
| US-05 | Quick actions | TC-ACTION-01, TC-ACTION-02 |

