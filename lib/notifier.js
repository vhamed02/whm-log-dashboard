'use strict';
/**
 * Background log watcher + hourly digest mailer.
 *
 * Independent of the browser: the dashboard's live view only tails a file while
 * someone is looking at it, whereas this attaches its own permanent listener to
 * every file an enabled account has selected. Both share the same per-file
 * LiveTail poller (one stat/read per file regardless of how many viewers and
 * notifiers are attached), so watching a file costs nothing extra when it is
 * also open in the UI.
 *
 * Flow per matching entry:
 *   LiveTail block -> severity filter (per-account settings) -> dedup group in
 *   the in-memory buffer. Nothing is written to disk and no email is sent here.
 *
 * Flow per cadence boundary (each account picks its own: hourly … monthly):
 *   a shared base tick checks which accounts have reached the next boundary of
 *   their own cadence -> for each, compose ONE digest -> send to every selected
 *   recipient in a single Brevo call -> clear the buffer and re-arm the schedule.
 *   Accounts that buffered nothing are skipped entirely — a quiet cadence sends
 *   no mail at all.
 */
const { config, RECIPIENTS, periodToMs, periodPhrase } = require('./config');
const store = require('./notify-store');
const brevo = require('./brevo');
const { getLiveTail, sourceLabel, readBlocksReverse, normalize } = require('./stream');
const { resolveUnderAccount } = require('./security');
const { renderEmail, fmtTime } = require('./email-template');

const SEV_RANK = { critical: 0, error: 1, warning: 2, info: 3 };
// Groups rendered in one email. The buffer holds up to config.notify.maxGroups
// (default 200); rendering all of them at full sample length could produce a
// multi-hundred-KB email, so the digest shows the worst ones and counts the rest.
const MAX_RENDERED_GROUPS = 50;

function firstLine(msg) {
  const i = msg.indexOf('\n');
  return i === -1 ? msg : msg.slice(0, i);
}

// The next epoch-aligned boundary of interval `iv` strictly after `t`. This is
// the same alignment the legacy single timer used (Math.ceil(now/iv)*iv), applied
// per account so each cadence lands on predictable wall-clock times.
function nextBoundaryAfter(t, iv) {
  return Math.floor(t / iv) * iv + iv;
}

/**
 * Collapse an entry's opener line into a dedup signature: identical errors that
 * differ only by timestamp, pid, memory address, IP or byte count must land in
 * the same group so a 4000-line fatal loop becomes one row with a count of 4000.
 * Every digit run becomes '#', which also normalizes the leading timestamp and
 * any access-log client IP without needing format-specific handling.
 */
function signature(line) {
  return line
    .replace(/^\[[^\]]*\]\s*/, '')      // leading bracketed timestamp
    .replace(/0x[0-9a-f]+/gi, '0x#')    // memory addresses
    .replace(/\d+/g, '#')               // pids, byte counts, line numbers, IPs, dates
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 400);
}

function sortedGroups(buf) {
  return [...buf.groups.values()].sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.count - a.count));
}

function severityCounts(buf) {
  const c = {};
  for (const g of buf.groups.values()) c[g.severity] = (c[g.severity] || 0) + g.count;
  return c;
}

/**
 * Build the digest email for one account's buffer. Pure — does not mutate or
 * clear the buffer, so /notify/preview can call it safely at any time.
 */
function composeDigest(account, buf, settings) {
  const counts = severityCounts(buf);
  const order = Object.keys(counts).sort((a, b) => SEV_RANK[a] - SEV_RANK[b]);
  const summary = order.map(s => `${counts[s]} ${s}`).join(', ') || 'no entries';
  const subject = `[${account}] ${summary}`;
  const groups = sortedGroups(buf);
  const shown = groups.slice(0, MAX_RENDERED_GROUPS);
  const hiddenGroups = groups.length - shown.length;
  const windowLine = `${fmtTime(buf.since)} → ${fmtTime(Date.now())}`;

  const notes = [];
  if (hiddenGroups > 0) notes.push(`+${hiddenGroups} more distinct message${hiddenGroups === 1 ? '' : 's'} not shown.`);
  if (buf.overflow) notes.push(`${buf.overflow} further entr${buf.overflow === 1 ? 'y' : 'ies'} were not grouped (per-digest group cap of ${config.notify.maxGroups} reached).`);

  const { html, text } = renderEmail({
    kind: 'digest',
    account,
    senderName: config.notify.senderName,
    subject,
    windowLine,
    counts,
    items: shown,
    notes,
    settings,
    cadence: periodPhrase(settings.period),
    dashboardUrl: config.dashboardUrl,
  });
  return { subject, html, text, counts, total: buf.total, groups: groups.length };
}

/**
 * Read the newest `perSeverity` entries for each subscribed severity out of the
 * account's selected files, newest first. Used to fill the test email with real
 * content rather than lorem text — a delivery test that shows nothing you would
 * recognise is only half a test.
 *
 * Bounded on every axis: a byte budget per file AND overall, and an early exit
 * once every severity is satisfied. A severity filter forces a backwards scan
 * (the newest tail may contain none of the wanted severity), which is exactly the
 * workload that could otherwise walk gigabytes on a busy box.
 */
async function sampleLatest(account, settings, perSeverity = 5) {
  const wanted = new Set(settings.severities);
  const bySev = new Map([...wanted].map(s => [s, []]));
  const full = () => [...bySev.values()].every(a => a.length >= perSeverity);
  const perFileCap = config.notify.sampleMaxBytesPerFile;
  let budget = config.notify.sampleMaxBytesTotal;

  for (const rel of settings.files) {
    if (full() || budget <= 0) break;
    let real;
    try { real = resolveUnderAccount(account, rel); } catch { continue; }
    const label = sourceLabel(real);
    const take = Math.min(perFileCap, budget);
    budget -= take;
    try {
      const gen = readBlocksReverse(real, { maxBytes: take, maxBlocks: Number.MAX_SAFE_INTEGER });
      for await (const block of gen) {
        const norm = normalize(block, label, account, new Date());
        if (!wanted.has(norm.severity)) continue;
        const arr = bySev.get(norm.severity);
        if (arr.length < perSeverity) {
          arr.push({
            severity: norm.severity,
            source: norm.source,
            sample: norm.message.slice(0, config.notify.maxSample),
            count: 1,
            first: Date.parse(norm.ts) || Date.now(),
            last: Date.parse(norm.ts) || Date.now(),
          });
        }
        if (full()) break;
      }
    } catch { /* unreadable file — skip, the others still sample */ }
  }
  return bySev;
}

/**
 * Test email: the newest N entries of each subscribed severity, in the same
 * template as a real digest, so what you approve here is what you will get.
 */
async function composeTest(account, settings, perSeverity = 5) {
  const bySev = await sampleLatest(account, settings, perSeverity);
  const items = [];
  const counts = {};
  for (const sev of [...bySev.keys()].sort((a, b) => SEV_RANK[a] - SEV_RANK[b])) {
    const arr = bySev.get(sev).sort((a, b) => b.last - a.last);
    if (arr.length) counts[sev] = arr.length;
    items.push(...arr);
  }
  const found = items.length;
  const summary = Object.keys(counts).sort((a, b) => SEV_RANK[a] - SEV_RANK[b])
    .map(s => `${counts[s]} ${s}`).join(', ');
  const subject = found
    ? `[${account}] Test — ${summary}`
    : `[${account}] Test — no matching entries found`;

  const notes = [];
  const missing = settings.severities.filter(s => !counts[s]);
  if (missing.length) {
    notes.push(`No recent ${missing.join(' or ')} entries were found in the selected files, so none are shown for ${missing.length === 1 ? 'that severity' : 'those severities'}.`);
  }
  if (!settings.files.length) notes.push('No log files are selected for this account.');

  const { html, text } = renderEmail({
    kind: 'test',
    account,
    senderName: config.notify.senderName,
    subject,
    windowLine: found
      ? `Newest ${perSeverity} entries per severity, sampled from ${settings.files.length} watched file${settings.files.length === 1 ? '' : 's'}`
      : `Sampled ${settings.files.length} watched file${settings.files.length === 1 ? '' : 's'} — nothing matched`,
    counts,
    items,
    notes,
    settings,
    cadence: periodPhrase(settings.period),
    dashboardUrl: config.dashboardUrl,
  });
  return { subject, html, text, counts, total: found };
}

class Notifier {
  constructor(log) {
    this.log = log || console;
    // account -> { groups: Map<key, group>, overflow, total, since }
    this.buffers = new Map();
    // account -> Map<relPath, { realPath, detach }>
    this.watchers = new Map();
    // account -> epoch ms of that account's next scheduled flush. Set when a
    // buffer is first created and advanced on every flush, so each account keeps
    // its own cadence independent of the shared base tick below.
    this.dueAt = new Map();
    this.tickTimer = null;
    this.resyncTimer = null;
    this.nextTickAt = 0;
    this.lastFlushAt = 0;
    this.lastError = null;
    this.flushing = false;
  }

  // The cadence (ms) an account's digest is batched to, from its saved period.
  _periodMs(account) {
    const s = store.getRaw(account);
    return periodToMs(s && s.period);
  }

  _dropBuffer(account) {
    this.buffers.delete(account);
    this.dueAt.delete(account);
  }

  start() {
    this.sync();
    this.resyncTimer = setInterval(() => {
      try { this.sync(); } catch (e) { this.log.error(`[notify] resync failed: ${e.message}`); }
    }, config.notify.resyncMs);
    if (this.resyncTimer.unref) this.resyncTimer.unref();

    // Base tick. Each account is flushed on its OWN cadence (see _tick); the tick
    // is just the clock that checks who is due. It runs at config.notify.intervalMs
    // (default 1h — the shortest offered cadence), aligned to the epoch boundary so
    // the check fires right on the wall-clock marks the per-account periods land on.
    const now = Date.now();
    const iv = config.notify.intervalMs;
    const firstAt = Math.ceil(now / iv) * iv;
    this.nextTickAt = firstAt;
    const kickoff = setTimeout(() => {
      this._tick();
      this.tickTimer = setInterval(() => this._tick(), iv);
      if (this.tickTimer.unref) this.tickTimer.unref();
    }, firstAt - now);
    if (kickoff.unref) kickoff.unref();
    this._kickoff = kickoff;

    this.log.info(
      `[notify] started — ${config.notify.enabled ? 'ARMED (email will be sent)' : 'DISARMED (dry run; no email will be sent)'}` +
      `, per-account cadence, base tick=${Math.round(iv / 60000)}min, first tick ${new Date(firstAt).toISOString()}`
    );
  }

  stop() {
    if (this._kickoff) { clearTimeout(this._kickoff); this._kickoff = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.resyncTimer) { clearInterval(this.resyncTimer); this.resyncTimer = null; }
    for (const [, files] of this.watchers) {
      for (const [, w] of files) { try { w.detach(); } catch {} }
    }
    this.watchers.clear();
    // Buffered entries are deliberately DROPPED rather than flushed on shutdown:
    // the service restarts automatically, and flushing on exit would turn a
    // crash-restart loop into an email flood.
    let dropped = 0;
    for (const buf of this.buffers.values()) dropped += buf.total;
    if (dropped) this.log.info(`[notify] dropped ${dropped} buffered entr${dropped === 1 ? 'y' : 'ies'} on shutdown (not sent)`);
    this.buffers.clear();
    this.dueAt.clear();
  }

  /**
   * Reconcile attached watchers with the saved settings. Incremental by design:
   * a file that is already watched keeps its existing listener untouched.
   * Detaching and re-attaching would stop the shared poller (last listener out
   * turns it off) and the replacement would resume from the new EOF, silently
   * losing every line written in between.
   */
  sync() {
    const all = store.getAll();
    // Drop watchers for accounts that are gone or no longer active.
    for (const account of [...this.watchers.keys()]) {
      const s = all[account];
      if (!s || !store.isActive(s)) this._syncAccount(account, null);
    }
    for (const [account, s] of Object.entries(all)) {
      this._syncAccount(account, store.isActive(s) ? s : null);
    }
  }

  _syncAccount(account, settings) {
    const current = this.watchers.get(account) || new Map();
    const want = new Set(settings ? settings.files : []);

    for (const [rel, w] of [...current]) {
      if (want.has(rel)) continue;
      try { w.detach(); } catch {}
      current.delete(rel);
    }

    for (const rel of want) {
      let realPath;
      try {
        realPath = resolveUnderAccount(account, rel);
      } catch {
        // The file may not exist yet (a log cPanel has not created), or may have
        // just been removed. If we are already watching that path, leave the
        // watcher alone — LiveTail follows the path and picks the file back up
        // when it reappears. Otherwise retry on the next resync.
        continue;
      }
      const existing = current.get(rel);
      if (existing && existing.realPath === realPath) continue;
      if (existing) { try { existing.detach(); } catch {} } // symlink retargeted
      const tail = getLiveTail(realPath, sourceLabel(realPath), account);
      const detach = tail.addListener((norm) => this._onEntry(account, norm));
      current.set(rel, { realPath, detach });
    }

    if (current.size) this.watchers.set(account, current);
    else this.watchers.delete(account);
  }

  // Hot path: called for every block appended to any watched file.
  _onEntry(account, norm) {
    const s = store.getRaw(account);
    if (!store.isActive(s)) return;
    if (!s.severities.includes(norm.severity)) return;

    let buf = this.buffers.get(account);
    if (!buf) {
      const now = Date.now();
      buf = { groups: new Map(), overflow: 0, total: 0, since: now };
      this.buffers.set(account, buf);
      // First entry of a new batch: schedule this account's flush at the next
      // boundary of its own cadence. Entries that arrive during the batch inherit
      // this due time; it is only re-armed after a flush or a cadence change.
      this.dueAt.set(account, nextBoundaryAfter(now, this._periodMs(account)));
    }
    const key = norm.severity + '\u0000' + norm.source + '\u0000' + signature(firstLine(norm.message));
    const tsMs = Date.parse(norm.ts) || Date.now();
    const g = buf.groups.get(key);
    if (g) {
      g.count++;
      if (tsMs > g.last) g.last = tsMs;
      if (tsMs < g.first) g.first = tsMs;
    } else if (buf.groups.size >= config.notify.maxGroups) {
      // Buffer is full of distinct messages — count it and move on. Never grow.
      buf.overflow++;
    } else {
      buf.groups.set(key, {
        severity: norm.severity,
        source: norm.source,
        sample: norm.message.slice(0, config.notify.maxSample),
        count: 1,
        first: tsMs,
        last: tsMs,
      });
    }
    buf.total++;
  }

  /** Compose (without sending or clearing) the digest an account would get now. */
  preview(account) {
    const buf = this.buffers.get(account);
    const s = store.get(account);
    if (!buf || !buf.total) return { empty: true, settings: s, recipients: this.recipientsFor(s) };
    return { empty: false, settings: s, recipients: this.recipientsFor(s), ...composeDigest(account, buf, s) };
  }

  recipientsFor(settings) {
    return RECIPIENTS.filter(r => settings.recipients.includes(r.id));
  }

  status() {
    const buffered = {};
    for (const [account, buf] of this.buffers) {
      const d = this.dueAt.get(account);
      buffered[account] = {
        total: buf.total,
        groups: buf.groups.size,
        since: buf.since,
        counts: severityCounts(buf),
        nextFlushAt: d ? d.at : null,
      };
    }
    const watching = {};
    for (const [account, files] of this.watchers) watching[account] = files.size;
    return {
      armed: config.notify.enabled,
      hasKey: !!config.notify.brevoKey,
      sender: config.notify.senderEmail || null,
      // Base tick cadence; each account batches to its own saved period instead.
      intervalMs: config.notify.intervalMs,
      nextTickAt: this.nextTickAt || null,
      lastFlushAt: this.lastFlushAt || null,
      lastError: this.lastError,
      buffered,
      watching,
    };
  }

  /**
   * Base-tick handler. Does not itself send — it decides which accounts have
   * reached the boundary of their own cadence and hands that list to flush().
   * Accounts whose cadence changed since their batch was scheduled are simply
   * re-armed to the new cadence's next boundary (never flushed early).
   */
  _tick() {
    const now = Date.now();
    this.nextTickAt = now + config.notify.intervalMs;
    const due = [];
    for (const account of this.buffers.keys()) {
      const iv = this._periodMs(account);
      const d = this.dueAt.get(account);
      if (!d || d.iv !== iv) {
        // Not yet scheduled, or the cadence was changed under it: (re)arm to the
        // next boundary of the current cadence and skip this tick.
        this.dueAt.set(account, { at: nextBoundaryAfter(now, iv), iv });
        continue;
      }
      if (now >= d.at) {
        due.push(account);
        this.dueAt.set(account, { at: nextBoundaryAfter(now, iv), iv });
      }
    }
    if (due.length) this._safeFlush(due);
  }

  // flush() already handles per-account send errors, but anything unexpected
  // escaping it would become an unhandled rejection — which terminates the
  // process on Node 15+. A broken digest must never take the log viewer down.
  _safeFlush(accounts) {
    this.flush('interval', accounts).catch((e) => {
      this.lastError = e.message;
      this.log.error(`[notify] flush failed: ${e.stack || e.message}`);
    });
  }

  /**
   * Send one digest per given account that has buffered entries. When `only` is
   * null every buffered account is flushed (manual/all); otherwise just the ones
   * the tick found due. Accounts with an empty buffer are skipped — a quiet
   * cadence produces no email.
   */
  async flush(reason = 'manual', only = null) {
    if (this.flushing) return; // a slow Brevo call must not overlap the next tick
    this.flushing = true;
    this.lastFlushAt = Date.now();
    const armed = config.notify.enabled;
    try {
      const accounts = only ? [...only] : [...this.buffers.keys()];
      for (const account of accounts) {
        const buf = this.buffers.get(account);
        if (!buf || !buf.total) { this._dropBuffer(account); continue; }

        const s = store.getRaw(account);
        if (!store.isActive(s)) { this._dropBuffer(account); continue; }
        const recips = this.recipientsFor(s);
        if (!recips.length) { this._dropBuffer(account); continue; }

        const digest = composeDigest(account, buf, s);

        if (!armed) {
          this.log.info(
            `[notify] DRY RUN (${reason}) account=${account} cadence=${s.period} — would send "${digest.subject}" to ` +
            `${recips.map(r => r.email).join(', ')} (${buf.total} entries, ${buf.groups.size} groups). ` +
            'Set LD_NOTIFY_ENABLED=1 to actually send.'
          );
          this._dropBuffer(account);
          continue;
        }

        try {
          const id = await brevo.send({ to: recips, subject: digest.subject, html: digest.html, text: digest.text });
          this.log.info(`[notify] sent account=${account} cadence=${s.period} to=${recips.map(r => r.email).join(',')} entries=${buf.total} messageId=${id || 'n/a'}`);
          this._dropBuffer(account);
          this.lastError = null;
        } catch (e) {
          // Keep the buffer so the entries roll into the next digest instead of
          // being lost. It stays bounded by maxGroups, so a long Brevo outage
          // cannot grow it without limit. dueAt was already advanced by the tick,
          // so a failed send simply retries at the next cadence boundary.
          this.lastError = `${account}: ${e.message}`;
          this.log.error(`[notify] send failed account=${account}: ${e.message} — entries kept for the next digest`);
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

module.exports = { Notifier, composeDigest, composeTest, sampleLatest, signature };
