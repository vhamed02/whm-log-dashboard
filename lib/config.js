'use strict';
const fs = require('fs');
const path = require('path');

function envBool(v, def) { if (v == null) return def; return /^(1|true|yes)$/i.test(v); }

// Public base URL of the dashboard, used to build the one-click link in emails.
// Only http/https is accepted (a bad scheme is dropped rather than emitted into
// an email href), and any trailing slash is trimmed. Empty when unset → no link.
function cleanUrl(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    // eslint-disable-next-line no-console
    console.error(`[config] LD_DASHBOARD_URL "${s}" ignored — must start with http:// or https://`);
    return '';
  }
  return s;
}

const raw = {
  // Public base URL where users reach the dashboard (e.g. https://logs.example.com
  // or http://1.2.3.4:3212). Used for the "Open dashboard" button in emails.
  dashboardUrl: cleanUrl(process.env.LD_DASHBOARD_URL),
  user: process.env.LD_USER || 'admin',
  pass: process.env.LD_PASS || '',
  host: process.env.LD_HOST || '0.0.0.0',
  port: parseInt(process.env.LD_PORT || '3212', 10),
  cacheTtl: parseInt(process.env.LD_CACHE_TTL || '480000', 10),
  maxDepth: parseInt(process.env.LD_MAX_DEPTH || '12', 10),
  skipDirs: (process.env.LD_SKIP_DIRS || 'node_modules,.git,backup,backups,cpmove,tmp,.cpanel,mail,.spamassassin,.Trash,.npm,wp-admin,wp-includes')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  logGlob: process.env.LD_LOG_GLOB || '*.log',
  logExtra: (process.env.LD_LOG_EXTRA || 'error_log,wp-cron.err').split(',').map(s => s.trim()).filter(Boolean),
  maxLogsPerAccount: parseInt(process.env.LD_MAX_LOGS_PER_ACCOUNT || '5000', 10),
  initialTailBytes: parseInt(process.env.LD_INITIAL_TAIL_BYTES || '262144', 10),
  initialMaxLines: parseInt(process.env.LD_INITIAL_MAX_LINES || '500', 10),
  tailPollMs: parseInt(process.env.LD_TAIL_POLL_MS || '1000', 10),
  maxLiveListeners: parseInt(process.env.LD_MAX_LIVE_LISTENERS || '64', 10),
  searchMaxBytesPerFile: parseInt(process.env.LD_SEARCH_MAX_BYTES_PER_FILE || '268435456', 10),
  homeRoot: process.env.LD_HOME_ROOT || '/home',

  // --- Brute-force lockout for the login ---
  // Temporarily blocks a client IP after too many failed logins, so the single
  // Basic-Auth password can't be guessed at internet speed. See lib/loginguard.js.
  auth: {
    maxFails: parseInt(process.env.LD_AUTH_MAX_FAILS || '5', 10),      // guesses before lockout
    windowMs: parseInt(process.env.LD_AUTH_WINDOW_MS || '900000', 10), // counted over 15 min
    lockoutMs: parseInt(process.env.LD_AUTH_LOCKOUT_MS || '900000', 10), // blocked for 15 min
  },

  notify: {
    // MASTER ARM SWITCH. While false, the notifier watches, classifies and
    // buffers exactly as normal and logs an hourly "would have sent" summary,
    // but NEVER calls Brevo. Nothing can leave the box until this is 1.
    enabled: envBool(process.env.LD_NOTIFY_ENABLED, false),
    // Where per-account notification settings are persisted. Must be writable —
    // under systemd this path needs a matching ReadWritePaths= in the unit.
    dataDir: process.env.LD_NOTIFY_DATA_DIR || path.join(__dirname, '..', 'data'),
    // Digest cadence. One grouped email per account per interval, and only when
    // that account actually buffered something.
    intervalMs: parseInt(process.env.LD_NOTIFY_INTERVAL_MS || '3600000', 10),
    // How often watchers are reconciled against saved settings. Picks up log
    // files that did not exist yet when the settings were saved.
    resyncMs: parseInt(process.env.LD_NOTIFY_RESYNC_MS || '300000', 10),
    // Memory guards for the digest buffer — a runaway error loop must never be
    // able to grow the buffer without bound between two flushes.
    maxGroups: parseInt(process.env.LD_NOTIFY_MAX_GROUPS || '200', 10),
    maxSample: parseInt(process.env.LD_NOTIFY_MAX_SAMPLE || '2000', 10),
    maxFilesPerAccount: parseInt(process.env.LD_NOTIFY_MAX_FILES || '200', 10),
    // Test email: how many recent entries to show per selected severity, and the
    // scan budget for finding them. Filtering by severity forces a backwards scan
    // (the newest tail may hold none of the wanted severity), so this is capped
    // per file and overall to keep a test click cheap on a busy box.
    testSamplePerSeverity: parseInt(process.env.LD_NOTIFY_TEST_SAMPLE || '5', 10),
    sampleMaxBytesPerFile: parseInt(process.env.LD_NOTIFY_SAMPLE_MAX_BYTES_PER_FILE || '4194304', 10),
    sampleMaxBytesTotal: parseInt(process.env.LD_NOTIFY_SAMPLE_MAX_BYTES_TOTAL || '33554432', 10),
    // Brevo transactional-email credentials.
    brevoKey: process.env.LD_BREVO_API_KEY || '',
    senderEmail: process.env.LD_BREVO_SENDER_EMAIL || '',
    senderName: process.env.LD_BREVO_SENDER_NAME || 'Log Dashboard',
  },
};

// Derive serving mode (TLS + listen port) from LD_DASHBOARD_URL, so the .env's
// single "where is this reachable" value also decides how the app serves itself:
//   https://host:3201  -> serve TLS on port 3201, cert for `host`
//   http://host        -> plain HTTP, port stays LD_PORT (no surprise :80 bind)
// Explicit LD_TLS_CERT/LD_TLS_KEY override the derived Let's Encrypt paths.
(function deriveServing() {
  let u = null;
  try { if (raw.dashboardUrl) u = new URL(raw.dashboardUrl); } catch { /* cleanUrl already validated the scheme */ }
  const tlsFromUrl = !!u && u.protocol === 'https:';
  const domain = (u && u.hostname) || '';
  const explicitCert = (process.env.LD_TLS_CERT || '').trim();
  const explicitKey = (process.env.LD_TLS_KEY || '').trim();
  raw.tls = {
    // TLS is on when the dashboard URL is https, or when cert+key are given
    // explicitly (lets an operator serve TLS without an https URL if they must).
    enabled: tlsFromUrl || (!!explicitCert && !!explicitKey),
    domain,
    cert: explicitCert || (domain ? `/etc/letsencrypt/live/${domain}/fullchain.pem` : ''),
    key: explicitKey || (domain ? `/etc/letsencrypt/live/${domain}/privkey.pem` : ''),
  };
  // A port in the URL wins over LD_PORT so the URL is the single source of truth
  // for reachability. No port in the URL keeps LD_PORT (never assume 80/443).
  if (u && u.port) raw.port = parseInt(u.port, 10);
})();

/**
 * Notification recipients.
 *
 * REAL people belong in the git-ignored .env (this is a public repo), via
 * LD_RECIPIENTS — a comma-separated list of `id:Name:email` entries, e.g.
 *
 *   LD_RECIPIENTS=joao:Joao Rosa:joao@example.com,ops:On-call:ops@example.com
 *
 * When LD_RECIPIENTS is set it fully REPLACES the placeholders below. Keeping the
 * roster in .env means editing it never touches a tracked file, so `git pull`
 * never conflicts with your local receiver list.
 *
 * The `id` is what gets persisted in the per-account settings file, so changing
 * an existing id orphans that selection (the name and email are free to change).
 * Ids must be a short slug: [a-z0-9] then up to 31 of [a-z0-9_-].
 */
function parseRecipients(rawStr) {
  const out = [];
  const seen = new Set();
  for (const chunk of String(rawStr).split(',')) {
    const s = chunk.trim();
    if (!s) continue;
    // Split on ':' — id first, email last, anything between is the name (so a
    // stray ':' inside a name survives). Needs at least id:name:email.
    const parts = s.split(':');
    if (parts.length < 3) {
      console.error(`[config] LD_RECIPIENTS: ignoring "${s}" (expected id:Name:email)`);
      continue;
    }
    const id = parts[0].trim();
    const email = parts[parts.length - 1].trim();
    const name = parts.slice(1, -1).join(':').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      console.error(`[config] LD_RECIPIENTS: ignoring "${s}" (id must be a slug [a-z0-9_-])`);
      continue;
    }
    if (!name || !email || !email.includes('@')) {
      console.error(`[config] LD_RECIPIENTS: ignoring "${s}" (name and a valid email are required)`);
      continue;
    }
    if (seen.has(id)) {
      console.error(`[config] LD_RECIPIENTS: ignoring duplicate id "${id}"`);
      continue;
    }
    seen.add(id);
    out.push({ id, name, email });
  }
  return out;
}

// Placeholder roster shipped in the repo — safe, obviously-fake addresses.
// Overridden wholesale by LD_RECIPIENTS in .env for real deployments.
const PLACEHOLDER_RECIPIENTS = [
  { id: 'reza', name: 'Reza', email: 'reza@example.com' },
  { id: 'hamed', name: 'Hamed', email: 'hamed@example.com' },
  { id: 'ali', name: 'Ali', email: 'ali@example.com' },
];

let RECIPIENTS = PLACEHOLDER_RECIPIENTS;
if (process.env.LD_RECIPIENTS && process.env.LD_RECIPIENTS.trim()) {
  const parsed = parseRecipients(process.env.LD_RECIPIENTS);
  if (parsed.length) {
    RECIPIENTS = parsed;
  } else {
    // Set but unparseable: fail loud but keep the dashboard usable rather than
    // leaving it with zero selectable receivers.
    console.error('[config] LD_RECIPIENTS is set but no valid entries were parsed — keeping placeholder recipients.');
  }
}

// Severities that can be subscribed to. `info` is the catch-all bucket for
// unclassified lines, so subscribing to it makes for high-volume digests — it is
// offered but left unticked by default (no account selects it unless asked).
const NOTIFY_SEVERITIES = ['critical', 'error', 'warning', 'info'];

// Digest cadences offered per account in the notification modal. Each is
// epoch-aligned to its own interval, exactly like the legacy single timer was:
// a 6h digest lands at 00:00/06:00/12:00/18:00 UTC, a daily one at 00:00 UTC.
// `daily`/`weekly`/`monthly` are rolling FIXED intervals (24h / 7d / 30d) aligned
// to UTC boundaries — deliberately not calendar midnight / Monday / the 1st,
// which would drag in timezone and month-length handling this service has no
// other need for. `phrase` is the human tail used in the email footer
// ("every <phrase>" / "the last <phrase>"); `label` is the dropdown text.
const NOTIFY_PERIODS = [
  { key: '1h', label: 'Every hour', phrase: 'hour', ms: 3600000 },
  { key: '3h', label: 'Every 3 hours', phrase: '3 hours', ms: 10800000 },
  { key: '6h', label: 'Every 6 hours', phrase: '6 hours', ms: 21600000 },
  { key: '12h', label: 'Every 12 hours', phrase: '12 hours', ms: 43200000 },
  { key: 'daily', label: 'Daily', phrase: 'day', ms: 86400000 },
  { key: 'weekly', label: 'Weekly', phrase: 'week', ms: 604800000 },
  { key: 'monthly', label: 'Monthly', phrase: '30 days', ms: 2592000000 },
];
const NOTIFY_PERIOD_BY_KEY = new Map(NOTIFY_PERIODS.map(p => [p.key, p]));

// The cadence an account that has never picked one inherits. Derived from
// LD_NOTIFY_INTERVAL_MS when it matches an offered period (so an operator who set
// the legacy interval to, say, 6h keeps that as the default), else hourly.
const DEFAULT_PERIOD =
  (NOTIFY_PERIODS.find(p => p.ms === raw.notify.intervalMs) || NOTIFY_PERIODS[0]).key;

function periodToMs(key) {
  const p = NOTIFY_PERIOD_BY_KEY.get(key);
  return p ? p.ms : raw.notify.intervalMs;
}
function periodPhrase(key) {
  const p = NOTIFY_PERIOD_BY_KEY.get(key);
  return p ? p.phrase : `${Math.round(raw.notify.intervalMs / 60000)} minutes`;
}

// Validate auth is configured. Refuse to boot without it.
const allowNoAuth = envBool(process.env.LD_ALLOW_NO_AUTH, false);
function assertConfig() {
  const weakPass = !raw.pass || raw.pass === 'changeme' || raw.pass.length < 8;
  if (weakPass) {
    if (!allowNoAuth) {
      // The dashboard exposes server logs; running it without authentication is
      // a foot-gun on a live box. Fail closed. Set a strong LD_PASS (>= 8 chars),
      // or LD_ALLOW_NO_AUTH=1 to intentionally run without auth (e.g. behind a
      // trusted reverse proxy / on loopback for local testing).
      throw new Error(
        'LD_PASS is unset or too short. The dashboard serves server logs and refuses ' +
        'to run without authentication. Set a strong LD_PASS (>= 8 chars), or set ' +
        'LD_ALLOW_NO_AUTH=1 to run without auth deliberately.'
      );
    }
    // eslint-disable-next-line no-console
    console.error('[log-dashboard] WARNING: running WITHOUT authentication (LD_ALLOW_NO_AUTH=1). The dashboard exposes server logs to anyone who can reach the port.');
  }
  if (!fs.existsSync(raw.homeRoot) || !fs.statSync(raw.homeRoot).isDirectory()) {
    throw new Error(`LD_HOME_ROOT (${raw.homeRoot}) does not exist or is not a directory.`);
  }
  if (raw.port < 1 || raw.port > 65535) throw new Error('Invalid LD_PORT');

  // TLS: if serving HTTPS, the cert and key must be present and readable now —
  // fail safe rather than boot into a broken listener. certbot writes both files
  // to /etc/letsencrypt/live/<domain>/ (see LD_DASHBOARD_URL / LD_TLS_*).
  if (raw.tls.enabled) {
    if (!raw.tls.cert || !raw.tls.key) {
      throw new Error(
        'HTTPS is requested (https:// dashboard URL) but no certificate path could be determined. ' +
        'Set LD_DASHBOARD_URL to https://<domain>:<port> or set LD_TLS_CERT and LD_TLS_KEY.'
      );
    }
    for (const [label, p] of [['certificate', raw.tls.cert], ['private key', raw.tls.key]]) {
      try { fs.accessSync(p, fs.constants.R_OK); }
      catch (e) {
        throw new Error(
          `TLS ${label} is not readable at ${p} (${e.code || e.message}). ` +
          'Obtain the certificate (e.g. certbot) before serving HTTPS, or switch LD_DASHBOARD_URL back to http://.'
        );
      }
    }
  }

  const n = raw.notify;
  if (n.intervalMs < 60000) {
    throw new Error('LD_NOTIFY_INTERVAL_MS must be at least 60000 (1 minute).');
  }
  // Fail closed when armed but unable to send: silently arming with no key would
  // look like "notifications are on" while every flush errors out.
  if (n.enabled) {
    if (!n.brevoKey) {
      throw new Error(
        'LD_NOTIFY_ENABLED=1 but LD_BREVO_API_KEY is unset. Email cannot be sent. ' +
        'Set the Brevo API key, or set LD_NOTIFY_ENABLED=0 to keep notifications disarmed.'
      );
    }
    if (!n.senderEmail) {
      throw new Error(
        'LD_NOTIFY_ENABLED=1 but LD_BREVO_SENDER_EMAIL is unset. Brevo rejects mail ' +
        'without a verified sender. Set it, or set LD_NOTIFY_ENABLED=0.'
      );
    }
  }
  // The settings store needs a writable directory. Warn rather than refuse —
  // the log viewer itself is fully functional without notifications.
  try {
    fs.mkdirSync(n.dataDir, { recursive: true, mode: 0o700 });
    fs.accessSync(n.dataDir, fs.constants.W_OK);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[log-dashboard] WARNING: notification data dir ${n.dataDir} is not writable (${e.code || e.message}). ` +
      'Notification settings cannot be saved. Under systemd, add it to ReadWritePaths=.'
    );
  }
}

module.exports = {
  config: raw,
  assertConfig,
  RECIPIENTS,
  NOTIFY_SEVERITIES,
  NOTIFY_PERIODS,
  DEFAULT_PERIOD,
  periodToMs,
  periodPhrase,
};