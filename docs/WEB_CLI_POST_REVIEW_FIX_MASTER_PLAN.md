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

## 4.9 Test bắt buộc Phase 2

Thêm test hoặc browser test cho ít nhất:

### T2.1 Controller snapshot geometry

```text
server snapshot 100x30
client xterm trước đó 80x24
attach controller
=> snapshot restore ở 100x30 trước khi fit viewport
```

### T2.2 Input không bật sớm

Dùng mock/delayed terminal write:

```text
snapshot_chunk write callback bị delay 100ms
sync_end đến trước callback
=> command input vẫn disabled
=> callback hoàn tất
=> mới connected/controller usable
```

### T2.3 Chunk gap

```text
chunk index 0
chunk index 2
=> socket bị reconnect
=> không đánh dấu sync complete
```

### T2.4 Chunk count mismatch

```text
sync_end.chunkCount = 3
nhưng nhận 2 chunks
=> reconnect
```

### T2.5 Session switch late write

```text
A chunk write callback pending
switch B
A callback finish
=> terminal B không bị state của A ghi đè
=> connection B không đổi sai
```

### T2.6 Mode restore

Nếu có thể kiểm thử xterm trực tiếp:

```text
snapshot bật bracketed paste mode
sync complete
=> terminal.modes.bracketedPasteMode === true
=> send multiline dùng bracketed paste
```

## 4.10 Gate Phase 2

Không được PASS nếu chỉ test text output.

Phải chứng minh:

- geometry đúng,
- callback sequencing đúng,
- input gate đúng,
- stale generation không can thiệp session mới.

---

# 5. PHASE 3 — BOUND WEBSOCKET V2 LIVE QUEUE DURING SYNC

## 5.1 Vấn đề

Trong `server/src/websocket.ts`, khi `clientRecord.syncComplete === false`:

```ts
clientRecord.liveQueue.push(msg)
```

Queue này chưa đi qua `ws.bufferedAmount`, vì chưa send.

Nếu PTY output nhanh hơn snapshot transfer, RAM có thể tăng không giới hạn.

## 5.2 File sửa

```text
server/src/websocket.ts
server/test/websocket.test.ts
```

Có thể thêm type helper.

## 5.3 Data structure bắt buộc

Thêm accounting:

```ts
type AttachedClient = {
  ...
  liveQueue: Array<Record<string, unknown>>;
  liveQueueBytes: number;
  ...
};
```

Khởi tạo:

```ts
liveQueue: [],
liveQueueBytes: 0,
```

## 5.4 Hàm enqueue riêng

Không copy-paste logic ở output/state/resize/attention.

Tạo helper kiểu:

```ts
private queueOrSend(
  client: AttachedClient,
  payload: Record<string, unknown>
): boolean
```

Hoặc local helper trong attach.

Semantics:

```text
Nếu syncComplete:
  sendJson(payload)

Nếu chưa sync:
  estimate serialized bytes
  nếu liveQueueBytes + bytes > maxWebsocketBufferedBytes:
      close 1013
      không enqueue
      return false
  enqueue
  tăng bytes
```

Byte size phải tính bằng UTF-8:

```ts
Buffer.byteLength(JSON.stringify(payload), "utf8")
```

Không dùng `payload.data.length`.

## 5.5 Khi drain

Sau snapshot:

```text
copy queue hiện tại
set liveQueue=[]
set liveQueueBytes=0
drain theo thứ tự
```

Nếu `sendJson` fail/close thì stop drain.

Không giữ queue cũ sau close.

## 5.6 Cleanup

Trong `cleanup()` bắt buộc:

```ts
clientRecord.liveQueue = [];
clientRecord.liveQueueBytes = 0;
```

## 5.7 Không pause PTY vì một client chậm

Rất quan trọng:

- Không gọi `pty.pause()` chỉ vì một browser sync chậm.
- Slow client phải bị drop/reconnect.
- PTY của session vẫn chạy.
- Viewer khác vẫn nhận output.

## 5.8 Test bắt buộc

### WQ1 — queue bounded

Set test config:

```text
MAX_WS_BUFFERED_BYTES = nhỏ, ví dụ 1024
```

Trong lúc snapshot chưa complete, phát output > limit.

Expect:

```text
socket closes code 1013
live queue không tiếp tục tăng
session vẫn running
```

### WQ2 — client khác không bị ảnh hưởng

```text
controller slow sync -> 1013
viewer/another valid client remains connected
PTY remains running
```

### WQ3 — normal small backlog

```text
queue dưới limit
sync_end
drain operations seq > baseSeq đúng thứ tự
```

### WQ4 — Unicode byte accounting

Payload chứa nhiều Unicode/emoji.

Assert byte limit dựa UTF-8 chứ không phải JS string length.

## 5.9 Gate Phase 3

PASS khi high-output sync không gây unbounded queue.

---

# 6. PHASE 4 — RECONNECT, MISSING SESSION VÀ CLOSE CODE

## 6.1 Contract cần đạt

Theo master contract:

```text
network/5xx/1013:
  backoff 1s,2s,4s,8s,15s
  tối đa 5 lần liên tiếp
  sau đó dừng
  hiện UI Nối lại

session 404 / removed:
  status = missing
  stop retry
  refresh session list một lần

401/403:
  stop retry
  auth flow
```

## 6.2 File sửa

```text
web/src/components/TerminalPane.tsx
web/src/features/sessions/useSessions.ts
web/src/features/sessions/sessionReducer.ts
web/src/App.tsx
web/src/lib/api.ts
```

Có thể bổ sung callback mới từ TerminalPane:

```ts
onSessionMissing(sessionId)
onReconnectExhausted(sessionId)
```

Nếu thêm callback phải type rõ.

## 6.3 Retry counter

Current logic không được retry vô hạn.

Cần constant:

```ts
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
```

Pseudo:

```ts
function scheduleReconnect() {
  if (stopped) return;

  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    setDisconnected();
    return;
  }

  const base = RECONNECT_DELAYS[attempt];
  attempt += 1;

  timer = setTimeout(connect, base + jitter(base));
}
```

`attempt = 0` chỉ reset khi **sync v2 hoàn tất thành công**, không reset chỉ vì WebSocket TCP `open`.

Đây là điểm quan trọng.

## 6.4 Handle 4004 Session Removed

Backend đóng socket code:

```text
4004 Session removed
```

Frontend close handler phải:

```text
- stopped = true
- no schedule reconnect
- notify parent session missing
- refresh list once
```

Không retry ticket vô hạn.

## 6.5 Handle ticket API 404

Nếu `createWsTicket()` throw `ApiError` với:

```text
status=404
code=unknown_session
```

thì:

```text
- stop current attach
- mark missing
- refresh list once
- không schedule reconnect
```

## 6.6 Handle 401/403

401:

- dispatch auth expired như hiện tại.
- stop socket retry.

403 permanent auth/origin:

- stop automatic retry.
- show error rõ.
- không loop.

## 6.7 Handle 1013

1013 là retryable.

Nhưng vẫn tính vào 5 attempts.

## 6.8 Manual reconnect button

`Nối lại` phải:

```text
- reset attempt counter
- increment reconnectKey / generation
- start new attach cycle
```

Không restart PTY.

## 6.9 Test bắt buộc

### R1

5 lần network fail:

```text
1,2,4,8,15 sec (+jitter)
=> sau attempt 5 stop
=> UI disconnected
=> Nối lại available
```

Có thể fake timers/unit test helper thay vì chờ 30 giây thật.

### R2

Socket close 4004:

```text
=> missing
=> không reconnect
```

### R3

Ticket endpoint 404:

```text
=> missing
=> list refresh exactly once hoặc bounded
=> không reconnect loop
```

### R4

1013:

```text
=> retry
=> eventually successful sync resets attempt=0
```

### R5

TCP `open` nhưng sync luôn fail:

```text
=> không reset retry counter ở open
=> sau 5 failed sync attempts dừng
```

---

# 7. PHASE 5 — SESSION REDUCER CLEANUP VÀ POLLING BACKOFF

## 7.1 Draft/attention prune

Khi `LOAD_SESSIONS` là authoritative snapshot cùng epoch, session IDs không còn trong list phải bị prune khỏi:

```text
draftsBySessionId
attentionBySessionId
seenAttentionBySessionId
```

Ngoại lệ:

- Nếu active ID vừa missing và cần message UI thì giữ connection state `missing`, nhưng không giữ prompt draft vô thời hạn.

Tạo helper:

```ts
function pruneKeyedState<T>(
  source: Record<string, T>,
  validIds: Set<string>
): Record<string, T>
```

## 7.2 Logout reset state

Khi logout/auth expired:

- clear active session,
- block input,
- clear drafts,
- clear attention,
- clear seen attention,
- clear pending operations,
- clear sessions list nếu auth boundary yêu cầu.

Ưu tiên action mới:

```text
RESET_SESSIONS
```

thay vì dispatch nhiều action rời rạc.

Nếu thêm action:

```ts
{ type: "RESET_SESSIONS" }
```

reducer trả clean initial state nhưng giữ configured `capacity.max` chỉ nếu cần. Thông thường reset full initial state là dễ hiểu hơn.

## 7.3 Polling backoff bug

Current flow có thể:

```text
fetchSessions error
=> set retry timer
=> caller finally scheduleNextPoll()
=> clear retry timer
=> fixed 5s
```

Phải có một nơi duy nhất sở hữu scheduling.

### Cách khuyến nghị

`fetchSessions()`:

- chỉ fetch + update state.
- không schedule timer bên trong.

Polling effect:

```text
success -> retryCount=0 -> schedule 5s
failure -> increment -> schedule backoff
```

Focus/online:

```text
reset retry cycle
fetch immediately
then schedule based result
```

Không cho `fetchSessions()` và effect cùng set `pollTimerRef`.

## 7.4 Poll chỉ khi cần

Theo master plan:

- authenticated,
- visible,
- online,
- còn active session.

Nếu hiện implementation poll ngay cả không có active session, sửa để giảm request.

Tuy nhiên khi Session Manager mở hoặc login/create/kill/restart vẫn refresh ngay explicit.

## 7.5 Tests

### P5.1

Authoritative list từ:

```text
[A,B]
```

sang:

```text
[B]
```

Expect draft/attention/seen của A removed.

### P5.2

Logout:

```text
sessions state reset
drafts empty
attention empty
connection idle
input blocked
```

### P5.3 Backoff

Mock 3 lỗi liên tiếp:

```text
next delays ≈ 1s,2s,4s
```

Không bị thay bằng 5s.

### P5.4 Success reset

Sau failure:

```text
error,error,success
=> next poll normal 5s
=> retryCount reset 0
```

---

# 8. PHASE 6 — CANONICAL WORKING DIRECTORY VÀ SAME-FOLDER WARNING

## 8.1 Mục tiêu

Cùng một physical directory phải có cùng identity dù user đi qua:

- symlink,
- path spelling khác,
- project/subpath khác nhưng resolve cùng real path.

Backend đã có `workingDirectoryId = sha256(realpath)` cho session. New Session warning phải dùng cùng identity.

## 8.2 Fix browse API canonicalization

File:

```text
server/src/sessionRoutes.ts
```

Current browse đang trả `canonicalSubpath` từ sanitized input. Phải trả subpath được tính từ resolved real path:

```ts
const relative = nodePath.relative(realProjectRoot, realTarget);
const canonicalSubpath =
  relative === ""
    ? ""
    : relative.split(nodePath.sep).join("/");
```

Lưu ý:

- `project.path` trong config thường đã realpath, nhưng vẫn dùng một biến `realRoot` rõ ràng.
- `isSubpathOf(realTarget, realRoot)` phải dùng cùng root canonical.
- `workingDirectoryId` hash `realTarget`.

## 8.3 Frontend cần nhớ selected workingDirectoryId

`ProjectSelector.onSelect` hiện chỉ trả:

```ts
(projectId, subpath?)
```

Mở rộng một cách rõ ràng, ví dụ:

```ts
onSelect({
  projectId,
  subpath,
  workingDirectoryId
})
```

Hoặc thêm argument thứ ba.

Không infer bằng string ở NewSessionDialog nếu browse response đã có ID.

Khi chọn project root trực tiếp:

- dùng `ProjectConfig.workingDirectoryId`.

Khi chọn subfolder:

- dùng `BrowseResult.workingDirectoryId`.

## 8.4 Same-folder conflict

NewSessionDialog:

```text
selected agent == shell
=> không warning

selected agent != shell
=> conflict nếu existing session:
     agent != shell
     state in running/idle/stopping
     workingDirectoryId == selectedWorkingDirectoryId
```

Không cần `projectId === selectedProjectId`.

## 8.5 Test symlink bắt buộc

Tạo:

```text
project/real-dir
project/link-dir -> real-dir
```

Session existing ở `real-dir`.

Browse/chọn `link-dir`.

Expect:

```text
same workingDirectoryId
warning xuất hiện
```

## 8.6 Không block create

Warning chỉ warning.

Không thêm confirm lần hai.

---

# 9. PHASE 7 — NEW SESSION DIALOG STATE VÀ MOBILE MODAL FLOW

## 9.1 Bug state reuse

Generic “+ Phiên mới” phải mở fresh state.

Hiện `selectedProjectId`/`selectedSubpath` có thể giữ lần trước.

## 9.2 Form opening rules

### Mở generic “+ Phiên mới”

Reset:

```text
agent = last manually selected agent hoặc default agent theo master plan
project = first project
subpath = undefined/root
workingDirectoryId = project root ID
name = ""
error = ""
browse state reset
```

Master plan nói agent mặc định theo lựa chọn form lần trước. Vì vậy có thể giữ `lastAgentId`, nhưng **không giữ old project/subpath từ “+ Ở đây”**.

### Mở “+ Ở đây”

Set chính xác:

```text
agentId = session.agentId
projectId = session.projectId
subpath = session.subpath
workingDirectoryId = session.workingDirectoryId
name = ""
```

## 9.3 Không mở hai dialog native cùng lúc trên mobile

Hiện mobile sheet có thể đang `showModal()`, sau đó NewSessionDialog cũng `showModal()`.

Phải đổi flow.

### Cách khuyến nghị

Khi user bấm “+ Phiên mới” hoặc “+ Ở đây” trong mobile sheet:

```text
1. close mobile sheet
2. sau close state/render, open NewSessionDialog
```

Khi Cancel New Session trên mobile:

- có thể quay lại Session Manager sheet nếu flow được mở từ sheet.
- hoặc trở về terminal nếu UX hiện tại chọn vậy.
- nhưng tuyệt đối không để 2 modal cùng `open`.

Nếu cần state:

```ts
const [returnToMobileSheetAfterNewDialog, setReturnToMobileSheetAfterNewDialog]
```

## 9.4 Focus

Khi New Session đóng:

- restore focus hợp lý.
- không focus vào element đang nằm trong closed dialog.

## 9.5 Test mobile

Puppeteer:

```text
open mobile Session sheet
click + Phiên mới
assert document.querySelectorAll("dialog[open]").length === 1
```

Cancel:

```text
assert không có modal stacking
assert focus hợp lý
```

Lặp lại với “+ Ở đây”.

## 9.6 Regression

Không làm hỏng desktop sidebar.

---

# 10. PHASE 8 — FCM / WEB PUSH LIFECYCLE HARDENING

> Nếu owner chưa dùng FCM production, có thể giữ `FCM_ENABLED=false` trong lúc hoàn tất phase này.
>
> **Không được tuyên bố FCM production-ready trước khi phase này PASS.**

## 10.1 Bug logout/re-login

Current flow:

```text
registered device
logout
backend revoke device
browser consent remains true
login
UI sees consent=true + Notification.permission=granted
UI says registered
backend has no device
```

## 10.2 Required behavior

### Explicit logout success

Sau `logout()` success:

```text
clear local push consent
invalidate pending registration callbacks
frontend state unregistered
```

Không cần revoke Firebase SDK trước logout nếu backend đã revoke scope, nhưng browser state phải không giả “registered”.

### Login/app init

Nếu:

```text
permission granted
consent true
```

thì phải **refresh registration với backend** chứ không chỉ set label.

Có 2 lựa chọn:

### Option A — clear consent on logout

Đơn giản và phù hợp security boundary:

```text
logout => clear consent
login => UI "Chưa bật"
user bật lại
```

### Option B — persistent user intent

Nếu giữ consent qua logout:

```text
login => silently refresh SDK registration/server device
chỉ set registered sau server 200
```

Master plan hiện thiên về refresh registration sau login. Nếu implement đúng được thì Option B tốt hơn.

Không được giữ current broken behavior.

## 10.3 Listener cleanup

`onMessage()` và `onRegistered()` nếu SDK trả unsubscribe thì lưu và cleanup.

Không attach foreground listener mới mỗi lần user bấm Enable.

React mount/unmount và repeated enable phải không tạo duplicate banner.

## 10.4 Fix PushStore auth scope delete

File:

```text
server/src/pushStore.ts
```

Current code mismatch scope vẫn remove.

Logic đúng:

```ts
this.cache.devices = this.cache.devices.filter((dev) => {
  if (dev.deviceId !== deviceId) return true;

  if (authScope && dev.webAuthScope !== authScope) {
    return true; // KEEP mismatched device
  }

  return false; // delete matching device
});
```

Nếu endpoint yêu cầu authScope luôn có thì có thể enforce mạnh hơn ở route.

## 10.5 Authorization test bắt buộc

```text
device D belongs to authScope A
delete(D, authScope B)
=> record D remains
```

Và:

```text
delete(D, authScope A)
=> record deleted
```

## 10.6 Login lifecycle test

Test:

```text
register
server store has device
logout
server store no device
login
```

Nếu Option A:

```text
consent false
UI unregistered
```

Nếu Option B:

```text
registration refresh call executes
server store contains device again
UI registered only after server 200
```

## 10.7 FCM disabled must remain harmless

With:

```text
FCM_ENABLED=false
```

- terminal works,
- multi-session works,
- no Firebase startup failure,
- no red blocking error,
- no extra permission prompt.

---

# 11. PHASE 9 — SMOKE TEST REPRODUCIBILITY

## 11.1 Bug

Smoke scripts currently fallback tới machine-specific path kiểu:

```text
/home/mrhoan/source/clone-truyen/node_modules/puppeteer
```

Clean checkout khác có thể fail.

## 11.2 Required fix

Chọn một trong hai:

### Option A — add Puppeteer as project dev dependency

Ưu tiên nếu CI cần browser test.

Root/package phù hợp:

```json
"devDependencies": {
  "puppeteer": "<pinned compatible version>"
}
```

Script:

```js
const puppeteer = require("puppeteer");
```

### Option B — puppeteer-core + CHROME_PATH

Nếu muốn không download Chromium:

```json
"puppeteer-core": "..."
```

Script require package trong repo và bắt buộc `CHROME_PATH`.

Không hard-code đường dẫn home của một máy cụ thể.

## 11.3 Scripts cần sửa

Ít nhất:

```text
scripts/smoke-multi-session.cjs
scripts/smoke-mobile.cjs
scripts/smoke-notifications.cjs
scripts/smoke-touch-scroll.cjs
scripts/smoke-hub.cjs
```

Rà tất cả `require("/home/...")`.

## 11.4 Clean checkout gate

Trên clean environment:

```bash
npm ci
npm run check
npm run build
npm test
```

sau đó smoke scripts phải resolve dependencies chỉ từ repo/env documented.

---

# 12. PHASE 10 — ADD CI / AUTOMATED RELEASE EVIDENCE

Current reviewed commit không có GitHub workflow/check status.

Thêm CI nếu repository chưa có.

## 12.1 Minimum CI

File:

```text
.github/workflows/ci.yml
```

Trigger:

```text
push
pull_request
```

Jobs tối thiểu:

```text
npm ci
npm run check
npm run build
npm test
git diff --check
```

Nếu browser dependencies có thể setup đáng tin cậy thì thêm smoke subset.

## 12.2 Không chạy live FCM trong CI

FCM live cần credential owner, không đưa vào repo.

CI chỉ:

- unit fake sender,
- route disabled/enabled mock,
- worker build,
- notification smoke không cần gửi FCM thật.

Live FCM vẫn có gate manual riêng.

---

# 13. TEST MATRIX BẮT BUỘC SAU KHI HOÀN TẤT TẤT CẢ PHASE

Agent phải tạo hoặc cập nhật validation report với matrix sau.

## 13.1 Backend multi-session

### S01

2 Codex cùng cwd chạy độc lập.

### S02

Codex + Shell cùng cwd, kill/restart một session không ảnh hưởng session kia.

### S03

Different cwd isolation.

### S04

Different subpath -> different workingDirectoryId.

### S05

Traversal/non-directory/path missing không consume slot.

### S06

Capacity active + reserved đúng.

### S07

Restart active giữ slot cũ, không chiếm thêm slot.

### S08

Restart exited cần slot mới.

### S09

Restart timeout giữ session stopping, không giả exited.

### S10

Retention removes old exited session và emits removed.

## 13.2 WebSocket v2

### W01

v1/v2 không double replay.

### W02

Snapshot baseSeq đúng.

### W03

Live output sequence liên tục sau sync.

### W04

Unicode chunks <= 16 KiB UTF-8.

### W05

Snapshot too large -> controlled error.

### W06

First socket controller, second viewer.

### W07

Controller disconnect -> oldest viewer promoted.

### W08

Viewer input/resize blocked.

### W09

Sequence gap -> reconnect.

### W10

Auth/origin/ticket validation.

### W11 — NEW

Sync liveQueue bounded; overflow closes 1013.

### W12 — NEW

Unicode payload byte accounting.

### W13 — NEW

Slow syncing client does not pause/kill PTY or other client.

## 13.3 Frontend terminal

### U01

Create B while A running.

### U02

Rapid switching without crosstalk.

### U03

Draft isolation.

### U04

Create error preserves form.

### U05

Kill/restart merge by revision.

### U06

Selection generation prevents async auto-switch race.

### U07

Missing session state.

### U08/U09

Codex Shift+Left behavior.

### U10/U11

Viewer + promotion.

### U12

Reload restore.

### U13 — NEW

Snapshot writes complete before input enabled.

### U14 — NEW

Controller restores snapshot at snapshot grid before viewport fit.

### U15 — NEW

Late terminal write from A cannot affect B after switch.

### U16 — NEW

Chunk gap/chunk count mismatch reconnects.

### U17 — NEW

Reconnect stops after 5 consecutive failures.

### U18 — NEW

4004/404 -> missing and no reconnect loop.

## 13.4 New Session UX

### N01

Generic open resets project/subpath correctly.

### N02

“+ Ở đây” prefills exact cwd.

### N03

Canonical same-directory warning via symlink.

### N04

Shell-only same-folder does not warn.

### N05

Warning does not block create.

### N06

Mobile never has >1 open modal dialog.

## 13.5 Poll/state

### P01

LOAD snapshot prunes removed draft/attention.

### P02

Logout resets session state.

### P03

Polling error delays follow 1/2/4/8/15 pattern.

### P04

Success resets retry count.

## 13.6 FCM

### F01

Disabled mode harmless.

### F02

Device store permissions/write tests.

### F03

Auth-scope mismatch cannot delete another record.

### F04

Logout/re-login state cannot falsely show registered.

### F05

No duplicate foreground listeners after repeated enable/mount.

---

# 14. MANUAL MOBILE REGRESSION CHECK

Browser automated test không thay thế hoàn toàn iOS/mobile manual regression.

Sau automated PASS, thực hiện manual checklist.

## 14.1 iPhone portrait

- Open Web CLI.
- Create session A.
- Create session B.
- Switch A/B.
- Draft A giữ riêng.
- Terminal touch scroll được.
- Composer không bị sheet che.
- Mở Session sheet.
- Mở New Session.
- Xác nhận chỉ có một modal.
- Cancel.
- Rotate landscape.
- Switch session.
- No horizontal page overflow.

## 14.2 Two tabs

Tab 1:

```text
Session A controller
```

Tab 2:

```text
Session A viewer
```

Verify:

- viewer không input được,
- viewer không resize PTY,
- close Tab 1,
- Tab 2 promoted,
- Tab 2 input được,
- không restart PTY.

## 14.3 Network interruption

- Start long-running command.
- Cut transport.
- UI disables input.
- Restore network.
- Snapshot restore.
- Command state/output remains coherent.
- Không double output.
- Không gửi draft tự động.

---

# 15. PRODUCTION GATE

Không deploy production nếu bất kỳ mục nào sau đây còn fail:

```text
[ ] Terminal snapshot callback sequencing
[ ] Controller snapshot grid correctness
[ ] WebSocket liveQueue bounded
[ ] Reconnect max 5 + manual reconnect
[ ] Removed/404 session stops retry
[ ] API error code contract
[ ] Canonical same-folder warning
[ ] Mobile single-modal flow
[ ] Draft/state prune
[ ] Poll backoff ownership
```

Nếu `FCM_ENABLED=true`, thêm:

```text
[ ] FCM logout/relogin lifecycle
[ ] PushStore auth-scope delete
[ ] Listener cleanup
[ ] Live FCM device test
```

Nếu FCM chưa hoàn tất, production env phải giữ:

```bash
FCM_ENABLED=false
```

và release note ghi rõ:

```text
Multi-session ready.
FCM remains disabled pending production notification validation.
```

---

# 16. THỨ TỰ COMMIT KHUYẾN NGHỊ

Không gộp toàn bộ sửa lỗi vào một mega-commit mới.

Khuyến nghị:

```text
fix(api): preserve backend error codes in ApiError

fix(terminal): serialize snapshot restore before enabling input

fix(ws): bound v2 sync live queue

fix(session-ui): stop reconnect loop for missing sessions

fix(session-state): prune stale drafts and repair polling backoff

fix(session-create): use canonical working directory conflicts

fix(mobile): avoid nested modal dialogs in session flow

fix(push): repair device auth scope and logout registration lifecycle

test(smoke): make browser tests reproducible

ci: add clean build and test workflow
```

Mỗi commit phải build được nếu có thể.

---

# 17. VALIDATION REPORT FORMAT BẮT BUỘC

Cập nhật hoặc tạo:

```text
docs/agile/changes/post-review-fix-validation.md
```

Format:

```md
# Post-review Fix Validation

## Baseline

- Base commit:
- Final commit:
- Node:
- npm:
- OS:
- Chrome/Chromium:

## Phase 1 — API Error Contract

### Files changed
- ...

### Tests added
- ...

### Commands
- `npm run check` — PASS/FAIL
- ...

### Result
PASS/FAIL

## Phase 2 — Terminal Snapshot
...

## Final Gate

- npm run check:
- npm run build:
- npm test:
- smoke-multi-session:
- smoke-mobile:
- smoke-notifications:
- git diff --check:
- CI URL/status:

## Remaining limitations

- Live FCM tested: YES/NO
- iOS manual test: YES/NO
- Any known blocker:
```

Không viết “PASS” nếu command chưa thật sự chạy.

---

# 18. DEFINITION OF DONE

Task chỉ DONE khi:

1. Tất cả P1/P2 ở đầu tài liệu đã được sửa.
2. Test mới cover chính bug đã review, không chỉ happy path.
3. `npm run check` PASS.
4. `npm run build` PASS.
5. `npm test` PASS.
6. Multi-session smoke PASS.
7. Mobile smoke PASS.
8. New terminal sync/backpressure/reconnect tests PASS.
9. `git diff --check` PASS.
10. Validation report có bằng chứng lệnh thực tế.
11. Không còn hard-coded Puppeteer path ngoài repo.
12. Nếu CI được thêm, GitHub check phải xanh.
13. Nếu FCM bật production, toàn bộ FCM gate phải PASS.
14. Nếu FCM chưa live-tested, giữ `FCM_ENABLED=false`.

---

# 19. CÁC LỖI AGENT TUYỆT ĐỐI KHÔNG ĐƯỢC “SỬA” BẰNG WORKAROUND

## Không được:

### Với terminal sync

```text
sleep(100)
```

để “đợi xterm”.

Phải dùng write callback/Promise.

### Với queue

Không tăng:

```text
MAX_WS_BUFFERED_BYTES
```

để né overflow.

Phải bound queue.

### Với reconnect

Không retry vô hạn.

Không đổi max attempts từ 5 sang số lớn tùy ý.

### Với sequence gap

Không bỏ assertion:

```text
if seq != expected => reconnect
```

Không “best effort append”.

### Với same-folder

Không so path string display label.

Phải dùng canonical workingDirectoryId.

### Với modal

Không chỉ đổi z-index của 2 dialog.

Phải tránh hai modal `showModal()` cùng lúc.

### Với push auth

Không bỏ auth-scope check.

Phải sửa filter logic.

### Với test

Không hard-code path môi trường máy dev.

Không skip race tests.

---

# 20. PSEUDOCODE TỔNG HỢP CHO AGENT

## 20.1 Frontend snapshot state machine

```text
ATTACH
  |
  v
CONNECTING
  |
  | WebSocket open
  v
WAIT_SYNC_START
  |
  | sync_start
  v
SYNCING
  - input blocked
  - reset xterm
  - resize xterm to snapshot grid
  - snapshot writes serialized
  |
  | sync_end received
  | AND all snapshot write callbacks complete
  | AND chunk count/index valid
  v
CONNECTED
  - if controller: fit viewport -> resize server
  - input enabled
  |
  | seq gap / 1013 / transport loss
  v
RECONNECT_BACKOFF
  |
  | max 5 fail
  v
DISCONNECTED
  |
  | user clicks Nối lại
  v
CONNECTING

404 / 4004
  |
  v
MISSING
  - stop retry
```

## 20.2 Backend sync queue

```text
attach v2
  |
  +--> register listeners BEFORE snapshot barrier
  |
  +--> syncComplete=false
  |
  +--> output arrives?
  |      |
  |      +--> serialize payload byte length
  |      +--> if queue bytes > limit -> close 1013
  |      +--> else enqueue
  |
  +--> snapshot barrier resolves
  |
  +--> send sync_start
  +--> send chunks
  +--> send sync_end
  |
  +--> syncComplete=true
  +--> drain queued seq > baseSeq
  +--> clear queue + byte counter
  |
  v
live
```

## 20.3 Canonical folder warning

```text
Project root selection:
  selectedWorkingDirectoryId = project.workingDirectoryId

Subfolder selection:
  browse API realpath(target)
  browse API returns workingDirectoryId
  selectedWorkingDirectoryId = response.workingDirectoryId

Conflict:
  selectedAgent != shell
  AND existing.agent != shell
  AND existing.state active/stopping
  AND existing.workingDirectoryId == selectedWorkingDirectoryId
```

---

# 21. FINAL NOTE TO CODING AGENT

Không được tối ưu “cho nhanh” bằng cách bỏ qua các race conditions trong tài liệu này.

Các bug được yêu cầu sửa ở đây không phải lỗi cosmetic; chúng chủ yếu là:

- asynchronous ordering,
- stale callbacks,
- terminal state correctness,
- bounded memory,
- reconnect lifecycle,
- canonical identity,
- auth lifecycle.

Đây là nhóm lỗi rất dễ “test xanh” nếu test chỉ chạy happy path.

Vì vậy mỗi fix phải đi cùng **một test có khả năng fail trên implementation cũ và pass trên implementation mới**.

Nếu một test mới cũng pass trên code cũ, test đó chưa chứng minh bug đã được bắt; hãy sửa test cho tới khi nó thật sự cover failure mode.

**Ưu tiên thực hiện:**

```text
Phase 1
↓
Phase 2
↓
Phase 3
↓
Phase 4
↓
Phase 5
↓
Phase 6
↓
Phase 7
↓
Phase 8
↓
Phase 9
↓
Phase 10
↓
Final validation
```

Không đổi thứ tự Phase 2/3/4 vì terminal synchronization, bounded queue và reconnect lifecycle liên quan trực tiếp với nhau.
