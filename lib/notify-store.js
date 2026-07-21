'use strict';
/**
 * Persistence for per-account notification settings.
 *
 * One small JSON file, loaded once at boot and held in memory; every read is
 * served from the cache and every write is an atomic replace (tmp + rename) so
 * a crash mid-write can never leave a truncated settings file behind.
 *
 * Stored shape:
 *   {
 *     "version": 1,
 *     "accounts": {
 *       "mysite": {
 *         "enabled": true,
 *         "severities": ["critical", "error"],
 *         "recipients": ["reza", "hamed"],
 *         "files": ["public_html/error_log"],   // relative to the account home
 *         "period": "6h",                        // digest cadence (see config)
 *         "updatedAt": 1752580000000
 *       }
 *     }
 *   }
 *
 * Files are stored as paths RELATIVE to the account home rather than as opaque
 * log ids: the ids are derived from absolute paths and are meaningless to a
 * human reading this file, and a relative path can be re-validated on load with
 * resolveUnderAccount() without needing a warm discovery cache.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { config, RECIPIENTS, NOTIFY_SEVERITIES, NOTIFY_PERIODS, DEFAULT_PERIOD } = require('./config');
const { validAccount, resolveUnderAccount, SecurityError } = require('./security');

const FILE = path.join(config.notify.dataDir, 'notifications.json');
const TMP = FILE + '.tmp';
const VERSION = 1;

const RECIPIENT_IDS = new Set(RECIPIENTS.map(r => r.id));
const SEVERITY_SET = new Set(NOTIFY_SEVERITIES);
const PERIOD_SET = new Set(NOTIFY_PERIODS.map(p => p.key));

let cache = { version: VERSION, accounts: {} };
let writeChain = Promise.resolve(); // serializes concurrent saves

function emptySettings() {
  return { enabled: false, severities: [], recipients: [], files: [], period: DEFAULT_PERIOD, updatedAt: 0 };
}

/**
 * An account only produces email when every axis is non-empty: it is switched
 * on, and it has at least one severity, one recipient and one file. Anything
 * less is a half-configured account that must stay silent.
 */
function isActive(s) {
  return !!(s && s.enabled && s.severities.length && s.recipients.length && s.files.length);
}

// Coerce whatever is on disk into a valid settings object, dropping unknown
// severities/recipients rather than throwing — a hand-edited or downgraded file
// must not stop the dashboard from booting.
function sanitizeLoaded(v) {
  const s = emptySettings();
  if (!v || typeof v !== 'object') return s;
  s.enabled = v.enabled === true;
  if (Array.isArray(v.severities)) {
    s.severities = [...new Set(v.severities.filter(x => SEVERITY_SET.has(x)))];
  }
  if (Array.isArray(v.recipients)) {
    s.recipients = [...new Set(v.recipients.filter(x => RECIPIENT_IDS.has(x)))];
  }
  if (Array.isArray(v.files)) {
    s.files = [...new Set(v.files.filter(x => typeof x === 'string' && x && !x.includes('..')))]
      .slice(0, config.notify.maxFilesPerAccount);
  }
  // Unknown/legacy period keys fall back to the default rather than throwing, so
  // a settings file written before this feature (no `period`) still loads.
  s.period = PERIOD_SET.has(v.period) ? v.period : DEFAULT_PERIOD;
  s.updatedAt = Number.isFinite(v.updatedAt) ? v.updatedAt : 0;
  return s;
}

function load() {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.error(`[notify-store] cannot read ${FILE}: ${e.message} — starting with empty settings`);
    }
    cache = { version: VERSION, accounts: {} };
    return cache;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    // Keep the unreadable file for forensics instead of silently overwriting it.
    const bak = FILE + '.corrupt-' + Date.now();
    try { fs.renameSync(FILE, bak); } catch {}
    // eslint-disable-next-line no-console
    console.error(`[notify-store] ${FILE} is not valid JSON (${e.message}); moved to ${bak}`);
    cache = { version: VERSION, accounts: {} };
    return cache;
  }
  const accounts = {};
  const src = (parsed && parsed.accounts) || {};
  for (const [account, v] of Object.entries(src)) {
    if (!validAccount(account)) continue; // ignore junk keys
    accounts[account] = sanitizeLoaded(v);
  }
  cache = { version: VERSION, accounts };
  return cache;
}

function get(account) {
  if (!validAccount(account)) throw new SecurityError('invalid account');
  return cache.accounts[account] ? { ...cache.accounts[account] } : emptySettings();
}

// Uncopied read for the hot path (called once per matching log line by the
// notifier). Callers must treat the result as read-only.
function getRaw(account) {
  return cache.accounts[account] || null;
}

function getAll() {
  return cache.accounts;
}

/**
 * Validate one selected file and return its path relative to the account home.
 *
 * A file that EXISTS is fully resolved with resolveUnderAccount(), so symlinks
 * are dereferenced and an escape is rejected outright. A file that does NOT yet
 * exist is checked lexically only, and kept: log files get rotated away and
 * recreated constantly, and refusing to save because a log happened to be
 * missing at that moment would make the settings unsavable at random. Storing
 * such a path is safe — the notifier calls resolveUnderAccount() again before
 * it ever attaches a watcher, so a path that only resolves outside the home can
 * be stored but can never be read.
 */
function validateFile(account, realHome, f) {
  const norm = path.normalize(f);
  if (norm.includes('..')) throw new SecurityError('path traversal rejected');
  const abs = path.isAbsolute(norm) ? norm : path.join(realHome, norm);
  if (abs !== realHome && !abs.startsWith(realHome + path.sep)) {
    throw new SecurityError('file outside account home');
  }
  let exists = true;
  try { fs.lstatSync(abs); } catch { exists = false; }
  if (exists) {
    const real = resolveUnderAccount(account, norm); // throws on symlink escape
    const rel = path.relative(realHome, real);
    if (!rel || rel.startsWith('..')) throw new SecurityError('file outside account home');
    return rel;
  }
  const rel = path.relative(realHome, abs);
  if (!rel || rel.startsWith('..')) throw new SecurityError('file outside account home');
  return rel;
}

/**
 * Validate and persist settings for one account. Throws SecurityError on any
 * input the caller should not have been able to produce (unknown severity,
 * unknown recipient, a file that does not resolve under this account's home).
 *
 * Every file is re-validated with resolveUnderAccount() here rather than trusted
 * from the client, so a saved settings file can never point the watcher at a
 * path outside /home/<account>/ even if the request was hand-crafted.
 */
async function set(account, incoming) {
  if (!validAccount(account)) throw new SecurityError('invalid account');
  if (!incoming || typeof incoming !== 'object') throw new SecurityError('invalid settings');

  const s = emptySettings();
  s.enabled = incoming.enabled === true;

  const sev = Array.isArray(incoming.severities) ? incoming.severities : [];
  for (const x of sev) {
    if (!SEVERITY_SET.has(x)) throw new SecurityError(`unknown severity: ${String(x).slice(0, 32)}`);
  }
  s.severities = [...new Set(sev)];

  const rec = Array.isArray(incoming.recipients) ? incoming.recipients : [];
  for (const x of rec) {
    if (!RECIPIENT_IDS.has(x)) throw new SecurityError(`unknown recipient: ${String(x).slice(0, 32)}`);
  }
  s.recipients = [...new Set(rec)];

  // Period is optional on the wire (older clients omit it): keep the default when
  // absent, but reject an unknown value rather than silently coercing it, so a
  // typo in a hand-crafted request surfaces instead of being swallowed.
  if (incoming.period != null) {
    if (!PERIOD_SET.has(incoming.period)) {
      throw new SecurityError(`unknown period: ${String(incoming.period).slice(0, 32)}`);
    }
    s.period = incoming.period;
  }

  const files = Array.isArray(incoming.files) ? incoming.files : [];
  if (files.length > config.notify.maxFilesPerAccount) {
    throw new SecurityError(`too many files (max ${config.notify.maxFilesPerAccount})`);
  }
  const rels = [];
  if (files.length) {
    let realHome;
    try { realHome = fs.realpathSync(path.join(config.homeRoot, account)); }
    catch { throw new SecurityError('account home not found'); }
    for (const f of files) {
      if (typeof f !== 'string' || !f) throw new SecurityError('invalid file entry');
      rels.push(validateFile(account, realHome, f));
    }
  }
  s.files = [...new Set(rels)];
  s.updatedAt = Date.now();

  cache.accounts[account] = s;
  await save();
  return { ...s };
}

function serialize() {
  return JSON.stringify({ version: VERSION, accounts: cache.accounts }, null, 2) + '\n';
}

async function writeNow(body) {
  await fsp.mkdir(config.notify.dataDir, { recursive: true, mode: 0o700 });
  // 0600: the file lists which addresses receive this server's log output.
  await fsp.writeFile(TMP, body, { mode: 0o600 });
  await fsp.rename(TMP, FILE);
}

// Atomic replace, serialized so two concurrent saves cannot interleave their
// tmp writes and rename each other's half-written file into place.
function save() {
  const body = serialize();
  // Run after the previous write settles, whether it resolved or rejected.
  const run = writeChain.then(() => writeNow(body), () => writeNow(body));
  // The chain itself must never stay rejected, or every later save would be
  // skipped by the .then() above. Callers still see the real error via `run`.
  writeChain = run.catch(() => {});
  run.catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`[notify-store] save failed: ${e.message}`);
  });
  return run;
}

module.exports = {
  load,
  get,
  getRaw,
  getAll,
  set,
  isActive,
  emptySettings,
  FILE,
};
