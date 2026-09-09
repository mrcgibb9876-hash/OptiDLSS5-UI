// Frame-generation DLL management for the OptiDLSS5-UI Manager.
//
// The Manager does not drive frame generation through OptiScaler -- that fights a game's own
// DLSS-G over the swapchain (the Cyberpunk crash; see the comment on autoConfigureGame in
// main.js). Its role here is narrower: manage the *version* of the DLL the game's own frame
// gen already loads, nvngx_dlssg.dll (the DLSS-Swapper model -- upgrade the component the
// game already uses, don't insert a new one).
//
// Redistributability: nvngx_dlssg.dll is in NVIDIA's public DLSS SDK and is fine to fetch/swap
// (RHI lists it). Only nvngx_dlssnr.dll (Neural Rendering) is driver-only and user-supplied.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

const FG_DLL_NAMES = ['nvngx_dlssg.dll'];
const FG_BACKUP_SUFFIX = '.dlss5ui-fgbackup';

// --- versions available (from RHI's manifest, the 'dlssg' list) --------------------

// getRhiManifest is main.js's shared fetch/cache/fallback fetcher for RHI's dlss_manifest.json
// (also used for the Streamline list) -- injected rather than required here to avoid a
// circular require (main.js requires this module). compareVersions is main.js's
// compareStreamlineVersions, equally generic for dotted DLL version strings.
async function getFrameGenReleases(getRhiManifest, compareVersions) {
  const manifest = await getRhiManifest();
  const list = Array.isArray(manifest && manifest.dlssg) ? manifest.dlssg : [];
  return list
    .filter((e) => e && typeof e.version === 'string' && typeof e.url === 'string' && e.url)
    .map((e) => ({ version: e.version, url: e.url }))
    .sort((a, b) => compareVersions(b.version, a.version)); // newest first
}

// --- identify what's in the folder ------------------------------------------------

function findGameFrameGenDll(dir) {
  for (const name of FG_DLL_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Read the DLL's FileVersion so the UI can show "game currently has 3.7.20" and so a swap
// decision is informed by what is actually there, not a guess.
async function readDllVersion(execFileAsync, dllPath) {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-Item -LiteralPath $env:OSM_DLL).VersionInfo.FileVersion'
    ], { env: { ...process.env, OSM_DLL: dllPath } });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// --- fetch a chosen version into a version-keyed cache dir --------------------------

// Mirrors ensureStreamlineSdkCache's on-disk shape in main.js (one directory per version
// under a cache root) so both DLL caches follow the same convention. The manifest's dlssg
// URLs may point at either a bare .dll or a .zip -- handle both rather than assuming one.
async function ensureFrameGenDllCache(release, { cacheRoot, execFileAsync, ghHeaders }) {
  if (!release) return null;
  const cacheDir = path.join(cacheRoot, release.version.replace(/[^0-9A-Za-z.]/g, '_'));
  const dllPath = path.join(cacheDir, 'nvngx_dlssg.dll');
  if (fs.existsSync(dllPath)) return dllPath;

  const res = await fetch(release.url, { headers: ghHeaders });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  await fsp.mkdir(cacheDir, { recursive: true });

  if (/\.zip(\?|$)/i.test(release.url)) {
    const tmpZip = path.join(os.tmpdir(), `dlssg-${Date.now()}.zip`);
    const tmpExtract = path.join(os.tmpdir(), `dlssg-extract-${Date.now()}`);
    try {
      await fsp.writeFile(tmpZip, buf);
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
      ], { env: { ...process.env, OSM_ZIP: tmpZip, OSM_DEST: tmpExtract } });

      let found = null;
      const stack = [tmpExtract];
      while (stack.length > 0 && !found) {
        const cur = stack.pop();
        for (const entry of await fsp.readdir(cur, { withFileTypes: true })) {
          const full = path.join(cur, entry.name);
          if (entry.isFile() && /^nvngx_dlssg\.dll$/i.test(entry.name)) { found = full; break; }
          if (entry.isDirectory()) stack.push(full);
        }
      }
      if (!found) throw new Error('nvngx_dlssg.dll not found in the downloaded archive');
      await fsp.copyFile(found, dllPath);
    } finally {
      await fsp.rm(tmpZip, { force: true }).catch(() => {});
      await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    await fsp.writeFile(dllPath, buf);
  }
  return dllPath;
}

// --- swap / restore, with backup (verify/undo) -------------------------------------

// Replace the game's frame-gen DLL with a chosen version, keeping the original so it can be
// put back. Never overwrites an existing backup -- a second swap must still be able to
// restore the true original, not the previous swap's target.
async function swapFrameGenDll(dir, sourceDll) {
  const target = findGameFrameGenDll(dir);
  if (!target) return { swapped: false, reason: "game has no nvngx_dlssg.dll to upgrade" };

  const backup = target + FG_BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    await fsp.copyFile(target, backup); // first swap: preserve the game's original
  }
  await fsp.copyFile(sourceDll, target);
  return { swapped: true, dll: path.basename(target), backedUp: backup };
}

// Put the game's original frame-gen DLL back and remove the backup.
async function restoreFrameGenDll(dir) {
  const target = findGameFrameGenDll(dir);
  if (!target) return { restored: false, reason: 'nothing to restore' };
  const backup = target + FG_BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { restored: false, reason: 'no backup on file' };
  await fsp.copyFile(backup, target);
  await fsp.rm(backup, { force: true });
  return { restored: true, dll: path.basename(target) };
}

// Is a Manager swap currently in place?
function frameGenSwapState(dir) {
  const target = findGameFrameGenDll(dir);
  if (!target) return { hasFrameGen: false };
  return {
    hasFrameGen: true,
    dll: path.basename(target),
    swapped: fs.existsSync(target + FG_BACKUP_SUFFIX)
  };
}

module.exports = {
  FG_DLL_NAMES,
  getFrameGenReleases,
  findGameFrameGenDll,
  readDllVersion,
  ensureFrameGenDllCache,
  swapFrameGenDll,
  restoreFrameGenDll,
  frameGenSwapState,
};
