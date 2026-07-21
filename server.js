'use strict';
const path = require('path');
const Fastify = require('fastify');
const { config, assertConfig, RECIPIENTS, NOTIFY_SEVERITIES, NOTIFY_PERIODS } = require('./lib/config');
const discovery = require('./lib/discovery');
const { SecurityError } = require('./lib/security');
const {
  readBlocksReverse,
  normalize,
  getLiveTail,
  searchFile,
  sourceLabel,
} = require('./lib/stream');
const notifyStore = require('./lib/notify-store');
const brevo = require('./lib/brevo');
const { Notifier, composeTest } = require('./lib/notifier');

assertConfig();
notifyStore.load();

const app = Fastify({
  logger: { level: process.env.LD_LOG_LEVEL || 'info' },
  bodyLimit: 8 * 1024,
  keepAliveTimeout: 65000,
});

// ---------- Static assets (served manually; no @fastify/static dep) ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const fs = require('fs');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

// ---------- Global auth hook ----------
const crypto = require('crypto');
// Precompute the expected header once (credentials are fixed for the process).
// Null only when auth is intentionally disabled via LD_ALLOW_NO_AUTH (assertConfig
// refuses to boot with an empty/weak LD_PASS otherwise).
const EXPECTED_AUTH = config.pass
  ? 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64')
  : null;

// Constant-time string compare that tolerates differing lengths without leaking
// them through an early return (timingSafeEqual itself throws on length mismatch).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // burn comparable time, then fail
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

app.addHook('onRequest', async (req, reply) => {
  if (!EXPECTED_AUTH) return; // auth disabled (LD_ALLOW_NO_AUTH) — nothing to check
  const header = req.headers.authorization || '';
  if (!safeEqual(header, EXPECTED_AUTH)) {
    reply.header('WWW-Authenticate', 'Basic realm="log-dashboard"');
    reply.code(401).send('auth required');
    return reply;
  }
});

app.route({
  method: 'GET',
  url: '/',
  handler: (_req, reply) => {
    return reply.type('text/html').send(fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')));
  },
});
app.route({
  method: 'GET',
  url: '/app.js',
  handler: (_req, reply) => reply.type('text/javascript').send(fs.createReadStream(path.join(PUBLIC_DIR, 'app.js'))),
});
app.route({
  method: 'GET',
  url: '/style.css',
  handler: (_req, reply) => reply.type('text/css').send(fs.createReadStream(path.join(PUBLIC_DIR, 'style.css'))),
});

// ---------- Helpers ----------

// Ensure connection upgrade contexts never end up buffered.
function writeSSEHeaders(reply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Reverse-read bounds for a viewer batch.
//  - deep=false (no severity filter): the fast newest-tail window.
//  - deep=true  (severity filter):    scan back across the file (up to the search
//    byte-cap, or the whole file when the cap is 0/unlimited) so we can gather a
//    full page of matching entries even when the recent tail contains none.
// maxBlocks is left effectively unbounded when deep so the consumer stops once it
// has enough MATCHING entries (config.initialMaxLines), not enough total blocks.
function scanBounds(deep, size) {
  if (!deep) {
    return { maxBytes: config.initialTailBytes, maxBlocks: config.initialMaxLines };
  }
  const cap = config.searchMaxBytesPerFile > 0 ? config.searchMaxBytesPerFile : size;
  return { maxBytes: cap, maxBlocks: Number.MAX_SAFE_INTEGER };
}

// ---------- API: accounts ----------
app.route({
  method: 'GET',
  url: '/accounts',
  schema: {},
  handler: async (req) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    const list = await discovery.listAccounts(force);
    return { accounts: list, cachedAt: Date.now() };
  },
});

// ---------- API: logs for an account ----------
app.route({
  method: 'GET',
  url: '/logs',
  schema: { querystring: { type: 'object', properties: { account: { type: 'string' }, force: { type: 'string' } } } },
  handler: async (req) => {
    const { account } = req.query;
    const force = req.query.force === '1' || req.query.force === 'true';
    const entries = await discovery.getLogs(account, force);
    // Return the path RELATIVE to the account home (e.g. public_html/error_log
    // or wp-content/plugins/foo/bar.log). This is safe behind the dashboard's
    // Basic Auth (admin-only) and lets the admin actually locate each file.
    // The absolute path is still never sent to the browser.
    const homeRoot = config.homeRoot;
    const accHome = path.join(homeRoot, account);
    // Most-recently-modified first, so the logs an admin is most likely to want
    // (the ones actively being written) sit at the top of the list. Ties fall
    // back to path so the order stays stable between refreshes.
    const sorted = [...entries].sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
    return {
      account,
      cachedAt: Date.now(),
      logs: sorted.map(e => {
        const base = path.basename(e.path);
        let rel = path.relative(accHome, e.path) || base;
        if (rel.startsWith('..')) rel = base; // symlink resolved outside home — fall back to basename
        return {
          id: e.id,
          name: base,
          path: rel,
          size: e.size,
          mtime: e.mtime,
        };
      }),
    };
  },
});

// ---------- API: download a whole log file as an attachment ----------
// Read-only, same authorization path as streaming: the opaque id must resolve to
// a file inside this account's home (resolveLogId re-realpaths and re-checks), so
// this can never be turned into an arbitrary-file download.
app.route({
  method: 'GET',
  url: '/download',
  schema: {
    querystring: {
      type: 'object',
      required: ['account', 'file'],
      properties: { account: { type: 'string' }, file: { type: 'string' } },
    },
  },
  handler: async (req, reply) => {
    const { account } = req.query;
    const file = String(req.query.file);
    let realPath;
    try { realPath = discovery.resolveLogId(account, file); }
    catch (e) {
      if (e instanceof SecurityError) return reply.code(403).send({ error: e.message });
      throw e;
    }
    let st;
    try { st = fs.statSync(realPath); }
    catch { return reply.code(404).send({ error: 'file not found' }); }
    if (!st.isFile()) return reply.code(404).send({ error: 'not a regular file' });

    // RFC 5987: an ASCII-safe filename for legacy clients plus a UTF-8 filename*.
    const base = path.basename(realPath);
    const asciiName = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(base)}`);
    reply.header('Cache-Control', 'no-store');
    if (st.size === 0) return reply.send('');
    // Cap the stream at the size measured now: a log being actively appended must
    // not make the response outrun a browser that trusts the initial size, and we
    // never claim a Content-Length that a later truncation could fail to fill.
    return reply.send(fs.createReadStream(realPath, { start: 0, end: st.size - 1 }));
  },
});

// ---------- API: stream (initial reverse tail + optional live SSE) ----------
app.route({
  method: 'GET',
  url: '/stream',
  schema: {
    querystring: {
      type: 'object',
      required: ['account', 'file'],
      properties: {
        account: { type: 'string' },
        file: { type: 'string' },
        live: { type: 'string' },
        severity: { type: 'string' },
        source: { type: 'string' },
      },
    },
  },
  handler: async (req, reply) => {
    const { account } = req.query;
    const file = String(req.query.file);
    const live = req.query.live === '1' || req.query.live === 'true';
    let realPath, srcFile;
    try {
      realPath = discovery.resolveLogId(account, file);
    } catch (e) {
      if (e instanceof SecurityError) return reply.code(403).send({ error: e.message });
      throw e;
    }
    srcFile = realPath;
    const displaySource = sourceLabel(realPath);
    const severity = req.query.severity || '';
    const sourceFilter = req.query.source || ''; // opaque log id filter (server re-resolves)

    writeSSEHeaders(reply);
    reply.hijack(); // we manage this response manually from here

    const res = reply.raw;
    let kaTimer = null;
    let liveTailRemove = null;

    function onAbort() {
      if (kaTimer) { clearInterval(kaTimer); kaTimer = null; }
      if (liveTailRemove) { try { liveTailRemove(); } catch {} liveTailRemove = null; }
      try { res.destroy(); } catch {}
    }
    res.on('close', onAbort);
    res.on('error', onAbort);

    try {
      // 1) Send initial newest-first batch (reverse tail, bounded).
      const size = (() => { try { return fs.statSync(realPath).size; } catch { return 0; } })();
      let count = 0;
      // Without a severity filter: fast path — just the newest ~256 KB tail.
      // With a severity filter: the recent tail may hold zero matching entries
      // (e.g. a burst of one severity) while matches sit deeper in the file, so
      // scan backwards across the file (bounded by the search byte-cap) until a
      // full page of MATCHING entries is collected.
      const { maxBytes, maxBlocks } = scanBounds(!!severity, size);
      const gen = readBlocksReverse(realPath, { maxBytes, maxBlocks });
      for await (const block of gen) {
        const norm = normalize(block, displaySource, account, new Date());
        if (severity && norm.severity !== severity) continue;
        if (sourceFilter && sourceFilter !== file) continue;
        sseSend(res, 'log', norm);
        count++;
        if (count >= config.initialMaxLines) break; // enough matching entries
      }
      // stopOffset = byte offset where this batch stopped (start of oldest entry shown).
      // The client sends it back to /more to page the next older batch.
      sseSend(res, 'initial-done', { count, size, stopOffset: gen.stopOffset });

      // 2) Optional live tail via shared poller fan-out.
      if (live) {
        const tail = getLiveTail(realPath, displaySource, account);
        liveTailRemove = tail.addListener((norm) => {
          if (severity && norm.severity !== severity) return;
          if (sourceFilter && sourceFilter !== file) return;
          sseSend(res, 'log', norm);
        });
        kaTimer = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
        if (kaTimer.unref) kaTimer.unref();
        res.write(`event: live-on\ndata: ${JSON.stringify({ pollMs: config.tailPollMs })}\n\n`);
      } else {
        res.write('event: done\ndata: {}\n\n');
        res.end();
      }
    } catch (e) {
      try { sseSend(res, 'error', { message: e.message }); res.end(); } catch {}
    }
  },
});

// ---------- API: more (page OLDER entries beyond the initial batch) ----------
app.route({
  method: 'GET',
  url: '/more',
  schema: {
    querystring: {
      type: 'object',
      required: ['account', 'file', 'offset'],
      properties: {
        account: { type: 'string' },
        file: { type: 'string' },
        offset: { type: 'string' }, // byte offset received from initial-done / previous more
        severity: { type: 'string' },
      },
    },
  },
  handler: async (req, reply) => {
    const { account } = req.query;
    const file = String(req.query.file);
    const fromOffset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(fromOffset) || fromOffset < 0) {
      return reply.code(400).send({ error: 'invalid offset' });
    }
    let realPath;
    try { realPath = discovery.resolveLogId(account, file); }
    catch (e) {
      if (e instanceof SecurityError) return reply.code(403).send({ error: e.message });
      throw e;
    }
    const displaySource = sourceLabel(realPath);
    const severity = req.query.severity || '';

    writeSSEHeaders(reply);
    reply.hijack();
    const res = reply.raw;
    res.on('close', () => { res.destroy(); });
    try {
      let count = 0;
      const size = (() => { try { return fs.statSync(realPath).size; } catch { return 0; } })();
      // Same rule as /stream: a severity filter pages OLDER matches by scanning
      // deeper, so paging keeps finding entries instead of stalling on windows
      // that happen to contain none of the requested severity.
      const { maxBytes, maxBlocks } = scanBounds(!!severity, size);
      const gen = readBlocksReverse(realPath, { maxBytes, maxBlocks, fromOffset });
      for await (const block of gen) {
        const norm = normalize(block, displaySource, account, new Date());
        if (severity && norm.severity !== severity) continue;
        sseSend(res, 'log', norm);
        count++;
        if (count >= config.initialMaxLines) break;
      }
      sseSend(res, 'more-done', { count, size, stopOffset: gen.stopOffset });
      res.end();
    } catch (e) {
      try { sseSend(res, 'error', { message: e.message }); res.end(); } catch {}
    }
    return reply;
  },
});

// ---------- API: search (streaming scan across account logs) ----------
app.route({
  method: 'GET',
  url: '/search',
  schema: {
    querystring: {
      type: 'object',
      required: ['account', 'query'],
      properties: {
        account: { type: 'string' },
        query: { type: 'string' },
        severity: { type: 'string' },
      },
    },
  },
  handler: async (req, reply) => {
    const { account, query } = req.query;
    const severity = req.query.severity || '';
    // Require /logs discovery cached first.
    let entries;
    try { entries = await discovery.getLogs(account); }
    catch (e) { if (e instanceof SecurityError) return reply.code(403).send({ error: e.message }); throw e; }

    writeSSEHeaders(reply);
    reply.hijack();
    const res = reply.raw;
    res.on('close', () => { abort = true; });
    let abort = false;

    try {
      let total = 0;
      for (const entry of entries) {
        if (abort) break;
        // Safety re-validate the cached path resolves under the account home.
        try {
          const { resolveUnderAccount } = require('./lib/security');
          resolveUnderAccount(account, entry.path);
        } catch { continue; }
        const label = sourceLabel(entry.path);
        for await (const norm of searchFile(entry, label, account, query, severity)) {
          if (abort) break;
          sseSend(res, 'match', norm);
          total++;
          if (total >= 10000) { // hard cap to protect the live box
            sseSend(res, 'truncated', { reason: 'max matches reached' });
            res.end();
            return reply;
          }
        }
      }
      sseSend(res, 'done', { total });
      res.end();
    } catch (e) {
      try { sseSend(res, 'error', { message: e.message }); res.end(); } catch {}
    }
    return reply;
  },
});

// ---------- API: refresh discovery ----------
app.route({
  method: 'POST',
  url: '/refresh',
  schema: { querystring: { type: 'object', properties: { account: { type: 'string' } } } },
  handler: async (req) => {
    const account = req.query.account || '';
    if (account) {
      discovery.invalidate(account);
      await discovery.getLogs(account, true);
    } else {
      discovery.invalidate();
      await discovery.listAccounts(true);
    }
    return { ok: true };
  },
});

// ---------- API: notifications ----------
const notifier = new Notifier(app.log);

// Static bits the settings UI needs: who can be picked, what can be subscribed
// to, and whether the process is actually able/allowed to send right now.
app.route({
  method: 'GET',
  url: '/notify/config',
  handler: async () => ({
    recipients: RECIPIENTS.map(r => ({ id: r.id, name: r.name, email: r.email })),
    severities: NOTIFY_SEVERITIES,
    periods: NOTIFY_PERIODS.map(p => ({ key: p.key, label: p.label, ms: p.ms })),
    status: notifier.status(),
  }),
});

app.route({
  method: 'GET',
  url: '/notify/settings',
  schema: { querystring: { type: 'object', required: ['account'], properties: { account: { type: 'string' } } } },
  handler: async (req) => ({ account: req.query.account, settings: notifyStore.get(req.query.account) }),
});

app.route({
  method: 'PUT',
  url: '/notify/settings',
  // The default 8 KB body limit is too small for a long file list (up to
  // LD_NOTIFY_MAX_FILES paths), so this route gets its own.
  bodyLimit: 256 * 1024,
  schema: {
    querystring: { type: 'object', required: ['account'], properties: { account: { type: 'string' } } },
    body: {
      type: 'object',
      required: ['enabled', 'severities', 'recipients', 'files'],
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        severities: { type: 'array', items: { type: 'string' } },
        recipients: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
        // Optional: older clients omit it and the store keeps the default. The
        // value is range-checked against the offered periods in notifyStore.set().
        period: { type: 'string' },
      },
    },
  },
  handler: async (req, reply) => {
    const { account } = req.query;
    let saved;
    try {
      saved = await notifyStore.set(account, req.body);
    } catch (e) {
      if (e instanceof SecurityError) return reply.code(400).send({ error: e.message });
      app.log.error({ err: e }, 'saving notification settings failed');
      return reply.code(500).send({ error: 'could not save settings' });
    }
    // Attach/detach watchers immediately so a save takes effect without waiting
    // for the periodic resync.
    try { notifier.sync(); } catch (e) { app.log.error({ err: e }, 'notifier sync failed'); }
    return { account, settings: saved, status: notifier.status() };
  },
});

// Compose the digest this account would receive right now, WITHOUT sending it
// and without clearing the buffer. This is the safe way to see exactly what
// would go out before arming the mailer.
app.route({
  method: 'GET',
  url: '/notify/preview',
  schema: {
    querystring: {
      type: 'object',
      required: ['account'],
      properties: { account: { type: 'string' }, kind: { type: 'string' } },
    },
  },
  handler: async (req) => {
    const { account } = req.query;
    const kind = req.query.kind || 'auto';
    const buffered = notifier.preview(account);
    // Prefer the real pending digest — that is what would actually go out next.
    if (kind !== 'test' && !buffered.empty) return { ...buffered, kind: 'digest' };
    // Nothing buffered yet (the common case right after setup): render the same
    // sampled email the test button would send, so the preview always shows real
    // content instead of an empty state.
    const settings = notifyStore.get(account);
    const t = await composeTest(account, settings, config.notify.testSamplePerSeverity);
    return {
      kind: 'test',
      empty: t.total === 0,
      settings,
      recipients: notifier.recipientsFor(settings),
      ...t,
    };
  },
});

// Send a one-off test email to the account's selected recipients. Hard-gated on
// the master arm switch: while LD_NOTIFY_ENABLED=0 this cannot send, and says so.
app.route({
  method: 'POST',
  url: '/notify/test',
  schema: { querystring: { type: 'object', required: ['account'], properties: { account: { type: 'string' } } } },
  handler: async (req, reply) => {
    const { account } = req.query;
    const settings = notifyStore.get(account);
    const recips = notifier.recipientsFor(settings);
    // Reads SAVED settings — ticking receivers in the UI without saving lands here.
    if (!recips.length) {
      return reply.code(400).send({
        error: 'No receivers are saved for this account. Tick the receivers you want, click Save, then try again.',
      });
    }
    if (!config.notify.enabled) {
      return reply.code(403).send({
        error: 'Notifications are disarmed (LD_NOTIFY_ENABLED=0). No email can be sent. ' +
               'Set LD_NOTIFY_ENABLED=1 in .env and restart to enable sending.',
      });
    }
    try {
      // Real content: the newest N entries of each subscribed severity, rendered
      // in the same template as a real digest — so the test proves the template
      // and the delivery, not just the delivery.
      const t = await composeTest(account, settings, config.notify.testSamplePerSeverity);
      const id = await brevo.send({ to: recips, subject: t.subject, html: t.html, text: t.text });
      app.log.info(`[notify] TEST email sent account=${account} to=${recips.map(r => r.email).join(',')} sampled=${t.total}`);
      return { ok: true, messageId: id, sentTo: recips.map(r => r.email), sampled: t.total, counts: t.counts };
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  },
});

// ---------- Error handling ----------
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof SecurityError) {
    return reply.code(403).send({ error: err.message });
  }
  app.log.error({ err }, 'request error');
  reply.code(500).send({ error: 'internal error' });
});

// ---------- Start ----------
app.listen({ host: config.host, port: config.port }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`log-dashboard listening on http://${config.host}:${config.port}`);
  app.log.info(`Auth: basic auth user="${config.user}" (${config.pass ? 'enabled' : 'DISABLED — set LD_PASS'})`);
  notifier.start();
});

// Graceful shutdown — stop pollers and in-flight streams.
function shutdown(sig) {
  app.log.info(`${sig} received, shutting down`);
  notifier.stop();
  app.close().then(() => process.exit(0)).catch(() => process.exit(1));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));