const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');

const { scanForGames } = require('./discover');
const execFileAsync = promisify(execFile);

const RELEASES_API = 'https://api.github.com/repos/mrcgibb9876-hash/OptiScaler_DLSSNR/releases/latest';
const GITHUB_HEADERS = { 'User-Agent': 'OptiDLSS5-UI', Accept: 'application/vnd.github+json' };

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

ipcMain.handle('data:load', () => {
  const games = readJson(gamesFile(), []);
  const settings = readJson(settingsFile(), {
    releaseFolder: '',
    nrDllPath: '',
    installedVersion: '',
    streamlineZipPath: ''
  });
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

ipcMain.handle('library:scan', async (_evt, options) => {
  const { extraFolders = [], scanDrives = false, excludedRoots = [], knownExePaths = [] } = options || {};

  try {
    return { ok: true, ...scanForGames({ extraFolders, scanDrives, excludedRoots, knownExePaths }) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), games: [], roots: [] };
  }
});

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

ipcMain.handle('pick:zip', async (_evt, title) => {
  const res = await dialog.showOpenDialog({
    title: title || 'Select a .zip file',
    properties: ['openFile'],
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
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

ipcMain.handle('steam:search', async (_evt, term) => {
  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).slice(0, 8).map((item) => ({
      appid: item.id,
      name: item.name,
      tinyImage: item.tiny_image || null
    }));
  } catch {
    return [];
  }
});

function findSetupBat(folder) {
  try {
    const entries = fs.readdirSync(folder);
    return entries.find((f) => f.toLowerCase() === 'setup_windows.bat') || null;
  } catch {
    return null;
  }
}

function hasDlssNrSection(folder) {
  try {
    const ini = fs.readFileSync(path.join(folder, 'OptiScaler.ini'), 'utf8');
    return /^\[DlssNr\]/im.test(ini);
  } catch {
    return false;
  }
}

ipcMain.handle('release:validate', (_evt, folder) => {
  if (!folder) return { valid: false, reason: 'No folder set' };
  if (!fs.existsSync(folder)) return { valid: false, reason: 'Folder does not exist' };
  const bat = findSetupBat(folder);
  if (!bat) return { valid: false, reason: 'setup_windows.bat not found in this folder' };
  if (!hasDlssNrSection(folder)) {
    return {
      valid: false,
      reason: 'This looks like standard OptiScaler, not the DLSS-NR fork -- OptiScaler.ini has no [DlssNr] section. ' +
        'Use "Check for Updates" in Settings to fetch the right build from OptiScaler_DLSSNR rather than a manual download.'
    };
  }
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

function gameDir(exePath) {
  return path.dirname(exePath);
}

function detectInstalledBackends(dir) {
  const has = (name) => fs.existsSync(path.join(dir, name));
  const optiscaler = has('OptiScaler.ini') && has('nvngx_dlssnr.dll');
  return { optiscaler };
}

ipcMain.handle('game:status', (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { exeMissing: true };
  const dir = gameDir(exePath);
  const hasIni = fs.existsSync(path.join(dir, 'OptiScaler.ini'));
  const hasNr = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));
  const hasUninstaller = fs.existsSync(path.join(dir, 'Remove_OptiScaler.bat')) ||
    fs.existsSync(path.join(dir, 'uninstall_optiscaler.bat')) ||
    fs.existsSync(path.join(dir, 'uninstaller.bat'));
  const backends = detectInstalledBackends(dir);
  return { exeMissing: false, hasIni, hasNr, hasUninstaller, dir, backends };
});

ipcMain.handle('game:install', async (_evt, { exePath, releaseFolder, nrDllPath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    if (!releaseFolder || !fs.existsSync(releaseFolder)) throw new Error('OptiScaler release folder not set');
    if (!findSetupBat(releaseFolder)) throw new Error('setup_windows.bat not found in release folder');
    if (!hasDlssNrSection(releaseFolder)) {
      throw new Error('The release folder is standard OptiScaler, not the DLSS-NR fork -- no [DlssNr] section in its OptiScaler.ini. Fix it in Settings before installing.');
    }
    if (!nrDllPath || !fs.existsSync(nrDllPath)) {
      throw new Error(`DLSS NR file not found at "${nrDllPath || '(not set)'}" — re-check the path in Settings`);
    }

    const dir = gameDir(exePath);

    for (const entry of await fsp.readdir(releaseFolder, { withFileTypes: true })) {
      const src = path.join(releaseFolder, entry.name);
      const dest = path.join(dir, entry.name);
      await fsp.cp(src, dest, { recursive: true, force: true });
    }

    const nrDest = path.join(dir, 'nvngx_dlssnr.dll');
    await fsp.copyFile(nrDllPath, nrDest);
    const srcStat = await fsp.stat(nrDllPath);
    const destStat = await fsp.stat(nrDest);
    const nrCopied = destStat.size === srcStat.size;
    if (!nrCopied) throw new Error('nvngx_dlssnr.dll copy size mismatch — copy may have failed, try again');

    if (!fs.existsSync(path.join(dir, 'nvngx.dll_dlssnr.dll')) && fs.existsSync(path.join(releaseFolder, 'nvngx.dll_dlssnr.dll'))) {
      throw new Error('nvngx.dll_dlssnr.dll did not copy from the release folder -- copy may have failed, try again');
    }
    if (!fs.existsSync(path.join(releaseFolder, 'nvngx.dll_dlssnr.dll'))) {
      throw new Error('The release folder itself is missing nvngx.dll_dlssnr.dll -- it looks incomplete. Re-download it via "Check for Updates" in Settings.');
    }

    let proxyUpdated = null;
    try {
      const active = await findActiveOptiScalerFile(dir);
      if (active && active.renamed && sha256File(path.join(releaseFolder, 'OptiScaler.dll')) !== sha256File(active.file)) {
        await fsp.copyFile(path.join(releaseFolder, 'OptiScaler.dll'), active.file);
        proxyUpdated = path.basename(active.file);
      }
    } catch {
    }

    const { api, applied, streamline, reEngine, reframework } = await autoConfigureGame(dir, exePath);

    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, api, autoConfigured: applied, streamline, reEngine, reframework };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('game:run-setup', async (_evt, exePath) => {
  const dir = gameDir(exePath);
  const bat = findSetupBat(dir);
  if (!bat) return { ok: false, error: 'setup_windows.bat not found in game folder. Install first.' };
  spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', bat], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: false
  }).unref();
  return { ok: true };
});

async function removeSharedNrDllIfUnneeded(dir) {
  const file = path.join(dir, 'nvngx_dlssnr.dll');
  if (!fs.existsSync(file)) return false;
  await fsp.rm(file);
  return true;
}

ipcMain.handle('game:run-uninstall', async (_evt, exePath) => {
  const dir = gameDir(exePath);
  const candidates = ['Remove_OptiScaler.bat', 'uninstall_optiscaler.bat', 'uninstaller.bat'];
  const found = candidates.find((c) => fs.existsSync(path.join(dir, c)));
  const nrDllRemoved = await removeSharedNrDllIfUnneeded(dir);
  if (!found) {
    return {
      ok: false,
      error: 'No generated uninstaller found -- "Run Setup" was never completed for this game, so ' +
        'OptiScaler was never fully set up here. Removed what this app added directly ' +
        `(${nrDllRemoved ? 'nvngx_dlssnr.dll' : 'nothing found'}); ` +
        'the plain OptiScaler.dll/OptiScaler.ini copy is still in the folder, remove those by hand or via "Remove" below.',
      nrDllRemoved
    };
  }
  spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', found], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: false
  }).unref();
  return { ok: true, nrDllRemoved };
});

ipcMain.handle('game:confirm-remove', async (_evt, gameName) => {
  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Remove OptiScaler + forget game', 'Just forget game (keep files)', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Remove game',
    message: `Remove "${gameName}" from OptiDLSS5-UI?`,
    detail: 'Removing OptiScaler runs its uninstaller in a terminal you confirm yourself (same as Run Setup).'
  });
  return ['remove-and-forget', 'forget-only', 'cancel'][res.response] || 'cancel';
});

ipcMain.handle('game:open-folder', (_evt, exePath) => {
  shell.openPath(gameDir(exePath));
});

async function detectRenderApi(dir, exePath) {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.some((f) => /^vulkan-1\.dll$/i.test(f) || /_vk(ulkan)?\.dll$/i.test(f))) return 'vulkan';
  } catch {
  }
  try {
    const buf = await fsp.readFile(exePath);
    const has = (name) => buf.includes(Buffer.from(name.toLowerCase(), 'ascii')) ||
      buf.includes(Buffer.from(name.toUpperCase(), 'ascii'));
    if (has('vulkan-1.dll')) return 'vulkan';
    if (has('d3d12.dll')) return 'dx12';
    if (has('d3d11.dll')) return 'dx11';
  } catch {
  }
  return null;
}

const OLD_API_MARKERS = [
    ['dx9', ['d3d9.dll', 'd3d8.dll']],
    ['dx10', ['d3d10.dll', 'd3d10core.dll']],
    ['opengl', ['opengl32.dll']]
];

async function detectInstallPath(dir, exePath) {
  const api = await detectRenderApi(dir, exePath);

  if (api === 'vulkan' || api === 'dx12' || api === 'dx11') {
    return { api, recommend: 'optiscaler', reason: `${api.toUpperCase()} — OptiScaler hooks this directly` };
  }

  let buf = null;
  try {
    buf = await fsp.readFile(exePath);
  } catch {
    return { api: null, recommend: 'unknown', reason: 'could not read the executable' };
  }

  const has = (name) =>
    buf.includes(Buffer.from(name.toLowerCase(), 'ascii')) || buf.includes(Buffer.from(name.toUpperCase(), 'ascii'));

  for (const [old, markers] of OLD_API_MARKERS) {
    if (markers.some(has)) {
      return { api: old, recommend: 'unsupported', reason: `${old.toUpperCase()} — OptiScaler has no hook here` };
    }
  }

  return { api: null, recommend: 'unknown', reason: 'could not tell which graphics API this uses' };
}

ipcMain.handle('game:detect-path', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { recommend: 'unknown', reason: 'executable not found' };
    return await detectInstallPath(gameDir(exePath), exePath);
  } catch (error) {
    return { recommend: 'unknown', reason: String(error && error.message ? error.message : error) };
  }
});

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

// Pinned to 2.11.1 -- 2.12.0+ hard-crashed Witcher 3. Fetched from RHI's own pre-packaged,
// DLLs-only zip (the same one RHI itself downloads for its Streamline staging) rather than
// NVIDIA-RTX/Streamline's official release, which bundles the full SDK (headers, samples, docs,
// every platform) and needs a recursive search for where the DLLs actually landed. RHI's manifest
// (raw.githubusercontent.com/RankFTW/RHI/main/dlss_manifest.json) lists these same per-version
// zips; this hardcodes the URL for the one pinned version rather than fetching that manifest.
const STREAMLINE_SDK_VERSION = '2.11.1';
const STREAMLINE_DIRECT_ZIP_URL =
  `https://github.com/RankFTW/rhi-repo/releases/download/streamline-${STREAMLINE_SDK_VERSION}/streamline_${STREAMLINE_SDK_VERSION}.zip`;

const KNOWN_STREAMLINE_DLLS = new Set([
  'sl.common.dll', 'sl.deepdvc.dll', 'sl.directsr.dll', 'sl.dlss.dll',
  'sl.dlss_d.dll', 'sl.dlss_g.dll', 'sl.interposer.dll', 'sl.nis.dll',
  'sl.nvperf.dll', 'sl.pcl.dll', 'sl.reflex.dll',
]);

function streamlineSdkCacheDir() {
  return path.join(userDataDir(), 'streamline-sdk');
}

function streamlineSdkLocalCacheDir() {
  return path.join(userDataDir(), 'streamline-sdk-local');
}

async function ensureStreamlineSdkCache(localZipPath) {
  const usingLocal = !!(localZipPath && fs.existsSync(localZipPath));
  const cacheDir = usingLocal ? streamlineSdkLocalCacheDir() : streamlineSdkCacheDir();
  const versionMarker = path.join(cacheDir, '.version');
  const wantVersion = usingLocal ? `local:${sha256File(localZipPath)}` : STREAMLINE_SDK_VERSION;
  const cachedVersion = fs.existsSync(versionMarker) ? fs.readFileSync(versionMarker, 'utf-8').trim() : null;
  if (cachedVersion === wantVersion && fs.existsSync(path.join(cacheDir, 'sl.interposer.dll'))) {
    return cacheDir;
  }

  let tmpZip;
  try {
    if (usingLocal) {
      tmpZip = localZipPath;
    } else {
      const dlRes = await fetch(STREAMLINE_DIRECT_ZIP_URL, { headers: GITHUB_HEADERS });
      if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`);
      const buf = Buffer.from(await dlRes.arrayBuffer());

      tmpZip = path.join(os.tmpdir(), `streamline-sdk-${Date.now()}.zip`);
      await fsp.writeFile(tmpZip, buf);
    }

    const tmpExtract = path.join(os.tmpdir(), `streamline-sdk-extract-${Date.now()}`);
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
    ], { env: { ...process.env, OSM_ZIP: tmpZip, OSM_DEST: tmpExtract } });

    // Walk the extracted tree and pull out every known sl.*.dll by name, wherever it landed --
    // more robust than assuming a single flat bin folder, and matches RHI's own filter-by-name
    // extraction rather than searching for one anchor file's containing directory.
    await fsp.mkdir(cacheDir, { recursive: true });
    let foundAny = false;
    const stack = [tmpExtract];
    while (stack.length > 0) {
      const cur = stack.pop();
      const entries = await fsp.readdir(cur, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(cur, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && KNOWN_STREAMLINE_DLLS.has(entry.name.toLowerCase())) {
          await fsp.copyFile(fullPath, path.join(cacheDir, entry.name));
          foundAny = true;
        }
      }
    }
    await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});

    if (!foundAny || !fs.existsSync(path.join(cacheDir, 'sl.interposer.dll'))) return null;
    await fsp.writeFile(versionMarker, wantVersion, 'utf-8');
    return cacheDir;
  } catch {
    return null;
  } finally {
    if (tmpZip && !usingLocal) fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
}

async function deployStreamlineFolder(dir) {
  const base = fs.existsSync(path.join(dir, 'OptiScaler')) ? path.join(dir, 'OptiScaler') : dir;
  const dest = path.join(base, 'streamline');
  if (fs.existsSync(path.join(dest, 'sl.interposer.dll'))) return { deployed: false, reason: 'already present' };

  const streamlineZipPath = readJson(settingsFile(), {}).streamlineZipPath || '';
  const cacheDir = await ensureStreamlineSdkCache(streamlineZipPath);
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

function isReEngineGame(dir) {
  try {
    return fs.readdirSync(dir).some((f) => /^re_chunk_000\.pak$/i.test(f));
  } catch {
    return false;
  }
}

// ── RE Framework (dinput8.dll) ────────────────────────────────────────────────
// Capcom RE Engine games need RE Framework present for OptiScaler to work at all --
// not an OptiScaler setting, a separate injector DLL that has to already be there.
// Mirrors RHI's REFrameworkService.cs: same monolithic nightly build (one zip now covers
// every RE Engine title), same source repo. RHI additionally has a per-game "pd-upscaler"
// branch build for a few older titles (RE2/3/4/7/8) via a server-controlled manifest --
// skipped here since none of the games this app manages need it (Dragon's Dogma 2 isn't in
// that list either), and adding it would mean carrying a remote manifest just for that.
const REFRAMEWORK_ZIP_URL = 'https://github.com/praydog/REFramework-nightly/releases/latest/download/REFramework.zip';
const REFRAMEWORK_RELEASES_API = 'https://api.github.com/repos/praydog/REFramework-nightly/releases';
const REFRAMEWORK_DLL_NAME = 'dinput8.dll';

function reframeworkCacheDir() {
  return path.join(userDataDir(), 'reframework-cache');
}

async function getLatestREFrameworkVersion() {
  try {
    const res = await fetch(REFRAMEWORK_RELEASES_API, { headers: GITHUB_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    const tag = first && first.tag_name;
    if (!tag) return null;
    // Tags look like "nightly-01302-abcdef1" -- the numeric build number is the useful part.
    for (const part of tag.split('-')) {
      if (part.length > 0 && [...part].every((c) => c >= '0' && c <= '9')) return part;
    }
    return tag;
  } catch {
    return null;
  }
}

async function ensureREFrameworkCache() {
  const cacheDir = reframeworkCacheDir();
  const versionMarker = path.join(cacheDir, '.version');
  const cachedDll = path.join(cacheDir, REFRAMEWORK_DLL_NAME);
  const latestVersion = await getLatestREFrameworkVersion();
  const cachedVersion = fs.existsSync(versionMarker) ? fs.readFileSync(versionMarker, 'utf-8').trim() : null;

  if (fs.existsSync(cachedDll) && latestVersion && cachedVersion === latestVersion) {
    return cachedDll;
  }
  if (fs.existsSync(cachedDll) && !latestVersion) {
    // Offline or rate-limited -- use whatever is already cached rather than failing outright.
    return cachedDll;
  }

  let tmpZip;
  try {
    const dlRes = await fetch(REFRAMEWORK_ZIP_URL, { headers: GITHUB_HEADERS });
    if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`);
    const buf = Buffer.from(await dlRes.arrayBuffer());

    tmpZip = path.join(os.tmpdir(), `reframework-${Date.now()}.zip`);
    await fsp.writeFile(tmpZip, buf);

    const tmpExtract = path.join(os.tmpdir(), `reframework-extract-${Date.now()}`);
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
    ], { env: { ...process.env, OSM_ZIP: tmpZip, OSM_DEST: tmpExtract } });

    let foundDll = null;
    const stack = [tmpExtract];
    while (stack.length > 0 && !foundDll) {
      const cur = stack.pop();
      const entries = await fsp.readdir(cur, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(cur, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === REFRAMEWORK_DLL_NAME) {
          foundDll = fullPath;
          break;
        }
        if (entry.isDirectory()) stack.push(fullPath);
      }
    }
    if (!foundDll) throw new Error(`${REFRAMEWORK_DLL_NAME} not found in downloaded REFramework.zip`);

    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.copyFile(foundDll, cachedDll);
    await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});

    if (latestVersion) await fsp.writeFile(versionMarker, latestVersion, 'utf-8');
    return cachedDll;
  } catch {
    // Fall back to a stale cache rather than leaving the game with no REFramework at all.
    return fs.existsSync(cachedDll) ? cachedDll : null;
  } finally {
    if (tmpZip) fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
}

/// Ensures REFramework is present for an RE Engine game. Never overwrites an existing
/// dinput8.dll that this function didn't itself place there -- OptiScaler needs *a* working
/// REFramework present, not necessarily the latest one, and a manually-supplied build may be
/// there for a reason. Returns null for non-RE-Engine games or when a dll is already present.
async function ensureREFrameworkForGame(dir) {
  if (!isReEngineGame(dir)) return null;
  const destPath = path.join(dir, REFRAMEWORK_DLL_NAME);
  if (fs.existsSync(destPath)) return { installed: false, alreadyPresent: true };

  const cachedDll = await ensureREFrameworkCache();
  if (!cachedDll) return { installed: false, error: 'could not fetch REFramework' };

  await fsp.copyFile(cachedDll, destPath);
  return { installed: true, version: fs.existsSync(path.join(reframeworkCacheDir(), '.version'))
    ? fs.readFileSync(path.join(reframeworkCacheDir(), '.version'), 'utf-8').trim() : 'unknown' };
}

async function autoConfigureGame(dir, exePath) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return { api: null, applied: [] };

  const api = await detectRenderApi(dir, exePath);
  const edits = [];

  if (api === 'dx12') edits.push({ section: 'Upscalers', key: 'Dx12Upscaler', value: 'dlss' });
  else if (api === 'dx11') edits.push({ section: 'Upscalers', key: 'Dx11Upscaler', value: 'dlss' });
  else if (api === 'vulkan') edits.push({ section: 'Upscalers', key: 'VulkanUpscaler', value: 'dlss' });

  // Only force DlssNr on when the actual model file is present -- forcing it on every game
  // regardless (including ones where NR was never installed) risks the pass trying to initialize
  // with nothing to run, which crashed launches. See the "won't launch" report.
  if (fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) {
    edits.push({ section: 'DlssNr', key: 'Enabled', value: 'true' });
  }

  const reEngine = isReEngineGame(dir);
  let reframework = null;
  if (reEngine) {
    edits.push({ section: 'Hotfix', key: 'RestoreComputeSignature', value: 'true' });
    edits.push({ section: 'Hotfix', key: 'RestoreGraphicSignature', value: 'true' });
    // OptiScaler doesn't work on RE Engine without REFramework already present -- ensure it's
    // there before anything else here matters.
    reframework = await ensureREFrameworkForGame(dir);
  }

  let streamline = null;
  const hasNativeStreamline = fs.existsSync(path.join(dir, 'sl.interposer.dll')) ||
    fs.existsSync(path.join(dir, 'sl.interposer.dll.original'));
  if (api === 'dx11' || api === 'dx12') {
    edits.push({ section: 'FrameGen', key: 'Enabled', value: 'true' });
    edits.push({ section: 'FrameGen', key: 'FGInput', value: 'upscaler' });
    edits.push({ section: 'FrameGen', key: 'FGOutput', value: 'dlssg' });
    if (!hasNativeStreamline) streamline = await deployStreamlineFolder(dir);
  }

  const applied = patchIniDefaults(iniPath, edits);
  return { api, applied, streamline, reEngine, reframework };
}

const PROXY_CANDIDATES = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll', 'd3d12.dll', 'wininet.dll', 'winhttp.dll', 'OptiScaler.asi'];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

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
  }
  if (present.length === 1) return { file: path.join(dir, present[0]), renamed: true };
  return null;
}

ipcMain.handle('game:sync-if-stale', async (_evt, { exePath, releaseFolder }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: true, updated: false, reason: 'exe missing' };
    const dir = gameDir(exePath);
    if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return { ok: true, updated: false, reason: 'not installed' };

    const { api, applied: autoConfigured, streamline, reEngine, reframework } = await autoConfigureGame(dir, exePath);

    const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
    if (!releaseDll || !fs.existsSync(releaseDll)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'no release set', api, autoConfigured, streamline, reEngine, reframework };
    }

    if (!hasDlssNrSection(releaseFolder)) {
      return {
        ok: true, updated: autoConfigured.length > 0,
        reason: 'release folder is not the DLSS-NR fork (no [DlssNr] section) -- refusing to sync', api, autoConfigured, streamline, reEngine, reframework
      };
    }

    const active = await findActiveOptiScalerFile(dir);
    if (!active) {
      return {
        ok: true, updated: autoConfigured.length > 0,
        reason: 'could not identify the active OptiScaler file (ambiguous proxy candidates)', api, autoConfigured, streamline, reEngine, reframework
      };
    }

    if (sha256File(releaseDll) === sha256File(active.file)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'up to date', api, autoConfigured, streamline, reEngine, reframework };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});

    return { ok: true, updated: true, file: path.basename(active.file), api, autoConfigured, streamline, reEngine, reframework };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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
