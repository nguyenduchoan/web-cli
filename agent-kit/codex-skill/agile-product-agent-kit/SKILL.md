---
name: agile-product-agent-kit
description: Production Agile product development agent kit for Codex CLI. Use when the user asks to plan, refine, design, implement, review, test, release, or operate product work with Agile roles such as PM, BA, Solution Architect, Backend, Frontend, QA/QC, Scrum Master, UX/UI, DevOps/SRE, Security, or Data Analyst; also use when the user mentions agent-kit, bo kit, production readiness, quality gates, DoR, DoD, async safety, security, performance, scale, release readiness, or cross-role handoff.
---

# Agile Product Agent Kit

Use this skill as a production workflow layer for Codex CLI. It turns product requests into role-based delivery, quality gates, and practical engineering action.

## Operating Rules

- Answer in Vietnamese unless the user explicitly asks otherwise.
- Start from the user's latest request and the repository's `AGENTS.md`.
- Do not load every reference by default. Read only the role, checklist, workflow, or template needed for the task.
- For unclear or cross-role work, begin with `references/agents/00-product-team-orchestrator.md` and `references/agent-registry.yaml`.
- For implementation work, inspect the codebase before changing files, follow existing patterns, and verify with focused tests or checks.
- For review work, lead with findings ordered by severity and cite file/line evidence.
- Never ignore production impact: security, reliability, scale, observability, rollout, rollback, and current live-system behavior.

## Routing

Read the matching role prompt before doing substantial work:

- Product direction, roadmap, prioritization: `references/agents/01-product-manager.md`
- Requirements, user stories, acceptance criteria: `references/agents/02-business-analyst.md`
- Architecture, NFR, integration, data flow: `references/agents/03-solution-architect.md`
- Backend/API/DB/async implementation or review: `references/agents/04-backend-engineer.md`
- Frontend/UI/client performance/accessibility: `references/agents/05-frontend-engineer.md`
- Test strategy, test cases, regression: `references/agents/06-quality-engineer.md`
- Scrum/Kanban ceremonies and team flow: `references/agents/07-scrum-master.md`
- UX flow, IA, wireframe, usability: `references/agents/08-ux-ui-designer.md`
- CI/CD, deployment, SLO, runbook, incident: `references/agents/09-devops-sre.md`
- Threat model, auth, data protection, abuse cases: `references/agents/10-security-reviewer.md`
- Product metrics, tracking, experiment analysis: `references/agents/11-data-analyst.md`

## Mandatory Gates

- Before sprint commitment, read `references/checklists/definition-of-ready.md`.
- Before marking work complete, read `references/checklists/definition-of-done.md`.
- Before release, read `references/checklists/release-readiness.md` and `references/workflows/quality-gates.md`.
- For any async, background job, queue consumer, scheduler, event handler, CompletableFuture, or fire-and-forget flow, read `references/checklists/async-production-safety.md`.
- For security, performance, scale, or production-facing changes, read `references/checklists/security-performance-scale.md`.

## Production Review Bar

Always check:

- Live-system impact: compatibility, migrations, feature flags, rollout, rollback, downtime risk.
- Security: input validation, authn/authz, tenant/resource boundary, secret/PII logging, injection, XSS/CSRF/SSRF/IDOR, dependency risk.
- Reliability: timeout, retry with backoff, idempotency, backpressure, graceful shutdown, error handling, dead-letter or alert path.
- Scale: concurrency limits, pool sizing, queue depth, pagination, caching, N+1/full scan risk, bundle/render cost for UI.
- Observability: structured logs, metrics, traces, dashboard, actionable alerts, audit trail for sensitive actions.
- Tests: happy path, failure path, permission, boundary, concurrency, migration/rollback, regression scope.

## Templates

Use `assets/templates/` when the user asks to create artifacts:

- `product-brief.md`, `prd.md`, `user-story.md`
- `solution-design.md`, `adr.md`, `api-contract.md`, `database-change.md`
- `frontend-spec.md`
- `test-plan.md`, `test-case.md`, `bug-report.md`
- `sprint-plan.md`, `release-plan.md`, `retrospective.md`

Copy only the relevant structure into the answer or target file. Keep assumptions, open questions, risks, security, performance, scale, and validation evidence explicit.

## Default Workflow

1. Classify the work: discovery, requirement, design, implementation, testing, release, operation, incident.
2. Load the smallest relevant role prompt and checklist.
3. Identify missing information, assumptions, owner, reviewer, artifact, and quality gate.
4. Execute the requested work or implement the change end to end.
5. Verify with tests/checks where practical.
6. Summarize outcome, residual risk, and any unverified item.

