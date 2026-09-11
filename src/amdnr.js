// DLSS 5 Neural Rendering on AMD -- danielblnc/DLSS-NR-on-AMD -- for RX 7000/9000 users.
//
// OptiScaler_DLSSNR's Neural Rendering pass calls into NVIDIA's NGX runtime, which only exists
// with an NVIDIA driver, so nothing in this app's NVIDIA stack (OptiScaler, the Feeder, Luma)
// produces Neural Rendering on an AMD card. This tool is a ground-up reimplementation of the NR
// runtime for RDNA3/RDNA4 (HIP kernels, its own game integration) that hooks the game's own
// FSR 3/4 through the FidelityFX API and runs NVIDIA's model file on top. So on AMD it is not
// an add-on to our stack, it REPLACES it: the game runs FSR, the tool's proxy DLL sits beside the
// exe, and the user's own nvngx_dlssnr.dll goes next to it.
//
// PHASE 1 -- what this module does today, and deliberately not more:
//   - says whether this machine/game can use it at all (AMD vendor, DX12 game);
//   - detects an install in the game folder (its setup exe and its log file, the only two file
//     names its README documents -- the proxy DLL's name is not published and 0.2.16 made it
//     overridable, so it is not something to guess at);
//   - fetches the model file the tool asks for -- the UNMODIFIED 310.8.0 build -- into the game
//     folder. Note this is a different build from what the NVIDIA path deploys: fetchNrModel in
//     main.js takes the newest entry in RHI's manifest, which is "310.8.SF-v2", ShortFuse's
//     modified NR DLL that adds RTX 20/30/40 support (reports as 310.8.1). Right default for
//     NVIDIA, not what this tool documents; the README says 310.8.0.0 explicitly;
//   - checks the tool's latest GitHub release so the UI can say an update exists;
//   - opens its release page, and runs its installer in a console if it is already in the folder.
//
// NOT done, on purpose: downloading dlssnr_on_amd_setup.exe. Its licence (clause 2) forbids
// bundling the software with "another mod, tool, launcher, installer, package, or download" and
// says to link to the release page instead. A live fetch from the official release after a
// per-action consent dialog is the posture this app already takes for Luma and LumeniteFX and
// hosts nothing -- but this wording is aimed squarely at launchers, so the author is being asked
// first (see the issue text in the PR that added this). The installer is also interactive (U to
// update, R to remove, no documented silent switch), which is the other half of the same ask.
// Until both are answered, the user downloads and runs it; this app does everything around that.
//
// The tool is alpha (daily releases, open crash reports on several games) and needs Windows 11,
// Adrenalin 26.1.1+, a DX12 game running FSR, and no anti-cheat. Surfaced in the reason text
// rather than hidden behind a working-looking control.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { openZip, findEntry, extractEntryTo } = require('./zip');
const feeder = require('./feeder');

const AMDNR_REPO = 'danielblnc/DLSS-NR-on-AMD';
const AMDNR_RELEASES_API = `https://api.github.com/repos/${AMDNR_REPO}/releases/latest`;
const AMDNR_RELEASE_PAGE = `https://github.com/${AMDNR_REPO}/releases/latest`;
const AMDNR_SETUP_EXE = 'dlssnr_on_amd_setup.exe';
const AMDNR_LOG = 'dlssnr_on_amd.log';
// What the tool's README asks for, verbatim: "nvngx_dlssnr.dll version 310.8.0.0". RHI's
// manifest lists this build as "310.8.0".
const AMDNR_NR_MODEL_VERSION = '310.8.0';
const AMDNR_MIN_DRIVER = '26.1.1';
const AMDNR_SUMMARY = 'DLSS 5 Neural Rendering on AMD (danielblnc, alpha). Runs NVIDIA\'s NR model on RX 7000/9000 ' +
  'cards by hooking the game\'s own FSR 3/4 -- the game must run FSR. Needs Windows 11, Adrenalin ' +
  `${AMDNR_MIN_DRIVER} or newer, a DX12 game, and no anti-cheat. Roughly 33 fps at 1080p on a 9070 XT ` +
  'as of its README, improving release to release.';
const AMDNR_LICENSE_NOTE = 'Personal, non-commercial use only; the author\'s licence forbids redistributing or ' +
  'bundling it, so this app never downloads it for you -- get it from the official release page yourself.';

// The tool is AMD-only by construction (HIP kernels), and DX12-only until its planned Vulkan
// release. Intel gets the same "no NR here" answer for a different reason.
function amdNrEligibility(gpuVendor, api) {
  if (gpuVendor !== 'amd') {
    return { supported: false, reason: 'DLSS NR on AMD is for AMD Radeon RX 7000/9000 cards only.' };
  }
  if (api !== 'dx12') {
    return { supported: false, reason: `DLSS NR on AMD is DX12-only for now (Vulkan is planned upstream) -- this game is ${api || 'not yet detected'}.` };
  }
  return { supported: true };
}

function amdNrStatus(dir) {
  const setupPresent = fs.existsSync(path.join(dir, AMDNR_SETUP_EXE));
  const logPresent = fs.existsSync(path.join(dir, AMDNR_LOG));
  const nrDllPresent = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));
  return {
    setupPresent,
    logPresent,
    nrDllPresent,
    // Its installer has run here if it left its log; the setup exe alone means "placed, not run".
    toolPresent: logPresent || setupPresent,
    toolVersionHint: logPresent ? versionHintFromLog(path.join(dir, AMDNR_LOG)) : null,
    setupExe: AMDNR_SETUP_EXE,
    releasePage: AMDNR_RELEASE_PAGE,
    wantedNrModel: AMDNR_NR_MODEL_VERSION,
    summary: AMDNR_SUMMARY,
    licenseNote: AMDNR_LICENSE_NOTE,
  };
}

// Best effort: the log's format is not documented, but a version tag near the top is the
// common shape. A miss just means the UI cannot name the installed version.
function versionHintFromLog(logPath) {
  try {
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /\bv?(0\.\d+\.\d+)\b/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? `v${m[1]}` : null;
  } catch {
    return null;
  }
}

async function latestRelease(ghHeaders) {
  const res = await fetch(AMDNR_RELEASES_API, { headers: ghHeaders });
  if (!res.ok) throw new Error(`Could not check DLSS-NR-on-AMD's latest release: HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) => a.name.toLowerCase() === AMDNR_SETUP_EXE);
  return {
    tag: release.tag_name,
    name: release.name || release.tag_name,
    publishedAt: release.published_at,
    pageUrl: release.html_url || AMDNR_RELEASE_PAGE,
    assetName: asset ? asset.name : null,
    assetSize: asset ? asset.size : null,
    notes: (release.body || '').slice(0, 2000),
  };
}

// The plain 310.8.0 model build from RHI's manifest -- the exact entry, not the newest one.
// Cached under its own name so it never collides with the NVIDIA path's cache of the SF build.
async function ensureAmdNrModelCache({ getRhiManifest, cacheDir, ghHeaders }) {
  const dest = path.join(cacheDir, `nvngx_dlssnr_${AMDNR_NR_MODEL_VERSION}.dll`);
  if (fs.existsSync(dest)) return dest;

  const manifest = await getRhiManifest();
  const list = Array.isArray(manifest && manifest.dlssnr) ? manifest.dlssnr : [];
  const entry = list.find((e) => e && String(e.version) === AMDNR_NR_MODEL_VERSION);
  if (!entry || !entry.url) {
    throw new Error(`RHI's manifest has no plain ${AMDNR_NR_MODEL_VERSION} DLSS NR build (offline, or the entry was removed)`);
  }

  let zipPath = null;
  try {
    zipPath = await feeder.downloadToCache(entry.url, cacheDir, `nvngx_dlssnr_${AMDNR_NR_MODEL_VERSION}.zip`, ghHeaders);
    const zip = openZip(zipPath);
    const zipEntry = findEntry(zip, /(^|\/)nvngx_dlssnr\.dll$/i);
    if (!zipEntry) throw new Error('nvngx_dlssnr.dll not found inside the RHI package');
    extractEntryTo(zip, zipEntry, `${dest}.part`);
    await fsp.rename(`${dest}.part`, dest);
    const sizeMB = Math.round(fs.statSync(dest).size / 1024 / 1024);
    if (sizeMB < 50) {
      await fsp.rm(dest, { force: true });
      throw new Error(`The downloaded file is only ${sizeMB} MB -- not the real ~165 MB model`);
    }
    return dest;
  } finally {
    // Success or failure, the zip goes: downloadToCache would hand a bad one back on every retry.
    if (zipPath) fsp.rm(zipPath, { force: true }).catch(() => {});
  }
}

// Places the model file beside the exe. A copy already there is left alone unless the caller
// says replace -- a game that ships its own (Cyberpunk does) or a user's hand-placed build is
// theirs; when replacing, the old one is kept as .amdnr_backup so this is reversible.
async function deployAmdNrModel(dir, cachedDll, { replace = false } = {}) {
  const dest = path.join(dir, 'nvngx_dlssnr.dll');
  let backedUp = null;
  if (fs.existsSync(dest)) {
    if (!replace) return { deployed: false, reason: 'already present, not overwritten' };
    const backup = `${dest}.amdnr_backup`;
    if (!fs.existsSync(backup)) await fsp.rename(dest, backup);
    else await fsp.rm(dest, { force: true });
    backedUp = path.basename(backup);
  }
  await fsp.copyFile(cachedDll, dest);
  return { deployed: true, backedUp, version: AMDNR_NR_MODEL_VERSION };
}

module.exports = {
  AMDNR_REPO,
  AMDNR_RELEASE_PAGE,
  AMDNR_SETUP_EXE,
  AMDNR_LOG,
  AMDNR_NR_MODEL_VERSION,
  AMDNR_MIN_DRIVER,
  amdNrEligibility,
  amdNrStatus,
  latestRelease,
  ensureAmdNrModelCache,
  deployAmdNrModel,
};
