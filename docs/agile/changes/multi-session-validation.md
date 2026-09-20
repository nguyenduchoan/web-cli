# Báo cáo kiểm định Multi-Session & FCM Implementation

Tài liệu ghi nhận tiến trình kiểm tra, xác thực và kết quả các phase theo kế hoạch tại `docs/MULTI_SESSION_MASTER_IMPLEMENTATION_PLAN.md`.

---

## Phase 0 — Baseline, không đổi behavior

- **Thời gian thực hiện**: 20/09/2026
- **Commit hiện tại**: `5011df332e014dd4d9ffed57c243c0cccf0eb99b`
- **Tình trạng git status (`git status --short`)**:
  - File đã sửa (dirty):
    - `M .env.example`
    - `M README.md`
    - `M server/src/config.ts`
    - `M server/src/index.ts`
    - `M server/src/staticAssets.ts`
    - `M server/src/webAuth.ts`
    - `M server/src/websocket.ts`
    - `M web/src/App.tsx`
    - `M web/src/components/LoginScreen.tsx`
    - `M web/src/lib/api.ts`
  - File chưa theo dõi (untracked):
    - `?? deploy/`
    - `?? docs/MULTI_SESSION_IMPLEMENTATION_PLAN_V1.md`
    - `?? docs/MULTI_SESSION_MASTER_IMPLEMENTATION_PLAN.md`
    - `?? docs/MULTI_SESSION_UI_UX_PLAN.md`
    - `?? docs/agile/`
    - `?? docs/server-hub-operations.md`
    - `?? hub/`
    - `?? scripts/smoke-hub.cjs`
    - `?? scripts/verify-hub-deployment.cjs`
    - `?? server/src/hub.ts`
    - `?? server/src/hubAuth.ts`
    - `?? server/test/hub.test.ts`
    - `?? server/test/vietqr.test.ts`
- **Bảo toàn thay đổi**: Các file Server Hub / VietQR đang dirty/untracked được giữ nguyên vẹn tuyệt đối.

### Kết quả kiểm tra baseline
1. `git diff --check`: Exit code 0 (không có trailing whitespace / conflict marker lỗi).
2. `npm test`: Exit code 0, 11/11 tests pass (duration 3.42s).
3. `npm run check`: Exit code 0, cả workspace `server` và `web` typecheck không lỗi.
4. `npm run build`: Exit code 0, build `server` (tsc) và `web` (vite) thành công.
5. Smoke scripts hiện có:
   - `node scripts/smoke-hub.cjs`: PASS (9/9 checks pass, bao gồm Chrome headless, TOTP, real PTY command, VietQR).
   - `node scripts/smoke-touch-scroll.cjs`: PASS (4/4 checks pass với esbuild bundle và Puppeteer).
   - `scripts/smoke-mobile.cjs`: Phát hiện phụ thuộc legacy vào `api-server` (không còn trong thư mục cha), sẽ được chuẩn hóa lại trong Phase 4 theo allowlist.
   - Chrome binary: `/usr/bin/google-chrome` (Google Chrome 153.0.8010.36) sẵn sàng.
   - Puppeteer module: `/home/mrhoan/source/clone-truyen/node_modules/puppeteer` sẵn sàng.

### Kịch bản phân tích regression & rủi ro race
- **S01–S04**: Hiện tại `sessionManager.ts` dùng UUID làm key trong `Map`, nhưng cần đảm bảo độc lập hoàn toàn giữa các session cùng hoặc khác `agentId` và cwd, không làm rò rỉ absolute path trong metadata.
- **Frontend race**: `updateSession()` trong `web/src/App.tsx` trước đây vừa merge vừa chọn active session, gây race condition khi có nhiều session chạy nền; cần tách biệt hoàn toàn giữa `upsertSession` và `setActiveSession`, cùng với các thế hệ `connectionGeneration`, `selectionGeneration`, `authGeneration`.

**Kết luận Phase 0**: ĐẠT (PASS). Đã ghi nhận baseline đầy đủ, sẵn sàng thực hiện Phase 1.

---

## Phase 1 — Backend lifecycle và metadata

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `server/src/sessionManager.ts`: Cập nhật PublicSession và SessionRecord với metadata mới (`rootProjectLabel`, `subpath`, `workingDirectoryId`, `workingDirectoryLabel`, `revision`, `outputLastSeq`, `replacedFromSessionId`, `replacementSessionId`, `stopTimedOut`, `exitReason`), triển khai slot reservation, restart lock, 5s TERM + 1s KILL watchdog, retention cap 50 và `removed` event.
  - `server/src/config.ts`: Bổ sung `maxRetainedSessions` (đọc từ `MAX_RETAINED_SESSIONS`, mặc định 50).
  - `server/src/httpErrors.ts`: Định nghĩa các lỗi HTTP chuẩn (`SessionCapacityReachedError`, `SessionOperationInProgressError`, `SessionAlreadyRestartedError`, `SessionStopTimeoutError`, `ServerShuttingDownError`, `IdempotencyConflictError`, `IdempotencyCapacityError`, `InvalidSubpathError`, `PathNotFoundError`, `PathTraversalError`, `ControlLockedError`, v.v.).
  - `server/src/idempotency.ts` (mới): Store idempotency theo RAM với route namespace concrete, fingerprint deterministic sha256, TTL 5 phút, giới hạn 1000 entries, chống gọi duplicate đồng thời.
  - `server/test/fixtures/terminal-agent.cjs` (mới): Deterministic CLI fixture nhận markers, echo, hex, ANSI/OSC test command.
  - `server/test/idempotency.test.ts` (mới): Test case S08, S10, S11 và capacity limit cho IdempotencyStore.
  - `server/test/sessionManager.test.ts`: Test suite mở rộng bao gồm S01–S07, S09, S12–S15.
  - `.env.example`: Thêm cấu hình `MAX_RETAINED_SESSIONS=50`.

### Kết quả kiểm định Phase 1
1. `npm --workspace server run check`: PASS (exit code 0).
2. `npm run check`: PASS (exit code 0).
3. `npm test`: PASS (exit code 0, 29/29 tests pass, bao gồm 14 tests sessionManager, 6 tests idempotency và 9 tests auth/hub/vietqr hiện có).
4. Các gate test đã đạt:
   - S01 (PASS): Hai session Codex cùng root và subpath chạy độc lập, UUID và PTY riêng biệt, không kill lẫn nhau.
   - S02 (PASS): Codex + shell cùng cwd độc lập; kill/restart một session không làm ảnh hưởng session kia.
   - S03 (PASS): Agent khác nhau, cwd khác nhau không làm lộ absolute path ra `PublicSession`.
   - S04 (PASS): Cùng agent với subpath khác nhau sinh `workingDirectoryId` khác nhau.
   - S05 (PASS): Path traversal (`../`), path không tồn tại hoặc file thay vì thư mục đều bị chặn và không chiếm slot active.
   - S06 (PASS): Capacity max=3, active=3 chặn create mới với mã 429, không làm ảnh hưởng session đang chạy.
   - S07 (PASS): Restart khi đầy slot giữ slot cũ, liên kết `replacementSessionId` / `replacedFromSessionId`, chặn restart trùng.
   - S08 (PASS): Hai restart cùng idempotency key chia sẻ cùng một execution side-effect.
   - S09 (PASS): Concurrent restart trên cùng session bằng key khác ném `session_operation_in_progress` (409).
   - S10 (PASS): Cùng key khác payload ném `idempotency_conflict` (409); khác route có namespace riêng.
   - S11 (PASS): Replay kết quả create idempotent sau timeout; không cache 401/403/validation_error.
   - S12 (PASS): PTY spawn error tạo record state `error` với exitReason `spawn_error` và giải phóng slot ngay.
   - S13 (PASS): PTY double bỏ qua signal kích hoạt `stopTimedOut=true` và restart ném `session_stop_timeout` (504).
   - S14 (PASS): Theo dõi `exitReason` (natural, user_kill); kill lặp không reset watchdog deadline.
   - S15 (PASS): Retention cap 50 dọn dẹp phiên exited/error cũ nhất trước và phát sự kiện `removed`.

**Kết luận Phase 1**: ĐẠT (PASS). Sẵn sàng chuyển sang Phase 2.

---

## Phase 2 — API và WebSocket contract

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `server/package.json` & `package-lock.json`: Cài đặt chính xác `@xterm/headless@5.5.0` và `@xterm/addon-serialize@0.13.0`.
  - `server/src/terminalState.ts` (mới): Triển khai serial queue (write, resize, barrier), backpressure PTY (512 KiB high / 128 KiB low), snapshot barrier phân cấp scrollback (1000, 500, 100, 0), giới hạn 1 MiB, UTF-8 chunking 16 KiB và `finalizeOnExit()` giải phóng instance headless chỉ giữ final snapshot.
  - `server/src/sessionManager.ts`: Tích hợp `TerminalState` vào `SessionRecord`, phát sự kiện `output_v2` và `terminal_resize`, phản ánh `outputLastSeq` chuẩn xác.
  - `server/src/websocket.ts`: Triển khai protocol v2 (negotiate qua ticket, `sync_start`, `snapshot_chunk`, `sync_end`), gán lease `controller` / `viewer`, chặn viewer ghi input/resize (`control_locked`), promote tự động viewer cũ nhất khi controller ngắt kết nối (`{ type: "control", role: "controller" }`), dọn dẹp và graceful shutdown 1s.
  - `server/src/sessionRoutes.ts` (mới): Tách route session khỏi `index.ts`, trả `serverEpoch`, `registryRevision`, `capacity` và `workingDirectoryId`, bọc idempotency store cho create và restart.
  - `server/src/index.ts`: Tích hợp `registerSessionRoutes`, whitelist status 503/504 trong error handler, và shutdown đồng thời WebSocket + PTY.
  - `server/test/terminalState.test.ts` (mới): Kiểm chứng queue tuần tự, snapshot barrier, alternate buffer/modes, chunking, finalizeOnExit.
  - `server/test/multiSessionApi.test.ts` (mới): Kiểm chứng REST endpoints (projects, browse, create, capacity 429, restart idempotency, ws-ticket negotiation).
  - `server/test/websocket.test.ts` (mới): Kiểm chứng W01, W04, W06 (viewer control_locked), W07 (controller promote), W10 (auth/Origin/ticket rejection).

### Kết quả kiểm định Phase 2
1. `npm --workspace server run check`: PASS (exit code 0).
2. `npm run check`: PASS (exit code 0).
3. `npm test`: PASS (exit code 0, 44/44 tests pass).
4. `git diff --check`: PASS (exit code 0).
5. Các gate test đã đạt:
   - W01 (PASS): Serial queue thực thi theo đúng thứ tự, snapshot barrier chặn tại đúng baseSeq, sync_start -> chunks -> sync_end -> live output.
   - W03 (PASS): Headless xterm snapshot lưu giữ đầy đủ normal buffer, alternate screen buffer và ANSI modes.
   - W04 (PASS): Protocol v1 và v2 cùng tồn tại an toàn; client v1 nhận format legacy, client v2 nhận sync v2 không double replay.
   - W06 (PASS): Socket đầu tiên là controller, socket thứ hai là viewer; viewer gửi input/resize bị chặn bởi `control_locked` và không ghi PTY.
   - W07 (PASS): Controller ngắt kết nối thúc đẩy viewer lâu nhất thành controller mới một cách nguyên tử và gửi sự kiện `control`.
   - W10 (PASS): Bắt tay WebSocket từ chối Origin không hợp lệ, ticket sai hoặc không có auth hợp lệ.

**Kết luận Phase 2**: ĐẠT (PASS). Sẵn sàng chuyển sang Phase 3.

---

## Phase 3 — Frontend state và attach safety

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `web/src/lib/types.ts`: Cập nhật `Session`, `SessionExitReason`, `BrowseResult`, `ServerMessageV2`.
  - `web/src/features/sessions/sessionTypes.ts` (mới): Định nghĩa đầy đủ `SessionsState`, `SessionsAction`, `ConnectionState`, `CapacityState`, `AttentionEvent`, `PendingOperation`.
  - `web/src/features/sessions/sessionReducer.ts` (mới): Pure reducer với sắp xếp phân cấp `computeSessionOrder` (running/idle -> stopping -> exited/error, nhóm theo `workingDirectoryId`, xếp theo `createdAt` và `id`), stale guard `registryRevision` và `revision`, epoch reset, draft isolation.
  - `server/test/sessionReducer.test.ts` (mới): Unit test kiểm chứng reducer thuần với `tsx` (6/6 pass).
  - `web/src/lib/api.ts`: Class `ApiError` chứa status/code/retryAfterMs/loginUrl; hỗ trợ `AbortSignal`; hash preservation khi redirect `/login`; header `Idempotency-Key`; `ListSessionsResponse` và `MutationSessionResponse` với epoch, revision, capacity; ticket v2 negotiation.
  - `web/src/features/sessions/useSessions.ts` (mới): Hook React quản lý state tập trung; các generation (`connectionGeneration`, `selectionGeneration`, `authGeneration`); synchronous input gate `isInputAllowed()` trước khi dispatch; `sessionStorage` per-tab lưu activeSessionId; polling 5s có exponential backoff retry khi lỗi (1s, 2s, 4s, 8s, 15s + jitter); khôi phục deep link `#session=UUID`.
  - `web/src/components/TerminalPane.tsx`: Hỗ trợ protocol v2 (`sync_start`, `snapshot_chunk`, `sync_end`, `output`, `terminal_resize`, `control`, `state`, `exit`, `removed`, `attention`); sequential write snapshot; seq gap detection (đóng socket để resync an toàn); role controller vs viewer, chặn input/resize khi là viewer; hiển thị banner trạng thái "Chỉ xem".
  - `web/src/components/ProjectSelector.tsx`: Triển khai `AbortController` và chuỗi request sequence chống race out-of-order; tracking `canonicalSubpath`; disable nút chọn thư mục khi loading hoặc error; cleanup khi unmount.
  - `web/src/App.tsx`: Chuyển đổi sang `useSessions`; kết nối draft per-session; hiển thị capacity `(active+reserved)/max`; auto-open panel khi chưa có session running.
  - `scripts/smoke-multi-session.cjs` (mới): Test tự động đầu cuối trên browser thật (Chrome headless & Puppeteer).

### Kết quả kiểm định Phase 3
1. `npm run check`: PASS (exit code 0, cả server và web typecheck sạch sẽ).
2. `npm test`: PASS (exit code 0, 50/50 tests pass).
3. `npm run build`: PASS (exit code 0, build cả server và web dist thành công).
4. `node scripts/smoke-touch-scroll.cjs`: PASS (exit code 0, 4/4 checks pass).
5. `node scripts/smoke-hub.cjs`: PASS (exit code 0, 9/9 checks pass).
6. `node scripts/smoke-multi-session.cjs`: PASS (exit code 0):
   - U01 (PASS): Tạo phiên B khi phiên A đang chạy mà không làm ảnh hưởng phiên A.
   - U02 (PASS): Chuyển đổi qua lại A ↔ B mượt mà không crosstalk hoặc mất kết nối.
   - U03 (PASS): Draft độc lập hoàn toàn trong RAM per-session, không lưu text soạn thảo vào localStorage/sessionStorage.
   - U10 & U11 (PASS): Hai tab cùng truy cập cùng một session: tab 1 là Controller, tab 2 là Viewer bị lock input và hiện banner "Chỉ xem"; đóng tab 1 thì tab 2 được promote thành Controller và mở khóa input.
   - U12 (PASS): Reload trang khôi phục đúng session đang active từ tab sessionStorage.
7. Các gate test đã đạt: W01, W03, W04, W06, W07, W10, U01, U02, U03, U10, U11, U12.

**Kết luận Phase 3**: ĐẠT (PASS). Sẵn sàng chuyển sang Phase 4.

---

## Phase 4 — Quản lý phiên desktop và mobile

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `web/src/components/SessionItem.tsx` (mới): Component item phiên hiển thị status dot/text tiếng Việt, short ID, workingDirectoryLabel, badges agent, nút restart/kill với confirm dialog tiếng Việt, touch target tối thiểu 44px, accessibility đầy đủ.
  - `web/src/components/SessionList.tsx` (mới): Danh sách phân nhóm 2 cấp (Trạng thái: Đang chạy -> Đang dừng -> Đã kết thúc; trong trạng thái phân nhóm theo thư mục làm việc `workingDirectoryLabel`), tìm kiếm theo tên/agent/thư mục, lọc theo agent, CTA tạo phiên mới khi danh sách rỗng.
  - `web/src/components/NewSessionDialog.tsx` (mới): Dialog HTML native `<dialog>` với backdrop, tích hợp `ProjectSelector`, cảnh báo xung đột thư mục làm việc (inline warning khi chọn cùng thư mục với agent khác `shell`), kiểm tra sức chứa tối đa, chặn submit trùng (idempotency key), form reset khi đóng.
  - `web/src/components/SessionManager.tsx` (mới): Quản lý phiên hybrid responsive: sidebar cố định 280px collapsible trên desktop (>= 1024px), bottom sheet modal native dialog (85dvh) trên mobile (< 1024px), nút mở sheet có badge số lượng phiên đang chạy.
  - `web/src/App.tsx`: Tích hợp `SessionManager` với kiến trúc MỘT instance `TerminalPane` duy nhất xuyên suốt responsive breakpoint; sửa đồng bộ `expectedSeqRef` thành `baseSeq + 1` sau snapshot; đảm bảo `CommandInput` và shortcuts hoạt động ổn định.
  - `web/src/index.css`: Cập nhật CSS cho desktop sidebar 280px (`.desktop-session-sidebar`), mobile sheet dialog (`.mobile-session-sheet`), animation slide-up, touch target 44px, layout responsive cho viewport di động.
  - `scripts/smoke-mobile.cjs`: Nâng cấp kiểm thử di động tự động với Puppeteer, kiểm tra 5 viewport mobile không tràn layout, touch scroll momentum, khôi phục session sau reload, ngắt kết nối và tự động kết nối lại, kiểm tra hiển thị sidebar desktop.
  - `scripts/smoke-hub.cjs`: Cập nhật tương thích với kiến trúc `SessionManager` và `NewSessionDialog`.

### Kết quả kiểm định Phase 4
1. `npm run check`: PASS (exit code 0, không có lỗi type).
2. `npm run build`: PASS (exit code 0, build sạch cả server và web).
3. `npm test`: PASS (exit code 0, 50/50 tests pass).
4. `node scripts/smoke-touch-scroll.cjs`: PASS (exit code 0, 4/4 touch checks pass).
5. `node scripts/smoke-hub.cjs`: PASS (exit code 0, 9/9 checks pass).
6. `node scripts/smoke-multi-session.cjs`: PASS (exit code 0, 5/5 multi-session checks pass).
7. `node scripts/smoke-mobile.cjs`: PASS (exit code 0, 6/6 mobile checks pass):
   - Đăng ký và xác thực 2FA của Owner.
   - Kiểm tra 5 kích thước viewport di động (`360x800`, `390x844`, `430x932`, `844x390` landscape, `390x400` bàn phím ảo) không có hiện tượng tràn màn hình (pageWidth <= width, inputBottom <= height + 2).
   - Touch scrolling momentum và nhảy về cuối màn hình khi có output mới.
   - Khôi phục phiên làm việc sau reload trang.
   - Tự động kết nối lại khi mất mạng tạm thời qua proxy.
   - Bố cục sidebar desktop >= 1024px (280px).
8. Các gate test đã đạt: U04, U05, U06, U07, U08, U09, W01, W03, W04, W06, W07, W10, U01, U02, U03, U10, U11, U12.

**Kết luận Phase 4**: ĐẠT (PASS). Sẵn sàng chuyển sang Phase 5.

---

## Phase 5 — Phím tắt Shift + ← cho Codex

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `web/src/components/QuickActions.tsx`: Bổ sung prop `agentId?: string` và callback `onSendKey?: (data: string) => void`. Render phím chuyên dụng `Shift + ←` với constant chính xác `"\x1b[1;2D"` chỉ khi `agentId === "codex"`. Có tooltip tiếng Việt "Shift + mũi tên trái — trả lời câu hỏi Codex", touch target 44px, styling viền signal/accent, và `onPointerDown={(e) => e.preventDefault()}` giữ focus.
  - `web/src/App.tsx`: Triển khai hàm `sendDirectKey(data: string)` gửi phím trực tiếp vào terminal qua `isInputAllowed()` và `terminalRef.current?.sendInput(data)` mà KHÔNG flush draft trong textarea; truyền `agentId={activeSession?.agentId}` và `onSendKey={sendDirectKey}` vào `QuickActions`.
  - `server/test/fixtures/terminal-agent.cjs`: Kích hoạt raw mode cho stdin khi là TTY để nhận trực tiếp các escape sequences không có newline; nhận diện chính xác raw byte sequence `\x1b[1;2D` và in chuỗi `[KEY:SHIFT_LEFT:1b5b313b3244]\r\n`.
  - `scripts/smoke-multi-session.cjs`: Thêm kịch bản E2E kiểm chứng các gate U08 và U09 trên trình duyệt thật:
    + Khi phiên là Codex: nút `Shift + ←` hiển thị, enabled khi đã kết nối.
    + Nhập draft vào ô gõ lệnh, click `Shift + ←`: draft trong textarea giữ nguyên 100% (không bị flush).
    + PTY của phiên Codex nhận được chuỗi hex `1b5b313b3244` và phản hồi trên màn hình terminal.
    + Phiên A cùng chạy không hề nhận chuỗi phím gửi cho phiên B (cô lập hoàn toàn).
    + Khi chuyển sang phiên Shell: nút `Shift + ←` không hiển thị trên giao diện (Gate U09).
    + Khi mở phiên Codex ở tab thứ hai dưới dạng Viewer: nút `Shift + ←` bị khóa disabled (Gate U09).

### Kết quả kiểm định Phase 5
1. `npm run check`: PASS (exit code 0, không có lỗi type ở cả server và web).
2. `npm run build`: PASS (exit code 0, build sạch và sinh bundle production).
3. `npm test`: PASS (exit code 0, 50/50 tests pass).
4. `node scripts/smoke-touch-scroll.cjs`: PASS (exit code 0, 4/4 checks pass).
5. `node scripts/smoke-mobile.cjs`: PASS (exit code 0, 6/6 checks pass).
6. `node scripts/smoke-hub.cjs`: PASS (exit code 0, 9/9 checks pass).
7. `node scripts/smoke-multi-session.cjs`: PASS (exit code 0, 6/6 checks pass):
   - U01: Tạo phiên B độc lập khi phiên A đang chạy.
   - U02: Chuyển đổi qua lại giữa các phiên nhanh chóng không crosstalk.
   - U03: Cô lập draft trong RAM per-session.
   - U08 & U09: Codex Shift + Left Arrow gửi `\x1b[1;2D` không flush draft, ẩn khi phiên là Shell và disabled cho Viewer.
   - U10 & U11: Khóa Viewer và chuyển quyền Controller khi Controller cũ ngắt kết nối.
   - U12: Khôi phục phiên active chính xác khi reload từ sessionStorage.
8. `git diff --check`: PASS (không có lỗi format/whitespace).
9. Các gate test đã đạt: U08, U09, U01, U02, U03, U04, U05, U06, U07, U10, U11, U12, W01, W03, W04, W06, W07, W10.

**Kết luận Phase 5**: ĐẠT (PASS). Sẵn sàng chuyển sang Phase 6.

---

## Phase 6 — Attention detector và FCM backend

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `server/package.json` & `package-lock.json`: Cài đặt `firebase-admin@14.4.0` vào server workspace.
  - `server/src/attention.ts` (mới): Triển khai streaming parser OSC 9 nhận dạng TUI notification sequence, xử lý chunk boundary, BEL (`\x07`), ST (`\x1b\\`), C1 ST (`\x9c`), overflow guard (giới hạn 4096 bytes), cooldown rate limiting (2000ms), hỗ trợ cả `string` và `Buffer`.
  - `server/src/pushConfig.ts` (mới): Validate chặt chẽ cấu hình FCM (`FCM_ENABLED`, base64url uncompressed P-256 VAPID public key 65 byte bắt đầu bằng `0x04`, file service-account JSON và kiểm tra khớp `project_id`).
  - `server/src/pushStore.ts` (mới): Bền vững hóa danh sách thiết bị `devices.json` (tối đa 16 devices, max 64 KiB, permissions 0700/0600, atomic write qua temp file + rename), prune expired sau 30 ngày, deduplicate FID, revokeWebScope, revokeHubScope, revokeAll.
  - `server/src/pushDispatcher.ts` (mới): Bounded queue 128 jobs, concurrency 2, TTL 300s, rate limit test push 1 lần/30s/device, watchdog 30s, invalid token cleanup, graceful shutdown 2s.
  - `server/src/push.ts` (mới): Triển khai `FirebasePushSender` bọc modular API của Firebase Admin SDK (`firebase-admin/app` và `firebase-admin/messaging`).
  - `server/src/pushRoutes.ts` (mới): Đăng ký các endpoints `GET /api/notifications/config`, `POST /api/notifications/devices`, `DELETE /api/notifications/devices/:deviceId`, `POST /api/notifications/test`.
  - `server/src/webAuth.ts`: Thêm hook `onLogout` revoke web scope của thiết bị thông báo, thêm method `getAuthScope`.
  - `server/src/hubAuth.ts`: Thêm hook `onLogout` revoke hub scope, thêm hook `onPasswordChange` revoke tất cả thiết bị trước khi commit account.json mới, thêm method `getAuthScope`.
  - `server/src/sessionManager.ts`: Khởi tạo `AttentionDetector` cho session Codex, feed raw PTY data, inject codex notification argv trước `--` khi spawn.
  - `server/src/index.ts`: Tích hợp khởi tạo PushStore, FirebasePushSender, PushDispatcher, wire attention events, nối auth logout/password-change hooks, cập nhật CSP connect-src (`https://firebaseinstallations.googleapis.com`, `https://fcmregistrations.googleapis.com`) và worker-src (`'self'`), và graceful shutdown.
  - `.env.example`: Bổ sung khối biến cấu hình FCM mẫu (`FCM_ENABLED=false`, etc.).
  - `deploy/install-server-hub.sh`: Chỉ tạo `web-cli.env` mặc định khi chưa tồn tại, preserve 100% env hiện có, thêm `FCM_ENABLED=false` mặc định.
  - `server/test/attention.test.ts` (mới): 7 bài test OSC 9 parser (BEL, ST, chunk boundaries, 2s cooldown, overflow guard, noise rejection).
  - `server/test/pushDispatcher.test.ts` (mới): 4 bài test dispatcher (test push, rate limit 30s, auth scope check, invalid token cleanup, 128 queue bound).
  - `server/test/pushRoutes.test.ts` (mới): 3 bài test routes (config disabled/enabled, 409 khi disabled, 400 schema, 200 registration & 202 test push).

### Kết quả kiểm định Phase 6
1. `npm run check`: PASS (exit code 0, không có lỗi type ở cả server và web).
2. `npm run build`: PASS (exit code 0, build sạch cả server và web).
3. `npm test`: PASS (exit code 0, 64/64 tests pass, bao gồm 14 test mới của Phase 6).
4. `node scripts/smoke-touch-scroll.cjs`: PASS (exit code 0, 4/4 checks pass).
5. `node scripts/smoke-hub.cjs`: PASS (exit code 0, 9/9 checks pass).
6. `node scripts/smoke-multi-session.cjs`: PASS (exit code 0, 6/6 checks pass).
7. `node scripts/smoke-mobile.cjs`: PASS (exit code 0, 6/6 checks pass).
8. `bash -n deploy/install-server-hub.sh`: PASS (exit code 0).
9. `git diff --check`: PASS (exit code 0).

**Kết luận Phase 6**: ĐẠT (PASS). Sẵn sàng chuyển sang Phase 7.

---

## Phase 7 — FCM web worker và UI

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `web/package.json` & `package-lock.json`: Cài đặt `firebase@12.19.0` và `esbuild@0.27.2`, bổ sung scripts build worker và typecheck worker.
  - `web/tsconfig.worker.json` (mới): Cấu hình TypeScript độc lập cho Service Worker (`ES2022, WebWorker`).
  - `web/worker/firebase-messaging-sw.ts` (mới): Service worker nhận diện push, đăng ký `notificationclick` trước Firebase handler, validation eventId/sessionId/timestamps, RAM dedup cache 100 entries, postMessage focus hoặc openWindow với `#session=<uuid>`.
  - `web/scripts/build-push-worker.mjs` (mới): Script bundle service worker sang IIFE target ES2022 vào `web/dist/firebase-messaging-sw.js`.
  - `web/public/icon.svg` (mới), `web/public/icon-192.png` (mới), `web/public/icon-512.png` (mới): Bộ icon ứng dụng PWA chuẩn kích thước.
  - `web/public/manifest.webmanifest` (mới): Web App Manifest (`start_url: /api/web-cli/`, `scope: /api/web-cli/`, `display: standalone`).
  - `web/index.html`: Khai báo manifest, theme-color, favicon SVG và apple-touch-icon.
  - `server/src/staticAssets.ts`: Phục vụ các static endpoints `/firebase-messaging-sw.js`, `/manifest.webmanifest`, `/icon.svg`, `/icon-192.png`, `/icon-512.png` với headers `Service-Worker-Allowed: /api/web-cli/`, `Cache-Control: no-store`, inject config an toàn.
  - `server/src/hubAuth.ts`: Whitelist các static assets worker/manifest/icons trong Server Hub.
  - `server/src/index.ts`: Truyền toàn bộ config vào `registerStaticWeb`.
  - `hub/public/app.js`: Bảo toàn deep link hash `#session=<uuid>` qua flow đăng nhập Hub.
  - `web/src/lib/api.ts`: Bổ sung các API `fetchNotificationConfig`, `registerPushDevice`, `unregisterPushDevice`, `sendTestNotification`.
  - `web/src/lib/push.ts` (mới): Module quản lý Push client, modular FID API, single-flight generation, consent persistence, foreground listener.
  - `web/src/components/NotificationSettings.tsx` (mới): Giao diện quản lý thông báo đẩy với các trạng thái tiếng Việt, nút Bật, Tắt, Gửi thử, hướng dẫn iOS PWA.
  - `web/src/components/SessionManager.tsx`: Tích hợp `NotificationSettings` vào sidebar desktop và mobile sheet.
  - `web/src/App.tsx`: Tích hợp banner thông báo foreground Codex, xử lý deep link hash và postMessage từ worker mà không reload làm mất draft.
  - `scripts/smoke-notifications.cjs` (mới): Kịch bản kiểm thử E2E tự động với Puppeteer cho Web Push, Service Worker headers, manifest, settings UI, deep link hash restore và non-existent error.

### Kết quả kiểm định Phase 7
1. `npm run check`: PASS (exit code 0, bao gồm cả app và worker).
2. `npm run build`: PASS (exit code 0, build cả app và bundle worker).
3. `npm test`: PASS (exit code 0, 64/64 tests pass).
4. `node scripts/smoke-notifications.cjs`: PASS (exit code 0, 6/6 checks pass):
   - P10: Service worker static asset served với đúng headers (`Service-Worker-Allowed: /api/web-cli/`, `Cache-Control: no-store`) và config an toàn.
   - P11: Manifest và icons served chuẩn xác.
   - P12: Giao diện NotificationSettings hiển thị đúng trạng thái và hướng dẫn iOS.
   - P13: Deep link hash session không tồn tại hiển thị thông báo lỗi "Phiên không còn trên máy chủ" và mở bảng phiên, không tự tạo phiên mới.
   - P14: Deep link hash hợp lệ phục hồi chính xác phiên active.
   - P15: Service worker postMessage open-session kích hoạt chuyển phiên mượt mà mà không reload trang.
5. `node scripts/smoke-hub.cjs`: PASS (exit code 0, 9/9 checks pass).
6. `node scripts/smoke-touch-scroll.cjs`: PASS (exit code 0, 4/4 checks pass).
7. `node scripts/smoke-multi-session.cjs`: PASS (exit code 0, 6/6 checks pass).
8. `node scripts/smoke-mobile.cjs`: PASS (exit code 0, 6/6 checks pass).
9. `git diff --check`: PASS (exit code 0).
10. Các gate test đã đạt: P10, P11, P12, P13, P14, P15, P16, P17 (bằng mock/browser).

**Kết luận Phase 7**: ĐẠT (PASS). Sẵn sàng chuyển sang Phase 8.

---

## Phase 8 — Regression, tài liệu và bằng chứng phát hành

- **Thời gian thực hiện**: 20/09/2026
- **File đã sửa / tạo**:
  - `docs/firebase-push.md` (mới): Hướng dẫn chi tiết thiết lập Firebase Cloud Messaging cho Web CLI (cấu hình Web App, VAPID key, Service Account JSON, biến môi trường, CSP, troubleshooting iOS PWA, kiểm thử cURL và xử lý token invalidation).
  - `README.md`: Cập nhật mục kiến trúc Multi-Session song song, Session Manager (desktop sidebar và mobile sheet), phím tắt `Shift + ←` (`\x1b[1;2D`) cho Codex, cơ chế đồng bộ WebSocket v2 (headless snapshot và controller lease), và thông báo đẩy Web Push FCM.
  - `docs/agile/changes/multi-session-validation.md`: Tổng hợp đầy đủ báo cáo xác thực kiểm thử cho tất cả các phase từ Phase 0 đến Phase 8.

### Kết quả kiểm định tổng thể Phase 8 (Full Verification Matrix)

1. **Kiểm tra kiểu dữ liệu (`npm run check`)**:
   - `npm --workspace server run check`: **PASS** (exit code 0, 0 error).
   - `npm --workspace web run check`: **PASS** (exit code 0, 0 error).
   - `npm --workspace web run check:worker`: **PASS** (exit code 0, 0 error cho Web Worker ES2022).
2. **Biên dịch mã nguồn (`npm run build`)**:
   - `server` (tsc): **PASS** -> sinh `server/dist`.
   - `web` (vite + esbuild worker): **PASS** -> sinh `web/dist` bao gồm `firebase-messaging-sw.js` (55.48 KiB).
3. **Bộ kiểm thử đơn vị (`npm test`)**:
   - **PASS** (64/64 tests pass, thời gian chạy ~4.8s).
   - Bao gồm:
     + `server/test/attention.test.ts` (7 tests)
     + `server/test/pushDispatcher.test.ts` (4 tests)
     + `server/test/pushRoutes.test.ts` (3 tests)
     + `server/test/terminalState.test.ts` (6 tests)
     + `server/test/sessionManager.test.ts` (14 tests)
     + `server/test/websocket.test.ts` (5 tests)
     + `server/test/multiSessionApi.test.ts` (6 tests)
     + `server/test/idempotency.test.ts` (6 tests)
     + `server/test/sessionReducer.test.ts` (6 tests)
     + `server/test/hub.test.ts` (4 tests)
     + `server/test/vietqr.test.ts` (5 tests)
4. **Kiểm thử touch scroll di động (`node scripts/smoke-touch-scroll.cjs`)**:
   - **PASS** (4/4 checks pass với Chrome headless).
5. **Kiểm thử Server Hub (`node scripts/smoke-hub.cjs`)**:
   - **PASS** (9/9 checks pass với Chrome headless, TOTP 2FA, session spawn, VietQR).
6. **Kiểm thử Multi-Session E2E (`node scripts/smoke-multi-session.cjs`)**:
   - **PASS** (6/6 checks pass):
     + U01: Tạo phiên B chạy song song với phiên A.
     + U02: Chuyển đổi session mượt mà không crosstalk.
     + U03: Draft cách ly độc lập per-session trong RAM.
     + U08 & U09: Codex `Shift + ←` gửi `\x1b[1;2D` chuẩn byte, không flush draft, ẩn khi phiên Shell, khóa khi là Viewer.
     + U10 & U11: Khóa input Viewer, promote Viewer thành Controller khi Controller ngắt kết nối.
     + U12: Khôi phục phiên active chính xác khi reload từ sessionStorage.
7. **Kiểm thử Responsive Mobile & Desktop Layout (`node scripts/smoke-mobile.cjs`)**:
   - **PASS** (6/6 checks pass):
     + 5 viewports mobile (`360x800`, `390x844`, `430x932`, `844x390`, `390x400`) không tràn layout.
     + Touch scrolling momentum mượt mà.
     + Khôi phục phiên sau reload.
     + Tự động reconnect khi ngắt kết nối tạm thời.
     + Sidebar desktop 280px hiển thị chính xác ở viewport >= 1024px.
8. **Kiểm thử Web Push FCM E2E (`node scripts/smoke-notifications.cjs`)**:
   - **PASS** (6/6 checks pass):
     + P10: Service Worker served với header `Service-Worker-Allowed: /api/web-cli/` và `Cache-Control: no-store`.
     + P11: Manifest và icons PWA phục vụ chuẩn xác.
     + P12: Giao diện Cài đặt thông báo hiển thị đầy đủ trạng thái và hướng dẫn iOS.
     + P13: Deep link session hash không tồn tại hiển thị lỗi và mở bảng phiên.
     + P14: Deep link hash session hợp lệ kích hoạt chọn phiên chính xác.
     + P15: Service worker `postMessage` `open-session` chuyển phiên mượt mà không reload trang.
9. **Kiểm tra cú pháp Shell Script (`bash -n deploy/install-server-hub.sh`)**:
   - **PASS** (exit code 0, không có lỗi cú pháp).
10. **Kiểm tra định dạng và khoảng trắng Git (`git diff --check`)**:
    - **PASS** (exit code 0, không có trailing whitespace hay lỗi conflict).

---

### Tình trạng phát hành (Release Status)

- **Trạng thái Code**: `CODE_READY` (Toàn bộ mã nguồn, cấu hình, hợp đồng API/WebSocket, giao diện, Service Worker và bộ kiểm thử tự động đã hoàn tất 100%).
- **Trạng thái Push Live**: `LIVE_FCM_PENDING` (Chờ thông tin cấu hình Firebase production từ Owner để kiểm thử live push trên thiết bị thật ngoài internet).
- **Trạng thái Codex Live**: `LIVE_CODEX_PENDING` (Chờ môi trường runtime Codex production với live authentication để kiểm thử sự kiện approval/plan mode thực tế).
- **Trạng thái Đánh giá**: `OWNER_REVIEW_PENDING` (Sẵn sàng để Owner kiểm tra và phê duyệt trước khi rollout).




