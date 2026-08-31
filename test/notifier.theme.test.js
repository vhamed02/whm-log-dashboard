'use strict';
/**
 * Theme-expansion tests for lib/notifier.js.
 *
 * The rule under test: a critical/error/warning entry naming a wp-content/themes
 * path is listed ONE ROW PER OCCURRENCE, so the differing line numbers survive.
 * Everything else — core, plugins, uploads, mu-plugins, and theme `info` — stays
 * collapsed into a single row carrying an occurrence count.
 *
 * Zero dependencies: node:test + node:assert, both built in.
 *
 * The fixture home is created and LD_HOME_ROOT pointed at it BEFORE lib/config
 * is required, because security.js reads config.homeRoot into a const at load.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-notifier-test-'));
const ACCOUNT = 'testacct';
const ACCOUNT_HOME = path.join(HOME_ROOT, ACCOUNT);
fs.mkdirSync(path.join(ACCOUNT_HOME, 'public_html'), { recursive: true });
process.env.LD_HOME_ROOT = HOME_ROOT;
process.env.LD_NOTIFY_DATA_DIR = path.join(HOME_ROOT, '.data');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const N = require('../lib/notifier');
const store = require('../lib/notify-store');
const { config } = require('../lib/config');

// ---------------------------------------------------------------- helpers

const THEME_FN = '/home/testacct/public_html/wp-content/themes/astra/functions.php';
const CORE_FN = '/home/testacct/public_html/wp-includes/post.php';
const PLUGIN_FN = '/home/testacct/public_html/wp-content/plugins/wpforms/loader.php';

/** A normalized entry, the shape lib/stream.js normalize() produces. */
function entry(severity, message, tsMs = Date.now()) {
  return { ts: new Date(tsMs).toISOString(), severity, message, source: 'error_log', account: ACCOUNT };
}

function settings(over = {}) {
  return {
    enabled: true,
    severities: ['critical', 'error', 'warning'],
    recipients: [(require('../lib/config').RECIPIENTS[0] || { id: 'x' }).id],
    files: ['public_html/error_log'],
    period: 'hourly',
    updatedAt: Date.now(),
    ...over,
  };
}

const SILENT = { info() {}, error() {}, warn() {} };

/** A Notifier with the settings store stubbed — no timers, no disk, no email. */
function notifierWith(s) {
  store.getRaw = () => s;
  const n = new N.Notifier(SILENT);
  return n;
}

/** Feed entries through the live hot path and return the resulting buffer. */
function bufferFrom(entries, s = settings()) {
  const n = notifierWith(s);
  for (const e of entries) n._onEntry(ACCOUNT, e);
  return n.buffers.get(ACCOUNT);
}

function groupsOf(buf) {
  return buf ? [...buf.groups.values()] : [];
}

// ================================================================ 1. paths

test('THEME_PATH_RE matches a themes directory in every shape it appears', () => {
  for (const p of [
    '/home/a/public_html/wp-content/themes/astra/functions.php',
    'wp-content/themes/astra',
    'wp-content\\themes\\astra',            // Windows-style separator
    'PHP Fatal error: boom in wp-content/themes',  // trailing, end of line
    'include(wp-content/themes)',
    'WP-CONTENT/THEMES/Astra/x.php',        // case-insensitive
  ]) {
    assert.equal(N.isThemePath(p), true, p);
  }
});

test('THEME_PATH_RE does not match lookalike siblings', () => {
  for (const p of [
    'wp-content/themesbak/x.php',
    'wp-content/themes-data/x.php',
    'wp-content/themes_old/x.php',
    'wp-content/plugins/foo/x.php',
    'wp-content/mu-plugins/x.php',
    'wp-content/uploads/themes.php',
    '/home/a/public_html/theme.php',
    'PHP Warning: themes could not be loaded',
    '',
    null,
  ]) {
    assert.equal(N.isThemePath(p), false, String(p));
  }
});

// ======================================================= 2. severity gating

test('theme entries expand at critical, error and warning only', () => {
  for (const sev of ['critical', 'error', 'warning']) {
    assert.equal(N.expandsOccurrences(entry(sev, `boom in ${THEME_FN} on line 214`)), true, sev);
  }
  assert.equal(N.expandsOccurrences(entry('info', `boom in ${THEME_FN} on line 214`)), false,
    'info is the unclassified catch-all and must stay grouped');
});

test('a theme named only in a stack frame still expands', () => {
  const multi = `PHP Fatal error: Uncaught Error: boom\nStack trace:\n#0 ${THEME_FN}(88): go()\n  thrown in /home/a/wp-includes/x.php on line 3`;
  assert.equal(N.expandsOccurrences(entry('critical', multi)), true);
});

test('nothing outside wp-content/themes ever expands', () => {
  const others = [CORE_FN, PLUGIN_FN, '/home/a/wp-admin/includes/file.php',
    '/home/a/wp-content/mu-plugins/x.php', '/home/a/wp-content/uploads/x.php',
    '/home/a/wp-content/themesbak/x.php', '/home/a/public_html/index.php'];
  for (const f of others) {
    for (const sev of ['critical', 'error', 'warning', 'info']) {
      assert.equal(N.expandsOccurrences(entry(sev, `boom in ${f} on line 9`)), false, `${sev} ${f}`);
    }
  }
});

// ============================================ 3. live hot path (_onEntry)

test('_onEntry: repeated theme errors keep one occurrence each, with real line numbers', () => {
  const buf = bufferFrom([
    entry('critical', `PHP Fatal error: boom in ${THEME_FN} on line 214`, 1_000),
    entry('critical', `PHP Fatal error: boom in ${THEME_FN} on line 337`, 2_000),
    entry('critical', `PHP Fatal error: boom in ${THEME_FN} on line 900`, 3_000),
  ]);
  const g = groupsOf(buf);
  assert.equal(g.length, 1, 'the three collapse into ONE group (signature normalises digits)');
  assert.equal(g[0].count, 3);
  assert.equal(g[0].occurrences.length, 3, 'but all three occurrences are retained individually');
  const texts = g[0].occurrences.map(o => o.sample).join('|');
  for (const line of ['214', '337', '900']) assert.match(texts, new RegExp(line));
  assert.equal(buf.total, 3);
});

test('_onEntry: non-theme repeats are collapsed and carry NO occurrences list', () => {
  const buf = bufferFrom(Array.from({ length: 25 }, (_, i) =>
    entry('error', `PHP Parse error: boom in ${CORE_FN} on line ${i}`, 1000 + i)));
  const g = groupsOf(buf);
  assert.equal(g.length, 1);
  assert.equal(g[0].count, 25, 'full occurrence count is preserved');
  assert.equal(g[0].occurrences, undefined, 'no per-occurrence storage for non-theme entries');
});

test('_onEntry: theme info is grouped like anything else', () => {
  const buf = bufferFrom([
    entry('info', `notice in ${THEME_FN} on line 1`, 1000),
    entry('info', `notice in ${THEME_FN} on line 2`, 2000),
  ], settings({ severities: ['critical', 'error', 'warning', 'info'] }));
  const g = groupsOf(buf);
  assert.equal(g.length, 1);
  assert.equal(g[0].occurrences, undefined);
});

test('_onEntry: plugin exclusion still wins over theme expansion', () => {
  // An entry naming BOTH a theme and a plugin is plugin noise and is dropped
  // from email entirely — the documented strict reading of the plugin rule.
  const buf = bufferFrom([
    entry('critical', `PHP Fatal error: boom in ${THEME_FN}\n#0 ${PLUGIN_FN}(12): go()`, 1000),
  ]);
  assert.equal(buf, undefined, 'no buffer is created at all — the entry never counted');
});

test('_onEntry: per-message cap keeps at most THEME_MAX_OCCURRENCES rows but the full count', () => {
  const buf = bufferFrom(Array.from({ length: 40 }, (_, i) =>
    entry('error', `PHP Parse error: boom in ${THEME_FN} on line ${i}`, 1000 + i)));
  const g = groupsOf(buf)[0];
  assert.equal(g.count, 40, 'every occurrence still counts towards the total');
  assert.equal(g.occurrences.length, N.THEME_MAX_OCCURRENCES, 'but only 10 are retained');
});

test('_onEntry: the per-buffer occurrence budget bounds memory across many theme groups', () => {
  // 25 distinct theme messages x 10 occurrences each = 250 entries.
  // occurrences[0] of each group is free (it reuses the group's own sample), so
  // the budget only meters the repeats: 25 free + 200 budget = 225 retained.
  const entries = [];
  for (let m = 0; m < 25; m++) {
    for (let i = 0; i < 10; i++) {
      entries.push(entry('error', `PHP Parse error: fault_${String.fromCharCode(97 + m)} in ${THEME_FN} on line ${i}`, 1000 + i));
    }
  }
  const buf = bufferFrom(entries);
  const g = groupsOf(buf);
  assert.equal(g.length, 25, 'one group per distinct message');
  assert.equal(buf.total, 250);
  for (const grp of g) assert.equal(grp.count, 10, 'counts are exact regardless of retention');
  const retained = g.reduce((a, x) => a + (x.occurrences ? x.occurrences.length : 0), 0);
  assert.equal(retained, 225, '25 free + 200 budgeted');
  assert.equal(buf.occBudget, 0, 'budget is fully spent, never negative');
});

// ================================================= 4. renderer boundaries

test('expandForRender: occurrences render oldest-first, one row each, count 1', () => {
  const g = {
    severity: 'error', source: 'error_log', sample: 'x', count: 3, first: 1, last: 3,
    occurrences: [{ ts: 3, sample: 'line 337' }, { ts: 1, sample: 'line 214' }, { ts: 2, sample: 'line 900' }],
  };
  const { items, collapsed, untracked } = N.expandForRender([g]);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(i => i.first), [1, 2, 3], 'reads as the sequence it actually was');
  assert.deepEqual(items.map(i => i.sample), ['line 214', 'line 900', 'line 337']);
  assert.ok(items.every(i => i.count === 1));
  assert.equal(collapsed, 0);
  assert.equal(untracked, 0);
});

test('expandForRender: a group without occurrences passes through untouched', () => {
  const plain = { severity: 'error', source: 'error_log', sample: 'core boom', count: 500, first: 1, last: 2 };
  const { items, collapsed, untracked } = N.expandForRender([plain]);
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 500);
  assert.equal(collapsed, 0);
  assert.equal(untracked, 0);
});

test('expandForRender: a single retained occurrence is not worth a row of its own', () => {
  const g = { severity: 'error', source: 'error_log', sample: 'x', count: 9, first: 1, last: 9,
    occurrences: [{ ts: 1, sample: 'x' }] };
  const { items } = N.expandForRender([g]);
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 9, 'stays the collapsed row, keeping its count');
});

test('expandForRender: the row budget holds and groups degrade whole, never half', () => {
  const many = Array.from({ length: 12 }, () => ({
    severity: 'error', source: 'error_log', sample: 'x', count: 10, first: 1, last: 10,
    occurrences: Array.from({ length: 10 }, (_, i) => ({ ts: i + 1, sample: 's' + i })),
  }));
  const { items, collapsed, untracked } = N.expandForRender(many);
  assert.ok(items.length <= N.MAX_RENDERED_ROWS, `rendered ${items.length} rows, cap is ${N.MAX_RENDERED_ROWS}`);
  assert.ok(collapsed > 0, 'the groups that did not fit degraded');
  // A degraded group keeps its full count; an expanded row is always count 1.
  assert.ok(items.every(i => i.count === 1 || i.count === 10), 'no group was listed in part');
  assert.equal(untracked, 0);
});

test('expandForRender: the budget reserves a row for every group still to come', () => {
  // Fat theme groups first, plain ones after. Expanding every fat group would
  // need 8 x 10 + 42 = 122 rows, so some must degrade. Without the reservation
  // the degraded rows would land on top of an already-full email and overrun
  // the cap by however many groups degraded.
  const fat = () => ({
    severity: 'error', source: 'error_log', sample: 'x', count: 10, first: 1, last: 10,
    occurrences: Array.from({ length: 10 }, (_, i) => ({ ts: i + 1, sample: 's' + i })),
  });
  const plain = () => ({ severity: 'error', source: 'error_log', sample: 'p', count: 1, first: 1, last: 1 });
  const groups = [...Array.from({ length: 8 }, fat), ...Array.from({ length: 42 }, plain)];
  const { items, collapsed } = N.expandForRender(groups);
  assert.ok(items.length <= N.MAX_RENDERED_ROWS, `rendered ${items.length}, cap ${N.MAX_RENDERED_ROWS}`);
  assert.ok(collapsed > 0, 'the fat groups that did not fit degraded to collapsed rows');
  assert.ok(items.length >= groups.length, 'no group is ever dropped, only degraded');
});

test('the row cap cannot be overrun even when every group degrades', () => {
  // What actually makes MAX_RENDERED_ROWS safe is that composeDigest slices to
  // MAX_RENDERED_GROUPS before expanding, so the worst case — every group
  // degrading to one row — is MAX_RENDERED_GROUPS rows. Guard that invariant so
  // raising the group cap past the row cap fails here rather than in an inbox.
  assert.ok(N.MAX_RENDERED_GROUPS <= N.MAX_RENDERED_ROWS,
    `MAX_RENDERED_GROUPS (${N.MAX_RENDERED_GROUPS}) must not exceed MAX_RENDERED_ROWS (${N.MAX_RENDERED_ROWS})`);
  const allFat = Array.from({ length: N.MAX_RENDERED_GROUPS }, () => ({
    severity: 'error', source: 'error_log', sample: 'x', count: 10, first: 1, last: 10,
    occurrences: Array.from({ length: 10 }, (_, i) => ({ ts: i + 1, sample: 's' + i })),
  }));
  const { items } = N.expandForRender(allFat);
  assert.ok(items.length <= N.MAX_RENDERED_ROWS, `rendered ${items.length}, cap ${N.MAX_RENDERED_ROWS}`);
});

// ================================================ 5. digest email, end to end

test('composeDigest: every theme line number reaches the email; core stays one row', () => {
  const buf = bufferFrom([
    entry('critical', `PHP Fatal error: boom in ${THEME_FN} on line 214`, 1_700_000_000_000),
    entry('critical', `PHP Fatal error: boom in ${THEME_FN} on line 337`, 1_700_000_060_000),
    ...Array.from({ length: 25 }, (_, i) =>
      entry('warning', `PHP Warning: undefined index in ${CORE_FN} on line ${i}`, 1_700_000_000_000 + i)),
  ]);
  const s = settings();
  const d = N.composeDigest(ACCOUNT, buf, s);

  assert.match(d.text, /on line 214/, 'first theme occurrence is listed');
  assert.match(d.text, /on line 337/, 'second theme occurrence is listed');
  assert.match(d.html, /on line 214/);
  assert.match(d.html, /on line 337/);

  assert.equal(d.total, 27, 'total counts OCCURRENCES');
  assert.equal(d.groups, 2, 'groups counts DISTINCT MESSAGES, not rendered rows');
  assert.equal(d.counts.critical, 2);
  assert.equal(d.counts.warning, 25);
  assert.match(d.subject, /2 critical, 25 warning/);

  // The core warning is still a single collapsed row.
  const coreRows = d.text.split('\n').filter(l => l.includes('undefined index'));
  assert.equal(coreRows.length, 1, '25 identical core warnings render as ONE row');
});

test('composeDigest: caps are disclosed in the email notes, not silently applied', () => {
  const buf = bufferFrom(Array.from({ length: 40 }, (_, i) =>
    entry('error', `PHP Parse error: boom in ${THEME_FN} on line ${i}`, 1_700_000_000_000 + i)));
  const d = N.composeDigest(ACCOUNT, buf, settings());
  assert.match(d.text, /30 further theme occurrence/, 'the 30 unlisted occurrences are disclosed');
  assert.equal(d.counts.error, 40, 'and still counted in full');
});

test('composeDigest is pure — preview must not consume the buffer', () => {
  const buf = bufferFrom([entry('critical', `PHP Fatal error: boom in ${THEME_FN} on line 1`, 1000)]);
  const before = JSON.stringify([...buf.groups.values()]);
  N.composeDigest(ACCOUNT, buf, settings());
  N.composeDigest(ACCOUNT, buf, settings());
  assert.equal(JSON.stringify([...buf.groups.values()]), before, 'buffer is untouched by composing');
  assert.equal(buf.total, 1);
});

// ============================== 6. test email, against real files on disk

test('composeTest: samples real files and expands theme entries the same way', async () => {
  const logPath = path.join(ACCOUNT_HOME, 'public_html', 'error_log');
  fs.writeFileSync(logPath, [
    `[31-Aug-2026 10:00:00 UTC] PHP Fatal error: Uncaught Error: boom in ${THEME_FN} on line 214`,
    `[31-Aug-2026 10:00:01 UTC] PHP Fatal error: Uncaught Error: boom in ${THEME_FN} on line 337`,
    `[31-Aug-2026 10:00:02 UTC] PHP Warning: undefined index in ${CORE_FN} on line 9`,
    `[31-Aug-2026 10:00:03 UTC] PHP Warning: undefined index in ${CORE_FN} on line 9`,
    `[31-Aug-2026 10:00:04 UTC] PHP Fatal error: boom in ${PLUGIN_FN} on line 5`,
    '',
  ].join('\n'));

  const t = await N.composeTest(ACCOUNT, settings(), 5);

  assert.match(t.text, /on line 214/, 'theme occurrence 1 previews');
  assert.match(t.text, /on line 337/, 'theme occurrence 2 previews');
  assert.doesNotMatch(t.text, /wpforms/, 'the plugin fatal is excluded from email');

  const coreRows = t.text.split('\n').filter(l => l.includes('undefined index'));
  assert.equal(coreRows.length, 1, 'the two identical core warnings preview as ONE row');
  assert.equal(t.counts.warning, 2, 'while still counting 2 occurrences');
  assert.match(t.subject, /Test —/);
});

test('composeTest: an account whose only log is a plugin file reports nothing to sample', async () => {
  const pluginLog = path.join(ACCOUNT_HOME, 'public_html', 'wp-content', 'plugins', 'foo');
  fs.mkdirSync(pluginLog, { recursive: true });
  fs.writeFileSync(path.join(pluginLog, 'debug.log'), '[31-Aug-2026 10:00:00 UTC] PHP Fatal error: boom\n');
  const t = await N.composeTest(ACCOUNT, settings({ files: ['public_html/wp-content/plugins/foo/debug.log'] }), 5);
  assert.match(t.text, /nothing left to sample|excluded from email/i);
  assert.equal(t.total, 0);
});

// ------------------------------------------------------------------ cleanup
process.on('exit', () => { try { fs.rmSync(HOME_ROOT, { recursive: true, force: true }); } catch {} });
