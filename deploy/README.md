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
