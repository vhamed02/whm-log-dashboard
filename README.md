# log-dashboard

A **read-only**, streaming web dashboard for viewing cPanel/Apache logs on a
WHM server. Designed to be lightweight and production-safe on a live box.

## Architecture (final)

```
            ┌─────────────────────────────────────────────────────┐
  Browser   │  vanilla JS SPA (virtualized viewer)               │
   (:3212)  │  EventSource(/stream) + EventSource(/search)       │
            └───────────────┬─────────────────────────▲──────────┘
                            │  SSE (chunked)           │
                  ┌─────────▼─────────────────────────┴──────────┐
   Fastify (4.x) │  Basic Auth onRequest hook                      │
   server        │  Routes: /accounts /logs /stream /search /refresh│
   0.0.0.0:3212  └───┬───────────────┬─────────────────────┬──────┘
                    │               │                     │
            ┌───────▼──────┐  ┌──────▼───────┐    ┌─────────▼─────────┐
            │ discovery.js │  │  stream.js   │    │  security.js       │
            │ TTL cache of │  │ reverse tail │    │ account regex,     │
            │ PATHS ONLY   │  │ shared live  │    │ realpath-recheck,  │
            │ (no content) │  │ tail (poll), │    │ opaque ID → path    │
            │              │  │ search scan  │    │ resolve-under-home  │
            └──────────────┘  └──────────────┘    └────────────────────┘
```

**Constraints enforced:**
- No database. No persistence. No log ingestion. No indexing.
- Cache stores **file paths only**, never content. TTL configurable (default 8 min).
- All log reads are streaming:
  - *Initial view*: backwards line reader from EOF, bounded by `LD_INITIAL_TAIL_BYTES` (256 KB default) and `LD_INITIAL_MAX_LINES` (500). Multi-GB safe — only the tail window is read.
  - *Live tail*: a single poller per file polls file size on an interval (`LD_TAIL_POLL_MS`, default 1 s). When the file grows, **only the newly appended bytes are read once**, then complete new lines are fanned out to every attached SSE listener. No `fs.watch`/inotify pressure; no per-client file duplication.
  - *Search*: `createReadStream`-style `fs.open`+`read` scan per discovered log file, line-by-line, generator-yielded matches streamed via SSE. A per-file byte cap (`LD_SEARCH_MAX_BYTES_PER_FILE`, default 256 MB) scans the newest bytes of very large files to protect the live box.
- Disk → server → HTTP → DOM is streaming end-to-end. The DOM only ever renders the visible window + small overscan (virtualized).

## Stack choice (with justification)

- **Node.js + Fastify (4.x)** — Fastify's raw `reply.raw` + `reply.hijack()` gives clean chunked/SSE streaming with low overhead, schema-validated routes, and a simple hook model for basic auth. Express would work but Fastify is markedly faster on streaming hot paths. Raw `http` would force reimplementing routing/auth/parsing — not justified.
- **Vanilla JS frontend** — virtualized rendering of a live log requires tight control of the visible window. HTMX renders server fragments; using it per scroll-tick would hammer the server. A single hand-written scroller is simpler and correct. No build step, no bundler, no framework.
- **No extra infrastructure** — no Redis, no queue, no Docker requirement. One process, systemd-managed.

## Folder structure

```
/root/log-dashboard/
├── .env.example
├── package.json
├── server.js              # Fastify app, auth, routes, SSE handlers
├── log-dashboard.service # systemd unit
├── README.md
├── lib/
│   ├── config.js         # env-driven config + sanity checks, recipient list
│   ├── security.js       # account regex, realpath recheck, opaque IDs
│   ├── discovery.js      # cPanel account list + TTL-cached log path discovery
│   ├── stream.js         # reverse line reader, shared live-tail, search scan, normalization
│   ├── notify-store.js   # per-account notification settings (atomic JSON persistence)
│   ├── notifier.js       # background watcher, digest buffer, email composition
│   └── brevo.js          # Brevo transactional-email transport (the only sender)
├── data/
│   └── notifications.json # per-account settings (0600; the only file written)
└── public/
    ├── index.html        # three-panel shell + notification settings modal
    ├── app.js            # virtualized viewer, EventSource wiring, settings UI
    └── style.css
```

## API

| Method | Path | Purpose |
|----|----|----|
| GET  | `/accounts`              | list cPanel users from `/home` (cached; `?force=1` refreshes) |
| GET  | `/logs?account=USER`      | discovered log files for the account, each with an **opaque ID**; raw absolute paths are never returned |
| GET  | `/stream?account=USER&file=ID[&live=1][&severity=LVL]` | SSE: initial newest-first bounded reverse tail, then optional live tail fan-out |
| GET  | `/search?account=USER&query=TEXT[&severity=LVL]` | SSE: streaming scan across the account's logs, matches streamed newest-first |
| POST | `/refresh[?account=USER]` | invalidate discovery cache for an account (or all) and rebuild |
| GET  | `/notify/config`          | recipient list, subscribable severities, and live notifier status (armed?, next digest, buffered counts) |
| GET  | `/notify/settings?account=USER` | that account's saved notification settings |
| PUT  | `/notify/settings?account=USER` | save settings `{enabled, severities[], recipients[], files[]}`; re-syncs watchers immediately |
| GET  | `/notify/preview?account=USER`  | compose the digest that would be sent right now — **does not send, does not clear the buffer** |
| POST | `/notify/test?account=USER`     | send a one-off test email; **403 while disarmed** |
| GET  | `/`, `/app.js`, `/style.css` | the SPA |

## Email notifications

Per-cPanel-account email alerts via Brevo, configured in the UI under **🔔 Notify**
(select an account first). Settings live in `data/notifications.json`.

**How it is configured.** Per account: an on/off switch, which **log types**
(`critical`, `error`, `warning`) to subscribe to, which **receivers** get them,
which **log files** to watch, and how often to send — the **frequency**: every
hour, every 3 / 6 / 12 hours, daily, weekly, or monthly. Severities and receivers
are two independent lists — every ticked severity goes to every ticked receiver.
An account only sends when all four selections are non-empty (enabled + ≥1
severity + ≥1 receiver + ≥1 file); the frequency always has a value (default
hourly).

`info` is deliberately not subscribable: it is the catch-all bucket for
unclassified lines and would make every digest noise.

**How it sends.** A background watcher attaches to each selected file — this is
independent of the browser, and shares the same per-file poller as the live view,
so watching a file costs nothing extra when it is also open on screen. Matching
entries are buffered and deduplicated (entries differing only by timestamp, pid,
memory address or IP collapse into one row with a count), then **one grouped
email per account per chosen interval** goes out to all its receivers in a single
API call. Each account keeps its own cadence; a shared base tick just checks who
is due, and every interval is UTC-boundary aligned (e.g. a 6-hour digest lands at
00:00/06:00/12:00/18:00). `daily`/`weekly`/`monthly` are rolling fixed intervals
(24h / 7d / 30d), not calendar midnight / Monday / the 1st. **A quiet interval
sends no email at all.**

Recipients come from **`LD_RECIPIENTS` in `.env`** — a comma-separated list of
`id:Name:email` entries (e.g. `joao:Joao Rosa:joao@example.com,ops:On-call:ops@example.com`).
Defining them there keeps real addresses out of this public repo and out of any
tracked file, so `git pull` never conflicts with your roster. When unset, the
placeholder list in `lib/config.js` is used. Changing a name or address is safe;
changing an `id` orphans that selection in saved settings.

### Enabling sending (the arm switch)

`LD_NOTIFY_ENABLED` defaults to `0`, and **nothing can be emailed while it is 0** —
`lib/brevo.js` refuses at the transport, so it is a property of the code rather
than a discipline the callers must remember. While disarmed the notifier still
watches, classifies and buffers normally, and at each account's interval logs the
digest it *would* have sent. Use **Preview digest** in the UI to see the exact email.

To go live:

1. Set `LD_BREVO_API_KEY` (Brevo → SMTP & API → API keys).
2. Set `LD_BREVO_SENDER_EMAIL` to a sender **verified in Brevo**, or it will reject the mail.
3. Set `LD_NOTIFY_ENABLED=1`.
4. `systemctl restart log-dashboard`.

The server **refuses to boot** with `LD_NOTIFY_ENABLED=1` while the key or sender
is missing, so it can never look armed while being unable to send. Once armed,
**Send test email** verifies delivery end to end.

### Notification behaviour worth knowing

- **Buffered entries are dropped on restart, not flushed.** Flushing on exit would
  turn a crash-restart loop into an email flood. Up to one interval of alerts can be
  lost to a restart; the logs themselves are of course untouched.
- **Frequency changes take effect within one base tick.** Re-picking an account's
  interval re-arms its schedule to the new cadence's next boundary; the pending
  batch is never sent early because of the change.
- **A failed send keeps its entries** and rolls them into the next digest rather
  than losing them. Only `429`/`5xx` are retried — a timeout is not, since the mail
  may in fact have been delivered and a duplicate digest is worse than a late one.
- **The buffer is bounded** by `LD_NOTIFY_MAX_GROUPS` (200 distinct messages per
  account per digest); beyond that, entries are counted but not grouped, so a
  runaway error loop cannot grow memory without limit.
- **Only lines written after a file is selected** are considered. Enabling
  notifications does not backfill existing log content.
- **Watchers re-sync every 5 minutes** (`LD_NOTIFY_RESYNC_MS`), which is how a log
  file that did not exist when you saved the settings gets picked up later.

## Deployment (systemd)

```sh
cd /root/log-dashboard
npm install --omit=dev
cp .env.example .env
# Edit .env: set a strong LD_PASS (≥ 16 chars), confirm LD_PORT=3212, LD_HOST.
# Email notifications stay DISARMED (LD_NOTIFY_ENABLED=0) until you opt in.
mkdir -p data && chmod 700 data   # per-account notification settings live here
npm run check           # syntax sanity
npm start               # test once manually, Ctrl-C once verified

cp log-dashboard.service /etc/systemd/system/log-dashboard.service
systemctl daemon-reload
systemctl enable --now log-dashboard
systemctl status log-dashboard
journalctl -u log-dashboard -f
```

Visit `http://<server>:3212/` and log in with the basic-auth credentials.

> **Note on the sandbox.** The unit runs `ProtectSystem=strict` + `ProtectHome=read-only`,
> which makes the entire filesystem read-only for the service. `ReadWritePaths=/root/log-dashboard/data`
> punches the single writable hole needed for `notifications.json`. Without it, saving
> notification settings fails with `EROFS`. Log files under `/home` remain strictly
> read-only — nothing in this service can modify them. If you relocate the app or set
> `LD_NOTIFY_DATA_DIR`, update `ReadWritePaths=` to match.

## Performance & security hardening checklist

**Performance**
- [x] No full-file reads anywhere. Initial view is a bounded reverse tail (256 KB / 500 lines default).
- [x] No in-memory buffering of full logs. Each viewer holds an array of *normalized entries it has already seen*; the source file is never held in memory.
- [x] No database, no SQLite FTS, no Elasticsearch/OpenSearch.
- [x] Discovery is TTL-cached and stores **paths only**. Full traversal runs only on cache miss or explicit `/refresh`; never as a background loop.
- [x] Live tail uses **size polling** (no `fs.watch`/inotify fan-out), reads only appended bytes once, and fans lines out to all listeners. The poller self-terminates when the last listener detaches.
- [x] Search scan is stream-yielded per line over a single open per file; caps per-file scanned bytes and total matches (`10000`) to protect the live box.
- [x] Virtualized DOM renders only the visible window + overscan. Scroll-driven render is `requestAnimationFrame`-throttled.
- [x] systemd resource limits: `MemoryMax=512M`, `TasksMax=256`, `LimitNOFILE=4096`.

**Security**
- [x] **Auth**: HTTP Basic Auth enforced globally via an `onRequest` hook (chosen because it's stateless, browser-native for EventSource, and needs no session store — minimizing the attack surface and avoiding any persistence). The dashboard exposes server logs, so auth is **mandatory**: refuse to run without `LD_PASS` set (server boot warns loudly; fix before exposing).
- [x] **Path constraint**: all filesystem access confined to `LD_HOME_ROOT` (default `/home`). Account names are validated against `^[a-z0-9][a-z0-9_-]{0,31}$`.
- [x] **Path traversal blocked**: `path.normalize` rejects `..`; realpath re-checks that the resolved path is still under the real account home.
- [x] **Symlink escape blocked**: every candidate path (discovery + read) is dereferenced via `realpath` and re-checked against the account home boundary.
- [x] **Opaque log IDs**: the client only ever sees a 24-char id. IDs are resolved server-side against the cached discovery list **and** re-revalidated against the account home. The raw filesystem path is never sent to the browser. The directory structure beyond the discovered file list is never exposed (UI shows basename + parent-dir hint only).
- [x] **Cross-account access blocked**: every read requires `(account, id)` and validates the id appears in *that account's* cached discovery list before realpath re-validation. A user cannot reference another account's log id.
- [x] **Logs are never written**: the service never opens a log file for writing — every log path is opened `'r'` only. The **only** file it writes anywhere is `data/notifications.json` (its own settings, mode `0600`, atomic tmp+rename). systemd pins `ProtectSystem=strict` + `ProtectHome=read-only` with `ReadWritePaths=` scoped to that one directory, and a capability bounding set of just `CAP_DAC_READ_SEARCH` (read/search only — no write capability is granted, so `/home` is unwritable even to root).
- [x] **Notification settings are re-validated server-side**: severities and recipient ids must be members of the known sets, and every selected file is bounds-checked against the account home on save **and again** before the watcher attaches. A hand-crafted request cannot aim the watcher outside `/home/<account>/`.
- [x] **Email sending is fail-closed**: `lib/brevo.js` is the single egress point and refuses to send while `LD_NOTIFY_ENABLED=0`, so "disarmed" is enforced by the transport rather than by caller discipline. Booting armed without an API key or verified sender is a hard startup error.
- [x] **Log content is escaped into email**: digests are built from log lines, so all interpolated content is HTML-escaped; the in-app preview renders into a `sandbox=""` iframe rather than the document.
- [x] **HTTP hardening**: small `bodyLimit` (8 KB; the settings route raises its own to 256 KB for long file lists); SSE responses disable proxy buffering via `X-Accel-Buffering: no`; keep-alive pings every 15 s.
- [x] **Native TLS**: the app terminates HTTPS itself on the port from `LD_DASHBOARD_URL` (cert from certbot/Let's Encrypt), **refuses to boot** if HTTPS is requested but the cert/key are unreadable, and hot-reloads the certificate on `SIGHUP` (certbot deploy-hook) with no downtime.
- [x] **Brute-force lockout**: repeated wrong passwords from one IP are counted and, past a threshold (`LD_AUTH_MAX_FAILS`, default 5 in 15 min), that IP is blocked with HTTP 429 for a cooldown (`LD_AUTH_LOCKOUT_MS`, default 15 min). A correct login clears the count; only real credential attempts are counted, so the browser's initial prompt never penalizes a legitimate user. In-memory and bounded — no dependency, no store.

**Firewall / binding recommendation (evaluated, not skipped)**
Binding to `0.0.0.0:3212` is convenient for admin access but exposes an authenticated log viewer to the public Internet. On a **public-facing WHM server** this is *not* recommended; prefer one of:
1. **Firewall to admin IPs only** — with WHM/cPanel, use **ConfigServer Firewall (CSF)** (already standard on most WHM boxes):
   - Allow only admin/VPN source IPs to `tcp/3212`:
     ```sh
     # /etc/csf/csf.conf
     TCP_IN = "...,3212"
     # Create a dedicated allow-list file:
     # /etc/csf/csf.allow
     tcp|in|d=3212|s=203.0.113.10   # admin IP
     tcp|in|d=3212|s=198.51.100.0/24 # admin CIDR
     csf -r
     ```
2. **Bind loopback + reverse proxy** through Apache (already on port 443) with client-cert or IP allowlists, so 3212 is never directly internet-reachable.
3. If neither is feasible for the admin's workflow, at minimum keep `LD_PASS` very strong (≥ 24 random chars), TLS-terminate via a cPanel vhost proxy, and rate-limit brute-force via CSF `LF_SSHD`-style rules.

The service's `ProtectSystem=strict` + `ProtectHome=read-only` systemd settings do not interfere with log reading. They *do* apply to the notification settings file, which is why the unit carries a single narrow `ReadWritePaths=/root/log-dashboard/data`.

Note that arming notifications gives the service **outbound** network egress to `api.brevo.com:443`. If you run an egress allowlist, permit that host or digests will silently fail (the failure is logged and the entries roll into the next digest).

## Caveats / known trade-offs

- **Live tail latency**: polls every `LD_TAIL_POLL_MS` (default 1 s). This is intentional to avoid kernel `inotify`/`fs.watch` load on a live box; ~1 s lag on real-time tail is acceptable for an admin observability tool.
- **Default auth password**: the boot warns if `LD_PASS` is unset, `changeme`, or < 8 chars. Set a strong one before binding.
- **PHP/Apache timestamp parsing**: covers the common bracketed formats; lines without a parseable leading timestamp fall back to the read time, as specified ("inferred from read time/position").
- **Digest latency is up to one hour**: notifications are batched, so a critical error can sit in the buffer for up to `LD_NOTIFY_INTERVAL_MS` before it is emailed. This is the deliberate trade for not flooding inboxes — a busy `error_log` can emit hundreds of lines a minute, and per-entry email would both bury the recipients and hit Brevo's rate limits. Lower the interval (minimum 1 minute) if faster alerting matters more than batching.
- **Restarts drop buffered alerts**: up to one interval of pending notifications is lost on restart, because flushing on shutdown would make a crash-restart loop email the recipients on every restart. The log files themselves are unaffected.
- **Dedup can over-merge**: the digest signature normalizes every digit run, so two errors differing *only* by a number (e.g. `on line 12` vs `on line 500`) collapse into one group with a count. This is nearly always the desired behaviour for log noise, but the count, not the line number, is what survives.
- **Search large-file guard**: scans newest `LD_SEARCH_MAX_BYTES_PER_FILE` bytes per file (default 256 MB) so a 5 GB file does not block the live box. Set to `0` for unlimited if the workstation allows.