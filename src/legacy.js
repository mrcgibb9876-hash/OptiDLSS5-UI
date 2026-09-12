// EXPERIMENTAL: 32-bit games and DirectX 8/9 games, through the DLSS5 Feeder's own documented paths
// (its README: "Install for a 32-bit game", "Install for a DirectX 9 game"), with OptiScaler_DLSSNR
// as the neural consumer the Feeder names ("Alternative: OptiScaler DLSS-NR"). Nothing here has run
// on a live game on the machine it was written on -- the card says Experimental for that reason.
//
// Two separate pieces, which a game may need one or both of:
//
//   dgVoodoo2   D3D8 and D3D9 have no Feeder path of their own. dgVoodoo2 (Dege's wrapper) turns them
//               into D3D11 inside the game: its D3D8.dll / D3D9.dll beside the exe, with dgVoodoo.conf
//               set so it actually engages (DisableAndPassThru=false), outputs D3D11, has enough
//               emulated VRAM, and shows no watermark. x86 build for a 32-bit game; a 64-bit D3D9 game
//               takes the x64 D3D9.dll and then the ordinary 64-bit Feeder route. There is no 64-bit
//               D3D8. Pinned to one release and checked by sha256, as DLSS5-Swapper does.
//
//   host32      NVIDIA ships no 32-bit NGX, so a 32-bit game cannot run DLSS in its own process. The
//               Feeder's 32-bit add-on (dlss5-feed.addon32) sends the frame to dlss5-feed-host64.exe,
//               a 64-bit helper it starts from a host64\ folder beside the game, and the DLSS work --
//               and OptiScaler_DLSSNR with it -- happens there. Layout, per the Feeder's README:
//                 beside the exe   32-bit ReShade (as dxgi.dll, or opengl32.dll for OpenGL) with the
//                                  add-on, DLSS5_Feed.fx, the motion-vector shaders, ReShade.ini/preset
//                 host64\          dlss5-feed-host64.exe, a 64-bit ReShade dxgi.dll, the OptiScaler
//                                  release with OptiScaler.dll renamed winmm.dll ([DlssNr] Enabled=true,
//                                  ScanExposure=false, Dx12Upscaler=dlss), nvngx_dlssnr.dll, nvngx_dlss.dll
//
// Everything placed is recorded in one marker (.dlss5ui-legacy.json), and removeLegacy() takes back
// exactly that and restores anything it had to set aside.
//
// Parts of the approach, the dgVoodoo pin and its configuration values are ported from DLSS5-Swapper
// (src/core/apply.js, runtime-components.js, feeder-config.js; MIT, Copyright (c) 2026 Rakan
// Alkhaldi -- third_party/DLSS5-Swapper-LICENSE.txt).
//
// A note on dgVoodoo2 and antivirus: on the machine this was written on, Windows Defender deleted the
// official dgVoodoo2 2.87.4 zip seconds after download ("Trojan:Win32/Kepavll!rfn", a reputation-based
// detection). This app never works around that. It asks before downloading dgVoodoo2 at all, says
// plainly when the file was removed, and lets the user supply a copy they trust instead.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { openZip, findEntry, extractEntry } = require('./zip');
const { setIniKey, getIniKey } = require('./ini-merge');

const MARKER = '.dlss5ui-legacy.json';
const HOST_DIR = 'host64';
const BACKUP_SUFFIX = '.dlss5ui-orig';

const DGVOODOO = {
  version: '2.87.4',
  url: 'https://github.com/dege-diosg/dgVoodoo2/releases/download/v2.87.4/dgVoodoo2_87_4.zip',
  sha256: '74aeb464d829db80e3f4aa8fae235e6e3b38fc01188776c5c2376bb0dea0956e',
  fileName: 'dgVoodoo2_87_4.zip',
  page: 'https://github.com/dege-diosg/dgVoodoo2/releases',
};

// Zip entry names: the Feeder's release uses backslashes (host64\dlss5-feed-host64.exe).
const sep = '[\\\\/]';
const ENTRY = {
  addon32: new RegExp(`(^|${sep})dlss5-feed\\.addon32$`, 'i'),
  host64: new RegExp(`(^|${sep})dlss5-feed-host64\\.exe$`, 'i'),
  feedFx: new RegExp(`(^|${sep})DLSS5_Feed\\.fx$`, 'i'),
  reshade32: /^ReShade32\.dll$/i,
  reshade64: /^ReShade64\.dll$/i,
};

// ---------------------------------------------------------------------------------------------
// What a game needs

// detected: the detection result (bitness, api). Returns the plan or { supported: false, reason }.
function planFor(detected) {
  const bitness = detected && detected.bitness;
  const api = detected && detected.api;
  if (bitness === 32) {
    if (api === 'vulkan') return { supported: false, reason: '32-bit Vulkan is not supported by this app yet' };
    if (!['dx8', 'dx9', 'dx10', 'dx11', 'dx12', 'opengl'].includes(api)) return { supported: false, reason: 'graphics API not detected' };
    return {
      supported: true,
      host32: true,
      api,
      dgVoodoo: api === 'dx8' ? { arch: 'x86', dll: 'D3D8.dll' } : api === 'dx9' ? { arch: 'x86', dll: 'D3D9.dll' } : null,
      reshadeName: api === 'opengl' ? 'opengl32.dll' : 'dxgi.dll',
    };
  }
  if (bitness === 64 && api === 'dx9') {
    return { supported: true, host32: false, api, dgVoodoo: { arch: 'x64', dll: 'D3D9.dll' }, reshadeName: null };
  }
  return { supported: false, reason: 'not a legacy game' };
}

// ---------------------------------------------------------------------------------------------
// Marker

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
}

function writeMarker(dir, marker) {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2), 'utf8');
}

function status(dir) {
  const marker = readMarker(dir);
  const host = path.join(dir, HOST_DIR);
  return {
    deployed: !!marker,
    host32: !!(marker && marker.host32),
    dgVoodoo: !!(marker && marker.dgVoodoo),
    hostOptiScaler: fs.existsSync(path.join(host, 'OptiScaler.ini')) && fs.existsSync(path.join(host, 'nvngx_dlssnr.dll')),
    feeder32: fs.existsSync(path.join(dir, 'dlss5-feed.addon32')) && fs.existsSync(path.join(host, 'dlss5-feed-host64.exe')),
    marker,
  };
}

// ---------------------------------------------------------------------------------------------
// dgVoodoo2

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isDgVoodooZip(zipPath) {
  try {
    const zip = openZip(zipPath);
    return !!(findEntry(zip, /^MS[\\/]x86[\\/]D3D9\.dll$/i) && findEntry(zip, /^dgVoodoo\.conf$/i) && findEntry(zip, /^dgVoodooCpl\.exe$/i));
  } catch {
    return false;
  }
}

// The pinned release, verified. Separate errors for "the download was bad" and "it was verified,
// written, and then gone" -- the second is antivirus quarantine, and retrying does not help.
async function ensureDgVoodooZip(cacheDir, { fetchImpl = fetch, headers = {} } = {}) {
  const dest = path.join(cacheDir, DGVOODOO.fileName);
  try {
    if (sha256(fs.readFileSync(dest)) === DGVOODOO.sha256) return dest;
  } catch {}
  const res = await fetchImpl(DGVOODOO.url, { headers });
  if (!res.ok) throw Object.assign(new Error(`dgVoodoo2 download failed: HTTP ${res.status}`), { code: 'dgvoodoo-network' });
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== DGVOODOO.sha256) {
    throw Object.assign(new Error(`dgVoodoo2 download did not match its checksum (expected ${DGVOODOO.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`), { code: 'dgvoodoo-checksum' });
  }
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(dest, buf);
  await quarantineCheck(dest, DGVOODOO.sha256);
  return dest;
}

// A security tool removes or locks the file a moment after it is written.
async function quarantineCheck(file, expected) {
  const wait = Number(process.env.LEGACY_QUARANTINE_WAIT_MS ?? 1500);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  let ok = false;
  try { ok = sha256(fs.readFileSync(file)) === expected; } catch { ok = false; }
  if (!ok) {
    throw Object.assign(new Error(
      'dgVoodoo2 was downloaded and verified, then removed or blocked on this PC -- that is what antivirus ' +
      'quarantine looks like (Windows Defender reports the official dgVoodoo2 zip as "Trojan:Win32/Kepavll!rfn", a ' +
      'reputation-based detection). This app will not work around your antivirus. Check Windows Security\'s ' +
      'protection history and decide for yourself, or use "Use a dgVoodoo2 zip I have".'), { code: 'dgvoodoo-quarantined' });
  }
}

// A dgVoodoo2 zip the user picked: must be dgVoodoo's layout. Not held to the pinned hash -- it may
// be another version they trust -- but copied into the cache under its own name.
async function importDgVoodooZip(sourcePath, cacheDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('the picked file does not exist');
  if (!isDgVoodooZip(sourcePath)) throw new Error(`${path.basename(sourcePath)} is not a dgVoodoo2 release zip (no MS\\x86\\D3D9.dll, dgVoodoo.conf and dgVoodooCpl.exe)`);
  await fsp.mkdir(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, 'dgVoodoo2-user.zip');
  const buf = fs.readFileSync(sourcePath);
  await fsp.writeFile(dest, buf);
  await quarantineCheck(dest, sha256(buf));
  return dest;
}

function cachedDgVoodooZip(cacheDir) {
  for (const name of [DGVOODOO.fileName, 'dgVoodoo2-user.zip']) {
    const p = path.join(cacheDir, name);
    if (fs.existsSync(p) && isDgVoodooZip(p)) return p;
  }
  return null;
}

// dgVoodoo.conf as the Feeder's README and DLSS5-Swapper set it. VRAM: dgVoodoo enforces its emulated
// 256 MB, and a DirectX 9 game at a modern resolution runs out in seconds (DLSS5-Swapper measured SWTOR
// failing at 1024 MB); the number is a ceiling, not an allocation.
function configureDgVoodoo(text) {
  let out = String(text || '');
  out = setIniKey(out, 'General', 'OutputAPI', 'd3d11_fl11_0');
  out = setIniKey(out, 'General', 'CaptureMouse', 'false');
  out = setIniKey(out, 'DirectX', 'DisableAndPassThru', 'false');
  out = setIniKey(out, 'DirectX', 'VideoCard', 'internal3D');
  out = setIniKey(out, 'DirectX', 'VRAM', '4096');
  out = setIniKey(out, 'DirectX', 'dgVoodooWatermark', 'false');
  return out;
}

// LEGACY_QUARANTINE_WAIT_MS lets tests skip the pause a real security scanner needs.
async function stillThere(file) {
  const wait = Number(process.env.LEGACY_QUARANTINE_WAIT_MS ?? 1500);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try { fs.accessSync(file, fs.constants.R_OK); fs.readFileSync(file).subarray(0, 2); return true; } catch { return false; }
}

function fileMentions(file, text) {
  try { return fs.readFileSync(file).includes(Buffer.from(text, 'latin1')); } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Placing files, recorded

function recorder(dir, marker) {
  const rel = (p) => path.relative(dir, p).split(path.sep).join('/');
  return {
    // Before writing dest: a file of someone else's under that name is kept aside for Remove.
    async claim(dest, { ours = () => false } = {}) {
      const r = rel(dest);
      if (marker.files.includes(r) || marker.backups.some((b) => b.rel === r)) return;
      if (fs.existsSync(dest) && !ours(dest)) {
        const backup = dest + BACKUP_SUFFIX;
        if (!fs.existsSync(backup)) await fsp.rename(dest, backup);
        marker.backups.push({ rel: r, backup: rel(backup) });
      } else {
        marker.files.push(r);
      }
    },
    async write(dest, buf, opts) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await this.claim(dest, opts);
      await fsp.writeFile(dest, buf);
    },
    async copy(src, dest, opts) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await this.claim(dest, opts);
      await fsp.copyFile(src, dest);
    },
  };
}

function emptyMarker(existing) {
  return existing && Array.isArray(existing.files)
    ? { ...existing, backups: existing.backups || [] }
    : { version: 1, files: [], backups: [], dirs: [] };
}

async function deployDgVoodoo(dir, plan, zipPath) {
  if (!plan || !plan.dgVoodoo) throw new Error('this game does not need dgVoodoo2');
  const marker = emptyMarker(readMarker(dir));
  const rec = recorder(dir, marker);
  const zip = openZip(zipPath);
  const dllEntry = findEntry(zip, new RegExp(`^MS[\\\\/]${plan.dgVoodoo.arch}[\\\\/]${plan.dgVoodoo.dll.replace('.', '\\.')}$`, 'i'));
  const confEntry = findEntry(zip, /^dgVoodoo\.conf$/i);
  const cplEntry = findEntry(zip, /^dgVoodooCpl\.exe$/i);
  if (!dllEntry || !confEntry || !cplEntry) throw new Error(`the dgVoodoo2 zip has no MS\\${plan.dgVoodoo.arch}\\${plan.dgVoodoo.dll}`);
  const isDg = (p) => fileMentions(p, 'dgVoodoo');
  await rec.write(path.join(dir, plan.dgVoodoo.dll), extractEntry(zip, dllEntry), { ours: isDg });
  await rec.write(path.join(dir, 'dgVoodooCpl.exe'), extractEntry(zip, cplEntry), { ours: isDg });
  const confPath = path.join(dir, 'dgVoodoo.conf');
  const base = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : extractEntry(zip, confEntry).toString('utf8');
  await rec.write(confPath, Buffer.from(configureDgVoodoo(base), 'utf8'), { ours: () => true });
  marker.dgVoodoo = { arch: plan.dgVoodoo.arch, dll: plan.dgVoodoo.dll, zip: path.basename(zipPath) };
  marker.placedAt = new Date().toISOString();
  writeMarker(dir, marker);
  // Antivirus can take the wrapper out of the game folder just as it can out of the cache.
  if (!(await stillThere(path.join(dir, plan.dgVoodoo.dll)))) {
    throw Object.assign(new Error(
      `${plan.dgVoodoo.dll} (dgVoodoo2) was placed beside the game and then removed or blocked -- that is what antivirus ` +
      'quarantine looks like. This app will not work around your antivirus; check Windows Security\'s protection history.'), { code: 'dgvoodoo-quarantined' });
  }
  return { deployed: true, dll: plan.dgVoodoo.dll, arch: plan.dgVoodoo.arch };
}

// deps (all required):
//   feederZip      path to the Feeder release zip (addon32, host64 exe, DLSS5_Feed.fx)
//   reshadeSetup   path to ReShade's add-on setup exe (a zip with ReShade32.dll and ReShade64.dll)
//   releaseFolder  the OptiScaler_DLSSNR release folder
//   nrDllPath      nvngx_dlssnr.dll
//   deployShaders(dir)          headers, motion-vector provider, ReShade.ini and preset beside the exe
//   deployNvngxDlss(hostDir)    nvngx_dlss.dll into the helper folder
async function deployHost32(dir, plan, deps) {
  if (!plan || !plan.host32) throw new Error('this game does not take the 32-bit helper route');
  for (const k of ['feederZip', 'reshadeSetup', 'releaseFolder', 'nrDllPath']) {
    if (!deps[k] || !fs.existsSync(deps[k])) throw new Error(`missing ${k}: ${deps[k] || '(not set)'}`);
  }
  const hostDir = path.join(dir, HOST_DIR);
  const existing = readMarker(dir);
  if (fs.existsSync(hostDir) && !(existing && existing.host32)) {
    throw new Error(`${HOST_DIR}\\ already exists beside the game and was not made by this app -- another Feeder install? Remove it first.`);
  }
  const marker = emptyMarker(existing);
  const rec = recorder(dir, marker);
  if (!marker.dirs.includes(HOST_DIR)) marker.dirs.push(HOST_DIR);

  const feederZip = openZip(deps.feederZip);
  const reshadeZip = openZip(deps.reshadeSetup);
  const need = (zip, re, what) => {
    const e = findEntry(zip, re);
    if (!e) throw new Error(`${what} not found in ${path.basename(zip === feederZip ? deps.feederZip : deps.reshadeSetup)}`);
    return extractEntry(zip, e);
  };
  const isReShade = (p) => fileMentions(p, 'ReShade');

  // Beside the 32-bit game.
  await rec.write(path.join(dir, plan.reshadeName), need(reshadeZip, ENTRY.reshade32, 'ReShade32.dll'), { ours: isReShade });
  await rec.write(path.join(dir, 'dlss5-feed.addon32'), need(feederZip, ENTRY.addon32, 'dlss5-feed.addon32'), { ours: () => true });
  await rec.write(path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'), need(feederZip, ENTRY.feedFx, 'DLSS5_Feed.fx'), { ours: () => true });
  if (!marker.dirs.includes('reshade-shaders')) marker.dirs.push('reshade-shaders');
  for (const f of ['ReShade.ini', 'ReShadePreset.ini']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) marker.files.includes(f) || marker.files.push(f);
  }
  const shaderFiles = (await deps.deployShaders(dir)) || [];
  for (const f of shaderFiles) if (!marker.files.includes(f)) marker.files.push(f);

  // The 64-bit helper.
  await fsp.mkdir(hostDir, { recursive: true });
  await rec.write(path.join(hostDir, 'dlss5-feed-host64.exe'), need(feederZip, ENTRY.host64, 'dlss5-feed-host64.exe'), { ours: () => true });
  await rec.write(path.join(hostDir, 'dxgi.dll'), need(reshadeZip, ENTRY.reshade64, 'ReShade64.dll'), { ours: () => true });
  let hostIni = fs.existsSync(path.join(hostDir, 'ReShade.ini')) ? fs.readFileSync(path.join(hostDir, 'ReShade.ini'), 'utf8') : '';
  hostIni = setIniKey(hostIni, 'ADDON', 'AddonPath', '.\\');
  if (!getIniKey(hostIni, 'OVERLAY', 'TutorialProgress')) hostIni = setIniKey(hostIni, 'OVERLAY', 'TutorialProgress', '4');
  await rec.write(path.join(hostDir, 'ReShade.ini'), Buffer.from(hostIni, 'utf8'), { ours: () => true });

  // OptiScaler_DLSSNR, the release as it ships, with OptiScaler.dll as winmm.dll (the helper imports it).
  for (const entry of await fsp.readdir(deps.releaseFolder, { withFileTypes: true })) {
    const src = path.join(deps.releaseFolder, entry.name);
    if (/^setup_(windows\.bat|linux\.sh)$/i.test(entry.name)) continue;
    const destName = /^OptiScaler\.dll$/i.test(entry.name) ? 'winmm.dll' : entry.name;
    const dest = path.join(hostDir, destName);
    if (entry.isDirectory()) {
      await fsp.cp(src, dest, { recursive: true, force: true });
    } else {
      await rec.copy(src, dest, { ours: () => true });
    }
  }
  const optiIni = path.join(hostDir, 'OptiScaler.ini');
  if (fs.existsSync(optiIni)) {
    let ini = fs.readFileSync(optiIni, 'utf8');
    for (const [section, key, value] of [
      ['DlssNr', 'Enabled', 'true'],
      ['DlssNr', 'ScanExposure', 'false'],
      ['Upscalers', 'Dx12Upscaler', 'dlss'],
      ['Plugins', 'LoadReshade', 'false'],
      ['Log', 'LogToFile', 'true'],
      ['Log', 'LogLevel', '2'],
    ]) ini = setIniKey(ini, section, key, value);
    fs.writeFileSync(optiIni, ini, 'utf8');
  }
  await rec.copy(deps.nrDllPath, path.join(hostDir, 'nvngx_dlssnr.dll'), { ours: () => true });
  if (deps.deployNvngxDlss) {
    const had = fs.existsSync(path.join(hostDir, 'nvngx_dlss.dll'));
    await deps.deployNvngxDlss(hostDir);
    if (!had && fs.existsSync(path.join(hostDir, 'nvngx_dlss.dll'))) marker.files.push(`${HOST_DIR}/nvngx_dlss.dll`);
  }

  marker.host32 = { api: plan.api, reshadeName: plan.reshadeName };
  marker.placedAt = new Date().toISOString();
  writeMarker(dir, marker);
  return { deployed: true, hostDir, reshadeName: plan.reshadeName };
}

// ---------------------------------------------------------------------------------------------
// Removing

function removalPlan(dir) {
  const marker = readMarker(dir);
  if (!marker) return { remove: [], restore: [] };
  const remove = [...(marker.files || [])].filter((rel) => fs.existsSync(path.join(dir, ...rel.split('/'))));
  for (const d of marker.dirs || []) if (d === HOST_DIR && fs.existsSync(path.join(dir, d))) remove.push(`${d}/`);
  const restore = (marker.backups || []).filter((b) => fs.existsSync(path.join(dir, ...b.backup.split('/')))).map((b) => b.rel);
  return { remove, restore };
}

async function removeLegacy(dir) {
  const marker = readMarker(dir);
  const removed = [];
  const restored = [];
  if (!marker) return { removed, restored };
  for (const rel of marker.files || []) {
    const p = path.join(dir, ...rel.split('/'));
    if (fs.existsSync(p)) { await fsp.rm(p, { force: true }); removed.push(rel); }
  }
  for (const b of marker.backups || []) {
    const cur = path.join(dir, ...b.rel.split('/'));
    const bak = path.join(dir, ...b.backup.split('/'));
    if (!fs.existsSync(bak)) continue;
    await fsp.rm(cur, { force: true });
    await fsp.rename(bak, cur);
    restored.push(b.rel);
  }
  // The helper folder is entirely ours (deployHost32 refuses to use one it did not create).
  if ((marker.dirs || []).includes(HOST_DIR) && fs.existsSync(path.join(dir, HOST_DIR))) {
    await fsp.rm(path.join(dir, HOST_DIR), { recursive: true, force: true });
    removed.push(`${HOST_DIR}/`);
  }
  for (const rel of ['dlss5-feed.cfg', 'dlss5-feed.log', 'ReShade.log', 'dgVoodoo.log']) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { await fsp.rm(p, { force: true }); removed.push(rel); }
  }
  for (const rel of [path.join('reshade-shaders', 'Shaders', 'include'), path.join('reshade-shaders', 'Shaders'), 'reshade-shaders']) {
    const p = path.join(dir, rel);
    try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch {}
  }
  await fsp.rm(path.join(dir, MARKER), { force: true });
  return { removed, restored };
}

module.exports = {
  MARKER, HOST_DIR, DGVOODOO, planFor, status, readMarker, ensureDgVoodooZip, importDgVoodooZip, cachedDgVoodooZip,
  isDgVoodooZip, configureDgVoodoo, deployDgVoodoo, deployHost32, removalPlan, removeLegacy,
};
