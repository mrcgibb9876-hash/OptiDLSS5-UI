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

    const { api, applied, streamline, reEngine } = await autoConfigureGame(dir, exePath);

    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, api, autoConfigured: applied, streamline, reEngine };
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

const STREAMLINE_SDK_VERSION = 'v2.11.1';
const STREAMLINE_RELEASE_API = `https://api.github.com/repos/NVIDIA-RTX/Streamline/releases/tags/${STREAMLINE_SDK_VERSION}`;

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
    }

    const tmpExtract = path.join(os.tmpdir(), `streamline-sdk-extract-${Date.now()}`);
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
    ], { env: { ...process.env, OSM_ZIP: tmpZip, OSM_DEST: tmpExtract } });

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

async function autoConfigureGame(dir, exePath) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return { api: null, applied: [] };

  const api = await detectRenderApi(dir, exePath);
  const edits = [];

  if (api === 'dx12') edits.push({ section: 'Upscalers', key: 'Dx12Upscaler', value: 'dlss' });
  else if (api === 'dx11') edits.push({ section: 'Upscalers', key: 'Dx11Upscaler', value: 'dlss' });
  else if (api === 'vulkan') edits.push({ section: 'Upscalers', key: 'VulkanUpscaler', value: 'dlss' });

  edits.push({ section: 'DlssNr', key: 'Enabled', value: 'true' });

  const reEngine = isReEngineGame(dir);
  if (reEngine) {
    edits.push({ section: 'Hotfix', key: 'RestoreComputeSignature', value: 'true' });
    edits.push({ section: 'Hotfix', key: 'RestoreGraphicSignature', value: 'true' });
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
  return { api, applied, streamline, reEngine };
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

    const { api, applied: autoConfigured, streamline, reEngine } = await autoConfigureGame(dir, exePath);

    const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
    if (!releaseDll || !fs.existsSync(releaseDll)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'no release set', api, autoConfigured, streamline, reEngine };
    }

    if (!hasDlssNrSection(releaseFolder)) {
      return {
        ok: true, updated: autoConfigured.length > 0,
        reason: 'release folder is not the DLSS-NR fork (no [DlssNr] section) -- refusing to sync', api, autoConfigured, streamline, reEngine
      };
    }

    const active = await findActiveOptiScalerFile(dir);
    if (!active) {
      return {
        ok: true, updated: autoConfigured.length > 0,
        reason: 'could not identify the active OptiScaler file (ambiguous proxy candidates)', api, autoConfigured, streamline, reEngine
      };
    }

    if (sha256File(releaseDll) === sha256File(active.file)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'up to date', api, autoConfigured, streamline, reEngine };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});

    return { ok: true, updated: true, file: path.basename(active.file), api, autoConfigured, streamline, reEngine };
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
