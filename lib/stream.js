'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { config } = require('./config');

const CHUNK = 65536; // 64 KB reverse-read window

/**
 * Build a path-leak-safe display label for the `source` field of a normalized
 * entry. The raw absolute path stays server-side only; the client never learns
 * the directory structure beyond what the discovered-log list already reveals.
 */
function sourceLabel(realOrCachedPath) {
  const base = path.basename(realOrCachedPath);
  const parent = path.basename(path.dirname(realOrCachedPath));
  return parent && parent !== base ? `${base} · ${parent}` : base;
}

/**
 * Severity classification — applied in the strict priority order specified:
 *   1. Fatal / Allowed memory size / Segmentation fault  -> critical
 *   2. Generic Apache/PHP error-log lines                 -> error
 *   3. "warning" (case-insensitive)                       -> warning
 *   4. everything else                                    -> info
 */
const CRITICAL_PATTERNS = [
  /\bfatal\b/i,
  /allowed memory size/i,
  /segmentation fault/i,
  /segfault/i,
];

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Apache/nginx access log (common & combined). The bracketed date is NOT at the
// start of the line — it follows host / ident / authuser:
//   192.0.2.1 - alice [10/Oct/2026:13:55:36 -0700] "GET / HTTP/1.1" 200 1234 ...
const ACCESS_LOG_RE =
  /^\S+\s+\S+\s+\S+\s+\[(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-]\d{4}))?\]/;
// Leading ISO / nginx-error style timestamp: 2026-01-01T12:00:01, 2026/01/01 12:00:01
const ISO_LEADING_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function classify(line) {
  // Access-log lines are classified by HTTP status code, never by keyword: a
  // request URL such as /error or /fatal.php must not skew the severity.
  if (ACCESS_LOG_RE.test(line)) {
    const m = /\]\s+"[^"]*"\s+(\d{3})\b/.exec(line);
    if (m) {
      const code = parseInt(m[1], 10);
      if (code >= 500) return 'error';
      if (code >= 400) return 'warning';
    }
    return 'info';
  }
  for (const p of CRITICAL_PATTERNS) if (p.test(line)) return 'critical';
  if (/warning/i.test(line)) return 'warning';
  // Apache/PHP error log lines typically start with a bracketed timestamp
  // and the message body often begins with "PHP " / "AH0" + error-ish tokens.
  if (/^\[[^\]]*\]\s*(?:\[error\]|\[emerg\]|\[alert\])/i.test(line)) return 'error';
  if (/^\[[^\]]*\]\s*PHP\s+(?:Parse|Fatal|Notice|Deprecated|Warning|Strict|Catchable)/i.test(line)) {
    // Notice/Deprecated would otherwise fall to info; per the spec these are
    // "generic Apache/PHP error-log lines" -> error.
    return 'error';
  }
  if (/\berror\b/i.test(line) || /\bexception\b/i.test(line)) return 'error';
  return 'info';
}

/**
 * Try to parse a leading timestamp from common Apache/PHP error log formats.
 * Returns a Date or null. Never throws.
 */
function parseTimestamp(line) {
  // 1) Apache/nginx access log: host ... [10/Oct/2026:13:55:36 -0700] ...
  //    JS Date cannot parse this shape natively, so build it explicitly.
  let a = ACCESS_LOG_RE.exec(line);
  if (a) {
    const mon = MONTHS[a[2].toLowerCase()];
    if (mon != null) {
      const tz = a[7] ? `${a[7].slice(0, 3)}:${a[7].slice(3)}` : 'Z';
      const d = new Date(`${a[3]}-${String(mon + 1).padStart(2, '0')}-${a[1]}T${a[4]}:${a[5]}:${a[6]}${tz}`);
      if (!isNaN(d)) return d;
    }
  }
  // 2) Leading bracketed timestamp — PHP error_log ([01-Jan-2026 12:34:56 UTC])
  //    or Apache error log ([Mon Jan 01 12:34:56.789012 2026]).
  let m = /^\[([^\]]+)\]/.exec(line);
  if (m) {
    const t = m[1];
    let d = new Date(t);
    if (!isNaN(d)) return d;
    // Strip sub-second microseconds Date can't handle: 12:34:56.789012 -> 12:34:56
    d = new Date(t.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1'));
    if (!isNaN(d)) return d;
    // Named-region timezone (e.g. "America/New_York") that Date rejects: drop the
    // trailing tz token and parse as local time — better than the read-time fallback.
    d = new Date(t.replace(/\s+[A-Za-z][A-Za-z0-9_/+-]*$/, '').trim());
    if (!isNaN(d)) return d;
  }
  // 3) Leading ISO / nginx-error style: 2026-01-01T12:00:01, 2026/01/01 12:00:01
  m = ISO_LEADING_RE.exec(line);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
    if (!isNaN(d)) return d;
  }
  return null;
}

// A "block" is one logical log entry: an opener line (starts with `[`) plus
// any continuation lines that follow it (stack traces, "thrown in ...", etc.).
// Continuation lines never start with `[`. Grouping them this way is what lets
// a multi-line PHP fatal error carry severity=critical for ALL its lines
// (including "thrown in ..." which would otherwise classify as info).
function isBlockStart(line) {
  // Bracketed leading timestamp — covers PHP error_log ([01-Jan-2026 ...]) and
  // Apache error log ([Mon Jul 06 ...]).
  if (/^\[[^\]]+\]/.test(line)) return true;
  // Apache/nginx access log — each request line is its own record; the date
  // sits after host/ident/authuser rather than at the start of the line.
  if (ACCESS_LOG_RE.test(line)) return true;
  // Leading ISO / nginx-error style timestamp (2026-01-01T..., 2026/01/01 ...).
  if (ISO_LEADING_RE.test(line)) return true;
  // Everything else (Stack trace:, "#0 ...", " thrown in ...", wrapped lines) is
  // a continuation of the preceding record.
  return false;
}

function normalize(block, srcFile, account, fallbackTs) {
  // block = array of lines in FILE order (opener first). Single-line entries
  // arrive as a 1-element array.
  const opener = block[0];
  const ts = parseTimestamp(opener) || fallbackTs || new Date();
  return {
    ts: ts instanceof Date ? ts.toISOString() : ts,
    severity: classify(opener),
    message: block.join('\n'),
    source: srcFile,
    account,
  };
}

/**
 * Reverse block reader — async generator yielding BLOCKS (arrays of lines in
 * FILE order, opener first) newest-first WITHOUT ever loading the whole file.
 *
 * Options:
 *   maxBytes   — max bytes to read backwards from the end (default LD_INITIAL_TAIL_BYTES).
 *   maxBlocks  — max number of blocks (entries) to yield.
 *   fromOffset — read backwards from this byte offset instead of EOF. Use this
 *                to page OLDER entries: pass the stopOffset returned by the
 *                previous batch.
 *
 * The generator object has a `.stopOffset` property set after iteration ends:
 * the byte offset of the START of the oldest yielded block (or 0 if the
 * beginning of the file was reached). Use it as the next fromOffset.
 */
async function* readBlocksReverse(filePath, { maxBytes, maxBlocks, fromOffset } = {}) {
  const self = this;
  let stat;
  try { stat = await fsp.stat(filePath); }
  catch (e) { throw new Error(`cannot stat ${filePath}: ${e.message}`); }
  const size = stat.size;
  if (size === 0) { self.stopOffset = 0; return; }

  const end = (typeof fromOffset === 'number' && fromOffset >= 0 && fromOffset <= size)
    ? fromOffset : size;
  if (end === 0) { self.stopOffset = 0; return; }

  const limit = Math.min(maxBytes || config.initialTailBytes, end);
  const floor = Math.max(0, end - limit);

  let pos = end;          // current read position (excl.); we move it backwards
  let pendingStr = '';    // partial line at the OLDER edge spanning chunk boundary
  let pendingStart = end; // byte offset of pendingStr's start in the file
  let yielded = 0;
  let contBuf = [];       // continuation lines (newest first) awaiting their opener

  self.stopOffset = floor;

  const fd = await fsp.open(filePath, 'r');
  try {
    while (pos > floor && yielded < maxBlocks) {
      const take = Math.min(CHUNK, pos - floor);
      if (take <= 0) break;
      const buf = Buffer.allocUnsafe(take);
      const from = pos - take;
      await fd.read(buf, 0, take, from);
      pos = from;
      const chunkStr = buf.subarray(0, take).toString('utf8');
      const combined = chunkStr + pendingStr;
      // Byte length of each line in `combined` — we need file offsets, so
      // compute using Buffer byteLength per segment (utf8 safe).
      const segs = combined.split('\n');
      // Cumulative byte length of each seg plus its trailing \n. The first seg's
      // file start = pos (offset of chunkStr start). Subsequent segs follow.
      const starts = [];
      let cursor = pos;
      for (let i = 0; i < segs.length; i++) {
        starts[i] = cursor;
        cursor += Buffer.byteLength(segs[i], 'utf8') + 1; // +1 for the \n
      }
      const reachedFloor = pos <= floor || pos <= 0;
      let startIdx = 0;
      if (!reachedFloor && segs.length > 1) {
        // The first segment is a partial line at the older edge — keep it for next chunk.
        pendingStr = segs[0];
        pendingStart = starts[0];
        startIdx = 1;
      } else {
        pendingStr = '';
      }
      for (let i = segs.length - 1; i >= startIdx; i--) {
        if (yielded >= maxBlocks) break;
        const line = segs[i].replace(/\r$/, '');
        if (line.length === 0) continue;
        if (isBlockStart(line)) {
          const block = [line].concat(contBuf.reverse());
          contBuf = [];
          self.stopOffset = starts[i];
          yield block;
          yielded++;
        } else {
          contBuf.push(line);
        }
      }
      if (pos <= 0 || pos <= floor) break;
    }
    // Flush leftover partial line at the older edge.
    if (pendingStr.length && yielded < maxBlocks) {
      const line = pendingStr.replace(/\r$/, '');
      if (line) {
        if (isBlockStart(line)) {
          self.stopOffset = pendingStart;
          yield [line].concat(contBuf.reverse());
        } else {
          contBuf.push(line);
          self.stopOffset = pendingStart;
          yield contBuf.reverse();
        }
      }
    } else if (contBuf.length && yielded < maxBlocks) {
      // Orphan continuations only — emit them; nothing older to page to.
      self.stopOffset = 0;
      yield contBuf.reverse();
    }
  } finally {
    await fd.close();
  }
}

function readBlocksReverseSyncWrapper(filePath, opts) {
  const holder = { stopOffset: 0 };
  const gen = readBlocksReverse.call(holder, filePath, opts);
  Object.defineProperty(gen, 'stopOffset', {
    get() { return holder.stopOffset; },
  });
  return gen;
}

/**
 * Shared live-tail manager, one per file (by real path).
 * A SINGLE poller reads appended bytes ONCE when the file grows, then fans
 * the new complete lines out to every attached listener. No content is held
 * beyond the small partial-line scratch buffer kept by the poller itself.
 * Listeners may abort via the controller; when the last listener detaches the
 * poller is stopped, freeing the timer and any state.
 */
class LiveTail {
  constructor(realPath, srcFile, account) {
    this.realPath = realPath;
    this.srcFile = srcFile;
    this.account = account;
    this.size = 0;
    this.partial = ''; // bytes appended since last flush that didn't end in \n
    this.blockBuf = null; // current block being assembled, file order: [opener, ...cont]
    this.flushTimer = null; // idle flush for blocks awaiting next opener
    this.listeners = new Set(); // each: (normalizedEntry) => void
    this.timer = null;
    this.stopped = false;
  }
  async start() {
    try { this.size = (await fsp.stat(this.realPath)).size; }
    catch { this.size = 0; }
    this.timer = setInterval(() => this._tick().catch(() => {}), config.tailPollMs);
    if (this.timer.unref) this.timer.unref();
  }
  _emitBlock() {
    if (!this.blockBuf || !this.blockBuf.length) return;
    const norm = normalize(this.blockBuf, this.srcFile, this.account, new Date());
    this.blockBuf = null;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    for (const l of [...this.listeners]) {
      try { l(norm); } catch { /* listener gone */ }
    }
  }
  _ingestLine(line) {
    if (isBlockStart(line)) {
      // New opener — flush any in-progress block, then start a new one.
      this._emitBlock();
      this.blockBuf = [line];
    } else if (this.blockBuf) {
      // Continuation of the current block.
      this.blockBuf.push(line);
    } else {
      // Continuation with no current block (e.g. file rotated mid-block):
      // treat as a standalone info-ish entry.
      this.blockBuf = [line];
    }
    // Idle-flush: if no new opener arrives within 400 ms, emit the block so
    // the user sees the entry without waiting for the next one to arrive.
    if (this.blockBuf && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this._emitBlock();
      }, 400);
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
  }
  async _tick() {
    let st;
    try { st = await fsp.stat(this.realPath); }
    catch { return; } // file rotated/removed — silent
    const newSize = st.size;
    if (newSize <= this.size) {
      if (newSize < this.size) { this.size = newSize; this.partial = ''; this.blockBuf = null; }
      return;
    }
    const toRead = newSize - this.size;
    const MAX_BURST = 8 * 1024 * 1024;
    const readNow = Math.min(toRead, MAX_BURST);
    const fd = await fsp.open(this.realPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(readNow);
      await fd.read(buf, 0, readNow, this.size);
      this.size += readNow;
      const text = this.partial + buf.toString('utf8');
      this.partial = '';
      const lines = text.split('\n');
      if (!text.endsWith('\n')) {
        this.partial = lines.pop();
      } else if (lines.length && lines[lines.length - 1] === '') {
        lines.pop();
      }
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line) continue;
        this._ingestLine(line);
      }
    } finally { await fd.close(); }
  }
  addListener(fn) {
    this.listeners.add(fn);
    if (this.listeners.size === 1 && !this.timer) this.start();
    return () => this.removeListener(fn);
  }
  removeListener(fn) {
    this.listeners.delete(fn);
    if (this.listeners.size === 0) this.stop();
  }
  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.partial = '';
    this.blockBuf = null;
  }
}

const liveTails = new Map(); // realPath -> LiveTail
function getLiveTail(realPath, srcFile, account) {
  let t = liveTails.get(realPath);
  if (!t || t.stopped) {
    t = new LiveTail(realPath, srcFile, account);
    liveTails.set(realPath, t);
  }
  return t;
}

/**
 * Forward scanner for full-text search across an account's log files.
 * Async generator yielding NORMALIZED BLOCK matches. Streams line-by-line via
 * fs.read; never buffers the whole file. A block matches if ANY of its lines
 * contains the query (so a search for "WP_Widget" hits the whole stack trace
 * block, including the "thrown in" line). Honours a per-file byte cap to
 * protect the live box under adversarial workloads.
 */
async function* searchFile(entry, displaySource, account, query, severity) {
  const cap = config.searchMaxBytesPerFile;
  let stat;
  try { stat = await fsp.stat(entry.path); }
  catch { return; }
  const size = stat.size;
  const startByte = cap > 0 && size > cap ? size - cap : 0;
  const fd = await fsp.open(entry.path, 'r');
  let partial = '';
  let bytesRead = startByte;
  const buf = Buffer.allocUnsafe(CHUNK);
  let blockBuf = null; // [opener, ...cont] in file order

  function matchBlock(block) {
    if (!block || !block.length) return false;
    if (!query) return true;
    const hay = block.join('\n').toLowerCase();
    return hay.includes(query.toLowerCase());
  }
  function emit(block) {
    if (!block || !block.length) return null;
    if (!matchBlock(block)) return null;
    const norm = normalize(block, displaySource, account, new Date());
    if (severity && norm.severity !== severity) return null;
    return norm;
  }

  try {
    if (startByte > 0) {
      const r = await fd.read(buf, 0, Math.min(CHUNK, size - startByte), startByte);
      const seg = buf.subarray(0, r.bytesRead).toString('utf8');
      const nl = seg.indexOf('\n');
      if (nl === -1) bytesRead = startByte + r.bytesRead;
      else bytesRead = startByte + nl + 1;
    }
    while (bytesRead < size) {
      const want = Math.min(CHUNK, size - bytesRead);
      const r = await fd.read(buf, 0, want, bytesRead);
      if (!r.bytesRead) break;
      bytesRead += r.bytesRead;
      const text = partial + buf.subarray(0, r.bytesRead).toString('utf8');
      partial = '';
      const lines = text.split('\n');
      if (!text.endsWith('\n')) partial = lines.pop();
      else if (lines.length && lines[lines.length - 1] === '') lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line) continue;
        if (isBlockStart(line)) {
          if (blockBuf) {
            const out = emit(blockBuf);
            if (out) yield out;
          }
          blockBuf = [line];
        } else if (blockBuf) {
          blockBuf.push(line);
        } else {
          blockBuf = [line];
        }
      }
    }
    if (partial) {
      const line = partial.replace(/\r$/, '');
      if (line) {
        if (isBlockStart(line)) {
          if (blockBuf) { const out = emit(blockBuf); if (out) yield out; }
          blockBuf = [line];
        } else if (blockBuf) blockBuf.push(line);
        else blockBuf = [line];
      }
    }
    if (blockBuf) { const out = emit(blockBuf); if (out) yield out; }
  } finally {
    await fd.close();
  }
}

module.exports = {
  readBlocksReverse: readBlocksReverseSyncWrapper,
  normalize,
  sourceLabel,
  classify,
  parseTimestamp,
  isBlockStart,
  getLiveTail,
  searchFile,
  LiveTail,
};