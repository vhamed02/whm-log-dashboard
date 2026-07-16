'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { config } = require('./config');
const { validAccount, makeId, resolveUnderAccount, SecurityError } = require('./security');

const HOME = config.homeRoot;

/**
 * In-memory cache structure:
 *   accountsCache: { list: string[], at: ms }
 *   logsCache: Map<account, { entries: [{id, account, path, size, mtime}], at: ms }>
 * Cache stores PATHS ONLY. Never file content. TTL configurable (5–10 min).
 */

const accountsCache = { list: null, at: 0 };
const logsCache = new Map();

async function isCpanelUser(dirPath, name) {
  // A real cPanel account home has the directory name equal to the username
  // and is owned by a real user. We also accept it if it contains typical
  // cPanel markers (e.g. .cpanel, public_html, mail, .bashrc). Cheap stat only.
  if (!validAccount(name)) return false;
  try {
    const st = await fsp.stat(path.join(HOME, name));
    if (!st.isDirectory()) return false;
    // Best-effort ownership check: skip root-owned skeleton dirs.
    // cpanel3-skel etc. live under /home but aren't accounts.
    if (name === 'cpanel3-skel') return false;
    return true;
  } catch { return false; }
}

async function listAccounts(force = false) {
  const now = Date.now();
  if (!force && accountsCache.list && (now - accountsCache.at) < config.cacheTtl) {
    return accountsCache.list;
  }
  let entries;
  try { entries = await fsp.readdir(HOME, { withFileTypes: true }); }
  catch (e) { accountsCache.list = []; accountsCache.at = now; return []; }
  const accounts = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (await isCpanelUser(path.join(HOME, ent.name), ent.name)) {
      accounts.push(ent.name);
    }
  }
  accounts.sort();
  accountsCache.list = accounts;
  accountsCache.at = now;
  return accounts;
}

// Glob matcher for a single segment (no `**`). Supports `*` and `?`.
function globMatch(pattern, name) {
  // Convert to regex, escaping everything except * and ?
  let r = '^';
  for (const ch of pattern) {
    if (ch === '*') r += '[^/]*';
    else if (ch === '?') r += '[^/]';
    else r += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  r += '$';
  return new RegExp(r, 'i').test(name);
}

function isLogName(name) {
  if (globMatch(config.logGlob, name)) return true;
  for (const extra of config.logExtra) {
    if (name.toLowerCase() === extra.toLowerCase()) return true;
  }
  return false;
}

function shouldSkipDir(name) {
  const lower = name.toLowerCase();
  for (const s of config.skipDirs) {
    if (lower === s || lower.includes(s)) return true;
  }
  return false;
}

/**
 * Bounded recursive walk under account home. Collects PATHS ONLY.
 * Skips heavy/irrelevant dirs. Enforces maxDepth and a hard file cap.
 * No content is ever read here.
 */
async function discoverLogsForAccount(account) {
  const homeRoot = path.join(HOME, account);
  let realHome;
  try { realHome = await fsp.realpath(homeRoot); }
  catch { return []; }

  const out = [];
  let fileCount = 0;
  const walkErrors = new Set();
  // Track REAL directory paths already queued so a symlink that points back into
  // an already-walked subtree (e.g. the default cPanel `~/www -> public_html`)
  // cannot make us enumerate the same tree twice and emit duplicate log files.
  const visitedDirs = new Set([realHome]);
  const seenFiles = new Set(); // real file paths already collected (belt & suspenders)
  const stack = [{ dir: realHome, depth: 0 }];

  while (stack.length) {
    if (fileCount >= config.maxLogsPerAccount) break;
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) {
      // Log once per distinct dir at most, then skip — never silently hide a
      // whole account tree. EACCES here means we lack read perm on this dir.
      if (!walkErrors.has(dir)) {
        walkErrors.add(dir);
        // eslint-disable-next-line no-console
        console.error(`[discovery] readdir failed on ${dir}: ${e.code || e.message}`);
      }
      continue;
    }
    for (const ent of entries) {
      if (fileCount >= config.maxLogsPerAccount) break;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        // Resolve and verify it stays under the account home; include it.
        let real;
        try { real = await fsp.realpath(full); }
        catch { continue; }
        if (real === realHome || real.startsWith(realHome + path.sep)) {
          try {
            const st = await fsp.stat(real);
            if (st.isFile() && isLogName(ent.name)) {
              if (!seenFiles.has(real)) {
                seenFiles.add(real);
                out.push({ account, path: real, size: st.size, mtime: st.mtimeMs });
                fileCount++;
              }
            } else if (st.isDirectory() && depth + 1 < config.maxDepth && !shouldSkipDir(ent.name)) {
              if (!visitedDirs.has(real)) {
                visitedDirs.add(real);
                stack.push({ dir: real, depth: depth + 1 });
              }
            }
          } catch { /* skip single entry */ }
        }
        continue;
      }
      if (ent.isFile()) {
        if (isLogName(ent.name)) {
          try {
            const st = await fsp.stat(full);
            if (!seenFiles.has(full)) {
              seenFiles.add(full);
              out.push({ account, path: full, size: st.size, mtime: st.mtimeMs });
              fileCount++;
            }
          } catch { /* skip single entry */ }
        }
      } else if (ent.isDirectory() && depth + 1 < config.maxDepth && !shouldSkipDir(ent.name)) {
        if (!visitedDirs.has(full)) {
          visitedDirs.add(full);
          stack.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }
  // Attach opaque IDs.
  const result = out.map(e => ({ ...e, id: makeId(account, e.path) }));
  if (walkErrors.size) {
    // Surface aggregate via a single log line per account discovery attempt.
    // eslint-disable-next-line no-console
    console.error(`[discovery] account=${account}: ${walkErrors.size} dir(s) skipped due to access errors`);
  }
  return result;
}

async function getLogs(account, force = false) {
  if (!validAccount(account)) throw new SecurityError('invalid account');
  const now = Date.now();
  const cached = logsCache.get(account);
  if (!force && cached && (now - cached.at) < config.cacheTtl) {
    return cached.entries;
  }
  const entries = await discoverLogsForAccount(account);
  logsCache.set(account, { entries, at: now });
  return entries;
}

/**
 * Resolve an opaque ID for an account to the validated real path, using the
 * cached discovery list as the authoritative source of truth. The ID alone
 * grants nothing — it must appear in the cached list AND belong to this account.
 */
function resolveLogId(account, id) {
  if (!validAccount(account)) throw new SecurityError('invalid account');
  const cached = logsCache.get(account);
  if (!cached) throw new SecurityError('discovery cache miss — refresh logs first');
  const entry = cached.entries.find(e => e.id === id && e.account === account);
  if (!entry) throw new SecurityError('log id not found for this account');
  // Final defensive validation: re-realpath and confirm still under home.
  return resolveUnderAccount(account, entry.path);
}

function invalidate(account) {
  if (account) logsCache.delete(account);
  else logsCache.clear();
  accountsCache.list = null;
}

module.exports = {
  listAccounts,
  getLogs,
  resolveLogId,
  invalidate,
};