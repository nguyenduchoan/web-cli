#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly repo=/home/mrhoan/source/web-cli
readonly app=/home/mrhoan/apps/server-hub
readonly config=/home/mrhoan/.config/server-hub
readonly state=/home/mrhoan/.local/state/server-hub
readonly units=/home/mrhoan/.config/systemd/user
readonly node=/home/mrhoan/.nvm/versions/node/v24.16.0/bin/node
readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly release="$app/releases/$stamp"
readonly backup="$app/backups/$stamp"
readonly vhost=/etc/nginx/sites-available/server-hub
readonly enabled=/etc/nginx/sites-enabled/server-hub
stage_only=0
if [[ "${1:-}" = --stage-only ]]; then stage_only=1; elif [[ $# != 0 ]]; then echo 'Usage: install-server-hub.sh [--stage-only]' >&2; exit 2; fi

test "$(id -un)" = mrhoan
test -f "$repo/server/dist/hub.js"
test -f "$repo/web/dist/index.html"
test -f "$repo/hub/public/index.html"
if [[ "$stage_only" = 0 ]]; then sudo -n true; fi
# Port ownership is a deployment gate. Never stop an unrelated process.
port_report="$(ss -lntp 'sport = :3001')"
if [[ "$port_report" == *LISTEN* ]]; then
  running_pid="$(systemctl --user show server-hub.service -p MainPID --value)"
  [[ "$running_pid" != 0 && "$port_report" == *"pid=$running_pid,"* ]] || { echo 'Port 3001 belongs to another process.' >&2; exit 1; }
fi
if [[ -e "$vhost" ]]; then
  head -n 1 "$vhost" | rg -q '^# Managed by web-cli/deploy/install-server-hub.sh$'
fi
was_enabled=0
if [[ -e "$enabled" || -L "$enabled" ]]; then
  [[ "$(readlink "$enabled")" = "$vhost" ]]
  was_enabled=1
fi

mkdir -p "$release/server" "$release/web" "$release/hub" "$backup" "$config" "$state" "$units"
chmod 700 "$config" "$state" "$backup"
cp -a "$repo/server/dist" "$release/server/"
cp -a "$repo/server/package.json" "$release/server/"
cp -a "$repo/web/dist" "$release/web/"
cp -a "$repo/hub/public" "$release/hub/"
cp -a "$repo/node_modules" "$release/"
cp -a "$repo/package.json" "$repo/package-lock.json" "$release/"
previous_release="$(readlink -f "$app/current" 2>/dev/null || true)"
printf '%s\n' "$previous_release" > "$backup/previous-release.txt"
if [[ -f "$units/server-hub.service" ]]; then cp -a "$units/server-hub.service" "$backup/"; fi
if [[ -f "$vhost" ]]; then cp -a "$vhost" "$backup/nginx-server-hub.conf"; fi
cp -a /etc/nginx/sites-available/default "$backup/nginx-default.conf"
if [[ -f "$config/web-cli.env" ]]; then cp -a "$config/web-cli.env" "$backup/"; fi

if [[ ! -f "$config/web-cli.env" ]]; then
  cat > "$config/web-cli.env.new" <<'ENV'
HOST=127.0.0.1
PORT=3001
SERVER_HUB_ORIGIN=https://tmp-web.hoanit.io.vn
SERVER_HUB_USERNAME=mrhoan
SERVER_HUB_AUTH_DIR=/home/mrhoan/.local/state/server-hub/hub-auth
WEB_CLI_AUTH_DIR=/home/mrhoan/.local/state/server-hub/web-cli-auth
WEB_CLI_ENV_FILE=/home/mrhoan/.config/server-hub/web-cli.env
CLIENT_ORIGIN=https://tmp-web.hoanit.io.vn
ALLOWED_PROJECT_DIRS=/home/mrhoan/source,/var/www/html
AGENTS_CONFIG_JSON='[{"id":"codex","label":"Codex CLI","command":"/home/mrhoan/.nvm/versions/node/v24.16.0/bin/codex","args":[]},{"id":"claude","label":"Claude Code","command":"/home/mrhoan/.local/bin/claude","args":[]},{"id":"opencode","label":"OpenCode","command":"/home/mrhoan/.opencode/bin/opencode","args":[]}]'
MAX_SESSIONS=3
MAX_WS_CONNECTIONS=8
LOG_TERMINAL_OUTPUT=false
LOG_LEVEL=info
FCM_ENABLED=false
ENV
  chmod 600 "$config/web-cli.env.new"
  mv -f "$config/web-cli.env.new" "$config/web-cli.env"
fi
install -m 0644 "$repo/deploy/server-hub.service" "$units/server-hub.service"
ln -s "$release" "$app/current.new"
mv -Tf "$app/current.new" "$app/current"

activated=0
rollback() {
  trap - ERR
  echo 'Deployment failed; restoring the previous route and service.' >&2
  if [[ "$activated" = 1 ]]; then
    if [[ -f "$backup/nginx-server-hub.conf" ]]; then
      sudo -n install -m 0644 "$backup/nginx-server-hub.conf" "$vhost"
    fi
    if [[ "$was_enabled" = 0 && -L "$enabled" ]]; then
      sudo -n mv "$enabled" "$backup/nginx-enabled.failed"
    fi
    sudo -n nginx -t && sudo -n systemctl reload nginx
  fi
  if [[ -f "$backup/web-cli.env" ]]; then cp -a "$backup/web-cli.env" "$config/web-cli.env"; fi
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    ln -s "$previous_release" "$app/current.rollback"
    mv -Tf "$app/current.rollback" "$app/current"
    if [[ -f "$backup/server-hub.service" ]]; then cp -a "$backup/server-hub.service" "$units/server-hub.service"; fi
    systemctl --user daemon-reload
    systemctl --user restart server-hub.service
  else
    systemctl --user disable --now server-hub.service || true
  fi
  exit 1
}
trap rollback ERR
systemctl --user daemon-reload
systemctl --user enable server-hub.service
systemctl --user restart server-hub.service
ready=0
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3001/api/health >/dev/null; then ready=1; break; fi
  sleep 0.3
done
[[ "$ready" = 1 ]]
running_pid="$(systemctl --user show server-hub.service -p MainPID --value)"
port_report="$(ss -lntp 'sport = :3001')"
[[ "$port_report" == *"127.0.0.1:3001"* && "$port_report" == *"pid=$running_pid,"* ]]
login_body="$(curl --fail --silent --max-time 5 http://127.0.0.1:3001/login -H 'Host: tmp-web.hoanit.io.vn' -H 'X-Forwarded-Proto: https')"
[[ "$login_body" == *'<title>Server Hub'* ]]
if [[ "$stage_only" = 1 ]]; then
  trap - ERR
  printf 'STAGED_AND_HEALTHY\nRelease: %s\nBackup: %s\nLogin file: %s/hub-auth/initial-login.txt\n' "$release" "$backup" "$state"
  exit 0
fi
sudo -n install -m 0644 "$repo/deploy/nginx-server-hub.conf" "$vhost"
activated=1
if [[ ! -L "$enabled" ]]; then sudo -n ln -s "$vhost" "$enabled"; fi
sudo -n nginx -t
sudo -n systemctl reload nginx
sudo -n loginctl enable-linger mrhoan
ready=0
for attempt in {1..30}; do
  if login_body="$(curl --fail --silent --max-time 3 http://127.0.0.1/login -H 'Host: tmp-web.hoanit.io.vn' -H 'X-Forwarded-Proto: https')" && [[ "$login_body" == *'<title>Server Hub'* ]]; then ready=1; break; fi
  sleep 0.3
done
[[ "$ready" = 1 ]]
trap - ERR
printf 'DEPLOYED\nRelease: %s\nBackup: %s\nLogin file: %s/hub-auth/initial-login.txt\n' "$release" "$backup" "$state"
