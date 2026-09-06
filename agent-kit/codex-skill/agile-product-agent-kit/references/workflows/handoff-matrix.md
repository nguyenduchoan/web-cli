# Workflow: Handoff Matrix

Bảng này giúp tránh bàn giao mơ hồ giữa các vai trò.

| From | To | Khi nào | Bàn giao gì | Gate |
| --- | --- | --- | --- | --- |
| PM | BA | Product problem đã rõ | Product brief, outcome, scope, non-goals | Có metric và persona |
| PM | Data Analyst | Cần đo success | Product goal, funnel, business decision | Metric không phải vanity |
| BA | UX/UI | Cần thiết kế flow | User story, business rule, edge case | AC testable |
| BA | SA | Story ảnh hưởng hệ thống | Requirement, data, permission, dependency | Rule không mâu thuẫn |
| UX/UI | FE | UI đã đủ rõ | Flow, screen spec, state, responsive, accessibility | Không thiếu state lỗi/loading/empty |
| SA | BE | Backend scope rõ | API contract, data model, NFR, risk | Có security/scale/rollback |
| SA | FE | Client integration rõ | API behavior, error model, state contract | Không mơ hồ về loading/error |
| SA | DevOps/SRE | Cần deploy/operate | Runtime need, capacity, monitoring, rollout | Có SLO/alert/rollback |
| Security | SA/BE/FE | Có risk bảo mật | Threat model, finding, mitigation | Severity rõ |
| BE/FE | QC | Code sẵn sàng test | Build, test notes, scope changed, known risk | CI xanh hoặc exception rõ |
| QC | PM/DevOps | Sẵn sàng release | Test summary, defect status, residual risk | Blocker/critical đã xử lý |
| DevOps/SRE | PM/Team | Release xong | Version, rollout status, monitoring, incident note | Dashboard ổn định |

## Quy tắc bàn giao

- Bàn giao phải có owner nhận, không chỉ gửi tài liệu.
- Mỗi artifact phải ghi assumption và open question.
- Nếu có risk high/critical, phải có quyết định accept/mitigate/defer.
- Nếu task ảnh hưởng production, phải có rollback và monitoring trước release.

