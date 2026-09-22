# Third review — nhật ký kiểm chứng

Ngày: 2026-09-21. Baseline: `4c8801b83ef8a003f1611f5f0cc534586e51d954`.

## Review kế hoạch

- Sửa runner TypeScript thành `tsx`; bổ sung kiểm thử browser cho production hook thay vì coi source-string là bằng chứng hành vi.
- Bổ sung polling re-login trong khi fetch cũ pending, giữ tối đa một request tại một thời điểm.
- Push: hủy từ lúc bắt đầu logout/auth expiry, guard mọi async boundary, chỉ attach foreground listener sau backend success, cleanup timeout/FID subscription ở mọi lối ra; unmount không xóa consent.
- Chỉ sửa ba nhóm lifecycle; không đổi policy xác thực, protocol server, package version hay dịch vụ đang chạy.
- Phân công: agent chính xử lý xterm/tích hợp; `gpt-5.6-terra` review polling; agent kế thừa model chính review push; `gpt-5.6-luna` thu bằng chứng test xterm độc lập.

## Baseline

- `git status --short`: chỉ có plan do người dùng cung cấp ở trạng thái untracked; bảo toàn file.
- `git rev-parse HEAD`: khớp baseline.
- Đọc `.github/workflows/ci.yml`; dùng npm theo `package-lock.json`.
- `npm ci`: lần sandbox FAIL `EAI_AGAIN registry.npmjs.org`; retry ngoài sandbox PASS (475 packages). npm báo 2 moderate advisories có sẵn; không đổi dependency trong task này.
- `npm run check`: PASS.
- `npm test`: sandbox FAIL `listen EPERM` IPC tsx; retry ngoài sandbox PASS 109/109.
- `npm run build`: PASS.
- Log: `/tmp/web-cli-third-baseline-{install,install-retry,tests,tests-retry,build}.log`.
- Đã kiểm kê `ss -lntp` ngoài sandbox; smoke dùng port do OS cấp trên loopback, dữ liệu auth/project trong thư mục tạm; không restart dịch vụ hiện có.

- Browser preflight trước tích hợp: `node scripts/smoke-mobile.cjs` sandbox FAIL EPERM loopback; retry ngoài sandbox PASS. Kết quả này chỉ xác nhận môi trường browser; smoke trên build cuối đã chạy lại và ghi ở bảng validation. Logs `/tmp/web-cli-third-mobile-pre-integration{,-retry}.log`.

## Phase 1 — xterm

- Files: `web/src/lib/terminalSync.ts`, `server/test/terminalSync.test.ts`, `server/test/reconnectPolicy.test.ts`.
- `XQ4`: controlled promise giữ operation cũ, invalidate generation, enqueue reset/resize/snapshot/complete mới; stale queued operation bị bỏ qua.
- `RP7`: reconnect cùng session trong khi snapshot write cũ thực sự đã bắt đầu; reset mới phải chờ, socket cũ không tác động socket mới, counter chỉ reset sau sync hợp lệ.
- `T2.1` chờ queue barrier trước assertion geometry, phù hợp hợp đồng mới.
- RED: `node --import tsx --test --test-name-pattern='XQ4|RP7' server/test/terminalSync.test.ts server/test/reconnectPolicy.test.ts` exit 1 trên source baseline (2 failure; sandbox chỉ hiển thị cấp file). Fixture cô lập `/tmp/web-cli-third-phase1-red` dùng `terminalSync.ts` lấy bằng `git show` baseline, `cmp` xác nhận giống baseline. Chạy repo `node_modules/.bin/tsx --test --test-name-pattern='XQ4|RP7' server/test/terminalSync.test.ts server/test/reconnectPolicy.test.ts`: FAIL 2/2 đúng assertion: RP7 ghi nhận reset/resize thứ hai trước old-end; XQ4 đã có reset/resize khi operation cũ vẫn pending. Log chi tiết `/tmp/web-cli-third-phase1-red-detailed.log`.
- GREEN: cùng lệnh exit 0; `npx tsx --test --test-name-pattern='XQ4|RP7' server/test/terminalSync.test.ts server/test/reconnectPolicy.test.ts` ngoài sandbox PASS 2/2, assertion chi tiết.
- `npm run check`: PASS.
- Gate: `npx tsx --test server/test/terminalSync.test.ts server/test/reconnectPolicy.test.ts` PASS 28/28; `npm test` PASS 111/111.
- Lần full test đầu sau fix phát hiện `OR5` phân loại snapshot resize bằng `syncEndReceived` (không còn đúng khi resize qua queue). Cập nhật test ghi nhận cả snapshot geometry và chờ tín hiệu snapshot thật sự bắt đầu; assertion thứ tự đầy đủ chặt hơn. Không thay logic production ngoài fix.
- Logs: `/tmp/web-cli-third-phase1-{red,green,check,focused,tests,tests-final}.log`.

## Phase 2 — polling

- Files: `web/src/features/sessions/useSessions.ts`, `web/src/lib/pollingPolicy.ts`, `server/test/pollingPolicy.test.ts`, `scripts/smoke-multi-session.cjs`.
- Mutable refs giữ scheduler ổn định nhưng đọc auth/callback mới nhất. `resumeAfterFetch` tiếp tục generation mới sau request cũ, không overlap; stop-only không lên lịch lại.
- P8 kiểm tra mutable runtime; P9 controlled promise bắt re-login; P10 kiểm tra logout khi request pending. Source-string test đã bỏ khỏi final để tránh phụ thuộc tên biến; browser smoke kiểm tra hook thật.
- RED: `npx tsx --test server/test/pollingPolicy.test.ts` bắt P9 chỉ gọi `old`, thiếu `new`. Static test tạm cũng fail nhưng không dùng làm bằng chứng chính. `node scripts/smoke-multi-session.cjs` với build baseline FAIL timeout 7500ms do không có periodic GET sau login.
- GREEN: `npx tsx --test server/test/pollingPolicy.test.ts` PASS 8/8; `npm run check` PASS; `npm run build` PASS; `npm test` PASS 114/114; `node scripts/smoke-multi-session.cjs` PASS, phiên bản final đợi network idle rồi hai GET liên tiếp; `git diff --check` PASS.
- Logs: `/tmp/web-cli-third-phase2-{red-unit,red-smoke,green-final-unit,green-final-check,green-build,green-full-test,green-smoke}.log`.


### Bổ sung sau review tích hợp: external fetch còn pending

- Phát hiện boolean `isFetchingListRef` vẫn có thể làm mất fetch mới nếu request cũ được `App`/handler gọi trực tiếp, ngoài scheduler. Chuyển sang ref `{authGeneration, promise}`: cùng generation dùng chung promise; khác generation chờ request cũ rồi gọi callback mới. Không chạy GET chồng nhau; timeout HTTP cũ vẫn là 15 giây.
- Test hook thật: `scripts/smoke-polling-lifecycle.cjs` bundle `useSessions` thật với ReactDOM/StrictMode, mock API; request ngoài scheduler giữ pending qua logout/re-login, sau đó phải có GET mới, restore active session và poll tiếp theo. Assert `maxInFlight === 1`.
- RED: `POLLING_TEST_SOURCE_ROOT=/tmp/web-cli-third-phase2-external-red node scripts/smoke-polling-lifecycle.cjs` với fixture đã có mutable refs nhưng chưa sửa boolean: FAIL chờ GET #3.
- GREEN: `node scripts/smoke-polling-lifecycle.cjs` PASS, 4 requests, không overlap. Logs `/tmp/web-cli-third-phase2-external-{red,green}.log`.
- CI bổ sung smoke này. Full check/build/test và smoke cuối bên dưới chạy sau sửa coalescing.

## Phase 3 — push

Hoàn tất. Browser regression dùng App thật trong React StrictMode, settings thật và API client thật; mock Firebase SDK, browser push services, HTTP responses và terminal renderer không thuộc scope fixture. Hai smoke nhiều phiên/mobile vẫn dùng terminal thật. Fixture không gửi dữ liệu tới Firebase.

- `git archive 4c8801b83ef8a003f1611f5f0cc534586e51d954 web/src` được giải nén ở `/tmp/web-cli-third-push-baseline`, không sửa source đang triển khai.
- RED: `PUSH_TEST_SOURCE_ROOT=/tmp/web-cli-third-push-baseline node scripts/smoke-push-lifecycle.cjs` FAIL theo assertion. F3.1/F3.2: UI hiện `Đã bật` ở hai bảng khi backend/SDK chưa được gọi; F3.4 vẫn hiện registered dù backend failure; F3.5 chỉ bảng được bấm chuyển registering. F3.3/F3.6 fail precondition backendRequests=0, chưa phải bằng chứng logout riêng.
- Log RED browser: `/tmp/web-cli-third-phase3-red-browser-final.log`. Lần sandbox đầu bị EPERM bind loopback; retry ngoài sandbox mới là assertion evidence.
- CI bổ sung `node scripts/smoke-push-lifecycle.cjs`, không cần credential thật hay dependency mới.

### Phase 3 — kết quả implementation và regression

- Files: `web/src/lib/push.ts`, `web/src/features/push/usePushLifecycle.ts`, `web/src/App.tsx`, `web/src/components/SessionManager.tsx`, `web/src/components/NotificationSettings.tsx`, `server/test/pushLifecycle.test.ts`, `scripts/smoke-push-lifecycle.cjs`, `.github/workflows/ci.yml`.
- Một owner tại App, `busyRef` khóa đồng bộ để hai settings click cùng tick không tạo hai operation; state/actions dùng chung. Silent refresh kiểm tra consent/permission nhưng chỉ báo registered sau backend success.
- Generation được capture trước await đầu tiên; cancellation hủy chờ ngay ở logout/auth expiry; guard sau từng await và trước side effect. Listener foreground chỉ gắn sau backend success; listener FID và deadline được dọn ở mọi lối ra. Timeout operation 20 giây bao phủ support/SW/SDK/backend, prompt quyền do người dùng quyết định không bị timeout tùy tiện.
- Logout bắt đầu invalidate, thành công xóa consent; logout thất bại khởi tạo lại owner. Unmount/StrictMode cleanup giữ consent. Stale unregister không xóa consent của generation mới.
- RED lowlevel: `PUSH_SOURCE_PATH=/tmp/web-cli-third-push-baseline.ts node --test-name-pattern='F3.3:' server/test/pushLifecycle.test.ts` dùng source từ `git show` baseline: FAIL 2/2 (support đang pending và backend POST đang pending sau logout đều trả `registered` thay vì `unregistered`). Log `/tmp/web-cli-third-phase3-red-lowlevel.log`.
- GREEN: `node server/test/pushLifecycle.test.ts` PASS 12/12; `npx tsx --test server/test/pushLifecycle.test.ts` PASS 12/12. Đã chạy cả `node --test server/test/pushLifecycle.test.ts` (Node báo cấp file), runner chuẩn tsx xác nhận đủ 12 case.
- Browser bản cuối: `PUSH_TEST_SOURCE_ROOT=/tmp/web-cli-third-push-baseline node scripts/smoke-push-lifecycle.cjs` FAIL đúng behavior baseline; cùng script với source mới PASS 6 scenario, gồm F3.1/F3.2 dùng chung state/listener, unmount một consumer, F3.3 logout trước khi HTTP logout hoàn tất, F3.4 backend failure, F3.5 click hai setting cùng tick, F3.6 logout failure recovery, F3.7 login/auth expiry. Logs `/tmp/web-cli-third-phase3-red-browser-complete.log`, `/tmp/web-cli-third-final-push-smoke.log`.
- Lần smoke đầu sau fix đã đạt assertion FCM nhưng fixture không có CSS làm xterm dev StrictMode báo lỗi dimensions; cô lập terminal renderer trong fixture FCM, giữ nguyên assertion lỗi trang, rồi chạy lại thành công. Không sửa xterm production để phục vụ fixture.

## Final integration — kết quả cuối

| Lệnh | Kết quả thực tế |
| --- | --- |
| `npm run check` | PASS |
| `npm test` | PASS **126/126**, 0 skipped/cancelled, khoảng 46 giây |
| `npm run build` | PASS server + web + Firebase worker |
| `git diff --check` | PASS |
| `node scripts/smoke-multi-session.cjs` | PASS; hai periodic GET sau login, nhiều phiên, draft isolation, controller/viewer, reload |
| `node scripts/smoke-mobile.cjs` | PASS; 5 viewport, touch scroll, reload, reconnect, desktop layout |
| `node scripts/smoke-push-lifecycle.cjs` | PASS 6 scenario (Firebase giả lập) |
| `node scripts/smoke-polling-lifecycle.cjs` | PASS; external pending request qua re-login, restore và poll, maxInFlight=1 |

Check/test/build logs: `/tmp/web-cli-third-final-{check,tests,build}.log`. Kết quả smoke multi-session/mobile cuối được ghi trong transcript tool (exit 0); không nhận log preflight làm bằng chứng build cuối. `git status --short`, `git diff --stat`, `git diff` đã được review; không đổi server auth policy, API/WebSocket protocol, kiểm soát thư mục làm việc, package/lockfile hay style.

## Giới hạn và vận hành

- Chưa gửi thông báo qua Firebase thật/thiết bị thật; lifecycle được kiểm chứng với SDK/browser/backend giả lập. Không yêu cầu credential trong CI.
- Đây là sửa frontend lifecycle; không khẳng định giải quyết race backend revoke và POST đăng ký đã được gửi trước logout. Giữ nguyên cơ chế revoke hiện có.
- Re-login có thể chờ request cũ đến timeout HTTP hiện có (15 giây), để bảo toàn giới hạn một GET đồng thời.
- Không triển khai/restart dịch vụ đang chạy; không commit/push. Thay đổi đang ở working tree để review. Không có migration dữ liệu; rollback bản build frontend về baseline nếu cần, không dùng lệnh reset trên thay đổi khác của người dùng.
- CI đã thêm hai smoke lifecycle mới; các lệnh tương ứng đã chạy local, chưa có run CI remote mới.
