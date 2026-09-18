'use strict';
// Game Help's 'nr-model-only' route: OptiScaler out, and the NR model placed where the game's own
// Streamline looks for it. The route RHI takes on a game that ships its own DLSS -- see the case in
// main.js applyHelpFix for when it is offered.
//
// Out of main.js so the parts that can lose a user's file are testable without Electron. The review
// of 2026-09-18 found four ways the first cut did exactly that:
//   - it was reachable for a game with no DLSS of its own (the AI tier can ask for any fix in
//     gamehelp.FIX_IDS; only the rule table checked route.shipsDlss), where it removes OptiScaler and
//     leaves a model nothing will ever load -- refusal()
//   - it looked for "the game's own model" only beside the exe, while placing into the plugin /
//     Streamline folder, and recorded nothing, so Remove never took its copy back -- existingModel(),
//     the marker, removeNrModelOnly()
//   - a throw from the uninstall or the deploy (a DLL locked by a running game) left the model only
//     in the preserved cache copy, which nobody would ever find -- the recovery in nrModelOnly()
//   - the AMD route's pinned 310.8.0 model was fetched even on NVIDIA -- pickModelSource()

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const amdnr = require('./amdnr');
const nativeDlss = require('./native-dlss');

const MODEL = 'nvngx_dlssnr.dll';
const NRMODEL_MARKER = '.dlss5ui-nrmodel.json';

// The folder the game's own NGX looks in: where its DLSS/Streamline lives, else beside the exe.
function targetDirFor(dir) {
  const shipped = nativeDlss.shippedDlssPath(dir);
  return shipped ? path.dirname(shipped) : dir;
}

// Why this route must not run here, or null. Same test route.js makes for route.shipsDlss (a legacy
// renderer aside, which cannot have DLSS of its own to begin with): no DLSS or Streamline file of the
// game's own means nothing would ever load the model.
function refusal(dir) {
  if (!nativeDlss.shipsNativeDlss(dir)) {
    return 'this game has no DLSS of its own, so nothing would load the model without OptiScaler -- nothing was changed';
  }
  return null;
}

function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, NRMODEL_MARKER), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

// The folder a marker names, resolved and kept inside the game folder: a hand-edited marker must not
// point Remove at some other directory.
function markerTargetDir(dir, marker = readMarker(dir)) {
  if (!marker || typeof marker.target !== 'string') return null;
  const root = path.resolve(dir);
  const t = path.resolve(root, marker.target);
  const rel = path.relative(root, t);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return t;
}

// The card's "NR model present" check: beside the exe, or wherever this route put it.
function nrModelPresent(dir) {
  if (fs.existsSync(path.join(dir, MODEL))) return true;
  const t = markerTargetDir(dir);
  return !!t && fs.existsSync(path.join(t, MODEL));
}

// The model the game already has: in the target folder first (a game's own Streamline folder), then
// beside the exe (where Install puts the user's own).
function existingModel(dir, target) {
  for (const d of [target, dir]) {
    const p = path.join(d, MODEL);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// NVIDIA: the model Install uses -- the one set in Settings, else the newest build RHI publishes
// (main.js fetchNrModel, the SF build with RTX 20/30/40 support). AMD: the plain 310.8.0 build the
// DLSS-NR-on-AMD tool documents. The first cut used the AMD one everywhere.
async function pickModelSource({ vendor, settingsPath, fetchNvidia, fetchAmd }) {
  if (vendor === 'amd') return fetchAmd();
  if (settingsPath && fs.existsSync(settingsPath)) return settingsPath;
  return fetchNvidia();
}

// What removeNrModelOnly would do, for Remove's preview: game-folder-relative paths.
function removalPlan(dir) {
  const remove = [];
  const restore = [];
  const marker = readMarker(dir);
  if (!marker) return { remove, restore };
  const t = markerTargetDir(dir, marker);
  if (t) {
    const model = path.join(t, MODEL);
    const rel = path.relative(dir, model);
    if (marker.placed !== false && fs.existsSync(model)) remove.push(rel);
    if (marker.backedUp && fs.existsSync(path.join(t, path.basename(marker.backedUp)))) restore.push(rel);
  }
  remove.push(NRMODEL_MARKER);
  return { remove, restore };
}

// Remove's half, from the marker: our copy goes, the model it displaced comes back. Runs after the
// rest of Remove, because uninstallOptiScaler deletes nvngx_dlssnr.dll beside the exe outright: a
// game's own model put back there any earlier would be deleted again straight after.
async function removeNrModelOnly(dir) {
  const removed = [];
  const restored = [];
  const marker = readMarker(dir);
  if (!marker) return { removed, restored };
  const t = markerTargetDir(dir, marker);
  if (t) {
    const model = path.join(t, MODEL);
    const rel = path.relative(dir, model);
    // placed === false: the model in place was the game's own and this route left it there.
    if (marker.placed !== false && fs.existsSync(model)) {
      await fsp.rm(model, { force: true });
      removed.push(rel);
    }
    if (marker.backedUp) {
      const backup = path.join(t, path.basename(marker.backedUp));
      if (fs.existsSync(backup) && !fs.existsSync(model)) {
        await fsp.rename(backup, model);
        restored.push(rel);
      }
    }
  }
  await fsp.rm(path.join(dir, NRMODEL_MARKER), { force: true });
  removed.push(NRMODEL_MARKER);
  return { removed, restored };
}

const errText = (error) => (error && error.message ? error.message : String(error));

// The steps after the model has been stashed. Returns { done, text }; a throw from any dependency is
// turned into a result by nrModelOnly, which also decides what happens to the stash.
async function placeModel({ dir, target, uninstall, resolveSource, deploy, preserved, now }) {
  let removal;
  try {
    removal = await uninstall(dir);
  } catch (error) {
    return { done: false, text: `OptiScaler could not be taken out: ${errText(error)}` };
  }

  let source = preserved;
  if (!source) {
    try {
      source = await resolveSource();
    } catch (error) {
      // OptiScaler is already out at this point, so say so rather than reporting a clean failure:
      // the folder has changed and the user needs to know in which direction.
      return { done: false, text: `OptiScaler was removed, but no model could be fetched: ${errText(error)}` };
    }
  }

  let placed;
  try {
    placed = await deploy(target, source, { replace: true });
  } catch (error) {
    return { done: false, text: `OptiScaler was removed, but the model was not placed: ${errText(error)}` };
  }
  if (!placed || !placed.deployed) {
    return { done: false, text: `OptiScaler was removed, but the model was not placed: ${(placed && placed.reason) || 'refused'}` };
  }

  // What Remove has to undo (removeNrModelOnly). placed:false when the model in place already was
  // this very file -- the game's own, left where it was -- so Remove leaves it too.
  const marker = { target: path.relative(dir, target) || '.', backedUp: placed.backedUp || null, placed: !placed.already, at: new Date(now()).toISOString() };
  fs.writeFileSync(path.join(dir, NRMODEL_MARKER), JSON.stringify(marker, null, 2));

  const cleared = (removal && Array.isArray(removal.removed)) ? removal.removed.length : 0;
  const where = path.relative(dir, target) || 'the game folder';
  // Said out loud when there was already a model there: the name of the backup is the only way
  // anyone would know to put it back.
  const kept = placed.backedUp ? ` A model already in that folder was kept as ${placed.backedUp}.` : '';
  // Which model went back matters: the one the user supplied is the one they tested with.
  const whose = preserved ? 'the model this game already had' : 'a freshly fetched model';
  return {
    done: true,
    text: `OptiScaler is out (${cleared} file(s)) and ${whose} is in ${where}.${kept} Turn DLSS on in `
      + `the game's own video settings, then run it and check here again`,
  };
}

// The whole route once the user has confirmed. Dependencies come in so a test can make each step
// fail: uninstall(dir) is main.js's uninstallEverything, resolveSource() is pickModelSource bound to
// this machine, deploy is amdnr.deployAmdNrModel.
async function nrModelOnly({ dir, target = targetDirFor(dir), cacheDir, uninstall, resolveSource, deploy = amdnr.deployAmdNrModel, now = Date.now }) {
  // The model this game already has is the one to keep: the one the user tested with, or the game's
  // own. uninstallEverything deletes the copy beside the exe, so it is stashed first.
  const existing = existingModel(dir, target);
  let preserved = null;
  if (existing) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      preserved = path.join(cacheDir, `preserved-${now()}-${MODEL}`);
      await fsp.copyFile(existing, preserved);
    } catch {
      preserved = null; // fetching a fresh one is the fallback, not a failure
    }
  }

  let result;
  try {
    result = await placeModel({ dir, target, uninstall, resolveSource, deploy, preserved, now });
  } catch (error) {
    result = { done: false, text: `the model-only route failed: ${errText(error)}` };
  }

  if (preserved) {
    if (result.done || fs.existsSync(existing)) {
      await fsp.rm(preserved, { force: true }).catch(() => {});
    } else {
      // A failure after the uninstall took the model (a DLL locked by the running game, say): put it
      // back where it was, or at least say where it is. Without this the only copy sat under a
      // timestamped name in the app's cache, where nobody would look.
      try {
        await fsp.mkdir(path.dirname(existing), { recursive: true });
        await fsp.copyFile(preserved, existing);
        await fsp.rm(preserved, { force: true }).catch(() => {});
        result.text += ` The model this game had was put back in ${path.relative(dir, path.dirname(existing)) || 'the game folder'}.`;
      } catch {
        result.text += ` The model this game had is kept at ${preserved}.`;
      }
    }
  }
  return result;
}

module.exports = {
  MODEL,
  NRMODEL_MARKER,
  targetDirFor,
  refusal,
  readMarker,
  markerTargetDir,
  nrModelPresent,
  existingModel,
  pickModelSource,
  removalPlan,
  removeNrModelOnly,
  nrModelOnly,
};
