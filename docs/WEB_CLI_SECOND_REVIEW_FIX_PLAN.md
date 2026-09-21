# WEB CLI — SECOND REVIEW FIX PLAN

> **Baseline đã review:** `3d2f7e6d484f871d70cd60e292e2e5011632f10b`
>
> **Mục tiêu:** sửa các lỗi còn lại sau vòng review thứ hai của implementation multi-session.
>
> **Đối tượng thực hiện:** coding agent có khả năng suy luận hạn chế. Không tự đổi kiến trúc, không tự rút gọn acceptance criteria, không bỏ test, không thay bug thật bằng workaround timing.
>
> **Nguyên tắc:** mỗi finding trong tài liệu này phải có một test có khả năng FAIL trên baseline `3d2f7e6` và PASS sau khi sửa.

---

# 0. KẾT LUẬN REVIEW VÒNG 2

Implementation hiện tại đã cải thiện đáng kể và GitHub Actions đã PASS cho:

- `npm ci`
- `npm run check`
- `npm run build`
- `npm test`
- `git diff --check`

Các phần sau đã được sửa tốt và **không được refactor lại nếu không cần**:

- API error code `body.code ?? body.error`
- WebSocket v2 live queue bounded theo UTF-8 bytes
- slow syncing client bị drop bằng `1013`
- canonical `workingDirectoryId`
- reducer prune draft/attention
- `RESET_SESSIONS`
- PushStore auth-scope delete
- loại bỏ hard-coded Puppeteer module path
- GitHub Actions CI cơ bản

Tuy nhiên còn các lỗi correctness/lifecycle sau.

---

# 1. SEVERITY VÀ THỨ TỰ BẮT BUỘC

## P1 — BLOCK RELEASE

1. **Shared xterm race khi switch/reconnect:** write cũ của Session A có thể hoàn tất sau `reset()` của Session B.
2. **Live output và terminal resize chưa được apply theo cùng một ordered operation chain.**

## P2 — PHẢI SỬA TRƯỚC PRODUCTION

3. Reconnect tests đang test `ReconnectManager`, nhưng production `TerminalPane` không dùng class đó.
4. `onMismatchOrGap()` có thể schedule reconnect hai lần cho cùng một failure.
5. Mobile modal đang dựa vào `setTimeout(50)` thay vì lifecycle deterministic.
6. Mobile smoke chưa assert `dialog[open].length === 1`.
7. FCM reload/login lifecycle vẫn có thể hiển thị `registered` giả và thiếu foreground listener nếu FCM bật.

## P3 — HARDENING

8. Polling vẫn chạy mỗi 5 giây dù không có active session.
9. Chưa có test thực sự cho polling backoff/reset.
10. Restart session đã exited/error vẫn overwrite historical `exitReason`.
11. Browser smoke chưa chạy trong CI.

---

# 2. QUY TẮC CHUNG

Agent phải tuân thủ:

1. Đọc file này trước khi sửa.
2. Đọc lại:
   - `docs/MULTI_SESSION_MASTER_IMPLEMENTATION_PLAN.md`
   - `docs/WEB_CLI_POST_REVIEW_FIX_MASTER_PLAN.md`
   - `docs/agile/changes/post-review-fix-validation.md`
3. Không sửa unrelated features.
4. Không thêm sleep/timing delay để che race.
5. Không tăng retry count/buffer để né lỗi.
6. Không xóa hoặc weaken test cũ.
7. Mỗi phase phải:
   - code,
   - thêm test,
   - chạy test riêng phase,
   - chạy `npm run check`,
   - ghi validation.
8. Không được ghi PASS nếu command chưa chạy thật.
9. Nếu test mới cũng PASS trên baseline cũ thì test chưa bắt đúng regression.

---

# 3. PHASE 1 — GLOBAL XTERM WRITE BARRIER

## 3.1 Vấn đề

Hiện tại `TerminalSyncController` có:

```ts
private writeChain: Promise<void> = Promise.resolve();
```

Nhưng mỗi attach/session tạo một controller riêng.

Trong `TerminalPane` chỉ có **một xterm instance**:

```ts
const termRef = useRef<Terminal | undefined>();
```

Kịch bản lỗi:

```text
Session A
  terminal.write(A1, callbackA)
  callbackA chưa hoàn tất

User switch sang B

cleanup A:
  syncCtrlA.invalidate()

B:
  terminal.reset()
  terminal.resize(...)
  terminal.write(B snapshot)

Sau đó callback/write A hoàn tất muộn
```

`invalidate()` chỉ ngăn callback state update; nó **không hủy được xterm write đã được submit**.

Kết quả có thể:

- text A xuất hiện trên B,
- cursor state sai,
- ANSI mode từ A ảnh hưởng B,
- alternate buffer state sai,
- bracketed paste state sai.

## 3.2 Mục tiêu kiến trúc

Mọi thao tác mutate xterm phải đi qua **một queue/barrier thuộc xterm instance**, không thuộc từng connection.

Tối thiểu các operation sau phải serialize:

```text
reset
resize
write
clear nếu có
snapshot writes
live output writes
server terminal_resize
```

## 3.3 File đề xuất

```text
web/src/lib/xtermOperationQueue.ts     // NEW
web/src/components/TerminalPane.tsx
web/src/lib/terminalSync.ts
server/test/terminalSync.test.ts
```

Tên file có thể khác nhưng semantics phải giữ nguyên.

## 3.4 API khuyến nghị

Tạo helper:

```ts
export class XtermOperationQueue {
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;

  invalidate(): number
  getGeneration(): number

  enqueue(
    generation: number,
    operation: () => void | Promise<void>
  ): Promise<boolean>

  barrier(): Promise<void>
}
```

Hoặc interface tương đương.

### Semantics

`enqueue(gen, op)`:

```text
append op vào global chain
khi turn chạy:
  nếu gen != currentGeneration:
     skip op
     return false
  chạy op
  await hoàn tất
  return true
```

`invalidate()`:

```text
increment generation
return generation mới
```

Quan trọng:

- operation đã **bắt đầu chạy** không thể hủy.
- Vì vậy khi switch session, trước `reset()` session mới phải có barrier đảm bảo operation cũ đã drain.

## 3.5 Switch flow bắt buộc

Khi `session?.id` hoặc `connectionGeneration` đổi:

```text
1. block input synchronously
2. invalidate old connection/controller
3. mark old xterm generation stale
4. await global xterm write barrier
5. only then:
     reset xterm
     attach/sync new session
```

Không được:

```text
reset B trước khi write A callback hoàn tất
```

## 3.6 Không recreate xterm trừ khi cần

Ưu tiên global queue.

Chỉ recreate xterm per generation nếu chứng minh:

- touch scroll không regress,
- fit addon không leak,
- resize observer cleanup đúng,
- performance chấp nhận được.

## 3.7 Test bắt buộc

### XQ1 — write already started before switch

Test phải mô phỏng đúng bug:

```text
A writeTerminal được INVOKE
A Promise còn pending
switch B
B muốn reset
```

Assert:

```text
B reset KHÔNG chạy trước khi A write promise resolve
```

Sau khi A resolve:

```text
B reset
B resize
B snapshot write
```

thứ tự chính xác.

Expected operation log:

```text
A-write-start
A-write-end
B-reset
B-resize
B-write
```

Không chấp nhận test kiểu:

```text
invalidate A trước khi A writeTerminal được gọi
```

vì test cũ T2.5 chưa bắt đúng failure mode.

### XQ2 — rapid A/B/A

```text
A live write pending
switch B
switch A lại rất nhanh
```

Assert operation cũ không contaminate terminal cuối.

### XQ3 — reconnect same session generation

```text
old socket snapshot write pending
new reconnect snapshot bắt đầu
```

New reset phải chờ old xterm operation drain.

---

# 4. PHASE 2 — SERIALIZE OUTPUT VÀ RESIZE TRÊN CÙNG OPERATION STREAM

## 4.1 Vấn đề

Hiện:

```ts
handleOutput()
  -> writeChain.then(writeTerminal)

handleTerminalResize()
  -> resizeTerminal(...) ngay lập tức
```

Server sequence có thể:

```text
seq 20 output
seq 21 terminal_resize
```

Nhưng frontend apply:

```text
resize(21)
output(20) parse xong sau
```

=> sai thứ tự.

## 4.2 Contract đúng

Mọi message có `seq` làm thay đổi terminal phải:

1. validate seq,
2. enqueue operation vào cùng queue,
3. operation phải execute theo đúng seq.

Ví dụ:

```text
seq 20 output -> enqueue write
seq 21 resize -> enqueue resize
seq 22 output -> enqueue write
```

Execution:

```text
write20 callback done
resize21
write22 callback done
```

## 4.3 Thay đổi TerminalSyncController

Không cho `handleTerminalResize()` gọi resize sync trực tiếp.

Đề xuất:

```ts
public handleTerminalResize(msg: ResizeMessage): boolean {
  validate seq
  expectedSeq++

  queue.enqueue(currentGeneration, async () => {
    if role === "viewer" {
      resizeTerminal(msg.cols, msg.rows)
    }
  })

  return true
}
```

Controller resize từ server:

- giữ semantics hiện tại nếu server resize message chỉ cần viewer apply.
- nhưng vẫn phải consume seq theo order.
- nếu controller không local-resize theo message thì queue một no-op marker hoặc maintain ordering bằng same stream.

## 4.4 Test bắt buộc

### OR1

```text
output seq=10
write promise delayed

resize seq=11
```

Assert:

```text
resize callback chưa được gọi khi output10 chưa finish
```

Sau output resolve:

```text
resize11 chạy
```

### OR2

```text
output10
resize11
output12
```

Expected order:

```text
write10-start
write10-end
resize11
write12-start
write12-end
```

### OR3

Duplicate resize:

```text
seq < expected
=> ignore
=> không enqueue
```

### OR4

Gap:

```text
expected 11
got resize12
=> reconnect
=> không enqueue resize
```

---

# 5. PHASE 3 — RECONNECT PRODUCTION STATE MACHINE PHẢI DÙNG CODE ĐƯỢC TEST

## 5.1 Vấn đề

Có file:

```text
web/src/lib/reconnectPolicy.ts
```

và tests:

```text
server/test/reconnectPolicy.test.ts
```

Nhưng `TerminalPane.tsx` vẫn tự implement:

```ts
let attempt = 0
const schedule = ...
```

Production không dùng `ReconnectManager`.

Do đó R1-R5 xanh nhưng không bảo vệ code thật.

## 5.2 Bắt buộc chọn 1 trong 2

### Option A — khuyến nghị

Dùng `ReconnectManager` thật trong `TerminalPane`.

```ts
const reconnectManager = new ReconnectManager()
```

Mọi retry decision phải đi qua manager.

### Option B

Xóa `ReconnectManager` và test trực tiếp helper/state machine mà production thực sự sử dụng.

Không được giữ duplicated policy.

## 5.3 Một failure chỉ schedule đúng một lần

Hiện pattern nguy hiểm:

```ts
onMismatchOrGap() {
  ws.close()
  schedule()
}
```

Sau đó:

```ts
ws.close event
  schedule()
```

Phải sửa thành:

```text
mismatch/gap:
  mark socket unhealthy
  close socket
  KHÔNG schedule ở đây

close handler:
  là owner duy nhất quyết định retry
```

Ngoại lệ:

- ticket API fail trước khi WebSocket object được tạo thì catch handler schedule.
- nhưng một failure event chỉ increment attempt một lần.

## 5.4 Retry semantics bắt buộc

### Retryable

```text
network error
1006
1011
1013
ticket network error
ticket 5xx
sync mismatch/gap
heartbeat timeout
```

### Permanent stop

```text
4001 / HTTP 401 -> auth expired
4003 / HTTP 403 -> forbidden
4004 / HTTP 404 / unknown_session -> missing
```

### Attempt reset

Chỉ:

```text
after complete v2 sync
```

Không reset tại:

```text
TCP open
ticket success
sync_start
```

## 5.5 Manual reconnect

User click `Nối lại`:

```text
reconnectManager.onManualReconnect()
new connectionGeneration/reconnectKey
start immediately
```

Không restart PTY.

## 5.6 Test production wiring bắt buộc

### RP1 — import/wiring

Test hoặc static assertion cho thấy `TerminalPane` production dùng reconnect policy helper.

Không đủ chỉ test class riêng.

### RP2 — mismatch consumes one attempt

Simulate:

```text
connected socket
sequence gap
socket closes
```

Assert manager attempt:

```text
1
```

không phải `2`.

### RP3 — repeated TCP-open/sync-fail

```text
open -> sync gap -> close
x5
```

Assert:

```text
after 5 retries -> disconnected
manual reconnect button visible
```

### RP4 — 4004

```text
close 4004
=> missing
=> no timer
=> fetch list once
```

---

# 6. PHASE 4 — MOBILE MODAL FLOW KHÔNG DÙNG setTimeout

## 6.1 Vấn đề

Current code:

```ts
onCloseMobileSheet()

setTimeout(() => {
  setIsNewDialogOpen(true)
}, 50)
```

Đây là timing workaround.

50 ms không phải lifecycle guarantee.

## 6.2 Contract

Không bao giờ có hơn 1:

```css
dialog[open]
```

khi flow từ Session Manager -> New Session.

## 6.3 Cách sửa khuyến nghị

Tạo pending intent:

```ts
type PendingNewSession =
  | undefined
  | {
      prefill?: ...
      returnToSessionManagerOnCancel: boolean
    }
```

Flow:

```text
click New Session while mobile sheet open
  -> set pending intent
  -> close mobile dialog

mobile dialog onClose event
  -> if pending intent:
       open NewSessionDialog
       clear pending intent
```

Dùng native:

```tsx
<dialog onClose={...}>
```

Không dùng arbitrary timeout.

## 6.4 Desktop

Desktop sidebar không phải modal.

Nếu desktop:

```text
open NewSessionDialog immediately
```

## 6.5 Cancel behavior

Nếu New Session mở từ mobile manager:

```text
Cancel
=> có thể reopen Session Manager
```

Nếu UX hiện tại muốn quay terminal thì ghi rõ và test.

Quan trọng nhất: không modal stacking.

## 6.6 Test bắt buộc

### M1

```text
mobile sheet open
click + Phiên mới
```

Assert liên tục ở các bước:

```js
document.querySelectorAll("dialog[open]").length <= 1
```

### M2

Lặp với:

```text
+ Ở đây
```

### M3

Cancel New Session:

```text
no stacked dialog
focus valid
```

### M4

Mở/đóng 20 lần loop:

```text
không InvalidStateError từ showModal()
không pageerror
```

---

# 7. PHASE 5 — FCM LIFECYCLE CHỈ NẾU MUỐN BẬT PRODUCTION

> Nếu chưa cần FCM production, giữ `FCM_ENABLED=false`.
>
> Multi-session release không được block bởi FCM nếu feature đang tắt.

## 7.1 Vấn đề A — reload báo registered giả

`NotificationSettings` hiện:

```ts
if (hasPushConsent() && Notification.permission === "granted") {
  setPushState("registered")
}
```

Không refresh server registration.

Không attach foreground listener.

## 7.2 Behavior đúng

Khi component/app authenticated mount:

```text
if config enabled
and consent true
and permission granted:
    set registering
    call registerPushNotification(...)
    chỉ set registered nếu server registration success
```

Không gọi `Notification.requestPermission()` lại nếu permission đã granted.

Có thể tách:

```ts
refreshPushRegistration(config, listener)
```

để không request permission.

## 7.3 Vấn đề B — logout chưa invalidate registration đang pending hoàn toàn

`cleanupPushListeners()` chỉ unsubscribe.

Phải có:

```ts
invalidatePushRegistration()
```

hoặc:

```ts
cleanupPushListeners({ invalidateGeneration: true })
```

Logout/auth-expired:

```text
registrationGeneration++
cleanup listeners
clear consent
```

Nếu promise cũ resolve sau logout:

```text
không được call registerPushDevice
không set consent lại
```

## 7.4 Tests

### F2.1 Reload

```text
consent true
permission granted
component mount
=> backend registration refresh called
=> onMessage attached
=> state registered only after success
```

### F2.2 Logout during registration

```text
register() pending
logout
FID callback fires later
=> no backend register device
=> consent remains cleared
```

### F2.3 Listener dedupe

```text
mount/unmount/reload/enable
=> exactly one foreground handler
```

## 7.5 Gate

Nếu chưa test live FCM:

```text
FCM_ENABLED=false
```

Validation report phải nói rõ.

---

# 8. PHASE 6 — POLLING ONLY WHEN ACTIVE + TEST BACKOFF

## 8.1 Vấn đề

Polling loop hiện chạy nếu:

```text
authenticated
visible
online
```

nhưng chưa check có active session.

Master plan yêu cầu fixed polling khi có active session.

## 8.2 Desired behavior

5s polling khi:

```text
isAuthenticated
document visible
navigator online
stateRef.current.activeSessionId exists
```

Nếu không có active session:

```text
không giữ 5s timer
```

Vẫn fetch explicit khi:

- login,
- focus,
- online,
- Session Manager open,
- create,
- restart,
- kill,
- missing session refresh.

## 8.3 Tránh stale closure

Không thêm `state.activeSessionId` thẳng vào effect nếu gây restart effect liên tục không cần thiết.

Có thể dùng:

```ts
stateRef.current.activeSessionId
```

trong scheduler.

## 8.4 Backoff tests còn thiếu

Thêm test helper cho polling policy.

Khuyến nghị tạo:

```text
web/src/lib/pollingPolicy.ts
server/test/pollingPolicy.test.ts
```

Pure helper:

```ts
getPollingDelay({
  activeSession: boolean,
  visible: boolean,
  online: boolean,
  retryCount: number,
  lastAttemptFailed: boolean
})
```

Hoặc scheduler abstraction thực tế.

## 8.5 Tests

### P3

Errors:

```text
1 -> 1s
2 -> 2s
3 -> 4s
4 -> 8s
5+ -> 15s
```

### P4

```text
error,error,success
=> retry count reset
=> next normal delay 5s
```

### P5

```text
no activeSessionId
=> no background 5s poll
```

### P6

```text
active session created/selected
=> polling starts
```

---

# 9. PHASE 7 — PRESERVE HISTORICAL EXIT REASON

## 9.1 Vấn đề

Trong `SessionManager.restartSession()`:

```ts
else {
  ...
  previous.restartLock = true;
  previous.exitReason = "restart";
}
```

Nếu previous session đã:

```text
state = exited
exitReason = natural
```

user restart sau đó làm mất lịch sử:

```text
natural -> restart
```

## 9.2 Semantics đúng

`exitReason` mô tả:

```text
why this PTY ended
```

Không phải:

```text
why user created a replacement session later
```

Vì vậy:

### Active session restart

Nếu restart action làm dừng PTY:

```text
exitReason = restart
```

đúng.

### Already exited/error session restart

Không overwrite:

```ts
previous.exitReason
```

Dùng existing relation:

```text
replacementSessionId
replacedFromSessionId
```

để biểu diễn restart relation.

## 9.3 Test

### ER1

```text
session exits naturally
assert exitReason=natural

restart exited session
assert old.exitReason=natural
assert old.replacementSessionId = new.id
assert new.replacedFromSessionId = old.id
```

### ER2

```text
active running session restart
=> old.exitReason=restart
```

---

# 10. PHASE 8 — BROWSER SMOKE TRONG CI

## 10.1 Mục tiêu

Unit tests không đủ cho:

- xterm async callback,
- native dialog,
- browser WebSocket lifecycle,
- mobile viewport,
- controller/viewer promotion.

## 10.2 CI strategy

Không nhất thiết chạy toàn bộ smoke ở mọi commit nếu quá nặng.

Tối thiểu thêm job:

```text
browser-smoke
```

chạy:

```bash
npm ci
npm run build
node scripts/smoke-multi-session.cjs
node scripts/smoke-mobile.cjs
```

## 10.3 Chrome

Vì dùng `puppeteer-core`:

- dùng Chrome có sẵn trên `ubuntu-latest`, hoặc
- setup explicit Chrome action/package.

Script phải dùng `resolveChromePath()`.

Không fallback cứng sang path không tồn tại mà không error rõ.

## 10.4 Nếu CI runtime quá dài

Có thể:

```text
pull_request:
  smoke-multi-session
  smoke-mobile

push main:
  full smoke suite
```

Nhưng minimum requirement:

```text
multi-session + mobile browser smoke
```

phải có automated evidence.

---

# 11. TEST MATRIX ROUND 2

## P1 terminal

```text
[ ] XQ1 old write already started -> new reset waits
[ ] XQ2 rapid A/B/A no xterm contamination
[ ] XQ3 reconnect generation barrier
[ ] OR1 output before resize ordering
[ ] OR2 output/resize/output ordering
[ ] OR3 duplicate resize ignored
[ ] OR4 resize gap reconnect
```

## P2 reconnect

```text
[ ] RP1 production uses tested reconnect policy
[ ] RP2 one mismatch = one retry attempt
[ ] RP3 5 sync failures -> disconnected
[ ] RP4 4004/404 missing no retry loop
```

## Mobile

```text
[ ] M1 + Phiên mới never 2 dialogs
[ ] M2 + Ở đây never 2 dialogs
[ ] M3 cancel focus/state valid
[ ] M4 repeated modal cycle no InvalidStateError
```

## Push

```text
[ ] F2.1 reload refreshes registration
[ ] F2.2 logout invalidates pending registration
[ ] F2.3 one foreground listener
```

## Polling

```text
[ ] P3 exponential retry
[ ] P4 success resets backoff
[ ] P5 no active session => no 5s poll
[ ] P6 active session => poll enabled
```

## Audit

```text
[ ] ER1 exited natural reason preserved after restart
[ ] ER2 active restart reason = restart
```

---

# 12. VALIDATION REPORT

Cập nhật:

```text
docs/agile/changes/second-review-fix-validation.md
```

Format:

```md
# Second Review Fix Validation

## Baseline
- base:
- final:
- node:
- npm:
- OS:
- Chrome:

## Phase 1 — Global Xterm Queue
### Files
### Tests
### Commands
### Result

## Phase 2 — Ordered Output/Resize
...

## Phase 3 — Reconnect Production Wiring
...

## Phase 4 — Mobile Dialog Lifecycle
...

## Phase 5 — FCM
...

## Phase 6 — Polling
...

## Phase 7 — Exit Reason
...

## Phase 8 — Browser CI
...

## Final
- npm run check:
- npm run build:
- npm test:
- smoke-multi-session:
- smoke-mobile:
- CI unit job:
- CI browser smoke job:
- FCM live tested:
```

---

# 13. DEFINITION OF DONE

Round 2 chỉ DONE nếu:

1. Shared xterm race được sửa bằng global barrier/queue hoặc equivalent deterministic solution.
2. `terminal_resize` và output cùng ordered stream.
3. Reconnect production dùng code được test.
4. Một sequence gap chỉ consume một retry attempt.
5. 5 consecutive sync/connect failures dừng đúng và hiện manual reconnect.
6. 4004/404 stop retry.
7. Mobile modal không dùng `setTimeout(50)` workaround.
8. Mobile test assert <= 1 `dialog[open]`.
9. Polling backoff tests có thật.
10. Historical exitReason không bị overwrite sau restart exited session.
11. `npm run check` PASS.
12. `npm run build` PASS.
13. `npm test` PASS.
14. `smoke-multi-session` PASS.
15. `smoke-mobile` PASS.
16. GitHub Actions unit job PASS.
17. Browser smoke CI PASS nếu Phase 8 được implement.
18. Nếu FCM chưa live tested thì `FCM_ENABLED=false`.

---

# 14. CÁC WORKAROUND BỊ CẤM

Không được:

```text
setTimeout(50/100/200) để chờ dialog/xterm
sleep để chờ xterm
increase retry count
increase websocket buffer
ignore seq gap
apply resize immediately ngoài operation queue
mark registered chỉ vì localStorage consent=true
overwrite historical exitReason
skip browser race test
```

---

# 15. THỨ TỰ IMPLEMENT BẮT BUỘC

```text
Phase 1 — global xterm barrier
↓
Phase 2 — ordered output/resize
↓
Phase 3 — reconnect production wiring
↓
Phase 4 — mobile deterministic modal
↓
Phase 6 — polling
↓
Phase 7 — exitReason
↓
Phase 8 — browser CI
↓
Phase 5 — FCM only if enabling FCM
↓
final validation
```

Lý do Phase 5 FCM để cuối:

- không liên quan trực tiếp đến multi-session correctness,
- có thể giữ feature disabled,
- không được để FCM làm chậm release multi-session nếu `FCM_ENABLED=false`.

---

# 16. HƯỚNG DẪN CUỐI CHO AGENT

Các lỗi còn lại chủ yếu là race/lifecycle.

Không đánh giá correctness dựa vào:

```text
"CI xanh"
"87 tests pass"
"code nhìn đúng"
```

Nếu test không mô phỏng đúng event ordering của browser/xterm thì test xanh không có ý nghĩa cho bug đó.

Đặc biệt với Phase 1:

Test phải chứng minh trường hợp **write A đã thực sự bắt đầu** trước khi B muốn reset.

Đặc biệt với Phase 3:

Test phải chạy qua cùng reconnect implementation mà `TerminalPane` production sử dụng.

Đặc biệt với Phase 4:

Không dùng timeout để tạo cảm giác dialog đã đóng; dùng lifecycle event/state deterministic.

Sau khi hoàn tất, không sửa file plan này thành “PASS”. Hãy ghi bằng chứng vào:

```text
docs/agile/changes/second-review-fix-validation.md
```
