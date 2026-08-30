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
