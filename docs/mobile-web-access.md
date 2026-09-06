# Web CLI trên điện thoại

Web CLI chạy terminal và các AI trên chính máy chủ. Đăng nhập bằng một tài khoản
chủ máy, mật khẩu và mã TOTP (mã sáu số thay đổi theo thời gian). Không cần VPN,
kết nối SSH hoặc mã Bearer cũ. Chưa có AI gợi ý chạy ngầm trong lúc gõ.

## Truy cập và thiết lập lần đầu

Mở `/api/web-cli/` trên tên miền HTTPS đang phục vụ Server Hub. Nút Web CLI trên
trang chủ trỏ đến đường này. API Hub chuyển tiếp tới `127.0.0.1:3001`; cả hai
dịch vụ vẫn chỉ lắng nghe trên địa chỉ nội bộ. Đường này có xác thực riêng của
Web CLI, không dùng mật khẩu hoặc cookie của Hub.

Khi chưa có tài khoản, dịch vụ tạo mã thiết lập ngẫu nhiên trong
`/var/www/html/secrets/web-cli-auth/setup-code.txt` (chỉ chủ máy đọc được).
Chủ máy lấy mã đó từ hệ thống tệp, nhập vào màn hình thiết lập, chọn tài khoản
và mật khẩu ít nhất 12 ký tự. Không đưa mã vào URL, runtime-config hoặc log.

Quét QR bằng ứng dụng xác thực; khi dùng một điện thoại, chọn mở ứng dụng hoặc
sao chép khóa để thêm thủ công. Nhập mã sáu số, tải mười mã khôi phục và lưu ở
nơi riêng. Chỉ sau khi xác minh mã đầu tiên mới cho phép mở terminal. Mã thiết
lập được xóa sau khi dùng; các lần sau chỉ nhập tài khoản, mật khẩu và mã 2FA.

Nếu mất ứng dụng xác thực, chọn dùng mã khôi phục tại màn hình đăng nhập.
Mỗi mã khôi phục chỉ dùng một lần, cùng mật khẩu. Bản hiện tại chưa có giao
diện đổi mật khẩu hoặc ghép lại 2FA; trường hợp mất cả mã khôi phục cần chủ máy
thực hiện quy trình phục hồi tài khoản trực tiếp trên máy chủ.

## Thao tác trên điện thoại

- “Phiên & dự án” mở bảng chọn thư mục, terminal thông thường hoặc AI.
- “Tạo phiên mới” mở tác vụ mới; danh sách trên đầu màn hình chuyển giữa phiên.
- Ô soạn hỗ trợ nhiều dòng và gõ tiếng Việt. Enter trên bàn phím xuống dòng;
  “Gửi” chuyển nội dung sang terminal. Với ứng dụng hỗ trợ dán nguyên khối,
  nhiều dòng được gửi theo chế độ đó.
- Tab gửi phần đang soạn vào terminal trước khi yêu cầu hoàn thành lệnh.
  Sau đó tiếp tục chỉnh sửa trực tiếp trên terminal nếu cần.
- Ctrl+C ngắt tác vụ. Hàng phím tắt cuộn ngang để thấy các phím còn lại.
- “Chép” sao chép phần được chọn, hoặc tối đa 500 dòng cuối. “↓ cuối” cuộn về cuối.
- Chỉnh cỡ chữ và bật gõ trực tiếp trong “Phiên & dự án”.
- Mất mạng tạm thời sẽ tự nối lại, có thời gian chờ tăng dần. Không tự gửi lại
  các lệnh có thể đã thực thi. Bản nháp riêng từng phiên chỉ nằm trong bộ nhớ trang.
- Tải lại trang khôi phục phiên đã chọn nếu phiên còn trên máy chủ. Tải lại
  trang sẽ mất bản nháp chưa gửi. Khởi động lại dịch vụ máy chủ kết thúc các PTY
  (phiên dòng lệnh); chưa có lưu phiên qua khởi động lại dịch vụ.
- Kết thúc hoặc khởi động lại phiên đều hỏi xác nhận. Đăng xuất đóng quyền
  điều khiển, tác vụ máy chủ vẫn theo vòng đời phiên đã cấu hình.

## Bảo vệ và giới hạn

Mật khẩu lưu bằng scrypt (N=131072, r=8, p=1). Khóa TOTP và bộ đếm chống dùng
lại mã được lưu trong thư mục riêng quyền 0700, tệp 0600. Mã khôi phục chỉ lưu
bản băm. Trình duyệt dùng cookie HttpOnly, SameSite=Strict, Secure khi HTTPS;
không lưu mật khẩu hoặc mã đăng nhập trong localStorage/sessionStorage.

Phiên đăng nhập hết hạn sau 12 giờ hoặc 30 phút không hoạt động. Đăng xuất và
hết hạn thu hồi cả kết nối WebSocket (kênh dữ liệu terminal liên tục). Ticket
kết nối dùng một lần, gắn với phiên đăng nhập và gửi trong giao thức phụ của
WebSocket; không có ticket trên URL/access log. API kiểm tra nguồn yêu cầu,
giới hạn thử đăng nhập và chỉ cho phép một tác vụ băm mật khẩu đồng thời.

Một tài khoản Web CLI có quyền chạy lệnh như người vận hành dịch vụ; danh sách
thư mục cho phép chọn thư mục ban đầu, không phải vùng cách ly quyền hệ thống.

## Triển khai và kiểm tra

```bash
cd /var/www/html/web-cli
npm ci
npm run check
npm test
npm run build
node scripts/smoke-mobile.cjs
```

Kiểm tra trình duyệt sử dụng Chrome và Puppeteer đã có ở máy chủ này. Tài khoản,
khóa 2FA và terminal kiểm thử đều nằm trong thư mục tạm. Không dùng tài khoản thật.

Khởi động lại `web-cli` và `api-server` sau khi hoàn tất kiểm tra. API Hub cần
bản có `src/web-cli-proxy.js`; Web CLI cần bản giao diện có đường cơ sở
`/api/web-cli/`. Nginx hiện có đã chuyển `/api/` kèm WebSocket. Khi dùng cấu hình
triển khai chuẩn trong `deploy/nginx-server-hub.conf`, có location riêng tương ứng.

`WEB_CLI_AUTH_DIR` đổi thư mục tài khoản (mặc định như trên). `WEB_CLI_PORT` trên
API Hub đổi cổng đích nội bộ. Sao lưu thư mục tài khoản riêng, không đưa vào public.
Không khôi phục bản backend xác thực Bearer cũ trong khi vẫn mở đường truy cập mới.
Khi quay lui, gỡ đường chuyển tiếp công khai trước và khôi phục bản đã sao lưu.

Kiểm tra trên điện thoại thật thêm: bàn phím iOS/Android, gõ tiếng Việt, chuyển
ứng dụng, mở ứng dụng xác thực, xoay màn hình và sao chép bằng cảm ứng. Giả lập
chiều cao bàn phím không thay thế toàn bộ hành vi thiết bị thật.
