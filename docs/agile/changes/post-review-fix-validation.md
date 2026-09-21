# Post-review Fix Validation

## Baseline

- Base commit: `c07e22b7b2b33c84dfca1711d945073e2481c310`
- Node: `v24.16.0`
- npm: `12.0.2`
- OS: `Linux 6.1.0-53-amd64 x86_64`
- Chrome/Chromium: `Google Chrome 153.0.8010.36`

---

## Phase 1 — API Error Contract

### Files changed
- `web/src/lib/api.ts`: Chuẩn hóa `extractApiErrorInfo(status, body)` trích xuất `code = body.code ?? body.error`, ưu tiên `code`, hỗ trợ đầy đủ `429 session_capacity_reached` và `409 notifications_disabled`.

### Tests added
- `server/test/apiError.test.ts`:
  - `extractApiErrorInfo preserves session error code from error field` (PASS)
  - `extractApiErrorInfo preserves error code from code field (notifications)` (PASS)
  - `extractApiErrorInfo prioritizes code over error if both present` (PASS)
  - `extractApiErrorInfo falls back to generic status message on non-object body` (PASS)

### Commands
- `npm run check` — PASS
- `npm --workspace server run test -- test/apiError.test.ts` — PASS

### Result
PASS

---

## Phase 2 — Terminal v2 Snapshot Restore Correctness

### Files changed
- `web/src/lib/terminalSync.ts`: Tạo `TerminalSyncController` quản lý hàng đợi ghi tuần tự (`writeChain`), bảo đảm geometry cols/rows được khôi phục trước khi viewport fit, xác thực chunk index và chunk count (`sync_end`), phát hiện sequence gap và generation invalidation khi đổi phiên.
- `web/src/components/TerminalPane.tsx`: Ủy quyền xử lý `sync_start`, `sync_chunk`, `sync_end`, `output` cho `TerminalSyncController`. Không cho phép nhập liệu trước khi snapshot drain hoàn tất.

### Tests added
- `server/test/terminalSync.test.ts`:
  - `T2.1: Controller snapshot geometry restores server cols/rows before viewport fit` (PASS)
  - `T2.2: Input not enabled early; syncComplete only true after pending writes complete` (PASS)
  - `T2.3: Chunk gap triggers onMismatchOrGap and rejects sync` (PASS)
  - `T2.4: Chunk count mismatch on sync_end triggers onMismatchOrGap` (PASS)
  - `T2.5: Session switch late write does not overwrite session B or mark it complete` (PASS)
  - `T2.6: Output seq gap triggers onMismatchOrGap; duplicate is ignored` (PASS)

### Commands
- `npm run check` — PASS
- `npm --workspace server run test -- test/terminalSync.test.ts` — PASS

### Result
PASS

---

## Phase 3 — Bound WebSocket v2 Live Queue during sync

### Files changed
- `server/src/websocket.ts`: Thêm trường `liveQueueBytes` vào `AttachedClient`. Tính toán dung lượng hàng đợi bằng byte UTF-8 thực tế (`Buffer.byteLength(..., "utf8")`). Đóng socket client đồng bộ chậm với close code `1013` khi vượt ngưỡng `maxWebsocketBufferedBytes`. Reset bộ đếm khi drain hoặc cleanup. Không bao giờ pause PTY.

### Tests added
- `server/test/websocket.test.ts`:
  - `W11: Sync liveQueue bounded; overflow closes socket with 1013 and leaves session running` (PASS)
  - `W12: Unicode byte accounting computes UTF-8 byte length rather than string length` (PASS)
  - `W13: Slow syncing client does not pause/kill PTY or disconnect other clients` (PASS)
  - `WQ3: Normal small backlog is drained in order after sync completes` (PASS)

### Commands
- `npm run check` — PASS
- `npm --workspace server run test -- test/websocket.test.ts` — PASS

### Result
PASS

---

## Phase 4 — Reconnect, Missing Session, and Close Code Handling

### Files changed
- `web/src/lib/reconnectPolicy.ts`: Cài đặt `ReconnectManager` với exponential backoff (1s, 2s, 4s, 8s, 15s), chặn tối đa 5 lần thử. Nhận diện các close code dứt điểm không retry (4001, 4004 session missing, 4003). Chỉ reset `attempt = 0` khi sync thành công (không reset ở TCP open).
- `web/src/components/TerminalPane.tsx`: Tích hợp `ReconnectManager`, phân định rõ `onSessionMissing` và `onReconnectExhausted`.
- `web/src/App.tsx`: Xử lý `handleSessionMissing`, `handleReconnectExhausted`, hiển thị trạng thái ngắt kết nối và nút "Nối lại" thủ công.

### Tests added
- `server/test/reconnectPolicy.test.ts`:
  - `R1: Reconnect follows 1s, 2s, 4s, 8s, 15s delays and stops after 5 consecutive attempts` (PASS)
  - `R2: Socket close code 4004 (Session Removed) stops retry immediately with session_missing` (PASS)
  - `R3: Ticket endpoint 404 or unknown_session stops retry immediately with session_missing` (PASS)
  - `R4: 1013 (Try again later / overflow) is retryable; eventual sync success resets attempt to 0` (PASS)
  - `R5: TCP open does not reset retry counter; sync failure accumulates until 5 attempts` (PASS)

### Commands
- `npm run check` — PASS
- `npm --workspace server run test -- test/reconnectPolicy.test.ts` — PASS

### Result
PASS

---

## Phase 5 — Session Reducer Cleanup và Polling Backoff

### Files changed
- `web/src/features/sessions/sessionTypes.ts`: Thêm action `{ type: "RESET_SESSIONS" }`.
- `web/src/features/sessions/sessionReducer.ts`: Export `pruneKeyedState<T>()`. Tự động dọn dẹp các session ID không còn trong danh snapshot authoritative khỏi `draftsBySessionId`, `attentionBySessionId`, `seenAttentionBySessionId`. Xử lý `RESET_SESSIONS`.
- `web/src/features/sessions/useSessions.ts`: Dispatch `RESET_SESSIONS` khi đăng xuất hoặc mất phiên. Chuyển quyền quản lý timer retry/polling duy nhất về cho polling loop (tránh race condition với timer phụ trong `fetchSessions`). Cài đặt exponential backoff (1s, 2s, 4s, 8s, 15s) khi lỗi và reset về 5s khi thành công.
- `web/src/App.tsx`: Dispatch `RESET_SESSIONS` tại `logout()` và `web-cli-auth-expired`.

### Tests added
- `server/test/sessionReducer.test.ts`:
  - `P5.1: LOAD_SESSIONS prunes stale drafts, attention, and seenAttention for missing sessions` (PASS)
  - `P5.2: RESET_SESSIONS resets sessions, drafts, attention, and connection state to clean initial state` (PASS)

### Commands
- `npm run check` — PASS
- `npm --workspace server run test -- test/sessionReducer.test.ts` — PASS

### Result
PASS

---

## Phase 6 — Canonical Working Directory và Same-Folder Warning

### Files changed
- `server/src/sessionRoutes.ts`: Endpoint `/api/browse/:projectId` chuẩn hóa `realProjectRoot` bằng `fs.realpath()`, tính `canonicalSubpath` tương đối với `realProjectRoot`, tạo `workingDirectoryId` bằng SHA-256 của real path.
- `web/src/components/ProjectSelector.tsx`: Truyền `workingDirectoryId` qua `onSelect`.
- `web/src/components/NewSessionDialog.tsx`: So khớp cảnh báo cùng thư mục dựa trên `workingDirectoryId` canonical thay vì string so sánh lỏng lẻo.

### Tests added
- `server/test/multiSessionApi.test.ts`:
  - `symlink directory resolves to identical workingDirectoryId and canonicalSubpath as real directory (Phase 6)` (PASS)

### Commands
- `npm run check` — PASS
- `npm --workspace server run test -- test/multiSessionApi.test.ts` — PASS

### Result
PASS

---

## Phase 7 — New Session Dialog State và Mobile Modal Flow

### Files changed
- `web/src/components/NewSessionDialog.tsx`: Reset trạng thái project/subpath khi mở generic "+ Phiên mới", chỉ giữ `lastAgentIdRef` theo master plan.
- `web/src/components/SessionManager.tsx`: Đóng mobile sheet (`onCloseMobileSheet`) trước khi mở `NewSessionDialog`, loại bỏ hoàn toàn hiện tượng 2 dialog native cùng gọi `showModal()` trên mobile.

### Commands
- `npm run check` — PASS
- `npm run build` — PASS

### Result
PASS

---

## Phase 8 — FCM / Web Push Lifecycle Hardening

### Files changed
- `server/src/pushStore.ts`: Sửa lỗi logic `deleteDevice`: khi `authScope` không khớp với `dev.webAuthScope`, giữ nguyên thiết bị thay vì xóa nhầm thiết bị của phiên khác.
- `web/src/lib/push.ts`: Thêm `cleanupPushListeners()` giải phóng các listener `onMessage` và `onRegistered`. Tự động hủy đăng ký listener cũ trước khi gán mới để tránh duplicate notification banner.
- `web/src/App.tsx`: Gọi `clearPushConsent()` và `cleanupPushListeners()` khi `logout()` thành công hoặc khi phiên đăng nhập hết hạn (`web-cli-auth-expired`).

### Tests added
- `server/test/pushRoutes.test.ts`:
  - `PushStore: deleteDevice with mismatched authScope keeps device, matching authScope deletes it (Phase 8)` (PASS)

### Commands
- `npm run check` — PASS
- `npm --workspace server run test -- test/pushRoutes.test.ts` — PASS

### Result
PASS

---

## Phase 9 — Smoke Test Reproducibility

### Files changed
- `package.json`: Bổ sung `puppeteer-core` vào `devDependencies`.
- `scripts/smoke-utils.cjs`: Module tiện ích chung dùng `resolvePuppeteer()` và `resolveChromePath()`, ưu tiên package nội bộ của project và tự động tìm binary Chrome/Chromium có sẵn trên hệ thống.
- Cập nhật các file kịch bản kiểm thử, loại bỏ toàn bộ đường dẫn hardcode `/home/mrhoan/...`:
  - `scripts/smoke-multi-session.cjs`
  - `scripts/smoke-mobile.cjs`
  - `scripts/smoke-notifications.cjs`
  - `scripts/smoke-hub.cjs`
  - `scripts/smoke-touch-scroll.cjs`
  - `scripts/verify-hub-deployment.cjs`

### Commands
- `node scripts/smoke-touch-scroll.cjs` — PASS
- `node scripts/smoke-multi-session.cjs` — PASS
- `node scripts/smoke-mobile.cjs` — PASS
- `node scripts/smoke-notifications.cjs` — PASS

### Result
PASS

---

## Phase 10 — CI Workflow & Automated Evidence

### Files changed
- `.github/workflows/ci.yml`: Workflow GitHub Actions chạy tự động trên các sự kiện `push` và `pull_request` nhánh `main`:
  - `npm ci`
  - `npm run check`
  - `npm run build`
  - `npm test`
  - `git diff --check`

### Result
PASS

---

## Final Gate

- `npm run check`: PASS (server & web tsc pass without errors)
- `npm run build`: PASS (server build & web vite production bundle pass)
- `npm test`: PASS (87/87 tests pass across 12 test suites)
- `smoke-multi-session`: PASS (U01, U02, U03, U08, U09, U10, U11, U12 pass)
- `smoke-mobile`: PASS (5 mobile viewport sizes, touch scroll, 2FA, reconnection pass)
- `smoke-notifications`: PASS (P10, P11, P12, P13, P14, P15 pass)
- `smoke-touch-scroll`: PASS (CDP touch emulation drag across history, momentum pass)
- `git diff --check`: PASS (clean diff, no whitespace errors or conflicts)
- `CI workflow`: Configured at `.github/workflows/ci.yml`

---

## Remaining limitations

- Live FCM tested: NO (Production FCM credentials are not in repository; mock/simulated FCM flows pass all tests; `FCM_ENABLED=false` remains safe default).
- iOS manual test: Tested via Chrome Mobile Emulation (WebKit touch and home screen install requires physical iOS device for live notification check).
- Any known blocker: None.
