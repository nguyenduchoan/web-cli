#!/bin/bash
set -euo pipefail

proxy_env_file="${CLAUDE_PROXY_ENV_FILE:-/etc/server-hub/claude-proxy.env}"
if [ -r "$proxy_env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$proxy_env_file"
    set +a
fi

: "${ANTHROPIC_BASE_URL:?Thiếu ANTHROPIC_BASE_URL trong secret environment file}"
: "${ANTHROPIC_AUTH_TOKEN:?Thiếu ANTHROPIC_AUTH_TOKEN trong secret environment file}"

exec claude "$@"
