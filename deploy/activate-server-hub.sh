#!/usr/bin/env bash
# Root-only activation of the already built, installed and health-checked hub.
set -Eeuo pipefail
umask 077
[[ "$(id -u)" = 0 ]]
readonly source_config=/home/mrhoan/source/web-cli/deploy/nginx-server-hub.conf
readonly destination=/etc/nginx/sites-available/server-hub
readonly enabled=/etc/nginx/sites-enabled/server-hub
readonly backup="/var/backups/server-hub/$(date -u +%Y%m%dT%H%M%SZ)"
readonly curl=/usr/bin/curl
readonly nginx=/usr/sbin/nginx

# Never take a service port or change another site's configuration.
ss -lntp 'sport = :3001' | /usr/bin/grep -q '127.0.0.1:3001'
health_body="$("$curl" --fail --silent --max-time 5 http://127.0.0.1:3001/api/health)"
[[ "$health_body" == *agent-cli-web-controller* ]]
login_body="$("$curl" --fail --silent --max-time 5 http://127.0.0.1:3001/login -H 'Host: tmp-web.hoanit.io.vn' -H 'X-Forwarded-Proto: https')"
[[ "$login_body" == *'<title>Server Hub'* ]]
if [[ -e "$destination" ]]; then
  head -n 1 "$destination" | /usr/bin/grep -q '^# Managed by web-cli/deploy/install-server-hub.sh$'
fi
was_enabled=0
if [[ -e "$enabled" || -L "$enabled" ]]; then [[ "$(readlink "$enabled")" = "$destination" ]]; was_enabled=1; fi
install -d -m 0700 "$backup"
if [[ -f "$destination" ]]; then cp -a "$destination" "$backup/nginx-server-hub.conf"; fi
cp -a /etc/nginx/sites-available/default "$backup/nginx-default.conf"
rollback() {
  trap - ERR
  if [[ -f "$backup/nginx-server-hub.conf" ]]; then
    install -m 0644 "$backup/nginx-server-hub.conf" "$destination"
  fi
  if [[ "$was_enabled" = 0 && -L "$enabled" ]]; then
    mv "$enabled" "$backup/nginx-enabled.failed"
  fi
  "$nginx" -t && systemctl reload nginx
  echo "Activation failed at line ${failure_line:-unknown}; restored previous public route." >&2
  exit 1
}
trap 'failure_line=$LINENO; rollback' ERR
install -m 0644 "$source_config" "$destination"
if [[ ! -L "$enabled" ]]; then ln -s "$destination" "$enabled"; fi
"$nginx" -t
systemctl reload nginx
loginctl enable-linger mrhoan
ready=0
for attempt in {1..30}; do
  if login_body="$("$curl" --fail --silent --max-time 3 http://127.0.0.1/login -H 'Host: tmp-web.hoanit.io.vn' -H 'X-Forwarded-Proto: https')" && [[ "$login_body" == *'<title>Server Hub'* ]]; then ready=1; break; fi
  sleep 0.3
done
[[ "$ready" = 1 ]]
trap - ERR
printf 'PUBLIC_ACTIVATED\nBackup: %s\n' "$backup"
