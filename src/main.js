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
    streamlineVersion: 'latest'
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

// The Streamline builds RHI currently publishes, newest first, for the Settings dropdown.
ipcMain.handle('streamline:versions', async () => {
  try {
    const releases = await getStreamlineReleases();
    return { ok: true, versions: releases.map((r) => r.version) };
  } catch (error) {
    return { ok: false, versions: [], error: String(error && error.message ? error.message : error) };
  }
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

ipcMain.handle('game:install', async (_evt, { exePath, releaseFolder, nrDllPath, proxyName }) => {
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

    // Checked before anything is written, not after. OptiScaler does not work on RE Engine without
    // REFramework, so an install that could not get it is not a working install -- and reporting
    // success with a footnote leaves an "Installed" badge on a game that will not start it. Failing
    // here means the folder is untouched and the user can retry once they are online.
    if (isReEngineGame(dir)) {
      const pre = await ensureREFrameworkForGame(dir);
      if (pre && pre.error) {
        throw new Error(
          `This is an RE Engine game, which needs REFramework before OptiScaler will do anything -- ` +
            `and it could not be fetched (${pre.error}). Nothing has been changed in the game folder. ` +
            `Check your connection and try again, or drop REFramework's ${REFRAMEWORK_DLL_NAME} in yourself.`
        );
      }
    }

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

    // The rename that actually makes the game load OptiScaler. Previously this only happened when
    // the user went and ran setup_windows.bat in a console afterwards; until they did, an
    // "Installed" badge meant nothing was hooked.
    let proxy = null;
    let proxyError = null;
    try {
      proxy = await installProxy(dir, proxyName || DEFAULT_PROXY);
    } catch (err) {
      // Not fatal: everything else is in place, and Run Setup is still there to do it by hand.
      proxyError = err.message;
    }

    const { api, applied, streamline, reEngine, reframework, reEngineHotfix } = await autoConfigureGame(dir, exePath);

    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, proxy, proxyError, api, autoConfigured: applied, streamline, reEngine, reframework, reEngineHotfix };
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
  try {
    // Done here rather than by spawning the generated .bat: that script asks its own questions in
    // a console the app cannot see, and decides what to restore by guessing from filenames. This
    // reverses what the install recorded it did.
    const result = await uninstallOptiScaler(dir);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

// Sets keys to an exact value whatever they currently hold, and reports what it changed.
//
// patchIniDefaults below only writes over the shipped "auto" placeholder, which is right for a
// default: it never argues with a value someone chose. That is exactly wrong for a setting that is
// known to crash. v1.4.3 wrote RestoreGraphicSignature=true into every RE Engine game's ini;
// v1.4.4 stopped writing it, but stopping is not undoing -- every install made with 1.4.3 still
// has the fatal value, and a fill-if-auto pass will never touch it again because it is no longer
// "auto". Those games stay broken through any number of updates.
function patchIniValues(iniPath, edits) {
  const original = fs.readFileSync(iniPath, 'utf-8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r\n|\n/);
  const wanted = new Map(edits.map((e) => [`${e.section.toLowerCase()}::${e.key.toLowerCase()}`, e]));
  const changed = [];
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
    const edit = wanted.get(`${currentSection.toLowerCase()}::${key.trim().toLowerCase()}`);
    if (!edit) continue;

    // Already correct: leave the line alone so the app does not report a change it did not make.
    if (value.trim().toLowerCase() === String(edit.value).toLowerCase()) continue;

    changed.push({ ...edit, was: value.trim() });
    lines[i] = `${indent}${key}${sep}${edit.value}`;
  }

  if (changed.length > 0) fs.writeFileSync(iniPath, lines.join(eol), 'utf-8');
  return changed;
}

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

// Streamline comes from RHI's pre-packaged, DLLs-only zips rather than NVIDIA-RTX/Streamline's
// official releases, which bundle the full SDK (headers, samples, docs, every platform) and need a
// recursive search for where the DLLs actually landed.
//
// Which version to fetch used to be a hardcoded constant, which meant a Manager release had to ship
// before anyone could get a newer Streamline. RHI publishes the list it uses in a manifest, so read
// that instead and take the newest entry. Note this manifest also carries a "dlssnr" list: we
// deliberately ignore it. The DLSS-NR model and the OptiScaler build both stay pinned to our own
// OptiScaler_DLSSNR fork -- RHI is a source for third-party dependencies here, not for the thing
// this app exists to install.
const RHI_MANIFEST_URL = 'https://raw.githubusercontent.com/RankFTW/RHI/main/dlss_manifest.json';
const RHI_MANIFEST_TTL_MS = 6 * 60 * 60 * 1000;

// Only consulted when the manifest can't be read and nothing has been cached yet: the newest build
// known when this shipped, plus the last one The Witcher 3 tolerates (see STREAMLINE_GAME_PINS).
const STREAMLINE_BUILTIN_VERSIONS = ['2.14.0.0', '2.11.1'];

const streamlineZipUrlFor = (version) =>
  `https://github.com/RankFTW/rhi-repo/releases/download/streamline-${version}/streamline_${version}.zip`;

// Games whose own interposer can't be driven by an arbitrarily new Streamline. 2.12.0 hard-crashed
// The Witcher 3 on startup; 2.11.1 is the last build it survives. Everything not listed here gets
// whatever RHI has newest.
const STREAMLINE_GAME_PINS = [
  { exe: /^witcher3(_dx12)?\.exe$/i, maxVersion: '2.11.1' },
];

const KNOWN_STREAMLINE_DLLS = new Set([
  'sl.common.dll', 'sl.deepdvc.dll', 'sl.directsr.dll', 'sl.dlss.dll',
  'sl.dlss_d.dll', 'sl.dlss_g.dll', 'sl.interposer.dll', 'sl.nis.dll',
  'sl.nvperf.dll', 'sl.pcl.dll', 'sl.reflex.dll',
]);

/// Compares dotted numeric versions part-by-part, treating missing parts as 0 -- so "2.11.1" and
/// "2.11.1.0" compare equal, and "2.12.128.0" sorts above "2.12.0.0".
function compareStreamlineVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] || 0);
    const nb = Number(pb[i] || 0);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return String(a).localeCompare(String(b));
    if (na !== nb) return na - nb;
  }
  return 0;
}

function rhiManifestCacheFile() {
  return path.join(userDataDir(), 'rhi-dlss-manifest.json');
}

let rhiManifestMemo = null;

/// Returns RHI's Streamline list as [{ version, url }], newest first. Prefers a fresh fetch, falls
/// back to the on-disk copy from a previous run when offline, and to a built-in list when there has
/// never been one. Never throws.
async function getStreamlineReleases() {
  if (rhiManifestMemo && Date.now() - rhiManifestMemo.at < RHI_MANIFEST_TTL_MS) {
    return rhiManifestMemo.releases;
  }

  const normalize = (list) => (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.version === 'string')
    .map((e) => ({ version: e.version, url: typeof e.url === 'string' && e.url ? e.url : streamlineZipUrlFor(e.version) }))
    .sort((x, y) => compareStreamlineVersions(y.version, x.version));

  try {
    const res = await fetch(RHI_MANIFEST_URL, { headers: { 'User-Agent': GITHUB_HEADERS['User-Agent'] } });
    if (res.ok) {
      const data = await res.json();
      const releases = normalize(data && data.streamline);
      if (releases.length > 0) {
        writeJson(rhiManifestCacheFile(), { fetchedAt: Date.now(), streamline: releases });
        rhiManifestMemo = { at: Date.now(), releases };
        return releases;
      }
    }
  } catch {
    // Fall through to the cached / built-in list.
  }

  const cached = normalize(readJson(rhiManifestCacheFile(), {}).streamline);
  const releases = cached.length > 0
    ? cached
    : STREAMLINE_BUILTIN_VERSIONS.map((version) => ({ version, url: streamlineZipUrlFor(version) }));
  rhiManifestMemo = { at: Date.now(), releases };
  return releases;
}

/// Picks the release to deploy for one game: an explicit user choice if there is one, otherwise the
/// newest build that game is known to tolerate.
async function resolveStreamlineRelease(exePath, pinnedVersion) {
  const releases = await getStreamlineReleases();
  if (releases.length === 0) return null;

  if (pinnedVersion && pinnedVersion !== 'latest') {
    const exact = releases.find((r) => compareStreamlineVersions(r.version, pinnedVersion) === 0);
    if (exact) return { ...exact, reason: 'pinned in Settings' };
    return { version: pinnedVersion, url: streamlineZipUrlFor(pinnedVersion), reason: 'pinned in Settings' };
  }

  // Split on both separators by hand: these paths are always Windows paths, but the app is also
  // developed and unit-tested on posix, where path.basename() would hand back the whole string.
  const exeName = exePath ? String(exePath).split(/[\\/]/).pop() : '';
  const cap = STREAMLINE_GAME_PINS.find((p) => exeName && p.exe.test(exeName));
  if (cap) {
    const allowed = releases.find((r) => compareStreamlineVersions(r.version, cap.maxVersion) <= 0);
    if (allowed) return { ...allowed, reason: `capped for ${exeName}` };
  }
  return { ...releases[0], reason: 'newest from RHI' };
}

function streamlineSdkCacheRoot() {
  return path.join(userDataDir(), 'streamline-sdk');
}

function streamlineSdkCacheDir(version) {
  return path.join(streamlineSdkCacheRoot(), version.replace(/[^0-9A-Za-z.]/g, '_'));
}

/// Versions used to share one flat cache directory. Move an old one into its per-version slot so
/// upgrading the app doesn't force a re-download of a build that's already on disk.
function migrateFlatStreamlineCache() {
  const root = streamlineSdkCacheRoot();
  const flatMarker = path.join(root, '.version');
  if (!fs.existsSync(flatMarker)) return;
  try {
    const version = fs.readFileSync(flatMarker, 'utf-8').trim();
    const dest = version ? streamlineSdkCacheDir(version) : null;
    if (dest && !fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        fs.renameSync(path.join(root, entry.name), path.join(dest, entry.name));
      }
      return;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile()) fs.rmSync(path.join(root, entry.name), { force: true });
    }
  } catch {
    // A cache that can't be migrated just gets re-downloaded; not worth failing an install over.
  }
}

async function ensureStreamlineSdkCache(release) {
  if (!release) return null;
  migrateFlatStreamlineCache();

  const cacheDir = streamlineSdkCacheDir(release.version);
  const versionMarker = path.join(cacheDir, '.version');
  const wantVersion = release.version;
  const cachedVersion = fs.existsSync(versionMarker) ? fs.readFileSync(versionMarker, 'utf-8').trim() : null;
  if (cachedVersion === wantVersion && fs.existsSync(path.join(cacheDir, 'sl.interposer.dll'))) {
    return cacheDir;
  }

  let tmpZip;
  try {
    const dlRes = await fetch(release.url, { headers: GITHUB_HEADERS });
    if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`);
    const buf = Buffer.from(await dlRes.arrayBuffer());

    tmpZip = path.join(os.tmpdir(), `streamline-sdk-${Date.now()}.zip`);
    await fsp.writeFile(tmpZip, buf);

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
    // A previously-cached copy of this same version is better than no Streamline at all.
    return fs.existsSync(path.join(cacheDir, 'sl.interposer.dll')) ? cacheDir : null;
  } finally {
    if (tmpZip) fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
}

async function deployStreamlineFolder(dir, exePath) {
  const base = fs.existsSync(path.join(dir, 'OptiScaler')) ? path.join(dir, 'OptiScaler') : dir;
  const dest = path.join(base, 'streamline');
  if (fs.existsSync(path.join(dest, 'sl.interposer.dll'))) return { deployed: false, reason: 'already present' };

  const settings = readJson(settingsFile(), {});
  const release = await resolveStreamlineRelease(exePath, settings.streamlineVersion || 'latest');
  const cacheDir = await ensureStreamlineSdkCache(release);
  if (!cacheDir) {
    return { deployed: false, reason: 'could not fetch Streamline SDK', version: release ? release.version : null };
  }

  await fsp.mkdir(dest, { recursive: true });
  const copied = [];
  for (const entry of await fsp.readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === '.version') continue;
    const destFile = path.join(dest, entry.name);
    if (fs.existsSync(destFile)) continue;
    await fsp.copyFile(path.join(cacheDir, entry.name), destFile);
    copied.push(entry.name);
  }
  return {
    deployed: copied.length > 0,
    files: copied,
    version: release.version,
    reason: release.reason,
  };
}

function isReEngineGame(dir) {
  try {
    return fs.readdirSync(dir).some((f) => /^re_chunk_000\.pak$/i.test(f));
  } catch {
    return false;
  }
}

// The ini keys RE Engine needs, from a tested Dragon's Dogma 2 configuration.
//
// These are FORCED, not defaulted, because two of them are values that crash rather than values
// that are merely wrong -- see patchIniValues.
//
// What each one is for:
//
//   ShortcutKey (Menu)      REFramework's own default menu key is Insert too -- confirmed straight
//                           out of its dinput8.dll ("Default Menu Key: Insert"). REFramework's
//                           DirectInput proxy evicts OptiScaler's window subclass a couple of
//                           seconds into startup (OptiScaler.log shows "subclass lost input" right
//                           as DirectInput's CreateDevice hook fires), and OptiScaler deliberately
//                           does not fight to reclaim it. From that point Insert can only reach
//                           REFramework's own menu, never OptiScaler's -- so this moves OptiScaler
//                           off Insert entirely rather than trying to win a hook fight. 0x24 is
//                           VK_HOME, OptiScaler's own pre-Insert default and not claimed by
//                           REFramework's defaults either.
//
//   RestoreComputeSignature RE Engine's scheduler expects its compute pipeline state intact across
//                           frames. Return without restoring the compute root signature and it hits
//                           its own assertion trap -- the Capcom CrashReport box, 0xC000001D.
//
//   RestoreGraphicSignature MUST be false. On the intro-to-3D transition Streamline tears down the
//                           swapchain and RE Engine rebinds bindless descriptors. Restoring graphics
//                           root state there feeds dangling pointers into nvwgf2umx.dll: instant
//                           0xC0000005. The log shows "Couldn't restore GraphicsRoot32BitConstant"
//                           and "Couldn't restore GraphicsRootDescriptorTable" first.
//
//   ExtendedStateRestore    MUST be false, same failure for the same reason -- extended tracking of
//                           bindless state across that teardown.
//
// This supersedes the v1.4.3/v1.4.4 handling. v1.4.3 set the compute AND graphics restores to true
// together, which crashed Dragon's Dogma 2, and v1.4.4 responded by setting neither -- reading the
// crash as "the compute restore fought the quirks table". On this evidence that was the wrong half:
// the graphics restore is the one that kills it, and the compute restore is required. Setting them
// explicitly and in opposite directions is what was actually needed.
const RE_ENGINE_HOTFIX = [
  { section: 'Menu', key: 'ShortcutKey', value: '0x24' },
  { section: 'Hotfix', key: 'RestoreComputeSignature', value: 'true' },
  { section: 'Hotfix', key: 'RestoreGraphicSignature', value: 'false' },
  { section: 'Hotfix', key: 'ExtendedStateRestore', value: 'false' },
];

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
  let reEngineHotfix = [];
  if (reEngine) {
    reEngineHotfix = patchIniValues(iniPath, RE_ENGINE_HOTFIX);

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
    if (!hasNativeStreamline) streamline = await deployStreamlineFolder(dir, exePath);
  }

  const applied = patchIniDefaults(iniPath, edits);
  return { api, applied, streamline, reEngine, reframework, reEngineHotfix };
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

    const { api, applied: autoConfigured, streamline, reEngine, reframework, reEngineHotfix } = await autoConfigureGame(dir, exePath);

    const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
    if (!releaseDll || !fs.existsSync(releaseDll)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'no release set', api, autoConfigured, streamline, reEngine, reframework, reEngineHotfix };
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
      return { ok: true, updated: autoConfigured.length > 0, reason: 'up to date', api, autoConfigured, streamline, reEngine, reframework, reEngineHotfix };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});

    return { ok: true, updated: true, file: path.basename(active.file), api, autoConfigured, streamline, reEngine, reframework, reEngineHotfix };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Proxy install / removal, without the terminal ─────────────────────────────
//
// Copying the release in does not make a game load OptiScaler: the DLL has to be renamed to
// something the game already loads. setup_windows.bat did that, which is why installing was two
// steps -- click Install, then click Run Setup and answer seven prompts in a console window. The
// app then had no idea whether any of it worked, so the badge and reality drifted apart.
//
// This does the same rename directly. The prompts the script asks are all things the app already
// knows or has a sane default for.

const INSTALL_MARKER = '.optiscaler-manager-install.json';

// dxgi.dll is what the script offers as option 1 and what nearly every DX11/DX12/Vulkan game on
// Windows already loads.
const DEFAULT_PROXY = 'dxgi.dll';

function readInstallMarker(dir) {
  return readJson(path.join(dir, INSTALL_MARKER), null);
}

// Renames OptiScaler.dll to the proxy name, preserving anything already using that name.
//
// The backup rule is deliberately more cautious than the script's: if a backup already exists this
// refuses instead of overwriting it. The script does `del /F` on the old backup first, so
// installing twice over a game that shipped its own dxgi.dll destroys the original permanently on
// the second run. Refusing is recoverable; deleting someone's file is not.
async function installProxy(dir, proxyName = DEFAULT_PROXY) {
  if (!PROXY_CANDIDATES.includes(proxyName)) {
    throw new Error(`${proxyName} is not one of the proxy names OptiScaler supports`);
  }

  const active = await findActiveOptiScalerFile(dir);
  if (active && active.renamed) {
    return { proxy: path.basename(active.file), created: false, backedUp: null };
  }

  const source = path.join(dir, 'OptiScaler.dll');
  if (!fs.existsSync(source)) {
    throw new Error('OptiScaler.dll is not in the game folder -- the release copy did not land');
  }

  const target = path.join(dir, proxyName);
  let backedUp = null;

  if (fs.existsSync(target)) {
    const bare = proxyName.replace(/\.[^.]+$/, '');
    const backupName = `${bare}.optiscaler_original_backup`;
    const backup = path.join(dir, backupName);

    if (fs.existsSync(backup)) {
      throw new Error(
        `${proxyName} already exists here and so does ${backupName}. Refusing to overwrite the ` +
          'backup -- that would destroy the original for good. Sort those two files out by hand, ' +
          'or install to a different proxy name.'
      );
    }

    await fsp.rename(target, backup);
    backedUp = backupName;
  }

  await fsp.rename(source, target);

  // What we did, so removal reverses exactly this rather than inferring it from what is lying
  // around. The generated uninstaller has to guess, which is why it can hijack a hand-made setup.
  writeJson(path.join(dir, INSTALL_MARKER), {
    proxy: proxyName,
    backedUp,
    installedAt: new Date().toISOString()
  });

  return { proxy: proxyName, created: true, backedUp };
}

// Reverses installProxy and clears out what the app copied in.
//
// Never deletes a file at a proxy name without confirming it is actually OptiScaler: if someone
// renamed things by hand in between, the honest outcome is to leave their file alone and say so.
async function uninstallOptiScaler(dir) {
  const removed = [];
  const kept = [];
  const marker = readInstallMarker(dir);

  const active = await findActiveOptiScalerFile(dir);
  const proxyPath = active && active.renamed
    ? active.file
    : (marker && marker.proxy ? path.join(dir, marker.proxy) : null);

  if (proxyPath && fs.existsSync(proxyPath)) {
    if (active && active.renamed && path.resolve(active.file) === path.resolve(proxyPath)) {
      await fsp.rm(proxyPath, { force: true });
      removed.push(path.basename(proxyPath));
    } else {
      kept.push(
        `${path.basename(proxyPath)} (does not identify itself as OptiScaler -- left alone)`
      );
    }
  }

  if (marker && marker.backedUp) {
    const backup = path.join(dir, marker.backedUp);
    const restoreTo = path.join(dir, marker.proxy);
    if (fs.existsSync(backup) && !fs.existsSync(restoreTo)) {
      await fsp.rename(backup, restoreTo);
      removed.push(`restored ${marker.proxy}`);
    }
  }

  for (const name of ['OptiScaler.dll', 'OptiScaler.ini', 'OptiScaler.log', 'nvngx.dll_dlssnr.dll',
                      'Remove_OptiScaler.bat', 'setup_windows.bat', 'setup_linux.sh', INSTALL_MARKER]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) {
      await fsp.rm(f, { force: true });
      if (name !== INSTALL_MARKER) removed.push(name);
    }
  }

  const nrDllRemoved = await removeSharedNrDllIfUnneeded(dir);
  if (nrDllRemoved) removed.push('nvngx_dlssnr.dll');

  return { removed, kept, nrDllRemoved };
}

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
