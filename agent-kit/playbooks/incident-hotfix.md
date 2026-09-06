# Playbook: Incident / Hotfix

## Khi dùng

Dùng khi production có lỗi nghiêm trọng cần xử lý nhanh nhưng vẫn giữ kỷ luật an toàn.

## 1. Triage

- Severity:
- Customer impact:
- Revenue/data/security impact:
- Start time:
- Affected version:
- Current workaround:

## 2. Stabilize

- Rollback nếu bản release mới gây lỗi và rollback ít rủi ro hơn hotfix.
- Tắt feature flag nếu có.
- Giới hạn traffic hoặc degrade gracefully nếu cần.
- Bảo toàn dữ liệu trước khi sửa.

## 3. Root Cause Hypothesis

- Change gần nhất:
- Log/metric/trace:
- Reproduction:
- Suspected component:

## 4. Hotfix

- Scope nhỏ nhất để khôi phục dịch vụ.
- Có test tái hiện lỗi.
- Có regression cho luồng chính bị ảnh hưởng.
- Review nhanh bởi owner phù hợp.
- Không trộn refactor hoặc cải tiến ngoài incident.

## 5. Release Hotfix

- Deploy owner:
- Verification steps:
- Rollback trigger:
- Monitoring window:

## 6. Postmortem

- Timeline.
- Root cause.
- Detection gap.
- Prevention action.
- Owner và due date.

