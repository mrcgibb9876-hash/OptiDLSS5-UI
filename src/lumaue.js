// Luma Framework's Unreal Engine mod (Filoppi/Luma-Framework) for games with no native DLSS
// of their own -- specifically STAR WARS Jedi: Fallen Order, per the OptiScaler wiki's own page
// for this game (github.com/optiscaler/OptiScaler/wiki/STAR-WARS-Jedi-Fallen-Order). Fallen
// Order (2019) shipped with UE4's stock TAA only -- no DLSS, no FSR, no XeSS -- so, like the
// DLSS5-Feeder (feeder.js), OptiScaler's Neural Rendering pass has nothing to hook unless
// something else synthesises a DLSS evaluate call first. Luma is that something else here:
// a ReShade add-on that replaces UE4's TAA with DLAA/FSR3 and, in doing so, makes the real DLSS
// call OptiScaler's Neural Rendering pass hooks.
//
// Scope (widened 2026-09-11, after the Fallen Order deploy was verified end to end -- Luma's
// overlay, DLSS selected there, the NR pass evaluating through dlss_12): Luma is "a modding
// framework that facilitates improving graphics in DirectX 11 games" (its README), its Unreal
// Engine mod detects UE4's TAA shaders generically and "works in the majority of games out of the
// box" (its own tooltip), and it skips any non-D3D11 device (CHECK_GRAPHICS_API_COMPATIBILITY).
// So the gate is the mod's own: Unreal Engine 4, rendering with DirectX 11, no DLSS of the game's
// own -- isLumaUeGame() below. Fallen Order stays special only for what is specific to it: the
// open menu bug and the AMD/Intel ini workaround from the OptiScaler wiki. UE3 (Batman: Arkham
// Knight, no version string) and any UE game on DX12 stay on the Feeder.
//
// KNOWN, OPEN, UNRESOLVED BUG (checked 2026-09-10, Luma-Framework issue #122, still open, no
// maintainer response): character pop-in and an "unnatural amount of noise" when opening any
// in-game menu with this combo. The reporter notes gameplay itself is fine as long as no menu
// is opened. Surfaced in lumaUeReadiness() below so the UI shows it before/after deploy -- do
// not silently hide this behind a working-looking readiness state.
//
// LICENSE: Luma-Framework's LICENSE.md is a custom MIT variant with two added terms beyond
// plain MIT -- (1) reuse must name the authors/project, (2) "Commercial usage is possible but
// only after asking permission to the authors." Whether an installer auto-deploying built
// binaries on a user's behalf counts as commercial use is genuinely unclear for a free tool, but
// it is not this app's call to make unilaterally. Same posture as feeder.js's LumeniteFX entry:
// not auto-fetchable without a real, per-action confirmation, and always fetched live from the
// official GitHub release (never mirrored/cached in this repo) so nothing here is an independent
// redistribution of a copy.
//
// UNTESTED: written without the game (the user doesn't own it). Every file name, zip layout, and
// ini key below is sourced from Luma-Framework's actual latest release asset (fetched and
// inspected directly, 2026-09-10) and the OptiScaler wiki's own setup page for this game -- not
// guessed -- but the deploy has never been run against a real Fallen Order install. Flag that to
// the user rather than presenting this as verified the way the Feeder integration is.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { openZip, findEntry, findEntries, extractEntryTo } = require('./zip');
const { setIniKey, getIniKey } = require('./ini-merge');
const feeder = require('./feeder');
const integrity = require('./integrity');
const verified = require('./verified');
const { readFileVersion } = require('./detect');

// The app's backup suffix for a game file it replaced (main.js ORIG_BACKUP_SUFFIX, which the full uninstall
// restores by name).
const ORIG_BACKUP_SUFFIX = '.dlss5ui-orig';

const LUMA_RELEASES_API = 'https://api.github.com/repos/Filoppi/Luma-Framework/releases/latest';

// Which Luma mod a game gets. Luma-Framework publishes one zip per game mod, all with the same layout
// (Luma\ shaders, Luma's ReShade as dxgi.dll, one compiled .addon, nvngx_dlss.dll), so a profile is
// just the asset and the add-on name. The production builds, never "-Test" (Luma's debug variant).
//
//   ue    Luma's generic Unreal Engine 4 mod: stock TAA replaced with DLAA (Fallen Order, verified).
//   prey  Pumbo's Prey (2017) mod: the game's post-processing rebuilt with DLSS Super Resolution and
//         HDR -- a real DLSS call with the engine's own motion vectors and depth, where the Feeder
//         could only estimate them. Asked for by a user (2026-09-15); the OptiScaler wiki's Prey page
//         documents exactly this stack ("Method 1": Luma's ReShade renamed ReShade64.dll, OptiScaler
//         as dxgi.dll, LoadReshade=true), which is the layout this module already deploys.
//         Luma-Prey.zip listed directly (latest-676): Luma/** (incl. its own d3dcompiler_47.dll),
//         dxgi.dll, Luma-Prey.addon, nvngx_dlss.dll.
const LUMA_PROFILES = {
  ue: { id: 'ue', name: 'Luma UE', asset: /^Luma-Unreal_Engine\.zip$/i, assetName: 'Luma-Unreal_Engine.zip', addon: 'Luma-Unreal Engine.addon' },
  prey: { id: 'prey', name: 'Luma (Prey)', asset: /^Luma-Prey\.zip$/i, assetName: 'Luma-Prey.zip', addon: 'Luma-Prey.addon' },
};

// Every other game's Luma mod comes from Luma-Framework itself (lumacatalog.js): the per-game zips in its
// release that carry DLSS, matched to the game by name. `mod` is a catalog entry.
function profileFromMod(mod) {
  if (!mod || !mod.addon) return null;
  const esc = mod.asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { id: mod.key, name: 'Luma', asset: new RegExp(`^${esc}$`, 'i'), assetName: mod.asset, addon: mod.addon, status: mod.status || null, catalog: true };
}

// Every Luma add-on in a folder: Luma names each one after its game ("Luma-Monster Hunter World.addon").
const LUMA_ADDON_PATTERN = /^Luma-.+\.addon(32|64)?$/i;
function lumaAddonsIn(dir) {
  try { return fs.readdirSync(dir).filter((n) => LUMA_ADDON_PATTERN.test(n)); } catch { return []; }
}

// Prey (2017) and Mooncrash: Prey.exe under Binaries\Danielle\x64\Release, CryEngine DLLs beside it.
// The path or CrySystem.dll tells it apart from Prey (2006), a 32-bit idTech 4 game with the same exe name.
function isPrey2017(exePath) {
  if (!exePath || path.basename(exePath).toLowerCase() !== 'prey.exe') return false;
  const dir = path.dirname(exePath);
  return /[\\/]danielle[\\/]/i.test(dir) || fs.existsSync(path.join(dir, 'CrySystem.dll'));
}

// The Luma mod for this game, or null. `detected` as for isLumaUeGame; `lumaMod` is the catalog match the
// caller found for the game's names (main.js lumaModFor), which wins over the built-in profiles.
function lumaProfileFor(exePath, detected, lumaMod = null) {
  const fromCatalog = profileFromMod(lumaMod);
  if (fromCatalog) return fromCatalog;
  if (isPrey2017(exePath)) return LUMA_PROFILES.prey;
  if (isLumaUeGame(exePath, detected)) return LUMA_PROFILES.ue;
  return null;
}

// The profile of the Luma mod on disk here, if any: from the deploy marker when it names one, else from
// the add-on's own file name.
function deployedProfile(dir) {
  const addons = lumaAddonsIn(dir);
  if (!addons.length) return null;
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(dir, LUMA_DEPLOY_MARKER), 'utf8')); } catch {}
  if (marker && marker.asset && marker.addon && addons.includes(marker.addon)) {
    return profileFromMod({ key: marker.profile || marker.asset, asset: marker.asset, addon: marker.addon }) || null;
  }
  const known = Object.values(LUMA_PROFILES).find((p) => addons.includes(p.addon));
  return known || { id: 'unknown', name: 'Luma', addon: addons[0] };
}

// Real names inside the release zip, confirmed by downloading and listing it directly
// (2026-09-10, tag latest-645): Luma/** (shader source Luma's addon loads from disk at
// runtime), dxgi.dll (Luma's own ReShade-based proxy), "Luma-Unreal Engine.addon" (the actual
// compiled ReShade add-on), and its own bundled nvngx_dlss.dll (not used here -- see
// deployLumaUeStack, we reuse feeder.js's deployNvngxDlss instead so there is one trusted
// source for that file across both integrations rather than two).
const LUMA_SHADER_PREFIX = 'Luma/';
const LUMA_DXGI_ENTRY = /^dxgi\.dll$/i;

// Method 2 from the OptiScaler wiki page for this game: OptiScaler takes the dxgi.dll proxy
// slot (installProxy() in main.js, same as every other game in this app), and Luma's own
// dxgi.dll is deployed as a plain, non-proxying file under this name instead -- exactly the
// same "OptiScaler proxies, ReShade-based tool loads alongside via LoadReshade" shape feeder.js
// already uses, for the same reason (two independent proxies fighting over the swapchain hook
// broke on a real game there; see feeder.js's file header).
const RESHADE_DLL_NAME = 'ReShade64.dll';

const LUMA_DEPLOY_MARKER = '.dlss5ui-lumaue-deploy.json';

const LUMA_LICENSE_SUMMARY = 'Custom MIT licence (Filoppi/Luma-Framework). Standard MIT terms, ' +
  'plus: reuse must name the authors/project, and commercial use needs the authors\' permission ' +
  'first. This always fetches live from the official GitHub release -- never a cached/mirrored ' +
  'copy -- and only runs with your explicit confirmation.';

const LUMA_KNOWN_ISSUE = 'Open upstream bug (Luma-Framework issue #122, unresolved): opening ' +
  'any in-game menu with this combo causes character pop-in and visible noise. Gameplay itself ' +
  'is reported fine as long as no menu is opened. Not something this app can fix -- it lives in ' +
  'Luma\'s own Unreal Engine mod.';

// STAR WARS Jedi: Fallen Order's real render process (UE4 convention: a launcher stub at the
// game root, the actual game -- and where the proxy DLL / mods belong -- under
// SwGame\Binaries\Win64\SwGame-Win64-Shipping.exe). Not every copy launches through that
// name: a real install (2026-09-11) runs a starwarsjedifallenorder.exe sitting right beside
// SwGame-Win64-Shipping.exe, and matching the UE name alone left that game on the Feeder route.
// So the project folder is the signature -- any exe in SwGame\Binaries\Win64 next to the
// shipping exe is this game -- and the names are only the fast path.
const FALLEN_ORDER_EXE_NAMES = ['swgame-win64-shipping.exe', 'starwarsjedifallenorder.exe'];

function isFallenOrder(exePath) {
  if (!exePath) return false;
  if (FALLEN_ORDER_EXE_NAMES.includes(path.basename(exePath).toLowerCase())) return true;
  const dir = path.dirname(exePath);
  const parts = dir.split(/[\\/]/).map((p) => p.toLowerCase());
  const inSwGame = parts.length >= 3 && parts[parts.length - 1] === 'win64' &&
    parts[parts.length - 2] === 'binaries' && parts[parts.length - 3] === 'swgame';
  return inSwGame && fs.existsSync(path.join(dir, 'SwGame-Win64-Shipping.exe'));
}

// Where Luma's Unreal Engine mod applies at all: UE4 (a version string is required -- a
// version-less "Unreal Engine" is the layout-only guess, which is how UE3 titles read), D3D11 as
// the renderer, and no DLSS of the game's own. `detected` is the app's detection result (route.js
// hands the cached one over; main.js runs detection where nothing is cached).
function isLumaUeGame(exePath, detected) {
  if (isFallenOrder(exePath)) return true;
  if (!detected || detected.engineId !== 'unreal') return false;
  const version = detected.engineVersion || ((/Unreal Engine (\d+)/.exec(detected.engine || '') || [])[1]) || null;
  if (parseInt(String(version), 10) !== 4) return false;
  if (detected.api !== 'dx11') return false;
  const dir = path.dirname(exePath);
  return !fs.existsSync(path.join(dir, 'sl.interposer.dll')) && !fs.existsSync(path.join(dir, 'sl.interposer.dll.original'));
}

const LUMA_GENERIC_NOTE = 'Unverified on this game. Luma\'s Unreal Engine mod is generic for UE4 DirectX 11 games, but not ' +
  'every game survives it -- Spyro Reignited Trilogy does not start with it deployed. If this game fails to launch ' +
  'afterwards, use Remove Luma UE below; the DLSS5 Feeder route stays available either way.';

// Games where Luma UE was tried on a real install and the game did not start. Refused rather
// than warned about -- a route that is known to break the game is not a choice to offer.
const LUMA_UE_KNOWN_BAD = {
  'spyro-win64-shipping.exe': 'Spyro Reignited Trilogy does not start with Luma UE deployed (user report, 2026-09-12)',
};

function lumaUeKnownBad(exePath) {
  return verified.knownBad(exePath, 'lumaue') || LUMA_UE_KNOWN_BAD[path.basename(exePath || '').toLowerCase()] || null;
}

// The default route only where Luma UE has been verified end to end (Fallen Order). Every other
// eligible UE4 D3D11 game defaults to the Feeder and gets Luma as an experimental option in Edit
// -- the wider gate shipped in 1.25.0 on the strength of one game and broke Spyro within a day.
function isLumaUeDefault(exePath, lumaMod = null) {
  return !!(lumaMod && lumaMod.addon) || isFallenOrder(exePath) || isPrey2017(exePath) || verified.defaultRoute(exePath) === 'lumaue';
}

function lumaUeDeployed(dir) {
  return !!deployedProfile(dir);
}

// Luma reads its Super Resolution choice from ReShade.ini [Luma] SRUserType (Luma-Framework
// super_resolution.h: 0 None, 1 Auto, 2 DLSS, 3 FSR 3). Picking DLSS in the overlay is the only step
// Luma asks of the player, and opening ReShade's menu for it broke the menu in Monster Hunter: World,
// so DLSS is set here. Missing or Auto becomes DLSS; None and FSR 3 are someone's own choice and stay.
const LUMA_SR_DLSS = '2';

function ensureLumaDlss(dir) {
  if (!lumaUeDeployed(dir)) return false;
  const iniPath = path.join(dir, 'ReShade.ini');
  let text = '';
  try { text = fs.readFileSync(iniPath, 'utf8'); } catch {}
  const current = (getIniKey(text, 'Luma', 'SRUserType') || '').trim();
  if (current && current !== '1') return false;
  fs.writeFileSync(iniPath, setIniKey(text, 'Luma', 'SRUserType', LUMA_SR_DLSS), 'utf8');
  return true;
}

const LUMA_CATALOG_NOTE = 'Luma-Framework has a mod for this game that adds real DLSS with the game\'s own motion vectors. ' +
  'Luma runs on DirectX 11: pick DirectX 11 in the game\'s settings if it offers DX12, and turn the game\'s own ' +
  'DLSS off. The app switches DLSS on in Luma for you.';

const LUMA_PREY_NOTE = 'Luma\'s Prey mod adds real DLSS with the game\'s own motion vectors, the reason it beats the Feeder ' +
  'here. Not yet run with this app. The app switches DLSS on in Luma for you.';

// Same "explain, don't just disable" shape as feeder.js's feederReadiness().
function lumaUeReadiness(dir, exePath, detected = null, lumaMod = null) {
  const knownBad = lumaUeKnownBad(exePath);
  if (knownBad && !lumaUeDeployed(dir)) {
    return {
      supported: false,
      reason: 'Luma UE is known not to work here: {why}. The DLSS5 Feeder is the route for this game.',
      reasonVars: { why: knownBad },
    };
  }
  const profile = deployedProfile(dir) || lumaProfileFor(exePath, detected, lumaMod);
  if (!profile) {
    return {
      supported: false,
      reason: 'Luma UE is for Unreal Engine 4 games rendering with DirectX 11 and no DLSS of their own -- this game reads as {engine} on {api}, so the DLSS5 Feeder is the route here.',
      reasonVars: { engine: (detected && detected.engine) || 'an unknown engine', api: (detected && detected.api) ? detected.api.toUpperCase() : 'an unknown API' },
    };
  }

  const reshadeInstalled = fs.existsSync(path.join(dir, RESHADE_DLL_NAME));
  const addonInstalled = fs.existsSync(path.join(dir, profile.addon));
  const shadersInstalled = fs.existsSync(path.join(dir, 'Luma', 'Global', 'Luma_Copy_PS.hlsl'));
  const dlssInstalled = fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));

  // Both are ReShade add-ons that supply the DLSS call; two at once means two DLSS sources
  // fighting over one ReShade. Still supported -- the section stays open and Deploy does the
  // hand-over itself (lumaue:deploy removes the Feeder first). Hiding the section here is what
  // read as "still no Luma" to a real user (2026-09-11).
  const blockedByFeeder = !addonInstalled && fs.existsSync(path.join(dir, 'dlss5-feed.addon64'));

  return {
    supported: true,
    profile: profile.id,
    profileName: profile.name,
    blockedByFeeder,
    reason: blockedByFeeder
      ? 'The DLSS5 Feeder is deployed here. Luma UE and the Feeder are both ReShade add-ons supplying the DLSS call, and only one can run -- Deploy removes the Feeder first, then puts Luma UE in.'
      : null,
    // A catalog mod is experimental unless Luma's own wiki calls it working.
    experimental: profile.catalog ? profile.status !== 'working' : !isFallenOrder(exePath) && profile.id !== 'prey',
    knownBad,
    knownIssue: profile.catalog ? LUMA_CATALOG_NOTE : profile.id === 'prey' ? LUMA_PREY_NOTE : isFallenOrder(exePath) ? LUMA_KNOWN_ISSUE : LUMA_GENERIC_NOTE,
    licenseSummary: LUMA_LICENSE_SUMMARY,
    reshadeInstalled,
    addonInstalled,
    shadersInstalled,
    dlssInstalled,
    complete: reshadeInstalled && addonInstalled && shadersInstalled && dlssInstalled,
  };
}

// --- download + cache: feeder.js's downloadToCache, which checks the release asset's sha256 ---

const downloadToCache = (url, cacheDir, fileName, ghHeaders, opts) => feeder.downloadToCache(url, cacheDir, fileName, ghHeaders, opts);

async function resolveLumaAsset(ghHeaders, profile = LUMA_PROFILES.ue) {
  const res = await fetch(LUMA_RELEASES_API, { headers: ghHeaders });
  if (!res.ok) throw new Error(`Could not check the Luma-Framework release: HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) => profile.asset.test(a.name));
  if (!asset) throw new Error(`No ${profile.assetName} asset in the latest Luma-Framework release`);
  // Luma publishes a rolling "latest-<n>" tag; the cache file is named per tag so an update is fetched.
  return { url: asset.browser_download_url, name: `${String(release.tag_name || 'latest').replace(/[^\w.-]/g, '')}-${asset.name}`, tag: release.tag_name, digest: integrity.digestFromAsset(asset) };
}

// --- deploy -------------------------------------------------------------------------------

// Whole stack for Fallen Order: Luma's shader tree, its dxgi.dll renamed to ReShade64.dll
// (Method 2, see file header), its compiled add-on, nvngx_dlss.dll (via feeder.js -- one
// trusted source for that file), and the ReShade.ini bits that make ReShade actually load an
// add-on at all. Does NOT install OptiScaler and does NOT set [Plugins] LoadReshade or the
// AMD/Intel Dxgi/DontUseNTShared workaround -- same division of labour as feeder.js's
// deployFeederStack: the caller (main.js) owns ini edits that affect OptiScaler.ini itself.
//
// Refuses outright without licenseConfirmed:true -- see LUMA_LICENSE_SUMMARY. Enforced here,
// not just in the UI, so a UI bug can't silently bypass consent.
async function deployLumaUeStack(dir, { cacheDir, getRhiManifest, compareVersions, ghHeaders, force = false, licenseConfirmed = false, profile = LUMA_PROFILES.ue }) {
  if (!licenseConfirmed) {
    throw new Error('Luma UE requires explicit licence confirmation before it can be fetched -- ' +
      'see LUMA_LICENSE_SUMMARY. Refusing.');
  }

  if (lumaUeDeployed(dir) && !force) {
    return { deployed: false, reason: 'already present' };
  }

  const asset = await resolveLumaAsset(ghHeaders, profile);
  const zipPath = await downloadToCache(asset.url, cacheDir, asset.name, ghHeaders, { sha256: asset.digest });
  const zip = openZip(zipPath);

  const shaderEntries = findEntries(zip, new RegExp('^' + LUMA_SHADER_PREFIX.replace('/', '\\/')));
  if (shaderEntries.length === 0) throw new Error('No Luma/** shader files found in the Luma-Framework release');
  for (const entry of shaderEntries) {
    if (entry.name.endsWith('/')) continue; // directory entries carry no data
    extractEntryTo(zip, entry, path.join(dir, entry.name.replace(/\\/g, '/')));
  }

  const dxgiEntry = findEntry(zip, LUMA_DXGI_ENTRY);
  if (!dxgiEntry) throw new Error('dxgi.dll not found in the Luma-Framework release');
  extractEntryTo(zip, dxgiEntry, path.join(dir, RESHADE_DLL_NAME));

  const addonEntry = zip.entries.find((e) => e.name.replace(/\\/g, '/').toLowerCase() === profile.addon.toLowerCase());
  if (!addonEntry) throw new Error(`"${profile.addon}" not found in ${profile.assetName}`);
  extractEntryTo(zip, addonEntry, path.join(dir, profile.addon));

  // A game whose own nvngx_dlss.dll predates DLSS 2 (Monster Hunter: World ships 1.1.13) would hand
  // Luma's DLSS call to that runtime, which cannot serve it. Set aside under the app's backup suffix --
  // Remove (and the full uninstall) put it back -- so a current one is placed.
  const gameDlss = path.join(dir, 'nvngx_dlss.dll');
  let setAsideOldDlss = null;
  if (fs.existsSync(gameDlss)) {
    const version = readFileVersion(gameDlss);
    const major = version ? parseInt(version.split('.')[0], 10) : NaN;
    if (Number.isFinite(major) && major < 2) {
      const backup = gameDlss + ORIG_BACKUP_SUFFIX;
      if (!fs.existsSync(backup)) fs.renameSync(gameDlss, backup);
      else fs.rmSync(gameDlss, { force: true });
      setAsideOldDlss = version;
    }
  }
  const dlss = await feeder.deployNvngxDlss(dir, getRhiManifest, compareVersions, cacheDir, ghHeaders);
  // Luma ships no .fx effects (its shaders live under Luma\); pointing ReShade at the Feeder's
  // reshade-shaders folder only logs "Failed to resolve search path" every launch.
  const ini = feeder.configureReShadeIni(dir, { effectSearchPaths: '.\\' });

  fs.writeFileSync(
    path.join(dir, LUMA_DEPLOY_MARKER),
    JSON.stringify({
      lumaVersion: asset.tag, profile: profile.id, asset: profile.assetName, addon: profile.addon,
      placedNvngxDlss: !!(dlss && dlss.deployed), setAsideOldDlss, deployedAt: new Date().toISOString(),
    }, null, 2),
    'utf8',
  );
  ensureLumaDlss(dir);

  return { deployed: true, version: asset.tag, shaderFiles: shaderEntries.length, dlss, ini };
}

// Reverses deployLumaUeStack(): Luma's shader folder, its add-on, the ReShade it brought (a plain
// ReShade64.dll plus the ini/preset/log ReShade writes beside it), nvngx_dlss.dll when this app
// placed it, and the marker. Same shape as feeder.removeFeederStack().
async function removeLumaStack(dir) {
  const removed = [];
  const kept = [];
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(dir, LUMA_DEPLOY_MARKER), 'utf8')); } catch {}
  const rm = async (rel) => {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) return;
    await fsp.rm(p, { recursive: true, force: true });
    removed.push(rel);
  };
  await rm('Luma');
  for (const addon of lumaAddonsIn(dir)) await rm(addon);
  for (const name of [RESHADE_DLL_NAME, 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log']) await rm(name);
  if (!(marker && marker.placedNvngxDlss === false)) await rm('nvngx_dlss.dll');
  else kept.push('nvngx_dlss.dll (was already here before Luma)');
  // The game's own old DLSS runtime, set aside at deploy, goes back.
  const backup = path.join(dir, 'nvngx_dlss.dll' + ORIG_BACKUP_SUFFIX);
  const restored = [];
  if (fs.existsSync(backup) && !fs.existsSync(path.join(dir, 'nvngx_dlss.dll'))) {
    await fsp.rename(backup, path.join(dir, 'nvngx_dlss.dll'));
    restored.push('nvngx_dlss.dll');
  }
  await rm(LUMA_DEPLOY_MARKER);
  return { removed, kept, restored };
}

module.exports = {
  LUMA_PROFILES,
  LUMA_ADDON_PATTERN,
  lumaAddonsIn,
  profileFromMod,
  isPrey2017,
  lumaProfileFor,
  deployedProfile,
  removeLumaStack,
  isFallenOrder,
  isLumaUeGame,
  isLumaUeDefault,
  lumaUeKnownBad,
  lumaUeDeployed,
  ensureLumaDlss,
  lumaUeReadiness,
  deployLumaUeStack,
  LUMA_LICENSE_SUMMARY,
  LUMA_KNOWN_ISSUE,
  RESHADE_DLL_NAME,
};
