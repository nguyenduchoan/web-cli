#!/usr/bin/env bash
set -euo pipefail

export COPYFILE_DISABLE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$KIT_ROOT/.." && pwd)"
SKILL_SRC="$KIT_ROOT/codex-skill/agile-product-agent-kit"
VERSION="${1:-1.0.0}"
PACKAGE_NAME="agile-product-agent-kit-$VERSION"
DIST_DIR="$REPO_ROOT/dist"
PACKAGE_DIR="$DIST_DIR/$PACKAGE_NAME"
ARCHIVE="$DIST_DIR/$PACKAGE_NAME.tar.gz"
CHECKSUMS="$DIST_DIR/SHA256SUMS"

if [[ ! -f "$SKILL_SRC/SKILL.md" ]]; then
  echo "Missing skill source: $SKILL_SRC/SKILL.md" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
rm -rf "$PACKAGE_DIR" "$ARCHIVE"
mkdir -p "$PACKAGE_DIR/skills"

cp -R "$SKILL_SRC" "$PACKAGE_DIR/skills/agile-product-agent-kit"

cat > "$PACKAGE_DIR/VERSION" <<EOF_VERSION
$VERSION
EOF_VERSION

cat > "$PACKAGE_DIR/install.sh" <<'EOF_INSTALL'
#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$PACKAGE_DIR/skills/agile-product-agent-kit"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR="$CODEX_HOME_DIR/skills"
TARGET="$SKILLS_DIR/agile-product-agent-kit"
GLOBAL_AGENTS="$CODEX_HOME_DIR/AGENTS.md"
MARKER="<!-- agile-product-agent-kit-global -->"

if [[ ! -f "$SKILL_SRC/SKILL.md" ]]; then
  echo "Missing package skill source: $SKILL_SRC/SKILL.md" >&2
  exit 1
fi

mkdir -p "$SKILLS_DIR"

if [[ -e "$TARGET" ]]; then
  BACKUP="$TARGET.backup-$(date +%Y%m%d%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "Backed up existing skill to: $BACKUP"
fi

cp -R "$SKILL_SRC" "$TARGET"

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

echo "Installed: $TARGET"
echo "Restart Codex CLI sessions to pick up the global skill."
EOF_INSTALL

cat > "$PACKAGE_DIR/uninstall.sh" <<'EOF_UNINSTALL'
#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
TARGET="$CODEX_HOME_DIR/skills/agile-product-agent-kit"
GLOBAL_AGENTS="$CODEX_HOME_DIR/AGENTS.md"
MARKER="<!-- agile-product-agent-kit-global -->"

if [[ -e "$TARGET" ]]; then
  rm -rf "$TARGET"
  echo "Removed skill: $TARGET"
else
  echo "Skill not found: $TARGET"
fi

if [[ -f "$GLOBAL_AGENTS" ]] && grep -q "$MARKER" "$GLOBAL_AGENTS"; then
  TMP_FILE="$(mktemp)"
  awk -v marker="$MARKER" '
    $0 == marker {skip = !skip; next}
    skip == 0 {print}
  ' "$GLOBAL_AGENTS" > "$TMP_FILE"
  mv "$TMP_FILE" "$GLOBAL_AGENTS"
  echo "Removed global instruction marker from: $GLOBAL_AGENTS"
fi
EOF_UNINSTALL

cat > "$PACKAGE_DIR/README.md" <<EOF_README
# Agile Product Agent Kit $VERSION

Portable Codex CLI package for the global skill \`\$agile-product-agent-kit\`.

## Install

\`\`\`sh
tar -xzf $PACKAGE_NAME.tar.gz
cd $PACKAGE_NAME
./install.sh
\`\`\`

The installer writes to:

- \`\${CODEX_HOME:-\$HOME/.codex}/skills/agile-product-agent-kit\`
- \`\${CODEX_HOME:-\$HOME/.codex}/AGENTS.md\` with a small marker block

It backs up an existing skill folder before replacing it.

## Verify

\`\`\`sh
find "\${CODEX_HOME:-\$HOME/.codex}/skills/agile-product-agent-kit" -maxdepth 2 -type f -name SKILL.md -print
codex --version
\`\`\`

Open a new Codex CLI session and use:

\`\`\`md
Use \$agile-product-agent-kit to route this request through production-ready Agile roles and quality gates:
<request>
\`\`\`

## Uninstall

\`\`\`sh
./uninstall.sh
\`\`\`

## Contents

- \`skills/agile-product-agent-kit/SKILL.md\`
- Role references: PM, BA, SA, Backend, Frontend, QA/QC, Scrum Master, UX/UI, DevOps/SRE, Security, Data
- Production checklists: DoR, DoD, release readiness, async safety, security/performance/scale
- Templates: PRD, user story, solution design, API contract, frontend spec, test plan, release plan
EOF_README

chmod +x "$PACKAGE_DIR/install.sh" "$PACKAGE_DIR/uninstall.sh"

(
  cd "$DIST_DIR"
  tar -czf "$ARCHIVE" "$PACKAGE_NAME"
)

if command -v shasum >/dev/null 2>&1; then
  (
    cd "$DIST_DIR"
    shasum -a 256 "$PACKAGE_NAME.tar.gz" > "$CHECKSUMS"
  )
elif command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$DIST_DIR"
    sha256sum "$PACKAGE_NAME.tar.gz" > "$CHECKSUMS"
  )
else
  echo "Warning: shasum/sha256sum not found; checksum skipped." >&2
fi

echo "Created package directory: $PACKAGE_DIR"
echo "Created archive: $ARCHIVE"
if [[ -f "$CHECKSUMS" ]]; then
  echo "Created checksums: $CHECKSUMS"
fi
