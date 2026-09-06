# Global Instructions

- Luon tra loi nguoi dung bang tieng Viet.
- Khi len ke hoach, coding hoac review, luon kiem tra anh huong den he thong dang chay, kha nang chiu tai cao, scale, reliability va bao mat.
- Voi Node.js project, luon kiem tra lockfile hien co truoc khi chon package manager.

## Codex CLI va Agent Kit

- Repo nay chua source kit Agile product trong `agent-kit/`.
- Ban skill production cho Codex CLI nam tai `agent-kit/codex-skill/agile-product-agent-kit/`.
- Script cai global cho host: `agent-kit/scripts/install-codex-global.sh`.
- Script dong goi portable de cai tren may khac: `agent-kit/scripts/package-codex-global.sh`.
- Skill global sau khi cai: `$agile-product-agent-kit`.

## Su dung agent-kit

- Khi nguoi dung nhac `agent-kit`, `bo kit`, `vai tro`, `PM/BA/SA/BE/FE/QC/SRE/Security`, hoac `production readiness`, phai dung skill `$agile-product-agent-kit` hoac doc role/checklist/template lien quan trong `agent-kit`.
- Khong load tat ca file trong `agent-kit` neu khong can. Chon file theo task de giu context gon.
- Neu yeu cau mo ho hoac can phan ra nhieu vai tro, bat dau bang `agent-kit/agents/00-product-team-orchestrator.md` va `agent-kit/config/agent-registry.yaml`.
- Neu task la coding/review backend, doc them `agent-kit/agents/04-backend-engineer.md` va checklist lien quan.
- Neu task la UI/frontend, doc them `agent-kit/agents/05-frontend-engineer.md`; neu can UX thi doc `agent-kit/agents/08-ux-ui-designer.md`.
- Neu task la review bao mat, doc `agent-kit/agents/10-security-reviewer.md` va `agent-kit/checklists/security-performance-scale.md`.
- Neu co async/job/event/CompletableFuture/background processing, bat buoc kiem tra `agent-kit/checklists/async-production-safety.md`.
- Truoc khi dua story vao sprint, dung `agent-kit/checklists/definition-of-ready.md`.
- Truoc khi release, dung `agent-kit/checklists/definition-of-done.md` va `agent-kit/checklists/release-readiness.md`.

## Routing nhanh theo vai tro

- Orchestrator: `agent-kit/agents/00-product-team-orchestrator.md`
- Product Manager: `agent-kit/agents/01-product-manager.md`
- Business Analyst: `agent-kit/agents/02-business-analyst.md`
- Solution Architect: `agent-kit/agents/03-solution-architect.md`
- Backend Engineer: `agent-kit/agents/04-backend-engineer.md`
- Frontend Engineer: `agent-kit/agents/05-frontend-engineer.md`
- Quality Engineer: `agent-kit/agents/06-quality-engineer.md`
- Scrum Master: `agent-kit/agents/07-scrum-master.md`
- UX/UI Designer: `agent-kit/agents/08-ux-ui-designer.md`
- DevOps/SRE: `agent-kit/agents/09-devops-sre.md`
- Security Reviewer: `agent-kit/agents/10-security-reviewer.md`
- Data Analyst: `agent-kit/agents/11-data-analyst.md`

## Async va shutdown checklist khi review

- Kiem tra task async co can tinh toan day du ket qua truoc khi ket thuc process khong; neu co, phai co `join/get/allOf/await` hoac co che cho hoan tat an toan.
- Kiem tra race voi shutdown: `SpringApplication.exit(context)`, context close, SIGTERM, scale down, rolling deploy co the cat ngang async dang chay.
- Neu async fire-and-forget, phai co retry, idempotency, dead-letter hoac canh bao that bai.
- Kiem tra timeout, bulkhead, executor, backpressure, transaction boundary, ThreadLocal/MDC/security context propagation, thu tu du lieu, duplicate processing, cleanup va monitoring.
- Khong log PII/secret trong callback async, worker, error hoac audit.



<claude-mem-context>
# Memory Context

# [codex-template] recent context, 2026-05-14 2:46pm GMT+7

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (11,714t read) | 0t work

### May 14, 2026
S149 Dựng “agent kit”/bộ khung chuẩn cho team phát triển sản phẩm theo Agile; đồng thời rà soát repo mẫu “Agent CLI Web Controller” và làm rõ ý nghĩa “ssh” + ưu tiên cải tiến mobile (May 14 at 2:22 AM)
S150 Làm rõ scope “web control panel mượt, realtime trên mobile” (không phải thêm SSH feature) và xác định các quyết định ưu tiên (terminal UX vs realtime stability) + mode truy cập (VPN/LAN/Public) (May 14 at 2:24 AM)
1304 2:24p 🟣 Created SKILL.md for agile-product-agent-kit Codex skill with role routing and production gates
1305 2:25p 🟣 Added harness metadata agents/openai.yaml for agile-product-agent-kit skill
1306 " 🟣 Added global installer script for Codex skill and AGENTS.md augmentation
1307 " 🟣 Created install-codex-global.sh script to deploy skill into ~/.codex and mark AGENTS.md
1308 " ✅ Made install-codex-global.sh executable
1309 " ✅ Documented host-wide global Codex skill installation in agent-kit/QUICKSTART.md
1310 " ✅ Updated agent-kit/README.md to describe packaged Codex skill and global installer workflow
1311 2:26p ✅ Applied README patch confirming Codex global install instructions and kit packaging paths
1312 " 🔵 Validated install-codex-global.sh syntax with bash -n
1313 " 🔵 Validated agile-product-agent-kit skill folder passes Codex quick_validate checks
1314 " 🔵 Confirmed packaged skill includes role prompts, gates, playbooks, and templates within maxdepth 3
1315 2:28p 🟣 Installed agile-product-agent-kit as a global Codex skill under ~/.codex/skills
1316 " 🔵 Re-validated installed global skill under ~/.codex/skills/agile-product-agent-kit
1317 2:29p 🔵 Verified global Codex install artifacts: skill file tree and AGENTS.md marker block
1318 2:30p ✅ Replaced repository AGENTS.md with expanded instructions for using agile-product-agent-kit
1319 " ✅ Applied AGENTS.md replacement patch to align repo behavior with global skill kit
1320 " 🔵 Verified final repository AGENTS.md content for global kit routing rules
1321 2:31p ✅ Refined agent-kit/README.md wording for global installer safety and backup behavior
1322 " ✅ Applied README patch emphasizing install-codex-global.sh backup safety
1323 " 🔵 Confirmed global AGENTS.md marker block and installed skill metadata after setup
1324 " 🔵 Rechecked installer script syntax after documentation edits
1325 " 🔵 Confirmed global skill discovery now includes agile-product-agent-kit alongside frontend-skill
1326 2:35p 🔵 Reviewed Codex skill-creator guidelines for skill packaging structure
1327 2:36p 🟣 Added script to package Codex global skill as portable tarball with installer
1328 " ✅ Committed packaging script file and marked it executable
1329 2:37p 🔴 Escaped $ in generated README to prevent unintended variable expansion
1330 " 🔴 Updated package script README template to render literal skill invocation
1331 " ✅ Documented portable packaging and cross-machine installation steps in agent-kit README
1332 " ✅ Patched agent-kit README with pack-and-install workflow for other machines
1333 " ✅ Added portable packaging instructions to agent-kit QUICKSTART
1334 " 🔵 Validated packaging script syntax with bash -n
1335 2:38p 🔵 Validated installer scripts and confirmed Codex skill passes quick validation
1336 " 🟣 Built portable distribution archive for agile-product-agent-kit v1.0.0
1337 " 🔵 Verified contents of packaged agile-product-agent-kit tarball
1338 2:39p 🔵 Verified packaged tarball integrity, README output, and installer script syntax
1339 " 🔵 Extracted package to temp directory and verified SHA-256 checksum
1340 " 🟣 Test-installed packaged skill into isolated CODEX_HOME and validated installation
1341 " 🔵 Confirmed installed files under isolated CODEX_HOME after install.sh run
1342 " 🔵 Confirmed AGENTS.md marker block insertion and successful uninstall cleanup
1343 " ✅ Updated repo AGENTS.md to reference portable packaging script
1344 " 🔴 Disabled macOS AppleDouble metadata copying in packaging script
1345 2:40p 🔴 Patched package-codex-global.sh to export COPYFILE_DISABLE=1
1346 " 🔵 Revalidated packaging script syntax after COPYFILE_DISABLE change
1347 " 🔵 Reconfirmed agile-product-agent-kit skill validity after packaging updates
1348 " ✅ Regenerated agile-product-agent-kit v1.0.0 package after macOS metadata hardening
1349 " 🔵 Verified regenerated tarball checksum matches SHA256SUMS
1350 2:41p 🔵 Rechecked rebuilt package: new SHA-256, contents, and installer syntax all valid
1351 " ✅ Extracted final rebuilt package into a fresh temp workspace
1352 " 🟣 Final end-to-end install test succeeded for rebuilt portable package
1353 " 🔵 Validated installed skill and confirmed AGENTS.md marker block in final test environment
</claude-mem-context>
