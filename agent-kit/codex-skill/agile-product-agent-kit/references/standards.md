# Standards

## Product Management

- Mỗi initiative phải có problem statement, target user, product outcome và metric.
- Roadmap ưu tiên theo outcome, impact, confidence, effort, risk và dependency.
- MVP phải có non-goals để tránh scope creep.
- Release phải có giả thuyết đo lường và plan học từ dữ liệu.

## Business Analysis

- Requirement phải testable.
- User story theo INVEST.
- Acceptance criteria theo Given/When/Then khi phù hợp.
- Business rule phải tách khỏi UI detail và technical implementation.
- Luôn ghi edge case, permission, data requirement và dependency.

## Architecture

- Thiết kế phải có goals, non-goals, alternatives, trade-off và risk.
- NFR phải có target đo được.
- API/event/data contract phải rõ versioning và compatibility.
- Async workflow phải có timeout, retry, idempotency, dead-letter, backpressure và graceful shutdown.
- Mọi thay đổi production phải có rollout, rollback và observability.

## Backend

- Validate input ở server.
- Authorization theo resource/action/tenant.
- External IO có timeout.
- Query và migration phải được review performance.
- Transaction boundary rõ.
- Không log PII/secret.
- Test cover happy path, failure path, permission và boundary quan trọng.

## Frontend

- UI phải có loading, empty, error, permission denied và success state.
- Responsive, accessible, keyboard friendly.
- Không lưu secret ở client.
- Xử lý API error rõ, không lộ thông tin nhạy cảm.
- Tối ưu render, bundle, asset và dữ liệu lớn theo mức cần thiết.

## Quality Engineering

- Test theo risk, không chỉ theo màn hình.
- Traceability từ AC đến test case.
- Regression scope dựa trên impact analysis.
- Bug report phải có reproduce steps, expected, actual, impact và evidence.
- Release quality summary phải nêu residual risk.

## DevOps/SRE

- CI/CD có build, test, scan và artifact version.
- Deploy có health check, readiness/liveness và rollback.
- SLO, dashboard, alert phải action được.
- Secret/config quản lý an toàn.
- Incident có runbook và postmortem action.

## Security

- Threat model cho feature rủi ro cao.
- Data classification cho PII/secret/regulatory data.
- Least privilege.
- Defense against injection, XSS, CSRF, SSRF, IDOR, replay và abuse case.
- Audit cho hành động nhạy cảm.

## Agile Delivery

- Sprint goal phải rõ.
- Không đưa story chưa ready vào sprint.
- WIP giới hạn theo năng lực review/test.
- Velocity không dùng để ép cam kết.
- Retro action có owner, due date và theo dõi tới khi đóng.

