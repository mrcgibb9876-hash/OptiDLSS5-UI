// Unreal's own HDR output, switched on in the game's user Engine.ini, for RenoDX UE-Extended's
// native-HDR path (ueextended.js).
//
// WHY. On a game UE-Extended runs with Set_Path = 0 (Dawnwalker, Hell is Us, Lies of P, STALKER 2 ...)
// the add-on does not upgrade an SDR swap chain: it fixes the HDR the ENGINE outputs. So the engine has
// to be outputting HDR, and on most of these games there is no in-game switch for it -- it is
// r.HDR.* in Engine.ini. The add-on does not write that file; this module does.
//
// WHERE. %LOCALAPPDATA%\<Project>\Saved\Config\<Windows|WinGDK>\Engine.ini, where <Project> is the
// folder above Binaries (…\Dawnwalker\Binaries\Win64\Dawnwalker.exe -> "Dawnwalker") and WinGDK is the
// Game Pass / Microsoft Store build's platform folder. A layout this cannot read is left alone.
//
// READ-ONLY. An Unreal game rewrites -- and when nothing in it differs from the defaults, DELETES --
// its user Engine.ini on exit, which took these lines out after the first run. So the file is set
// read-only after writing, and made writable again before anything here touches it.
//
// UNDO IS EXACT. apply() returns a record of what it did (created the file? which folders? where the
// original was backed up?), the add-ons marker keeps it (addons.js), and revert() reverses exactly
// that: the backup put back if there is one; a file we created deleted only when it holds nothing but
// our keys (otherwise just our keys are taken out); folders we created removed only when empty.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SECTION = 'SystemSettings';
const HDR_KEYS = [
  ['r.AllowHDR', '1'],
  ['r.HDR.EnableHDROutput', '1'],
  ['r.HDR.Display.OutputDevice', '3'],
  ['r.HDR.Display.ColorGamut', '2'],
  ['r.HDR.UI.CompositeMode', '1'],
  ['r.LUT.UpdateEveryFrame', '1'],
];
const BACKUP_SUFFIX = '.dlss5ui-orig';

// { project, platform, dir, file } for an exe, or null when the folder above Binaries cannot be told.
function engineIniLocation(exePath, { localAppData = process.env.LOCALAPPDATA } = {}) {
  if (!exePath || !localAppData) return null;
  const binDir = path.dirname(path.resolve(exePath));
  const platformDir = path.basename(binDir);
  const binaries = path.dirname(binDir);
  if (path.basename(binaries).toLowerCase() !== 'binaries') return null;
  if (!/^win(64|gdk)$/i.test(platformDir)) return null;
  const project = path.basename(path.dirname(binaries));
  if (!project || /^engine$/i.test(project) || project === path.dirname(binaries)) return null;
  const platform = /^wingdk$/i.test(platformDir) || /-wingdk-shipping\.exe$/i.test(exePath) ? 'WinGDK' : 'Windows';
  const dir = path.join(localAppData, project, 'Saved', 'Config', platform);
  return { project, platform, dir, file: path.join(dir, 'Engine.ini') };
}

function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }
const isHeader = (line) => /^\s*\[[^\]]*\]\s*$/.test(line);
const headerName = (line) => line.trim().slice(1, -1).trim();
const keyOf = (line) => { const m = /^\s*([^=;#\s][^=]*?)\s*=/.exec(line); return m ? m[1] : null; };
const ourKey = (k) => !!k && HDR_KEYS.some(([key]) => key.toLowerCase() === k.toLowerCase());

// Merge HDR_KEYS into [SystemSettings]: existing lines for these keys get our value, missing ones are
// added at the end of the section, the section is added when absent. Everything else is kept as is.
function mergeHdrKeys(text) {
  const eol = eolOf(text || '');
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (isHeader(lines[i]) && headerName(lines[i]).toLowerCase() === SECTION.toLowerCase()) { start = i; break; }
  const want = new Map(HDR_KEYS.map(([k, v]) => [k.toLowerCase(), [k, v]]));
  if (start < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${SECTION}]`, ...HDR_KEYS.map(([k, v]) => `${k}=${v}`));
    return lines.join(eol) + eol;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (isHeader(lines[i])) { end = i; break; }
  const seen = new Set();
  for (let i = start + 1; i < end; i++) {
    const k = keyOf(lines[i]);
    if (k && want.has(k.toLowerCase())) {
      const [key, v] = want.get(k.toLowerCase());
      lines[i] = `${key}=${v}`;
      seen.add(k.toLowerCase());
    }
  }
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  const add = HDR_KEYS.filter(([k]) => !seen.has(k.toLowerCase())).map(([k, v]) => `${k}=${v}`);
  lines.splice(insertAt, 0, ...add);
  return lines.join(eol) + eol;
}

// The text with our keys taken out of [SystemSettings] (and the section too if nothing is left in it).
function stripHdrKeys(text) {
  const eol = eolOf(text || '');
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (isHeader(line)) inSection = headerName(line).toLowerCase() === SECTION.toLowerCase();
    if (inSection && ourKey(keyOf(line))) continue;
    out.push(line);
  }
  // Drop a [SystemSettings] header left with nothing under it.
  const cleaned = [];
  for (let i = 0; i < out.length; i++) {
    if (isHeader(out[i]) && headerName(out[i]).toLowerCase() === SECTION.toLowerCase()) {
      let j = i + 1;
      while (j < out.length && out[j].trim() === '') j++;
      if (j >= out.length || isHeader(out[j])) { i = j - 1; continue; }
    }
    cleaned.push(out[i]);
  }
  while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();
  return cleaned.length ? cleaned.join(eol) + eol : '';
}

// Whether the file holds nothing but our keys (plus headers, blank lines and comments).
function onlyOurKeys(text) {
  return String(text || '').split(/\r?\n/).every((line) => {
    const t = line.trim();
    if (!t || t.startsWith(';') || t.startsWith('#')) return true;
    if (isHeader(line)) return headerName(line).toLowerCase() === SECTION.toLowerCase();
    return ourKey(keyOf(line));
  });
}

function makeWritable(file) {
  try { fs.chmodSync(file, 0o666); } catch {}
}

function isReadOnly(file) {
  try { return (fs.statSync(file).mode & 0o200) === 0; } catch { return false; }
}

// Write the keys. Returns the record revert() needs, or { skipped } when nothing was done.
function applyEngineIniHdr(exePath, { localAppData = process.env.LOCALAPPDATA } = {}) {
  const loc = engineIniLocation(exePath, { localAppData });
  if (!loc) return { skipped: 'no-project', reason: `could not tell the Unreal project folder from ${exePath}` };
  const record = { file: loc.file, project: loc.project, platform: loc.platform, created: false, backup: null, createdDirs: [], keys: HDR_KEYS.map(([k, v]) => `${k}=${v}`) };

  if (fs.existsSync(loc.file)) {
    makeWritable(loc.file);
    const original = fs.readFileSync(loc.file, 'utf8');
    const backup = loc.file + BACKUP_SUFFIX;
    // Once: a backup already there is the older original and is kept, not overwritten with a file we
    // may already have edited.
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
    record.backup = backup;
    fs.writeFileSync(loc.file, mergeHdrKeys(original), 'utf8');
  } else {
    // The folders the game would make on its first run, recorded so revert() takes back only ours.
    const missing = [];
    for (let d = loc.dir; d && d !== localAppData && !fs.existsSync(d); d = path.dirname(d)) {
      missing.push(d);
      if (path.dirname(d) === d) break;
    }
    fs.mkdirSync(loc.dir, { recursive: true });
    record.createdDirs = missing; // deepest first
    fs.writeFileSync(loc.file, mergeHdrKeys(''), 'utf8');
    record.created = true;
  }
  fs.chmodSync(loc.file, 0o444);
  return record;
}

// Reverse what applyEngineIniHdr recorded. Returns { restored, deleted, stripped, removedDirs }.
function revertEngineIniHdr(record) {
  const out = { restored: false, deleted: false, stripped: false, removedDirs: [] };
  if (!record || record.skipped || !record.file) return out;
  const file = record.file;
  if (fs.existsSync(file)) makeWritable(file);
  if (record.backup && fs.existsSync(record.backup)) {
    makeWritable(record.backup);
    fs.copyFileSync(record.backup, file);
    fs.rmSync(record.backup, { force: true });
    out.restored = true;
  } else if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (record.created && onlyOurKeys(text)) {
      fs.rmSync(file, { force: true });
      out.deleted = true;
    } else {
      const left = stripHdrKeys(text);
      if (left !== text) { fs.writeFileSync(file, left, 'utf8'); out.stripped = true; }
    }
  }
  for (const d of record.createdDirs || []) {
    try {
      if (fs.readdirSync(d).length === 0) { fs.rmdirSync(d); out.removedDirs.push(d); } else break;
    } catch { break; }
  }
  return out;
}

// RenoDX's own choice of path, when the player has set one: ReShade.ini [renodx] Set_Path. null when
// not set (the add-on's per-game default then applies).
function reshadeSetPath(gameDir) {
  let text;
  try { text = fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8'); } catch { return null; }
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (isHeader(line)) { inSection = headerName(line).toLowerCase() === 'renodx'; continue; }
    if (!inSection) continue;
    const m = /^\s*Set_Path\s*=\s*([0-9.]+)/i.exec(line);
    if (m) return Math.round(Number(m[1]));
  }
  return null;
}

// Whether UE-Extended will run the native-HDR path here: the player's Set_Path when set, else the
// add-on's default for this game (its table: nativeHdr).
function wantsNativeHdr(entry, gameDir) {
  const own = reshadeSetPath(gameDir);
  if (own !== null) return own === 0;
  return !!(entry && entry.nativeHdr);
}

module.exports = {
  HDR_KEYS, BACKUP_SUFFIX, SECTION,
  engineIniLocation, mergeHdrKeys, stripHdrKeys, onlyOurKeys, isReadOnly,
  applyEngineIniHdr, revertEngineIniHdr, reshadeSetPath, wantsNativeHdr,
};
