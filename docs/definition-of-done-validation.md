# Definition of Done (điều kiện hoàn tất)

## Trạng thái hiện tại

Phần ứng dụng đã được harden (gia cố), build và kiểm thử cho mô hình private
service (dịch vụ riêng). Việc cài unit systemd/Nginx thật vẫn là deployment
gate (cổng kiểm soát triển khai) cần quyền `sudo` của người vận hành.

## Checklist

- [x] TypeScript check và production build thành công.
- [x] Chính xác `/api/health` là public; các API còn lại yêu cầu Bearer token.
- [x] Project dùng ID phía server, `realpath` và allowlist.
- [x] Client không thể gửi command/args tùy ý.
- [x] WebSocket dùng Origin + ticket một lần, giới hạn payload/tốc độ/backpressure.
- [x] Môi trường PTY dùng allowlist và không kế thừa controller token.
- [x] Session, idle timeout, retention, output và số kết nối đều có giới hạn.
- [x] Shutdown đóng WebSocket và chấm dứt PTY.
- [x] Token trình duyệt dùng `sessionStorage`.
- [x] Agent production chỉ liệt kê executable hợp lệ: Codex, OpenCode, Terminal.
- [x] `npm audit --omit=dev` trả `0 vulnerabilities`.
- [x] Không tìm thấy credential thật trong source hoặc log đã quét.
- [ ] Cài và xác minh unit systemd thật bằng quyền `sudo`.
- [ ] Đặt URL Web CLI sau VPN/Access nếu cần truy cập từ máy khác.

## Lệnh xác minh

```bash
npm test
npm run check
npm run build
npm audit --omit=dev
node /var/www/html/scripts/smoke-deployment.js
```

Smoke test (kiểm tra nhanh chức năng cốt lõi) xác minh API auth, cấu hình
Nginx, file nhạy cảm trả `404`, audio range `206`, token Web CLI và vòng đời
tạo/dừng một PTY session.

## Kết quả gần nhất

- 3 unit test backend đạt.
- Web bundle ban đầu khoảng 211 KB; terminal chunk lazy-load khoảng 293 KB.
- Web CLI cô lập trả `401` khi thiếu token và tạo/dừng terminal thành công.
- Cấu hình production chỉ bind `127.0.0.1:3001`.
