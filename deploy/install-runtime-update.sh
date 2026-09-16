#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

source_directory="${1:-}"
app_root=/srv/theone
target="$app_root/shared/runtime-updates"
staging="$app_root/shared/.runtime-updates.$$.next"
previous="$app_root/shared/runtime-updates.previous"
env_file="$app_root/shared/.env"
env_next="$app_root/shared/.env.runtime-update.$$.next"
env_backup="$app_root/shared/.env.runtime-update.$$.backup"
activated=false

if [[ -z "$source_directory" || ! -d "$source_directory" || ! -f "$source_directory/stable.json" ]]; then
  echo "Usage: sudo bash deploy/install-runtime-update.sh /path/to/signed-release-directory" >&2
  exit 2
fi
if [[ ! -f "$env_file" ]]; then
  echo "ONE environment file is missing: $env_file" >&2
  exit 2
fi

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

node "$app_root/current/scripts/verify-runtime-update.mjs" \
  --manifest "$source_directory/stable.json" \
  --public-key "$app_root/current/config/runtime-update-public-key.txt"

install -d -m 0750 -o root -g theone "$staging"
while IFS= read -r source; do
  install -m 0640 -o root -g theone "$source" "$staging/$(basename "$source")"
done < <(find "$source_directory" -maxdepth 1 -type f \( -name 'one-macos-*.zip' -o -name 'one-windows-*.exe' \) -print)
install -m 0640 -o root -g theone "$source_directory/stable.json" "$staging/stable.json"

awk '!/^ONE_UPDATE_DIRECTORY=/ && !/^ONE_UPDATE_MANIFEST_PATH=/ && !/^ONE_UPDATE_PUBLIC_KEY=/' "$env_file" > "$env_next"
printf '%s\n' \
  'ONE_UPDATE_DIRECTORY=/srv/theone/shared/runtime-updates' \
  'ONE_UPDATE_MANIFEST_PATH=/srv/theone/shared/runtime-updates/stable.json' \
  "ONE_UPDATE_PUBLIC_KEY=$(tr -d '\r\n' < "$app_root/current/config/runtime-update-public-key.txt")" \
  >> "$env_next"
chown theone:theone "$env_next"
chmod 0600 "$env_next"
cp -p -- "$env_file" "$env_backup"

if [[ -d "$previous" ]]; then rm -rf -- "$previous"; fi
if [[ -d "$target" ]]; then mv -- "$target" "$previous"; fi
activated=true
mv -- "$staging" "$target"
mv -- "$env_next" "$env_file"

systemctl restart theone.service
healthy=false
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3091/api/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  echo "ONE health check failed; restoring previous runtime release" >&2
  exit 1
fi
rm -f -- "$env_backup"
activated=false
trap - EXIT
echo "ONE runtime update published. Previous release: $previous"
