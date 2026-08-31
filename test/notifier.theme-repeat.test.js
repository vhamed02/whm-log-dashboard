'use strict';
/**
 * Theme re-reporting tests for lib/notifier.js.
 *
 * The rule under test: a theme error/warning keeps being reported in EVERY
 * digest for as long as its lines are present in the log file, and stops only
 * when those lines are removed. Repeats are labelled so a reader can tell an
 * unfixed problem from a fresh one. Everything else is still reported exactly
 * once, because the watcher only reads bytes appended after it attached.
 *
 * Zero dependencies: node:test + node:assert, both built in.
 *
 * A temp home is created and LD_HOME_ROOT/LD_NOTIFY_DATA_DIR pointed at it
 * BEFORE lib/config is required, because security.js reads config.homeRoot into
 * a const at load time.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-theme-repeat-'));
const ACCOUNT = 'testacct';
const HOME = path.join(ROOT, 'home');
const ACCOUNT_HOME = path.join(HOME, ACCOUNT);
const LOG_DIR = path.join(ACCOUNT_HOME, 'public_html');
const LOG = path.join(LOG_DIR, 'error_log');
fs.mkdirSync(LOG_DIR, { recursive: true });
process.env.LD_HOME_ROOT = HOME;
process.env.LD_NOTIFY_DATA_DIR = path.join(ROOT, 'data');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const N = require('../lib/notifier');
const store = require('../lib/notify-store');
const state = require('../lib/notify-state');
const { RECIPIENTS } = require('../lib/config');

// ---------------------------------------------------------------- fixtures

const THEME = '/home/testacct/public_html/wp-content/themes/astra/functions.php';
const CORE = '/home/testacct/public_html/wp-includes/post.php';
const PLUGIN = '/home/testacct/public_html/wp-content/plugins/wpforms/loader.php';

const themeFatal = (n) => `[31-Aug-2026 10:0${n}:00 UTC] PHP Fatal error: Uncaught Error: theme boom in ${THEME} on line 214`;
const coreWarn = (n) => `[31-Aug-2026 10:0${n}:00 UTC] PHP Warning: undefined index in ${CORE} on line 9`;
const pluginFatal = (n) => `[31-Aug-2026 10:0${n}:00 UTC] PHP Fatal error: plugin boom in ${PLUGIN} on line 5`;

function writeLog(lines) { fs.writeFileSync(LOG, lines.join('\n') + '\n'); }

function settings(over = {}) {
  return {
    enabled: true,
    severities: ['critical', 'error', 'warning'],
    recipients: [(RECIPIENTS[0] || { id: 'x' }).id],
    files: ['public_html/error_log'],
    period: '1h',
    updatedAt: Date.now(),
    ...over,
  };
}

const SILENT = { info() {}, error() {}, warn() {} };

function notifierWith(s) {
  store.getRaw = () => s;
  store.get = () => s;
  store.getAll = () => ({ [ACCOUNT]: s });
  return new N.Notifier(SILENT);
}

// The label the watcher attaches to entries from this file. Both the live
// watcher (_syncAccount) and the rescan (scanThemeGroups) build it with
// sourceLabel(realPath), and groupKey includes it — so if these two ever
// disagreed, the buffer copy and the scanned copy of one message would land in
// different groups and be counted twice. Derived here rather than hardcoded so
// the test keeps agreeing with the implementation.
const { sourceLabel } = require('../lib/stream');
const SOURCE = sourceLabel(LOG);

/** Feed entries through the live watcher path. */
function entry(severity, message, tsMs) {
  return { ts: new Date(tsMs).toISOString(), severity, message, source: SOURCE, account: ACCOUNT };
}

// Timestamps parsed out of the fixture lines above, so "before/after the last
// email" can be controlled precisely.
const LOG_TS = Date.parse('2026-08-31T10:00:00Z');
// The fixture lines are stamped 10:01 to 10:03, so these two sit clear of them
// on either side: BEFORE is an email sent after every line was written, LONG_AGO
// one sent before any of them.
const BEFORE = Date.parse('2026-08-31T10:05:00Z');
const LONG_AGO = Date.parse('2026-08-31T09:59:00Z');

// ============================================ 1. the core requirement

test('a theme error still in the log is reported again in the next digest', async () => {
  writeLog([themeFatal(1)]);
  // Pretend a digest already went out AFTER that line was written: under the old
  // behaviour the line was emailed once and could never appear again.
  const scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal(scan.groups.size, 1, 'the line is found again by re-reading the file');
  const g = [...scan.groups.values()][0];
  assert.equal(g.count, 1);
  assert.equal(g.newSince, 0, 'nothing new since the last email');
  assert.equal(g.fromLog, true);
});

test('removing the lines is what stops the reporting', async () => {
  writeLog([themeFatal(1), themeFatal(2)]);
  let scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal(scan.groups.size, 1, 'reported while present');
  assert.equal([...scan.groups.values()][0].count, 2);

  // The team fixes the theme and clears those lines out of the log.
  writeLog([coreWarn(1)]);
  scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal(scan.groups.size, 0, 'gone from the log means gone from the digest');
});

test('an empty log file reports nothing', async () => {
  writeLog([]);
  const scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal(scan.groups.size, 0);
});

// ============================================ 2. only themes repeat

test('non-theme entries are never picked up by the rescan', async () => {
  writeLog([coreWarn(1), coreWarn(2), coreWarn(3)]);
  const scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal(scan.groups.size, 0, 'core warnings are reported once, from the buffer, and never again');
});

test('plugin entries stay excluded from the rescan', async () => {
  writeLog([pluginFatal(1)]);
  const scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal(scan.groups.size, 0);
});

test('an entry naming both a theme and a plugin is still plugin noise', async () => {
  writeLog([`[31-Aug-2026 10:01:00 UTC] PHP Fatal error: boom in ${THEME}`, `#0 ${PLUGIN}(12): go()`]);
  const scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal(scan.groups.size, 0, 'plugin exclusion wins over theme re-reporting');
});

test('theme info is not re-reported', async () => {
  writeLog([`[31-Aug-2026 10:01:00 UTC] Something unremarkable happened in ${THEME}`]);
  const scan = await N.scanThemeGroups(ACCOUNT, settings({ severities: ['critical', 'error', 'warning', 'info'] }), BEFORE);
  assert.equal(scan.groups.size, 0, 'info is the unclassified catch-all and would flood the digest');
});

test('the account severity filter still applies', async () => {
  writeLog([themeFatal(1)]);  // classifies as critical
  const scan = await N.scanThemeGroups(ACCOUNT, settings({ severities: ['warning'] }), BEFORE);
  assert.equal(scan.groups.size, 0, 'an account not subscribed to critical does not get it');
});

// ============================================ 3. repeat labelling

test('markRepeat: everything already seen is labelled "still in the log"', () => {
  const g = { severity: 'critical', source: 'error_log', sample: 'x', count: 3, first: 1, last: 2, newSince: 0, fromLog: true };
  const m = N.markRepeat(g, 100);
  assert.deepEqual(m.repeat, { kind: 'all' });
});

test('markRepeat: a repeat that fired again names how many are new', () => {
  const g = { severity: 'critical', source: 'error_log', sample: 'x', count: 5, first: 1, last: 9, newSince: 2, fromLog: true };
  const m = N.markRepeat(g, 100);
  assert.deepEqual(m.repeat, { kind: 'partial', fresh: 2 });
});

test('markRepeat: a wholly new problem carries no label', () => {
  const g = { severity: 'critical', source: 'error_log', sample: 'x', count: 4, first: 1, last: 9, newSince: 4, fromLog: true };
  assert.equal(N.markRepeat(g, 100).repeat, undefined);
});

test('markRepeat: the very first email labels nothing as a repeat', () => {
  const g = { severity: 'critical', source: 'error_log', sample: 'x', count: 4, first: 1, last: 9, newSince: 0, fromLog: true };
  assert.equal(N.markRepeat(g, 0).repeat, undefined, 'nothing was ever sent, so nothing was "already reported"');
});

test('scanThemeGroups counts repeat occurrences against the last email too', async () => {
  // Multiple occurrences of ONE message, all written before the last email. The
  // first occurrence and the repeats take different code paths (group creation
  // vs increment), so both have to be checked against lastSentAt or a repeat
  // silently reads as new.
  writeLog([themeFatal(1), themeFatal(2), themeFatal(3)]);
  const seen = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  const g = [...seen.groups.values()][0];
  assert.equal(g.count, 3);
  assert.equal(g.newSince, 0, 'every occurrence predates the last email');
  assert.deepEqual(N.markRepeat(g, BEFORE).repeat, { kind: 'all' });

  // Same three lines, but the last email went out before they were written.
  const fresh = [...(await N.scanThemeGroups(ACCOUNT, settings(), LONG_AGO)).groups.values()][0];
  assert.equal(fresh.newSince, 3, 'all three are new');
  assert.equal(N.markRepeat(fresh, LONG_AGO).repeat, undefined);

  // And a genuine mix: an email sent between the second and third line.
  const between = Date.parse('2026-08-31T10:02:30Z');
  const mixed = [...(await N.scanThemeGroups(ACCOUNT, settings(), between)).groups.values()][0];
  assert.equal(mixed.count, 3);
  assert.equal(mixed.newSince, 1, 'only the line written after the email is new');
  assert.deepEqual(N.markRepeat(mixed, between).repeat, { kind: 'partial', fresh: 1 });
});

test('scanThemeGroups splits occurrences either side of the last email', async () => {
  writeLog([themeFatal(1)]);
  const seen = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.equal([...seen.groups.values()][0].newSince, 0, 'written before the last email');
  const fresh = await N.scanThemeGroups(ACCOUNT, settings(), LONG_AGO);
  assert.equal([...fresh.groups.values()][0].newSince, 1, 'written after the last email');
});

// ============================================ 4. the digest email

test('composeDigest labels a repeat in both the HTML and the text part', async () => {
  writeLog([themeFatal(1)]);
  const theme = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  const d = N.composeDigest(ACCOUNT, null, settings(), theme);
  assert.equal(d.repeated, 1);
  assert.match(d.html, /already reported/i);
  assert.match(d.text, /ALREADY REPORTED/);
  assert.match(d.text, /still in the log/i);
  assert.match(d.text, /logged /, 'the time the log recorded it is shown');
  assert.match(d.text, /until those lines are removed/i, 'and the email says how to make it stop');
});

test('composeDigest sends a digest for an account with NO buffered entries at all', async () => {
  writeLog([themeFatal(1), themeFatal(2)]);
  const theme = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  const d = N.composeDigest(ACCOUNT, null, settings(), theme);
  assert.equal(d.total, 2, 'a quiet hour still reports the open theme fault');
  assert.equal(d.groups, 1);
  assert.match(d.subject, /2 critical/);
});

test('composeDigest merges the buffer with the rescan without double counting', async () => {
  // The same theme line is BOTH in the live buffer (it arrived this hour) and in
  // the file (the rescan re-reads it). It must be counted once.
  writeLog([themeFatal(1)]);
  const n = notifierWith(settings());
  n._onEntry(ACCOUNT, entry('critical', `PHP Fatal error: Uncaught Error: theme boom in ${THEME} on line 214`, LOG_TS));
  const buf = n.buffers.get(ACCOUNT);
  assert.equal(buf.total, 1, 'the watcher still buffers theme entries');

  const theme = await N.scanThemeGroups(ACCOUNT, settings(), LONG_AGO);
  const d = N.composeDigest(ACCOUNT, buf, settings(), theme);
  assert.equal(d.groups, 1, 'one message, not two');
  assert.equal(d.total, 1, 'counted once, not twice');
});

test('a theme entry rotated out of the log is still sent from the buffer', async () => {
  // Arrived this hour, then the log was rotated away before the digest ran. The
  // rescan finds nothing, so the buffer copy must survive.
  writeLog([]);
  const n = notifierWith(settings());
  n._onEntry(ACCOUNT, entry('critical', `PHP Fatal error: theme boom in ${THEME} on line 1`, LOG_TS));
  const theme = await N.scanThemeGroups(ACCOUNT, settings(), LONG_AGO);
  assert.equal(theme.groups.size, 0);
  const d = N.composeDigest(ACCOUNT, n.buffers.get(ACCOUNT), settings(), theme);
  assert.equal(d.total, 1, 'not lost just because the file no longer has it');
});

test('a partially rotated log keeps the buffer copy, which holds more', async () => {
  // Five occurrences arrived this window, then rotation trimmed the file down to
  // two of them before the digest ran. The scan can now see fewer than the
  // buffer, and taking the scan blindly would under-report what actually
  // happened, so the larger copy has to win.
  writeLog([themeFatal(1), themeFatal(2)]);
  const n = notifierWith(settings());
  for (let i = 0; i < 5; i++) {
    n._onEntry(ACCOUNT, entry('critical', `PHP Fatal error: Uncaught Error: theme boom in ${THEME} on line 214`, LOG_TS + i));
  }
  const buf = n.buffers.get(ACCOUNT);
  assert.equal(buf.total, 5);

  const theme = await N.scanThemeGroups(ACCOUNT, settings(), LONG_AGO);
  assert.equal([...theme.groups.values()][0].count, 2, 'the file only has two left');

  const d = N.composeDigest(ACCOUNT, buf, settings(), theme);
  assert.equal(d.groups, 1, 'still one message');
  assert.equal(d.total, 5, 'and all five occurrences are reported, not just the two still on disk');
});

test('non-theme entries still reach the digest from the buffer', async () => {
  writeLog([]);
  const n = notifierWith(settings());
  for (let i = 0; i < 25; i++) {
    n._onEntry(ACCOUNT, entry('warning', `PHP Warning: undefined index in ${CORE} on line 9`, LOG_TS + i));
  }
  const theme = await N.scanThemeGroups(ACCOUNT, settings(), LONG_AGO);
  const d = N.composeDigest(ACCOUNT, n.buffers.get(ACCOUNT), settings(), theme);
  assert.equal(d.counts.warning, 25, 'grouped into one row carrying its count, exactly as before');
  assert.equal(d.groups, 1);
  assert.equal(d.repeated, 0, 'and never labelled a repeat — it is reported once only');
});

test('composeDigest is pure — previewing must not consume anything', async () => {
  writeLog([themeFatal(1)]);
  const theme = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  const before = JSON.stringify([...theme.groups.values()]);
  N.composeDigest(ACCOUNT, null, settings(), theme);
  N.composeDigest(ACCOUNT, null, settings(), theme);
  assert.equal(JSON.stringify([...theme.groups.values()]), before);
});

test('the watcher and the rescan label a file identically', async () => {
  // groupKey includes the source label. If the live path and the rescan derived
  // it differently, one message would occupy two groups and be counted twice.
  writeLog([themeFatal(1)]);
  const scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  const scanned = [...scan.groups.values()][0];
  assert.equal(scanned.source, SOURCE, 'the rescan uses the same label the watcher does');
});

// ============================================ 5. scheduling

test('an active account is scheduled even though nothing has been buffered', () => {
  const n = notifierWith(settings());
  n.sync();
  assert.ok(n.dueAt.has(ACCOUNT),
    'before re-reporting the schedule was created by the first entry to arrive; a quiet account is exactly the one that needs the re-check');
  assert.equal(n.buffers.has(ACCOUNT), false, 'and it has no buffer');
});

test('clearing a buffer does not unschedule the account', () => {
  const n = notifierWith(settings());
  n.sync();
  n._dropBuffer(ACCOUNT);
  assert.ok(n.dueAt.has(ACCOUNT), 'it must still be visited next cadence');
});

test('an inactive account is unscheduled entirely', () => {
  const n = notifierWith(settings());
  n.sync();
  assert.ok(n.dueAt.has(ACCOUNT));
  store.getAll = () => ({ [ACCOUNT]: settings({ enabled: false }) });
  n.sync();
  assert.equal(n.dueAt.has(ACCOUNT), false);
});

// ============================================ 6. bounds

test('the rescan is bounded and says when it stopped early', async () => {
  writeLog(Array.from({ length: 400 }, (_, i) => themeFatal(i % 10)));
  const scan = await N.scanThemeGroups(ACCOUNT, settings(), BEFORE);
  assert.ok(scan.scanned > 0);
  assert.ok(scan.groups.size >= 1);
  assert.equal(typeof scan.capped, 'boolean');
});

test('a missing log file does not throw', async () => {
  const scan = await N.scanThemeGroups(ACCOUNT, settings({ files: ['public_html/does-not-exist'] }), BEFORE);
  assert.equal(scan.groups.size, 0);
});

test('an account subscribed to no theme severity skips the scan entirely', async () => {
  writeLog([themeFatal(1)]);
  const scan = await N.scanThemeGroups(ACCOUNT, settings({ severities: ['info'] }), BEFORE);
  assert.equal(scan.groups.size, 0);
  assert.equal(scan.scanned, 0, 'no file is read at all');
});

// ============================================ 7. last-sent state

test('notify-state records a send time and survives a reload', async () => {
  await state.setLastSentAt(ACCOUNT, 1_700_000_000_000);
  assert.equal(state.getLastSentAt(ACCOUNT), 1_700_000_000_000);
  state.load();
  assert.equal(state.getLastSentAt(ACCOUNT), 1_700_000_000_000, 'a restart must not turn every repeat back into "new"');
  await state.forget(ACCOUNT);
  assert.equal(state.getLastSentAt(ACCOUNT), 0);
});

test('notify-state treats an unknown account as never sent', () => {
  assert.equal(state.getLastSentAt('nobody'), 0);
});

process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });
