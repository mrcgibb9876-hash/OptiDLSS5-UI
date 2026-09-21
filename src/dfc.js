// Deep Fried Chicken as a neural consumer this app can choose, deploy and remove.
//
// WHAT IT IS, and why this is a route choice rather than a rival to be evicted.
//
// The DLSS5-Feeder manufactures a DLSS contract for a game that never makes one. Something else
// has to consume that contract and run the neural pass, and the Feeder's rule is "exactly one
// neural consumer" (its v0.11.0-beta.1 release notes). On this app's Feeder route that consumer
// has always been OptiScaler_DLSSNR -- our own fork, patched so ConflictingNrAddon stops refusing
// dlss5-feed.addon64 (engine commit f2290a39). Deep Fried Chicken is the other one people use.
//
// So the two are alternatives for the same slot, and until now this app only knew how to treat
// Chicken as a foreign toolchain to remove (detect.js FOREIGN_TOOLCHAINS). That is right when
// someone has it by accident -- PCSX2 (#89) had it layered under three other stacks and the whole
// thing silently did nothing -- and wrong when they want it. This module is the "they want it" half.
//
// WHY NOTHING HERE DOWNLOADS ANYTHING.
//
// Chicken is distributed through its author's Discord: no public repository, no release URL, and so
// nothing for integrity.js to pin a sha256 against. Its LICENSE.txt then settles it outright --
// "you may not: copy, rehost, mirror, redistribute, sublicense, sell, rent, or bundle the
// Software", unless Alexander gives prior written permission. So this is a licence term, not an
// unknown, and the same position the AMD installer is under (CLAUDE.md,
// danielblnc/DLSS-NR-on-AMD#151). A permission request is out with full credit offered; until it
// is answered, nothing here fetches. What this module does instead is take a copy the USER already has, keep it in this
// app's cache the way importDgVoodooZip keeps a user-supplied dgVoodoo2, and deploy that. The
// bytes are theirs throughout.
//
// WHAT COUNTS AS OURS.
//
// Only a deploy this module made, recorded in .dlss5ui-dfc.json with the exact names it placed.
// A Chicken copied in by hand (3.0's README installs it that way; older builds had .cmd scripts)
// has no marker, and is never deleted, never overwritten and never reported as ours -- it stays a
// foreign toolchain, as it should, because this app cannot know what else was set up with it.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { openZip, findEntry, extractEntry } = require('./zip');
const saferemove = require('./saferemove');

// Read off a real release (CP376 Beta, 20 September 2026) rather than inferred from a folder
// listing. The package ships TWO trees, and its README is explicit about which to use: "Use the
// folder matching the GAME's bitness, not Windows' bitness."
//
//   64-bit/   deep-fried-chicken.addon64, deep-fried-chicken-nvngx.dll, deep-fried-chicken.cfg
//             -> copied beside the game's ReShade
//   32-bit/   deep-fried-chicken.addon32, dfc-universal-feed.cfg,
//             host64\ (the same addon64 + nvngx + cfg, plus dfc-universal-host64.exe and its own
//             dxgi.dll -- "the hidden x64 worker and its ReShade ... starts automatically"), and
//             reshade-shaders\Shaders\DFC_Universal_Feed.fx
//
// Worth knowing for the route work: the 32-bit tree is Chicken's OWN transport. It does not use
// jlrouzies' DLSS5-Feeder at all -- DFC_Universal_Feed.fx is enabled in the game's ReShade instead.
// Only the 64-bit tree is the drop-in consumer for our Feeder route, which is all this module
// deploys today.
const ADDON = 'deep-fried-chicken.addon64';
const ADDON32 = 'deep-fried-chicken.addon32';
const NVNGX = 'deep-fried-chicken-nvngx.dll';
const CFG = 'deep-fried-chicken.cfg';
const LOG = 'deep-fried-chicken.log';
// The 32-bit route (Chicken 3.0's README, "32-BIT GAMES"): its bridge settings beside the game, and a
// host64\ folder holding the hidden x64 worker with its own copy of the add-on and the main cfg.
const BRIDGE_CFG = 'deep-fried-chicken-bridge.cfg';
const HOST_DIR = 'host64';
const TREE32 = '32-bit';
// Vulkan and OpenGL (Chicken 3.0's README, "OpenGL or Vulkan without a usable native neural route"):
// its own frame producer, which takes the place of any other feeder in the game.
const COMPAT_ADDON = 'dfc-universal-feed.addon64';
const COMPAT_TREE = 'compat';
// Every cfg a player can tune, per route. Kept in the cache on the way back to DLSS 5 and restored on
// the next switch to Chicken -- its README: "KEEP existing .cfg files".
const TUNED_CFGS = [CFG, BRIDGE_CFG, `${HOST_DIR}/${CFG}`];
// The licence, README and notices as the release actually names them. The older
// LICENSE-Deep-Fried-Chicken.md is what #89's folder carried, so detect.js still knows that name
// too; both are recognised and neither is ever modified -- its licence forbids altering
// "copyright, authorship, version, licence, or integrity information".
const DOCS = ['LICENSE.txt', 'README.txt', 'THIRD-PARTY-NOTICES.txt', 'LICENSE-Deep-Fried-Chicken.md'];
const LICENSE = 'LICENSE.txt';

// What a deploy places. The cfg and the documents go in only when the folder has none of them:
// Chicken's own README says "Keep your existing deep-fried-chicken.cfg when updating", so
// overwriting it on a re-deploy would undo exactly what the author tells people to preserve.
const PAYLOAD = [ADDON, NVNGX];
const PAYLOAD_IF_ABSENT = [CFG, ...DOCS];

// The marker is the whole ownership story: which files this app placed, where they came from, and
// when. Remove reads it rather than deleting by name, so a Chicken that was already in the folder
// when we arrived survives us.
const MARKER = '.dlss5ui-dfc.json';

// The cache folder name under the app's own cache dir. "user" in the name because there is no
// other kind -- there is no download to sit beside it -- and because it should stay obvious in a
// support bundle that these bytes came from the person, not from us.
const CACHE_NAME = 'deep-fried-chicken-user';

// The two consumers the Feeder route can hand its contract to. Stored per game; 'optiscaler' is
// the default and what every existing install is, since nothing else was possible before this.
const CONSUMERS = {
  optiscaler: {
    id: 'optiscaler',
    label: 'DLSS 5 (this app\x27s engine)',
    ours: true,
  },
  dfc: {
    id: 'dfc',
    label: 'Deep Fried Chicken',
    ours: false,
    // Surfaced wherever the choice is offered, so nobody wonders why there is no Download button.
    supply: 'You supply the files: Chicken is handed out on its author\x27s Discord, with no public download this app may fetch from.',
  },
};
const DEFAULT_CONSUMER = 'optiscaler';

function isConsumer(id) {
  return Object.prototype.hasOwnProperty.call(CONSUMERS, id);
}

// A per-game choice, normalised. Anything unrecognised -- an older record, a hand-edited file --
// reads as the default rather than throwing: the consumer is a preference, not a validated input,
// and a game that cannot be read should still install the way it always did.
function consumerOf(game) {
  const id = game && game.neuralConsumer;
  return isConsumer(id) ? id : DEFAULT_CONSUMER;
}

// ── the user's own copy ──────────────────────────────────────────────────────────────────────

// Is this folder (or the set of names inside a zip) really Deep Fried Chicken? Both payload files
// have to be there. Checked before anything is cached, so a mis-picked zip fails at the file
// picker rather than at deploy time in a game folder.
function looksLikeDfc(names) {
  const lower = new Set(names.map((n) => path.basename(String(n)).toLowerCase()));
  return lower.has(ADDON) && lower.has(NVNGX);
}

function readDfcFolder(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  if (!looksLikeDfc(names)) return null;
  return names;
}

// A release ships 64-bit/ and 32-bit/ side by side, so the folder the user picks is usually the
// archive root rather than either tree. Finds the 64-bit payload wherever it is: this folder, a
// child named for the bitness, or one level further down (the archive unpacks into a versioned
// folder). Returns null when nothing here is Chicken.
function findPayloadDir(root, depth = 0) {
  if (readDfcFolder(root)) return root;
  if (depth >= 2) return null;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  // 64-bit/ first by name, so a package holding both trees never yields the 32-bit one by accident.
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    .sort((a, b) => (/64/.test(a) ? -1 : 0) - (/64/.test(b) ? -1 : 0));
  for (const name of dirs) {
    const found = findPayloadDir(path.join(root, name), depth + 1);
    if (found) return found;
  }
  return null;
}

// Chicken's 32-bit tree: a folder with the 32-bit add-on and a host64\ holding the x64 worker's add-on.
function is32Tree(dir) {
  return fs.existsSync(path.join(dir, ADDON32)) && fs.existsSync(path.join(dir, HOST_DIR, ADDON));
}

function find32Dir(root, depth = 0) {
  if (is32Tree(root)) return root;
  if (depth >= 2) return null;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  // 32-bit/ first by name, the same way findPayloadDir looks for 64-bit/ first.
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    .sort((a, b) => (/32/.test(a) ? -1 : 0) - (/32/.test(b) ? -1 : 0));
  for (const name of dirs) {
    const found = find32Dir(path.join(root, name), depth + 1);
    if (found) return found;
  }
  return null;
}

// Chicken's Vulkan/OpenGL producer set: the folder holding its add-on (Compatibility\Vulkan-OpenGL).
function findCompatDir(root, depth = 0) {
  if (fs.existsSync(path.join(root, COMPAT_ADDON))) return root;
  if (depth >= 3) return null;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const name of entries.filter((e) => e.isDirectory()).map((e) => e.name)) {
    if (/^(32-bit|host64|reshade-shaders)$/i.test(name)) continue;
    const found = findCompatDir(path.join(root, name), depth + 1);
    if (found) return found;
  }
  return null;
}

function cachedCompat(cacheDir) {
  const p = path.join(cacheDir, CACHE_NAME, COMPAT_TREE);
  return cachedDfc(cacheDir) && fs.existsSync(path.join(p, COMPAT_ADDON)) ? p : null;
}

// The cached 32-bit tree, or null when the copy the user added had none (an older release, or only
// its 64-bit folder picked).
function cached32(cacheDir) {
  const p = path.join(cacheDir, CACHE_NAME, TREE32);
  return cachedDfc(cacheDir) && is32Tree(p) ? p : null;
}

// Takes what the user picked -- Chicken's zip, or the folder they unpacked it into -- and keeps a
// copy in this app's cache. Returns the cache path. Nothing is fetched and nothing is published:
// this is their download, stored where the app can find it again for the next game.
async function importDfcSource(sourcePath, cacheDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('the picked file or folder does not exist');
  const dest = path.join(cacheDir, CACHE_NAME);
  const stat = fs.statSync(sourcePath);

  // Chicken 3.0 is handed out as a password-protected .7z (the password is in its README and its
  // Discord post). This app reads zips only and does not unpack someone else's protected archive,
  // so it says what to do instead of "not a zip".
  if (!stat.isDirectory() && /\.(7z|rar)$/i.test(sourcePath)) {
    throw new Error(`${path.basename(sourcePath)} is a protected archive -- unpack it first (the password is in Chicken's own post), then pick the folder it unpacked into`);
  }

  const wanted = [...PAYLOAD, ...PAYLOAD_IF_ABSENT];
  if (stat.isDirectory()) {
    // The 64-bit tree, wherever in the picked folder it lives -- the release unpacks to
    // <name>/64-bit/, so the folder a user picks is normally a parent of the payload.
    const payloadDir = findPayloadDir(sourcePath);
    if (!payloadDir) {
      throw new Error(`${path.basename(sourcePath)} does not look like Deep Fried Chicken (no ${ADDON} and ${NVNGX} in it, or in a 64-bit folder inside it)`);
    }
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });
    // The payload from the 64-bit tree; the licence and notices from wherever they sit, which in a
    // real release is the archive root beside the two trees rather than inside either.
    for (const from of [payloadDir, sourcePath, path.dirname(payloadDir)]) {
      let names = [];
      try { names = fs.readdirSync(from); } catch { continue; }
      for (const name of names) {
        if (!wanted.some((w) => w.toLowerCase() === name.toLowerCase())) continue;
        const to = path.join(dest, name);
        if (fs.existsSync(to)) continue; // the payload tree wins over a copy further up
        await fsp.copyFile(path.join(from, name), to);
      }
    }
    // The 32-bit tree as it ships (addon32, the bridge cfg, host64\, reshade-shaders\), kept whole:
    // its README is explicit that host64 and reshade-shaders keep their folder structure.
    const tree32 = find32Dir(sourcePath);
    if (tree32) await fsp.cp(tree32, path.join(dest, TREE32), { recursive: true, force: true });
    // Compatibility\Vulkan-OpenGL as it ships (the producer, its bridge cfg, reshade-shaders\).
    const compat = findCompatDir(sourcePath);
    if (compat) await fsp.cp(compat, path.join(dest, COMPAT_TREE), { recursive: true, force: true });
  } else {
    const zip = openZip(fs.readFileSync(sourcePath));
    // Its zip may nest the files under a version folder, so each is found by name anywhere in it.
    const found = new Map();
    for (const name of wanted) {
      const entry = findEntry(zip, new RegExp(`(^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
      if (entry) found.set(name, entry);
    }
    if (!PAYLOAD.every((n) => found.has(n))) {
      throw new Error(`${path.basename(sourcePath)} is not a Deep Fried Chicken release (no ${ADDON} and ${NVNGX} in it)`);
    }
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });
    for (const [name, entry] of found) await fsp.writeFile(path.join(dest, name), extractEntry(zip, entry));
  }

  // Their own licence file travels with it wherever it goes, and is never something we author.
  // Beside the cache folder, not in it: the folder holds Chicken's files and nothing else.
  const info = { from: path.basename(sourcePath), addedAt: new Date().toISOString() };
  try { fs.writeFileSync(path.join(cacheDir, `${CACHE_NAME}.json`), JSON.stringify(info, null, 2), 'utf8'); } catch {}
  return { path: dest, files: fs.readdirSync(dest).sort(), from: info.from };
}

// Where the copy came from, in full: what main.js re-imports from when a part is missing later.
function recordSource(cacheDir, sourcePath) {
  const file = path.join(cacheDir, `${CACHE_NAME}.json`);
  let info = {};
  try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  info.from = path.basename(sourcePath);
  info.sourcePath = sourcePath;
  try { fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf8'); } catch {}
}

// Which copy the app has: the name of what was picked, and when. Null for a copy imported before
// this was recorded, or none at all.
function suppliedInfo(cacheDir) {
  if (!cachedDfc(cacheDir)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, `${CACHE_NAME}.json`), 'utf8')); } catch { return {}; }
}

// The cached copy, or null when the user has not supplied one yet. Every caller that offers the
// Chicken choice checks this first: the choice is only real once there is something to deploy.
function cachedDfc(cacheDir) {
  const p = path.join(cacheDir, CACHE_NAME);
  return readDfcFolder(p) ? p : null;
}

// ── a game folder ────────────────────────────────────────────────────────────────────────────

function markerPath(dir) {
  return path.join(dir, MARKER);
}

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(markerPath(dir), 'utf8')); } catch { return null; }
}

// Chicken's files are here, whoever put them there.
function dfcPresent(dir) {
  return PAYLOAD.some((n) => fs.existsSync(path.join(dir, n)))
    || fs.existsSync(path.join(dir, ADDON32))
    || fs.existsSync(path.join(dir, COMPAT_ADDON))
    || fs.existsSync(path.join(dir, HOST_DIR, ADDON));
}

// Here AND placed by this app. The distinction decides whether Remove may touch it and whether
// detect.js should go on calling it a foreign toolchain.
function dfcOurs(dir) {
  const m = readMarker(dir);
  return !!(m && Array.isArray(m.files) && m.files.length && dfcPresent(dir));
}

// Copies the cached payload in and records it. Refuses rather than overwrites when Chicken is
// already here and is not ours: somebody copied that one in by hand (3.0 ships no installer), and
// it is theirs to take out.
//
// The marker is MERGED with the one already here. A re-deploy skips the cfg and the documents
// (they exist), so a marker written from this deploy alone forgot them -- and Remove then left
// the cfg behind, which detect.js reported as a foreign Chicken install of our own making.
async function deployDfc(dir, cacheDir, { force = false, extra = {} } = {}) {
  const source = cachedDfc(cacheDir);
  if (!source) throw new Error('no Deep Fried Chicken copy has been added yet -- add yours in Edit first');
  if (dfcPresent(dir) && !dfcOurs(dir) && !force) {
    return { deployed: false, reason: HAND_PLACED, files: [] };
  }

  // A cfg the player tuned before switching this game back to DLSS 5 comes back with Chicken.
  const restoredCfg = !fs.existsSync(path.join(dir, CFG)) && await restoreStashedCfg(dir, cacheDir);

  const placed = restoredCfg ? [CFG] : [];
  for (const name of PAYLOAD) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) continue;
    await fsp.copyFile(from, path.join(dir, name));
    placed.push(name);
  }
  // The cfg and the licence only when the folder has none -- see PAYLOAD_IF_ABSENT.
  for (const name of PAYLOAD_IF_ABSENT) {
    const from = path.join(source, name);
    if (!fs.existsSync(from) || fs.existsSync(path.join(dir, name))) continue;
    await fsp.copyFile(from, path.join(dir, name));
    placed.push(name);
  }

  const before = readMarker(dir) || {};
  const files = [...new Set([...(Array.isArray(before.files) ? before.files : []), ...placed])];
  writeMarker(dir, { ...before, ...extra, files, from: path.basename(source), deployedAt: new Date().toISOString() });

  return { deployed: true, files: placed, restoredCfg: !!restoredCfg };
}

function writeMarker(dir, data) {
  fs.writeFileSync(markerPath(dir), JSON.stringify(data, null, 2), 'utf8');
}

// Takes out only what the marker says this app placed, and puts the folder back the way the Feeder
// route has it: ReShade under its plain name again, for OptiScaler to load (switchToDfc made it the
// proxy). The player's cfg is stashed in the cache first, so switching back to Chicken later brings
// their settings with it -- Chicken's own README: "KEEP existing .cfg files". The log is never
// removed: it is the evidence for whatever sent them to support.
//
// uninstall: the whole folder is being put back (uninstallEverything). ReShade is deleted rather
// than renamed, since the Feeder stack that owned it is going too.
//   unlistVulkanApp(record)  takes the exe off ReShade's Vulkan app list (legacy.unlistVulkanLayerApp),
//                            for a 32-bit Vulkan game this app put on it; the layer itself stays
async function removeDfc(dir, { cacheDir = null, uninstall = false, unlistVulkanApp = null } = {}) {
  const marker = readMarker(dir);
  const removed = [];
  const kept = [];
  const failed = [];

  if (!marker) {
    if (dfcPresent(dir)) kept.push(`Deep Fried Chicken (${HAND_PLACED})`);
    return { removed, kept, failed };
  }

  if (cacheDir) {
    for (const rel of TUNED_CFGS) {
      if (!fs.existsSync(path.join(dir, rel))) continue;
      try { await stashCfg(dir, cacheDir, rel); kept.push(`${rel} (kept for this game's next switch to Chicken)`); } catch {}
    }
  }

  for (const name of marker.files || []) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const r = await saferemove.removePath(p);
    if (r.ok) removed.push(name);
    else failed.push({ rel: name, code: r.code });
  }

  // ReShade back from the proxy slot. Only the file we renamed, and only while it still is ReShade.
  // A ReShade taken over with a hand-made Chicken is the player's: it stays where it was (a later
  // Install sets it aside properly, under its backup name, if OptiScaler needs the slot).
  const proxy = marker.reshadeProxy && !marker.reshadeAdopted ? path.join(dir, marker.reshadeProxy) : null;
  if (proxy && fs.existsSync(proxy) && isReShade(proxy)) {
    const plain = path.join(dir, RESHADE_PLAIN);
    // Fetched for Chicken on a game with no Feeder: nothing on the way back loads a ReShade64.dll,
    // so it goes -- with the ini, preset and log ReShade wrote while it ran.
    if (uninstall || marker.reshadeFetched || fs.existsSync(plain)) {
      const r = await saferemove.removePath(proxy);
      if (r.ok) removed.push(marker.reshadeProxy);
      else failed.push({ rel: marker.reshadeProxy, code: r.code });
    } else {
      try {
        await fsp.rename(proxy, plain);
        removed.push(`${marker.reshadeProxy} (ReShade, back to ${RESHADE_PLAIN})`);
      } catch (e) {
        failed.push({ rel: marker.reshadeProxy, code: (e && e.code) || 'failed' });
      }
    }
  }

  // Chicken's 32-bit host64\ is entirely ours when we made it (switchToDfc32 refuses one that is
  // not): the worker writes its own log and ReShade files there, so the folder goes whole.
  if ((marker.dirs || []).includes(HOST_DIR) && fs.existsSync(path.join(dir, HOST_DIR)) && !failed.length) {
    const r = await saferemove.removePath(path.join(dir, HOST_DIR));
    if (r.ok) removed.push(`${HOST_DIR}/`);
    else failed.push({ rel: HOST_DIR, code: r.code });
  }
  // The shader folders the 32-bit tree brought, once empty -- a player's own shaders stay.
  for (const rel of ['reshade-shaders/Shaders', 'reshade-shaders']) {
    try { if (fs.readdirSync(path.join(dir, rel)).length === 0) fs.rmdirSync(path.join(dir, rel)); } catch {}
  }

  // ReShade's files beside the game. The ones this switch created go (and ReShade's log, when the
  // ReShade was ours). A player's own ReShade.ini or preset that a switch edited was backed up to the
  // cache first (writeReShadeFile) and is put back exactly -- never deleted. Markers from before that
  // record existed keep the old rule.
  if (!failed.length) {
    const created = Array.isArray(marker.reshadeIniCreated) ? marker.reshadeIniCreated : null;
    const backedUp = Array.isArray(marker.reshadeIniBackedUp) ? marker.reshadeIniBackedUp : [];
    const oldMarker = !created && marker.reshadeIni;
    const ours = new Set(created || []);
    if (oldMarker || (marker.reshadeFetched && !created)) ['ReShade.ini', 'ReShadePreset.ini'].forEach((n) => ours.add(n));
    if (marker.reshadeFetched || ours.has('ReShade.ini')) ours.add('ReShade.log');
    for (const name of ours) {
      if (backedUp.includes(name)) continue;
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      const r = await saferemove.removePath(p);
      if (r.ok) removed.push(name);
      else failed.push({ rel: name, code: r.code });
    }
    for (const name of backedUp) {
      try {
        if (cacheDir && await restoreStashedCfg(dir, cacheDir, name)) removed.push(`${name} (put back as it was before Chicken)`);
        else kept.push(`${name} (the player's own, edited for Chicken)`);
      } catch {
        kept.push(`${name} (the player's own, edited for Chicken)`);
      }
    }
  }

  if (marker.vulkanLayer && marker.vulkanLayer.listedByUs && unlistVulkanApp && !failed.length) {
    try {
      const r = await unlistVulkanApp(marker.vulkanLayer);
      if (r && r.ok === false) kept.push(`${path.basename(marker.vulkanLayer.exe || '')} on ReShade's Vulkan app list (${r.error})`);
      else removed.push('this game on ReShade\x27s Vulkan app list');
    } catch (e) {
      kept.push(`this game on ReShade's Vulkan app list (${(e && e.message) || e})`);
    }
  }

  // The marker goes last, and only when everything it lists is gone: a failed delete (the game
  // still running) must leave the record that says what is ours, or the next try could not tell.
  if (!failed.length) {
    const m = await saferemove.removePath(markerPath(dir));
    if (!m.ok) failed.push({ rel: MARKER, code: m.code });
  }

  if (fs.existsSync(path.join(dir, LOG))) kept.push(`${LOG} (Chicken's own log, left for support)`);
  return { removed, kept, failed };
}

// ── the swap ─────────────────────────────────────────────────────────────────────────────────
//
// On this app's Feeder route, ReShade is a plain ReShade64.dll that OptiScaler loads
// ([Plugins] LoadReshade=true, feeder.js). Take OptiScaler out and nothing loads ReShade at all --
// so the first version of this PR, which deployed Chicken and left OptiScaler in place, built a
// folder that could never run: with OptiScaler, two neural passes (Chicken goes CONFLICT); without
// it, no ReShade. Chicken 3.0's own README installs ReShade the ordinary way, as the game's proxy,
// with nvngx_dlssnr.dll beside the add-on. That is what switchToDfc builds, and removeDfc undoes.

const RESHADE_PLAIN = 'ReShade64.dll';
// ReShade as the D3D11/D3D12 game's dxgi.dll -- the name ReShade's own installer uses for both.
const RESHADE_PROXY = 'dxgi.dll';
const HAND_PLACED = 'copied in by hand, not by this app -- switching this game to Chicken from its ⋯ menu lets the app take it over';

// A Chicken the player copied in by hand, taken over when they switch the game to Chicken here:
// every Chicken name beside the exe (and its worker folder, on 32-bit) becomes this app's to update
// and, on the way back, to remove. Written only once the switch is about to change the folder, so a
// switch that refuses leaves the player's copy exactly as unclaimed as it was.
// Only names that are Chicken's alone: LICENSE.txt, README.txt and THIRD-PARTY-NOTICES.txt are as
// likely to be the game's own, and a takeover must never claim (and later delete) those.
const CHICKEN_NAMES = [ADDON, NVNGX, CFG, ADDON32, BRIDGE_CFG, COMPAT_ADDON, 'LICENSE-Deep-Fried-Chicken.md'];
function handPlaced(dir) {
  return dfcPresent(dir) && !dfcOurs(dir);
}
function adoptHandPlaced(dir) {
  const files = CHICKEN_NAMES.filter((n) => fs.existsSync(path.join(dir, n)));
  const hostIsChicken = fs.existsSync(path.join(dir, HOST_DIR, ADDON));
  writeMarker(dir, { files, dirs: hostIsChicken ? [HOST_DIR] : [], adopted: true, adoptedAt: new Date().toISOString() });
}

// OptiScaler's install journal (main.js INSTALL_MARKER): which proxy it took, and whose file it set aside.
const OPTISCALER_JOURNAL = '.optiscaler-manager-install.json';

function fileHas(file, text) {
  try { return fs.readFileSync(file).includes(Buffer.from(text, 'latin1')); } catch { return false; }
}
// OptiScaler carries the string too (it loads ReShade itself), so ReShade means ReShade and not OptiScaler.
function isReShade(file) { return fileHas(file, 'ReShade') && !fileHas(file, 'OptiScaler'); }
function isOptiScaler(file) { return fileHas(file, 'OptiScaler'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Where ReShade lives in a folder we switched to Chicken, or null.
function reshadeProxyOf(dir) {
  const m = readMarker(dir);
  if (!m || !m.reshadeProxy) return null;
  return isReShade(path.join(dir, m.reshadeProxy)) ? m.reshadeProxy : null;
}

// Which games this swap is built for. Everything else says why rather than building a folder that
// cannot run. The reasons are codes; the renderer words them.
//   vulkan/opengl  Chicken 3.0 brings its own feeder there (Compatibility\Vulkan-OpenGL) and says
//                  "Do not install another neural feeder alongside" -- a different route.
//   32-bit         Chicken's own 32-bit transport (host64 worker), also a different route.
//
// Chicken 3.0 needs no Feeder on Direct3D ("Feeder supported but no longer required"; its own
// depth and motion fallback), so every 64-bit Direct3D game qualifies, Feeder or not. DX9 counts:
// this app's 64-bit DX9 route is dgVoodoo2's D3D9.dll presenting through D3D11, and ReShade as
// dxgi.dll sits on that D3D11 exactly as on any DX11 game.
const D3D_APIS = ['dx9', 'dx10', 'dx11', 'dx12'];
function supportedFor(detected) {
  const d = detected || {};
  // 32-bit: Chicken's own companion route (switchToDfc32), for the renderers it names there.
  if (d.bitness === 32) return Object.prototype.hasOwnProperty.call(RESHADE32_FOR, d.api) ? { ok: true, code: null } : { ok: false, code: 'dfc-32bit' };
  // 64-bit Vulkan/OpenGL: Chicken's own producer (switchToDfcCompat), in place of this app's Feeder.
  if (d.api === 'vulkan' || d.api === 'opengl') return { ok: true, code: null };
  if (!D3D_APIS.includes(d.api)) return { ok: false, code: 'dfc-api' };
  return { ok: true, code: null };
}

// Our engine out, ReShade in as the proxy, the NR model beside it, Chicken in -- with everything
// that can refuse checked before anything is touched, so a refusal leaves the folder as it was.
//   removeOptiScaler  main.js uninstallOptiScaler (the install journal knows what is ours)
//   nrDllPath         the NR model in Settings, for a folder that has none after OptiScaler left
//   fetchReShade      places a plain ReShade64.dll (feeder.js deployReShade), for a game that has
//                     none of its own -- one on the plain OptiScaler route, no Feeder
async function switchToDfc(dir, cacheDir, { nrDllPath = null, removeOptiScaler, fetchReShade = null } = {}) {
  if (!cachedDfc(cacheDir)) throw new Error('no Deep Fried Chicken copy has been added yet -- add yours in Settings first');
  const adopting = handPlaced(dir);

  const plain = path.join(dir, RESHADE_PLAIN);
  const proxy = path.join(dir, RESHADE_PROXY);
  const already = reshadeProxyOf(dir);
  // A ReShade64.dll is ours to move only when the Feeder put it there; anything else by that name
  // (Luma's, the player's) is not touched.
  const feederReShade = fs.existsSync(plain) && fs.existsSync(path.join(dir, 'dlss5-feed.addon64'));
  // The hand-made Chicken setup: the player's ReShade already in the proxy slot, no Feeder. That
  // ReShade is used where it is, and stays theirs: the way back leaves it in place.
  const adoptProxy = adopting && !already && !feederReShade && fs.existsSync(proxy) && isReShade(proxy);
  if (!already && fs.existsSync(plain) && !feederReShade) throw new Error(`${RESHADE_PLAIN} here is not this app's -- it is left alone`);
  if (!already && !feederReShade && !adoptProxy && !fetchReShade) throw new Error(`${RESHADE_PLAIN} is not here -- deploy the Feeder first`);
  const nrHere = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));
  if (!nrHere && !(nrDllPath && fs.existsSync(nrDllPath))) throw new Error('the NR model (nvngx_dlssnr.dll) is not set up in Settings, and Chicken needs it beside its add-on');
  // The proxy slot has to end up free for ReShade, so whatever is in it now must be the OptiScaler
  // that is coming out, or the ReShade being taken over. Anything else -- a game's own dxgi.dll, or a
  // player's ReShade with no Chicken beside it -- is refused here, before anything is touched. (The
  // latter used to pass this check and fail after OptiScaler was already out, leaving the game with
  // neither; review of 2026-09-22.) A game whose own dxgi.dll OptiScaler's install set aside would
  // get it back the moment OptiScaler leaves, so that is refused up front too.
  if (!already) {
    if (fs.existsSync(proxy) && !adoptProxy && !isOptiScaler(proxy)) {
      throw new Error(`${RESHADE_PROXY} here is not this app's -- ReShade cannot take its place`);
    }
    const journal = readJson(path.join(dir, OPTISCALER_JOURNAL));
    const backedUpAs = journal && journal.backedUp ? String(journal.backedUpAs || journal.proxy || '').toLowerCase() : '';
    if (backedUpAs === RESHADE_PROXY) {
      throw new Error(`this game's own ${RESHADE_PROXY} was set aside when DLSS 5 was installed and comes back when it is taken out, so ReShade cannot use that name here`);
    }
  }

  const steps = [];
  // Fetched BEFORE OptiScaler comes out: offline, the swap stops here with the folder as it was.
  let reshadeFetched = false;
  if (!already && !feederReShade && !adoptProxy) {
    await fetchReShade(dir);
    if (!fs.existsSync(plain)) throw new Error('ReShade could not be fetched -- check the connection and try again');
    reshadeFetched = true;
    steps.push('fetched ReShade');
  }
  const dropFetched = () => { if (reshadeFetched) { try { fs.rmSync(plain, { force: true }); } catch {} } };
  const out = await removeOptiScaler(dir);
  if (out && out.failed && out.failed.length) {
    dropFetched();
    throw new Error(`OptiScaler could not be taken out (${out.failed.map((f) => `${f.rel}: ${f.code}`).join(', ')}) -- close the game and try again`);
  }
  if (out && out.removed && out.removed.length) steps.push('took OptiScaler out');
  // Only now, with OptiScaler out, is a hand-made Chicken this app's: a switch that stopped above
  // leaves it exactly as unclaimed as it was.
  if (adopting) adoptHandPlaced(dir);

  if (!already && adoptProxy) {
    steps.push(`kept the ReShade already loading as ${RESHADE_PROXY}`);
  } else if (!already) {
    // dxgi.dll is free now unless the OptiScaler removal put a game's own file back: never overwritten.
    if (fs.existsSync(proxy)) {
      dropFetched();
      throw new Error(`${RESHADE_PROXY} here is not this app's -- ReShade cannot take its place`);
    }
    try {
      await fsp.rename(plain, proxy);
    } catch (e) {
      dropFetched();
      throw e;
    }
    steps.push(`ReShade now loads itself as ${RESHADE_PROXY}`);
  }
  // The proxy is recorded the moment it is in place: a failure below then leaves a switch that the
  // next Install finishes (reshadeProxyOf reads it back as "already"), not a folder it refuses.
  const soFar = readMarker(dir) || {};
  writeMarker(dir, {
    ...soFar,
    files: Array.isArray(soFar.files) ? soFar.files : [],
    reshadeProxy: RESHADE_PROXY,
    ...(reshadeFetched ? { reshadeFetched: true } : {}),
    ...(adoptProxy ? { reshadeAdopted: true } : {}),
  });

  let nrPlaced = false;
  if (!fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) {
    if (!nrDllPath || !fs.existsSync(nrDllPath)) throw new Error('the NR model (nvngx_dlssnr.dll) is not set up in Settings, and Chicken needs it beside its add-on -- set it, then press Install again to finish');
    await fsp.copyFile(nrDllPath, path.join(dir, 'nvngx_dlssnr.dll'));
    nrPlaced = true;
    steps.push('placed the NR model');
  }

  const deployed = await deployDfc(dir, cacheDir, { extra: { ...(nrPlaced ? { nrPlaced } : {}) } });
  steps.push(deployed.restoredCfg ? 'deployed Chicken with this game\x27s saved settings' : 'deployed Chicken');
  return { ...deployed, steps };
}

// The player's cfg, kept in the cache per game folder while the game is back on DLSS 5.
// The main cfg keeps its first name (<key>.cfg), so a stash made before the 32-bit route still restores.
function stashPathFor(dir, cacheDir, rel = CFG) {
  const key = require('node:crypto').createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16);
  const name = rel === CFG ? `${key}.cfg` : `${key}.${rel.replace(/[\\/]/g, '_')}`;
  return path.join(cacheDir, 'configs', name);
}

async function stashCfg(dir, cacheDir, rel = CFG) {
  const to = stashPathFor(dir, cacheDir, rel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(path.join(dir, rel), to);
}

async function restoreStashedCfg(dir, cacheDir, rel = CFG) {
  const from = stashPathFor(dir, cacheDir, rel);
  if (!fs.existsSync(from)) return false;
  await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fsp.copyFile(from, path.join(dir, rel));
  return true;
}

// ── 64-bit Vulkan and OpenGL (stage 2) ───────────────────────────────────────────────────────
//
// Chicken's README for these: the ordinary 64-bit files, plus the CONTENTS of
// Compatibility\Vulkan-OpenGL beside the exe (reshade-shaders kept as a folder), the x64
// nvngx_dlss.dll beside the exe, .\reshade-shaders\Shaders on ReShade's search path, and
// DFC_Universal_Feed enabled -- "Do not install another neural feeder alongside this compatibility
// producer." So this app's Feeder comes out with OptiScaler, and Chicken's producer takes its place.
//
// ReShade: on Vulkan it is the machine-wide layer, which has to be registered with add-on support and
// switched on for this exe already (the Feeder route needs the same; the player runs ReShade's own
// installer for it, this app cannot). On OpenGL it is the game's opengl32.dll, put back fresh after the
// Feeder's comes out.
//
//   api                  vulkan or opengl
//   removeOptiScaler(dir) / removeFeeder(dir)   this app's two halves out (main.js)
//   vulkanLayerReady()   true when the add-on layer is registered and on for this exe
//   reshadeSetup()       ReShade's add-on setup, for the OpenGL proxy
//   placeNvngxDlss(dir)  the x64 nvngx_dlss.dll beside the exe, when none is there
//   nrDllPath            the NR model
async function switchToDfcCompat(dir, cacheDir, deps = {}) {
  const { api, nrDllPath = null, removeOptiScaler, removeFeeder, vulkanLayerReady, reshadeSetup, placeNvngxDlss, setUpVulkanLayer = null } = deps;
  if (!cachedDfc(cacheDir)) throw new Error('no Deep Fried Chicken copy has been added yet -- add yours in Settings first');
  const compat = cachedCompat(cacheDir);
  if (!compat) throw new Error('the Chicken copy you added has no Vulkan/OpenGL part -- add the whole unpacked folder (the one with Compatibility inside) in Settings');
  if (api !== 'vulkan' && api !== 'opengl') throw new Error(`not a Vulkan or OpenGL game (${api || 'not detected'})`);
  const adopting = handPlaced(dir);
  const nrHere = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));
  if (!nrHere && !(nrDllPath && fs.existsSync(nrDllPath))) throw new Error('the NR model (nvngx_dlssnr.dll) is not set up in Settings, and Chicken needs it beside its add-on');
  const before = readMarker(dir);
  const already = !!(before && before.compat === api && dfcOurs(dir));
  // Which of ReShade's files were here before anything below (writeReShadeFile).
  const iniAtStart = { 'ReShade.ini': fs.existsSync(path.join(dir, 'ReShade.ini')), 'ReShadePreset.ini': fs.existsSync(path.join(dir, 'ReShadePreset.ini')) };
  const iniRecord = { created: [...((before && before.reshadeIniCreated) || [])], backedUp: [...((before && before.reshadeIniBackedUp) || [])] };

  // Everything that can refuse, before anything is touched.
  let setup = null;
  const { openZip: open, findEntry: find, extractEntry: extract } = require('./zip');
  // Vulkan: ReShade's layer, with add-ons and on for this exe. Set up here when it is not (ReShade's
  // own setup, headless, one administrator prompt -- legacy.setUpVulkanLayer32 installs both layers),
  // and the exe comes back off its app list with Chicken when this switch put it there.
  let vulkanLayer = before && before.vulkanLayer ? before.vulkanLayer : null;
  if (api === 'vulkan' && !(await vulkanLayerReady())) {
    const layer = setUpVulkanLayer ? await setUpVulkanLayer() : null;
    if (!layer || !layer.ok || !(await vulkanLayerReady())) {
      const e = new Error(`ReShade's Vulkan layer with add-on support could not be set up for this game${layer && layer.error ? ` (${layer.error})` : ''}`);
      e.code = 'dfc-vulkan-layer';
      throw e;
    }
    vulkanLayer = {
      exe: layer.exe || null,
      appsPath: (layer.after && layer.after.appsPath) || null,
      listedByUs: !!(layer.before && layer.before.appListed !== true && layer.after && layer.after.appListed === true),
    };
  }
  if (api === 'opengl' && !already) {
    const gl = path.join(dir, 'opengl32.dll');
    // A game's own opengl32.dll that the Feeder set aside comes back when the Feeder leaves.
    if (fs.existsSync(path.join(dir, 'opengl32.dll.dlss5ui-orig'))) {
      throw new Error('this game\x27s own opengl32.dll was set aside by the Feeder and comes back when it is taken out, so ReShade cannot use that name here');
    }
    if (fs.existsSync(gl) && !isReShade(gl) && !isOptiScaler(gl)) throw new Error('opengl32.dll here is not this app\x27s -- ReShade cannot take its place');
    setup = open(await reshadeSetup());
    if (!find(setup, /^ReShade64\.dll$/i)) throw new Error('ReShade64.dll was not found in the ReShade setup');
  }

  const steps = [];
  if (!already) {
    const o = await removeOptiScaler(dir);
    if (o && o.failed && o.failed.length) throw new Error(`OptiScaler could not be taken out (${o.failed.map((f) => `${f.rel}: ${f.code}`).join(', ')}) -- close the game and try again`);
    // Both removals are safe to run again, so a locked file here is a retry, not a stuck folder.
    try {
      await removeFeeder(dir);
    } catch (e) {
      throw new Error(`the Feeder could not be taken out (${(e && e.code) || (e && e.message) || e}) -- close the game and press Install again`);
    }
    steps.push('took OptiScaler and the Feeder out: Chicken\x27s producer is the one feeder now');
  }
  // Only now, with this app's pass out, is a hand-made Chicken this app's.
  if (adopting) adoptHandPlaced(dir);

  // Chicken's 64-bit files (with this game's saved cfg), then the producer set over them.
  const deployed = await deployDfc(dir, cacheDir);
  const files = new Set(readMarker(dir).files || []);
  const restored = [];
  if (!fs.existsSync(path.join(dir, BRIDGE_CFG)) && await restoreStashedCfg(dir, cacheDir, BRIDGE_CFG)) { restored.push(BRIDGE_CFG); files.add(BRIDGE_CFG); }
  await layTree(compat, dir, files);
  // The model and DLSS itself beside the exe.
  let nrPlaced = !!(before && before.nrPlaced);
  if (!fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) {
    if (!nrDllPath || !fs.existsSync(nrDllPath)) throw new Error('the NR model (nvngx_dlssnr.dll) is not set up in Settings -- set it, then press Install again to finish');
    await fsp.copyFile(nrDllPath, path.join(dir, 'nvngx_dlssnr.dll'));
    nrPlaced = true;
  }
  if (!fs.existsSync(path.join(dir, 'nvngx_dlss.dll'))) {
    await placeNvngxDlss(dir);
    if (fs.existsSync(path.join(dir, 'nvngx_dlss.dll'))) files.add('nvngx_dlss.dll');
  }
  // OpenGL: ReShade back in as the game's opengl32.dll.
  if (setup) await fsp.writeFile(path.join(dir, 'opengl32.dll'), extract(setup, find(setup, /^ReShade64\.dll$/i)));

  // ReShade beside the game: this folder's add-ons, the shaders, and DFC_Universal_Feed on.
  const { setIniKey, getIniKey } = require('./ini-merge');
  const iniPath = path.join(dir, 'ReShade.ini');
  let ini = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, 'utf8') : '';
  ini = setIniKey(ini, 'ADDON', 'AddonPath', '.\\');
  const searchPaths = getIniKey(ini, 'GENERAL', 'EffectSearchPaths') || '';
  if (!/reshade-shaders\\Shaders/i.test(searchPaths)) {
    ini = setIniKey(ini, 'GENERAL', 'EffectSearchPaths', searchPaths ? `${searchPaths},.\\reshade-shaders\\Shaders\\**` : '.\\reshade-shaders\\Shaders\\**');
  }
  if (!getIniKey(ini, 'GENERAL', 'PresetPath')) ini = setIniKey(ini, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  if (!getIniKey(ini, 'OVERLAY', 'TutorialProgress')) ini = setIniKey(ini, 'OVERLAY', 'TutorialProgress', '4');
  await writeReShadeFile(dir, cacheDir, 'ReShade.ini', iniAtStart['ReShade.ini'], ini, iniRecord);
  const presetPath = path.join(dir, 'ReShadePreset.ini');
  let preset = fs.existsSync(presetPath) ? fs.readFileSync(presetPath, 'utf8') : '';
  const techniques = (getIniKey(preset, '', 'Techniques') || '').split(',').map((t) => t.trim()).filter(Boolean)
    // The Feeder's own technique went with the Feeder.
    .filter((t) => !/^DLSS5_Feed/i.test(t));
  if (!techniques.some((t) => /^DFC_Universal_Feed@/i.test(t))) techniques.push('DFC_Universal_Feed@DFC_Universal_Feed.fx');
  preset = setIniKey(preset, '', 'Techniques', techniques.join(','));
  await writeReShadeFile(dir, cacheDir, 'ReShadePreset.ini', iniAtStart['ReShadePreset.ini'], preset, iniRecord);

  writeMarker(dir, {
    ...readMarker(dir),
    compat: api,
    files: [...files],
    ...(nrPlaced ? { nrPlaced } : {}),
    // Vulkan: no proxy of ours, but the ini and preset above are (created, or the player's backed
    // up); OpenGL: the proxy too.
    reshadeIni: true,
    reshadeIniCreated: iniRecord.created,
    reshadeIniBackedUp: iniRecord.backedUp,
    ...(vulkanLayer ? { vulkanLayer } : {}),
    ...(api === 'opengl' ? { reshadeProxy: 'opengl32.dll', reshadeFetched: true } : {}),
  });
  steps.push(api === 'opengl' ? 'ReShade as opengl32.dll, Chicken\x27s producer in' : 'Chicken\x27s producer in, on ReShade\x27s Vulkan layer');
  return { ...deployed, compat: api, restoredCfg: deployed.restoredCfg || restored.length > 0, steps };
}

// ── 32-bit games (stage 3) ───────────────────────────────────────────────────────────────────
//
// Chicken 3.0 runs a 32-bit game through its own companion: a 32-bit ReShade with its add-on beside
// the game, feeding frames to a hidden x64 worker in host64\ that runs DLSS and the model (its
// README, "32-BIT GAMES"). This app's own 32-bit route uses a host64\ too -- the Feeder's helper,
// a ReShade dxgi.dll and OptiScaler as winmm.dll -- so the two can never share the folder: the swap
// takes this app's whole 32-bit stack out first (main.js removeOur32Stack: DXVK or dgVoodoo2, the
// Feeder, host64\) and lays Chicken's tree in its place. The way back is removeDfc, then Install
// builds this app's route again.
//
// The game's ReShade goes in under the name its renderer loads: d3d9.dll for Direct3D 9 (Chicken
// hooks D3D9 itself, no dgVoodoo2), dxgi.dll for Direct3D 10/11, opengl32.dll for OpenGL. Vulkan has
// no proxy: ReShade's 32-bit layer, set up machine-wide for this exe by ReShade's own setup
// (legacy.setUpVulkanLayer32, one administrator prompt -- the step this app's DXVK route already runs).
// DFC_Universal_Feed, the technique the README has the player enable by hand, is switched on in the
// preset this app writes.
const RESHADE32_FOR = { dx9: 'd3d9.dll', dx10: 'dxgi.dll', dx11: 'dxgi.dll', opengl: 'opengl32.dll', vulkan: null };

// ReShade.ini / ReShadePreset.ini beside the game, written by a switch. One that is still there and
// was there before the switch began is the player's own: backed up to the cache before it is edited,
// and put back on the way back. Any other is this switch's, and goes with Chicken. `record` is
// { created: [], backedUp: [] }, kept in the marker.
async function writeReShadeFile(dir, cacheDir, rel, existedAtStart, text, record) {
  const p = path.join(dir, rel);
  if (!record.created.includes(rel) && !record.backedUp.includes(rel)) {
    if (fs.existsSync(p) && existedAtStart) {
      await stashCfg(dir, cacheDir, rel);
      record.backedUp.push(rel);
    } else {
      record.created.push(rel);
    }
  }
  await fsp.writeFile(p, text, 'utf8');
}

// A Chicken tree (the 32-bit one, or the Vulkan/OpenGL set) laid into the game folder. A tuned cfg
// already there is kept. A file already there that is not ours -- a shared name such as
// reshade-shaders\Shaders\ReShade.fxh, which the player's other effects use -- is left as it is
// and never claimed, so the way back cannot delete it. `mayReplace(rel)` names the ones that are
// ours to refresh (in the marker already, or in a worker folder being taken over).
async function layTree(tree, dir, files, mayReplace = (rel) => files.has(rel)) {
  for (const rel of walkFiles(tree)) {
    const to = path.join(dir, ...rel.split('/'));
    const exists = fs.existsSync(to);
    if (exists && /\.cfg$/i.test(rel)) continue;
    if (exists && !mayReplace(rel)) continue;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(path.join(tree, ...rel.split('/')), to);
    files.add(rel);
  }
}

function walkFiles(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, r));
    else out.push(r);
  }
  return out;
}

//   api                 dx9, dx10 or dx11
//   removeOurStack(dir) this app's 32-bit route out, whole (main.js removeOur32Stack)
//   occupiedAfterRemoval(rel)  true when a file or folder by that name would still be here once
//                       removeOurStack has run -- a game's own file it would put back, or one that
//                       was never ours
//   reshadeSetup()      path to ReShade's add-on setup (a zip holding ReShade32.dll and ReShade64.dll)
//   placeNvngxDlss(hostDir)  the x64 nvngx_dlss.dll into the worker's folder
//   nrDllPath           the NR model, for the worker's folder
async function switchToDfc32(dir, cacheDir, deps = {}) {
  const { api, nrDllPath = null, removeOurStack, occupiedAfterRemoval, reshadeSetup, placeNvngxDlss, setUpVulkanLayer = null } = deps;
  const tree = cached32(cacheDir);
  if (!cachedDfc(cacheDir)) throw new Error('no Deep Fried Chicken copy has been added yet -- add yours in Settings first');
  if (!tree) throw new Error('the Chicken copy you added has no 32-bit part -- add the whole unpacked folder (the one with 32-bit and 64-bit inside) in Settings');
  if (!Object.prototype.hasOwnProperty.call(RESHADE32_FOR, api)) throw new Error(`Chicken is set up here for 32-bit DirectX 9 to 11, OpenGL and Vulkan games, and this one is ${api || 'not detected'}`);
  const proxyName = RESHADE32_FOR[api];
  const adopting = handPlaced(dir);
  // The player's own Chicken worker folder, taken over with the rest.
  const adoptHost = adopting && fs.existsSync(path.join(dir, HOST_DIR, ADDON));
  const adoptProxy = (rel) => adopting && rel && fs.existsSync(path.join(dir, rel)) && isReShade(path.join(dir, rel));
  if (!nrDllPath || !fs.existsSync(nrDllPath)) throw new Error('the NR model (nvngx_dlssnr.dll) is not set up in Settings, and Chicken\x27s worker needs it');

  const before = readMarker(dir);
  const already = !!(before && before.bits === 32 && dfcOurs(dir));
  const iniAtStart = { 'ReShade.ini': fs.existsSync(path.join(dir, 'ReShade.ini')), 'ReShadePreset.ini': fs.existsSync(path.join(dir, 'ReShadePreset.ini')) };
  const iniRecord = { created: [...((before && before.reshadeIniCreated) || [])], backedUp: [...((before && before.reshadeIniBackedUp) || [])] };
  // Everything that can refuse, before anything is touched.
  if (!already) {
    if (proxyName && occupiedAfterRemoval(proxyName) && !adoptProxy(proxyName)) throw new Error(`${proxyName} here is not this app's -- ReShade cannot take its place`);
    if (occupiedAfterRemoval(HOST_DIR) && !adoptHost) throw new Error(`a ${HOST_DIR} folder here is not this app's -- Chicken's worker needs that name`);
  }
  // ReShade fetched before this app's route comes out: offline, the swap stops with the folder as it was.
  const { openZip: open, findEntry: find, extractEntry: extract } = require('./zip');
  const setup = open(await reshadeSetup());
  const r32 = find(setup, /^ReShade32\.dll$/i);
  const r64 = find(setup, /^ReShade64\.dll$/i);
  if (!r32 || !r64) throw new Error('ReShade32.dll and ReShade64.dll were not both found in the ReShade setup');

  // Vulkan: ReShade's 32-bit layer, on for this exe. Its setup changes nothing in the game folder
  // for good (it holds any ReShade.ini aside and puts it back), so a refusal here still leaves the
  // folder as it was.
  let vulkanLayer = already ? (before.vulkanLayer || null) : null;
  if (api === 'vulkan' && !already) {
    const layer = await setUpVulkanLayer();
    if (!layer || !layer.ok) {
      const e = new Error(`ReShade's 32-bit Vulkan layer could not be set up for this game${layer && layer.error ? ` (${layer.error})` : ''}`);
      e.code = 'dfc-vulkan-layer';
      throw e;
    }
    vulkanLayer = {
      exe: layer.exe || null,
      appsPath: (layer.after && layer.after.appsPath) || null,
      // Remove owes taking the exe off the layer's list only when this switch put it there.
      listedByUs: !!(layer.before && layer.before.appListed !== true && layer.after && layer.after.appListed === true),
    };
  }

  const steps = [];
  if (!already) {
    const out = await removeOurStack(dir);
    if (out && out.failed && out.failed.length) {
      throw new Error(`this app's 32-bit route could not be taken out (${out.failed.map((f) => `${f.rel}: ${f.code}`).join(', ')}) -- close the game and try again`);
    }
    steps.push('took the DLSS 5 32-bit route out');
    const back = (proxyName && fs.existsSync(path.join(dir, proxyName)) && !adoptProxy(proxyName)) ? proxyName
      : (fs.existsSync(path.join(dir, HOST_DIR)) && !adoptHost) ? HOST_DIR : null;
    if (back) throw new Error(`${back} came back after the DLSS 5 route was taken out -- it is the game's own, so Chicken cannot use that name`);
  }
  // Only now, with this app's route out, is a hand-made Chicken this app's.
  if (adopting) adoptHandPlaced(dir);

  const adoptedMarker = adopting ? readMarker(dir) : null;
  const files = new Set(already && Array.isArray(before.files) ? before.files : (adoptedMarker ? adoptedMarker.files : []));
  const hostDirMade = already ? (before.dirs || []).includes(HOST_DIR) : true;
  // The player's tuned cfgs first, so the tree's defaults below never overwrite them.
  const restored = [];
  for (const rel of TUNED_CFGS) {
    if (rel === CFG) continue; // the 64-bit route's name; not part of the 32-bit layout
    if (!fs.existsSync(path.join(dir, rel)) && await restoreStashedCfg(dir, cacheDir, rel)) { restored.push(rel); files.add(rel); }
  }
  // A cfg already here (tuned, or restored above) is kept; Chicken's own files are refreshed; a shared
  // name that is not ours is left alone. A worker folder being taken over is Chicken's through and through.
  await layTree(tree, dir, files, (rel) => files.has(rel) || (adoptHost && rel.startsWith(`${HOST_DIR}/`)));

  // The game's 32-bit ReShade, under the name its renderer loads (none on Vulkan: the layer).
  if (proxyName) await fsp.writeFile(path.join(dir, proxyName), extract(setup, r32));
  // The worker's x64 ReShade (the README's step 3), unless the tree shipped one of its own.
  const hostDir = path.join(dir, HOST_DIR);
  if (!fs.existsSync(path.join(hostDir, 'dxgi.dll')) || files.has(`${HOST_DIR}/dxgi.dll`)) {
    await fsp.writeFile(path.join(hostDir, 'dxgi.dll'), extract(setup, r64));
    files.add(`${HOST_DIR}/dxgi.dll`);
  }
  // DLSS and the model for the worker (step 4).
  await fsp.copyFile(nrDllPath, path.join(hostDir, 'nvngx_dlssnr.dll'));
  files.add(`${HOST_DIR}/nvngx_dlssnr.dll`);
  await placeNvngxDlss(hostDir);
  if (fs.existsSync(path.join(hostDir, 'nvngx_dlss.dll'))) files.add(`${HOST_DIR}/nvngx_dlss.dll`);

  // ReShade beside the game: find the shaders, load the preset, and have DFC_Universal_Feed on (step 5).
  const { setIniKey, getIniKey } = require('./ini-merge');
  const iniPath = path.join(dir, 'ReShade.ini');
  let ini = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, 'utf8') : '';
  const searchPaths = getIniKey(ini, 'GENERAL', 'EffectSearchPaths') || '';
  if (!/reshade-shaders\\Shaders/i.test(searchPaths)) {
    ini = setIniKey(ini, 'GENERAL', 'EffectSearchPaths', searchPaths ? `${searchPaths},.\\reshade-shaders\\Shaders\\**` : '.\\reshade-shaders\\Shaders\\**');
  }
  if (!getIniKey(ini, 'GENERAL', 'PresetPath')) ini = setIniKey(ini, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  if (!getIniKey(ini, 'OVERLAY', 'TutorialProgress')) ini = setIniKey(ini, 'OVERLAY', 'TutorialProgress', '4');
  await writeReShadeFile(dir, cacheDir, 'ReShade.ini', iniAtStart['ReShade.ini'], ini, iniRecord);
  const presetPath = path.join(dir, 'ReShadePreset.ini');
  let preset = fs.existsSync(presetPath) ? fs.readFileSync(presetPath, 'utf8') : '';
  const techniques = (getIniKey(preset, '', 'Techniques') || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!techniques.some((t) => /^DFC_Universal_Feed@/i.test(t))) {
    techniques.push('DFC_Universal_Feed@DFC_Universal_Feed.fx');
    preset = setIniKey(preset, '', 'Techniques', techniques.join(','));
    await writeReShadeFile(dir, cacheDir, 'ReShadePreset.ini', iniAtStart['ReShadePreset.ini'], preset, iniRecord);
  }
  // The worker's ReShade loads the add-on from its own folder and skips its first-run tutorial.
  const hostIniPath = path.join(hostDir, 'ReShade.ini');
  if (!fs.existsSync(hostIniPath)) {
    let hostIni = setIniKey('', 'ADDON', 'AddonPath', '.\\');
    hostIni = setIniKey(hostIni, 'OVERLAY', 'TutorialProgress', '4');
    await fsp.writeFile(hostIniPath, hostIni, 'utf8');
  }

  writeMarker(dir, {
    ...(already ? before : {}),
    // Taken over from a hand-made copy: said in the record, for support and for Remove.
    ...(adopting || (before && before.adopted) ? { adopted: true } : {}),
    bits: 32,
    files: [...files],
    dirs: hostDirMade ? [HOST_DIR] : [],
    ...(proxyName ? { reshadeProxy: proxyName, reshadeFetched: true } : {}),
    reshadeIni: true,
    reshadeIniCreated: iniRecord.created,
    reshadeIniBackedUp: iniRecord.backedUp,
    ...(vulkanLayer ? { vulkanLayer } : {}),
    from: path.basename(path.dirname(tree)),
    deployedAt: new Date().toISOString(),
  });
  steps.push(proxyName ? `ReShade (32-bit) as ${proxyName}, Chicken's worker in ${HOST_DIR}\\` : `ReShade's 32-bit Vulkan layer on for this game, Chicken's worker in ${HOST_DIR}\\`);
  if (restored.length) steps.push('this game\x27s saved Chicken settings restored');
  return { deployed: true, bits: 32, files: [...files], restoredCfg: restored.length > 0, steps };
}

// ── what Chicken is doing ────────────────────────────────────────────────────────────────────

// Chicken reports itself as ARMED, DISARMED, CONFLICT or FAILED -- its own overlay's Status
// section, and the Feeder reads the same arming state back over the DFC.Feeder.* ABI it added in
// v0.11.0-beta.1. Read here from its log so this app's card can show it without the in-game
// overlay, which is the whole point of offering the choice from our UI.
//
// Read-only on purpose. The state words are Chicken's, quoted rather than re-worded, so a user
// searching its Discord for what they see here finds the same term.
const STATES = ['ARMED', 'CONFLICT', 'FAILED', 'DISARMED'];

function readDfcState(dir) {
  const file = path.join(dir, LOG);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ran: false, state: null }; }
  // Last mention wins: the log is append-only across runs, and what matters is the most recent.
  let state = null;
  for (const word of STATES) {
    const at = text.lastIndexOf(word);
    if (at === -1) continue;
    if (state === null || at > state.at) state = { word, at };
  }
  return {
    ran: true,
    state: state ? state.word : null,
    // CONFLICT is the failure this app has to explain, because it is the one we can cause: two
    // neural consumers in a process and Chicken goes inert for the whole session.
    conflict: state ? state.word === 'CONFLICT' : false,
    bytes: text.length,
  };
}

// The config file, as text. Parsing and writing live in dfccfg.js, which is where the field table
// and the schema guard are; this is just the read that the panel and the status card start from.
//
// Writing it is allowed: Chicken's LICENSE.txt grants "create and share your own Deep Fried Chicken
// configuration and preset files". The "don't edit its settings file" line this module once
// deferred to came from the DLSS5-Feeder's README describing Chicken, not from Alexander -- his own
// README says "Keep your existing deep-fried-chicken.cfg when updating", which is what deployDfc
// does.
function readCfgText(dir) {
  try { return fs.readFileSync(path.join(dir, CFG), 'utf8'); } catch { return null; }
}

function cfgPath(dir) {
  return path.join(dir, CFG);
}

module.exports = {
  ADDON, NVNGX, CFG, LOG, LICENSE, MARKER, CACHE_NAME,
  PAYLOAD, PAYLOAD_IF_ABSENT, STATES,
  CONSUMERS, DEFAULT_CONSUMER, isConsumer, consumerOf,
  looksLikeDfc, importDfcSource, cachedDfc, suppliedInfo, recordSource,
  readMarker, dfcPresent, dfcOurs, deployDfc, removeDfc,
  RESHADE_PROXY, reshadeProxyOf, supportedFor, switchToDfc,
  ADDON32, BRIDGE_CFG, HOST_DIR, RESHADE32_FOR, cached32, switchToDfc32,
  COMPAT_ADDON, cachedCompat, switchToDfcCompat,
  readDfcState, readCfgText, cfgPath,
};
