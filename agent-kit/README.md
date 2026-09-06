# Agile Product Agent Kit

Bộ kit này dùng để vận hành một team phát triển sản phẩm theo Agile/Scrum hoặc Kanban, có đủ các vai trò chính: Product Manager, Business Analyst, Solution Architect, Backend Engineer, Frontend Engineer, Quality Engineer và các vai trò bổ trợ như Scrum Master, UX/UI, DevOps/SRE, Security Reviewer, Data Analyst.

Mục tiêu là tạo một bộ agent prompt và artifact chuẩn để dùng lại cho nhiều sản phẩm, giúp team đi từ ý tưởng, discovery, refinement, delivery, kiểm thử, release đến vận hành production.

## Cấu trúc

- `agents/`: system prompt theo từng vai trò.
- `workflows/`: luồng làm việc Agile product, bàn giao, quality gate.
- `templates/`: mẫu tài liệu và artifact chuẩn.
- `checklists/`: checklist sẵn dùng cho bảo mật, scale, release, DoR, DoD.
- `playbooks/`: playbook xử lý tình huống phổ biến.
- `config/agent-registry.yaml`: registry để route task cho đúng agent.
- `codex-skill/agile-product-agent-kit/`: bản đóng gói sạch để cài global cho Codex CLI.
- `scripts/install-codex-global.sh`: installer an toàn, có backup cho `${CODEX_HOME:-$HOME/.codex}`.
- `scripts/package-codex-global.sh`: build package portable để cài trên máy khác.

## Đóng gói để cài trên máy khác

Từ root repo:

```sh
./agent-kit/scripts/package-codex-global.sh 1.0.0
```

Output:

- `dist/agile-product-agent-kit-1.0.0.tar.gz`
- `dist/agile-product-agent-kit-1.0.0/`
- `dist/SHA256SUMS`

Trên máy khác:

```sh
tar -xzf agile-product-agent-kit-1.0.0.tar.gz
cd agile-product-agent-kit-1.0.0
./install.sh
```

## Setup global cho Codex CLI

Từ root repo:

```sh
./agent-kit/scripts/install-codex-global.sh
```

Sau đó mở session Codex CLI mới ở bất kỳ repo nào và gọi:

```md
Use $agile-product-agent-kit to plan/review/implement this work with production-ready Agile roles and quality gates:
<yêu cầu>
```

Bản global được cài vào `${CODEX_HOME:-$HOME/.codex}/skills/agile-product-agent-kit` và được neo trong `${CODEX_HOME:-$HOME/.codex}/AGENTS.md`.

## Cách dùng nhanh

1. Bắt đầu bằng `agents/00-product-team-orchestrator.md` để phân rã mục tiêu thành backlog, artifact và vai trò chịu trách nhiệm.
2. PM tạo product outcome, scope, roadmap bằng `agents/01-product-manager.md`.
3. BA làm rõ requirement, user story, acceptance criteria bằng `agents/02-business-analyst.md`.
4. SA thiết kế solution, NFR, risk, integration bằng `agents/03-solution-architect.md`.
5. Dev BE/FE triển khai theo hợp đồng kỹ thuật trong `agents/04-backend-engineer.md` và `agents/05-frontend-engineer.md`.
6. QC lập test strategy, test case, automation, regression bằng `agents/06-quality-engineer.md`.
7. Trước khi release, chạy các checklist trong `checklists/`.

## Nguyên tắc vận hành

- Product trước, solution sau: mọi task phải gắn với mục tiêu người dùng, business outcome và metric đo được.
- Agile không đồng nghĩa làm thiếu tài liệu: tài liệu cần đủ để giảm hiểu nhầm, kiểm soát rủi ro và scale team.
- Mọi user story phải có acceptance criteria kiểm thử được.
- Mọi thay đổi kỹ thuật đáng kể phải có thiết kế, trade-off, security, performance, observability và rollback.
- Không release nếu thiếu Definition of Ready, Definition of Done hoặc quality gate bắt buộc.

## Luồng artifact khuyến nghị

`Product Brief -> PRD -> User Story -> Solution Design -> API/UI/Test Spec -> Implementation -> Test Evidence -> Release Plan -> Production Monitoring`

## Tiêu chuẩn chất lượng nền

- Bảo mật: validate input, phân quyền, bảo vệ secret, không log PII, kiểm soát dependency.
- Scale: giới hạn concurrency, timeout, retry có backoff, idempotency, backpressure, caching đúng chỗ.
- Reliability: graceful shutdown, retry/dead-letter cho async, observability, alert theo SLO.
- Maintainability: code rõ ownership, test có ý nghĩa, migration an toàn, backward compatibility.
- Product fit: đo adoption, activation, retention, conversion, revenue hoặc cost-to-serve theo ngữ cảnh sản phẩm.

## Khi dùng với AI agent

Mỗi file trong `agents/` có thể dùng làm system prompt hoặc instruction cho agent riêng. Với workflow nhiều vai trò, dùng orchestrator để:

- Chọn agent phù hợp.
- Yêu cầu đầu vào tối thiểu.
- Chuẩn hóa đầu ra.
- Chặn các bước thiếu requirement, thiếu acceptance criteria hoặc thiếu quality gate.
