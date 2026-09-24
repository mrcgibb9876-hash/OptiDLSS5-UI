'use strict';
// ReLimiter: a frame-pacing ReShade add-on for G-Sync/VRR displays, by RankFTW, Lazorr and UltraMatt
// (https://github.com/RankFTW/ReLimiter). MIT, so unlike Deep Fried Chicken, LumeniteFX and the AMD
// installer this app MAY carry and place it -- the MIT notice travels with the binary.
//
// WHY IT NEEDS ReShade, AND WHY THAT IS NOT NEGOTIABLE. ReLimiter is not merely loaded by ReShade, it
// is DRIVEN by it: its whole frame pipeline is ReShade events -- init_device, init_swapchain,
// set_fullscreen_state and above all `present`, which is the limiter's heartbeat. Its DoInit returns
// false outright when no ReShade module is in the process ("not a ReShade process ..., skipping"), so
// nothing hooks and nothing paces. Running it standalone would mean re-implementing the part of
// ReShade it is built on. Do not try; deploy ReShade instead.
//
// WHICH IS ALREADY SOLVED. The arrangement the Feeder route uses works here unchanged, and it was
// arrived at the hard way (feeder.js's header: two independent proxies broke Batman: Arkham Knight two
// different ways). On D3D11 and D3D12 OptiScaler keeps the proxy slot, ReShade goes down as a plain
// non-proxying ReShade64.dll, and [Plugins] LoadReshade=true has OptiScaler load it. So ReLimiter on an
// ordinary DX12 game needs no new plumbing at all -- it needs that plumbing to stop being conditional
// on the Feeder.
//
// WHAT THIS MUST NOT DO. The Feeder additionally forces OptiScaler into NR-only mode
// (DLSS5_ONLY_FORCED), because OptiScaler must not drive its own upscaler alongside the Feeder.
// ReLimiter is a frame pacer, not an upscaler, and that constraint does not apply to it. Deploying
// ReLimiter must never narrow what OptiScaler is doing: a user who adds frame pacing and silently
// loses their upscaler has been handed a worse app.
const fs = require('node:fs');
const path = require('node:path');

const feeder = require('./feeder');

const ADDON_64 = 'relimiter.addon64';
const ADDON_32 = 'relimiter.addon32';
const MARKER = '.dlss5ui-relimiter.json';

function addonName(bitness) {
  return bitness === 32 ? ADDON_32 : ADDON_64;
}

// Identified by CONTENT, never by file name. The same rule as isAddonReShadeDll: a name is what
// someone typed, and a folder can hold a renamed or half-downloaded file. ReLimiter's own strings and
// the add-on entry point it must export are the honest tell.
function isReLimiterAddon(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 64 * 1024) return false;                 // a real build is megabytes
    if (buf.readUInt16LE(0) !== 0x5a4d) return false;          // 'MZ' -- a PE image at all
    return buf.includes(Buffer.from('ReLimiter', 'latin1'))
      && buf.includes(Buffer.from('AddonInit', 'latin1'));
  } catch {
    return false;
  }
}

// How ReShade has to reach this game, which is entirely feeder.js's question already.
//   local         dx11/dx12 -- a plain ReShade64.dll that OptiScaler loads. Fully automatic.
//   opengl32      ReShade IS the game's opengl32.dll. Automatic, but OptiScaler then takes another
//                 name (winmm/version), which is main.js's existing choice.
//   vulkan-layer  ReShade only runs as a machine-wide implicit layer, registered under HKLM by its
//                 own installer, and attaches only to exes listed in ReShadeApps.ini. This app cannot
//                 write either of those, so a Vulkan game needs the user to run ReShade's setup once.
//                 That is a limitation to state, not one to work around.
function reshadeModeFor(api) {
  return feeder.reshadeModeForApi(api);
}

// Whether ReLimiter can be set up here without asking the user to do anything by hand.
function isAutomatic(api) {
  return reshadeModeFor(api) !== 'vulkan-layer';
}

function marker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

function deployed(dir, bitness = 64) {
  return fs.existsSync(path.join(dir, addonName(bitness)));
}

// What is actually in the folder, and what is still missing. Every field is a file on disk or a key in
// an ini -- never the plan, only the state, which is the distinction route.js's dgVoodooDeployed
// exists for.
function status(dir, { api = 'dx12', bitness = 64 } = {}) {
  const name = addonName(bitness);
  const addon = fs.existsSync(path.join(dir, name));
  const mode = reshadeModeFor(api);
  const reshade = mode === 'opengl32'
    ? feeder.isReShadeDll(path.join(dir, 'opengl32.dll'))
    : fs.existsSync(path.join(dir, 'ReShade64.dll'));
  // The add-on build specifically: the plain build has the same version and product name and simply
  // never loads an add-on (feeder.js's issue-#53 note), so ReLimiter would sit there doing nothing.
  const addonBuild = mode === 'opengl32'
    ? feeder.isAddonReShadeDll(path.join(dir, 'opengl32.dll'))
    : feeder.isAddonReShadeDll(path.join(dir, 'ReShade64.dll'));
  const m = marker(dir);
  return {
    supported: true,
    api,
    mode,
    automatic: isAutomatic(api),
    addon,
    addonName: name,
    // Claimed by our marker but gone from disk -- the antivirus shape that cost Max Payne 2 a
    // diagnosis, and worth telling apart from "never installed".
    addonGone: !!(m && !addon),
    reshade,
    reshadeIsAddonBuild: reshade ? addonBuild : null,
    ours: !!m,
    version: m ? m.version || null : null,
    complete: addon && reshade && addonBuild,
  };
}

// Everything that has to be true, as a list of what is missing. Ordered the way a user would fix it.
function missing(dir, opts = {}) {
  const s = status(dir, opts);
  const gaps = [];
  if (!s.reshade) gaps.push('reshade');
  else if (!s.reshadeIsAddonBuild) gaps.push('reshade-addon-build');
  if (!s.addon) gaps.push('addon');
  if (s.mode === 'vulkan-layer') gaps.push('vulkan-layer-registration');
  return gaps;
}

// Place a user-supplied (or cached) copy. Validated by content first: placing an unidentified DLL
// under a name ReShade will load is exactly the thing this app refuses to do elsewhere.
function deploy(dir, sourceFile, { bitness = 64, version = null } = {}) {
  if (!isReLimiterAddon(sourceFile)) {
    throw new Error('That file is not a ReLimiter add-on (no ReLimiter/AddonInit in it) -- refusing to place it');
  }
  const name = addonName(bitness);
  fs.copyFileSync(sourceFile, path.join(dir, name));
  const record = {
    tool: 'ReLimiter',
    file: name,
    version,
    // Recorded so Remove takes back only what this app put there.
    files: [name],
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(record, null, 2));
  return record;
}

// Take out only the add-on and our marker. ReShade is deliberately left alone: the Feeder route needs
// it, and a user may have installed it themselves for shaders. Removing a dependency someone else is
// using is how a clean-up turns into a bug report.
function remove(dir) {
  const m = marker(dir);
  const removed = [];
  for (const name of (m && m.files) || [ADDON_64, ADDON_32]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(name); }
  }
  const mp = path.join(dir, MARKER);
  if (fs.existsSync(mp)) { fs.rmSync(mp, { force: true }); removed.push(MARKER); }
  return removed;
}

// ── The one thing that must not run alongside it ──
//
// [DlssNr] AutoScale with AutoScaleMode = 2 ("Aim at: Frame rate") is a closed loop that moves the NR
// MODEL's working resolution up and down until the game reaches a target frame rate. ReLimiter is a
// closed loop that HOLDS the frame rate at a target by sleeping. Both aim at frames per second, and
// together they are not merely redundant, they degrade:
//
//   ReLimiter caps the game at its target. Our loop reads the resulting frame rate, finds it short of
//   OUR target, and sheds model resolution to close a gap ReLimiter will never allow to close. It
//   keeps shedding. The picture loses model detail for no frame-rate gain whatsoever.
//
// The engine's own help for that row says as much without knowing why: "Frame rate ... the only one
// that can fall short -- the pass can give back what it costs and no more, so if the game itself
// cannot reach the number, the panel says so." Under a frame limiter it can never reach the number.
//
// WHICH IS WHY THIS IS NARROW. AutoScaleMode 0 ("Share of the frame") and 1 ("Milliseconds") are cost
// budgets on the pass itself, not frame-rate targets: they bound what the pass may spend, which is
// orthogonal to a limiter and perfectly safe beside it. Turning all of AutoScale off would remove a
// feature that works. Only mode 2 conflicts, so only mode 2 is refused.
const NR_FPS_TARGET_MODE = 2;

// Given the current [DlssNr] values, is there a conflict? Values in, answer out -- the ini reading
// belongs to the caller (main.js owns readIniKey/patchIniValues), which also keeps this testable
// without a file.
function nrConflict({ autoScale, autoScaleMode } = {}) {
  const on = autoScale === true || autoScale === 'true';
  const mode = Number(autoScaleMode);
  if (!on || mode !== NR_FPS_TARGET_MODE) return null;
  return {
    setting: 'AutoScale',
    mode: NR_FPS_TARGET_MODE,
    why: 'both aim at a frame rate: ReLimiter holds it, Adjust-it-for-me chases it, and the model loses resolution to a gap that can never close',
  };
}

// What to write to resolve it. Ours goes off, not ReLimiter's target: the user deployed a frame pacer
// to pace frames, so it is the one that should be doing the frame-rate work. Reported as an applied
// edit rather than done silently -- a setting that turns itself off without saying so is a bug report.
const NR_CONFLICT_EDITS = [{ section: 'DlssNr', key: 'AutoScale', value: 'false' }];

module.exports = {
  ADDON_64, ADDON_32, MARKER,
  addonName, isReLimiterAddon, reshadeModeFor, isAutomatic,
  marker, deployed, status, missing, deploy, remove,
  NR_FPS_TARGET_MODE, nrConflict, NR_CONFLICT_EDITS,
};
