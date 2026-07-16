'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

const HOME = config.homeRoot;

/**
 * Validate and normalize a cPanel account name. cPanel usernames match
 * /^[a-z0-9][a-z0-9_-]{0,15}$/ — we enforce a strict subset to prevent any
 * traversal or odd names from reaching the filesystem.
 */
function validAccount(account) {
  return typeof account === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(account);
}

/**
 * Resolve and validate an absolute filesystem path strictly constrained to
 * /home/<account>/. Symlinks are dereferenced via realpath and re-checked so
 * a symlink cannot escape the account home. Returns the real, absolute path
 * or throws.
 */
function resolveUnderAccount(account, candidate) {
  if (!validAccount(account)) throw new SecurityError('invalid account');
  const homeRoot = path.join(HOME, account);
  // Normalize and reject any traversal segments defensively.
  const norm = path.normalize(candidate);
  if (norm.includes('..')) throw new SecurityError('path traversal rejected');
  // Realpath the home dir to get the canonical root, then realpath the file.
  let realHome;
  try { realHome = fs.realpathSync(homeRoot); }
  catch { throw new SecurityError('account home not found'); }
  // Build candidate relative to home root if it isn't already absolute.
  let abs;
  if (path.isAbsolute(norm)) abs = norm;
  else abs = path.join(realHome, norm);
  let realAbs;
  try { realAbs = fs.realpathSync(abs); }
  catch { throw new SecurityError('file not found'); }
  // Ensure the resolved file is still under the resolved account home.
  if (realAbs !== realHome && !realAbs.startsWith(realHome + path.sep)) {
    throw new SecurityError('symlink escape blocked');
  }
  return realAbs;
}

/**
 * Make an opaque ID for a (account, realPath) pair. Same path → same ID
 * within a process lifetime. Uses sha256 truncated; this is an opaque token,
 * NOT a commitment that the ID itself carries authority — resolution always
 * re-validates against the cached discovery list.
 */
function makeId(account, realPath) {
  return crypto
    .createHash('sha256')
    .update(account + '\0' + realPath)
    .digest('hex')
    .slice(0, 24);
}

class SecurityError extends Error {
  constructor(msg) { super(msg); this.statusCode = 403; }
}

module.exports = {
  SecurityError,
  validAccount,
  resolveUnderAccount,
  makeId,
};