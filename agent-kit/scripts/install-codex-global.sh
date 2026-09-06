#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_SRC="$KIT_ROOT/codex-skill/agile-product-agent-kit"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR="$CODEX_HOME_DIR/skills"
TARGET="$SKILLS_DIR/agile-product-agent-kit"
GLOBAL_AGENTS="$CODEX_HOME_DIR/AGENTS.md"
MARKER="<!-- agile-product-agent-kit-global -->"

if [[ ! -f "$SKILL_SRC/SKILL.md" ]]; then
  echo "Missing skill source: $SKILL_SRC/SKILL.md" >&2
  exit 1
fi

mkdir -p "$SKILLS_DIR"

if [[ -e "$TARGET" ]]; then
  BACKUP="$TARGET.backup-$(date +%Y%m%d%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "Backed up existing global skill to: $BACKUP"
fi

cp -R "$SKILL_SRC" "$TARGET"
echo "Installed global Codex skill: $TARGET"

if [[ ! -f "$GLOBAL_AGENTS" ]]; then
  touch "$GLOBAL_AGENTS"
fi

if ! grep -q "$MARKER" "$GLOBAL_AGENTS"; then
  {
    printf '\n%s\n' "$MARKER"
    printf '## Global Agile Product Agent Kit\n\n'
    printf -- '- Skill global: `$agile-product-agent-kit`.\n'
    printf -- '- Khi nguoi dung nhac agent-kit, bo kit, PM/BA/SA/BE/FE/QC/SRE/Security, production readiness, quality gate, DoR, DoD, async safety, release readiness, hay dung skill nay truoc khi lap ke hoach, coding hoac review.\n'
    printf -- '- Van giu nguyen quy tac hien co: tra loi tieng Viet, kiem tra anh huong he thong dang chay, scale, reliability va bao mat.\n'
    printf '%s\n' "$MARKER"
  } >> "$GLOBAL_AGENTS"
  echo "Updated global Codex instructions: $GLOBAL_AGENTS"
else
  echo "Global Codex instructions already contain agile-product-agent-kit marker."
fi

echo "Done. Restart Codex CLI sessions to pick up the global skill."

