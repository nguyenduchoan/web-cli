# Test Cases

## Auth

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-AUTH-01 | Health is public | Call exactly `/api/health` without `Authorization` | 200 and `ok: true` |
| TC-AUTH-02 | Private API rejects missing token | Call `/api/agents` without `Authorization` | 401 |
| TC-AUTH-03 | Private API accepts valid token | Call `/api/agents` with bearer token | 200 |
| TC-AUTH-04 | Health-prefix bypass is closed | Call `/api/health/private` without token | 401 |
| TC-AUTH-05 | Login screen handles invalid token | Enter wrong token in UI | Error message, no controller access |

## Agent selection

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-AGENT-01 | List agents | Call `/api/agents` | Returns configured agent ids and labels, no raw command needed from client |
| TC-AGENT-02 | Unknown agent rejected | POST session with invalid `agentId` | 404 `unknown_agent` |

## Project allowlist

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-PROJ-01 | List projects | Call `/api/projects` | Returns allowlisted projects |
| TC-PROJ-02 | Unknown project rejected | POST session with invalid `projectId` | 404 `unknown_project` |
| TC-PROJ-03 | Raw path not accepted | POST session with arbitrary `projectPath` only | Validation/unknown project, no spawn |

## Session lifecycle

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-SESSION-01 | Start session | Select valid agent/project and Start | Session state running or error if command missing |
| TC-SESSION-02 | Kill session | Press Kill on running session | Process exits, state exited |
| TC-SESSION-03 | Restart session | Press Restart | New session id returned and attaches |
| TC-SESSION-04 | Command not found | Configure invalid command and start | Session state error, visible UI error/state |
| TC-SESSION-05 | Capacity bound | Create more than `MAX_SESSIONS` active sessions | 429 `session_capacity_reached` |
| TC-SESSION-06 | Idle cleanup | Leave a running PTY inactive past its TTL | Session is stopped |

## WebSocket streaming

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-WS-01 | Attach with ticket | Start session, frontend requests ticket | WS opens and receives state |
| TC-WS-02 | Reject missing ticket | Open WS without ticket | Upgrade rejected |
| TC-WS-03 | Send input | Type in bottom input | CLI receives text plus Enter |
| TC-WS-04 | Resize | Resize browser | Backend receives resize payload and PTY resizes |
| TC-WS-05 | Disconnect | Close browser tab | PTY remains only until killed, exit or idle timeout |
| TC-WS-06 | Origin enforcement | Upgrade from an origin outside same-origin/allowlist | 403 |
| TC-WS-07 | Ticket replay | Reuse a consumed ticket | 401 |
| TC-WS-08 | Backpressure | Let client outbound buffer exceed configured cap | Socket closes with retry-later semantics |

## Quick actions

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-ACTION-01 | Enter button | Press Enter | Sends `\r` |
| TC-ACTION-02 | Tab button | Press Tab | Sends `\t` |
| TC-ACTION-03 | Ctrl+C button | Press Ctrl+C | Sends `\x03` |
| TC-ACTION-04 | Ctrl+D button | Press Ctrl+D | Sends `\x04` |
| TC-ACTION-05 | Arrow buttons | Press up/down | Sends `\x1b[A` or `\x1b[B` |
| TC-ACTION-06 | Confirm buttons | Press Yes/No/Abort | Sends configured sequences |

## Mobile UI

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-MOBILE-01 | 360px viewport | Open devtools mobile width 360 | No text overlap, controls tappable |
| TC-MOBILE-02 | Phone browser | Open from phone in LAN | Login, select, start, quick actions usable |
| TC-MOBILE-03 | Keyboard input | Focus bottom input and send | Input does not hide all controls |

## Security negative cases

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-SEC-01 | Unauthorized WS | WS without ticket | Rejected |
| TC-SEC-02 | Raw command injection | Try to send `command` in POST body | Ignored/rejected, server uses config only |
| TC-SEC-03 | Unsupported WS event | Send `{ "type": "spawnRawCommand" }` | Error event, no spawn |
| TC-SEC-04 | Token logging | Inspect server logs after requests | Token not logged |
| TC-SEC-05 | Output buffer bound | Produce large output | Server memory buffer capped by `OUTPUT_BUFFER_LIMIT` |
| TC-SEC-06 | Child environment isolation | Print child env from a test PTY | Controller token/config absent; allowlisted value present |
| TC-SEC-07 | Connection/input limits | Flood connections or WS input | Capacity/rate policy closes or rejects excess traffic |

## Error handling

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| TC-ERR-01 | Missing project config | Start with empty allowlist | UI shows no projects and Start disabled |
| TC-ERR-02 | Invalid `.env` project | Set nonexistent path | Server fails clearly on startup |
| TC-ERR-03 | Backend down | Stop backend while UI open | UI shows API/WS error |
