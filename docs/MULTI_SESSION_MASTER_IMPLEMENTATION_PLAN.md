# Kế hoạch triển khai chuẩn — Multi-session, UX quản lý phiên, Shift + ← và FCM

**Trạng thái:** Bản bàn giao để owner duyệt; chưa cho phép tự triển khai chỉ vì file tồn tại

**Phiên bản:** 1.0

**Ngày:** 20/09/2026

**Kho mã:** `/home/mrhoan/source/web-cli`

**Tài liệu duy nhất được phép dùng để thực thi:** file này.

> `docs/MULTI_SESSION_UI_UX_PLAN.md`, `docs/MULTI_SESSION_IMPLEMENTATION_PLAN_V1.md` và `docs/agile/multi-session-plan.md` chỉ là tài liệu tham khảo cũ. Agent thực thi không được lấy thêm yêu cầu từ các file đó. Nếu có mâu thuẫn, file này được ưu tiên.

Owner xem mục 2–3 để duyệt phạm vi, mục 10.9 để chuẩn bị Firebase và mục 11 để xem thứ tự làm. Agent thực thi phải đọc toàn bộ, đặc biệt contract mục 7–10 và test mục 12. Mục 17 chỉ rõ quyết định đã hợp nhất; mục 18 có prompt bàn giao dùng ngay.

---

## 1. Hợp đồng bắt buộc với agent thực thi

Agent phải tuân thủ các quy tắc sau trong toàn bộ công việc:

1. Đọc `AGENTS.md`, tài liệu này và các file nguồn được liệt kê trước khi sửa.
2. Chỉ triển khai đúng các mục trong tài liệu này. Không thêm tính năng, không đổi kiến trúc, không refactor không liên quan.
3. Dùng symbol/tên hàm thay vì phụ thuộc số dòng. Thay đổi số dòng/format không phải blocker. Nếu contract, auth, lifecycle hoặc API thực tế khác quyết định trong file này, dừng hạng mục bị ảnh hưởng và báo: file, symbol, khác biệt, tác động và quyết định cần owner. Không tự thay kiến trúc.
4. Không xóa hoặc hoàn tác các thay đổi có sẵn trong working tree. Không sửa phần Server Hub/VietQR nếu phase đó không nêu rõ file cần sửa.
5. Chỉ sửa file nằm trong allowlist tổng và danh sách phase. Chỉ owner được mở rộng allowlist; agent không tự thêm đường dẫn vào tài liệu để hợp thức hóa thay đổi ngoài scope. Được quay lại sửa file của phase đã làm để khắc phục regression do chính thay đổi mới gây ra, rồi chạy lại gate liên quan.
6. Repo dùng `package-lock.json` và npm workspaces. Không đổi package manager. Không thêm dependency ngoài danh sách được cho phép ở mục 10.1.
7. Không commit, push, deploy, restart service hoặc thay đổi port. Không đọc/ghi secret thật vào repo.
8. Chỉ luồng terminal WebSocket đã xác thực được mang terminal output/snapshot. Không đưa nội dung đó vào REST metadata, log hay notification. Cookie, FID, FCM token, service-account private key không được ghi log; FID chỉ truyền trong API đăng ký đã auth và lưu trong store riêng.
9. Sau mỗi phase phải chạy đúng validation của phase. Không chuyển phase nếu gate chưa đạt.
10. Khi test cần server, bind `127.0.0.1` và dùng port ephemeral. Nếu phải dùng port cố định, kiểm tra `ss -lntp` trước và không dừng dịch vụ đang chiếm port.
11. Không nâng `MAX_SESSIONS`, `MAX_WS_CONNECTIONS`, buffer hoặc timeout mặc định để làm test pass.
12. Không dùng regex tìm các từ như `confirm`, `approve`, `yes` trong terminal output để kết luận agent cần người dùng phản hồi.
13. Không tự động trả lời, duyệt, kill hoặc restart phiên do nhận notification.
14. Báo cáo cuối phải liệt kê file đã sửa, test đã chạy, test bị bỏ qua, rủi ro còn lại và cấu hình người dùng còn phải cung cấp.

Việc bàn giao tài liệu này hiện chỉ là lập kế hoạch. Agent bắt đầu coding sau khi owner giao rõ lệnh triển khai. Khi đã được giao, không hỏi lại cho các bước trong scope; hoàn thành lần lượt các gate. Không dùng tài liệu cũ như lệnh bổ sung.

Không tự tạo subagent, không cài global skill, không tạo branch/worktree hoặc thay `AGENTS.md`. Được lựa chọn tên biến cục bộ và cách chia hàm bên trong các module đã chỉ định; không được lựa chọn lại behavior/API/định mức trong tài liệu.

---

## 2. Kết quả cần đạt

Người dùng có thể chạy đồng thời các phiên sau:

```text
Codex     -> project-A
Codex     -> project-A
Terminal  -> project-A
OpenCode  -> project-B/subdir
```

Ví dụ bốn phiên trên chỉ chạy đủ khi owner đã cấu hình capacity ít nhất 4. Cấu hình mặc định 3 vẫn giữ nguyên; test chạy các tổ hợp hai/ba phiên, không sửa env production để chứa ví dụ. Các phiên phải có ID, PTY, output, trạng thái, bản nháp và thao tác lifecycle độc lập. Các quy tắc không được vi phạm:

```text
create session mới       != kill/restart session cũ
switch session            != kill/restart/create session
đóng tab/WebSocket        != kill PTY
logout                    != kill toàn bộ PTY
reconnect                 != gửi lại input cũ
notification click        != tự động approve
```

Ngoài multi-session, bản release này có hai tính năng cụ thể:

- Khi phiên đang xem có `agentId === "codex"`, hiển thị nút **Shift + ←**. Nút gửi đúng mã phím vào PTY đang xem và không gửi kèm bản nháp.
- Khi Codex phát tín hiệu yêu cầu phản hồi, backend gửi FCM khi owner đã bật config và thiết bị đã đăng ký. Notification phải hoạt động khi trang Web CLI đã đóng; khi bấm, mở đúng `sessionId` sau khi người dùng đăng nhập lại nếu cần.

---

## 3. Phạm vi khóa

### 3.1 Được làm

- Backend quản lý nhiều PTY độc lập trong một process.
- Lifecycle rõ ràng: running, stopping, exited, error và lý do kết thúc.
- API trả metadata phiên, capacity, working directory tương đối và revision output.
- Chống restart trùng và retry create/restart bằng idempotency key.
- Frontend tách `sessionsById`, `activeSessionId`, connection state và draft theo phiên.
- Một xterm và một terminal WebSocket hiển thị tại một thời điểm; phiên nền vẫn chạy.
- Session Manager desktop sidebar và mobile bottom sheet/dialog.
- New Session flow riêng; warning cùng thư mục chỉ cảnh báo, không chặn.
- Stale REST/WebSocket/folder request guard.
- Khôi phục màn hình terminal từ headless snapshot có sequence và giới hạn scrollback; byte ring buffer không được coi là snapshot màn hình.
- Nút Shift + ← chỉ cho Codex.
- FCM Web push, service worker, foreground banner, background notification, deep link về phiên.
- Test backend, API/WS, browser smoke, mobile layout, security và async shutdown.
- README, `.env.example` và hướng dẫn vận hành Firebase.

### 3.2 Không được làm trong bản này

- Git worktree tự động hoặc clone/copy thư mục.
- Cách ly Docker/VM/process sandbox cho từng agent.
- Multi-user, RBAC, chia sẻ terminal giữa tài khoản.
- Redis, database phiên, distributed SessionManager hoặc nhiều backend worker.
- Giữ PTY qua restart/reboot backend.
- Split-screen nhiều terminal/xterm cùng lúc.
- Session recording hoặc terminal history lưu lâu dài.
- Tự động conflict resolution cho hai agent cùng sửa file.
- Tích hợp notification cho Claude/Gemini/OpenCode/agent khác. Các agent này vẫn phải chạy multi-session đúng; adapter push cho chúng nằm ngoài bản này.
- Firebase Authentication, Firestore hoặc thay hệ thống login/TOTP hiện có.
- Tự động approve/deny câu hỏi từ notification.
- Đổi domain, reverse proxy, port hoặc triển khai production.

---

## 4. Thuật ngữ và invariant

| Thuật ngữ | Định nghĩa bắt buộc |
| --- | --- |
| Session | Bản ghi backend gắn với một PTY/process, `sessionId` UUID duy nhất. |
| Active session | Session đang được người dùng chọn trên một tab trình duyệt. |
| Attached session | Session có terminal WebSocket đang gắn với xterm hiện tại. |
| Background session | Session đang chạy nhưng không phải active/attached. |
| Working directory | `cwd` sau khi server resolve/realpath và kiểm tra allowlist. Không expose absolute path. |
| Draft | Nội dung chưa gửi, lưu theo `sessionId`; không dùng chung giữa các phiên. |
| Attention event | Sự kiện Codex cần người dùng xem và phản hồi; chỉ có metadata, không có prompt. |

Invariant phải có test:

1. Hai phiên cùng `agentId` và cùng cwd vẫn tạo hai UUID/PTY riêng.
2. Hai agent khác nhau cùng cwd không bị backend tự block.
3. Kill/restart A không đổi state, PTY hoặc output của B.
4. Dữ liệu state/output của A không được chọn active A khi người dùng đã chọn B.
5. Một callback cũ không được đổi `connected`, xterm hoặc error của phiên mới.
6. Một thao tác logic với cùng idempotency key chỉ tạo một kết quả.
7. Session limit chỉ chặn create mới; không làm rơi các phiên đang chạy.
8. FCM notification chỉ mở session; không gửi input.

---

## 5. Hiện trạng đã xác minh

Agent không được coi các điểm dưới đây là giả định:

- `server/src/sessionManager.ts` dùng `Map` theo UUID, spawn PTY riêng và có output buffer riêng.
- `web/src/App.tsx` hiện có một `session` active và một xterm visible; danh sách session đã có nhưng `updateSession()` vừa merge vừa chọn active.
- `web/src/components/TerminalPane.tsx` đã có socket identity/stopped guard. Không ghi trong code rằng stale close callback chắc chắn đã xảy ra; phải bổ sung generation/session guard để hoàn thiện.
- Backend hiện phát lại đuôi `outputBuffer` khi attach nhưng chưa có sequence/sync boundary; output bị cắt có thể không dựng lại chính xác màn hình ANSI.
- `restartSession()` hiện stop rồi create session mới, chưa có lock/idempotency.
- `localStorage` đang dùng chung cho session cuối giữa các tab.
- `ProjectSelector` có request duyệt thư mục có thể trả về đảo thứ tự.
- `WebSocketBridge` hiện cho nhiều socket hợp lệ cùng gửi input/resize vào một PTY.
- `MAX_SESSIONS`, `MAX_WS_CONNECTIONS`, output limit, auth cookie, WebSocket ticket, project allowlist và child env allowlist là guard hiện có; phải giữ nguyên.
- Repo có `package-lock.json`, npm workspaces, TypeScript, Vite, React và test server bằng `tsx --test`.
- Working tree đang có thay đổi Server Hub/VietQR. Agent phải giữ nguyên các thay đổi đó.

---

## 6. File được phép sửa

### 6.1 File hiện có được phép sửa

```text
server/src/config.ts
server/src/httpErrors.ts
server/src/index.ts
server/src/sessionManager.ts
server/src/websocket.ts
server/src/staticAssets.ts
server/src/webAuth.ts
server/src/hubAuth.ts
hub/public/app.js
server/test/sessionManager.test.ts
server/test/auth.test.ts
server/test/hub.test.ts
scripts/smoke-hub.cjs
scripts/smoke-mobile.cjs
scripts/smoke-touch-scroll.cjs
web/src/App.tsx
web/src/index.css
web/src/lib/api.ts
web/src/lib/types.ts
web/src/components/TerminalPane.tsx
web/src/components/QuickActions.tsx
web/src/components/ProjectSelector.tsx
web/src/components/SessionControls.tsx
web/index.html
.env.example
README.md
deploy/install-server-hub.sh
package.json
package-lock.json
server/package.json
web/package.json
```

### 6.2 File mới được phép tạo

```text
server/src/idempotency.ts
server/src/sessionRoutes.ts
server/src/terminalState.ts
server/src/attention.ts
server/src/pushConfig.ts
server/src/pushStore.ts
server/src/pushDispatcher.ts
server/src/push.ts
server/test/idempotency.test.ts
server/test/terminalState.test.ts
server/test/sessionReducer.test.ts
server/test/pushRoutes.test.ts
server/test/attention.test.ts
server/test/pushDispatcher.test.ts
server/test/websocket.test.ts
server/test/multiSessionApi.test.ts
web/src/features/sessions/sessionReducer.ts
web/src/features/sessions/sessionTypes.ts
web/src/features/sessions/useSessions.ts
web/src/components/SessionManager.tsx
web/src/components/SessionList.tsx
web/src/components/SessionItem.tsx
web/src/components/NewSessionDialog.tsx
web/src/components/NotificationSettings.tsx
web/src/lib/push.ts
web/worker/firebase-messaging-sw.ts
web/tsconfig.worker.json
web/scripts/build-push-worker.mjs
web/public/icon.svg
web/public/icon-192.png
web/public/icon-512.png
web/public/manifest.webmanifest
scripts/smoke-multi-session.cjs
scripts/smoke-notifications.cjs
server/test/fixtures/terminal-agent.cjs
docs/firebase-push.md
docs/agile/changes/multi-session-validation.md
```

Không tạo file khác nếu chưa được owner cho phép.

`hub/public/app.js` chỉ được sửa việc bảo toàn deep link notification qua login và xóa consent khi logout; không thay layout/navigation/VietQR. Các smoke script cũ chỉ cập nhật selector và assertion tương ứng UI mới, không xóa coverage auth/TOTP/mobile. `sessionRoutes.ts` chỉ tách route session khỏi `index.ts` để test bằng Fastify inject; không rewrite bootstrap/auth/static của toàn repo.

---

## 7. Contract backend phải triển khai

### 7.1 Public session

Mở rộng `PublicSession` nhưng giữ tương thích các field cũ:

```ts
type SessionState = "idle" | "running" | "stopping" | "exited" | "error";
type SessionExitReason =
  | "natural"
  | "user_kill"
  | "restart"
  | "idle_timeout"
  | "server_shutdown"
  | "spawn_error";

type PublicSession = {
  id: string;
  name?: string;
  agentId: string;
  agentLabel: string;
  projectId: string;
  projectLabel: string;
  rootProjectLabel: string;
  subpath?: string;
  workingDirectoryId: string;
  workingDirectoryLabel: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  revision: number; // revision metadata, không tăng cho từng output chunk
  outputLastSeq: number;
  replacedFromSessionId?: string;
  replacementSessionId?: string;
  stopTimedOut?: boolean;
  attention?: { eventId: string; createdAt: string };
  exitReason?: SessionExitReason;
  exitCode?: number;
  signal?: number;
  error?: string;
};
```

Không trả `project.path`, cwd tuyệt đối, agent command/args hoặc env.

`workingDirectoryId = sha256(realCwd).slice(0, 32)`. `subpath = path.relative(realRoot, realCwd)` đổi separator thành `/`; root là chuỗi rỗng. `rootProjectLabel` là tên root; `projectLabel` giữ giá trị tương thích cũ; `workingDirectoryLabel = rootProjectLabel + (subpath ? '/' + subpath : '')`. Tuyệt đối không dùng label làm identity. Server resolve lại khi create/restart, kiểm tra `stat.isDirectory()` trước spawn. `cd` bên trong shell không đổi metadata thư mục khởi tạo.

`revision` tăng cho mỗi lần đổi metadata/state/attention; `lastActivityAt` đổi theo input/output nhưng không làm broadcast mỗi chunk. Mỗi lần server start sinh `serverEpoch` UUID và có `registryRevision` tăng khi thêm/đổi/xóa session; mọi REST session response mang hai field này. Output sequence là số tăng riêng, bao gồm thao tác resize ở mục 7.6.

### 7.2 GET `/api/sessions`

Response bắt buộc:

```json
{
  "serverEpoch": "startup-uuid",
  "registryRevision": 9,
  "sessions": [],
  "capacity": { "active": 2, "reserved": 0, "max": 3 }
}
```

`active` đếm `idle`, `running`, `stopping`; `reserved` đếm slot đang giữ cho restart sau khi PTY cũ đã exit nhưng PTY mới chưa spawn. Điều kiện create: `active + reserved < max`. UI hiện tổng sử dụng `(active + reserved)/max`, không ghi tất cả là “running”. Không đổi default `MAX_SESSIONS=3`.

`GET /api/projects` thêm `workingDirectoryId` cho mỗi root; `GET /api/browse/:projectId` thêm `workingDirectoryId` và `canonicalSubpath` cho folder đã resolve. Đây là dữ liệu để warning cùng folder; response browse không thay active session. `GET /api/sessions/:id` giữ `{session}` và thêm epoch/registry revision.

### 7.3 POST `/api/sessions`

Request giữ field cũ và thêm `name`:

```json
{
  "agentId": "codex",
  "projectId": "project-id",
  "subpath": "server",
  "name": "Backend refactor",
  "cols": 100,
  "rows": 30
}
```

Validation:

- `agentId`, `projectId`: chuỗi không rỗng.
- `name`: trim, 1–80 ký tự nếu có.
- `subpath`: tối đa 500 ký tự; resolve/realpath trong project root; symlink/traversal ngoài root trả lỗi.
- `cols`: 20–300; `rows`: 5–120.
- Command/args chỉ lấy từ server config.

Client mới phải gửi header `Idempotency-Key` UUID cho Create và Restart. Để tương thích client cũ, backend vẫn chấp nhận header vắng; khi vắng thì request không có bảo đảm chống lặp. Không header nào được bỏ qua auth/Origin.

Algorithm idempotency trong `idempotency.ts`:

1. Sau auth/schema validation, key namespace là `method + canonical concrete route (đã thay path params) + UUID`, trong phạm vi chủ máy duy nhất hiện có; không namespace theo cookie ngắn hạn.
2. Fingerprint tạo từ các field request đã parse, theo thứ tự field cố định. Cùng key nhưng fingerprint khác trả `409 idempotency_conflict`.
3. Đặt entry `{pendingPromise, fingerprint}` trước `await` đầu tiên có side effect; cùng key đang pending await chung promise. Không chạy action lần hai.
4. Cache status/body kết quả đã hoàn tất 5 phút tính từ completion, gồm success và lỗi nghiệp vụ sau khi vào action. Không cache 401/403/schema error. Retry cùng key nhận cùng HTTP status và body.
5. Tối đa 1000 entry gồm pending; chỉ xóa entry completed đã hết hạn. Đầy thì trả `429 idempotency_capacity`, không evict entry pending hoặc còn TTL.
6. Response ghi session ID tại thời điểm tạo; nếu session đó đã hết retention trong TTL, replay không được spawn lại. UI refresh list để nhận trạng thái missing.
7. Cache chỉ trong RAM. Server restart mất cache và PTY; UI không tự gửi lại mutation qua epoch mới.

### 7.4 Kill/restart

- `POST /api/sessions/:id/kill`: chuyển `stopping`, reason `user_kill`, trả ngay metadata; SIGTERM một lần, deadline 5 giây rồi SIGKILL nếu PTY chưa exit. Kill lặp trả state hiện tại; không reset deadline.
- `POST /api/sessions/:id/restart`: xử lý idempotency trước, sau đó lock theo session ID trước `await`. Trong lúc restart đang chạy, key khác trả `409 session_operation_in_progress`; key đã hoàn tất trả lại cùng response.
- Restart tạo session mới với ID mới, giữ session cũ ở recent retention và reason `restart`; response trả `{ session, replacedSessionId }`.
- Không bao giờ restart hoặc kill session khác để giải phóng capacity.

Thuật toán giữ slot restart: mỗi PTY active sở hữu một slot; restart giữ slot đó khi PTY cũ exit và chuyển thành reservation, create thường không được dùng slot này. Spawn replacement sử dụng cùng slot, không xin thêm slot. Nếu restart phiên đã exited/error, phải xin một slot rảnh trước. Nếu spawn/revalidate fail sau khi PTY cũ đã exit, giải phóng reservation trong `finally`. Nếu PTY cũ chưa exit, không giải phóng slot, không spawn replacement.

Sau SIGKILL chờ thêm 1 giây. Nếu chưa có `onExit`, giữ `stopping`, đặt `stopTimedOut=true`, trả `504 session_stop_timeout` cho restart; không giả lập `exited`. Cleanup tiếp tục lắng nghe exit thực; UI báo không dừng được và không khuyên tự kill phiên khác. Test dùng PTY double cho timeout, không tạo process không thể dừng trên host.

Sau restart thành công, session cũ có `replacementSessionId`; session mới có `replacedFromSessionId`. Restart lại ID cũ bằng key mới trả `409 session_already_restarted`, không sinh bản sao. Kill trong lúc ID đó có restart lock trả 409. Create/restart trả `{session, serverEpoch, registryRevision, capacity}`; restart thêm `replacedSessionId`. Spawn lỗi trả session `error/spawn_error` có ID để UI hiển thị, không tự retry CLI.

Giữ status success hiện tại: create 201, kill/restart 200. Spawn thất bại sau khi record đã tạo vẫn trả record state error để client mở được item lỗi; lỗi validate/capacity trước khi tạo record trả 4xx. Kill response cũng có `{session,serverEpoch,registryRevision,capacity}`. Create kiểm tra + chiếm slot đồng bộ ngay trước spawn, sau resolve path; không có await giữa check capacity và chiếm slot. Resize body/key retry phải giữ nguyên request ban đầu, không lấy lại kích thước mới giữa chừng.

Error response giữ helper `sendError` hiện có: `{error: code, message}`. `ApiError.code` ở frontend lấy từ `body.error`, không đổi tên field response hiện có. Các code ổn định gồm:

```text
unknown_session
unknown_agent
unknown_project
validation_error
session_capacity_reached
session_operation_in_progress
invalid_subpath
path_not_found
path_traversal
control_locked
idempotency_conflict
idempotency_capacity
session_already_restarted
session_stop_timeout
server_shutting_down
```

`web/src/lib/api.ts` phải giữ `status` và `code` trên lỗi để UI phân biệt retryable/permanent.

Status mapping: validation/invalid_subpath 400; unknown session/agent/project/path_not_found 404; path_traversal 403; operation/idempotency/already_restarted 409; capacity 429; shutting_down 503; stop_timeout 504. Không để global error handler đổi mọi 5xx nghiệp vụ thành 500; whitelist đúng 503/504 của app, mọi exception khác vẫn 500 sanitized. Không log raw Firebase/credential exception qua global handler.

### 7.5 Lifecycle và shutdown

- PTY exit tự nhiên: `natural`, trừ khi có stop reason đã ghi trước đó.
- Spawn lỗi: `error` + `spawn_error`.
- Idle timeout: `stopping` + `idle_timeout`.
- Server đóng: `stopping` + `server_shutdown`.
- State `stopping` có deadline và escalated signal; chỉ `onExit` được kết luận đã exit. Khi timeout phải hiển thị lỗi như mục 7.4 và giữ accounting đúng.
- `sweep()` khi xóa session recent phải phát event `removed` và đóng socket của session đó.
- Shutdown: đồng bộ đặt `closing=true` ở SessionManager/WS/dispatcher trước mọi await; mutation mới trả 503, ticket/upgrade mới bị từ chối. Gọi close WebSocket (deadline 1 giây rồi terminate) và stop PTY (5 giây TERM + 1 giây KILL) đồng thời, cùng close dispatcher deadline 2 giây; `await Promise.allSettled` cả ba rồi Fastify.close. Deadline toàn cục `SHUTDOWN_TIMEOUT_MS=15000` giữ nguyên; clear/unref timer sau hoàn tất, không cộng deadline tuần tự.

Retention: thêm `MAX_RETAINED_SESSIONS=50` (chỉ exited/error), xóa oldest-first khi vượt; không xóa active/stopping. Xóa theo TTL hoặc cap phải dispose terminal mirror, timer, listeners, buffer và đóng socket mã 4004. Idle vẫn 4 giờ, tính input/output, bỏ resize khỏi activity nghiệp vụ; không tính HTTP polling/WebSocket ping để giữ PTY sống. Người đang xem nhưng không input/output vẫn có thể bị idle stop; mô tả trong UI/hướng dẫn.

### 7.6 Màn hình terminal và protocol đồng bộ v2

**Quyết định cố định:** một terminal headless cho mỗi session ở server; một xterm visible cho mỗi tab. Tạo `terminalState.ts` với `@xterm/headless@5.5.0` và `@xterm/addon-serialize@0.13.0`, cùng thế hệ với frontend xterm 5.5.0. Dùng serializer ANSI, không HTML. Không tự viết VT parser, không truy cập `_core` private và không coi đuôi raw ANSI là snapshot.

Nguồn đối chiếu: [xterm 5.5.0 và addon tương thích](https://github.com/xtermjs/xterm.js/releases/tag/5.5.0), [API SerializeAddon](https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/addons/addon-serialize/typings/addon-serialize.d.ts). Addon có giới hạn: Phase 2 phải kiểm chứng các mode thực tế; nếu thiếu capability bắt buộc, dừng để owner quyết định, không thay bằng replay sai trạng thái.

**Dữ liệu mỗi session:**

- Headless có cols/rows bằng PTY, `scrollback=1000`, `allowProposedApi=true`; không nối `headless.onData` vào PTY để tránh gửi trùng phản hồi terminal. Frontend hiện tại tiếp tục gửi terminal replies khi đang attach/controller.
- `terminalSeq` tăng 1 cho mỗi operation output hoặc resize đã hoàn tất; `PublicSession.outputLastSeq` phản ánh cùng sequence này để giữ tên field contract. Không đánh đồng với metadata `revision`.
- `terminalState` có queue tuần tự `write`, `resize`, `snapshot barrier`. `write` chỉ hoàn tất khi callback `headless.write(data, callback)` chạy; output v2 được phát sau callback. Resize PTY/headless nằm trong cùng queue, sau đó phát `terminal_resize` có seq.
- Buffer raw cũ vẫn giữ để phục vụ v1, không dùng làm source phục hồi v2. Queue/headless không lưu ra đĩa.
- Pending parse bytes vượt 512 KiB thì `pty.pause()`; xuống 128 KiB thì `pty.resume()`. Đây chỉ là backpressure parser cục bộ; client chậm không được pause PTY của tất cả người khác. Đóng session/shutdown phải xử lý cả trạng thái đang pause và dispose queue.
- Khi PTY exit, xếp barrier sau output cuối, tạo final snapshot cùng quy tắc giới hạn 1 MiB bên dưới rồi dispose headless. Session recent chỉ giữ final snapshot và raw buffer bounded; không giữ 50 headless đầy scrollback. Attach vào session exited chờ final snapshot sẵn sàng và không bật input. Xóa record thì dispose cả snapshot/queue; callback muộn phải kiểm tra record còn tồn tại. Serialize lỗi phải báo lỗi đồng bộ, không dùng đuôi raw giả làm snapshot.

**Negotiate protocol:** `POST /api/sessions/:id/ws-ticket` nhận `{protocolVersion:2}` từ client mới. TicketRecord lưu version; thiếu field là v1. URL/subprotocol auth và ticket một lần vẫn giữ nguyên. V1 nhận đúng message cũ/raw replay; v2 nhận contract mới dưới đây. Không phát cả raw replay cũ và snapshot mới cho cùng socket.

**Attach v2 bắt buộc theo thứ tự:**

1. Validate auth/Origin/ticket/session/capacity như hiện tại; xác định role socket.
2. Đăng ký listener terminal operations/state/exit trước, queue output của socket trong lúc sync.
3. Đặt snapshot barrier vào queue của session. Tại barrier, lấy `baseSeq`, cols/rows, serialize normal + alternate buffer + modes (`excludeModes=false`, `excludeAltBuffer=false`). Không serialize trước khi write callback hoàn tất.
4. Giới hạn snapshot UTF-8 tối đa 1 MiB: thử scrollback 1000, nếu vượt thì 500, 100, 0; không cắt raw chuỗi serialized. Nếu chỉ màn hình hiện tại vẫn vượt 1 MiB, trả `terminal_snapshot_too_large`, không bật input. Field `historyTruncated=true` khi có giảm scrollback hoặc ring/history đã bỏ phần đầu.
5. Chia snapshot theo ranh giới Unicode thành `snapshot_chunk` tối đa 16 KiB dữ liệu UTF-8/chunk. `syncId` UUID riêng cho lần attach. Gửi:

```ts
// Mọi message v2 đều có sessionId + serverEpoch.
{ type: "sync_start", sessionId, serverEpoch, syncId, session,
  baseSeq, cols, rows, control: "controller" | "viewer", historyTruncated }
{ type: "snapshot_chunk", sessionId, serverEpoch, syncId, index: 0, data }
// ... index liên tục, không bỏ chunk
{ type: "sync_end", sessionId, serverEpoch, syncId, baseSeq, chunkCount }
{ type: "output", sessionId, serverEpoch, seq: baseSeq + 1, data }
{ type: "terminal_resize", sessionId, serverEpoch, seq, cols, rows }
```

6. Bỏ các queued operation `seq <= baseSeq` vì đã nằm trong snapshot. Gửi còn lại theo seq rồi chuyển socket sang live. Không bỏ output silently; nếu queue socket vượt `MAX_WS_BUFFERED_BYTES`, đóng 1013 để client đồng bộ lại. Không tăng config limit.
7. Gửi snapshot chunks có backpressure dựa `bufferedAmount`, deadline sync 10 giây; cleanup listener/timer khi timeout, mất auth, close hoặc đổi session. Không giữ tất cả snapshot của các lần attach trong RAM vô hạn.

Các message metadata v2 cũng có `sessionId/serverEpoch`; không tăng terminal sequence:

```ts
{ type: "state", sessionId, serverEpoch, registryRevision, session }
{ type: "exit", sessionId, serverEpoch, registryRevision, session }
{ type: "removed", sessionId, serverEpoch, registryRevision } // rồi close 4004
{ type: "attention", sessionId, serverEpoch, eventId, createdAt }
{ type: "error", sessionId, serverEpoch, code, message } // message sanitized
```

Trong sync, state/exit mới hơn snapshot chỉ gửi sau sync_end; không để state trước snapshot bị snapshot cũ ghi đè. Removed/auth loss hủy sync ngay. `control` event có thể cập nhật role trong lúc sync nhưng chưa cho gửi input; chỉ bật khi cả role controller và sync hoàn tất. `historyTruncated` chỉ là mất lịch sử cuộn, không phải màn hình hiện tại được phép sai.

**Frontend nhận v2:**

- `sync_start`: gate input=false, chờ các write cũ đã callback rồi reset xterm, resize xterm về cols/rows snapshot trước khi write snapshot. Serialize/deserialize cùng kích thước; chỉ fit theo viewport sau khi restore xong và có role controller.
- Chỉ accept snapshot cùng `sessionId`, `serverEpoch`, `connectionGeneration`, `syncId`. Verify index/chunkCount. Chờ callback write chunk cuối trước xử lý `sync_end`/bật input.
- `seq <= appliedSeq` là duplicate: bỏ; `seq !== appliedSeq+1` là gap: disable input, reconnect mới lấy snapshot, không nối tiếp trạng thái thiếu.
- Kể cả callback WebSocket đã guard, callback `terminal.write` đang xếp hàng từ A cũng phải được drain/guard trước render B. Test bắt buộc write callback A đến sau switch B không làm lẫn màn hình.
- Snapshot không chứa OSC notification gốc; không phát lại attention khi reconnect. Attention chỉ parse raw PTY bytes ở backend lúc phát sinh.
- Lưu vị trí cuộn theo session trong RAM dạng khoảng cách tới đáy, không lưu nội dung màn hình. Restore có clamp sau sync; nếu người dùng đã ở đáy thì theo output mới. Reload vào đáy; không hứa lịch sử vô hạn.
- Scrollback cũ đã vượt limit có thể mất, nhưng màn hình hiện tại, alternate screen, cursor và chế độ input dùng trong test không được sai. Nếu gate tương thích Codex/ANSI không đạt, agent dừng phần terminal, không bỏ assertion để hoàn tất UI.

### 7.7 Quyền điều khiển một PTY

Trong cùng một session, socket đầu tiên là controller. Socket sau là viewer:

- Viewer được nhận state/output.
- Viewer gửi input/resize nhận `{ type: "error", code: "control_locked" }` và không ghi PTY.
- Controller mất kết nối/auth hết hạn thì quyền được giải phóng; server tự cấp cho viewer đã attach sớm nhất còn auth hợp lệ. Không có viewer thì socket tiếp theo là controller. Thao tác cấp/thu hồi đồng bộ trong event loop, không await ở giữa.
- V2 gửi `{type:"control", sessionId, serverEpoch, role:"controller"|"viewer"}` khi role đổi. Tới lượt được cấp quyền, client chỉ fit/resize sau sync xong. Mỗi input/resize server kiểm tra lại socket owner và auth ngay trước ghi PTY; viewer không được làm thay đổi `lastActivityAt`.
- Không làm tính năng “claim control” trong bản này.
- UI phải hiện “Chỉ xem — phiên đang được điều khiển ở thiết bị khác” khi nhận state viewer.
- Viewer muốn điều khiển phải đóng/kết thúc attach trên thiết bị đang giữ quyền; chưa có nút cưỡng chế takeover. Không auto-restart PTY để giành quyền. Viewer giữ kích thước grid của controller, dùng overflow trong container; không tự resize grid khác server.

---

## 8. Contract frontend và UX

### 8.1 State model bắt buộc

Tạo reducer/hook trong `web/src/features/sessions/` với shape:

```ts
type SessionsState = {
  sessionsById: Record<string, Session>;
  sessionOrder: string[];
  serverEpoch?: string;
  registryRevision: number;
  activeSessionId?: string;
  capacity: { active: number; reserved: number; max: number };
  connection: { sessionId?: string; status: "idle" | "connecting" | "syncing" | "connected" | "disconnected" | "missing"; control: "none" | "controller" | "viewer" };
  draftsBySessionId: Record<string, string>;
  pendingOperation?: { id: string; type: "create" | "kill" | "restart"; sessionId?: string };
  attentionBySessionId: Record<string, AttentionEvent>;
  seenAttentionBySessionId: Record<string, string>; // eventId đã xem, không phải đã approve
};
```

Reducer actions tối thiểu:

```text
LOAD_SESSIONS
UPSERT_SESSIONS
UPSERT_SESSION
REMOVE_SESSION
SET_ACTIVE_SESSION
SET_CONNECTION
SET_DRAFT
SET_PENDING_OPERATION
ADD_ATTENTION
REMOVE_ATTENTION
```

`SET_ACTIVE_SESSION` chỉ đổi ID và trạng thái kết nối UI về connecting/idle; không gọi API lifecycle. Hàm `switchSession(id)` khóa đường gửi input đồng bộ trước dispatch, tăng generation rồi detach socket cũ. Không chờ React effect mới khóa input.

### 8.2 Quy tắc async frontend

- Mỗi lần switch/attach tăng `connectionGeneration`; mọi callback WS/timer/xterm write thuộc attach đó kiểm tra `sessionId`, generation, socket identity trước đổi view/kết nối. `sendInput`/resize kiểm tra cùng tuple ngay trước `ws.send`, thêm role controller và sync complete.
- Dùng `authGeneration` riêng: logout/auth-expired tăng generation và invalidate mọi REST callback cũ. Không áp dụng connectionGeneration cho merge metadata nền vì phản hồi của A vẫn có ích khi đang xem B.
- Kill/restart response được merge theo ID/revision; chỉ auto-chọn replacement nếu active ID và `selectionGeneration` vẫn bằng giá trị lúc bấm restart. Create cũng ghi lại selectionGeneration: nếu người dùng đóng form rồi chủ động chọn phiên khác, create vẫn thêm vào list nhưng không kéo active về phiên mới.
- Query list chỉ có một request đang chạy; requestGeneration chống response đảo thứ tự. Snapshot có registryRevision nhỏ hơn dữ liệu đã nhận bị bỏ qua; snapshot hợp lệ replace danh sách, prune ID bị xóa. Upsert entity có revision nhỏ hơn bỏ qua; không đổi thứ tự item khi state thay đổi. Capacity/list phải được refresh sau mutation, không dùng capacity cache idempotency cũ để ghi đè state mới.
- Epoch khác: đóng attach cũ, xóa list/connection của epoch cũ, báo backend đã khởi động lại; không tự retry mutation chưa biết kết quả. Không gửi input của phiên cũ vào ID mới.
- Folder browse dùng đồng thời AbortController và request sequence. `canonicalSubpath` chỉ cập nhật khi response thành công; nút “Chọn thư mục này” disabled khi loading/error. Đóng form phải abort request và reset browse error.
- Khi session 404: trạng thái `missing`, dừng retry vô hạn và refresh danh sách một lần.
- Khi 401/403: dừng socket, không retry; giữ deep link notification nếu có.
- GET/ticket/WS 5xx/network/1013: backoff 1, 2, 4, 8, 15 giây + jitter tối đa 20%, tối đa 5 lần liên tiếp; sau đó hiện nút Nối lại. Online/focus cho phép một vòng retry mới. Reset counter sau đồng bộ thành công. Không auto-retry POST create/restart/kill; nút “Thử lại yêu cầu” dùng cùng idempotency key/body trong 5 phút.
- Active ID lưu trong `sessionStorage` theo tab, không lưu `localStorage` dùng chung. Không lưu output/prompt vào storage.

Khi load: ưu tiên hash notification hợp lệ → sessionStorage của tab → phiên running mới nhất → không có phiên. Nếu hash hợp lệ nhưng ID không tồn tại thì báo missing và mở Session Manager, không tự chọn phiên khác. Khi active session exit, giữ màn hình cuối và trạng thái exited, không tự nhảy session; khi bị retention remove thì clear active, giữ một thông báo trong danh sách.

Refresh danh sách: ngay sau login/create/kill/restart, khi mở Session Manager, khi focus/online/visibility trở lại. Poll 5 giây khi tab visible/online/authenticated và còn session active; dừng khi hidden/offline/logout. Error backoff theo các mốc trên; không chồng request. Status session nền phải hội tụ trong 5 giây + độ trễ API khi mạng bình thường. FCM không phụ thuộc polling.

Draft giữ RAM tối đa theo số session còn trong list; prune khi retention remove/logout. Không persist prompt qua reload. `seenAttentionBySessionId` cũng RAM; một notification đã xem có thể xuất hiện lại sau reload, nhưng cùng event trong một lần mở app chỉ hiện một lần.

### 8.3 Desktop

- Breakpoint desktop là 1024px. Sidebar rộng 280px, có nút thu gọn; terminal/composer chiếm phần còn lại. Dưới 1024px dùng mobile sheet. Không tạo terminal mới khi đổi breakpoint.
- Sidebar có nhóm `Đang chạy`, `Đang dừng`, `Gần đây`; item đổi nhóm theo process state, không reorder vì output/last activity.
- Mỗi item hiển thị: status text + dot, session name hoặc agent label, agent, project/subpath tương đối, thời gian/last activity, ID 6 ký tự.
- Item active có `aria-current="true"` và focus-visible.
- Header hiện `(active + reserved)/max đang sử dụng` từ API và nút `+ Phiên mới`.
- Menu item có Mở, Nối lại, Khởi động lại, Kết thúc. Không có Rename, xóa lịch sử hay Stop all trong bản này. Tên chỉ nhập lúc create; restart giữ tên và thêm ID mới để phân biệt.
- Trong mỗi nhóm trạng thái, nhóm tiếp theo `workingDirectoryId`; tên group hiển thị workingDirectoryLabel. Trong group sort createdAt tăng dần rồi ID để ổn định. Có search tên/agent/folder và filter agent; filter chỉ đổi danh sách, không đổi active. Nếu active bị filter ẩn, terminal vẫn giữ phiên đó.

Item chỉ chuyển nhóm khi process state đổi; output/lastActivity/attention không reorder trong nhóm. Các action Mở và Thêm phiên ở thư mục này luôn giữ nguyên session đang chạy. Nối lại chỉ attach, không restart. Restart/Kết thúc yêu cầu confirmation một lần; nhấn liên tiếp khi pending bị disable, không nhân request mới.

### 8.4 Mobile

- Terminal là vùng chính; không dùng sidebar cố định.
- Header hiện session hiện tại, state text, capacity và nút `Phiên`.
- Nút `Phiên` mở bottom sheet/dialog có danh sách và `+ Phiên mới`.
- Touch target tối thiểu 44px; có safe-area; dialog đóng trả focus về nút mở.
- Không để session list che composer khi bàn phím ảo mở; test 360px, 390px portrait/landscape.
- Sheet dùng native `<dialog>` modal cao tối đa 85dvh với body list cuộn; terminal ở phía sau không nhận click/input. Composer thuộc terminal ngoài sheet; đóng sheet mới thao tác composer. Khi bàn phím ảo hiện, giữ logic `visualViewport`/safe-area hiện có. Không tạo đồng thời hai dialog mở; New Session thay nội dung sheet rồi quay lại danh sách khi hủy.

### 8.5 New Session flow

Dialog riêng, không dùng dialog settings hiện tại cho lifecycle:

```text
Phiên mới
Agent -> Project -> Thư mục -> Tên phiên -> Xác nhận
```

- Form giữ nguyên khi request fail.
- Chọn agent mặc định theo lựa chọn form lần trước, folder mặc định theo project đầu tiên; mở từ nút “Thêm phiên ở thư mục này” thì điền từ metadata item. Form không được lấy agent từ active session để tự đổi selection đang nhập.
- Nếu selected agent không phải `shell` và có phiên không phải `shell` đang running/idle/stopping cùng `workingDirectoryId`, hiện warning inline: “Các phiên này dùng chung tệp. Thay đổi có thể xung đột.” Liệt kê tối đa 3 tên + số còn lại; không mở dialog xác nhận thứ hai và không thêm bước duyệt bắt buộc. Hai terminal shell không warning.
- Tạo thành công: upsert session, chọn phiên mới và attach nếu selectionGeneration còn hợp lệ như mục 8.2; đóng form. Lỗi giữ nguyên form và active cũ.
- Không làm thay đổi active session khi browse folder hoặc khi warning hiện.
- Create disable trong lúc pending; dùng idempotency key UUID.
- State empty có CTA “Tạo phiên đầu tiên”; đầy capacity chỉ disable Create, mọi phiên hiện tại vẫn dùng được. Idle/exited/error không có input; item stopping disable kill/restart tới khi kết thúc hoặc xuất hiện lỗi stopTimedOut. Gửi lại mutation sau lỗi mạng giữ cùng key/body; không âm thầm phát key mới.

### 8.6 Draft và status

- Draft A/B độc lập, switch A → B → A giữ đúng nội dung.
- Process status: `Đang chạy`, `Đang dừng`, `Đã kết thúc`, `Lỗi khởi chạy`.
- Connection status: `Đang kết nối`, `Đang đồng bộ`, `Đã kết nối`, `Mất kết nối`, `Không còn phiên`.
- Không dùng một chữ “đã dừng” cho mọi state.
- Kill/restart confirmation phải ghi tên phiên, agent và thư mục tương đối.
- Sau FCM attention: badge “Có nhắc phản hồi” và thời gian, không coi đó là trạng thái chắc chắn đang chờ. Backend chỉ biết đã phát event, không biết người dùng đã hoàn tất approve. Mở/ẩn banner chỉ đánh dấu đã xem trên tab, không phát input, không sửa state running thành waiting.
- Nếu process error/spawn_error, UI dùng message đã sanitize, không đưa đường dẫn credential/câu lệnh shell lên error banner.

---

## 9. Shift + ← cho Codex

Chỉ sửa `web/src/components/QuickActions.tsx`, wiring trong `web/src/App.tsx` và assertion `scripts/smoke-multi-session.cjs` cho tính năng này; dùng Session type đã có.

Yêu cầu bắt buộc:

1. Constant chính xác: `"\x1b[1;2D"`.
2. QuickActions nhận `agentId`, `onSendKey` riêng.
3. Render nút chỉ khi `activeSession.agentId === "codex"`.
4. Nút gửi `onSendKey("\x1b[1;2D")`, không gọi hàm shortcut flush draft.
5. `onPointerDown.preventDefault()` để giữ focus mobile.
6. Disabled khi không connected/controller, session không running hoặc đang switch/sync. Không chặn Shift + ← của textarea vì đó vẫn là chọn chữ; nút toolbar là đường gửi phím riêng. Khi focus xterm, giữ cách xterm xử lý bàn phím vật lý.
7. Tooltip/ARIA tiếng Việt: “Shift + mũi tên trái — trả lời câu hỏi Codex”.
8. Không tự động gửi Enter, không tự động approve, không hiển thị nút trong form agent khác.

Test bắt buộc: Codex có nút; shell/Claude/Gemini/OpenCode không có; draft vẫn giữ; spy nhận đúng chuỗi byte; nút disabled khi mất socket.

---

## 10. Firebase Cloud Messaging

### 10.1 Dependency được phép

Danh sách này bao gồm dependency terminal của Phase 2 và Firebase của Phase 6–7. Chỉ thêm bằng npm workspaces, pin exact; không nâng xterm/React/Vite hoặc dependency hiện có:

```text
server: @xterm/headless@5.5.0, @xterm/addon-serialize@0.13.0
server: firebase-admin@14.4.0
web: firebase@12.19.0
web dev: esbuild@0.27.2
```

Chạy từng lệnh ở phase tương ứng, không chạy song song các lệnh sửa lockfile:

```bash
npm install --workspace server --save-exact --ignore-scripts --no-audit --no-fund @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
npm install --workspace server --save-exact --ignore-scripts --no-audit --no-fund firebase-admin@14.4.0
npm install --workspace web --save-exact --ignore-scripts --no-audit --no-fund firebase@12.19.0
npm install --workspace web --save-dev --save-exact --ignore-scripts --no-audit --no-fund esbuild@0.27.2
```

Không dùng CDN script, không chạy lại lifecycle script node-pty hoặc cài CLI toàn cục. Nếu version/engine/API không tương thích, báo bằng chứng và dừng phần phụ thuộc; không tự đổi version. Kiểm tra diff lockfile chỉ bao gồm các dependency trên và dependency bắc cầu cần thiết.

### 10.2 Environment/config

Thêm vào `.env.example` giá trị tắt an toàn:

```env
FCM_ENABLED=false
FIREBASE_API_KEY=
FIREBASE_PROJECT_ID=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
FIREBASE_VAPID_PUBLIC_KEY=
FIREBASE_SERVICE_ACCOUNT_FILE=
# Không đặt thì dùng <WEB_CLI_AUTH_DIR>/push
# FCM_DATA_DIR=/var/lib/server-hub/web-cli-push
```

Rules:

- `FCM_ENABLED` vắng hoặc `false`: API config trả disabled, không đọc service account/khởi tạo Admin/store. Không phụ thuộc Firebase để chạy terminal.
- `FCM_ENABLED=true`: thiếu field, service-account JSON không hợp lệ, project mismatch hoặc store lỗi thì fail fast trước listen, chỉ nêu tên field/lỗi đã sanitize.
- VAPID public key phải decode base64url thành uncompressed P-256 public key 65 byte, byte đầu `0x04`. Không nhầm VAPID private key với public key.
- Service account nằm ngoài repo/public release, directory `0700`, file `0600`; project_id phải bằng `FIREBASE_PROJECT_ID`. Backend dùng credential này, không truyền vào child env.
- Web config chỉ có `apiKey`, `projectId`, `messagingSenderId`, `appId`; VAPID public key trả riêng. Không trả credential JSON/file path/FID danh sách thiết bị.
- `FCM_DATA_DIR` mặc định là `path.join(config.authDataDir, "push")`; cấu hình test dùng thư mục tạm riêng.
- Sửa `deploy/install-server-hub.sh` đúng một mục đích: chỉ tạo env mặc định khi chưa tồn tại, giữ toàn bộ env hiện có. Chỉ sửa script và kiểm tra `bash -n`, không chạy deploy.

### 10.3 Luồng đăng ký thiết bị

Các route sau là route nội bộ; URL browser thêm prefix `/api/web-cli`. Tất cả giữ auth/Origin/secure transport hiện có, body tối đa 4 KiB:

| Method + route | Input | Kết quả |
| --- | --- | --- |
| GET `/api/notifications/config` | Không có | `{enabled:false,supportedAgents:["codex"]}` hoặc `{enabled:true,supportedAgents:["codex"],firebaseConfig,vapidPublicKey}` |
| POST `/api/notifications/devices` | `{deviceId:UUID,fid:string}` | `200 {ok:true,expiresAt}` sau khi store đã persist |
| DELETE `/api/notifications/devices/:deviceId` | UUID | `200 {ok:true}`; lặp lại vẫn thành công |
| POST `/api/notifications/test` | `{deviceId:UUID}` | `202 {queued:true,eventId}`; chỉ device thuộc auth scope hiện tại, không có nghĩa đã giao thành công |

FCM disabled: mutation trả `409 notifications_disabled`. Sai schema trả 400, không auth 401, sai Origin 403, store không ghi được 503, vượt 16 device hoặc rate limit trả 429. Device test không thuộc scope trả 404. Không tạo API gửi tới FID/URL bất kỳ.

**Client, làm theo thứ tự:**

1. Kiểm tra HTTPS/localhost, ServiceWorker, Notification, PushManager và Firebase `isSupported()`. Không hỗ trợ thì hiển thị hướng dẫn, disable Bật; không request permission tự động.
2. Trong click Bật, gọi `Notification.requestPermission()` trực tiếp trong user gesture. Sau khi granted mới register service worker và Firebase.
3. Dùng Firebase modular FID API: gắn `onRegistered(messaging, callback)` trước `register(messaging, {vapidKey,serviceWorkerRegistration})`. Không trộn `getToken()`/token cũ với FID API. Đây là API theo [hướng dẫn Firebase Web](https://firebase.google.com/docs/cloud-messaging/web/get-started).
4. `deviceId` UUID ổn định trong localStorage; callback nhận FID rồi POST đăng ký. SDK không chờ Promise callback: app phải tự giữ Promise đăng ký, await/catch và chỉ báo Đã bật sau server 200. Validate FID là 22 ký tự base64url, ký tự đầu thuộc `c,d,e,f` theo SDK đã pin.
5. Chỉ lưu consent=true sau đăng ký thành công. Khi mở app và đã auth, permission vẫn granted và consent=true thì refresh registration/TTL. Không lưu FID/token vào UI log.
6. Tắt: tăng generation để chặn callback đăng ký muộn, await DELETE server, gọi Firebase `unregister(messaging)`, cleanup listener và xóa consent. Nếu lỗi phải hiển thị Lỗi tắt, cho retry; không báo đã tắt khi revoke chưa thành công.
7. Có guard single-flight và cleanup effect để React StrictMode không nhân đôi register/onMessage/onRegistered; logout/disable invalidates callbacks đang chờ.

**Store và revoke:**

- `pushStore.ts` lưu JSON version 1 gồm `projectId`, tối đa 16 devices: `deviceId`, `fid`, `webAuthScope`, `hubAuthScope?`, `registrationVersion` UUID, `expiresAt` 30 ngày. Scope là hash từ session key hiện có, không cookie/raw credential. File tối đa 64 KiB; directory 0700, file 0600; ghi temp+rename tuần tự, không ghi đè đồng thời. Không bỏ qua lỗi parse/version/project mismatch khi enabled.
- Upsert cùng device thay record; cùng FID ở device khác thì chuyển sang record mới để tránh gửi đôi. Prune expired trước giới hạn 16; không tự evict device còn hiệu lực để nhận device thứ 17. Persist trước khi trả thành công.
- Explicit Web CLI logout revoke web scope; Hub logout revoke hub scope; Hub password change revoke tất cả. Capture scope khi session còn hợp lệ; await revoke trước bước xóa auth/cookie. Password change chỉ revoke sau khi xác minh mật khẩu cũ thành công, trước commit mật khẩu mới. Revoke lỗi thì trả 503, không báo logout/change thành công; không đưa credential vào log.
- Browser xóa consent sau logout thành công ở cả Web CLI và Hub; không auto đăng ký lại trong callback muộn. Auth hết hạn tự nhiên không revoke device, vì push phải hoạt động khi đóng trang; lần đăng nhập hợp lệ tiếp theo mới refresh scope.
- Job lấy snapshot `deviceId + fid + registrationVersion`; trước send phải đối chiếu record còn hợp lệ. Lỗi FCM invalid-registration chỉ xóa nếu tuple vẫn khớp; không xóa FID mới vừa rotate. Không hứa thu hồi notification đã được FCM chấp nhận trước logout.

### 10.4 Nguồn attention event

- Tạo `server/src/attention.ts` parser streaming OSC 9, xử lý chunk boundary, BEL/ST/C1 OSC. Payload tối đa 4096 ký tự; overflow bỏ tới terminator, không tích lũy vô hạn. Bỏ OSC khác, plain text và malformed sequence.
- Chỉ bật detector cho `agentId === "codex"` khi `FCM_ENABLED=true`.
- Khi spawn Codex interactive mới, thêm các cặp argv dưới đây trước dấu `--` nếu có. Mỗi dòng là hai phần tử argv (`-c`, chuỗi cấu hình), không ghép shell command:

```text
-c tui.notifications=["approval-requested","plan-mode-prompt"]
-c tui.notification_method="osc9"
-c tui.notification_condition="always"
```

- Không sửa Codex global config, approval policy, sandbox hoặc tự restart PTY đang chạy để áp config. Nếu config `codex` là wrapper/non-interactive `exec` không nhận argv này, báo không tương thích; không sửa wrapper ngoài scope.
- `AttentionDetector` chỉ phát metadata. Mỗi session tối đa 1 event mỗi 2 giây; event dư trong cửa sổ bị bỏ, không tạo timer/queue vô hạn. Gắn detector vào raw PTY output, không replay snapshot vào detector.
- SessionManager cập nhật `attention`, metadata revision, phát event cho WS và dispatcher; không cần browser đang mở. Dispatcher lỗi không làm output/lifecycle fail.
- OSC từ terminal là tín hiệu không tin cậy và có thể bị CLI giả lập; chỉ dùng cho thông báo generic có giới hạn, tuyệt đối không dùng làm quyết định auth/approve.
- [OpenAI Codex advanced config](https://developers.openai.com/codex/config-advanced/) mô tả TUI notification/OSC9. `plan-mode-prompt` được thấy trong binary Codex 0.155.1 tại host; đây là điểm cần test với CLI thực tế, không suy diễn rằng mọi phiên bản hỗ trợ mọi câu hỏi. Fixture OSC chỉ kiểm chứng adapter, chưa chứng minh Codex thật phát event.
- Agent khác không gửi attention trong bản này. Nếu câu hỏi thực tế không phát event, ghi blocker tương thích Codex; không fallback regex nội dung màn hình.

### 10.5 Notification event/payload

Event nội bộ:

```ts
type AttentionEvent = {
  type: "attention";
  eventId: string;
  sessionId: string;
  createdAt: string;
};
```

FCM gửi data-only, chỉ có các field trên, tất cả là string. Backend chọn người nhận bằng FID theo API public Admin SDK đã pin; không dùng `notification` block tự hiển thị để tránh gửi trùng với service worker. Notification hiển thị:

```text
Title: Codex cần bạn phản hồi
Body: Mở Web CLI để xem yêu cầu xác nhận hoặc câu hỏi.
```

Không hiển thị ID, prompt, lệnh, agent output hoặc tên thư mục trên lock screen. Gửi thử dùng `type:"test"`, UUID eventId, `sessionId:""`, timestamp; title “Thông báo thử Web CLI”, body “Thiết bị đã nhận thông báo thử.”; không giả tạo một session/attention.

### 10.6 Dispatcher và shutdown

- Queue tối đa 128 job chờ, concurrency 2, mỗi job là một event/device. TTL 300 giây kể từ event; đầy thì drop job mới + tăng counter, không block PTY. Test push giới hạn 1 lần/30 giây/device, server thực thi.
- Trước send: bỏ job hết TTL, session attention đã bị thay bởi event mới/session không còn running hoặc registration tuple không còn khớp. Test event không kiểm tra session. Gửi WebPush TTL bằng số giây còn lại, Urgency high.
- Dùng sender abstraction inject fake sender cho test; production dùng `firebase-admin` public API. Không await mạng/store trong callback PTY. Mọi Promise queue/send/cleanup đều có catch/finally.
- Không thêm application retry: SDK đã có retry nội bộ hữu hạn. SDK đã kiểm tra có timeout HTTP 15 giây và tối đa 4 retry nội bộ; 15 giây không phải deadline tổng vì còn auth/retry. Không sửa SDK private fields hoặc cộng thêm một vòng retry bên ngoài.
- Watchdog job 30 giây ghi slow một lần; không giải phóng permit khi SDK Promise còn pending, vì Promise.race không hủy HTTP thật. Giữ tối đa 2 SDK send thực sự in-flight; queue vẫn bounded nếu cả hai bị treo. Khi Promise settle mới release permit; không gọi sender mới để thay một call chưa kết thúc.
- Invalid FID revoke đúng tuple; lỗi cuối log code whitelist, không log object error/request đầy đủ. Counters: accepted, sent (SDK accepted, không phải đã hiển thị), failed, dropped, slow, queueDepth, inFlight.
- Shutdown đặt closing trước await, không nhận thêm job, drop queue chờ, chờ in-flight/cleanup tối đa tổng 2 giây rồi nhường deadline shutdown chung. Cleanup Firebase app không được coi là chắc chắn hủy HTTP; Promise còn lại vẫn có rejection handler. Không chờ FCM vô hạn trước dừng server.
- Device store bền vững qua restart; queue notification chỉ ở RAM và không replay sau restart. Đây là delivery best effort, không hứa exactly-once hoặc giao thông báo khi OS/browser chặn. Cảnh báo lỗi/drop dùng log/counter hiện có; không thêm Redis, DLQ service hoặc dashboard mới.

### 10.7 Service worker và deep link

**Build/serve:**

1. Tạo worker TypeScript và bundle local thành `web/dist/firebase-messaging-sw.js` bằng esbuild, browser IIFE target es2022. Worker tsconfig dùng `ES2022,WebWorker`, `types:[]`, `noEmit:true`, `skipLibCheck:true`, không import React/DOM app.
2. Script build web: `tsc -b && tsc -p tsconfig.worker.json && vite build && node scripts/build-push-worker.mjs`; script check bổ sung `tsc -p tsconfig.worker.json`. Build worker sau Vite vì Vite xóa dist. Không commit dist hoặc hardcode Firebase project vào bundle.
3. URL public browser cố định `/api/web-cli/firebase-messaging-sw.js`, scope `/api/web-cli/`. Route nội bộ sau rewrite là `/firebase-messaging-sw.js` ở standalone, `/cli/firebase-messaging-sw.js` khi Hub bật; `/cli` là route nội bộ, không dùng làm URL đăng ký trên browser.
4. `staticAssets.ts` serve đúng MIME JavaScript, `Cache-Control:no-store`, `Service-Worker-Allowed:/api/web-cli/`; inject public config đã validate bằng JSON.stringify an toàn, không chèn secret. Disabled trả worker vô hiệu hóa notification handler, không khởi tạo Firebase. Auth whitelist chỉ exact worker/manifest/icon routes này; không public API hoặc toàn bộ `/cli`.
5. Manifest serve tại `/api/web-cli/manifest.webmanifest`, `id/start_url/scope` đều `/api/web-cli/`, `display:standalone`; icon SVG và PNG 192/512 cùng origin. Dùng biểu tượng terminal đơn giản từ SVG tự tạo, không thêm thư viện tạo ảnh. Thêm manifest/icon link trong web/index.html. Không thêm cache API/auth response hoặc chế độ terminal offline.
6. CSP giữ chính sách cũ; thêm `worker-src 'self'` và chỉ thêm `https://firebaseinstallations.googleapis.com`, `https://fcmregistrations.googleapis.com` vào connect-src. Không mở `*`, unsafe-inline cho script hoặc CDN.

**Nhận/click:**

1. Đăng ký custom `notificationclick` trước Firebase handler; theo [Firebase receive messages](https://firebase.google.com/docs/cloud-messaging/web/receive-messages), dùng onMessage foreground và onBackgroundMessage trong worker. Worker phải đưa Promise show/focus/openWindow vào vòng đời event, không fire-and-forget.
2. Chỉ nhận `attention` có eventId/sessionId UUID hợp lệ, hoặc `test` có sessionId rỗng; createdAt không cũ quá 300 giây, không vượt tương lai 60 giây. Bỏ payload khác. Dùng notification tag eventId và cache dedup tối đa 100 ID trong RAM; không ghi prompt/token vào cache.
3. Foreground: banner generic có nút Mở phiên, không tự chuyển active, không gọi showNotification lần hai. Background/page closed: worker showNotification generic một lần; không cần React/WS tồn tại.
4. Click attention: URL tự xây từ origin cố định + `/api/web-cli/#session=<uuid>`; không dùng URL nhận từ payload. Focus client cùng origin/path nếu có rồi postMessage `{type:"web-cli-open-session",sessionId}`; nếu không còn client, openWindow URL trên. Click test mở Web CLI không hash.
5. App nhận message/hash ngay cả lúc chưa auth; chỉ chọn session sau auth + GET list. Listener cleanup khi unmount; không reload trang đang mở làm mất draft. Session không tồn tại: báo “Phiên không còn trên máy chủ” và mở Session Manager, không create và không tự chọn phiên khác.
6. Hub redirect tới `/login` phải giữ hash UUID hợp lệ. `api.ts` khi redirect Hub login nối đúng hash session hợp lệ; `hub/public/app.js` sau login có hash hợp lệ thì tới `/api/web-cli/#session=<uuid>`, không có hash thì giữ navigation `/` như cũ. Không thêm returnUrl tùy ý. Web CLI login/TOTP giữ hash đến lúc đã xử lý target.
7. Test browser thật luồng HTTP redirect 303 → Hub login → Web CLI TOTP → đúng session. Không chỉ unit test hàm parse hash rồi coi flow đã pass.

Đóng trang là tiêu chí nghiệm thu. Đóng hoàn toàn/force-stop browser, OS tiết kiệm pin hoặc thu hồi permission có thể ngăn push; không hứa vượt chính sách nền của hệ điều hành. iOS/iPadOS cần web app đã Add to Home Screen và phiên bản có Web Push ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)); ghi hướng dẫn này trong UI unsupported và docs, không coi tab Safari thông thường là môi trường nghiệm thu tương đương PWA.

### 10.8 UI push settings

Trong Session Manager/settings hiển thị các trạng thái:

```text
Chưa cấu hình Firebase
Trình duyệt chưa hỗ trợ — có hướng dẫn
Chưa bật trên thiết bị
Đang đăng ký / Đang tắt
Đã bật
Quyền bị chặn
Lỗi đăng ký
Lỗi tắt thông báo
```

Có nút `Bật thông báo`, `Tắt trên thiết bị này`, `Gửi thử`. Gửi thử chỉ gửi tới device hiện tại và không tạo attention giả trong session.

Thông báo giới hạn hiện tại: “Yêu cầu xác nhận/câu hỏi từ Codex; các agent khác chưa hỗ trợ.” Permission denied hướng dẫn mở site settings, không lặp requestPermission. Disabled config không hiện lỗi đỏ cho terminal. Nút Gửi thử chỉ enabled khi server đã xác nhận đăng ký; 202 hiển thị “Đã xếp hàng gửi thử”, không báo “Đã nhận”.

### 10.9 Cấu hình owner cần chuẩn bị

| Owner chuẩn bị | Đưa vào đâu | Ghi chú |
| --- | --- | --- |
| Firebase project + Web App | 4 field FIREBASE_API_KEY/PROJECT_ID/MESSAGING_SENDER_ID/APP_ID | Cùng một project, có FCM Registration API hoạt động |
| Web Push certificate/VAPID public key | FIREBASE_VAPID_PUBLIC_KEY | Không gửi private key cho frontend |
| Admin service account JSON có quyền gửi FCM | File riêng ngoài repo; env chỉ trỏ đường dẫn | Không dán private key vào chat hoặc commit |
| Domain HTTPS dùng truy cập Web CLI | Môi trường do owner quản lý | Giữ route worker/manifest đúng same-origin; không đổi proxy trong task này |
| Browser/device thử + quyền notification | Đăng ký từ nút Bật sau login | Thử desktop và thiết bị mobile thực tế cần dùng |

Không có config thật vẫn phải hoàn tất code + mock tests. Báo `CODE_READY / LIVE_FCM_PENDING`; không giả lập live pass, không bắt owner chuẩn bị Firebase trước khi sửa multi-session.

---

## 11. Thứ tự thực thi và phase gate

Làm tuần tự Phase 0 → 8. Mỗi phase ghi kết quả vào `docs/agile/changes/multi-session-validation.md`; đây là file báo cáo chung được phép sửa ở mọi phase. Không tạo story/ADR khác hoặc thay bản master để né gate. Các checklist dưới đây là công việc triển khai tương lai, không phải xác nhận đã làm.

### Phase 0 — Baseline, không đổi behavior

Files: chỉ tạo/cập nhật báo cáo validation.

- [ ] Đọc `AGENTS.md`, bản master, code tại mục 5 và package-lock; ghi commit hiện tại, `git status --short`, danh sách file đang dirty/untracked. Không in nội dung `.env`/credential.
- [ ] Chạy `npm test`, `npm run check`, `npm run build`, `git diff --check`; ghi lệnh, exit code và failure có sẵn.
- [ ] Đọc smoke script hiện có để dùng lại setup auth/TOTP và Chrome; ghi tool nào thiếu. Không cài dependency ngoài mục 10.1 để sửa môi trường.
- [ ] Ghi kịch bản regression S01–S04 và race frontend để viết test ở phase liên quan; ghi rõ lỗi đã tái hiện hay mới là rủi ro từ phân tích, không tự nhận đã tìm ra duy nhất root cause.

Gate: có baseline và danh sách thay đổi cần bảo toàn. Baseline failure ngoài scope không cho phép sửa lan; tiếp tục phần độc lập, báo failure đó, không gọi final gate pass nếu check còn fail. Thiếu Firebase thật không phải blocker Phase 1–7.

### Phase 1 — Backend lifecycle và metadata

Files: `server/src/sessionManager.ts`, `server/src/config.ts`, `server/src/httpErrors.ts`, `server/src/idempotency.ts`, `server/test/sessionManager.test.ts`, `server/test/idempotency.test.ts`, `server/test/fixtures/terminal-agent.cjs`, `.env.example`.

- [ ] Thêm metadata/epoch/registry revision/cwd identity ở mục 7.1; giữ PublicSession field cũ. Chưa có terminalState thì outputLastSeq tạm bắt đầu 0, Phase 2 nối sequence thật.
- [ ] Thêm fixture CLI deterministic nhận marker, in cwd, trả input dạng hex, phát ANSI/OSC theo lệnh test; không gọi agent/network thật và không sửa file project người dùng.
- [ ] Tách đường merge metadata khỏi lifecycle; mỗi session vẫn UUID/PTY riêng, không key map bằng agentId/project/cwd.
- [ ] Làm state transition/reason/stop watchdog; `kill()` lặp không gia hạn timer. Dùng PTY double kiểm chứng không exit sau SIGKILL.
- [ ] Làm restart lock, slot reservation và relationship old/new. Kiểm tra race restart A với create B khi đầy; release slot đúng cả spawn fail/path fail.
- [ ] Viết idempotency store theo mục 7.3; namespace route phải gồm ID thực của session, không dùng nguyên mẫu `:id` khiến restart A/B trùng namespace.
- [ ] Thêm retention 50, event removed, idle theo input/output, close idempotent và cleanup listeners/timers. Không tăng default capacity.

Validation: `npm --workspace server run check`, `npm test`. Gate S01–S15 ở mức SessionManager/idempotency; test API chưa wiring ở phase này được hoàn tất Phase 2, nhưng unit lifecycle/idempotency phải pass trước khi tiếp tục.

### Phase 2 — API và WebSocket contract

Files: `server/src/index.ts`, `server/src/sessionRoutes.ts`, `server/src/websocket.ts`, `server/src/terminalState.ts`, `server/src/sessionManager.ts`, `server/src/httpErrors.ts`, `server/package.json`, `package-lock.json`, `server/test/terminalState.test.ts`, `server/test/multiSessionApi.test.ts`, `server/test/websocket.test.ts`, `server/test/auth.test.ts`.

- [ ] Cài riêng 2 package xterm ở mục 10.1; kiểm tra ESM/types tương thích. Implement terminalState serial queue/barrier/backpressure/final snapshot.
- [ ] Tách đăng ký session routes để Fastify inject test được; giữ nguyên auth hook order. GET projects/browse thêm cwd identity; không thay allowlist path.
- [ ] Wire create/restart idempotency sau auth/schema; trả epoch/revision/capacity, error code và validation đúng mục 7. Test request legacy không có key còn chạy.
- [ ] Ticket negotiate v1/v2; v1 giữ format cũ, v2 snapshot/chunk/sync/seq. Không bắt frontend cũ hiểu message v2.
- [ ] Implement controller/viewer, transfer khi close/auth-expire; mỗi input/resize check auth + owner trước PTY.
- [ ] Wire removed/exit/state, giới hạn buffer socket, cleanup attach; snapshot drain có deadline, seq gap có thể phục hồi bằng reconnect.
- [ ] Wiring shutdown đồng thời WS/PTY theo mục 7.5; Phase 6 thêm dispatcher vào cùng cơ chế, không tăng global deadline.

Validation: `npm --workspace server run check`, `npm test`. Gate S01–S15 + W01–W04/W06–W10; W05 thuộc frontend Phase 3; v1/v2 output đúng một lần, restoration normal/alternate/cursor/modes pass, không tăng socket/buffer limit để qua test.

### Phase 3 — Frontend state và attach safety

Files: `web/src/features/sessions/sessionTypes.ts`, `sessionReducer.ts`, `useSessions.ts` trong cùng thư mục đó; `web/src/App.tsx`, `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/components/TerminalPane.tsx`, `web/src/components/ProjectSelector.tsx`, `server/test/sessionReducer.test.ts`, `scripts/smoke-multi-session.cjs`.

- [ ] Tạo type/reducer thuần, không React/browser import trong reducer; server test dùng tsx import reducer để kiểm chứng action ordering, không thêm test framework.
- [ ] Thay updateSession vừa merge vừa select bằng upsert và setActive riêng. Upsert/list stale guard dùng entity/registry revision; hoạt động frontend cũ giữ được trong lúc chuyển state model.
- [ ] Implement auth/selection/connection generation riêng, synchronous input gate, per-tab sessionStorage và per-session draft.
- [ ] API error giữ status/code; manual mutation retry giữ body/key, GET polling/backoff/AbortController theo mục 8.2.
- [ ] TerminalPane dùng ticket v2, sequential xterm write/sync callbacks, seq validation, viewer grid, reconnect; disable composer tới khi sync complete + controller.
- [ ] ProjectSelector abort + sequence, disable chọn folder chưa resolve. Không tự select session khi browse hoặc khi response của phiên cũ tới.
- [ ] Tạo smoke script với fixture/auth thật trong môi trường tạm: A/B/A, delayed metadata, draft isolation, disconnect/reload và 2 tab.

Validation: `npm run check`, `npm test`, `npm run build`, `node scripts/smoke-multi-session.cjs`. Gate W05/W08/W09/W10 và U01–U05/U10–U13 bằng assertion hành vi; không chỉ so constant hoặc snapshot JSX.

### Phase 4 — Session Manager desktop/mobile

Files: `web/src/components/SessionManager.tsx`, `SessionList.tsx`, `SessionItem.tsx`, `NewSessionDialog.tsx`, `SessionControls.tsx`, `ProjectSelector.tsx` trong cùng thư mục components; `web/src/App.tsx`, `web/src/index.css`, `scripts/smoke-multi-session.cjs`, `scripts/smoke-mobile.cjs`, `scripts/smoke-touch-scroll.cjs`, `scripts/smoke-hub.cjs`.

- [ ] Desktop sidebar/mobile dialog đúng mục 8.3–8.4, giữ một TerminalPane/xterm khi đổi breakpoint.
- [ ] Item có status/agent/folder/name/ID và action theo sessionId; search/filter/group chỉ tác động list.
- [ ] NewSessionDialog có form riêng, canonical folder, capacity, same-folder warning và pending/error. Reuse agent selector hiện có, không redesign settings/auth.
- [ ] Kill/restart confirmation ghi đúng session; action response merge đúng ID, không kéo focus/active khi người dùng đã chuyển.
- [ ] Empty/missing/stopping/error/viewer/stopTimedOut có copy theo spec; loại bỏ đường create/restart trùng ở SessionControls. Chỉ xóa component cũ nếu `rg` xác nhận không còn import, không xóa behavior còn dùng.
- [ ] Kiểm chứng tab order, Escape/backdrop, focus return, touch 44px, safe-area và keyboard viewport. Update selector smoke cũ theo UI mới, giữ assertion auth/scroll/composer.

Validation: `npm run check`, `npm run build`, `node scripts/smoke-multi-session.cjs`, `node scripts/smoke-mobile.cjs`, `node scripts/smoke-touch-scroll.cjs`, `node scripts/smoke-hub.cjs`. Gate U01–U07/U10–U13, mobile không horizontal page overflow và không có 2 dialog mở.

### Phase 5 — Shift + ←

Files: `web/src/components/QuickActions.tsx`, `web/src/App.tsx`, `scripts/smoke-multi-session.cjs`.

- [ ] Thêm nút conditional Codex và onSendKey theo mục 9, không đi qua flushDraft.
- [ ] Test với 2 session id khác nhau cùng agentId codex; trên B gửi phím thì fixture B nhận `1b5b313b3244`, A không nhận, textarea B còn nguyên draft.
- [ ] Test shell/agent khác không có nút; reconnect/viewer/sync disabled; bấm không gửi Enter.

Validation: `npm run check`, `npm run build`, `node scripts/smoke-multi-session.cjs`. Gate U08/U09; kiểm tra cả frame WS và input mà fixture PTY nhận.

### Phase 6 — Attention detector và FCM backend

Files: `server/src/attention.ts`, `pushConfig.ts`, `pushStore.ts`, `pushDispatcher.ts`, `push.ts`, `sessionManager.ts`, `config.ts`, `index.ts`, `webAuth.ts`, `hubAuth.ts` trong server/src; `server/test/attention.test.ts`, `pushRoutes.test.ts`, `pushDispatcher.test.ts`, `auth.test.ts`, `hub.test.ts`, `fixtures/terminal-agent.cjs` trong server/test; `server/package.json`, `package-lock.json`, `.env.example`, `deploy/install-server-hub.sh`.

- [ ] Cài firebase-admin ở mục 10.1. Config disabled không đọc credentials, enabled validate trước listen.
- [ ] Implement streaming detector/cooldown/argv local; test argv bằng fixture được gắn agentId codex, OSC split/overflow/false positives.
- [ ] Implement bounded private store, schema API + auth, serialized atomic persistence; inject file dir/temp clock cho test.
- [ ] Implement sender queue concurrency/TTL/revoke tuple/watchdog/shutdown; fake sender có resolve/reject/hang. Không gửi FCM thật trong npm test.
- [ ] Hook logout/password revoke khi scope còn hợp lệ; test wrong password không revoke, expiry vẫn nhận generic push, explicit logout không còn job mới.
- [ ] Wire SessionManager attention → metadata/WS/dispatcher độc lập browser; queue lỗi không đổi session state.
- [ ] Env example và installer chỉ thay đúng phần preserve existing env. Đọc child env allowlist để chắc không lọt FIREBASE/FCM credentials.

Validation: `npm --workspace server run check`, `npm test`, `bash -n deploy/install-server-hub.sh`, `git diff --check`. Gate P01–P09/P15/P17; không có raw error/credential leak hoặc unhandled rejection.

### Phase 7 — FCM web worker và UI

Files: `web/src/lib/push.ts`, `web/src/lib/api.ts`, `web/src/components/NotificationSettings.tsx`, `web/src/components/SessionManager.tsx`, `web/src/App.tsx`, `web/src/index.css`, `web/worker/firebase-messaging-sw.ts`, `web/tsconfig.worker.json`, `web/scripts/build-push-worker.mjs`, `web/index.html`, `web/public/icon.svg`, `web/public/icon-192.png`, `web/public/icon-512.png`, `web/public/manifest.webmanifest`, `web/package.json`, `package-lock.json`, `server/src/staticAssets.ts`, `server/src/index.ts`, `server/src/webAuth.ts`, `server/src/hubAuth.ts`, `hub/public/app.js`, `server/test/auth.test.ts`, `server/test/hub.test.ts`, `scripts/smoke-notifications.cjs`, `scripts/smoke-hub.cjs`.

- [ ] Cài firebase/esbuild theo mục 10.1; implement worker build/check, icons/manifest/public routes/CSP đúng 10.7.
- [ ] Implement browser register consent/generation/error flow và UI settings; không request permission lúc mount.
- [ ] Implement foreground banner, worker data validation/showNotification/tag, custom click listener và App postMessage/hash handler.
- [ ] Giữ hash qua Hub login và Web CLI TOTP; chỉ redirect local URL cố định, chỉ whitelist exact static resources. Kiểm tra protected REST/WS vẫn 401 khi không auth.
- [ ] Tạo smoke-notifications có chế độ mock mặc định, fake notification payload và receiver để test rendering/deep link; không thêm test-only route gửi push trong production.
- [ ] Test disable/logout ngay trong lúc registration Promise pending; callback muộn không re-register/đổi UI thành Đã bật.

Validation: `npm test`, `npm run check`, `npm run build`, `node scripts/smoke-notifications.cjs`, `node scripts/smoke-hub.cjs`. Gate P10–P17 bằng mock/browser; P18/P19 cần thiết bị/FCM/Codex thật ở Phase 8, chưa được gán PASS giả.

### Phase 8 — Regression, docs và release evidence

Files: `scripts/smoke-multi-session.cjs`, `scripts/smoke-notifications.cjs`, `README.md`, `docs/firebase-push.md`, `docs/agile/changes/multi-session-validation.md`. Regression do phase trước gây ra chỉ sửa trong allowlist của phase đó và chạy lại gate tương ứng.

- [ ] Chạy final command set mục 12; đính kèm kết quả theo ID test, phân biệt mock và live.
- [ ] Kiểm chứng smoke nhiều session theo kịch bản mục 12.5, teardown sạch, không chạm service/dữ liệu thật.
- [ ] Đo bounded memory/listeners/socket khi churn; log/drop/slow được sanitize, giữ default cap và một socket visible/tab.
- [ ] Viết README behavior mới, shortcut, idle/restart limitations; docs/firebase-push.md hướng dẫn owner tạo config, đăng ký, test đóng trang, revoke, disabled/rollback và hạn chế iOS.
- [ ] Nếu đã có cấu hình thật và owner giao kiểm chứng trên môi trường test, thực hiện P18/P19, ghi browser/OS/Codex version và quan sát. Chưa có thì đánh dấu LIVE_FCM_PENDING/LIVE_CODEX_PENDING tương ứng, không tự bật production.
- [ ] Kiểm tra diff chỉ có thay đổi được giao; báo file baseline giữ nguyên. Không commit/push/deploy/restart.

Gate: `CODE_READY` chỉ khi toàn bộ gate code/mock/browser đạt; `RELEASE_READY` chỉ sau live FCM + Codex compatibility và owner review đạt. Nếu thiếu điều kiện môi trường, hoàn tất phần độc lập và báo đúng item pending; không gọi cả công việc “đã xong hoàn toàn”.

---

## 12. Ma trận kiểm thử bắt buộc

Agent phải chạy test theo phase và ghi ID, command, exit code, môi trường, kết quả vào báo cáo. Unit/integration chạy loopback và fixture; browser smoke dùng port ephemeral. Trước mỗi smoke: `ss -lntp` để biết port; không dừng process không thuộc test. Không dùng live Codex/FCM để thay test deterministic.

### 12.1 Backend/session — bắt buộc

| ID | Tình huống và setup | Kết quả phải assert |
| --- | --- | --- |
| S01 | Hai `codex` cùng project root + cùng subpath, fixture marker A/B | UUID, PTY, output marker, session metadata độc lập; cả hai không kill nhau |
| S02 | Codex + shell cùng cwd | Tạo được cả hai; kill/restart một không đổi state/output/seq của kia |
| S03 | Agent khác nhau, cwd khác nhau | `rootProjectLabel`, `canonicalSubpath`, `workingDirectoryId` đúng; không lộ absolute path |
| S04 | Cùng loại agent, khác cwd (root hoặc subpath khác) | IDs thư mục khác; warning chỉ khi cùng canonical cwd |
| S05 | Symlink/traversal/file thay folder | Create/restart bị lỗi `invalid_subpath`/`path_not_found`/`path_traversal`; không spawn, không chiếm slot |
| S06 | Capacity max=3, active=3 | Create trả 429 `session_capacity_reached`; ba session cũ vẫn running; reserved tính đúng |
| S07 | Restart khi capacity đầy | Restart giữ slot của A, create khác không lấy slot; replacement chỉ có một ID |
| S08 | Hai restart cùng key song song | Một side effect, hai caller nhận cùng status/body; entry đặt trước side effect |
| S09 | Hai key restart khác nhau song song | Key thứ hai 409 `session_operation_in_progress`; không tạo replacement thứ hai |
| S10 | Cùng key/route nhưng body khác; cùng key với route session khác | Body khác trả 409 `idempotency_conflict`, không chạy action; route khác có namespace riêng, không replay nhầm kết quả A cho B |
| S11 | Retry create sau client timeout | Cùng key/body replay kết quả; không nhân đôi PTY; 401/403/schema không bị cache |
| S12 | Spawn lỗi/path đổi sau browse | Session `error/spawn_error` có ID; reservation/slot release đúng; không auto retry |
| S13 | PTY không exit sau TERM/KILL | `stopping + stopTimedOut`, restart 504, không giả `exited`/giải phóng slot |
| S14 | Natural exit/kill/idle/server shutdown | `exitReason` đúng; state transition một lần; kill lặp không reset deadline |
| S15 | Retention >50, removed, shutdown | Chỉ exited/error bị evict oldest; removed event + socket 4004; listener/timer/buffer sạch |

### 12.2 WebSocket/headless terminal — bắt buộc

| ID | Tình huống và setup | Kết quả phải assert |
| --- | --- | --- |
| W01 | Attach v2 trong lúc fixture phát dày | Listener đăng ký trước barrier; `sync_start → chunks → sync_end → output/resize` đúng seq, không mất chunk |
| W02 | Raw buffer/history vượt giới hạn | Snapshot giảm scrollback theo bậc; `historyTruncated=true`; không cắt giữa serialized string; lỗi `terminal_snapshot_too_large` nếu màn hình hiện tại >1 MiB |
| W03 | ANSI Unicode/combining, colors, cursor, alternate screen | Restore tại cùng cols/rows đúng screen/cursor/mode; test thực tế các mode Codex cần; capability thiếu thì fail gate |
| W04 | V1 client và V2 client cùng session | V1 nhận legacy raw một lần; V2 nhận snapshot một lần; không double replay |
| W05 | A → B → A với write callback cũ đến sau switch | callback/xterm queue của A bị guard/drain; màn hình và connection B không đổi |
| W06 | Hai socket cùng session | Socket đầu controller, socket hai viewer; viewer input/resize trả `control_locked` và fixture không nhận |
| W07 | Controller close/auth-expire | Viewer lâu nhất được promote atomically; role event không tự restart PTY; chỉ input/fit khi sync đã hoàn tất |
| W08 | Client chậm/gap/1013/timeout | Socket queue bounded; quá limit đóng 1013; seq gap disable input/reconnect snapshot; cleanup deadline 10s |
| W09 | Disconnect/reconnect trong output | PTY tiếp tục, không replay input cũ; snapshot mới không phát lại OSC attention |
| W10 | Auth/Origin/ticket/epoch | 401/403/expired ticket/epoch mismatch đóng đúng; không gửi terminal output qua REST/log |

### 12.3 Frontend/UX — bắt buộc

| ID | Tình huống và setup | Kết quả phải assert |
| --- | --- | --- |
| U01 | Tạo B khi A running | A vẫn list/running; B active; không gọi kill/restart A |
| U02 | Switch A ↔ B 20 lần | Mỗi lần chỉ attach đúng session; không tạo/kill; output/draft không lẫn |
| U03 | Draft A/B/A | Draft độc lập trong RAM; không lưu output/prompt vào storage |
| U04 | Folder response đảo thứ tự + abort | Chỉ response mới nhất cập nhật canonical folder; nút chọn disabled khi loading/error |
| U05 | Kill A rồi chọn B trước response | Response A merge đúng item, không kéo active về A |
| U06 | Desktop/mobile 360/390/768/1024/1440 | Không page overflow; một xterm; dialog/sheet max 85dvh, touch ≥44px, focus/ARIA/safe-area đúng |
| U07 | Capacity/retention/stopping/error/viewer | Copy/status/action đúng; full capacity chỉ disable create, không khóa phiên cũ |
| U08 | Codex active/controller/running/sync complete | Nút Shift + ← visible/enabled; gửi chính xác `\x1b[1;2D`; draft không flush |
| U09 | Shell/Claude/Gemini/OpenCode hoặc viewer | Không hiển thị nút; hoặc disabled đúng role/state |
| U10 | Hai tab cùng browser + reload | Mỗi tab dùng sessionStorage riêng; hash/deep link chỉ chọn UUID hợp lệ của tab đó |
| U11 | Hash invalid/missing/401 | Không tự chọn session khác; báo missing hoặc giữ hash qua login; auth error không retry vô hạn |
| U12 | Create/kill/restart network timeout | POST không auto-retry; nút retry dùng cùng key/body; pending selection guard giữ active người dùng đã chọn |
| U13 | Poll hidden/offline/focus | Không chồng GET; dừng hidden/offline; focus tạo một vòng retry; status nền hội tụ ≤5s khi online |

### 12.4 FCM/config/security/async — bắt buộc

| ID | Tình huống và setup | Kết quả phải assert |
| --- | --- | --- |
| P01 | `FCM_ENABLED` unset/false | Server start, không init Admin/đọc credential; config/UI disabled; terminal vẫn chạy |
| P02 | Enabled thiếu field, sai VAPID, sai project/service JSON | Startup fail trước listen, message sanitized, không log secret |
| P03 | POST/DELETE/test device auth/origin/schema/rate | Chỉ owner scope; body/FID limit; status codes đúng; test 202 queued không claim delivered |
| P04 | Store corrupt/wrong version/project/concurrent writes | Enabled fail closed; atomic file 0600/dir0700; không mất record hợp lệ/không ghi nửa file |
| P05 | OSC9 BEL/ST/C1 split/overflow/plain/OSC52 | Một attention đúng, chunk boundary không false positive, cooldown 2s; payload không đi vào event/log |
| P06 | Codex argv fixture | Exact argv `-c` pairs trước `--`; chỉ interactive Codex; wrapper unsupported dừng báo owner, không sửa global config |
| P07 | Queue burst 200, 2 sender hang | Queue cap 128/drop; tối đa 2 SDK Promise thực sự pending; permit chỉ release khi settle; PTY vẫn xử lý output |
| P08 | Sender transient/invalid/slow/TTL | Không thêm application retry ngoài SDK; invalid xóa tuple đúng; watchdog metric/log sanitized; job hết TTL bị drop |
| P09 | Shutdown trong queue/in-flight | closing trước await; queue drop; cleanup ≤2s; mọi Promise catch/finally; PTY shutdown không chờ vô hạn |
| P10 | Foreground `onMessage` | Banner generic theo session, không auto-switch, không show notification lần hai |
| P11 | Page closed/background worker | data-only payload show generic notification một lần, tag event; không cần tab/React |
| P12 | Click notification có/không client | Focus đúng same-origin client hoặc open URL `#session=UUID`; không dùng URL/payload tùy ý; test không có hash |
| P13 | Auth redirect Web CLI/Hub/TOTP | Hash UUID hợp lệ được giữ qua 303/login/2FA; hash sai/return URL tùy ý bị loại; sau auth GET list rồi chọn đúng session |
| P14 | Session removed/expired after click | Báo missing, mở manager; không tạo session và không gửi input |
| P15 | Logout explicit / Hub logout / password change | Revoke đúng scope trước success; wrong password không revoke; late registration callback không re-register |
| P16 | Permission denied/unsupported/iOS web app | UI hướng dẫn, không loop permission; iOS requirement Add to Home Screen được ghi docs; không giả live pass |
| P17 | Payload/log/source inspection | Không có prompt/output/path/command/token/FID/private key trong REST notification, log, SW cache hoặc lock screen |
| P18 | Firebase live test (chỉ khi owner cung cấp config) | Browser desktop + mobile nhận khi page closed, click deep link đúng; ghi OS/browser/domain/time; thiếu config ghi `LIVE_FCM_PENDING` |
| P19 | Codex thật: approval + câu hỏi Plan Mode | Ghi phiên bản CLI; hai session cùng cwd, mỗi sự kiện đi đúng session; phím Shift + ← vào đúng phiên. Fixture không thay test này; thiếu tài khoản/cấu hình ghi `LIVE_CODEX_PENDING` |

### 12.5 Kịch bản E2E tối thiểu

Smoke phải chạy server mới trên `127.0.0.1` với env tạm, fixture `terminal-agent.cjs`, project roots tạm có `project-A` và `project-B/subdir`, và capacity mặc định 3. Dùng hai phiên Codex fixture cùng `project-A`, một shell cùng `project-A`, sau đó kiểm tra agent khác tại `project-B/subdir` ở test riêng với capacity phù hợp; không sửa production env để ép bốn phiên.

1. Đăng nhập bằng setup/TOTP flow hiện có, tạo A/B cùng cwd, gửi marker khác nhau và xác nhận cả hai output.
2. Tạo shell C khi max=3; thử create D nhận 429 nhưng A/B/C không đổi.
3. Switch A/B 20 lần, xen kẽ browse folder chậm, draft và reload tab; chụp lỗi console/pageerror/uncaught rejection.
4. Mở tab thứ hai vào cùng auth, attach viewer, kiểm tra input viewer bị khóa rồi đóng controller để promote. Sau đó kill B, kiểm tra C và A còn output; restart A kiểm tra replacement ID/relationship và dùng ID mới cho các bước còn lại.
5. Chạy viewport 360×800, 390×844, 768×1024, 1440×900; assert page width, terminal height, focus return, dialog count.
6. Gửi phím shortcut và kiểm tra frame WS + bytes fixture nhận, không chỉ kiểm tra text nút.
7. Mock notification test, đóng tab, kiểm tra worker click/deep link qua login. Live FCM/Codex approval là bước riêng P18/P19 và phải có credentials/owner approval.

### 12.6 Memory/async/security budgets

- Chạy SessionManager churn tối thiểu 200 create/exit với retention cap 50; đo RSS sau mỗi 20 vòng. Assert headless sống chỉ bằng session active, final snapshot ≤1 MiB/session, records recent ≤50, listener/socket/timer của session đã remove về 0. Ghi RSS trước/sau; tăng đều qua các vòng sau khi cap đã ổn định là finding phải điều tra, không tự nới cap hoặc đặt ngưỡng RSS thiếu baseline.
- Test queue 200 event, hai sender hang, shutdown; assert queue bounded, no unhandled rejection, shutdown không vượt 15s global. Không dùng `Promise.race` để giả vờ đã hủy request còn pending.
- Chạy `git diff --check`, scan log test bằng pattern cho `private_key`, `access_token`, `fid`, prompt/path; pattern scan chỉ kiểm tra rò rỉ, không dùng để nhận diện attention.

### 12.7 Lệnh validation cuối

```bash
npm test
npm run check
npm run build
git diff --check
node scripts/smoke-multi-session.cjs
node scripts/smoke-notifications.cjs
```

Nếu Puppeteer/Chrome hoặc module test ngoài repo không có, smoke phải báo `SKIPPED` kèm module/path cụ thể; không âm thầm đổi production code/dependency. Nếu FCM/Codex credentials chưa có, P18/P19 là `PENDING`, không chuyển thành PASS. Báo cáo phải ghi riêng `CODE_READY` và `RELEASE_READY`.

---

## 13. Bảo mật, scale và vận hành

- Giữ bind loopback và auth/origin/CSRF/TOTP/WebSocket ticket hiện có.
- FCM public config không phải secret; service account private key là secret và chỉ nằm ngoài repo.
- Child environment không được nhận `FIREBASE_*`, `FCM_*`, `GOOGLE_APPLICATION_CREDENTIALS` hoặc auth credential trừ khi một phase khác có owner phê duyệt.
- Notification chỉ metadata generic; logs chỉ event code/session ID đã được cho phép, không log FID/token/prompt.
- Queue có giới hạn, concurrency, timeout, retry, drop policy và drain khi shutdown.
- Không tạo một socket/xterm cho mọi background session.
- Giữ buffer/memory limits; đo trước khi đề xuất tăng limit.
- Server hiện là single process; không thêm nhiều worker/Redis để “giải quyết” race.
- Không chạy migration database vì session vẫn in-memory.
- Chỉ bật FCM sau khi kiểm tra HTTPS, service worker scope, CSP, reverse proxy route và quyền file.

---

## 14. Rollout/rollback

### Rollout dev/staging

1. Hoàn thành phase code và giữ test protocol v1; kiểm tra backend mới với client legacy ở Phase 2 trước đổi frontend.
2. Build frontend mới; chạy browser smoke với fixture deterministic, không cần dùng tài khoản agent thật.
3. Bật UI FCM với `FCM_ENABLED=false` để kiểm tra disabled state.
4. Sau khi người dùng cung cấp Firebase config, bật ở staging, đăng ký một browser, test page closed và click deep link.
5. Chỉ khi toàn bộ S/W/U/P pass (bao gồm live P18/P19) và owner chấp nhận mới xem xét production. Các bước rollout là hướng dẫn cho lần triển khai sau, không phải lệnh deploy trong task coding.

### Rollback

- Tắt `FCM_ENABLED`; app vẫn chạy không cần Firebase.
- Rollback frontend về build trước không được kill PTY.
- Backend rollback có thể làm mất các session in-memory như hiện trạng; phải báo trước, không hứa giữ PTY.
- Không chạy script deploy trong phase coding.

---

## 15. Definition of Done

Chỉ báo RELEASE_READY khi tất cả mục sau đạt; CODE_READY có thể còn P18/P19 chờ môi trường, phải liệt kê rõ:

- [ ] Bốn tổ hợp agent/folder chạy độc lập.
- [ ] Create/switch/disconnect/logout không kill session ngoài action rõ ràng.
- [ ] Kill/restart đúng session, có reason, deadline và lock.
- [ ] Capacity và retention hiển thị đúng từ API.
- [ ] REST/WS/folder stale guard pass.
- [ ] Headless snapshot phục hồi màn hình/mode/cursor, seq/sync boundary đúng; cảnh báo historyTruncated; headless disposed khi exit.
- [ ] Viewer không ghi vào PTY controller.
- [ ] Desktop/mobile Session Manager usable và accessible.
- [ ] Draft tách theo session.
- [ ] Shift + ← đúng Codex, đúng bytes, không flush draft.
- [ ] FCM disabled an toàn; enabled config validate; queue bounded/shutdown safe.
- [ ] Codex OSC9 attention hoạt động; agent khác không false-positive.
- [ ] Push foreground/background/deep-link/auth flow pass.
- [ ] Payload/log không chứa nội dung nhạy cảm.
- [ ] `npm test`, `npm run check`, `npm run build`, smoke và `git diff --check` pass.
- [ ] README/.env/firebase guide cập nhật.
- [ ] Không có file ngoài allowlist bị sửa.
- [ ] Không deploy/restart/commit ngoài yêu cầu.
- [ ] Owner hoặc reviewer được giao đã xem kết quả; nếu chưa, ghi OWNER_REVIEW_PENDING.

---

## 16. Mẫu báo cáo bắt buộc của agent

```text
Đã thực hiện:
- Phase đã hoàn tất:
- File đã sửa/tạo:
- Behavior đã thay đổi:

Validation:
- npm test: PASS/FAIL + kết quả
- npm run check: PASS/FAIL + kết quả
- npm run build: PASS/FAIL + kết quả
- smoke multi-session: PASS/FAIL + kết quả
- FCM mock: PASS/FAIL + kết quả
- FCM live: PASS/SKIPPED + lý do
- Codex approval/Plan Mode live: PASS/PENDING + phiên bản/lý do
- Trạng thái: CODE_READY hoặc CODE_BLOCKED; RELEASE_READY hoặc LIVE_FCM_PENDING/LIVE_CODEX_PENDING/OWNER_REVIEW_PENDING

Không thực hiện:
- Deploy/restart/commit: luôn ghi rõ đã không thực hiện
- Hạng mục ngoài scope: liệt kê nếu phát hiện

Rủi ro/blocker:
- File/dòng/lỗi cụ thể
- Tác động
- Quyết định cần owner nếu có

Cấu hình người dùng còn thiếu:
- Firebase project/Web App
- VAPID public key
- Service account file ngoài repo
- HTTPS domain
```

Agent không được kết luận “đã hoàn tất” nếu còn blocker hoặc chưa chạy validation tương ứng.

---

## 17. Quyết định hợp nhất từ các bản trước

| Nội dung | Quyết định trong bản master |
| --- | --- |
| Session Manager, new-session dialog, desktop/mobile, same-folder warning trong UI/UX plan | Giữ và cụ thể hóa tại mục 8; warning không chặn, một xterm visible |
| Metadata, exitReason, retention, lifecycle ở hai bản cũ | Hợp nhất mục 7; bổ sung slot reservation/restart lock/idempotency/shutdown deadline |
| Kết luận frontend là root cause duy nhất | Bỏ kết luận tuyệt đối; code đã có UUID/PTY riêng, còn các rủi ro state/attach/restart cần regression bằng fixture |
| Replay đuôi outputBuffer như snapshot hoàn chỉnh | Thay bằng headless serializer có barrier/seq; raw buffer chỉ giữ tương thích v1 |
| last session dùng localStorage | Chuyển sessionStorage per tab; draft chỉ RAM per session |
| Poll tùy chọn 15–30 giây | Chốt 5 giây khi visible/online/auth và có active process; dừng nền, không overlap |
| Nhiều socket cùng resize/write một PTY | Chốt controller/viewer lease; không thêm nút takeover cưỡng chế |
| Shortcut và push chưa có trong plan UI/UX | Bổ sung mục 9–10: bytes Shift + ←, native Codex event, FCM worker/deep link/config |
| Agent có thể tự chọn cách làm ngoài scope | Khóa file/phase/contract; chỉ owner mở rộng scope; sai khác quan trọng phải báo thay vì tự thiết kế lại |

Các quyết định ở bảng này đã được đưa đầy đủ vào mục triển khai; agent không cần và không được đọc plan cũ để bổ sung thêm task.

## 18. Prompt bàn giao cho agent thực thi

Owner có thể copy đoạn sau khi quyết định bắt đầu coding:

```text
Triển khai trong /home/mrhoan/source/web-cli theo duy nhất:
docs/MULTI_SESSION_MASTER_IMPLEMENTATION_PLAN.md

Đọc AGENTS.md và toàn bộ bản master trước khi sửa. Làm tuần tự Phase 0–8,
chỉ sửa các file trong allowlist tổng và allowlist phase. Không dùng các
plan SUPERSEDED như yêu cầu bổ sung. Bảo toàn thay đổi working tree có sẵn.

Không thêm feature, dependency, refactor hay đổi kiến trúc ngoài tài liệu.
Không sửa lại plan để tự mở rộng scope. Không commit/push/deploy/restart service.
Không tự bật Firebase production hoặc tự approve câu hỏi của CLI.

Mỗi phase phải có test/gate đúng tài liệu và cập nhật
docs/agile/changes/multi-session-validation.md. Gate lỗi do thay đổi của bạn
thì sửa trong scope và kiểm tra lại. Nếu contract/code thực tế khác plan hoặc
cần quyết định ngoài scope, dừng phần phụ thuộc, báo file/symbol/bằng chứng,
tiếp tục phần độc lập. Không bỏ test hoặc tăng limit để vượt gate.

Nếu thiếu Firebase/Codex credentials, vẫn hoàn tất code + mock/browser tests;
ghi LIVE_FCM_PENDING/LIVE_CODEX_PENDING, không tuyên bố live đã pass.
Báo cáo cuối theo mục 16: file, behavior, test PASS/FAIL/SKIPPED, rủi ro và
cấu hình còn thiếu. Không yêu cầu tôi quyết định lại các chi tiết đã chốt.
```
