# Hướng Dẫn Cấu Hình Và Vận Hành Web Push (FCM)

Tài liệu này hướng dẫn quản trị viên (owner) thiết lập, kiểm thử và quản trị tính năng **Web Push Notifications qua Firebase Cloud Messaging (FCM)** cho Web CLI.

---

## 1. Tổng Quan Kiến Trúc

Web CLI tích hợp tính năng thông báo đẩy khi CLI agent (hiện tại hỗ trợ **Codex CLI**) phát tín hiệu cần người dùng phản hồi (`approval-requested`, `plan-mode-prompt`) qua chuỗi escape TUI chuẩn **OSC 9**.

### Đặc điểm thiết kế an toàn
- **Bảo mật**: Không truyền prompt, lệnh, ID hay thông tin nhạy cảm qua payload FCM. Nội dung thông báo hiển thị trên màn hình khóa chỉ là thông báo chung:
  - **Tiêu đề**: `Codex cần bạn phản hồi`
  - **Nội dung**: `Mở Web CLI để xem yêu cầu xác nhận hoặc câu hỏi.`
- **Kiểm soát phiên**: Mỗi thiết bị gắn với một `authScope` dẫn xuất từ phiên đăng nhập hợp lệ. Khi người dùng đăng xuất rõ ràng (explicit logout) hoặc đổi mật khẩu Server Hub, quyền gửi thông báo của thiết bị bị thu hồi tự động.
- **Deep Link an toàn**: Nhấn vào thông báo sẽ mở trực tiếp phiên làm việc qua URL `#session=<uuid>`. Nếu phiên không còn tồn tại, hệ thống báo lỗi an toàn và mở bảng quản lý phiên mà không tự ý tạo phiên mới.
- **Không block terminal**: Hàng đợi gửi thông báo ở backend được giới hạn tối đa 128 công việc (bounded queue), concurrency 2, TTL 300 giây. Mọi sự cố mạng của FCM không làm gián đoạn hay ảnh hưởng tới PTY của phiên.

---

## 2. Chuẩn Bị Cấu Hình Firebase

Để kích hoạt tính năng thông báo thật (live push), quản trị viên cần chuẩn bị các thông tin từ [Firebase Console](https://console.firebase.google.com/):

### Bước 2.1: Tạo Firebase Project và Web App
1. Tạo một dự án Firebase mới hoặc chọn dự án hiện có.
2. Trong phần **Project Settings** > **General**, chọn **Add app** > **Web app**.
3. Đặt tên app (ví dụ: `Web CLI`) và lưu lại các tham số cấu hình:
   - `apiKey` (`FIREBASE_API_KEY`)
   - `projectId` (`FIREBASE_PROJECT_ID`)
   - `messagingSenderId` (`FIREBASE_MESSAGING_SENDER_ID`)
   - `appId` (`FIREBASE_APP_ID`)

### Bước 2.2: Tạo Web Push Certificate (VAPID Key)
1. Trong **Project Settings** > thẻ **Cloud Messaging** > mục **Web configuration**.
2. Tại phần **Web Push certificates**, nhấn **Generate key pair**.
3. Sao chép chuỗi **Key pair** công khai (đây là chuỗi base64url uncompressed P-256 public key 65 byte) và đưa vào biến `FIREBASE_VAPID_PUBLIC_KEY`.
   > **Lưu ý**: Tuyệt đối không nhầm lẫn giữa VAPID Public Key và Private Key.

### Bước 2.3: Tạo Firebase Admin Service Account
1. Trong **Project Settings** > thẻ **Service accounts**.
2. Nhấn **Generate new private key** để tải về tệp JSON chứa khóa bí mật của tài khoản dịch vụ.
3. Lưu tệp JSON này vào thư mục an toàn trên máy chủ (nằm ngoài thư mục mã nguồn git), phân quyền an toàn:
   ```bash
   sudo chmod 700 /var/lib/server-hub
   sudo chmod 600 /var/lib/server-hub/service-account.json
   ```

---

## 3. Cấu Hình Môi Trường Trên Server

Thêm hoặc cập nhật các biến môi trường trong tệp cấu hình của Web CLI (ví dụ: `.env` hoặc `/home/mrhoan/.config/server-hub/web-cli.env`):

```env
# Bật tính năng Web Push
FCM_ENABLED=true

# Thông tin Web App
FIREBASE_API_KEY=AIzaSy...
FIREBASE_PROJECT_ID=ten-project-cua-ban
FIREBASE_MESSAGING_SENDER_ID=123456789012
FIREBASE_APP_ID=1:123456789012:web:abcdef...

# VAPID Public Key
FIREBASE_VAPID_PUBLIC_KEY=B...

# Đường dẫn tệp Service Account JSON trên máy chủ
FIREBASE_SERVICE_ACCOUNT_FILE=/var/lib/server-hub/service-account.json

# (Tùy chọn) Thư mục lưu danh sách thiết bị devices.json (mặc định <WEB_CLI_AUTH_DIR>/push)
# FCM_DATA_DIR=/var/lib/server-hub/web-cli-push
```

Khởi động lại dịch vụ backend Web CLI để áp dụng cấu hình.

---

## 4. Đăng Ký Thiết Bị Và Thử Nghiệm

1. Mở Web CLI trên trình duyệt qua kết nối HTTPS (hoặc localhost).
2. Đăng nhập tài khoản của bạn.
3. Mở **Quản lý phiên** (trên desktop nằm ở thanh bên trái; trên di động bấm nút **Phiên** ở góc trên).
4. Kéo xuống mục **Thông báo đẩy (FCM)**:
   - Trạng thái ban đầu: `Chưa bật trên thiết bị`.
   - Nhấn nút **Bật thông báo**.
   - Trình duyệt sẽ hiển thị hộp thoại xin cấp quyền thông báo; chọn **Cho phép (Allow)**.
   - Sau khi hoàn tất đăng ký, trạng thái chuyển sang: `Đã bật` (màu xanh lá).
5. Nhấn nút **Gửi thử**:
   - Hệ thống sẽ gửi một thông báo thử nghiệm tới thiết bị hiện tại.
   - Trạng thái thông báo: `Đã xếp hàng gửi thử.`
   - Lưu ý: Giới hạn gửi thử là 1 lần mỗi 30 giây cho mỗi thiết bị để chống spam.

---

## 5. Hướng Dẫn Dành Cho iOS / iPadOS (PWA)

Theo chính sách của Apple đối với WebKit trên iOS/iPadOS 16.4 trở lên:
1. Mở Web CLI bằng trình duyệt **Safari**.
2. Nhấn nút **Chia sẻ (Share)** ở thanh công cụ Safari.
3. Chọn **Thêm vào Màn hình chính (Add to Home Screen)**.
4. Thoát Safari và mở ứng dụng Web CLI từ biểu tượng trên Màn hình chính.
5. Đăng nhập và bật thông báo trong mục cài đặt phiên.

---

## 6. Cơ Chế Thu Hồi Quyền (Revoke) Và Rollback

- **Tắt thông báo trên thiết bị hiện tại**:
  - Nhấn nút **Tắt trên thiết bị này** trong mục cài đặt. Hệ thống sẽ xóa bản ghi đăng ký trên máy chủ và hủy đăng ký Service Worker.
- **Thu hồi khi Đăng xuất (Logout)**:
  - Khi người dùng bấm Đăng xuất ở Web CLI, mọi thiết bị đăng ký trong phiên đăng nhập đó sẽ tự động bị thu hồi.
  - Khi người dùng đăng xuất khỏi Server Hub, các thiết bị gắn với tài khoản Hub đó bị thu hồi.
- **Thu hồi khi Đổi mật khẩu**:
  - Khi chủ tài khoản đổi mật khẩu Server Hub, toàn bộ danh sách thiết bị push (`devices.json`) sẽ bị xóa hoàn toàn để đảm bảo an toàn tuyệt đối.
- **Tắt hoàn toàn tính năng (Rollback)**:
  - Đặt `FCM_ENABLED=false` trong cấu hình môi trường và khởi động lại server.
  - Khi `FCM_ENABLED=false`, backend sẽ không tải credential Firebase, không tạo kết nối tới Google và vô hiệu hóa các API liên quan. Giao diện người dùng sẽ hiển thị trạng thái `Chưa cấu hình Firebase` mà không gây ảnh hưởng đến hoạt động của terminal.

---

## 7. Trạng Thái Nghiệm Thu Hiện Tại

- Mã nguồn, service worker, streaming attention detector OSC 9, hàng đợi push dispatcher, API đăng ký thiết bị và giao diện người dùng đã hoàn thành và đạt 100% các bài kiểm thử tự động với mock: **`CODE_READY`**.
- Thử nghiệm trên môi trường có cấu hình Firebase thật và thiết bị di động thật của owner: **`LIVE_FCM_PENDING`** (chờ owner cung cấp cấu hình Firebase production).
