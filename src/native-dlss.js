// Does this game have DLSS of its own? One answer, shared by every gate that depends on it --
// main.js's hasNativeDlss (the DLSS 5 only profile), feeder.js's needsFeeder (the Feeder gate),
// route.js's shippedDlss (the card's route tag) and losslessEligibility. They used to be three
// copies of the same two-line exe-folder check, and the copies were all wrong the same way:
//
//   An Unreal game keeps NVIDIA's DLLs under its plugin tree, not beside the exe --
//   <Root>/Engine/Plugins/DLSS/Binaries/ThirdParty/Win64/nvngx_dlss.dll and
//   <Root>/Engine/Plugins/StreamlineCore/Binaries/ThirdParty/Win64/sl.interposer.dll -- so the
//   exe-folder check said "no native DLSS", the Feeder got deployed on top of the game's real
//   DLSS, and the two crashed together (Code Vein 2, 2026-09-11: the Feeder's synthetic
//   CreateFeature faulted inside the game's own Streamline stack with two nvngx_dlss.dll copies
//   loaded, then NVIDIA's Shutdown1 faulted on the way out -- dlss5-feed.log and the UE crash
//   reporter both had it).
//
// Two questions, deliberately separate:
//
//   shippedDlssPath(dir)  Evidence the GAME shipped DLSS: a Streamline interposer beside the
//                         exe, or DLSS/Streamline files anywhere in the Unreal plugin tree.
//                         Nothing this app deploys ever produces either, so this survives a
//                         Feeder/Luma deploy -- it is what tells a mis-deployed Feeder apart.
//   hasNativeDlss(dir)    The above, or an nvngx_dlss.dll beside the exe -- which the Feeder
//                         and Luma deploys place themselves, so on its own it cannot tell a
//                         native game from a synthesised one; the deploy markers do that.
//
// The plugin walk is framegen.js's (it already had to find nvngx_dlssg.dll the same way), and
// the shipped answer is memoised briefly: route.js runs for every card on every grid render,
// and the files it looks for are the game's own, which no action of this app moves.

const path = require('node:path');
const fs = require('node:fs');
const { findUnrealPluginFile } = require('./framegen');

const STREAMLINE_BESIDE_EXE = ['sl.interposer.dll', 'sl.interposer.dll.original'];
const PLUGIN_TREE_FILES = ['nvngx_dlss.dll', 'sl.interposer.dll'];

const SHIPPED_CACHE_TTL_MS = 30 * 1000;
const shippedCache = new Map();

function findShippedDlss(dir) {
  for (const name of STREAMLINE_BESIDE_EXE) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return findUnrealPluginFile(dir, PLUGIN_TREE_FILES);
}

// Full path of the game's own DLSS/Streamline file, or null.
function shippedDlssPath(dir) {
  const key = path.resolve(dir).toLowerCase();
  const now = Date.now();
  const hit = shippedCache.get(key);
  if (hit && now - hit.at < SHIPPED_CACHE_TTL_MS) return hit.result;
  const result = findShippedDlss(dir);
  shippedCache.set(key, { at: now, result });
  return result;
}

function shipsNativeDlss(dir) {
  return shippedDlssPath(dir) !== null;
}

function hasNativeDlss(dir) {
  return shipsNativeDlss(dir) || fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));
}

module.exports = { shippedDlssPath, shipsNativeDlss, hasNativeDlss };
