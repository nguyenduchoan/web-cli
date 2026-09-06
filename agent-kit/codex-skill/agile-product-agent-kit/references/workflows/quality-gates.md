# Workflow: Quality Gates

Quality gate là điểm kiểm soát để ngăn lỗi lan sang bước sau.

## Gate 1: Discovery Ready

- Problem statement rõ.
- User/persona rõ.
- Business outcome rõ.
- Metric thành công và guardrail metric rõ.
- MVP và non-goals rõ.
- Rủi ro lớn đã được ghi nhận.

## Gate 2: Backlog Ready

- Story theo INVEST.
- Acceptance criteria pass/fail được.
- Business rule, permission, data, edge case rõ.
- Dependency rõ.
- Estimate đủ tin cậy.
- QC có thể tạo test case.

## Gate 3: Design Ready

- Architecture/data/API/event flow rõ.
- NFR có target và cách kiểm chứng.
- Security review theo mức rủi ro.
- Performance và scale đã cân nhắc.
- Observability đủ.
- Migration, rollout, rollback rõ.

## Gate 4: Code Ready For Test

- Code build được.
- Unit/integration test phù hợp đã chạy.
- Feature flag/config nếu cần đã có.
- Log/metric/error handling đủ.
- Không hard-code secret.
- Không phát sinh breaking change ngoài scope.

## Gate 5: Release Ready

- Acceptance criteria chính pass.
- Regression pass theo scope.
- Defect blocker/critical không còn mở.
- Rollout và rollback đã chuẩn bị.
- Dashboard/alert sẵn sàng.
- Support/runbook rõ.
- Product owner hoặc người được ủy quyền chấp nhận release risk.

## Gate 6: Production Verified

- Deploy version đúng.
- Health check ổn định.
- Error rate, latency, saturation trong ngưỡng.
- Không có spike bất thường ở log/alert.
- Business metric hoặc event tracking hoạt động.
- Có kết luận tiếp tục rollout, pause hoặc rollback.

