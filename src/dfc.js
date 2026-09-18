// Deep Fried Chicken as a neural consumer you can choose per game, instead of only a clash to
// clear out.
//
// What it is, from the DLSS5-Feeder README, which documents the interop: DFC is a ReShade add-on
// that "does the neural rendering on top of what this project feeds it", and the Feeder names it
// the recommended consumer. So it is not a rival to the Feeder and it is not a route of its own --
// it replaces OptiScaler in one job only, the neural pass at the end. Whatever produces the DLSS
// call (the game's own DLSS, the Feeder, the 32-bit helper) is unchanged.
//
// That is why this is a consumer choice rather than a new route id. A route here says how the DLSS
// call is produced and hooked; picking DFC does not change any of that, it changes who consumes
// the call. Modelling it as a route would have meant duplicating every existing route with a DFC
// variant, and would have read to the user as though the Feeder were no longer involved.
//
// Three facts this module exists to encode, each of which is easy to get wrong:
//
//   1. Two neural add-ons is the one thing never to do. The Feeder's README: "Never install two
//      neural add-ons", and "If Deep Fried Chicken finds RenoDX's add-on or Alex's Toolkit loaded
//      beside it, it does nothing at all for the whole session". OptiScaler's own NR pass is
//      another one. The failure is silent -- an install that reports success, a panel that opens,
//      and no picture change ever -- which is exactly why detect.js flags DFC as a conflict today.
//      Choosing DFC does not make that rule go away; it decides which side of it to be on.
//   2. On a 32-bit game the files do NOT go beside the exe. The README is explicit: they go "in the
//      `host64\\` folder next to `dlss5-feed-host64.exe` -- not beside the game itself", because
//      that is the process doing the D3D12 work.
//   3. It is user-supplied and always will be. DFC is distributed through its author's Discord,
//      with no public repository and no licence to rely on, so this app never fetches, caches or
//      mirrors it -- the same posture as LumeniteFX and Luma. It detects, configures around, and
//      removes on request.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The three files DFC ships, plus the log it writes beside them. Exactly the set detect.js already
// recognises; kept here as the one definition both can share.
const DFC_FILES = ['deep-fried-chicken.addon64', 'deep-fried-chicken-nvngx.dll', 'deep-fried-chicken.cfg'];
const DFC_LOG = 'deep-fried-chicken.log';
const DFC_ADDON = 'deep-fried-chicken.addon64';

// Where it comes from. No repository, no release page, no licence: a Discord invite is the whole
// of its distribution, which settles the question of whether this app could ever fetch it.
const DFC_SOURCE = 'https://discord.gg/g2v2XGqvR';
const DFC_MIN_VERSION = '1.4.8';

// The 32-bit helper folder, spelled the same as legacy.js's HOST_DIR. Not imported from there: that
// module pulls in the whole legacy route, and this needs one string.
const HOST_DIR = 'host64';

// Which neural consumer this game is set to. A preference, so it lives in its own marker and is
// never treated as an install leftover (see main.js's `leftovers` note -- a preference marker in
// that list turns the card's Install button into a red "Remove leftovers" that deletes the choice).
const MARKER = '.dlss5ui-neural.json';
const CONSUMERS = ['optiscaler', 'dfc'];
const DEFAULT_CONSUMER = 'optiscaler';

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
}

// The chosen consumer, defaulting to OptiScaler. Nothing changes for a game nobody has touched.
function consumerFor(dir) {
  const m = readMarker(dir);
  return m && CONSUMERS.includes(m.consumer) ? m.consumer : DEFAULT_CONSUMER;
}

function dfcChosen(dir) {
  return consumerFor(dir) === 'dfc';
}

// Records the choice. Writing the default removes the marker rather than storing it, so a folder
// left on OptiScaler is byte-for-byte what it was before anyone opened the dropdown.
function setConsumer(dir, consumer) {
  const file = path.join(dir, MARKER);
  if (!CONSUMERS.includes(consumer)) throw new Error(`unknown neural consumer: ${consumer}`);
  if (consumer === DEFAULT_CONSUMER) {
    try { fs.rmSync(file, { force: true }); } catch {}
    return DEFAULT_CONSUMER;
  }
  fs.writeFileSync(file, JSON.stringify({ consumer, setAt: new Date().toISOString() }, null, 2), 'utf8');
  return consumer;
}

// Where DFC's files belong for this game. Beside the exe normally; inside host64\ for a 32-bit
// game, because the 64-bit helper there is the process that runs the neural pass.
function dfcDir(dir, bitness) {
  return Number(bitness) === 32 ? path.join(dir, HOST_DIR) : dir;
}

// What is actually on disk, in the folder that matters for this game's bitness.
function dfcStatus(dir, bitness) {
  const target = dfcDir(dir, bitness);
  const present = DFC_FILES.filter((f) => fs.existsSync(path.join(target, f)));
  const missing = DFC_FILES.filter((f) => !present.includes(f));
  return {
    chosen: dfcChosen(dir),
    dir: target,
    inHostDir: target !== dir,
    present: missing.length === 0,
    partial: present.length > 0 && missing.length > 0,
    missing,
    files: present,
    logged: fs.existsSync(path.join(target, DFC_LOG)),
  };
}

// Every neural add-on in the folder that is not DFC. The Feeder's README names the two it knows
// about by effect: "If Deep Fried Chicken finds RenoDX's add-on or Alex's Toolkit loaded beside it,
// it does nothing at all for the whole session." ReShade loads every .addon64 whatever it is
// called, so this matches on the name anywhere, the same way detect.js had to after a renamed
// RenoDX add-on went unseen on SWTOR.
const RIVAL_ADDON = /(renodx-dlss|alex.?s?.?toolkit|toolkit-dlss).*\.addon(64|32)?$/i;

function rivalNeuralAddons(dir, bitness) {
  const target = dfcDir(dir, bitness);
  let names = [];
  try { names = fs.readdirSync(target); } catch { return []; }
  return names.filter((n) => RIVAL_ADDON.test(n));
}

// Everything standing between this game and a working DFC pass, as reasons rather than a boolean.
// optiScalerNrOn is read by the caller (it owns the ini), because this module deliberately knows
// nothing about OptiScaler.ini.
function dfcBlockers(dir, { bitness = 64, optiScalerNrOn = false } = {}) {
  const status = dfcStatus(dir, bitness);
  const blockers = [];
  if (!status.present) {
    blockers.push({
      key: 'dfc-files',
      detail: status.partial
        ? `Deep Fried Chicken is only half here: ${status.missing.join(', ')} missing from ${status.inHostDir ? `${HOST_DIR}\\` : 'the game folder'}.`
        : `Deep Fried Chicken's three files are not in ${status.inHostDir ? `${HOST_DIR}\\` : 'the game folder'} yet.`,
    });
  }
  if (optiScalerNrOn) {
    blockers.push({
      key: 'dfc-optiscaler-nr',
      detail: 'OptiScaler\'s own Neural Rendering is still on. Two neural add-ons in one process is the case '
        + 'Deep Fried Chicken refuses outright: it does nothing at all for the whole session, silently.',
    });
  }
  const rivals = rivalNeuralAddons(dir, bitness);
  if (rivals.length) {
    blockers.push({
      key: 'dfc-rival-addon',
      detail: `${rivals.join(', ')} is another neural add-on in the same folder. Deep Fried Chicken does nothing at all `
        + 'for the whole session when it finds one.',
    });
  }
  return blockers;
}

module.exports = {
  DFC_FILES,
  DFC_LOG,
  DFC_ADDON,
  DFC_SOURCE,
  DFC_MIN_VERSION,
  MARKER,
  CONSUMERS,
  DEFAULT_CONSUMER,
  HOST_DIR,
  consumerFor,
  dfcChosen,
  setConsumer,
  dfcDir,
  dfcStatus,
  rivalNeuralAddons,
  dfcBlockers,
};
