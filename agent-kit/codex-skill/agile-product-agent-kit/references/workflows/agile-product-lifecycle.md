# Workflow: Agile Product Lifecycle

Workflow này dùng cho sản phẩm mới hoặc feature lớn cần đi qua discovery, delivery và vận hành production.

## 1. Product Discovery

Owner chính: Product Manager  
Reviewer: BA, UX/UI, Data Analyst

Artifact bắt buộc:

- Product brief.
- Problem statement.
- Persona hoặc customer segment.
- Metric thành công.
- MVP scope và non-goals.

Exit criteria:

- Có vấn đề thật cần giải quyết.
- Có outcome đo được.
- Có phạm vi đủ nhỏ để validate.
- Có giả định rủi ro cần kiểm chứng.

## 2. Requirement Refinement

Owner chính: Business Analyst  
Reviewer: PM, QC, UX/UI, SA

Artifact bắt buộc:

- User story.
- Acceptance criteria.
- Business rules.
- Edge cases.
- Traceability từ objective đến test.

Exit criteria:

- Story đạt Definition of Ready.
- Acceptance criteria có thể kiểm thử.
- Dependency và assumption rõ.
- UX state, permission, data requirement đã xác nhận.

## 3. Solution Design

Owner chính: Solution Architect  
Reviewer: BE, FE, DevOps/SRE, Security Reviewer, QC

Artifact bắt buộc:

- Solution design.
- API/event contract nếu có.
- Data design nếu có.
- NFR và risk.
- Rollout/rollback strategy.

Exit criteria:

- Thiết kế đủ để triển khai mà không phải đoán.
- Security, scale, reliability và observability đã review.
- Migration/backward compatibility đã rõ.
- Async/background workflow có cơ chế an toàn.

## 4. Sprint Planning / Commitment

Owner chính: Scrum Master  
Reviewer: PM, Tech Lead, QC

Artifact bắt buộc:

- Sprint goal.
- Sprint backlog.
- Capacity.
- Dependency và risk.

Exit criteria:

- Story trong sprint đều ready.
- Capacity thực tế đủ.
- Owner rõ.
- Risk có mitigation.

## 5. Implementation

Owner chính: BE/FE  
Reviewer: SA, QC, Security Reviewer khi cần

Artifact bắt buộc:

- Implementation plan.
- Code change.
- Test evidence.
- Migration notes nếu có.

Exit criteria:

- Code pass local/CI quality gate.
- Test phù hợp với mức rủi ro.
- Không phá backward compatibility.
- Observability và error handling đủ vận hành.

## 6. Quality Validation

Owner chính: QC  
Reviewer: PM, BA, BE, FE

Artifact bắt buộc:

- Test plan.
- Test case result.
- Bug report nếu fail.
- Regression summary.

Exit criteria:

- AC quan trọng đều có evidence.
- Defect blocker/critical đã xử lý hoặc có risk acceptance rõ.
- Regression scope hợp lý.
- Release risk được nêu minh bạch.

## 7. Release

Owner chính: DevOps/SRE  
Reviewer: PM, SA, QC, Security Reviewer khi cần

Artifact bắt buộc:

- Release plan.
- Rollout plan.
- Rollback plan.
- Monitoring/alert.

Exit criteria:

- Deploy plan đã dry-run hoặc kiểm chứng theo mức rủi ro.
- Dashboard/alert sẵn sàng.
- Owner trực release rõ.
- Rollback path rõ và có dữ liệu để quyết định rollback.

## 8. Measure & Learn

Owner chính: PM, Data Analyst  
Reviewer: BA, UX/UI, Engineering

Artifact bắt buộc:

- Metric readout.
- User feedback.
- Incident/defect learnings.
- Backlog adjustment.

Exit criteria:

- So sánh kết quả với success metric.
- Quyết định tiếp theo rõ: iterate, scale, pause, rollback, retire.

