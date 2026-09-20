# Server Hub trên máy mrhoan

Trang chính: `https://tmp-web.hoanit.io.vn`. Sau đăng nhập, chọn VietQR Studio
hoặc Web CLI. VietQR xử lý thông tin và tạo ảnh trực tiếp trong trình duyệt.
Web CLI giữ xác thực tài khoản/mật khẩu + TOTP riêng theo lựa chọn của chủ máy.

## Đăng nhập lần đầu

- Tài khoản hub: `mrhoan`. Mật khẩu ngẫu nhiên tại
  `/home/mrhoan/.local/state/server-hub/hub-auth/initial-login.txt` (0600).
- Chọn **Đổi mật khẩu** trên hub để đặt mật khẩu từ 12 ký tự. Tệp mật khẩu
  khởi tạo tự xóa, các phiên cũ (gồm quyền điều khiển Web CLI) bị thu hồi.
- Mở Web CLI và tạo tài khoản riêng. Hub tự cấp mã thiết lập một lần sau
  đăng nhập; không cần sao chép mã hệ thống. Quét QR bằng ứng dụng xác thực,
  nhập mã sáu số, lưu các mã khôi phục rồi mở terminal.
- Terminal, Codex, Claude Code và OpenCode dùng chương trình có sẵn trên máy;
  trạng thái đăng nhập nhà cung cấp AI vẫn thuộc CLI tương ứng.

## Kiến trúc và bảo vệ

`Cloudflare HTTPS → Tunnel hiện có → Nginx :80 (host tmp-web) → 127.0.0.1:3001`.
Cấu hình Nginx dùng cơ chế Upgrade theo [tài liệu WebSocket chính thức](https://nginx.org/en/docs/http/websocket.html).
Unit user `server-hub.service` chạy release ở `/home/mrhoan/apps/server-hub/current`.
Tài khoản/state nằm ngoài release, ngoài document root. Phiên hub có TTL 12 giờ,
idle 30 phút, cookie HttpOnly, Secure, SameSite=Strict; dữ liệu phiên ở bộ nhớ,
restart yêu cầu đăng nhập lại. Đăng xuất/đổi mật khẩu hub thu hồi kết nối Web CLI
đang mở (ngay khi có input, tối đa 5 giây khi idle). TOTP vẫn bắt buộc ở Web CLI.

Hub chỉ phục vụ các tệp cho phép và không có API start/stop dịch vụ hệ thống.
Web CLI chạy với quyền `mrhoan`; lựa chọn thư mục không phải sandbox. Unit dùng
`NoNewPrivileges=true`, vì vậy sudo trong terminal không tăng đặc quyền. Một hub
account chủ máy, tối đa 3 PTY và 8 WebSocket; chưa hỗ trợ phân quyền nhiều người.

VietQR đã tải về trình duyệt vẫn tạo QR offline khi phiên hết hạn; API và lần
tải trang tiếp theo yêu cầu đăng nhập. Không có dữ liệu chuyển khoản gửi lên server.

## Build, kiểm thử, triển khai

```bash
cd /home/mrhoan/source/web-cli
npm ci
npm run check
npm test
npm run build
node scripts/smoke-hub.cjs
bash deploy/install-server-hub.sh
```

Nếu máy yêu cầu mật khẩu sudo, tách bước cài user service và bước quản trị:

```bash
bash deploy/install-server-hub.sh --stage-only
pkexec /usr/bin/bash /home/mrhoan/source/web-cli/deploy/activate-server-hub.sh
```

Có thể thay `pkexec` bằng `sudo`. Nhập mật khẩu trong hộp thoại/terminal của máy.
Sau activation, `node scripts/verify-hub-deployment.cjs --browser` kiểm tra HTTPS
và Chrome public bằng mật khẩu khởi tạo; lệnh này chỉ dùng trước khi tệp mật khẩu
khởi tạo được xóa qua chức năng đổi mật khẩu.

Browser smoke dùng Chrome và Puppeteer hiện có; có thể đặt `CHROME_PATH` và
`PUPPETEER_MODULE` trên máy khác. Mọi tài khoản/TOTP/PTY thử nghiệm ở `/tmp`,
không dùng tài khoản production. Script cài yêu cầu sudo không tương tác cho
Nginx và linger; sao lưu cấu hình trước khi đổi route, chỉ tiếp tục nếu cổng
3001 rảnh hoặc thuộc đúng service. Release chứa bản sao dependency từ lockfile.
Không sửa file trong release đang chạy. Cấu hình repo `.env` không được đóng gói.

## Kiểm tra vận hành

```bash
systemctl --user status server-hub.service --no-pager
ss -lntp 'sport = :3001'
curl --fail http://127.0.0.1:3001/api/health
curl --head https://tmp-web.hoanit.io.vn/login
journalctl --user -u server-hub.service -n 30 --no-pager
```

Backend phải ở `127.0.0.1:3001`, đúng MainPID của unit. `/api/health` public bị
Nginx chặn; nội bộ trả `ok: true`. `loginctl show-user mrhoan -p Linger` phải là
`yes` để user service chạy sau reboot dù chưa đăng nhập desktop.
Phản hồi WebSocket bị từ chối có `Content-Length: 0` để Cloudflare chuyển tiếp
đúng 401/403. Không đổi thành `socket.destroy()` ngay sau `write()`: phản hồi
thiếu framing/đóng quá sớm từng làm kiểm tra public nhận 502.
Mã nguồn TOTP ở `server/src/webAuth.ts`, hub ở `server/src/hub*.ts`, giao diện và
VietQR ở `hub/public/`. Danh sách project và CLI nằm trong
`/home/mrhoan/.config/server-hub/web-cli.env`; không thêm CLI chưa có executable.

## Rollback

Script báo release và backup trong `/home/mrhoan/apps/server-hub/backups/<timestamp>`.
Nếu lần đầu public hub có lỗi, chuyển symlink `/etc/nginx/sites-enabled/server-hub`
ra thư mục backup (không xóa dữ liệu), chạy `sudo nginx -t` rồi
`sudo systemctl reload nginx`. Default site VietQR cũ vẫn tồn tại và sẽ phục vụ
lại tên miền. Sau đó `systemctl --user disable --now server-hub.service`.

Với lần cập nhật sau, restore `current` theo `previous-release.txt`, env/unit/vhost
trong backup, `systemctl --user daemon-reload`, restart hub, kiểm tra health và
`nginx -t` trước reload. Không rollback về bản thiếu xác thực trong khi còn route
public. Không ghi đè account/TOTP hiện tại từ một backup cũ.

Chủ máy sao lưu riêng thư mục state 0700 để phục hồi tài khoản và TOTP. Chưa có
giao diện reset 2FA; mất cả thiết bị và mã khôi phục cần phục hồi trực tiếp trên máy.
