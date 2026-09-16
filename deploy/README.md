# ONE production deployment

Production uses one isolated systemd service behind the server's existing Nginx:

- app user: `theone`
- deploy-only SSH user: `theone-deploy`
- root directory: `/srv/theone`
- loopback address: `127.0.0.1:3091`
- service: `theone.service`
- hostname: `theone.aiarrival.cn`

`bootstrap-ubuntu.sh` installs only ONE-owned files. It does not replace the
server's Nginx configuration, Docker setup, PM2 processes, or other sites.

## First-time setup

1. Point `theone.aiarrival.cn` to the server.
2. Run `sudo bash deploy/bootstrap-ubuntu.sh` from a checkout of this repository.
3. Set production secrets in `/srv/theone/shared/.env`; keep it mode `0600` and
   owned by `theone`.
4. Add a dedicated Ed25519 public key to
   `/home/theone-deploy/.ssh/authorized_keys` with:

   ```text
   restrict,command="/usr/local/sbin/theone-deploy-gate" ssh-ed25519 PUBLIC_KEY github-actions-theone
   ```

5. Add `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, and
   `DEPLOY_KNOWN_HOSTS` as GitHub Actions repository secrets.
6. Set the GitHub Actions repository variable `DEPLOY_ENABLED` to `true`, then
   trigger the `Deploy production` workflow.
7. After DNS resolves and HTTP works, issue a TLS certificate for the exact
   hostname and verify WebSocket access through HTTPS.

Each deployment is built and tested in a new release directory. The `current`
symlink changes atomically. A failed health check restores the previous release,
and only the five latest releases are retained.

## Launcher / Bridge updates

Launcher updates use a signing key that is independent from login credentials.
The public key is committed at `config/runtime-update-public-key.txt`; the only
private key is stored outside the repository at:

```text
~/Library/Application Support/ONE Release/runtime-update-private.pem
```

Back that private key up to the operator's encrypted offline storage before the
first batch ships. Never copy it to the server, GitHub Actions, a ONE Key, or
the application `.env`. Losing it means already shipped launchers cannot trust
new releases; leaking it requires an emergency launcher replacement.

Build both launchers, then create a signed immutable release directory:

```bash
npm run release:one-runtime -- \
  --private-key "$HOME/Library/Application Support/ONE Release/runtime-update-private.pem" \
  --mac-app /path/to/ONE.app \
  --windows-exe /path/to/ONE.exe \
  --version 0.3.1 \
  --output /path/to/one-runtime-0.3.1
```

Copy that complete directory to a temporary server path, verify it again and
atomically publish it:

```bash
sudo bash /srv/theone/current/deploy/install-runtime-update.sh /tmp/one-runtime-0.3.1
```

The installer verifies the package again, atomically publishes it and adds
these non-secret settings to `/srv/theone/shared/.env`. The first publication
restarts only `theone.service` so it can load the channel configuration. Later
launcher-only publications keep the service running: the manifest is loaded on
demand from the same stable path. A failed health check rolls the release and
environment back:

```text
ONE_UPDATE_DIRECTORY=/srv/theone/shared/runtime-updates
ONE_UPDATE_MANIFEST_PATH=/srv/theone/shared/runtime-updates/stable.json
ONE_UPDATE_PUBLIC_KEY=ck7I5vQpOjJ-b6axzxhQJAb6-ACoV_y6hJ_DUB4MAMs
```

The server receives only signed artifacts and keeps the previous published
directory at `/srv/theone/shared/runtime-updates.previous`. To roll back the
offered release, move that directory back into place; do not re-sign or edit a
published `stable.json`.

## First local MySQL cutover

The server's existing databases are not reused. After deploying the release that
contains the relational store, run once:

```bash
sudo bash /srv/theone/current/deploy/configure-local-mysql.sh
```

The script creates only `theone_prod` and `theone_app@127.0.0.1`, snapshots the
current environment and `db.json`, imports the existing ONE state on first boot,
then verifies the health endpoint and row counts. If the health check fails it
restores the JSON configuration automatically. Keep the printed snapshot path
until the MySQL backup and restore drill has passed.

It also enables a nightly compressed backup with 14-day local retention. Local
copies protect against application mistakes but not loss of the whole server.
Before the external pilot, install an executable
`/srv/theone/shared/backup-upload`; it receives the dump and checksum paths and
must upload both to a private COS bucket. This keeps COS credentials outside the
repository and makes a failed off-site copy fail the backup job visibly.

### Tencent COS without permanent keys

Create a private COS bucket in `ap-nanjing`, then bind a least-privilege CAM role
to the CVM. COSCLI obtains rotating temporary credentials from the instance role,
so no SecretId or SecretKey is stored on disk. After the role is attached, run:

```bash
sudo bash /srv/theone/current/deploy/setup-cos-backup.sh BUCKET-NAME-WITH-APPID CVM-ROLE-NAME
```

The setup downloads the Linux amd64 COSCLI from Tencent Cloud's mainland mirror,
verifies its published SHA-256 checksum, installs a
role-based configuration, enables the pre-existing upload hook, creates a fresh
database backup and confirms both the dump and SHA-256 file exist remotely under
`production/mysql/`. Uploads request COS-managed AES-256 encryption and never
grant the CVM permission to download or delete backups. Start from
`deploy/cos-backup-cam-policy.template.json` when creating the CAM policy.
