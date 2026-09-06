# Product Requirements Document: Agent CLI Web Controller

## 1. Overview

Agent CLI Web Controller là web app mobile-first cho phép người dùng điều khiển các AI CLI agents đã cài sẵn trên Debian thông qua browser mobile. Ứng dụng không thay thế Claude Code, Gemini CLI, Codex CLI hoặc OpenCode CLI, mà tạo một control panel tối ưu cho thao tác trên điện thoại.

## 2. Problem statement

Terminal mobile không tối ưu cho AI coding agents vì các thao tác xác nhận, phím điều khiển và chọn action khó dùng. Điều này làm giảm tốc độ phản hồi khi agent hỏi quyền hoặc cần điều hướng terminal.

## 3. Goals

- Tạo trải nghiệm mobile-first để chọn agent, project, start session và tương tác realtime.
- Bảo vệ backend khỏi arbitrary command execution.
- Chỉ cho spawn agent command từ config server-side.
- Chỉ cho chạy trong project directory thuộc allowlist.
- Cung cấp quick actions và shortcut row phù hợp với AI CLI workflow.

## 4. Non-goals

- Không làm public SaaS.
- Không làm RBAC/multi-user/multi-tenant.
- Không làm file explorer, Git GUI hoặc full IDE.
- Không triển khai production hardening bằng Nginx/systemd.
- Không tự động parse đầy đủ mọi confirm prompt.

## 5. Users / Personas

### Mobile product developer

Developer có máy Debian chạy CLI agents, thường kiểm tra hoặc điều phối agent từ điện thoại trong LAN/VPN.

## 6. User journey

1. Mở web app trên điện thoại.
2. Nhập token.
3. Chọn agent.
4. Chọn project trong allowlist.
5. Bấm Start.
6. Xem terminal output realtime.
7. Gửi tin nhắn/lệnh hoặc bấm quick action.
8. Kill/restart session nếu cần.

## 7. Feature priority

| Feature | Priority | Notes |
| --- | --- | --- |
| Auth token | Must | Bắt buộc cho API và WebSocket |
| Agent list from server | Must | Client không gửi raw command |
| Project allowlist | Must | Validate server-side |
| PTY session | Must | `node-pty` |
| WebSocket streaming | Must | Output/input realtime |
| xterm.js terminal | Must | Mobile-friendly |
| Quick actions | Must | Button lớn |
| Session control | Must | Start, kill, restart, status |
| Bounded output buffer | Must | Không giữ buffer vô hạn |
| Configurable action mapping | Should | Cho Yes to all, Skip, Edit first |
| Reconnect replay | Should | Replay buffer khi attach |

## 8. Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-01 | Người dùng phải auth trước khi gọi API hoặc WebSocket | Must |
| FR-02 | Backend trả danh sách agent từ config | Must |
| FR-03 | Backend trả danh sách project từ allowlist | Must |
| FR-04 | Backend tạo session bằng agentId và projectId hợp lệ | Must |
| FR-05 | Backend không nhận raw command từ client | Must |
| FR-06 | Backend stream PTY output qua WebSocket | Must |
| FR-07 | Frontend gửi input và key sequence qua WebSocket | Must |
| FR-08 | Người dùng có thể kill session | Must |
| FR-09 | Người dùng có thể restart session | Must |
| FR-10 | Terminal output buffer phải giới hạn | Must |

## 9. Non-functional requirements

| Category | Requirement | Target |
| --- | --- | --- |
| Security | Token required | 100% protected API/WS |
| Security | No raw command spawn | Enforced by schema and code |
| Reliability | Session cleanup on exit | Process state updated and listeners cleaned |
| Performance | Output buffer bounded | Default max 200000 chars |
| UX | Mobile-first controls | Touch targets at least 44px |
| Observability | Lifecycle logs | session start/exit/kill/restart |

## 10. Edge cases

- Invalid token.
- Missing `AUTH_TOKEN`.
- No allowed projects configured.
- Project path does not exist.
- Agent command not found.
- CLI agent not logged in.
- WebSocket disconnected.
- Session already exited.
- User sends unsupported WS event.
- Terminal output burst lớn.
- PTY spawn error.

## 11. Traceability

| Objective | Feature | Story | Test |
| --- | --- | --- | --- |
| Điều khiển CLI agent trên mobile | PTY session | US-03 | TC-SESSION-01 |
| Không expose command tùy ý | Server-side agent config | US-02 | TC-SEC-02 |
| Giới hạn project | Project allowlist | US-02 | TC-PROJ-01 |
| Tương tác realtime | WebSocket streaming | US-04 | TC-WS-01 |
| Thao tác dễ bấm | Quick actions | US-05 | TC-ACTION-01 |
| Truy cập có bảo vệ | Auth | US-01 | TC-AUTH-01 |

