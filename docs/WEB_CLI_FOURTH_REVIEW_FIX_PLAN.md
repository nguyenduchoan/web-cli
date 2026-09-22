# WEB-CLI — FOURTH REVIEW FIX PLAN

> **Repository:** `nguyenduchoan/web-cli`  
> **Baseline commit:** `3026b70a8d855b604ae0db3b83956c43c7b4d706`  
> **Baseline message:** `fix: implement third review fix plan (phases 1-3)`  
> **Purpose:** xử lý các race còn lại sau khi third-review implementation đã sửa đúng stale polling closure, single-flight session fetch, same-session xterm reconnect barrier và push lifecycle.

---

# 0. BỐI CẢNH

Commit `3026b70` đã sửa đúng các finding trước sau:

- polling scheduler không còn giữ stale `isAuthenticated` / `fetchSessions` closure;
- session-list fetch đã single-flight qua auth generation;
- reconnect cùng session không còn reset xterm trước khi old write drain;
- test `RP7` đã đi qua production `TerminalConnectionSession`;
- push lifecycle có một owner tại App, có generation guard và browser smoke riêng.

CI của baseline đã PASS:

- Build, Check & Test: PASS
- Browser Smoke Tests: PASS
- Multi-Session Smoke: PASS
- Mobile Smoke: PASS
- Push Lifecycle Smoke: PASS
- Polling Lifecycle Smoke: PASS

GitHub Actions run của baseline:

`35682251555`

Không làm lại các phần đã hoàn tất ở trên.

---

# 1. FINDINGS CÒN LẠI

## P1 — WebSocket CLOSING race / attempt resource ownership

Files chính:

```text
web/src/lib/terminalConnection.ts
web/src/components/TerminalPane.tsx
server/test/reconnectPolicy.test.ts
```

Hiện `TerminalConnectionSession.connect()` chỉ block khi:

```ts
if (this.stopped || this.connecting || this.ws?.readyState === 1) return;
```

Điều này chỉ chặn OPEN.

Nó không chặn:

```text
CONNECTING = 0
CLOSING    = 2
```

Khi mismatch/gap xảy ra, production gọi:

```ts
this.attemptGeneration += 1;
syncCtrl.invalidate();
...
ws.close();
```

Trong browser thật, `ws.close()` có thể chỉ chuyển socket sang `CLOSING` và `close` event đến sau.

Trong cửa sổ này, `focus`, `online` hoặc `visibilitychange` có thể làm `TerminalPane.resume()` gọi `conn.connect()`.

Vì `readyState === CLOSING` không bị block, socket mới có thể được tạo **trước khi close handler socket cũ xử lý retry/backoff**.

### Hậu quả

Có thể xảy ra:

```text
socket1 gap
-> socket1.close()
-> socket1 CLOSING

focus event
-> connect()
-> socket2 được tạo ngay
-> backoff bị bypass

socket2 open
-> heartbeat2 được tạo

close event muộn của socket1
-> old close handler clear shared heartbeatTimer
-> heartbeat2 có thể bị clear
```

Close handler hiện có thứ tự nguy hiểm:

```ts
this.clearTimeoutFn(openTimeout);
this.clearIntervalFn(this.heartbeatTimer);

if (this.ws !== ws) return;
```

Old callback đang cleanup một shared field có thể đã thuộc attempt mới.

Ngoài ra heartbeat callback hiện dùng:

```ts
this.send({ type: "ping" });
```

`this.send()` gửi qua `this.ws` hiện tại. Nếu heartbeat callback cũ chạy muộn, nó có thể gửi ping qua socket mới.

---

## P2 — Scheduled polling timer vẫn fetch khi hidden/offline

Files:

```text
web/src/lib/pollingPolicy.ts
server/test/pollingPolicy.test.ts
scripts/smoke-polling-lifecycle.cjs
```

`triggerImmediateRefresh()` đã check:

```text
authenticated
visible
online
```

Nhưng `executeFetch()` hiện chỉ check:

```ts
if (this.stopped || this.isFetching) return;
```

Timer callback đã schedule từ lúc tab visible/online gọi thẳng:

```ts
void this.executeFetch();
```

Race:

```text
T0 visible=true, online=true, activeSession=true
-> schedule 5s timer

T3 document hidden
-> visibilitychange
-> triggerImmediateRefresh() return vì hidden
-> timer cũ vẫn tồn tại

T5 timer fire
-> executeFetch()
-> vẫn GET /sessions
```

Offline tương tự.

Contract cần giữ:

```text
periodic 5s polling chỉ chạy khi:
- authenticated
- document visible
- navigator online
- activeSession tồn tại
```

---

# 2. NGUYÊN TẮC IMPLEMENTATION BẮT BUỘC

1. Không dùng sleep, arbitrary delay hoặc `setTimeout(..., 50)` để che race.
2. Không bỏ reconnect backoff.
3. Không cho focus/online/visibility bypass backoff.
4. One socket failure phải consume đúng một reconnect attempt.
5. Close handler là owner duy nhất của retry decision cho socket failure.
6. Resource của attempt cũ không được cleanup resource attempt mới.
7. Heartbeat callback cũ không được gửi qua socket mới.
8. Open timeout cũ không được close socket mới.
9. Poll timer fire trong hidden/offline phải không phát network request.
10. Không tạo polling tight-loop khi hidden/offline.
11. Không phá single-flight / auth-generation logic vừa được sửa trong `3026b70`.
12. Mỗi fix phải có regression test FAIL trên baseline `3026b70` và PASS sau fix.
13. Test phải mô phỏng browser async-close thực tế; không được tiếp tục chỉ dùng synchronous `MockWebSocket.close()`.
14. Không sửa push/FCM nếu không liên quan trực tiếp.

---

# 3. PHASE 1 — SOCKET STATE / ATTEMPT OWNERSHIP

## 3.1 Guard connect khi socket chưa CLOSED

Trong:

```text
web/src/lib/terminalConnection.ts
```

`connect()` không được tạo attempt mới nếu current socket đang:

```text
CONNECTING
OPEN
CLOSING
```

Rule đơn giản:

```text
ws exists && readyState !== CLOSED
=> return
```

Không phụ thuộc static constants của browser trong unit test nếu mock không có constants.

Có thể dùng internal constants:

```ts
const WS_OPEN = 1;
const WS_CLOSED = 3;
```

hoặc helper:

```ts
private hasLiveSocket(): boolean {
  return Boolean(this.ws && this.ws.readyState !== 3);
}
```

Không tạo socket mới chỉ vì `readyState !== OPEN`.

---

## 3.2 Per-attempt heartbeat ownership

Không để attempt cũ clear heartbeat mới.

Hướng ưu tiên:

```ts
const heartbeatTimer = this.setIntervalFn(...);
```

resource này thuộc lexical scope của attempt/socket.

Cleanup:

```ts
const cleanupAttempt = () => {
  this.clearTimeoutFn(openTimeout);
  this.clearIntervalFn(heartbeatTimer);
};
```

Nếu cần giữ field cho `dispose()`, field phải kèm owner identity:

```ts
private heartbeat?: {
  attempt: number;
  id: any;
};
```

và chỉ clear field nếu:

```text
field.attempt === currentAttempt
```

Không được để old close callback gọi `clearIntervalFn(this.heartbeatTimer)` trên field đã bị socket mới overwrite.

---

## 3.3 Heartbeat phải gửi qua socket owner

Không dùng:

```ts
this.send({ type: "ping" });
```

trong callback heartbeat của một attempt cụ thể.

Heartbeat callback phải verify:

```text
this.ws === ws
attemptGeneration === currentAttempt
ws.readyState === OPEN
```

sau đó gửi trực tiếp:

```ts
ws.send(JSON.stringify({ type: "ping" }));
```

Old heartbeat callback dù bị scheduler event-loop gọi muộn cũng không được ping socket mới.

---

## 3.4 Close handler ordering

Close handler phải cleanup đúng resource của chính attempt.

Pseudo flow:

```text
close event socket1
-> cleanup socket1-local open timeout
-> cleanup socket1-local heartbeat
-> if socket1 is no longer current:
     return
-> this.ws = undefined
-> invalidate sync ctrl
-> set UI disconnected/syncing false
-> reconnectManager.handleCloseCode(code)
-> exactly one retry decision
-> schedule exactly one retry
```

Điểm quan trọng:

```text
old close callback
!= permission to clear new attempt resource
```

---

## 3.5 Mismatch/gap flow

`onMismatchOrGap` chỉ được:

```text
- invalidate current sync attempt
- block connected/sync state
- request current socket close
```

Nó không schedule retry.

Retry chỉ từ socket close handler.

Nếu socket đang CLOSING, `resume()` không được gọi `connect()` thành công trước close event.

---

## 3.6 Manual reconnect

Kiểm tra semantics hiện có của:

```ts
manualReconnect()
```

Nếu current socket còn CONNECTING/OPEN/CLOSING, manual reconnect không được tạo socket song song.

Có hai hướng hợp lệ:

### Hướng A

Manual reconnect khi socket hiện tại còn sống:

```text
mark manual reconnect requested
close current socket
close handler không dùng normal failure backoff
sau close mới tạo clean attempt
```

### Hướng B

Nếu UI chỉ cho manual reconnect khi trạng thái đã disconnected và socket đã CLOSED/undefined, giữ behavior hiện có nhưng thêm test/assertion contract.

Không được vô tình tạo parallel socket.

---

# 4. PHASE 2 — ASYNC-CLOSE REGRESSION TESTS

File:

```text
server/test/reconnectPolicy.test.ts
```

## 4.1 Nâng cấp MockWebSocket

Mock hiện tại:

```ts
close() {
  this.readyState = 3;
  this.emit("close", ...);
}
```

không tái hiện browser.

Thêm mode async close, ví dụ:

```ts
public autoFinishClose = true;

public close(code = 1000) {
  this.readyState = 2;
  this.pendingCloseCode = code;
  if (this.autoFinishClose) {
    this.finishClose();
  }
}

public finishClose(code = this.pendingCloseCode ?? 1000) {
  this.readyState = 3;
  this.emit("close", { code });
}
```

Existing tests có thể giữ default sync behavior nếu cần.

Các regression mới phải đặt:

```text
autoFinishClose = false
```

để có cửa sổ CLOSING.

---

## 4.2 RP8 — CLOSING blocks early reconnect

Flow:

```text
socket1 open
sync valid hoặc gap setup

gap
-> socket1.close()
-> socket1.readyState === CLOSING
-> chưa emit close

gọi session.connect()
```

Assert:

```text
createWebSocket count === 1
ReconnectManager attempt chưa bị bypass
không có socket2
```

Sau:

```text
socket1.finishClose(1006)
```

Assert:

```text
ReconnectManager attempt === 1
exactly one retry timer
```

Trước retry timer fire:

```text
socket count === 1
```

Sau retry timer:

```text
socket count === 2
```

---

## 4.3 RP9 — old close cannot clear new heartbeat

Inject fake intervals:

```text
setIntervalFn -> return deterministic IDs
clearIntervalFn -> record cleared IDs
```

Flow:

```text
socket1 heartbeat id=H1
socket1 close -> retry
socket2 open -> heartbeat id=H2

emit late stale close event/callback từ socket1
```

Assert:

```text
H1 may be cleared
H2 must NOT be cleared
socket2 remains OPEN
retry count does not increment again
```

---

## 4.4 RP10 — stale heartbeat cannot ping new socket

Capture heartbeat callbacks.

Flow:

```text
socket1 open -> capture heartbeat callback HB1
socket1 closes
socket2 becomes current/open

manually invoke HB1
```

Assert:

```text
socket2.sent does NOT gain ping from HB1
```

Sau đó invoke heartbeat2:

```text
socket2 receives expected ping
```

---

## 4.5 RP11 — focus/resume equivalent cannot bypass backoff

Không cần mount React nếu production class behavior đủ để chứng minh.

Flow:

```text
socket1 enters CLOSING after retryable failure
call session.connect() multiple times, tương đương resume/focus
```

Assert:

```text
không socket mới
không duplicate ticket request
không retry timer mới
```

Sau close handler:

```text
delay attempt1 = 1000ms (+ configured jitter)
```

Chỉ retry callback mới được tạo socket2.

---

# 5. PHASE 3 — HIDDEN/OFFLINE POLLING GUARD

File:

```text
web/src/lib/pollingPolicy.ts
```

## 5.1 Re-check execution conditions tại thời điểm fetch

Timer schedule time không đủ.

Trước khi `executeFetch()` bắt đầu network request, phải đọc runtime state mới nhất:

```text
stopped?
authenticated?
visible?
online?
already fetching?
```

Expected guard:

```ts
if (
  this.stopped ||
  this.isFetching ||
  !this.isAuthenticatedFn() ||
  !this.isVisibleFn() ||
  !this.isOnlineFn()
) {
  return;
}
```

Nhưng agent phải kiểm tra toàn bộ lifecycle trước khi áp dụng máy móc.

---

## 5.2 Không tight-loop

Nếu timer fire trong hidden/offline:

```text
executeFetch returns
```

không schedule ngay một timer khác.

Polling sẽ resume khi browser phát:

```text
visibilitychange -> visible
online
focus
```

và production gọi:

```ts
triggerImmediateRefresh()
```

Sau explicit refresh thành công:

```text
activeSession=true
=> schedule 5s timer mới
```

---

## 5.3 Error backoff khi browser chuyển offline

Nếu previous fetch fail và đã schedule backoff:

```text
offline trước khi backoff timer fire
```

timer fire:

```text
không fetch
không tăng retryCount
không reset retryCount
không schedule tight-loop
```

Khi online lại, `triggerImmediateRefresh()` hiện reset retry state rồi fetch ngay.

Giữ behavior này nếu phù hợp contract hiện tại.

---

# 6. PHASE 4 — POLLING REGRESSION TESTS

File:

```text
server/test/pollingPolicy.test.ts
```

## P11 — scheduled periodic timer fires while hidden

Setup:

```text
authenticated=true
activeSession=true
visible=true
online=true
```

Run initial success để schedule 5000ms.

Trước timer:

```text
visible=false
```

Advance fake clock 5000ms.

Assert:

```text
fetchCalls không tăng
no pending periodic timer/tight loop
retryCount unchanged
```

Sau:

```text
visible=true
await triggerImmediateRefresh()
```

Assert:

```text
fetchCalls tăng đúng 1
next timer 5000ms
```

---

## P12 — scheduled periodic timer fires while offline

Tương tự P11:

```text
online=false trước timer fire
```

Assert:

```text
không fetch
không timer loop
```

Sau:

```text
online=true
triggerImmediateRefresh()
```

Assert fetch exactly once và periodic resume.

---

## P13 — backoff timer fire while offline

Setup fetch fail để:

```text
lastAttemptFailed=true
retryCount=1
timer=1000ms
```

Chuyển:

```text
online=false
```

Advance 1000ms.

Assert:

```text
không network call mới
retryCount vẫn = 1
lastAttemptFailed vẫn true hoặc state tương đương không bị giả success
không schedule loop mới
```

Online lại + explicit refresh:

```text
success
retryCount=0
lastAttemptFailed=false
periodic 5000ms nếu active session
```

---

# 7. PHASE 5 — BROWSER SMOKE HARDENING

File:

```text
scripts/smoke-polling-lifecycle.cjs
```

Unit fake-timer là bằng chứng chính cho hidden/offline scheduling.

Browser smoke nên thêm ít nhất một runtime case nếu Puppeteer có thể override được state ổn định:

### Option A — Page Visibility

Nếu reliable:

```text
schedule active poll
simulate hidden
wait >5s
assert request count unchanged
restore visible/focus
assert exactly one immediate request + periodic resume
```

### Option B — Offline

Dùng Puppeteer network emulation nếu không phá fixture:

```text
page.setOfflineMode(true)
wait past timer
assert no request
page.setOfflineMode(false)
dispatch online/focus nếu cần
assert refresh resumes
```

Nếu browser API không deterministic trong CI, giữ P11-P13 unit tests làm bắt buộc và document browser limitation. Không viết flaky smoke.

---

# 8. PHASE 6 — VALIDATION DOC UPDATE

Không rewrite lịch sử của third-review validation.

Tạo:

```text
docs/agile/changes/fourth-review-fix-validation.md
```

Nội dung tối thiểu:

```text
Baseline:
3026b70a8d855b604ae0db3b83956c43c7b4d706

Baseline CI:
run 35682251555
Build/Check/Test PASS
Browser Smoke PASS

Findings:
- WebSocket CLOSING / per-attempt timer ownership
- scheduled polling timer hidden/offline execution guard
```

Sau fix ghi RED/GREEN evidence cho:

```text
RP8-RP11
P11-P13
```

và full validation commands.

Có thể bổ sung note vào third-review validation rằng remote CI của `3026b70` đã PASS, nhưng không sửa nội dung cũ thành như thể CI đã tồn tại tại thời điểm tài liệu ban đầu được viết.

---

# 9. FULL VERIFICATION

Sau khi implementation xong phải chạy:

```bash
npm run check
npm run build
npm test
node scripts/smoke-multi-session.cjs
node scripts/smoke-mobile.cjs
node scripts/smoke-push-lifecycle.cjs
node scripts/smoke-polling-lifecycle.cjs
git diff --check
```

Nếu thêm smoke mới thì chạy thêm smoke đó.

Không được ghi PASS nếu chưa thực sự chạy.

Sau push, kiểm tra GitHub Actions:

```text
Build, Check & Test
Browser Smoke Tests
```

và ghi run URL vào validation.

---

# 10. DEFINITION OF DONE

Chỉ hoàn tất khi:

- [ ] `connect()` không tạo socket mới khi current socket CONNECTING.
- [ ] `connect()` không tạo socket mới khi current socket OPEN.
- [ ] `connect()` không tạo socket mới khi current socket CLOSING.
- [ ] Retryable socket failure consume đúng một reconnect attempt.
- [ ] focus/online/visibility resume không bypass backoff.
- [ ] Old close callback không clear heartbeat attempt mới.
- [ ] Old heartbeat callback không gửi ping qua socket mới.
- [ ] Old open timeout không close socket mới.
- [ ] Không có parallel WebSocket attempt ngoài lifecycle được thiết kế.
- [ ] RP8 PASS.
- [ ] RP9 PASS.
- [ ] RP10 PASS.
- [ ] RP11 PASS.
- [ ] Timer periodic fire khi hidden không fetch.
- [ ] Timer periodic fire khi offline không fetch.
- [ ] Backoff timer fire khi offline không fetch/tight-loop.
- [ ] visible/online restore thực hiện đúng một immediate refresh.
- [ ] Polling sau restore quay lại 5s khi có active session.
- [ ] P11 PASS.
- [ ] P12 PASS.
- [ ] P13 PASS.
- [ ] Existing P3-P10 vẫn PASS.
- [ ] Existing RP1-RP7 vẫn PASS.
- [ ] Existing XQ/OR tests vẫn PASS.
- [ ] Push tests/smoke vẫn PASS.
- [ ] Multi-session smoke PASS.
- [ ] Mobile smoke PASS.
- [ ] `npm run check` PASS.
- [ ] `npm run build` PASS.
- [ ] `npm test` PASS.
- [ ] `git diff --check` PASS.
- [ ] Có `fourth-review-fix-validation.md`.
- [ ] Remote CI sau push PASS.

---

# 11. KHÔNG ĐƯỢC LÀM

Không:

- thêm arbitrary reconnect delay để che CLOSING race;
- gọi `connect()` từ mismatch handler trước close;
- reset reconnect counter khi TCP open;
- reset reconnect counter trước successful terminal sync;
- dùng shared heartbeat timer mà không có owner identity;
- cho heartbeat cũ gọi generic `this.send()`;
- đổi MockWebSocket thành synchronous-only để test dễ PASS;
- bỏ existing RP7/xterm barrier;
- thay polling single-flight logic bằng request overlap;
- recreate polling scheduler mỗi render;
- schedule repeated short timer khi hidden/offline;
- sửa FCM/push code không liên quan;
- claim browser hidden/offline coverage nếu không test thực tế.

---

# 12. COMMIT GỢI Ý

Sau khi mọi validation PASS:

```text
fix: close remaining reconnect and polling races
```

Commit body:

```text
- prevent websocket reconnect while the previous socket is closing
- isolate heartbeat and timeout cleanup per connection attempt
- prevent stale heartbeat callbacks from sending through a newer socket
- preserve one-failure-one-backoff reconnect ownership
- prevent scheduled polling fetches while hidden or offline
- add async-close and runtime polling regression tests
- add fourth-review validation evidence
```

---

# 13. OUTPUT AGENT PHẢI TRẢ LẠI

Agent phải báo:

1. File đã sửa.
2. Cách ownership socket/heartbeat được thay đổi.
3. Cách CLOSING state được xử lý.
4. Regression tests RP8-RP11.
5. Cách hidden/offline polling được xử lý.
6. Regression tests P11-P13.
7. Kết quả full validation.
8. Commit SHA.
9. GitHub Actions run URL/result sau push.
10. Bất kỳ phần nào deferred hoặc chưa test được.

Nếu còn test fail hoặc CI chưa xanh, không được nói task đã hoàn tất.
