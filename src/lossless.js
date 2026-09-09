// Lossless Scaling (Steam app 993090) as an alternative Frame Generation path for DLSS5-Feeder
// games, where OptiScaler's own FSRFG is blocked -- see optiFgReadiness() in main.js. FSRFG
// crashed on a real game (Bodycam, 2026-09-10): any FG output presents twice per real frame by
// design, and the Feeder's own DLSS5_Feed.fx technique isn't built to survive that (confirmed via
// isolation testing, not a guess -- see the OptiScaler_DLSSNR fix in FGHooks::CheckForFGStatus).
//
// Lossless Scaling sidesteps that class of bug entirely: it is a separate external process that
// captures the game's already-composited window output (Desktop Duplication / DXGI capture, not
// a D3D12 Present hook inside the game) and generates extra frames purely on the display side.
// ReShade and the Feeder only ever see one real Present per frame either way -- LS never touches
// the game's own swapchain at all.
//
// Its per-game settings live in a real Windows XML config, %LOCALAPPDATA%\Lossless Scaling\
// Settings.xml -- confirmed against a real, freshly-generated copy on this machine (2026-09-10),
// not guessed from documentation. A <Profile> is matched primarily by its <Path> element (the
// game's own exe path) and secondarily by <Title>, since a profile created by hand through LS's
// own UI (typing a title, browsing for the exe later) can have an empty <Path> until that's done.
// The actual element-by-element editing happens in the renderer (renderer.js), using the
// browser's built-in DOMParser/XMLSerializer -- this app has zero npm runtime dependencies by
// design, and Electron's renderer already has a full browser environment, so there is no need to
// add an XML library just for this. main.js only ever reads/writes the raw file text.

const path = require('node:path');
const fs = require('node:fs');
const library = require('./library');

function settingsPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Lossless Scaling', 'Settings.xml');
}

// Uses the same Steam-library scan the game scanner already relies on (registry SteamPath +
// libraryfolders.vdf) rather than duplicating that logic -- Lossless Scaling shows up as an
// ordinary Steam "game" entry (its name doesn't match the redistributable/soundtrack exclusion
// list), so no special-casing is needed beyond picking it out by name.
function detect() {
  const games = library.steam();
  const entry = games.find((g) => g.name === 'Lossless Scaling');
  if (!entry) return { installed: false };

  const exePath = path.join(entry.dir, 'LosslessScaling.exe');
  if (!fs.existsSync(exePath)) return { installed: false };

  const settings = settingsPath();
  return {
    installed: true,
    exePath,
    settingsPath: settings,
    // Settings.xml is only created on Lossless Scaling's own first launch -- installed and
    // "ready to configure" are different states, both worth telling the UI apart.
    hasRunOnce: fs.existsSync(settings)
  };
}

function readSettingsRaw() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

// Never overwrite the user's real config without a recoverable copy -- this file can hold
// profiles for every other game they use Lossless Scaling with, not just the one we're touching.
function writeSettingsRaw(xmlText) {
  const p = settingsPath();
  if (fs.existsSync(p)) {
    const backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(p, backup);
  }
  fs.writeFileSync(p, xmlText, 'utf-8');
}

module.exports = { settingsPath, detect, readSettingsRaw, writeSettingsRaw };
