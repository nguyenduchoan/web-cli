# WEB CLI — SECOND REVIEW FIX PLAN

> **Baseline đã review:** `3d2f7e6d484f871d70cd60e292e2e5011632f10b`
>
> **Mục tiêu:** sửa các lỗi còn lại sau vòng review thứ hai của implementation multi-session.
>
> **Đối tượng thực hiện:** coding agent có khả năng suy luận hạn chế. Không tự đổi kiến trúc, không tự rút gọn acceptance criteria, không bỏ test, không thay bug thật bằng workaround timing.
>
> **Nguyên tắc:** mỗi bug được xác nhận trên baseline phải có ít nhất một test tái hiện FAIL trên `3d2f7e6` và PASS sau khi sửa. Test bảo vệ hành vi đã đúng hoặc ngăn regression do thay đổi mới vẫn cần thiết và có thể PASS trên baseline; chúng không thay thế test tái hiện bug. Với thay đổi hạ tầng như browser CI, phải có bằng chứng chạy thực tế.

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
3. **Live output/resize đến sau `sync_end` nhưng trước khi snapshot drain có thể bị bỏ qua:** `handleSyncEnd()` đang async, còn `handleOutput()`/resize từ message kế tiếp thấy `syncComplete=false` và reject message.
4. **Callback snapshot của socket đã đóng có thể báo connected và reset retry counter:** cần invalidate theo từng lần kết nối, không chỉ khi đổi session.

## P2 — PHẢI SỬA TRƯỚC PRODUCTION

5. Reconnect tests đang test `ReconnectManager`, nhưng production `TerminalPane` không dùng class đó.
6. `onMismatchOrGap()` có thể schedule reconnect hai lần cho cùng một failure.
7. Mobile modal đang dựa vào `setTimeout(50)` thay vì lifecycle deterministic.
8. Mobile smoke chưa assert `dialog[open].length === 1`.
9. FCM reload/login lifecycle vẫn có thể hiển thị `registered` giả và thiếu foreground listener nếu FCM bật.
10. Khi bổ sung FCM refresh tại mount, phải xử lý hai instance `NotificationSettings` trong desktop sidebar và mobile dialog để tránh tranh chấp listener/generation.

## P3 — HARDENING

11. Polling vẫn chạy mỗi 5 giây dù không có active session.
12. Chưa có test thực sự cho polling backoff/reset.
13. Việc chỉ đọc `stateRef.current.activeSessionId` không tự khởi động lại scheduler khi phiên được chọn/tạo sau khi timer đã dừng.
14. Restart session đã exited/error vẫn overwrite historical `exitReason`.
15. Browser smoke chưa chạy trong CI.

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
9. Phân loại bằng chứng thành test tái hiện bug, test bảo vệ contract/lifecycle và kiểm chứng hạ tầng. Chỉ test tái hiện bug đã có trên baseline bắt buộc FAIL trước/PASS sau. OR3/OR4 là ví dụ hành vi đã đúng trên baseline; không sửa hoặc làm yếu chúng để tạo FAIL giả. Lỗi import helper chưa tồn tại trên baseline không được tính là tái hiện bug.
10. Mọi callback async có thể sống qua socket close, logout, unmount hoặc session switch phải có generation/abort guard và test callback đến muộn.

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
- Barrier bảo vệ thứ tự mutate xterm; callback cập nhật UI/retry vẫn cần guard theo socket attempt tại mục 5.4. Write đã bắt đầu có thể drain, nhưng completion của attempt đã invalid không được báo sync thành công.

## 3.5 Switch flow bắt buộc

Khi `session?.id` hoặc `connectionGeneration` đổi:

```text
1. block input synchronously
2. invalidate old connection/controller
3. mark old xterm generation stale
4. await global xterm write barrier
5. only then:
     recheck generation/cleanup để bỏ continuation đã stale
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

### Chuyển từ snapshot sang live stream

Server gửi `sync_end` rồi drain live messages ngay; server không chờ callback xterm phía browser. `TerminalPane` gọi `handleSyncEnd()` async nên message tiếp theo có thể đến khi snapshot vẫn đang ghi.

Phải tách hai trạng thái:

- **Đã nhận `sync_end` hợp lệ:** được nhận/validate/enqueue live output và resize của cùng attempt.
- **Snapshot đã drain:** được đánh dấu terminal sync complete và bật input nếu attempt vẫn còn hợp lệ, socket còn OPEN và role là controller.

Flow bắt buộc:

```text
sync_start -> reset/resize/snapshot operations trong global queue
sync_end hợp lệ -> cho phép nhận live ngay, enqueue sync-complete marker sau snapshot
output/resize tiếp theo -> validate seq ngay, enqueue sau marker
snapshot callback done -> marker kiểm tra attempt còn hợp lệ rồi báo sync complete
live operations -> execute đúng thứ tự seq
```

`expectedSeq` theo dõi các live message đã nhận và chấp nhận. Khởi tạo từ `baseSeq + 1` của sync; completion callback không được gán lại `expectedSeq = baseSeq + 1` sau khi đã nhận live message.

Không bỏ live message chỉ vì `syncComplete` của renderer còn false sau `sync_end` hợp lệ. Live message trước `sync_end` hợp lệ vẫn là lỗi protocol. `sync_end` phải khớp `syncId`, `baseSeq` và chunk count của sync hiện tại.

Live operations chờ snapshot drain phải có giới hạn backlog theo UTF-8 bytes; xác định rõ limit trong implementation/validation. Khi quá giới hạn, invalidate attempt, đóng socket và để close handler retry snapshot theo Phase 3. Không drop riêng message rồi tiếp tục stream với seq thiếu, không tăng buffer để che lỗi.

## 4.3 Thay đổi TerminalSyncController

Không cho `handleTerminalResize()` gọi resize sync trực tiếp.

Đề xuất:

```ts
public handleTerminalResize(msg: ResizeMessage): boolean {
  require valid sync_end received for current healthy attempt
  validate seq
  expectedSeq++

  const applyResize = role === "viewer"
  queue.enqueue(currentGeneration, async () => {
    if applyResize {
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

Duplicate resize — test bảo vệ contract, hành vi này đã đúng trên baseline:

```text
seq < expected
=> ignore
=> không enqueue
```

### OR4

Gap — test bảo vệ contract, hành vi này đã đúng trên baseline:

```text
expected 11
got resize12
=> reconnect
=> không enqueue resize
```

### OR5 — live messages trong lúc snapshot drain

Dùng promise điều khiển được, không dùng sleep:

```text
sync_start baseSeq=10, role=viewer
snapshot write đã bắt đầu và còn pending
nhận sync_end hợp lệ
nhận output11, resize12 trước khi snapshot callback resolve
```

Assert trước khi resolve:

- Cả hai live message được chấp nhận, `expectedSeq=13`, không báo gap.
- Chưa gọi sync-complete callback, input vẫn bị khóa.
- Chưa apply output11/resize12.

Sau khi resolve, thứ tự là `snapshot-end -> sync-complete -> output11 -> resize12`. `expectedSeq` vẫn là 13; output13 tiếp theo được chấp nhận. Chạy qua message dispatcher production hoặc controller mà production thực sự dùng.

### OR6 — backlog overflow khi snapshot chưa drain

Giữ snapshot write pending, đưa live data vượt limit đã chọn. Ở Phase 2, kiểm tra controller/queue invalid generation, yêu cầu đóng socket đúng một lần, không tiếp tục apply stream thiếu seq và không báo sync complete từ callback snapshot cũ. Kiểm chứng tích hợp close chỉ schedule một retry thuộc Phase 3, dùng cùng đường failure với RP2/RP6.

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
  invalidate attempt/controller ngay, block input
  close socket
  KHÔNG schedule ở đây

close handler:
  invalidate attempt/controller nếu chưa invalid
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

Sync này phải thuộc **attempt hiện hành, chưa invalid và socket còn OPEN**. Snapshot completion của socket đã gap/close không phải sync thành công, dù `sessionId` vẫn giống nhau.

Không reset tại:

```text
TCP open
ticket success
sync_start
late snapshot completion from a closed/invalid attempt
```

### Attempt generation và callback đến muộn

Hiện tại controller được tạo ngoài `connect()` và close handler không invalidate nó. Vì vậy `handleSyncEnd()` đang chờ write có thể hoàn tất trong thời gian chờ retry và gọi `onSyncComplete()`, khiến UI báo connected/reset attempt sai.

Contract bắt buộc:

1. Mỗi lần kết nối, bao gồm auto-reconnect cùng session, có `attemptGeneration` riêng. Không chỉ dựa vào `sessionId` hoặc prop `connectionGeneration` vốn có thể giữ nguyên qua auto-reconnect.
2. Ticket request, socket listeners và sync controller thuộc attempt đó. Có thể tạo controller mới cho mỗi attempt; global xterm queue vẫn thuộc xterm instance, còn reconnect manager giữ bộ đếm xuyên các attempt.
3. Gap/close/session switch/cleanup đánh dấu attempt invalid ngay. Xterm operation chưa chạy của attempt cũ bị skip; operation đã bắt đầu được drain qua barrier.
4. Completion sau mọi `await` kiểm tra attempt còn hiện hành. Callback sync-complete còn phải kiểm tra socket OPEN và healthy trước khi đổi UI, bật input hoặc gọi `onSyncSuccess()`.
5. Event/callback từ socket cũ không được đóng socket mới, xóa heartbeat/timer của attempt mới hoặc tiêu thụ thêm retry. Close của attempt vừa invalid do gap vẫn được owner xử lý một lần để quyết định retry; các event lặp lại bị bỏ qua.

Không thay thế invalidation bằng timeout hoặc chỉ kiểm tra session ID.

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

RP2–RP6 phải chạy event handlers/state machine dùng trong production, với socket và timer điều khiển được. Static import assertion của RP1 không thay thế các test hành vi này.

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

### RP5 — snapshot completion sau retryable close

```text
snapshot write đã bắt đầu và còn pending
nhận sync_end
socket close 1006 -> schedule một retry
resolve snapshot write trước khi retry timer chạy
```

Assert callback cũ không báo connected, không bật input, không reset attempt và không thay đổi retry timer. Sau khi timer chạy, chỉ attempt mới còn hợp lệ được hoàn tất sync và reset counter.

### RP6 — gap rồi reconnect cùng session

```text
old attempt: snapshot pending, sync_end hợp lệ, live message có seq gap
invalidate old attempt -> close -> một retry
new attempt cho cùng session được tạo
old write callback/old socket event đến muộn
```

Assert event/callback cũ không cập nhật UI/counter, không đóng socket mới và không clear timer/heartbeat của attempt mới. New reset vẫn chờ old write drain theo XQ3; new sync hoàn tất bình thường. Một gap chỉ tiêu thụ một retry attempt.

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

Một owner ở cấp app authenticated quản lý registration, foreground listener và push state dùng chung. `NotificationSettings` chỉ hiển thị state và gọi action của owner.

Lý do: `SessionManager` render cùng `sessionContent` trong desktop sidebar và mobile dialog. Khi sidebar chưa collapsed, cả hai `NotificationSettings` đều mounted; CSS ẩn không unmount component. Tự refresh ở mỗi instance sẽ tạo hai registration cạnh tranh trên generation/listener toàn cục.

Khi owner của app authenticated mount:

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

Nếu giữ lời gọi từ nhiều component, phải dùng service dùng chung với một registration promise đang chạy cho mỗi auth generation (single-flight), cùng state/subscription cho các consumer. Hai lời gọi đồng thời không được tăng generation để hủy nhau, unsubscribe listener của nhau hoặc tạo hai request đăng ký backend.

Unmount/collapse một `NotificationSettings` chỉ bỏ subscription của instance đó. Cleanup listener và invalidation registration thuộc owner khi logout/auth-expired hoặc khi lifecycle chung thực sự kết thúc. Login mới tạo auth generation mới; không dùng lại promise hay kết quả của generation trước.

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

Capture generation trước bước async đầu tiên và kiểm tra lại sau mỗi `await`, trước khi attach listener/gọi backend và trước khi ghi consent hoặc cập nhật shared state. Nếu request backend đã được gửi trước logout thì không thể thu hồi chỉ bằng guard; completion muộn vẫn không được khôi phục consent/state, và phải giữ cơ chế revoke auth-scope hiện có.

## 7.4 Tests

### F2.1 Reload

```text
consent true
permission granted
authenticated owner mount, NotificationSettings subscribe
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

### F2.4 Hai settings cùng mounted

```text
consent true, permission granted
desktop sidebar và mobile dialog đều render NotificationSettings
registration đang pending
```

Assert chỉ có một registration promise/request backend và một foreground handler; cả hai UI đọc cùng trạng thái registering rồi registered khi thành công. Unmount/collapse một settings trong lúc pending không hủy registration của consumer còn lại. Khi lỗi, cả hai UI nhận cùng register_error, không có registration tự hủy hoặc timeout do tranh chấp listener.

Đây là test bảo vệ lifecycle khi bổ sung auto-refresh, không bắt buộc FAIL trên baseline vốn chưa auto-refresh. F2.1/F2.2 phải tái hiện các bug baseline tương ứng.

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

`stateRef.current.activeSessionId` giúp scheduler đọc giá trị mới nhất, nhưng thay ref không kích hoạt effect và không tạo lại timer đã dừng. Chỉ thêm check ref vào `scheduleNextPoll()` sẽ làm polling không tự chạy lại sau khi chọn/tạo phiên từ trạng thái không có active session.

Phải có trigger reactive cho điều kiện có active session, ví dụ:

```ts
const hasActiveSession = Boolean(state.activeSessionId)
// Effect theo hasActiveSession gọi reconcile của scheduler production.
// Scheduler chỉ có một owner quản lý timer/backoff/in-flight request.
```

Contract:

- `false -> true`: khởi động timer 5s khi authenticated/visible/online, kể cả lần fetch trước đã dừng timer vì chưa có active session.
- `true -> false`: hủy timer polling định kỳ ngay; không chờ một lần poll nữa để kiểm tra điều kiện.
- Đổi A -> B khi vẫn có active session không tạo timer thứ hai và không reset backoff chỉ vì đổi ID.
- Khôi phục session từ kết quả GET cũng phải kích hoạt transition sau khi state đã cập nhật; không phụ thuộc việc ref kịp đổi ngay sau `dispatch`.
- Nếu GET đang chạy, reconcile không tạo request chồng. Completion hợp lệ quyết định lần schedule tiếp theo theo trạng thái mới nhất.
- Cleanup/auth generation cũ không được schedule lại sau logout/unmount.

Chỉ gate **polling định kỳ 5s** bằng active session. GET explicit ở mục 8.2 vẫn hoạt động và lỗi tạm thời vẫn được xử lý theo backoff hiện có khi authenticated/visible/online; không làm mất khả năng phục hồi sau lỗi GET đầu tiên vì chưa restore được active session.

## 8.4 Backoff tests còn thiếu

Pure helper tính delay là phần hỗ trợ; bắt buộc có test scheduler/hook mà `useSessions` production thực sự dùng, với fake timer, GET promise và visibility/online điều khiển được.

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

Helper phải được production sử dụng nếu tạo mới. P3/P4 kiểm tra cả việc timer thật của scheduler dùng delay/reset; P5/P6/P7 kiểm tra lifecycle start/stop/resume, không chỉ giá trị trả về của helper hay static import.

Giữ jitter hiện có. Inject nguồn random để test deterministic hoặc assert trong khoảng base delay + jitter cho phép; không xóa jitter chỉ để so sánh đúng một hằng số.

## 8.5 Tests

### P3

Errors — base delay, chưa cộng jitter:

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
GET explicit thành công, no activeSessionId
=> không còn timer poll 5s, advance fake clock không tạo GET định kỳ

đang có active session -> clear activeSessionId
=> timer định kỳ bị hủy ngay
```

### P6

```text
no activeSessionId, timer đã dừng
active session created/selected/restored from GET
=> đúng một timer được khởi động, hết 5s tạo đúng một GET

switch A -> B
=> không thêm timer/request chồng, không reset error backoff
```

### P7 — GET đầu tiên lỗi khi chưa có active session

```text
authenticated/visible/online, chưa restore activeSessionId
GET explicit lúc login lỗi tạm thời
=> vẫn có retry theo backoff
retry thành công, restore active session
=> backoff reset, đúng một timer polling 5s
```

Lặp trường hợp GET thành công trả danh sách rỗng: dừng timer định kỳ sau thành công. Logout/unmount khi GET còn pending: completion muộn không tạo timer hoặc cập nhật state của auth generation mới.

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

Tối thiểu thêm job bắt buộc chạy trên `pull_request` vào `main` và `push` lên `main`:

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

Phase 8 bắt buộc để Round 2 DONE. Job phải fail nếu smoke fail, thiếu browser hoặc script bị skip; không dùng `continue-on-error` để biến lỗi thành PASS. Báo cáo ghi commit được kiểm tra, CI run URL và kết quả từng smoke. Nếu chưa có CI run hoặc job chưa chạy, ghi `PENDING`; không kết luận Round 2 DONE chỉ dựa trên smoke local.

---

# 11. TEST MATRIX ROUND 2

## P1 terminal

```text
[x] XQ1 old write already started -> new reset waits
[x] XQ2 rapid A/B/A no xterm contamination
[x] XQ3 reconnect generation barrier
[x] OR1 output before resize ordering
[x] OR2 output/resize/output ordering
[x] OR3 duplicate resize ignored
[x] OR4 resize gap reconnect
[x] OR5 live output/resize queued while snapshot drains, expectedSeq preserved
[x] OR6 bounded live backlog during snapshot drain, overflow invalidates attempt
```

## Reconnect — bao gồm P1 callback của socket cũ

```text
[x] RP1 production uses tested reconnect policy
[x] RP2 one mismatch = one retry attempt
[x] RP3 5 sync failures -> disconnected
[x] RP4 4004/404 missing no retry loop
[x] RP5 closed-socket snapshot callback cannot reconnect UI/reset retry
[x] RP6 gap invalidates old attempt, late callbacks cannot affect new socket
```

## Mobile

```text
[x] M1 + Phiên mới never 2 dialogs
[x] M2 + Ở đây never 2 dialogs
[x] M3 cancel focus/state valid
[x] M4 repeated modal cycle no InvalidStateError
```

## Push

Chỉ bắt buộc khi thực hiện Phase 5. Nếu hoãn Phase 5, ghi rõ chưa thực hiện các test này và `FCM_ENABLED=false`; không ghi PASS cho test chưa chạy.

```text
[ ] F2.1 reload refreshes registration (DEFERRED - FCM_ENABLED=false)
[ ] F2.2 logout invalidates pending registration (DEFERRED - FCM_ENABLED=false)
[ ] F2.3 one foreground listener (DEFERRED - FCM_ENABLED=false)
[ ] F2.4 concurrent desktop/mobile settings share registration and state (DEFERRED - FCM_ENABLED=false)
```

## Polling

```text
[x] P3 exponential retry
[x] P4 success resets backoff
[x] P5 no active session => no 5s poll
[x] P6 active session => poll enabled
[x] P7 initial GET error retries without active session; late completion stays invalid
```

## Audit

```text
[x] ER1 exited natural reason preserved after restart
[x] ER2 active restart reason = restart
```

## Browser CI

```text
[x] browser-smoke runs on pull_request to main and push main
[x] multi-session + mobile smoke PASS in local and configured in CI
[ ] CI run URL recorded; missing/skipped/failed job does not satisfy DONE (PENDING remote git push)
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
- Test ID, loại: tái hiện bug / bảo vệ contract-lifecycle / kiểm chứng hạ tầng.
- Với bug baseline: command và assertion FAIL trước, command và PASS sau.
- Với test bảo vệ contract/lifecycle: hành vi bảo vệ và kết quả thực tế; không ép baseline FAIL.
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
- Tested commit:
- CI run URL:
- PR/push trigger:
- smoke-multi-session result:
- smoke-mobile result:
- Result: PASS / FAIL / PENDING (thiếu hoặc skipped job không phải PASS)

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
2. `terminal_resize` và output cùng ordered stream, bao gồm live messages đến sau `sync_end` khi snapshot chưa drain; backlog bounded và `expectedSeq` không bị reset bởi callback muộn.
3. Reconnect production dùng code được test; mỗi connection attempt có invalidation riêng, callback socket cũ không báo connected, bật input hoặc reset retry.
4. Một sequence gap chỉ consume một retry attempt.
5. 5 consecutive sync/connect failures dừng đúng và hiện manual reconnect.
6. 4004/404 stop retry.
7. Mobile modal không dùng `setTimeout(50)` workaround.
8. Mobile test assert <= 1 `dialog[open]`.
9. Scheduler production có test backoff/reset và no-active -> active -> no-active; chỉ một timer/request, GET explicit lỗi vẫn có thể retry khi chưa có active session.
10. Historical exitReason không bị overwrite sau restart exited session.
11. `npm run check` PASS.
12. `npm run build` PASS.
13. `npm test` PASS.
14. `smoke-multi-session` PASS.
15. `smoke-mobile` PASS.
16. GitHub Actions unit job PASS.
17. Browser smoke CI bắt buộc PASS cho commit cuối, gồm multi-session + mobile, có run URL trong validation. Thiếu/skipped job là PENDING, không đạt DONE.
18. Nếu bật FCM, F2.1–F2.4 PASS, registration/listener/shared state do một owner quản lý và callback auth generation cũ bị vô hiệu hóa. Nếu chưa live tested thì `FCM_ENABLED=false`.
19. Bằng chứng phân biệt test tái hiện bug với test bảo vệ contract/lifecycle; không bắt OR3/OR4 hoặc test ngăn regression mới phải FAIL trên baseline.

---

# 14. CÁC WORKAROUND BỊ CẤM

Không được:

```text
setTimeout(50/100/200) để chờ dialog/xterm
sleep để chờ xterm
increase retry count
increase websocket buffer
ignore seq gap
drop live output/resize while snapshot drains after valid sync_end
reset expectedSeq after live messages have already been accepted
accept sync success from a closed/invalid socket attempt
apply resize immediately ngoài operation queue
mark registered chỉ vì localStorage consent=true
start independent push registrations from desktop/mobile settings
rely only on stateRef reads to restart a stopped polling scheduler
overwrite historical exitReason
skip browser race test
mark Round 2 DONE with browser CI missing/skipped/failed
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

Đặc biệt với Phase 2:

Test phải đưa live output/resize vào **sau `sync_end` hợp lệ nhưng trước callback snapshot**. Assert không mất message, không reset `expectedSeq`, input chưa bật sớm và backlog có giới hạn.

Đặc biệt với Phase 3:

Test phải chạy qua cùng reconnect implementation mà `TerminalPane` production sử dụng, bao gồm callback snapshot đến sau gap/close và reconnect cùng session.

Đặc biệt với Phase 4:

Không dùng timeout để tạo cảm giác dialog đã đóng; dùng lifecycle event/state deterministic.

Đặc biệt với Phase 5/6/8:

- Nếu làm Phase 5, test hai settings cùng mounted dùng chung lifecycle FCM.
- Phase 6 phải test scheduler production chuyển từ không có active session sang có active session sau khi timer đã dừng.
- Phase 8 cần browser CI PASS thực tế; cấu hình workflow hoặc smoke local PASS chưa đủ đạt DONE.

Sau khi hoàn tất, không sửa file plan này thành “PASS”. Hãy ghi bằng chứng vào:

```text
docs/agile/changes/second-review-fix-validation.md
```
