# Fourth review — nhật ký kiểm chứng

Ngày: 2026-09-22.

## Baseline và đánh giá kế hoạch

- Runtime baseline: `3026b70a8d855b604ae0db3b83956c43c7b4d706`.
- HEAD lúc bắt đầu: `c088041e9978b1d18d7ad7c365f4e8941d4babed` (chỉ thêm fourth-review plan); working tree sạch. Hai file runtime của finding chưa đổi so với baseline.
- Baseline CI: [run 35682251555](https://github.com/nguyenduchoan/web-cli/actions/runs/35682251555), `success`, xác minh qua GitHub Actions API ngày 2026-09-22. Build, Check & Test và Browser Smoke Tests đều PASS; bốn bước multi-session/mobile/push/polling đều PASS.
- Findings xác nhận: WebSocket CLOSING/per-attempt timer ownership; scheduled polling không recheck hidden/offline trước fetch.
- Điều chỉnh cần thiết so với guard tối thiểu trong plan: `connect()` phải chặn cả thời gian retry timer đang chờ **sau** close event; nếu chỉ chặn CLOSING, resume vẫn bỏ qua backoff. Giữ quyền sở hữu socket đến khi close handler xử lý xong, kể cả socket đã CLOSED nhưng close event chưa được dispatch.
- Manual reconnect chọn contract B: chỉ khởi động khi ticket/connection cũ đã kết thúc và socket đã được close handler giải phóng. Instance đã dispose không được hồi sinh bằng callback UI đến muộn.
- Poll timer cũng recheck active session để giữ contract periodic; explicit refresh và error backoff vẫn được chạy khi chưa có active session.
- Không cần sửa `TerminalPane.tsx`: resume hiện gọi production `TerminalConnectionSession.connect()`, được guard tại owner. Không sửa single-flight/auth-generation hoặc push/FCM production.

## Implementation và ownership

- `web/src/lib/terminalConnection.ts`: socket còn thuộc attempt hoặc retry timer chưa fire thì `connect()` trả về, không lấy ticket mới. Gap/mismatch chỉ invalidate và yêu cầu close; close handler là nơi duy nhất quyết định retry cho socket failure.
- Heartbeat/open timeout nằm trong closure của từng attempt. Cleanup idempotent chỉ xóa timer local; reference cleanup của session chỉ được xóa nếu vẫn trỏ đúng owner. `dispose()` dọn cả open timeout ngay, không phải chờ async close.
- Heartbeat recheck socket identity, generation, stopped và OPEN trước khi gửi trực tiếp qua socket owner. Open timeout chỉ đóng socket owner còn CONNECTING và timeout còn hiệu lực. Callback đã vào event queue nhưng bị cancel/invalidate không ảnh hưởng attempt mới.
- Retry callback kiểm tra timer identity/generation rồi giải phóng timer trước khi gọi `connect()`. Ticket failure dùng cùng cơ chế, giữ exponential backoff và jitter. Counter chỉ reset sau terminal sync thành công hoặc manual reconnect hợp lệ.
- `web/src/lib/pollingPolicy.ts`: `executeFetch()` đọc auth/visible/online tại thời điểm thực thi; callback periodic còn kiểm tra active session. Bị chặn thì không request, không thay đổi error state và không schedule loop. Event visible/online/focus hợp lệ tiếp tục explicit refresh và lịch 5 giây.
- `server/test/reconnectPolicy.test.ts`: thêm async-close mock, fake timeout/interval với callback có thể được gọi lại sau cancel; RP5/RP6 có teardown để không để heartbeat thật chạy sau test.
- `server/test/pollingPolicy.test.ts`: thêm runtime-state regression; P7 khai báo visible/online tường minh để không phụ thuộc `navigator` của Node test environment.
- `scripts/smoke-polling-lifecycle.cjs`: dùng Chromium `setOfflineMode`, quan sát timer browser thật mà không đổi delay, kiểm tra production `useSessions` với API fixture in-memory. Fixture vẫn hoạt động offline để request sai không bị che bởi HTTP failure.

## RED/GREEN evidence

Tạo fixture `/tmp/web-cli-fourth-baseline` bằng `git archive 3026b70...`, copy các regression test mới và dùng dependencies có sẵn. Đã đối chiếu byte-for-byte hai runtime file fixture với `git show 3026b70:<path>`.

Lệnh RED chạy trong fixture, GREEN chạy tại repository:

```bash
/home/mrhoan/source/web-cli/node_modules/.bin/tsx --test \
  --test-name-pattern='RP(8|9|1[0-4]):|P1[1-5]:' \
  server/test/reconnectPolicy.test.ts server/test/pollingPolicy.test.ts
```

| Regression | RED trên 3026b70 | GREEN |
| --- | --- | --- |
| RP8: CONNECTING/OPEN/CLOSING; gap chỉ close, một retry | Tạo socket thứ hai lúc CLOSING (`2 !== 1`) | PASS |
| RP9: stale close không clear heartbeat mới | H2 bị clear bởi close cũ | PASS |
| RP10: stale heartbeat không ping socket mới | HB1 gửi ping qua socket2 | PASS |
| RP11: resume lúc CLOSING và lúc chờ backoff | Tạo socket mới trước retry | PASS; một retry 1125ms gồm jitter 125ms |
| RP12: queued open timeout | Timeout bị cancel vẫn đóng socket đã OPEN | PASS; socket mới cũng không bị đóng |
| RP13: manual reconnect | Lấy ticket mới khi socket đang CLOSING | PASS; retry cũ không tạo attempt nữa |
| RP14: dispose cleanup | Open timeout còn pending sau dispose | PASS; callback muộn không revive session |
| P11: timer fire khi hidden | Fetch tăng từ 1 lên 2 | PASS; restore một refresh, trở lại 5s |
| P12: timer fire khi offline | Fetch tăng từ 1 lên 2 | PASS; restore một refresh, trở lại 5s |
| P13: backoff fire khi offline | Fetch tăng từ 1 lên 2 | PASS; giữ retryCount=1/failed=true; online success reset |
| P14: auth bị thu hồi trước timer | Fetch tăng từ 1 lên 2 | PASS |
| P15: không còn active session trước timer | Fetch tăng từ 1 lên 2 | PASS; explicit refresh vẫn được phép |

- RED: 12/12 FAIL đúng assertion, exit 1; log `/tmp/web-cli-fourth-baseline-red.log`.
- GREEN: 12/12 PASS, exit 0; log `/tmp/web-cli-fourth-green-unit.log`. Full suite cuối xác nhận lại các case, gồm assertion dispose bổ sung.
- Browser RED: `POLLING_TEST_SOURCE_ROOT=/tmp/web-cli-fourth-baseline node scripts/smoke-polling-lifecycle.cjs`, exit 1: `pending poll cannot call the API offline`, requests `5 !== 4`. Log `/tmp/web-cli-fourth-red-browser-retry.log`.
- Browser GREEN: `node scripts/smoke-polling-lifecycle.cjs`, exit 0: `passed=true`, `offlinePolling=true`, requests=6. Timer thật fire offline mà không gọi API/rearm; native online event gọi đúng một lần và poll 5s tiếp theo chạy. Log `/tmp/web-cli-fourth-smoke-polling.log`.
- Hidden state: coverage bằng fake-timer unit P11, **không** claim native browser background/visibility smoke. Chọn Option B offline của plan để tránh phụ thuộc background throttling trong CI.

## Full local validation

| Lệnh | Kết quả | Log |
| --- | --- | --- |
| `npm run check` | PASS | `/tmp/web-cli-fourth-check-final.log` |
| `npm run build` | PASS | `/tmp/web-cli-fourth-build-final.log` |
| `npm test` | PASS 138/138, không skip | `/tmp/web-cli-fourth-tests-final.log` |
| `node scripts/smoke-multi-session.cjs` | PASS | `/tmp/web-cli-fourth-smoke-multi-session.log` |
| `node scripts/smoke-mobile.cjs` | PASS | `/tmp/web-cli-fourth-smoke-mobile.log` |
| `node scripts/smoke-push-lifecycle.cjs` | PASS | `/tmp/web-cli-fourth-smoke-push.log` |
| `node scripts/smoke-polling-lifecycle.cjs` | PASS, gồm offline runtime | `/tmp/web-cli-fourth-smoke-polling.log` |
| `git diff --check` | PASS | Kiểm tra trực tiếp trước commit |

- Existing RP1–RP7, P3–P10, XQ/OR và push tests đều PASS trong full suite.
- Lần full test đầu: 137/138, P7 fail vì fixture dùng `navigator.onLine` mặc định không được định nghĩa như browser. Đã bổ sung runtime getters tường minh; chạy lại toàn bộ suite đạt 138/138.
- Sandbox không cho tsx mở IPC (`listen EPERM`) hoặc smoke bind loopback. Các lần kiểm chứng có kết quả ở trên chạy lại ngoài sandbox sau approval. Lỗi sandbox không được tính là RED regression.
- Dependencies giữ nguyên theo `package-lock.json`; Node local v24.16.0; CI dùng Node 22 theo workflow hiện hữu.

## Vận hành, reliability, bảo mật và rollback

- Đã kiểm kê port bằng `ss -lntup`; smoke dùng port trống do OS cấp, bind `127.0.0.1`, auth/project fixture ở thư mục tạm, có health check trước browser. Đối chiếu port 33617/PID 3259046 của polling fixture qua `ss -lntp` trong lúc chạy; các fixture tự cleanup sau test.
- Backend đang chạy từ `/home/mrhoan/apps/server-hub/releases/20260913T095320Z`, khác thư mục repo. Không restart/deploy hoặc thay port/cấu hình dịch vụ hiện hữu.
- Giảm duplicate ticket/socket và request hidden/offline; giữ backoff để tránh reconnect storm. Bộ nhớ timer/closure giới hạn theo một active attempt; dispose và close cleanup idempotent.
- Không đổi auth policy, protocol, payload, dependency hoặc lưu/log secret. Không migration dữ liệu. Nếu cần rollback sau deploy, dùng artifact release trước hoặc revert commit fix; rollback sẽ khôi phục các race đã ghi nhận.
- Không chạy load test mới: scope là lifecycle client, được kiểm chứng bằng deterministic regression và các browser smoke hiện hữu.

## Commit và remote CI

- Local validation hoàn tất. Commit/push và kết quả GitHub Actions của implementation: đang chờ.
- Chưa đánh dấu toàn bộ Definition of Done cho đến khi cả Build, Check & Test và Browser Smoke Tests của commit fix đều xanh.
