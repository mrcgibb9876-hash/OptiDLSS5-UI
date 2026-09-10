const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');

const { scanForGames } = require('./discover');
const framegen = require('./framegen');
const injector = require('./injector');
const feeder = require('./feeder');
const lossless = require('./lossless');
const lumaue = require('./lumaue');
const ENGINE_KNOWN_GAMES = new Set(require('./engine-known-games.json').exeNames);
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

// The DLSS Frame Generation (nvngx_dlssg.dll) builds RHI currently publishes, newest first,
// for the per-game version dropdown. Shares getRhiManifest with the Streamline fetch above --
// see the comment on getRhiManifest.
ipcMain.handle('framegen:versions', async () => {
  try {
    const releases = await framegen.getFrameGenReleases(getRhiManifest, compareStreamlineVersions);
    return { ok: true, versions: releases.map((r) => r.version) };
  } catch (error) {
    return { ok: false, versions: [], error: String(error && error.message ? error.message : error) };
  }
});

// Whether this game has a frame-gen DLL to version at all, whether the Manager has already
// swapped it, and what version is currently in the folder.
ipcMain.handle('framegen:state', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { hasFrameGen: false };
  const dir = gameDir(exePath);
  const state = framegen.frameGenSwapState(dir);
  if (state.hasFrameGen) {
    state.currentVersion = await framegen.readDllVersion(execFileAsync, path.join(dir, state.dll));
  }
  return state;
});

ipcMain.handle('framegen:swap', async (_evt, { exePath, version }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const releases = await framegen.getFrameGenReleases(getRhiManifest, compareStreamlineVersions);
    const release = releases.find((r) => r.version === version);
    if (!release) throw new Error(`Version ${version} not found in the manifest`);
    const sourceDll = await framegen.ensureFrameGenDllCache(release, {
      cacheRoot: path.join(userDataDir(), 'framegen-dll-cache'),
      execFileAsync,
      ghHeaders: GITHUB_HEADERS,
    });
    const result = await framegen.swapFrameGenDll(dir, sourceDll);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('framegen:restore', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const result = await framegen.restoreFrameGenDll(dir);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Everything Launch mode: Injector needs, or the real reason it can't run yet, so the UI
// can show an explanation instead of a dead button.
ipcMain.handle('injector:readiness', (_evt, { releaseFolder } = {}) => {
  return injector.injectorReadiness({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    releaseFolder,
  });
});

// The Steam Launch Options string to paste into Properties -> Launch Options. Copy-paste
// only -- see the header comment in injector.js for why this doesn't auto-write
// localconfig.vdf.
ipcMain.handle('injector:steamOption', (_evt, { releaseFolder } = {}) => {
  const readiness = injector.injectorReadiness({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    releaseFolder,
  });
  if (!readiness.ready) return { ok: false, error: readiness.reason };
  return { ok: true, launchOption: injector.steamLaunchOption(readiness.injectorExe, readiness.dllPath) };
});

// Non-Steam "Launch now": spawn the game through the injector directly, detached.
ipcMain.handle('injector:launch', async (_evt, { exePath, releaseFolder } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const readiness = injector.injectorReadiness({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appRoot: app.getAppPath(),
      releaseFolder,
    });
    if (!readiness.ready) throw new Error(readiness.reason);
    // Await the injector itself (not the game -- the injector exits right after injecting),
    // so an anti-cheat refusal, a 32-bit game or an early exit reaches the card as the real
    // reason instead of a false "launched".
    const result = await injector.launchThroughInjector(spawn, {
      injectorExe: readiness.injectorExe,
      dllPath: readiness.dllPath,
      gameExe: exePath,
    });
    if (!result.ok) {
      const detail = result.stderr ? ` (${result.stderr.split('\n').pop()})` : '';
      throw new Error(`${result.reason}${detail}`);
    }
    return { ok: true, reason: result.reason };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

const feederCacheDir = () => path.join(userDataDir(), 'feeder-cache');
const lumaUeCacheDir = () => path.join(userDataDir(), 'lumaue-cache');

// Whether this game needs the Feeder at all (no native DLSS), and what's already deployed --
// same "explain, don't just disable" posture as injector:readiness.
//
// needsFeeder() alone isn't enough here: it flips false the moment a Feeder deploy places
// nvngx_dlss.dll (that's correct for needsFeeder's own purpose -- see its own comment -- but
// would make this section vanish from the UI right after the first successful deploy, taking
// the update-check control with it). feederDeployed() covers that: once deployed, stays
// "needed" so the user can still see/update it.
ipcMain.handle('feeder:readiness', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { ready: false, reason: 'Game .exe not found' };
  const dir = gameDir(exePath);
  if (!feeder.needsFeeder(dir) && !feeder.feederDeployed(dir)) {
    return { ready: false, needed: false, reason: 'This game already has native DLSS -- use the DLSS 5 only profile instead, not the Feeder.' };
  }
  const api = await detectRenderApi(dir, exePath);
  return { needed: true, ...feeder.feederReadiness(dir, api) };
});

ipcMain.handle('feeder:mvProviders', () => {
  return feeder.mvProviderList();
});

// A real native dialog showing a provider's actual licence text, for the one MV provider that
// can't be auto-fetched without it (LumeniteFX). Same dialog.showMessageBox pattern as
// game:confirm-remove. Returns the confirmation itself -- feeder:deploy's licenseConfirmed
// param is what this feeds, and deployLumeniteFx() refuses without it regardless, so a
// renderer bug skipping this call can't turn into a silent fetch.
ipcMain.handle('feeder:confirmProviderLicense', async (_evt, providerId) => {
  const provider = feeder.MV_PROVIDERS[providerId];
  if (!provider) return false;
  const res = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', `I understand, fetch ${provider.displayName}`],
    defaultId: 0,
    cancelId: 0,
    title: 'Third-party licence',
    message: `${provider.displayName} -- before this fetches anything`,
    detail: `${provider.licenseSummary || provider.license}\n\nOfficial repo: ${provider.officialUrl}${provider.licenseUrl ? `\nFull licence text: ${provider.licenseUrl}` : ''}`,
  });
  return res.response === 1;
});

// Compares the deployed Feeder's recorded version against its actual latest release. Only
// meaningful once something has been deployed -- feeder.js reports why not, otherwise.
ipcMain.handle('feeder:checkUpdate', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    return { ok: true, ...(await feeder.feederUpdateCheck(dir, GITHUB_HEADERS)) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Whether this game can offer OptiScaler's own Frame Generation, and whether it's on --
// optiFgReadiness (defined further down, next to autoConfigureGame -- hoisted, fine to call
// from up here) explains why not rather than just hiding the control.
ipcMain.handle('optifg:readiness', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { supported: false, reason: 'Game .exe not found' };
  const dir = gameDir(exePath);
  const api = await detectRenderApi(dir, exePath);
  return { api, ...optiFgReadiness(dir, api) };
});

// Toggles the per-game marker and immediately re-runs autoConfigureGame so the ini reflects it
// right away, rather than waiting for the next Install/sync to pick it up.
ipcMain.handle('optifg:set', async (_evt, { exePath, enabled }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    setOptiFgEnabled(dir, !!enabled);
    const result = await autoConfigureGame(dir, exePath);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Lossless Scaling as an alternative Frame Generation path for Feeder games, since OptiScaler's
// own FSRFG is blocked there -- see optiFgReadiness()'s Feeder gate above. See lossless.js for
// why this sidesteps that whole crash class (it never touches the game's own Present/swapchain).
ipcMain.handle('lossless:openStorePage', () => {
  shell.openExternal('https://store.steampowered.com/app/993090/Lossless_Scaling/');
});

ipcMain.handle('lossless:detect', () => {
  try { return lossless.detect(); } catch (error) { return { installed: false, error: String(error && error.message ? error.message : error) }; }
});

ipcMain.handle('lossless:readSettings', () => lossless.readSettingsRaw());

// xmlText is fully-formed replacement content, built in the renderer via DOMParser/XMLSerializer
// (see configureLossless() in renderer.js) -- this handler only ever writes what it's given,
// after backing up whatever was there. It does not itself understand or validate the XML shape.
ipcMain.handle('lossless:writeSettings', (_evt, xmlText) => {
  try {
    lossless.writeSettingsRaw(xmlText);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('lossless:launch', () => {
  try {
    const info = lossless.detect();
    if (!info.installed) throw new Error('Lossless Scaling is not installed');
    spawn(info.exePath, [], { cwd: path.dirname(info.exePath), detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Points the in-game panel's own Lossless Scaling launch/close checkbox at the real exe -- that
// panel never detects or configures Lossless Scaling itself, only this app does (see lossless.js).
// Called right after configureLossless() succeeds, not on every section load, so the ini's pointer
// and the actual per-game profile setup always land together -- an ExePath with no matching
// profile would make the in-game checkbox launch Lossless Scaling for nothing.
// gameTitle must be the exact <Title> text written into Lossless Scaling's own profile (see
// configureLossless() in renderer.js) -- the in-game panel matches its own profile list by this
// exact text via UI Automation, since a list entry there carries no other stable identifier.
ipcMain.handle('lossless:setExePathInGameIni', (_evt, { exePath, losslessExePath, gameTitle }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const iniPath = path.join(dir, 'OptiScaler.ini');
    if (!fs.existsSync(iniPath)) throw new Error('OptiScaler.ini not found -- install OptiScaler for this game first.');
    ensureIniKey(iniPath, 'DlssNr', 'LosslessScalingExePath', losslessExePath);
    if (gameTitle) ensureIniKey(iniPath, 'DlssNr', 'LosslessScalingGameTitle', gameTitle);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// force: true re-fetches and overwrites the whole stack (an update, not a first install).
// licenseConfirmed: only meaningful when mvProviderId names a non-auto-fetchable provider
// (LumeniteFX right now) -- the renderer only ever sends true here after the user has actually
// seen and confirmed that provider's real licence text in a dedicated dialog, never as a side
// effect of the generic Deploy button. deployLumeniteFx() itself refuses without it regardless,
// so a renderer bug can't turn this into a silent bypass.
ipcMain.handle('feeder:deploy', async (_evt, { exePath, mvProviderId, force, licenseConfirmed }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const api = await detectRenderApi(dir, exePath);
    const results = await feeder.deployFeederStack(dir, api, mvProviderId, {
      cacheDir: feederCacheDir(),
      getRhiManifest,
      compareVersions: compareStreamlineVersions,
      ghHeaders: GITHUB_HEADERS,
      force: !!force,
      licenseConfirmed: !!licenseConfirmed,
    });
    return { ok: true, ...results };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Same shape as feeder:readiness -- lumaue.lumaUeReadiness() itself explains why (wrong game,
// or which files are still missing) rather than this handler doing any of that reasoning.
ipcMain.handle('lumaue:readiness', async (_evt, { exePath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Game .exe not found' };
    const dir = gameDir(exePath);
    return { ok: true, ...lumaue.lumaUeReadiness(dir, exePath) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// licenseConfirmed: only ever true after the renderer has shown the user lumaue.LUMA_LICENSE_SUMMARY
// and lumaue.LUMA_KNOWN_ISSUE in a dedicated dialog and they've explicitly agreed, same posture as
// feeder:deploy's LumeniteFX confirmation. deployLumaUeStack() itself refuses without it regardless.
ipcMain.handle('lumaue:deploy', async (_evt, { exePath, force, licenseConfirmed }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    if (!lumaue.isFallenOrder(exePath)) throw new Error('Luma UE is only offered for STAR WARS Jedi: Fallen Order');
    const dir = gameDir(exePath);
    const results = await lumaue.deployLumaUeStack(dir, {
      cacheDir: lumaUeCacheDir(),
      getRhiManifest,
      compareVersions: compareStreamlineVersions,
      ghHeaders: GITHUB_HEADERS,
      force: !!force,
      licenseConfirmed: !!licenseConfirmed,
    });
    return { ok: true, ...results };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The AMD/Intel workaround the OptiScaler wiki names for this exact game -- a separate,
// explicit opt-in rather than something autoConfigureGame silently forces. This app has no GPU
// vendor detection (nothing else here has needed it), so guessing would risk applying an
// Nvidia-only-relevant override on an Nvidia system for no reason; the user knows their own GPU.
ipcMain.handle('lumaue:applyAmdIntelWorkaround', async (_evt, { exePath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const iniPath = path.join(dir, 'OptiScaler.ini');
    if (!fs.existsSync(iniPath)) throw new Error('OptiScaler.ini not found -- install OptiScaler for this game first');
    const applied = patchIniValues(iniPath, [
      { section: 'Spoofing', key: 'Dxgi', value: 'false' },
      { section: 'Dx11withDx12', key: 'DontUseNTShared', value: 'true' },
    ]);
    return { ok: true, applied };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
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
    //
    // A Feeder game (see feeder.js) proxy-installs exactly the same way as any other game --
    // OptiScaler takes the proxy slot. ReShade is NOT a competing proxy here: it deploys as a
    // plain ReShade64.dll, and OptiScaler itself loads it via [Plugins] LoadReshade=true (forced
    // below, in autoConfigureGame). An earlier version of this used the injector for Feeder
    // games instead, on the theory that OptiScaler-as-proxy would fight ReShade for the slot --
    // that was wrong on both counts, confirmed on a real deploy (Batman: Arkham Knight,
    // 2026-09-09): the Feeder couldn't find an injected OptiScaler at all ("this game never
    // loaded a DLL of that name"), and two independent proxies (even different DLL names) meant
    // ReShade's own Present hook never engaged. Do not reintroduce the injector here.
    const feederGame = feeder.needsFeeder(dir) || feeder.feederDeployed(dir);

    let proxy = null;
    let proxyError = null;
    try {
      proxy = await installProxy(dir, proxyName || DEFAULT_PROXY);
    } catch (err) {
      // Not fatal: everything else is in place, and Run Setup is still there to do it by hand.
      proxyError = err.message;
    }

    const { api, applied, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix } = await autoConfigureGame(dir, exePath);

    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, proxy, proxyError, feederGame, api, autoConfigured: applied, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
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

// Guard against scanning something absurd (a multi-GB data blob happening to sit beside the
// exe) -- every real D3D/Vulkan/OpenGL import lives in a normal-sized PE file, so skipping
// anything past this is a safe, cheap filter, not a real limitation.
const RENDER_API_SCAN_MAX_BYTES = 200 * 1024 * 1024;

// The exe plus every top-level DLL beside it -- not the exe alone. RED Engine (Cyberpunk 2077,
// The Witcher 3) never carries d3d11.dll/d3d12.dll as a literal string in its own exe (confirmed
// against both real executables), and the same turned out true for RBDOOM-3-BFG, the DX12/Vulkan
// community source port of DOOM 3: BFG Edition -- its D3D12 import lives in NVRHI's own DLL, not
// the game's exe, so the old exe-only scan reported it as undetected. Scanning every sibling DLL
// too catches that whole class of engine without a per-game special case, the same way
// vulkan-1.dll's presence in the directory already worked before this without ever needing to be
// found inside the exe's own bytes.
async function findDllMarkers(dir, exePath, markerNames) {
  const found = new Set();
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return found;
  }

  const dllPaths = entries.filter((f) => /\.dll$/i.test(f)).map((f) => path.join(dir, f));
  const filesToScan = [exePath, ...dllPaths];

  for (const filePath of filesToScan) {
    try {
      const st = await fsp.stat(filePath);
      if (st.size > RENDER_API_SCAN_MAX_BYTES) continue;
      const buf = await fsp.readFile(filePath);
      for (const name of markerNames) {
        if (found.has(name)) continue;
        if (buf.includes(Buffer.from(name.toLowerCase(), 'ascii')) ||
            buf.includes(Buffer.from(name.toUpperCase(), 'ascii'))) {
          found.add(name);
        }
      }
    } catch {
    }
  }
  return found;
}

async function detectRenderApi(dir, exePath) {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.some((f) => /^vulkan-1\.dll$/i.test(f) || /_vk(ulkan)?\.dll$/i.test(f))) return 'vulkan';
  } catch {
  }

  const found = await findDllMarkers(dir, exePath, ['vulkan-1.dll', 'd3d12.dll', 'd3d11.dll']);
  if (found.has('vulkan-1.dll')) return 'vulkan';
  if (found.has('d3d12.dll')) return 'dx12';
  if (found.has('d3d11.dll')) return 'dx11';
  return null;
}

const OLD_API_MARKERS = [
    ['dx9', ['d3d9.dll', 'd3d8.dll']],
    ['dx10', ['d3d10.dll', 'd3d10core.dll']],
    ['opengl', ['opengl32.dll']]
];

// `badge` is the short chip shown on the card; `reason` is the longer explanation that goes in its
// tooltip. Engine identity (RE Engine, RED Engine) takes the badge over the raw graphics API when
// both are known -- which tool matters (REFramework, etc.) is more useful at a glance than DX/Vulkan.
async function detectInstallPath(dir, exePath) {
  const api = await detectRenderApi(dir, exePath);

  if (isReEngineGame(dir)) {
    return {
      api, recommend: 'optiscaler', badge: 'RE Engine',
      reason: 'RE Engine (Capcom) — needs REFramework, which this app fetches automatically'
    };
  }

  if (api === 'vulkan' || api === 'dx12' || api === 'dx11') {
    return {
      api, recommend: 'optiscaler', badge: api.toUpperCase(),
      reason: `${api.toUpperCase()} — OptiScaler hooks this directly`
    };
  }

  let buf = null;
  try {
    buf = await fsp.readFile(exePath);
  } catch {
    return { api: null, recommend: 'unknown', badge: 'Unknown', reason: 'could not read the executable' };
  }

  const has = (name) =>
    buf.includes(Buffer.from(name.toLowerCase(), 'ascii')) || buf.includes(Buffer.from(name.toUpperCase(), 'ascii'));

  // Same widened exe+directory scan detectRenderApi uses, not just the exe buffer -- an old-API
  // game with its real import in a side DLL (the same class of case as RED Engine / RBDOOM-3-BFG
  // above) would otherwise silently fall through to "Unknown" instead of a correct "not
  // supported" reason. DOOM 3: BFG Edition's stock OpenGL release is the confirmed real case this
  // closes: reported Unknown before, now correctly OPENGL / not supported.
  const oldApiMarkers = await findDllMarkers(dir, exePath, OLD_API_MARKERS.flatMap(([, markers]) => markers));
  for (const [old, markers] of OLD_API_MARKERS) {
    if (markers.some((m) => oldApiMarkers.has(m))) {
      return {
        api: old, recommend: 'unsupported', badge: old.toUpperCase(),
        reason: `${old.toUpperCase()} — OptiScaler has no hook here`
      };
    }
  }

  // REDengine (Cyberpunk 2077, The Witcher 3) never fails detectRenderApi's d3d11.dll/d3d12.dll
  // scan because it doesn't succeed either -- confirmed against both games' real executables,
  // neither contains that literal string, so the DLL is loaded some other way than a static
  // import. "REDengine" and "CD PROJEKT" are both in there in plain text, though.
  if (has('redengine') || has('cd projekt')) {
    return {
      api: null, recommend: 'optiscaler', badge: 'RED Engine',
      reason: 'RED Engine (CD Projekt Red) — graphics API not detected, but OptiScaler is commonly used with this engine'
    };
  }

  return { api: null, recommend: 'unknown', badge: 'Unknown', reason: 'could not tell which graphics API this uses' };
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

// patchIniValues/patchIniDefaults above only ever update a line already present in the file --
// exactly right for their own job (every key they touch ships in OptiScaler's own default ini
// template, so it's always there to find), but wrong for a key added to Config.cpp this same
// session: an already-installed game's ini predates it and has no such line at all, so those
// functions silently do nothing. Ensures the key exists, appending a new line (and a new section
// if needed) rather than requiring one to already be there. Found live: the first version of this
// used patchIniValues and reported success while writing nothing, for exactly this reason.
function ensureIniKey(iniPath, section, key, value) {
  const original = fs.readFileSync(iniPath, 'utf-8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r\n|\n/);
  const sectionLower = section.toLowerCase();
  const keyLower = key.toLowerCase();

  let sectionStart = -1;
  let sectionEnd = lines.length;
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      if (currentSection && currentSection.toLowerCase() === sectionLower) { sectionEnd = i; break; }
      currentSection = sectionMatch[1];
      if (currentSection.toLowerCase() === sectionLower) sectionStart = i;
      continue;
    }
    if (currentSection && currentSection.toLowerCase() === sectionLower) {
      const kvMatch = lines[i].match(/^(\s*)([^;#=\s][^=]*?)(\s*=\s*)(.*)$/);
      if (kvMatch && kvMatch[2].trim().toLowerCase() === keyLower) {
        if (kvMatch[4].trim() === String(value)) return false; // already correct
        lines[i] = `${kvMatch[1]}${kvMatch[2]}${kvMatch[3]}${value}`;
        fs.writeFileSync(iniPath, lines.join(eol), 'utf-8');
        return true;
      }
    }
  }

  if (sectionStart === -1) {
    lines.push('', `[${section}]`, `${key} = ${value}`);
  } else {
    lines.splice(sectionEnd, 0, `${key} = ${value}`);
  }
  fs.writeFileSync(iniPath, lines.join(eol), 'utf-8');
  return true;
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

/// Fetches RHI's whole dlss_manifest.json (streamline, dlssg, dlss, dlssnr lists) once and
/// shares it between every consumer -- the Streamline version dropdown and the Frame Gen
/// version dropdown both read from this instead of fetching twice. Prefers a fresh fetch,
/// falls back to the on-disk copy from a previous run when offline, and to an empty object
/// when there has never been one (callers apply their own built-in fallback list on top of
/// that, since only Streamline has one). Never throws.
async function getRhiManifest() {
  if (rhiManifestMemo && Date.now() - rhiManifestMemo.at < RHI_MANIFEST_TTL_MS) {
    return rhiManifestMemo.data;
  }

  try {
    const res = await fetch(RHI_MANIFEST_URL, { headers: { 'User-Agent': GITHUB_HEADERS['User-Agent'] } });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        writeJson(rhiManifestCacheFile(), { fetchedAt: Date.now(), manifest: data });
        rhiManifestMemo = { at: Date.now(), data };
        return data;
      }
    }
  } catch {
    // Fall through to the cached / empty manifest.
  }

  const cachedWrap = readJson(rhiManifestCacheFile(), {});
  const data = cachedWrap && cachedWrap.manifest && typeof cachedWrap.manifest === 'object' ? cachedWrap.manifest : {};
  rhiManifestMemo = { at: Date.now(), data };
  return data;
}

/// Returns RHI's Streamline list as [{ version, url }], newest first, falling back to a
/// built-in list only when the manifest has nothing at all (never fetched, offline with no
/// cache yet).
async function getStreamlineReleases() {
  const manifest = await getRhiManifest();
  const releases = (Array.isArray(manifest && manifest.streamline) ? manifest.streamline : [])
    .filter((e) => e && typeof e.version === 'string')
    .map((e) => ({ version: e.version, url: typeof e.url === 'string' && e.url ? e.url : streamlineZipUrlFor(e.version) }))
    .sort((x, y) => compareStreamlineVersions(y.version, x.version));

  return releases.length > 0
    ? releases
    : STREAMLINE_BUILTIN_VERSIONS.map((version) => ({ version, url: streamlineZipUrlFor(version) }));
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
//                           off Insert entirely rather than trying to win a hook fight.
//
//                           Not 0x24/VK_HOME (tried first): DlssNrPanelKey defaults to Alt+Home, and
//                           an unchorded bind here ignores whatever modifiers are held -- by design,
//                           in BindMatches, so a plain bind still fires if you're incidentally
//                           holding Shift for something else -- so bare Home also matched every
//                           Alt+Home press, double-toggling both menus on every key-repeat tick.
//                           That storm coincided with REFramework logging a fatal "Present failed:
//                           87a0001" (DXGI_ERROR_INVALID_CALL) and going silent -- two Present hooks
//                           racing on rapid BlockMouse/BlockKeyboard/BlockCursor flips, most likely.
//                           0x91/VK_SCROLL (Scroll Lock) tested clean afterwards. Final choice is
//                           0x14F = VK_O (0x4F) | KeyModAlt (0x100), i.e. Alt+O: chorded, and 'O'
//                           isn't a base key for REFramework's defaults, DlssNr's panel key, or any
//                           of OptiScaler's own other shortcuts either.
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
  { section: 'Menu', key: 'ShortcutKey', value: '0x14F' },
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

// REFramework writes its own settings the first time the game actually runs with dinput8.dll in
// place -- a flat KEY=VALUE file, no [Section] headers, so patchIniValues/patchIniDefaults (which
// both require a section) don't apply to it. There is nothing to patch until that first run has
// happened, which is fine: this only ever fixes a file that already exists.
const REFRAMEWORK_CONFIG_NAME = 're2_fw_config.txt';

// REFramework's own docs and in-game text say the menu opens on Insert (VK_INSERT = 45), but a real
// generated config here had REFrameworkConfig_MenuKey_V2=96 (VK_NUMPAD0) instead -- a key a laptop
// keyboard doesn't have, which is why pressing Insert looked like it did nothing. Forced back to 45
// so the documented key actually matches what's bound.
//
// REFramework has no separate window-size or DPI setting -- the overlay is Dear ImGui, so its only
// lever on how big things render is font size. 22 renders small on a high-res panel; 34 reads like a
// normal desktop window there while staying reasonable at 1080p.
const REFRAMEWORK_CONFIG_FIXES = [
  { key: 'REFrameworkConfig_MenuKey_V2', value: '45' },
  { key: 'REFrameworkConfig_FontSize', value: '34' },
  { key: 'REFrameworkConfig_UIFontSize', value: '34.000000' },
];

function patchFlatKeyValueFile(filePath, edits) {
  if (!fs.existsSync(filePath)) return [];
  const original = fs.readFileSync(filePath, 'utf-8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r\n|\n/);
  const wanted = new Map(edits.map((e) => [e.key.toLowerCase(), e]));
  const changed = [];

  for (let i = 0; i < lines.length; i++) {
    const kvMatch = lines[i].match(/^([^=]+)=(.*)$/);
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;
    const edit = wanted.get(key.trim().toLowerCase());
    if (!edit || value.trim() === String(edit.value)) continue;
    changed.push({ ...edit, was: value.trim() });
    lines[i] = `${key}=${edit.value}`;
  }

  if (changed.length > 0) fs.writeFileSync(filePath, lines.join(eol), 'utf-8');
  return changed;
}

function fixREFrameworkConfig(dir) {
  return patchFlatKeyValueFile(path.join(dir, REFRAMEWORK_CONFIG_NAME), REFRAMEWORK_CONFIG_FIXES);
}

// A game that already has its own DLSS -- a native Streamline interposer, or a bare
// nvngx_dlss.dll -- already does its own upscaling and (where present) its own frame gen.
// OptiScaler's job there is Neural Rendering only: its native-DLSS passthrough already runs
// NR on top of whatever the game's own DLSS produced, so replacing the upscaler or touching
// frame gen is not just unnecessary, forcing FrameGen on is the Cyberpunk crash. A game with
// none of these signals gets the full config below -- OptiScaler is doing the upscaling
// there, so it needs to be told which upscaler to use.
function hasNativeDlss(dir) {
  return fs.existsSync(path.join(dir, 'sl.interposer.dll')) ||
    fs.existsSync(path.join(dir, 'sl.interposer.dll.original')) ||
    fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));
}

// The one value that MUST be forced for a "DLSS 5 only" game: a full install from before the
// Cyberpunk-crash fix may have left [FrameGen] Enabled=true in this game's ini, and leaving it
// on is the crash. patchIniValues (force), not patchIniDefaults (fill-if-auto), because a
// value that already crashed once needs to be corrected, not left alone for being non-default.
const DLSS5_ONLY_FORCED = [
  { section: 'FrameGen', key: 'Enabled', value: 'false' },
];

// The SECOND value that must be forced for a "DLSS 5 only" game, and the one that is easy
// to get wrong: the upscaler key. Leaving it alone is NOT "leave the game's DLSS alone". An
// unset/auto upscaler is OptiScaler's own default backend -- Config.h: Dx12Upscaler defaults
// to XeSS, Dx11Upscaler and VulkanUpscaler to FSR 2.2 -- so on a fresh ini a native-DLSS game
// (Cyberpunk, 007 First Light...) has its DLSS 4.x quietly REPLACED by XeSS/FSR, with NR run
// on top of that. The game works, NR runs, and it looks worse than it should. Keeping the
// game's DLSS means saying `dlss` explicitly. Forced, because a stale `auto` from an earlier
// install is exactly the case that bites.
const UPSCALER_KEY_FOR_API = { dx12: 'Dx12Upscaler', dx11: 'Dx11Upscaler', vulkan: 'VulkanUpscaler' };
function keepGamesOwnDlss(api) {
  const key = UPSCALER_KEY_FOR_API[api];
  return key ? [{ section: 'Upscalers', key, value: 'dlss' }] : [];
}

// The one value that MUST be forced for a Feeder game: OptiScaler has to explicitly load
// ReShade64.dll itself (feeder.js deploys it as a plain file, not a proxy) for the two to
// coexist at all -- see the long comment on installProxy's caller in game:install for why.
// Forced, not defaulted, for the same reason as DLSS5_ONLY_FORCED: a game Feeder-deployed
// before this fix existed needs LoadReshade corrected, not left at whatever it already was.
const LOAD_RESHADE_FORCED = [
  { section: 'Plugins', key: 'LoadReshade', value: 'true' },
];

// OptiScaler's own Frame Generation, opted into per game -- see optiFgReadiness() below for
// why this only ever applies to a D3D12 game. FSRFG specifically (not DLSSG/XeFG): it's plain
// ini config with no Streamline dependency, which is what makes it reachable through a Feeder
// game at all (confirmed on a real Feeder deploy, Bodycam, 2026-09-09: OptiScaler.log read back
// `FrameGen.FGOutput: FSRFG` correctly).
const OPTIFG_FORCED = [
  { section: 'FrameGen', key: 'Enabled', value: 'true' },
  { section: 'FrameGen', key: 'FGInput', value: 'upscaler' },
  { section: 'FrameGen', key: 'FGOutput', value: 'fsrfg' },
];

// Persisted per game-folder, not in games.json -- same reasoning as feederDeployed(): this has
// to survive being read by any entry point that calls autoConfigureGame (game:install,
// game:sync-if-stale), not just the one IPC call that set it.
const OPTIFG_MARKER = '.dlss5ui-optifg-enabled';

function isOptiFgEnabled(dir) {
  return fs.existsSync(path.join(dir, OPTIFG_MARKER));
}

function setOptiFgEnabled(dir, enabled) {
  const marker = path.join(dir, OPTIFG_MARKER);
  if (enabled) fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
  else if (fs.existsSync(marker)) fs.rmSync(marker);
}

// OptiScaler's FGHooks::CreateSwapChain requires the game's own swapchain device to answer
// QueryInterface for ID3D12CommandQueue -- refuses outright (E_INVALIDARG) otherwise, for every
// FG backend, not just FSRFG. That's a hard wall for a D3D11 game (confirmed against OptiScaler's
// own source, 2026-09-09) -- no ini setting or Manager-side trigger can route around it, so this
// reports why rather than offering a control that can't work. Also checks the FFX DLLs FSRFG
// specifically needs (OptiScaler's own release payload ships them under OptiScaler/, already
// copied there by game:install same as everything else in the release folder).
function optiFgReadiness(dir, api) {
  if (api !== 'dx12') {
    return { supported: false, reason: `OptiScaler's own Frame Generation needs the game's swapchain to be D3D12 -- this game is ${api || 'not yet detected'}.` };
  }
  // Crashes on a real game: our exported NGX Shutdown1 forwards into NVIDIA's real
  // _nvngx.dll while the Feeder's own private DX12 NGX session is still live, and NVIDIA's
  // side null-derefs. Confirmed via a symbolicated minidump (Bodycam, 2026-09-09) -- not a
  // theoretical risk. Block the combo until that interaction is actually fixed.
  if (feeder.needsFeeder(dir) || feeder.feederDeployed(dir)) {
    return { supported: false, reason: 'Not available together with the DLSS5 Feeder yet -- this combination crashed on a real test (confirmed via a symbolicated crash dump). Blocked until fixed.' };
  }
  const ffxLoader = path.join(dir, 'OptiScaler', 'amd_fidelityfx_loader_dx12.dll');
  const ffxFg = path.join(dir, 'OptiScaler', 'amd_fidelityfx_framegeneration_dx12.dll');
  if (!fs.existsSync(ffxLoader) || !fs.existsSync(ffxFg)) {
    return { supported: false, reason: 'Missing amd_fidelityfx_loader_dx12.dll / amd_fidelityfx_framegeneration_dx12.dll -- install OptiScaler for this game first (Install button).' };
  }
  return { supported: true, enabled: isOptiFgEnabled(dir) };
}

async function autoConfigureGame(dir, exePath) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return { api: null, applied: [] };

  const api = await detectRenderApi(dir, exePath);
  const dlss5Only = hasNativeDlss(dir);
  // hasNativeDlss() just checks for nvngx_dlss.dll on disk -- for a Feeder game that file was
  // placed by the Feeder deploy itself, not the game, so this alone can't tell native DLSS
  // apart from Feeder-supplied. Excluded explicitly: Feeder + FSRFG crashed on a real game
  // (confirmed via a symbolicated minidump) -- see optiFgReadiness's own guard above.
  const isFeederGame = feeder.needsFeeder(dir) || feeder.feederDeployed(dir);
  const optiFgOn = dlss5Only && api === 'dx12' && !isFeederGame && isOptiFgEnabled(dir);
  const edits = [];

  if (!dlss5Only) {
    if (api === 'dx12') edits.push({ section: 'Upscalers', key: 'Dx12Upscaler', value: 'dlss' });
    else if (api === 'dx11') edits.push({ section: 'Upscalers', key: 'Dx11Upscaler', value: 'dlss' });
    else if (api === 'vulkan') edits.push({ section: 'Upscalers', key: 'VulkanUpscaler', value: 'dlss' });
  }

  // Only force DlssNr on when the actual model file is present -- forcing it on every game
  // regardless (including ones where NR was never installed) risks the pass trying to initialize
  // with nothing to run, which crashed launches. See the "won't launch" report.
  if (fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) {
    edits.push({ section: 'DlssNr', key: 'Enabled', value: 'true' });
  }

  const reEngine = isReEngineGame(dir);
  let reframework = null;
  let reframeworkConfig = [];
  let reEngineHotfix = [];
  if (reEngine) {
    reEngineHotfix = patchIniValues(iniPath, RE_ENGINE_HOTFIX);

    // OptiScaler doesn't work on RE Engine without REFramework already present -- ensure it's
    // there before anything else here matters.
    reframework = await ensureREFrameworkForGame(dir);
    reframeworkConfig = fixREFrameworkConfig(dir);
  }

  // Frame gen is the game's own job, not OptiScaler's -- OptiScaler's FG bridge and a
  // game's native DLSS-G both try to wrap the swapchain, and running both at once is a
  // hard crash (confirmed via Aftermath on Cyberpunk: DXGI_ERROR_INVALID_CALL through
  // hkslDLSSGSetOptions intercepting the game's own native slDLSSGSetOptions call).
  // [FrameGen] Enabled is deliberately left untouched here -- OptiScaler's own FG stays a
  // narrow, explicit per-game opt-in (for titles with no native frame gen at all), never
  // the default. Streamline SDK deploy moves with it: it exists to feed OptiScaler's FG
  // bridge, so it has no default-path reason to run once that bridge isn't forced on.
  const streamline = null;

  const applied = patchIniDefaults(iniPath, edits);
  // A DLSS-5-only game keeps its own DLSS whether or not OptiFG is layered on -- see
  // keepGamesOwnDlss for why the upscaler key cannot be left at auto.
  let forced = dlss5Only
    ? patchIniValues(iniPath, [...(optiFgOn ? OPTIFG_FORCED : DLSS5_ONLY_FORCED), ...keepGamesOwnDlss(api)])
    : [];
  if (feeder.feederDeployed(dir)) forced = [...forced, ...patchIniValues(iniPath, LOAD_RESHADE_FORCED)];
  // Luma UE deploys its own ReShade64.dll the same non-proxying way the Feeder does (see
  // lumaue.js's file header) -- OptiScaler needs the same explicit LoadReshade nudge to load it.
  if (lumaue.lumaUeDeployed(dir)) forced = [...forced, ...patchIniValues(iniPath, LOAD_RESHADE_FORCED)];
  return {
    api, applied: [...applied, ...forced], streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix,
    profile: dlss5Only ? (optiFgOn ? 'dlss5-only+optifg' : 'dlss5-only') : 'full',
  };
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

    const { api, applied: autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix } = await autoConfigureGame(dir, exePath);

    const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
    if (!releaseDll || !fs.existsSync(releaseDll)) {
      return { ok: true, updated: autoConfigured.length > 0, reason: 'no release set', api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
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
      return { ok: true, updated: autoConfigured.length > 0, reason: 'up to date', api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});

    return { ok: true, updated: true, file: path.basename(active.file), api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
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

const MANAGER_REPO = 'mrcgibb9876-hash/OptiDLSS5-UI';

// What engine version THIS running Manager build actually shipped with -- parsed off the
// bundled zip asset name on the Manager's own GitHub release for its own current tag
// (release.yml's "Fetch the OptiScaler_DLSSNR engine build" step names that asset
// OptiScaler_DLSSNR-<tag>.zip). This is a stronger compatibility signal than "are both
// independently the latest release of their own repo" -- two repos each being independently
// up to date doesn't mean the two latest releases were ever tested together, but the pair a
// single Manager release actually bundled and shipped was.
ipcMain.handle('update:checkManager', async () => {
  try {
    const currentVersion = app.getVersion();
    const currentTag = `v${currentVersion}`;

    let bundledEngineTag = null;
    const ownRes = await fetch(`https://api.github.com/repos/${MANAGER_REPO}/releases/tags/${encodeURIComponent(currentTag)}`, { headers: GITHUB_HEADERS });
    if (ownRes.ok) {
      const ownRelease = await ownRes.json();
      const zipAsset = (ownRelease.assets || []).find((a) => /^OptiScaler_DLSSNR-.*\.zip$/i.test(a.name));
      const m = zipAsset && zipAsset.name.match(/^OptiScaler_DLSSNR-(.+)\.zip$/i);
      if (m) bundledEngineTag = m[1];
    }

    const latestRes = await fetch(`https://api.github.com/repos/${MANAGER_REPO}/releases/latest`, { headers: GITHUB_HEADERS });
    if (!latestRes.ok) throw new Error(`GitHub API returned ${latestRes.status}`);
    const latest = await latestRes.json();
    const latestVersion = String(latest.tag_name || '').replace(/^v/i, '');

    return {
      ok: true,
      currentVersion,
      latestVersion,
      upToDate: latestVersion ? compareStreamlineVersions(currentVersion, latestVersion) >= 0 : null,
      releaseUrl: latest.html_url,
      bundledEngineTag,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:openManagerReleasePage', () => {
  shell.openExternal(`https://github.com/${MANAGER_REPO}/releases/latest`);
});

// Closes the "blind install" gap without this app guessing at settings it hasn't verified:
// tells the user whether OptiScaler_DLSSNR's own engine has ever been specifically tuned for
// this exe (a real compiled-in Quirks.h entry) versus a completely default configuration. Does
// NOT read or apply the actual quirk flags -- those stay engine-internal and can differ by
// build; this is visibility only, not another source of auto-applied settings.
ipcMain.handle('engine:hasKnownProfile', (_evt, { exePath }) => {
  if (!exePath) return { ok: true, known: false };
  return { ok: true, known: ENGINE_KNOWN_GAMES.has(path.basename(exePath).toLowerCase()) };
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
