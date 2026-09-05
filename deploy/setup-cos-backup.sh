#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi
if [[ "$#" -ne 2 ]]; then
  echo "Usage: setup-cos-backup.sh BUCKET-NAME-WITH-APPID CVM-ROLE-NAME" >&2
  exit 2
fi

bucket_name="$1"
role_name="$2"
app_root="/srv/theone"
config_file="$app_root/shared/cos-backup.yaml"
binary_url="https://cosbrowser.cloud.tencent.com/software/coscli/coscli-linux-amd64"
binary_sha256="a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915"

[[ "$bucket_name" =~ ^[a-z0-9][a-z0-9-]*-[0-9]+$ ]] || { echo "Bucket must include its APPID suffix, for example theone-backup-1250000000." >&2; exit 2; }
[[ "$role_name" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "Unexpected CVM role name." >&2; exit 2; }
[[ -x "$app_root/current/deploy/cos-backup-upload" ]] || { echo "Deploy the current ONE release first." >&2; exit 1; }

tmp_binary="$(mktemp)"
trap 'rm -f "$tmp_binary"' EXIT
curl --fail --location --silent --show-error --connect-timeout 10 --max-time 120 "$binary_url" --output "$tmp_binary"
if ! printf '%s  %s\n' "$binary_sha256" "$tmp_binary" | sha256sum --check --status; then
  echo "Downloaded COSCLI did not match Tencent Cloud's published SHA-256 checksum." >&2
  exit 1
fi
install -m 0755 "$tmp_binary" /usr/local/bin/coscli

cat > "$config_file" <<EOF
cos:
  base:
    mode: CvmRole
    cvmrolename: $role_name
    protocol: https
  buckets:
  - name: $bucket_name
    alias: one-backup
    region: ap-nanjing
    endpoint: cos.ap-nanjing.myqcloud.com
    ofs: false
EOF
chown root:theone "$config_file"
chmod 0640 "$config_file"
install -m 0750 -o root -g theone "$app_root/current/deploy/cos-backup-upload" "$app_root/shared/backup-upload"

sudo -u theone coscli ls cos://one-backup/ --config-path "$config_file" --limit 1 >/dev/null
systemctl start theone-db-backup.service
systemctl --no-pager --full status theone-db-backup.service

echo "COS off-site backup is active for cos://one-backup/production/mysql/."
