const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');

const discover = require('./discover');
const { scanForGames } = discover;
const framegen = require('./framegen');
const injector = require('./injector');
const feeder = require('./feeder');
const relimiter = require('./relimiter');
const addons = require('./addons');
const lossless = require('./lossless');
const reengine = require('./reengine');
const integrity = require('./integrity');
const presentroute = require('./presentroute');
const lumaue = require('./lumaue');
const nativeDlss = require('./native-dlss');
const { recommendRoute, withApiOverride, API_OVERRIDE_VALUES } = require('./route');
const gpu = require('./gpu');
const emulators = require('./emulators');
const amdnr = require('./amdnr');
const nrmodelonly = require('./nrmodelonly');
const helpfix = require('./helpfix');
const { EARLY_PROXY_CANDIDATES, HOOK_DLLS, detectGameCached, invalidateDetection, peOriginalFilename, isDetectionStale, isReEngineGame, isUnityGame, agilityRedistRisk, antiCheatStub, antiCheatPresent, peImports, peBitness, resolveUnrealShippingExe, foreignToolchains, planForeignRemoval } = require('./detect');
const { openZip, findEntry, extractEntryTo } = require('./zip');
const dlssnr = require('./dlssnr');
const exeicon = require('./exeicon');
const managerUpdate = require('./manager-update');
const runlog = require('./runlog');
const library = require('./library');
const steamgrid = require('./steamgrid');
const lumacatalog = require('./lumacatalog');
const ghreport = require('./ghreport');
const reportinfo = require('./reportinfo');
const gamehelp = require('./gamehelp');
const aihelp = require('./aihelp');
const engines = require('./engines');
const pdplugin = require('./pdplugin');
const rtxmfg = require('./rtxmfg');
const legacy = require('./legacy');
const gameupdate = require('./gameupdate');
const probe = require('./probe');
const preflight = require('./preflight');
const gpupref = require('./gpupref');
const verify = require('./verify');
const translation = require('./translation');
const catalog = require('./catalog');
const routescore = require('./routescore');
const editmenu = require('./editmenu');
const fgsuggest = require('./fgsuggest');
const launchwatch = require('./launchwatch');
const defender = require('./defender');
const elevate = require('./elevate');
const saferemove = require('./saferemove');
const dfc = require('./dfc');
const dfccfg = require('./dfccfg');
const panelwindow = require('./panelwindow');
const panelroute = require('./panelroute');
const { netFetch } = require('./net');
let electronAutoUpdater = null;
try { ({ autoUpdater: electronAutoUpdater } = require('electron-updater')); } catch { electronAutoUpdater = null; }
const ENGINE_KNOWN_GAMES = new Set(require('./engine-known-games.json').exeNames);
const execFileAsync = promisify(execFile);

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

// Written beside the target and renamed over it: writeFileSync truncates first, so a reader that
// arrived in that window got half a file or none. games.json is written from the grid while the
// grid is also reading it, and a corrupt games.json reads back as an empty library.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    // The packaged exe carries build/icon.ico; this covers the window and taskbar when run from source.
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Right-click Cut/Copy/Paste/Select all. A BrowserWindow has no context menu of its own, and this
  // window hides its menu bar, so without this there was no discoverable way to paste a path into a
  // field or copy an error message out of a panel -- only the keyboard shortcuts, if you knew them.
  editmenu.attach(win.webContents, { Menu, clipboard });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // The pop-out panel is hidden rather than closed, so it would keep the app alive after the main
  // window has gone -- and it is skipTaskbar, so there would be nothing left to click.
  win.on('closed', () => panelwindow.destroy());
}

app.whenReady().then(() => {
  // Luma-Framework's per-game mods: the cached list now, a fresh one from GitHub in the background and daily.
  lumacatalog.load(lumaCatalogFile());
  refreshLumaCatalog();
  // The known-good catalog's local half: this machine's own runs (catalog.js learnFromRun).
  catalog.configure({ localFile: () => path.join(userDataDir(), 'known-good.local.json') });
  setInterval(refreshLumaCatalog, 24 * 60 * 60 * 1000);
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
  applyPanelHotkey();
  applyNrOnEverywhere();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// A global shortcut outlives the window that registered it, so it has to be handed back explicitly.
app.on('will-quit', () => panelwindow.unregisterHotkey());

ipcMain.handle('data:load', () => {
  // A game whose recorded exe is not an executable repairs itself here rather than staying broken.
  // An Xbox / Microsoft Store install could end up with its Content FOLDER stored as the exe (#93),
  // and every install then went beside a folder: no API detected, nothing ever loaded, and the only
  // symptom the user saw was "DLSS 5 makes no difference". A path that is merely missing is left
  // alone -- that is an unplugged drive, and the card says so already.
  const games = readJson(gamesFile(), []).map((game) => {
    if (!game || !game.exePath) return game;
    const fixed = discover.repairExePath(game.exePath);
    return fixed === game.exePath ? game : { ...game, exePath: fixed };
  });
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
  if (process.env.OPTIDLSS5_NO_SYNC !== '1' && panelLanguageValue(before) !== panelLanguageValue(settings)) {
    for (const game of readJson(gamesFile(), [])) {
      try {
        if (game && game.exePath) applyPanelLanguage(gameDir(game.exePath), settings);
      } catch {
        // One game's unwritable ini must not block saving the settings themselves.
      }
    }
  }
  // The break-away panel's hotkey is owned by the OS, not by a window, so a changed key (or the
  // panel being switched off) has to be handed back and re-taken here rather than at next launch.
  if (panelHotkeySignature(before) !== panelHotkeySignature(settings)) applyPanelHotkey(settings);
  // The pop-out panel and the main window share settings.json, and either can change the theme or
  // the language, so whichever did not make the change is told rather than left stale.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents !== _evt.sender) {
      try { win.webContents.send('settings-changed', settings); } catch {}
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

// DLSS 5 on in every game when it starts ([DlssNr] Enabled=true). Written on every install and sync,
// and across all installed games when the app starts, so a game switched off in its own panel is back
// on at its next launch -- the in-game panel only switches it for that session. Only a folder that has
// the model: switching the pass on with nothing to run crashed launches (see autoConfigureGame).
//
// There was a top-bar choice for this ('each game's own' / 'on') until 2026-09-19. With 'each game's
// own', a pass switched off once in the panel stayed off, and the next run looked like DLSS 5 failing
// to hook (Cyberpunk 2077, and #86 Flight Simulator 2024). Never write Enabled=false here: that took the
// DLSS 5 panel away on the Present-route games (Resident Evil 2, 2026-09-18).
function applyNrOn(dir) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return [];
  if (!fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) return [];
  return ensureIniKey(iniPath, 'DlssNr', 'Enabled', 'true') ? [{ section: 'DlssNr', key: 'Enabled', value: 'true' }] : [];
}

// Every installed game, in its own folder and, on the 32-bit route, the helper's. At app start.
function applyNrOnEverywhere() {
  if (process.env.OPTIDLSS5_NO_SYNC === '1') return;
  for (const game of readJson(gamesFile(), [])) {
    if (!game || !game.exePath) continue;
    const dir = gameDir(game.exePath);
    for (const target of [dir, path.join(dir, legacy.HOST_DIR)]) {
      try { applyNrOn(target); } catch {}
    }
  }
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
const pdPluginCacheDir = () => path.join(userDataDir(), 'pd-plugin');
const dxvkCacheDir = () => path.join(userDataDir(), 'dxvk-cache');

function pdPluginDownloadsDirs() {
  const dirs = [];
  try { dirs.push(app.getPath('downloads')); } catch {}
  return dirs;
}

ipcMain.handle('pdplugin:status', () => ({
  cached: pdplugin.readCacheInfo(pdPluginCacheDir()),
  candidates: pdplugin.findCandidates(pdPluginDownloadsDirs()).slice(0, 5),
  pageUrl: reengine.PD_PLUGIN_PAGE_URL,
  pageLabel: reengine.PD_PLUGIN_PAGE_LABEL,
}));

ipcMain.handle('pdplugin:pick', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Select the Upscaler Base Plugin download (or PDPerfPlugin.dll)',
    defaultPath: pdPluginDownloadsDirs()[0],
    properties: ['openFile'],
    filters: [{ name: 'Plugin download', extensions: ['zip', '7z', 'rar', 'dll'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Import only. The Resident Evil games no longer use the plugin (they take the engine's Present route,
// reengine.js), so it is kept in the app's cache and placed nowhere -- placing it would only have the
// next sync take it out again.
ipcMain.handle('pdplugin:import', async (_evt, { sourcePath } = {}) => {
  try {
    const info = await pdplugin.importPlugin(sourcePath, pdPluginCacheDir());
    return { ok: true, info, placed: [], skipped: [], waiting: [] };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

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
  const detected = effectiveDetection(dir, exePath, await detectFor(dir, exePath));
  if ((lumaue.isLumaUeDefault(exePath, lumaModFor(exePath, detected)) || lumaue.lumaUeDeployed(dir)) && !feeder.feederDeployed(dir)) {
    return { ready: false, needed: false, reason: 'This game uses Luma UE for its DLSS call, not the Feeder -- see the Luma UE section.' };
  }
  return { needed: true, ...(await feeder.feederReadiness(dir, detected.api, { execFileAsync, exePath })) };
});

// ReShade's own installer, for the one step this app leaves to it: registering ReShade as the
// machine-wide Vulkan layer with add-on support (an HKLM registration -- the installer asks for
// elevation itself). The setup exe is the same one the Feeder deploy downloads and caches.
ipcMain.handle('feeder:openReShadeSetup', async () => {
  try {
    // ...OrAsk, because this button IS the Vulkan route's only way forward: the layer is
    // machine-wide and only ReShade's own installer registers it. A download that fails here used
    // to be a dead end with nothing to run, so the user's own setup is offered instead.
    const setupPath = await ensureReShadeSetupOrAsk();
    const opened = await shell.openPath(setupPath);
    if (opened) throw new Error(opened);
    return { ok: true, setupPath };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('feeder:mvProviders', () => {
  return feeder.mvProviderList();
});

// ---- the ReShade add-on catalogue (addons.js) ------------------------------------------------

// Everything the catalogue needs goes through the Feeder's downloader, so an add-on arrives the
// same way every other file this app places does: integrity-checked against a pin or GitHub's own
// published digest, and cached, so a second game on the same machine costs no network at all.
const addonCtx = () => ({
  fetchBuffer: async (url, { sha256 = null } = {}) => {
    const name = url.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
    const file = await feeder.downloadToCache(url, feederCacheDir(), name, GITHUB_HEADERS, { sha256 });
    return fs.readFileSync(file);
  },
  resolveRelease: async (repo, tag) => {
    const url = `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${tag}` : 'latest'}`;
    const res = await netFetch(url, { headers: GITHUB_HEADERS });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} for ${repo} releases`);
    return res.json();
  },
});

// RenoDX's games-index.json AND the release it came from, memoised together for the session.
//
// Together, because the two cannot be mixed: each release's index names its own artifact files, so
// reading one source's index and then fetching the other's asset would ask for a filename that
// release may not have (addons.RENODX_SOURCES says the same thing from the other end).
//
// Memoised because it is ~260 KB and the picker asks for it every time a card is opened, so
// re-fetching per card would be a download per click. It is an ordinary release asset, so it is
// digest-checked like the add-ons themselves -- integrity.releaseAssetDigest reads owner, repo, tag
// and name straight off the download URL, which is why a second source needs no pin of its own.
let renodxIndexMemo = null;
async function renodxIndex() {
  if (renodxIndexMemo) return renodxIndexMemo;
  const tried = [];
  for (const source of addons.RENODX_SOURCES) {
    try {
      const buf = await addonCtx().fetchBuffer(addons.renodxIndexUrl(source));
      renodxIndexMemo = { index: JSON.parse(buf.toString('utf8')), source };
      return renodxIndexMemo;
    } catch (error) {
      // A fork that has published no release yet answers 404 here. That is the ordinary case, not a
      // failure, so it is recorded and the next source is tried.
      tried.push(`${source.repo}: ${(error && error.message) || error}`);
    }
  }
  throw new Error(`No RenoDX index could be fetched (${tried.join('; ')})`);
}

// The catalogue as this game sees it: what is installed here, and which RenoDX add-on (if any)
// this particular game has. The index fetch is allowed to fail -- offline, or GitHub down -- and
// the rest of the list still works, because only the RenoDX row depends on it.
ipcMain.handle('addons:forGame', async (_evt, { exePath } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const detected = detectGameCached(exePath) || {};
    const steam = library.steamManifestFor(exePath);
    const installed = new Set(addons.installedIds(dir));
    // Once, here: every row's blocker is derived from this rather than walking the folder again.
    const reshade = addons.reshadeIn(dir);

    let match = null;
    let indexError = null;
    // Which release the match came from. Reported because with two sources it decides whether the
    // engine's in-game HDR page can appear at all, and "the tab is missing" is otherwise a mystery.
    let renodxSource = null;
    try {
      const renodx = await renodxIndex();
      renodxSource = renodx.source;
      match = addons.matchRenodx(renodx.index, {
        steamAppid: steam ? steam.appid : null,
        title: (steam && steam.name) || path.basename(dir),
        bitness: detected.bitness || null,
        // Lets an Unreal game with no bespoke mod still get the engine-wide one. Already on the
        // cached detection (the same field lumaue.js reads), so this costs no extra folder work.
        engineId: detected.engineId || null,
      });
    } catch (error) {
      indexError = String(error && error.message ? error.message : error);
    }

    return {
      ok: true,
      dir,
      // The neural pass being installed here is what decides whether the RenoDX row shows its
      // "untested together" line, so the renderer is told rather than guessing from the card.
      neuralRendering: !!(detected && detected.optiscaler) || fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll')),
      // Whether ReShade is here at all, and whether it is the build that can load an add-on. The
      // card's button is on every game, so this is the one fact that decides whether any of these
      // rows can do anything -- found by content rather than by our own marker, so a ReShade the
      // user installed himself counts (addons.reshadeIn).
      reshade,
      catalogue: addons.catalogue().map((a) => ({
        ...a,
        installed: installed.has(a.id),
        // Why Install is refused here, or null. Per entry, because a plain ReShade stops an add-on
        // and not a shader pack -- but from the ONE scan above, not a fresh walk of the folder per
        // row. Never on an installed row: Remove must work whatever happened to ReShade since.
        blocker: installed.has(a.id) ? null : addons.installBlocker(dir, a.id, reshade),
        // What pressing Install would swap out. The renderer says so up front rather than the
        // other row silently flipping to "Install" afterwards.
        replaces: addons.conflictsFor(dir, a.id),
      })),
      renodx: match,
      renodxSource,
      indexError,
      // The motion-vector providers, shown in this same list. They are not add-ons in the
      // catalogue's sense -- the Feeder picks exactly one and the deploy owns it -- but this is
      // where someone looks for "what ReShade things can this game have", and having to know to
      // open Edit instead is the kind of hiding this app has been told off for before.
      mvProviders: feeder.mvProviderList().filter((p) => p.selectable !== false).map((p) => ({
        id: p.id, displayName: p.displayName, license: p.license,
        mvProviderValue: p.mvProviderValue, officialUrl: p.officialUrl || null,
        bringYourOwn: !!p.bringYourOwn, recommended: !!p.recommended, isDefault: !!p.default,
      })),
      mvProviderId: (feeder.readFeederDeployMarker(dir) || {}).mvProviderId || null,
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('addons:install', async (_evt, { exePath, id } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const detected = detectGameCached(exePath) || {};
    const opts = { bitness: detected.bitness || null };
    if (id === 'renodx') {
      const steam = library.steamManifestFor(exePath);
      const renodx = await renodxIndex();
      // The asset comes from the release the index came from, never the other one.
      opts.source = renodx.source;
      opts.match = addons.matchRenodx(renodx.index, {
        steamAppid: steam ? steam.appid : null,
        title: (steam && steam.name) || path.basename(dir),
        bitness: detected.bitness || null,
        // Lets an Unreal game with no bespoke mod still get the engine-wide one. Already on the
        // cached detection (the same field lumaue.js reads), so this costs no extra folder work.
        engineId: detected.engineId || null,
      });
      if (!opts.match) throw new Error('No RenoDX mod is built for this game');
    }
    // A ReShade ADD-ON needs the same folder to be true as pacing's does, so it goes through the
    // same function rather than a second copy of the reasoning. A shader pack does not: .fx effects
    // load off the preset under any ReShade build and nothing about them touches NGX.
    const spec = addons.addonById(id);
    let host = null;
    if (spec && spec.kind === 'addon') {
      if ((await peBitness(exePath)) === 32) {
        throw Object.assign(new Error('32-bit games are not supported for ReShade add-ons yet'), { code: 'bitness-32' });
      }
      const api = (await resolveApi(dir, exePath)) || 'dx12';
      if (!relimiter.isAutomatic(api)) {
        throw Object.assign(new Error('ReShade on Vulkan needs its own setup run for this game first'), { code: 'vulkan-layer' });
      }
      host = await ensureReShadeAddonHost(dir, api, { addon: id });
    }

    const res = await addons.installAddon(dir, id, addonCtx(), opts);
    // A pack that brought techniques changes the run order, so the preset is re-sorted now rather
    // than at the next Feeder deploy -- which might never come.
    reorderPresetFor(dir);
    // The step without which the whole thing is inert on an OptiScaler game: [Plugins]
    // LoadReshade=true is what makes OptiScaler load the ReShade64.dll beside it, and nothing else
    // in this handler writes it. Placing an add-on and leaving this undone puts a file in the folder
    // that never loads, which reads to a user exactly like the add-on not working.
    const configured = host && host.optiHere ? await autoConfigureGame(dir, exePath) : null;
    return {
      ok: true,
      ...res,
      standalone: host ? host.standalone : false,
      applied: configured ? configured.applied : [],
    };
  } catch (error) {
    // The code lets the renderer word the shared refusals for this add-on rather than for frame pacing.
    return { ok: false, code: (error && error.code) || null, error: String(error && error.message ? error.message : error) };
  }
});

// Swap the motion-vector provider on a game the Feeder is already on, in one press. The whole
// point of offering five is that nobody can tell you which looks best on YOUR game -- that is
// something you find out by looking, and only if trying the next one is cheap.
//
// The 32-bit helper route keeps its own copy of the stack, so it goes through legacy.js's
// setMvProvider; everything else through feeder.switchMvProvider. Same answer either way.
ipcMain.handle('addons:setMvProvider', async (_evt, { exePath, mvProviderId, licenseConfirmed = false } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const provider = feeder.MV_PROVIDERS[mvProviderId];
    if (!provider) throw new Error(`Unknown motion-vector provider: ${mvProviderId}`);
    // The licence gate is enforced in deployLumeniteFx regardless; this is the call that gets the
    // consent, so a renderer that skipped the dialog fails here rather than fetching.
    const res = legacyMvSummary(dir)
      ? await legacy.setMvProvider(dir, mvProviderId, { ghHeaders: GITHUB_HEADERS, cacheDir: feederCacheDir(), licenseConfirmed })
      : await feeder.switchMvProvider(dir, mvProviderId, feederCacheDir(), GITHUB_HEADERS, { licenseConfirmed });
    return { ok: true, ...res };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('addons:remove', async (_evt, { exePath, id } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const res = await addons.removeAddon(dir, id);
    reorderPresetFor(dir);
    // The last ReShade add-on out takes the ReShade this app placed for it (ensureReShadeAddonHost
    // recorded it in pacing's marker), unless frame pacing still uses it. The Feeder's, Luma's,
    // Chicken's or the user's own ReShade was never recorded as placed, so it is never touched.
    const spec = addons.addonById(id);
    if (spec && spec.kind === 'addon' && !addons.installedAddonIds(dir).length && !relimiter.deployed(dir) && relimiter.ownsReShade(dir)) {
      // Something deployed since may have come to rely on that same file, so it stays for them.
      const sharedNow = feeder.feederDeployed(dir) || lumaue.lumaUeDeployed(dir) || !!dfc.dfcPresent(dir);
      res.removed = [...res.removed, ...relimiter.remove(dir, sharedNow ? { keepReShade: true } : { withPlacedReShade: true })];
      if (!sharedNow && fs.existsSync(path.join(optiScalerDirFor(dir), 'OptiScaler.ini'))) {
        try { patchIniValues(path.join(optiScalerDirFor(dir), 'OptiScaler.ini'), [{ section: 'Plugins', key: 'LoadReshade', value: 'auto' }]); } catch {}
      }
    }
    return { ok: true, ...res };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Re-sort this game's preset after the set of installed add-ons changed. Only touches a preset
// that already exists: a game with no ReShade here has nothing to order, and writing one would
// be this app creating a file nobody asked for.
function reorderPresetFor(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'ReShadePreset.ini'))) return;
    const marker = feeder.readFeederDeployMarker(dir);
    feeder.configurePreset(dir, (marker && marker.mvProviderId) || feeder.defaultMvProviderId());
  } catch {
    // A preset that cannot be parsed or written is not worth failing an install over; the
    // add-on is in place and the next deploy re-sorts.
  }
}

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
// Off by default, and read at call time so a change in Settings applies to the next deploy
// without a restart. A pre-release is what the Feeder's author asks a particular person to test,
// so it is offered rather than handed to everyone.
function feederPrereleaseEnabled() {
  return !!readJson(settingsFile(), {}).feederPrerelease;
}

// The newest Feeder tag, resolved once per app run and shared by every game's sync. Without the
// cache a library of twenty Feeder games would hit the releases API twenty times on every pass.
// A failure (offline, rate limited) is cached as null so it is not retried per game either.
let latestFeederTagPromise = null;
function latestFeederTag() {
  if (latestFeederTagPromise === null) {
    latestFeederTagPromise = feeder.resolveFeederAsset(GITHUB_HEADERS, { allowPrerelease: feederPrereleaseEnabled() })
      .then((asset) => asset.tag || null)
      .catch(() => null);
  }
  return latestFeederTagPromise;
}

// The newest Feeder's zip in the cache, resolved once per app run like the tag above, for the
// 32-bit route's sync (legacy.refreshFeeder32). null when offline.
let latestFeederZipPromise = null;
function latestFeederZip() {
  if (latestFeederZipPromise === null) {
    latestFeederZipPromise = feeder.resolveFeederAsset(GITHUB_HEADERS, { allowPrerelease: feederPrereleaseEnabled() })
      .then((asset) => feeder.downloadToCache(asset.url, feederCacheDir(), asset.name, GITHUB_HEADERS, { sha256: asset.digest }))
      .catch(() => null);
  }
  return latestFeederZipPromise;
}

// Brings a game's deployed Feeder up to the newest release, the same way Game Help's
// "redeploy-feeder" does. Games were left on whatever the Feeder was when they were installed, so a
// library built up over weeks ran a different Feeder per game -- and the fixes that matter most on
// this route (a Close() failure, the cast's input forwarding) only arrive with the add-on itself.
//
// Only when the tag actually differs: the deploy rewrites the shader, the preset, both provider
// levels and the ReShade ini, which is not something to do on every sync for no reason. Offline is
// left alone; a marker that predates version tracking is not (see below).
async function updateFeederIfStale(dir, exePath) {
  if (!feeder.feederDeployed(dir)) return null;

  const marker = feeder.readFeederDeployMarker(dir);
  // A marker from before versions were recorded counts as stale, not as "leave it alone": that rule
  // kept such installs on their first Feeder for good.
  const current = (marker && marker.feederVersion) || null;

  const latest = await latestFeederTag();
  if (!latest || latest === current) return null;

  const api = await resolveApi(dir, exePath);
  const status = feeder.feederProviderStatus(dir);
  const provider = feeder.MV_PROVIDERS[status.id || ''] || null;
  const keep = !!provider && provider.selectable !== false &&
    (provider.bringYourOwn ? feeder.mvProviderPresent(dir, provider.id) : true);
  const providerId = keep ? provider.id : feeder.defaultMvProviderId();

  const results = await feeder.deployFeederStack(dir, api, providerId, {
    cacheDir: feederCacheDir(),
    getRhiManifest,
    compareVersions: compareStreamlineVersions,
    ghHeaders: GITHUB_HEADERS,
    force: true,
    allowPrerelease: feederPrereleaseEnabled(),
    unity: isUnityGame(dir, exePath),
    depthProfile: feeder.feederDepthProfile(dir),
    execFileAsync,
    exePath,
    // A Vulkan layer that skips this exe needs the user at ReShade's installer; on a sync that is a
    // warning carried back, not a throw that aborts the add-on update (feeder.js deployReShade).
    layerWarnOnly: true,
  });

  const to = (results.addon && results.addon.version) || latest;
  const warning = (results.reshade && results.reshade.warning) || null;
  return warning ? { from: current, to, warning } : { from: current, to };
}

ipcMain.handle('feeder:checkUpdate', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    return { ok: true, ...(await feeder.feederUpdateCheck(dir, GITHUB_HEADERS, { allowPrerelease: feederPrereleaseEnabled() })) };
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
// { generator: 'xefg' | 'fsrfg' | 'none', startOn } since 2026-09-23; { enabled } still works (the
// Lossless Scaling hand-off switches it off that way).
ipcMain.handle('optifg:set', async (_evt, { exePath, enabled, generator, startOn } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    if (generator !== undefined) {
      if (generator && generator !== 'none') {
        // The renderer only offers what readiness allows; this is the backstop.
        const ready = optiFgReadiness(dir, await resolveApi(dir, exePath));
        if (!ready.supported) throw new Error(ready.reason);
        if (!ready.available[generator]) throw new Error(`${generator === 'xefg' ? 'XeFG' : 'FSR FG'} files are missing from this game's OptiScaler folder`);
      }
      setOptiFg(dir, { generator, startOn });
    } else {
      setOptiFgEnabled(dir, !!enabled);
    }
    // Arming a generator takes the swap chain away from ReShade, and pacing would go on installed and
    // doing nothing (pacingBesideUpscalerBlocker, optifg-armed). Out it comes, reported.
    let pacingRemoved = null;
    try { pacingRemoved = await dropBlockedPacing(dir); } catch {}
    const result = await autoConfigureGame(dir, exePath);
    return { ok: true, ...result, pacingRemoved };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The pop-out panel's live frame generation switches, for a game with XeFG or FSR FG armed. On/off is
// [FrameGen] Enabled and HUD fix is [OptiFG] HUDFix, both read per frame by the engine; its settings
// reload compares them and raises the same flags OptiScaler's own key and menu do (engine v2.2.12,
// PollSettingsFromDisk), so this is the same operation as the in-game switch. Which generator is not
// here: it is a launch-time choice, made in Edit.
function optiFgIniState(iniPath) {
  let text = '';
  try { text = fs.readFileSync(iniPath, 'utf-8'); } catch { return null; }
  const section = (name) => {
    const m = new RegExp(`^\\s*\\[${name}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, 'im').exec(text);
    return m ? m[1] : '';
  };
  const key = (body, k) => ((new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, 'im').exec(body) || [])[1] || '').toLowerCase();
  const frameGen = section('FrameGen');
  const output = key(frameGen, 'FGOutput');
  return {
    armed: OPTIFG_GENERATORS.includes(output),
    generator: OPTIFG_GENERATORS.includes(output) ? output : null,
    enabled: /^(true|1)$/.test(key(frameGen, 'Enabled')),
    hudfix: /^(true|1)$/.test(key(section('OptiFG'), 'HUDFix')),
  };
}

ipcMain.handle('optifg:live', async (_evt, { exePath } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Game .exe not found' };
    const state = optiFgIniState(path.join(optiScalerDirFor(gameDir(exePath)), 'OptiScaler.ini'));
    return state ? { ok: true, ...state } : { ok: false, error: 'OptiScaler.ini not found' };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('optifg:live-set', async (_evt, { exePath, enabled, hudfix } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const iniPath = path.join(optiScalerDirFor(dir), 'OptiScaler.ini');
    const state = optiFgIniState(iniPath);
    if (!state) throw new Error('OptiScaler.ini not found');
    // Nothing to switch without a generator armed at launch -- the panel does not offer it then.
    if (!state.armed) throw new Error('No frame generator is set up for this game -- pick one in Edit first');
    if (enabled !== undefined) ensureIniKey(iniPath, 'FrameGen', 'Enabled', enabled ? 'true' : 'false');
    if (hudfix !== undefined) ensureIniKey(iniPath, 'OptiFG', 'HUDFix', hudfix ? 'true' : 'false');
    ensureLiveReload(dir);
    return { ok: true, ...optiFgIniState(iniPath) };
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

// ── Frame pacing (ReLimiter) ──
//
// A ReShade add-on, so it needs the same arrangement the Feeder uses: OptiScaler keeps the proxy slot
// and [Plugins] LoadReshade=true has it load the plain ReShade64.dll beside the exe. autoConfigureGame
// sets that key whenever ReLimiter is deployed, so nothing here has to.
ipcMain.handle('relimiter:status', async (_evt, exePath) => {
  try {
    const dir = gameDir(exePath);
    const { api } = effectiveDetection(dir, exePath, await detectFor(dir, exePath));
    const st = relimiter.status(dir, { api: api || 'dx12' });
    // The number in ReLimiter's own ini, not one this app remembers: the in-game panel and ReLimiter's
    // own overlay can both change it, and a remembered copy would go stale the first time they did.
    const raw = readIniKey(relimiter.iniPath(dir), relimiter.INI_SECTION, 'target_fps');
    const targetFps = Number.isFinite(Number(raw)) ? Number(raw) : 0;
    return { ok: true, ...st, targetFps, min: relimiter.TARGET_FPS_MIN, max: relimiter.TARGET_FPS_MAX };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('relimiter:set-target', async (_evt, { exePath, fps } = {}) => {
  try {
    const dir = gameDir(exePath);
    const applied = patchIniValues(relimiter.iniPath(dir), relimiter.targetFpsEdits(fps));
    return { ok: true, applied };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// Why frame pacing cannot sit beside OptiScaler's upscaler on this game right now, or null when it can.
// Only asked for a game OptiScaler upscales on the game's own device (not a Feeder game: there DLSS runs
// on the Feeder's private device and neither rule applies).
//   reshade-dlss-crash  the engine here predates the NGX device hold (relimiter.engineKeepsNgxDevice):
//                       ReShade with any add-on crashes at DLSS creation. Updating DLSS 5 fixes it.
//   optifg-armed        FSR FG, or XeFG on an engine from before 9a4ce766: the frame generator builds
//                       the game's swap chain on a queue ReShade did not make, so ReShade logs
//                       "Skipping swap chain because it was created without a proxy Direct3D device"
//                       and ReLimiter never sees a frame -- pacing would install and do nothing.
//                       Measured on Shadow of the Tomb Raider, 2026-09-24. XeFG on a newer engine is
//                       built on ReShade's device and paces fine (relimiter.engineGivesXefgToReShade).
async function pacingBesideUpscalerBlocker(dir) {
  const active = await findActiveOptiScalerFile(dir);
  if (!active || !relimiter.engineKeepsNgxDevice(active.file)) {
    return { code: 'reshade-dlss-crash', message: 'Frame pacing needs a newer DLSS 5 engine on this game: update DLSS 5 here first' };
  }
  // The app's own choice (its marker, which autoConfigureGame turns into FGOutput) or one set by hand.
  // XeFG is fine with an engine that builds it on ReShade's device (relimiter.engineGivesXefgToReShade);
  // FSR FG was never changed or measured, so it stays refused.
  const fg = optiFgIniState(path.join(optiScalerDirFor(dir), 'OptiScaler.ini'));
  const chosen = readOptiFg(dir);
  const generators = [chosen && chosen.generator, fg && fg.armed && fg.generator].filter(Boolean);
  if (generators.length > 0) {
    const xefgOnly = generators.every((g) => g === 'xefg');
    if (!xefgOnly) {
      return { code: 'optifg-armed', message: 'Frame pacing can’t see frames with FSR frame generation on this game: switch frame generation to XeFG or off in Edit first' };
    }
    if (!relimiter.engineGivesXefgToReShade(active.file)) {
      return { code: 'optifg-armed', message: 'Frame pacing with XeFG needs a newer DLSS 5 engine on this game: update DLSS 5 here first, or turn frame generation off in Edit' };
    }
  }
  return null;
}

// Takes frame pacing out of a non-Feeder game where pacingBesideUpscalerBlocker now refuses it: the
// add-on, the ReShade64.dll this app placed for it, and OptiScaler's LoadReshade (unless Luma UE still
// needs ReShade). Run BEFORE autoConfigureGame, which forces LoadReshade=true wherever pacing is
// deployed. Returns what was removed, or null.
// RenoDX goes with it for the same reasons (ensureReShadeAddonHost refuses both on the same blocker):
// FSR frame generation switched on in Edit afterwards, or an older engine put back, would otherwise
// leave an add-on loading beside the upscaler -- the Shadow of the Tomb Raider crash.
async function dropBlockedPacing(dir, feederGame = isFeederGame(dir)) {
  const addonIds = addons.installedAddonIds(dir);
  if (feederGame || (!relimiter.deployed(dir) && !addonIds.length) || !(await pacingBesideUpscalerBlocker(dir))) return null;
  const removed = [];
  for (const id of addonIds) removed.push(...(await addons.removeAddon(dir, id)).removed);
  removed.push(...relimiter.remove(dir, { withPlacedReShade: true }));
  if (!lumaue.lumaUeDeployed(dir)) {
    try { patchIniValues(path.join(optiScalerDirFor(dir), 'OptiScaler.ini'), [{ section: 'Plugins', key: 'LoadReshade', value: 'auto' }]); } catch {}
  }
  return removed;
}

// Everything a ReShade ADD-ON needs true of a game folder before it is placed there, in one place.
//
// This was pacing's prologue, and it is here because RenoDX needs every line of it for the same
// reasons -- an add-on is an add-on. Writing a second version of it for the add-ons picker is how the
// two would drift, and the drift would be silent: a placed file that never loads looks identical to
// one that does until someone reports the feature doing nothing.
//
// It throws with a `code` the caller passes straight back to the renderer.
//
//   reshade-dlss-crash  ReShade + ANY add-on + OptiScaler upscaling on the game's own device is the
//                       Shadow of the Tomb Raider fault (0xC0000005 in ReShade64.dll inside DLSS
//                       CreateFeature) on an engine that does not hold the NGX session device. It was
//                       never specific to pacing; it is what loading an add-on beside our upscaler
//                       does, so RenoDX is refused on those engines rather than crashing the game.
//   optifg-armed        OptiScaler's frame generation hides the swap chain from ReShade, so the
//                       add-on sees no frames.
//   vulkan-layer        ReShade on Vulkan is a machine-wide layer only its own setup can register.
//
// Afterwards ReShade is present, is the Add-on build, is in a slot something will load, and is not
// listing this add-on under DisabledAddons. The CALLER still has to run autoConfigureGame when
// OptiScaler is here -- that is what writes [Plugins] LoadReshade=true, without which OptiScaler
// never loads the ReShade64.dll beside it and the add-on is inert.
async function ensureReShadeAddonHost(dir, api, { addon = 'relimiter' } = {}) {
  const optiHere = fs.existsSync(path.join(dir, 'OptiScaler.ini')) && !!(await findActiveOptiScalerFile(dir));
  if (optiHere && !isFeederGame(dir)) {
    const blocker = await pacingBesideUpscalerBlocker(dir);
    if (blocker) throw Object.assign(new Error(blocker.message), { code: blocker.code });
  }
  // Chicken: its ReShade is already the proxy, so the add-on simply joins it (relimiter.chickenReShade).
  const standalone = !optiHere && !relimiter.chickenReShade(dir) && relimiter.reshadeModeFor(api) === 'local';

  // DLSS 5 arrived after an earlier standalone install and something skipped the hand-back.
  if (optiHere && relimiter.status(dir, { api }).standalone) relimiter.demoteStandaloneReShade(dir);
  const before = relimiter.status(dir, { api });
  if (!before.reshade || !before.reshadeIsAddonBuild) {
    await ensureReShadeSetupOrAsk();
    // A plain build standing in our standalone proxy slot is replaced there, not beside it.
    if (before.standalone) relimiter.demoteStandaloneReShade(dir);
    const placed = await feeder.deployReShade(dir, feederCacheDir(), GITHUB_HEADERS, { api, force: before.reshade && !before.reshadeIsAddonBuild });
    // Recorded so Chicken's swap knows this ReShade64.dll is the app's to take over.
    if (placed && placed.deployed && placed.file === 'ReShade64.dll' && !before.reshade) relimiter.writeMarker(dir, { reshadePlaced: true });
  }
  if (standalone && !relimiter.status(dir, { api }).standalone) relimiter.promoteToStandalone(dir, api);
  relimiter.configureReShadeIni(dir, { addon });
  return { optiHere, standalone };
}

// Add frame pacing to ANY game -- Feeder or not, DLSS 5 installed or not: ReShade (the add-on build)
// where it is missing or plain, then the add-on itself.
//   OptiScaler here   ReShade is the plain ReShade64.dll and OptiScaler loads it; the reconfigure
//                     below writes [Plugins] LoadReshade=true.
//   no OptiScaler     nothing would load ReShade64.dll, so ReShade becomes the game's own proxy
//                     (relimiter.promoteToStandalone). Installing DLSS 5 later moves it back.
//   OpenGL            ReShade is opengl32.dll either way.
ipcMain.handle('relimiter:install', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw Object.assign(new Error('Game .exe not found'), { code: 'no-exe' });
    const dir = gameDir(exePath);
    // The 32-bit route's ReShade lives in host64\ beside the helper, not here; placing the add-on
    // beside the game exe would load nowhere.
    if ((await peBitness(exePath)) === 32) throw Object.assign(new Error('32-bit games are not supported for frame pacing yet'), { code: 'bitness-32' });
    const api = (await resolveApi(dir, exePath)) || 'dx12';
    if (!relimiter.isAutomatic(api)) throw Object.assign(new Error('Vulkan needs ReShade’s own setup first'), { code: 'vulkan-layer' });
    const { optiHere, standalone } = await ensureReShadeAddonHost(dir, api, { addon: 'relimiter' });

    const asset = await relimiter.resolveAddonAsset(GITHUB_HEADERS, { fetchImpl: netFetch });
    // Cached under its source and tag, so the fork's build and upstream's of the same name never
    // stand in for each other.
    const cacheName = `relimiter-${asset.repo.split('/')[0]}-${asset.tag || 'latest'}-${asset.name}`.replace(/[^\w.-]/g, '_');
    const file = await feeder.downloadToCache(asset.url, path.join(feederCacheDir(), 'relimiter'), cacheName, GITHUB_HEADERS, { sha256: asset.digest });
    relimiter.deploy(dir, file, { version: asset.tag });

    const configured = optiHere ? await autoConfigureGame(dir, exePath) : null;
    return { ok: true, version: asset.tag, source: asset.repo, hostApi: asset.hostApi, standalone, applied: configured ? configured.applied : [] };
  } catch (e) {
    return { ok: false, code: (e && e.code) || null, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('relimiter:remove', async (_evt, exePath) => {
  try {
    const dir = gameDir(exePath);
    // RenoDX installed through the same ReShade keeps it: pacing's Remove used to delete the standalone
    // proxy it had placed, and RenoDX went dark with it.
    return { ok: true, removed: relimiter.remove(dir, { keepReShade: addons.installedAddonIds(dir).length > 0 }) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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

// Whether a Lossless Scaling process is up, by image name. It is single-instance: a second
// launch only tells the first to show its window and exits, which is exactly the pop-over the
// tray settings exist to prevent -- so every launch here checks first.
async function losslessRunning() {
  const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq LosslessScaling.exe', '/NH', '/FO', 'CSV'], { windowsHide: true });
  return stdout.toLowerCase().includes('"losslessscaling.exe"');
}

// Starts it and waits for the spawn to be accepted (a refusal arrives as an asynchronous error
// event, which unhandled would take this process down). minimized: its own -StartMinimized
// argument sends it straight to the tray.
async function losslessSpawn(exePath, { minimized = false } = {}) {
  const child = spawn(exePath, minimized ? ['-StartMinimized'] : [], { cwd: path.dirname(exePath), detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (e) => reject(new Error(`could not start Lossless Scaling: ${e && e.message ? e.message : e}`)));
  });
  child.unref();
}

ipcMain.handle('lossless:launch', async () => {
  try {
    const info = lossless.detect();
    if (!info.installed) throw new Error('Lossless Scaling is not installed');
    if (await losslessRunning()) return { ok: true, alreadyRunning: true };
    await losslessSpawn(info.exePath);
    return { ok: true, alreadyRunning: false };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Lossless Scaling reads its profiles from Settings.xml once, at startup, and writes its own
// in-memory copy back over the file from its UI and from a real close (its decompiled
// MainWindow, 2026-09-12). So a profile written while it runs is neither picked up nor safe
// until it restarts -- and the restart has to be a kill, since a graceful close would first save
// the stale copy over what was just written. Called after every successful configure; a no-op
// when it is not running (the next launch reads the file).
ipcMain.handle('lossless:restart', async () => {
  try {
    const info = lossless.detect();
    if (!info.installed) throw new Error('Lossless Scaling is not installed');
    if (!(await losslessRunning())) return { ok: true, restarted: false };
    await execFileAsync('taskkill.exe', ['/F', '/IM', 'LosslessScaling.exe'], { windowsHide: true }).catch(() => {});
    for (let i = 0; i < 40 && (await losslessRunning()); i++) await new Promise((r) => setTimeout(r, 100));
    if (await losslessRunning()) throw new Error('Lossless Scaling would not close -- if it runs as administrator, close it yourself and launch it again');
    await losslessSpawn(info.exePath, { minimized: true });
    return { ok: true, restarted: true };
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
  // Lossless Scaling cannot capture a game in exclusive fullscreen, and players rarely know to change the
  // game's own display mode. The engine (v1.0.33+) keeps the swapchain windowed and turns a switch to
  // fullscreen into a borderless window over the monitor, so this works whatever the game's setting.
  set('ForceBorderless', 'true');
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
// swapOnly: Install switching an already-deployed Feeder game between our engine and Chicken. The
// Feeder stack is left exactly as it is -- redeploying it here would reset a motion-vector shader
// the player picked (LumeniteFX needs its licence confirmed again) for a change that is not about it.
ipcMain.handle('feeder:deploy', async (_evt, { exePath, mvProviderId, force, licenseConfirmed, depthProfile, consumer, nrDllPath, swapOnly }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    // This is the 64-bit stack (ReShade64.dll, dlss5-feed.addon64), and a 32-bit game can load
    // none of it. Edit's Deploy button and Game Help's redeploy fix reach here without the route
    // check Install makes, and on Castlevania: Lords of Shadow 2 (2026-09-14) that left a folder
    // the game ran straight past with no DLSS at all. Install owns the 32-bit route (legacy.js).
    if ((await peBitness(exePath)) === 32) {
      throw new Error('this is a 32-bit game, and the 64-bit Feeder cannot load in it -- use Install, which sets up the experimental 32-bit route');
    }
    const api = await resolveApi(dir, exePath);
    // Refused before anything is fetched or touched when Chicken is not set up for this game
    // (dfc.supportedFor), so nothing is left half-swapped.
    const wantConsumer = dfc.isConsumer(consumer) ? consumer : dfc.DEFAULT_CONSUMER;
    if (wantConsumer === 'dfc') {
      const support = dfc.supportedFor({ api, bitness: 64 });
      if (!support.ok) { const e = new Error(support.code); e.code = support.code; throw e; }
    }
    // Back to our engine: Chicken out FIRST, before the Feeder is deployed. On OpenGL its ReShade is
    // the game's opengl32.dll, which the Feeder's deploy would take for its own ("already present")
    // and removeDfc would then delete from under it; on Direct3D removeDfc puts ReShade64.dll back,
    // which the deploy then finds where it expects it.
    let dfcRemoved = null;
    if (wantConsumer === 'optiscaler' && (dfc.dfcOurs(dir) || dfc.reshadeProxyOf(dir))) {
      dfcRemoved = await dfc.removeDfc(dir, dfcRemoveOptions());
      if (dfcRemoved.failed.length) throw new Error(`Chicken could not be taken out (${dfcRemoved.failed.map((f) => `${f.rel}: ${f.code}`).join(', ')}) -- close the game and try again`);
    }
    // Vulkan and OpenGL: Chicken's own producer replaces the Feeder rather than eating its contract
    // ("Do not install another neural feeder alongside"), so the Feeder is not deployed at all.
    if (wantConsumer === 'dfc' && (api === 'vulkan' || api === 'opengl')) {
      await refreshDfcCopy('compat');
      const r = await dfc.switchToDfcCompat(dir, dfcCacheDir(), {
        api,
        nrDllPath: nrDllPath || null,
        removeOptiScaler: removeOptiScalerForSwap,
        removeFeeder: (d) => (feeder.feederDeployed(d) ? feeder.removeFeederStack(d, { keepReShade: false }) : null),
        vulkanLayerReady: async () => {
          const s = await feeder.vulkanLayerStatus({ execFileAsync, exePath });
          return !!(s.registered && s.addon && s.appListed !== false);
        },
        // ReShade's own setup, headless and elevated: it installs both layers and lists this exe
        // (the same call the 32-bit DXVK route makes; the function's name is from that route).
        setUpVulkanLayer: async () => {
          const setupPath = await ensureReShadeSetupOrAsk();
          const r = await legacy.setUpVulkanLayer32(dir, exePath, {
            setupPath,
            runElevated: (file, args) => elevate.runElevated(file, args, { execFileAsync }),
            layerStatus: () => feeder.vulkanLayerStatus({ execFileAsync, exePath, bitness: 64 }),
          });
          return { ...r, exe: exePath };
        },
        reshadeSetup: () => ensureReShadeSetupOrAsk(),
        placeNvngxDlss: (d) => feeder.deployNvngxDlss(d, getRhiManifest, compareStreamlineVersions, feederCacheDir(), GITHUB_HEADERS),
      });
      invalidateDetection(dir);
      return { ok: true, consumer: 'dfc', dfc: r, consumerHere: 'dfc' };
    }
    // Settle ReShade's installer before the deploy starts, so the "use one I have" door is offered
    // with the user standing right there rather than thrown from inside a half-finished stack. It
    // lands in the cache, which is the first place deployReShade looks, so the deploy below just
    // finds it. On the Vulkan layer no local setup is needed and this is a no-op.
    if (feeder.reshadeModeForApi(api) !== 'vulkan-layer') await ensureReShadeSetupOrAsk();
    const results = swapOnly && feeder.feederDeployed(dir) ? {} : await feeder.deployFeederStack(dir, api, mvProviderId || feeder.defaultMvProviderId(), {
      cacheDir: feederCacheDir(),
      getRhiManifest,
      compareVersions: compareStreamlineVersions,
      ghHeaders: GITHUB_HEADERS,
      force: !!force,
      licenseConfirmed: !!licenseConfirmed,
      allowPrerelease: feederPrereleaseEnabled(),
      // Unity clears its depth buffer before the UI pass and renders reversed-Z; ReShade's
      // Generic Depth needs telling both, or the Feeder gets a flat depth (feeder.js).
      unity: isUnityGame(dir, exePath),
      // A profile the user picked in Edit (the verified Unity one, for a flat-depth game) wins
      // over the engine default above -- feeder.js's DEPTH_PROFILES explains the difference. A
      // re-deploy with nothing passed keeps whatever the last deploy chose.
      depthProfile: depthProfile || feeder.feederDepthProfile(dir),
      execFileAsync,
      exePath,
    });
    // Which neural consumer eats the contract the stack above manufactures. The Feeder allows
    // exactly one (its v0.11.0-beta.1 notes), so this is a swap, done whole (dfc.js):
    //   to Chicken  OptiScaler out (its journal says what is ours), ReShade in as the game's proxy
    //               (nothing loads the plain ReShade64.dll once OptiScaler is gone), the NR model
    //               beside Chicken's add-on, Chicken in.
    //   back        Chicken out with its cfg kept for next time, ReShade back to ReShade64.dll --
    //               the renderer's Install then puts OptiScaler back, which loads it again.
    // One Chicken the user copied in by hand is never touched: switchToDfc refuses, removeDfc skips.
    results.consumer = wantConsumer;
    if (results.consumer === 'dfc') {
      // Frame pacing's own ReShade proxy steps back to ReShade64.dll, which Chicken then takes as its
      // ReShade -- the add-on rides on it from there.
      try { relimiter.demoteStandaloneReShade(dir); } catch {}
      results.dfc = await dfc.switchToDfc(dir, dfcCacheDir(), {
        nrDllPath: nrDllPath || null,
        removeOptiScaler: removeOptiScalerForSwap,
        reshadeIsOurs: relimiter.placedReShade,
        fetchReShade: fetchReShadeForDfc,
      });
      invalidateDetection(dir);
    } else if (dfcRemoved) {
      results.dfcRemoved = dfcRemoved;
    }
    results.consumerHere = dfc.dfcOurs(dir) ? 'dfc' : 'optiscaler';
    return { ok: true, ...results };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.message ? error.message : error),
      // The Vulkan case this app hands to ReShade's own installer (feeder.js, deployReShade).
      needsReShadeInstaller: !!(error && error.needsReShadeInstaller),
      code: (error && error.code) || null,
    };
  }
});

// A plain ReShade64.dll (the add-on build this app pins, feeder.js), for a game switched to Chicken
// that has no Feeder to have brought one.
function fetchReShadeForDfc(dir) {
  return feeder.deployReShade(dir, feederCacheDir(), GITHUB_HEADERS, { api: 'dx11' });
}

// This app's whole 32-bit route out of a game folder, for a switch to Chicken's own 32-bit route
// (dfc.js switchToDfc32) -- the same stages uninstallEverything runs for it, in the same order: our
// translation layer (DXVK or dgVoodoo2, with whatever it displaced put back), the exe's entry on
// ReShade's Vulkan app list if our DXVK swap put it there, then the Feeder's 32-bit stack and its
// host64\ helper (legacy.removeLegacy). Anything that fails is reported and the switch stops.
async function removeOur32Stack(dir) {
  const removed = [];
  const failed = [];
  const tl = translation.activeLayer(dir);
  if (tl.ours) {
    const r = await translation.purgeTranslationLayer(dir, { layer: tl.layer });
    removed.push(...(r.removed || []));
    for (const f of r.failed || []) failed.push({ rel: f.file, code: f.code });
  }
  const vkApp = legacy.vulkanLayerRecord(dir);
  if (vkApp && vkApp.listedByUs) {
    await legacy.unlistVulkanLayerApp(vkApp, {
      runElevatedPowerShell: (command) => elevate.runElevatedPowerShell(command, { execFileAsync }),
    }).catch(() => {});
  }
  if (legacy.readMarker(dir)) {
    try {
      const r = await legacy.removeLegacy(dir);
      removed.push(...r.removed);
    } catch (e) {
      failed.push({ rel: 'the 32-bit route', code: (e && e.code) || 'failed' });
    }
  }
  return { removed, failed };
}

// Would a file or folder by this name still be here once removeOur32Stack has run? A backup it would
// put back under that name (the game's own d3d9.dll behind dgVoodoo2, say), or anything by that name
// that none of this app's records own. Read-only: asked before anything is touched.
function occupiedAfterOur32Removal(dir, rel) {
  const lower = String(rel).toLowerCase();
  const name = (x) => String(x && typeof x === 'object' ? (x.rel || x.file || '') : x).replace(/\\/g, '/').toLowerCase();
  const lm = legacy.readMarker(dir) || {};
  const tm = translation.readManifest(dir) || {};
  const backups = [...(lm.backups || []), ...(tm.backups || [])];
  if (backups.some((b) => name(b) === lower)) return true;
  if (!fs.existsSync(path.join(dir, rel))) return false;
  const ours = (lm.files || []).some((f) => name(f) === lower)
    || (lm.dirs || []).some((d) => name(d) === lower)
    || (tm.files || []).some((f) => name(f) === lower);
  return !ours;
}

// What every removal of Chicken passes: the cache for the player's cfgs, and the way to take a
// 32-bit Vulkan game back off ReShade's app list (the same call uninstallEverything makes for DXVK).
function dfcRemoveOptions() {
  return {
    cacheDir: dfcCacheDir(),
    unlistVulkanApp: (record) => legacy.unlistVulkanLayerApp(record, {
      runElevatedPowerShell: (command) => elevate.runElevatedPowerShell(command, { execFileAsync }),
    }),
  };
}

async function dfcRouteFor(dir, exePath) {
  const { vendor } = await getGpuInfo();
  const effective = effectiveDetection(dir, exePath, await detectFor(dir, exePath));
  return recommendRoute(dir, exePath, effective, vendor, { lumaMod: lumaModFor(exePath, effective) });
}

// The swap on any game Chicken is offered on (route.dfcSupport), Feeder or not -- the card menu and
// Install on a plain-OptiScaler game come here; a Feeder game's Install goes through feeder:deploy,
// which does the same with the Feeder brought up to date first.
//   to 'dfc'         OptiScaler out, ReShade in as the proxy (the Feeder's, or fetched), the NR
//                    model, Chicken (dfc.switchToDfc)
//   to 'optiscaler'  Chicken out, its cfg kept; the renderer's Install then puts OptiScaler back
ipcMain.handle('dfc:switch', async (_evt, { exePath, to, nrDllPath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    if (to === 'dfc') {
      const route = await dfcRouteFor(dir, exePath);
      const support = route.dfcSupport;
      if (!support || !support.ok) {
        const e = new Error((support && support.code) || 'dfc-route');
        e.code = (support && support.code) || 'dfc-route';
        throw e;
      }
      if (route.dfcBits === 32) await refreshDfcCopy(32);
      else try { relimiter.demoteStandaloneReShade(dir); } catch {}
      // A 32-bit game: Chicken's own companion route, with this app's 32-bit route taken out whole.
      const r = route.dfcBits === 32
        ? await dfc.switchToDfc32(dir, dfcCacheDir(), {
          api: await resolveApi(dir, exePath),
          nrDllPath: nrDllPath || null,
          removeOurStack: removeOur32Stack,
          occupiedAfterRemoval: (rel) => occupiedAfterOur32Removal(dir, rel),
          reshadeSetup: () => feeder.downloadToCache(feeder.RESHADE_SETUP_URL, feederCacheDir(), path.basename(feeder.RESHADE_SETUP_URL), GITHUB_HEADERS),
          placeNvngxDlss: (hostDir) => feeder.deployNvngxDlss(hostDir, getRhiManifest, compareStreamlineVersions, feederCacheDir(), GITHUB_HEADERS),
          // 32-bit Vulkan: ReShade's 32-bit layer, on for this exe (one administrator prompt).
          setUpVulkanLayer: async () => {
            const setupPath = await feeder.downloadToCache(feeder.RESHADE_SETUP_URL, feederCacheDir(), path.basename(feeder.RESHADE_SETUP_URL), GITHUB_HEADERS);
            const r32 = await legacy.setUpVulkanLayer32(dir, exePath, {
              setupPath,
              runElevated: (file, args) => elevate.runElevated(file, args, { execFileAsync }),
              layerStatus: () => feeder.vulkanLayerStatus({ execFileAsync, exePath, bitness: 32 }),
            });
            return { ...r32, exe: exePath };
          },
        })
        : await dfc.switchToDfc(dir, dfcCacheDir(), {
          nrDllPath: nrDllPath || null,
          removeOptiScaler: removeOptiScalerForSwap,
          reshadeIsOurs: relimiter.placedReShade,
          fetchReShade: fetchReShadeForDfc,
        });
      invalidateDetection(dir);
      // Chicken's x64 worker on a hybrid laptop, on the card the game renders on (gpupref.js).
      if (route.dfcBits === 32) await preferDiscreteGpu(dir, exePath);
      return { ok: true, dfc: r, consumerHere: 'dfc' };
    }
    const r = (dfc.dfcOurs(dir) || dfc.reshadeProxyOf(dir)) ? await dfc.removeDfc(dir, dfcRemoveOptions()) : null;
    if (r && r.failed.length) throw new Error(`Chicken could not be taken out (${r.failed.map((f) => `${f.rel}: ${f.code}`).join(', ')}) -- close the game and try again`);
    invalidateDetection(dir);
    return { ok: true, dfcRemoved: r, consumerHere: 'optiscaler' };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), code: (error && error.code) || null };
  }
});

// Where the user's own Deep Fried Chicken copy lives once they have supplied it. Beside the other
// caches; never fetched into, only copied into from a file they picked.
function dfcCacheDir() {
  const dir = path.join(userDataDir(), 'dfc');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Settings: the user points at Chicken's zip or the folder they unpacked it into, once, and every
// game can use it after that. There is no download to offer -- see dfc.js for why.
// 7-Zip, where its installer puts it. Chicken 3.0 is handed out as a .7z, which nothing built into
// Windows can open when it is password-protected.
function sevenZipExe() {
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
    if (!base) continue;
    const p = path.join(base, '7-Zip', '7z.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Chicken's .7z carries a password its author prints in the release post and in its own README
// ("Archive password: chicken"), so that every player can open it -- used here only to unpack the
// player's own download into a temporary folder that is removed again.
const DFC_ARCHIVE_PASSWORD = 'chicken';

// The player's copy into the cache, from whatever they picked: the .7z itself (unpacked with 7-Zip),
// a .zip, a folder, or any file inside the folder they unpacked it into (the Windows picker cannot
// offer files and folders at once). Remembered in full, for refreshDfcCopy.
async function importChicken(picked) {
  let source = picked;
  let temp = null;
  if (/\.7z$/i.test(picked)) {
    const sz = sevenZipExe();
    if (!sz) {
      throw new Error(`${path.basename(picked)} is a password-protected .7z and 7-Zip is not installed -- unpack it yourself (the password is in Chicken's own README), then add it again and choose "Pick the folder I unpacked it into"`);
    }
    temp = path.join(os.tmpdir(), `dlss5ui-dfc-${Date.now()}`);
    try {
      await execFileAsync(sz, ['x', '-y', `-p${DFC_ARCHIVE_PASSWORD}`, `-o${temp}`, picked], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`7-Zip could not unpack ${path.basename(picked)} -- unpack it yourself, then add it again and choose "Pick the folder I unpacked it into"`);
    }
    source = temp;
  } else if (fs.existsSync(picked) && fs.statSync(picked).isFile() && !/\.zip$/i.test(picked)) {
    source = path.dirname(picked);
  }
  try {
    const r = await dfc.importDfcSource(source, dfcCacheDir());
    dfc.recordSource(dfcCacheDir(), picked);
    return { ...r, from: path.basename(picked) };
  } finally {
    if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

// A copy added before the app knew about Chicken's 32-bit or Vulkan/OpenGL parts, refreshed from
// where it was picked when a switch needs one of them. Nothing happens when the part is there, or the
// original is gone (the switch then says what to add).
async function refreshDfcCopy(need) {
  const cache = dfcCacheDir();
  const missing = (need === 32 && !dfc.cached32(cache)) || (need === 'compat' && !dfc.cachedCompat(cache));
  if (!missing) return;
  const info = dfc.suppliedInfo(cache) || {};
  if (!info.sourcePath || !fs.existsSync(info.sourcePath)) return;
  try { await importChicken(info.sourcePath); } catch {}
}

// Where the player's copy of Chicken is, asked as a plain question.
//
// It used to be one openFile dialog whose title said ".7z, or any file in the folder you unpacked
// it into". That made the natural action impossible: somebody who unpacks the archive sees the
// folder, tries to select it, and cannot -- an openFile dialog will not take a directory, so they
// are left hunting for a file inside it with no idea which one. Reported within a day of v2.4.0.
//
// Windows cannot offer both in one dialog (Electron: openFile and openDirectory cannot be
// combined there), so the choice is asked first rather than guessed at. The folder is the default
// because it is the one that needs nothing installed.
async function askForChicken() {
  const answer = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Pick the folder I unpacked it into', 'Pick the .7z file', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Add your copy of Deep Fried Chicken',
    message: 'Where is your copy of Deep Fried Chicken?',
    detail: 'Chicken is handed out on its author\u2019s Discord as a password-protected .7z, so this app cannot download it for you.\n\n'
      + 'Already unpacked it? Pick the folder \u2014 the whole folder, not a file inside it. The app finds the parts it needs. This needs nothing installed.\n\n'
      + 'Picking the .7z instead needs 7-Zip installed, and the app unpacks it with the password from Chicken\u2019s own README.',
  });
  if (answer.response === 2) return null;
  if (answer.response === 0) {
    const r = await dialog.showOpenDialog({
      title: 'Pick the folder you unpacked Deep Fried Chicken into',
      properties: ['openDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  }
  const r = await dialog.showOpenDialog({
    title: 'Pick Deep Fried Chicken\u2019s .7z',
    properties: ['openFile'],
    filters: [
      { name: 'Deep Fried Chicken (.7z, .zip)', extensions: ['7z', 'zip'] },
      { name: 'Any file', extensions: ['*'] },
    ],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
}

ipcMain.handle('dfc:supply', async (_evt, sourcePath) => {
  try {
    const picked = sourcePath || (await askForChicken());
    if (!picked) return { ok: true, cancelled: true };
    const r = await importChicken(picked);
    // Carry the new copy into every game this app already put Chicken into. Without this, replacing
    // the copy changed the cache and nothing else: the player's games kept the old binaries and
    // nothing on screen said so, which is not "changing it at will". Games with a hand-placed
    // Chicken are never ours and are left exactly as they are.
    const dirs = readJson(gamesFile(), []).map((g) => (g && g.exePath ? gameDir(g.exePath) : null)).filter(Boolean);
    const refreshed = await dfc.redeployOurs(dirs, dfcCacheDir());
    for (const dir of refreshed.updated) invalidateDetection(dir);
    return { ok: true, ...r, updatedGames: refreshed.updated.length, failedGames: refreshed.failed };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Chicken's own settings, in our panel. Writing this file is what its LICENSE.txt expressly allows
// ("create and share your own Deep Fried Chicken configuration and preset files"), while shipping
// its binaries is what it forbids -- so this reads and writes the config and nothing fetches.
ipcMain.handle('dfc:cfg-read', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'game .exe not found' };
    const text = dfc.readCfgText(gameDir(exePath));
    if (text === null) return { ok: true, present: false };
    return { ok: true, present: true, ...dfccfg.readFields(text) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// One field at a time, straight to disk: Chicken re-reads its config itself, and a panel that
// batched changes would leave the file disagreeing with what the user is looking at.
ipcMain.handle('dfc:cfg-write', async (_evt, { exePath, edits }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'game .exe not found' };
    const dir = gameDir(exePath);
    const text = dfc.readCfgText(dir);
    if (text === null) return { ok: false, error: 'there is no deep-fried-chicken.cfg in this folder yet' };
    const r = dfccfg.applyEdits(text, edits || {});
    if (r.refused) return { ok: false, error: r.refused };
    // Written through the same helper the rest of the app uses, so a read-only or locked file is
    // reported rather than throwing an errno at the renderer (#96).
    await fsp.writeFile(dfc.cfgPath(dir), r.text, 'utf8');
    return { ok: true, changed: r.changed };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// What the UI needs to draw the choice: whether a copy has been supplied at all, and for one game,
// whose Chicken is in the folder and what it last reported.
ipcMain.handle('dfc:status', async (_evt, exePath) => {
  try {
    const supplied = dfc.cachedDfc(dfcCacheDir());
    const out = { ok: true, supplied: !!supplied, suppliedFiles: supplied ? fs.readdirSync(supplied).sort() : [], suppliedInfo: dfc.suppliedInfo(dfcCacheDir()) };
    if (exePath && fs.existsSync(exePath)) {
      const dir = gameDir(exePath);
      out.present = dfc.dfcPresent(dir);
      out.ours = dfc.dfcOurs(dir);
      out.state = dfc.readDfcState(dir);
      out.cfg = dfc.readCfgText(dir);
      out.optiScalerHere = !!(await findActiveOptiScalerFile(dir));
      // Whether the swap is built for this game at all (64-bit Direct3D 11/12), so the choice can
      // say why before Install would refuse.
      // From the route, not the API alone: the route says whether Chicken is offered here at all
      // (NVIDIA, a Feeder or plain-OptiScaler game) and, if so, whether this game qualifies.
      out.support = (await dfcRouteFor(dir, exePath)).dfcSupport || null;
    }
    return out;
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// ── Experimental legacy routes: 32-bit games, DirectX 8/9 (legacy.js) ────────────────────────

// Where OptiScaler (and its log) lives for this game: host64\ for a 32-bit game on the helper route.
function optiScalerDirFor(dir) {
  const marker = legacy.readMarker(dir);
  return marker && marker.host32 ? path.join(dir, legacy.HOST_DIR) : dir;
}

function legacyPlanFor(dir, exePath, detected) {
  return legacy.planFor(effectiveDetection(dir, exePath, detected || {}));
}

// Whether Install should put DXVK in front of this game: picked by hand, or PROVEN for this game by the
// known-good catalog (layerdefault.js). Asked of the route, so the card, Edit and Install cannot
// disagree. Callers ask BEFORE they place anything: once the helper or dgVoodoo2 is in, "what is
// installed" wins over the catalog.
async function dxvkWanted(dir, exePath, detected) {
  if (translation.dxvkBlockedFor(exePath)) return false;
  if (translation.readPreference(dir) === 'dxvk') return true;
  const route = await layerRouteFor(dir, exePath, detected);
  return !!(route && route.wrapperPreference === 'dxvk');
}

async function layerRouteFor(dir, exePath, detected) {
  try {
    const effective = effectiveDetection(dir, exePath, detected || {});
    let vendor = 'unknown';
    try { vendor = ((await getGpuInfo()) || {}).vendor || 'unknown'; } catch {}
    return recommendRoute(dir, exePath, effective, vendor, { lumaMod: lumaModFor(exePath, effective) });
  } catch {
    return null;
  }
}

// Going back to the standard layer before anything is placed. With no proof the DXVK choice is simply
// forgotten, as it always was; where the catalog proves DXVK for this game, the standard layer is
// recorded as the pick instead -- with nothing recorded, the proven DXVK would just come back.
async function pickStandardLayer(dir, exePath, detected, standard) {
  const route = await layerRouteFor(dir, exePath, detected);
  const lc = route && route.layerChoice;
  translation.writePreference(dir, lc && lc.proven && lc.proven.via === 'dxvk' ? standard : null);
}

// The plan the DXVK <-> dgVoodoo2 swaps work from: the game's own API, never the one a wrapper this
// app deployed made it look like. Detection already keeps a 32-bit game's own API under our DXVK
// (detect.js ourTranslationLayer); this also covers a detection stored before that rule, or a
// 64-bit game, where the wrapper's 'vulkan' would otherwise leave "not a legacy game" and no way
// back to dgVoodoo2 (Assassin's Creed II, 2026-09-18).
function wrapperPlanFor(dir, exePath, detected) {
  const effective = effectiveDetection(dir, exePath, detected || {});
  const tl = translation.readManifest(dir);
  // A 32-bit DirectX 10/11 game can be under our DXVK too now (legacy.dxvkReplacesNative); its own API
  // is dx10 in legacyApis or dx11 in exeApis, which the wrapper's 'vulkan' never overwrites.
  const own = (effective.legacyApis || []).find((a) => a === 'dx8' || a === 'dx9')
    || (effective.bitness === 32 && ((effective.legacyApis || []).find((a) => a === 'dx10')
      || (effective.exeApis || []).find((a) => a === 'dx11')));
  if (effective.api === 'vulkan' && tl && tl.layer === 'dxvk' && own) return legacy.planFor({ ...effective, api: own });
  return legacy.planFor(effective);
}

// DXVK in front of a game, from the pinned release. A refused file is a failed deploy (deployDxvk is
// all-or-nothing now, and this says so either way). { ok, deployed, backedUp, text }.
async function deployDxvkFor(dir, plan) {
  let sourceDir;
  try {
    sourceDir = await translation.ensureDxvk(dxvkCacheDir(), { headers: GITHUB_HEADERS });
  } catch (error) {
    return { ok: false, text: `could not fetch DXVK: ${error && error.message ? error.message : error}` };
  }
  const r = await translation.deployDxvk(dir, { sourceDir, api: plan.api, bitness: plan.host32 ? 32 : 64 });
  invalidateDetection(dir);
  if (!r.ok || (r.refused || []).length) {
    const why = (r.refused || []).map((x) => `${x.file} (${x.reason})`).join(', ');
    return { ok: false, text: `DXVK was not deployed: ${why || 'refused'}` };
  }
  // A game whose renderer cannot load DXVK under its own names (Max Payne 2: legacy.js
  // RENDERER_RENAMES) gets it under the renamed pair too. A no-op for every other game.
  let rendererRename = null;
  if (plan.api === 'dx8' && plan.host32) {
    try {
      rendererRename = await legacy.applyRendererRenameForDxvk(dir, path.join(sourceDir, 'x32'));
    } catch (error) {
      return { ok: false, text: `DXVK is in, but its renamed copy for this game's renderer failed: ${error && error.message ? error.message : error}` };
    }
  }
  return { ok: true, deployed: r.deployed, backedUp: r.backedUp, rendererRename };
}

// A 32-bit DirectX 10/11 game: DXVK in place of its own Direct3D (legacy.swapNativeToDxvk parks the
// ReShade dxgi.dll proxy first and puts it back if DXVK is refused). { ok, deployed, backedUp,
// parkedNote, text }.
async function deployDxvkNative32(dir, plan) {
  const r = await legacy.swapNativeToDxvk(dir, plan, () => deployDxvkFor(dir, plan));
  invalidateDetection(dir);
  const parkedNote = r.parked ? `; the game-folder ReShade (${r.parked.parked}) is set aside as ${r.parked.as}` : '';
  return { ...r, parkedNote };
}

// "Use native Direct3D 11": DXVK out of a 32-bit DirectX 10/11 game, whatever it displaced handed
// back, and the parked ReShade proxy back as dxgi.dll (legacy.swapDxvkToNative). Game Help's answer
// shape, { done, text }. A DXVK only chosen, not placed -- by hand or proven by the catalog -- is
// forgotten, or, where the catalog proves it, answered by recording native as the pick
// (pickStandardLayer).
async function swapBackToNative(dir, plan, exePath, detected) {
  const nativeName = plan.api === 'dx10' ? 'Direct3D 10' : 'Direct3D 11';
  const layerNow = translation.activeLayer(dir);
  if (!(layerNow.ours && layerNow.layer === 'dxvk')) {
    if (await dxvkWanted(dir, exePath, detected)) {
      await pickStandardLayer(dir, exePath, detected, 'native');
      return { done: true, text: `native ${nativeName} it is again: Install leaves the game's own Direct3D in place` };
    }
    return { done: false, text: 'DXVK is not a layer this app put in front of this game, so there is nothing to swap back from' };
  }
  const answer = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Switch back', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Run this game through DXVK',
    message: `Switch this game back from DXVK to native ${nativeName}?`,
    detail: 'DXVK\'s files come out and anything of the game\'s they displaced goes back. The game-folder ReShade '
      + '(dxgi.dll) returns, so DLSS 5 reaches the game through it again; ReShade\'s Vulkan layer stays installed on the PC.'
      + '\n\nRun the game afterwards and check here again.',
  });
  if (answer.response !== 0) return { done: false, text: 'cancelled by the user' };
  // Nothing to record here: the helper stays installed on the game's own Direct3D, and what is installed
  // wins over the catalog's proof (layerdefault.js).
  translation.writePreference(dir, null);
  const r = await legacy.swapDxvkToNative(dir);
  invalidateDetection(dir);
  const back = (r.restored || []).length ? `; the game's own ${r.restored.join(', ')} is back` : '';
  const proxy = (r.unparked || []).length ? '; the game-folder ReShade is back'
    : (r.stillParked || []).length ? '; the game-folder ReShade could not go back under its name (something else holds it)' : '';
  const left = (r.skipped || []).length ? `; left alone: ${r.skipped.map((s) => `${s.file} (${s.reason})`).join(', ')}` : '';
  return { done: true, text: `DXVK is out and the game is on native ${nativeName} again${back}${proxy}${left} -- run the game and check again` };
}

// The 32-bit helper route under DXVK: the game-folder ReShade proxy parked and ReShade's own setup
// run elevated for its 32-bit Vulkan layer (legacy.js has the why and the command line). Shared by
// the swap and by Install, which is where a DXVK chosen before installing gets its layer.
async function dxvkHost32LayerStep(dir, exePath) {
  const parked = await legacy.parkReShadeProxy(dir);
  const parkedNote = parked.parked ? `; the game-folder ReShade (${parked.parked}) is set aside as ${parked.as}` : '';
  let setupPath;
  try {
    setupPath = await ensureReShadeSetupOrAsk();
  } catch (error) {
    return { ok: false, parkedNote, error: `ReShade's setup could not be fetched (${error && error.message ? error.message : error})` };
  }
  const layer = await legacy.setUpVulkanLayer32(dir, exePath, {
    setupPath,
    runElevated: (file, args) => elevate.runElevated(file, args, { execFileAsync }),
    layerStatus: () => feeder.vulkanLayerStatus({ execFileAsync, exePath, bitness: 32 }),
  });
  invalidateDetection(dir);
  return { ok: layer.ok, ran: layer.ran, error: layer.error || null, parkedNote };
}

// ReShade's installer, with the door out that dgVoodoo2 has had all along (askForDgVoodooZip's
// shape, below). reshade.me publishes only its current version: when the next one ships, the
// version this app pins 404s and every fresh Feeder install fails at the same step on every
// machine at once. Rather than leave the user with nothing, offer to take a setup they already
// have -- validated as the Add-on build, since the plain one deploys fine and then never loads
// the Feeder.
// Where a browser drops things. The same handoff pdplugin.js makes for PureDark's plugin.
function reshadeDownloadDirs() {
  const dirs = [];
  for (const key of ['downloads', 'desktop']) {
    try { dirs.push(app.getPath(key)); } catch {}
  }
  return dirs;
}

// ReShade's installer, with the handoff that keeps a failed download from ending the install.
//
// reshade.me publishes only its current version, so the version this app pins stops existing when
// the next one ships -- and a filtered network, a VPN that is a proxy rather than a tunnel, or a
// bad minute at the host all land in the same place. None of that may leave a user stuck, so when
// the app cannot fetch it:
//
//   - it says WHICH download failed and why (the host and the cause, not "fetch failed"),
//   - it points at reshade.me and puts the link on the clipboard, because a BROWSER usually
//     succeeds where this app's fetch does not: Node ignores the system proxy a VPN or a
//     DPI-bypass tool sets up, and a browser does not,
//   - and then it finds what they downloaded by itself, in Downloads or on the Desktop, checks it
//     is the Add-on build and carries straight on with the install.
//
// So the user's only job is to click a link and save a file. No path to type, nothing to place.
async function ensureReShadeSetupOrAsk(win = null) {
  const attempt = () => feeder.ensureReShadeSetup(feederCacheDir(), GITHUB_HEADERS, { downloadDirs: reshadeDownloadDirs() });
  let error;
  try {
    return await attempt();
  } catch (e) {
    error = e;
  }

  const page = error.downloadPage || 'https://reshade.me/';
  let note = '';
  // Bounded: each round is a button press, and Cancel is always there. The cap only stops a stuck
  // dialog looping forever if showMessageBox ever starts answering without a user.
  for (let round = 0; round < 12; round++) {
    const answer = await dialog.showMessageBox(...(win ? [win] : []), {
      type: 'warning',
      buttons: ['Open the download page', 'Copy the link', "I've downloaded it -- look again", 'Choose the file myself...', 'Cancel'],
      defaultId: 0,
      cancelId: 4,
      noLink: true,
      title: 'ReShade (the Feeder is one of its add-ons)',
      message: 'This app could not download ReShade\u2019s installer.',
      detail: `${error.message}\n\n${page}\n\nDownload the Add-on build there and save it \u2014 Downloads is fine, you do not have to tell this app where it went. ` +
        `Then press "I've downloaded it" and the install carries on.${note}`,
    });

    if (answer.response === 4) throw error;
    if (answer.response === 0) {
      await shell.openExternal(page).catch(() => {});
      note = '\n\nThe page is open in your browser.';
      continue;
    }
    if (answer.response === 1) {
      clipboard.writeText(page);
      note = `\n\nCopied: ${page}`;
      continue;
    }
    if (answer.response === 2) {
      try {
        return await attempt();
      } catch (e) {
        // Keep the newest reasons -- "you downloaded the plain build" is the one that matters.
        error = e;
        note = '\n\nStill nothing usable found. Check the file finished downloading, and that it is the Add-on build.';
        continue;
      }
    }
    const pick = await dialog.showOpenDialog({
      title: 'Select ReShade\u2019s Add-on setup',
      properties: ['openFile'],
      filters: [{ name: 'ReShade setup', extensions: ['exe'] }],
    });
    if (pick.canceled || pick.filePaths.length === 0) continue;
    try {
      return await feeder.importReShadeSetup(pick.filePaths[0], feederCacheDir());
    } catch (e) {
      note = `\n\n${e && e.message ? e.message : e}`;
    }
  }
  throw error;
}

// dgVoodoo2 in front of a DirectX 8/9 game. Fetched like every other component, with no prompt:
// the zip Defender flags is never written (legacy.js). Only when that fetch fails -- offline, a
// checksum mismatch, a scanner taking one of the files -- is the user offered a zip of their own.
ipcMain.handle('legacy:dgvoodoo', async (_evt, { exePath, detected } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const plan = legacyPlanFor(dir, exePath, detected);
    if (!plan.supported || !plan.dgVoodoo) return { ok: true, skipped: true };
    if (legacy.status(dir).dgVoodoo && fs.existsSync(path.join(dir, plan.dgVoodoo.dll))) return { ok: true, already: true };
    // DXVK swapped in from Game Help does this job here; Install must not quietly swap it back.
    const tl = translation.readManifest(dir);
    if (tl && tl.layer === 'dxvk') return { ok: true, already: true, via: 'dxvk' };
    // DXVK chosen before anything was installed (card menu, Edit or Game Help), or proven for this
    // game by the known-good catalog (layerdefault.js): it goes in here, where dgVoodoo2 would have.
    if (await dxvkWanted(dir, exePath, detected)) {
      const r = await deployDxvkFor(dir, plan);
      if (!r.ok) throw new Error(r.text);
      translation.writePreference(dir, null);
      return { ok: true, via: 'dxvk', deployed: true, dll: (r.deployed || []).join(', ') };
    }
    let source;
    try {
      source = await legacy.ensureDgVoodoo(feederCacheDir(), { headers: GITHUB_HEADERS });
    } catch (fetchError) {
      const answer = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Use a dgVoodoo2 zip I have…', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'dgVoodoo2 (experimental DirectX 8/9 route)',
        message: 'dgVoodoo2 could not be set up automatically.',
        detail: `${fetchError.message}\n\nIf you have a dgVoodoo2 release zip (${legacy.DGVOODOO.page}), pick it and Install carries on.`,
      });
      if (answer.response !== 0) throw fetchError;
      const pick = await dialog.showOpenDialog({ title: 'Select a dgVoodoo2 release zip', properties: ['openFile'], filters: [{ name: 'dgVoodoo2 zip', extensions: ['zip'] }] });
      if (pick.canceled || pick.filePaths.length === 0) return { ok: true, cancelled: true };
      source = await legacy.importDgVoodooZip(pick.filePaths[0], feederCacheDir());
    }
    const res = await legacy.deployDgVoodoo(dir, plan, source, { vendor: ((await getGpuInfo()) || {}).vendor });
    return { ok: true, ...res };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), code: error && error.code ? error.code : null };
  }
});

// The shaders beside a 32-bit game (legacy.js deployLegacyShaders). Any selectable provider now, not
// only VORT: Assassin's Creed II (2026-09-18) jumped with VORT and the Feeder recommends LumeniteFX.
// licenseConfirmed is only ever true after the renderer showed feeder:confirmProviderLicense's
// dialog; deployLumeniteFx refuses without it regardless.
function deployLegacyShaders(dir, mvProviderId, licenseConfirmed) {
  return legacy.deployLegacyShaders(dir, mvProviderId || feeder.defaultMvProviderId(), {
    cacheDir: feederCacheDir(), ghHeaders: GITHUB_HEADERS, licenseConfirmed: !!licenseConfirmed,
  });
}

// The whole 32-bit helper route for one game (dgVoodoo2, when needed, is legacy:dgvoodoo first).
ipcMain.handle('legacy:installHost32', async (_evt, { exePath, detected, releaseFolder, nrDllPath, mvProviderId, licenseConfirmed } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const plan = legacyPlanFor(dir, exePath, detected);
    if (!plan.supported || !plan.host32) throw new Error(`this game does not take the 32-bit route (${plan.reason || 'not 32-bit'})`);
    let dxvkInstead = (translation.readManifest(dir) || {}).layer === 'dxvk';
    if (plan.dgVoodoo && !legacy.status(dir).dgVoodoo && !dxvkInstead) throw new Error('dgVoodoo2 has to be in place first');
    // Asked now, before the helper goes in: once it is, the route reads the game as installed on its
    // own Direct3D, and a DXVK proven by the catalog would no longer be the answer.
    const dxvkForNative = !dxvkInstead && legacy.dxvkReplacesNative(plan) && await dxvkWanted(dir, exePath, detected);
    const root = releaseFolder && findReleaseRoot(releaseFolder);
    if (!root || !hasDlssNrSection(root)) throw new Error('OptiScaler release folder not set, or not the DLSS-NR build');
    if (!nrDllPath || !fs.existsSync(nrDllPath)) throw new Error('DLSS NR model file not found -- check Settings');
    // A provider behind a licence is refused before anything is downloaded or placed.
    const chosenMv = feeder.MV_PROVIDERS[mvProviderId || feeder.defaultMvProviderId()];
    if (chosenMv && !chosenMv.autoFetchable && !chosenMv.bringYourOwn && !licenseConfirmed) {
      throw new Error(`${chosenMv.displayName} needs its licence confirmed before it can be fetched`);
    }
    const asset = await feeder.resolveFeederAsset(GITHUB_HEADERS);
    const feederZip = await feeder.downloadToCache(asset.url, feederCacheDir(), asset.name, GITHUB_HEADERS, { sha256: asset.digest });
    const reshadeSetup = await ensureReShadeSetupOrAsk();
    const res = await legacy.deployHost32(dir, plan, {
      feederZip,
      reshadeSetup,
      releaseFolder: root,
      nrDllPath,
      deployShaders: (d) => deployLegacyShaders(d, mvProviderId, licenseConfirmed),
      deployNvngxDlss: (hostDir) => feeder.deployNvngxDlss(hostDir, getRhiManifest, compareStreamlineVersions, feederCacheDir(), GITHUB_HEADERS),
    });
    try { applyPanelLanguage(path.join(dir, legacy.HOST_DIR)); } catch {}
    try { applyNrOn(path.join(dir, legacy.HOST_DIR)); } catch {}
    // DXVK in dgVoodoo2's place: the ReShade that just went in as dxgi.dll is parked and ReShade's
    // 32-bit Vulkan layer set up instead -- the same step the swap runs. It asks for admin only when
    // the layer is not already registered and switched on for this exe.
    let dxvkLayer = null;
    // A 32-bit DirectX 10/11 game with DXVK chosen before Install: there is no dgVoodoo2 step for it
    // to take the place of, so it goes in here, after the ReShade proxy it has to park exists.
    // Placing it first would have deployHost32 back DXVK's dxgi.dll up as "the game's own" and put
    // ReShade over it.
    if (dxvkForNative) {
      const r = await deployDxvkNative32(dir, plan);
      if (r.ok) {
        translation.writePreference(dir, null);
        dxvkInstead = true;
      } else {
        // Installed all the same, on the game's own Direct3D; the choice stays for another try.
        dxvkLayer = { ok: false, dxvkRefused: true, error: r.text || 'DXVK was not deployed' };
      }
    }
    if (dxvkInstead) dxvkLayer = await dxvkHost32LayerStep(dir, exePath);
    const gpuPreference = await preferDiscreteGpu(dir, exePath);
    return { ok: true, ...res, feederVersion: asset.tag, api: plan.api, dxvkLayer, gpuPreference };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The motion-vector provider a 32-bit route game is on, for Edit's picker and the card's menu entry.
// File reads only (marker, preset), so it is cheap enough for every card.
function legacyMvSummary(dir) {
  const marker = legacy.readMarker(dir);
  if (!marker || !marker.host32) return null;
  const cur = legacy.currentMvProvider(dir);
  const provider = cur.id ? feeder.MV_PROVIDERS[cur.id] : null;
  return {
    id: cur.id,
    displayName: provider ? provider.displayName : null,
    mvProviderValue: provider ? provider.mvProviderValue : null,
    // iMMERSE is bring-your-own: offered only when the player's copy is already in the folder.
    immersePresent: feeder.mvProviderPresent(dir, 'immerse-launchpad'),
  };
}

ipcMain.handle('legacy:mvProvider', async (_evt, { exePath } = {}) => {
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Game .exe not found' };
  const summary = legacyMvSummary(gameDir(exePath));
  return summary ? { ok: true, host32: true, ...summary } : { ok: true, host32: false };
});

// Switches the provider on an installed 32-bit game without reinstalling: the old provider's files
// out, the new one's in, preset techniques and DLSS5_MV_PROVIDER rewritten, all journaled for Remove
// (legacy.js setMvProvider). licenseConfirmed as for feeder:deploy -- only true after the renderer's
// licence dialog, and deployLumeniteFx refuses without it regardless.
ipcMain.handle('legacy:setMvProvider', async (_evt, { exePath, mvProviderId, licenseConfirmed } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const res = await legacy.setMvProvider(dir, mvProviderId, {
      cacheDir: feederCacheDir(), ghHeaders: GITHUB_HEADERS, licenseConfirmed: !!licenseConfirmed,
    });
    return { ok: true, ...res, current: legacyMvSummary(dir) };
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
    const detected = effectiveDetection(dir, exePath, await detectFor(dir, exePath));
    return { ok: true, ...lumaue.lumaUeReadiness(dir, exePath, detected, lumaModFor(exePath, detected)) };
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
    const detected = effectiveDetection(dir, exePath, await detectFor(dir, exePath));
    const profile = lumaue.deployedProfile(dir) || lumaue.lumaProfileFor(exePath, detected, lumaModFor(exePath, detected));
    if (!profile) throw new Error('Luma UE is for Unreal Engine 4 games rendering with DirectX 11 and no DLSS of their own');
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
      profile,
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
  // An Unreal root launcher stub is swapped for the shipping exe it spawns (detect.js) -- but the
  // swap is now reported rather than silently applied. Someone who browses to a particular exe and
  // gets a different path back reads that as the app overruling them, which is the "I change it in
  // Edit and it defaults back" report. Edit shows what happened and offers the original.
  // The Store's gamelaunchhelper.exe is swapped the same way, for the exe it starts (#65).
  const picked = res.filePaths[0];
  const resolved = discover.resolvePickedExe(picked);
  return { path: resolved, picked, swapped: resolved.toLowerCase() !== picked.toLowerCase() };
});

// Every exe in this game's folder tree, best candidates first, so Edit can offer the real choices
// rather than only a Browse dialog. Same walker and scoring the library scan uses, so the list and
// its order match what the scan would propose -- with the game's current exe always in it, even
// when the scoring would not have picked that one.
ipcMain.handle('game:exe-candidates', (_evt, exePath) => {
  try {
    if (!exePath) return { ok: true, candidates: [], root: null };
    const root = nativeDlss.installRoot(gameDir(exePath));
    const picked = discover.chooseExe(root, path.basename(root));
    const ordered = picked ? [picked.exePath, ...(picked.alternatives || [])] : [];
    const candidates = [...new Set([path.resolve(exePath), ...ordered.map((p) => path.resolve(p))])]
      .filter((p) => fs.existsSync(p));
    return { ok: true, root, candidates };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), candidates: [], root: null };
  }
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

// Bumped when the search gets smarter, so cards that missed under an older search try again.
// 4: the store's first answer is no longer taken on trust -- library.pickBannerMatch has to
// recognise it (Castlevania: Lords of Shadow wore Lords of Shadow 2's art) -- and the term ladder
// handles dotted acronyms, a trailing "1", and dropping trailing words when nothing else hits.
// 3: a Steam manifest beside the exe now decides the art, so cards whose auto-found art
// disagrees with their manifest are corrected once.
const BANNER_SEARCH_VERSION = 5;

async function steamStoreSearch(term) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
  const res = await netFetch(url, { headers: { 'User-Agent': 'OptiDLSS5-UI' } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).slice(0, 8).map((item) => ({
    appid: item.id,
    name: item.name,
    tinyImage: item.tiny_image || null
  }));
}

ipcMain.handle('steam:search', async (_evt, term) => {
  try {
    // The name as given first, then the spellings the store is more likely to know. The first
    // spelling with a hit wins; a term that fails is not the end of it.
    // The picked match first, then the rest of that spelling's results: this is the Edit dialog's
    // own search box, where the user makes the final call, so nothing is hidden -- only reordered
    // so the app's own best guess is the one under the cursor.
    for (const t of library.bannerSearchTerms(term)) {
      const items = await steamStoreSearch(t);
      if (!items.length) continue;
      const best = library.pickBannerMatch(t, items);
      return best ? [best, ...items.filter((i) => i !== best)] : items;
    }
    return [];
  } catch {
    return [];
  }
});

ipcMain.handle('steam:searchVersion', () => BANNER_SEARCH_VERSION);

// The art for a card, without guessing where the answer is on disk. A game under a Steam
// library has its appid in the appmanifest beside it, which is exact; a store search by name
// is the fallback, and only for games Steam does not own -- "re2" searched the store and got
// Red Dead Redemption 2 (a real card, 2026-09-12).
ipcMain.handle('banner:resolve', async (_evt, { exePath, name } = {}) => {
  try {
    const manifest = library.steamManifestFor(exePath);
    if (manifest) return { appid: String(manifest.appid), name: manifest.name, tinyImage: null, source: 'steam-manifest' };
    // Unlike the search box, this picks art on its own with nobody watching, so a title it cannot
    // recognise is left without art rather than given somebody else's.
    for (const t of library.bannerSearchTerms(name)) {
      const items = await steamStoreSearch(t);
      if (!items.length) continue;
      const best = library.pickBannerMatch(t, items);
      if (best) return { appid: String(best.appid), name: best.name, tinyImage: best.tinyImage, source: 'search' };
    }
    // Last network step before the exe icon: the community art database, on the user's own key.
    // Only reached for a game the store could not name -- old, delisted, console-ported, or never
    // sold on Steam -- which is exactly the set that was ending up wearing its own icon. No key
    // set is not a failure, it is this step not existing (steamgrid.resolve returns null then).
    // No appid comes back: a SteamGridDB id is not a Steam one, and bannerAppId is what this app
    // reads as "this is a Steam game" (loadInjectorSection). The art arrives as a URL instead.
    const sgdb = await steamgrid.resolve(name, (readJson(settingsFile(), {}) || {}).steamGridDbKey);
    if (sgdb) return { appid: null, name: sgdb.name, imageUrl: sgdb.imageUrl, gridId: sgdb.gridId, source: 'steamgriddb' };
    return null;
  } catch {
    return null;
  }
});

// What to call a game added by its exe: the Steam manifest's name where there is one, else a
// folder or exe name that says something (library.nameForExe).
ipcMain.handle('game:nameForExe', (_evt, exePath) => {
  try { return library.nameForExe(exePath); } catch { return null; }
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
// ---- The game's own NVIDIA Frame Generation: multiplier override ----------------------------
//
// A native-DLSS game (anything with an nvngx_dlssg.dll, beside the exe or in its Unreal plugin
// tree) runs NVIDIA's own DLSS Frame Generation through Streamline. OptiScaler never replaces
// that here (its own FG bridge stays off -- see autoConfigureGame), but it does hook every
// slDLSSGSetOptions the game makes, and [DLSSG] OverrideInterpolationCount / OverrideForceDMFG /
// FramerateTargetDMFG in OptiScaler.ini rewrite what the game asks the driver for: 1 = 2x,
// 2 = 3x, 3 = 4x generated frames, or Dynamic (the driver picks, RTX 50 only). Turning FG on and
// off stays the game's own video setting. The engine clamps a count above what the driver
// reports (an RTX 40 card is 2x whatever is written), so offering 3x/4x everywhere is safe.
//
// Same shape as the Lossless marker: game:install copies the release ini over the folder
// wholesale, and a multiplier can be picked before OptiScaler is installed, so the source of
// truth is a per-game marker beside the exe that autoConfigureGame re-applies. No marker means
// "don't touch" -- a value set live from the Alt+Home panel is then left alone.
const FRAMEGEN_MARKER = '.dlss5ui-framegen.json';

// The value of one key in one section of an ini, as written (trimmed), or null when absent.
function readIniKey(iniPath, section, key) {
  let text;
  try { text = fs.readFileSync(iniPath, 'utf-8'); } catch { return null; }
  let inSection = false;
  for (const line of text.split(/\r\n|\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) { inSection = sectionMatch[1].toLowerCase() === section.toLowerCase(); continue; }
    if (!inSection) continue;
    const kvMatch = line.match(/^(\s*)([^;#=\s][^=]*?)(\s*=\s*)(.*)$/);
    if (kvMatch && kvMatch[2].trim().toLowerCase() === key.toLowerCase()) return kvMatch[4].trim();
  }
  return null;
}

function frameGenMarkerFrames(marker) {
  return marker && Number.isInteger(marker.frames) && marker.frames >= 1 && marker.frames <= 5 ? marker.frames : null;
}

function applyFrameGenMarker(dir) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  const marker = readJson(path.join(dir, FRAMEGEN_MARKER), null);
  if (!marker || !fs.existsSync(iniPath)) return [];
  const applied = [];
  const set = (key, value) => {
    if (ensureIniKey(iniPath, 'DLSSG', key, value)) applied.push({ section: 'DLSSG', key, value });
  };
  const frames = frameGenMarkerFrames(marker);
  set('OverrideInterpolationCount', frames ? String(frames) : 'auto');
  set('OverrideForceDMFG', marker.dynamic ? 'true' : 'auto');
  if (marker.dynamic) {
    const target = Number(marker.target);
    set('FramerateTargetDMFG', Number.isFinite(target) && target > 0 ? String(Math.round(target)) : 'auto');
  }
  return applied;
}

// The engine choice per game (engines.js). RunBeforeSR / Passes are written once when the marker
// is pending (just installed, or just changed in Edit Game) and never again after that: the
// in-game panel saves those keys too, and OptiScaler writes a default-valued key back as
// auto, so a sync that re-forced them would silently undo a choice made in the game. A folder
// installed before this existed has no marker and is left exactly as is.
function applyEngineMarker(dir) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  const marker = engines.readEngineMarker(dir);
  if (!marker || !marker.pendingApply || !fs.existsSync(iniPath)) return [];
  const applied = [];
  for (const { section, key, value } of engines.iniEditsFor(marker)) {
    if (ensureIniKey(iniPath, section, key, value)) applied.push({ section, key, value });
  }
  engines.writeEngineMarker(dir, { ...marker, pendingApply: false });
  return applied;
}

ipcMain.handle('engine:forGame', (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { marker: null, ini: null };
  const dir = gameDir(exePath);
  const iniPath = path.join(dir, 'OptiScaler.ini');
  return {
    marker: engines.readEngineMarker(dir),
    iniPresent: fs.existsSync(iniPath),
    ini: fs.existsSync(iniPath) ? {
      runBeforeSR: readIniKey(iniPath, 'DlssNr', 'RunBeforeSR'),
      passes: readIniKey(iniPath, 'DlssNr', 'Passes'),
    } : null,
  };
});

// runBeforeSR / passes as explicit choices for this game. Writes the marker and, when OptiScaler
// is already in the folder, the ini.
ipcMain.handle('engine:setForGame', (_evt, { exePath, engine, runBeforeSR, passes } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const prev = engines.readEngineMarker(dir) || {};
    // Only what this call names is an explicit choice. A build change alone keeps the earlier
    // choices and writes nothing new to the ini; the re-Install that switches the files does.
    const choosing = typeof runBeforeSR === 'boolean' || passes !== undefined && passes !== null;
    const marker = {
      ...prev,
      engine: engines.normalizeEngine(engine),
      ...(typeof runBeforeSR === 'boolean' ? { runBeforeSR } : {}),
      ...(passes !== undefined && passes !== null ? { passes: engines.clampPasses(passes) } : {}),
      pendingApply: choosing ? true : !!prev.pendingApply,
      updatedAt: new Date().toISOString(),
    };
    engines.writeEngineMarker(dir, marker);
    const iniPresent = fs.existsSync(path.join(dir, 'OptiScaler.ini'));
    return { ok: true, marker, deferred: !iniPresent, applied: iniPresent ? applyEngineMarker(dir) : [] };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('framegen:multiplier', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { hasFrameGen: false };
  const dir = gameDir(exePath);
  if (!framegen.frameGenSwapState(dir).hasFrameGen) return { hasFrameGen: false };
  let gpuVendor = 'unknown';
  try { gpuVendor = ((await getGpuInfo()) || {}).vendor || 'unknown'; } catch {}
  const iniPath = path.join(dir, 'OptiScaler.ini');
  const iniPresent = fs.existsSync(iniPath);
  return {
    hasFrameGen: true,
    gpuVendor,
    marker: readJson(path.join(dir, FRAMEGEN_MARKER), null),
    iniPresent,
    ini: iniPresent ? {
      frames: readIniKey(iniPath, 'DLSSG', 'OverrideInterpolationCount'),
      dynamic: readIniKey(iniPath, 'DLSSG', 'OverrideForceDMFG'),
      target: readIniKey(iniPath, 'DLSSG', 'FramerateTargetDMFG'),
    } : null,
  };
});

// frames: 1..5 generated frames per real one (1 = 2x), or null; dynamic: let the driver pick.
// Neither = back to the game's own setting: the marker goes and any override it wrote is cleared.
ipcMain.handle('framegen:setMultiplier', async (_evt, { exePath, frames, dynamic, target } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    if (!framegen.frameGenSwapState(dir).hasFrameGen) {
      throw new Error('This game has no DLSS Frame Generation of its own (no nvngx_dlssg.dll) -- nothing to set a multiplier on');
    }
    const iniPath = path.join(dir, 'OptiScaler.ini');
    const markerPath = path.join(dir, FRAMEGEN_MARKER);
    const wantFrames = frameGenMarkerFrames({ frames: Number(frames) });
    const wantDynamic = !!dynamic;
    if (!wantFrames && !wantDynamic) {
      try { fs.rmSync(markerPath, { force: true }); } catch {}
      const cleared = [];
      if (fs.existsSync(iniPath)) {
        for (const key of ['OverrideInterpolationCount', 'OverrideForceDMFG']) {
          if (ensureIniKey(iniPath, 'DLSSG', key, 'auto')) cleared.push({ section: 'DLSSG', key, value: 'auto' });
        }
      }
      return { ok: true, cleared: true, deferred: !fs.existsSync(iniPath), applied: cleared };
    }
    const t = Number(target);
    writeJson(markerPath, {
      frames: wantDynamic ? null : wantFrames,
      dynamic: wantDynamic,
      target: Number.isFinite(t) && t > 0 ? Math.round(t) : null,
      updatedAt: new Date().toISOString(),
    });
    if (!fs.existsSync(iniPath)) return { ok: true, cleared: false, deferred: true, applied: [] };
    return { ok: true, cleared: false, deferred: false, applied: applyFrameGenMarker(dir) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// ---- RTXMFG: Multi Frame Generation on RTX 40 / 30 (rtxmfg.js) ------------------------------
//
// Offered on the same games as the multiplier above -- the game's own DLSS Frame Generation is what it
// unlocks -- and independent of OptiScaler: it works with or without it installed.
const rtxmfgCacheDir = () => path.join(userDataDir(), 'rtxmfg-cache');

ipcMain.handle('rtxmfg:state', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { hasFrameGen: false };
  const dir = gameDir(exePath);
  const hasFrameGen = framegen.frameGenSwapState(dir).hasFrameGen;
  let gpuInfo = null;
  try { gpuInfo = await getGpuInfo(); } catch {}
  const marker = rtxmfg.readMarker(dir);
  return {
    hasFrameGen,
    gpu: { name: gpuInfo && gpuInfo.name, ...rtxmfg.gpuSupport(gpuInfo) },
    marker,
    installed: !!rtxmfg.ourFile(dir),
    intact: marker ? rtxmfg.isOurCopy(dir, marker) : false,
    settingsPresent: fs.existsSync(path.join(dir, rtxmfg.SETTINGS_FILE)),
    ...rtxmfg.proxyChoice(dir),
    projectPage: rtxmfg.PROJECT_PAGE,
  };
});

ipcMain.handle('rtxmfg:install', async (_evt, { exePath, proxyName } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    if (!framegen.frameGenSwapState(dir).hasFrameGen) {
      throw new Error('This game has no DLSS Frame Generation of its own (no nvngx_dlssg.dll) -- RTXMFG has nothing to unlock');
    }
    const cache = await rtxmfg.ensureCache({ cacheRoot: rtxmfgCacheDir(), headers: GITHUB_HEADERS });
    if (!cache.ok) throw new Error(cache.error);
    const name = proxyName || rtxmfg.proxyChoice(dir).suggested;
    if (!name) throw new Error('every name RTXMFG can load as is already taken in this folder');
    const marker = rtxmfg.deploy(dir, { dllPath: cache.dllPath, sha256: cache.sha256, tag: cache.tag, proxyName: name });
    invalidateDetection(dir);
    return { ok: true, marker };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('rtxmfg:remove', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const res = rtxmfg.remove(dir);
    invalidateDetection(dir);
    return { ok: true, ...res };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

const API_OVERRIDE_MARKER = '.dlss5ui-api.json';

function readApiOverride(dir) {
  const marker = readJson(path.join(dir, API_OVERRIDE_MARKER), null);
  return marker && API_OVERRIDE_VALUES.includes(marker.api) ? marker.api : null;
}

// The proxy DLL name, chosen by hand. Same shape as the API choice above and for the same reason:
// detection reads a file on disk, and which DLL a game actually loads at start is knowledge this
// code does not always have. OptiScaler's own wiki names a proxy for several games this app has no
// entry for, and until now there was no way to act on that -- a No Man's Sky reporter (#132) went
// through every section of Edit looking for the setting before I could tell them it did not exist.
//
// Distinct from PROXY_OVERRIDES, which is this app's own table, keyed by exe and measured one game
// at a time. That table stays the automatic answer; this is the user overruling it for their copy.
const PROXY_CHOICE_MARKER = '.dlss5ui-proxy.json';

function readProxyChoice(dir) {
  const marker = readJson(path.join(dir, PROXY_CHOICE_MARKER), null);
  const name = marker && typeof marker.proxy === 'string' ? marker.proxy.toLowerCase() : null;
  // Only a name the folder scan can read back. A stored choice that is no longer offered (a name
  // dropped from HOOK_DLLS in some later version) is ignored rather than honoured into a state
  // where the app installs something it cannot then see -- the exact bug this control came out of.
  return name && PROXY_CHOICE_NAMES.includes(name) ? name : null;
}

function writeProxyChoice(dir, name) {
  const file = path.join(dir, PROXY_CHOICE_MARKER);
  if (!name) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  writeJson(file, { proxy: name, setAt: new Date().toISOString() });
}

function writeApiOverride(dir, api) {
  const file = path.join(dir, API_OVERRIDE_MARKER);
  if (!api) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  writeJson(file, { api, setAt: new Date().toISOString() });
}

// ── Detection, once ──────────────────────────────────────────────────────────────────────────
//
// Every detection in the main process goes through detectFor. Behind it, detect.js caches the
// answer per executable and reuses the one already stored for the game (games.json) while the
// rules, the folder and OptiScaler.log still agree with it -- only the folder evidence is re-read.
//
// This is the fix for the app's own slowness. detectGame scans the executable byte by byte when a
// string it looks for is absent, which on a big title means reading the whole file: measured on
// this library, 11 s for Star Wars Outlaws, 10 s for Resident Evil Requiem, 52 s for all twenty
// games. autoConfigureGame called it uncached, and autoConfigureGame runs for every installed game
// on every sync -- so a start-up spent about a minute of the main process inside detection, with
// every IPC call the grid made queued behind it. Measured on that library: 70 s for one sync pass
// before, 2 s for the first pass now, and 10 ms for every pass after it.
const storedDetections = { mtimeMs: null, byExe: new Map(), names: new Map() };
function refreshStoredGames() {
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(gamesFile()).mtimeMs; } catch {}
  if (mtimeMs !== storedDetections.mtimeMs) {
    storedDetections.mtimeMs = mtimeMs;
    storedDetections.byExe = new Map();
    storedDetections.names = new Map();
    for (const game of readJson(gamesFile(), [])) {
      if (!game || !game.exePath) continue;
      if (game.detectedPath) storedDetections.byExe.set(game.exePath.toLowerCase(), game.detectedPath);
      if (game.name) storedDetections.names.set(game.exePath.toLowerCase(), game.name);
    }
  }
}
function storedDetectionFor(exePath) {
  refreshStoredGames();
  return storedDetections.byExe.get(String(exePath || '').toLowerCase()) || null;
}

function detectFor(dir, exePath) {
  return detectGameCached(dir, exePath, { stored: storedDetectionFor(exePath) });
}

// ---- Luma-Framework per-game mods (lumacatalog.js) ------------------------------------------------
//
// Every game on the grid is checked against Luma-Framework's own list of DLSS-adding mods, by the names it
// goes by: its card name, its Steam manifest name, and the folders it sits in. A match puts the game on the
// Luma route (route.js) and on DirectX 11. The catalog loads from userData (else the bundled snapshot) and
// refreshes from GitHub at start-up and once a day, so a mod Luma publishes later is picked up by itself.
const lumaCatalogFile = () => path.join(userDataDir(), 'luma-catalog.json');
const lumaModCache = new Map();
function lumaNamesFor(exePath) {
  refreshStoredGames();
  const names = [];
  const cardName = storedDetections.names.get(String(exePath || '').toLowerCase());
  if (cardName) names.push(cardName);
  try {
    const manifest = library.steamManifestFor(exePath);
    if (manifest && manifest.name) names.push(manifest.name);
  } catch {}
  const parts = path.dirname(String(exePath || '')).split(/[\\/]/).filter(Boolean);
  // The install folder under steamapps\common (or whatever library root), and the exe's own name.
  const common = parts.findIndex((p) => /^common$/i.test(p));
  if (common >= 0 && parts[common + 1]) names.push(parts[common + 1]);
  names.push(path.basename(String(exePath || ''), path.extname(String(exePath || ''))));
  return [...new Set(names)];
}
function lumaModFor(exePath, detected) {
  const catalog = lumacatalog.get();
  const key = `${exePath}|${catalog.tag || ''}|${catalog.mods ? catalog.mods.length : 0}|${storedDetections.mtimeMs}`;
  if (!lumaModCache.has(key)) {
    if (lumaModCache.size > 512) lumaModCache.clear();
    lumaModCache.set(key, lumacatalog.matchGame(lumaNamesFor(exePath), { bitness: (detected && detected.bitness) || 64, catalog }));
  }
  return lumaModCache.get(key);
}
// Luma games are DirectX 11 games as far as everything here is concerned (route.js withApiOverride).
// A watched launch's facts (probe.js) sit between the two: over static detection, under Edit.
function effectiveDetection(dir, exePath, detected) {
  const lumaMod = lumaModFor(exePath, detected);
  const luma = lumaue.lumaUeDeployed(dir) || (!!lumaMod && lumaue.isLumaUeDefault(exePath, lumaMod));
  const observed = probe.applyProbe(detected || {}, probeFactsFor(exePath));
  // The hand-set proxy name rides on the detection the way apiOverride does, because the two
  // consumers are the same: the run digest, which should say a name was chosen rather than picked,
  // and the route payload behind the card. A marker read, so this stays a stat per card.
  return { ...withApiOverride(observed, readApiOverride(dir), { luma }), proxyChoice: readProxyChoice(dir) };
}

// ── Watched launch facts (probe.js) ──────────────────────────────────────────
// One file for every game, keyed by exe; probe.readStore caches it on its mtime, so asking per card
// per render is a stat, not a read. Facts expire by themselves when the exe changes (a game update).
const probeFactsFile = () => path.join(userDataDir(), 'probe-facts.json');
function probeFactsFor(exePath) {
  if (!exePath) return null;
  try { return probe.freshFacts(probeFactsFile(), exePath); } catch { return null; }
}

// ── High performance GPU on hybrid laptops (gpupref.js) ──────────────────────
// One registry read shared by every game a sync pass touches (a reg.exe per game is the kind of
// per-game process spawn that made sync slow before -- see the perf notes on detection).
let gpuPrefsMemo = null;
function sharedGpuPrefs() {
  if (!gpuPrefsMemo || Date.now() - gpuPrefsMemo.at > 10000) {
    gpuPrefsMemo = { at: Date.now(), value: preflight.readGpuPrefs(execFileAsync) };
  }
  return gpuPrefsMemo.value;
}

// The game's exes and, on the 32-bit route, the Feeder's helper, all on the NVIDIA card: a helper on
// the integrated GPU cannot import the game's cross-process fence (Feeder #100). Never fails the caller.
async function preferDiscreteGpu(dir, exePath, { onlyNew = false } = {}) {
  try {
    const gpuInfo = await getGpuInfo();
    if (!preflight.isHybrid(gpuInfo)) return null;
    let target = exePath;
    try { target = launchTarget(exePath); } catch {}
    const facts = probeFactsFor(exePath);
    const r = await gpupref.ensureHighPerformance(dir, [exePath, target, facts && facts.realExe], {
      execFileAsync, gpuInfo, onlyNew, readPrefs: sharedGpuPrefs,
    });
    if (r.set.length) gpuPrefsMemo = null;
    return r;
  } catch {
    return null;
  }
}
async function refreshLumaCatalog() {
  try {
    await lumacatalog.refresh({ cachePath: lumaCatalogFile(), headers: GITHUB_HEADERS });
    lumaModCache.clear();
  } catch {}
}

// The primary API every handler should act on: the user's choice if there is one, else detection.
async function resolveApi(dir, exePath) {
  return effectiveDetection(dir, exePath, await detectFor(dir, exePath)).api;
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

// What the Edit panel needs to draw the proxy row. Asked for when the panel opens, not per card
// render: proxyNameForGame resolves the API and can read the exe's import table, which is too much
// to pay for a list of fifty games.
ipcMain.handle('game:proxyInfo', async (_evt, { exePath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const host32 = !!legacy.status(dir).host32;
    let automatic = null;
    if (!host32) {
      // What the app would pick with no choice set -- read past the choice deliberately, so the row
      // can say "Automatic (winmm.dll)" while a different name is selected.
      try { automatic = await proxyNameForGame(dir, exePath, isFeederGame(dir), { ignoreChoice: true }); } catch {}
    }
    return {
      ok: true,
      names: PROXY_CHOICE_NAMES,
      chosen: readProxyChoice(dir),
      automatic,
      installed: (readInstallMarker(dir) || {}).proxy || null,
      settable: !host32,
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The proxy DLL name for one game, set by hand. Writes the choice, then MOVES the installed
// OptiScaler to it -- migrateProxyIfNeeded does the rename, refuses when the target name is
// somebody else's file, and keeps the install journal straight so Remove still takes back the right
// one. Setting it on a game with nothing installed is fine: the choice is read at install time too.
ipcMain.handle('game:setProxyName', async (_evt, { exePath, proxy }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const name = proxy ? String(proxy).toLowerCase() : null;
    if (name && !PROXY_CHOICE_NAMES.includes(name)) {
      // Refused rather than accepted-and-ignored: a name the folder scan cannot read back would
      // install an OptiScaler the app then reports as missing (#132).
      throw new Error(`${proxy} is not a name this app can install under and read back`);
    }
    const dir = gameDir(exePath);
    // The 32-bit route has no proxy beside the exe at all -- OptiScaler lives in host64\ as
    // winmm.dll, loaded by the helper, and renaming anything here would move a file nothing loads.
    if (legacy.status(dir).host32) {
      throw new Error('this game runs the 32-bit route, where OptiScaler is in host64\\ and there is no proxy beside the exe to name');
    }
    writeProxyChoice(dir, name);
    let migration = null;
    try { migration = await migrateProxyIfNeeded(dir, exePath); } catch (error) { migration = { error: String(error && error.message ? error.message : error) }; }
    const configured = fs.existsSync(path.join(dir, 'OptiScaler.ini')) ? await autoConfigureGame(dir, exePath) : null;
    return { ok: true, proxy: name, migration, applied: configured ? configured.applied : [] };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

function detectInstalledBackends(dir) {
  const has = (name) => fs.existsSync(path.join(dir, name));
  // A 32-bit game's OptiScaler is in host64\ (legacy.js).
  const legacyMarker = legacy.readMarker(dir);
  const optiscaler = (has('OptiScaler.ini') && has('nvngx_dlssnr.dll')) ||
    !!(legacyMarker && legacyMarker.host32 && legacy.status(dir).hostOptiScaler);
  // Anything else of ours still in the folder once OptiScaler itself is gone -- so the card can
  // still offer Remove and take the folder the rest of the way back.
  // Only what an INSTALL leaves behind. The preference markers (.dlss5ui-api.json,
  // .dlss5ui-lossless.json, .dlss5ui-framegen.json, .dlss5ui-optifg-enabled) are deliberately not here: each can be set
  // on a game before anything is installed -- choosing DX12 for Where Winds Meet in Edit wrote
  // .dlss5ui-api.json, this list then called it a leftover, and the card's Install button turned
  // into a red "Remove leftovers" that deleted the choice. Remove (the full uninstall) still
  // clears them via APP_MARKERS.
  const leftovers = [
    'OptiScaler.ini', 'OptiScaler.dll', 'OptiScaler_OpticalFlow.dll', 'nvngx_dlssnr.dll', 'nvngx.dll_dlssnr.dll', 'OptiScaler',
    'dlss5-feed.addon64', ...lumaue.lumaAddonsIn(dir), 'Luma',
    '.dlss5ui-feeder-deploy.json', '.dlss5ui-lumaue-deploy.json', '.optiscaler-manager-install.json',
    legacy.MARKER, 'dlss5-feed.addon32',
  ].filter(has);
  // What older versions placed and never journaled (Stellar Blade, 2026-09-12: OptiScaler_DlssNr.*
  // build files and the Feeder-era scripts survived a Remove on an old build, and with OptiScaler
  // itself gone the card offered no way back) -- same names the full Remove clears.
  try {
    for (const n of fs.readdirSync(dir)) {
      if (LEGACY_PAYLOAD.includes(n) || LEGACY_PATTERNS.some((p) => p.test(n))) leftovers.push(n);
    }
  } catch {}
  // A Feeder game switched to Deep Fried Chicken (dfc.js) has no OptiScaler on purpose, and is still
  // an install of this app's: the card's "installed" state, Remove and the filters read `optiscaler`
  // as exactly that. `dfc` says which, for what only makes sense with OptiScaler (Verify reads its log).
  const dfcHere = dfc.dfcOurs(dir);
  return { optiscaler: optiscaler || dfcHere, dfc: dfcHere, leftovers };
}

// The DLSS 5 settings for one game, read from and written to the ini OptiScaler really loads.
// The in-game panel is the other way in; on the 32-bit route it is behind the Feeder's add-on and
// a user with a working install had no way to change anything at all (2026-09-14).
ipcMain.handle('dlssnr:get', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Game .exe not found' };
    const dir = gameDir(exePath);
    const optiDir = optiScalerDirFor(dir);
    const iniPath = path.join(optiDir, 'OptiScaler.ini');
    if (!fs.existsSync(iniPath)) return { ok: false, error: 'not-installed' };
    const inHelper = path.resolve(optiDir) !== path.resolve(dir);
    // Settings this app holds to a value, with the reason. Offering a slider the next sync quietly
    // puts back is worse than not offering it: the Feeder's synthetic frame has no pre-upscale
    // colour for Pre-SR to run on, and on Armored Core VI turning it on faulted the model every run.
    const forced = isFeederGame(dir)
      ? {
        RunBeforeSR: 'Held off on a Feeder game: there is no real pre-upscale frame for the pass to run on, and on Armored Core VI switching it on faulted the model on every run.',
        RunBeforeRR: 'Held off on a Feeder game: there is no real pre-upscale frame for the pass to run on, and on Armored Core VI switching it on faulted the model on every run.',
      }
      : {};
    // The borderless window is made by OptiScaler intercepting the game's own DXGI swapchain, so it
    // only exists where OptiScaler is inside the game's process and the game draws through DXGI.
    // On the 32-bit route OptiScaler is in the helper: the flag would restyle the helper's window --
    // the very one the Feeder casts into the game -- and leave the game exactly as it was. On OpenGL
    // and Vulkan there is no DXGI swapchain to intercept at all.
    let borderlessReason = null;
    if (inHelper) {
      borderlessReason = 'Not available on the 32-bit route: OptiScaler runs in the 64-bit helper beside the game, so it has no hold on the game\'s own window. Set Borderless or Windowed in the game\'s display settings.';
    } else {
      let api = null;
      try { api = await resolveApi(dir, exePath); } catch { /* unknown api: offer the switch */ }
      // One string for both, not a template: the renderer translates the reason by exact text.
      if (api === 'opengl' || api === 'vulkan') {
        borderlessReason = 'Not available on OpenGL or Vulkan: the borderless window is made by intercepting the game\'s DirectX swapchain, and this game has none. Set Borderless or Windowed in the game\'s display settings.';
      }
    }
    // The window size rides on the switch, so it is held off wherever the switch is.
    if (borderlessReason) {
      forced.ForceBorderless = borderlessReason;
      forced.BorderlessWidth = borderlessReason;
      forced.BorderlessHeight = borderlessReason;
    }
    // The pages travel with the fields: the pop-out panel draws the in-game panel's own six pages,
    // and PAGES is where that layout is written (src/dlssnr.js).
    return { ok: true, inHelper, iniPath, forced, pages: dlssnr.PAGES, headerKeys: dlssnr.HEADER_KEYS,
             fields: dlssnr.readSettings(iniPath) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('dlssnr:set', (_evt, { exePath, values } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Game .exe not found' };
    const dir = gameDir(exePath);
    const iniPath = path.join(optiScalerDirFor(dir), 'OptiScaler.ini');
    const res = dlssnr.writeSettings(iniPath, values || {});
    if (!res.ok) return res;
    // A game installed before autoConfigureGame wrote LiveReload everywhere has it off, and the
    // engine only reads the switch at launch -- so this write cannot reach the game running now, but
    // it makes every later one (pop-out or Edit) land from the next launch without a reinstall.
    ensureLiveReload(dir);
    return { ok: true, written: res.written, fields: dlssnr.readSettings(iniPath) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The break-away DLSS 5 panel. Same settings as the Edit dialog's DLSS 5 tab and the in-game panel,
// in a small always-on-top window of this app's own, opened by a global hotkey. It exists because
// the in-game panel depends on the game cooperating: some games swallow Alt+Home, and a 32-bit game
// only ever shows a mirror of the 64-bit helper's panel. This one needs nothing from the game.
// See src/panelwindow.js for why it cannot beat exclusive fullscreen.
function panelEnabled(settings) {
  // On by default: a hotkey the user never has to find is the whole point, and the window itself
  // costs nothing until it is first opened.
  return !settings || settings.panelEnabled === undefined || !!settings.panelEnabled;
}

function panelHotkeySignature(settings) {
  return panelEnabled(settings) ? panelwindow.accelerator(settings) : '';
}

let panelHotkeyState = { ok: false, accelerator: panelwindow.DEFAULT_ACCELERATOR };

function panelOptions() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    page: path.join(__dirname, 'renderer', 'panel.html'),
    savedBounds: readJson(settingsFile(), {}).panelBounds,
    // Written back on move and resize so the panel returns where it was left. Re-read here rather
    // than closed over, because the renderer saves settings.json too and would otherwise be undone.
    onBoundsChanged: (bounds) => {
      try {
        const current = readJson(settingsFile(), {});
        current.panelBounds = bounds;
        writeJson(settingsFile(), current);
      } catch {
        // Losing the remembered position is not worth an error dialog over a game.
      }
    },
  };
}

// The pop-out's key: Insert unless the player bound another in Settings.
//
// On Insert -- the in-game panel's key too -- which panel it opens follows the running game
// (panelroute.js), and the pop-out only takes the key while a game that needs it runs: a hotkey Windows
// has registered never reaches the game, so holding Insert all the time would break the in-game panel
// everywhere else, and Insert in every other program besides. On any other key there is nothing to
// share, so it is held the whole time the app runs, as the pop-out's hotkey always was.
//
// Its own poll rather than the renderer's games:running: that one stops when this window loses focus,
// which is exactly when a game is in front. One tasklist every few seconds, shared by all games.
const PANEL_ROUTE_POLL_MS = 3000;
let panelRouteTimer = null;
let panelRouteBusy = false;

function panelModeForGame(exePath) {
  const dir = gameDir(exePath);
  if (dfc.dfcPresent(dir)) return panelroute.panelModeFor({ chicken: true });
  const host32 = optiScalerDirFor(dir) !== dir;
  let overlayOff = false;
  try { overlayOff = panelroute.overlayMenuOff(fs.readFileSync(path.join(optiScalerDirFor(dir), 'OptiScaler.ini'), 'utf8')); } catch {}
  const detected = detectGameCached(exePath) || {};
  return panelroute.panelModeFor({
    host32,
    api: effectiveDetection(dir, exePath, detected).api,
    overlayMenuOff: overlayOff,
    fullscreenOnly: host32 && feeder.needsInGameCast(dir),
    engineHasPanel: engines.engine((engines.readEngineMarker(dir) || {}).engine).panel !== false,
  });
}

// Whether the pop-out's key is the one the in-game panel uses, so the two have to take turns.
function sharesInGameKey(settings) {
  return panelwindow.accelerator(settings).toLowerCase() === panelwindow.DEFAULT_ACCELERATOR.toLowerCase();
}

async function routePanelKey() {
  if (panelRouteBusy) return;
  panelRouteBusy = true;
  try {
    const settings = readJson(settingsFile(), {});
    if (!panelEnabled(settings) || !sharesInGameKey(settings)) return;
    const running = await runningImageSet();
    let game = null;
    for (const g of readJson(gamesFile(), [])) {
      try {
        if (g && g.exePath && running.has(path.basename(launchTarget(g.exePath)).toLowerCase())) { game = g; break; }
      } catch {}
    }
    const mode = game ? panelModeForGame(game.exePath) : null;
    if (mode === panelroute.MODES.POPOUT) {
      const reg = panelwindow.registerHotkey(settings, () => panelwindow.toggle(panelOptions()));
      panelHotkeyState = { ...reg, smart: true, mode, game: game.name || path.basename(game.exePath) };
    } else {
      panelwindow.unregisterHotkey();
      panelHotkeyState = { ok: true, smart: true, accelerator: panelwindow.accelerator(settings), mode, game: game ? (game.name || path.basename(game.exePath)) : null };
    }
  } catch {
    // A failed process listing leaves the key as it was; the next poll tries again.
  } finally {
    panelRouteBusy = false;
  }
}

function applyPanelHotkey(settings = readJson(settingsFile(), {})) {
  if (!panelEnabled(settings)) {
    if (panelRouteTimer) clearInterval(panelRouteTimer);
    panelRouteTimer = null;
    panelwindow.unregisterHotkey();
    panelwindow.hide();
    panelHotkeyState = { ok: false, accelerator: panelwindow.accelerator(settings), disabled: true };
    return panelHotkeyState;
  }
  if (!sharesInGameKey(settings)) {
    // A key of the player's own: held all the time, and the router has nothing to do.
    if (panelRouteTimer) clearInterval(panelRouteTimer);
    panelRouteTimer = null;
    panelHotkeyState = panelwindow.registerHotkey(settings, () => panelwindow.toggle(panelOptions()));
    return panelHotkeyState;
  }
  // Insert: let go of whatever key was held before, then the router takes and releases Insert by game.
  panelwindow.unregisterHotkey();
  panelHotkeyState = { ok: true, smart: true, accelerator: panelwindow.accelerator(settings), mode: null, game: null };
  if (!panelRouteTimer) panelRouteTimer = setInterval(() => { routePanelKey(); }, PANEL_ROUTE_POLL_MS);
  routePanelKey();
  return panelHotkeyState;
}

ipcMain.handle('panel:hotkeyState', () => panelHotkeyState);

ipcMain.handle('panel:close', () => {
  panelwindow.hide();
  return true;
});

// "Reset layout", at the foot of the panel's Main page. The remembered bounds go as well as the
// window's current ones, or the next open would put it straight back where it was.
ipcMain.handle('panel:reset-layout', () => {
  try {
    const current = readJson(settingsFile(), {});
    delete current.panelBounds;
    writeJson(settingsFile(), current);
  } catch {
    // The window still moves; only the memory of where it was is lost, which is the point.
  }
  return { ok: panelwindow.resetBounds() };
});

// Settings' "Open it now": the same thing the hotkey does, for a user checking it works before
// there is a game in front of it, or one whose key combination another application has taken.
ipcMain.handle('panel:open', () => {
  panelwindow.show(panelOptions());
  return true;
});

// One tasklist call for the whole list, the same way games:running does it: the panel opens on the
// running game, so it has to know which that is before it can show anything.
ipcMain.handle('panel:targets', async () => {
  const games = readJson(gamesFile(), []);
  let running = new Set();
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/NH', '/FO', 'CSV'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^"([^"]+)"/.exec(line.trim());
      if (m) running.add(m[1].toLowerCase());
    }
  } catch {
    // No process list means nothing is known to be running, which is still a usable panel.
    running = new Set();
  }

  const out = [];
  for (const game of games) {
    if (!game || !game.exePath) continue;
    let isRunning = false;
    let installed = false;
    try {
      isRunning = running.has(path.basename(launchTarget(game.exePath)).toLowerCase());
      installed = fs.existsSync(path.join(optiScalerDirFor(gameDir(game.exePath)), 'OptiScaler.ini'));
    } catch {
      // A game whose exe has gone still belongs in the list; it just has nothing to edit.
    }
    out.push({ name: game.name || path.basename(game.exePath), exePath: game.exePath, detectedPath: game.detectedPath || null, running: isRunning, installed });
  }
  return { ok: true, games: out };
});

// What the neural pass costs, for the break-away panel. The engine's in-game panel shows this as
// "Running - N ms per frame" and the panel that stands in for it had no equivalent, which on the
// routes where the in-game one cannot draw at all (OpenGL, and the 32-bit helper) left no way to
// see it. Read from OptiScaler.log rather than asked of the engine: it is already written there
// every 600 frames, and this needs no engine release to reach installs that already exist.
// What is feeding motion to the model, for the pop-out panel's Guide section -- the same row the
// in-game panel shows, from the other side of the glass.
//
// The two sides know different things and neither is complete. The engine knows the truth --
// whether vectors actually reached the model this frame -- and shows it in-game. Out here the
// manager cannot see into the process, but it CAN see what the in-game panel cannot: which
// provider is configured, whether its shader is even in the folder, and whether the preset and the
// compiled-for value agree. Those three are exactly the faults that produce "no vectors", and they
// are checkable without the game running at all.
//
// So this row does not guess at live state. It reports the configuration and names the fault when
// the configuration is broken, which is a claim it can actually support.
ipcMain.handle('panel:motion', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false };
    const dir = gameDir(exePath);
    const status = feeder.feederProviderStatus(dir);
    const route = feeder.readFeederDeployMarker(dir) ? 'feeder' : null;

    // Why it cannot work, in the order someone would check. Each is provable from the files.
    let fault = null;
    if (status.id && status.broken) fault = 'broken';
    else if (status.id && !status.bringYourOwn && !status.shaderPresent) fault = 'shader-missing';
    else if (status.id && status.bringYourOwn && !status.shaderPresent) fault = 'byo-missing';
    else if (status.valueMismatch) fault = 'value-mismatch';
    else if (status.techniqueMismatch) fault = 'technique-mismatch';

    return {
      ok: true, route, fault,
      id: status.id,
      displayName: status.displayName,
      unsupportedReason: status.unsupportedReason,
      enabledTechnique: status.enabledTechnique,
      definedValue: status.definedValue,
      expectedValue: status.expectedValue,
      // So the panel can offer the swap rather than only naming the problem.
      providers: feeder.mvProviderList().filter((p) => p.selectable !== false)
        .map((p) => ({ id: p.id, displayName: p.displayName, license: p.license, recommended: !!p.recommended })),
    };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('panel:timing', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, reason: 'no-log' };
  try {
    const dir = gameDir(exePath);
    return await runlog.nrTiming(optiScalerDirFor(dir));
  } catch {
    return { ok: false, reason: 'no-log' };
  }
});

// Live numbers for the break-away panel: fps, frame time, VRAM, whether DLSS 5 is running, Adaptive
// resolution's state and frame generation's -- what the in-game panel shows from inside the process.
// The engine (feat/panel-live-stats, DlssNr_Live.cpp) writes OptiScaler.live.json beside
// OptiScaler.ini about twice a second, but only while OptiScaler.live.request there is younger than
// 10 s, so a game nobody is watching gets no disk traffic at all. This keeps the request fresh while
// the panel asks and reads the answer back. An engine without the writer never answers, and the panel
// falls back to the log timing above.
const LIVE_REQUEST = 'OptiScaler.live.request';
const LIVE_FILE = 'OptiScaler.live.json';
const LIVE_TOUCH_MS = 2000;
// Older than this and the numbers are not what is on screen now: the game stopped, or the writer did.
const LIVE_STALE_MS = 3000;
const liveTouched = new Map();

function liveDirFor(exePath) {
  return optiScalerDirFor(gameDir(exePath));
}

ipcMain.handle('panel:live', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { ok: false, reason: 'no-game' };
  const dir = liveDirFor(exePath);
  if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return { ok: false, reason: 'not-installed' };
  const now = Date.now();
  const last = liveTouched.get(dir) || 0;
  if (now - last >= LIVE_TOUCH_MS) {
    try {
      const req = path.join(dir, LIVE_REQUEST);
      if (fs.existsSync(req)) fs.utimesSync(req, new Date(now), new Date(now));
      else fs.writeFileSync(req, 'OptiDLSS5-UI pop-out panel\n');
      liveTouched.set(dir, now);
    } catch {
      return { ok: false, reason: 'request-failed' };
    }
  }
  let live;
  try { live = JSON.parse(fs.readFileSync(path.join(dir, LIVE_FILE), 'utf8')); } catch { return { ok: false, reason: 'no-answer' }; }
  if (!live || live.v !== 1 || typeof live.at !== 'number') return { ok: false, reason: 'unknown-format' };
  if (now - live.at > LIVE_STALE_MS) return { ok: false, reason: 'stale', at: live.at };
  return { ok: true, live };
});

// The panel moved to another game, was hidden, or the app is quitting: stop asking, so the engine
// stops writing. It would stop on its own 10 s later; this makes it immediate and leaves no file behind.
function stopLive(dir) {
  liveTouched.delete(dir);
  try { fs.rmSync(path.join(dir, LIVE_REQUEST), { force: true }); } catch {}
}

ipcMain.handle('panel:live-stop', async (_evt, exePath) => {
  if (exePath && fs.existsSync(exePath)) stopLive(liveDirFor(exePath));
  else for (const dir of [...liveTouched.keys()]) stopLive(dir);
  return { ok: true };
});

app.on('will-quit', () => { for (const dir of [...liveTouched.keys()]) stopLive(dir); });

// The store a game came from (library.storeFor), for the grid's filter. A game does not move between
// stores, so it is worked out once per exe per session: the grid asks for every card on every render.
const storeCache = new Map();
function storeOf(exePath) {
  const key = String(exePath).toLowerCase();
  if (!storeCache.has(key)) {
    let store = 'other';
    try { store = library.storeFor(exePath); } catch {}
    storeCache.set(key, store);
  }
  return storeCache.get(key);
}

ipcMain.handle('game:status', async (_evt, exePath) => {
  if (!exePath || !fs.existsSync(exePath)) return { exeMissing: true };
  const dir = gameDir(exePath);
  const hasIni = fs.existsSync(path.join(dir, 'OptiScaler.ini'));
  // Beside the exe, or where Game Help's model-only route put it (the game's own Streamline folder).
  const hasNr = nrmodelonly.nrModelPresent(dir);
  const hasUninstaller = fs.existsSync(path.join(dir, 'Remove_OptiScaler.bat')) ||
    fs.existsSync(path.join(dir, 'uninstall_optiscaler.bat')) ||
    fs.existsSync(path.join(dir, 'uninstaller.bat'));
  const backends = detectInstalledBackends(dir);
  // Cheap marker checks on every card render: another DLSS 5 toolchain in the folder is the
  // one thing that makes an otherwise correct install crash, so it is said on the card itself.
  const foreign = foreignToolchains(dir);
  // Deep Fried Chicken copied in by hand is the other neural pass this app can run, not a rival stack:
  // the card says how to switch to it (the switch takes it over, dfc.js) rather than warning of a crash.
  // Only where that is the answer: on NVIDIA (the only place the switch is offered), and with no
  // OptiScaler of ours beside it -- both in one folder is the two-neural-passes clash, and the crash
  // warning is right there. A Chicken this app runs does not flag its own installer's leftovers.
  const gpuVendor = ((await getGpuInfo()) || {}).vendor;
  const chickenIsChoice = gpuVendor === 'nvidia' && !(backends.optiscaler && !backends.dfc);
  const shown = backends.dfc ? foreign.filter((f) => f.tool !== 'Deep Fried Chicken') : foreign;
  const warnings = shown.map((f) => (f.tool === 'Deep Fried Chicken' && chickenIsChoice
    ? {
      message: 'Deep Fried Chicken was copied into this folder by hand ({files}). Switch this game to Chicken from its ⋯ menu and the app takes it over, or delete those files to stay on DLSS 5.',
      vars: { files: f.files.join(', ') },
    }
    : {
      message: 'Another DLSS 5 toolchain is installed here ({tool}: {files}) -- two stacks hooking the same DLSS call crash the game. Remove it with its own uninstaller before using this one.',
      vars: { tool: f.tool, files: f.files.join(', ') },
    }));
  const marker = engines.readEngineMarker(dir);
  const engine = marker && marker.engine ? engines.normalizeEngine(marker.engine) : null;
  return { exeMissing: false, hasIni, hasNr, hasUninstaller, dir, backends, foreign, warnings, engine, store: storeOf(exePath) };
});

// The one-line answer the card tags and the Install button acts on -- see route.js. `detected`
// is the cached detection the renderer already holds for this game, so this never rescans the exe.
ipcMain.handle('game:route', async (_evt, { exePath, detected }) => {
  if (!exePath || !fs.existsSync(exePath)) {
    return { route: 'unknown', label: 'Exe missing', reason: 'Game .exe not found', steps: [], complete: false, nextStep: null };
  }
  const { vendor } = await getGpuInfo();
  const dir = gameDir(exePath);
  const effective = effectiveDetection(dir, exePath, detected || {});
  const route = recommendRoute(dir, exePath, effective, vendor, { lumaMod: lumaModFor(exePath, effective) });
  // Kept for game:lastRun, which analyses the same game's run moments later on the same card render
  // and has no route of its own (see lastRouteByExe).
  lastRouteByExe.set(String(exePath).toLowerCase(), { route, api: effective.api || null });
  return {
    ...route,
    apiOverride: effective.apiOverride,
    // A choice Edit cannot honour, and why (route.js withApiOverride): an emulator has no renderer
    // of that name, so the choice was refused rather than installed.
    apiOverrideRefused: effective.apiOverrideRefused || null,
    // The renderers this game can actually be set to. An emulator's are a closed list; every other
    // game's is empty, meaning "no restriction" -- detection can be wrong about a normal game, which
    // is what the override is for.
    apiChoices: effective.emulator ? (emulators.profileOf(effective.emulator) || {}).apis || [] : [],
    effectiveApi: effective.api || null,
    detectedApi: (detected && detected.api) || null,
    detectedApis: (detected && detected.apis) || [],
    // The card's "Motion vectors: <provider> -- change…" entry on an installed 32-bit route game.
    legacyMv: legacyMvSummary(dir),
    // Whether a proxy name is set by hand, for the card's badge. Just the marker read -- what the
    // AUTOMATIC answer would be costs a detection and can read the exe's import table, so the Edit
    // panel asks for that once through game:proxyInfo rather than paying it on every card render.
    proxyChoice: readProxyChoice(dir),
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
  return { ok: true, ...status, nrDllVersion, ...amdnr.amdNrEligibility(vendor, (await resolveApi(dir, exePath)) || api || null) };
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

ipcMain.handle('game:install', async (_evt, { exePath, releaseFolder, nrDllPath, proxyName, engine }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    // The 64-bit OptiScaler cannot load into a 32-bit game; those take legacy:installHost32.
    if ((await peBitness(exePath)) === 32) throw new Error('This is a 32-bit game: OptiScaler goes into the Feeder\'s 64-bit helper (the experimental 32-bit route), not beside the game');
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
      const pre = await ensureREFrameworkForGame(dir, exePath);
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
    // Which build went in, so autoConfigureGame can set (or clear) the Pre-SR keys and the card
    // can say which engine this game runs. Pre-SR preferences already in the marker survive.
    if (engine) {
      engines.writeEngineMarker(dir, { ...engines.markerForInstall(engines.readEngineMarker(dir), engine), updatedAt: new Date().toISOString() });
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

    // Refresh the proxy to this release's build -- but only a proxy this app created.
    //
    // It used to refresh whichever proxy-named OptiScaler it found, which is destructive in the one
    // case that matters: another tool's build, silently overwritten, inside a catch that threw the
    // failure away. Now it touches only what the journal says is ours, and an adopted proxy we
    // cannot account for is reported to the caller instead (foreignProxy), for the UI to raise.
    let proxyUpdated = null;
    let proxyRefreshError = null;
    let foreignProxy = null;
    let proxyIsThisBuild = false;
    try { await migrateProxyIfNeeded(dir, exePath); } catch {}
    try {
      const active = await findActiveOptiScalerFile(dir);
      if (active && active.renamed) {
        // Byte-identical to the build being installed means it *is* this build, whatever the
        // journal does or does not say -- installs from before the journal recorded a proxy name
        // land here, and they are not somebody else's. Nothing is written and nobody is accused.
        const same = sha256File(path.join(releaseFolder, 'OptiScaler.dll')) === sha256File(active.file);
        if (same) {
          proxyIsThisBuild = true;
        } else if (proxyIsOurs(dir, active.file)) {
          await fsp.copyFile(path.join(releaseFolder, 'OptiScaler.dll'), active.file);
          proxyUpdated = path.basename(active.file);
        } else {
          foreignProxy = path.basename(active.file);
        }
      }
    } catch (err) {
      // Said out loud rather than swallowed: a proxy that could not be refreshed is a game still
      // running the previous build, which is worth knowing when something behaves like an old bug.
      proxyRefreshError = String(err && err.message ? err.message : err);
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
    // Frame pacing added before DLSS 5 put ReShade in the proxy slot itself (relimiter.js,
    // promoteToStandalone). Two proxies is exactly the Arkham Knight failure above, so it cannot stay.
    // It goes back to ReShade64.dll, where OptiScaler loads it. Whether it may STAY beside OptiScaler's
    // upscaler is only known once this install is done (the engine it leaves, the frame generation it
    // configures), so that is decided below, after autoConfigureGame.
    let pacingRemoved = null;
    try {
      if (relimiter.status(dir).standalone) relimiter.demoteStandaloneReShade(dir);
    } catch {}
    try {
      proxy = await installProxy(dir, proxyName || (await proxyNameForGame(dir, exePath, feederGame)));
    } catch (err) {
      // Not fatal: everything else is in place, and Run Setup is still there to do it by hand.
      proxyError = err.message;
    }
    // installProxy sees the same slot from the other side; either witness is enough to report it,
    // except when the bytes already said it is this very build (a pre-journal install of ours).
    if (proxy && proxy.adopted && proxy.ours === false && !foreignProxy && !proxyIsThisBuild) {
      foreignProxy = proxy.proxy;
    }

    // Not fatal: OptiScaler still loads without it, and Game Help names the missing file after a run.
    let nvngxDlss = null;
    try {
      nvngxDlss = await placeNvngxDlssBesideExe(dir);
    } catch (err) {
      nvngxDlss = { placed: false, error: String(err && err.message ? err.message : err) };
    }

    // Pacing kept beside the upscaler only where pacingBesideUpscalerBlocker allows it: a crash, or
    // pacing that silently sees no frames, is worse than none. Reported, not silent.
    try { pacingRemoved = await dropBlockedPacing(dir, feederGame); } catch {}

    invalidateDetection(dir);
    const { api, applied, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix, profile } = await autoConfigureGame(dir, exePath);

    const gpuPreference = await preferDiscreteGpu(dir, exePath);
    return { ok: true, dir, nrDllBytes: destStat.size, proxyUpdated, proxyRefreshError, foreignProxy, proxy, proxyError, feederGame, api, autoConfigured: applied, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix, profile, nvngxDlss, gpuPreference, pacingRemoved };
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
  const r = await saferemove.removePath(file);
  if (!r.ok) { const e = new Error(`nvngx_dlssnr.dll could not be deleted (${r.code})`); e.code = r.code; throw e; }
  return true;
}

// Strips a game folder back to what it was before this app touched it: every stack it can
// deploy (Feeder, Luma UE, the FrameGen DLL swap, Streamline, REFramework), the OptiScaler
// payload and proxy, everything the install journal recorded as added, everything it recorded
// as replaced (put back from its backup), and every marker. A folder installed before the
// journal existed still gets the fixed payload list. Nothing here guesses at a file it did not
// place -- unknown files stay, and the report says so where a decision was made.
const RELEASE_LICENSE_FILES = ['DirectX_LICENSE.txt', 'FidelityFX_v2_LICENSE.md', 'FidelityFX_OpticalFlow_LICENSE.txt', 'RenoDX_ATTRIBUTION.txt', 'DXL_ATTRIBUTION.txt', 'XeSS_LICENSE.txt'];

// A game working the way its user wants, pinned so a new engine or model reaching every other game on
// sync does not reach this one (asked for Resident Evil Requiem, 2026-09-14, when the engine gained the
// Present route). Presence of the file is the whole setting.
const KEEP_AS_IS_MARKER = '.dlss5ui-keep-as-is';
function keptAsIs(dir) {
  return fs.existsSync(path.join(dir, KEEP_AS_IS_MARKER));
}

const APP_MARKERS = ['.dlss5ui-lossless.json', '.dlss5ui-framegen.json', '.dlss5ui-api.json', PROXY_CHOICE_MARKER, '.dlss5ui-optifg-enabled', '.optiscaler-manager-install.json', reengine.REFRAMEWORK_BUILD_MARKER, engines.ENGINE_MARKER, KEEP_AS_IS_MARKER, translation.PREFERENCE];
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
  const failed = [];
  const journal = readInstallMarker(dir) || {};
  // Every deletion here goes through saferemove: a file Windows will not unlink -- read-only, still
  // mapped into a running process, in a folder the user cannot delete from -- is recorded and the
  // strip carries on. It used to throw out of this function on the first one, which left the folder
  // half-stripped and told the user only the raw errno (GTA San Andreas, #96).
  const rmRel = async (rel) => {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) return false;
    const r = await saferemove.removePath(p);
    if (!r.ok) { failed.push({ rel, code: r.code }); return false; }
    removed.push(rel);
    return true;
  };
  const rmdirIfEmpty = (rel) => {
    try { if (fs.readdirSync(path.join(dir, rel)).length === 0) { fs.rmdirSync(path.join(dir, rel)); removed.push(rel); } } catch {}
  };
  // A stage that throws is one stage lost, not the whole removal. Each of them deletes a different
  // stack, so the ones after it are still worth running.
  const stage = async (what, fn) => {
    try { return await fn(); } catch (err) { failed.push({ rel: what, code: (err && err.code) || 'failed' }); return null; }
  };

  // Frame pacing first: the Feeder's removal below takes ReShade64.dll, and an add-on left behind with
  // no ReShade to load it is a file that does nothing and a marker that claims otherwise.
  if (relimiter.marker(dir) || relimiter.deployed(dir)) {
    const r = await stage('frame pacing', () => relimiter.remove(dir));
    if (r) removed.push(...r);
  }
  // The add-ons picker's installs (RenoDX, the shader packs) for the same reason, and from their own
  // marker: every file in it is one this app placed. Left behind, a RenoDX .addon64 sat in a folder
  // with no ReShade and the picker still read "Remove".
  for (const id of addons.installedIds(dir)) {
    const r = await stage(`the ${id} add-on`, () => addons.removeAddon(dir, id));
    if (r) removed.push(...r.removed, ...(addons.installedIds(dir).length ? [] : [addons.ADDONS_MARKER]));
  }
  if (feeder.feederDeployed(dir)) {
    const r = await stage('the Feeder stack', () => feeder.removeFeederStack(dir, { keepReShade: false }));
    if (r) { removed.push(...r.removed); kept.push(...r.kept); }
  }
  // The translation layer this app put in front of the game (translation.js), before the legacy
  // marker goes: DXVK's d3d9.dll and .dlss5ui-translation.json used to survive Remove altogether,
  // because nothing here called translation.js (review of the 2.2.3 swap, 2026-09-18). Only a layer
  // the manifest says is ours -- a DXVK the player installed by hand is theirs to keep. A dgVoodoo2
  // purge rewrites the legacy marker without its own entries rather than deleting it, so
  // removeLegacy below still finds host64\ and the ReShade proxy. The ReShade Vulkan layer's app
  // list loses this exe if the DXVK swap put it there; the layer itself stays (machine-wide).
  {
    const vkApp = legacy.vulkanLayerRecord(dir);
    const tl = translation.activeLayer(dir);
    if (tl.ours) {
      const r = await stage(`the ${tl.layer} translation layer`, () => translation.purgeTranslationLayer(dir, { layer: tl.layer }));
      if (r) {
        removed.push(...r.removed); restored.push(...r.restored);
        // .dlss5ui-translation.json among them means the app still thinks this layer is deployed,
        // so the user has to know: Install would otherwise put it back over whatever replaced it.
        for (const f of r.failed || []) failed.push({ rel: f.file, code: f.code });
      }
    }
    if (vkApp && vkApp.listedByUs) {
      const r = await legacy.unlistVulkanLayerApp(vkApp, {
        runElevatedPowerShell: (command) => elevate.runElevatedPowerShell(command, { execFileAsync }),
      });
      if (!r.ok) kept.push(`${path.basename(vkApp.exe)} on ReShade's Vulkan app list (${r.error}) -- the layer ignores it once this folder has no ReShade.ini`);
    }
  }
  // The High performance GPU choice this app made for the game's exes and the helper, put back to what
  // it was (gpupref.js) -- while the marker that says what that was still exists.
  try {
    const r = await gpupref.restore(dir, { execFileAsync });
    if (r.restored.length) restored.push(...r.restored.map((e) => `graphics preference of ${path.basename(e)}`));
  } catch {}
  // The experimental legacy routes: dgVoodoo2, the 32-bit Feeder and its host64\ helper.
  if (legacy.readMarker(dir)) {
    const r = await stage('dgVoodoo2 and the 32-bit helper', () => legacy.removeLegacy(dir));
    if (r) { removed.push(...r.removed); restored.push(...r.restored); }
  }
  if (lumaue.lumaUeDeployed(dir)) {
    const r = await stage('the Luma UE stack', () => lumaue.removeLumaStack(dir));
    if (r) { removed.push(...r.removed); kept.push(...r.kept); }
  }
  // Deep Fried Chicken, when it is this game's chosen neural consumer and WE deployed it (dfc.js).
  // One the user installed with its own .cmd has no marker: removeDfc leaves it and says so, which
  // is right -- its own uninstaller is the thing that knows how to take it out.
  if (dfc.dfcPresent(dir) || dfc.readMarker(dir)) {
    const r = await stage('Deep Fried Chicken', () => dfc.removeDfc(dir, { ...dfcRemoveOptions(), uninstall: true }));
    if (r) {
      removed.push(...r.removed); kept.push(...r.kept);
      for (const f of r.failed || []) failed.push(f);
    }
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
  // PureDark's plugin only when it is still the copy this app placed; one the user swapped in stays.
  if (journal.pdPlugin) {
    if (pdplugin.isOurCopy(dir, journal.pdPlugin)) await rmRel(pdplugin.PLUGIN_NAME);
    else if (fs.existsSync(path.join(dir, pdplugin.PLUGIN_NAME))) kept.push(`${pdplugin.PLUGIN_NAME} (not the copy this app placed)`);
  }
  // RTXMFG, the same way: only the copy this app placed (rtxmfg.js).
  if (rtxmfg.readMarker(dir)) {
    const r = await stage('the RTXMFG files', () => rtxmfg.remove(dir));
    if (r) { removed.push(...r.removed); kept.push(...r.kept); }
  }

  const core = await uninstallOptiScaler(dir);
  removed.push(...core.removed); kept.push(...core.kept); failed.push(...core.failed);
  if (core.nrDllRemoved && !removed.includes('nvngx_dlssnr.dll')) removed.push('nvngx_dlssnr.dll');
  // Game Help's model-only route (nrmodelonly.js): its copy of the model, wherever it put it, and the
  // model it displaced put back. After uninstallOptiScaler, which deletes the one beside the exe.
  {
    const r = await stage('the model-only route\x27s files', () => nrmodelonly.removeNrModelOnly(dir));
    if (r) {
      for (const rel of r.removed) if (!removed.includes(rel)) removed.push(rel);
      restored.push(...r.restored);
    }
  }

  for (const rel of journal.added || []) await rmRel(rel);
  // Putting an original back means deleting ours first. If that delete fails, the backup STAYS a
  // backup -- renaming over a file that is still there would either fail or, worse, lose the
  // original. The user is told which file to deal with, and the .orig is still sitting beside it.
  const restoreFromBackup = async (rel, backupName) => {
    const target = path.join(dir, rel);
    if (fs.existsSync(target)) {
      const r = await saferemove.removePath(target);
      if (!r.ok) {
        failed.push({ rel, code: r.code });
        kept.push(`${backupName} (the original -- ${rel} could not be deleted, so it was left as the backup)`);
        return false;
      }
    }
    await fsp.rename(path.join(dir, backupName), target);
    if (!restored.includes(rel)) restored.push(rel);
    return true;
  };
  for (const r of journal.replaced || []) {
    if (!fs.existsSync(path.join(dir, r.backup))) continue;
    await restoreFromBackup(r.rel, r.backup);
  }
  // Any backup the journal lost track of (an older marker, a hand-edited one): the suffix alone
  // says what it is and where it goes back.
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(ORIG_BACKUP_SUFFIX)) continue;
    await restoreFromBackup(name.slice(0, -ORIG_BACKUP_SUFFIX.length), name);
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

  // A file that could not be deleted is never also reported as removed: the marker for this install
  // may be one of them, so the folder is still partly ours and the next Remove has to find it again.
  const failedRels = new Set(failed.map((f) => f.rel));
  return { removed: [...new Set(removed)].filter((r) => !failedRels.has(r)), restored, kept, failed };
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
  {
    const tl = translation.activeLayer(dir);
    if (tl.ours) {
      const r = await translation.purgeTranslationLayer(dir, { layer: tl.layer, dryRun: true });
      for (const rel of r.removed) add(rel);
      restore.push(...r.restored);
      add(translation.MANIFEST);
    }
  }
  if (legacy.readMarker(dir)) {
    const lp = legacy.removalPlan(dir);
    for (const rel of lp.remove) remove.add(rel);
    restore.push(...lp.restore);
    add(legacy.MARKER);
  }
  {
    const m = relimiter.marker(dir);
    for (const n of (m && m.files) || [relimiter.ADDON_64, relimiter.ADDON_32]) add(n);
    if (m) add(relimiter.MARKER);
    if (m && m.reshadeProxy && m.reshadePlaced && relimiter.isReShadeProxy(path.join(dir, m.reshadeProxy))) add(m.reshadeProxy);
  }
  for (const rel of addons.filesPlaced(dir)) add(rel);
  add(addons.ADDONS_MARKER);
  if (feeder.feederDeployed(dir)) {
    for (const n of ['dlss5-feed.addon64', 'dlss5-feed.cfg', 'dlss5-feed.log', 'ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', '.dlss5ui-feeder-deploy.json']) add(n);
    for (const f of ['DLSS5_Feed.fx', 'ReShade.fxh', 'ReShadeUI.fxh']) add('reshade-shaders/Shaders/' + f);
    // The provider's own files come from what the deploy recorded: a layout provider (VORT) also
    // writes into reshade-shaders\Shaders\Includes\ and \Textures\, which a list of bare Shaders\
    // names cannot describe. The static per-provider lists remain the fallback for a deploy made
    // before the marker carried mvFiles.
    const mvFiles = (feederMarker && Array.isArray(feederMarker.mvFiles) && feederMarker.mvFiles.length)
      ? feederMarker.mvFiles
      : Object.values(feeder.MV_PROVIDERS).flatMap((p) => (p.files || []).map((f) => `Shaders/${f}`));
    for (const f of mvFiles) add('reshade-shaders/' + f);
    if (nativeDlss.shippedDlssPath(dir) || !(feederMarker && feederMarker.placedNvngxDlss === false)) add('nvngx_dlss.dll');
  }
  if (lumaue.lumaUeDeployed(dir)) {
    for (const n of ['Luma', ...lumaue.lumaAddonsIn(dir), 'ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', '.dlss5ui-lumaue-deploy.json']) add(n);
    if (!(lumaMarker && lumaMarker.placedNvngxDlss === false)) add('nvngx_dlss.dll');
  }
  try {
    const fg = framegen.frameGenSwapState(dir);
    if (fg.hasFrameGen && fs.existsSync(fg.dllPath + '.dlss5ui-fgbackup')) restore.push(path.basename(fg.dllPath));
  } catch {}
  if (journal.streamline && journal.streamline.dir) for (const f of journal.streamline.files || []) add(path.join(journal.streamline.dir, f));
  if (journal.reframework) { add(REFRAMEWORK_DLL_NAME); add(REFRAMEWORK_CONFIG_NAME); add('reframework'); }
  if (journal.pdPlugin && pdplugin.isOurCopy(dir, journal.pdPlugin)) add(pdplugin.PLUGIN_NAME);
  for (const rel of rtxmfg.removalPlan(dir)) add(rel);
  if (journal.proxy) add(journal.proxy);
  if (journal.backedUp && has(journal.backedUp)) restore.push(`${journal.backedUpAs || journal.proxy} (from ${journal.backedUp})`);
  for (const n of ['OptiScaler.dll', 'OptiScaler_OpticalFlow.dll', 'OptiScaler.ini', 'OptiScaler.log', 'nvngx.dll_dlssnr.dll', 'Remove_OptiScaler.bat', 'setup_windows.bat', 'setup_linux.sh', 'nvngx_dlssnr.dll', 'OptiScaler', '!! EXTRACT ALL FILES TO GAME FOLDER !!']) add(n);
  for (const f of RELEASE_LICENSE_FILES) add('Licenses/' + f);
  // Game Help's model-only route, which can place the model in the game's own Streamline folder.
  { const p = nrmodelonly.removalPlan(dir); for (const rel of p.remove) add(rel); restore.push(...p.restore); }
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
    invalidateDetection(dir);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The explicit, double-confirmed removal of another DLSS 5 toolchain. The card already asked once
// (warning 1 of 2, renderer); this shows the second, native confirmation with the exact file list
// and then deletes only what the plan names. Never runs without both.
ipcMain.handle('game:removeForeign', (_evt, exePath) => removeForeignFlow(exePath));

// The whole foreign-removal flow, its second warning included, so Game Help can run it too.
async function removeForeignFlow(exePath) {
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
}

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

// The route game:route last worked out for an exe, so game:lastRun can record a run without
// computing one a second time per card. The card asks for both on the same render, route first, so
// the entry is this game's and is seconds old; a game that has not been through game:route yet is
// simply not recorded, which is where this was before.
//
// Nothing comes from the renderer here: an entry is only ever written by game:route from
// recommendRoute's own result, because this feeds the catalog on disk.
const lastRouteByExe = new Map();

// What the last run's logs say -- see runlog.js for the verdicts and where each was met.
//
// This is also where a run becomes EVIDENCE. learnFromRun used to be called only from helpContext,
// so a game was recorded as working only if the user happened to open Game Help on it after a run
// -- which is why a library could be full of games that plainly worked and still wore the
// Experimental chip (2026-09-21: 8 of 18 games here had zero recorded runs, while the ones that had
// been debugged through Game Help carried 14, 18, 39, 44). The card already analyses the run here on
// every render and already reads `nr-ran` off it to draw its "working" evidence, so the proof was in
// hand and only the recording was missing. No extra work: the analysis and the route were both being
// computed for this card anyway.
ipcMain.handle('game:lastRun', async (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return { ran: false, verdict: 'no-log' };
    const dir = gameDir(exePath);
    const run = await runlog.analyzeRun(dir, { optiDir: optiScalerDirFor(dir) });
    const known = lastRouteByExe.get(String(exePath).toLowerCase());
    // learnFromRun ignores anything that is not proof either way, and records each run once by its
    // timestamp, so a card that renders twenty times counts one run once.
    if (known && known.route && known.route.optiInstalled) {
      try {
        catalog.learnFromRun({
          exePath, name: path.basename(exePath, path.extname(exePath)), run,
          setup: { route: known.route.route, via: routescore.placedVia(known.route), api: run.runtimeApi || known.api || null },
        });
      } catch {}
    }
    return run;
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
    const effective = effectiveDetection(dir, exePath, detected || {});
    const gpuInfo = (await getGpuInfo()) || {};
    const extra = {
      appVersion: app.getVersion(),
      // The same machine and version facts "Send game failure" puts in its header (reportinfo.js).
      versions: { app: app.getVersion(), bundled: (bundledEngine() || {}).tag || null, setting: readJson(settingsFile(), {}).installedVersion || null },
      system: { gpu: gpuInfo.name || null, vendor: gpuInfo.vendor || null, driver: gpuInfo.driverVersion || null, vram: await reportinfo.readVram(execFileAsync) },
      detection: effective,
      route: recommendRoute(dir, exePath, effective, gpuInfo.vendor || 'unknown', { lumaMod: lumaModFor(exePath, effective) }),
      backends: detectInstalledBackends(dir),
      foreign: foreignToolchains(dir),
    };
    const out = await runlog.collectSupportBundle(dir, { zipPath: res.filePath, extra, execFileAsync, optiDir: optiScalerDirFor(dir) });
    return { ok: true, cancelled: false, ...out };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// ── Send game failure (ghreport.js) ────────────────────────────────────────────
// The GitHub sign-in token, encrypted for this Windows user (safeStorage = DPAPI). Never in settings.json.
const reportTokenFile = () => path.join(userDataDir(), 'github-report-token.bin');
function readReportToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(reportTokenFile()));
  } catch {
    return null;
  }
}
function writeReportToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows could not protect the sign-in on this PC');
  fs.writeFileSync(reportTokenFile(), safeStorage.encryptString(token));
}
function clearReportToken() {
  try { fs.rmSync(reportTokenFile(), { force: true }); } catch {}
}
const sendToWindows = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) { try { win.webContents.send(channel, payload); } catch {} }
};

ipcMain.handle('report:status', () => ({ configured: ghreport.configured(), signedIn: !!readReportToken() }));

ipcMain.handle('report:signout', () => { clearReportToken(); return { ok: true }; });

// Starts GitHub's device flow: returns the code to show, opens the page to type it into, and finishes in
// the background (the renderer hears 'report-signin' when the player has approved, declined or timed out).
let reportSignIn = null;
ipcMain.handle('report:signin', async () => {
  try {
    const flow = await ghreport.startDeviceFlow();
    shell.openExternal(flow.verification_uri);
    const attempt = {};
    reportSignIn = attempt;
    ghreport.pollForToken(flow.device_code, { interval: flow.interval, expiresIn: flow.expires_in })
      .then((token) => { if (reportSignIn !== attempt) return; writeReportToken(token); sendToWindows('report-signin', { ok: true }); })
      .catch((error) => { if (reportSignIn === attempt) sendToWindows('report-signin', { ok: false, error: String(error && error.message ? error.message : error) }); });
    return { ok: true, userCode: flow.user_code, verificationUri: flow.verification_uri };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Gathers the support bundle's files, shows the player exactly what will be posted, and on yes creates the
// gist and the issue. title/body come from the renderer (the same text the old "Report on GitHub" filled in).
// Two steps, so the player sees exactly what leaves the PC before it does:
//   report:prepare gathers everything, adds the machine and version header (reportinfo.js), redacts and
//     cuts it (ghreport.prepareReport), keeps that object here under an id, and hands the renderer a copy
//     to show in the preview;
//   report:send posts the kept object by id -- not anything the renderer sends back -- so what was
//     previewed is what is sent.
const preparedReports = new Map();
ipcMain.handle('report:prepare', async (_evt, { exePath, detected, title, body, game, finding } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const dir = gameDir(exePath);
    const optiDir = optiScalerDirFor(dir);
    const effective = effectiveDetection(dir, exePath, detected || {});
    const gpuInfo = (await getGpuInfo()) || {};
    const route = recommendRoute(dir, exePath, effective, gpuInfo.vendor || 'unknown', { lumaMod: lumaModFor(exePath, effective) });
    const vram = await reportinfo.readVram(execFileAsync);
    const versions = { app: app.getVersion(), bundled: (bundledEngine() || {}).tag || null, setting: readJson(settingsFile(), {}).installedVersion || null };
    const extra = {
      appVersion: versions.app,
      versions,
      system: { gpu: gpuInfo.name || null, vendor: gpuInfo.vendor || null, driver: gpuInfo.driverVersion || null, vram },
      detection: effective,
      route,
      backends: detectInstalledBackends(dir),
      foreign: foreignToolchains(dir),
    };
    const { files, run } = await runlog.gatherSupportFiles(dir, { extra, optiDir });
    const withText = files.map((f) => {
      let text = f.text;
      if (text === undefined) { try { text = fs.readFileSync(f.source, 'utf8'); } catch { text = ''; } }
      return { name: f.name, text };
    });
    // The logs go to a gist, and a gist is not reachable from anything but a browser signed in as a
    // person: a scripted triage gets 403 there and at the attachment host alike. So the lines that
    // decide the diagnosis go in the body too, where they can actually be read (runlog.reportDigest).
    const helpCtx = await helpContext(exePath, detected).catch(() => null);
    const digest = runlog.reportDigest(run, {
      mvProvider: helpCtx ? helpCtx.mvProvider : null,
      vulkanFeeder: helpCtx ? helpCtx.vulkanFeeder : null,
      detected: helpCtx ? helpCtx.detected : effective,
      route: helpCtx ? helpCtx.route : null, feeder: helpCtx ? helpCtx.feederReady : null,
      timing: helpCtx ? helpCtx.timing : null,
    });
    // Aftermath dumps from around the failed run: the newest OptiScaler.log is when it was.
    let around = null;
    for (const d of [dir, optiDir]) {
      try { around = Math.max(around || 0, fs.statSync(path.join(d, 'OptiScaler.log')).mtimeMs); } catch {}
    }
    const aftermath = reportinfo.findAftermath({ dirs: [dir, optiDir], around });
    const assembled = reportinfo.assemble({
      base: { title, body: runlog.withDigest(body, digest) },
      game: { name: game || path.basename(exePath, path.extname(exePath)), exe: path.basename(exePath) },
      finding, route, detection: effective, gpu: gpuInfo, vram, versions, files: withText, aftermath,
    });
    const prepared = ghreport.prepareReport(assembled);
    const id = crypto.randomUUID();
    preparedReports.clear(); // one preview at a time; an abandoned one is not kept around
    preparedReports.set(id, prepared);
    return { ok: true, id, ...prepared, repo: ghreport.REPO };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('report:discard', (_evt, { id } = {}) => { preparedReports.delete(id); return { ok: true }; });

ipcMain.handle('report:send', async (_evt, { id } = {}) => {
  try {
    const prepared = preparedReports.get(id);
    if (!prepared) throw new Error('This report preview is no longer open -- press Send game failure again');
    const token = readReportToken();
    if (!token) return { ok: false, signedOut: true };
    const out = await ghreport.postReport({ token, prepared });
    preparedReports.delete(id);
    return { ok: true, ...out };
  } catch (error) {
    if (error && error.signedOut) { clearReportToken(); return { ok: false, signedOut: true }; }
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// ── Game Help ─────────────────────────────────────────────────────────────────
// Everything gamehelp.diagnose() looks at, gathered from what the app already computes for the
// card: the cached detection (with the API override), the route, the last run, other
// toolchains, the registry's known-bad note, REFramework, and whether NR is on in the ini.
// A 32-bit helper-route game with DXVK in dgVoodoo2's place (Assassin's Creed II, 2026-09-18): what
// the DLSS 5 half needs there and nothing else shows. ReShade only reaches the game as its 32-bit
// Vulkan layer, which starts only when a ReShade.ini sits beside the exe (ReShade's dll_main.cpp), and
// the add-on's log is the one sign it loaded. Logs are compared against the swap's own timestamp,
// because the folder still holds dlss5-feed.log and ReShade.log from the dgVoodoo2 days.
async function dxvkHost32Status(dir, exePath) {
  const layer = await feeder.vulkanLayerStatus({ execFileAsync, exePath, bitness: 32 });
  const manifest = translation.readManifest(dir);
  const swapAt = manifest && manifest.placedAt ? Date.parse(manifest.placedAt) : 0;
  const since = (rel) => {
    try { return fs.statSync(path.join(dir, rel)).mtimeMs > swapAt; } catch { return false; }
  };
  const marker = legacy.readMarker(dir);
  const proxyName = marker && marker.host32 && marker.host32.reshadeName ? marker.host32.reshadeName : 'dxgi.dll';
  const proxyPath = path.join(dir, proxyName);
  const proxyBack = fs.existsSync(proxyPath) && translation.identifyWrapper(proxyPath) === 'reshade' ? proxyName : null;
  const feedLogSinceSwap = since('dlss5-feed.log');
  let feedExclusive = false;
  if (feedLogSinceSwap) {
    try {
      // The 32-bit add-on's own lines (dlss5-feed.addon32, Feeder 1.16.0-beta.4).
      const text = fs.readFileSync(path.join(dir, 'dlss5-feed.log'), 'latin1');
      feedExclusive = /swapchain is exclusive fullscreen at start|host runs without a window because the game was exclusive fullscreen/i.test(text);
    } catch {}
  }
  return {
    exe: path.basename(exePath),
    layerRegistered: !!layer.registered, layerAddon: !!layer.addon, appListed: layer.appListed,
    reshadeIni: fs.existsSync(path.join(dir, 'ReShade.ini')),
    proxyBack,
    ranSinceSwap: since('ReShade.log'),
    feedLogSinceSwap,
    feedExclusive,
  };
}

async function helpContext(exePath, detected, fixesTried = []) {
  const dir = gameDir(exePath);
  const effective = effectiveDetection(dir, exePath, detected || {});
  const gpuInfo = (await getGpuInfo()) || {};
  const { vendor } = gpuInfo;
  const lumaMod = lumaModFor(exePath, effective);
  const route = recommendRoute(dir, exePath, effective, vendor || 'unknown', { lumaMod });
  const run = await runlog.analyzeRun(dir, { optiDir: optiScalerDirFor(dir) });
  // This machine's own evidence (catalog.js learnFromRun): a run that proved or sank the installed
  // setup is recorded once, by its timestamp, and the route is scored again with it and the run.
  if (route.optiInstalled) {
    try {
      catalog.learnFromRun({
        exePath, name: path.basename(exePath, path.extname(exePath)), run,
        setup: { route: route.route, via: routescore.placedVia(route), api: run.runtimeApi || effective.api || null },
      });
    } catch {}
  }
  const knownGood = catalog.lookup(exePath);
  const routeScore = routescore.scoreRoutes(route, {
    exePath, detected: effective, gpuVendor: vendor || 'unknown', run, catalog: knownGood, lumaMod,
  });
  // What the neural pass costs and the frame rate it leaves, for the digest and the frame-gen suggestion.
  const timing = run.ran ? await runlog.nrTiming(optiScalerDirFor(dir)).catch(() => null) : null;
  let nrEnabledInIni = null;
  try {
    const ini = fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8');
    // Only the [DlssNr] section's own Enabled: the match stops at the next section header.
    const section = /^\[DlssNr\][^[]*/im.exec(ini);
    const m = section && /^Enabled\s*=\s*(\S+)/im.exec(section[0]);
    if (m) nrEnabledInIni = !/^(false|0)$/i.test(m[1]);
  } catch {}
  const reEngine = isReEngineGame(dir);
  // A Vulkan Feeder game: ReShade is the machine-wide Vulkan layer, not a file this app placed, so whether
  // it is there (with add-on support) and whether the Feeder ever wrote its log is all there is to go on.
  let vulkanFeeder = null;
  if (effective.api === 'vulkan' && feeder.feederDeployed(dir)) {
    try {
      const layer = await feeder.vulkanLayerStatus({ execFileAsync, exePath });
      vulkanFeeder = {
        layerRegistered: !!layer.registered, layerAddon: !!layer.addon, appListed: layer.appListed, exe: path.basename(exePath),
        feederLogPresent: fs.existsSync(path.join(dir, 'dlss5-feed.log')),
        // The engine blacklists Vulkan layers, so a correct ReShade setup still never attaches
        // (feeder.LAYER_BLACKLIST_EXES). Carried here so Game Help can say that rather than send
        // the player back through ReShade's installer.
        layerBlacklisted: feeder.refusesVulkanLayers(exePath),
      };
    } catch {}
  }
  const dxvkHost32 = route.route === 'feeder32' && route.dxvkDeployed
    ? await dxvkHost32Status(dir, exePath).catch(() => null)
    : null;
  // The proxy name this app installed OptiScaler under, and the one the game would load if that
  // differs (wantedProxyFor): the Feeder's "OptiScaler: not present" is that mismatch on a Vulkan,
  // OpenGL or DirectX 9 game, and Reconfigure moves the file (migrateProxyIfNeeded).
  const journal = readInstallMarker(dir);
  const optiProxy = journal && typeof journal.proxy === 'string' ? journal.proxy : null;
  let wantedProxy = null;
  try { wantedProxy = optiProxy ? await wantedProxyFor(dir, exePath) : null; } catch {}
  return {
    dir, exePath, detected: effective, route, run, fixesTried, vulkanFeeder, dxvkHost32, optiProxy, wantedProxy,
    // The 32-bit route's motion-vector provider, so a working run on VORT can point at LumeniteFX.
    legacyMv: route.route === 'feeder32' ? legacyMvSummary(dir) : null,
    foreign: foreignToolchains(dir),
    backends: detectInstalledBackends(dir),
    // A game switched to Deep Fried Chicken: its own log is the evidence there, not OptiScaler's.
    dfcState: route.consumerHere === 'dfc' ? dfc.readDfcState(dir) : null,
    lumaKnownBad: route.lumaDeployed ? lumaue.lumaUeKnownBad(exePath) : null,
    // Luma's Prey mod only replaces the game's TAA / SMAA 2TX pass: with anti-aliasing off, FXAA or SMAA 1X
    // there is no pass for DLSS to take over (Luma-Framework Games/Prey/main.cpp, shader_hashes_PostAA_TAA).
    lumaPrey: route.lumaDeployed && lumaue.isPrey2017(exePath),
    reEngine,
    reframeworkPresent: reEngine ? fs.existsSync(path.join(dir, REFRAMEWORK_DLL_NAME)) : null,
    // RE2/3/4/7/Village: the pd-upscaler route's three files (reengine.js), null elsewhere.
    pdUpscaler: reengine.pdStatus(dir, exePath),
    pdPluginPage: reengine.PD_PLUGIN_PAGE_URL,
    // The Agility SDK redirect that makes every D3D12 device in the process fail, the Feeder's
    // private one included (detect.js). Null unless the exe really carries those exports and no
    // D3D12Core.dll can be found for them.
    agilityRedist: agilityRedistRisk(dir, effective),
    // Which frame generator, if any, this app has configured for this game. Marker files, because
    // they are what the app writes when it sets one up -- cheap, and true whether or not the game
    // has been run since. Needed to spot a SECOND generator: NVIDIA Smooth Motion is frame
    // generation done by the driver, outside the process, and the Feeder is the only thing that
    // can see it (runlog.js feedSmoothMotion).
    frameGen: [
      fs.existsSync(path.join(dir, LOSSLESS_MARKER)) ? 'Lossless Scaling' : null,
      fs.existsSync(path.join(dir, FRAMEGEN_MARKER)) ? 'DLSS Frame Generation' : null,
      fs.existsSync(path.join(dir, OPTIFG_MARKER)) ? "OptiScaler's own Frame Generation" : null,
    ].filter(Boolean),
    // Which motion-vector provider this game is actually set up for, and whether that set-up
    // agrees with itself -- a Feeder deploy can be complete in every file sense and still feed
    // nothing (feeder.js's feederProviderStatus).
    mvProvider: feeder.feederDeployed(dir) ? feeder.feederProviderStatus(dir) : null,
    // Which pieces of the Feeder stack are actually on disk. A "no-dlss" verdict on this route is
    // almost always one of them missing -- above all ReShade, which the add-on needs to load at all.
    feederReady: feeder.feederDeployed(dir)
      ? await feeder.feederReadiness(dir, effective.api, { execFileAsync, exePath }).catch(() => null)
      : null,
    nrEnabledInIni,
    gpuVendor: vendor || 'unknown',
    gpu: { vendor: vendor || 'unknown', name: gpuInfo.name || null },
    knownGood, routeScore, timing,
  };
}

// The frame-generation suggestion for a game Game Help has just looked at (fgsuggest.js). Only worth
// the Steam-library scan (Lossless Scaling) and the plugin-tree walk (native frame generation) once a
// run has left a frame rate to judge by.
function frameGenSuggestion(ctx) {
  const run = ctx.run || {};
  const t = ctx.timing && ctx.timing.ok ? ctx.timing : null;
  const fps = (t && t.fps) || run.fps || null;
  if (!run.ran || !fps) return null;
  let hasNativeFg = false;
  try { hasNativeFg = !!framegen.frameGenSwapState(ctx.dir).hasFrameGen; } catch {}
  let ls = { installed: false };
  try { ls = lossless.detect(); } catch {}
  return fgsuggest.suggestFrameGen({
    fps, route: ctx.route, hasNativeFg, gpu: ctx.gpu, lossless: ls,
    configured: ctx.frameGen, smoothMotion: !!run.feedSmoothMotion, catalog: ctx.knownGood,
  });
}

ipcMain.handle('game:help', async (_evt, { exePath, detected, fixesTried = [] } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const ctx = await helpContext(exePath, detected, fixesTried);
    const diag = gamehelp.diagnose(ctx);
    // The digest rides with the diagnosis so the renderer can put it in a report body it opens in the
    // browser itself ("Report on GitHub"), not only in the one report:send posts.
    const digest = runlog.reportDigest(ctx.run, {
      mvProvider: ctx.mvProvider, vulkanFeeder: ctx.vulkanFeeder,
      detected: ctx.detected, route: ctx.route, feeder: ctx.feederReady, timing: ctx.timing,
    });
    const kg = ctx.knownGood;
    return {
      ok: true, ...diag, run: ctx.run, route: { route: ctx.route.route, label: ctx.route.label, reason: ctx.route.reason }, foreign: ctx.foreign, digest,
      // "Why this route?" (routescore.js), the catalog's word on this game, and the frame-gen suggestion.
      score: ctx.routeScore,
      knownGood: kg ? { status: kg.status || null, route: (kg.setup || {}).route || null, notes: kg.notes || '', local: !!kg.local } : null,
      fg: frameGenSuggestion(ctx),
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The fixes the app runs itself. 'install' is the card's Install button: the renderer runs it.
async function applyHelpFix(exePath, fixId) {
  const dir = gameDir(exePath);
  switch (fixId) {
    case 'remove-foreign': {
      const r = await removeForeignFlow(exePath);
      if (!r.ok) throw new Error(r.error);
      if (r.cancelled) return { done: false, text: 'cancelled by the user' };
      return { done: true, text: `removed ${(r.removed || []).length} item(s)${(r.restored || []).length ? ', restored ' + r.restored.length : ''}` };
    }
    case 'remove-feeder': {
      if (!feeder.feederDeployed(dir)) return { done: false, text: 'no Feeder deployed here' };
      const r = await feeder.removeFeederStack(dir, { keepReShade: lumaue.lumaUeDeployed(dir) });
      if (fs.existsSync(path.join(dir, 'OptiScaler.ini'))) await autoConfigureGame(dir, exePath);
      return { done: true, text: `removed the Feeder (${r.removed.length} files)` };
    }
    // Needs Luma's licence confirmed by the user, which only the renderer's own dialog does.
    case 'switch-to-luma':
      return { done: false, text: 'switching to Luma needs its licence confirmed -- use Fix it in Game Help' };
    case 'remove-luma': {
      if (!lumaue.lumaUeDeployed(dir)) return { done: false, text: 'no Luma UE deployed here' };
      const r = await lumaue.removeLumaStack(dir);
      if (fs.existsSync(path.join(dir, 'OptiScaler.ini'))) await autoConfigureGame(dir, exePath);
      return { done: true, text: `removed Luma UE (${r.removed.length} files)` };
    }
    case 'reconfigure': {
      if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return { done: false, text: 'OptiScaler is not installed here' };
      // The proxy under a name this game never loads (SWTOR's dxgi.dll beside DXVK) is as much a
      // configuration as any ini key, and the same migration sync runs -- Game Help's opti-proxy-name
      // finding lands here.
      // A failed move is said, not swallowed: with `catch {}` here a rename refused by a running game
      // came back as "nothing needed changing", which is the one answer that sends the user away
      // from the actual problem (review of 2026-09-18).
      let migration = null;
      let migrateError = null;
      try {
        migration = await migrateProxyIfNeeded(dir, exePath);
      } catch (error) {
        migrateError = error;
      }
      const r = await autoConfigureGame(dir, exePath);
      return helpfix.reconfigureSummary({ migration, migrateError, applied: r.applied, reframeworkPlaced: !!(r.reframework && r.reframework.installed) });
    }
    // Re-deploy the Feeder's own half of the stack, forced, from one answer: the provider (this
    // app's current default unless the game's existing choice is still usable), its shader, both
    // DLSS5_MV_PROVIDER levels, the search paths and the add-on's enabled state. The fix for
    // every "the feed ran and DLSS got no motion vectors" verdict -- including any game deployed
    // before v1.57.0, whose motion-vector shader (DRME) cannot compile on ReShade 6.8 at all.
    case 'redeploy-feeder': {
      if (!feeder.feederDeployed(dir)) return { done: false, text: 'no Feeder deployed here' };
      const api = await resolveApi(dir, exePath);
      const current = feeder.MV_PROVIDERS[feeder.feederProviderStatus(dir).id || ''] || null;
      // A bring-your-own provider that is really there stays; anything unusable (DRME) or absent
      // gives way to the default, which this app can fetch.
      const keep = !!current && current.selectable !== false &&
        (current.bringYourOwn ? feeder.mvProviderPresent(dir, current.id) : true);
      const providerId = keep ? current.id : feeder.defaultMvProviderId();
      const results = await feeder.deployFeederStack(dir, api, providerId, {
        cacheDir: feederCacheDir(),
        getRhiManifest,
        compareVersions: compareStreamlineVersions,
        ghHeaders: GITHUB_HEADERS,
        force: true,
        allowPrerelease: feederPrereleaseEnabled(),
        unity: isUnityGame(dir, exePath),
        depthProfile: feeder.feederDepthProfile(dir),
        execFileAsync,
        exePath,
      });
      await autoConfigureGame(dir, exePath);
      const version = results.addon && results.addon.version ? `, add-on ${results.addon.version}` : '';
      return { done: true, text: `re-deployed the Feeder with ${feeder.MV_PROVIDERS[providerId].displayName} (motion-vector shader, preset and ReShade settings rewritten)${version}` };
    }
    // Flat depth: move this game to the one Unity depth profile a human has confirmed end to end
    // (the Feeder's README carries it as its Subnautica profile). Only ReShade.ini changes, so it
    // applies on the next launch, and Remove or a re-deploy still undoes it.
    case 'feeder-depth-profile': {
      if (!feeder.feederDeployed(dir)) return { done: false, text: 'no Feeder deployed here' };
      if (feeder.feederDepthProfile(dir) === 'unity-verified') {
        return { done: false, text: 'already on the verified depth profile -- ReShade\'s own Add-ons > Generic Depth page is the next step, since it lists the real depth buffers the running game has' };
      }
      feeder.configureReShadeIni(dir, { depthProfile: 'unity-verified' });
      const marker = path.join(dir, '.dlss5ui-feeder-deploy.json');
      try {
        const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
        fs.writeFileSync(marker, JSON.stringify({ ...data, depthProfile: 'unity-verified' }, null, 2), 'utf8');
      } catch {}
      return { done: true, text: 'switched to the contributor-verified Unity depth profile (clear index, aspect heuristic, reversed and upside-down depth)' };
    }
    // The Agility SDK redirect: move the game's own D3D12\ redist folder aside so Direct3D 12
    // falls back to the runtime Windows ships -- the test the Feeder's README gives for
    // D3D12_ERROR_INVALID_REDIST. Reversible by name, and the game itself says whether it needed
    // the folder: if it refuses to start, the rename goes back.
    case 'disable-agility-redist': {
      const src = path.join(dir, 'D3D12');
      const dest = path.join(dir, 'D3D12.dlss5ui-off');
      if (!fs.existsSync(src)) return { done: false, text: 'no D3D12\\ folder beside the exe -- something else in the process is redirecting Direct3D 12 (a launcher, a mod loader, or an absolute D3D12SDKPath), so verify the game\'s files through its launcher' };
      if (fs.existsSync(dest)) return { done: false, text: 'already moved aside, as D3D12.dlss5ui-off' };
      await fsp.rename(src, dest);
      return { done: true, text: 'moved D3D12\\ aside to D3D12.dlss5ui-off. Launch the game: if it starts, that folder was the problem and the Feeder can open its own device now. If it refuses to start, rename the folder back -- the redist is genuinely in use and damaged, and the game\'s files need verifying' };
    }
    // The card's Remove, for a route that cannot run on this game at all (dgVoodoo2 crashing it at
    // startup). Everything this app placed goes and anything it set aside comes back -- asked first,
    // since it undoes the whole install rather than one setting.
    // The other translation layer, offered when the game crashed inside the one it has. deployDxvk
    // purges the layer in the way itself (canDeploy -> purgeTranslationLayer), handing back
    // whatever that layer displaced, so this does not have to unwind anything by hand.
    case 'swap-to-dxvk': {
      // The AI tier and an old card can still ask for it; the list is enforced here, not only in the UI.
      const blocked = translation.dxvkBlockedFor(exePath);
      if (blocked) return { done: false, text: blocked.why };
      // The game's REAL detection, not {}. effectiveDetection({}) returns an object with no bitness
      // and no api, so legacy.planFor falls straight through to "not a legacy game" -- which meant
      // this swap answered "this game has no translation-layer route" on every game it was ever
      // offered for, from the crash verdict as well as from the button. Assassin's Creed II, a
      // 32-bit DirectX 9 game whose plan is plainly supported, is what showed it (2026-09-18).
      // Every other legacyPlanFor caller passes the detection the renderer already has.
      const detectedForPlan = await detectFor(dir, exePath);
      const plan = wrapperPlanFor(dir, exePath, detectedForPlan);
      if (!plan || !plan.supported) {
        return {
          done: false,
          text: `this game has no translation-layer route (${plan && plan.reason ? plan.reason : 'unsupported'})`,
        };
      }
      // DXVK is offered in dgVoodoo2's place (DirectX 8/9), and in place of the game's own Direct3D on a
      // 32-bit DirectX 10/11 game (legacy.dxvkReplacesNative). That second case used to be refused: the
      // helper route's ReShade is its dxgi.dll, the name DXVK's D3D11 set needs, and the swap put
      // d3d11.dll in, refused dxgi.dll and still reported success (review of 2.2.3, 2026-09-18). It
      // now parks that proxy first, exactly as the DX9 swap does before the Vulkan layer goes in.
      const native = legacy.dxvkReplacesNative(plan);
      if (!plan.dgVoodoo && !native) {
        return { done: false, text: `DXVK is offered here in place of dgVoodoo2 (DirectX 8/9) or of a 32-bit DirectX 10/11 game's own Direct3D; this one is ${plan.host32 ? '32-bit ' : ''}${plan.api || 'an unknown API'}` };
      }
      const nativeName = plan.api === 'dx10' ? 'Direct3D 10' : 'Direct3D 11';
      const layerNow = translation.activeLayer(dir);
      const dxvkIn = layerNow.ours && layerNow.layer === 'dxvk';
      // The wording cannot assume a crash any more: this is reachable from Game Help's More row as a
      // choice, not only from a 'wrapper-crash' verdict, so it has to read correctly for a game that
      // is merely misbehaving -- or that has dgVoodoo2 nowhere near it yet.
      const hasDgVoodoo = legacy.status(dir).dgVoodoo;
      const helperInstalled = !!(legacy.readMarker(dir) || {}).host32;
      // The 32-bit helper route needs ReShade's 32-bit Vulkan layer under DXVK (legacy.js explains
      // why), and installing it takes an administrator prompt and changes the whole PC. Said before,
      // not discovered after.
      const layerNote = plan.host32
        ? '\n\nThis game\'s DLSS 5 runs through ReShade, and under DXVK ReShade has to be its 32-bit Vulkan layer. '
          + 'ReShade\'s own setup installs that now: Windows will ask for administrator permission, and the layer is '
          + 'installed for the whole PC (C:\\ProgramData\\ReShade) and switched on for this game only. The game-folder '
          + `ReShade (dxgi.dll) is set aside while DXVK is in, and comes back with ${native ? `native ${nativeName}` : 'dgVoodoo2'}. `
          + 'Remove takes this game off the layer\'s list but leaves the layer for any other game that uses it.'
        : '';
      // A DirectX 10/11 game has no dgVoodoo2 to swap out: DXVK replaces the game's own Direct3D, and
      // its full D3D10/11 set (d3d10core.dll, d3d11.dll, dxgi.dll) goes beside the exe.
      const intro = native
        ? `DXVK runs this game's ${nativeName} on Vulkan instead: its d3d10core.dll, d3d11.dll and dxgi.dll go beside `
          + 'the exe. Any game file under those names is backed up first, so switching back to native '
          + `${nativeName} puts the folder back as it was.`
          + '\n\nNative is usually the better choice on a DirectX 10/11 game; DXVK is worth trying when the game '
          + 'misbehaves under it. Nothing here can tell which way it went until you run the game. Run it '
          + 'afterwards and check here again.'
        : (hasDgVoodoo
          ? 'dgVoodoo2 and DXVK do the same job by different routes -- dgVoodoo2 through Direct3D 11, DXVK '
            + 'through Vulkan -- so when a game will not behave under one, the other is worth a try.\n\n'
            + 'Whatever dgVoodoo2 displaced is handed back first, so this can be undone.'
          : 'DXVK translates this game\'s old Direct3D to Vulkan, which is what gives OptiScaler something '
            + 'modern to hook.\n\nAnything it displaces is backed up first, so this can be undone.')
          + '\n\nNeither layer is better everywhere: the swap can make a nearly-working game worse, and '
          + 'nothing here can tell which way it went until you run the game. Run it afterwards and check here again.';
      const answer = await dialog.showMessageBox({
        type: 'question',
        buttons: [dxvkIn ? 'Set up the layer' : 'Try DXVK', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: native ? 'Run this game through DXVK' : 'Try the other compatibility layer',
        message: dxvkIn
          ? 'Set up ReShade\'s 32-bit Vulkan layer for this game again?'
          : native ? `Use DXVK (Vulkan) instead of native ${nativeName} in this game?`
            : hasDgVoodoo ? 'Swap dgVoodoo2 for DXVK in this game?' : 'Use DXVK as this game\'s compatibility layer?',
        detail: (dxvkIn
          ? 'DXVK is already in front of this game. This runs ReShade\'s setup for it once more.'
          : intro)
          + layerNote,
      });
      if (answer.response !== 0) return { done: false, text: 'cancelled by the user' };

      let said;
      if (dxvkIn) {
        said = 'DXVK was already in front of the game';
      } else if (plan.host32 && !helperInstalled && !hasDgVoodoo) {
        // Nothing installed yet: the choice is recorded and Install acts on it (legacy:dgvoodoo puts
        // DXVK in, legacy:installHost32 sets up the layer). Deploying now would put DXVK in front of
        // a game whose ReShade proxy Install is about to add -- two ReShades.
        // On a DirectX 10/11 game legacy:installHost32 places DXVK itself, after the proxy it parks.
        translation.writePreference(dir, 'dxvk');
        return {
          done: true,
          text: native
            ? `DXVK is chosen for this game: Install puts it in front of the game instead of native ${nativeName}, then sets up ReShade's 32-bit Vulkan layer (asking for administrator permission)`
            : 'DXVK is chosen for this game: Install puts it in front of the game instead of dgVoodoo2, then sets up ReShade\'s 32-bit Vulkan layer (asking for administrator permission)',
        };
      } else {
        // DirectX 10/11: the ReShade dxgi.dll proxy is parked BEFORE DXVK goes in (its dxgi.dll takes
        // the name), and put back if DXVK is refused. DirectX 8/9 parks it in the layer step below.
        const r = native ? await deployDxvkNative32(dir, plan) : await deployDxvkFor(dir, plan);
        if (!r.ok) return { done: false, text: r.text };
        // Said from what happened, not assumed: dgVoodoo2 may never have been here.
        const files = (r.deployed || []).join(', ');
        const kept = (r.backedUp || []).map((b) => `${b.rel} kept as ${b.backup}`).join(', ');
        said = native ? `DXVK (${files}) is in front of the game instead of native ${nativeName}`
          : hasDgVoodoo ? `DXVK (${files}) replaced dgVoodoo2` : `DXVK (${files}) is in front of the game`;
        if (kept) said += `; the game's own ${kept}`;
        if (native) said += r.parkedNote || '';
      }
      translation.writePreference(dir, null);
      if (!plan.host32) {
        return { done: true, text: `${said} -- run the game and check again` };
      }
      if (!helperInstalled) {
        return { done: true, text: `${said}; Install sets up the rest, ReShade's 32-bit Vulkan layer included` };
      }
      const layer = await dxvkHost32LayerStep(dir, exePath);
      if (!layer.ok) {
        return { done: false, text: `${said}${layer.parkedNote}, but ReShade's 32-bit Vulkan layer is NOT set up: ${layer.error}. DLSS 5 will not run under DXVK until it is -- try again from Game Help, or swap back to ${native ? `native ${nativeName}` : 'dgVoodoo2'}.` };
      }
      return { done: true, text: `${said}${layer.parkedNote}; ReShade's 32-bit Vulkan layer is ${layer.ran ? 'now' : 'already'} set up for ${path.basename(exePath)} -- run the game (borderless or windowed, for the panel) and check again` };
    }
    // Back from DXVK to dgVoodoo2: the other half of the swap above, offered when a DXVK run did no
    // better. deployDgVoodoo purges the DXVK this app placed through the same exclusivity gate and
    // puts the parked ReShade proxy back, so this does not unwind anything by hand. ReShade's Vulkan
    // layer stays registered: it is machine-wide, and without Vulkan in the game it never attaches.
    case 'swap-to-dgvoodoo': {
      const detectedForPlan = await detectFor(dir, exePath);
      const plan = wrapperPlanFor(dir, exePath, detectedForPlan);
      // A 32-bit DirectX 10/11 game's way back is its own Direct3D, not dgVoodoo2 -- an older card or
      // the AI tier asking for this there gets that instead of a refusal.
      if (legacy.dxvkReplacesNative(plan)) return swapBackToNative(dir, plan, exePath, detectedForPlan);
      if (!plan || !plan.supported || !plan.dgVoodoo) {
        return { done: false, text: `this game has no dgVoodoo2 route (${plan && plan.reason ? plan.reason : plan && plan.api ? plan.api : 'unsupported'})` };
      }
      const layerNow = translation.activeLayer(dir);
      if (!(layerNow.ours && layerNow.layer === 'dxvk')) {
        // DXVK only chosen (by hand, or proven by the catalog), not placed yet: going back forgets the
        // choice, or records dgVoodoo2 where a proven DXVK would otherwise come back (pickStandardLayer).
        if (await dxvkWanted(dir, exePath, detectedForPlan)) {
          await pickStandardLayer(dir, exePath, detectedForPlan, 'dgvoodoo');
          return { done: true, text: 'dgVoodoo2 it is again: Install puts dgVoodoo2 in front of this game' };
        }
        return { done: false, text: 'DXVK is not a layer this app put in front of this game, so there is nothing to swap back from' };
      }
      const answer = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Swap back', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'Try the other compatibility layer',
        message: 'Swap DXVK back for dgVoodoo2 in this game?',
        detail: 'DXVK comes out and dgVoodoo2 goes back in, with whatever DXVK displaced handed back first.'
          + (plan.host32 ? ' The game-folder ReShade (dxgi.dll) returns with it; ReShade\'s Vulkan layer stays installed on the PC.' : '')
          + '\n\nRun the game afterwards and check here again.',
      });
      if (answer.response !== 0) return { done: false, text: 'cancelled by the user' };
      let source;
      try {
        source = await legacy.ensureDgVoodoo(feederCacheDir(), { headers: GITHUB_HEADERS });
      } catch (error) {
        return { done: false, text: `could not fetch dgVoodoo2: ${error && error.message ? error.message : error}` };
      }
      const hadParked = !!((legacy.readMarker(dir) || {}).parked || []).length;
      // dgVoodoo2 goes back in, and what is installed wins over the catalog's proof: nothing to record.
      translation.writePreference(dir, null);
      await legacy.deployDgVoodoo(dir, plan, source, { vendor: ((await getGpuInfo()) || {}).vendor });
      invalidateDetection(dir);
      const stillParked = !!((legacy.readMarker(dir) || {}).parked || []).length;
      const proxy = hadParked && !stillParked ? '; the game-folder ReShade is back' : stillParked ? '; the game-folder ReShade could not go back under its name (something else holds it)' : '';
      return { done: true, text: `dgVoodoo2 (${plan.dgVoodoo.dll}) is back in place of DXVK${proxy} -- run the game and check again` };
    }
    // Back from DXVK to a 32-bit DirectX 10/11 game's own Direct3D: the other half of the native swap.
    case 'swap-to-native': {
      const detectedForPlan = await detectFor(dir, exePath);
      const plan = wrapperPlanFor(dir, exePath, detectedForPlan);
      if (!legacy.dxvkReplacesNative(plan)) {
        return { done: false, text: `native Direct3D is the way back only on a 32-bit DirectX 10/11 game (${plan && plan.reason ? plan.reason : plan && plan.api ? plan.api : 'unsupported'})` };
      }
      return swapBackToNative(dir, plan, exePath, detectedForPlan);
    }
    // The route RHI takes on a game that ships its own DLSS: no proxy at all, just the model beside
    // the exe for the game's own Streamline to load. It is the fallback for the case the proxy route
    // cannot serve -- a game that will not start with a DLL injected into its loader -- and it costs
    // the in-game panel, which is why it is offered on a failure and confirmed, never automatic.
    case 'nr-model-only': {
      // Only a game with DLSS of its own. The rule table checks route.shipsDlss before offering this,
      // but the fix is in gamehelp.FIX_IDS, so the AI tier can ask for it on any game -- where it would
      // take OptiScaler out and leave a model nothing ever loads (review of 2026-09-18).
      const refused = nrmodelonly.refusal(dir);
      if (refused) return { done: false, text: refused };
      const answer = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Use the model only', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'Add Neural Rendering without OptiScaler',
        message: 'Take OptiScaler out and let the game load the model itself?',
        detail: 'This game has DLSS of its own, so Neural Rendering does not need OptiScaler to reach it: the '
          + 'model file beside the exe is enough, and the game\'s own Streamline loads it.\n\n'
          + 'Everything this app placed here is removed first, so the game goes back to loading only its own '
          + 'DLLs. That is the point -- nothing of ours is in its loader any more -- but it also means no '
          + 'in-game panel and none of the DLSS 5 controls. Take this route when a game will not start with '
          + 'OptiScaler in it.\n\nInstall puts OptiScaler back whenever you want it.',
      });
      if (answer.response !== 0) return { done: false, text: 'cancelled by the user' };

      // Where the game keeps its OWN Streamline is where its NGX looks for the model, and that is
      // not always beside the exe: an Unreal game keeps it under Engine\\Plugins\\...\\Win64, and
      // Where Winds Meet keeps a whole Streamline runtime in a folder of its own. native-dlss.js
      // already knows all three layouts (nrmodelonly.targetDirFor) -- dropping the model beside the
      // exe regardless would be a no-op on exactly the games most likely to need this route.
      //
      // nrmodelonly.nrModelOnly keeps the model the game already has (in that folder or beside the
      // exe), records what it placed for Remove, and puts the model back if a step fails after the
      // uninstall took it. The fetched model, when there is none, is the one Install would use on this
      // machine: Settings' model or the newest RHI build on NVIDIA, the pinned 310.8.0 on AMD.
      const { vendor } = await getGpuInfo();
      const settings = readJson(settingsFile(), {});
      const result = await nrmodelonly.nrModelOnly({
        dir,
        cacheDir: nrModelCacheDir(),
        uninstall: uninstallEverything,
        resolveSource: () => nrmodelonly.pickModelSource({
          vendor,
          settingsPath: settings.nrDllPath || null,
          fetchNvidia: async () => {
            if (!nrFetchInFlight) nrFetchInFlight = fetchNrModel().finally(() => { nrFetchInFlight = null; });
            const r = await nrFetchInFlight;
            if (!r || !r.ok) throw new Error((r && r.error) || 'the NR model could not be fetched');
            return r.path;
          },
          fetchAmd: () => amdnr.ensureAmdNrModelCache({ getRhiManifest, cacheDir: nrModelCacheDir(), ghHeaders: GITHUB_HEADERS }),
        }),
      });
      invalidateDetection(dir);
      return result;
    }
    case 'remove-all': {
      const answer = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Remove', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'Remove from this game',
        message: 'Remove everything this app placed in this game\'s folder?',
        detail: 'The game goes back to how it was before Install. You can Install again later.',
      });
      if (answer.response !== 0) return { done: false, text: 'cancelled by the user' };
      const r = await uninstallEverything(dir);
      invalidateDetection(dir);
      const tail = (r.failed || []).length
        ? ` -- but ${r.failed.map((f) => f.rel).join(', ')} could not be deleted, so close the game and run Remove again`
        : ' -- the game is back to how it was';
      return { done: true, text: `removed ${(r.removed || []).length} item(s)${(r.restored || []).length ? ', restored ' + r.restored.length : ''}${tail}` };
    }
    case 'install':
      return { done: false, text: 'Install runs from the card: press Install DLSS 5 on this game' };
    case 'place-dlss': {
      const r = await placeNvngxDlssBesideExe(dir);
      invalidateDetection(dir);
      if (!r.placed) return { done: false, text: `nvngx_dlss.dll was not placed: ${r.reason}` };
      return {
        done: true,
        text: r.source === 'game'
          ? `copied the game's own nvngx_dlss.dll beside the exe (from ${r.from})`
          : `placed NVIDIA's nvngx_dlss.dll ${r.version} beside the exe`,
      };
    }
    default:
      throw new Error(`unknown fix ${fixId}`);
  }
}

ipcMain.handle('game:help-apply', async (_evt, { exePath, fixId } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    return { ok: true, ...(await applyHelpFix(exePath, fixId)) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The AI tier's evidence: the same view the bundle carries, as text, plus the log tails.
async function helpEvidence(ctx) {
  const tail = (file, max = 12000) => {
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.min(size, max);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('latin1');
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  };
  const { dir } = ctx;
  const view = {
    appVersion: app.getVersion(), gpuVendor: ctx.gpuVendor, detection: ctx.detected, route: ctx.route, run: ctx.run,
    backends: ctx.backends, foreign: ctx.foreign, reEngine: ctx.reEngine, reframeworkPresent: ctx.reframeworkPresent,
    nrEnabledInIni: ctx.nrEnabledInIni, lumaKnownBad: ctx.lumaKnownBad, fixesTried: ctx.fixesTried,
    ruleVerdict: gamehelp.diagnose(ctx),
  };
  let listing = [];
  try { listing = fs.readdirSync(dir).slice(0, 200); } catch {}
  const parts = [`## App view\n${JSON.stringify(view, null, 1)}`, `## Folder listing (${path.basename(dir)})\n${listing.join('\n')}`];
  for (const name of ['OptiScaler.log', 'dlss5-feed.log', 'ReShade.log']) {
    const t = tail(path.join(dir, name));
    if (t) parts.push(`## ${name} (tail)\n${t}`);
  }
  const ini = tail(path.join(dir, 'OptiScaler.ini'), 6000);
  if (ini) parts.push(`## OptiScaler.ini (tail)\n${ini}`);
  return parts.join('\n\n');
}

ipcMain.handle('game:help-ai', async (evt, { exePath, detected, fixesTried = [] } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const settings = readJson(settingsFile(), {});
    const apiKey = (settings.anthropicApiKey || '').trim();
    if (!apiKey) throw new Error('No API key set (Settings > AI help)');
    const model = aihelp.MODELS.includes(settings.aiModel) ? settings.aiModel : aihelp.DEFAULT_MODEL;
    const ctx = await helpContext(exePath, detected, fixesTried);
    const evidence = await helpEvidence(ctx);
    const sender = evt && evt.sender;
    const result = await aihelp.helpSession({
      apiKey, model, evidence,
      onText: (text) => { try { sender.send('game:help-ai-text', { exePath, text }); } catch {} },
      applyFix: async (fix, why) => {
        if (!gamehelp.FIX_IDS.includes(fix)) return 'refused: not a known fix';
        if (fix === 'install') return 'not possible from here: the user must press Install DLSS 5 on the card; tell them so';
        const res = await dialog.showMessageBox({
          type: 'question', buttons: ['Allow', 'Skip'], defaultId: 0, cancelId: 1,
          title: 'Game Help (AI) wants to make a change',
          message: `Apply "${fix}" to ${path.basename(exePath)}?`,
          detail: why || '',
        });
        if (res.response !== 0) return 'the user declined this fix';
        const r = await applyHelpFix(exePath, fix);
        return (r.done ? 'done: ' : 'not done: ') + r.text;
      },
    });
    return { ok: true, model, ...result };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The exe a Launch should run. An Unreal game's card may point at the launcher stub in the
// install root (the exe the store lists); the process that actually renders is the
// <Project>-Win64-Shipping.exe under <Project>\Binaries\Win64, and that is what OptiScaler is
// installed beside -- so that is what runs. Anything else runs as it is.
// A game that will not start without its own launcher. Star Wars: The Old Republic's swtor.exe exits at
// once unless launcher.exe -- two folders up -- has signed the player in and started it, so the card's
// Launch and Game Help's "Launch and check" did nothing at all (user report, 2026-09-16). A launcher.exe
// in the exe's folder or up to three above is taken as the game's own; Edit can pick another or say the
// exe runs on its own. The running check still watches the game's exe, which the launcher starts.
function findGameLauncher(exePath) {
  let dir = path.dirname(path.resolve(exePath));
  for (let up = 0; up <= 3; up++) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const hit = names.find((n) => n.toLowerCase() === 'launcher.exe');
    if (hit) {
      const full = path.join(dir, hit);
      if (full.toLowerCase() !== path.resolve(exePath).toLowerCase()) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 'direct' = the game exe; an absolute path = that launcher; anything else (undefined, 'auto') = found.
function resolveGameLauncher(exePath, choice) {
  if (choice === 'direct') return null;
  if (choice && choice !== 'auto') return fs.existsSync(choice) ? choice : null;
  return findGameLauncher(exePath);
}

ipcMain.handle('game:launcher', (_evt, exePath) => {
  try {
    return { found: exePath && fs.existsSync(exePath) ? findGameLauncher(exePath) : null };
  } catch {
    return { found: null };
  }
});

function launchTarget(exePath) {
  if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
  const resolved = resolveUnrealShippingExe(exePath);
  return fs.existsSync(resolved) ? resolved : exePath;
}

// Has this app put anything in this folder? The anti-cheat stub question below only arises for a
// game this app has actually modified -- an untouched game should launch exactly as Steam intends.
function stackInstalledHere(dir) {
  return ['.optiscaler-manager-install.json', '.dlss5ui-feeder-deploy.json', '.dlss5ui-lumaue-deploy.json']
    .some((name) => fs.existsSync(path.join(dir, name)));
}

// Launching past an anti-cheat stub: asked once per game, remembered on a yes, and never assumed.
// The consequence is real (an account, if someone then goes online), so the wording says it.
async function confirmLaunchWithoutAntiCheat(exePath, { stub, antiCheat, appId, switchArgs = null }) {
  const settings = readJson(settingsFile(), {});
  const remembered = settings.launchWithoutAntiCheat || {};
  const key = String(exePath).toLowerCase();
  if (remembered[key]) return true;

  const name = path.basename(exePath);
  // The publisher's own offline switch keeps the normal launch, so the story is shorter.
  const detail = switchArgs
    ? `Anti-cheat will not let the game start with OptiScaler's DLL in the folder. This launch uses the game's own `
      + `${switchArgs.join(' ')} switch, which starts it through its normal launcher with ${antiCheat || 'the anti-cheat'} off.`
      + '\n\nStory Mode works. Online play does not, and playing online with these files in place can get the account '
      + 'banned -- so keep this game offline while it is modded, and use Remove before going back online.'
    : `Steam does not start the game directly: it runs ${stub}, which starts ${antiCheat || 'the anti-cheat service'} `
      + 'and then the game under it. Anti-cheat will not let the game start with OptiScaler\'s DLL in the folder, so that '
      + `launch fails with nothing written to any log at all.\n\nStarting ${name} directly skips the stub. `
      + 'Single-player works. Online play and matchmaking do not, and playing online with these files in place can get '
      + 'the account banned -- so keep this game offline while it is modded, and use Remove before going back online.';
  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Launch without anti-cheat', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'This game starts through its anti-cheat',
    message: `${name} runs under ${antiCheat || 'anti-cheat'}.`,
    detail,
    checkboxLabel: 'Do not ask again for this game',
    checkboxChecked: false,
    noLink: true,
  });
  if (res.response !== 0) return false;
  if (res.checkboxChecked) {
    writeJson(settingsFile(), { ...settings, launchWithoutAntiCheat: { ...remembered, [key]: true } });
  }
  return true;
}

// Starts a game detached, in its own folder, owing nothing to this app.
//
// spawn() cannot start an exe that needs elevation -- one with Windows' "Run this program as an
// administrator" compatibility box ticked, or a manifest asking for it. CreateProcess refuses with
// ERROR_ELEVATION_REQUIRED, which libuv reports as EACCES, and the card said "spawn EACCES"
// (Cyberpunk 2077, whose exe carried RUNASADMIN in HKCU AppCompatFlags, 2026-09-16). The Windows
// shell is what honours that flag and shows the UAC prompt, so the exe is handed to it instead.
// The shell takes no environment, so a Steam app id passed that way does not reach the game on
// this path; the argument list is kept.
async function startDetached(file, argv = [], { cwd, env } = {}) {
  try {
    const child = spawn(file, argv, { cwd, detached: true, stdio: 'ignore', windowsHide: false, ...(env ? { env } : {}) });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { elevated: false };
  } catch (e) {
    const needsElevation = e && (e.code === 'EACCES' || e.errno === 740 || e.errno === -4092);
    if (!needsElevation) throw new Error(`could not start ${path.basename(file)}: ${e && e.message ? e.message : e}`);
  }
  // Start-Process -Verb RunAs is ShellExecute with the elevation verb, the argument list intact and
  // the working folder set -- shell.openPath would lose both.
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = [
    `Start-Process -FilePath ${quote(file)}`,
    `-WorkingDirectory ${quote(cwd || path.dirname(file))}`,
    argv.length ? `-ArgumentList @(${argv.map(quote).join(',')})` : '',
    '-Verb RunAs',
  ].filter(Boolean).join(' ');
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  } catch (e) {
    // Declining the UAC prompt lands here too ("The operation was canceled by the user").
    const detail = String((e && (e.stderr || e.message)) || e).split(/\r?\n/).find((l) => l.trim()) || 'refused';
    throw new Error(`${path.basename(file)} is set to run as administrator and did not start: ${detail.trim()}`);
  }
  return { elevated: true };
}

// The card's Launch, as a function: a watched launch (probe.js) and Verify install start the game the
// same way, anti-cheat question and all.
async function launchGame({ exePath, launcher = 'auto', dryRun = false } = {}) {
  try {
    const target = launchTarget(exePath);
    const dir = path.dirname(target);
    const steamAppId = library.steamAppIdFor(target);
    // Arguments this app must add for the game to work at all (feeder.launchArgs): idTech's
    // +r_allowBlackListedLayers 1, without which ReShade's Vulkan layer never attaches. Game Help
    // already tells the user to add these; the card's Launch has to add them as well, or the one
    // launch this app controls is the one that still fails.
    const extraArgs = feeder.launchArgs(target);
    // An anti-cheat stub (detect.js's antiCheatStub) is a dead end for everything this app
    // installs: Steam runs the stub, the stub starts the anti-cheat, and the game then refuses to
    // start at all -- no log, nothing to diagnose (Armored Core VI, 2026-09-13). The game's own
    // exe is right beside it and starts without the anti-cheat, so that is what gets launched,
    // once the person has said yes to what it costs (no online play, and a ban risk if they go
    // online anyway). Only for a game this app has modified, and never silently.
    const stubInfo = stackInstalledHere(dir) ? antiCheatStub(dir) : null;
    if (stubInfo) {
      // The exe on record can itself be the stub -- a BattlEye game's <Game>_BE.exe is what a
      // launcher points at, and it is the one a user picks when adding the game by hand. The stub
      // names the exe it fronts, so launch that instead of re-running the stub.
      const real = stubInfo.gameExe && path.basename(target).toLowerCase() === stubInfo.stub.toLowerCase()
        ? path.join(dir, stubInfo.gameExe)
        : target;
      const stub = stubInfo.stub;
      const antiCheat = stubInfo.antiCheat || antiCheatPresent(dir, real);
      // The publisher's own switch (detect.js ANTI_CHEAT_SWITCHES): the normal launch, launcher and
      // sign-in included, with the anti-cheat left out. Skipping the stub is what breaks these games.
      if (stubInfo.launch) {
        const { args } = stubInfo.launch;
        const launcher = path.join(dir, stubInfo.launch.exe);
        const via = steamAppId ? 'steam-no-anticheat' : 'launcher-no-anticheat';
        if (dryRun) return { ok: true, target: launcher, via, args, steamAppId, stub, antiCheat };
        if (!(await confirmLaunchWithoutAntiCheat(real, { stub, antiCheat, appId: steamAppId, switchArgs: args }))) {
          return { ok: true, cancelled: true, target: launcher, via, args, stub, antiCheat };
        }
        const steamExe = steamAppId ? library.steamExe() : null;
        if (steamAppId && !steamExe) {
          await shell.openExternal(`steam://run/${steamAppId}//${args.join(' ')}/`);
        } else {
          const file = steamExe || launcher;
          const argv = steamExe ? ['-applaunch', String(steamAppId), ...args] : args;
          await startDetached(file, argv, { cwd: steamExe ? path.dirname(steamExe) : dir });
        }
        return { ok: true, target: launcher, via, args, steamAppId, stub, antiCheat };
      }
      if (dryRun) return { ok: true, target: real, via: 'exe-no-anticheat', steamAppId, stub, antiCheat };
      if (!(await confirmLaunchWithoutAntiCheat(real, { stub, antiCheat, appId: steamAppId }))) {
        return { ok: true, cancelled: true, target: real, via: 'exe-no-anticheat', stub, antiCheat };
      }
      // steam_api64.dll reads SteamAppId (or steam_appid.txt) to initialise when the game was not
      // started by Steam itself. Passed in the environment rather than written into the game
      // folder: nothing to clean up afterwards, and no file for a verify-files pass to fight over.
      // Steam still has to be running and still has to own the game -- this is not a DRM bypass.
      const env = { ...process.env };
      if (steamAppId) { env.SteamAppId = String(steamAppId); env.SteamGameId = String(steamAppId); }
      // `real`, not `target`: when the card holds the stub itself, target is the stub.
      const started = await startDetached(real, [], { cwd: dir, env });
      return { ok: true, target: real, via: 'exe-no-anticheat', elevated: started.elevated, steamAppId, stub, antiCheat };
    }
    // A Steam-installed game goes through Steam: its DRM, overlay, cloud saves and launch
    // options all expect that, and some games refuse to start any other way. Steam then runs the
    // same exe (through the game's own stub where it has one). Everything else runs directly.
    if (steamAppId) {
      // rungameid takes no arguments at all, so a game that needs one goes through run/<id>//args/
      // -- the form the anti-cheat switch below already uses. Steam appends it to whatever the user
      // has in Launch Options rather than replacing it, and a Steam that ignores the URL's arguments
      // leaves Game Help's advice as the fallback; that advice stays, for exactly that reason.
      const url = extraArgs.length
        ? `steam://run/${steamAppId}//${encodeURIComponent(extraArgs.join(' '))}/`
        : `steam://rungameid/${steamAppId}`;
      if (!dryRun) await shell.openExternal(url);
      return { ok: true, target, via: 'steam', steamAppId, args: extraArgs.length ? extraArgs : undefined };
    }
    // A game with a launcher of its own starts through it (see findGameLauncher).
    const gameLauncher = resolveGameLauncher(target, launcher);
    if (gameLauncher) {
      let launcherElevated = false;
      // A launcher starts the game itself, so an argument handed to the launcher never reaches the
      // exe. Reported back as argsUnreachable so the caller can keep telling the user to set it in
      // the launcher, instead of the app claiming it did something it cannot do.
      if (!dryRun) ({ elevated: launcherElevated } = await startDetached(gameLauncher, [], { cwd: path.dirname(gameLauncher) }));
      return {
        ok: true, target, launcher: gameLauncher, via: 'launcher', elevated: launcherElevated,
        argsUnreachable: extraArgs.length ? extraArgs : undefined,
      };
    }
    let elevated = false;
    if (!dryRun) {
      // Detached, own folder as cwd (Unreal and Unity both resolve their data relative to it),
      // nothing inherited from this app: the game outlives the manager if it is closed.
      ({ elevated } = await startDetached(target, extraArgs, { cwd: path.dirname(target) }));
    }
    return { ok: true, target, via: 'exe', elevated, args: extraArgs.length ? extraArgs : undefined };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}
// Only the card's Launch is watched for an early close (launchwatch.js): Analyse and Verify close the
// game themselves within ~30 s, so watching them would report a false crash and offer Restore.
ipcMain.handle('game:launch', async (_evt, { exePath, launcher = 'auto', dryRun = false } = {}) => {
  // The engine reads LiveReload once, at startup -- so this is the moment it has to be right, whatever
  // happened to the ini since the last sync (a hand edit, a restore, another tool rewriting it).
  if (!dryRun && exePath) ensureLiveReload(gameDir(exePath));
  const res = await launchGame({ exePath, launcher, dryRun });
  if (res.ok && !res.cancelled && !res.antiCheat && exePath) {
    try {
      const target = launchTarget(exePath);
      const dir = path.dirname(target);
      if (stackInstalledHere(dir)) {
        const ac = antiCheatPresent(dir, target);
        if (ac) res.antiCheatRisk = ac;
      }
    } catch {}
  }
  if (res.ok && !res.cancelled && !dryRun) {
    try { watchLaunch(exePath, res); } catch {}
  }
  return res;
});

// ── Analyse game, Checks before Install, Verify install ──────────────────────
// Analyse (probe.js) and Verify (verify.js) each start the game and close it again, so only one of
// either runs at a time. Neither focuses, clicks or types into the game: some games die on a focus
// change (Assassin's Creed II), and the progress shows in this window whether it is in front or not.
let watchedLaunchBusy = null;
const sendTo = (sender, channel, payload) => { try { if (!sender.isDestroyed()) sender.send(channel, payload); } catch {} };

ipcMain.handle('game:probe', async (evt, { exePath, launcher = 'auto' } = {}) => {
  if (watchedLaunchBusy) return { ok: false, error: `${watchedLaunchBusy} is already running` };
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    watchedLaunchBusy = 'Analyse game';
    const workDir = path.join(os.tmpdir(), 'optidlss5-probe');
    const res = await probe.runProbe({
      exePath: launchTarget(exePath), execFileAsync, workDir,
      launch: () => launchGame({ exePath, launcher }),
      onProgress: (p) => sendTo(evt.sender, 'game:probe-progress', { exePath, ...p }),
    });
    if (!res.ok) return res;
    // Stored under the card's exe, which is what effectiveDetection and the proxy helpers look up.
    probe.writeFacts(probeFactsFile(), exePath, res.facts);
    return { ok: true, summary: probe.summary(res.facts), proxyHint: probe.proxyHint(res.facts), closed: res.closed, etwError: res.etwError, facts: res.facts };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  } finally {
    watchedLaunchBusy = null;
  }
});

ipcMain.handle('game:probe-facts', (_evt, { exePath } = {}) => {
  const facts = probeFactsFor(exePath);
  return { ok: true, summary: probe.summary(facts), proxyHint: probe.proxyHint(facts) };
});

async function preflightFor(exePath, detected) {
  const dir = gameDir(exePath);
  const effective = effectiveDetection(dir, exePath, detected || await detectFor(dir, exePath));
  const gpuInfo = await getGpuInfo();
  const route = recommendRoute(dir, exePath, effective, gpuInfo.vendor || 'unknown', { lumaMod: lumaModFor(exePath, effective) });
  const facts = probeFactsFor(exePath);
  let target = exePath;
  try { target = launchTarget(exePath); } catch {}
  // Every exe the game really runs as: the launch target, and the one a watched launch saw take over.
  const exes = [...new Map([target, facts && facts.realExe].filter(Boolean).map((e) => [String(e).toLowerCase(), e])).values()];
  let run = null;
  try { run = await runlog.analyzeRun(dir, { optiDir: optiScalerDirFor(dir) }); } catch {}
  const gathered = await preflight.gather({
    exePath, dir, exes, gpuInfo, detected: effective, route, run,
    ourReShade: feeder.feederDeployed(dir) || lumaue.lumaUeDeployed(dir) || dfc.dfcPresent(dir) || relimiter.ownsReShade(dir),
    probe: probe.summary(facts),
  }, { execFileAsync, detect: { antiCheatPresent, antiCheatStub } });
  return { checks: preflight.evaluate(gathered), gpuPrefs: gathered.gpuPrefs };
}

ipcMain.handle('game:preflight', async (_evt, { exePath, detected } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const { checks } = await preflightFor(exePath, detected);
    return { ok: true, checks };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// The only two things a check may do (preflight.js). Anything else a renderer asks for is refused.
ipcMain.handle('game:preflight-fix', async (_evt, { exePath, fix } = {}) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    const { checks, gpuPrefs } = await preflightFor(exePath, null);
    // Acted on as main.js computed it just now, never as the renderer sent it: the exes and the
    // folder come from this machine's own check, not from the message.
    const current = checks.find((c) => c.fix && fix && c.fix.id === fix.id);
    if (!current) return { ok: true, done: false, text: 'nothing to do any more' };
    if (current.fix.id === 'set-gpu-preference') {
      const done = await preflight.setGpuPreference(current.fix.exes, { execFileAsync, prefs: gpuPrefs });
      return { ok: true, done: true, text: `High performance set for ${done.map((d) => path.basename(d.exe)).join(', ')}` };
    }
    if (current.fix.id === 'open-folder') {
      await shell.openPath(current.fix.path);
      return { ok: true, done: true, text: 'folder opened' };
    }
    return { ok: false, error: `unknown fix ${current.fix.id}` };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('game:verify', async (evt, { exePath, launcher = 'auto', detected } = {}) => {
  if (watchedLaunchBusy) return { ok: false, error: `${watchedLaunchBusy} is already running` };
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    watchedLaunchBusy = 'Verify install';
    const res = await verify.runVerify({
      exePath: launchTarget(exePath), execFileAsync, workDir: path.join(os.tmpdir(), 'optidlss5-probe'),
      launch: () => launchGame({ exePath, launcher }),
      readRun: async () => {
        const ctx = await helpContext(exePath, detected);
        return { run: ctx.run, diag: gamehelp.diagnose(ctx) };
      },
      onProgress: (p) => sendTo(evt.sender, 'game:verify-progress', { exePath, ...p }),
    });
    return res;
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  } finally {
    watchedLaunchBusy = null;
  }
});

// Whether the game's process is up, by image name -- the one signal that works for a direct
// launch and a Steam one alike, so the help modal judges the log after the game stops, not
// while it is still writing. null when tasklist cannot say.
// Which of these games are running, from one process listing rather than one per game. The
// single-game handler below spawns a tasklist.exe of its own, which is fine for the one game a
// help modal is watching and is not fine for a grid that asks about every card every few seconds:
// twenty games would be twenty process spawns a tick, which is the shape of the problem v1.59.0
// spent its whole release removing.
ipcMain.handle('games:running', async (_evt, exePaths) => {
  try {
    const running = await runningImageSet();
    const out = {};
    for (const exePath of exePaths || []) {
      if (!exePath) continue;
      try {
        out[exePath] = running.has(path.basename(launchTarget(exePath)).toLowerCase());
      } catch {
        // A game whose exe has gone is not running, and is not a reason to give up on the rest.
        out[exePath] = false;
      }
    }
    return { ok: true, running: out };
  } catch (error) {
    return { ok: false, running: {}, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('game:running', async (_evt, { exePath } = {}) => {
  try {
    const name = path.basename(launchTarget(exePath));
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { windowsHide: true });
    return { ok: true, running: stdout.toLowerCase().includes(`"${name.toLowerCase()}"`) };
  } catch (error) {
    return { ok: false, running: null, error: String(error && error.message ? error.message : error) };
  }
});

// One process listing, as image names. games:running and the launch watch below both read it.
async function runningImageSet() {
  const { stdout } = await execFileAsync('tasklist.exe', ['/NH', '/FO', 'CSV'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return launchwatch.runningImageNames(stdout);
}

// ── Watching a launch (launchwatch.js) ───────────────────────────────────────────────────────
//
// The card's own poll only runs while this window has focus, and a game that has just started has
// taken it -- so a game that dies ten seconds in is never seen running by the grid at all. A launch
// this app started is watched here instead, focus or not, for the minute or so it takes to decide:
// one tasklist for every watched game, every few seconds, and nothing once they are all decided.
// Only a folder this app has modified is watched: an untouched game crashing is not ours to explain,
// and there would be nothing to restore.
const launchWatches = new Map(); // exe name (lower) -> { watch, exePath, dir, antiCheat, firstRun }
let launchWatchTimer = null;

const launchHistoryFile = () => path.join(userDataDir(), 'launch-watch.json');

function watchedExeFor(exePath) {
  const target = launchTarget(exePath);
  const dir = path.dirname(target);
  // A card that holds an anti-cheat stub (<Game>_BE.exe) is launched as the exe it fronts, and
  // that is the process that has to be watched.
  const stub = antiCheatStub(dir);
  if (stub && stub.gameExe && path.basename(target).toLowerCase() === stub.stub.toLowerCase()) return path.join(dir, stub.gameExe);
  return target;
}

function watchLaunch(exePath, res) {
  const target = watchedExeFor(exePath);
  const dir = path.dirname(target);
  if (!stackInstalledHere(dir)) return;
  const history = readJson(launchHistoryFile(), {});
  const firstRun = launchwatch.firstRunSinceInstall(dir, history);
  history[dir.toLowerCase()] = Date.now();
  try { writeJson(launchHistoryFile(), history); } catch {}
  const via = res.via === 'launcher' || res.via === 'launcher-no-anticheat' ? 'launcher' : res.via;
  const exeName = path.basename(target);
  launchWatches.set(exeName.toLowerCase(), {
    watch: launchwatch.createWatch({ exeName, startedAt: Date.now(), via }),
    exePath,
    dir,
    antiCheat: antiCheatPresent(dir, target),
    firstRun,
  });
  if (!launchWatchTimer) launchWatchTimer = setInterval(tickLaunchWatches, launchwatch.POLL_MS);
}

async function tickLaunchWatches() {
  if (tickLaunchWatches.busy) return;
  tickLaunchWatches.busy = true;
  try {
    let running;
    try { running = await runningImageSet(); } catch { return; }
    const now = Date.now();
    for (const [name, w] of [...launchWatches]) {
      const outcome = launchwatch.step(w.watch, running.has(name), now);
      if (!outcome) continue;
      launchWatches.delete(name);
      const notice = launchwatch.outcomeNotice(outcome, {
        exePath: w.exePath,
        antiCheat: w.antiCheat,
        canRestore: stackInstalledHere(w.dir),
        firstRun: w.firstRun,
      });
      if (!notice) continue;
      sendToWindows('game:launch-outcome', notice);
      // The game has just gone, so this window is probably behind something: say so in the taskbar.
      if (notice.kind !== 'ok') {
        for (const win of BrowserWindow.getAllWindows()) { try { if (!win.isFocused()) win.flashFrame(true); } catch {} }
      }
    }
  } finally {
    tickLaunchWatches.busy = false;
    if (!launchWatches.size) { clearInterval(launchWatchTimer); launchWatchTimer = null; }
  }
}

// ── Did something take the files Install just placed? (defender.js) ──────────────────────────
//
// The DLLs the install leaves beside the game (defender.js expectedInstallBinaries), checked a moment after it.
// Only when one is gone is Defender's history read -- one powershell.exe, only then.
function placedBinaries(dir) {
  return defender.expectedInstallBinaries(dir, readInstallMarker(dir), { companions: ENGINE_COMPANION_DLLS });
}

async function quarantineReport(targets, missing, since) {
  const hits = await defender.defenderRemovals([...missing, ...targets], { execFileAsync, since });
  return {
    ok: true,
    missing: missing.map((f) => path.basename(f)),
    // null: Defender could not be asked (another antivirus, a policy) -- the renderer says "antivirus".
    defender: hits,
  };
}

ipcMain.handle('safety:check-installed', async (_evt, { exePath, waitMs = 1500 } = {}) => {
  try {
    const dir = gameDir(exePath);
    const wait = Number(process.env.LEGACY_QUARANTINE_WAIT_MS ?? waitMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const missing = placedBinaries(dir).filter((f) => !fs.existsSync(f));
    if (!missing.length) return { ok: true, missing: [] };
    const since = launchwatch.installedAt(dir);
    return await quarantineReport([dir], missing, since ? since - 60_000 : 0);
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// After legacy.js reported dgvoodoo-quarantined: which file, and what Defender called it. The cache
// and the game folder are where it could have been taken from.
ipcMain.handle('safety:dgvoodoo-quarantine', async (_evt, { exePath } = {}) => {
  try {
    const targets = [feederCacheDir()];
    if (exePath) targets.push(gameDir(exePath));
    return await quarantineReport(targets, [], Date.now() - 15 * 60_000);
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

// Windows Security's protection history, where a quarantined file is restored or allowed. A fixed
// URI, nothing from the renderer is passed through.
ipcMain.handle('safety:open-protection-history', async () => {
  try { await shell.openExternal(defender.PROTECTION_HISTORY_URI); return { ok: true }; } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('game:open-folder', (_evt, exePath) => {
  shell.openPath(gameDir(exePath));
});

// The project's Discord server (top bar and Game Help). A permanent invite.
const DISCORD_INVITE = 'https://discord.gg/HFZTDdSNmJ';
// The project's Buy Me a Coffee page, in the top bar beside Discord. Already on the GitHub README.
const BUY_ME_A_COFFEE = 'https://buymeacoffee.com/ripplingsnake';
// The driver banner's "Get the driver" button (renderer.js). It opened nothing until 2026-09-18
// because this page was missing from the allowlist below; test/renderer-dom.test.js checks the
// renderer still asks for exactly this URL.
const NVIDIA_DRIVER_PAGE = 'https://www.nvidia.com/Download/index.aspx';

ipcMain.handle('shell:openExternal', (_evt, url) => {
  // Only the project's own GitHub (the report button), its Discord invite, and the third-party pages a
  // route sends the user to (PureDark's Upscaler Base Plugin, reengine.js; RTXMFG): not a general opener.
  if (typeof url === 'string' && (url.startsWith('https://github.com/mrcgibb9876-hash/') || url === DISCORD_INVITE || url === BUY_ME_A_COFFEE || url === NVIDIA_DRIVER_PAGE || url === reengine.PD_PLUGIN_PAGE_URL || url === rtxmfg.PROJECT_PAGE)) shell.openExternal(url);
});

// Puts a saved support bundle on the clipboard as a file (the same thing Explorer's Copy does), so
// Ctrl+V in GitHub's comment box attaches it. A browser link can carry the issue's text but never a
// file; without the GitHub App sign-in this paste is the one step left. Chromium delivers a pasted
// CF_HDROP file to the page as a File (checked 2026-09-15), which is what GitHub uploads. Only .zip
// files this app wrote into its own bundle folders qualify. The path travels in the environment,
// not in the command text.
ipcMain.handle('report:copy-zip', async (_evt, zipPath) => {
  try {
    if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
    if (typeof zipPath !== 'string' || !/\.zip$/i.test(zipPath) || !fs.existsSync(zipPath)) return { ok: false, error: 'no such zip' };
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $c = New-Object System.Collections.Specialized.StringCollection; '
      + '[void]$c.Add($env:OPTIDLSS5_ZIP); [System.Windows.Forms.Clipboard]::SetFileDropList($c)'],
    { windowsHide: true, env: { ...process.env, OPTIDLSS5_ZIP: path.resolve(zipPath) }, timeout: 15000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
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
    return await detectGameCached(gameDir(exePath), exePath);
  } catch (error) {
    return { recommend: 'unknown', reason: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('game:detect-path-if-stale', async (_evt, { exePath, stored }) => {
  const dir = exePath && fs.existsSync(exePath) ? gameDir(exePath) : null;
  if (!isDetectionStale(stored, dir, exePath)) {
    // The exe half is current, but what sits beside the exe can change without any of that: an engine
    // update copied over dxgi.dll, a ReShade added or removed. games.json kept the old reading forever,
    // and Game Help trusts it -- Batman: Arkham Knight's card said "Another OptiScaler loads first" about
    // a dxgi.dll byte-identical to this app's own build, because the saved size predated the update
    // (2026-09-15). detectFor re-reads the folder evidence (cached per folder signature); hand the
    // renderer the fresh answer whenever that evidence differs from what it saved.
    try {
      const fresh = await detectFor(dir, exePath);
      const keys = ['vulkanWrapper', 'reshadeProxy', 'optiScalerProxy', 'asiPlugins', 'antiCheat', 'protectedLauncher', 'oldShaderCompiler'];
      const changed = fresh && keys.some((k) => JSON.stringify(fresh[k] ?? null) !== JSON.stringify(stored[k] ?? null));
      return changed ? fresh : null;
    } catch {
      return null;
    }
  }
  try {
    if (!exePath || !fs.existsSync(exePath)) return { recommend: 'unknown', reason: 'executable not found' };
    return await detectGameCached(gameDir(exePath), exePath);
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
// [DlssNr] LiveReload=true in the ini the engine actually reads (host64\ on the 32-bit route). Without
// it a DX11/DX12 game never re-reads its ini after launch, and the pop-out panel and Edit change
// nothing (#123). Never throws: a locked or missing ini must not stop a launch or a save.
function ensureLiveReload(dir) {
  try {
    const iniPath = path.join(optiScalerDirFor(dir), 'OptiScaler.ini');
    if (fs.existsSync(iniPath)) return ensureIniKey(iniPath, 'DlssNr', 'LiveReload', 'true');
  } catch {}
  return false;
}

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
    const res = await netFetch(RHI_MANIFEST_URL, { headers: { 'User-Agent': GITHUB_HEADERS['User-Agent'] } });
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
    const dlRes = await netFetch(release.url, { headers: GITHUB_HEADERS });
    if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`);
    integrity.checkFinalUrl(release.url, dlRes);
    const buf = Buffer.from(await dlRes.arrayBuffer());
    integrity.verifyBuffer(buf, await integrity.expectedSha256(release.url, { headers: GITHUB_HEADERS }), path.basename(release.url));

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
//   PanelKey (DlssNr)       The DLSS 5 panel moved to Insert everywhere else (engine v2.2.7), so one
//                           key opens this app's panel whatever a game runs on. Not here: Insert is
//                           REFramework's own menu key, and its DirectInput proxy evicts OptiScaler's
//                           subclass seconds into startup, so on an RE Engine game Insert can only
//                           ever reach REFramework. The panel keeps Alt+Home (292) here -- a key that
//                           works beats a key that is consistent and does nothing.
const RE_ENGINE_HOTFIX = [
  { section: 'Menu', key: 'ShortcutKey', value: '0x14F' },
  { section: 'DlssNr', key: 'PanelKey', value: '292' },
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
    const res = await netFetch(REFRAMEWORK_RELEASES_API, { headers: GITHUB_HEADERS });
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

async function reframeworkZipDigest() {
  try {
    const res = await netFetch(REFRAMEWORK_RELEASES_API, { headers: GITHUB_HEADERS });
    if (!res.ok) return null;
    const first = (await res.json())[0];
    return integrity.digestFromAsset(((first && first.assets) || []).find((a) => a.name === 'REFramework.zip'));
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
    const dlRes = await netFetch(REFRAMEWORK_ZIP_URL, { headers: GITHUB_HEADERS });
    if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`);
    integrity.checkFinalUrl(REFRAMEWORK_ZIP_URL, dlRes);
    const buf = Buffer.from(await dlRes.arrayBuffer());
    // "latest/download" names no tag, so the digest comes from the newest release's asset. A
    // nightly published between the two requests only costs a retry.
    integrity.verifyBuffer(buf, await reframeworkZipDigest(), 'REFramework.zip');

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
async function ensureREFrameworkForGame(dir, exePath = null) {
  if (!isReEngineGame(dir)) return null;
  const destPath = path.join(dir, REFRAMEWORK_DLL_NAME);
  const pdGame = reengine.pdUpscalerGame(exePath);

  // The five RE Engine games with no DLSS of their own take the pd-upscaler build (reengine.js).
  // A standard build this app placed earlier is swapped; a hand-placed dinput8.dll is left.
  if (pdGame) {
    const marker = reengine.readBuildMarker(dir);
    const ours = !!(readInstallMarker(dir) || {}).reframework;
    if (fs.existsSync(destPath) && !(ours && (!marker || marker.build !== 'pd-upscaler'))) {
      return { installed: false, alreadyPresent: true, build: marker && marker.build ? marker.build : 'unknown', pdUpscaler: true };
    }
    const pd = await ensurePdReframeworkCache(pdGame);
    if (!pd) return { installed: false, error: 'could not fetch the pd-upscaler REFramework', pdUpscaler: true };
    await fsp.copyFile(pd.dll, destPath);
    updateInstallJournal(dir, { reframework: true });
    reengine.writeBuildMarker(dir, { build: 'pd-upscaler', revision: pd.revision });
    return { installed: true, version: pd.revision || 'unknown', build: 'pd-upscaler', pdUpscaler: true };
  }

  if (fs.existsSync(destPath)) return { installed: false, alreadyPresent: true };

  const cachedDll = await ensureREFrameworkCache();
  if (!cachedDll) return { installed: false, error: 'could not fetch REFramework' };

  await fsp.copyFile(cachedDll, destPath);
  updateInstallJournal(dir, { reframework: true });
  reengine.writeBuildMarker(dir, { build: 'standard' });
  return { installed: true, version: fs.existsSync(path.join(reframeworkCacheDir(), '.version'))
    ? fs.readFileSync(path.join(reframeworkCacheDir(), '.version'), 'utf-8').trim() : 'unknown' };
}

// The pd-upscaler REFramework build for one game, cached per game in the app data folder.
//
// Per game because the source is: the build moved from praydog's nightly.link artifact (404 since
// at least 2026-09-13 -- that route was silently broken for every RE game) to TheRazerMD's
// releases, which publish RE2.zip, RE3.zip and so on separately. See reengine.js for why.
// A fetch that fails falls back to whatever is already cached for that game.
async function ensurePdReframeworkCache(game) {
  if (!game) return null;
  const cacheDir = path.join(userDataDir(), 'reframework-pd-cache', game);
  const cachedDll = path.join(cacheDir, REFRAMEWORK_DLL_NAME);
  const revisionFile = path.join(cacheDir, '.revision');
  const cached = () => (fs.existsSync(cachedDll)
    ? { dll: cachedDll, revision: fs.existsSync(revisionFile) ? fs.readFileSync(revisionFile, 'utf-8').trim() : null }
    : null);
  if (cached()) return cached();
  const tmpZip = path.join(os.tmpdir(), `dlss5ui-pd-reframework-${Date.now()}.zip`);
  try {
    const listRes = await feeder.fetchWithRetry(reengine.PD_UPSCALER_RELEASES_API, { headers: GITHUB_HEADERS });
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status} listing ${reengine.PD_UPSCALER_SOURCE_LABEL}`);
    const releases = await listRes.json();
    const wanted = reengine.pdUpscalerAssetName(game).toLowerCase();
    // The newest release that actually carries this game's asset -- a release can be cut for one
    // game and not another, and taking a different game's build would attach to the wrong type
    // database and fail in the game rather than here.
    let asset = null;
    for (const release of Array.isArray(releases) ? releases : []) {
      asset = (release.assets || []).find((a) => String(a.name).toLowerCase() === wanted);
      if (asset) break;
    }
    if (!asset) throw new Error(`no ${reengine.pdUpscalerAssetName(game)} in ${reengine.PD_UPSCALER_SOURCE_LABEL}`);
    const res = await feeder.fetchWithRetry(asset.browser_download_url, { headers: GITHUB_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    integrity.checkFinalUrl(asset.browser_download_url, res);
    const pdBuf = Buffer.from(await res.arrayBuffer());
    integrity.verifyBuffer(pdBuf, integrity.digestFromAsset(asset), asset.name);
    await fsp.writeFile(tmpZip, pdBuf);
    await fsp.mkdir(cacheDir, { recursive: true });
    const revision = reengine.extractPdReframework(tmpZip, cachedDll);
    if (revision) await fsp.writeFile(revisionFile, revision, 'utf-8');
    return cached();
  } catch {
    return cached();
  } finally {
    fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
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

// See the Feeder branch in autoConfigureGame() for the measurement behind this one.
const FEEDER_PRE_SR_OFF = [
  { section: 'DlssNr', key: 'RunBeforeSR', value: 'false' },
];

// The two keys that decide whether the Feeder's NGX calls reach OptiScaler at all. The Feeder's own
// log names exactly these when the driver answers its probe instead of OptiScaler ("[Inputs]
// EnableDlssInputs must be true and [Hooks] HookOriginalNvngxOnly false"), and its README repeats
// them as the two that can undo the redirect. Both are OptiScaler's defaults, so forcing them only
// ever corrects a hand-set value -- and a hand-set value here is a neural pass that never runs.
const FEEDER_NGX_REDIRECT = [
  { section: 'Inputs', key: 'EnableDlssInputs', value: 'true' },
  { section: 'Hooks', key: 'HookOriginalNvngxOnly', value: 'false' },
];

// How the Feeder's own installer sets up OptiScaler as the neural consumer (Install-DLSS5Feeder.ps1,
// `-Consumer OptiScaler`): the inputs it will never see on this route off, the spoofs for
// non-NVIDIA cards off, no update check from inside the game. Defaults, in the installer's own
// sense -- "a key the user has already set by hand (anything but auto) is left alone".
const FEEDER_CONSUMER_DEFAULTS = [
  { section: 'Spoofing', key: 'Dxgi', value: 'false' },
  { section: 'Spoofing', key: 'StreamlineSpoofing', value: 'false' },
  { section: 'Inputs', key: 'EnableXeSSInputs', value: 'false' },
  { section: 'Inputs', key: 'EnableFsr2Inputs', value: 'false' },
  { section: 'Inputs', key: 'EnableFsr3Inputs', value: 'false' },
  { section: 'Inputs', key: 'EnableFfxInputs', value: 'false' },
  { section: 'Hotfix', key: 'CheckForUpdate', value: 'false' },
];

// The panel's Inspect tools, put back to neutral whenever this app configures a game.
//
// They are session tools that persist like preferences, and one of them costs people hours.
// "Hold frame" freezes the frame the model works on; the game's own HUD and post-processing run
// after the pass and keep updating, and the panel's own help says "close the panel and it stays
// held". So: tick it once while exploring, close the panel, and every launch from then on is a
// frozen picture with a live game behind it -- which reads as a broken install rather than as a
// setting, and reinstalling never helps, because reinstalling never touched the ini key.
//
// Reported by a user on two DX12 games with no upscaler of their own (Doom 3 BFG with the DX12 mod,
// A Plague Tale: Innocence): "everything activated and OptiScaler was reading the feeder, but it
// became a freeze frame with the game running fine behind" -- and they could not reproduce their
// one working run afterwards. That is this key, persisted.
//
// Compare (side by side / wipe), DebugView (vectors, depth or masks instead of the picture) and
// ApplyModel=false have the same shape and the same silent persistence.
//
// Forced at configure time only -- Install, Reconfigure, a Feeder deploy. Nothing fights the panel
// during a session, so the tools behave exactly as before while they are being used; they just do
// not outlive the app touching the game again. It also makes Reconfigure a real answer to "it looks
// frozen and I have no idea why".
const INSPECT_NEUTRAL = [
  { section: 'DlssNr', key: 'HoldFrame', value: 'false' },
  { section: 'DlssNr', key: 'Compare', value: '0' },
  { section: 'DlssNr', key: 'CompareSwap', value: 'false' },
  { section: 'DlssNr', key: 'DebugView', value: '0' },
  { section: 'DlssNr', key: 'ApplyModel', value: 'true' },
];

// OptiScaler's own Frame Generation, opted into per game -- see optiFgReadiness() below for
// why this only ever applies to a D3D12 game. Plain ini config with no Streamline dependency.
//
// Two generators, chosen per game (2026-09-23): XeFG -- OptiScaler's own verdict is "heaviest, but
// best universal FG", and the best with HUDs -- and FSR FG (FSR 3.1, FSR 4 on RDNA4), lighter. Which
// one is fixed at launch: OptiScaler builds it into the swapchain the game creates, once per session.
// Whether it STARTS on is a separate choice, because arming a generator is what makes it switchable at
// all: with FGOutput set and Enabled=false the swapchain is still built with it, and the DLSS 5 panel,
// the pop-out and OptiScaler's End key turn it on and off live.
const OPTIFG_GENERATORS = ['xefg', 'fsrfg'];
const OPTIFG_DEFAULT_GENERATOR = 'xefg';

// Not armed: the generator this app put there comes back out, not only switched off. Enabled=false alone
// leaves it built into the swapchain every launch -- the always-armed state that is meant to be a
// per-game choice. Only our own values are cleared; an FGOutput someone set by hand is theirs.
function optiFgDisarm(iniPath) {
  let text = '';
  try { text = fs.readFileSync(iniPath, 'utf-8'); } catch { return []; }
  const out = (/^\s*FGOutput\s*=\s*(\S+)/im.exec(text) || [])[1];
  if (!out || !OPTIFG_GENERATORS.includes(out.toLowerCase())) return [];
  return [
    { section: 'FrameGen', key: 'FGOutput', value: 'auto' },
    { section: 'FrameGen', key: 'FGInput', value: 'auto' },
  ];
}

function optiFgForced({ generator, startOn }) {
  return [
    { section: 'FrameGen', key: 'Enabled', value: startOn ? 'true' : 'false' },
    { section: 'FrameGen', key: 'FGInput', value: 'upscaler' },
    { section: 'FrameGen', key: 'FGOutput', value: generator },
  ];
}

// Persisted per game-folder, not in games.json -- same reasoning as feederDeployed(): this has
// to survive being read by any entry point that calls autoConfigureGame (game:install,
// game:sync-if-stale), not just the one IPC call that set it.
//
// JSON { generator, startOn } since 2026-09-23. Before that the file held only a timestamp and meant
// "FSR FG, on" -- which is how an old one still reads.
const OPTIFG_MARKER = '.dlss5ui-optifg-enabled';

function readOptiFg(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, OPTIFG_MARKER), 'utf-8'); } catch { return null; }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        generator: OPTIFG_GENERATORS.includes(parsed.generator) ? parsed.generator : OPTIFG_DEFAULT_GENERATOR,
        startOn: parsed.startOn !== false,
      };
    }
  } catch {}
  return { generator: 'fsrfg', startOn: true };
}

function isOptiFgEnabled(dir) {
  return readOptiFg(dir) !== null;
}

// generator null (or 'none') removes it; otherwise one of OPTIFG_GENERATORS.
function setOptiFg(dir, { generator, startOn = false } = {}) {
  const marker = path.join(dir, OPTIFG_MARKER);
  if (!generator || generator === 'none') {
    if (fs.existsSync(marker)) fs.rmSync(marker);
    return;
  }
  if (!OPTIFG_GENERATORS.includes(generator)) throw new Error(`${generator} is not a frame generator this app offers`);
  fs.writeFileSync(marker, JSON.stringify({ generator, startOn: !!startOn, at: new Date().toISOString() }, null, 2), 'utf-8');
}

// Kept for the one caller that only ever switches it off (Lossless Scaling taking over).
function setOptiFgEnabled(dir, enabled) {
  if (!enabled) setOptiFg(dir, { generator: null });
  else setOptiFg(dir, { generator: (readOptiFg(dir) || {}).generator || OPTIFG_DEFAULT_GENERATOR, startOn: true });
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
  // A game with DLSS Frame Generation of its own keeps it: it has the game's real motion vectors and
  // a HUD-less frame, so it is better than either of these -- and OptiScaler's FG next to a game's own
  // Streamline is what TDR-crashed Cyberpunk 2077 (2026-09-08). Its multiplier is on the DLSS 5 panel.
  if (framegen.frameGenSwapState(dir).hasFrameGen) {
    return { supported: false, reason: 'This game has NVIDIA DLSS Frame Generation of its own, which is better than OptiScaler\'s -- turn it on in the game\'s settings. Its multiplier is on the DLSS 5 panel.' };
  }
  // What each generator needs, from OptiScaler's own release payload (copied to OptiScaler\ by Install).
  const has = (...files) => files.every((f) => fs.existsSync(path.join(dir, 'OptiScaler', f)));
  const available = {
    xefg: has('libxess_fg.dll', 'libxell.dll'),
    fsrfg: has('amd_fidelityfx_loader_dx12.dll', 'amd_fidelityfx_framegeneration_dx12.dll'),
  };
  if (!available.xefg && !available.fsrfg) {
    return { supported: false, reason: 'The frame generation files are missing from this game\'s OptiScaler folder -- install OptiScaler for this game first (Install button).' };
  }
  const current = readOptiFg(dir);
  return {
    supported: true,
    enabled: current !== null,
    generator: current ? current.generator : 'none',
    startOn: current ? current.startOn : false,
    available,
    recommended: available.xefg ? 'xefg' : 'fsrfg',
  };
}

async function autoConfigureGame(dir, exePath) {
  const iniPath = path.join(dir, 'OptiScaler.ini');
  if (!fs.existsSync(iniPath)) return { api: null, applied: [] };

  const { api, apis } = effectiveDetection(dir, exePath, await detectFor(dir, exePath));
  let dlss5Only = hasNativeDlss(dir);
  // hasNativeDlss() just checks for nvngx_dlss.dll on disk -- for a Feeder game that file was
  // placed by the Feeder deploy itself, not the game, so this alone can't tell native DLSS
  // apart from Feeder-supplied. Excluded explicitly: Feeder + FSRFG crashed on a real game
  // (confirmed via a symbolicated minidump) -- see optiFgReadiness's own guard above.
  const feederGame = isFeederGame(dir);
  // The same gates as optiFgReadiness, enforced here too, so a marker left behind (the game gained
  // DLSS-G in an update, or became a Feeder game) never arms a generator that should not be there.
  const optiFg = readOptiFg(dir);
  const optiFgOn = !!optiFg && dlss5Only && api === 'dx12' && !feederGame && !framegen.frameGenSwapState(dir).hasFrameGen;
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

  // The engine only polls its ini for changes when it thinks the in-game panel is out of reach, and
  // it decides that by asking whether it is running in the 32-bit route's helper. On an OpenGL or
  // Vulkan game that misses this case: OptiScaler is in the game's own process, so it answers "the
  // panel is right there on a keypress" -- but there is no DXGI swapchain for it to draw on, the
  // menu never initialises, and Alt+Home does nothing. The ini is the only way in, and it was the
  // one route where the engine had stopped reading it.
  //
  // Tomb Raider I-III Remastered, 2026-09-16: "Live settings reload: off (this game can open the
  // panel itself)" in a log with zero menu lines in it. Every edit from the pop-out panel and from
  // Edit here sat on disk unread, which is exactly what it looked like from the outside -- controls
  // that changed nothing.
  //
  // Every game, not only those two (2026-09-23). The pop-out panel is nothing but writes to this
  // file, and on an ordinary DX11/DX12 game the engine's default is to never read it again after
  // launch -- so the pop-out changed nothing on any of them. MSFS 2024 (#123): with OverlayMenu=false
  // the pop-out was the only panel left, and switching DLSS 5 off in it "did nothing, the visuals did
  // not change". The cost is one file-time check every 250 ms.
  //
  // ensureIniKey, not an edit for patchIniDefaults: OptiScaler's template has no LiveReload line, so
  // it only exists once the engine has saved the ini itself, and patchIniDefaults only rewrites lines
  // already there. As an edit this silently did nothing on a fresh install -- the OpenGL/Vulkan case
  // included (Shadow of the Tomb Raider's ini had no such line at all). Runs on every configure, so a
  // line anyone or anything removes is put back on the next sync or launch.
  const liveReload = ensureIniKey(iniPath, 'DlssNr', 'LiveReload', 'true')
    ? [{ section: 'DlssNr', key: 'LiveReload', value: 'true' }] : [];

  const reEngine = isReEngineGame(dir);
  let reframework = null;
  let reframeworkConfig = [];
  let reEngineHotfix = [];
  if (reEngine) {
    reEngineHotfix = patchIniValues(iniPath, RE_ENGINE_HOTFIX);

    // OptiScaler doesn't work on RE Engine without REFramework already present -- ensure it's
    // there before anything else here matters.
    reframework = await ensureREFrameworkForGame(dir, exePath);
    reframeworkConfig = fixREFrameworkConfig(dir);
    // RE2/3/4/7/Village take the engine's Present route now (reengine.js): DLSS 5 at Present over the
    // game's own TAA, depth found by the engine. No DLSS call is involved, so nvngx_dlss.dll and
    // PureDark's plugin are no longer placed. What this app placed for the old pd route goes -- the
    // plugin copy only when the journal proves it is ours -- and REFramework's TemporalUpscaler is
    // switched off, since that mod swaps the game's TAA for a DLSS call nothing answers any more.
    // Runs on Install and on every sync, so a game set up the old way is moved over on its own.
    if (reengine.presentRouteGame(exePath)) {
      const presentRoute = { temporalUpscalerOff: reengine.presentRouteConfigure(dir), pluginRemoved: false, feederRemoved: false };
      // A Feeder this app deployed (its deploy marker says so) is the old route on these games, and it
      // stops the Present route from running at all: its ReShade wraps the D3D12 device. Taken out, with
      // OptiScaler's ReShade loading switched back to auto. One placed by hand is left.
      try {
        if (feeder.feederDeployed(dir) && fs.existsSync(path.join(dir, '.dlss5ui-feeder-deploy.json'))) {
          const removed = await feeder.removeFeederStack(dir, { keepReShade: lumaue.lumaUeDeployed(dir) });
          if (!lumaue.lumaUeDeployed(dir)) patchIniValues(iniPath, [{ section: 'Plugins', key: 'LoadReshade', value: 'auto' }]);
          presentRoute.feederRemoved = removed.removed.length > 0;
        }
      } catch (e) {
        presentRoute.feederError = String(e && e.message ? e.message : e);
      }
      try {
        const journal = readInstallMarker(dir) || {};
        if (journal.pdPlugin && pdplugin.isOurCopy(dir, journal.pdPlugin)) {
          await fsp.rm(path.join(dir, pdplugin.PLUGIN_NAME), { force: true });
          updateInstallJournal(dir, { pdPlugin: null });
          presentRoute.pluginRemoved = true;
        }
      } catch (e) {
        presentRoute.pluginError = String(e && e.message ? e.message : e);
      }
      reframework = { ...(reframework || {}), presentRoute };
    }
  }

  // Elden Ring / Armored Core VI / Nightreign (presentroute.js): the Present route by ini, and no Feeder --
  // the one this app deployed is the old route that crashed the model, and it would stop this one running.
  // A Placement set by hand to "evaluate" is left alone. Install and every sync.
  if (presentroute.iniPresentGame(exePath)) {
    try {
      if (feeder.feederDeployed(dir) && fs.existsSync(path.join(dir, '.dlss5ui-feeder-deploy.json'))) {
        await feeder.removeFeederStack(dir, { keepReShade: lumaue.lumaUeDeployed(dir) });
        if (!lumaue.lumaUeDeployed(dir)) patchIniValues(iniPath, [{ section: 'Plugins', key: 'LoadReshade', value: 'auto' }]);
      }
    } catch {}
    // ensureIniKey, not a default: installs from before Placement existed have no such line to fill in.
    const placement = (readIniKey(iniPath, 'DlssNr', 'Placement') || '').toLowerCase();
    if (placement !== 'present' && placement !== 'evaluate') ensureIniKey(iniPath, 'DlssNr', 'Placement', 'present');
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

  // The Feeder's installer's own consumer set-up for OptiScaler, as defaults (FEEDER_CONSUMER_DEFAULTS).
  if (feederGame && feeder.feederDeployed(dir)) edits.push(...FEEDER_CONSUMER_DEFAULTS);

  const applied = [...liveReload, ...patchIniDefaults(iniPath, edits)];
  // A DLSS-5-only game keeps its own DLSS whether or not OptiFG is layered on -- see
  // keepGamesOwnDlss for why the upscaler key cannot be left at auto.
  // A Feeder game's DLSS call always arrives on a private D3D12 device -- on D3D11, Vulkan
  // and OpenGL games too (the Feeder's README: "Dx12Upscaler=dlss" for the DLSS-NR consumer)
  // -- so the D3D12 key is set whatever API the game itself renders with.
  const upscalerApis = feederGame ? [...new Set([...apis, 'dx12'])] : apis;
  let forced = dlss5Only
    ? patchIniValues(iniPath, [...(optiFgOn ? optiFgForced(optiFg) : [...DLSS5_ONLY_FORCED, ...optiFgDisarm(iniPath)]), ...keepGamesOwnDlss(upscalerApis)])
    : [];
  // ReLimiter is a ReShade add-on and is driven by ReShade's present event, so wherever it is deployed
  // OptiScaler has to load ReShade (below). On an ordinary OptiScaler game that is only allowed with an
  // engine that keeps NGX's device alive and a frame generator ReShade can see
  // (pacingBesideUpscalerBlocker; relimiter:install and dropBlockedPacing enforce it). Deliberately NOT
  // tied to dlss5Only above: ReLimiter is a frame pacer, not an upscaler, so adding
  // it must never narrow OptiScaler into NR-only mode. A user who turns on frame pacing and silently
  // loses their upscaler has been handed a worse app.
  const relimiterHere = relimiter.deployed(dir);
  // ReLimiter and [DlssNr] AutoScale in frame-rate mode both aim at a frame rate, and together the
  // model sheds resolution chasing a gap the limiter will never let close (see relimiter.js). Ours is
  // the one that gives way: the user deployed a frame pacer to pace frames. Applied through
  // patchIniValues so it lands in `forced` and the app SAYS it changed a setting -- one that turns
  // itself off in silence is a bug report waiting to happen.
  if (relimiterHere) {
    const conflict = relimiter.nrConflict({
      autoScale: readIniKey(iniPath, 'DlssNr', 'AutoScale'),
      autoScaleMode: readIniKey(iniPath, 'DlssNr', 'AutoScaleMode'),
    });
    if (conflict) forced = [...forced, ...patchIniValues(iniPath, relimiter.NR_CONFLICT_EDITS)];
  }
  // Frame pacing on a non-Feeder game needs the same: OptiScaler leaves LoadReshade off by default, so
  // without this the ReShade64.dll placed for ReLimiter would never load. relimiter:install and
  // dropBlockedPacing keep pacing off the games where it would crash or see no frames.
  // RenoDX (any kind: 'addon' from the picker) is loaded by the same ReShade and needs the same line;
  // addons:install writes it once, and this keeps it written on every sync as it does for pacing.
  if ((feederGame && feeder.feederDeployed(dir)) || relimiterHere || addons.installedAddonIds(dir).length > 0) {
    // Only where ReShade is the plain ReShade64.dll beside the exe. As the game's opengl32.dll
    // or as the Vulkan layer it is already in the process, and a second copy loaded by
    // OptiScaler would be two ReShades.
    const local = feeder.feederDeployed(dir)
      ? feeder.feederReShadeMode(dir) === 'local'
      : relimiter.reshadeModeFor(api || 'dx12') === 'local';
    forced = [...forced, ...patchIniValues(iniPath, local ? LOAD_RESHADE_FORCED : [{ section: 'Plugins', key: 'LoadReshade', value: 'false' }])];
  }
  // Everything below is the Feeder's alone. ReLimiter shares only the ReShade loading above: on a
  // native-DLSS game with frame pacing, Pre-SR is the user's real choice and the game's own NGX calls
  // must not be redirected.
  if (feederGame && feeder.feederDeployed(dir)) {
    // Neural Rendering before Super Resolution: off, on a Feeder game specifically.
    //
    // Measured on Armored Core VI (2026-09-13) -- same game, same frame contract, one setting
    // apart, twice each way. With RunBeforeSR off the model evaluated (1.99 ms measured) and
    // frames were delivered; with it on, the evaluate faulted inside nvngx_dlssnr.dll reading
    // 0xFFFFFFFFFFFFFFFF and the feed stopped on the spot.
    //
    // Pre-SR runs the neural pass on the game's own pre-upscale colour. A Feeder game has no such
    // thing: the "upscaler input" is a synthetic DLAA contract the Feeder builds out of ReShade's
    // capture, so the placement the setting asks for is not there to use. Forced rather than
    // defaulted, like the keys above, because the in-game panel writes this one back on every
    // change -- and a crash is not a preference. The panel can still turn it on for a native-DLSS
    // game, where it is a real choice and works.
    forced = [...forced, ...patchIniValues(iniPath, FEEDER_PRE_SR_OFF)];
    // And the redirect itself: without these two at their defaults the driver answers the Feeder's
    // NGX calls and OptiScaler, loaded or not, sees nothing (FEEDER_NGX_REDIRECT).
    forced = [...forced, ...patchIniValues(iniPath, FEEDER_NGX_REDIRECT)];
  }
  // Luma UE deploys its own ReShade64.dll the same non-proxying way the Feeder does (see
  // lumaue.js's file header) -- OptiScaler needs the same explicit LoadReshade nudge to load it.
  if (lumaue.lumaUeDeployed(dir)) forced = [...forced, ...patchIniValues(iniPath, LOAD_RESHADE_FORCED)];
  // Every game, not just the Feeder ones: a stuck Inspect tool looks like a broken install on any
  // of them, and none of these is a preference worth carrying across a reconfigure.
  forced = [...forced, ...patchIniValues(iniPath, INSPECT_NEUTRAL)];
  forced = [...forced, ...applyLosslessMarker(dir)];
  forced = [...forced, ...applyFrameGenMarker(dir)];
  forced = [...forced, ...applyEngineMarker(dir)];
  forced = [...forced, ...applyPanelLanguage(dir)];
  forced = [...forced, ...applyNrOn(dir)];
  return {
    api, applied: [...applied, ...forced], streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix,
    profile: dlss5Only ? (optiFgOn ? 'dlss5-only+optifg' : 'dlss5-only') : 'full',
  };
}

const PROXY_CANDIDATES = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll', 'd3d12.dll', 'wininet.dll', 'winhttp.dll', 'OptiScaler.asi'];

// Keyed on size and mtime, so a file that changes is hashed again and one that has not is not.
// The release OptiScaler.dll is 26 MB and sync-if-stale hashes it to compare against every
// installed game: twenty games meant reading and hashing half a gigabyte per sync pass.
const hashCache = new Map();
const HASH_CACHE_MAX = 64;

function sha256File(filePath) {
  let key = null;
  try {
    const st = fs.statSync(filePath);
    key = `${filePath}|${st.size}|${st.mtimeMs}`;
    const hit = hashCache.get(key);
    if (hit) return hit;
  } catch {}
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (key) {
    if (hashCache.size >= HASH_CACHE_MAX) hashCache.delete(hashCache.keys().next().value);
    hashCache.set(key, hash);
  }
  return hash;
}

async function findActiveOptiScalerFile(dir) {
  const rtxmfgFile = (rtxmfg.ourFile(dir) || '').toLowerCase();
  const present = PROXY_CANDIDATES.filter((name) => name.toLowerCase() !== rtxmfgFile && fs.existsSync(path.join(dir, name)));
  if (present.length === 0) {
    const plain = path.join(dir, 'OptiScaler.dll');
    return fs.existsSync(plain) ? { file: plain, renamed: false } : null;
  }
  // OriginalFilename is read out of the PE version resource directly (detect.js). This used to
  // ask PowerShell for it -- Get-Item .VersionInfo -- which is correct but costs about 700 ms per
  // game folder in process start-up alone: fifteen seconds of the main process across twenty
  // installed games, on every sync pass, for an answer that takes 1.5 ms to read. Checked against
  // the PowerShell it replaces on all twenty installed games: the same answer every time.
  try {
    for (const name of present) {
      const orig = peOriginalFilename(path.join(dir, name));
      if ((orig || '').toLowerCase() === 'optiscaler.dll') return { file: path.join(dir, name), renamed: true };
    }
  } catch {
  }
  // One proxy-named DLL and no version resource to say what it is: only OptiScaler if its bytes say
  // so. Without this check a game's own dxgi.dll (or one just restored from a backup) was taken for
  // OptiScaler -- Remove deleted it, and a sync could have copied OptiScaler over it.
  if (present.length === 1) {
    const file = path.join(dir, present[0]);
    try {
      if (fs.readFileSync(file).includes(Buffer.from('OptiScaler', 'latin1'))) return { file, renamed: true };
    } catch {}
  }
  return null;
}

// The engine DLL alone brought up to the release, for a game kept as is: the full sync below does the
// same copy among everything else it keeps current.
async function copyEngineIfStale(dir, releaseFolder) {
  const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
  if (!releaseDll || !fs.existsSync(releaseDll) || !hasDlssNrSection(releaseFolder)) return false;
  const legacyMarker = legacy.readMarker(dir);
  if (legacyMarker && legacyMarker.host32) {
    const hostDll = path.join(dir, legacy.HOST_DIR, 'winmm.dll');
    if (!fs.existsSync(hostDll) || sha256File(releaseDll) === sha256File(hostDll)) return false;
    await fsp.copyFile(releaseDll, hostDll);
    return true;
  }
  if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return false;
  const active = await findActiveOptiScalerFile(dir);
  if (!active || sha256File(releaseDll) === sha256File(active.file)) return false;
  await fsp.copyFile(releaseDll, active.file);
  const plain = path.join(dir, 'OptiScaler.dll');
  if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});
  invalidateDetection(dir);
  return true;
}

async function syncGameIfStale(_evt, { exePath, releaseFolder, nrDllPath }) {
  try {
    // OPTIDLSS5_NO_SYNC=1: a second copy of the app (screenshots, a demo, a source checkout pointed at a
    // real library) that must not touch game folders the installed app already manages.
    if (process.env.OPTIDLSS5_NO_SYNC === '1') return { ok: true, updated: false, reason: 'sync disabled' };
    if (!exePath || !fs.existsSync(exePath)) return { ok: true, updated: false, reason: 'exe missing' };
    const dir = gameDir(exePath);
    // The user asked for this game to be left as it is: no NR model update, no ini or REFramework
    // changes on sync. Install, Edit and Remove still act when pressed. The engine is the exception: a
    // library on two engines has an in-game panel, ini keys and Manager rows that disagree game to game
    // (2026-09-22: Cyberpunk held on a test build by a forgotten marker showed none of v2.2.6's rows).
    if (keptAsIs(dir)) {
      const engineUpdated = await copyEngineIfStale(dir, releaseFolder);
      return { ok: true, updated: engineUpdated, reason: 'kept as is' };
    }
    // A 32-bit game on the helper route: its OptiScaler (winmm.dll) and NR model are in host64\ and
    // follow the engine and model in Settings the same way.
    const legacyMarker = legacy.readMarker(dir);
    // For ensureDgVoodooWindowed below: which vendor dgVoodoo names itself as to the game (legacy.js
    // DG_ADAPTER_ID_TYPES). getGpuInfo is memoised, so this is an already-resolved promise per game
    // and not per-game work -- the rule that keeps sync off the 52-second path.
    const gpuVendor = ((await getGpuInfo()) || {}).vendor || null;
    if (legacyMarker && legacyMarker.host32) {
      const hostDir = path.join(dir, legacy.HOST_DIR);
      let updated = false;
      let nrUpdated = false;
      const releaseDll = releaseFolder ? path.join(releaseFolder, 'OptiScaler.dll') : null;
      const hostDll = path.join(hostDir, 'winmm.dll');
      if (releaseDll && fs.existsSync(releaseDll) && hasDlssNrSection(releaseFolder) && fs.existsSync(hostDll) && sha256File(releaseDll) !== sha256File(hostDll)) {
        await fsp.copyFile(releaseDll, hostDll);
        updated = true;
      }
      // The engine's companions follow it into the helper folder, as they do beside a 64-bit game.
      if (releaseDll && fs.existsSync(hostDll) && hasDlssNrSection(releaseFolder)) {
        for (const name of engineCompanionsIn(releaseFolder)) {
          const src = path.join(releaseFolder, name);
          const dest = path.join(hostDir, name);
          if (!fs.existsSync(src) || (fs.existsSync(dest) && sha256File(src) === sha256File(dest))) continue;
          await fsp.copyFile(src, dest);
          updated = true;
        }
      }
      const hostNr = path.join(hostDir, 'nvngx_dlssnr.dll');
      if (nrDllPath && fs.existsSync(nrDllPath) && fs.existsSync(hostNr) && fs.statSync(hostNr).size !== fs.statSync(nrDllPath).size) {
        await fsp.copyFile(nrDllPath, hostNr);
        nrUpdated = true;
      }
      try { applyPanelLanguage(hostDir); } catch {}
      try { applyNrOn(hostDir); } catch {}
      // Installs from before 32-bit DirectX 8/9 games were held in a borderless window (legacy.js
      // DG_WINDOWED): an exclusive-fullscreen game can freeze the moment the helper starts.
      let dgWindowed = false;
      try { dgWindowed = legacy.ensureDgVoodooWindowed(dir, { vendor: gpuVendor }); } catch {}
      // Installs from before the deploy gave the in-game panel its Alt+Home key (legacy.js ensureCastKey).
      try { legacy.ensureCastKey(dir); } catch {}
      // The Feeder follows its releases here too. A locked file (the game running) is thrown, so the
      // sync fails and the renderer retries once the game closes.
      let feederUpdated = null;
      const feederZip = await latestFeederZip();
      if (feederZip) {
        const refreshed = await legacy.refreshFeeder32(dir, feederZip);
        if (refreshed.updated) feederUpdated = { files: refreshed.files };
      }
      // Installs from before High performance was set for the helper (Feeder #100, 2026-09-19).
      await preferDiscreteGpu(dir, exePath, { onlyNew: true });
      return { ok: true, updated: updated || nrUpdated || !!feederUpdated, nrUpdated, feederUpdated, dgWindowed, reason: 'legacy 32-bit route', autoConfigured: [] };
    }
    // A 64-bit DirectX 8/9 game behind dgVoodoo2 gets the same scaled-to-screen display (legacy.js DG_DISPLAY).
    try { legacy.ensureDgVoodooWindowed(dir, { vendor: gpuVendor }); } catch {}
    // Luma installs from before DLSS was preset for them (lumaue.js ensureLumaDlss).
    try { lumaue.ensureLumaDlss(dir); } catch {}
    // The Feeder follows its own releases, not this app's: a game installed weeks ago kept whatever
    // add-on it was deployed with, and the fixes that matter most on this route ship in the add-on.
    let feederUpdated = null;
    try { feederUpdated = await updateFeederIfStale(dir, exePath); } catch {}
    if (!fs.existsSync(path.join(dir, 'OptiScaler.ini'))) return { ok: true, updated: !!feederUpdated, feederUpdated, reason: 'not installed' };
    await preferDiscreteGpu(dir, exePath, { onlyNew: true });

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
      return { ok: true, updated: autoConfigured.length > 0 || nrUpdated, nrUpdated, feederUpdated, reason: 'no release set', api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
    }

    if (!hasDlssNrSection(releaseFolder)) {
      return {
        ok: true, updated: autoConfigured.length > 0 || nrUpdated, nrUpdated, feederUpdated,
        reason: 'release folder is not the DLSS-NR fork (no [DlssNr] section) -- refusing to sync', api, autoConfigured, streamline, reEngine, reframework
      };
    }

    // A proxy placed under a name this game never loads (PROXY_OVERRIDES) is moved before anything else.
    let proxyMigrated = null;
    try { proxyMigrated = await migrateProxyIfNeeded(dir, exePath); } catch {}

    const active = await findActiveOptiScalerFile(dir);
    if (!active) {
      return {
        ok: true, updated: autoConfigured.length > 0 || nrUpdated || !!(proxyMigrated && !proxyMigrated.skipped), nrUpdated, feederUpdated,
        reason: 'could not identify the active OptiScaler file (ambiguous proxy candidates)', api, autoConfigured, streamline, reEngine, reframework
      };
    }

    // The engine's companion DLLs beside OptiScaler (engine v1.0.27: OptiScaler_OpticalFlow.dll, the Present
    // route's motion vectors) follow the release too -- Install copies every release file, but a game
    // installed before a companion existed would otherwise never get it.
    let companionsUpdated = false;
    for (const name of engineCompanionsIn(releaseFolder)) {
      const src = path.join(releaseFolder, name);
      const dest = path.join(dir, name);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest) && sha256File(src) === sha256File(dest)) continue;
      try {
        await fsp.copyFile(src, dest);
        companionsUpdated = true;
      } catch {}
    }

    if (sha256File(releaseDll) === sha256File(active.file)) {
      return { ok: true, updated: autoConfigured.length > 0 || nrUpdated || companionsUpdated || !!(proxyMigrated && !proxyMigrated.skipped), nrUpdated, feederUpdated, proxyMigrated, reason: 'up to date', api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
    }

    await fsp.copyFile(releaseDll, active.file);
    const plain = path.join(dir, 'OptiScaler.dll');
    if (active.file !== plain) await fsp.copyFile(releaseDll, plain).catch(() => {});
    // Copying over an existing file leaves the folder's mtime alone, so detectSignature cannot see it:
    // without this the cached folder evidence kept the old proxy's size (see game:detect-path-if-stale).
    invalidateDetection(dir);

    return { ok: true, updated: true, nrUpdated, feederUpdated, file: path.basename(active.file), api, autoConfigured, streamline, reEngine, reframework, reframeworkConfig, reEngineHotfix };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The sync, plus noticing that the game itself updated since the last one (gameupdate.js): the exe
// fingerprint is compared before the sync -- so a changed exe drops the cached detection and the
// sync's own auto-configure re-checks the route against the new build -- and recorded after it.
// Not for a game kept as is, or with sync switched off: those folders are not ours to judge.
ipcMain.handle('game:sync-if-stale', async (evt, payload = {}) => {
  const exePath = payload && payload.exePath;
  let watch = null;
  try {
    if (process.env.OPTIDLSS5_NO_SYNC !== '1' && exePath && fs.existsSync(exePath) && !keptAsIs(gameDir(exePath))) {
      watch = gameupdate.inspect(gameupdate.storeFile(userDataDir()), exePath, gameDir(exePath));
      if (watch.changed) invalidateDetection(gameDir(exePath));
    }
  } catch { watch = null; }
  const res = await syncGameIfStale(evt, payload || {});
  if (!watch || !res || !res.ok) return res;
  try {
    const dir = gameDir(exePath);
    // The proxy OptiScaler runs under is ours too, and the file a Steam verify is likeliest to delete.
    const active = fs.existsSync(path.join(dir, 'OptiScaler.ini')) ? await findActiveOptiScalerFile(dir).catch(() => null) : null;
    const gameUpdated = gameupdate.commit(gameupdate.storeFile(userDataDir()), exePath, dir, watch, { extra: active ? [path.basename(active.file)] : [] });
    return gameUpdated ? { ...res, gameUpdated } : res;
  } catch {
    return res;
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

// DLLs the engine release carries beside OptiScaler.dll, kept current by sync and taken by Remove.
// The forwarder rides along since 2026-09-22: it was never synced, so every installed game kept the one
// it was installed with while OptiScaler.dll beside it moved on.
const ENGINE_COMPANION_DLLS = ['OptiScaler_OpticalFlow.dll', 'nvngx.dll_dlssnr.dll'];

// What sync keeps current: every DLL the release ships beside OptiScaler.dll, read from the release
// itself, plus the list above. A hand-kept list alone is how the forwarder went unsynced -- the next DLL
// the engine adds is covered without anyone remembering to add it here.
function engineCompanionsIn(releaseFolder) {
  let shipped = [];
  try {
    shipped = fs.readdirSync(releaseFolder, { withFileTypes: true })
      .filter((e) => e.isFile() && /.dll$/i.test(e.name) && !/^OptiScaler.dll$/i.test(e.name))
      .map((e) => e.name);
  } catch {}
  return [...new Set([...ENGINE_COMPANION_DLLS, ...shipped])];
}

// dxgi.dll is what the script offers as option 1 and what nearly every DX11/DX12/Vulkan game on
// Windows already loads.
const DEFAULT_PROXY = 'dxgi.dll';

// The proxy name for a game. dxgi.dll for anything Direct3D. A Vulkan or OpenGL Feeder game
// never imports dxgi.dll itself: OptiScaler would only load once the Feeder's private D3D12
// device pulled it in, too late for its loader hook to catch the Feeder's NGX module. The
// Feeder's README says winmm.dll or version.dll ("a name the process imports at start"); the
// exe's own import table says which of the candidates it actually imports.
// Lives in detect.js, and is imported rather than repeated: every name the app can install under
// has to be a name detect.js reads a folder by, and keeping one list is what makes that true.
// (The two copies had drifted -- see the HOOK_DLLS note there.)
// Games whose exe never loads a dxgi.dll from its own folder, measured one at a time. dxgi.dll works for
// nearly every Direct3D game because the system's d3d11/d3d12 pull it in through the normal search order;
// these load it some other way, so a dxgi.dll proxy sits there unused and OptiScaler never starts -- no
// log, no panel, nothing to say why. Keyed by exe name, lower case.
//
// Monster Hunter: World (2026-09-14, a user report): installed as dxgi.dll, the game ran and wrote no
// OptiScaler.log at all; its exe imports d3d11/d3d12 but not dxgi.dll. As winmm.dll, which it does import,
// OptiScaler loaded, wrapped the DX12 swapchain and was handed the game's nvngx.
//
// Red Dead Redemption 2 (2026-09-16, a user report of no log at all): the same symptom, and the
// cause is documented rather than measured here -- the game stopped loading a dxgi.dll from its own
// folder, which is why ReShade's own troubleshooting tells people to rename to d3d12.dll or go
// through the Vulkan layer. OptiScaler's wiki page for the game names winmm.dll as the proxy to
// use, with version.dll and OptiScaler.asi as the other two it accepts. RDR2.exe is the game;
// PlayRDR2.exe is Rockstar's launcher shim and never loads any of this itself.
//   https://github.com/optiscaler/OptiScaler/wiki/Red-Dead-Redemption-II
// What Edit offers. Exactly the names detect.js reads a folder by, and no others: letting someone
// pick a name the app cannot see afterwards would reproduce the drift bug by hand. dxgi.dll leads
// because it is the answer for nearly every Direct3D game.
const PROXY_CHOICE_NAMES = [...new Set(['dxgi.dll', ...EARLY_PROXY_CANDIDATES, ...HOOK_DLLS])];

//
// No Man's Sky (2026-09-25, #132): documented rather than measured, like RDR2 above, and the
// weaker of the two cases -- so what it rests on is worth writing down. The game is Vulkan with
// native DLSS, which means it is not a Feeder game, which means the early-proxy picker above never
// runs for it and it got dxgi.dll. A Vulkan game does load a dxgi.dll, but late, for adapter
// enumeration -- OptiScaler starts after the renderer is already up. OptiScaler's own wiki page
// names dbghelp.dll for exactly that reason ("Recommended to use OptiScaler as dbghelp.dll for
// early hooking"), and the reporter's verdict was init-no-feature: present, initialised, never
// asked for a feature, which is the shape a late hook produces.
//   https://github.com/optiscaler/OptiScaler/wiki/No-Man's-Sky
// Not proven here, and the honest downside is bounded on both sides: if NMS.exe does not import
// dbghelp.dll the proxy never loads and DLSS 5 does nothing -- which is what init-no-feature
// already was. And since this release the user can set the name back by hand in Edit, which is
// what makes shipping an unmeasured entry defensible at all.
const PROXY_OVERRIDES = {
  'monsterhunterworld.exe': 'winmm.dll',
  'rdr2.exe': 'winmm.dll',
  'nms.exe': 'dbghelp.dll',
};

function proxyOverrideFor(exePath) {
  return exePath ? PROXY_OVERRIDES[path.basename(exePath).toLowerCase()] || null : null;
}

// The proxy name a game should have now, when it differs from dxgi.dll for a reason: a measured override
// (PROXY_OVERRIDES), or a Feeder game on Vulkan, OpenGL or DirectX 9, where nothing loads a dxgi.dll from
// the game's folder. Star Wars: The Old Republic (2026-09-16): installed as dxgi.dll while it was still
// misread as native DLSS, it kept that name when the Feeder route replaced it -- DXVK renders it, ReShade's
// Vulkan layer loads the system dxgi.dll by full path, and the Feeder reported "OptiScaler: not present" for
// 18,000 frames of plain DLAA. Null when dxgi.dll is right.
async function wantedProxyFor(dir, exePath) {
  // The user's own choice outranks everything below it, including the measured table: they are
  // saying which DLL their copy of the game loads, and unlike the automatic answer they can watch
  // the result. Returned even when it is dxgi.dll -- picking the default back is a migration too,
  // and migrateProxyIfNeeded no-ops when it already matches the journal.
  const chosen = readProxyChoice(dir);
  if (chosen) return chosen;
  const override = proxyOverrideFor(exePath);
  if (override) return override;
  // A watched launch that saw the game ignore a dxgi.dll beside it, or never load one (probe.proxyHint).
  const observed = probe.proxyHint(probeFactsFor(exePath));
  if (observed) return observed;
  if (!isFeederGame(dir)) return null;
  const name = await proxyNameForGame(dir, exePath, true);
  return name && name.toLowerCase() !== DEFAULT_PROXY.toLowerCase() ? name : null;
}

// Moves a proxy this app placed under the wrong name to the one the game loads. Only when the journal proves
// the proxy is ours. An original of the game's backed up under the old name stays backed up where it is --
// it is not put back, since the new name is not a rename of it -- and the journal keeps the name it came
// from (backedUpAs), so Remove still restores it there. A folder where the right name already holds
// OptiScaler just has its journal corrected.
async function migrateProxyIfNeeded(dir, exePath) {
  const wanted = await wantedProxyFor(dir, exePath);
  const journal = readInstallMarker(dir);
  if (!wanted || !journal || typeof journal.proxy !== 'string' || journal.proxy.toLowerCase() === wanted.toLowerCase()) return null;

  const from = path.join(dir, journal.proxy);
  const to = path.join(dir, wanted);
  const isOptiScaler = (file) => {
    try {
      const orig = peOriginalFilename(file);
      // No version resource: OptiScaler only if its bytes say so, as findActiveOptiScalerFile decides.
      return orig ? orig.toLowerCase() === 'optiscaler.dll' : fs.readFileSync(file).includes(Buffer.from('OptiScaler', 'latin1'));
    } catch { return false; }
  };

  if (fs.existsSync(to)) {
    if (!isOptiScaler(to)) return { from: journal.proxy, to: wanted, skipped: `${wanted} is somebody else's file` };
    if (fs.existsSync(from) && isOptiScaler(from)) await fsp.rm(from, { force: true });
  } else {
    if (!fs.existsSync(from) || !isOptiScaler(from)) return null;
    await fsp.rename(from, to);
  }

  const patch = { proxy: wanted };
  if (journal.backedUp && !journal.backedUpAs) patch.backedUpAs = journal.proxy;
  updateInstallJournal(dir, patch);
  return { from: journal.proxy, to: wanted };
}

async function proxyNameForGame(dir, exePath, feederGame, { ignoreChoice = false } = {}) {
  const chosen = ignoreChoice ? null : readProxyChoice(dir);
  if (chosen) return chosen;
  const override = proxyOverrideFor(exePath);
  if (override) return override;
  const observed = probe.proxyHint(probeFactsFor(exePath));
  if (observed) return observed;
  if (!feederGame) return DEFAULT_PROXY;
  const api = await resolveApi(dir, exePath);
  // dx9: a 64-bit DirectX 9 game behind dgVoodoo2 imports no DXGI at start either (legacy.js).
  if (api !== 'vulkan' && api !== 'opengl' && api !== 'dx9') return DEFAULT_PROXY;
  const imports = await peImports(exePath);
  return EARLY_PROXY_CANDIDATES.find((name) => imports.includes(name)) || 'winmm.dll';
}

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

// nvngx_dlss.dll beside the exe, on the plain OptiScaler route. OptiScaler looks for it there
// ("Check for DLSS files") and switches DLSS off without it, so DLSS 5 has nothing to attach to.
// The Feeder and Luma deploys already place it; this route had nothing, and a game that keeps its
// DLSS elsewhere (Baldur's Gate 3, #83: the file was not beside bg3_dx11.exe) ran with DLSS off.
//
// Only for a game that ships DLSS or Streamline somewhere (shipsNativeDlss): the file beside the
// exe makes hasNativeDlss true, and on a game that needs the Feeder that would flip its route to
// plain OptiScaler before the Feeder is ever deployed. Feeder and Luma games are left to their own
// deploys, which record the file in their own markers.
//
// Where it comes from, in order:
//   1. the game's own copy, from elsewhere in its install tree -- the version the game shipped;
//   2. otherwise NVIDIA's DLSS from RHI (RankFTW's manifest and rhi-repo releases, sha256-checked),
//      the same fetch the Feeder and Luma deploys use.
// Recorded in the install journal's added list, so Remove takes it away again.
async function placeNvngxDlssBesideExe(dir, { fetchDlss = null } = {}) {
  const dest = path.join(dir, 'nvngx_dlss.dll');
  // A copy already there is the user's and is never replaced -- unless it cannot be a DLL at all.
  // A PCSX2 report (#89) carried a twelve-byte one, which OptiScaler accepts by name and nothing
  // can load, and "present" would have made this a no-op: the fix would report success, the next
  // run would fail identically, and Game Help would say "fix did not help" -- exactly the dead
  // button that #83 was about. A file under the threshold is a placeholder, not a copy.
  const stubBytes = runlog.dlssRuntimeStubBytes(dir);
  if (fs.existsSync(dest) && stubBytes === null) return { placed: false, reason: 'present' };
  if (stubBytes !== null) await fsp.rm(dest, { force: true });
  if (isFeederGame(dir) || lumaue.lumaUeDeployed(dir)) return { placed: false, reason: 'the Feeder or Luma deploy places it' };
  if (!nativeDlss.shipsNativeDlss(dir)) return { placed: false, reason: 'the game ships no DLSS' };

  let result;
  const own = nativeDlss.findInGameTree(dir, ['nvngx_dlss.dll']);
  if (own) {
    await fsp.copyFile(own, dest);
    result = { placed: true, source: 'game', from: own };
  } else {
    const r = fetchDlss
      ? await fetchDlss(dir)
      : await feeder.deployNvngxDlss(dir, getRhiManifest, compareStreamlineVersions, feederCacheDir(), GITHUB_HEADERS);
    if (!r.deployed) return { placed: false, reason: r.reason };
    result = { placed: true, source: 'rhi', version: r.version };
  }
  const journal = readInstallMarker(dir) || {};
  const added = new Set(journal.added || []);
  added.add('nvngx_dlss.dll');
  updateInstallJournal(dir, { added: [...added], nvngxDlss: { ...result, at: new Date().toISOString() } });
  return result;
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
// Did this app create that proxy? The install journal records every proxy it makes, so this is a
// lookup rather than a guess about bytes -- and the absence of the record is itself informative: a
// journal with files but no proxy name means the install adopted a proxy somebody else had already
// put there, which is exactly the DOOM 3 BFG case.
function proxyIsOurs(dir, proxyFile) {
  const journal = readInstallMarker(dir);
  if (!journal || typeof journal.proxy !== 'string') return false;
  return journal.proxy.toLowerCase() === path.basename(proxyFile).toLowerCase();
}

async function installProxy(dir, proxyName = DEFAULT_PROXY) {
  if (!PROXY_CANDIDATES.includes(proxyName)) {
    throw new Error(`${proxyName} is not one of the proxy names OptiScaler supports`);
  }

  const active = await findActiveOptiScalerFile(dir);
  if (active && active.renamed) {
    // An OptiScaler already sits in a proxy slot. Whether that is *ours* is the whole question,
    // and until now it was never asked: any DLL reporting OriginalFilename=OptiScaler.dll counted
    // as "already installed", so a folder holding somebody else's build got a silent no-op and an
    // "Installed" badge, while the build that actually answered the game's NGX calls was theirs.
    // A user's DOOM 3 BFG ran an upstream OptiScaler as winmm.dll exactly this way -- no neural
    // pass, nothing wrong on any screen in this app.
    //
    // The journal is the authority: this app records the proxy it creates, so a proxy it did not
    // record is not its own. It is still adopted either way -- refusing would break the hand-made
    // setups that do work, and overwriting another tool's DLL unasked is the other way to get this
    // wrong. What changes is that an adoption we cannot account for is reported (ours: false)
    // instead of passing silently for an install of ours.
    const ours = proxyIsOurs(dir, active.file);
    return { proxy: path.basename(active.file), created: false, backedUp: null, adopted: true, ours };
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
// keepNr: leave nvngx_dlssnr.dll where it is (a switch to Deep Fried Chicken, which loads the same file).
async function uninstallOptiScaler(dir, { keepNr = false } = {}) {
  const removed = [];
  const kept = [];
  const failed = [];
  const marker = readInstallMarker(dir);

  const active = await findActiveOptiScalerFile(dir);
  const proxyPath = active && active.renamed
    ? active.file
    : (marker && marker.proxy ? path.join(dir, marker.proxy) : null);

  if (proxyPath && fs.existsSync(proxyPath)) {
    if (active && active.renamed && path.resolve(active.file) === path.resolve(proxyPath)) {
      // The proxy is the file a still-running game has mapped, so it is the likeliest EPERM of all.
      const r = await saferemove.removePath(proxyPath);
      if (r.ok) removed.push(path.basename(proxyPath));
      else failed.push({ rel: path.basename(proxyPath), code: r.code });
    } else {
      kept.push(
        `${path.basename(proxyPath)} (does not identify itself as OptiScaler -- left alone)`
      );
    }
  }

  if (marker && marker.backedUp) {
    const backup = path.join(dir, marker.backedUp);
    // backedUpAs: the name the original had, when the proxy has since moved to another (migrateProxyIfNeeded).
    const originalName = marker.backedUpAs || marker.proxy;
    const restoreTo = path.join(dir, originalName);
    if (fs.existsSync(backup) && !fs.existsSync(restoreTo)) {
      await fsp.rename(backup, restoreTo);
      removed.push(`restored ${originalName}`);
    }
  }

  for (const name of ['OptiScaler.dll', 'OptiScaler_OpticalFlow.dll', 'OptiScaler.ini', 'OptiScaler.log', 'nvngx.dll_dlssnr.dll',
                      'Remove_OptiScaler.bat', 'setup_windows.bat', 'setup_linux.sh', INSTALL_MARKER]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) {
      const r = await saferemove.removePath(f);
      if (!r.ok) failed.push({ rel: name, code: r.code });
      else if (name !== INSTALL_MARKER) removed.push(name);
    }
  }

  let nrDllRemoved = false;
  try {
    nrDllRemoved = keepNr ? false : await removeSharedNrDllIfUnneeded(dir);
    if (nrDllRemoved) removed.push('nvngx_dlssnr.dll');
  } catch (err) {
    failed.push({ rel: 'nvngx_dlssnr.dll', code: (err && err.code) || 'failed' });
  }

  return { removed, kept, failed, nrDllRemoved };
}

// OptiScaler out of a Feeder game that is switching to Deep Fried Chicken (dfc.js switchToDfc):
// uninstallOptiScaler, and then the rest of OptiScaler's release that it leaves to
// uninstallEverything -- the OptiScaler\ folder, the licences, "!! EXTRACT ALL FILES TO GAME
// FOLDER !!" -- read off the install journal before uninstallOptiScaler deletes it. Tried on a real
// install (2026-09-22), the swap without this left all three behind. Never the Feeder's files, the
// NR model or ReShade: those are the half of the folder Chicken runs on.
const SWAP_KEEPS = new Set(['nvngx_dlss.dll', 'nvngx_dlssnr.dll', 'reshade64.dll', 'reshade.ini', 'reshadepreset.ini', 'reshade-shaders', 'dlss5-feed.addon64', 'dlss5-feed.cfg']);
async function removeOptiScalerForSwap(dir) {
  const journal = readInstallMarker(dir) || {};
  const core = await uninstallOptiScaler(dir, { keepNr: true });
  if (core.failed.length) return core;
  const rm = async (rel) => {
    if (SWAP_KEEPS.has(String(rel).toLowerCase()) || !fs.existsSync(path.join(dir, rel))) return;
    const r = await saferemove.removePath(path.join(dir, rel));
    if (r.ok) core.removed.push(rel);
    else core.failed.push({ rel, code: r.code });
  };
  for (const rel of journal.added || []) await rm(rel);
  for (const rel of ['OptiScaler', '!! EXTRACT ALL FILES TO GAME FOLDER !!', 'setup_linux.sh']) await rm(rel);
  for (const f of RELEASE_LICENSE_FILES) await rm(path.join('Licenses', f));
  try { if (fs.readdirSync(path.join(dir, 'Licenses')).length === 0) fs.rmdirSync(path.join(dir, 'Licenses')); } catch {}
  return core;
}

function bannersDir() {
  const dir = path.join(userDataDir(), 'banners');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The art of last resort: the game's own icon, out of its exe (exeicon.js). Only ever reached
// when the Steam manifest and the store search have both come up empty -- a game bought anywhere
// but Steam, or one whose folder name matches no store title. A square icon is not a banner, so
// the renderer shows it centred rather than cropped to fill; it is still this game's own art, and
// it needs no network at all.
ipcMain.handle('banner:exe-icon', (_evt, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) return null;
    return exeicon.cacheIcon(exePath, bannersDir());
  } catch {
    return null;
  }
});

ipcMain.handle('banner:cache-steam', async (_evt, { appid, fallbackImageUrl }) => {
  const dest = path.join(bannersDir(), `steam-${appid}.jpg`);
  if (fs.existsSync(dest)) return dest;

  let imageUrl = null;
  try {
    const res = await netFetch(`https://store.steampowered.com/api/appdetails?appids=${appid}`);
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
    const res = await netFetch(imageUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(dest, buf);
    return dest;
  } catch {
    return null;
  }
});

// Art that arrives as a plain URL rather than a Steam appid -- today that is SteamGridDB. Cached
// under the id it came from, so the same card does not re-download it, and so Remove-and-re-add
// finds the file already there. Same banners folder and same failure posture as the Steam cache:
// anything that goes wrong is null, and the caller falls through to the exe icon.
ipcMain.handle('banner:cache-url', async (_evt, { id, imageUrl }) => {
  if (!id || !imageUrl) return null;
  const ext = (path.extname(new URL(imageUrl).pathname) || '.png').slice(0, 5);
  const dest = path.join(bannersDir(), `sgdb-${String(id).replace(/[^a-z0-9]/gi, '')}${ext}`);
  if (fs.existsSync(dest)) return dest;
  try {
    const res = await netFetch(imageUrl, { headers: { 'User-Agent': 'OptiDLSS5-UI' } });
    if (!res.ok) return null;
    await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
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

// engine: which build's releases to look at (engines.js); omitted = this project's own fork, as
// every caller before there was a choice.
ipcMain.handle('update:check', async (_evt, { engine } = {}) => {
  const id = engines.normalizeEngine(engine);
  try {
    // The pinned release (package.json engineVersion) is what this app version was tested with;
    // a newer "latest" is only reported. No pin: latest, as before.
    //
    // The pin names a release of OUR fork -- the one release.yml bundles -- so it means nothing in
    // another author's repository, where that tag does not exist. Asking for it there 404s, and
    // getJson throws, which would fail the whole check and leave the second build uninstallable. A
    // build this app does not bundle is offered its own latest instead.
    const pin = engines.engine(id).bundled ? engines.pinnedEngineTag() : null;
    const getJson = async (url) => {
      const r = await netFetch(url, { headers: GITHUB_HEADERS });
      if (!r.ok) throw new Error(`GitHub API returned ${r.status}`);
      return r.json();
    };
    const pinned = pin ? await getJson(engines.releaseByTagApi(id, pin)) : null;
    let latest = null;
    try { latest = await getJson(engines.releasesApi(id)); } catch (e) { if (!pin) throw e; }
    const { offer: data, newerUntested } = engines.chooseEngineOffer({ pin, pinned, latest });
    if (!data) throw new Error('no engine release found');
    const { zip: zipAsset, sha256: shaAsset } = engines.pickAssets(data);
    return {
      ok: true,
      engine: id,
      pinned: !!pin,
      newerUntested,
      sha256: integrity.digestFromAsset(zipAsset),
      tag: data.tag_name,
      name: data.name || data.tag_name,
      publishedAt: data.published_at,
      downloadUrl: zipAsset ? zipAsset.browser_download_url : data.zipball_url,
      assetName: zipAsset ? zipAsset.name : `${data.tag_name}.zip`,
      sha256Url: shaAsset ? shaAsset.browser_download_url : null,
    };
  } catch (err) {
    return { ok: false, engine: id, error: err.message };
  }
});

ipcMain.handle('engine:list', () => Object.values(engines.ENGINES).map((e) => ({
  ...e, managedFolder: managedReleaseFolder(e.id), releasePage: engines.releasePageUrl(e.id),
})));

// Releases and issues live in a public repo of their own: the source repo is private, and a private
// repo's releases are private too, which would cut every installed copy off from its updates.
const MANAGER_REPO = 'mrcgibb9876-hash/OptiDLSS5-UI-releases';

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
      const ownRes = await netFetch(`https://api.github.com/repos/${MANAGER_REPO}/releases/tags/${encodeURIComponent(currentTag)}`, { headers: GITHUB_HEADERS });
      if (ownRes.ok) {
        const ownRelease = await ownRes.json();
        const zipAsset = (ownRelease.assets || []).find((a) => /^OptiScaler_DLSSNR-.*\.zip$/i.test(a.name));
        const m = zipAsset && zipAsset.name.match(/^OptiScaler_DLSSNR-(.+)\.zip$/i);
        if (m) bundledEngineTag = m[1];
      }
    }

    const latestRes = await netFetch(`https://api.github.com/repos/${MANAGER_REPO}/releases/latest`, { headers: GITHUB_HEADERS });
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
ipcMain.handle('update:managerDownload', () => managerUpdate.download());

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
// One per engine build (engines.js folderName), so switching a game between builds never
// re-downloads the other one. The default engine keeps the folder name it always had.
function managedReleaseFolder(engine) {
  return path.join(userDataDir(), engines.engine(engine).folderName);
}

ipcMain.handle('update:bundledEngine', () => ({ ...(bundledEngine() || {}), managedFolder: managedReleaseFolder() }));

// localZip: extract an already-downloaded zip (the bundled engine) instead of fetching downloadUrl.
// Always lands in the managed folder, and the live copy is only replaced once the new one has
// extracted and validated -- a truncated zip or a blocked Expand-Archive leaves a working engine
// exactly as it was. engine picks which managed folder; sha256Url (a release's own checksum
// asset, which the Pre-SR fork publishes) is checked before anything is extracted.
ipcMain.handle('update:install', async (_evt, { downloadUrl, localZip, tag, engine, sha256Url, sha256: digest }) => {
  let tmpZip;
  const dest = managedReleaseFolder(engine);
  const staging = `${dest}.new`;
  try {
    let zipPath = localZip;
    if (!zipPath) {
      const res = await netFetch(downloadUrl, { headers: GITHUB_HEADERS });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      integrity.checkFinalUrl(downloadUrl, res);
      const buf = Buffer.from(await res.arrayBuffer());
      // GitHub's published digest for the asset, when update:check had one.
      if (digest && /^[0-9a-f]{64}$/i.test(digest)) integrity.verifyBuffer(buf, digest.toLowerCase(), 'The engine zip');

      if (sha256Url) {
        const shaRes = await netFetch(sha256Url, { headers: GITHUB_HEADERS });
        const expected = shaRes.ok ? engines.parseSha256Text(await shaRes.text()) : null;
        if (expected) {
          const actual = crypto.createHash('sha256').update(buf).digest('hex');
          if (actual !== expected) throw new Error(`Downloaded zip failed its sha256 check (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
        }
      }

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

    return { ok: true, folder: findReleaseRoot(dest), tag, engine: engines.normalizeEngine(engine) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tmpZip) fsp.rm(tmpZip, { force: true }).catch(() => {});
    fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
});
