# Installer — Log Dashboard on a WHM/cPanel server

This is the step-by-step guide to get **log-dashboard** running on a fresh
WHM/cPanel server after cloning this repository. It is written to be followed
top-to-bottom by someone who has just SSH'd into the box as `root`.

> **Canonical install path: `~/log-dashboard` (i.e. `/root/log-dashboard`).**
> Everything below — and the bundled `systemd` unit — assumes this exact path.
> Do not clone it elsewhere unless you are prepared to edit every `/root/log-dashboard`
> reference in `log-dashboard.service`.

The dashboard is **read-only**: it discovers and streams Apache/cPanel log files
under `/home/*`. It never modifies logs. The only thing it ever writes is its own
per-account notification settings under `data/`.

---

## 0. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| Root SSH access | Reads account log files under `/home` (mode `711` homes need root + a capability) | `whoami` → `root` |
| WHM/cPanel server (RHEL/AlmaLinux/CloudLinux 8/9) | Where the Apache/domain logs live | `cat /etc/redhat-release` |
| `systemd` | Runs the dashboard as a hardened service | `systemctl --version` |
| Node.js **≥ 18** (20 or 22 LTS recommended) | Runtime | `node --version` |
| `git` | To clone/update | `git --version` |
| An open TCP port (default **3212**) | Where the UI is served | see firewall step |

### 0.1 Install Node.js (if `node --version` is missing or < 18)

cPanel ships its own Node via `ea-nodejs`, but the simplest portable route is
NodeSource. Pick **one**:

```bash
# Option A — NodeSource (Node 20 LTS)
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Option B — cPanel EA4 Node (then symlink so `node` is on PATH)
dnf install -y ea-nodejs20
ln -sf /opt/cpanel/ea-nodejs20/bin/node /usr/local/bin/node
ln -sf /opt/cpanel/ea-nodejs20/bin/npm  /usr/local/bin/npm
```

Verify:

```bash
node --version   # must print v18.x or newer
npm --version
```

> The `systemd` unit calls `/usr/bin/node`. If your `node` lives elsewhere
> (`which node`), either symlink it (`ln -sf "$(which node)" /usr/bin/node`) or
> edit `ExecStart=` in `log-dashboard.service` to the full path.

---

## 1. Clone the repository to `~/log-dashboard`

```bash
cd ~
git clone git@github.com:vhamed02/whm-log-dashboard.git log-dashboard
cd ~/log-dashboard
```

If SSH deploy keys are not set up on this box, use HTTPS instead:

```bash
git clone https://github.com/vhamed02/whm-log-dashboard.git ~/log-dashboard
```

Confirm you landed in the right place:

```bash
pwd        # -> /root/log-dashboard
ls         # -> server.js  lib/  public/  .env.example  log-dashboard.service ...
```

---

## 2. Install dependencies

The only runtime dependency is Fastify (pinned in `package-lock.json`).

```bash
cd ~/log-dashboard
npm ci --omit=dev     # reproducible install from the lockfile
# (use `npm install --omit=dev` if you don't have a lockfile match)
```

Sanity-check that every source file parses:

```bash
npm run check         # node --check across server.js and lib/*
```

---

## 3. Create and fill in `.env`

The repo intentionally does **not** contain `.env` (it holds the auth password
and, optionally, the Brevo API key — it is git-ignored). Create it from the
template:

```bash
cp .env.example .env
chmod 600 .env        # keep credentials root-only
```

Now edit `.env` and set, at minimum:

```ini
LD_USER=admin
LD_PASS=<a long random string, >= 16 chars>     # REQUIRED — see below
LD_HOST=0.0.0.0        # or 127.0.0.1 if fronting with a reverse proxy
LD_PORT=3212
LD_HOME_ROOT=/home     # top-level root the walker is constrained to
```

Generate a strong password quickly:

```bash
openssl rand -base64 24
```

> **The server refuses to boot if `LD_PASS` is unset, `changeme`, or shorter
> than 8 characters.** This is deliberate — the dashboard exposes server logs.
> To run without auth on purpose (e.g. bound to loopback behind a trusted
> reverse proxy), set `LD_ALLOW_NO_AUTH=1`. Do not do this on a public port.

Email notifications stay **fully disarmed** (`LD_NOTIFY_ENABLED=0`) out of the
box — no email can leave the box until you opt in. You can configure them later
(see §7). Every other `LD_*` knob has a sane default and is documented inline in
`.env.example`.

---

## 4. First run in the foreground (smoke test)

Before installing the service, confirm it boots and can see your accounts:

```bash
cd ~/log-dashboard
set -a; . ./.env; set +a      # load .env into this shell
node server.js
```

You should see:

```
log-dashboard listening on http://0.0.0.0:3212
```

In a second terminal (or from your workstation over an SSH tunnel), verify auth
and discovery work — replace the credentials with your `.env` values:

```bash
curl -s -u admin:'YOUR_LD_PASS' http://127.0.0.1:3212/accounts | head
```

You should get back a JSON list of cPanel accounts. If it is empty, jump to
§8 Troubleshooting (it is almost always the home-directory permission issue).

Stop the foreground process with `Ctrl-C` once you're satisfied.

---

## 5. Install as a systemd service

The bundled `log-dashboard.service` runs the app hardened: no new privileges,
read-only `/home`, `data/` as the single writable path, and exactly one Linux
capability (`CAP_DAC_READ_SEARCH`) so the read-only walker can traverse
mode-`711` cPanel home directories.

```bash
cd ~/log-dashboard

# 1. Install the unit (it already points at /root/log-dashboard)
cp log-dashboard.service /etc/systemd/system/log-dashboard.service

# 2. Reload systemd and enable at boot
systemctl daemon-reload
systemctl enable --now log-dashboard

# 3. Confirm it's up
systemctl status log-dashboard --no-pager
journalctl -u log-dashboard -n 30 --no-pager
```

> If you cloned to a path other than `/root/log-dashboard`, edit the unit's
> `WorkingDirectory=`, `EnvironmentFile=`, `ExecStart=`, and `ReadWritePaths=`
> before copying it, then `systemctl daemon-reload`.

---

## 6. Open the firewall / reach the UI

The dashboard listens on `LD_PORT` (default **3212**). Allow it on whichever
firewall the box runs:

```bash
# firewalld (common on AlmaLinux/CloudLinux)
firewall-cmd --permanent --add-port=3212/tcp && firewall-cmd --reload

# csf (common on WHM boxes) — add 3212 to TCP_IN, then:
csf -r
```

Then browse to `http://SERVER_IP:3212` and log in with `LD_USER` / `LD_PASS`.

**Recommended (do not expose 3212 to the world):** keep `LD_HOST=127.0.0.1` and
either use an SSH tunnel:

```bash
ssh -L 3212:127.0.0.1:3212 root@SERVER_IP    # then open http://localhost:3212
```

or front it with Apache/nginx + a real TLS certificate. Basic-auth over plain
HTTP sends the password reversibly — always put TLS in front for remote access.

---

## 7. (Optional) Enable email notifications

Notifications are off until you deliberately arm them. To enable digest emails via
**Brevo** (transactional email) — each account picks its own frequency in the UI
(every hour / 3h / 6h / 12h / daily / weekly / monthly):

1. In `.env`, set `LD_RECIPIENTS` to the real people who may receive digests —
   comma-separated `id:Name:email` entries, e.g.
   `LD_RECIPIENTS="joao:Joao Rosa:joao@example.com,ops:On-call:ops@example.com"`
   (quote the value so names with spaces survive).
   Keeping them in `.env` (git-ignored) means real addresses never land in the
   public repo. Keep each `id` stable once accounts have subscribed to it.
2. In Brevo → **SMTP & API → API keys**, create a key. Verify a sender
   address/domain under **Senders**.
3. In `.env` set:
   ```ini
   LD_NOTIFY_ENABLED=1
   LD_BREVO_API_KEY=xkeysib-...
   LD_BREVO_SENDER_EMAIL=alerts@your-verified-domain.tld
   LD_BREVO_SENDER_NAME=Log Dashboard
   ```
4. Restart: `systemctl restart log-dashboard`.

> The server **refuses to boot** with `LD_NOTIFY_ENABLED=1` while the API key or
> sender email is missing — it can never look "armed" while unable to send.
> While disarmed (`=0`) it still watches, classifies, and logs a "would have sent"
> summary at each account's chosen interval, so you can dry-run safely.
> `LD_NOTIFY_INTERVAL_MS` is now just the base tick / default cadence — the actual
> per-account frequency is set in the modal and stored in `data/notifications.json`.

Per-account recipient/severity selections are made in the UI and persisted to
`~/log-dashboard/data/notifications.json` (the only writable path under systemd).

---

## 7b. (Optional, recommended) Require an Apache `.htaccess` gateway

This adds an outer layer so the app **refuses to run unless it is behind an
Apache `.htaccess` login**. Apache does the human Basic-Auth, then proves each
request passed it by injecting a shared secret + the authenticated username; the
app verifies both on every request and fails safe when the protection is missing.

**1. Bind the app to loopback** so nothing but Apache can reach it — in `.env`:
```ini
LD_HOST=127.0.0.1
LD_PORT=3212
```

**2. Create the login file** (`.htpasswd`) and a gateway secret:
```bash
mkdir -p /etc/log-dashboard
htpasswd -c /etc/log-dashboard/.htpasswd alice      # add more: htpasswd (no -c)
openssl rand -hex 24                                 # copy this secret
```

**3. Drop in the `.htaccess`** (template in the repo: `.htaccess.example`) at the
docroot Apache serves for this vhost, e.g. `/var/www/log-dashboard/.htaccess`:
```apache
AuthType Basic
AuthName "Log Dashboard"
AuthUserFile "/etc/log-dashboard/.htpasswd"
Require valid-user

<IfModule mod_headers.c>
  RequestHeader unset X-LD-Gateway
  RequestHeader unset X-LD-User
  RequestHeader set   X-LD-Gateway "PASTE_THE_openssl_SECRET_HERE"
  RequestHeader set   X-LD-User    "expr=%{REMOTE_USER}"
</IfModule>
```

**4. Proxy to the app in the vhost** (proxy directives are not allowed in
`.htaccess`). Needs `mod_proxy`, `mod_proxy_http`, `mod_headers`:
```apache
<VirtualHost *:80>
    ServerName logs.example.com
    DocumentRoot /var/www/log-dashboard
    <Directory /var/www/log-dashboard>
        AllowOverride AuthConfig FileInfo
        Require all granted
    </Directory>
    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3212/
    ProxyPassReverse / http://127.0.0.1:3212/
</VirtualHost>
```

**5. Point the app at the protection and arm it** — in `.env`:
```ini
LD_HTACCESS_REQUIRED=1
LD_HTACCESS_SECRET=the_same_openssl_secret
LD_HTACCESS_FILE=/var/www/log-dashboard/.htaccess
# LD_HTPASSWD_FILE=/etc/log-dashboard/.htpasswd   # only if not in the .htaccess
```

**6. Reload both:**
```bash
apachectl configtest && systemctl reload httpd    # or apache2
systemctl restart log-dashboard
```

Now: a request straight to `127.0.0.1:3212` (no secret) gets **403**; a request
that skipped the `.htaccess` login gets **403**; deleting/weakening the
`.htaccess` while running locks the app to **503** within `LD_HTACCESS_RECHECK_MS`;
and a missing/misconfigured setup makes the app **refuse to boot**. The app's own
`LD_PASS` Basic-Auth still applies underneath — to avoid a double login prompt,
set `LD_ALLOW_NO_AUTH=1` (safe here: the gateway secret is now the access proof).

> The `.htaccess` and `.htpasswd` are git-ignored (they hold the secret and
> credentials). Only `.htaccess.example` is tracked.

---

## 8. Troubleshooting

**The account/log list is empty (but no error).**
This is the classic cPanel case: home directories are mode `711` (`drwx--x--x`),
so even `root` cannot `readdir()` them without `CAP_DAC_READ_SEARCH`.
- Under **systemd** this is already granted by the unit — confirm with
  `systemctl show log-dashboard -p AmbientCapabilities`.
- Running **by hand** as root should also work; if not, check `LD_HOME_ROOT`
  actually points at where accounts live (`/home`), and that the paths exist.

**`LD_PASS is unset or too short` on boot.**
Set a strong `LD_PASS` (≥ 8, ideally ≥ 16 chars) in `.env`, or set
`LD_ALLOW_NO_AUTH=1` to intentionally run without auth. Then restart.

**`LD_NOTIFY_ENABLED=1 but LD_BREVO_API_KEY/SENDER is unset`.**
Fill in the Brevo key and a verified sender, or set `LD_NOTIFY_ENABLED=0`.

**Everything returns 403 after enabling the `.htaccess` gateway (§7b).**
The app isn't seeing valid gateway headers. Check: the `X-LD-Gateway` value in the
`.htaccess` byte-for-byte equals `LD_HTACCESS_SECRET`; `mod_headers` is enabled
(`RequestHeader` is silently ignored otherwise); and requests really go through
Apache, not straight to the Node port. The app log line `[htaccess] enforcement
ARMED` confirms the mode is on.

**Everything returns 503 with the gateway enabled.**
The app has **locked** because the `.htaccess`/`.htpasswd` failed re-validation —
the log says why (e.g. file removed, `Require valid-user` dropped, empty
`.htpasswd`). Restore the protection; it unlocks within `LD_HTACCESS_RECHECK_MS`.

**Refuses to boot: `[htaccess] refusing to start …`.**
`LD_HTACCESS_REQUIRED=1` but the protection is missing/misconfigured (no
`LD_HTACCESS_SECRET`, or the configured `LD_HTACCESS_FILE` is invalid). Fix it, or
set `LD_HTACCESS_REQUIRED=0` to disable the layer.

**`node: command not found` from systemd.**
`ExecStart=` uses `/usr/bin/node`. Point it at your real binary:
`ln -sf "$(which node)" /usr/bin/node` (or edit the unit) then
`systemctl daemon-reload && systemctl restart log-dashboard`.

**Notification settings won't save / "data dir not writable" warning.**
`data/` must be writable. Under systemd it must appear in `ReadWritePaths=`
(it does by default). If you moved the install, update that path in the unit.

**Can't reach the port from your browser.**
Check the firewall step (§6), confirm `LD_HOST` isn't `127.0.0.1` if you're
connecting remotely, and verify with `ss -ltnp | grep 3212` on the server.

**Read the live logs:**
```bash
journalctl -u log-dashboard -f
```

---

## 9. Updating to a newer version

```bash
cd ~/log-dashboard
git pull
npm ci --omit=dev            # only if dependencies changed
systemctl restart log-dashboard
journalctl -u log-dashboard -n 20 --no-pager
```

Your `.env` and `data/` are git-ignored, so a `git pull` never touches your
credentials or saved settings.

---

## 10. Uninstall

```bash
systemctl disable --now log-dashboard
rm /etc/systemd/system/log-dashboard.service
systemctl daemon-reload
rm -rf ~/log-dashboard        # removes code, .env, and saved settings
```

---

## Quick reference

| Action | Command |
|---|---|
| Start / stop / restart | `systemctl {start,stop,restart} log-dashboard` |
| Status | `systemctl status log-dashboard` |
| Follow logs | `journalctl -u log-dashboard -f` |
| Edit config | `nano ~/log-dashboard/.env` then `systemctl restart log-dashboard` |
| Update | `cd ~/log-dashboard && git pull && systemctl restart log-dashboard` |
| Default URL | `http://SERVER_IP:3212` (login with `LD_USER` / `LD_PASS`) |
</content>
</invoke>
