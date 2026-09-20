# Server Hub — 13/09/2026

Mục tiêu: chuyển `https://tmp-web.hoanit.io.vn` từ trang tạo VietQR thành cổng
dịch vụ cá nhân có username/password. VietQR giữ ở `/vietqr/`; Web CLI ở
`/api/web-cli/` và giữ tài khoản cùng TOTP 2FA riêng theo lựa chọn của chủ máy.

## Tiêu chí nghiệm thu

- Chưa đăng nhập chỉ xem màn hình đăng nhập; URL trực tiếp vào công cụ/API bị chặn.
- Có thể đăng nhập, đổi mật khẩu, đăng xuất; mật khẩu lưu bằng scrypt, cookie
  HttpOnly/Secure/SameSite=Strict, giới hạn thử đăng nhập và kiểm tra Origin.
- VietQR dùng lại mã nguồn đang chạy, kiểm tra mẫu CRC/TLV, tạo/tải PNG trên mobile.
- Web CLI thiết lập TOTP, tạo terminal thực, truyền lệnh/output qua WebSocket;
  đăng xuất hub hoặc Web CLI thu hồi quyền của kết nối đang mở.
- Backend bind loopback trên cổng rảnh; systemd tự khởi động sau reboot;
  kiểm tra HTTPS public, health endpoint, tiến trình và cổng sau khi triển khai.
- Có bản sao cấu hình Nginx trước thay đổi và hướng dẫn rollback.

## Quyết định và phạm vi

- Hub được bật bằng cấu hình trong backend Fastify hiện có, cùng vòng đời với
  Web CLI; không thêm một tầng proxy ứng dụng hay thay dashboard OAuth cũ.
- Chỉ cung cấp hai công cụ được yêu cầu trong lần này. Những dịch vụ hệ thống
  khác tiếp tục chạy với cấu hình hiện có, chưa cấp quyền start/stop qua hub.
- Một tài khoản chủ máy; terminal chạy với quyền mrhoan, không phải môi trường
  cách ly nhiều người dùng. Giới hạn PTY/WebSocket hiện có được giữ nguyên.
- Phiên đăng nhập nằm trong bộ nhớ và bị thu hồi sau restart. Tài khoản/TOTP
  nằm ngoài mã nguồn và ngoài document root, thư mục 0700, tệp 0600.
- Rollout chỉ đổi virtual host web chính sau kiểm thử cục bộ; không sửa Tunnel
  hoặc dừng những dịch vụ khác. Backend failure rollback bằng bản Nginx đã lưu.

## Validation

- `npm ci`: 232 packages, audit 0 vulnerabilities, không đổi lockfile.
- `npm run check`, `npm run build`: đạt; `npm test`: 11/11 đạt.
- `node scripts/smoke-hub.cjs`: đạt đăng nhập, 4 kích thước màn hình,
  PNG 580×580, lỗi số tiền, thiết lập TOTP/mã khôi phục, PTY thật qua WebSocket,
  reload giữ phiên, đăng xuất hub thu hồi WebSocket đang mở.
- `node scripts/verify-hub-deployment.cjs --local` và bản public HTTPS: đạt.
  Chưa đăng nhập chuyển về login; hub login mở hai công cụ; API/WS terminal vẫn
  từ chối nếu chưa 2FA; account/env không public. Cookie Secure/HttpOnly/Strict.
- Release cuối `/home/mrhoan/apps/server-hub/releases/20260913T095320Z`.
  Unit `server-hub.service` active/running, PID 3350304 tại thời điểm kiểm tra,
  chỉ nghe `127.0.0.1:3001`; health đạt; `Linger=yes`.
- Nginx validate và reload thành công, route public đã chuyển sang hub.
  Backup kích hoạt cuối: `/var/backups/server-hub/20260913T072406Z`.
- Rollback tự động thực sự đã được thực hiện khi kiểm tra ngay sau reload chưa
  thấy worker mới. Đã thêm retry và lưu đúng trạng thái enabled trước khi thử lại.
- Chủ máy cần tự ghép ứng dụng TOTP ở lần mở Web CLI đầu tiên; không tạo TOTP
  production thay chủ máy. Kiểm thử thao tác terminal/TOTP đầy đủ dùng tài khoản tạm.
- Đã sửa phản hồi từ chối bắt tay WebSocket: ghi `Content-Length: 0` và đóng
  socket sau khi gửi xong. Trước sửa, Nginx trả 401 nhưng Cloudflare có thể trả
  502; sau sửa cả Nginx nội bộ và HTTPS public cùng trả 401. Browser smoke
  kiểm tra framing này và kiểm tra lại luồng WebSocket/PTY thành công.
- `node scripts/verify-hub-deployment.cjs --browser`: đạt trên HTTPS thật sau
  bản sửa cuối: login, hub desktop/mobile, tạo VietQR, màn hình thiết lập 2FA,
  logout; không có lỗi JavaScript. Ảnh ở `/tmp/server-hub-public-desktop.png`
  và `/tmp/server-hub-public-mobile.png`.
