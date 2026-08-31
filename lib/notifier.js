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
 *   WordPress theme entries are the exception to the grouping: every occurrence
 *   is kept and rendered on its own row (see expandsOccurrences).
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

/**
 * WordPress plugin noise is excluded from EMAIL only — the dashboard still
 * discovers, streams and searches these logs exactly as before. Plugins are the
 * loudest and least actionable source of deprecations and notices on a WP box,
 * and a digest full of them buries the errors worth waking up for.
 *
 * Negative lookahead rather than a trailing separator so this matches the
 * directory in every shape it appears in: `wp-content/plugins/foo/debug.log`,
 * `... in wp-content/plugins` at end of line, and `include(wp-content/plugins)`.
 * A sibling like `wp-content/pluginsdata` is correctly NOT matched.
 */
const PLUGIN_PATH_RE = /wp-content[/\\]plugins(?![A-Za-z0-9_-])/i;

/** True for any path that sits under a wp-content/plugins directory. */
function isPluginPath(p) {
  return PLUGIN_PATH_RE.test(String(p || ''));
}

/**
 * WordPress THEME problems are the opposite case to plugins: they are the ones
 * worth seeing every time. Repeats of an identical message are normally collapsed
 * into a single row carrying an occurrence count (see signature/groupKey), which
 * is right for a plugin loop but wrong for a theme — a theme fatal that fires on
 * three different requests is three things to look at, and the collapsed row
 * hides that the second and third ever happened.
 *
 * So theme entries are exempt from grouping: each occurrence is listed on its own
 * row, with its own text and its own timestamp. That matters more than it looks,
 * because signature() rewrites every digit run to '#' — `functions.php on line
 * 214` and `on line 337` are ONE group under the normal rule, and expanding is
 * what puts the real line numbers back in front of the reader.
 *
 * Same directory-shape matching as PLUGIN_PATH_RE, so `wp-content/themes/foo/x.php`,
 * a trailing `... in wp-content/themes`, and `include(wp-content/themes)` all match
 * while a sibling like `wp-content/themesbak` does not.
 */
const THEME_PATH_RE = /wp-content[/\\]themes(?![A-Za-z0-9_-])/i;

/** How many individual occurrences of one theme message a digest keeps and shows. */
const THEME_MAX_OCCURRENCES = 10;

/**
 * Occurrences retained per account buffer, across all theme groups. Bounds the
 * memory an expanded group can add: without it a box with 200 distinct theme
 * groups would hold 200 x THEME_MAX_OCCURRENCES samples, and the buffer is meant
 * to stay the same order of size it was before expansion existed.
 */
const THEME_OCCURRENCE_BUDGET = 200;

/** Total entry rows one email may render, expanded rows included. */
const MAX_RENDERED_ROWS = 80;

/**
 * Severities whose theme entries get expanded. The manager's rule is "theme
 * errors or warnings", and `critical` is included because a theme fatal is the
 * strongest case for seeing every occurrence. `info` is left grouped: it is the
 * catch-all bucket for unclassified lines, and expanding it would flood a digest.
 */
const THEME_EXPAND_SEVERITIES = new Set(['critical', 'error', 'warning']);

/** True for any path that sits under a wp-content/themes directory. */
function isThemePath(p) {
  return THEME_PATH_RE.test(String(p || ''));
}

/**
 * True when an entry's every occurrence should be listed separately instead of
 * collapsed into one counted row.
 *
 * Tested against the whole entry, mirroring isPluginEntry: a theme fatal names
 * the theme file on its opener OR somewhere in the stack frames below it, and
 * either shape is a theme problem. `norm.source` is a display label, never a
 * path, so only the message can match.
 */
function expandsOccurrences(norm) {
  return THEME_EXPAND_SEVERITIES.has(norm.severity) && isThemePath(norm.message);
}

/**
 * True when an entry is plugin-related and must never reach an email.
 *
 * Tested against the ENTIRE entry, not just its opener line: a PHP fatal names
 * the file it died in on the opener, but the stack frames that follow are where
 * a plugin usually shows up. Matching the whole block is the strict reading of
 * "no report regarding plugins" — an error routed through plugin code is plugin
 * noise even when it surfaces in core. The trade is deliberate: a core error
 * whose trace merely passes through a plugin is dropped too.
 *
 * Only the message is tested. `norm.source` is a display label built by
 * sourceLabel() ("debug.log · plugins"), never a full path, so it could not
 * match this pattern — plugin FILES are excluded by path in _syncAccount and
 * sampleLatest instead, before an entry is ever produced.
 */
function isPluginEntry(norm) {
  return isPluginPath(norm.message);
}

/**
 * An account's selected files minus the ones inside plugin directories. Used
 * everywhere the notifier reads `settings.files`, so watching, sampling and the
 * "Watching N files" footer all agree on the same number.
 */
function notifiableFiles(settings) {
  return (settings.files || []).filter(f => !isPluginPath(f));
}

/**
 * A settings object safe to hand to the email template: identical to the saved
 * one except that excluded files are not counted in the footer. Never persisted
 * — the account's real selection is left untouched on disk.
 */
function forEmail(settings) {
  const files = notifiableFiles(settings);
  return files.length === (settings.files || []).length ? settings : { ...settings, files };
}

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

/**
 * The identity of a group: same severity, same file, same normalized opener.
 * Shared by the live digest buffer and the test sampler so both collapse an
 * identical error the same way.
 */
function groupKey(norm) {
  return norm.severity + '\u0000' + norm.source + '\u0000' + signature(firstLine(norm.message));
}

/**
 * Build the group object for the first occurrence of a message. A theme group
 * also carries an `occurrences` list; occurrences[0] reuses the group's own
 * sample string rather than a second copy, so the first one is free.
 */
function makeGroup(norm, tsMs) {
  const sample = norm.message.slice(0, config.notify.maxSample);
  const g = { severity: norm.severity, source: norm.source, sample, count: 1, first: tsMs, last: tsMs };
  if (expandsOccurrences(norm)) g.occurrences = [{ ts: tsMs, sample }];
  return g;
}

/**
 * Fold a repeat into an existing group. `retain` is the caller's permission to
 * keep this occurrence's own text (the digest buffer meters that against
 * THEME_OCCURRENCE_BUDGET); returns whether it actually did, so the caller can
 * charge its budget only for occurrences that were stored.
 *
 * Shared by the live digest buffer and the test sampler so both accumulate a
 * group — and expand a theme one — exactly the same way.
 */
function addToGroup(g, norm, tsMs, retain) {
  g.count++;
  // Neither caller can assume an order: the sampler scans newest-first, and
  // timestamps within a log are not strictly monotonic. Widen both ends.
  if (tsMs < g.first) g.first = tsMs;
  if (tsMs > g.last) g.last = tsMs;
  if (!retain || !g.occurrences || g.occurrences.length >= THEME_MAX_OCCURRENCES) return false;
  g.occurrences.push({ ts: tsMs, sample: norm.message.slice(0, config.notify.maxSample) });
  return true;
}

function sortedGroups(buf) {
  return [...buf.groups.values()].sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.count - a.count));
}

/**
 * Turn the selected groups into email rows, listing every retained occurrence of
 * a theme group on a row of its own (count 1, its own text, its own timestamp)
 * while every other group stays a single counted row.
 *
 * Expansion is applied AFTER the caller has chosen which groups to show, so a
 * noisy theme message can never push another group out of the email — it only
 * spends rows. If the row budget cannot fit a whole group, that group degrades
 * to the old collapsed row instead of being cut in half or dropped: partial
 * expansion would read as "it happened 3 times" when it happened 40.
 *
 * Returns { items, collapsed, untracked } where `collapsed` counts theme groups
 * the budget could not expand and `untracked` counts occurrences beyond
 * THEME_MAX_OCCURRENCES that exist in the totals but have no row.
 */
function expandForRender(groups) {
  const items = [];
  let collapsed = 0;
  let untracked = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const occ = g.occurrences;
    if (!occ || occ.length < 2) { items.push(g); continue; }
    // Every group still to come needs at least its own collapsed row, so reserve
    // those before deciding whether this one's occurrences fit. Spending the
    // budget without the reservation lets the degraded rows land on top of an
    // already-full email and overrun MAX_RENDERED_ROWS by however many groups
    // degraded — the cap has to hold for the rows actually rendered.
    const reserved = groups.length - i - 1;
    if (items.length + occ.length + reserved > MAX_RENDERED_ROWS) { items.push(g); collapsed++; continue; }
    // Oldest first, so an expanded group reads as the sequence it actually was.
    for (const o of [...occ].sort((a, b) => a.ts - b.ts)) {
      items.push({ severity: g.severity, source: g.source, sample: o.sample, count: 1, first: o.ts, last: o.ts });
    }
    untracked += g.count - occ.length;
  }
  return { items, collapsed, untracked };
}

/** The notes explaining what expansion could not show. Shared by digest and test. */
function expansionNotes({ collapsed, untracked }) {
  const notes = [];
  if (collapsed > 0) {
    notes.push(`${collapsed} theme message${collapsed === 1 ? '' : 's'} shown as a single grouped row instead of one row per occurrence (this email reached its ${MAX_RENDERED_ROWS}-entry limit).`);
  }
  if (untracked > 0) {
    notes.push(`${untracked} further theme occurrence${untracked === 1 ? ' is' : 's are'} counted above but not listed individually — at most ${THEME_MAX_OCCURRENCES} occurrences of one message are listed.`);
  }
  return notes;
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
  const { items, collapsed, untracked } = expandForRender(shown);
  const windowLine = `${fmtTime(buf.since)} → ${fmtTime(Date.now())}`;

  const notes = [];
  if (hiddenGroups > 0) notes.push(`+${hiddenGroups} more distinct message${hiddenGroups === 1 ? '' : 's'} not shown.`);
  if (buf.overflow) notes.push(`${buf.overflow} further entr${buf.overflow === 1 ? 'y' : 'ies'} were not grouped (per-digest group cap of ${config.notify.maxGroups} reached).`);
  notes.push(...expansionNotes({ collapsed, untracked }));

  const { html, text } = renderEmail({
    kind: 'digest',
    account,
    senderName: config.notify.senderName,
    subject,
    windowLine,
    counts,
    items,
    notes,
    settings: forEmail(settings),
    cadence: periodPhrase(settings.period),
    dashboardUrl: config.dashboardUrl,
  });
  // `groups` stays the count of distinct MESSAGES, not of rendered rows, so an
  // expanded digest still reports how many things broke rather than how many
  // rows it took to say so.
  return { subject, html, text, counts, total: buf.total, groups: groups.length };
}

/**
 * Read the newest entries for each subscribed severity out of the account's
 * selected files, newest first, grouping identical ones exactly the way the live
 * digest buffer does: a critical that repeats 300 times is ONE entry carrying a
 * count of 300, never 300 rows. Used to fill the test email with real content
 * rather than lorem text — a delivery test that shows nothing you would
 * recognise is only half a test.
 *
 * Keeps up to `perSeverity` DISTINCT messages per severity. Because repeats are
 * counted instead of listed, the scan can no longer stop at the first N matches
 * the way the ungrouped version did — an occurrence count only means something
 * over a known span — so it runs to a fixed entry cap and reports whether that
 * cap cut it short.
 *
 * Bounded on every axis: a byte budget per file, a byte budget overall, and a
 * cap on entries scanned. A severity filter forces a backwards scan (the newest
 * tail may contain none of the wanted severity), which is exactly the workload
 * that could otherwise walk gigabytes on a busy box.
 *
 * Returns { bySev: Map<severity, group[]>, scanned, capped, omitted }.
 */
async function sampleLatest(account, settings, perSeverity = 5) {
  const wanted = new Set(settings.severities);
  const bySev = new Map([...wanted].map(s => [s, new Map()])); // severity -> key -> group
  const perFileCap = config.notify.sampleMaxBytesPerFile;
  let budget = config.notify.sampleMaxBytesTotal;
  let remaining = Math.max(1, config.notify.sampleMaxBlocks);
  let scanned = 0;
  let omitted = 0; // matched the filter but belongs to no kept group

  // Excluded files are dropped before the scan so their bytes never even count
  // against the budget — the sample spends its whole allowance on files that can
  // actually appear in an email.
  for (const rel of notifiableFiles(settings)) {
    if (budget <= 0 || remaining <= 0) break;
    let real;
    try { real = resolveUnderAccount(account, rel); } catch { continue; }
    if (isPluginPath(real)) continue; // symlink pointing into a plugin directory
    const label = sourceLabel(real);
    const take = Math.min(perFileCap, budget);
    budget -= take;
    try {
      const gen = readBlocksReverse(real, { maxBytes: take, maxBlocks: remaining });
      for await (const block of gen) {
        remaining--;
        scanned++;
        const norm = normalize(block, label, account, new Date());
        // Plugin entries fall out here rather than via `continue`, so the
        // remaining-budget break at the bottom of the loop still runs. They are
        // not added to `omitted` either — that number means "matched but not
        // shown", and an excluded entry never matched.
        if (wanted.has(norm.severity) && !isPluginEntry(norm)) {
          const groups = bySev.get(norm.severity);
          const key = groupKey(norm);
          const tsMs = Date.parse(norm.ts) || Date.now();
          const g = groups.get(key);
          if (g) {
            // Always allowed to retain: a sample holds at most perSeverity groups
            // per severity, so occurrence storage here is bounded by construction
            // and needs no budget of the kind the long-lived digest buffer keeps.
            addToGroup(g, norm, tsMs, true);
          } else if (groups.size < perSeverity) {
            groups.set(key, makeGroup(norm, tsMs));
          } else {
            omitted++;
          }
        }
        if (remaining <= 0) break;
      }
    } catch { /* unreadable file — skip, the others still sample */ }
  }
  return { bySev, scanned, capped: remaining <= 0, omitted };
}

/**
 * Test email: the newest distinct messages of each subscribed severity, in the
 * same template as a real digest, so what you approve here is what you will get
 * — including the grouping, so a repeating critical looks the same in both.
 */
async function composeTest(account, settings, perSeverity = 5) {
  const { bySev, scanned, capped, omitted } = await sampleLatest(account, settings, perSeverity);
  const selected = [];
  const counts = {};
  for (const sev of [...bySev.keys()].sort((a, b) => SEV_RANK[a] - SEV_RANK[b])) {
    // Same order as a digest: loudest first, then most recent.
    const arr = [...bySev.get(sev).values()].sort((a, b) => (b.count - a.count) || (b.last - a.last));
    for (const g of arr) counts[sev] = (counts[sev] || 0) + g.count;
    selected.push(...arr);
  }
  // Expanded the same way a digest is, so a theme error that will arrive as one
  // row per occurrence also previews as one row per occurrence.
  const { items, collapsed, untracked } = expandForRender(selected);
  // The chips and the subject count OCCURRENCES; `groups` is how many distinct
  // messages were found, which is not the row count once themes are expanded.
  const groups = selected.length;
  const found = Object.values(counts).reduce((a, b) => a + b, 0);
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
  if (omitted > 0) {
    notes.push(`${omitted} further entr${omitted === 1 ? 'y' : 'ies'} matched but ${omitted === 1 ? 'is' : 'are'} not shown — a test shows at most ${perSeverity} distinct message${perSeverity === 1 ? '' : 's'} per severity.`);
  }
  if (capped && found) {
    notes.push(`Occurrence counts cover the newest ${scanned} entries scanned; anything older than that is not counted.`);
  }
  notes.push(...expansionNotes({ collapsed, untracked }));
  // Counts describe what was actually sampled, so they use the notifiable set.
  // A selection made up entirely of plugin logs reads as "nothing to sample"
  // rather than silently reporting a file count that produced no rows.
  const sampled = notifiableFiles(settings);
  const excluded = (settings.files || []).length - sampled.length;
  if (excluded > 0) {
    notes.push(`${excluded} selected file${excluded === 1 ? '' : 's'} under wp-content/plugins ${excluded === 1 ? 'is' : 'are'} excluded from email notifications; ${excluded === 1 ? 'it is' : 'they are'} still viewable in the dashboard.`);
  }
  if (!sampled.length) {
    notes.push(excluded > 0
      ? 'Every selected log file is inside a plugin directory, so there is nothing left to sample.'
      : 'No log files are selected for this account.');
  }

  const { html, text } = renderEmail({
    kind: 'test',
    account,
    senderName: config.notify.senderName,
    subject,
    windowLine: found
      ? `Newest ${perSeverity} distinct message${perSeverity === 1 ? '' : 's'} per severity, repeats grouped except theme entries — sampled from ${sampled.length} watched file${sampled.length === 1 ? '' : 's'}`
      : `Sampled ${sampled.length} watched file${sampled.length === 1 ? '' : 's'} — nothing matched`,
    counts,
    items,
    notes,
    settings: forEmail(settings),
    cadence: periodPhrase(settings.period),
    dashboardUrl: config.dashboardUrl,
  });
  return { subject, html, text, counts, total: found, groups };
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
    // Plugin logs are filtered out here rather than at send time, so no watcher
    // is ever attached to them: excluded files cost zero polling. An account
    // that later deselects a plugin file needs no special handling — it was
    // never in `want`, so the detach loop below simply never had it.
    const want = new Set(settings ? notifiableFiles(settings) : []);

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
      // Re-checked after resolution: `rel` can be an innocuous-looking path that
      // symlinks into a plugin directory.
      if (isPluginPath(realPath)) continue;
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
    // Second line of defence. _syncAccount already refuses to watch files inside
    // plugin directories, but plugin errors overwhelmingly arrive through an
    // ordinary public_html/error_log that names the plugin file in the entry
    // itself — that is what this catches, and it is the common case.
    if (isPluginEntry(norm)) return;

    let buf = this.buffers.get(account);
    if (!buf) {
      const now = Date.now();
      // occBudget meters how many theme occurrences this buffer may keep the
      // individual text of, across all its groups — see THEME_OCCURRENCE_BUDGET.
      buf = { groups: new Map(), overflow: 0, total: 0, since: now, occBudget: THEME_OCCURRENCE_BUDGET };
      this.buffers.set(account, buf);
      // First entry of a new batch: schedule this account's flush at the next
      // boundary of its own cadence. Entries that arrive during the batch inherit
      // this due time; it is only re-armed after a flush or a cadence change.
      // Shape must match what _tick writes ({ at, iv }, never a bare number): the
      // tick treats a missing `iv` as a cadence change and re-arms instead of
      // flushing, which would silently push every batch's first digest out by a
      // whole base tick, and status() reads `.at` for nextFlushAt.
      const iv = this._periodMs(account);
      this.dueAt.set(account, { at: nextBoundaryAfter(now, iv), iv });
    }
    const key = groupKey(norm);
    const tsMs = Date.parse(norm.ts) || Date.now();
    const g = buf.groups.get(key);
    if (g) {
      // A retained occurrence costs one unit of the buffer's budget. Once it is
      // spent, theme repeats still count towards the group's total — they just
      // stop getting a row of their own, which is the pre-expansion behaviour.
      if (addToGroup(g, norm, tsMs, buf.occBudget > 0)) buf.occBudget--;
    } else if (buf.groups.size >= config.notify.maxGroups) {
      // Buffer is full of distinct messages — count it and move on. Never grow.
      buf.overflow++;
    } else {
      buf.groups.set(key, makeGroup(norm, tsMs));
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

module.exports = {
  Notifier, composeDigest, composeTest, sampleLatest, signature,
  isPluginPath, isPluginEntry, notifiableFiles, PLUGIN_PATH_RE,
  isThemePath, expandsOccurrences, expandForRender, THEME_PATH_RE,
  THEME_MAX_OCCURRENCES, MAX_RENDERED_ROWS, MAX_RENDERED_GROUPS,
};
