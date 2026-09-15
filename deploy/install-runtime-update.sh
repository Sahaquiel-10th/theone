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

if [[ -z "$source_directory" || ! -d "$source_directory" || ! -f "$source_directory/stable.json" ]]; then
  echo "Usage: sudo bash deploy/install-runtime-update.sh /path/to/signed-release-directory" >&2
  exit 2
fi

cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT

node "$app_root/current/scripts/verify-runtime-update.mjs" \
  --manifest "$source_directory/stable.json" \
  --public-key "$app_root/current/config/runtime-update-public-key.txt"

install -d -m 0750 -o root -g theone "$staging"
while IFS= read -r source; do
  install -m 0640 -o root -g theone "$source" "$staging/$(basename "$source")"
done < <(find "$source_directory" -maxdepth 1 -type f \( -name 'one-macos-*.zip' -o -name 'one-windows-*.exe' \) -print)
install -m 0640 -o root -g theone "$source_directory/stable.json" "$staging/stable.json"

if [[ -d "$previous" ]]; then rm -rf -- "$previous"; fi
if [[ -d "$target" ]]; then mv -- "$target" "$previous"; fi
mv -- "$staging" "$target"
trap - EXIT

if ! curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3091/api/health >/dev/null; then
  echo "ONE health check failed; restoring previous runtime release" >&2
  rm -rf -- "$target"
  if [[ -d "$previous" ]]; then mv -- "$previous" "$target"; fi
  exit 1
fi
echo "ONE runtime update published. Previous release: $previous"
