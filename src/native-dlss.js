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
const emulators = require('./emulators');

const STREAMLINE_BESIDE_EXE = ['sl.interposer.dll', 'sl.interposer.dll.original'];
const PLUGIN_TREE_FILES = ['nvngx_dlss.dll', 'sl.interposer.dll'];
// Anywhere else in the game's own install tree. sl.dlss.dll is Streamline's DLSS feature plugin
// and nvngx_dlssg.dll the DLSS-G model: a game only ever carries those if it shipped DLSS.
const GAME_TREE_FILES = ['nvngx_dlss.dll', 'sl.interposer.dll', 'sl.dlss.dll', 'nvngx_dlssg.dll'];

// Folders beside the exe that THIS app fills: a hit inside them is our deploy, not the game's.
// streamline\ is NOT on this list unconditionally: Where Winds Meet keeps its own Streamline
// runtime (sl.interposer.dll, sl.dlss.dll, nvngx_dlss.dll, nvngx_dlssg.dll) in
// Engine\Binaries\Win64r\Streamline\, and this app's own deploy of that folder is journaled in
// .optiscaler-manager-install.json (streamline.dir) -- so the journal decides, see ownStreamlineDir().
// host64 is this app's own too, and it is the one that was missed. The 32-bit route (legacy.js)
// builds it beside the exe and puts nvngx_dlss.dll in it for the helper to load -- so the tree
// walk below found our own DLL and reported that the GAME ships DLSS. Every gate that asks this
// question then went the wrong way at once: route.js called the Feeder mis-deployed and dropped
// the game off the feeder32 route, and Game Help, seeing a 32-bit game not on that route, answered
// "DLSS 5 is not currently available: it is a 32-bit game" about an install that was running
// Neural Rendering at the time (Alien: Isolation, 2026-09-14, 3600 frames and a clean shutdown in
// its own log). The comment at the top of this file claimed nothing this app deploys could produce
// this evidence; host64\ is exactly that, and had been since the 32-bit route shipped.
const OWN_FOLDERS_BESIDE_EXE = new Set(['optiscaler', 'reshade-shaders', 'luma', 'host64']);

function ownStreamlineDir(exeDir) {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(exeDir, '.optiscaler-manager-install.json'), 'utf8'));
    return journal && journal.streamline && journal.streamline.dir ? path.resolve(exeDir, journal.streamline.dir).toLowerCase() : null;
  } catch {
    return null;
  }
}
// Where a game's install root sits: the folder whose parent is one of these is the root.
const INSTALL_PARENTS = new Set(['common', 'games', 'epic games', 'gog games', 'gog galaxy', 'xboxgames',
  'program files', 'program files (x86)', 'ubisoft game launchers', 'ea games', 'origin games', 'battle.net']);
const ROOT_ASCEND_MAX = 4;
const TREE_WALK_MAX_DEPTH = 6;
const TREE_WALK_MAX_ENTRIES = 40000;

const SHIPPED_CACHE_TTL_MS = 30 * 1000;
const shippedCache = new Map();

function findShippedDlss(dir) {
  for (const name of STREAMLINE_BESIDE_EXE) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return findUnrealPluginFile(dir, PLUGIN_TREE_FILES) || findInGameTree(dir, GAME_TREE_FILES);
}

// The third place a game keeps its DLSS: not beside the exe, not in an Unreal plugin tree, but
// somewhere else under its own install folder -- Where Winds Meet (Messiah engine) is the case
// that found this: nothing DLSS-shaped beside the exe, so the exe-folder and Unreal checks both
// said "no DLSS", the route became OptiScaler + Feeder, and the Feeder was deployed on a game
// that runs DLSS 4 of its own in DX12 mode.
//
// The install root is the nearest ancestor whose parent is a launcher's games folder
// (steamapps\common, Epic Games, GOG Games...). That bound matters: walking up an unbounded
// number of levels from <Game>\bin\x64 reaches the library folder, and a search from there
// finds some OTHER game's DLSS and calls this one native. With no such parent within
// ROOT_ASCEND_MAX levels, the root is the exe folder itself.
//
// Excluded on the way: the exe folder itself for nvngx_dlss.dll (the Feeder and Luma deploys
// put it there -- the beside-the-exe copy is judged by the deploy markers, in hasNativeDlss), and
// the folders beside the exe that this app fills (streamline\, OptiScaler\, reshade-shaders\,
// Luma\). Bounded by depth and by a total entry count so a 100 GB asset tree cannot stall a
// card render; the result is memoised with the rest of shippedDlssPath.
function findInGameTree(exeDir, names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const root = installRoot(exeDir);
  const exeDirKey = path.resolve(exeDir).toLowerCase();
  const ownStreamline = ownStreamlineDir(exeDir);
  let budget = TREE_WALK_MAX_ENTRIES;

  const walk = (dir, depth) => {
    if (depth > TREE_WALK_MAX_DEPTH || budget <= 0) return null;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    budget -= entries.length;
    const here = path.resolve(dir).toLowerCase();
    const isExeDir = here === exeDirKey;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (!wanted.has(lower)) continue;
      if (isExeDir && lower === 'nvngx_dlss.dll') continue; // ours or the game's: markers decide
      return path.join(dir, e.name);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (isExeDir && OWN_FOLDERS_BESIDE_EXE.has(e.name.toLowerCase())) continue;
      if (ownStreamline && path.resolve(dir, e.name).toLowerCase() === ownStreamline) continue;
      const hit = walk(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}

// Reaching the drive root means no launcher's games folder was found on the way, which is the "no such
// parent" case: the exe folder is the root. It used to return the drive root itself, and a library
// the list does not know ("D:\GAMES 2TB\Tomb Raider 1-3 Remastered", two players' bundles 2026-09-15)
// then had the whole drive walked, some other game's nvngx_dlss.dll found, and an OpenGL game with no
// DLSS routed as "ships its own DLSS" -- OptiScaler as dxgi.dll, never loaded, Game Help stuck on
// "needs a run".
function installRoot(exeDir) {
  let cur = path.resolve(exeDir);
  for (let up = 0; up <= ROOT_ASCEND_MAX; up++) {
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(exeDir); // drive root: no games folder above this game
    if (INSTALL_PARENTS.has(path.basename(parent).toLowerCase())) return cur;
    cur = parent;
  }
  return path.resolve(exeDir);
}

// An emulator (emulators.js) never has DLSS of its own: it makes no DLSS call, whatever console game
// it runs, so the Feeder is always its DLSS source. Asked of the folder rather than the exe because
// every gate here only has the folder. Without this, RPCS3 was told it "already has native DLSS" and
// kept off the Feeder -- by the nvngx_dlss.dll the Feeder deploy itself places beside the exe, or by
// the install-tree walk finding DLSS files that belong to something else under the same root.
const emulatorCache = new Map();

function isEmulatorDir(dir) {
  const key = path.resolve(dir).toLowerCase();
  const now = Date.now();
  const hit = emulatorCache.get(key);
  if (hit && now - hit.at < SHIPPED_CACHE_TTL_MS) return hit.result;
  let result = false;
  try {
    result = fs.readdirSync(dir).some((name) => emulators.profileFor(name) !== null);
  } catch {
    result = false;
  }
  emulatorCache.set(key, { at: now, result });
  return result;
}

// Full path of the game's own DLSS/Streamline file, or null.
function shippedDlssPath(dir) {
  const key = path.resolve(dir).toLowerCase();
  const now = Date.now();
  const hit = shippedCache.get(key);
  if (hit && now - hit.at < SHIPPED_CACHE_TTL_MS) return hit.result;
  const result = isEmulatorDir(dir) ? null : findShippedDlss(dir);
  shippedCache.set(key, { at: now, result });
  return result;
}

function shipsNativeDlss(dir) {
  return shippedDlssPath(dir) !== null;
}

// A detection whose renderer cannot make a DLSS call: DirectX 8, 9 or 10, whether the game presents it
// itself or through a Vulkan wrapper such as DXVK. DLSS needs D3D11, D3D12 or native Vulkan, so
// Streamline or DLSS files beside such a game belong to a mod. A game that also links D3D11 or D3D12 is
// not called legacy -- it may have a modern path.
const LEGACY_APIS = ['dx8', 'dx9', 'dx10'];
function rendererCannotCallDlss(detected) {
  if (!detected) return false;
  const apis = new Set([detected.api, ...(detected.apis || [])].filter(Boolean));
  if (apis.has('dx11') || apis.has('dx12')) return false;
  if (LEGACY_APIS.includes(detected.api)) return true;
  return !!detected.vulkanWrapper && LEGACY_APIS.some((a) => apis.has(a));
}

function hasNativeDlss(dir) {
  if (isEmulatorDir(dir)) return false;
  return shipsNativeDlss(dir) || fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));
}

module.exports = { shippedDlssPath, shipsNativeDlss, hasNativeDlss, installRoot, findInGameTree, isEmulatorDir, rendererCannotCallDlss };
