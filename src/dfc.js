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
// Chicken is distributed through its author's Discord. There is no public repository, no release
// URL and no stated licence, so this app cannot fetch it, cannot bundle it, and has no sha256 to
// pin the way integrity.js pins every other download. The same rule the AMD installer is under
// (CLAUDE.md, danielblnc/DLSS-NR-on-AMD#151): we do not redistribute someone else's work without
// permission. What this module does instead is take a copy the USER already has, keep it in this
// app's cache the way importDgVoodooZip keeps a user-supplied dgVoodoo2, and deploy that. The
// bytes are theirs throughout.
//
// WHAT COUNTS AS OURS.
//
// Only a deploy this module made, recorded in .dlss5ui-dfc.json with the exact names it placed.
// A Chicken the user installed with its own INSTALL-DEEP-FRIED-CHICKEN.cmd has no marker, and is
// never deleted, never overwritten and never reported as ours -- it stays a foreign toolchain, as
// it should, because its installer is the thing that knows how to take it out again.

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

// Takes what the user picked -- Chicken's zip, or the folder they unpacked it into -- and keeps a
// copy in this app's cache. Returns the cache path. Nothing is fetched and nothing is published:
// this is their download, stored where the app can find it again for the next game.
async function importDfcSource(sourcePath, cacheDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('the picked file or folder does not exist');
  const dest = path.join(cacheDir, CACHE_NAME);
  const stat = fs.statSync(sourcePath);

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
  return { path: dest, files: fs.readdirSync(dest).sort(), from: path.basename(sourcePath) };
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
  return PAYLOAD.some((n) => fs.existsSync(path.join(dir, n)));
}

// Here AND placed by this app. The distinction decides whether Remove may touch it and whether
// detect.js should go on calling it a foreign toolchain.
function dfcOurs(dir) {
  const m = readMarker(dir);
  return !!(m && Array.isArray(m.files) && m.files.length && dfcPresent(dir));
}

// Copies the cached payload in and records it. Refuses rather than overwrites when Chicken is
// already here and is not ours: that copy belongs to its own installer, which is also the only
// thing that knows how to uninstall it.
async function deployDfc(dir, cacheDir, { force = false } = {}) {
  const source = cachedDfc(cacheDir);
  if (!source) throw new Error('no Deep Fried Chicken copy has been supplied yet -- add one in Settings first');
  if (dfcPresent(dir) && !dfcOurs(dir) && !force) {
    return { deployed: false, reason: 'Deep Fried Chicken is already in this folder and this app did not put it there -- its own installer owns that copy', files: [] };
  }

  const placed = [];
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

  fs.writeFileSync(markerPath(dir), JSON.stringify({
    files: placed,
    from: path.basename(source),
    deployedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  return { deployed: true, files: placed };
}

// Takes out only what the marker says this app placed. A cfg the user has since edited is theirs;
// it is deleted only because we placed it and it carries no state they could not rebuild -- but
// the log never is, since it is the evidence for whatever sent them to support in the first place.
async function removeDfc(dir) {
  const marker = readMarker(dir);
  const removed = [];
  const kept = [];
  const failed = [];

  if (!marker) {
    if (dfcPresent(dir)) kept.push('Deep Fried Chicken (not placed by this app -- use its own UNINSTALL-DEEP-FRIED-CHICKEN.cmd)');
    return { removed, kept, failed };
  }

  for (const name of marker.files || []) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const r = await saferemove.removePath(p);
    if (r.ok) removed.push(name);
    else failed.push({ rel: name, code: r.code });
  }
  const m = await saferemove.removePath(markerPath(dir));
  if (!m.ok) failed.push({ rel: MARKER, code: m.code });

  if (fs.existsSync(path.join(dir, LOG))) kept.push(`${LOG} (Chicken's own log, left for support)`);
  return { removed, kept, failed };
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

// The config file, as text. Deliberately NOT parsed into keys and NOT written: Chicken's README
// says "Don't edit its settings file", its schema is not published, and this app has never been
// able to run the binary to check what a key does. Guessing one would be the same mistake as the
// D3D12 resource state in engine v1.0.21 (CLAUDE.md) -- wrong defaults that only break on someone
// else's machine. Shown as-is until a real cfg and its documentation are in hand.
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
  looksLikeDfc, importDfcSource, cachedDfc,
  readMarker, dfcPresent, dfcOurs, deployDfc, removeDfc,
  readDfcState, readCfgText, cfgPath,
};
