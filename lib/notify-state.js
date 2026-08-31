'use strict';
/**
 * Sidecar state for the notifier: when each account last had a digest actually
 * sent to it.
 *
 * This exists for one reason. Theme problems are re-reported in every digest for
 * as long as their lines remain in the log file, so the same entry legitimately
 * appears in email after email. Without a record of when mail last went out
 * there is no way to tell the reader which of those entries they have already
 * seen and which are new since last time — and an unlabelled repeat reads as a
 * fresh failure, which is exactly the alarm fatigue the re-reporting is meant to
 * avoid.
 *
 * A separate file from notifications.json on purpose: that one is written by the
 * settings UI on every save, and interleaving an automatic per-flush write into
 * it would risk one clobbering the other. This file is written only by the
 * notifier, only after a successful send.
 *
 * Only the send TIME is stored, never log content — one number per account. That
 * is enough to classify every scanned entry (occurred after the last send = new,
 * otherwise = already reported) without keeping any history of what was emailed.
 *
 * A missing or unreadable file is not an error: it means nothing has been sent
 * yet, every entry is new, and the first digest reads exactly as it does today.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { config } = require('./config');

const FILE = path.join(config.notify.dataDir, 'notify-state.json');
const TMP = FILE + '.tmp';
const VERSION = 1;

let cache = { version: VERSION, accounts: {} };
let writeChain = Promise.resolve();

/** Load at boot. Never throws — a corrupt file resets to "nothing sent yet". */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const accounts = {};
    if (raw && typeof raw === 'object' && raw.accounts && typeof raw.accounts === 'object') {
      for (const [name, v] of Object.entries(raw.accounts)) {
        const ms = v && Number(v.lastSentAt);
        if (Number.isFinite(ms) && ms > 0) accounts[name] = { lastSentAt: ms };
      }
    }
    cache = { version: VERSION, accounts };
  } catch {
    cache = { version: VERSION, accounts: {} };
  }
  return cache;
}

/**
 * Epoch ms of the last digest actually delivered for this account, or 0 when
 * none ever was. 0 makes every entry "new", which is the correct reading for an
 * account that has never received mail.
 */
function getLastSentAt(account) {
  const a = cache.accounts[account];
  return a && a.lastSentAt ? a.lastSentAt : 0;
}

/**
 * Record a successful send. Fire-and-forget: the returned promise is available
 * for tests, but a failed write must never break the flush — the cost of losing
 * it is that the next digest labels repeats as new, not that mail stops.
 */
function setLastSentAt(account, ms) {
  cache.accounts[account] = { lastSentAt: ms };
  return save();
}

/** Drop an account's record — used when its settings are deleted. */
function forget(account) {
  if (!(account in cache.accounts)) return Promise.resolve();
  delete cache.accounts[account];
  return save();
}

async function writeNow(body) {
  await fsp.mkdir(config.notify.dataDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(TMP, body, { mode: 0o600 });
  await fsp.rename(TMP, FILE);
}

// Same atomic replace and serialization as notify-store: two concurrent flushes
// must not interleave their tmp writes and rename each other's half-written file.
function save() {
  const body = JSON.stringify(cache, null, 2);
  const run = writeChain.then(() => writeNow(body), () => writeNow(body));
  writeChain = run.catch(() => {});
  return run;
}

module.exports = { load, getLastSentAt, setLastSentAt, forget, FILE };
