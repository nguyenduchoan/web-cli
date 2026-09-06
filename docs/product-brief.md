# Product Brief: Agent CLI Web Controller

## Problem statement

Developer đang dùng điện thoại để điều khiển AI CLI agents qua terminal mobile như Termius, nhưng trải nghiệm nhập phím điều khiển và xác nhận action chưa phù hợp. Các thao tác thường gặp như Yes/No, Ctrl+C, Ctrl+D, Tab, Enter, mũi tên lên/xuống hoặc chọn action của agent khó bấm, dễ sai và làm chậm workflow.

## Target user

- Developer, product engineer hoặc tech lead đã cài sẵn Claude Code CLI, Gemini CLI, Codex CLI, OpenCode CLI trên máy Debian.
- Người dùng muốn điều khiển các CLI agent từ browser mobile trong LAN/VPN.

## Jobs-to-be-done

- Khi đang dùng điện thoại, tôi muốn chọn agent và project nhanh để bắt đầu phiên làm việc.
- Khi agent hỏi xác nhận, tôi muốn bấm nút lớn thay vì gõ chính xác trên terminal mobile.
- Khi cần phím đặc biệt, tôi muốn có shortcut row cho Ctrl+C, Ctrl+D, Tab, Enter, mũi tên.
- Khi phiên đang chạy, tôi muốn xem output realtime và gửi input như terminal.
- Khi phiên lỗi hoặc treo, tôi muốn kill hoặc restart session an toàn.

## Product goal

Xây dựng một web app mobile-first chạy local/dev trên Debian giúp điều khiển các AI CLI agents đã cài sẵn thông qua PTY và WebSocket, không viết lại các agent gốc.

## Success metrics

- Người dùng có thể start một CLI agent trong project allowlist dưới 30 giây sau khi mở web.
- 100% API và WebSocket bị chặn nếu thiếu token.
- 100% session chỉ spawn command từ server config, không nhận raw command từ client.
- 100% project spawn phải match allowlist server-side.
- Quick actions chính gửi đúng key sequence theo mapping MVP.
- Terminal output stream về mobile gần realtime trong điều kiện LAN.

## MVP scope

Must:

- Auth bằng token/password tĩnh từ `.env`.
- Danh sách agent từ server config.
- Danh sách project từ allowlist server-side.
- Spawn PTY bằng `node-pty` trong selected project directory.
- Session id và state: idle/running/exited/error.
- WebSocket stream output và nhận input/key sequence.
- Terminal UI bằng xterm.js.
- Quick action panel và shortcut row.
- Start, kill, restart session.
- Logging lifecycle cơ bản.
- README, `.env.example`, docs product/UX/architecture/security/QA.

Should:

- Replay bounded terminal output buffer khi reconnect.
- WebSocket ticket ngắn hạn thay vì token dài hạn trong URL.
- Agent quick action mapping cấu hình được.

Could:

- Expose danh sách session trong memory.
- Cho phép resize terminal từ frontend.

Won't:

- Public SaaS.
- Multi-user collaboration.
- Full IDE, file explorer nâng cao, Git GUI.
- Payment/billing.
- Agent memory riêng.
- Parse chính xác 100% mọi confirm prompt.
- Deploy production qua Nginx/systemd.
- Release plan production.
- RBAC hoặc multi-tenant.

## Product risks

- Nếu public internet, token tĩnh là không đủ an toàn.
- CLI agent có thể tự thực hiện hành động mạnh trong project vì chạy dưới user OS hiện tại.
- Terminal output có thể chứa secret.
- Mapping action của từng CLI có thể khác nhau và cần chỉnh config.

