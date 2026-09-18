'use strict';
// Noticing that a game updated under an install (2026-09-18).
//
// A store update or a Steam "verify integrity" rewrites the exe and, often, deletes DLLs it does not
// know -- which is exactly OptiScaler's proxy, the NR model and the Feeder's add-on. Until now the
// app found out only when the next launch ran without DLSS 5, and the card still said "Set up": the
// sync quietly skipped a game whose files were gone ("not installed") and the route answer cached
// from before the update kept describing the old exe.
//
// So each sync compares the exe with the fingerprint taken at the last one -- size, mtime, a hash of
// its first 64 KB (the PE header, whose link timestamp changes on any rebuild; the whole exe can be
// 100 MB+, not something to hash per game per sync), and for a Steam game the manifest's buildid --
// and remembers which of our files were in the folder. A changed exe invalidates the cached
// detection and says "Game updated -- rechecked"; a changed exe with our files gone says the game
// needs a reinstall, instead of failing silently at the next launch.
//
// The fingerprints live in the app's own userData, not in the game folder: the update that deletes
// our DLLs can take a marker file of ours with them, and then there would be nothing to compare.
// .dlss5ui-keep-as-is games never get here -- the sync returns before any of this (main.js).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE_NAME = 'game-fingerprints.json';
const HEAD_BYTES = 64 * 1024;

// Files this app places that an update is known to delete. Only the ones present at the last sync
// are watched, so a route that never had a given file is never told it lost it.
const OUR_FILES = [
  'OptiScaler.ini', 'OptiScaler.dll', 'nvngx_dlssnr.dll', 'nvngx.dll_dlssnr.dll', 'OptiScaler_OpticalFlow.dll',
  'dlss5-feed.addon64', 'dlss5-feed.addon32',
  'host64/winmm.dll', 'host64/OptiScaler.ini', 'host64/dlss5-feed-host64.exe', 'host64/nvngx_dlssnr.dll',
  'dgVoodoo.conf',
];
const LEGACY_MARKER = '.dlss5ui-legacy.json';
const FEEDER_MARKER = '.dlss5ui-feeder-deploy.json';

function storeFile(userDataDir) {
  return path.join(userDataDir, STORE_NAME);
}

function readStore(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeStore(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* a fingerprint that could not be saved is taken again next sync */ }
}

const keyFor = (exePath) => path.resolve(String(exePath)).toLowerCase();

// "installdir" -> appmanifest file, per steamapps folder, built once per run: reading every
// manifest in a big library for every game on every sync is the per-game cost the UI cannot afford
// (v1.59.0). The one manifest a game maps to is small and read fresh each time.
const manifestIndex = new Map();
const kv = (text, key) => (text.match(new RegExp(`"${key}"\\s+"([^"]+)"`, 'i')) || [])[1];

function indexSteamApps(appsDir, refresh = false) {
  if (!refresh && manifestIndex.has(appsDir)) return manifestIndex.get(appsDir);
  const index = new Map();
  let files = [];
  try { files = fs.readdirSync(appsDir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)); } catch {}
  for (const f of files) {
    try {
      const dir = kv(fs.readFileSync(path.join(appsDir, f), 'utf8'), 'installdir');
      if (dir) index.set(dir.toLowerCase(), f);
    } catch {}
  }
  manifestIndex.set(appsDir, index);
  return index;
}

// { appid, buildid } for an exe under steamapps\common\<installdir>, or null when it is not a Steam
// game (or the manifest cannot be read, which is simply "not determinable").
function steamBuild(exePath) {
  const parts = path.resolve(String(exePath || '')).split(path.sep);
  for (let i = parts.length - 2; i >= 2; i--) {
    if (parts[i].toLowerCase() !== 'common' || parts[i - 1].toLowerCase() !== 'steamapps') continue;
    const appsDir = parts.slice(0, i).join(path.sep);
    const installdir = (parts[i + 1] || '').toLowerCase();
    for (const refresh of [false, true]) {
      const file = indexSteamApps(appsDir, refresh).get(installdir);
      if (!file) continue;
      try {
        const text = fs.readFileSync(path.join(appsDir, file), 'utf8');
        if ((kv(text, 'installdir') || '').toLowerCase() !== installdir) continue;
        const appid = kv(text, 'appid');
        const buildid = kv(text, 'buildid');
        return appid || buildid ? { appid: appid || null, buildid: buildid || null } : null;
      } catch { /* the manifest went away: look again with a fresh index */ }
    }
    return null;
  }
  return null;
}

function headHash(exePath) {
  let fd;
  try {
    fd = fs.openSync(exePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return crypto.createHash('sha1').update(buf.subarray(0, n)).digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function fingerprint(exePath) {
  let st;
  try { st = fs.statSync(exePath); } catch { return null; }
  return { size: st.size, mtimeMs: st.mtimeMs, head: headHash(exePath), steam: steamBuild(exePath) };
}

// Whether two fingerprints describe different executables. A Steam buildid that moved is an update
// whatever the exe looks like (the patch can leave the exe itself alone); otherwise any of size,
// mtime or header hash. A bare mtime change counts too: a Steam verify that re-wrote the same bytes
// is precisely the pass that deletes unknown DLLs.
function exeChanged(before, now) {
  if (!before || !now) return false;
  const b = before.steam && before.steam.buildid;
  const n = now.steam && now.steam.buildid;
  if (b && n && b !== n) return true;
  return before.size !== now.size || before.mtimeMs !== now.mtimeMs || (!!before.head && !!now.head && before.head !== now.head);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Our files in this folder right now (game-relative, forward slashes). extra: names only the caller
// knows, such as the proxy OptiScaler is running under (main.js findActiveOptiScalerFile).
function ourFiles(dir, extra = []) {
  const wanted = new Set(OUR_FILES);
  for (const e of extra) if (e) wanted.add(String(e).replace(/\\/g, '/'));
  const legacy = readJson(path.join(dir, LEGACY_MARKER));
  if (legacy && Array.isArray(legacy.files)) {
    for (const f of legacy.files) if (/\.(dll|asi|addon32|addon64|exe)$/i.test(String(f))) wanted.add(String(f).replace(/\\/g, '/'));
  }
  if (fs.existsSync(path.join(dir, FEEDER_MARKER))) wanted.add('ReShade64.dll');
  return [...wanted].filter((rel) => fs.existsSync(path.join(dir, ...rel.split('/')))).sort();
}

// Before the sync: has the exe changed since the last one, and which of our files did the change
// take? Pure reading -- nothing is recorded until commit, so a sync that fails half-way asks again.
function inspect(file, exePath, dir) {
  const store = readStore(file);
  const prev = store[keyFor(exePath)] || null;
  const now = fingerprint(exePath);
  const changed = !!prev && exeChanged(prev.exe, now);
  const missing = prev
    ? (prev.files || []).filter((rel) => !fs.existsSync(path.join(dir, ...rel.split('/'))))
    : [];
  return { prev, now, changed, missing };
}

// After the sync: records the fingerprint and our files as they are now, and returns what the card
// should say -- null when there is nothing to say.
//
// needsReinstall stays until the files come back (a reinstall) or none of ours is left at all,
// when the card's own "Install" already says it; so an app restart does not lose the hint.
function commit(file, exePath, dir, inspection, { extra = [] } = {}) {
  const { prev, now, changed, missing } = inspection || {};
  const store = readStore(file);
  const files = ourFiles(dir, extra);
  const hadOurs = !!prev && (prev.files || []).length > 0;

  let flagged = null;
  if (changed && hadOurs && missing.length > 0) flagged = missing;
  else if (prev && Array.isArray(prev.pendingReinstall)) {
    const still = prev.pendingReinstall.filter((rel) => !files.includes(rel));
    flagged = still.length > 0 ? still : null;
  }
  // Nothing of ours left: the card is back to "Not installed" and its Install says the rest.
  const pending = flagged && files.length > 0 ? flagged : null;

  if (now) {
    store[keyFor(exePath)] = { exe: now, files, pendingReinstall: pending, at: new Date().toISOString() };
    writeStore(file, store);
  }

  if (!(changed && hadOurs) && !pending) return null;
  const build = (fp) => (fp && fp.steam && fp.steam.buildid) || null;
  return {
    rechecked: !!(changed && hadOurs),
    needsReinstall: !!flagged,
    missing: flagged || [],
    buildFrom: build(prev && prev.exe),
    buildTo: build(now),
  };
}

module.exports = { STORE_NAME, OUR_FILES, storeFile, fingerprint, exeChanged, steamBuild, ourFiles, inspect, commit, _manifestIndex: manifestIndex };
