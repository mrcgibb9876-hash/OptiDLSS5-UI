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
const integrity = require('./integrity');
const dfc = require('./dfc');
const { peOriginalFilename } = require('./detect');
const { setIniKey, getIniKey } = require('./ini-merge');

const ADDON_64 = 'relimiter.addon64';
const ADDON_32 = 'relimiter.addon32';
const MARKER = '.dlss5ui-relimiter.json';

function addonName(bitness) {
  return bitness === 32 ? ADDON_32 : ADDON_64;
}

// Whether this OptiScaler build keeps NGX's device alive under ReShade, read from its bytes.
//
// Shadow of the Tomb Raider (and any game like it) initialises NGX on a throwaway device while its
// launcher is up, releases it, and initialises again on the device it renders with; the real
// _nvngx.dll keeps the first. Under ReShade that device is a wrapper ReShade frees on release, so DLSS
// went on calling into freed memory: with ANY add-on loaded CreateFeature faulted in ReShade64.dll,
// and without one the game sometimes just closed at DLSS creation. Measured under a debugger,
// 2026-09-24. Engine commit 02e2dac9 holds a reference on that device, and e93d1f53 logs this exact
// text when it does -- so the text in the DLL is the proof that the engine in THIS folder has the fix,
// whatever the pin says (a game can be on an older engine until it is updated).
const NGX_DEVICE_HOLD_MARK = 'Holding the NGX session device';

function engineKeepsNgxDevice(file) {
  return engineHas(file, NGX_DEVICE_HOLD_MARK);
}

// Whether this OptiScaler build lets ReShade see an XeFG swap chain, read from its bytes the same way.
// Before engine commit 9a4ce766 XeFG made its present queue on the raw device OptiScaler captures
// beneath ReShade, ReShade skipped the swap chain ("created without a proxy Direct3D device") and
// ReLimiter never saw a frame. That build builds XeFG on the game queue's device and logs this text.
// Verified on Shadow of the Tomb Raider, 2026-09-24. FSR FG was not changed and stays refused.
const XEFG_RESHADE_MARK = "XeFG context on the game queue's device";

function engineGivesXefgToReShade(file) {
  return engineHas(file, XEFG_RESHADE_MARK);
}

function engineHas(file, mark) {
  try {
    return fs.readFileSync(file).includes(Buffer.from(mark, 'latin1'));
  } catch {
    return false;
  }
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

// ── A game with no OptiScaler ──
//
// Frame pacing is for ANY game, not only ones this app has put DLSS 5 on. Where OptiScaler is in the
// folder it loads the plain ReShade64.dll ([Plugins] LoadReshade). Where it is not, nothing would load
// that file, so ReShade goes down as the game's own proxy instead: dxgi.dll for DX10/11/12 (all of
// them reach the swapchain through DXGI), d3d9.dll for a 64-bit DX9 game. OpenGL is already a proxy
// in every case (opengl32.dll, feeder.js). Recorded in our marker as reshadeProxy so that installing
// DLSS 5 afterwards can move it back to ReShade64.dll before OptiScaler takes the slot
// (demoteStandaloneReShade), and Remove can take back a ReShade it placed for nothing else.
// Strict on purpose. feeder.isReShadeDll is a string match, and OptiScaler.dll carries the string
// "ReShade" too (its LoadReshade), so it would pass -- and this check decides what gets renamed or
// deleted in a proxy slot OptiScaler may be sitting in. ReShade's own version resource names it.
function isReShadeProxy(file) {
  try {
    return /^reshade(32|64)?\.dll$/i.test(peOriginalFilename(file) || '');
  } catch {
    return false;
  }
}

// Did frame pacing put the ReShade64.dll here? Recorded at install (reshadePlaced) and checked against
// the file itself, so a ReShade someone else dropped in later is not claimed. Chicken's swap asks this
// before taking ReShade64.dll over (dfc.js switchToDfc, reshadeIsOurs).
function placedReShade(dir) {
  const m = marker(dir);
  return !!(m && m.reshadePlaced && !m.reshadeProxy && isReShadeProxy(path.join(dir, 'ReShade64.dll')));
}

// Whether the ReShade in this folder is the one frame pacing put here, in either place: as the game's
// own proxy (a game with no OptiScaler, promoteToStandalone) or as ReShade64.dll. Install's preflight
// asks this, so it does not tell the player to remove the ReShade the app itself placed -- installing
// DLSS 5 hands a standalone one back to ReShade64.dll anyway (game:install, demoteStandaloneReShade).
function ownsReShade(dir) {
  const m = marker(dir);
  if (m && m.reshadePlaced && m.reshadeProxy && isReShadeProxy(path.join(dir, m.reshadeProxy))) return true;
  return placedReShade(dir);
}

function standaloneProxyName(api) {
  return api === 'dx9' ? 'd3d9.dll' : 'dxgi.dll';
}

// A game switched to Deep Fried Chicken already has ReShade in the proxy slot -- Chicken's own
// (dfc.js reshadeProxyOf), with OptiScaler out of the folder. ReLimiter is then one more add-on on
// that ReShade: nothing is promoted, moved or recorded as ours, so removing pacing can never take
// Chicken's ReShade with it.
function chickenReShade(dir) {
  return dfc.reshadeProxyOf(dir);
}

function reshadeFileIn(dir, api) {
  const chicken = chickenReShade(dir);
  if (chicken) return chicken;
  const m = marker(dir);
  if (m && m.reshadeProxy && isReShadeProxy(path.join(dir, m.reshadeProxy))) return m.reshadeProxy;
  return reshadeModeFor(api) === 'opengl32' ? 'opengl32.dll' : 'ReShade64.dll';
}

function writeMarker(dir, patch) {
  const next = { ...(marker(dir) || { tool: 'ReLimiter' }), ...patch };
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(next, null, 2));
  return next;
}

// ReShade64.dll (just placed by deployReShade) becomes the game's proxy. Refused when the slot holds
// something that is not ReShade -- another tool's dxgi.dll is not ours to overwrite.
function promoteToStandalone(dir, api) {
  const proxy = standaloneProxyName(api);
  const dest = path.join(dir, proxy);
  const src = path.join(dir, 'ReShade64.dll');
  if (fs.existsSync(dest) && !isReShadeProxy(dest)) {
    throw Object.assign(new Error(`${proxy} in this folder belongs to something else, so ReShade cannot go there`), { code: 'proxy-taken' });
  }
  if (!fs.existsSync(dest)) fs.renameSync(src, dest);
  else if (fs.existsSync(src)) fs.rmSync(src, { force: true });
  writeMarker(dir, { reshadeProxy: proxy, reshadePlaced: true });
  return proxy;
}

// Before OptiScaler takes the proxy slot: our standalone ReShade goes back to ReShade64.dll, where
// OptiScaler loads it. Two proxies in one folder is the Batman: Arkham Knight failure feeder.js
// records, so this is not optional.
function demoteStandaloneReShade(dir) {
  const m = marker(dir);
  if (!m || !m.reshadeProxy) return null;
  const from = path.join(dir, m.reshadeProxy);
  const to = path.join(dir, 'ReShade64.dll');
  if (isReShadeProxy(from)) {
    if (!fs.existsSync(to)) fs.renameSync(from, to);
    else fs.rmSync(from, { force: true });
  }
  writeMarker(dir, { reshadeProxy: null });
  return m.reshadeProxy;
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
  const reshadeFile = reshadeFileIn(dir, api);
  const reshade = mode === 'opengl32'
    ? feeder.isReShadeDll(path.join(dir, reshadeFile))
    : fs.existsSync(path.join(dir, reshadeFile));
  // The add-on build specifically: the plain build has the same version and product name and simply
  // never loads an add-on (feeder.js's issue-#53 note), so ReLimiter would sit there doing nothing.
  const addonBuild = feeder.isAddonReShadeDll(path.join(dir, reshadeFile));
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
    // m.files, not m alone: a marker can also exist only to record a ReShade this app placed for
    // RenoDX (ensureReShadeAddonHost), with pacing never installed -- that is not pacing gone.
    addonGone: !!(m && m.files && !addon),
    reshade,
    reshadeIsAddonBuild: reshade ? addonBuild : null,
    ours: !!(m && m.files),
    version: m ? m.version || null : null,
    reshadeFile,
    standalone: !!(m && m.reshadeProxy),
    chicken: !!chickenReShade(dir),
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
  // Merged, not replaced: a standalone ReShade recorded before this call stays recorded.
  return writeMarker(dir, {
    file: name,
    version,
    // Recorded so Remove takes back only what this app put there.
    files: [name],
    at: new Date().toISOString(),
  });
}

// ── Where the add-on comes from ──
//
// The fork first, because only its build exports ReLimiterGetApi, and without that export the
// engine's in-game Pacing page stays hidden (DlssNr_ReLimiter.cpp: no API, no page). Upstream second,
// so pacing itself still works when the fork has not published a build: ReLimiter's own overlay
// drives it and this app's slider writes its ini either way. Both are GitHub releases whose assets are
// named exactly relimiter.addon64 / relimiter.addon32, and whatever arrives is still checked by
// content in deploy() -- a release is not trusted for being on the list.
const RELEASE_SOURCES = [
  { repo: 'mrcgibb9876-hash/ReLimiter', hostApi: true },
  { repo: 'RankFTW/ReLimiter', hostApi: false },
];

function addonAssetFromRelease(release, bitness = 64) {
  const want = addonName(bitness).toLowerCase();
  const asset = ((release && release.assets) || []).find((a) => String(a.name).toLowerCase() === want);
  if (!asset) return null;
  return { url: asset.browser_download_url, name: asset.name, digest: integrity.digestFromAsset(asset), tag: release.tag_name || null };
}

// The first source with a usable build. A source that has no release yet (the fork, until it
// publishes one) answers 404, which is an ordinary "try the next one", not a failure.
//
// GitHub's API allows 60 unauthenticated calls an hour per IP, and the app spends them on its update
// checks too, so a 403/429 here is "the hour is used up", not "there is no build" -- which is what
// "Could not add frame pacing: HTTP 403; HTTP 403" was on 2026-09-25. So, per source, on a refusal:
//   1. the last answer this app got for that source (memoFile), digest and all, so the download is
//      still checked against GitHub's published hash;
//   2. failing that, GitHub's own /releases/latest/download/<asset> link, which is a plain download
//      and not an API call. No digest then, but deploy() still refuses a file that is not ReLimiter.
// The fork is still tried first, so the host API export is not lost to a rate limit.
async function resolveAddonAsset(ghHeaders, { bitness = 64, fetchImpl, sources = RELEASE_SOURCES, memoFile = null } = {}) {
  const tried = [];
  const memo = readJsonSafe(memoFile) || {};
  const refusedBy = [];
  for (const src of sources) {
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${src.repo}/releases/latest`, { headers: ghHeaders });
      if (!res.ok) {
        tried.push(`${src.repo}: HTTP ${res.status}`);
        if (res.status === 403 || res.status === 429) refusedBy.push(src);
        continue;
      }
      const found = addonAssetFromRelease(await res.json(), bitness);
      if (!found) { tried.push(`${src.repo}: no ${addonName(bitness)} in its latest release`); continue; }
      const answer = { ...found, repo: src.repo, hostApi: src.hostApi };
      if (memoFile) {
        try { fs.writeFileSync(memoFile, JSON.stringify({ ...memo, [`${src.repo}:${bitness}`]: answer }, null, 2)); } catch {}
      }
      return answer;
    } catch (e) {
      tried.push(`${src.repo}: ${(e && e.message) || e}`);
    }
  }
  for (const src of refusedBy) {
    const remembered = memo[`${src.repo}:${bitness}`];
    if (remembered && remembered.url) return { ...remembered, repo: src.repo, hostApi: src.hostApi, fromMemo: true };
  }
  if (refusedBy.length) {
    const src = refusedBy[0];
    const name = addonName(bitness);
    return { url: `https://github.com/${src.repo}/releases/latest/download/${name}`, name, digest: null, tag: null, repo: src.repo, hostApi: src.hostApi, unverified: true };
  }
  throw new Error(`No ReLimiter build could be found (${tried.join('; ')})`);
}

function readJsonSafe(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ReShade loads add-ons from AddonPath, which beside the exe is where this one goes. A ReShade.ini the
// user already has keeps everything else; only the add-on path, a DisabledAddons entry naming
// ReLimiter (ReShade honours that on every launch, so the add-on would sit there unloaded), and the
// first-run tutorial banner are touched.
// `addon` is the name ReShade would have written into DisabledAddons -- ReShade honours that list on
// every launch, so an add-on left in it sits there unloaded however correctly it was placed. Defaulted
// to ReLimiter because this started as pacing's, but RenoDX needs exactly the same treatment and a
// second copy of this function is how the two would drift.
function configureReShadeIni(dir, { addon = 'relimiter' } = {}) {
  const iniFile = path.join(dir, 'ReShade.ini');
  const existing = fs.existsSync(iniFile) ? fs.readFileSync(iniFile, 'utf8') : '';
  let next = existing;
  if (!getIniKey(next, 'ADDON', 'AddonPath')) next = setIniKey(next, 'ADDON', 'AddonPath', '.\\');
  const disabled = getIniKey(next, 'ADDON', 'DisabledAddons');
  const wanted = new RegExp(addon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (disabled && wanted.test(disabled)) {
    const kept = disabled.split(',').map((s) => s.trim()).filter((s) => s && !wanted.test(s));
    next = setIniKey(next, 'ADDON', 'DisabledAddons', kept.join(','));
  }
  if (!getIniKey(next, 'OVERLAY', 'TutorialProgress')) next = setIniKey(next, 'OVERLAY', 'TutorialProgress', '4');
  if (next !== existing) fs.writeFileSync(iniFile, next, 'utf8');
  return next !== existing;
}

// Take out only the add-on and our marker. ReShade is deliberately left alone: the Feeder route needs
// it, and a user may have installed it themselves for shaders. Removing a dependency someone else is
// using is how a clean-up turns into a bug report.
// withPlacedReShade: also the plain ReShade64.dll this app placed for pacing (placedReShade), for a game
// where OptiScaler would otherwise go on loading it beside its upscaler with nothing to show for it.
// keepReShade: another ReShade add-on this app installed (RenoDX, addons.installedAddonIds) still needs
// the ReShade placed here. Only pacing's own files go; the ReShade stays, and so does the part of our
// marker that records it as ours, so the last add-on's Remove -- or installing DLSS 5, which demotes a
// standalone proxy -- can still find it.
function remove(dir, { withPlacedReShade = false, keepReShade = false } = {}) {
  const m = marker(dir);
  const removed = [];
  if (keepReShade) {
    for (const name of (m && m.files) || [ADDON_64, ADDON_32]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(name); }
    }
    if (m && m.reshadePlaced) {
      fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ tool: m.tool || 'ReLimiter', reshadePlaced: true, reshadeProxy: m.reshadeProxy || null }, null, 2));
    } else if (m) {
      fs.rmSync(path.join(dir, MARKER), { force: true });
      removed.push(MARKER);
    }
    return removed;
  }
  if (withPlacedReShade && placedReShade(dir)) {
    fs.rmSync(path.join(dir, 'ReShade64.dll'), { force: true });
    removed.push('ReShade64.dll');
  }
  for (const name of (m && m.files) || [ADDON_64, ADDON_32]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(name); }
  }
  // The one exception to leaving ReShade alone: a proxy this app placed for frame pacing on a game
  // with no OptiScaler. Nothing else there loads it, so left behind it would be ReShade hooking the
  // game for no reason.
  const chicken = (chickenReShade(dir) || '').toLowerCase();
  if (m && m.reshadeProxy && m.reshadePlaced && m.reshadeProxy.toLowerCase() !== chicken) {
    const p = path.join(dir, m.reshadeProxy);
    if (isReShadeProxy(p)) { fs.rmSync(p, { force: true }); removed.push(m.reshadeProxy); }
  }
  const mp = path.join(dir, MARKER);
  if (fs.existsSync(mp)) { fs.rmSync(mp, { force: true }); removed.push(MARKER); }
  return removed;
}

// ── Its own config ──
//
// LoadConfig takes the DLL's own path and swaps the extension, so relimiter.addon64 reads
// relimiter.ini beside the exe -- the same file RHI ships a copy of. The section is [FrameLimiter].
// Written with the app's ordinary ini writer; the values below are all this app ever sets, and every
// other key in that file is ReLimiter's own business.
const INI_NAME = 'relimiter.ini';
const INI_SECTION = 'FrameLimiter';

function iniPath(dir) {
  return path.join(dir, INI_NAME);
}

// target_fps: 0 is not "no limit", it is "stay below the VRR ceiling", and ValidateConfig clamps
// anything else to 30..1000. A value outside that is discarded on the next load, so it is clamped
// here rather than written and silently lost -- and 0 is passed through untouched, because clamping it
// up to 30 would turn "automatic" into a hard 30 fps cap.
const TARGET_FPS_MIN = 30;
const TARGET_FPS_MAX = 1000;

function targetFpsEdits(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return [{ section: INI_SECTION, key: 'target_fps', value: '0' }];
  const clamped = Math.round(Math.min(TARGET_FPS_MAX, Math.max(TARGET_FPS_MIN, n)));
  return [{ section: INI_SECTION, key: 'target_fps', value: String(clamped) }];
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
  NGX_DEVICE_HOLD_MARK, engineKeepsNgxDevice, XEFG_RESHADE_MARK, engineGivesXefgToReShade,
  marker, deployed, status, missing, deploy, remove,
  isReShadeProxy, chickenReShade, placedReShade, ownsReShade, writeMarker, standaloneProxyName, reshadeFileIn, promoteToStandalone, demoteStandaloneReShade,
  RELEASE_SOURCES, addonAssetFromRelease, resolveAddonAsset, configureReShadeIni,
  NR_FPS_TARGET_MODE, nrConflict, NR_CONFLICT_EDITS,
  INI_NAME, INI_SECTION, iniPath, targetFpsEdits, TARGET_FPS_MIN, TARGET_FPS_MAX,
};
