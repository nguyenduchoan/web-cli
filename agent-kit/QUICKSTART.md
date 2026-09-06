# Quickstart

## 0. Dùng trực tiếp với Codex CLI

### Đóng gói để cài trên máy khác

Tạo archive portable:

```sh
./agent-kit/scripts/package-codex-global.sh 1.0.0
```

Copy file này sang máy khác:

```sh
dist/agile-product-agent-kit-1.0.0.tar.gz
```

Cài trên máy đích:

```sh
tar -xzf agile-product-agent-kit-1.0.0.tar.gz
cd agile-product-agent-kit-1.0.0
./install.sh
```

### Setup global trên máy host

Chạy installer để Codex CLI ở mọi repo có thể discover skill `$agile-product-agent-kit`:

```sh
./agent-kit/scripts/install-codex-global.sh
```

Installer sẽ:

- Cài skill vào `${CODEX_HOME:-$HOME/.codex}/skills/agile-product-agent-kit`.
- Backup skill global cũ nếu đã tồn tại.
- Thêm marker ngắn vào `${CODEX_HOME:-$HOME/.codex}/AGENTS.md` nếu chưa có.

Sau khi cài, mở session Codex CLI mới và gọi:

```md
Use $agile-product-agent-kit to route this request through production-ready Agile roles and quality gates:
<yêu cầu>
```

Chạy Codex tại root repo để CLI tự đọc `AGENTS.md`:

```sh
cd /Users/hoannguyenduc/source/agent/codex-template
codex
```

Prompt mẫu:

```md
Dùng agent-kit orchestrator để phân rã feature này:
<mô tả feature>

Sau đó route sang BA, SA, BE, FE, QC và Security nếu cần.
Nêu artifact cần tạo, thông tin thiếu, rủi ro bảo mật/performance/scale.
```

Với non-interactive mode:

```sh
codex exec -C /Users/hoannguyenduc/source/agent/codex-template "Dùng agent-kit Backend Engineer review phần async/job trong repo này"
```

Lưu ý: Codex CLI đọc `AGENTS.md` tự động, còn các file trong `agent-kit/**` là thư viện prompt/artifact. Khi prompt nhắc `agent-kit` hoặc một vai trò cụ thể, Codex sẽ đọc file role/checklist/template liên quan theo hướng dẫn trong `AGENTS.md`.

## 1. Dùng orchestrator để nhận yêu cầu mới

Copy nội dung `agents/00-product-team-orchestrator.md` làm system prompt, sau đó đưa yêu cầu theo format:

```md
## Yêu cầu
<mô tả ý tưởng hoặc feature>

## Bối cảnh
<sản phẩm, người dùng, hệ thống hiện có>

## Ràng buộc
<deadline, compliance, kỹ thuật, vận hành>

## Kỳ vọng đầu ra
<backlog, PRD, solution design, test plan, release plan...>
```

Orchestrator sẽ trả về vai trò cần tham gia, artifact cần tạo và thông tin thiếu.

## 2. Route sang đúng agent

Sau khi orchestrator phân loại, dùng prompt của agent tương ứng:

- Product direction: `agents/01-product-manager.md`
- Requirement: `agents/02-business-analyst.md`
- Architecture: `agents/03-solution-architect.md`
- Backend: `agents/04-backend-engineer.md`
- Frontend: `agents/05-frontend-engineer.md`
- QC/Test: `agents/06-quality-engineer.md`
- Agile flow: `agents/07-scrum-master.md`
- UX/UI: `agents/08-ux-ui-designer.md`
- Release/operation: `agents/09-devops-sre.md`
- Security: `agents/10-security-reviewer.md`
- Metrics/data: `agents/11-data-analyst.md`

## 3. Luồng chuẩn cho một feature

1. PM tạo `templates/product-brief.md`.
2. PM/BA tạo `templates/prd.md`.
3. BA tách story bằng `templates/user-story.md`.
4. UX/UI tạo `templates/frontend-spec.md` nếu có UI.
5. SA tạo `templates/solution-design.md` và `templates/adr.md` nếu có quyết định kỹ thuật đáng kể.
6. BE/FE triển khai theo design và ghi test evidence.
7. QC tạo `templates/test-plan.md`, `templates/test-case.md`, bug bằng `templates/bug-report.md` nếu có.
8. DevOps/SRE tạo `templates/release-plan.md`.
9. PM/Data Analyst đo kết quả sau release.

## 4. Prompt mẫu để yêu cầu output chuẩn

```md
Hãy dùng vai trò <agent name> theo agent-kit.
Đầu vào:
- Product/feature:
- Người dùng:
- Mục tiêu:
- Scope:
- Constraint:

Hãy tạo artifact theo template <template name>.
Phải nêu rõ assumption, open question, risk, security/performance/scale impact nếu có.
```

## 5. Gate bắt buộc trước sprint

Chạy `checklists/definition-of-ready.md`. Nếu story không đạt DoR, trả lại refinement thay vì đưa vào sprint.

## 6. Gate bắt buộc trước release

Chạy các checklist:

- `checklists/definition-of-done.md`
- `checklists/security-performance-scale.md`
- `checklists/release-readiness.md`
- `checklists/async-production-safety.md` nếu có async/job/event/CompletableFuture.
