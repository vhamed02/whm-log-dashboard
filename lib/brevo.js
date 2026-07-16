'use strict';
/**
 * Brevo transactional-email client.
 *
 * This is the ONLY place in the process that can put mail on the wire, so the
 * master arm switch is enforced here as well as at the call sites: while
 * config.notify.enabled is false, send() throws before any network call. That
 * makes "disarmed" a property of the transport rather than a discipline the
 * callers have to remember.
 */
const { config } = require('./config');

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 15000;

class BrevoError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

class DisarmedError extends Error {}

function assertSendable() {
  if (!config.notify.enabled) {
    throw new DisarmedError('notifications are disarmed (LD_NOTIFY_ENABLED=0) — refusing to send');
  }
  if (!config.notify.brevoKey) throw new BrevoError('LD_BREVO_API_KEY is not set');
  if (!config.notify.senderEmail) throw new BrevoError('LD_BREVO_SENDER_EMAIL is not set');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Send one transactional email.
 *   to: [{ email, name }]
 * Returns Brevo's messageId on success.
 *
 * Retries only on 429 and 5xx — cases where Brevo explicitly told us it did not
 * accept the message. A timeout or a socket error is NOT retried: the request
 * may well have been delivered, and a duplicate digest is worse than a missing
 * one (the next hourly flush covers the gap anyway).
 */
async function send({ to, subject, html, text }, { retries = 2 } = {}) {
  assertSendable();
  if (!Array.isArray(to) || !to.length) throw new BrevoError('no recipients');

  const body = JSON.stringify({
    sender: { email: config.notify.senderEmail, name: config.notify.senderName },
    to: to.map(r => ({ email: r.email, name: r.name })),
    subject,
    htmlContent: html,
    textContent: text,
  });

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': config.notify.brevoKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // Network error / timeout — deliberately not retried (see above).
      throw new BrevoError(`request failed: ${e.message}`);
    }

    if (res.ok) {
      let id = null;
      try { id = (await res.json()).messageId || null; } catch { /* body optional */ }
      return id;
    }

    const retryable = res.status === 429 || res.status >= 500;
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch {}

    if (!retryable || attempt >= retries) {
      throw new BrevoError(`Brevo returned ${res.status}: ${detail}`, res.status);
    }
    // Honour Retry-After when present, else exponential backoff: 2s, 4s.
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = Number.isFinite(ra) ? Math.min(ra * 1000, 30000) : 2000 * Math.pow(2, attempt);
    await sleep(waitMs);
    attempt++;
  }
}

module.exports = { send, assertSendable, BrevoError, DisarmedError };
