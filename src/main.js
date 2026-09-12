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
const nativeDlss = require('./native-dlss');
const { recommendRoute, withApiOverride, API_OVERRIDE_VALUES } = require('./route');
const gpu = require('./gpu');
const amdnr = require('./amdnr');
const { detectGame, detectRenderApi, isDetectionStale, isReEngineGame, resolveUnrealShippingExe, foreignToolchains, planForeignRemoval } = require('./detect');
const { openZip, findEntry, extractEntryTo } = require('./zip');
const managerUpdate = require('./manager-update');
const runlog = require('./runlog');
const library = require('./library');
let electronAutoUpdater = null;
try { ({ autoUpdater: electronAutoUpdater } = require('electron-updater')); } catch { electronAutoUpdater = null; }
const ENGINE_KNOWN_GAMES = new Set(require('./engine-known-games.json').exeNames);
const execFileAsync = promisify(execFile);

const RELEASES_API = 'https://api.github.com/repos/mrcgibb9876-hash/OptiScaler_DLSSNR/releases/latest';
const GITHUB_HEADERS = { 'User-Agent': 'OptiDLSS5-UI', Accept: 'application/vnd.github+json' };

// Detected once per run, on first use (the GPU process is up by the time any IPC arrives).
// See gpu.js for what the vendor changes.
let gpuInfoMemo = null;
function getGpuInfo() {
  if (!gpuInfoMemo) gpuInfoMemo = gpu.detectGpu(app, execFileAsync);
  return gpuInfoMemo;
}
ipcMain.handle('gpu:info', () => getGpuInfo());

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
  // The Manager's own updater: checks its GitHub releases after launch and every few hours,
  // downloads in the background, installs on quit; the renderer shows "Restart to update".
  managerUpdate.setup({
    app,
    autoUpdater: electronAutoUpdater,
    onChange: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send('manager-update', state); } catch {}
      }
    },
  });
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
  const before = readJson(settingsFile(), {});
  writeJson(settingsFile(), settings);
  // A changed Language reaches every installed game's in-game panel now, not on its next install.
  if (panelLanguageValue(before) !== panelLanguageValue(settings)) {
    for (const game of readJson(gamesFile(), [])) {
      try {
        if (game && game.exePath) applyPanelLanguage(gameDir(game.exePath), settings);
      } catch {
        // One game's unwritable ini must not block saving the settings themselves.
      }
    }
  }
  return true;
});

// The in-game DLSS 5 panel speaks the same languages as this app (engine v1.0.11 and later), and
// its [DlssNr] Language key follows this app's Language setting: auto stays auto (each then follows
// Windows on its own), a pinned language is written in the engine's lower-case form. Written on
// every install (autoConfigureGame) and re-written across all games when the setting changes.
function panelLanguageValue(settings) {
  const lang = settings && settings.language ? String(settings.language) : 'auto';
  return lang === 'auto' ? 'auto' : lang.toLowerCase();
}

function applyPanelLanguage(dir, settings = readJson(settingsFile(), {})) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return [];
  const value = panelLanguageValue(settings);
  return ensureIniKey(iniPath, 'DlssNr', 'Language', value) ? [{ section: 'DlssNr', key: 'Language', value }] : [];
}

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
    // state.dllPath, not path.join(dir, state.dll): an Unreal game keeps the DLL under its
    // plugin tree, not beside the exe.
    state.currentVersion = await framegen.readDllVersion(execFileAsync, state.dllPath);
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
  // A Feeder on a game that ships DLSS (an older version of this app could not see DLSS kept
  // under an Unreal plugin folder): the section stays open, but only to remove it -- the
  // Feeder's synthetic DLSS call and the game's real one crash together (Code Vein 2, 2026-09-11).
  const shipped = nativeDlss.shippedDlssPath(dir);
  if (shipped && feeder.feederDeployed(dir)) {
    return {
      ready: false, needed: true, supported: false, misdeployed: true,
      reason: 'This game ships its own DLSS ({file}), so the Feeder must not run here -- the two crash together. Remove it; OptiScaler then hooks the game\'s own DLSS.',
      reasonVars: { file: shipped },
    };
  }
  if (!feeder.needsFeeder(dir) && !feeder.feederDeployed(dir)) {
    return { ready: false, needed: false, reason: 'This game already has native DLSS -- use the DLSS 5 only profile instead, not the Feeder.' };
  }
  // Fallen Order gets its DLSS call from Luma UE (lumaue.js), not the Feeder. Both deploy a plain
  // ReShade64.dll into the same folder, so offering both here let a user deploy one over the
  // other. Only a Feeder already on disk keeps this section open for that game.
  const detected = withApiOverride(await detectGame(dir, exePath), readApiOverride(dir));
  if ((lumaue.isLumaUeDefault(exePath) || lumaue.lumaUeDeployed(dir)) && !feeder.feederDeployed(dir)) {
    return { ready: false, needed: false, reason: 'This game uses Luma UE for its DLSS call, not the Feeder -- see the Luma UE section.' };
  }
  return { needed: true, ...feeder.feederReadiness(dir, detected.api) };
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
  const api = await resolveApi(dir, exePath);
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
// The in-game panel's link to this game's Lossless Scaling profile lives in OptiScaler.ini, but
// game:install copies the release ini over the folder wholesale and Lossless can now be configured
// before OptiScaler is even installed. So the source of truth is a per-game marker beside the
// exe, and autoConfigureGame re-applies it every time it runs (install, sync, deploy).
const LOSSLESS_MARKER = '.dlss5ui-lossless.json';

// Lossless Scaling is offered ONLY to games with no DLSS of their own. A native-DLSS game
// (Cyberpunk, 007 First Light, Witcher 3...) has NVIDIA's own Frame Generation available in its
// video settings, and the Manager versions that DLL for it (framegen.js); layering an external
// generator on top is never the better option there, and two generators stacking frames is the
// exact failure the in-game panel warns about. So for those games the section is hidden, the
// profile is never written, and an old marker is never re-applied to the ini.
//
// "Its own DLSS" means the game SHIPPED it -- hasNativeDlss() only checks the disk, and both
// the Feeder and Luma UE deploys place nvngx_dlss.dll into a game that had none (same trap
// autoConfigureGame's isFeederGame guard exists for). Those games stay eligible: for them
// Lossless is the only Frame Generation route there is.
function losslessEligibility(dir) {
  const synthesised = isFeederGame(dir) || lumaue.lumaUeDeployed(dir);
  if (hasNativeDlss(dir) && !synthesised) {
    return {
      eligible: false,
      reason: 'This game has its own DLSS -- use its built-in DLSS Frame Generation (versioned above) instead of Lossless Scaling.',
    };
  }
  return { eligible: true };
}

ipcMain.handle('lossless:eligibility', (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { eligible: false, reason: 'Game .exe not found' };
  return losslessEligibility(gameDir(exePath));
});

function applyLosslessMarker(dir) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  const marker = readJson(path.join(dir, LOSSLESS_MARKER), null);
  if (!marker || !marker.exePath || !fs.existsSync(iniPath)) return [];
  // A marker left from before the gate (or from a game that has since gained native DLSS via an
  // update) must not resurrect the panel row: leave the ini alone, so it never gets the keys.
  if (!losslessEligibility(dir).eligible) return [];
  const applied = [];
  const set = (key, value) => {
    if (ensureIniKey(iniPath, 'DlssNr', key, value)) applied.push({ section: 'DlssNr', key, value });
  };
  set('LosslessScalingExePath', marker.exePath);
  if (marker.gameTitle) set('LosslessScalingGameTitle', marker.gameTitle);
  set('LosslessScalingMode', marker.mode === 'ADAPTIVE' ? 'ADAPTIVE' : 'FIXED');
  if (Number.isInteger(marker.multiplier) && marker.multiplier >= 2) set('LosslessScalingMultiplier', String(marker.multiplier));
  if (Number.isInteger(marker.target) && marker.target >= 30) set('LosslessScalingTarget', String(marker.target));
  // The in-game panel synthesizes Lossless Scaling's own toggle hotkey (read from its Settings.xml)
  // to turn Frame Gen on/off without ever showing its window. Default Ctrl+Alt+S = mods 3, vk 0x53.
  if (Number.isInteger(marker.hotkeyMods)) set('LosslessScalingHotkeyMods', String(marker.hotkeyMods));
  if (Number.isInteger(marker.hotkeyVk)) set('LosslessScalingHotkeyVk', String(marker.hotkeyVk));
  return applied;
}

ipcMain.handle('lossless:setExePathInGameIni', (_evt, { exePath, losslessExePath, gameTitle, mode, multiplier, target, hotkeyMods, hotkeyVk }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    // The renderer hides the section for these games; this is the backstop so a stale UI state
    // can't write a marker the gate would then have to keep ignoring forever.
    const gate = losslessEligibility(dir);
    if (!gate.eligible) throw new Error(gate.reason);
    writeJson(path.join(dir, LOSSLESS_MARKER), {
      exePath: losslessExePath,
      gameTitle: gameTitle || null,
      mode: mode === 'ADAPTIVE' ? 'ADAPTIVE' : 'FIXED',
      multiplier: Number(multiplier),
      target: Number(target),
      hotkeyMods: Number.isInteger(hotkeyMods) ? hotkeyMods : 3,
      hotkeyVk: Number.isInteger(hotkeyVk) ? hotkeyVk : 0x53,
      updatedAt: new Date().toISOString(),
    });
    if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return { ok: true, deferred: true };
    applyLosslessMarker(dir);
    return { ok: true, deferred: false };
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
    const api = await resolveApi(dir, exePath);
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

// Undoes feeder:deploy for one game. Two callers: a mis-deployed Feeder on a game that ships
// its own DLSS (feeder:readiness's misdeployed), and a user simply done with it. Resets
// [Plugins] LoadReshade (unless Luma UE still needs ReShade loaded) and re-runs the profile,
// so a game that ships DLSS comes out on the DLSS 5 only profile it should have had.
ipcMain.handle('feeder:remove', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const keepReShade = lumaue.lumaUeDeployed(dir);
    const result = await feeder.removeFeederStack(dir, { keepReShade });
    const iniPath = path.join(dir, 'OptiScaler.ini');
    let ini = [];
    if (fs.existsSync(iniPath)) {
      if (!keepReShade) ini = patchIniValues(iniPath, [{ section: 'Plugins', key: 'LoadReshade', value: 'auto' }]);
      const { applied } = await autoConfigureGame(dir, exePath);
      ini = [...ini, ...(applied || [])];
    }
    return { ok: true, ...result, ini };
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
    const detected = withApiOverride(await detectGame(dir, exePath), readApiOverride(dir));
    return { ok: true, ...lumaue.lumaUeReadiness(dir, exePath, detected) };
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
    const dir = gameDir(exePath);
    const detected = withApiOverride(await detectGame(dir, exePath), readApiOverride(dir));
    if (!lumaue.isLumaUeGame(exePath, detected)) throw new Error('Luma UE is for Unreal Engine 4 games rendering with DirectX 11 and no DLSS of their own');
    if (lumaue.lumaUeKnownBad(exePath)) throw new Error('Luma UE is known not to work with this game: ' + lumaue.lumaUeKnownBad(exePath));
    // Hand-over from the Feeder: the two are both ReShade add-ons supplying the DLSS call and
    // cannot share one ReShade. Its ReShade64.dll goes too -- Luma's deploy places its own.
    const feederRemoved = feeder.feederDeployed(dir)
      ? await feeder.removeFeederStack(dir, { keepReShade: false })
      : null;
    const results = await lumaue.deployLumaUeStack(dir, {
      cacheDir: lumaUeCacheDir(),
      getRhiManifest,
      compareVersions: compareStreamlineVersions,
      ghHeaders: GITHUB_HEADERS,
      force: !!force,
      licenseConfirmed: !!licenseConfirmed,
    });
    // The deploy places Luma's ReShade as a plain ReShade64.dll; nothing loads it until
    // OptiScaler.ini says [Plugins] LoadReshade=true. autoConfigureGame forces that once Luma is
    // on disk, but it only used to run on Install and at app start -- deploying Luma into an
    // already-installed game left ReShade unloaded (no Luma overlay, no DLSS call, the NR panel
    // stuck on "waiting") until the next launch of this app. Run it now.
    const configured = fs.existsSync(path.join(dir, 'OptiScaler.ini')) ? await autoConfigureGame(dir, exePath) : null;
    return { ok: true, ...results, feederRemoved, autoConfigured: configured ? configured.applied : [], optiScalerInstalled: !!configured };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Undoes lumaue:deploy for one game, the mirror of feeder:remove: the stack goes, [Plugins]
// LoadReshade returns to auto unless the Feeder still needs ReShade loaded, and the profile is
// re-run so the game lands where it should (the Feeder route, for a game Luma broke).
ipcMain.handle('lumaue:remove', async (_evt, { exePath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const result = await lumaue.removeLumaStack(dir);
    const iniPath = path.join(dir, 'OptiScaler.ini');
    let ini = [];
    if (fs.existsSync(iniPath)) {
      if (!feeder.feederDeployed(dir)) ini = patchIniValues(iniPath, [{ section: 'Plugins', key: 'LoadReshade', value: 'auto' }]);
      const { applied } = await autoConfigureGame(dir, exePath);
      ini = [...ini, ...(applied || [])];
    }
    return { ok: true, ...result, ini };
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
  // An Unreal root launcher stub is swapped for the shipping exe it spawns -- see detect.js.
  return resolveUnrealShippingExe(res.filePaths[0]);
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

function nrModelCacheDir() {
  return path.join(userDataDir(), 'nr-model');
}

// NVIDIA only ships the NR model inside driver packages, but RHI republishes it in the same
// manifest (its dlssnr list) the Feeder already trusts for nvngx_dlss.dll -- so the one file the
// setup guide used to make people dig out of a driver archive by hand can be fetched instead.
let nrFetchInFlight = null;

// One download at a time: the startup fetch and the Settings button share the same cache paths,
// so a second concurrent call joins the first instead of racing it for the same .part file.
ipcMain.handle('nrdll:autoFetch', () => {
  if (!nrFetchInFlight) {
    nrFetchInFlight = fetchNrModel().finally(() => { nrFetchInFlight = null; });
  }
  return nrFetchInFlight;
});

async function fetchNrModel() {
  let zipPath = null;
  try {
    const manifest = await getRhiManifest();
    const list = Array.isArray(manifest && manifest.dlssnr) ? manifest.dlssnr : [];
    if (list.length === 0) throw new Error("RHI's manifest lists no DLSS NR model build (offline, or none published yet)");
    const newest = [...list].sort((a, b) => compareStreamlineVersions(b.version, a.version))[0];
    const safe = String(newest.version).replace(/[^0-9A-Za-z.-]/g, '_');
    const dest = path.join(nrModelCacheDir(), `nvngx_dlssnr_${safe}.dll`);

    if (!fs.existsSync(dest)) {
      zipPath = await feeder.downloadToCache(newest.url, nrModelCacheDir(), `nvngx_dlssnr_${safe}.zip`, GITHUB_HEADERS);
      const zip = openZip(zipPath);
      const entry = findEntry(zip, /(^|\/)nvngx_dlssnr\.dll$/i);
      if (!entry) throw new Error('nvngx_dlssnr.dll not found inside the RHI package');
      extractEntryTo(zip, entry, `${dest}.part`);
      await fsp.rename(`${dest}.part`, dest);
    }

    const sizeMB = Math.round(fs.statSync(dest).size / 1024 / 1024);
    if (sizeMB < 50) {
      await fsp.rm(dest, { force: true });
      throw new Error(`The downloaded file is only ${sizeMB} MB -- not the real ~165 MB model`);
    }
    return { ok: true, path: dest, version: newest.version, sizeMB };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    // Success or failure, the zip goes: downloadToCache would hand a bad one back on every retry.
    if (zipPath) fsp.rm(zipPath, { force: true }).catch(() => {});
  }
}

// The newest NR model RHI publishes, and the cache file name fetchNrModel() would give it -- so
// the renderer can tell whether the model on disk is already that one without downloading.
ipcMain.handle('nrdll:latest', async () => {
  try {
    const manifest = await getRhiManifest();
    const list = Array.isArray(manifest && manifest.dlssnr) ? manifest.dlssnr : [];
    if (list.length === 0) return { ok: true, version: null };
    const newest = [...list].sort((a, b) => compareStreamlineVersions(b.version, a.version))[0];
    const safe = String(newest.version).replace(/[^0-9A-Za-z.-]/g, '_');
    return { ok: true, version: newest.version, cacheFile: `nvngx_dlssnr_${safe}.dll` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

// ── Per-game graphics API choice ─────────────────────────────────────────────
// Where Winds Meet links DX11 in its exe and ships a DX12 path beside it (see detect.js's
// folderApiEvidence); detection has to name one primary and names what the exe says. Which one
// the game actually runs is a setting in its own video options -- and every API-dependent
// decision here follows it: the upscaler key autoConfigureGame writes, whether the Feeder or
// OptiScaler's own Frame Generation apply, whether DLSS NR on AMD is offered. So a game that
// ships more than one gets a choice. Stored beside the exe like the other per-game markers, so
// every entry point (install, sync, deploy, the card) sees the same answer.
const API_OVERRIDE_MARKER = '.dlss5ui-api.json';

function readApiOverride(dir) {
  const marker = readJson(path.join(dir, API_OVERRIDE_MARKER), null);
  return marker && API_OVERRIDE_VALUES.includes(marker.api) ? marker.api : null;
}

function writeApiOverride(dir, api) {
  const file = path.join(dir, API_OVERRIDE_MARKER);
  if (!api) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  writeJson(file, { api, setAt: new Date().toISOString() });
}

// The primary API every handler should act on: the user's choice if there is one, else detection.
async function resolveApi(dir, exePath) {
  return readApiOverride(dir) || detectRenderApi(dir, exePath);
}

ipcMain.handle('game:setApiOverride', async (_evt, { exePath, api }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    if (api && !API_OVERRIDE_VALUES.includes(api)) throw new Error(`${api} is not a graphics API this app knows`);
    const dir = gameDir(exePath);
    writeApiOverride(dir, api || null);
    // An installed game's ini follows the choice right away (upscaler key, FG gate), the same
    // way optifg:set re-runs the configuration rather than waiting for the next sync.
    const configured = fs.existsSync(path.join(dir, 'OptiScaler.ini')) ? await autoConfigureGame(dir, exePath) : null;
    return { ok: true, api: api || null, applied: configured ? configured.applied : [] };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

function detectInstalledBackends(dir) {
  const has = (name) => fs.existsSync(path.join(dir, name));
  const optiscaler = has('OptiScaler.ini') && has('nvngx_dlssnr.dll');
  // Anything else of ours still in the folder once OptiScaler itself is gone -- so the card can
  // still offer Remove and take the folder the rest of the way back.
  // Only what an INSTALL leaves behind. The three preference markers (.dlss5ui-api.json,
  // .dlss5ui-lossless.json, .dlss5ui-optifg-enabled) are deliberately not here: each can be set
  // on a game before anything is installed -- choosing DX12 for Where Winds Meet in Edit wrote
  // .dlss5ui-api.json, this list then called it a leftover, and the card's Install button turned
  // into a red "Remove leftovers" that deleted the choice. Remove (the full uninstall) still
  // clears them via APP_MARKERS.
  const leftovers = [
    'OptiScaler.ini', 'OptiScaler.dll', 'nvngx_dlssnr.dll', 'nvngx.dll_dlssnr.dll', 'OptiScaler',
    'dlss5-feed.addon64', 'Luma-Unreal Engine.addon', 'Luma',
    '.dlss5ui-feeder-deploy.json', '.dlss5ui-lumaue-deploy.json', '.optiscaler-manager-install.json',
  ].filter(has);
  // What older versions placed and never journaled (Stellar Blade, 2026-09-12: OptiScaler_DlssNr.*
  // build files and the Feeder-era scripts survived a Remove on an old build, and with OptiScaler
  // itself gone the card offered no way back) -- same names the full Remove clears.
  try {
    for (const n of fs.readdirSync(dir)) {
      if (LEGACY_PAYLOAD.includes(n) || LEGACY_PATTERNS.some((p) => p.test(n))) leftovers.push(n);
    }
  } catch {}
  return { optiscaler, leftovers };
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
  // Cheap marker checks on every card render: another DLSS 5 toolchain in the folder is the
  // one thing that makes an otherwise correct install crash, so it is said on the card itself.
  const foreign = foreignToolchains(dir);
  const warnings = foreign.map((f) => ({
    message: 'Another DLSS 5 toolchain is installed here ({tool}: {files}) -- two stacks hooking the same DLSS call crash the game. Remove it with its own uninstaller before using this one.',
    vars: { tool: f.tool, files: f.files.join(', ') },
  }));
  return { exeMissing: false, hasIni, hasNr, hasUninstaller, dir, backends, foreign, warnings };
});

// The one-line answer the card tags and the Install button acts on -- see route.js. `detected`
// is the cached detection the renderer already holds for this game, so this never rescans the exe.
ipcMain.handle('game:route', async (_evt, { exePath, detected }) => {
  if (!exePath || !fs.existsSync(exePath)) {
    return { route: 'unknown', label: 'Exe missing', reason: 'Game .exe not found', steps: [], complete: false, nextStep: null };
  }
  const { vendor } = await getGpuInfo();
  const dir = gameDir(exePath);
  const effective = withApiOverride(detected || {}, readApiOverride(dir));
  return {
    ...recommendRoute(dir, exePath, effective, vendor),
    apiOverride: effective.apiOverride,
    effectiveApi: effective.api || null,
    detectedApi: (detected && detected.api) || null,
    detectedApis: (detected && detected.apis) || [],
  };
});

// ── DLSS NR on AMD (amdnr.js) ────────────────────────────────────────────────
// Phase 1: detect, explain, fetch the model file, link to the release page, run an installer
// the user already downloaded. Never downloads the tool itself -- see amdnr.js for why.
ipcMain.handle('amdnr:status', async (_evt, { exePath, api }) => {
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Game .exe not found' };
  const dir = gameDir(exePath);
  const { vendor } = await getGpuInfo();
  const status = amdnr.amdNrStatus(dir);
  const nrDllVersion = status.nrDllPresent ? await framegen.readDllVersion(execFileAsync, path.join(dir, 'nvngx_dlssnr.dll')) : null;
  return { ok: true, ...status, nrDllVersion, ...amdnr.amdNrEligibility(vendor, readApiOverride(dir) || api || null) };
});

ipcMain.handle('amdnr:latest', async () => {
  try {
    return { ok: true, ...(await amdnr.latestRelease(GITHUB_HEADERS)) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('amdnr:openReleasePage', () => {
  shell.openExternal(amdnr.AMDNR_RELEASE_PAGE);
});

// The plain 310.8.0 model build, into this game's folder. Shares the NVIDIA path's nr-model
// cache directory (different file name, so the SF build and this one never collide).
ipcMain.handle('amdnr:deployNrModel', async (_evt, { exePath, replace }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const cached = await amdnr.ensureAmdNrModelCache({ getRhiManifest, cacheDir: nrModelCacheDir(), ghHeaders: GITHUB_HEADERS });
    const result = await amdnr.deployAmdNrModel(dir, cached, { replace: !!replace });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Same shape as game:run-setup: the tool's own installer is interactive, so it gets a console
// the user answers in. Only ever runs a file already sitting in the game folder.
ipcMain.handle('amdnr:runSetup', (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const setup = path.join(dir, amdnr.AMDNR_SETUP_EXE);
    if (!fs.existsSync(setup)) throw new Error(`${amdnr.AMDNR_SETUP_EXE} is not in the game folder -- download it from the release page and put it beside the game exe first`);
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', amdnr.AMDNR_SETUP_EXE], { cwd: dir, detached: true, stdio: 'ignore', shell: false }).unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
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

    const journal = readInstallMarker(dir) || {};
    const added = new Set(journal.added || []);
    const replaced = [...(journal.replaced || [])];
    const oursAlready = OUR_INSTALL_SIGNS.some((n) => fs.existsSync(path.join(dir, n)));
    for (const entry of await fsp.readdir(releaseFolder, { withFileTypes: true })) {
      const src = path.join(releaseFolder, entry.name);
      const dest = path.join(dir, entry.name);
      const existed = fs.existsSync(dest);
      if (!existed) {
        added.add(entry.name);
      } else if (entry.isFile() && !oursAlready && !added.has(entry.name) && !replaced.some((r) => r.rel === entry.name)) {
        // Someone else's file under a payload name (a hand-installed OptiScaler, say): keep the
        // original so Remove can put it back exactly.
        const backup = entry.name + ORIG_BACKUP_SUFFIX;
        if (!fs.existsSync(path.join(dir, backup))) await fsp.copyFile(dest, path.join(dir, backup));
        replaced.push({ rel: entry.name, backup });
      }
      await fsp.cp(src, dest, { recursive: true, force: true });
    }
    updateInstallJournal(dir, { added: [...added], replaced });

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
    const feederGame = isFeederGame(dir);

    let proxy = null;
    let proxyError = null;
    try {
      proxy = await installProxy(dir, proxyName || DEFAULT_PROXY);
    } catch (err) {
      // Not fatal: everything else is in place, and Run Setup is still there to do it by hand.
      proxyError = err.message;
    }

    const { api, applied, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix, profile } = await autoConfigureGame(dir, exePath);

    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, proxy, proxyError, feederGame, api, autoConfigured: applied, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix, profile };
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

// Strips a game folder back to what it was before this app touched it: every stack it can
// deploy (Feeder, Luma UE, the FrameGen DLL swap, Streamline, REFramework), the OptiScaler
// payload and proxy, everything the install journal recorded as added, everything it recorded
// as replaced (put back from its backup), and every marker. A folder installed before the
// journal existed still gets the fixed payload list. Nothing here guesses at a file it did not
// place -- unknown files stay, and the report says so where a decision was made.
const RELEASE_LICENSE_FILES = ['DirectX_LICENSE.txt', 'FidelityFX_v2_LICENSE.md', 'RenoDX_ATTRIBUTION.txt', 'XeSS_LICENSE.txt'];
const APP_MARKERS = ['.dlss5ui-lossless.json', '.dlss5ui-api.json', '.dlss5ui-optifg-enabled', '.optiscaler-manager-install.json'];
const LEGACY_PAYLOAD = [
  'OptiScaler_DlssNr.addon64', 'OptiScaler_DlssNr.exp', 'OptiScaler_DlssNr.lib', 'OptiScaler_DlssNr.pdb', 'OptiScaler_DlssNr.dll',
  '.optdlss5-active-manifest.json', 'Verify-DLSS5Feeder.ps1', 'Run-DLSS5-Feeder-Install.bat', 'Remove_OptiScaler.bat',
  'dlss5-feed.cfg', 'dlss5-feed.log', 'dlss5-feed-crash.dmp',
];
const LEGACY_PATTERNS = [/^OptiScaler_DLSSNR-.*\.zip$/i, /\.release-backup$/i, /^ReShade\.log\d+$/i];

async function uninstallEverything(dir) {
  const removed = [];
  const restored = [];
  const kept = [];
  const journal = readInstallMarker(dir) || {};
  const rmRel = async (rel) => {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) return false;
    await fsp.rm(p, { recursive: true, force: true });
    removed.push(rel);
    return true;
  };
  const rmdirIfEmpty = (rel) => {
    try { if (fs.readdirSync(path.join(dir, rel)).length === 0) { fs.rmdirSync(path.join(dir, rel)); removed.push(rel); } } catch {}
  };

  if (feeder.feederDeployed(dir)) {
    const r = await feeder.removeFeederStack(dir, { keepReShade: false });
    removed.push(...r.removed); kept.push(...r.kept);
  }
  if (lumaue.lumaUeDeployed(dir) || fs.existsSync(path.join(dir, 'Luma-Unreal Engine.addon'))) {
    const r = await lumaue.removeLumaStack(dir);
    removed.push(...r.removed); kept.push(...r.kept);
  }
  try {
    const fg = await framegen.restoreFrameGenDll(dir);
    if (fg.restored) restored.push(path.basename(fg.file || 'nvngx_dlssg.dll'));
  } catch {}
  if (journal.streamline && journal.streamline.dir) {
    for (const f of journal.streamline.files || []) await rmRel(path.join(journal.streamline.dir, f));
    rmdirIfEmpty(journal.streamline.dir);
  }
  if (journal.reframework) {
    await rmRel(REFRAMEWORK_DLL_NAME);
    await rmRel(REFRAMEWORK_CONFIG_NAME);
    await rmRel('reframework');
  }

  const core = await uninstallOptiScaler(dir);
  removed.push(...core.removed); kept.push(...core.kept);
  if (core.nrDllRemoved && !removed.includes('nvngx_dlssnr.dll')) removed.push('nvngx_dlssnr.dll');

  for (const rel of journal.added || []) await rmRel(rel);
  for (const r of journal.replaced || []) {
    const backup = path.join(dir, r.backup);
    if (!fs.existsSync(backup)) continue;
    await fsp.rm(path.join(dir, r.rel), { recursive: true, force: true });
    await fsp.rename(backup, path.join(dir, r.rel));
    restored.push(r.rel);
  }
  // Any backup the journal lost track of (an older marker, a hand-edited one): the suffix alone
  // says what it is and where it goes back.
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(ORIG_BACKUP_SUFFIX)) continue;
    const rel = name.slice(0, -ORIG_BACKUP_SUFFIX.length);
    await fsp.rm(path.join(dir, rel), { recursive: true, force: true });
    await fsp.rename(path.join(dir, name), path.join(dir, rel));
    if (!restored.includes(rel)) restored.push(rel);
  }

  // Payload names from before the journal existed. Licenses/ only loses the files the release
  // ships and the folder itself only once empty -- a game's own Licenses folder is not ours.
  for (const rel of ['OptiScaler', '!! EXTRACT ALL FILES TO GAME FOLDER !!', 'setup_linux.sh']) await rmRel(rel);
  for (const f of RELEASE_LICENSE_FILES) await rmRel(path.join('Licenses', f));
  rmdirIfEmpty('Licenses');
  for (const m of APP_MARKERS) await rmRel(m);

  // What older versions of this app placed and never journaled: engine build artifacts from
  // early releases, the previous marker name, a verification script, an engine zip dropped in
  // the folder, the old proxy-backup name, ReShade's rotated logs. Seen on real folders
  // (Zero Company, Halloween, Batman, 2026-09-12) after a Remove that left them all behind.
  for (const rel of LEGACY_PAYLOAD) await rmRel(rel);
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) {
    if (LEGACY_PATTERNS.some((p) => p.test(name))) await rmRel(name);
  }
  // A Feeder-era folder whose add-on is already gone (an older Remove took only OptiScaler):
  // the shader folder's DLSS5_Feed.fx is the proof, and then the ReShade files were ours too --
  // unless another toolchain is here, whose ReShade they may be.
  const foreign = foreignToolchains(dir);
  const feederEra = fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'));
  if (feederEra && !foreign.length) {
    for (const n of ['ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', 'reshade-shaders']) await rmRel(n);
  }
  // nvngx_dlss.dll beside the exe is ours when the game keeps its own DLSS in its plugin tree
  // (the beside-the-exe copy is the duplicate a mis-deploy left) or when the Feeder era placed
  // it. A game that ships DLSS beside its exe (Streamline games, Tomb Raider) keeps its own.
  const shippedElsewhere = nativeDlss.shippedDlssPath(dir) && !fs.existsSync(path.join(dir, 'sl.interposer.dll')) && !fs.existsSync(path.join(dir, 'sl.interposer.dll.original'));
  if (fs.existsSync(path.join(dir, 'nvngx_dlss.dll')) && (shippedElsewhere || feederEra)) await rmRel('nvngx_dlss.dll');
  // A streamline\ folder beside the exe is only ours when the journal says so (handled above).
  // Where Winds Meet keeps its own Streamline runtime in exactly such a subfolder, and a
  // heuristic here deleted it once (2026-09-12) -- never again.
  if (fs.existsSync(path.join(dir, 'streamline', 'sl.interposer.dll')) && !(journal.streamline && journal.streamline.dir)) {
    kept.push('streamline folder (left alone: not recorded as this app\x27s deploy -- a game can keep its own Streamline runtime there)');
  }

  // Another tool's files are not this app's to delete -- named so the user knows they remain.
  for (const f of foreignToolchains(dir)) kept.push(`${f.tool} files, not placed by this app: ${f.files.join(', ')}`);

  return { removed: [...new Set(removed)], restored, kept };
}

// What uninstallEverything() would do, read-only, for the confirmation text -- the same lists
// and markers it acts on, none of the actions. Kept in step with it: a deletion that this does
// not name is a bug in one of the two. (The Streamline deletion of 2026-09-12 is why this exists.)
async function planUninstall(dir) {
  const remove = new Set();
  const restore = [];
  const kept = [];
  const has = (rel) => fs.existsSync(path.join(dir, ...rel.split(/[\\/]/)));
  const add = (rel) => { if (has(rel)) remove.add(rel); };
  const journal = readInstallMarker(dir) || {};
  const feederMarker = readJson(path.join(dir, '.dlss5ui-feeder-deploy.json'), null);
  const lumaMarker = readJson(path.join(dir, '.dlss5ui-lumaue-deploy.json'), null);
  if (feeder.feederDeployed(dir)) {
    for (const n of ['dlss5-feed.addon64', 'dlss5-feed.cfg', 'dlss5-feed.log', 'ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', '.dlss5ui-feeder-deploy.json']) add(n);
    const shaders = ['DLSS5_Feed.fx', 'ReShade.fxh', 'ReShadeUI.fxh'];
    for (const p of Object.values(feeder.MV_PROVIDERS)) shaders.push(...(p.files || []));
    for (const f of shaders) add('reshade-shaders/Shaders/' + f);
    if (nativeDlss.shippedDlssPath(dir) || !(feederMarker && feederMarker.placedNvngxDlss === false)) add('nvngx_dlss.dll');
  }
  if (lumaue.lumaUeDeployed(dir) || has('Luma-Unreal Engine.addon')) {
    for (const n of ['Luma', 'Luma-Unreal Engine.addon', 'ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', '.dlss5ui-lumaue-deploy.json']) add(n);
    if (!(lumaMarker && lumaMarker.placedNvngxDlss === false)) add('nvngx_dlss.dll');
  }
  try {
    const fg = framegen.frameGenSwapState(dir);
    if (fg.hasFrameGen && fs.existsSync(fg.dllPath + '.dlss5ui-fgbackup')) restore.push(path.basename(fg.dllPath));
  } catch {}
  if (journal.streamline && journal.streamline.dir) for (const f of journal.streamline.files || []) add(path.join(journal.streamline.dir, f));
  if (journal.reframework) { add(REFRAMEWORK_DLL_NAME); add(REFRAMEWORK_CONFIG_NAME); add('reframework'); }
  if (journal.proxy) add(journal.proxy);
  if (journal.backedUp && has(journal.backedUp)) restore.push(`${journal.proxy} (from ${journal.backedUp})`);
  for (const n of ['OptiScaler.dll', 'OptiScaler.ini', 'OptiScaler.log', 'nvngx.dll_dlssnr.dll', 'Remove_OptiScaler.bat', 'setup_windows.bat', 'setup_linux.sh', 'nvngx_dlssnr.dll', 'OptiScaler', '!! EXTRACT ALL FILES TO GAME FOLDER !!']) add(n);
  for (const f of RELEASE_LICENSE_FILES) add('Licenses/' + f);
  for (const rel of journal.added || []) add(rel);
  for (const r of journal.replaced || []) if (has(r.backup)) restore.push(r.rel);
  for (const m of APP_MARKERS) add(m);
  for (const rel of LEGACY_PAYLOAD) add(rel);
  const feederEra = has('reshade-shaders/Shaders/DLSS5_Feed.fx');
  const foreign = foreignToolchains(dir);
  if (feederEra && !foreign.length) for (const n of ['ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', 'reshade-shaders']) add(n);
  const shippedElsewhere = nativeDlss.shippedDlssPath(dir) && !has('sl.interposer.dll') && !has('sl.interposer.dll.original');
  if (shippedElsewhere || feederEra) add('nvngx_dlss.dll');
  try {
    for (const n of fs.readdirSync(dir)) {
      if (LEGACY_PATTERNS.some((p) => p.test(n))) remove.add(n);
      if (n.endsWith(ORIG_BACKUP_SUFFIX)) restore.push(n.slice(0, -ORIG_BACKUP_SUFFIX.length));
    }
  } catch {}
  for (const f of foreign) kept.push(`${f.tool}: ${f.files.join(', ')}`);
  if (has('streamline/sl.interposer.dll') && !(journal.streamline && journal.streamline.dir)) kept.push('streamline folder (not recorded as this app\'s deploy)');
  return { ok: true, remove: [...remove].sort(), restore: [...new Set(restore)], kept };
}

ipcMain.handle('game:uninstallPlan', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    return await planUninstall(gameDir(exePath));
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('game:run-uninstall', async (_evt, exePath) => {
  const dir = gameDir(exePath);
  try {
    // Done here rather than by spawning the generated .bat: that script asks its own questions in
    // a console the app cannot see, and decides what to restore by guessing from filenames. This
    // reverses what the install recorded it did -- and every other stack this app deploys.
    const result = await uninstallEverything(dir);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The explicit, double-confirmed removal of another DLSS 5 toolchain. The card already asked once
// (warning 1 of 2, renderer); this shows the second, native confirmation with the exact file list
// and then deletes only what the plan names. Never runs without both.
ipcMain.handle('game:removeForeign', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const ours = feeder.feederDeployed(dir) || lumaue.lumaUeDeployed(dir);
    const plan = await planForeignRemoval(dir, { ours });
    if (!plan.found.length) return { ok: true, cancelled: false, removed: [], restored: [], notes: ['nothing recognised'] };
    if (!plan.del.length && !plan.restore.length) return { ok: true, cancelled: false, removed: [], restored: [], notes: plan.notes };
    const tools = plan.found.map((f) => f.tool).join(', ');
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Delete these files', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Warning 2 of 2 -- delete the other DLSS 5 toolchain',
      message: `Delete ${plan.del.length} item(s) placed by ${tools}?`,
      detail: `Will delete:\n  ${plan.del.join('\n  ')}` +
        (plan.restore.length ? `\n\nWill restore from that tool's backups:\n  ${plan.restore.map((r) => r.to).join('\n  ')}` : '') +
        '\n\nIf that tool modified game files in place without leaving a backup, those cannot be restored here and the game may break -- verify the game files through its store afterwards if it does. Your own OptiScaler install here is not touched.',
    });
    if (res.response !== 0) return { ok: true, cancelled: true };
    const done = await executeForeignRemoval(dir, plan);
    return { ok: true, cancelled: false, ...done, notes: plan.notes };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

async function executeForeignRemoval(dir, plan) {
  const removed = [];
  const restored = [];
  for (const r of plan.restore) {
    const backup = path.join(dir, r.backup);
    const to = path.join(dir, r.to);
    if (!fs.existsSync(backup)) continue;
    await fsp.rm(to, { recursive: true, force: true });
    await fsp.rename(backup, to);
    restored.push(r.to);
  }
  for (const rel of plan.del) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) continue;
    await fsp.rm(p, { recursive: true, force: true });
    removed.push(rel);
  }
  return { removed, restored };
}

// Settings > "Clean a game folder...": the full Remove for a game that is no longer on the grid
// (removed from the list by an older version that only took OptiScaler out), then -- with its own
// warning -- the other-toolchain removal if one is found. Both steps confirm natively first.
ipcMain.handle('game:cleanFolder', async (_evt, { folder }) => {
  try {
    if (!folder || !fs.existsSync(folder)) throw new Error('Folder not found');
    const dir = folder;
    const backends = detectInstalledBackends(dir);
    let legacy = [];
    try { legacy = fs.readdirSync(dir).filter((n) => LEGACY_PAYLOAD.includes(n) || LEGACY_PATTERNS.some((p) => p.test(n))); } catch {}
    const found = [...new Set([...backends.leftovers, ...legacy])];
    const first = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Clean this folder', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Clean a game folder',
      message: `Remove everything this app ever put in ${path.basename(dir)}?`,
      detail: (found.length ? `Found here now:\n  ${found.join('\n  ')}\n\n` : 'Nothing of this app\'s was recognised here, but the full Remove will still run.\n\n') +
        'This removes OptiScaler, the Feeder or Luma UE, Streamline, REFramework, swapped DLLs and every marker this app placed, and puts back anything it renamed or replaced. Files it did not place are left alone.',
    });
    if (first.response !== 0) return { ok: true, cancelled: true };
    const result = await uninstallEverything(dir);
    const plan = await planForeignRemoval(dir, { ours: false });
    let foreignDone = null;
    if (plan.found.length && (plan.del.length || plan.restore.length)) {
      const tools = plan.found.map((f) => f.tool).join(', ');
      const second = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Delete these files', 'Leave them'],
        defaultId: 1,
        cancelId: 1,
        title: 'Another DLSS 5 toolchain is here',
        message: `Also delete ${plan.del.length} item(s) placed by ${tools}?`,
        detail: `Will delete:\n  ${plan.del.join('\n  ')}` +
          (plan.restore.length ? `\n\nWill restore from that tool's backups:\n  ${plan.restore.map((r) => r.to).join('\n  ')}` : '') +
          '\n\nIf that tool modified game files in place without leaving a backup, those cannot be restored here and the game may break -- verify the game files through its store afterwards if it does.',
      });
      if (second.response === 0) foreignDone = await executeForeignRemoval(dir, plan);
    }
    return { ok: true, cancelled: false, folder: dir, ...result, foreign: foreignDone };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
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
    detail: 'Removing OptiScaler deletes the files this app installed and puts back anything it renamed. No terminal.'
  });
  return ['remove-and-forget', 'forget-only', 'cancel'][res.response] || 'cancel';
});

// What the last run's logs say -- see runlog.js for the verdicts and where each was met.
ipcMain.handle('game:lastRun', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ran: false, verdict: 'no-log' };
    return await runlog.analyzeRun(gameDir(exePath));
  } catch (error) {
    return { ran: false, verdict: 'no-log', error: String(error && error.message ? error.message : error) };
  }
});

// One zip with everything a helper asks for, saved where the user picks. The app's own view
// (detection, route, status, last-run verdict, version) goes in as app-view.json.
ipcMain.handle('game:supportBundle', async (_evt, { exePath, detected }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const base = path.basename(exePath, path.extname(exePath)).replace(/[^A-Za-z0-9._-]+/g, '_');
    const res = await dialog.showSaveDialog({
      title: 'Save support bundle',
      defaultPath: path.join(app.getPath('desktop'), `${base}-support-${stamp}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { ok: true, cancelled: true };
    const effective = withApiOverride(detected || {}, readApiOverride(dir));
    const extra = {
      appVersion: app.getVersion(),
      detection: effective,
      route: recommendRoute(dir, exePath, effective, ((await getGpuInfo()) || {}).vendor || 'unknown'),
      backends: detectInstalledBackends(dir),
      foreign: foreignToolchains(dir),
    };
    const out = await runlog.collectSupportBundle(dir, { zipPath: res.filePath, extra, execFileAsync });
    return { ok: true, cancelled: false, ...out };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The exe a Launch should run. An Unreal game's card may point at the launcher stub in the
// install root (the exe the store lists); the process that actually renders is the
// <Project>-Win64-Shipping.exe under <Project>\Binaries\Win64, and that is what OptiScaler is
// installed beside -- so that is what runs. Anything else runs as it is.
function launchTarget(exePath) {
  if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
  const resolved = resolveUnrealShippingExe(exePath);
  return fs.existsSync(resolved) ? resolved : exePath;
}

ipcMain.handle('game:launch', async (_evt, { exePath, dryRun = false } = {}) => {
  try {
    const target = launchTarget(exePath);
    // A Steam-installed game goes through Steam: its DRM, overlay, cloud saves and launch
    // options all expect that, and some games refuse to start any other way. Steam then runs the
    // same exe (through the game's own stub where it has one). Everything else runs directly.
    const steamAppId = library.steamAppIdFor(target);
    if (steamAppId) {
      if (!dryRun) await shell.openExternal(`steam://rungameid/${steamAppId}`);
      return { ok: true, target, via: 'steam', steamAppId };
    }
    if (!dryRun) {
      // Detached, own folder as cwd (Unreal and Unity both resolve their data relative to it),
      // nothing inherited from this app: the game outlives the manager if it is closed.
      const child = spawn(target, [], { cwd: path.dirname(target), detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    }
    return { ok: true, target, via: 'exe' };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('game:open-folder', (_evt, exePath) => {
  shell.openPath(gameDir(exePath));
});

ipcMain.handle('shell:openPath', (_evt, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

// Engine + graphics API detection lives in detect.js. Results are cached per game in games.json;
// the renderer asks for a refresh through game:detect-path-if-stale, which re-runs detection when
// the rules have changed since the cached result (DETECT_VERSION) or the result was provisional
// (a Unity game that has not been run yet, so its Player.log could not settle the API).
ipcMain.handle('game:detect-path', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { recommend: 'unknown', reason: 'executable not found' };
    return await detectGame(gameDir(exePath), exePath);
  } catch (error) {
    return { recommend: 'unknown', reason: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('game:detect-path-if-stale', async (_evt, { exePath, stored }) => {
  const dir = exePath && fs.existsSync(exePath) ? gameDir(exePath) : null;
  if (!isDetectionStale(stored, dir)) return null;
  try {
    if (!exePath || !fs.existsSync(exePath)) return { recommend: 'unknown', reason: 'executable not found' };
    return await detectGame(gameDir(exePath), exePath);
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
  if (copied.length > 0) {
    const prior = (readInstallMarker(dir) || {}).streamline || {};
    updateInstallJournal(dir, { streamline: { dir: path.relative(dir, dest), files: [...new Set([...(prior.files || []), ...copied])] } });
  }
  return {
    deployed: copied.length > 0,
    files: copied,
    version: release.version,
    reason: release.reason,
  };
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
  updateInstallJournal(dir, { reframework: true });
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
// See native-dlss.js: beside the exe OR under an Unreal plugin tree -- the exe-folder-only
// check this used to be put the Feeder on top of Code Vein 2's real DLSS (2026-09-11).
function hasNativeDlss(dir) {
  return nativeDlss.hasNativeDlss(dir);
}

// A game the Feeder is (or was) the DLSS source for. needsFeeder() flips false once the deploy
// places nvngx_dlss.dll, so the deploy marker keeps it true afterwards -- but never for a game
// that ships its own DLSS: a Feeder there is a mis-deploy (see feeder:readiness), and treating
// it as a Feeder game would keep forcing [Plugins] LoadReshade=true, i.e. keep loading the
// add-on that crashes it.
function isFeederGame(dir) {
  return !nativeDlss.shipsNativeDlss(dir) && (feeder.needsFeeder(dir) || feeder.feederDeployed(dir));
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
// Every API the game can run on gets its key, not just the one it defaults to: a Unity or Unreal
// game that also ships a DX12 path must keep its DLSS there too, and an unused key is harmless.
// The Neural Rendering pass runs in D3D12 (and Vulkan) only. A DLSS call that arrives through
// the D3D11 NGX entry points -- Luma UE on Fallen Order, or any native D3D11 DLSS game -- has to
// be lifted onto a D3D12 command list first, which is exactly what OptiScaler's dlss_12
// (DLSSFeature_Dx11On12, the Dx11wDx12 interop path) does; plain dlss (DLSSFeature_Dx11) runs
// native D3D11 DLSS and the NR pass never gets a chance to run. Found live (Fallen Order +
// Luma, 2026-09-11): the feature was created, nothing evaluated, the panel said "waiting".
const UPSCALER_VALUE_FOR_API = { dx11: 'dlss_12', dx12: 'dlss', vulkan: 'dlss' };

function keepGamesOwnDlss(apis) {
  return apis
    .filter((api) => UPSCALER_KEY_FOR_API[api])
    .map((api) => ({ section: 'Upscalers', key: UPSCALER_KEY_FOR_API[api], value: UPSCALER_VALUE_FOR_API[api] || 'dlss' }));
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
    return { supported: false, reason: "OptiScaler's own Frame Generation needs the game's swapchain to be D3D12 -- this game is {api}.", reasonVars: { api: api || 'not yet detected' } };
  }
  // Crashes on a real game: our exported NGX Shutdown1 forwards into NVIDIA's real
  // _nvngx.dll while the Feeder's own private DX12 NGX session is still live, and NVIDIA's
  // side null-derefs. Confirmed via a symbolicated minidump (Bodycam, 2026-09-09) -- not a
  // theoretical risk. Block the combo until that interaction is actually fixed.
  if (isFeederGame(dir)) {
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

  const { api, apis } = withApiOverride(await detectGame(dir, exePath), readApiOverride(dir));
  const dlss5Only = hasNativeDlss(dir);
  // hasNativeDlss() just checks for nvngx_dlss.dll on disk -- for a Feeder game that file was
  // placed by the Feeder deploy itself, not the game, so this alone can't tell native DLSS
  // apart from Feeder-supplied. Excluded explicitly: Feeder + FSRFG crashed on a real game
  // (confirmed via a symbolicated minidump) -- see optiFgReadiness's own guard above.
  const feederGame = isFeederGame(dir);
  const optiFgOn = dlss5Only && api === 'dx12' && !feederGame && isOptiFgEnabled(dir);
  const edits = [];

  if (!dlss5Only) edits.push(...keepGamesOwnDlss(apis));

  // Only force DlssNr on when the actual model file is present -- forcing it on every game
  // regardless (including ones where NR was never installed) risks the pass trying to initialize
  // with nothing to run, which crashed launches. See the "won't launch" report.
  if (fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) {
    edits.push({ section: 'DlssNr', key: 'Enabled', value: 'true' });
  }

  // OptiScaler's own default is no log file at all, and its "auto" level is Trace. Every support
  // question about this app starts with "what does OptiScaler.log say" -- so a log, at Info.
  // Defaults only: a level someone set by hand (Debug for a repro) is left alone.
  edits.push({ section: 'Log', key: 'LogToFile', value: 'true' });
  edits.push({ section: 'Log', key: 'LogLevel', value: '2' });

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
    ? patchIniValues(iniPath, [...(optiFgOn ? OPTIFG_FORCED : DLSS5_ONLY_FORCED), ...keepGamesOwnDlss(apis)])
    : [];
  if (feederGame && feeder.feederDeployed(dir)) forced = [...forced, ...patchIniValues(iniPath, LOAD_RESHADE_FORCED)];
  // Luma UE deploys its own ReShade64.dll the same non-proxying way the Feeder does (see
  // lumaue.js's file header) -- OptiScaler needs the same explicit LoadReshade nudge to load it.
  if (lumaue.lumaUeDeployed(dir)) forced = [...forced, ...patchIniValues(iniPath, LOAD_RESHADE_FORCED)];
  forced = [...forced, ...applyLosslessMarker(dir)];
  forced = [...forced, ...applyPanelLanguage(dir)];
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

ipcMain.handle('game:sync-if-stale', async (_evt, { exePath, releaseFolder, nrDllPath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: true, updated: false, reason: 'exe missing' };
    const dir = gameDir(exePath);
    if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return { ok: true, updated: false, reason: 'not installed' };

    const { api, applied: autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix } = await autoConfigureGame(dir, exePath);

    // The NR model beside the exe follows the one in Settings: a newer model fetched at launch
    // reaches every installed game on the next sync instead of waiting for a reinstall. Size is
    // the comparison -- two different builds of a 165 MB model do not share a byte count, and
    // hashing that much per game on every launch would not be worth what it adds.
    let nrUpdated = false;
    if (nrDllPath && fs.existsSync(nrDllPath)) {
      const gameNr = path.join(dir, 'nvngx_dlssnr.dll');
      if (fs.existsSync(gameNr) && fs.statSync(gameNr).size !== fs.statSync(nrDllPath).size) {
        await fsp.copyFile(nrDllPath, gameNr);
        nrUpdated = true;
      }
    }

    const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
    if (!releaseDll || !fs.existsSync(releaseDll)) {
      return { ok: true, updated: autoConfigured.length > 0 || nrUpdated, nrUpdated, reason: 'no release set', api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
    }

    if (!hasDlssNrSection(releaseFolder)) {
      return {
        ok: true, updated: autoConfigured.length > 0 || nrUpdated, nrUpdated,
        reason: 'release folder is not the DLSS-NR fork (no [DlssNr] section) -- refusing to sync', api, autoConfigured, streamline, reEngine, reframework
      };
    }

    const active = await findActiveOptiScalerFile(dir);
    if (!active) {
      return {
        ok: true, updated: autoConfigured.length > 0 || nrUpdated, nrUpdated,
        reason: 'could not identify the active OptiScaler file (ambiguous proxy candidates)', api, autoConfigured, streamline, reEngine, reframework
      };
    }

    if (sha256File(releaseDll) === sha256File(active.file)) {
      return { ok: true, updated: autoConfigured.length > 0 || nrUpdated, nrUpdated, reason: 'up to date', api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});

    return { ok: true, updated: true, nrUpdated, file: path.basename(active.file), api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
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

// The install journal: the same marker file, grown into a record of everything this app put in
// the folder (`added`), every file of someone else's it overwrote and backed up (`replaced`), and
// which optional stacks it deployed (`streamline`, `reframework`). uninstallEverything() reverses
// it; a folder installed before the journal existed still gets the fixed payload list.
function updateInstallJournal(dir, patch) {
  const current = readInstallMarker(dir) || {};
  writeJson(path.join(dir, INSTALL_MARKER), { ...current, ...patch });
}

const ORIG_BACKUP_SUFFIX = '.dlss5ui-orig';
// Files this app's own earlier installs leave behind: a payload-named file beside any of these
// is ours, not the game's, and is overwritten without a backup.
const OUR_INSTALL_SIGNS = ['nvngx_dlssnr.dll', 'nvngx.dll_dlssnr.dll', INSTALL_MARKER];

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
  updateInstallJournal(dir, {
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

    // The engine zip ships inside the installer now, with its tag beside it -- no network needed
    // to know what this build was tested with. The release-asset lookup stays as the fallback for
    // builds made before the bundle existed.
    let bundledEngineTag = (bundledEngine() || {}).tag || null;
    if (!bundledEngineTag) {
      const ownRes = await fetch(`https://api.github.com/repos/${MANAGER_REPO}/releases/tags/${encodeURIComponent(currentTag)}`, { headers: GITHUB_HEADERS });
      if (ownRes.ok) {
        const ownRelease = await ownRes.json();
        const zipAsset = (ownRelease.assets || []).find((a) => /^OptiScaler_DLSSNR-.*\.zip$/i.test(a.name));
        const m = zipAsset && zipAsset.name.match(/^OptiScaler_DLSSNR-(.+)\.zip$/i);
        if (m) bundledEngineTag = m[1];
      }
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

// The self-updater (src/manager-update.js): state for the banner, a manual check that also
// downloads, and the restart that installs what was downloaded.
ipcMain.handle('update:managerState', () => managerUpdate.snapshot());
ipcMain.handle('update:managerCheck', () => managerUpdate.check());
ipcMain.handle('update:managerRestart', () => managerUpdate.restart());

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

// The engine zip electron-builder packed beside the app (release.yml fetches it into engine/
// before the build), plus the tag it was cut from. Null when running from source without one.
function bundledEngine() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(__dirname, '..', 'engine');
  const zipPath = path.join(root, 'OptiScaler_DLSSNR.zip');
  const versionFile = path.join(root, 'VERSION');
  if (!fs.existsSync(zipPath) || !fs.existsSync(versionFile)) return null;
  const tag = fs.readFileSync(versionFile, 'utf-8').trim();
  return tag ? { tag, zipPath } : null;
}

// The one folder this app owns and may overwrite. A release folder the user pointed Settings at
// (their own build) is theirs: read from, never extracted into or deleted.
function managedReleaseFolder() {
  return path.join(userDataDir(), 'OptiScalerRelease');
}

ipcMain.handle('update:bundledEngine', () => ({ ...(bundledEngine() || {}), managedFolder: managedReleaseFolder() }));

// localZip: extract an already-downloaded zip (the bundled engine) instead of fetching downloadUrl.
// Always lands in the managed folder, and the live copy is only replaced once the new one has
// extracted and validated -- a truncated zip or a blocked Expand-Archive leaves a working engine
// exactly as it was.
ipcMain.handle('update:install', async (_evt, { downloadUrl, localZip, tag }) => {
  let tmpZip;
  const dest = managedReleaseFolder();
  const staging = `${dest}.new`;
  try {
    let zipPath = localZip;
    if (!zipPath) {
      const res = await fetch(downloadUrl, { headers: GITHUB_HEADERS });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      tmpZip = path.join(os.tmpdir(), `optiscaler-update-${Date.now()}.zip`);
      await fsp.writeFile(tmpZip, buf);
      zipPath = tmpZip;
    }

    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });

    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:OSM_ZIP -DestinationPath $env:OSM_DEST -Force'
    ], { env: { ...process.env, OSM_ZIP: zipPath, OSM_DEST: staging } });

    if (!findReleaseRoot(staging)) throw new Error('Extracted update, but setup_windows.bat was not found inside it');

    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(staging, dest);

    return { ok: true, folder: findReleaseRoot(dest), tag };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tmpZip) fsp.rm(tmpZip, { force: true }).catch(() => {});
    fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
});
