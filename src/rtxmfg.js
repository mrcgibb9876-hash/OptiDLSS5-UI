// Universal RTXMFG (dashdogy/RTX40MFG-Unlock, MIT): DLSS Multi Frame Generation -- 3x, 4x, up to 6x
// and Dynamic -- on RTX 40 cards, experimentally on RTX 30, in games that already ship NVIDIA's
// Streamline DLSS Frame Generation. Asked for by a user on 2026-09-15.
//
// What it is, from its own README (v1.3.3): one DLL, RTXMFG.dll, with its menu built in (Backspace).
// It does nothing under its own name -- it has to be renamed to a DLL the game loads early (version.dll,
// winhttp.dll, dsound.dll, dinput8.dll, ...) and placed beside the real game exe. It keeps its
// settings in RTXMFG-Universal.json beside itself. RTX 50 cards have MFG natively and do not need it.
//
// How it fits this app:
//   - Fetched from the project's latest GitHub release, never bundled. The zip and the DLL are both
//     checked against the release's SHA256SUMS.txt before anything reaches a game folder.
//   - The name it takes is chosen from the names the game folder does NOT already hold; an occupied
//     name is never overwritten, whoever owns it (OptiScaler as dxgi.dll/winmm.dll, REFramework as
//     dinput8.dll, the game's own DLLs).
//   - A marker beside the exe records the name and the hash. That marker is what lets every other check
//     in this app recognise the file as ours: RTXMFG.dll carries the string "ReShade", and in a proxy
//     slot detect.js would otherwise report it as somebody's ReShade. (The same trap -- our own file
//     read as a rival's -- has bitten this app twice before; see native-dlss.js's host64 note.)
//   - Remove takes the DLL only while it is still the copy this app placed.
'use strict';
const { netFetch } = require('./net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openZip, findEntry, extractEntry } = require('./zip');

const REPO = 'dashdogy/RTX40MFG-Unlock';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
const PROJECT_PAGE = `https://github.com/${REPO}`;
const MARKER = '.dlss5ui-rtxmfg.json';
const SETTINGS_FILE = 'RTXMFG-Universal.json';
const DLL_NAME = 'RTXMFG.dll';

// Names from its README's supported list, in the order this app offers them. version.dll first: it is
// loaded at start-up by nearly every game and is not a name OptiScaler takes on a native-DLSS game
// (dxgi.dll there, winmm.dll on Monster Hunter: World). d3d11/d3d12/dxgi/winmm are left out on purpose:
// they are where OptiScaler and ReShade live, and a second proxy chain there is a fight nobody wins.
const PROXY_NAMES = ['version.dll', 'winhttp.dll', 'dsound.dll', 'dinput8.dll', 'wininet.dll', 'xinput1_3.dll', 'xinput1_4.dll', 'xinput9_1_0.dll'];

// "NVIDIA GeForce RTX 4070 Laptop GPU" -> 40. Null for anything that is not a GeForce RTX 20/30/40/50.
function gpuSeries(name) {
  const m = /\bRTX\s*([2-9])0[5-9]0\b/i.exec(String(name || ''));
  return m ? Number(m[1]) * 10 : null;
}

// What the unlock means on this machine: 'supported' (RTX 40), 'experimental' (RTX 30, DX12 only),
// 'native' (RTX 50 already has MFG), 'unsupported' (anything else, or not NVIDIA).
function gpuSupport(gpu) {
  if (!gpu || gpu.vendor !== 'nvidia') return { status: 'unsupported', series: null };
  const series = gpuSeries(gpu.name);
  if (series === 40) return { status: 'supported', series };
  if (series === 30) return { status: 'experimental', series };
  if (series === 50) return { status: 'native', series };
  return { status: 'unsupported', series };
}

// "<hex>  name" per line -> { name(lower): hex(lower) }.
function parseSums(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) out[m[2].toLowerCase()] = m[1].toLowerCase();
  }
  return out;
}

function pickAssets(release) {
  const assets = (release && release.assets) || [];
  return {
    zip: assets.find((a) => /^RTXMFG.*\.zip$/i.test(a.name || '')) || null,
    sums: assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name || '')) || null,
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The latest release's RTXMFG.dll in cacheRoot/<tag>/, verified. Returns { ok, tag, dllPath, sha256 }
// or { ok: false, error }. A cached copy whose hash still matches the release is used as is.
async function ensureCache({ cacheRoot, fetchImpl = netFetch, headers = {} }) {
  try {
    const res = await fetchImpl(RELEASES_API, { headers });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${REPO}'s latest release`);
    const release = await res.json();
    const tag = String(release.tag_name || '').replace(/[^\w.-]/g, '') || 'latest';
    const { zip, sums } = pickAssets(release);
    if (!zip) throw new Error(`${REPO} ${tag} has no RTXMFG zip`);
    if (!sums) throw new Error(`${REPO} ${tag} publishes no SHA256SUMS.txt -- not installing an unverified DLL`);

    const sumsRes = await fetchImpl(sums.browser_download_url, { headers });
    if (!sumsRes.ok) throw new Error(`could not fetch SHA256SUMS.txt (${sumsRes.status})`);
    const table = parseSums(await sumsRes.text());
    const wantDll = table[DLL_NAME.toLowerCase()] || null;
    const wantZip = table[String(zip.name).toLowerCase()] || null;
    if (!wantDll && !wantZip) throw new Error('SHA256SUMS.txt lists neither the zip nor RTXMFG.dll');

    const dir = path.join(cacheRoot, tag);
    const dllPath = path.join(dir, DLL_NAME);
    if (wantDll && fs.existsSync(dllPath) && sha256(fs.readFileSync(dllPath)) === wantDll) {
      return { ok: true, tag, dllPath, sha256: wantDll };
    }

    const zipRes = await fetchImpl(zip.browser_download_url, { headers });
    if (!zipRes.ok) throw new Error(`could not download ${zip.name} (${zipRes.status})`);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    if (wantZip && sha256(zipBuf) !== wantZip) throw new Error(`${zip.name} does not match its sha256 in SHA256SUMS.txt`);
    const archive = openZip(zipBuf);
    const entry = findEntry(archive, /(^|\/)RTXMFG\.dll$/i);
    if (!entry) throw new Error(`${zip.name} holds no RTXMFG.dll`);
    const dll = extractEntry(archive, entry);
    const got = sha256(dll);
    if (wantDll && got !== wantDll) throw new Error('RTXMFG.dll does not match its sha256 in SHA256SUMS.txt');
    if (dll.length < 2 || dll[0] !== 0x4d || dll[1] !== 0x5a) throw new Error('RTXMFG.dll is not a Windows DLL');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dllPath, dll);
    return { ok: true, tag, dllPath, sha256: got };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return m && typeof m.file === 'string' ? m : null;
  } catch {
    return null;
  }
}

// The file name this app placed RTXMFG under, while that file is still there -- or null. Cheap (no
// hashing): it is asked by detection and the route on every card render.
function ourFile(dir) {
  const m = readMarker(dir);
  return m && fs.existsSync(path.join(dir, m.file)) ? m.file : null;
}

// Still the exact copy placed (hash match), so Remove may take it.
function isOurCopy(dir, marker = readMarker(dir)) {
  if (!marker || !marker.sha256) return false;
  try { return sha256(fs.readFileSync(path.join(dir, marker.file))) === marker.sha256; } catch { return false; }
}

// Which of PROXY_NAMES are taken in this folder (by anything other than our own copy), and the first
// free one.
function proxyChoice(dir) {
  const ours = ourFile(dir);
  const occupied = PROXY_NAMES.filter((n) => n !== ours && fs.existsSync(path.join(dir, n)));
  const free = PROXY_NAMES.filter((n) => !occupied.includes(n));
  return { names: PROXY_NAMES, occupied, free, suggested: ours || free[0] || null };
}

// Places the cached DLL as proxyName beside the exe. Never overwrites a file this app did not place;
// moving to a different name removes our old copy first.
function deploy(dir, { dllPath, sha256: hash, tag, proxyName }) {
  const name = String(proxyName || '').toLowerCase();
  if (!PROXY_NAMES.includes(name)) throw new Error(`${proxyName} is not a name RTXMFG can load as`);
  const prev = readMarker(dir);
  const target = path.join(dir, name);
  const targetIsOurs = prev && prev.file.toLowerCase() === name && isOurCopy(dir, prev);
  if (fs.existsSync(target) && !targetIsOurs) {
    throw new Error(`${name} already exists in this folder and is not this app's copy -- pick another name`);
  }
  if (prev && prev.file.toLowerCase() !== name && isOurCopy(dir, prev)) {
    fs.rmSync(path.join(dir, prev.file), { force: true });
  }
  fs.copyFileSync(dllPath, target);
  const marker = { file: name, tag: tag || null, sha256: hash || sha256(fs.readFileSync(target)), placedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2), 'utf8');
  return marker;
}

// Takes the DLL (only if it is still our copy), its marker, and -- unless keepSettings -- the
// settings file its menu wrote. Returns { removed, kept }.
function remove(dir, { keepSettings = false } = {}) {
  const removed = [];
  const kept = [];
  const marker = readMarker(dir);
  if (marker && fs.existsSync(path.join(dir, marker.file))) {
    if (isOurCopy(dir, marker)) {
      fs.rmSync(path.join(dir, marker.file), { force: true });
      removed.push(marker.file);
    } else {
      kept.push(`${marker.file} (changed since this app placed RTXMFG there -- left alone)`);
    }
  }
  if (marker) {
    fs.rmSync(path.join(dir, MARKER), { force: true });
    removed.push(MARKER);
    if (!keepSettings && fs.existsSync(path.join(dir, SETTINGS_FILE))) {
      fs.rmSync(path.join(dir, SETTINGS_FILE), { force: true });
      removed.push(SETTINGS_FILE);
    }
  }
  return { removed, kept };
}

// Read-only mirror of remove() for the Remove preview.
function removalPlan(dir) {
  const marker = readMarker(dir);
  if (!marker) return [];
  const out = [MARKER];
  if (isOurCopy(dir, marker)) out.push(marker.file);
  if (fs.existsSync(path.join(dir, SETTINGS_FILE))) out.push(SETTINGS_FILE);
  return out;
}

module.exports = {
  REPO, RELEASES_API, RELEASE_PAGE, PROJECT_PAGE, MARKER, SETTINGS_FILE, DLL_NAME, PROXY_NAMES,
  gpuSeries, gpuSupport, parseSums, pickAssets, ensureCache, readMarker, ourFile, isOurCopy, proxyChoice,
  deploy, remove, removalPlan,
};
