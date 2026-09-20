# SUPERSEDED — Rà soát và kế hoạch quản lý nhiều phiên

> Không dùng file này để thực thi. Kế hoạch chuẩn duy nhất là [../MULTI_SESSION_MASTER_IMPLEMENTATION_PLAN.md](../MULTI_SESSION_MASTER_IMPLEMENTATION_PLAN.md).

Ngày: 20/09/2026. Trạng thái: bản kế hoạch để xem xét, chưa triển khai sửa ứng dụng.

Phạm vi đã xác nhận: hiện chỉ rà soát và lên kế hoạch. Yêu cầu Shift + ← và Firebase bên dưới là bổ sung vào kế hoạch, chưa phải yêu cầu triển khai. Phần mã thử làm trước khi làm rõ phạm vi đã được hoàn tác, gồm mã ứng dụng, khai báo dependency và lockfile; không commit, deploy hay restart dịch vụ. Các package đã tải trong `node_modules` là dữ liệu cài đặt cục bộ, không phải thay đổi mã được bàn giao.

Mục tiêu: nhiều phiên cùng/khác loại agent, cùng/khác thư mục hoạt động độc lập; người dùng nhận biết, chuyển và quản lý đúng phiên trên desktop, mobile và nhiều tab.

## 1. Kết luận từ logic hiện tại

Backend đã dùng UUID làm khóa phiên, tạo PTY và buffer riêng cho từng ID. `createSession()` không tìm phiên theo cặp agent/thư mục, không tái sử dụng và không kết thúc phiên cũ khi tạo phiên mới. WebSocket lọc output/state/exit theo session ID. Cả bốn tổ hợp dưới đây đều đi qua cơ chế này.

| Loại agent | Thư mục khởi tạo | Hành vi cần bảo đảm |
| --- | --- | --- |
| Giống nhau | Giống nhau | Mỗi lần tạo chủ động sinh phiên riêng; chuyển qua lại và dừng một phiên không tác động phiên khác |
| Giống nhau | Khác nhau | Mỗi phiên giữ đúng thư mục, terminal, bản nháp và ngữ cảnh thao tác |
| Khác nhau | Giống nhau | Mỗi agent có tiến trình và luồng terminal riêng trong cùng thư mục |
| Khác nhau | Khác nhau | Tách đúng cả ID phiên, loại agent và thư mục |

Thư mục ở đây là thư mục khởi tạo PTY. Lệnh `cd` bên trong shell không được backend theo dõi. Các phiên trong cùng thư mục vẫn làm việc trên cùng tập tin; tính độc lập của terminal không tạo ra bản sao mã nguồn.

Cấu hình đã đọc đặt `MAX_SESSIONS=3`, `MAX_WS_CONNECTIONS=8`, là giới hạn toàn dịch vụ. Giới hạn phiên đang chạy không phải giới hạn theo thư mục hoặc agent. Không có cơ sở từ mã controller để kết luận agent bên ngoài khóa thư mục hoặc dùng chung cuộc hội thoại.

Nguồn: [SessionManager](../../server/src/sessionManager.ts), [WebSocketBridge](../../server/src/websocket.ts), [cấu hình](../../server/src/config.ts).

## 2. Các vấn đề cần xử lý

Các mục sau là hành vi hoặc đường thực thi đọc được trong mã. Khi phụ thuộc thứ tự phản hồi hay điều kiện lỗi, điều kiện được nêu rõ; chưa khẳng định tất cả đã xảy ra trong sự cố người dùng báo.

| Mã / ưu tiên | Bằng chứng | Ảnh hưởng và hướng sửa |
| --- | --- | --- |
| F01 / P0 | `App.tsx:35` dùng `updateSession()` để vừa cập nhật dữ liệu vừa chọn phiên. Kill/restart ở dòng 117–118 gọi hàm này sau `await`. | Nếu thao tác với A chưa trả về, người dùng đóng bảng và chuyển sang B, phản hồi A có thể chọn lại A hoặc phiên restart của A. Tách cập nhật dữ liệu khỏi chọn phiên; ràng buộc kết quả theo ID và ngữ cảnh thao tác. |
| F02 / P0 | `TerminalPane.tsx:44,75,99` dùng một xterm, đóng kết nối khi đổi ID và reset mỗi lần kết nối mở. `sessionManager.ts:213` chỉ giữ đuôi chuỗi output; `websocket.ts:187` phát lại chuỗi đó. | Màn hình, chế độ terminal, lịch sử và vị trí cuộn không có bản lưu độc lập theo phiên. Khi phần thiết lập ANSI nằm ngoài buffer hoặc kích thước thay đổi, replay đuôi chuỗi không bảo đảm tái dựng đúng CLI tương tác. Cần cơ chế giữ/khôi phục trạng thái terminal và đồng bộ output có thứ tự. |
| F03 / P0 | `sessionManager.ts:131` restart bằng `await stopAndWait()` rồi `createSession()`, không có khóa theo phiên hoặc mã chống xử lý lặp. API create cũng không có mã này. | Hai request restart cùng A có thể tạo hai phiên thay thế nếu còn slot. Create/restart đã thành công nhưng mất phản hồi, rồi người dùng thử lại, có thể tạo thêm PTY. Khóa thao tác theo ID, chống xử lý lặp và bảo toàn slot khi restart. |
| F04 / P1 | `App.tsx:11,36,46` dùng chung khóa `localStorage` cho phiên cuối. | Tab A đang xem X, tab B chọn Y, reload A sẽ đọc Y. Lưu lựa chọn theo từng tab; đồng bộ danh sách không đồng nghĩa đồng bộ phiên đang chọn. |
| F05 / P1 | `App.tsx:40,92,117` chỉ tải danh sách ở một số thao tác; WebSocket chỉ gửi state của phiên được attach. `setSessions()` thay cả danh sách từ phản hồi. | Phiên nền tự kết thúc hoặc được tạo/dừng ở tab khác có thể hiển thị cũ. Phản hồi danh sách đến muộn có thể ghi đè dữ liệu vừa cập nhật. Cần đồng bộ danh sách có kiểm soát thứ tự; tránh tự đổi lựa chọn và thứ tự dòng khi nhận state. |
| F06 / P1 | `index.ts:203` giữ `projectId` của root, đưa subpath vào label; `PublicSession` không có trường subpath hoặc danh tính thư mục thực riêng. | Các thư mục con cùng root có chung project ID; frontend không có đủ dữ liệu có cấu trúc để nhóm thư mục và điền lại form chính xác. Giữ root ID, bổ sung danh tính thư mục chuẩn hóa và đường dẫn tương đối; không dùng label làm khóa. |
| F07 / P1 | `ProjectSelector.tsx:32` không bỏ qua phản hồi duyệt thư mục cũ; nút chọn thư mục ở dòng 169 vẫn bật trong lúc tải. | Request cũ về sau có thể kéo trình duyệt thư mục trở lại; người dùng có thể chọn thư mục cũ khi thư mục mới đang tải. Hủy/bỏ qua request lỗi thời và chỉ cho xác nhận trạng thái tải đã hoàn tất. |
| F08 / P1 | `api.ts:22` chuyển lỗi thành `Error(message)`, mất status/code. `TerminalPane.tsx:115` retry mọi lần đóng trừ auth-expired; catch lỗi ticket cũng retry. | Phiên đã bị xóa trả 404 vẫn bị nối lại liên tục; lỗi hết chỗ dễ bị hiểu như lỗi phiên hiện tại. Giữ mã lỗi, phân biệt lỗi vĩnh viễn và tạm thời, trả trạng thái khôi phục phù hợp. |
| F09 / P1 | `killSession()` chỉ gọi `requestStop()`; watchdog của `stopAndWait()` chỉ dùng khi restart/shutdown. `sweep()` chỉ xử lý idle khi state là running. | PTY không thoát sau tín hiệu dừng có thể kẹt ở stopping và giữ slot. Cần deadline dừng, xác nhận exit và xử lý quá hạn thống nhất, đồng thời kiểm tra tiến trình con của agent. |
| F10 / P1 | `websocket.ts:226` cho mọi kết nối hợp lệ của một phiên gửi input/resize. | Hai thiết bị cùng attach một ID có thể trộn lệnh hoặc liên tục đổi kích thước PTY. Tách việc xem và quyền điều khiển; server quyết định kết nối nào được input/resize. Điều này độc lập với việc có nhiều session trong một thư mục. |
| F11 / P1 | UI ở `App.tsx:91,96` gộp các state khác running thành đã kết thúc/đã dừng; form tạo và thao tác hiện tại ở chung dialog. | Đang dừng và lỗi khởi chạy bị hiển thị như đã kết thúc; banner lỗi dùng chung thiếu ngữ cảnh phiên. Dễ nhầm chọn agent/thư mục với chuyển phiên. Tách luồng và thông báo đúng state, hiển thị nguyên nhân lỗi của từng phiên. |

Các điểm vòng đời/tài nguyên phải xử lý cùng đợt:

- `sweep()` xóa phiên hết thời gian lưu mà không phát sự kiện xóa hoặc đóng socket của phiên; UI cần biết phiên đã hết hạn thay vì retry mãi.
- Idle TTL dựa trên input/output/resize, không dựa trên việc người dùng đang xem. Phải công bố rõ chính sách và trả lý do kết thúc; không suy diễn running thành “agent đang suy nghĩ” hoặc “đang chờ xác nhận”.
- Giới hạn đang áp dụng cho PTY hoạt động; số bản ghi exited/error chỉ giới hạn bằng thời gian lưu. Bổ sung giới hạn số bản ghi lưu và tổng bộ nhớ output khi có nhiều lần tạo/dừng.
- `index.ts:301` chờ đóng WebSocket rồi mới đóng PTY, trong khi deadline chung đã chạy. Cần chặn tạo mới ngay khi shutdown bắt đầu và chia thời hạn cho các bước để client chậm không làm mất thời gian dừng PTY.
- Session và output nằm trong RAM. Restart backend kết thúc vòng đời phiên; lưu metadata xuống đĩa đơn thuần không giữ được tiến trình PTY.

## 3. Mô hình quản lý đề xuất

Một session luôn là một thực thể độc lập theo `sessionId`. Agent là loại chương trình; thư mục là nơi khởi chạy; cả hai chỉ dùng để nhóm/lọc. Không tạo ràng buộc duy nhất theo `agentId + folder`.

| Thành phần | Trách nhiệm |
| --- | --- |
| Server session | ID, agent, thư mục khởi tạo chuẩn hóa, tên hiển thị, trạng thái tiến trình, revision, thời điểm, lý do kết thúc và liên kết phiên restart |
| Danh sách phía client | `sessionsById` là dữ liệu phiên; cập nhật theo revision/request generation để phản hồi cũ không ghi đè trạng thái mới |
| Lựa chọn trong tab | `activeSessionId` riêng cho mỗi tab, độc lập với cập nhật dữ liệu và bộ lọc danh sách |
| Kết nối terminal | Mang `sessionId`, thế hệ attach và trạng thái đồng bộ; chỉ cho input khi khớp phiên đang chọn và đã sẵn sàng |
| Trạng thái soạn/thao tác | Bản nháp, lỗi, tác vụ chờ và thông tin cuộn theo ID; dữ liệu form tạo mới được tách riêng |

Quy tắc cụ thể:

1. “Tạo mới” luôn tạo PTY mới. “Mở phiên” chỉ attach ID có sẵn. “Nối lại” không tạo PTY. “Khởi động lại” kết thúc phiên đích rồi tạo tối đa một phiên thay thế.
2. Phiên được đổi chỉ bởi hành động điều hướng của người dùng hoặc kết quả tạo/restart còn đúng ngữ cảnh. Dữ liệu nền và phản hồi muộn không được tự chọn phiên.
3. Khi bắt đầu chuyển phiên, chặn input ngay; callback/kết quả thuộc lần attach cũ không được thay đổi kết nối, trạng thái hoặc terminal mới. Giữ các kiểm tra `stopped`/socket identity đã có, bổ sung kiểm tra ở đường gửi lệnh và kết quả REST.
4. Tên và `subpath` là metadata; backend vẫn tự resolve/realpath và kiểm tra allowlist. Thư mục đã bị xóa/thay đổi hoặc subpath trỏ tới tập tin phải trả lỗi rõ trước spawn.
5. Giữ draft trong bộ nhớ theo phiên như hiện tại. Chuyển phiên giữ draft; không mặc định lưu nội dung terminal/prompt vào localStorage để giữ qua reload.
6. Phiên đăng nhập và phiên terminal là hai vòng đời khác nhau. Logout thu hồi API/socket; UI phải mô tả rõ PTY nền tiếp tục chịu chính sách dừng/idle hiện có. Không tự kết thúc toàn bộ tác vụ chỉ vì đóng tab.

## 4. Thiết kế kết nối và khôi phục terminal

- Duy trì trạng thái hiển thị/scroll theo ID với giới hạn cache. Chỉ attach luồng terminal đang xem; không mặc định giữ một socket cho mọi phiên trong mọi tab.
- Bổ sung thứ tự output và điểm đồng bộ. Resume tiếp phần còn thiếu khi dữ liệu vẫn trong cửa sổ lưu; nếu mất đoạn, đồng bộ lại bằng snapshot terminal hợp lệ, gồm chế độ và kích thước cần thiết. Không coi đuôi chuỗi ANSI tùy ý là snapshot.
- Cache phía client chỉ là tối ưu; server phải có cơ chế phục hồi khi tab reload hoặc cache không còn. Chốt cách tạo snapshot trong phần thiết kế kỹ thuật trước khi sửa đường replay.
- Hoàn tất đồng bộ đúng phiên rồi mới bật nhập lệnh. Không tự phát lại input khi reconnect vì lệnh có thể đã chạy; trường hợp chưa xác định phải báo rõ.
- Danh sách lấy snapshot khi load, sau thao tác và khi kết nối trở lại. Giai đoạn đầu có thể refresh tối đa mỗi 2 giây khi tab hiển thị, chỉ một request đang chờ, dừng polling khi hidden/offline; lỗi mạng có backoff. Đây là dữ liệu trạng thái nhỏ, không truyền output của mọi phiên.
- Quyền điều khiển cùng một ID được cấp cho một kết nối tại một thời điểm; kết nối khác xem output và có nút “Nhận điều khiển”. Lease có hạn, thu hồi khi mất quyền đăng nhập; input/resize được enforce ở backend.

## 5. UI/UX đề xuất

Desktop dùng danh sách phiên bên trái và terminal chính bên phải. Mobile giữ terminal là vùng chính, tên phiên hiện tại luôn nhìn thấy; nút “Phiên” mở bảng chuyển phiên. Cài đặt tài khoản/cỡ chữ tách khỏi thao tác tạo và quản lý phiên.

Danh sách phiên:

- Nhóm theo thư mục khởi tạo đầy đủ trong root được phép; mỗi dòng có tên phiên, loại agent, trạng thái tiến trình và ID rút gọn để phân biệt.
- Thứ tự ổn định; chọn phiên hoặc nhận state không làm cả danh sách nhảy vị trí. Có tìm kiếm/lọc agent, thư mục và trạng thái; phiên đã kết thúc nằm trong nhóm riêng.
- Hiển thị số phiên hoạt động/giới hạn do API trả về, không hardcode số 3. Khi hết chỗ, chỉ thao tác tạo mới bị chặn; các phiên đang chạy tiếp tục dùng bình thường.
- Các thao tác trên đúng dòng: mở, đổi tên, nối lại, khởi động lại, kết thúc. “Ẩn khỏi danh sách” nếu bổ sung phải được phân biệt với kết thúc PTY.

Tạo mới theo thứ tự: chọn thư mục → chọn agent → tên tùy chọn → kiểm tra thông tin → tạo. Có lối tắt “Thêm phiên trong thư mục này”. Việc duyệt folder không đổi terminal hiện tại; form giữ nguyên khi tạo thất bại.

Hiển thị hai nhóm trạng thái riêng: tiến trình (đang chạy/đang dừng/đã kết thúc/lỗi khởi chạy) và kết nối (đang kết nối/đồng bộ/đã kết nối/mất mạng/phiên không còn). Xác nhận dừng/restart phải ghi đúng tên, agent và thư mục của phiên đích. Nút tối thiểu 44px, dùng bàn phím được, trả focus sau khi đóng bảng; tên/đường dẫn dài không tràn màn hình.

## 6. Backlog theo thứ tự thực hiện

Đây là thứ tự đề xuất, chưa gán thời lượng hoặc đưa vào sprint. PM/BA chốt quy tắc từ ma trận; BE/FE/QC triển khai và kiểm chứng theo từng phần có kết quả quan sát được.

| Phần | Owner / reviewer | Phạm vi và điều kiện hoàn tất |
| --- | --- | --- |
| A — Chuyển đúng phiên, mọi tổ hợp (P0) | FE + BE / QC | Chuẩn hóa metadata thư mục, tách lựa chọn/dữ liệu/form, bảo vệ phản hồi muộn và lựa chọn theo tab. Cả bốn tổ hợp tạo/chuyển được; kill A đang chờ không kéo người dùng khỏi B. |
| B — Terminal ổn định khi chuyển/reconnect (P0) | FE + BE / QC | Thiết kế và thực hiện snapshot/resume, giữ draft/scroll, gate input theo ID và thế hệ attach. A → B → A, reload và mất mạng không trộn output hoặc gửi sai lệnh. |
| C — Tạo/dừng/restart đáng tin cậy (P0/P1) | BE + FE / QC | Idempotency có TTL/giới hạn bộ nhớ; khóa restart theo ID, giữ slot; deadline dừng; lỗi có code/status. Hai request restart cùng phiên không sinh hai phiên thay thế; retry create không nhân đôi tác vụ. |
| D — Màn hình quản lý và nhiều tab/thiết bị (P1) | FE/UX + BE / QC | Danh sách theo thư mục, tên phiên, trạng thái nền, form tạo riêng, capacity UI và quyền điều khiển. Tab giữ lựa chọn riêng; một phiên đang xem từ hai thiết bị không bị tranh input/resize. |
| E — Vận hành và phát hành (P1) | BE/SRE / QC | Retention, tổng buffer, idle reason, shutdown, telemetry chỉ metadata; regression và hướng dẫn sử dụng. Kiểm tra rollout/rollback và tác động tới phiên đang chạy. |

Phụ thuộc: A xác lập identity/metadata cho B và D; C dùng cùng identity và error contract; E kiểm chứng toàn bộ. Không chỉ đổi layout rồi coi tính độc lập của nhiều phiên đã được giải quyết.

Đề xuất thay đổi API giữ tương thích: bổ sung metadata và revision cho session; trả capacity trong danh sách; nhận mã thao tác cho create/restart; endpoint đổi tên; protocol attach/resume/control có version. Bổ sung trường mới trước, chuyển frontend sau; client cũ cần fallback được xác định rõ trong rollout.

## 7. Ma trận kiểm chứng và tiêu chí nghiệm thu

| Nhóm | Ca kiểm tra | Kết quả bắt buộc |
| --- | --- | --- |
| M01–M04 | Bốn tổ hợp agent/thư mục ở mục 1 | UUID và output riêng; đúng thư mục khởi tạo; gửi/dừng/restart A không chạm B |
| M05 | Ba phiên trộn agent/thư mục; tạo thêm khi đầy | Tất cả phiên cũ tiếp tục hoạt động; lỗi capacity rõ; dừng một phiên trả lại đúng một slot |
| M06 | Chuyển A → B → A nhanh trong lúc output dày và nhận phản hồi REST trễ | Không đổi lựa chọn ngoài ý muốn; không lẫn state/output/draft, không gửi input sang ID cũ |
| M07 | Hai tab chọn hai ID khác nhau rồi reload từng tab | Mỗi tab khôi phục ID của mình; không spawn thêm PTY |
| M08 | Hai client cùng attach một ID, kích thước khác nhau | Chỉ client điều khiển được gửi input/resize; client xem không giành kích thước PTY |
| M09 | Hai restart đồng thời; retry create sau mất phản hồi; create cạnh tranh với restart khi gần đầy | Một thao tác logic chỉ có một kết quả; không nhân đôi PTY, không vượt cap; restart không mất slot do request khác |
| M10 | Mất mạng, reconnect, output vượt cửa sổ buffer, ANSI/alternate screen và đổi kích thước | Khôi phục terminal theo protocol; không phát lại lệnh; chỉ bật input sau đồng bộ |
| M11 | Agent không chạy được, PTY dừng chậm, idle timeout, hết retention hoặc thư mục biến mất | State và lý do đúng; có deadline/recovery; không kẹt slot hoặc retry 404 vô hạn |
| M12 | Phiên nền kết thúc hoặc bị dừng/tạo ở tab khác | Danh sách hội tụ sau refresh thành công; khi mạng tốt sai lệch không quá chu kỳ 2 giây cộng độ trễ request |
| M13 | Browser folder có phản hồi đảo thứ tự; chọn folder khi request đang chạy | Chỉ request mới nhất được áp dụng, không xác nhận nhầm thư mục cũ |
| M14 | Logout/auth-expired trong lúc attach/create; ticket sai ID/replay; đường dẫn ngoài allowlist | Không gắn lại phiên sau mất quyền; giữ các kiểm tra auth/origin/ticket/path hiện có |
| M15 | Tạo/dừng nhiều lần, nhiều client chậm, shutdown có PTY đang chạy | Số PTY/socket/listener/buffer nằm trong giới hạn; dừng theo deadline; không nhận create mới khi shutdown |
| M16 | Mobile 360px, màn hình ngang, bàn phím ảo, desktop và thao tác keyboard | Không tràn/che thao tác chính; phiên đích luôn rõ; focus và scroll phù hợp |

Kiểm thử theo tầng: unit cho state/reducer và lifecycle; integration cho API/PTY/WebSocket/concurrency; browser regression cho lựa chọn tab, phản hồi chậm, reconnect và UI. Dùng chương trình terminal kiểm thử xác định trước để kiểm chứng cả output văn bản lẫn ANSI; kiểm tra tương thích agent thật trước phát hành phần khôi phục terminal, không lấy việc chờ tái hiện thủ công làm điều kiện để bắt đầu sửa lỗi logic đã biết.

## 8. Vận hành, phạm vi và bằng chứng hiện tại

Giữ giới hạn PTY/socket hiện tại trong bước sửa; chỉ tăng sau khi đo CPU/RAM và hành vi client chậm. Dữ liệu socket có backpressure, snapshot/output có ngân sách bộ nhớ; polling không chồng request. Không log prompt/output/token và không tự sao chép thư mục credential để giả lập “cách ly agent”. Bộ điều khiển hiện phục vụ một chủ máy; kế hoạch này không mở rộng sang phân quyền nhiều người dùng.

Không hứa giữ PTY qua restart backend. Trước triển khai phải xác định phiên còn chạy, thời điểm dừng, bản build/cấu hình để rollback và kiểm tra health sau phát hành. Khi có thao tác cấu hình/khởi động dịch vụ, kiểm kê port trước, giữ bind loopback, kiểm tra port/tiến trình/health bằng retry ngắn sau restart. Chưa nhân bản backend thành nhiều worker vì registry PTY nằm trong bộ nhớ một process.

Worktree tách file, lưu lịch sử hội thoại dài hạn, resume hội thoại đặc thù từng CLI và giữ tiến trình qua reboot là phần mở rộng riêng; không cần đưa vào để sửa tính độc lập của phiên trong controller.

Bằng chứng kiểm tra ngày 20/09/2026:

- Đã đọc luồng create/list/kill/restart, metadata folder, PTY/event/buffer/cleanup, WS attach/ticket/retry, state UI/draft/tab, browser folder, xác thực và các test hiện có.
- `npm test`: 11/11 đạt. Lần chạy trong sandbox bị chặn IPC của tsx; chạy lại với quyền được cấp đã hoàn tất.
- `npm run check`: đạt typecheck server và web.
- `git diff --check`: đạt; tài liệu mới được kiểm tra whitespace riêng vì chưa được Git theo dõi.
- Kiểm tra ở lượt trước: hai shell cùng agent/cwd có ID/output riêng, dừng B không làm A dừng. Đây là bằng chứng ở tầng SessionManager, không đại diện cho toàn bộ ma trận hoặc UI agent thật.
- Test hiện có của SessionManager kiểm tra môi trường child và cap/shutdown; smoke browser chủ yếu một PTY và nhiều thiết bị attach cùng PTY. Chưa có regression cho M01–M04, chuyển nhiều ID, restart đồng thời và khôi phục terminal sau buffer bị cắt.
- Lượt này chỉ bổ sung tài liệu kế hoạch; không sửa mã chạy, không restart/deploy dịch vụ. Working tree đã có thay đổi từ trước và được giữ nguyên.

## 9. Bổ sung: Shift + ← và Firebase Cloud Messaging

### Kết quả mong muốn

- Khi đang xem phiên Codex, có nút Shift + ← dễ bấm trên mobile. Nút gửi đúng tổ hợp phím vào phiên hiện tại, giữ nguyên nội dung đang soạn; không tự gửi câu trả lời hay duyệt yêu cầu.
- Khi agent có yêu cầu xác nhận/câu hỏi cần người dùng phản hồi, thông báo ghi đúng phiên. Người dùng đang ở phiên khác không bị tự chuyển terminal.
- Dùng Firebase Cloud Messaging (FCM) để nhận thông báo cả khi đóng trang. Bấm thông báo mở đúng phiên, kể cả phải đi qua bước đăng nhập Hub và 2FA. Nếu phiên không còn, báo rõ, không tạo phiên thay thế.

### Hướng kỹ thuật cần chốt trước triển khai

Luồng dự kiến: **tín hiệu từ CLI → backend gắn session ID → hàng đợi thông báo → FCM → service worker/trang đang mở → người dùng chọn mở phiên**.

1. **Phím tắt:** điều kiện hiển thị dựa trên agent của phiên đang mở, không dựa trên form tạo phiên. Xterm đang dùng mã `ESC [ 1 ; 2 D` cho Shift + ←. Vô hiệu hóa khi đang chuyển phiên, mất kết nối hoặc phiên đã dừng; kiểm chứng mã tới đúng PTY và draft không bị gửi kèm.
2. **Nguồn sự kiện:** lấy từ backend để vẫn hoạt động khi không có tab Web CLI. Codex hỗ trợ bộ lọc `tui.notifications`, phương thức `osc9` và điều kiện `always`; `notify` bên ngoài hiện chỉ hỗ trợ hoàn tất lượt, nên không dùng nó làm tín hiệu duyệt. Cần một bước kiểm chứng tương thích phiên bản CLI cho cả approval và câu hỏi; chỉ cấu hình theo lần khởi chạy, không sửa cấu hình Codex global. [Tài liệu cấu hình Codex](https://developers.openai.com/codex/config-advanced/).
3. **Các agent khác:** cần adapter/tín hiệu tương ứng cho từng CLI và công bố trạng thái hỗ trợ. Tính độc lập của nhiều loại phiên vẫn nằm trong phạm vi sửa chính; không đồng nghĩa tất cả CLI đã có cùng giao thức thông báo. Không dùng regex đọc chữ “confirm” trong output làm bằng chứng chắc chắn.
4. **Đăng ký thiết bị:** người dùng chủ động bật/tắt, quyền trình duyệt chỉ xin khi bấm nút. API đăng ký/xóa/gửi thử dùng xác thực và kiểm tra origin hiện có. Lưu registration bền vững ngoài thư mục public, có TTL và giới hạn thiết bị; xử lý đăng ký đổi ID, thiết bị hết hiệu lực và thu hồi khi logout/đổi mật khẩu. Chốt quy tắc: hết phiên đăng nhập không làm mất push nền đã bật; mở nội dung vẫn phải đăng nhập lại.
5. **Phân phối:** định danh sự kiện để hạn chế trùng; hàng đợi có giới hạn, TTL, retry hữu hạn và theo dõi lỗi. Không chặn luồng PTY khi Firebase chậm. Chốt drain/checkpoint và mức bảo đảm mất thông báo khi backend restart trước phát hành. Mô hình hiện tại là một backend giữ PTY; chưa nhân bản nhiều worker khi chưa có định tuyến phiên và hàng đợi dùng chung.
6. **Service worker:** bundle SDK tại ứng dụng; có route worker ổn định, không bị redirect sang login khi cập nhật nền. Chỉ public đúng worker/manifest/icon; API đăng ký và terminal vẫn yêu cầu đăng nhập. CSP chỉ mở thêm các endpoint Firebase cần thiết. Dùng thông báo chung, không đưa prompt, lệnh, đường dẫn dự án hay secret lên màn hình khóa.
7. **UI:** trong bảng quản lý có trạng thái chưa cấu hình/đã bật/bị chặn/lỗi, nút bật/tắt và gửi thử. Khi trang đang mở, hiện nhắc có thể bấm để chọn phiên; khi trang đã đóng, service worker hiển thị thông báo hệ điều hành. Tách trạng thái “đang chạy” của PTY khỏi trạng thái “cần phản hồi”. [Cách nhận FCM trên web](https://firebase.google.com/docs/cloud-messaging/web/receive-messages).

Điều kiện nền tảng: HTTPS và trình duyệt hỗ trợ Push API. Trên iPhone/iPad, cần thêm ứng dụng vào Màn hình chính và mở từ đó để dùng web push. Đóng tab nằm trong tiêu chí nghiệm thu; độ trễ khi mất mạng, hệ điều hành chặn thông báo hoặc trình duyệt bị force-stop không thể cam kết tức thời. [Thiết lập FCM Web](https://firebase.google.com/docs/cloud-messaging/web/get-started), [Web Push trên iOS/iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

### Cấu hình bạn cần chuẩn bị

Các tên biến dưới đây là đề xuất, chưa được thêm vào cấu hình ứng dụng.

| Thông tin | Nguồn / cách dùng dự kiến |
| --- | --- |
| Firebase project và Web App | Tạo/chọn project, đăng ký một ứng dụng Web trong Firebase Console |
| `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID` | Lấy từ Firebase Web config; backend cung cấp phần cấu hình công khai cho trình duyệt |
| `FIREBASE_VAPID_PUBLIC_KEY` | Project settings → Cloud Messaging → Web Push certificates → Generate key pair; dùng public key |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | Đường dẫn tới JSON service account có quyền gửi FCM, đặt riêng trên máy chủ, quyền đọc hạn chế; không gửi private key trong chat hay commit vào repo |
| Domain HTTPS của Web CLI | Dùng để kiểm tra quyền thông báo, scope service worker, CSP và luồng mở lại sau đăng nhập |
| `FCM_DATA_DIR`, `FCM_ENABLED` | Thư mục lưu đăng ký thiết bị ngoài bản release; cờ bật/tắt độc lập, mặc định tắt khi chưa cấu hình |

Bật Cloud Messaging API/FCM Registration API phù hợp trong đúng project. Không cần thêm Firestore hoặc thay hệ đăng nhập hiện có bằng Firebase Authentication chỉ để gửi push. Cần rà soát script deploy hiện ghi lại file env để cấu hình Firebase không bị mất trong lần cập nhật sau. [Firebase Web setup](https://firebase.google.com/docs/cloud-messaging/web/get-started), [Firebase Admin setup](https://firebase.google.com/docs/admin/setup).

### Thứ tự bổ sung vào backlog

| Phần | Phụ thuộc | Tiêu chí nghiệm thu chính |
| --- | --- | --- |
| F — Phím tắt Codex | A/B: xác định và điều khiển đúng phiên | Chỉ hiện ở Codex; gửi chính xác Shift + ←; không gửi/xóa draft; không gửi trong lúc chuyển phiên |
| G — Sự kiện cần phản hồi và FCM | A: identity; kiểm chứng sự kiện CLI; cấu hình Firebase | Phiên nền phát tín hiệu khi không có WebSocket; dedupe/retry/giới hạn có kiểm thử; secrets không vào API, log hoặc child env |
| H — UX thông báo và mở đúng phiên | D/G; auth Hub và Web CLI | Bật/tắt/gửi thử rõ ràng; foreground không tự đổi phiên; đóng trang vẫn nhận; click qua login về đúng ID; báo đúng khi phiên hết hạn |

Ưu tiên đề xuất: xử lý độc lập phiên và terminal A–C trước; thiết kế UI D cùng phím tắt F; sau đó G/H; cuối cùng kiểm chứng vận hành E. Có thể chuẩn bị Firebase trong lúc xem kế hoạch, chưa cần khóa để chốt thiết kế.

Ma trận bổ sung: hai Codex cùng thư mục cùng chờ phản hồi; Codex ở thư mục khác; phiên khác loại không phát nhầm; người dùng đang xem B khi A cần duyệt; không mở tab nào; nhiều tab/multiple devices; logout/đổi mật khẩu; quyền bị chặn; registration hết hiệu lực; Firebase lỗi/timeout/queue đầy; click thông báo lặp hoặc đã cũ; mobile và luồng đăng nhập hai lớp. Push thật qua Firebase chưa được kiểm chứng do chưa có cấu hình project.
