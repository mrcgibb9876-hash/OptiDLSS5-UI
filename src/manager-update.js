// Self-update for the Manager itself, over its own GitHub releases (electron-updater).
//
// Until now the engine (OptiScaler_DLSSNR) updated itself at launch while the Manager only
// opened its release page and left the install to the user -- so people ran an old Manager with a
// new engine, or the other way round, and neither half could tell which. This closes that: the
// Manager checks its own releases shortly after launch and every few hours after, downloads a
// newer build in the background, tells the renderer so a banner can offer "Restart to update",
// and installs on the next quit regardless (autoInstallOnAppQuit). release.yml publishes the
// latest.yml + blockmap electron-updater reads, and package.json's build.publish block is what
// makes electron-builder write app-update.yml into the packaged app.
//
// Not everywhere: the portable exe cannot replace itself (electron-builder sets
// PORTABLE_EXECUTABLE_FILE there), and a source checkout has nothing to update -- both report
// supported:false with the reason, and the Settings page falls back to opening the release page.

const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;
const FIRST_CHECK_MS = 8 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const state = {
  supported: false,
  reason: null,
  phase: 'idle', // idle | checking | up-to-date | available | downloading | downloaded | error
  currentVersion: null,
  version: null,
  percent: 0,
  error: null,
};

let updater = null;
let notify = () => {};

function set(patch) {
  Object.assign(state, patch);
  try { notify({ ...state }); } catch {}
}

// app: electron's app; autoUpdater: electron-updater's (null when the module is missing);
// onChange: called with a state snapshot on every transition (main.js forwards it to the window).
function setup({ app, autoUpdater, onChange }) {
  notify = onChange || notify;
  state.currentVersion = app.getVersion();
  if (!autoUpdater) { set({ supported: false, reason: 'electron-updater is not available in this build' }); return state; }
  if (!app.isPackaged) { set({ supported: false, reason: 'running from source' }); return state; }
  if (PORTABLE) { set({ supported: false, reason: 'the portable build cannot replace itself -- use the installer build for automatic updates' }); return state; }

  updater = autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;
  updater.logger = null;

  updater.on('checking-for-update', () => set({ phase: 'checking', error: null }));
  updater.on('update-available', (info) => set({ phase: 'available', version: info && info.version, percent: 0 }));
  updater.on('update-not-available', (info) => set({ phase: 'up-to-date', version: info && info.version }));
  updater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  updater.on('update-downloaded', (info) => set({ phase: 'downloaded', version: info && info.version, percent: 100 }));
  updater.on('error', (err) => set({ phase: 'error', error: String(err && err.message ? err.message : err) }));

  set({ supported: true, reason: null });
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  return state;
}

async function check() {
  if (!updater) return { ...state };
  if (state.phase === 'downloading' || state.phase === 'downloaded') return { ...state };
  try {
    await updater.checkForUpdates();
  } catch (err) {
    set({ phase: 'error', error: String(err && err.message ? err.message : err) });
  }
  return { ...state };
}

// Quit and run the downloaded installer silently, relaunching the new build afterwards.
function restart() {
  if (!updater || state.phase !== 'downloaded') return false;
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

function snapshot() {
  return { ...state };
}

module.exports = { setup, check, restart, snapshot, CHECK_EVERY_MS };
