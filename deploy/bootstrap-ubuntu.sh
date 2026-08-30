#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this bootstrap with sudo." >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

id -u theone >/dev/null 2>&1 || useradd --system --home-dir /srv/theone --shell /usr/sbin/nologin theone
id -u theone-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash theone-deploy

install -d -m 0755 /srv/theone /srv/theone/releases /srv/theone/incoming
install -d -m 0750 -o theone -g theone /srv/theone/shared /srv/theone/shared/data /srv/theone/shared/data/uploads
chown theone-deploy:theone-deploy /srv/theone/incoming

install -m 0755 "$repo_dir/deploy/theone-deploy" /usr/local/sbin/theone-deploy
install -m 0755 "$repo_dir/deploy/theone-deploy-gate" /usr/local/sbin/theone-deploy-gate
install -m 0644 "$repo_dir/deploy/theone.service" /etc/systemd/system/theone.service
printf 'theone-deploy ALL=(root) NOPASSWD: /usr/local/sbin/theone-deploy *\n' > /etc/sudoers.d/theone-deploy
chmod 0440 /etc/sudoers.d/theone-deploy
visudo -cf /etc/sudoers.d/theone-deploy >/dev/null

if [[ ! -f /srv/theone/shared/.env ]]; then
  install -m 0600 -o theone -g theone "$repo_dir/.env.example" /srv/theone/shared/.env
  jwt_secret="$(openssl rand -hex 48)"
  credential_key="$(openssl rand -hex 32)"
  initial_password="$(openssl rand -base64 24 | tr -d '/+=')"
  sed -i \
    -e "s/^JWT_SECRET=.*/JWT_SECRET=$jwt_secret/" \
    -e "s/^PROVIDER_CREDENTIALS_KEY=.*/PROVIDER_CREDENTIALS_KEY=$credential_key/" \
    -e "s/^ADMIN_INITIAL_PASSWORD=.*/ADMIN_INITIAL_PASSWORD=$initial_password/" \
    /srv/theone/shared/.env
  printf '%s\n' "$initial_password" > /root/theone-initial-admin-password
  chmod 0600 /root/theone-initial-admin-password
fi

if [[ -e /etc/nginx/sites-enabled/theone.conf || -e /etc/nginx/sites-available/theone.conf ]]; then
  echo "Existing ONE Nginx config found; leaving it unchanged."
else
  if grep -RqsE 'server_name[[:space:]]+theone\.aiarrival\.cn([[:space:];]|$)' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null; then
    echo "theone.aiarrival.cn is already declared by another Nginx config; aborting." >&2
    exit 1
  fi
  install -m 0644 "$repo_dir/deploy/nginx-one.conf" /etc/nginx/sites-available/theone.conf
  ln -s /etc/nginx/sites-available/theone.conf /etc/nginx/sites-enabled/theone.conf
fi

nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl enable theone.service >/dev/null

echo "Bootstrap complete. Configure /srv/theone/shared/.env before the first deployment."
echo "The generated initial admin password is in /root/theone-initial-admin-password."
