'use strict';
/**
 * .htaccess gateway enforcement.
 *
 * This turns "the app is protected by Apache .htaccess" from a hope into an
 * invariant the app itself enforces. It never trusts that a reverse proxy exists;
 * it demands PROOF, on every request, that the request passed the .htaccess
 * Basic-Auth layer — and fails safe (serves nothing) when that proof is absent.
 *
 * How the proof works:
 *   Apache, AFTER a successful .htaccess login (AuthType Basic + Require
 *   valid-user), injects two headers before proxying to this app:
 *     <gatewayHeader>: <shared secret>     — proves the request came through the
 *                                            .htaccess-protected proxy, not direct
 *     <userHeader>:    <REMOTE_USER>        — the authenticated .htaccess username
 *   This app verifies the secret in constant time and requires a non-empty user.
 *   A request that reaches the Node port directly (bypassing Apache) carries no
 *   secret and is rejected — so the app cannot function without .htaccess.
 *
 * Two independent guarantees, mapping to the two acceptance criteria:
 *   1. Protection MISSING/MISCONFIGURED -> app does not operate.
 *      - Boot: if a .htaccess file is configured, its protective directives are
 *        validated; on failure the app refuses to boot (throws).
 *      - Runtime: the file is re-validated periodically; if it is removed or
 *        weakened while running, the gate LOCKS and every request gets 503.
 *   2. User NOT logged in via .htaccess -> app does not operate.
 *      - Every request must carry the gateway secret AND an authenticated user,
 *        or it is rejected 403. Apache's Require valid-user guarantees only
 *        authenticated requests are ever proxied with REMOTE_USER set.
 *
 * The shared secret is what defends against a client forging the headers by
 * hitting the Node port directly: without it, X-LD-Gateway cannot be produced.
 * Bind the app to loopback (LD_HOST=127.0.0.1) so only Apache can reach it.
 */
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('./config');

const H = config.htaccess;

// Constant-time compare that tolerates differing lengths without leaking them.
function ctEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // burn comparable time, then fail
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Parse a .htaccess and confirm it actually enforces Basic auth for a valid user
// and names an AuthUserFile. Comments are stripped first so a commented-out
// directive never counts as protection.
function inspectHtaccess(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, reason: `cannot read .htaccess at ${file} (${e.code || e.message})` }; }
  const active = text.replace(/^[ \t]*#.*$/gm, '');
  if (!/^\s*AuthType\s+Basic\b/im.test(active)) {
    return { ok: false, reason: `.htaccess at ${file} does not set "AuthType Basic"` };
  }
  const m = active.match(/^\s*AuthUserFile\s+"?([^"\r\n]+?)"?\s*$/im);
  const authUserFile = m ? m[1].trim() : '';
  if (!authUserFile) {
    return { ok: false, reason: `.htaccess at ${file} has no "AuthUserFile"` };
  }
  const requiresUser = /^\s*Require\s+valid-user\b/im.test(active) || /^\s*Require\s+user\s+\S+/im.test(active);
  if (!requiresUser) {
    return { ok: false, reason: `.htaccess at ${file} does not "Require valid-user"` };
  }
  return { ok: true, authUserFile };
}

// Confirm the .htpasswd exists and holds at least one real credential line.
function inspectPasswd(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, reason: `cannot read AuthUserFile at ${file} (${e.code || e.message})` }; }
  const hasEntry = text.split(/\r?\n/).some((l) => {
    const s = l.trim();
    return s && !s.startsWith('#') && /^[^:\s]+:.+/.test(s);
  });
  if (!hasEntry) return { ok: false, reason: `AuthUserFile ${file} contains no credentials` };
  return { ok: true };
}

/**
 * Validate the whole protection setup. Returns { ok, reason }.
 * Called at boot (hard failure) and periodically (runtime lock).
 */
function validate() {
  if (!H.required) return { ok: true };
  if (!H.secret || H.secret.length < 16) {
    return { ok: false, reason: 'LD_HTACCESS_SECRET is unset or shorter than 16 characters' };
  }
  // File validation is optional: the request-time gate already enforces that a
  // request passed .htaccess. When a file IS configured we additionally prove the
  // .htaccess and its .htpasswd are genuinely protective.
  if (H.file) {
    const r = inspectHtaccess(H.file);
    if (!r.ok) return r;
    const passwd = H.passwdFile || r.authUserFile;
    if (!passwd) return { ok: false, reason: 'no AuthUserFile configured or found in the .htaccess' };
    const p = inspectPasswd(passwd);
    if (!p.ok) return p;
  }
  return { ok: true };
}

class HtaccessGate {
  constructor(log) {
    this.log = log || console;
    this.locked = false;
    this.lockReason = '';
    this.timer = null;
  }

  // Boot gate. Throws (crashing the process, which under systemd Restart=always
  // becomes a visible crash-loop) when required protection is missing/broken.
  assertBoot() {
    if (!H.required) {
      this.log.warn('[htaccess] enforcement DISABLED (LD_HTACCESS_REQUIRED != 1). The app trusts its own auth only.');
      return;
    }
    const r = validate();
    if (!r.ok) {
      throw new Error(
        `[htaccess] refusing to start — ${r.reason}. Configure the .htaccess protection ` +
        'correctly, or set LD_HTACCESS_REQUIRED=0 to disable this layer.'
      );
    }
    if (!H.file) {
      this.log.warn(
        '[htaccess] enforcement ARMED via shared-secret gate, but LD_HTACCESS_FILE is not set — ' +
        'the .htaccess content is not being validated. Set it for boot/runtime validation.'
      );
    }
    this.log.info(
      `[htaccess] enforcement ARMED — every request must carry a valid "${H.gatewayHeader}" secret ` +
      `and a "${H.userHeader}" user` + (H.file ? `; validated ${H.file}` : '') + '.'
    );
  }

  // Periodic re-validation of the on-disk protection, so removing/weakening the
  // .htaccess while the app runs also fails safe (gate locks -> 503).
  startWatch() {
    if (!H.required || !H.file) return;
    const every = Math.max(5000, H.recheckMs);
    this.timer = setInterval(() => {
      let r;
      try { r = validate(); } catch (e) { r = { ok: false, reason: e.message }; }
      if (!r.ok && !this.locked) {
        this.locked = true;
        this.lockReason = r.reason;
        this.log.error(`[htaccess] LOCKED — protection is no longer valid: ${r.reason}. All requests will 503 until fixed.`);
      } else if (r.ok && this.locked) {
        this.locked = false;
        this.lockReason = '';
        this.log.info('[htaccess] protection restored — unlocking.');
      }
    }, every);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Per-request check. Returns null to allow, or { code, message } to reject.
   * Intended to run as the FIRST onRequest hook, ahead of any app-level auth.
   */
  check(req) {
    if (!H.required) return null;
    if (this.locked) {
      return { code: 503, message: 'service unavailable: .htaccess protection is not in place' };
    }
    const gw = req.headers[H.gatewayHeader] || '';
    if (!H.secret || !ctEqual(gw, H.secret)) {
      return { code: 403, message: 'forbidden: request did not pass the .htaccess gateway' };
    }
    const user = (req.headers[H.userHeader] || '').toString().trim();
    if (!user) {
      return { code: 403, message: 'forbidden: no .htaccess-authenticated user' };
    }
    req.htUser = user; // expose the authenticated identity to handlers/logging
    return null;
  }
}

module.exports = { HtaccessGate, validate, inspectHtaccess, inspectPasswd, ctEqual };
