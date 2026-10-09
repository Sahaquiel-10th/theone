#!/usr/bin/env bash
set -Eeuo pipefail
# Publishes reviewed tools only. Gateway and model/pricing remain unchanged.
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
source_directory="${1:-}"
app_root=/srv/theone
target="$app_root/shared/codex-tools"
staging="$app_root/shared/.codex-tools.$$.next"
previous="$app_root/shared/codex-tools.previous"
env_file="$app_root/shared/.env"
env_next="$app_root/shared/.env.codex-tools.$$.next"
env_backup="$app_root/shared/.env.codex-tools.$$.backup"
activated=false
if [[ -z "$source_directory" || ! -d "$source_directory" || ! -f "$source_directory/catalog.json" || ! -f "$env_file" ]]; then echo 'Signed catalog directory required.' >&2; exit 2; fi
source_directory=$(realpath "$source_directory")
cleanup() {
  status=$?
  rm -rf -- "$staging"
  rm -f -- "$env_next"
  if [[ "$status" -ne 0 && "$activated" == true ]]; then
    rm -rf -- "$target"
    if [[ -d "$previous" ]]; then mv -- "$previous" "$target"; fi
    if [[ -f "$env_backup" ]]; then mv -- "$env_backup" "$env_file"; fi
    systemctl restart theone.service >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
export ONE_EXECUTOR_PUBLIC_KEY
ONE_EXECUTOR_PUBLIC_KEY=$(tr -d '\r\n' < "$app_root/current/config/runtime-update-public-key.txt")
export ONE_EXECUTOR_DOWNLOAD_ORIGINS=https://theone.aiarrival.cn
cd "$app_root/current"
node node_modules/tsx/dist/cli.mjs scripts/check-executor-catalog.ts "$source_directory/catalog.json" --verify-packages
install -d -m 0750 -o root -g theone "$staging"
while IFS= read -r file; do install -m 0640 -o root -g theone "$file" "$staging/$(basename "$file")"; done < <(find "$source_directory" -maxdepth 1 -type f -name 'codex-macos-*.tar.gz' -print)
install -m 0640 -o root -g theone "$source_directory/catalog.json" "$staging/catalog.json"
awk '!/^ONE_EXECUTOR_MANIFEST_PATH=/ && !/^ONE_EXECUTOR_PUBLIC_KEY=/ && !/^ONE_EXECUTOR_DOWNLOAD_ORIGINS=/' "$env_file" > "$env_next"
printf '%s\n' 'ONE_EXECUTOR_MANIFEST_PATH=/srv/theone/shared/codex-tools/catalog.json' "ONE_EXECUTOR_PUBLIC_KEY=$ONE_EXECUTOR_PUBLIC_KEY" 'ONE_EXECUTOR_DOWNLOAD_ORIGINS=https://theone.aiarrival.cn' >> "$env_next"
chown theone:theone "$env_next"; chmod 0600 "$env_next"; cp -p -- "$env_file" "$env_backup"
# Reuse the deployment drain check before a restart; never interrupt live work.
node "$app_root/current/deploy/check-mysql-schema.mjs" --env "$env_file"
if ! curl --fail --silent --max-time 10 http://127.0.0.1:3091/api/health >/dev/null; then echo 'Service health unavailable.' >&2; exit 1; fi
if [[ -d "$previous" ]]; then echo 'Previous tools backup exists; preserve it before publishing another release.' >&2; exit 1; fi
if [[ -d "$target" ]]; then mv -- "$target" "$previous"; fi
activated=true
mv -- "$staging" "$target"; mv -- "$env_next" "$env_file"
systemctl restart theone.service
healthy=false
for _ in $(seq 1 30); do if curl --fail --silent --max-time 2 http://127.0.0.1:3091/api/health >/dev/null; then healthy=true; break; fi; sleep 1; done
if [[ "$healthy" != true ]]; then echo 'Service unhealthy; restoring previous tools.' >&2; exit 1; fi
rm -f -- "$env_backup"
activated=false; trap - EXIT
echo 'Codex tools published. Gateway/model/pricing settings were not enabled or changed.'
