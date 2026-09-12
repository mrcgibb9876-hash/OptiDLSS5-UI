// PureDark's Upscaler Base Plugin (PDPerfPlugin.dll): the one file the Resident Evil pd-upscaler
// route (reengine.js) needs that this app may not download or ship -- it is PureDark's work,
// distributed on Nexus Mods only. So the user downloads it once, and this module does the rest:
//
//   findCandidates   looks for that download in the Downloads folder: a loose PDPerfPlugin.dll,
//                    an archive named like the mod (UpscalerBasePlugin-502-...), or a folder a
//                    browser or the user already extracted it into.
//   importPlugin     takes the DLL out of whatever was picked (.dll, .zip, .7z, .rar -- the last
//                    two through Windows' own tar.exe, which is libarchive), checks it is a 64-bit
//                    DLL, and keeps one copy in the app's data folder.
//   deployToGame     puts that copy beside a game's exe. Never over a PDPerfPlugin.dll someone
//                    else placed; a copy this app placed earlier (recorded by hash in the install
//                    journal) is refreshed when a newer one is imported.
//
// The copy stays on this PC. Every user gets their own from Nexus.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { openZip, findEntry, extractEntryTo } = require('./zip');

const execFileAsync = promisify(execFile);

const PLUGIN_NAME = 'PDPerfPlugin.dll';
const INFO_NAME = 'plugin.json';
const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;
// The Nexus file is "UpscalerBasePlugin-502-<version>-<timestamp>.<ext>"; people also rename.
const NAME_HINT = /upscaler.?base.?plugin|pdperf|pd.?perf|puredark/i;
const MAX_SCAN_ENTRIES = 4000;

function cacheFile(cacheDir) {
  return path.join(cacheDir, PLUGIN_NAME);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// What is cached: { sha256, size, from, importedAt }, or null when there is no usable copy.
function readCacheInfo(cacheDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(cacheDir, INFO_NAME), 'utf8'));
    if (!info || !fs.existsSync(cacheFile(cacheDir))) return null;
    return info;
  } catch {
    return null;
  }
}

// A 64-bit Windows DLL: MZ, a PE header, machine AMD64, the DLL characteristic. The games are all
// 64-bit, and a 32-bit or non-DLL file under this name would just fail to load in silence.
function peKind(buf) {
  if (!buf || buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return 'not a Windows DLL';
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) return 'not a Windows DLL';
  const machine = buf.readUInt16LE(peOffset + 4);
  const characteristics = buf.readUInt16LE(peOffset + 22);
  if ((characteristics & 0x2000) === 0) return 'not a DLL';
  if (machine !== 0x8664) return 'a 32-bit DLL (the games are 64-bit)';
  return 'ok';
}

function isPluginName(name) {
  return String(name).toLowerCase() === PLUGIN_NAME.toLowerCase();
}

// Depth-limited search for PDPerfPlugin.dll under a folder (an extracted download).
function findPluginFile(root, maxDepth = 4) {
  let budget = MAX_SCAN_ENTRIES;
  const walk = (dir, depth) => {
    if (depth > maxDepth || budget <= 0) return null;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    budget -= entries.length;
    for (const e of entries) if (e.isFile() && isPluginName(e.name)) return path.join(dir, e.name);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = walk(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}

// Downloads that look like the plugin, newest first. Only names are matched for archives -- opening
// every zip in someone's Downloads to look inside would be slow and nosy.
function findCandidates(dirs) {
  const out = [];
  const seen = new Set();
  const push = (p, kind) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    try {
      const st = fs.statSync(p);
      seen.add(key);
      out.push({ path: p, name: path.basename(p), kind, size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  };
  for (const dir of dirs || []) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        if (isPluginName(e.name)) push(full, 'dll');
        else if (ARCHIVE_EXT.test(e.name) && NAME_HINT.test(e.name)) push(full, 'archive');
      } else if (e.isDirectory() && NAME_HINT.test(e.name)) {
        const hit = findPluginFile(full, 3);
        if (hit) push(hit, 'dll');
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function windowsTar() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

// Returns the DLL's bytes from a .dll, .zip, .7z or .rar, or throws with a sentence a person can act on.
async function readPluginFrom(sourcePath, workDir) {
  const name = path.basename(sourcePath);
  if (/\.dll$/i.test(name)) {
    if (!isPluginName(name)) throw new Error(`${name} is not ${PLUGIN_NAME} -- pick the file with exactly that name`);
    return fs.readFileSync(sourcePath);
  }
  if (/\.zip$/i.test(name)) {
    const zip = openZip(sourcePath);
    const entry = findEntry(zip, /(^|\/)pdperfplugin\.dll$/i);
    if (!entry) throw new Error(`there is no ${PLUGIN_NAME} inside ${name}`);
    const dest = path.join(workDir, PLUGIN_NAME);
    extractEntryTo(zip, entry, dest);
    return fs.readFileSync(dest);
  }
  if (/\.(7z|rar)$/i.test(name)) {
    const out = path.join(workDir, 'extracted');
    await fsp.mkdir(out, { recursive: true });
    try {
      await execFileAsync(windowsTar(), ['-xf', sourcePath, '-C', out], { windowsHide: true, timeout: 120000 });
    } catch (e) {
      throw new Error(`Windows could not open ${name} (${String(e && e.message ? e.message : e).split('\n')[0]}) -- extract it yourself and pick ${PLUGIN_NAME}`);
    }
    const hit = findPluginFile(out, 6);
    if (!hit) throw new Error(`there is no ${PLUGIN_NAME} inside ${name}`);
    return fs.readFileSync(hit);
  }
  throw new Error(`${name} is not a .dll, .zip, .7z or .rar`);
}

// Keeps one validated copy in cacheDir. Returns the cache info.
async function importPlugin(sourcePath, cacheDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('the picked file does not exist');
  await fsp.mkdir(cacheDir, { recursive: true });
  const workDir = await fsp.mkdtemp(path.join(cacheDir, '.incoming-'));
  try {
    const buf = await readPluginFrom(sourcePath, workDir);
    const kind = peKind(buf);
    if (kind !== 'ok') throw new Error(`the ${PLUGIN_NAME} found is ${kind}`);
    const info = { sha256: sha256(buf), size: buf.length, from: path.basename(sourcePath), importedAt: new Date().toISOString() };
    const tmp = cacheFile(cacheDir) + '.new';
    await fsp.writeFile(tmp, buf);
    await fsp.rm(cacheFile(cacheDir), { force: true });
    await fsp.rename(tmp, cacheFile(cacheDir));
    await fsp.writeFile(path.join(cacheDir, INFO_NAME), JSON.stringify(info, null, 2), 'utf8');
    return info;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// journalPlugin: what the install journal says this app placed here ({ sha256 }) or null.
// Returns { placed, updated, sha256?, reason? }.
function deployToGame(dir, cacheDir, journalPlugin) {
  const info = readCacheInfo(cacheDir);
  if (!info) return { placed: false, updated: false, reason: 'no plugin imported yet' };
  const dest = path.join(dir, PLUGIN_NAME);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(cacheFile(cacheDir), dest);
    return { placed: true, updated: false, sha256: info.sha256 };
  }
  const current = sha256(fs.readFileSync(dest));
  if (current === info.sha256) return { placed: false, updated: false, reason: 'already the imported copy' };
  if (journalPlugin && journalPlugin.sha256 === current) {
    fs.copyFileSync(cacheFile(cacheDir), dest);
    return { placed: false, updated: true, sha256: info.sha256 };
  }
  return { placed: false, updated: false, reason: 'a PDPerfPlugin.dll this app did not place is already there' };
}

// Whether the PDPerfPlugin.dll in dir is the one this app placed (so Remove may take it).
function isOurCopy(dir, journalPlugin) {
  if (!journalPlugin || !journalPlugin.sha256) return false;
  try {
    return sha256(fs.readFileSync(path.join(dir, PLUGIN_NAME))) === journalPlugin.sha256;
  } catch {
    return false;
  }
}

module.exports = {
  PLUGIN_NAME, NAME_HINT, cacheFile, readCacheInfo, peKind, findCandidates, findPluginFile, importPlugin, deployToGame, isOurCopy,
};
