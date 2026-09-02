const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const execFileAsync = promisify(execFile);

const RELEASES_API = 'https://api.github.com/repos/mrcgibb9876-hash/OptiScaler_DLSSNR/releases/latest';
const GITHUB_HEADERS = { 'User-Agent': 'OptiScaler-Manager', Accept: 'application/vnd.github+json' };

const userDataDir = () => app.getPath('userData');
const gamesFile = () => path.join(userDataDir(), 'games.json');
const settingsFile = () => path.join(userDataDir(), 'settings.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- data ----------

ipcMain.handle('data:load', () => {
  const games = readJson(gamesFile(), []);
  const settings = readJson(settingsFile(), { releaseFolder: '', nrDllPath: '', installedVersion: '' });
  return { games, settings };
});

ipcMain.handle('data:save-games', (_evt, games) => {
  writeJson(gamesFile(), games);
  return true;
});

ipcMain.handle('data:save-settings', (_evt, settings) => {
  writeJson(settingsFile(), settings);
  return true;
});

// ---------- file/folder pickers ----------

ipcMain.handle('pick:exe', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Select game .exe',
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('pick:folder', async (_evt, title) => {
  const res = await dialog.showOpenDialog({
    title: title || 'Select folder',
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('pick:dll', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Select nvngx_dlssnr.dll (from an extracted NVIDIA driver package)',
    properties: ['openFile'],
    filters: [{ name: 'DLL', extensions: ['dll'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('pick:image', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Select banner image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// ---------- steam search ----------

ipcMain.handle('steam:search', async (_evt, term) => {
  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    // tiny_image is a real, currently-valid hash-versioned URL straight from the API response —
    // guessing fixed CDN paths like /apps/<id>/header.jpg 404s for many newer store listings.
    return (data.items || []).slice(0, 8).map((item) => ({
      appid: item.id,
      name: item.name,
      tinyImage: item.tiny_image || null
    }));
  } catch {
    return [];
  }
});

// ---------- release folder validation ----------

function findSetupBat(folder) {
  try {
    const entries = fs.readdirSync(folder);
    return entries.find((f) => f.toLowerCase() === 'setup_windows.bat') || null;
  } catch {
    return null;
  }
}

ipcMain.handle('release:validate', (_evt, folder) => {
  if (!folder) return { valid: false, reason: 'No folder set' };
  if (!fs.existsSync(folder)) return { valid: false, reason: 'Folder does not exist' };
  const bat = findSetupBat(folder);
  if (!bat) return { valid: false, reason: 'setup_windows.bat not found in this folder' };
  return { valid: true };
});

ipcMain.handle('nrdll:validate', (_evt, filePath) => {
  if (!filePath) return { valid: false, reason: 'No file set' };
  if (!fs.existsSync(filePath)) return { valid: false, reason: 'File does not exist' };
  const stat = fs.statSync(filePath);
  const sizeMB = Math.round(stat.size / 1024 / 1024);
  if (sizeMB < 50) return { valid: false, reason: `Only ${sizeMB} MB — the real model file is ~165 MB. Check you didn't point at nvngx.dll_dlssnr.dll by mistake.` };
  return { valid: true, sizeMB };
});

// ---------- install status ----------

function gameDir(exePath) {
  return path.dirname(exePath);
}

ipcMain.handle('game:status', (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { exeMissing: true };
  const dir = gameDir(exePath);
  const hasIni = fs.existsSync(path.join(dir, 'OptiScaler.ini'));
  const hasNr = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));
  const hasUninstaller = fs.existsSync(path.join(dir, 'uninstall_optiscaler.bat')) ||
    fs.existsSync(path.join(dir, 'uninstaller.bat'));
  return { exeMissing: false, hasIni, hasNr, hasUninstaller, dir };
});

// ---------- install / uninstall ----------

ipcMain.handle('game:install', async (_evt, { exePath, releaseFolder, nrDllPath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    if (!releaseFolder || !fs.existsSync(releaseFolder)) throw new Error('OptiScaler release folder not set');
    if (!findSetupBat(releaseFolder)) throw new Error('setup_windows.bat not found in release folder');
    if (!nrDllPath || !fs.existsSync(nrDllPath)) {
      throw new Error(`DLSS NR file not found at "${nrDllPath || '(not set)'}" — re-check the path in Settings`);
    }

    const dir = gameDir(exePath);

    // Copy every file from the extracted release into the game folder (async: avoids blocking the app on large files).
    for (const entry of await fsp.readdir(releaseFolder, { withFileTypes: true })) {
      const src = path.join(releaseFolder, entry.name);
      const dest = path.join(dir, entry.name);
      await fsp.cp(src, dest, { recursive: true, force: true });
    }

    // Copy the user-supplied NVIDIA model DLL in under the expected name, then verify it actually landed.
    const nrDest = path.join(dir, 'nvngx_dlssnr.dll');
    await fsp.copyFile(nrDllPath, nrDest);
    const srcStat = await fsp.stat(nrDllPath);
    const destStat = await fsp.stat(nrDest);
    const nrCopied = destStat.size === srcStat.size;
    if (!nrCopied) throw new Error('nvngx_dlssnr.dll copy size mismatch — copy may have failed, try again');

    // If this game was already set up before, setup_windows.bat previously renamed OptiScaler.dll
    // to a proxy name (dxgi.dll etc.) and deleted itself -- the fresh OptiScaler.dll just copied
    // above sits inert next to it. Refresh the actual proxy in place so an update takes effect
    // without re-running the interactive setup script.
    let proxyUpdated = null;
    try {
      const active = await findActiveOptiScalerFile(dir);
      if (active && active.renamed && sha256File(path.join(releaseFolder, 'OptiScaler.dll')) !== sha256File(active.file)) {
        await fsp.copyFile(path.join(releaseFolder, 'OptiScaler.dll'), active.file);
        proxyUpdated = path.basename(active.file);
      }
    } catch {
      // Non-fatal -- the plain OptiScaler.dll copy above still succeeded either way.
    }

    // Auto-detect the game's rendering API and switch its upscaler/DLSS-NR/Frame-Gen settings on,
    // so it works without the user having to do this by hand -- the overlay no longer has a menu
    // section to do it from in-game. Only fills in values still left at "auto"; see patchIniDefaults.
    const { api, applied, streamline } = await autoConfigureGame(dir, exePath);

    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, api, autoConfigured: applied, streamline };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('game:run-setup', async (_evt, exePath) => {
  const dir = gameDir(exePath);
  const bat = findSetupBat(dir);
  if (!bat) return { ok: false, error: 'setup_windows.bat not found in game folder. Install first.' };
  // Open in a normal interactive console window since the script prompts the user directly.
  spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', bat], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: false
  }).unref();
  return { ok: true };
});

ipcMain.handle('game:run-uninstall', async (_evt, exePath) => {
  const dir = gameDir(exePath);
  const candidates = ['uninstall_optiscaler.bat', 'uninstaller.bat'];
  const found = candidates.find((c) => fs.existsSync(path.join(dir, c)));
  if (!found) return { ok: false, error: 'No uninstaller script found in game folder.' };
  spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', found], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: false
  }).unref();
  return { ok: true };
});

ipcMain.handle('game:open-folder', (_evt, exePath) => {
  shell.openPath(gameDir(exePath));
});

// ---------- render API detection / auto-configuration ----------
// The overlay no longer has a menu section to turn any of this on from in-game (see the
// [FrameGen] handling below), so a fresh install needs to already be configured correctly for
// the game's actual rendering API. This is best-effort: an exe importing d3d12.dll may still
// render in Dx11 in some hybrid engines, so it never overrides a value the user (or a previous
// run of this same logic) already changed away from "auto" -- see patchIniDefaults.

async function detectRenderApi(dir, exePath) {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.some((f) => /^vulkan-1\.dll$/i.test(f) || /_vk(ulkan)?\.dll$/i.test(f))) return 'vulkan';
  } catch {
    // fall through to the exe scan below
  }
  try {
    const buf = await fsp.readFile(exePath);
    const has = (name) => buf.includes(Buffer.from(name.toLowerCase(), 'ascii')) ||
      buf.includes(Buffer.from(name.toUpperCase(), 'ascii'));
    if (has('vulkan-1.dll')) return 'vulkan';
    if (has('d3d12.dll')) return 'dx12';
    if (has('d3d11.dll')) return 'dx11';
  } catch {
    // exe unreadable/too large/locked -- fall through to "unknown"
  }
  return null;
}

// Text-preserving ini patch: only fills in a key when its current value is still the shipped
// "auto" placeholder, so it never clobbers a value the user (or a prior run) deliberately set.
// Rewrites just the matched value lines -- every comment, blank line and unrelated setting in the
// file is left byte-for-byte alone.
function patchIniDefaults(iniPath, edits) {
  const original = fs.readFileSync(iniPath, 'utf-8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r\n|\n/);
  const remaining = new Map(edits.map((e) => [`${e.section.toLowerCase()}::${e.key.toLowerCase()}`, e]));
  const applied = [];
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    if (!currentSection) continue;
    const kvMatch = lines[i].match(/^(\s*)([^;#=\s][^=]*?)(\s*=\s*)(.*)$/);
    if (!kvMatch) continue;
    const [, indent, key, sep, value] = kvMatch;
    const mapKey = `${currentSection.toLowerCase()}::${key.trim().toLowerCase()}`;
    const edit = remaining.get(mapKey);
    if (!edit) continue;
    remaining.delete(mapKey);
    if (value.trim().toLowerCase() === 'auto') {
      lines[i] = `${indent}${key}${sep}${edit.value}`;
      applied.push(edit);
    }
  }

  if (applied.length > 0) fs.writeFileSync(iniPath, lines.join(eol), 'utf-8');
  return applied;
}

// ---------- Streamline SDK (needed for FGOutput=dlssg) ----------
// FGOutput::DLSSG needs sl.interposer.dll/sl.common.dll/nvngx_dlssg.dll in a "streamline"
// subfolder next to the proxy DLL, or it fails at runtime with "Can't init DLSSG Output -- Are
// you missing the streamline folder?". Unlike the DLSS NR model file, this one IS freely
// redistributable straight from NVIDIA-RTX/Streamline's own GitHub releases, so it can be fetched
// automatically instead of asking the user to run the repo's Streamlined_fetcher_windows.bat by
// hand for every game.
//
// Pinned to the exact version, NOT "latest": the OptiScaler build this app installs compiles
// against external/streamline's headers, currently SL_VERSION 2.11.1. Deploying the newest
// release (2.12.0, at the time this was pinned) crashed Witcher 3 hard -- Windows Error Reporting
// pointed straight at OptiScaler\streamline\sl.reflex.dll, access violation, during DLSS-G init.
// An ABI-mismatched runtime DLL talking to an interposer built against older headers reproduces
// exactly like that. Bump this only in lockstep with a rebuild against newer streamline headers.
const STREAMLINE_SDK_VERSION = 'v2.11.1';
const STREAMLINE_RELEASE_API = `https://api.github.com/repos/NVIDIA-RTX/Streamline/releases/tags/${STREAMLINE_SDK_VERSION}`;

function streamlineSdkCacheDir() {
  return path.join(userDataDir(), 'streamline-sdk');
}

// Downloads and caches once per app install -- subsequent calls are a no-op if the cache already
// matches STREAMLINE_SDK_VERSION (a version marker file, not just file presence, so a cache left
// over from before this version was pinned gets replaced rather than silently reused). Returns
// the cache directory, or null if the fetch failed (offline, GitHub rate limit, etc.) -- callers
// treat that as non-fatal and just skip deploying it this time.
async function ensureStreamlineSdkCache() {
  const cacheDir = streamlineSdkCacheDir();
  const versionMarker = path.join(cacheDir, '.version');
  const cachedVersion = fs.existsSync(versionMarker) ? fs.readFileSync(versionMarker, 'utf-8').trim() : null;
  if (cachedVersion === STREAMLINE_SDK_VERSION && fs.existsSync(path.join(cacheDir, 'sl.interposer.dll'))) {
    return cacheDir;
  }

  let tmpZip;
  try {
    const res = await fetch(STREAMLINE_RELEASE_API, { headers: GITHUB_HEADERS });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const data = await res.json();
    const zipAsset = (data.assets || []).find((a) => a.name.toLowerCase().endsWith('.zip'));
    if (!zipAsset) throw new Error(`No .zip asset in Streamline release ${STREAMLINE_SDK_VERSION}`);

    const dlRes = await fetch(zipAsset.browser_download_url, { headers: GITHUB_HEADERS });
    if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`);
    const buf = Buffer.from(await dlRes.arrayBuffer());

    tmpZip = path.join(os.tmpdir(), `streamline-sdk-${Date.now()}.zip`);
    await fsp.writeFile(tmpZip, buf);

    const tmpExtract = path.join(os.tmpdir(), `streamline-sdk-extract-${Date.now()}`);
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
    ], { env: { ...process.env, OSM_ZIP: tmpZip, OSM_DEST: tmpExtract } });

    // The SDK zip nests the real (non-development) DLLs under bin/x64 -- find it rather than
    // hardcoding the path, in case a future SDK release reshuffles the layout.
    let binDir = null;
    const stack = [tmpExtract];
    while (stack.length > 0 && !binDir) {
      const cur = stack.pop();
      const entries = await fsp.readdir(cur, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'sl.interposer.dll')) {
        binDir = cur;
        break;
      }
      for (const e of entries) if (e.isDirectory()) stack.push(path.join(cur, e.name));
    }
    if (!binDir) throw new Error('sl.interposer.dll not found anywhere in the downloaded SDK');

    await fsp.mkdir(cacheDir, { recursive: true });
    for (const entry of await fsp.readdir(binDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
        await fsp.copyFile(path.join(binDir, entry.name), path.join(cacheDir, entry.name));
      }
    }
    await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});

    if (!fs.existsSync(path.join(cacheDir, 'sl.interposer.dll'))) return null;
    await fsp.writeFile(versionMarker, STREAMLINE_SDK_VERSION, 'utf-8');
    return cacheDir;
  } catch {
    return null; // Offline, rate-limited, etc. -- non-fatal, just try again next sync.
  } finally {
    if (tmpZip) fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
}

// Copy-if-missing, not force-overwrite: a game folder may already have a hand-populated
// streamline folder (e.g. NR-specific sl.dlss_nr.dll/nvngx_dlssnr.dll plugins sourced from a
// driver package, which this SDK download doesn't carry), and this only needs to fill gaps.
//
// Goes under <gamedir>/OptiScaler/streamline, not <gamedir>/streamline: dllmain.cpp resolves
// MainDllPath (the base LoadStreamline() builds "streamline" onto) to the game's OptiScaler/
// subfolder whenever it exists -- which it always does once the release's own OptiScaler/
// subfolder has been copied in -- falling back to the game root only if that subfolder is
// missing.
async function deployStreamlineFolder(dir) {
  const base = fs.existsSync(path.join(dir, 'OptiScaler')) ? path.join(dir, 'OptiScaler') : dir;
  const dest = path.join(base, 'streamline');
  if (fs.existsSync(path.join(dest, 'sl.interposer.dll'))) return { deployed: false, reason: 'already present' };

  const cacheDir = await ensureStreamlineSdkCache();
  if (!cacheDir) return { deployed: false, reason: 'could not fetch Streamline SDK' };

  await fsp.mkdir(dest, { recursive: true });
  const copied = [];
  for (const entry of await fsp.readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const destFile = path.join(dest, entry.name);
    if (fs.existsSync(destFile)) continue;
    await fsp.copyFile(path.join(cacheDir, entry.name), destFile);
    copied.push(entry.name);
  }
  return { deployed: copied.length > 0, files: copied };
}

// Frame Gen output/input are only wired up for Dx11/Dx12 in this build -- the menu's own
// Vulkan-disables everything gate (see upstream RenderFrameGenerationSelection) no longer runs
// at all, since the overlay was stripped down to just the DLSS NR panel, so nothing resets an
// unsupported choice at runtime any more. Leaving Frame Gen untouched on Vulkan avoids silently
// switching on something the game has no working path for and no in-game control to undo.
async function autoConfigureGame(dir, exePath) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return { api: null, applied: [] };

  const api = await detectRenderApi(dir, exePath);
  const edits = [];

  if (api === 'dx12') edits.push({ section: 'Upscalers', key: 'Dx12Upscaler', value: 'dlss' });
  else if (api === 'dx11') edits.push({ section: 'Upscalers', key: 'Dx11Upscaler', value: 'dlss' });
  else if (api === 'vulkan') edits.push({ section: 'Upscalers', key: 'VulkanUpscaler', value: 'dlss' });

  edits.push({ section: 'DlssNr', key: 'Enabled', value: 'true' });

  // FGOutput=dlssg, not fsrfg: the overlay's Frame Generation section is wired specifically to
  // FGOutput::DLSSG (real NVIDIA DLSS-G) -- fsrfg/xefg are deliberately left out of that panel, so
  // either would leave it stuck reading "NVIDIA DLSS Frame Generation is not the active output
  // right now." Needs an RTX 40-series+ card, same tier this app's core DLSS NR feature already
  // requires an RTX 50-series card for.
  let streamline = null;
  if (api === 'dx11' || api === 'dx12') {
    edits.push({ section: 'FrameGen', key: 'Enabled', value: 'true' });
    edits.push({ section: 'FrameGen', key: 'FGInput', value: 'upscaler' });
    edits.push({ section: 'FrameGen', key: 'FGOutput', value: 'dlssg' });
    streamline = await deployStreamlineFolder(dir);
  }

  const applied = patchIniDefaults(iniPath, edits);
  return { api, applied, streamline };
}

// ---------- stale-install detection / auto-update ----------
// setup_windows.bat renames OptiScaler.dll to a proxy name (dxgi.dll, winmm.dll, ...) and deletes
// itself, so re-copying the release folder into a game only refreshes the inert, never-loaded
// OptiScaler.dll -- the proxy actually being loaded by the game stays on whatever version it was
// last renamed from. This finds that real, currently-loaded file and refreshes it directly.

const PROXY_CANDIDATES = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll', 'd3d12.dll', 'wininet.dll', 'winhttp.dll', 'OptiScaler.asi'];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Same technique setup_windows.bat itself uses to spot leftover OptiScaler files: the PE
// OriginalFilename in the version resource survives a plain rename, so it still reads
// "OptiScaler.dll" no matter what the file on disk is actually called.
async function findActiveOptiScalerFile(dir) {
  const present = PROXY_CANDIDATES.filter((name) => fs.existsSync(path.join(dir, name)));
  if (present.length === 0) {
    const plain = path.join(dir, 'OptiScaler.dll');
    return fs.existsSync(plain) ? { file: plain, renamed: false } : null;
  }
  try {
    const psScript = `
      $names = @(${present.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')})
      $out = foreach ($n in $names) {
        $p = Join-Path $env:OSM_DIR $n
        $vi = (Get-Item -LiteralPath $p).VersionInfo
        [PSCustomObject]@{ Name = $n; Orig = $vi.OriginalFilename }
      }
      ConvertTo-Json -InputObject $out -Compress
    `;
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', psScript
    ], { env: { ...process.env, OSM_DIR: dir } });
    let parsed = JSON.parse(stdout || 'null');
    if (parsed && !Array.isArray(parsed)) parsed = [parsed];
    const match = (parsed || []).find((e) => (e.Orig || '').toLowerCase() === 'optiscaler.dll');
    if (match) return { file: path.join(dir, match.Name), renamed: true };
  } catch {
    // fall through to the single-candidate fallback below
  }
  // Version-info lookup failed. Only safe to guess when exactly one candidate is present --
  // with several, guessing wrong would overwrite an unrelated DLL (e.g. a real ReShade dxgi.dll).
  if (present.length === 1) return { file: path.join(dir, present[0]), renamed: true };
  return null;
}

ipcMain.handle('game:sync-if-stale', async (_evt, { exePath, releaseFolder }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: true, updated: false, reason: 'exe missing' };
    const dir = gameDir(exePath);
    if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return { ok: true, updated: false, reason: 'not installed' };

    // Fill in any still-"auto" upscaler/DlssNr/FrameGen settings every sync, not just on install --
    // covers games that were already installed before this feature existed.
    const { api, applied: autoConfigured, streamline } = await autoConfigureGame(dir, exePath);

    const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
    if (!releaseDll || !fs.existsSync(releaseDll)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'no release set', api, autoConfigured, streamline };
    }

    const active = await findActiveOptiScalerFile(dir);
    if (!active) {
      return {
        ok: true, updated: autoConfigured.length > 0,
        reason: 'could not identify the active OptiScaler file (ambiguous proxy candidates)', api, autoConfigured, streamline
      };
    }

    if (sha256File(releaseDll) === sha256File(active.file)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'up to date', api, autoConfigured, streamline };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});

    return { ok: true, updated: true, file: path.basename(active.file), api, autoConfigured, streamline };
  } catch (err) {
    // Most common cause: the game is currently running and has the DLL locked.
    return { ok: false, error: err.message };
  }
});

// ---------- banner caching ----------
// Fetched from the main process (not <img> in the renderer) because Steam's CDN can reject
// image requests whose Referer/Origin is a file:// page; Node's fetch sends no such header.

function bannersDir() {
  const dir = path.join(userDataDir(), 'banners');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('banner:cache-steam', async (_evt, { appid, fallbackImageUrl }) => {
  const dest = path.join(bannersDir(), `steam-${appid}.jpg`);
  if (fs.existsSync(dest)) return dest;

  let imageUrl = null;
  try {
    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}`);
    if (res.ok) {
      const data = await res.json();
      const entry = data[String(appid)];
      if (entry && entry.success && entry.data) {
        imageUrl = entry.data.header_image || entry.data.capsule_image || null;
      }
    }
  } catch {
    // fall through to fallbackImageUrl
  }
  if (!imageUrl) imageUrl = fallbackImageUrl || null;
  if (!imageUrl) return null;

  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(dest, buf);
    return dest;
  } catch {
    return null;
  }
});

ipcMain.handle('banner:import-local', async (_evt, sourcePath) => {
  const ext = path.extname(sourcePath) || '.png';
  const dest = path.join(bannersDir(), `local-${Date.now()}${ext}`);
  await fsp.copyFile(sourcePath, dest);
  return dest;
});

// ---------- update check / install (GitHub releases) ----------

ipcMain.handle('update:check', async () => {
  try {
    const res = await fetch(RELEASES_API, { headers: GITHUB_HEADERS });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const data = await res.json();
    const zipAsset = (data.assets || []).find((a) => a.name.toLowerCase().endsWith('.zip'));
    return {
      ok: true,
      tag: data.tag_name,
      name: data.name || data.tag_name,
      publishedAt: data.published_at,
      downloadUrl: zipAsset ? zipAsset.browser_download_url : data.zipball_url,
      assetName: zipAsset ? zipAsset.name : `${data.tag_name}.zip`
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function findReleaseRoot(folder) {
  if (findSetupBat(folder)) return folder;
  try {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(folder, entry.name);
        if (findSetupBat(nested)) return nested;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

ipcMain.handle('update:install', async (_evt, { downloadUrl, assetName, tag, targetFolder }) => {
  let tmpZip;
  try {
    const dest = targetFolder && targetFolder.trim()
      ? targetFolder.trim()
      : path.join(userDataDir(), 'OptiScalerRelease');

    const res = await fetch(downloadUrl, { headers: GITHUB_HEADERS });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    tmpZip = path.join(os.tmpdir(), `optiscaler-update-${Date.now()}.zip`);
    await fsp.writeFile(tmpZip, buf);

    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });

    // Use Windows' built-in Expand-Archive via PowerShell rather than adding a zip dependency.
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
    ], { env: { ...process.env, OSM_ZIP: tmpZip, OSM_DEST: dest } });

    const root = findReleaseRoot(dest);
    if (!root) throw new Error('Extracted update, but setup_windows.bat was not found inside it');

    return { ok: true, folder: root, tag };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tmpZip) fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
});
