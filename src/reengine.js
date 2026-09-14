// RE Engine games that ship no DLSS of their own -- Resident Evil 2, 3, 4, 7 and Village.
//
// CURRENT ROUTE (engine with the DLSS-NR Present route, 2026-09-14): no DLSS call is needed at all.
// OptiScaler runs Neural Rendering at the game's Present, on top of the game's own TAA, and finds the
// scene depth itself by watching the game's depth buffers -- the approach of LCPD15's DXL, ported into
// the engine. Proven on Resident Evil 2: thousands of frames, no failures, the panel live. So this app
// no longer places PureDark's plugin or nvngx_dlss.dll for these five, removes a plugin copy it placed
// earlier, and switches REFramework's TemporalUpscaler off (presentRouteConfigure), because that mod
// replaces the game's TAA with a DLSS call and, without the plugin, with nothing. REFramework itself
// stays: the engine's RE Engine support expects it.
//
// What follows is the previous route, kept because the REFramework download below still serves it.
// The tool this app mirrors (RHI, manifest.json's
// pdUpscalerGames) swaps REFramework for praydog's "pd-upscaler" branch build on these five
// whenever OptiScaler is installed. That build carries REFramework's TemporalUpscaler mod: it
// hands the engine's own colour, depth, motion vectors and jitter to an upscaler plugin, which
// makes the DLSS call OptiScaler then hooks -- real motion vectors, not the Feeder's estimated
// ones. Three files, three sources:
//
//   dinput8.dll        the pd-upscaler REFramework build (nightly.link, zip inside a zip). This
//                      app fetches it; the standard nightly build has no TemporalUpscaler.
//   PDPerfPlugin.dll   PureDark's Upscaler Base Plugin. The plugin TemporalUpscaler loads from
//                      the game folder (utility::load_module_from_current_directory in
//                      TemporalUpscaler.cpp); without it the mod logs "TemporalUpscaler will not
//                      work". Distributed on Nexus Mods only, not redistributable, so the user
//                      fetches this one file themselves.
//   nvngx_dlss.dll     the DLSS runtime the plugin's DLSS path loads. This app places it, the
//                      same way the Feeder deploy does.
//
// In-game, REFramework's menu (Insert) -> TemporalUpscaler -> Enabled, Upscale Type DLSS.

const fs = require('node:fs');
const path = require('node:path');
const { openZip, findEntry, extractEntry, extractEntryTo } = require('./zip');

const PD_UPSCALER_EXES = { 're2.exe': 'RE2', 're3.exe': 'RE3', 're4.exe': 'RE4', 're7.exe': 'RE7', 're8.exe': 'RE8' };
// Where the pd-upscaler build comes from, and why it moved.
//
// It used to be praydog's own branch artifact through nightly.link. That URL answers 404 -- checked
// live, 2026-09-13 -- and OptiScaler's own wiki page for Resident Evil 2 says why: the official
// repo's artifact links have expired, and PDPerfPlugin does not work with the new unified
// monolithic REFramework in any case. The wiki points at TheRazerMD's fork, which publishes the
// same pd-upscaler build as a release, and that is where this fetches from now.
//
// The shape changed with the source: one zip per game (RE2.zip, RE3.zip, ...), each holding
// dinput8.dll on its own, rather than one build for all five nested zip-in-zip. So the cache is per
// game now, and a game whose asset is missing from the release says so instead of silently taking
// another game's build.
//
// That release also carries `_TDB` variants -- RE2_TDB66, RE3_TDB67, RE7_TDB49. Those are for the
// pre-ray-tracing versions of those games, whose type database differs; REFramework refuses to
// attach to the wrong one and says so in its own log. This fetches the ordinary asset, which is the
// current build a default Steam install gets.
const PD_UPSCALER_RELEASES_API = 'https://api.github.com/repos/TheRazerMD/REFramework/releases';
const PD_UPSCALER_SOURCE_LABEL = 'TheRazerMD/REFramework (pd-upscaler builds)';
const PD_PLUGIN_NAME = 'PDPerfPlugin.dll';
// 1.1.2 specifically, not "latest". OptiScaler's wiki is explicit that 1.2.0 "doesn't load the
// back-end properly", and the plugin is the piece the user has to fetch by hand -- so the link they
// are given has to land on the version that works, not on the newest file.
const PD_PLUGIN_PAGE_URL = 'https://www.nexusmods.com/site/mods/502?tab=files&file_id=2293';
const PD_PLUGIN_PAGE_LABEL = 'Upscaler Base Plugin 1.1.2 by PureDark on Nexus Mods';
const PD_PLUGIN_WANTED_VERSION = '1.1.2';
// Which REFramework build this app placed, so a standard one it put there earlier can be
// swapped for the pd build without touching a hand-placed dinput8.dll.
const REFRAMEWORK_BUILD_MARKER = '.dlss5ui-reframework.json';

function pdUpscalerGame(exePath) {
  if (!exePath) return null;
  return PD_UPSCALER_EXES[path.basename(exePath).toLowerCase()] || null;
}

function readBuildMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, REFRAMEWORK_BUILD_MARKER), 'utf8')); } catch { return null; }
}

function writeBuildMarker(dir, data) {
  fs.writeFileSync(path.join(dir, REFRAMEWORK_BUILD_MARKER), JSON.stringify({ ...data, placedAt: new Date().toISOString() }, null, 2), 'utf8');
}

// What the pd route needs and what is there. reframeworkBuild is 'pd-upscaler', 'standard'
// (this app placed the ordinary nightly) or 'unknown' (hand-placed, or from before the marker).
function pdStatus(dir, exePath) {
  const game = pdUpscalerGame(exePath);
  if (!game) return null;
  const marker = readBuildMarker(dir);
  const reframeworkPresent = fs.existsSync(path.join(dir, 'dinput8.dll'));
  return {
    game,
    reframeworkPresent,
    reframeworkBuild: !reframeworkPresent ? null : marker && marker.build ? marker.build : 'unknown',
    reframeworkRevision: marker && marker.revision ? marker.revision : null,
    pluginPresent: fs.existsSync(path.join(dir, PD_PLUGIN_NAME)),
    dlssPresent: fs.existsSync(path.join(dir, 'nvngx_dlss.dll')),
    temporalUpscalerOn: temporalUpscalerOn(dir),
  };
}

// REFramework's settings file is named after the game (re2_fw_config.txt, re8_fw_config.txt), and it
// only exists once the game has run with REFramework in place. Every one present is returned.
function reframeworkConfigFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /_fw_config\.txt$/i.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

const TEMPORAL_UPSCALER_KEY = 'TemporalUpscaler_Enabled';

// Whether any of the game's REFramework configs has TemporalUpscaler switched on.
function temporalUpscalerOn(dir) {
  return reframeworkConfigFiles(dir).some((file) => {
    try {
      return /^TemporalUpscaler_Enabled\s*=\s*true\s*$/im.test(fs.readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
}

// The Present route's REFramework setting: TemporalUpscaler off, so the game renders with its own TAA and
// no DLSS call is attempted. Only an existing key is changed -- a config REFramework has not written yet
// has the mod off by default. Returns the files changed.
function presentRouteConfigure(dir) {
  const changed = [];
  for (const file of reframeworkConfigFiles(dir)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const next = text.replace(/^(TemporalUpscaler_Enabled\s*=\s*)true(\s*)$/im, '$1false$2');
    if (next !== text) {
      fs.writeFileSync(file, next, 'utf8');
      changed.push(path.basename(file));
    }
  }
  return changed;
}

// The asset in that release for one game code: RE2 -> RE2.zip.
function pdUpscalerAssetName(game) {
  return `${game}.zip`;
}

// Handles both shapes on purpose: TheRazerMD's per-game zip holds dinput8.dll flat, while the old
// nightly.link artifact was a zip holding REFramework.zip holding the dll. A cached copy from
// before this change is still a valid zip of the second kind. Returns the revision text (the
// build's commit) when the zip carries one.
function extractPdReframework(zipPath, destDll) {
  const outer = openZip(zipPath);
  let inner = outer;
  const innerEntry = findEntry(outer, /\.zip$/i);
  if (innerEntry) inner = openZip(extractEntry(outer, innerEntry));
  const dll = findEntry(inner, /(^|\/)dinput8\.dll$/i);
  if (!dll) throw new Error('dinput8.dll not found in the pd-upscaler REFramework download');
  extractEntryTo(inner, dll, destDll);
  const rev = findEntry(inner, /reframework_revision\.txt$/i);
  return rev ? extractEntry(inner, rev).toString('utf8').trim() : null;
}

module.exports = {
  PD_UPSCALER_EXES, PD_UPSCALER_RELEASES_API, PD_UPSCALER_SOURCE_LABEL, pdUpscalerAssetName,
  PD_PLUGIN_NAME, PD_PLUGIN_PAGE_URL, PD_PLUGIN_PAGE_LABEL, PD_PLUGIN_WANTED_VERSION, REFRAMEWORK_BUILD_MARKER,
  pdUpscalerGame, pdStatus, readBuildMarker, writeBuildMarker, extractPdReframework,
  TEMPORAL_UPSCALER_KEY, reframeworkConfigFiles, temporalUpscalerOn, presentRouteConfigure,
};
