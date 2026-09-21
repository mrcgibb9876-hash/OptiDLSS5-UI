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
async function removeDfc(dir, { cacheDir = null, uninstall = false } = {}) {
  const marker = readMarker(dir);
  const removed = [];
  const kept = [];
  const failed = [];

  if (!marker) {
    if (dfcPresent(dir)) kept.push(`Deep Fried Chicken (${HAND_PLACED})`);
    return { removed, kept, failed };
  }

  if (cacheDir && fs.existsSync(path.join(dir, CFG))) {
    try { await stashCfg(dir, cacheDir); kept.push(`${CFG} (kept for this game's next switch to Chicken)`); } catch {}
  }

  for (const name of marker.files || []) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const r = await saferemove.removePath(p);
    if (r.ok) removed.push(name);
    else failed.push({ rel: name, code: r.code });
  }

  // ReShade back from the proxy slot. Only the file we renamed, and only while it still is ReShade.
  const proxy = marker.reshadeProxy ? path.join(dir, marker.reshadeProxy) : null;
  if (proxy && fs.existsSync(proxy) && isReShade(proxy)) {
    const plain = path.join(dir, RESHADE_PLAIN);
    if (uninstall || fs.existsSync(plain)) {
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
const HAND_PLACED = 'copied in by hand, not by this app -- delete its files to let this app manage Chicken here';

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
function supportedFor(detected) {
  const d = detected || {};
  if (d.bitness === 32) return { ok: false, code: 'dfc-32bit' };
  if (d.api === 'vulkan' || d.api === 'opengl') return { ok: false, code: 'dfc-vulkan-opengl' };
  if (d.api !== 'dx11' && d.api !== 'dx12') return { ok: false, code: 'dfc-api' };
  return { ok: true, code: null };
}

// Our engine out, ReShade in as the proxy, the NR model beside it, Chicken in -- with everything
// that can refuse checked before anything is touched, so a refusal leaves the folder as it was.
//   removeOptiScaler  main.js uninstallOptiScaler (the install journal knows what is ours)
//   nrDllPath         the NR model in Settings, for a folder that has none after OptiScaler left
async function switchToDfc(dir, cacheDir, { nrDllPath = null, removeOptiScaler } = {}) {
  if (!cachedDfc(cacheDir)) throw new Error('no Deep Fried Chicken copy has been added yet -- add yours in Edit first');
  if (dfcPresent(dir) && !dfcOurs(dir)) throw new Error(`Deep Fried Chicken is already in this folder, ${HAND_PLACED}`);

  const plain = path.join(dir, RESHADE_PLAIN);
  const proxy = path.join(dir, RESHADE_PROXY);
  const already = reshadeProxyOf(dir);
  if (!already && !fs.existsSync(plain)) throw new Error(`${RESHADE_PLAIN} is not here -- deploy the Feeder first`);
  const nrHere = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));
  if (!nrHere && !(nrDllPath && fs.existsSync(nrDllPath))) throw new Error('the NR model (nvngx_dlssnr.dll) is not set up in Settings, and Chicken needs it beside its add-on');
  // The proxy slot has to end up free for ReShade. Checked now, not after OptiScaler is out: a
  // dxgi.dll that is neither ReShade nor OptiScaler is somebody else's, and a game whose own
  // dxgi.dll OptiScaler's install backed up gets that file back the moment OptiScaler leaves.
  if (!already) {
    if (fs.existsSync(proxy) && !isReShade(proxy) && !isOptiScaler(proxy)) {
      throw new Error(`${RESHADE_PROXY} here is not this app's -- ReShade cannot take its place`);
    }
    const journal = readJson(path.join(dir, OPTISCALER_JOURNAL));
    const backedUpAs = journal && journal.backedUp ? String(journal.backedUpAs || journal.proxy || '').toLowerCase() : '';
    if (backedUpAs === RESHADE_PROXY) {
      throw new Error(`this game's own ${RESHADE_PROXY} was set aside when DLSS 5 was installed and comes back when it is taken out, so ReShade cannot use that name here`);
    }
  }

  const steps = [];
  const out = await removeOptiScaler(dir);
  if (out && out.failed && out.failed.length) {
    throw new Error(`OptiScaler could not be taken out (${out.failed.map((f) => `${f.rel}: ${f.code}`).join(', ')}) -- close the game and try again`);
  }
  if (out && out.removed && out.removed.length) steps.push('took OptiScaler out');

  if (!already) {
    // dxgi.dll is free now unless it is something that is neither ours nor ReShade (a game's own,
    // restored by the OptiScaler removal): that is never overwritten.
    if (fs.existsSync(proxy)) throw new Error(`${RESHADE_PROXY} here is not this app's -- ReShade cannot take its place`);
    await fsp.rename(plain, proxy);
    steps.push(`ReShade now loads itself as ${RESHADE_PROXY}`);
  }

  let nrPlaced = false;
  if (!fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) {
    await fsp.copyFile(nrDllPath, path.join(dir, 'nvngx_dlssnr.dll'));
    nrPlaced = true;
    steps.push('placed the NR model');
  }

  const deployed = await deployDfc(dir, cacheDir, { extra: { reshadeProxy: RESHADE_PROXY, ...(nrPlaced ? { nrPlaced } : {}) } });
  steps.push(deployed.restoredCfg ? 'deployed Chicken with this game\x27s saved settings' : 'deployed Chicken');
  return { ...deployed, steps };
}

// The player's cfg, kept in the cache per game folder while the game is back on DLSS 5.
function stashPathFor(dir, cacheDir) {
  const key = require('node:crypto').createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(cacheDir, 'configs', `${key}.cfg`);
}

async function stashCfg(dir, cacheDir) {
  const to = stashPathFor(dir, cacheDir);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(path.join(dir, CFG), to);
}

async function restoreStashedCfg(dir, cacheDir) {
  const from = stashPathFor(dir, cacheDir);
  if (!fs.existsSync(from)) return false;
  await fsp.copyFile(from, path.join(dir, CFG));
  return true;
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
  looksLikeDfc, importDfcSource, cachedDfc,
  readMarker, dfcPresent, dfcOurs, deployDfc, removeDfc,
  RESHADE_PROXY, reshadeProxyOf, supportedFor, switchToDfc,
  readDfcState, readCfgText, cfgPath,
};
