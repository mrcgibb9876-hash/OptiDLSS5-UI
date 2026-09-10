// Manager-side integration for DLSS5Injector.exe.
//
// Injector mode loads OptiScaler into a game as OptiScaler.dll (the injection mode
// dllmain.cpp already supports) instead of renaming a system DLL on disk -- it does NOT
// copy anything into the game folder, that's the whole point. Sidesteps the ReShade
// dxgi.dll fight entirely: ReShade keeps its own proxy, OptiScaler is injected alongside.
//
//   * Steam games: produces the exact Launch Options string for the user to paste into
//     Steam (Properties -> Launch Options). Steam expands %command%, so the game is
//     wrapped every time it launches from Steam, with the Manager not running. This is
//     copy-paste only -- auto-writing Steam's localconfig.vdf is a separate, riskier
//     feature (Steam rewrites that file from memory on exit, silently discarding a
//     concurrent write) and isn't implemented here.
//   * Non-Steam games: launches the game through the injector directly ("Launch now").
//
// Single-player only -- the injector binary itself refuses a game shipping a known
// anti-cheat, with no override. This module doesn't relax that; it just calls the exe.

const path = require('node:path');
const fs = require('node:fs');

// --- locating the two executables -------------------------------------------------

// DLSS5Injector.exe ships beside the Manager: as a repo-relative tools/ build in dev,
// as an extraResource next to the packaged app otherwise. app.getAppPath() in dev
// points at the repo root (main.js lives at <root>/src/main.js); in a packaged build
// process.resourcesPath is where electron-builder's extraResources land.
function resolveInjectorExe({ isPackaged, resourcesPath, appRoot }) {
  const candidate = isPackaged
    ? path.join(resourcesPath, 'DLSS5Injector.exe')
    : path.join(appRoot, 'tools', 'DLSS5Injector', 'DLSS5Injector.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

// OptiScaler.dll is the release folder's own DLL -- the same fork build the proxy path
// installs, just loaded by injection instead of copied and renamed.
function resolveOptiScalerDll(releaseFolder) {
  if (!releaseFolder) return null;
  const dll = path.join(releaseFolder, 'OptiScaler.dll');
  return fs.existsSync(dll) ? dll : null;
}

// --- quoting ----------------------------------------------------------------------

// A path for a Windows command line: wrap in double quotes. Paths cannot contain " on
// Windows, so no escaping inside is needed -- but reject one if it somehow appears,
// rather than emit a broken/injectable command.
function q(p) {
  if (p.includes('"')) throw new Error(`path contains a double quote, refusing: ${p}`);
  return `"${p}"`;
}

// --- Steam ------------------------------------------------------------------------

// The Launch Options string. Order matters: our options first, then `--`, then
// %command% (which Steam replaces with the real quoted game command line). The `--`
// stops the game's own switches being parsed as the injector's.
function steamLaunchOption(injectorExe, dllPath) {
  return `${q(injectorExe)} --dll ${q(dllPath)} -- %command%`;
}

// Recognise a launch option we wrote before, so the UI can show "on". Matches our
// injector exe basename followed eventually by %command%, tolerant of path/dll
// differences (an older install, a moved cache dir, etc).
function isOurLaunchOption(value) {
  if (!value) return false;
  return /DLSS5Injector\.exe"?\s.*--\s+%command%\s*$/i.test(value);
}

// --- non-Steam / "Launch now" -----------------------------------------------------

// What the injector's exit codes mean (see tools/DLSS5Injector/DLSS5Injector.cpp), so the
// card can say something specific instead of "launched" when it didn't.
const INJECTOR_EXIT = {
  0: 'injected',
  1: 'injection failed -- see the injector output',
  2: 'bad arguments',
  3: 'refused: this game ships an anti-cheat (single-player games only)',
  4: 'refused: 32-bit game; the injector and OptiScaler are 64-bit only',
  5: 'the game exited before it could be injected -- it probably starts a launcher; point at the real executable, or use the Steam launch option',
};

// Launch the game through the injector. Resolves when the INJECTOR exits -- almost at
// once, right after it has injected -- with its exit code, a human reason, and stderr.
//
// Two things the previous version got wrong:
//  * `detached` + `stdio: 'ignore'` threw the outcome away: an anti-cheat refusal, a 32-bit
//    game, or a launcher that exited early all came back as "launched". It is not needed
//    for the game to survive the Manager: the injector CreateProcess'es the game as an
//    independent process, and Windows does not tie a child's lifetime to a parent that
//    exits. Only the injector is our child, and it is gone in a second.
//  * `windowsHide` was missing. The injector is a console program; without it every launch
//    flashes a black console window over the game.
//
// caller (main.js) supplies spawn to avoid this module depending on node:child_process.
function launchThroughInjector(spawnFn, { injectorExe, dllPath, gameExe, gameArgs = [] }) {
  if (!fs.existsSync(injectorExe)) throw new Error(`injector not found: ${injectorExe}`);
  if (!fs.existsSync(dllPath))     throw new Error(`OptiScaler.dll not found: ${dllPath}`);
  if (!fs.existsSync(gameExe))     throw new Error(`game exe not found: ${gameExe}`);

  const args = ['--dll', dllPath, '--', gameExe, ...gameArgs];
  return new Promise((resolve) => {
    const child = spawnFn(injectorExe, args, {
      cwd: path.dirname(gameExe),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ ok: false, code: -1, reason: err.message, stdout, stderr }));
    child.on('close', (code) => resolve({
      ok: code === 0,
      code,
      reason: INJECTOR_EXIT[code] || `injector exited with code ${code}`,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }));
  });
}

// --- capability check -------------------------------------------------------------

// Everything injector mode needs, or the specific reason it is unavailable, so the UI
// can show a real explanation instead of a dead button.
function injectorReadiness({ isPackaged, resourcesPath, appRoot, releaseFolder }) {
  const injectorExe = resolveInjectorExe({ isPackaged, resourcesPath, appRoot });
  if (!injectorExe) return { ready: false, reason: 'DLSS5Injector.exe not found' };
  const dllPath = resolveOptiScalerDll(releaseFolder);
  if (!dllPath) return { ready: false, reason: 'OptiScaler.dll not found in the release folder' };
  return { ready: true, injectorExe, dllPath };
}

module.exports = {
  resolveInjectorExe,
  resolveOptiScalerDll,
  steamLaunchOption,
  isOurLaunchOption,
  launchThroughInjector,
  injectorReadiness,
  INJECTOR_EXIT,
};
