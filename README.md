# Agent CLI Web Controller

Mobile-first web controller để điều khiển các CLI agent đã cài sẵn trên Debian.
Máy chủ production hiện cấu hình Codex CLI, OpenCode CLI và Terminal; chỉ thêm
Claude/Gemini sau khi executable của chúng thực sự được cài.

Ứng dụng không viết lại các agent này. Backend spawn CLI agent bằng PTY trong project directory thuộc allowlist, stream terminal qua WebSocket, frontend hiển thị bằng xterm.js và cung cấp nút thao tác lớn cho mobile.

## Yêu cầu môi trường

- Debian hoặc distro Linux tương đương.
- Node.js 20 LTS trở lên.
- npm.
- Build tools cho `node-pty`:

```bash
sudo apt update
sudo apt install -y python3 make g++ pkg-config
```

- Ít nhất một CLI agent đã cài và login sẵn; production hiện dùng `codex`,
  `opencode` và `/usr/bin/bash`.

## Cài dependency

```bash
npm install
```

## Cấu hình môi trường

Production đọc `/etc/server-hub/web-cli.env`. File `.env` chỉ là fallback
(cấu hình dự phòng) cho phát triển cục bộ.

```bash
cp .env.example .env
```

Sửa các giá trị chính:

```bash
AUTH_TOKEN=mot-token-rat-dai-va-kho-doan
ALLOWED_PROJECT_DIRS=/home/user/projects/app1,/home/user/projects/app2
HOST=127.0.0.1
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
VITE_API_BASE_URL=http://localhost:3001
```

## Cấu hình agents

Mặc định backend dùng:

- Claude Code: `claude`
- Gemini CLI: `gemini`
- Codex CLI: `codex`
- OpenCode CLI: `opencode`

Nếu command khác hoặc cần args, cấu hình `AGENTS_CONFIG_JSON` trong `.env`:

```bash
AGENTS_CONFIG_JSON='[
  {"id":"claude","label":"Claude Code","command":"claude","args":[],"quickActions":{"yesAll":"a\r","skip":"s\r","editFirst":"e\r"}},
  {"id":"gemini","label":"Gemini CLI","command":"gemini","args":[],"quickActions":{"yesAll":"a\r","skip":"s\r","editFirst":"e\r"}}
]'
```

Client chỉ gửi `agentId`; backend không nhận raw command từ client.

## Cấu hình project allowlist

Chỉ các thư mục trong `ALLOWED_PROJECT_DIRS` mới xuất hiện trên UI và được dùng làm `cwd` khi spawn PTY.

```bash
ALLOWED_PROJECT_DIRS=/home/user/projects/app1,/home/user/projects/app2
```

Backend validate:

- path tồn tại,
- path là directory,
- path được resolve bằng realpath,
- client chỉ gửi project id do server cấp.

## Chạy dev

Terminal 1:

```bash
npm run dev:server
```

Terminal 2:

```bash
npm run dev:web
```

Mở web:

```text
http://localhost:5173
```

Nhập `AUTH_TOKEN` đã cấu hình.

## Build

```bash
npm run build
```

Backend build ra `server/dist`. Frontend build ra `web/dist`.

## Chạy local trên Debian

```bash
npm --workspace server run build
npm --workspace web run build
npm --workspace server run start
```

Backend production sẽ phục vụ cả API/WebSocket và frontend build tại cùng origin:

```text
http://localhost:3001
```

Frontend dev vẫn có thể chạy riêng bằng:

```bash
npm --workspace web run dev
```

Khi phát triển trên cổng 5173, mở `/api/web-cli/`; Vite chuyển tiếp API và WebSocket tới cổng 3001 cùng nguồn truy cập. Không cần đặt `VITE_API_BASE_URL`.

## Truy cập từ điện thoại hoặc máy khác

Giữ backend bind loopback:

```bash
HOST=127.0.0.1
```

Mở `/api/web-cli/` trên tên miền HTTPS của Server Hub. Xác thực bằng mật khẩu
và mã 2FA; hướng dẫn thiết lập lần đầu ở [mobile-web-access.md](docs/mobile-web-access.md).

## Truy cập ngoài LAN

Không yêu cầu VPN. Đường công khai đi qua Hub, còn cổng 3001 giữ nội bộ.

Không chuyển tiếp trực tiếp cổng 3001. AUTH_TOKEN cũ không còn cấp quyền truy cập.

## WebSocket protocol

API dùng cookie phiên sau khi xác minh mật khẩu và 2FA:

```text
web_cli_session; HttpOnly; SameSite=Strict; Secure (HTTPS)
```

WebSocket dùng ticket ngắn hạn:

1. Client gọi `POST /api/sessions/:id/ws-ticket`.
2. Backend trả ticket.
3. Client kết nối `/api/web-cli/api/sessions/:id/ws`, gửi `web-cli` và `ticket.<ticket>` qua giao thức phụ WebSocket. Ticket gắn với cookie đăng nhập, dùng một lần và không nằm trên URL.

Client -> Server:

- `input`
- `resize`
- `ping`

Server -> Client:

- `output`
- `state`
- `error`
- `exit`
- `pong`

Không có event `spawnRawCommand`.

## Quick action mapping

- Enter: `\r`
- Tab: `\t`
- Ctrl+C: `\x03`
- Ctrl+D: `\x04`
- Arrow Up: `\x1b[A`
- Arrow Down: `\x1b[B`
- Yes: `y\r`
- No: `n\r`
- Abort: `\x03`

Các mapping sau cấu hình được theo agent:

- Yes to all
- Skip
- Edit first

## Logging

Backend log session lifecycle: start, exit, kill, restart.

Mặc định không log terminal output. Terminal output có thể chứa secret, token, path nội bộ hoặc nội dung source code.

## Troubleshooting

### CLI command not found

Kiểm tra command có trong `PATH` của process server:

```bash
which claude
which gemini
which codex
which opencode
```

Nếu command nằm ở path khác, sửa `AGENTS_CONFIG_JSON`.

### Agent chưa login

Chạy agent trực tiếp trên máy Debian trước:

```bash
claude
gemini
codex
opencode
```

Login theo hướng dẫn của từng CLI, sau đó quay lại web controller.

### Permission denied

Kiểm tra user chạy backend có quyền vào project:

```bash
ls -la /home/user/projects/app1
```

### WebSocket disconnected

- Kiểm tra backend còn chạy.
- Kiểm tra `VITE_API_BASE_URL` đúng host/port.
- Đăng nhập lại nếu phiên đăng nhập hết hạn.
- Chọn phiên cũ hoặc bấm Nối lại; chỉ tạo phiên mới khi muốn tác vụ mới.

### node-pty install lỗi

Cài build tools:

```bash
sudo apt install -y python3 make g++ pkg-config
```

Sau đó chạy lại:

```bash
npm install
```

### Project path invalid

Kiểm tra `ALLOWED_PROJECT_DIRS` dùng absolute path, tồn tại và là directory.

```bash
realpath /home/user/projects/app1
```

### Không truy cập được từ điện thoại

- Mở tên miền HTTPS của Server Hub, đường `/api/web-cli/`.
- Giữ backend ở `HOST=127.0.0.1`.
- Kiểm tra chứng chỉ HTTPS và API Hub đang chuyển tiếp Web CLI.
- Nếu frontend dev chạy riêng, thêm đúng origin vào `CLIENT_ORIGIN`.

## Security notes

- Auth bắt buộc cho API và WebSocket.
- `/api/health` là ngoại lệ public để health check nội bộ.
- Chương trình khởi tạo phiên thuộc danh sách cấu hình máy chủ.
- Sau xác thực, người dùng nhập lệnh với quyền của tài khoản vận hành dịch vụ.
- Chỉ chọn project từ allowlist.
- Không log auth token.
- Không log terminal output mặc định.
- Phiên đăng nhập nằm trong cookie HttpOnly, không lưu bí mật vào localStorage/sessionStorage.
- Có giới hạn session, idle timeout, output buffer, WebSocket và graceful shutdown.
- Truy cập công khai yêu cầu HTTPS, mật khẩu và 2FA.
