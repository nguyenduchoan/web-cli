# Security Review (rà soát bảo mật)

## Phạm vi

Web CLI là bảng điều khiển có đặc quyền cao cho một người vận hành. Dịch vụ
production bind `127.0.0.1:3001` và chỉ nên được mở qua localhost, VPN hoặc
reverse proxy (proxy ngược) riêng có HTTPS/lớp xác thực bổ sung.

## Tài sản cần bảo vệ

- `AUTH_TOKEN` của bộ điều khiển.
- Source code và credential CLI của tài khoản hệ điều hành chạy backend.
- Nội dung vào/ra của terminal và trạng thái đăng nhập của từng CLI.
- Các thư mục project thuộc allowlist (danh sách cho phép).
- Biến môi trường và tiến trình con được tạo qua PTY (terminal giả lập).

## Ranh giới tin cậy

```text
Trình duyệt -> Bearer API / ticket WebSocket -> Fastify -> node-pty -> project được cho phép
```

Ai có `AUTH_TOKEN` gần như có quyền của tài khoản hệ điều hành vận hành Web
CLI trong các project được cho phép. Vì vậy token này không được dùng như cơ
chế xác thực duy nhất trên Internet công khai.

## Bề mặt tấn công và biện pháp hiện có

- Mọi API trừ chính xác `/api/health` đều yêu cầu Bearer token.
- Token lưu trong `sessionStorage`, không lưu lâu dài trong `localStorage`.
- WebSocket kiểm tra Origin, dùng ticket một lần có thời hạn ngắn và giới hạn
  số kết nối, kích thước payload, tốc độ input và lượng dữ liệu chờ gửi.
- Client chỉ gửi `agentId`/`projectId`; command và args do server cấu hình.
- Project được `realpath`, kiểm tra nằm trong allowlist và không trả absolute
  path (đường dẫn tuyệt đối) về trình duyệt.
- PTY chỉ nhận các biến môi trường có tên trong `AGENT_ENV_ALLOWLIST`; token
  của controller và cấu hình nội bộ không được truyền xuống.
- Số session, thời gian idle, thời gian lưu session đã thoát và output buffer
  đều có giới hạn.
- Terminal output không được ghi log; Authorization header được redaction
  (che dữ liệu nhạy cảm).
- Khi shutdown, backend đóng WebSocket và dừng PTY, có timeout cưỡng bức.

## Quy tắc triển khai

- Giữ `HOST=127.0.0.1`; không port-forward cổng 3001 ra Internet.
- Dùng token ngẫu nhiên dài tối thiểu 32 ký tự và xoay khi nghi ngờ lộ.
- Chỉ cấu hình agent có executable thật, ưu tiên đường dẫn tuyệt đối ổn định.
- Chỉ thêm project thực sự cần thiết vào `ALLOWED_PROJECT_DIRS`.
- Không thêm `AUTH_TOKEN`, `AGENTS_CONFIG_JSON` hoặc
  `ALLOWED_PROJECT_DIRS` vào `AGENT_ENV_ALLOWLIST`.
- Bảo vệ file môi trường bằng quyền `0640 root:hoantechlab` khi chạy systemd.

## Tiêu chí chấp nhận

- `/api/health` không token trả `200`; API riêng tư không token trả `401`.
- WebSocket không Origin/ticket hợp lệ bị từ chối.
- Unknown agent/project và path traversal không thể spawn PTY.
- Client không thể truyền raw command (lệnh thô) vào endpoint tạo session.
- Token không xuất hiện trong source/log hoặc môi trường tiến trình con.
- Giới hạn session/output/WebSocket được kiểm thử tự động.
- Dịch vụ chỉ lắng nghe trên loopback (địa chỉ nội bộ `127.0.0.1`).

## Rủi ro còn lại

- Token hợp lệ cho phép thao tác terminal mạnh; cần VPN/Access ở lớp ngoài.
- Output terminal vẫn có thể hiển thị secret cho người đang xem trình duyệt.
- Agent CLI là code bên thứ ba và hoạt động với quyền của user vận hành.
- Việc cài systemd/Nginx và xoay token nhà cung cấp cần người vận hành có
  quyền `sudo` hoặc quyền trên dashboard tương ứng.
