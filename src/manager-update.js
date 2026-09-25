// Self-update for the Manager itself, over its own GitHub releases (electron-updater).
//
// Until now the engine (OptiScaler_DLSSNR) updated itself at launch while the Manager only
// opened its release page and left the install to the user -- so people ran an old Manager with a
// new engine, or the other way round, and neither half could tell which. This closes that: the
// Manager checks its own releases shortly after launch and every few hours after and tells the
// renderer, whose banner offers "Download update" and then "Restart to update". Since 2026-09-25
// nothing downloads or installs without the player pressing those. release.yml publishes the
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
  // The build a check found, kept apart from `version` so nothing that goes wrong afterwards can lose
  // it: a background check that failed while the banner offered Download, or a download that failed
  // half-way, used to replace the whole state with phase 'error' -- and with it the one thing the
  // banner needed to offer the update again.
  availableVersion: null,
  // What the last failure was: 'check' or 'download'. A failed download is phase 'error' with this
  // set to 'download' and `version` kept, which is what lets the renderer offer Retry (download()
  // accepts exactly that state). null when the last thing did not fail.
  failed: null,
};

// What the updater is doing right now, so its 'error' event -- which electron-updater raises for a
// failed check and a failed download alike -- can be told apart.
let activity = null;

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
  Object.assign(state, { phase: 'idle', version: null, availableVersion: null, percent: 0, error: null, failed: null });
  activity = null;
  if (!autoUpdater) { set({ supported: false, reason: 'electron-updater is not available in this build' }); return state; }
  if (!app.isPackaged) { set({ supported: false, reason: 'running from source' }); return state; }
  if (PORTABLE) { set({ supported: false, reason: 'the portable build cannot replace itself -- use the installer build for automatic updates' }); return state; }

  updater = autoUpdater;
  // The player decides (2026-09-25): a new build is announced, never fetched or installed on its own.
  // Download is a button (download()), and only the Restart button installs -- quitting does not.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.logger = null;

  // A background check while Download is on offer leaves the offer up: the banner blinking to
  // "checking" and back every six hours is noise, and a failed re-check must not take it down at all.
  updater.on('checking-for-update', () => { if (state.phase !== 'available') set({ phase: 'checking', error: null }); });
  updater.on('update-available', (info) => set({ phase: 'available', version: info && info.version, availableVersion: info && info.version, percent: 0, error: null, failed: null }));
  updater.on('update-not-available', (info) => set({ phase: 'up-to-date', version: info && info.version, availableVersion: null, error: null, failed: null }));
  updater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  updater.on('update-downloaded', (info) => set({ phase: 'downloaded', version: info && info.version, percent: 100, error: null, failed: null }));
  updater.on('error', (err) => fail(err));

  set({ supported: true, reason: null });
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  return state;
}

// One place for both failure paths: the 'error' event and the rejected promise. electron-updater
// usually raises both for one failure, so running this twice must give the same state.
//   a check that fails while an update is already known keeps phase 'available' and its version --
//            the offer is still good, only the re-check failed (`error` says why). Otherwise 'error'.
//   a download that fails is phase 'error' with `version` and `availableVersion` kept and
//            failed: 'download', so the banner can offer Retry rather than start over.
function fail(err) {
  const error = String(err && err.message ? err.message : err);
  const during = activity || (state.phase === 'downloading' ? 'download' : 'check');
  if (during === 'download') {
    set({ phase: 'error', error, failed: 'download', version: state.availableVersion || state.version, percent: 0 });
  } else if (state.availableVersion) {
    set({ phase: 'available', version: state.availableVersion, error, failed: 'check' });
  } else {
    set({ phase: 'error', error, failed: 'check' });
  }
}

async function check() {
  if (!updater) return { ...state };
  if (state.phase === 'downloading' || state.phase === 'downloaded') return { ...state };
  activity = 'check';
  try {
    await updater.checkForUpdates();
  } catch (err) {
    fail(err);
  } finally {
    activity = null;
  }
  return { ...state };
}

// Whether download() may run: an update on offer, or a download that failed (Retry).
function canDownload() {
  return state.phase === 'available' || (state.phase === 'error' && state.failed === 'download' && !!state.availableVersion);
}

// Fetch the build check() found, when the player presses Download -- or Retry after a failed
// download. Progress arrives through the events.
async function download() {
  if (!updater || !canDownload()) return { ...state };
  activity = 'download';
  try {
    set({ phase: 'downloading', percent: 0, error: null, failed: null, version: state.availableVersion || state.version });
    await updater.downloadUpdate();
  } catch (err) {
    fail(err);
  } finally {
    activity = null;
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

module.exports = { setup, check, download, canDownload, restart, snapshot, CHECK_EVERY_MS };
