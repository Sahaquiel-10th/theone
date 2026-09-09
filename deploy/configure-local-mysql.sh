#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

app_root="/srv/theone"
env_file="$app_root/shared/.env"
schema_file="$app_root/current/deploy/migrations/001-relational-records.sql"
migration_dir="$app_root/current/deploy/migrations"
data_file="$app_root/shared/data/db.json"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot_dir="$app_root/shared/migration-backups/$stamp"

[[ -f "$env_file" ]] || { echo "Missing $env_file" >&2; exit 1; }
[[ -f "$schema_file" ]] || { echo "Missing $schema_file; deploy the current ONE release first." >&2; exit 1; }

if grep -q '^DB_PROVIDER=mysql$' "$env_file"; then
  echo "ONE already uses MySQL; refusing to repeat the initial cutover." >&2
  exit 1
fi

command -v mysql >/dev/null || { echo "mysql client is not installed." >&2; exit 1; }
install -d -m 0750 -o root -g theone "$snapshot_dir"
cp -a "$env_file" "$snapshot_dir/.env.before-mysql"
[[ ! -f "$data_file" ]] || cp -a "$data_file" "$snapshot_dir/db.json"

db_password="$(openssl rand -hex 32)"
mysql < "$schema_file"
for migration in "$migration_dir"/*.sql; do
  [[ "$migration" == "$schema_file" ]] || mysql < "$migration"
done
mysql --execute="CREATE USER IF NOT EXISTS 'theone_app'@'127.0.0.1' IDENTIFIED BY '$db_password'; ALTER USER 'theone_app'@'127.0.0.1' IDENTIFIED BY '$db_password'; GRANT SELECT, INSERT, UPDATE, DELETE ON theone_prod.* TO 'theone_app'@'127.0.0.1'; FLUSH PRIVILEGES;"

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

set_env MYSQL_HOST 127.0.0.1
set_env MYSQL_PORT 3306
set_env MYSQL_USER theone_app
set_env MYSQL_PASSWORD "$db_password"
set_env MYSQL_DATABASE theone_prod
set_env MYSQL_CONNECTION_LIMIT 10
set_env MYSQL_AUTO_MIGRATE false
set_env DB_PROVIDER mysql
chown theone:theone "$env_file"
chmod 0600 "$env_file"

rollback() {
  echo "MySQL health check failed; restoring the previous JSON configuration." >&2
  cp -a "$snapshot_dir/.env.before-mysql" "$env_file"
  chown theone:theone "$env_file"
  chmod 0600 "$env_file"
  systemctl restart theone.service
}
trap rollback ERR

systemctl restart theone.service
for _ in {1..20}; do
  if curl --fail --silent --show-error http://127.0.0.1:3091/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:3091/api/health >/dev/null

MYSQL_PWD="$db_password" mysql --host=127.0.0.1 --user=theone_app --database=theone_prod --batch --skip-column-names \
  --execute="SELECT CONCAT('users=', COUNT(*)) FROM users; SELECT CONCAT('workspaces=', COUNT(*)) FROM workspaces; SELECT CONCAT('conversations=', COUNT(*)) FROM conversations; SELECT CONCAT('messages=', COUNT(*)) FROM messages;"

install -d -m 0750 -o theone -g theone "$app_root/shared/backups/mysql"
backup_defaults="$app_root/shared/mysql-backup.cnf"
printf '[client]\nhost=127.0.0.1\nuser=theone_app\npassword=%s\n' "$db_password" > "$backup_defaults"
chown root:theone "$backup_defaults"
chmod 0640 "$backup_defaults"
install -m 0644 "$app_root/current/deploy/theone-db-backup.service" /etc/systemd/system/theone-db-backup.service
install -m 0644 "$app_root/current/deploy/theone-db-backup.timer" /etc/systemd/system/theone-db-backup.timer
systemctl daemon-reload
systemctl enable --now theone-db-backup.timer >/dev/null
systemctl start theone-db-backup.service

trap - ERR
echo "ONE now uses theone_prod. Rollback snapshot: $snapshot_dir"
