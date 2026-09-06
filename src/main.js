const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');

// Game-library discovery. library.js is lifted verbatim from DLSS5-Swapper (MIT, see
// LICENSE-DLSS5-Swapper.txt) so it can be refreshed from upstream without a merge; discover.js is
// ours, and turns the folders it finds into the executables this app installs against.
const { scanForGames } = require('./discover');
const feeder = require('./feeder');
const { installFeederNative } = require('./native-feeder/install');
const { getBitness, findMarkers } = require('./native-feeder/pe');
const { resolveGithubAsset, downloadToCache } = require('./native-feeder/download');
const { openZip, findEntry, extractEntryTo } = require('./native-feeder/zip');
const { FEEDER_RELEASES_API, FEEDER_ASSET_PATTERN } = require('./native-feeder/sources');
const { getIniKey } = require('./native-feeder/ini-merge');
const { extractReShadeDll } = require('./native-feeder/reshade');
const execFileAsync = promisify(execFile);

const RELEASES_API = 'https://api.github.com/repos/mrcgibb9876-hash/OptiScaler_DLSSNR/releases/latest';
const GITHUB_HEADERS = { 'User-Agent': 'OptoRenoDXlss5', Accept: 'application/vnd.github+json' };

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
  const settings = readJson(settingsFile(), {
    releaseFolder: '',
    nrDllPath: '',
    installedVersion: '',
    renoDxAddonPath: '',
    streamlineZipPath: '',
    dfcZipPath: ''
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

// ---------- library discovery ----------

// Finds installed games rather than making the user point at each executable by hand.
//
// Steam, Epic and GOG are cheap: they are read from libraryfolders.vdf and the registry, so this
// covers every Steam library on every drive without touching the disks themselves.
//
// scanDrives is the expensive one -- it walks all fixed drives looking for game-shaped folders --
// so it is opt-in and must stay that way. On a large library over a spinning disk it takes real
// time, and running it unasked on first launch would make the app feel broken.
//
// Nothing here writes anything or touches the network; it is a pure read of the local filesystem.
ipcMain.handle('library:scan', async (_evt, options) => {
  const { extraFolders = [], scanDrives = false, excludedRoots = [], knownExePaths = [] } = options || {};

  try {
    return { ok: true, ...scanForGames({ extraFolders, scanDrives, excludedRoots, knownExePaths }) };
  } catch (error) {
    // A scan that throws must not take the window with it. An unreadable drive, a permission-denied
    // folder or a launcher that is not installed are all normal, and the user should be told rather
    // than left with a spinner.
    return { ok: false, error: String(error && error.message ? error.message : error), games: [], roots: [] };
  }
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

ipcMain.handle('pick:addon', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Select renodx-dlss5.addon64',
    properties: ['openFile'],
    filters: [{ name: 'ReShade add-on', extensions: ['addon64', 'addon32', 'addon'] }]
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

// setup_windows.bat ships in upstream OptiScaler too, so its presence alone doesn't tell this
// fork's DLSS-NR build apart from a plain OptiScaler zip someone grabbed from the real upstream
// project -- both install fine and neither errors, which is exactly how a wrong build goes
// unnoticed until the in-game DLSS-NR settings simply aren't there. [DlssNr] in the release's own
// OptiScaler.ini template is this fork's actual differentiator (confirmed against a real release).
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

// ---------- install status ----------

function gameDir(exePath) {
  return path.dirname(exePath);
}

// Which DLSS-5 backend(s) are actually active in a game folder, by real file names rather than
// the generic "DLSS 5 Feeder" umbrella term the UI used to show -- OptiScaler, RenoDX and Deep
// Fried Chicken are three different pieces of software with three different DLSS-NR sections and
// tuning surfaces, and a card that just says "Installed" leaves the user guessing which one is
// actually running. Both halves are independent, not mutually exclusive: OptiScaler_DLSSNR hosts
// ReShade's own add-on-loading API once it owns the proxy DLL, so a RenoDX/DFC .addon64 already in
// the folder keeps loading and running alongside it -- confirmed live in a real game's ReShade.log.
// installFeederNative disables a conflicting consumer (RenoDX vs DFC, never OptiScaler) by
// renaming it to *.disabled-by-installer, so an exact-name check here already treats a disabled
// leftover as not active.
function detectInstalledBackends(dir) {
  const has = (name) => fs.existsSync(path.join(dir, name));
  const optiscaler = has('OptiScaler.ini') && has('nvngx_dlssnr.dll');
  const feeder = has('renodx-dlss5.addon64') ? { active: true, route: 'renodx', label: 'RenoDX' }
    : (has('deep-fried-chicken.addon64') || has('dlss5-feed.addon64')) ? { active: true, route: 'dfc', label: 'Deep Fried Chicken' }
    : { active: false, route: null, label: null };
  return { optiscaler, feeder };
}

// Kept for the one place that still wants a single "what's the headline backend" answer (game
// cards' badge) -- OptiScaler wins the headline when both are active, since it's the one whose
// install/uninstall this app fully owns.
function detectActiveRoute(dir) {
  const backends = detectInstalledBackends(dir);
  if (backends.optiscaler) return { route: 'optiscaler', label: 'OptiScaler', both: backends.feeder.active };
  if (backends.feeder.active) return { route: backends.feeder.route, label: backends.feeder.label, both: false };
  return { route: 'none', label: null, both: false };
}

// Two known, documented ways this exact combination crashes RenoDX's own CreateFeature call --
// found by reading a real crash out of dlss5-feed.log/ReShade.log on a live game, not guessed:
//
// 1. "two copies of the DLSS NGX module are loaded (the game-local nvngx_dlss.dll and the
//    driver's _nvngx.dll), and the DLSS 5 add-on hooks both" -- dlss5-feed.log's own diagnostic
//    for the access-violation it caught in renodx-dlss5.addon64's CreateFeature.
// 2. "RenoDX.DLSS5 NRStyle=2 is set -- this crashed at startup on the reference machine" --
//    the feed addon's own startup warning, logged every launch regardless of whether it actually
//    crashes this time.
//
// Neither is something this app ever writes (RenoDX supplies its own NRStyle default; nrDllPath
// is the user's own file, copied in deliberately), so this only warns -- it does not silently
// delete or rewrite either one out from under the user.
function detectFeederWarnings(dir) {
  const warnings = [];
  if (fs.existsSync(path.join(dir, 'renodx-dlss5.addon64')) && fs.existsSync(path.join(dir, 'nvngx_dlss.dll'))) {
    warnings.push({
      code: 'ngxDuplicate',
      message: 'A game-local nvngx_dlss.dll sits next to RenoDX -- with the driver\'s own copy also ' +
        'present, RenoDX hooks both and this has crashed DLSS-5 feature creation on a real install. ' +
        'Try removing the game-local nvngx_dlss.dll, or use a renodx-dlss5 v4.7+ build.'
    });
  }
  const reshadeIni = path.join(dir, 'ReShade.ini');
  if (fs.existsSync(reshadeIni)) {
    try {
      const style = getIniKey(fs.readFileSync(reshadeIni, 'utf8'), 'RenoDX.DLSS5', 'NRStyle');
      if (style === '2') {
        warnings.push({
          code: 'renoDxCrashStyle',
          message: 'ReShade.ini has RenoDX.DLSS5 NRStyle=2 ("Cinematic") -- RenoDX\'s own log flags this ' +
            'as a known startup crash on some machines. Set NRStyle=0 if this game crashes on launch.'
        });
      }
    } catch { /* unreadable ini -- nothing to warn about */ }
  }
  return warnings;
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
  return {
    exeMissing: false, hasIni, hasNr, hasUninstaller, dir,
    activeRoute: detectActiveRoute(dir), backends,
    warnings: backends.feeder.active ? detectFeederWarnings(dir) : []
  };
});

// ---------- install / uninstall ----------

// CORRECTION (this app previously disabled a game's RenoDX/DFC add-on files whenever OptiScaler
// was installed over them, on the assumption the two routes fight over the same proxy DLL and
// can't coexist). OptiScaler_DLSSNR's own reshade_addon/README.md says otherwise: OptiScaler hosts
// ReShade's add-on-loading API itself once it owns the proxy DLL, so a RenoDX/DFC .addon64 already
// sitting in the game folder just keeps loading and running -- confirmed live in ReShade.log on a
// real install (RenoDX and DLSS 5 Feed both loaded and ran after OptiScaler took the dxgi.dll
// slot). Disabling those files was actively counterproductive, not a safety net. Left as a no-op
// wrapper (rather than deleting the call site) so a future real conflict case has somewhere to go;
// nothing currently populates FILES.
const FEEDER_ROUTE_FILES = [];
async function disableFeederRoute(dir, onProgress = () => {}) {
  for (const name of FEEDER_ROUTE_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      await fsp.rename(file, `${file}.disabled-by-installer`);
      onProgress({ kind: 'info', line: `${name} renamed to .disabled-by-installer.` });
    } catch (err) {
      onProgress({ kind: 'warn', line: `Could not disable ${name}: ${err.message}` });
    }
  }
}

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

    // A RenoDX/DFC .addon64 already in this folder is left exactly as-is -- OptiScaler hosts
    // ReShade's own add-on-loading API once it owns the proxy DLL, so it keeps loading and running.
    // See the note on disableFeederRoute above for why this used to (wrongly) disable it first.

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

    // nvngx.dll_dlssnr.dll (a small shim, not the model itself -- easy to mistake for nvngx_dlssnr.dll
    // above at a glance) ships inside the release folder and is supposed to land via the copy-everything
    // loop above, but setup_windows.bat never copies it itself (it only prints a reminder that it "ships
    // in this package"), and an incomplete/older release folder can genuinely be missing it. Left
    // unnoticed, the game shows "nvngx.dll_dlssnr.dll is missing" in its own DLSS-NR panel later, which
    // reads as a driver problem rather than an install one. Catch it here instead.
    if (!fs.existsSync(path.join(dir, 'nvngx.dll_dlssnr.dll')) && fs.existsSync(path.join(releaseFolder, 'nvngx.dll_dlssnr.dll'))) {
      throw new Error('nvngx.dll_dlssnr.dll did not copy from the release folder -- copy may have failed, try again');
    }
    if (!fs.existsSync(path.join(releaseFolder, 'nvngx.dll_dlssnr.dll'))) {
      throw new Error('The release folder itself is missing nvngx.dll_dlssnr.dll -- it looks incomplete. Re-download it via "Check for Updates" in Settings.');
    }

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
    const { api, applied, streamline, reshadeCoexistence } = await autoConfigureGame(dir, exePath);

    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, api, autoConfigured: applied, streamline, reshadeCoexistence };
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

// nvngx_dlssnr.dll is NVIDIA's ~165 MB model file -- neither route's own uninstaller (the
// generated Remove_OptiScaler.bat, or feeder:uninstall below) ever removed it, since this app is
// the one that copies it in (from the user's own supplied file, never the game's), not either
// upstream project. Left behind, it's dead weight in the game folder after every uninstall. Safe
// to remove unconditionally when NO backend needs it any more; if the other backend is still
// active, it still needs this same file, so it's left alone.
async function removeSharedNrDllIfUnneeded(dir, exclude) {
  const backends = detectInstalledBackends(dir);
  const stillNeeded = exclude === 'optiscaler' ? backends.feeder.active : backends.optiscaler;
  if (stillNeeded) return false;
  const file = path.join(dir, 'nvngx_dlssnr.dll');
  if (!fs.existsSync(file)) return false;
  await fsp.rm(file);
  return true;
}

// The DLSS 5 tuning add-on (OptiScaler_DlssNr.addon64) and the ReShade64.dll ensureReShadeCoexistence
// deployed for it are OptiScaler-only additions this app makes -- Remove_OptiScaler.bat doesn't
// know about either, so they're left behind after an OptiScaler removal same as nvngx_dlssnr.dll
// was. Only removes ReShade64.dll if the Feeder route isn't also relying on it (it never is today --
// that route uses dxgi.dll/opengl32.dll directly -- but this stays a real check rather than an
// assumption in case that changes).
async function removeOptiScalerTuningExtras(dir) {
  const removed = [];
  const addon = path.join(dir, 'OptiScaler_DlssNr.addon64');
  if (fs.existsSync(addon)) { await fsp.rm(addon); removed.push('OptiScaler_DlssNr.addon64'); }
  const reshade64 = path.join(dir, 'ReShade64.dll');
  if (fs.existsSync(reshade64) && findMarkers(reshade64, ['ReShade']).size > 0) {
    await fsp.rm(reshade64);
    removed.push('ReShade64.dll');
  }
  return removed;
}

ipcMain.handle('game:run-uninstall', async (_evt, exePath) => {
  const dir = gameDir(exePath);
  // Remove_OptiScaler.bat is what setup_windows.bat actually generates; the other two names are
  // kept in case a future release renames it, so this doesn't silently break again.
  const candidates = ['Remove_OptiScaler.bat', 'uninstall_optiscaler.bat', 'uninstaller.bat'];
  const found = candidates.find((c) => fs.existsSync(path.join(dir, c)));
  if (!found) return { ok: false, error: 'No uninstaller script found in game folder.' };
  spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', found], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: false
  }).unref();
  // Independent of the spawned script above (which only knows upstream OptiScaler's own files) --
  // removable right away since it doesn't depend on the interactive uninstaller finishing.
  const nrDllRemoved = await removeSharedNrDllIfUnneeded(dir, 'optiscaler');
  const tuningExtrasRemoved = await removeOptiScalerTuningExtras(dir);
  return { ok: true, nrDllRemoved, tuningExtrasRemoved };
});

// Removes whichever ReShade-based backend (RenoDX or Deep Fried Chicken) is active for a game.
// Unlike OptiScaler, this route has no generated uninstaller script of its own to run, so this app
// removes its own files directly rather than leaving "no uninstall RenoDX" as a real gap.
//
// Deletes rather than renames-to-.disabled: unlike installFeederNative's conflict guard (which
// disables a file this app might reinstall moments later in the same flow), this is the user
// explicitly asking to remove it, and a renamed-not-deleted file left lying around would just
// confuse the next install attempt or a future scan.
//
// Only removes the ReShade proxy DLL itself (dxgi.dll/opengl32.dll/etc.) when OptiScaler is not
// also active in this folder -- OptiScaler hosts these add-ons through its own proxy once it owns
// one (see the note on detectInstalledBackends above), so touching the proxy would break OptiScaler
// too. Verified via a raw byte scan for the "ReShade" version string, the cheapest reliable way to
// tell "this dxgi.dll is ReShade" from "this dxgi.dll is OptiScaler" without a full PE version
// resource parser.
const RESHADE_PROXY_CANDIDATES = ['dxgi.dll', 'opengl32.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll'];
const FEEDER_CONSUMER_FILES = [
  'renodx-dlss5.addon64', 'renodx-dlss5.addon64.disabled-by-installer',
  'dlss5-feed.addon64', 'dlss5-feed.addon64.disabled-by-installer',
  'deep-fried-chicken.addon64', 'deep-fried-chicken-nvngx.dll', 'deep-fried-chicken.cfg'
];
ipcMain.handle('feeder:uninstall', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const backends = detectInstalledBackends(dir);
    if (!backends.feeder.active) return { ok: false, error: 'No RenoDX/Deep Fried Chicken install found for this game.' };

    const removed = [];
    for (const name of FEEDER_CONSUMER_FILES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) { await fsp.rm(file); removed.push(name); }
    }
    const fxFile = path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx');
    if (fs.existsSync(fxFile)) { await fsp.rm(fxFile); removed.push('reshade-shaders/Shaders/DLSS5_Feed.fx'); }

    if (!backends.optiscaler) {
      for (const name of RESHADE_PROXY_CANDIDATES) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        if (findMarkers(file, ['ReShade']).size === 0) continue; // not ReShade -- leave it alone
        const original = `${file}.original`;
        if (fs.existsSync(original)) {
          await fsp.rm(file);
          await fsp.rename(original, file);
          removed.push(`${name} (restored original)`);
        } else {
          await fsp.rm(file);
          removed.push(name);
        }
      }
    }

    if (await removeSharedNrDllIfUnneeded(dir, 'feeder')) removed.push('nvngx_dlssnr.dll');

    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- DLSS5-Feeder / RenoDX (a separate ReShade-addon toolchain from OptiScaler's own
// embedded DLSS-NR hook -- installs ReShade itself, the feeder addon, LumeniteFX and the chosen
// neural consumer via jlrouzies-fr/DLSS5-Feeder's own installer script). This app prepares the
// local files and hands back the command to run; it does not download or execute the third-party
// script itself. ----------

// The zip is a flat dump of NVIDIA driver-package DLLs, not just Streamline's own bin/x64 layout
// (it also carries nvngx_dlss.dll/nvngx_dlssnr.dll), so this searches for the two by name rather
// than assuming a path, the same way ensureStreamlineSdkCache locates sl.interposer.dll.
async function extractDlssRuntimeDlls(zipPath) {
  const tmpExtract = path.join(os.tmpdir(), `dlss5-feeder-runtime-${Date.now()}`);
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
  ], { env: { ...process.env, OSM_ZIP: zipPath, OSM_DEST: tmpExtract } });

  const found = { dir: tmpExtract };
  const stack = [tmpExtract];
  while (stack.length > 0 && !(found.dlssNr && found.dlss)) {
    const cur = stack.pop();
    for (const entry of await fsp.readdir(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.toLowerCase() === 'nvngx_dlssnr.dll') {
        found.dlssNr = full;
      } else if (entry.name.toLowerCase() === 'nvngx_dlss.dll') {
        found.dlss = full;
      }
    }
  }
  return found;
}

// The manual path, kept as a fallback: prepares local inputs and writes a launcher the user runs
// themselves. 'feeder:install' below does the same thing unattended and is what the UI reaches for
// first; this one is for a machine where running a downloaded script from inside the app is not
// wanted, or where that run failed and the user wants to drive it by hand.
ipcMain.handle('game:prepare-dlss5-feeder', async (_evt, { exePath, renoDxAddonPath, streamlineZipPath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    if (!renoDxAddonPath || !fs.existsSync(renoDxAddonPath)) {
      throw new Error(`renodx-dlss5.addon64 not found at "${renoDxAddonPath || '(not set)'}" — set it in Settings`);
    }

    const dir = gameDir(exePath);
    const parts = [
      '.\\Install-DLSS5Feeder.ps1',
      '-GameExe', `"${exePath}"`,
      '-Consumer', 'RenoDX',
      '-RenoDxAddon', `"${renoDxAddonPath}"`
    ];

    let runtimeNote = '';
    if (streamlineZipPath && fs.existsSync(streamlineZipPath)) {
      const { dlssNr, dlss } = await extractDlssRuntimeDlls(streamlineZipPath);
      const gameHasDlss = fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));
      if (dlssNr) parts.push('-DlssNrDll', `"${dlssNr}"`);
      if (dlss && !gameHasDlss) parts.push('-DlssDll', `"${dlss}"`);
      runtimeNote = dlssNr || (dlss && !gameHasDlss)
        ? ' Extracted the DLSS/DLSSNR runtime from the configured zip, so the launcher uses those ' +
          'instead of the script\'s own (expiring) Discord links.'
        : '';
      if (dlss && gameHasDlss) {
        runtimeNote += ' This game already has its own nvngx_dlss.dll, so -DlssDll was left out -- not overwriting it.';
      }
    }

    const command = `powershell.exe -ExecutionPolicy Bypass -File ${parts.join(' ')}`;

    // A double-click launcher instead of a paste-into-terminal step: classic cmd.exe windows
    // don't reliably support Ctrl+V, and this needs Install-DLSS5Feeder.ps1 to exist here first
    // anyway (that part is left to the user -- see the note below -- since fetching and running a
    // third-party script from this app's own code is exactly the shape sandboxed dev environments
    // block on sight). Writing this .bat is just a text file, no different from setup_windows.bat
    // writing Remove_OptiScaler.bat.
    const launcherPath = path.join(dir, 'Run-DLSS5-Feeder-Install.bat');
    const launcherContent = `@echo off\r\ncd /d "%~dp0"\r\n${command}\r\npause\r\n`;
    await fsp.writeFile(launcherPath, launcherContent, 'utf-8');

    shell.openPath(dir);

    return {
      ok: true,
      dir,
      launcherPath,
      command,
      note: `Opened the game folder and wrote Run-DLSS5-Feeder-Install.bat there.${runtimeNote} ` +
        'Download Install-DLSS5Feeder.ps1 from github.com/jlrouzies-fr/DLSS5-Feeder ' +
        '(tools/Install-DLSS5Feeder.ps1) into that same folder, then double-click the .bat ' +
        '-- no pasting needed.'
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The same install, run for the user instead of handed to them.
//
// This resolves the two NVIDIA runtime DLLs from what the user has already supplied -- the path in
// Settings, or the Streamline zip -- and passes them to the script explicitly. That is the whole
// point of doing it here: given local paths the script uses them and never reaches for its own
// Discord CDN copies of files that are NVIDIA's and not redistributable. If the user has not
// supplied nvngx_dlssnr.dll, this refuses rather than quietly fetching one for them.
//
// Everything else -- ReShade, the feeder add-on, LumeniteFX, dgVoodoo2 for Direct3D 8/9, and the
// .ini wiring -- the script fetches from its real sources, and that is fine to automate.
ipcMain.handle('feeder:install', async (evt, payload) => {
  const { exePath, consumer, mvProvider, nrDllPath, streamlineZipPath, renoDxAddonPath, dfcZipPath } = payload || {};

  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');

    // No exclusivity check here: an active OptiScaler install hosts a RenoDX/DFC .addon64 sitting
    // in the same folder rather than fighting it for the proxy DLL -- see the note on
    // disableFeederRoute above. Installing this route alongside OptiScaler is a supported
    // combination, not a conflict to warn about.

    let resolvedNr = nrDllPath && fs.existsSync(nrDllPath) ? nrDllPath : '';
    let resolvedDlss = '';
    let extractedTo = '';

    // The zip is the more common way in: Streamline ships both runtimes, and someone who already
    // configured it should not have to point at either DLL a second time. An explicitly set
    // nrDllPath still wins -- it is the more deliberate of the two.
    if (streamlineZipPath && fs.existsSync(streamlineZipPath)) {
      const { dlssNr, dlss, dir } = await extractDlssRuntimeDlls(streamlineZipPath);
      extractedTo = dir;
      resolvedNr = resolvedNr || dlssNr || '';
      resolvedDlss = dlss || '';
    }

    // Progress goes back over the same channel the renderer is already listening on, so a long
    // install shows its work rather than sitting behind a spinner for two minutes.
    const send = (update) => {
      if (!evt.sender.isDestroyed()) evt.sender.send('feeder:progress', { exePath, ...update });
    };

    // Plain DLSS is common enough that a game frequently already ships its own nvngx_dlss.dll --
    // unlike nvngx_dlssnr.dll (rarely native, and the whole point of this install), handing the
    // script a copy here risks it landing next to the driver's own _nvngx.dll, which is exactly
    // the "two copies of the DLSS NGX module loaded" condition that crashed RenoDX's CreateFeature
    // on a real install (see detectFeederWarnings). Not supplying one at all when the game already
    // has one leaves it to the script's own documented merge-not-replace behavior instead of this
    // app actively feeding it a DLL to overwrite with.
    if (resolvedDlss && fs.existsSync(path.join(gameDir(exePath), 'nvngx_dlss.dll'))) {
      send({ kind: 'info', line: 'nvngx_dlss.dll already present in this game -- not supplying a copy, leaving it as-is.' });
      resolvedDlss = '';
    }

    try {
      const detected = await detectInstallPath(gameDir(exePath), exePath);
      const bits = getBitness(exePath);
      const nativeSupported = consumer !== 'RenoDX' && bits === 64 && ['dx11', 'dx12', 'dx10', 'opengl'].includes(detected.api);

      if (nativeSupported) {
        send({ kind: 'info', line: `${detected.api.toUpperCase()}, 64-bit: installing natively (no PowerShell involved).` });
        return await installFeederNative(
          {
            exePath,
            api: detected.api,
            mvProvider,
            nrDllPath: resolvedNr,
            dlssDllPath: resolvedDlss,
            dfcZipPath: dfcZipPath && fs.existsSync(dfcZipPath) ? dfcZipPath : '',
            cacheDir: path.join(userDataDir(), 'feeder-cache-native')
          },
          send
        );
      }

      // Everything the native installer above doesn't cover -- RenoDX (any bitness), Vulkan,
      // 32-bit D3D, and Direct3D 8/9 (dgVoodoo2) -- still gets a real automatic install: feeder.js
      // drives DLSS5-Feeder's own Install-DLSS5Feeder.ps1 unattended (-Yes -NoPause), the same
      // script the manual path just hands to the user to run by hand, with the same
      // redistribution guard (refuses rather than letting the script fetch NVIDIA's DLL itself)
      // and the same download-integrity checks (pinned release, sha256 re-check right before
      // exec). This used to dead-end here with "use manual instead" even though that code already
      // existed and was tested -- it just was never called.
      send({ kind: 'info', line: `${detected.api ? detected.api.toUpperCase() : 'Unknown API'}${consumer === 'RenoDX' ? ', RenoDX' : ''}: running DLSS5-Feeder's own installer unattended.` });
      const feederApi = { dx11: 'D3D', dx12: 'D3D', dx10: 'D3D', vulkan: 'Vulkan', opengl: 'OpenGL', dx9: 'D3D9', dx8: 'D3D8' }[detected.api] || 'Auto';
      const result = await feeder.installForGame(
        {
          exePath,
          api: feederApi,
          consumer: consumer || 'DFC',
          mvProvider,
          nrDllPath: resolvedNr,
          dlssDllPath: resolvedDlss,
          renoDxAddonPath: renoDxAddonPath && fs.existsSync(renoDxAddonPath) ? renoDxAddonPath : '',
          cacheDir: path.join(userDataDir(), 'feeder-cache-script')
        },
        send
      );
      return result;
    } finally {
      // The unpacked zip is hundreds of megabytes and the DLL paths inside it have to stay valid
      // until it has been copied, so this cannot live inside extractDlssRuntimeDlls. Without it
      // every install leaves another full copy in %TEMP%.
      if (extractedTo) await fsp.rm(extractedTo, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// "Remove" in this app previously only forgot the game (deleted its games.json entry) without
// touching any installed files, which reads as "delete" but silently leaves OptiScaler (and,
// separately, any DLSS5-Feeder toolchain) still active in the game's folder. Ask what the user
// actually wants instead of guessing.
ipcMain.handle('game:confirm-remove', async (_evt, gameName) => {
  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Remove OptiScaler + forget game', 'Just forget game (keep files)', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Remove game',
    message: `Remove "${gameName}" from OptoRenoDXlss5?`,
    detail: 'Removing OptiScaler runs its uninstaller in a terminal you confirm yourself (same as ' +
      'Run Setup) -- it does not touch a separately installed DLSS5-Feeder/ReShade toolchain, if ' +
      'you set that up for this game; use its own uninstall steps for that.'
  });
  return ['remove-and-forget', 'forget-only', 'cancel'][res.response] || 'cancel';
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

// Which of the two install paths a game should take, and why.
//
// detectRenderApi above answers only the three APIs OptiScaler can configure, because that is all
// the ini needs. Choosing a path needs to tell "an API OptiScaler cannot reach" apart from "could
// not tell", which are very different answers: the first means use the Feeder, the second means
// say so and let the user decide. So this looks for the older APIs too.
const OLD_API_MARKERS = [
    ['dx9', ['d3d9.dll', 'd3d8.dll']],
    ['dx10', ['d3d10.dll', 'd3d10core.dll']],
    ['opengl', ['opengl32.dll']]
];

async function detectInstallPath(dir, exePath) {
  const api = await detectRenderApi(dir, exePath);

  // OptiScaler intercepts the game's own upscaler, so it needs one of these three.
  if (api === 'vulkan' || api === 'dx12' || api === 'dx11') {
    return { api, recommend: 'optiscaler', reason: `${api.toUpperCase()} — OptiScaler hooks this directly` };
  }

  // Nothing modern found. Look for something old before concluding anything: a D3D9 game is a
  // Feeder job, whereas an exe we simply could not read is not a conclusion at all.
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
      return { api: old, recommend: 'feeder', reason: `${old.toUpperCase()} — OptiScaler has no hook here` };
    }
  }

  // Read it fine, recognised nothing. Packed or bundled exes land here, and guessing at this point
  // would be worse than saying so.
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

function streamlineSdkLocalCacheDir() {
  return path.join(userDataDir(), 'streamline-sdk-local');
}

// Downloads and caches once per app install -- subsequent calls are a no-op if the cache already
// matches STREAMLINE_SDK_VERSION (a version marker file, not just file presence, so a cache left
// over from before this version was pinned gets replaced rather than silently reused). Returns
// the cache directory, or null if the fetch failed (offline, GitHub rate limit, etc.) -- callers
// treat that as non-fatal and just skip deploying it this time.
// A configured local zip (Settings > Streamline SDK zip) takes priority over the pinned
// auto-download -- it's how a version newer than STREAMLINE_SDK_VERSION gets used without
// waiting on this file to be re-pinned and rebuilt against. Cached separately by content hash
// (not the pinned version string), so pointing Settings at a different zip later is picked up
// without deleting anything by hand.
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
    await fsp.writeFile(versionMarker, wantVersion, 'utf-8');
    return cacheDir;
  } catch {
    return null; // Offline, rate-limited, bad zip, etc. -- non-fatal, just try again next sync.
  } finally {
    if (tmpZip && !usingLocal) fsp.rm(tmpZip, { force: true }).catch(() => {});
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

// Frame Gen output/input are only wired up for Dx11/Dx12 in this build -- the menu's own
// Vulkan-disables everything gate (see upstream RenderFrameGenerationSelection) no longer runs
// at all, since the overlay was stripped down to just the DLSS NR panel, so nothing resets an
// unsupported choice at runtime any more. Leaving Frame Gen untouched on Vulkan avoids silently
// switching on something the game has no working path for and no in-game control to undo.
// OptiScaler_DlssNr.addon64 (the DLSS 5 tuning panel that draws inside ReShade's own overlay --
// see OptiScaler/dlssnr/reshade_addon/README.md in the engine repo) only shows up if a real
// ReShade is actually loaded alongside OptiScaler: its own docs say to rename ReShade's DLL to
// ReShade64.dll and set LoadReShade=true under [Plugins] in OptiScaler.ini. Copying the addon file
// alone (which the plain release-folder copy in game:install already does) isn't enough on its
// own -- without this, the addon sits in the folder with nothing to load it. Reuses a Feeder
// route's own ReShade proxy already in the folder rather than fetching a second copy where one
// already exists.
async function ensureReShadeCoexistence(dir) {
  if (!fs.existsSync(path.join(dir, 'OptiScaler_DlssNr.addon64'))) return null; // engine build predates this addon
  const reshade64 = path.join(dir, 'ReShade64.dll');
  if (fs.existsSync(reshade64)) return { deployed: false, reason: 'already present' };

  let source = null;
  for (const name of RESHADE_PROXY_CANDIDATES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && findMarkers(candidate, ['ReShade']).size > 0) { source = candidate; break; }
  }
  if (source) {
    await fsp.copyFile(source, reshade64);
    return { deployed: true, reason: `copied from ${path.basename(source)}` };
  }
  try {
    await extractReShadeDll({ cacheDir: path.join(userDataDir(), 'feeder-cache-native'), bits: 64, destPath: reshade64 });
    return { deployed: true, reason: 'fetched fresh' };
  } catch (err) {
    return { deployed: false, reason: `could not fetch ReShade: ${err.message}` };
  }
}

async function autoConfigureGame(dir, exePath) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return { api: null, applied: [] };

  const api = await detectRenderApi(dir, exePath);
  const edits = [];
  const reshadeCoexistence = await ensureReShadeCoexistence(dir);
  if (reshadeCoexistence) edits.push({ section: 'Plugins', key: 'LoadReShade', value: 'true' });

  if (api === 'dx12') edits.push({ section: 'Upscalers', key: 'Dx12Upscaler', value: 'dlss' });
  else if (api === 'dx11') edits.push({ section: 'Upscalers', key: 'Dx11Upscaler', value: 'dlss' });
  else if (api === 'vulkan') edits.push({ section: 'Upscalers', key: 'VulkanUpscaler', value: 'dlss' });

  edits.push({ section: 'DlssNr', key: 'Enabled', value: 'true' });

  // FGOutput=dlssg (real NVIDIA DLSS-G, the only backend the overlay's Frame Generation section
  // is wired to -- fsrfg/xefg are deliberately left out of that panel). OptiScaler's own
  // StreamlineProxy::LoadStreamline() reuses the game's already-loaded native sl.interposer.dll
  // when one exists (the same "already in memory" detection dllmain.cpp's startup scan does) and
  // only falls back to loading OptiScaler's own bundled copy from OptiScaler/streamline for a
  // game with no native Streamline of its own -- so this is safe to default on either way. (An
  // earlier version of LoadStreamline() always loaded its own separate copy regardless, which on
  // a game with native Streamline gave the driver two independent Reflex instances fighting over
  // its single global Reflex state -- reproduced live as a hard crash on The Witcher 3. Fixed at
  // the source level; this app only needs to keep the OptiScaler/streamline SDK folder deployed
  // for the no-native-Streamline case that still needs it.)
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
  return { api, applied, streamline, reshadeCoexistence };
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
    const { api, applied: autoConfigured, streamline, reshadeCoexistence } = await autoConfigureGame(dir, exePath);

    const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
    if (!releaseDll || !fs.existsSync(releaseDll)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'no release set', api, autoConfigured, streamline, reshadeCoexistence };
    }

    // This runs unattended on every launch and every Settings change (autoSyncStaleGames), silently
    // overwriting an already-working game install -- so if the release folder has ever pointed at
    // plain upstream OptiScaler (same setup_windows.bat, no error, no [DlssNr] section), every game
    // would get quietly downgraded to it without the install button ever being touched again.
    if (!hasDlssNrSection(releaseFolder)) {
      return {
        ok: true, updated: autoConfigured.length > 0,
        reason: 'release folder is not the DLSS-NR fork (no [DlssNr] section) -- refusing to sync', api, autoConfigured, streamline, reshadeCoexistence
      };
    }

    const active = await findActiveOptiScalerFile(dir);
    if (!active) {
      return {
        ok: true, updated: autoConfigured.length > 0,
        reason: 'could not identify the active OptiScaler file (ambiguous proxy candidates)', api, autoConfigured, streamline, reshadeCoexistence
      };
    }

    if (sha256File(releaseDll) === sha256File(active.file)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'up to date', api, autoConfigured, streamline, reshadeCoexistence };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});

    return { ok: true, updated: true, file: path.basename(active.file), api, autoConfigured, streamline, reshadeCoexistence };
  } catch (err) {
    // Most common cause: the game is currently running and has the DLL locked.
    return { ok: false, error: err.message };
  }
});

// ---------- Feeder-toolchain staleness sync (Deep Fried Chicken / DFC route) ----------
// dlss5-feed.addon64 + DLSS5_Feed.fx always come from the latest jlrouzies-fr/DLSS5-Feeder release
// at install time (resolveGithubAsset re-checks GitHub on every install call), so a *new* install
// is never stale -- but a game installed months ago just keeps whatever was latest back then, with
// nothing to ever notice a newer release exists later. This closes that gap the same way
// game:sync-if-stale does for OptiScaler: on every launch, compare what is actually in the game
// folder against the latest release and refresh it in place if different.
//
// RenoDX and Deep Fried Chicken's own consumer files are deliberately NOT covered here (see
// native-feeder/sources.js's and feeder.js's top comments): both come from expiring Discord CDN
// links that are not this app's to redistribute or poll versions of, so they stay user-supplied
// via Settings with no auto-update path -- by design, not an oversight.
ipcMain.handle('feeder:sync-if-stale', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: true, updated: false, reason: 'exe missing' };
    const dir = gameDir(exePath);
    const addonPath = path.join(dir, 'dlss5-feed.addon64');
    if (!fs.existsSync(addonPath)) return { ok: true, updated: false, reason: 'not installed (DFC route)' };

    const cacheDir = path.join(userDataDir(), 'feeder-cache-native');
    const feederAsset = await resolveGithubAsset(FEEDER_RELEASES_API, FEEDER_ASSET_PATTERN);
    const zipPath = await downloadToCache(feederAsset.url, cacheDir, feederAsset.name);
    const zip = openZip(zipPath);

    const addonEntry = findEntry(zip, /(^|\/)dlss5-feed\.addon64$/i);
    if (!addonEntry) return { ok: true, updated: false, reason: 'dlss5-feed.addon64 not found in latest release' };

    const tmpAddon = path.join(os.tmpdir(), `dlss5-feed-check-${Date.now()}.addon64`);
    extractEntryTo(zip, addonEntry, tmpAddon);
    const stale = sha256File(tmpAddon) !== sha256File(addonPath);

    if (stale) {
      await fsp.copyFile(tmpAddon, addonPath);
      const fxEntry = findEntry(zip, /(^|\/)DLSS5_Feed\.fx$/i);
      const shaderDir = path.join(dir, 'reshade-shaders', 'Shaders');
      if (fxEntry && fs.existsSync(shaderDir)) extractEntryTo(zip, fxEntry, path.join(shaderDir, 'DLSS5_Feed.fx'));
    }
    await fsp.rm(tmpAddon, { force: true }).catch(() => {});

    return { ok: true, updated: stale, tag: feederAsset.tag };
  } catch (err) {
    // Offline, rate-limited, or the game is running and has the addon locked -- non-fatal, retry
    // next launch.
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
