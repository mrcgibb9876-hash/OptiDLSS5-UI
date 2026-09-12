// RE Engine games that ship no DLSS of their own -- Resident Evil 2, 3, 4, 7 and Village -- and
// how OptiScaler gets a DLSS call there. The tool this app mirrors (RHI, manifest.json's
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
const PD_UPSCALER_ZIP_URL = 'https://nightly.link/praydog/REFramework/workflows/dev-release/pd-upscaler/REFramework.zip';
const PD_PLUGIN_NAME = 'PDPerfPlugin.dll';
const PD_PLUGIN_PAGE_URL = 'https://www.nexusmods.com/site/mods/502';
const PD_PLUGIN_PAGE_LABEL = 'Upscaler Base Plugin by PureDark on Nexus Mods';
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
  };
}

// The nightly.link artifact is a zip holding REFramework.zip, which holds dinput8.dll and
// reframework_revision.txt. Returns the revision text (the build's commit) once extracted.
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
  PD_UPSCALER_EXES, PD_UPSCALER_ZIP_URL, PD_PLUGIN_NAME, PD_PLUGIN_PAGE_URL, PD_PLUGIN_PAGE_LABEL, REFRAMEWORK_BUILD_MARKER,
  pdUpscalerGame, pdStatus, readBuildMarker, writeBuildMarker, extractPdReframework,
};
