# Second Review Fix Validation

## Baseline
- base: `0a24ac161ef8343e2b618e37b7498db8c31717d3`
- final: `0b6c0a484c2f829f0f92b7c6569ecdeea07dfc41`
- node: `v24.16.0`
- npm: `12.0.2`
- OS: Linux mrhoan 6.1.0-53-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.187-1 (2026-09-07) x86_64 GNU/Linux
- Chrome: Google Chrome 153.0.8010.36

---

## Phase 1 — Global Xterm Queue
### Files
- [`web/src/lib/xtermOperationQueue.ts`](file:///home/mrhoan/source/web-cli/web/src/lib/xtermOperationQueue.ts)
- [`server/test/terminalSync.test.ts`](file:///home/mrhoan/source/web-cli/server/test/terminalSync.test.ts)

### Tests
- **XQ1** (Tái hiện bug baseline): Old write in-flight -> new reset waits. Khi session cũ có write promise chưa hoàn tất, chuyển sang session mới và gọi `barrier()` đảm bảo reset terminal đợi write cũ kết thúc hoàn toàn trước khi reset terminal, ngăn chặn buffer contamination.
- **XQ2** (Kiểm chứng hạ tầng): Rapid A/B/A switching không gây xterm buffer contamination. Các thao tác của generation cũ bị discard thông qua queue generation marker.
- **XQ3** (Kiểm chứng hạ tầng & bảo vệ lifecycle): Reconnect cùng session generation barrier; các write của attempt cũ hoàn tất hoặc bị discard trước khi reset cho attempt mới.

### Commands
```bash
npx tsx --test server/test/terminalSync.test.ts
```

### Result
PASS (15/15 tests trong `terminalSync.test.ts`).

---

## Phase 2 — Ordered Output/Resize
### Files
- [`web/src/lib/terminalSync.ts`](file:///home/mrhoan/source/web-cli/web/src/lib/terminalSync.ts)
- [`server/test/terminalSync.test.ts`](file:///home/mrhoan/source/web-cli/server/test/terminalSync.test.ts)

### Tests
- **OR1** (Tái hiện bug baseline): Output seq=10 bị hoãn -> resize seq=11 chỉ được thực thi sau khi write của output 10 đã resolve, đảm bảo thứ tự tuần tự hóa tuyệt đối.
- **OR2** (Bảo vệ contract): Chuỗi output10 -> resize11 -> output12 được thực thi tuần tự không đảo lộn.
- **OR3** (Bảo vệ contract baseline): Duplicate resize (`seq < expected`) bị bỏ qua, không enqueue.
- **OR4** (Bảo vệ contract baseline): Resize gap (`seq > expected`) kích hoạt `onMismatchOrGap` và không enqueue.
- **OR5** (Kiểm chứng tính năng mới): Live output/resize đến sau `sync_end` hợp lệ được đệm trong khi snapshot đang drain; sau khi snapshot drain xong, `expectedSeq` được duy trì chính xác và live queue được drain tuần tự.
- **OR6** (Kiểm chứng tính năng mới): Giới hạn `liveBacklogBytes` (64KB UTF-8) kiểm soát lượng backlog trong lúc snapshot drain; nếu tràn backlog sẽ kích hoạt lỗi giao thức, hủy attempt và kích hoạt reconnect an toàn thay vì drop packet đơn lẻ.

### Commands
```bash
npx tsx --test server/test/terminalSync.test.ts
```

### Result
PASS (OR1 - OR6 PASS).

---

## Phase 3 — Reconnect Production Wiring
### Files
- [`web/src/lib/terminalConnection.ts`](file:///home/mrhoan/source/web-cli/web/src/lib/terminalConnection.ts)
- [`web/src/components/TerminalPane.tsx`](file:///home/mrhoan/source/web-cli/web/src/components/TerminalPane.tsx)
- [`server/test/reconnectPolicy.test.ts`](file:///home/mrhoan/source/web-cli/server/test/reconnectPolicy.test.ts)

### Tests
- **RP1** (Tái hiện bug baseline): `TerminalPane.tsx` production trực tiếp import và sử dụng `ReconnectManager` và `TerminalConnectionSession`.
- **RP2** (Tái hiện bug baseline): `onMismatchOrGap` chỉ vô hiệu hóa attempt hiện tại; duy nhất socket `close` handler là owner tính toán retry, ngăn chặn việc 1 gap sequence tiêu tốn 2 attempt retry song song.
- **RP3** (Tái hiện bug baseline): 5 lần thất bại TCP-open/sync liên tiếp dừng retry và kích hoạt `onReconnectExhausted`, hiển thị nút "Nối lại" thủ công.
- **RP4** (Bảo vệ contract): Mã đóng socket 4004 (Session Removed) hoặc 404 dừng retry ngay lập tức với `onSessionMissing`.
- **RP5** (Tái hiện bug baseline): Snapshot callback của socket đã đóng không thể kết nối lại UI hoặc reset retry counter.
- **RP6** (Tái hiện bug baseline): Sequence gap vô hiệu hóa attempt cũ; các callback muộn của attempt cũ không ảnh hưởng đến socket mới.

### Commands
```bash
npx tsx --test server/test/reconnectPolicy.test.ts
```

### Result
PASS (11/11 tests trong `reconnectPolicy.test.ts`).

---

## Phase 4 — Mobile Dialog Lifecycle
### Files
- [`web/src/components/SessionManager.tsx`](file:///home/mrhoan/source/web-cli/web/src/components/SessionManager.tsx)
- [`web/src/components/NewSessionDialog.tsx`](file:///home/mrhoan/source/web-cli/web/src/components/NewSessionDialog.tsx)
- [`scripts/smoke-mobile.cjs`](file:///home/mrhoan/source/web-cli/scripts/smoke-mobile.cjs)

### Tests
- **M1** (Tái hiện bug baseline): Loại bỏ `setTimeout(..., 50)`, dùng `pendingNewSessionRef` và native `<dialog onClose>`. Mở mobile sheet -> click "+ Phiên mới" -> xác thực `document.querySelectorAll("dialog[open]").length <= 1` xuyên suốt toàn bộ quá trình chuyển đổi.
- **M2** (Tương tự cho "+ Ở đây"): Click "+ Ở đây" trong mobile sheet -> chỉ đúng 1 dialog mở.
- **M3** (Kiểm chứng tính năng): Hủy New Session dialog -> toàn bộ dialog đóng sạch (`length === 0`), focus hợp lệ trên document.
- **M4** (Bảo vệ hạ tầng): 20 chu kỳ mở/đóng dialog liên tiếp trên Puppeteer mobile mà không gặp lỗi `InvalidStateError` hay `pageerror`.

### Commands
```bash
node scripts/smoke-mobile.cjs
```

### Result
PASS (Exit code 0, 0 page errors, M1-M4 passed).

---

## Phase 5 — FCM
### Status
- Giữ `FCM_ENABLED=false` mặc định theo Section 7.5 và Section 15 của kế hoạch vì môi trường hiện tại chưa cấu hình Firebase credentials live.
- Các test F2.1–F2.4 chưa được kích hoạt và không được đánh dấu PASS giả.
- Multi-session release không bị block bởi FCM vì tính năng push notification đang ở trạng thái disabled an toàn.

---

## Phase 6 — Polling
### Files
- [`web/src/lib/pollingPolicy.ts`](file:///home/mrhoan/source/web-cli/web/src/lib/pollingPolicy.ts)
- [`web/src/features/sessions/useSessions.ts`](file:///home/mrhoan/source/web-cli/web/src/features/sessions/useSessions.ts)
- [`server/test/pollingPolicy.test.ts`](file:///home/mrhoan/source/web-cli/server/test/pollingPolicy.test.ts)

### Tests
- **P3** (Tái hiện bug baseline): Error exponential backoff tuân theo base delay: 1 -> 1s, 2 -> 2s, 3 -> 4s, 4 -> 8s, 5+ -> 15s (+ jitter 0..20%).
- **P4** (Tái hiện bug baseline): Chuỗi lỗi error, error, sau đó success -> `retryCount` được reset về 0 và chu kỳ delay tiếp theo trở về 5000ms thông thường.
- **P5** (Tái hiện bug baseline): GET explicit thành công khi không có active session -> không duy trì timer poll 5s. Khi có active session -> xóa active session sẽ lập tức hủy timer polling định kỳ.
- **P6** (Kiểm chứng tính năng mới): Khi active session được tạo/chọn/restore -> đúng một timer 5s được khởi động. Chuyển đổi session A -> B khi vẫn có active session không tạo timer kép và không reset backoff retry.
- **P7** (Kiểm chứng tính năng mới): Khi đăng nhập lần đầu gặp lỗi mạng, scheduler vẫn retry theo backoff dù chưa có active session; khi retry thành công và khôi phục session -> backoff reset và kích hoạt timer 5s. Khi unmount/logout, các completion muộn không tạo timer mới.

### Commands
```bash
npx tsx --test server/test/pollingPolicy.test.ts
```

### Result
PASS (5/5 tests trong `pollingPolicy.test.ts`).

---

## Phase 7 — Exit Reason
### Files
- [`server/src/sessionManager.ts`](file:///home/mrhoan/source/web-cli/server/src/sessionManager.ts)
- [`server/test/sessionManager.test.ts`](file:///home/mrhoan/source/web-cli/server/test/sessionManager.test.ts)

### Tests
- **ER1** (Tái hiện bug baseline): Restart session đã kết thúc tự nhiên (`natural`) không bị ghi đè `exitReason` thành `"restart"`. Mối quan hệ giữa phiên cũ và phiên mới được duy trì qua `replacementSessionId` và `replacedFromSessionId`.
- **ER2** (Bảo vệ contract): Restart session đang chạy (`running`) dừng PTY và gán chính xác `exitReason = "restart"`.

### Commands
```bash
npx tsx --test server/test/sessionManager.test.ts
```

### Result
PASS (16/16 tests trong `sessionManager.test.ts`).

---

## Phase 8 — Browser CI
### Details
- **Workflow file**: [`.github/workflows/ci.yml`](file:///home/mrhoan/source/web-cli/.github/workflows/ci.yml)
- **Job**: `browser-smoke` (chạy sau `build-and-test` trên cả `push` và `pull_request` vào `main`).
- **Steps**:
  1. `npm ci`
  2. `npm run build`
  3. `node scripts/smoke-multi-session.cjs`
  4. `node scripts/smoke-mobile.cjs`
- **Tested commit**: `0b6c0a484c2f829f0f92b7c6569ecdeea07dfc41`
- **CI run URL**: `PENDING (awaiting git push to origin/main)`
- **PR/push trigger**: `push/pull_request`
- **smoke-multi-session local result**: PASS (Exit code 0)
- **smoke-mobile local result**: PASS (Exit code 0)
- **Result**: `PENDING (Local PASS, CI workflow configured)`

---

## Final Verification Checklist
- **npm run check**: PASS (TypeScript check exit code 0)
- **npm run build**: PASS (Client & server build exit code 0)
- **npm test**: PASS (109/109 tests passed, 0 failures)
- **smoke-multi-session**: PASS (Exit code 0)
- **smoke-mobile**: PASS (Exit code 0, 5 viewport sizes, M1-M4 passed)
- **git diff --check**: PASS (Sạch whitespace và EOF)
- **FCM live tested**: DEFERRED (`FCM_ENABLED=false` documented)
