# WEB CLI — POST-REVIEW FIX MASTER IMPLEMENTATION PLAN

> **Mục đích của tài liệu này:** đây là kế hoạch sửa lỗi sau review cho implementation multi-session hiện tại của repository `nguyenduchoan/web-cli`.
>
> **Target baseline đã review:** commit `ce0fbba872f0ab41b2b03d83ad68fdffa0fd2b60`.
>
> **Đối tượng thực hiện:** coding agent có khả năng suy luận hạn chế. Vì vậy **không tự rút gọn yêu cầu, không tự đổi kiến trúc, không bỏ test, không suy đoán ý định**. Làm đúng từng phase, từng gate, từng acceptance criterion trong file này.
>
> **Nguyên tắc quan trọng nhất:** ưu tiên correctness của terminal multi-session trước UI polish và trước FCM. Không được đánh dấu hoàn tất chỉ vì `npm test` xanh nếu các gate E2E/corner-case trong tài liệu này chưa chạy và chưa PASS.

---

# 0. MỤC TIÊU, PHẠM VI VÀ THỨ TỰ ƯU TIÊN

Implementation hiện tại đã giải quyết đúng bài toán kiến trúc chính:

- Có nhiều PTY chạy độc lập theo session UUID.
- Có SessionManager phía backend.
- Có protocol WebSocket v2 và terminal snapshot.
- Có reducer/hook multi-session phía frontend.
- Có controller/viewer khi nhiều tab cùng attach vào một PTY.
- Có UI Session Manager desktop/mobile.
- Có retained session, restart, kill, idempotency.
- Có FCM/Web Push được thêm chung vào commit.

Tuy nhiên review sau implement phát hiện một số lỗi correctness/lifecycle chưa được test đầy đủ.

## 0.1 Severity

### P1 — PHẢI SỬA TRƯỚC KHI DEPLOY MULTI-SESSION

1. WebSocket v2 `liveQueue` trong lúc snapshot sync **không bounded theo bytes**, có thể tăng RAM không giới hạn.
2. Frontend `TerminalPane` **đánh dấu sync complete trước khi xterm apply snapshot hoàn tất**.
3. Frontend **không restore terminal grid đúng cols/rows snapshot cho controller trước khi deserialize**.

### P1 NẾU BẬT FCM

4. Logout revoke push registration ở backend nhưng browser giữ consent; login lại UI có thể báo “Đã bật” dù backend đã không còn device.

### P2 — PHẢI SỬA TRƯỚC RELEASE PRODUCTION

5. Backend trả error code trong field `error`, frontend chủ yếu đọc `body.code`.
6. WebSocket reconnect không dừng sau 5 lần như contract.
7. Session bị `removed`/404 chưa chuyển hẳn sang `missing` và chưa dừng reconnect đúng.
8. Same-folder warning đang so sánh project/subpath thay vì canonical `workingDirectoryId`.
9. Mobile có thể mở hai native `<dialog>` modal chồng nhau.
10. New Session dialog có thể giữ lại project/subpath từ lần mở trước.
11. PushStore delete device có lỗi auth-scope mismatch vẫn xóa device.

### P3 — HARDENING

12. Draft/attention RAM state không được prune đầy đủ khi retention remove/logout.
13. Polling retry backoff bị timer 5 giây ghi đè trong một số flow.
14. Smoke scripts phụ thuộc Puppeteer path hard-code ngoài repo.
15. Commit hiện không có CI/check status chứng minh test trên clean environment.

---

# 1. QUY TẮC THỰC THI BẮT BUỘC

Agent phải tuân thủ tất cả các quy tắc sau.

## 1.1 Không mở rộng scope

Không làm các việc sau nếu không được yêu cầu riêng:

- Không refactor toàn bộ SessionManager.
- Không đổi framework.
- Không thay xterm bằng thư viện khác.
- Không đổi auth model.
- Không thêm Redis/database.
- Không thêm “claim control”.
- Không thêm Stop All.
- Không thêm persistence cho terminal output.
- Không thêm retry cho mutation create/restart/kill ngoài contract hiện có.
- Không sửa unrelated styling.
- Không đổi route public hiện tại nếu không cần thiết.
- Không thay contract API đã dùng bởi code hiện tại nếu có thể sửa tương thích hai phía.

## 1.2 Mỗi phase phải độc lập kiểm chứng được

Sau mỗi phase:

1. Chạy typecheck.
2. Chạy unit/integration test liên quan.
3. Không tiếp tục phase kế tiếp nếu gate phase hiện tại fail.
4. Ghi lại file đã sửa.
5. Ghi lại test đã thêm.
6. Ghi lại lệnh đã chạy và exit code.

## 1.3 Không xóa test để làm build xanh

Nếu test cũ fail sau sửa:

- Tìm nguyên nhân.
- Chỉ sửa assertion nếu contract thật sự thay đổi theo tài liệu này.
- Không skip test.
- Không comment-out test.
- Không tăng timeout vô lý để che race condition.
- Không đổi test sang happy-path yếu hơn.

## 1.4 Không coi console log là bằng chứng correctness

Các câu như:

- “looks good”
- “probably fixed”
- “should work”
- “smoke likely passes”

không được tính là validation.

Phải có assertion tự động hoặc bước manual reproduction được mô tả rõ.

---

# 2. BASELINE VÀ FILE CẦN ĐỌC TRƯỚC KHI SỬA

Trước khi code, đọc toàn bộ các file sau:

```text
docs/MULTI_SESSION_MASTER_IMPLEMENTATION_PLAN.md
docs/agile/changes/multi-session-validation.md

server/src/sessionManager.ts
server/src/sessionRoutes.ts
server/src/websocket.ts
server/src/terminalState.ts
server/src/httpErrors.ts
server/src/idempotency.ts

web/src/components/TerminalPane.tsx
web/src/features/sessions/useSessions.ts
web/src/features/sessions/sessionReducer.ts
web/src/features/sessions/sessionTypes.ts
web/src/lib/api.ts
web/src/lib/types.ts

web/src/components/SessionManager.tsx
web/src/components/SessionList.tsx
web/src/components/SessionItem.tsx
web/src/components/NewSessionDialog.tsx
web/src/components/ProjectSelector.tsx
web/src/App.tsx

server/src/pushStore.ts
server/src/pushDispatcher.ts
server/src/pushRoutes.ts
server/src/webAuth.ts
web/src/lib/push.ts
web/src/components/NotificationSettings.tsx

server/test/websocket.test.ts
server/test/sessionManager.test.ts
server/test/multiSessionApi.test.ts

scripts/smoke-multi-session.cjs
scripts/smoke-mobile.cjs
scripts/smoke-notifications.cjs
```

Sau đó xác nhận branch đang sửa có chứa baseline review tương đương commit:

```text
ce0fbba872f0ab41b2b03d83ad68fdffa0fd2b60
```

Nếu branch đã có commit mới hơn, **không reset**. Chỉ so diff để biết bug nào đã được sửa rồi.

---

# 3. PHASE 1 — FIX API ERROR CONTRACT

## 3.1 Vấn đề

Backend session API dùng helper:

```ts
sendError(reply, status, message, code)
```

và payload hiện có dạng:

```json
{
  "error": "session_capacity_reached",
  "message": "Maximum of 3 active sessions reached"
}
```

Nhưng frontend `web/src/lib/api.ts` đọc:

```ts
code = body.code;
```

Do đó các lỗi session có thể tạo:

```ts
ApiError.code === undefined
```

dù backend đã trả error code đúng.

## 3.2 File sửa

```text
web/src/lib/api.ts
```

Có thể thêm test frontend helper nếu project có hạ tầng test phù hợp. Nếu không có frontend unit runner thì bắt buộc test API helper qua một test tách được hoặc smoke bằng browser.

## 3.3 Logic bắt buộc

Type body phải hỗ trợ cả hai field vì notification endpoints hiện dùng `code`, session endpoints dùng `error`.

Sửa từ logic tương đương:

```ts
code = body.code;
```

thành:

```ts
code = body.code ?? body.error;
```

Type:

```ts
type ApiErrorBody = {
  error?: string;
  code?: string;
  message?: string;
  loginUrl?: string;
};
```

Không được bỏ support `code`, vì push routes hiện có response dùng `code`.

## 3.4 Acceptance tests bắt buộc

Test ít nhất các case:

```text
HTTP 429 body {error:"session_capacity_reached",message:"..."}
=> thrown ApiError.code === "session_capacity_reached"

HTTP 409 body {error:"session_operation_in_progress",message:"..."}
=> ApiError.code === "session_operation_in_progress"

HTTP 409 body {code:"notifications_disabled",message:"..."}
=> ApiError.code === "notifications_disabled"
```

## 3.5 Gate Phase 1

PASS khi:

- Typecheck frontend xanh.
- Error contract test xanh.
- Không đổi backend response shape chỉ để né bug frontend.

---

# 4. PHASE 2 — FIX TERMINAL V2 SNAPSHOT RESTORE CORRECTNESS

Đây là phase quan trọng nhất.

## 4.1 Vấn đề A — sync_end đến trước khi xterm write hoàn tất

Current flow gần tương đương:

```text
snapshot_chunk -> terminal.write(...)
snapshot_chunk -> terminal.write(...)
sync_end       -> syncComplete = true
```

`Terminal.write()` có parse queue nội bộ. Gọi `write()` không đồng nghĩa terminal state đã apply xong ngay lập tức.

Nếu bật input ngay ở `sync_end`, người dùng có thể input trong lúc:

- snapshot chưa apply hết,
- bracketedPasteMode chưa restore,
- cursor/mode chưa restore,
- alternate buffer chưa restore.

## 4.2 Vấn đề B — controller không resize về snapshot grid trước restore

Current code chỉ:

```ts
if (message.control === "viewer") {
  terminal.resize(message.cols, message.rows);
}
```

Controller cũng phải deserialize snapshot ở đúng grid kích thước server snapshot.

## 4.3 Vấn đề C — chưa verify chunk index/chunkCount đầy đủ

Frontend phải không chấp nhận snapshot nếu:

- index bị bỏ,
- index lặp sai,
- chunkCount không khớp,
- syncId không khớp,
- sessionId không khớp,
- serverEpoch không khớp,
- connection generation đã stale.

## 4.4 File sửa

```text
web/src/components/TerminalPane.tsx
web/src/lib/types.ts   // chỉ nếu cần type bổ sung
```

Có thể tạo helper riêng:

```text
web/src/lib/terminalSync.ts
```

nếu làm vậy giúp code rõ hơn. Không bắt buộc.

## 4.5 State/ref cần có

Agent phải quản lý tối thiểu:

```ts
const syncIdRef = useRef("");
const syncCompleteRef = useRef(false);
const expectedSnapshotChunkRef = useRef(0);
const expectedSnapshotChunkCountRef = useRef<number | null>(null);
const pendingSnapshotWritesRef = useRef(Promise.resolve());
const expectedSeqRef = useRef(0);
```

Nếu dùng queue khác thì phải giữ cùng semantics.

## 4.6 Quy trình đúng bắt buộc

### Khi nhận `sync_start`

Phải thực hiện theo thứ tự:

```text
1. Verify sessionId của message = current session.
2. Verify serverEpoch hợp lệ với attach hiện tại.
3. Verify current socket identity.
4. Verify current connection generation.
5. syncComplete=false.
6. block input.
7. syncing=true.
8. save syncId.
9. expected chunk index = 0.
10. reset terminal.
11. resize terminal = snapshot cols/rows CHO CẢ controller và viewer.
12. chưa fit theo viewport ở bước này.
13. chưa gửi resize lên server ở bước này.
14. set role từ message.control.
```

### Khi nhận `snapshot_chunk`

Phải:

```text
1. Verify syncId.
2. Verify sessionId.
3. Verify epoch/generation/socket.
4. Verify index == expectedSnapshotChunkIndex.
5. Nếu sai -> abort current socket + reconnect snapshot mới.
6. Queue terminal.write theo thứ tự.
7. Chỉ tăng expected index sau khi chunk được chấp nhận.
```

Nên wrap `terminal.write(data, callback)` thành Promise:

```ts
function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve);
  });
}
```

Sau đó serialize:

```ts
snapshotWriteChain = snapshotWriteChain.then(
  () => writeTerminal(terminal, message.data)
);
```

Không fire-and-forget.

### Khi nhận `sync_end`

Không set connected ngay.

Phải:

```text
1. Verify syncId.
2. Verify received chunk count == message.chunkCount.
3. Await toàn bộ snapshot write chain.
4. Sau await, verify socket/session/generation vẫn còn hợp lệ.
5. Set expected terminal seq = baseSeq + 1.
6. syncComplete=true.
7. syncing=false.
8. connected=true.
9. Nếu role controller:
     - fit/propose viewport,
     - resize local terminal nếu cần,
     - gửi resize lên server sau sync.
10. Chỉ lúc này mới unblock input.
```

## 4.7 Switch A -> B race bắt buộc xử lý

Case:

```text
Session A đang restore snapshot chunk cuối
↓
User switch sang Session B
↓
callback terminal.write của A chạy muộn
```

Callback A **không được**:

- bật connected cho B,
- ghi state connection của B,
- gọi resize của B,
- unblock input B sai lúc.

Nếu xterm instance dùng chung và `terminal.write` của A vẫn có thể apply sau reset B thì phải có barrier/drain trước khi render B.

Cách an toàn được chấp nhận:

### Option A — queue global theo xterm instance

Mọi write của snapshot/live output đi qua một serialized write chain.

Khi switch:

```text
invalidate generation
wait/drain prior chain
reset
start B sync
```

### Option B — recreate xterm instance theo session generation

Chỉ dùng nếu không phá touch scroll, fit, performance và tests hiện có.

Ưu tiên Option A vì ít thay đổi architecture.

## 4.8 Live `output` và `terminal_resize`

Sau sync complete:

- `seq <= appliedSeq`: duplicate -> bỏ.
- `seq === appliedSeq + 1`: apply.
- `seq > appliedSeq + 1`: gap -> block input + close/reconnect.

Không được apply out-of-order.
