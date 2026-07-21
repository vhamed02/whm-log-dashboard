'use strict';
/**
 * Brute-force lockout for the dashboard's Basic Auth.
 *
 * The dashboard is exposed directly on the internet behind a single password, so
 * the attack that matters is guessing it. This tracks failed logins per client IP
 * and temporarily blocks an IP once it crosses a threshold, turning an unlimited
 * guess rate into a few tries per lockout window. In-memory, no dependencies; the
 * tracking map is bounded so it can never be used to exhaust memory.
 */
class LoginGuard {
  constructor({ maxFails = 5, windowMs = 900000, lockoutMs = 900000, maxTracked = 20000 } = {}) {
    this.maxFails = maxFails;      // failed guesses allowed within a window
    this.windowMs = windowMs;      // window the failures are counted over
    this.lockoutMs = lockoutMs;    // how long an IP stays blocked once tripped
    this.maxTracked = maxTracked;  // hard cap on distinct IPs held in memory
    this.map = new Map();          // ip -> { fails, first, lockedUntil }
  }

  // 0 if the IP may attempt a login now, else the ms remaining on its lockout.
  retryAfter(ip, now = Date.now()) {
    const e = this.map.get(ip);
    return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
  }

  // Record a failed credential attempt. Returns the lockout ms if this trips it.
  fail(ip, now = Date.now()) {
    let e = this.map.get(ip);
    if (!e || now - e.first > this.windowMs) {
      e = { fails: 0, first: now, lockedUntil: 0 };
      this._track(ip, e);
    }
    e.fails++;
    if (e.fails >= this.maxFails) {
      e.lockedUntil = now + this.lockoutMs;
      e.fails = 0;              // fresh count once the lock expires
      e.first = e.lockedUntil;
      return this.lockoutMs;
    }
    return 0;
  }

  // Clear an IP's record after a successful login.
  succeed(ip) { this.map.delete(ip); }

  _track(ip, e) {
    if (this.map.size >= this.maxTracked) {
      const now = Date.now();
      for (const [k, v] of this.map) {
        if (v.lockedUntil <= now && now - v.first > this.windowMs) this.map.delete(k);
      }
      if (this.map.size >= this.maxTracked) {
        const oldest = this.map.keys().next().value; // Map preserves insertion order
        if (oldest !== undefined) this.map.delete(oldest);
      }
    }
    this.map.set(ip, e);
  }
}

module.exports = { LoginGuard };
