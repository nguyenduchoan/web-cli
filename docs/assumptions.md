# Assumptions

## Product assumptions

- Người dùng chính là developer hoặc product engineer đang dùng điện thoại để điều khiển AI CLI agent chạy trên máy Debian cá nhân hoặc máy dev nội bộ.
- Các CLI agent đã được cài, đăng nhập và có thể chạy trực tiếp từ shell trên Debian bằng lệnh `claude`, `gemini`, `codex`, `opencode`.
- MVP chỉ phục vụ local/LAN/VPN cá nhân, không public internet.
- Chỉ cần một người dùng với token tĩnh trong `.env`, chưa cần RBAC, multi-user hoặc audit nâng cao.
- Project directory được chọn từ allowlist server-side. Client không được nhập path tự do trong MVP.

## Technical assumptions

- Backend dùng Node.js + TypeScript + Fastify + `ws` + `node-pty`.
- Frontend dùng React + Vite + TypeScript + TailwindCSS + xterm.js.
- Node.js trên Debian đủ mới để chạy Vite và TypeScript. Khuyến nghị Node.js 20 LTS trở lên.
- `node-pty` có thể cần build tools trên Debian: `python3`, `make`, `g++`.
- WebSocket dùng ticket ngắn hạn do backend cấp sau khi đã auth bằng bearer token, tránh đưa auth token dài hạn vào URL WebSocket.
- PTY session vẫn tiếp tục chạy khi browser/WebSocket disconnect, người dùng có thể attach lại trong vòng đời server process nếu còn session id.
- Terminal output buffer được giới hạn để tránh giữ bộ nhớ vô hạn.

## CLI behavior assumptions

- Mapping chắc chắn:
  - Enter: `\r`
  - Tab: `\t`
  - Ctrl+C: `\x03`
  - Ctrl+D: `\x04`
  - Arrow Up: `\x1b[A`
  - Arrow Down: `\x1b[B`
  - Yes: `y\r`
  - No: `n\r`
  - Abort: `\x03`
- Mapping chưa chắc 100% theo từng CLI nên được đặt trong server config và có thể sửa:
  - Yes to all: fallback `a\r`
  - Skip: fallback `s\r`
  - Edit first: fallback `e\r`
- MVP không tự parse chính xác mọi confirm prompt của agent. Người dùng bấm quick action thủ công.

## Security assumptions

- Token tĩnh đủ cho MVP local/dev, nhưng không đủ cho public internet.
- Người vận hành phải cấu hình firewall/VPN nếu truy cập ngoài LAN.
- Terminal output có thể chứa secret do CLI agent in ra. Ứng dụng mặc định không log terminal output ra console server.
- Allowlist project chỉ giới hạn thư mục làm việc ban đầu của process. Sau khi agent chạy, chính CLI agent vẫn có quyền theo user OS hiện tại.

