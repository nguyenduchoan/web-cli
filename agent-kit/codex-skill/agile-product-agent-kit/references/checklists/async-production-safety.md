# Checklist: Async Production Safety

Checklist này bắt buộc cho CompletableFuture, background job, queue consumer, scheduler, event handler và mọi async fire-and-forget.

## Completion & Shutdown

- [ ] Nếu process cần kết quả async trước khi kết thúc, có `join`, `get`, `allOf` hoặc cơ chế await tương đương.
- [ ] Không để async bị cắt ngang bởi `SpringApplication.exit(context)`, context close, SIGTERM, rolling deploy hoặc scale down.
- [ ] Executor do framework quản lý hoặc có shutdown hook rõ.
- [ ] Có graceful shutdown, wait-for-tasks-to-complete và await termination phù hợp.
- [ ] Scheduler/worker có cơ chế drain hoặc checkpoint trước khi dừng.

## Error Handling

- [ ] CompletableFuture chain có `exceptionally`, `handle`, `whenComplete` hoặc cơ chế log lỗi đầy đủ.
- [ ] Không nuốt exception trong callback.
- [ ] Log có stacktrace và correlation/trace id, nhưng không chứa PII/secret.
- [ ] Failure có alert hoặc đưa vào retry/dead-letter.

## Timeout & Bulkhead

- [ ] Mọi call DB/HTTP/Kafka/external trong async có timeout rõ.
- [ ] Không dùng common pool cho workload nặng hoặc blocking IO.
- [ ] Executor có core/max/queue/rejection policy phù hợp.
- [ ] Có giới hạn số task đồng thời.
- [ ] Có backpressure khi queue đầy hoặc downstream chậm.

## Consistency & Idempotency

- [ ] Async không giả định kế thừa transaction từ thread gốc.
- [ ] ThreadLocal/MDC/security context/trace id được propagate nếu cần.
- [ ] Có idempotency key cho retry hoặc at-least-once delivery.
- [ ] Có version/checkpoint/locking khi cần giữ thứ tự hoặc tránh ghi đè.
- [ ] Duplicate processing được xử lý an toàn.

## Monitoring

- [ ] Metric queue depth, active thread, latency, failure rate, timeout rate.
- [ ] Alert cho backlog tăng, dead-letter tăng, worker failure, timeout spike.
- [ ] Dashboard đủ để xác định đang xử lý, đang treo hay đã mất task.

