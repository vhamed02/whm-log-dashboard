'use strict';
/* Log dashboard frontend.
 * Vanilla JS, virtualized viewer. All data flows via SSE streams; the client
 * never requests the "full file". The DOM only ever renders the visible window
 * plus a small overscan.
 */

const ROW_H = 22;
const OVERSCAN = 8;
let uidCounter = 0;

const $ = (id) => document.getElementById(id);
const accountsList = $('accounts-list');
const logsList = $('logs-list');
const logsFilter = $('logs-filter');
const accountSelect = $('account-select');
const severityFilter = $('severity-filter');
const searchInput = $('search-input');
const liveToggle = $('live-toggle');
const refreshBtn = $('refresh-btn');
const clearBtn = $('clear-btn');
const downloadBtn = $('download-btn');
const themeToggle = $('theme-toggle');
const viewerMeta = $('viewer-meta');
const quickbar = $('quickbar');
const viewerWrap = $('viewer-wrap');
const linesEl = $('log-lines');
const spacerTop = $('spacer-top');
const spacerBottom = $('spacer-bottom');
const viewerEmpty = $('viewer-empty');
const logsStatus = $('logs-status');
const toastEl = $('toast');

const state = {
  accounts: [],
  selectedAccount: null,
  logs: [],
  logFilter: '', // client-side filter over the discovered log-file list
  selectedLogId: null,
  // entries: newest-first array (index 0 = newest). Each entry gets a stable uid.
  entries: [],
  expanded: new Set(), // uids of expanded rows
  measuredHeights: new Map(), // uid -> measured pixel height (expanded rows)
  live: false,
  mode: 'stream', // 'stream' | 'search'
  streamPhase: 'idle', // 'idle' | 'loading' | 'ready' — drives the empty-state message
  viewCleared: false, // true right after a manual Clear, until new entries arrive
  severity: '',
  searchQuery: '',
  currentEs: null,
  // Pagination of older entries:
  oldestOffset: null, // byte offset of the oldest entry shown; null = no more / not started
  loadingMore: false,
  reachedBOF: false, // reached beginning of file — no more to load
};

function firstLine(msg) {
  const i = msg.indexOf('\n');
  return i === -1 ? msg : msg.slice(0, i);
}

// ---------- render: accounts ----------
function renderAccounts() {
  accountsList.innerHTML = '';
  for (const a of state.accounts) {
    const li = document.createElement('li');
    li.textContent = a;
    li.dataset.account = a;
    if (a === state.selectedAccount) li.classList.add('active');
    li.onclick = () => selectAccount(a);
    accountsList.appendChild(li);
  }
}

// ---------- render: logs ----------
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'M';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'G';
}
function renderLogs() {
  logsList.innerHTML = '';
  if (!state.logs.length) {
    const li = document.createElement('li');
    li.classList.add('muted');
    li.textContent = state.selectedAccount ? 'No log files found.' : 'Select an account.';
    logsList.appendChild(li);
    return;
  }
  // Real-time client-side filter by file name OR relative path (case-insensitive).
  const q = state.logFilter.trim().toLowerCase();
  const list = q
    ? state.logs.filter(l =>
        (l.name && l.name.toLowerCase().includes(q)) ||
        (l.path && l.path.toLowerCase().includes(q)))
    : state.logs;
  if (!list.length) {
    const li = document.createElement('li');
    li.classList.add('muted');
    li.textContent = `No files match “${state.logFilter.trim()}”.`;
    logsList.appendChild(li);
    return;
  }
  for (const l of list) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'lf-name';
    name.textContent = l.name;
    name.title = l.path || l.name;
    const pathLine = document.createElement('div');
    pathLine.className = 'lf-path';
    pathLine.textContent = l.path || '';
    pathLine.title = l.path || '';
    const sz = document.createElement('span');
    sz.className = 'size';
    sz.textContent = fmtSize(l.size);
    li.appendChild(name);
    li.appendChild(pathLine);
    li.appendChild(sz);
    li.dataset.id = l.id;
    if (l.id === state.selectedLogId) li.classList.add('active');
    li.onclick = () => selectLog(l.id);
    logsList.appendChild(li);
  }
}

// ---------- render: virtualized viewer ----------
function rowHeight(e) {
  if (state.expanded.has(e.uid)) {
    return state.measuredHeights.get(e.uid) || estimateHeight(e);
  }
  return ROW_H;
}
function estimateHeight(e) {
  // Heuristic: ~18px per line, capped at 600px (so huge stack traces still
  // get an internal scrollbar instead of unbounded growth).
  const lines = e.message.split('\n').length;
  return Math.min(600, lines * 18 + 32);
}
// Build cumulative-height array for binary search. cumH[i] = height of rows 0..i-1.
function cumulativeHeights() {
  const total = state.entries.length;
  const cum = new Array(total + 1);
  cum[0] = 0;
  for (let i = 0; i < total; i++) {
    cum[i + 1] = cum[i] + rowHeight(state.entries[i]);
  }
  return cum;
}
// Show a contextual empty-state message whenever the viewer holds no entries.
// Kept out of the way (hidden) while a load is still in flight so it never
// "flashes" between clearing the view and the first entries arriving.
function renderEmptyState() {
  if (state.entries.length > 0) { viewerEmpty.hidden = true; return; }
  const titleEl = viewerEmpty.querySelector('.ve-title');
  const subEl = viewerEmpty.querySelector('.ve-sub');
  let title, sub;
  if (state.viewCleared) {
    title = 'View cleared';
    sub = state.live
      ? 'On-screen entries were cleared — new lines will appear here as they arrive. The log file was not modified.'
      : 'On-screen entries were cleared. The log file was not modified.';
  } else if (state.mode === 'search') {
    if (state.streamPhase === 'loading') { viewerEmpty.hidden = true; return; }
    title = 'No matches';
    sub = `Nothing matches “${state.searchQuery}”` +
      (state.severity ? ` at severity “${state.severity}”` : '') + '.';
  } else if (!state.selectedLogId) {
    title = state.selectedAccount ? 'No log selected' : 'Nothing to show yet';
    sub = state.selectedAccount
      ? 'Select a log file from the list to view its entries.'
      : 'Select an account, then a log file.';
  } else if (state.streamPhase === 'loading') {
    viewerEmpty.hidden = true; return; // still streaming — don't flash
  } else {
    title = 'No matching entries';
    sub = state.severity
      ? `This log has no “${state.severity}” entries. Try “All” or a different severity.`
      : 'This log has no entries to show.';
  }
  titleEl.textContent = title;
  subEl.textContent = sub;
  viewerEmpty.hidden = false;
}

function renderViewer() {
  const total = state.entries.length;
  const viewH = viewerWrap.clientHeight || 0;
  const scrollTop = viewerWrap.scrollTop;
  const cum = cumulativeHeights();
  renderEmptyState();
  if (total === 0) {
    linesEl.replaceChildren();
    spacerTop.style.height = '0px';
    spacerBottom.style.height = '0px';
    return;
  }
  // Binary search for the first visible row.
  let start = upperBound(cum, scrollTop) - 1;
  if (start < 0) start = 0;
  if (start > total - 1) start = Math.max(0, total - 1);
  let end = start;
  while (end < total && cum[end] < scrollTop + viewH) end++;
  end = Math.min(total, end + OVERSCAN);
  start = Math.max(0, start - OVERSCAN);

  const frag = document.createDocumentFragment();
  for (let i = start; i < end && i < total; i++) {
    frag.appendChild(buildRow(state.entries[i]));
  }
  linesEl.replaceChildren(frag);
  spacerTop.style.height = cum[start] + 'px';
  spacerBottom.style.height = Math.max(0, cum[total] - cum[end]) + 'px';
  // NOTE: do NOT schedule measureExpanded here — that created a render loop
  // during scroll. Expanded rows are measured once in toggleExpand instead.
}
function upperBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}
function buildRow(e) {
  const row = document.createElement('div');
  const expanded = state.expanded.has(e.uid);
  row.className = 'logrow ' + e.severity + (expanded ? ' expanded' : '');
  row.dataset.uid = String(e.uid);

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTs(e.ts);

  const sev = document.createElement('span');
  sev.className = 'sev sev-' + e.severity;
  sev.textContent = e.severity;

  if (expanded) {
    // Full body: ts|sev on the first row of the grid, full message spanning
    // below. Wraps long lines so there is never "...".
    const body = document.createElement('div');
    body.className = 'msg expanded-body';
    body.textContent = e.message;
    row.appendChild(ts); row.appendChild(sev); row.appendChild(body);
  } else {
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = ' ' + firstLine(e.message);
    const hint = document.createElement('span');
    hint.className = 'expand-hint';
    hint.textContent = ' ▸';
    row.appendChild(ts); row.appendChild(sev); row.appendChild(msg); row.appendChild(hint);
  }
  return row;
}

// ---------- toast + clipboard ----------
let toastTimer = null;
function showToast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('toast-error', !!isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// Legacy copy for plain-HTTP (non-secure) contexts where navigator.clipboard is
// unavailable — the dashboard is typically served over http://<server>:3212.
function legacyCopy(text) {
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand copy returned false'));
    } catch (e) { reject(e); }
  });
}
function copyToClipboard(text) {
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  }
  return legacyCopy(text);
}
function copyEntry(entry) {
  copyToClipboard(entry.message).then(
    () => showToast('Log copied to clipboard'),
    () => showToast('Copy failed — select the text and press Ctrl+C', true)
  );
}

// Event delegation on the container — survives re-renders during clicks.
// Clicking a row toggles expand/collapse; on EXPAND it also copies the full
// entry (all lines, e.g. a whole stack trace) to the clipboard.
linesEl.addEventListener('click', (ev) => {
  const row = ev.target.closest('.logrow');
  if (!row || !row.dataset.uid) return;
  const uid = Number(row.dataset.uid);
  const willExpand = !state.expanded.has(uid);
  toggleExpand(uid);
  if (willExpand) {
    const entry = state.entries.find(e => e.uid === uid);
    if (entry) copyEntry(entry);
  }
});

function toggleExpand(uid) {
  if (state.expanded.has(uid)) {
    state.expanded.delete(uid);
    state.measuredHeights.delete(uid);
  } else {
    state.expanded.add(uid);
  }
  renderViewer();
  // After the row is rendered, measure its real height ONCE and re-render to
  // fix the spacer math. This is the only place measurement happens — never
  // during scroll — so there is no render loop.
  requestAnimationFrame(() => {
    let changed = false;
    for (const row of linesEl.children) {
      const ruid = Number(row.dataset.uid);
      if (!state.expanded.has(ruid)) continue;
      const h = row.getBoundingClientRect().height;
      if (h && h !== state.measuredHeights.get(ruid)) {
        state.measuredHeights.set(ruid, h);
        changed = true;
      }
    }
    if (changed) renderViewer();
  });
}

function fmtTs(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return iso; }
}

// Scroll handler: only re-render on real movement, and never auto-load more
// from a scroll event that was itself caused by our DOM update (that was the
// runaway loop). use rAF so we don't fight the browser's scroll gesture.
let lastScrollTop = -Infinity;
let lastLoadTime = 0;
viewerWrap.addEventListener('scroll', () => {
  const st = viewerWrap.scrollTop;
  if (st === lastScrollTop) return;     // ignore no-op scroll events
  lastScrollTop = st;
  scheduleRender();
  maybeLoadMore();
}, { passive: true });

// Load older entries only when the user EXPLICITLY scrolls near the bottom,
// and never more than once per second. This is the only trigger — completing
// a load does NOT re-arm another load.
function maybeLoadMore() {
  if (state.mode !== 'stream') return;
  if (state.loadingMore || state.reachedBOF || state.oldestOffset == null) return;
  const now = Date.now();
  if (now - lastLoadTime < 1000) return; // cooldown — no rapid re-fetch
  const wrap = viewerWrap;
  const distanceFromBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  // Require the user to be within 80px of the bottom AND the content to be
  // tall enough that scrolling was actually needed (not a tiny file).
  if (distanceFromBottom < 80 && wrap.scrollHeight > wrap.clientHeight + 200) {
    lastLoadTime = now;
    loadMore();
  }
}

function loadMore() {
  if (state.loadingMore || state.reachedBOF || state.oldestOffset == null) return;
  if (!state.selectedAccount || !state.selectedLogId) return;
  state.loadingMore = true;
  quickbar.textContent = 'loading older entries…';
  const params = new URLSearchParams({
    account: state.selectedAccount,
    file: state.selectedLogId,
    offset: String(state.oldestOffset),
    severity: state.severity,
  });
  const es = new EventSource('/more?' + params.toString());
  const buffer = [];   // accumulate the whole batch, render ONCE at the end
  es.addEventListener('log', (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    buffer.push(withUid(e));
  });
  es.addEventListener('more-done', (ev) => {
    let d = {}; try { d = JSON.parse(ev.data); } catch {}
    // Append the WHOLE batch in one go, then render once. This avoids 500
    // individual replaceChildren calls, each of which would disturb the
    // browser's scroll position.
    for (const e of buffer) state.entries.push(e);
    if (typeof d.stopOffset === 'number' && d.stopOffset > 0) {
      state.oldestOffset = d.stopOffset;
      state.reachedBOF = false;
    } else {
      state.oldestOffset = null;
      state.reachedBOF = true;
    }
    state.loadingMore = false;
    quickbar.textContent = `+${buffer.length} older · ${state.entries.length} total` +
      (state.reachedBOF ? ' · start of file' : '');
    es.close();
    renderViewer();
    // NOTE: deliberately do NOT call maybeLoadMore here. The user must scroll
    // again to load the next batch — this is what stops the runaway.
  });
  es.addEventListener('error', () => {
    state.loadingMore = false;
    quickbar.textContent = 'failed to load more (scroll to retry)';
    if (es.readyState === EventSource.CLOSED) es.close();
  });
}
window.addEventListener('resize', renderViewer, { passive: true });

// ---------- entry ingestion ----------
// Initial reverse tail arrives newest-first → push (entries[0]=newest, end=oldest).
// Live appended blocks are NEWER than anything seen → unshift (index 0).
// Search matches arrive oldest-first across the scan → unshift (index 0=newest).
// Any newly ingested entry means the view is no longer in a just-cleared state.
function withUid(e) { e.uid = ++uidCounter; state.viewCleared = false; return e; }

// Clear ONLY the on-screen entries. This never reads, writes, or deletes the log
// file — it just empties the in-memory list so (e.g. in live mode) you can watch
// fresh lines arrive against a clean viewer. The live stream stays connected and
// the older-entries pagination cursor is preserved.
function clearView() {
  if (!state.entries.length) return;
  state.entries = [];
  state.expanded.clear();
  state.measuredHeights.clear();
  state.viewCleared = true;
  renderViewer();
  viewerMeta.textContent = `mode=${state.mode} rows=0`;
  quickbar.textContent = state.live
    ? 'view cleared · watching for new entries…'
    : 'view cleared';
}
function pushInitial(entries) {
  for (const e of entries) state.entries.push(withUid(e));
  scheduleRender();
}
function unshiftNewest(entries) {
  for (const e of entries) state.entries.unshift(withUid(e));
  scheduleRender();
}

function clearEntries() {
  state.entries = [];
  state.expanded.clear();
  state.measuredHeights.clear();
  state.oldestOffset = null;
  state.loadingMore = false;
  state.reachedBOF = false;
  state.viewCleared = false;
  renderViewer();
  viewerMeta.textContent = `mode=${state.mode} rows=0`;
}

// ---------- SSE connections ----------
function closeStream() {
  if (state.currentEs) {
    try { state.currentEs.close(); } catch {}
    state.currentEs = null;
  }
}

function startStream() {
  closeStream();
  state.mode = 'stream';
  state.streamPhase = 'loading';
  clearEntries();
  if (!state.selectedAccount || !state.selectedLogId) { state.streamPhase = 'idle'; renderViewer(); return; }
  const params = new URLSearchParams({
    account: state.selectedAccount,
    file: state.selectedLogId,
    severity: state.severity,
  });
  if (state.live) params.set('live', '1');
  const url = '/stream?' + params.toString();
  const es = new EventSource(url, { withCredentials: false });
  state.currentEs = es;
  quickbar.className = 'muted';
  quickbar.textContent = 'Streaming…';
  let initialDone = false;
  es.addEventListener('log', (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    // Initial reverse tail arrives newest-first → PUSH (arrival order = display order).
    // Live updates arrive AFTER initial-done and are newer than everything → UNSHIFT.
    if (initialDone) state.entries.unshift(withUid(e));
    else state.entries.push(withUid(e));
    scheduleRender();
  });
  es.addEventListener('initial-done', (ev) => {
    initialDone = true;
    state.streamPhase = 'ready';
    let d = {}; try { d = JSON.parse(ev.data); } catch {}
    quickbar.textContent = `initial: ${d.count || 0} entries${state.live ? ' · live on' : ''}`;
    // Track pagination cursor for older entries (only meaningful in stream mode).
    if (typeof d.stopOffset === 'number' && d.stopOffset > 0) {
      state.oldestOffset = d.stopOffset;
      state.reachedBOF = false;
    } else {
      state.oldestOffset = null;
      state.reachedBOF = true;
    }
    renderViewer();
  });
  es.addEventListener('live-on', () => { quickbar.textContent = 'live · streaming'; });
  es.addEventListener('done', () => {
    quickbar.textContent = 'stream ended';
    es.close(); state.currentEs = null;
  });
  es.addEventListener('error', (ev) => {
    if (ev.data) { try { quickbar.textContent = 'error: ' + JSON.parse(ev.data).message; } catch {} }
    else { quickbar.textContent = 'connection error'; if (es.readyState === EventSource.CLOSED) es.close(); }
  });
}

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderViewer(); viewerMeta.textContent = `mode=${state.mode} rows=${state.entries.length}`; });
}

function startSearch() {
  closeStream();
  state.mode = 'search';
  state.streamPhase = 'loading';
  clearEntries();
  if (!state.selectedAccount) { state.streamPhase = 'idle'; renderViewer(); return; }
  const params = new URLSearchParams({
    account: state.selectedAccount,
    query: state.searchQuery,
    severity: state.severity,
  });
  const url = '/search?' + params.toString();
  const es = new EventSource(url);
  state.currentEs = es;
  quickbar.textContent = `searching "${state.searchQuery}"…`;
  es.addEventListener('match', (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    // Search scans forward (oldest first per file) → unshift each → newest on top.
    state.entries.unshift(withUid(e));
    scheduleRender();
  });
  es.addEventListener('truncated', (ev) => {
    let r = ''; try { r = JSON.parse(ev.data).reason; } catch {}
    quickbar.textContent = 'search truncated: ' + r;
  });
  es.addEventListener('done', (ev) => {
    let total = 0; try { total = JSON.parse(ev.data).total; } catch {}
    state.streamPhase = 'ready';
    quickbar.textContent = `search done · ${total} matches`;
    es.close(); state.currentEs = null;
    renderViewer();
  });
  es.addEventListener('error', () => {
    quickbar.textContent = 'search connection error';
    if (es.readyState === EventSource.CLOSED) es.close();
  });
}

// ---------- actions ----------
async function loadAccounts(force) {
  accountSelect.disabled = true;
  let res;
  try { res = await fetch('/accounts' + (force ? '?force=1' : '')); }
  catch { logsStatus.textContent = 'network error'; accountSelect.disabled = false; return; }
  if (!res.ok) { logsStatus.textContent = 'auth required'; accountSelect.disabled = false; return; }
  const data = await res.json();
  state.accounts = data.accounts || [];
  renderAccounts();
  accountSelect.innerHTML = '<option value="">—</option>' +
    state.accounts.map(a => `<option value="${a}">${a}</option>`).join('');
  accountSelect.disabled = false;
}

async function selectAccount(account) {
  state.selectedAccount = account;
  state.selectedLogId = null;
  updateDownloadBtn();
  state.logFilter = '';
  logsFilter.value = '';
  accountSelect.value = account;
  logsStatus.textContent = 'discovering…';
  renderAccounts();
  logsList.innerHTML = '';
  clearEntries();
  await loadLogs(true, account);
}

async function loadLogs(force, account) {
  account = account || state.selectedAccount;
  if (!account) return;
  let res;
  try {
    res = await fetch('/logs?account=' + encodeURIComponent(account) + (force ? '&force=1' : ''));
  } catch { logsStatus.textContent = 'network error'; return; }
  if (!res.ok) { logsStatus.textContent = 'error ' + res.status; return; }
  const data = await res.json();
  state.logs = data.logs || [];
  renderLogs();
  logsStatus.textContent = `${state.logs.length} log file${state.logs.length===1?'':'s'} discovered` +
    (force ? ' (refreshed)' : '');
  // If the previously selected log no longer exists, clear it.
  if (state.selectedLogId && !state.logs.some(l => l.id === state.selectedLogId)) {
    state.selectedLogId = null;
  }
  updateDownloadBtn();
}

function selectLog(id) {
  state.selectedLogId = id;
  renderLogs();
  updateDownloadBtn();
  if (state.searchQuery) startSearch(); else startStream();
}

// The header download control acts on the currently selected log file; there is
// nothing to download until one is picked.
function updateDownloadBtn() {
  downloadBtn.disabled = !(state.selectedAccount && state.selectedLogId);
}

// ---------- event wiring ----------
accountSelect.addEventListener('change', (e) => selectAccount(e.target.value));
// Real-time filter of the discovered log-file list (in-memory; no server call).
logsFilter.addEventListener('input', (e) => {
  state.logFilter = e.target.value;
  renderLogs();
});
severityFilter.addEventListener('change', (e) => {
  state.severity = e.target.value;
  if (state.searchQuery) startSearch(); else if (state.selectedLogId) startStream();
});
liveToggle.addEventListener('change', (e) => {
  state.live = e.target.checked;
  if (state.selectedLogId && !state.searchQuery) startStream();
});

let searchTimer = null;
searchInput.addEventListener('input', (e) => {
  const v = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.searchQuery = v;
    if (v) startSearch();
    else if (state.selectedLogId) startStream();
    else clearEntries();
  }, 450);
});

clearBtn.addEventListener('click', clearView);

// Download the selected log via a transient anchor. Same-origin GET, so the
// browser reuses the dashboard's Basic-Auth credentials; the server's
// Content-Disposition makes it save instead of navigating away.
downloadBtn.addEventListener('click', () => {
  if (!state.selectedAccount || !state.selectedLogId) return;
  const url = '/download?account=' + encodeURIComponent(state.selectedAccount) +
    '&file=' + encodeURIComponent(state.selectedLogId);
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spin');
  try {
    await fetch('/refresh' + (state.selectedAccount ? '?account=' + encodeURIComponent(state.selectedAccount) : ''), { method: 'POST' });
    await loadAccounts(true);
    if (state.selectedAccount) await loadLogs(true, state.selectedAccount);
  } finally {
    refreshBtn.classList.remove('spin');
  }
});

// ---------- notifications ----------
/* Per-account email settings. Severities and receivers are two INDEPENDENT
 * lists: every ticked severity is emailed to every ticked receiver. Digests are
 * batched by the server (hourly by default) and only sent when the account
 * actually logged something matching. */
const notifyBtn = $('notify-btn');
const notifyModal = $('notify-modal');
const previewModal = $('preview-modal');
const notifyAccountEl = $('notify-account');
const notifyMode = $('notify-mode');
const notifyBanner = $('notify-banner');
const notifyEnabled = $('notify-enabled');
const notifySeverities = $('notify-severities');
const notifyRecipients = $('notify-recipients');
const notifyFiles = $('notify-files');
const notifyFilesFilter = $('notify-files-filter');
const notifyFilesCount = $('notify-files-count');
const notifySummary = $('notify-summary');
const notifyStatus = $('notify-status');
const notifySaveBtn = $('notify-save');
const notifyPreviewBtn = $('notify-preview-btn');
const notifyTestBtn = $('notify-test-btn');
const notifyPeriod = $('notify-period');
const notifyPeriodNote = $('notify-period-note');

// Fallback cadence used only until /notify/config arrives with the real catalog.
const DEFAULT_PERIOD = '1h';

const SEV_HINTS = {
  critical: 'Fatal errors, memory exhaustion, segfaults',
  error: 'PHP / Apache errors, exceptions, HTTP 5xx',
  warning: 'Warnings and HTTP 4xx',
  info: 'Everything else — high volume, off by default',
};

// Send-state shown in the modal header, mirroring the banner underneath it.
function notifySetMode(kind, text) {
  notifyMode.className = 'mode-pill mode-' + kind;
  notifyMode.textContent = text;
  notifyMode.hidden = false;
}

// Up to two initials for a receiver's avatar, with a stable per-name hue so the
// same person keeps the same colour across accounts.
function initialsOf(name) {
  const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function hueOf(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const notify = {
  account: null,
  cfg: null,            // { recipients, severities, periods, status }
  sel: { enabled: false, severities: new Set(), recipients: new Set(), files: new Set(), period: DEFAULT_PERIOD },
  // Snapshot of what the SERVER currently has. The test email and the digests
  // both run off saved settings, so the UI must be able to tell the two apart:
  // unsaved ticks are not something the server can act on.
  saved: { enabled: false, severities: new Set(), recipients: new Set(), files: new Set(), period: DEFAULT_PERIOD },
  filesFilter: '',
  loading: false,
};

// Look up a cadence in the catalog the server sent, for its label and interval.
function periodInfo(key) {
  const list = (notify.cfg && notify.cfg.periods) || [];
  return list.find(p => p.key === key) || null;
}
// Next epoch-aligned boundary of this cadence — the same alignment the server
// flushes on, so what the modal says matches when mail actually goes out.
function nextPeriodBoundary(key) {
  const p = periodInfo(key);
  if (!p || !p.ms) return null;
  const now = Date.now();
  return Math.floor(now / p.ms) * p.ms + p.ms;
}

// Digests flush on epoch-aligned boundaries (all land at 00:00 UTC). For the
// day-and-up cadences (daily/weekly/monthly) that time isn't obvious from the
// label, so tag them with the clock time in the viewer's local timezone, e.g.
// "01:00 AM Lisbon time". Sub-daily cadences read plainly, so no tag.
const DAY_MS = 86400000;
function periodTimeTag(key) {
  const at = nextPeriodBoundary(key);
  const p = periodInfo(key);
  if (!at || !p || !p.ms || p.ms < DAY_MS) return '';
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').split('/').pop().replace(/_/g, ' ');
  return tz ? `${time} ${tz} time` : time;
}

const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
function notifyDirty() {
  const s = notify.sel, v = notify.saved;
  return s.enabled !== v.enabled ||
    s.period !== v.period ||
    !setEq(s.severities, v.severities) ||
    !setEq(s.recipients, v.recipients) ||
    !setEq(s.files, v.files);
}
function notifySnapshot() {
  notify.saved = {
    enabled: notify.sel.enabled,
    severities: new Set(notify.sel.severities),
    recipients: new Set(notify.sel.recipients),
    files: new Set(notify.sel.files),
    period: notify.sel.period,
  };
}

function notifyOpen() {
  if (!state.selectedAccount) { showToast('Select an account first', true); return; }
  notify.account = state.selectedAccount;
  notify.filesFilter = '';
  notifyFilesFilter.value = '';
  notifyAccountEl.textContent = notify.account;
  notifyMode.hidden = true; // until the config says what the send-state actually is
  notifyModal.hidden = false;
  notifyLoad();
}
function notifyClose() { notifyModal.hidden = true; }

// Every control in the modal, so a form that could not load can be switched off
// wholesale. Close buttons stay live — you must always be able to get out.
function notifyFormDisabled(on) {
  const controls = notifyModal.querySelectorAll('.modal-body input, .modal-body button, .foot-actions button');
  for (const el of controls) {
    if (el.hasAttribute('data-close')) continue;
    el.disabled = on;
  }
}

/* Fail loudly. The first version of this reported a load failure in a one-line
 * status that the next render promptly overwrote, so a dead form looked exactly
 * like a working one with nothing configured yet — you could tick boxes and hit
 * Save against a config that was never loaded. Now the modal says what broke and
 * refuses to pretend it is usable. */
function notifyFail(kind, detail) {
  notify.cfg = null;
  notifySeverities.replaceChildren();
  notifyRecipients.replaceChildren();
  notifyFiles.replaceChildren();
  notifyFilesCount.textContent = '';
  notifySummary.textContent = '';
  notifySummary.className = 'summary';
  notifyStatus.textContent = detail || '';
  notifySetMode('bad', 'Unavailable');
  notifyBanner.innerHTML = kind === 'outdated'
    ? '<strong>The server is running an older build.</strong> This page came from disk, but the ' +
      'running process still has the previous <code>server.js</code> in memory, and it has no ' +
      'notification API (<code>/notify/config</code> → 404). Restart the service to load it: ' +
      '<code>systemctl restart log-dashboard</code>'
    : '<strong>Could not load notification settings.</strong> ' + (detail || 'The server returned an error.') +
      ' Check <code>journalctl -u log-dashboard -n 50</code>.';
  notifyBanner.hidden = false;
  notifyFormDisabled(true);
}

async function notifyLoad() {
  notify.loading = true;
  notifyBanner.hidden = true;
  notifyStatus.textContent = 'loading…';
  notifyFormDisabled(true);
  try {
    const [cfgRes, setRes] = await Promise.all([
      fetch('/notify/config'),
      fetch('/notify/settings?account=' + encodeURIComponent(notify.account)),
    ]);
    // A 404 here means the route does not exist in the running process, which in
    // practice always means the service predates the notification feature.
    if (cfgRes.status === 404 || setRes.status === 404) return notifyFail('outdated');
    if (!cfgRes.ok) return notifyFail('error', `/notify/config returned ${cfgRes.status}.`);
    if (!setRes.ok) return notifyFail('error', `/notify/settings returned ${setRes.status}.`);

    const cfg = await cfgRes.json();
    const { settings } = await setRes.json();
    if (!cfg || !Array.isArray(cfg.severities) || !Array.isArray(cfg.recipients)) {
      return notifyFail('error', 'The server sent a malformed configuration.');
    }
    notify.cfg = cfg;
    notify.sel = {
      enabled: !!settings.enabled,
      severities: new Set(settings.severities || []),
      recipients: new Set(settings.recipients || []),
      files: new Set(settings.files || []),
      period: settings.period || DEFAULT_PERIOD,
    };
    notifySnapshot();
    // Log discovery may not have run for this account yet (e.g. the modal was
    // opened straight after a page load); the file list needs it.
    if (!state.logs.length) await loadLogs(false, notify.account);
    notifyRender();
  } catch (e) {
    notifyFail('error', 'Network error — the dashboard could not be reached.');
  } finally {
    notify.loading = false;
  }
}

function notifyRenderBanner() {
  const st = notify.cfg && notify.cfg.status;
  if (!st) { notifyBanner.hidden = true; notifyMode.hidden = true; return; }
  if (!st.armed) {
    notifyBanner.innerHTML =
      '<strong>Disarmed.</strong> Settings are saved and matching entries are collected, but ' +
      '<strong>no email is sent</strong> while <code>LD_NOTIFY_ENABLED=0</code>. Each hour the server logs the digest it would have sent.';
    notifyBanner.hidden = false;
    notifySetMode('warn', 'Disarmed');
  } else if (!st.hasKey) {
    notifyBanner.innerHTML = '<strong>No Brevo API key.</strong> Set <code>LD_BREVO_API_KEY</code> and restart — sending will fail without it.';
    notifyBanner.hidden = false;
    notifySetMode('bad', 'No API key');
  } else {
    notifyBanner.hidden = true;
    notifySetMode('ok', 'Armed');
  }
}

function mkCheck(checked, onChange) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  return cb;
}

function notifyRender() {
  if (!notify.cfg) return;
  notifyFormDisabled(false);
  notifyRenderBanner();
  notifyEnabled.checked = notify.sel.enabled;

  // Severities
  notifySeverities.replaceChildren();
  for (const sev of notify.cfg.severities) {
    const label = document.createElement('label');
    const cb = mkCheck(notify.sel.severities.has(sev), (on) => {
      on ? notify.sel.severities.add(sev) : notify.sel.severities.delete(sev);
      notifyRenderSummary();
    });
    const wrap = document.createElement('span');
    wrap.className = 'cl-grow';
    const name = document.createElement('div');
    name.className = 'cl-name sev-' + sev;
    name.textContent = sev;
    const sub = document.createElement('div');
    sub.className = 'cl-sub';
    sub.textContent = SEV_HINTS[sev] || '';
    wrap.appendChild(name); wrap.appendChild(sub);
    label.appendChild(cb); label.appendChild(wrap);
    notifySeverities.appendChild(label);
  }

  // Receivers
  notifyRecipients.replaceChildren();
  for (const r of notify.cfg.recipients) {
    const label = document.createElement('label');
    const cb = mkCheck(notify.sel.recipients.has(r.id), (on) => {
      on ? notify.sel.recipients.add(r.id) : notify.sel.recipients.delete(r.id);
      notifyRenderSummary();
    });
    const av = document.createElement('span');
    av.className = 'avatar';
    av.setAttribute('aria-hidden', 'true');
    av.style.setProperty('--h', hueOf(r.name || r.email));
    av.textContent = initialsOf(r.name || r.email);
    const wrap = document.createElement('span');
    wrap.className = 'cl-grow';
    const name = document.createElement('div');
    name.className = 'cl-name';
    name.textContent = r.name;
    const sub = document.createElement('div');
    sub.className = 'cl-sub';
    sub.textContent = r.email;
    wrap.appendChild(name); wrap.appendChild(sub);
    label.appendChild(cb); label.appendChild(av); label.appendChild(wrap);
    notifyRecipients.appendChild(label);
  }

  // Frequency dropdown, populated from the catalog the server advertises. Falls
  // back to a lone hourly option only if an old server sent none, so the control
  // is never empty.
  const periods = (notify.cfg.periods && notify.cfg.periods.length)
    ? notify.cfg.periods
    : [{ key: '1h', label: 'Every hour' }];
  notifyPeriod.replaceChildren();
  for (const p of periods) {
    const opt = document.createElement('option');
    opt.value = p.key;
    const tag = periodTimeTag(p.key);
    opt.textContent = tag ? `${p.label} — ${tag}` : p.label;
    notifyPeriod.appendChild(opt);
  }
  // If the saved cadence is one the server no longer offers, keep it selectable
  // so saving doesn't silently change it out from under the account.
  if (!periods.some(p => p.key === notify.sel.period)) {
    const opt = document.createElement('option');
    opt.value = notify.sel.period;
    opt.textContent = notify.sel.period + ' (unavailable)';
    notifyPeriod.appendChild(opt);
  }
  notifyPeriod.value = notify.sel.period;

  notifyRenderFiles();
  notifyRenderSummary();
}

// The file list is the account's discovered logs, plus any already-selected path
// that discovery no longer returns (rotated away, or created before a skip rule
// changed). Those stay visible and ticked so saving never silently drops them.
function notifyFileRows() {
  const rows = state.logs.map(l => ({ path: l.path, name: l.name, missing: false }));
  const known = new Set(rows.map(r => r.path));
  for (const p of notify.sel.files) {
    if (!known.has(p)) rows.push({ path: p, name: p.split('/').pop(), missing: true });
  }
  return rows;
}

function notifyRenderFiles() {
  const rows = notifyFileRows();
  const q = notify.filesFilter.trim().toLowerCase();
  const list = q ? rows.filter(r => r.path.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : rows;

  notifyFilesCount.textContent = `${notify.sel.files.size} of ${rows.length} selected`;
  notifyFiles.replaceChildren();

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'files-empty';
    empty.textContent = rows.length ? 'No files match the filter.' : 'No log files discovered for this account.';
    notifyFiles.appendChild(empty);
    return;
  }
  for (const r of list) {
    const label = document.createElement('label');
    const cb = mkCheck(notify.sel.files.has(r.path), (on) => {
      on ? notify.sel.files.add(r.path) : notify.sel.files.delete(r.path);
      notifyFilesCount.textContent = `${notify.sel.files.size} of ${rows.length} selected`;
      notifyRenderSummary();
    });
    const wrap = document.createElement('span');
    wrap.className = 'cl-grow';
    const name = document.createElement('div');
    name.className = 'cl-name';
    name.textContent = r.name;
    if (r.missing) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-warn';
      badge.title = 'Still watched, but discovery no longer returns this path';
      badge.textContent = 'not discovered';
      name.appendChild(badge);
    }
    const p = document.createElement('div');
    p.className = 'cl-path';
    p.textContent = r.path;
    p.title = r.path;
    wrap.appendChild(name); wrap.appendChild(p);
    label.appendChild(cb); label.appendChild(wrap);
    notifyFiles.appendChild(label);
  }
}

function notifyRenderSummary() {
  if (!notify.cfg) return;
  const s = notify.sel;
  const st = notify.cfg.status || {};
  // The chosen cadence, phrased for a sentence: "every 3 hours", "daily", …
  const cadence = (periodInfo(s.period) && periodInfo(s.period).label.toLowerCase()) || 'every hour';

  // Show the send time in the viewer's local timezone so "Weekly" et al. aren't
  // ambiguous about when mail actually goes out.
  if (notifyPeriodNote) {
    const tag = periodTimeTag(s.period);
    notifyPeriodNote.textContent = tag
      ? `Sent around ${tag}, and only when there is something to report.`
      : 'One batched digest per interval — and only when there is something to report.';
  }
  const recipNames = (notify.cfg ? notify.cfg.recipients : [])
    .filter(r => s.recipients.has(r.id)).map(r => r.name);

  const gaps = [];
  if (!s.severities.size) gaps.push('a log type');
  if (!s.recipients.size) gaps.push('a receiver');
  if (!s.files.size) gaps.push('a log file');

  if (!s.enabled) {
    notifySummary.className = 'summary summary-off';
    notifySummary.innerHTML = 'Notifications are <strong>off</strong> for this account. Nothing is watched and no email is sent.';
  } else if (gaps.length) {
    notifySummary.className = 'summary summary-warn';
    notifySummary.innerHTML = `Nothing will be sent — select at least ${gaps.join(', ')}.`;
  } else {
    notifySummary.className = 'summary';
    notifySummary.innerHTML =
      `<strong>${[...s.severities].join(', ')}</strong> entries from <strong>${s.files.size}</strong> ` +
      `file${s.files.size === 1 ? '' : 's'} go to <strong>${recipNames.join(', ')}</strong>, ` +
      `batched into one email <strong>${cadence}</strong> — and only when there is something to report.`;
  }

  const dirty = notifyDirty();
  const buf = st.buffered && st.buffered[notify.account];
  const bits = [];
  if (dirty) bits.push('unsaved changes');
  if (buf) bits.push(`${buf.total} entr${buf.total === 1 ? 'y' : 'ies'} buffered for the next digest`);
  // A pending batch has a real server-side flush time; otherwise show when the
  // next digest boundary of the selected cadence falls. When the cadence has
  // unsaved edits, the boundary reflects the new pick — flag it as not yet saved.
  const nextAt = (buf && buf.nextFlushAt) || nextPeriodBoundary(s.period);
  if (nextAt) {
    const changed = s.period !== notify.saved.period;
    bits.push('next digest ' + fmtTs(new Date(nextAt).toISOString()) + (changed ? ' (after save)' : ''));
  }
  if (st.lastError) bits.push('last send error: ' + st.lastError);
  notifyStatus.textContent = bits.join(' · ');
  notifySaveBtn.classList.toggle('dirty', dirty);

  /* The test email is sent by the SERVER from SAVED settings — it cannot see
   * ticks that have not been saved yet. Gate the button on the saved snapshot,
   * not the local selection, so it is never clickable in a state where the
   * server would answer "no recipients selected". */
  const savedRecips = notify.saved.recipients.size;
  notifyTestBtn.disabled = !st.armed || !savedRecips || dirty;
  notifyTestBtn.title =
    !st.armed ? 'Disabled while notifications are disarmed (LD_NOTIFY_ENABLED=0)'
    : dirty ? 'Save your changes first — the test email uses saved settings'
    : !savedRecips ? 'Select at least one receiver, then Save'
    : 'Send a one-off test email to the saved receivers';
}

async function notifySave() {
  notifySaveBtn.disabled = true;
  notifySaveBtn.textContent = 'Saving…';
  try {
    const res = await fetch('/notify/settings?account=' + encodeURIComponent(notify.account), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: notify.sel.enabled,
        severities: [...notify.sel.severities],
        recipients: [...notify.sel.recipients],
        files: [...notify.sel.files],
        period: notify.sel.period,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || `save failed (${res.status})`, true); return; }
    if (notify.cfg && data.status) notify.cfg.status = data.status;
    // Re-sync from what the server echoed back, so the snapshot reflects what was
    // actually stored (it normalizes file paths) rather than what we sent.
    if (data.settings) {
      notify.sel = {
        enabled: !!data.settings.enabled,
        severities: new Set(data.settings.severities || []),
        recipients: new Set(data.settings.recipients || []),
        files: new Set(data.settings.files || []),
        period: data.settings.period || DEFAULT_PERIOD,
      };
      notifyPeriod.value = notify.sel.period;
    }
    notifySnapshot();
    showToast('Notification settings saved');
    // Deliberately stay open: the usual next step is Send test email, which only
    // unlocks once the settings are saved.
    notifyRenderFiles();
    notifyRenderSummary();
  } catch {
    showToast('save failed — network error', true);
  } finally {
    notifySaveBtn.disabled = false;
    notifySaveBtn.textContent = 'Save';
  }
}

// Renders the digest that WOULD be sent right now. Never sends, never clears
// the server-side buffer. The email HTML is built from log content, so it goes
// into a sandboxed iframe rather than this document.
async function notifyPreview() {
  notifyPreviewBtn.disabled = true;
  try {
    const res = await fetch('/notify/preview?account=' + encodeURIComponent(notify.account));
    if (!res.ok) { showToast('preview failed', true); return; }
    const d = await res.json();
    const sub = $('preview-sub');
    const frame = $('preview-frame');
    const to = (d.recipients || []).map(r => `${r.name} <${r.email}>`).join(', ') || 'no receivers saved';
    if (d.empty) {
      sub.textContent = `${notify.account} — nothing to show`;
      frame.srcdoc = '<div style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#6b7280;padding:32px;text-align:center;">' +
        'Nothing buffered, and no recent entries matching the saved severities were found in the ' +
        'selected files.<br><br>Save at least one severity and one log file, then preview again.</div>';
    } else {
      // 'digest' = the real pending buffer. 'test' = a live sample of the newest
      // entries, which is what you get before the first hour has elapsed.
      sub.textContent = (d.kind === 'test' ? '[sample of latest entries] ' : '[pending digest] ') +
        `${d.subject} — to ${to}`;
      frame.srcdoc = d.html;
    }
    previewModal.hidden = false;
  } catch {
    showToast('preview failed — network error', true);
  } finally {
    notifyPreviewBtn.disabled = false;
  }
}

async function notifyTest() {
  // Saved recipients, not local ticks — this mirrors exactly who the server will
  // actually mail.
  const names = notify.cfg.recipients.filter(r => notify.saved.recipients.has(r.id));
  const who = names.map(r => `${r.name} (${r.email})`).join('\n');
  // Explicit confirmation: this is the one control in the UI that puts real
  // email on the wire.
  if (!window.confirm(`Send a test email now to:\n\n${who}\n\nThis sends a real email.`)) return;
  notifyTestBtn.disabled = true;
  notifyTestBtn.textContent = 'Sending…';
  try {
    const res = await fetch('/notify/test?account=' + encodeURIComponent(notify.account), { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) showToast(d.error || `test failed (${res.status})`, true);
    else showToast('Test email sent to ' + (d.sentTo || []).join(', '));
  } catch {
    showToast('test failed — network error', true);
  } finally {
    notifyTestBtn.textContent = 'Send test email';
    notifyRenderSummary();
  }
}

// Every handler bails when the config never loaded: the controls are disabled in
// that state, but a stray call must not repopulate a dead form piecemeal (which
// is exactly how an empty modal previously came back to life via "Select all").
notifyBtn.addEventListener('click', notifyOpen);
notifyEnabled.addEventListener('change', () => {
  if (!notify.cfg) return;
  notify.sel.enabled = notifyEnabled.checked;
  notifyRenderSummary();
});
notifyPeriod.addEventListener('change', () => {
  if (!notify.cfg) return;
  notify.sel.period = notifyPeriod.value;
  notifyRenderSummary();
});
notifyFilesFilter.addEventListener('input', (e) => {
  if (!notify.cfg) return;
  notify.filesFilter = e.target.value;
  notifyRenderFiles();
});
$('notify-files-all').addEventListener('click', () => {
  if (!notify.cfg) return;
  for (const r of notifyFileRows()) notify.sel.files.add(r.path);
  notifyRenderFiles(); notifyRenderSummary();
});
$('notify-files-none').addEventListener('click', () => {
  if (!notify.cfg) return;
  notify.sel.files.clear();
  notifyRenderFiles(); notifyRenderSummary();
});
notifySaveBtn.addEventListener('click', notifySave);
notifyPreviewBtn.addEventListener('click', notifyPreview);
notifyTestBtn.addEventListener('click', notifyTest);

// Backdrop / ✕ / Close all carry data-close.
for (const modal of [notifyModal, previewModal]) {
  modal.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]')) modal.hidden = true;
  });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!previewModal.hidden) previewModal.hidden = true;
  else if (!notifyModal.hidden) notifyClose();
});

// ---------- theme (dark/light) ----------
// The head inline-script has already applied the stored/preferred theme before
// first paint; here we just keep the toggle's icon in sync and handle clicks.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'light' ? '☀️' : '🌙';
  themeToggle.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  try { localStorage.setItem('ld-theme', theme); } catch {}
}
themeToggle.addEventListener('click', () => {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
});
applyTheme(currentTheme()); // sync icon to whatever the head script set

// ---------- boot ----------
loadAccounts(false);
viewerWrap.scrollTop = 0;
renderViewer();