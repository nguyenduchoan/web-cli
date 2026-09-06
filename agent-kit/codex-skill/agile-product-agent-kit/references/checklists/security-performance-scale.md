# Checklist: Security, Performance, Scale

## Security

- [ ] Input được validate theo schema, type, length, format và allowlist khi cần.
- [ ] Authorization kiểm tra ở server theo resource/action/tenant.
- [ ] Không log secret, token, PII hoặc dữ liệu nhạy cảm.
- [ ] Secret nằm trong secret manager hoặc config an toàn.
- [ ] Error response không lộ stacktrace hoặc thông tin nội bộ.
- [ ] Dependency có scan vulnerability.
- [ ] File upload/webhook/redirect có kiểm soát abuse case.
- [ ] Audit log cho hành động nhạy cảm.

## Performance

- [ ] External IO có timeout.
- [ ] Query có index phù hợp và tránh N+1.
- [ ] Pagination/limit cho danh sách lớn.
- [ ] Cache có TTL, invalidation và ownership rõ.
- [ ] Bulk operation có chunking và không giữ transaction quá lâu.
- [ ] UI tránh render danh sách quá lớn không virtualization.
- [ ] Asset/bundle được tối ưu theo mức cần thiết.

## Scale & Reliability

- [ ] Có rate limit hoặc backpressure cho luồng có burst traffic.
- [ ] Retry có backoff, limit và idempotency.
- [ ] Queue/topic có monitoring depth, lag, failure.
- [ ] Worker có graceful shutdown.
- [ ] DB pool/thread pool/executor có cấu hình rõ.
- [ ] Autoscaling dựa trên metric hợp lý.
- [ ] SLO, dashboard và alert đã định nghĩa.

