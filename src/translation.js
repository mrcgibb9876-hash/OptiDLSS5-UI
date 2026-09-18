// One owner for the graphics translation layers that sit in front of a legacy game: DXVK
// (D3D9/10/11 -> Vulkan) and dgVoodoo2 (D3D8/9 -> D3D11). Before this module each was deployed by
// whoever needed it, nothing recorded which one was in charge, and nothing stopped the two sharing
// a folder.
//
// What that cost, from a real support bundle (SWTOR, issue #50, 2026-09-17):
//
//   D3D9.dll                    564 KB   dgVoodoo2's, live
//   D3D9.dll.dlss5ui-orig      7.2 MB    DXVK's, buried by our own dgVoodoo2 deploy
//   dxgi.optiscaler_original_backup 5.4 MB   DXVK's, buried by our own OptiScaler install
//   d3d9 - Copy.dll            4.3 MB    the player's own hand-made copy
//   dxvk.conf                  1 byte    written by this app while dgVoodoo2 was the live wrapper
//
// So the app buried a working DXVK setup under dgVoodoo2 and then wrote config for the layer it
// had just displaced. dgVoodoo2 went on to fault at d3d9!00065af0, and the game's own crash report
// named the adapter "dgVoodoo DX API Layer".
//
// Two rules follow, and they are the whole point of this module:
//
//   1. The manifest is the truth. Which layer is in charge is recorded, not re-inferred from the
//      files on disk. Inference is what let a DX9 game read as D3D11 to its own router: dgVoodoo2
//      presents D3D11, detection believed it, and the guard that keeps a legacy renderer off the
//      DLSS routes never fired (see native-dlss.js rendererCannotCallDlss).
//   2. Never remove a file by name alone. `dxgi.dll` belongs to DXVK's file set AND is the proxy
//      name OptiScaler installs under; `d3d9.dll` can be DXVK, dgVoodoo2, ReShade or the game's
//      own. A purge that trusted the name would delete OptiScaler out of the folder it was asked
//      to clean. Every candidate is identified by its contents first, and anything this module
//      cannot positively identify as the layer being purged is left alone and reported.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MANIFEST = '.dlss5ui-translation.json';
// The marker the dgVoodoo2 half of legacy.js has been writing since the 32-bit route shipped. Folders
// in the wild carry it and no .dlss5ui-translation.json, so it is read as a dgVoodoo2 manifest.
const LEGACY_MARKER = '.dlss5ui-legacy.json';
const BACKUP_SUFFIX = '.dlss5ui-orig';

// The file sets, lower-cased. `owns` is what a purge of that layer may remove once the contents
// agree; `configs` are files only that layer ever creates, so a name match is enough for them.
const LAYERS = {
  dxvk: {
    id: 'dxvk',
    label: 'DXVK',
    translates: 'Direct3D 9/10/11 to Vulkan',
    // d3d8.dll is in DXVK's set too, from 3.x onward: the v3.1.1 release ships x32/ and x64/ each
    // holding d3d8, d3d9, d3d10core, d3d11 and dxgi. Leaving it out made a purge walk past a DXVK
    // d3d8.dll and, worse, let dgVoodoo2 claim the name unopposed.
    owns: ['d3d8.dll', 'd3d9.dll', 'd3d10core.dll', 'd3d11.dll', 'dxgi.dll'],
    configs: ['dxvk.conf'],
    logs: ['dxvk.log', 'd3d9.log', 'd3d11.log', 'dxgi.log'],
    signature: 'DXVK',
  },
  dgvoodoo: {
    id: 'dgvoodoo',
    label: 'dgVoodoo2',
    translates: 'Direct3D 8/9 to Direct3D 11',
    owns: ['d3d8.dll', 'd3d9.dll', 'd3dimm.dll', 'ddraw.dll', 'drawgl.dll'],
    configs: ['dgvoodoo.conf', 'dgvoodoocpl.exe'],
    logs: ['dgvoodoo.log'],
    signature: 'dgVoodoo',
  },
};

const LAYER_IDS = Object.keys(LAYERS);

// Read far enough into a DLL to catch its name string without pulling a 26 MB OptiScaler into
// memory for every card render. The signatures below all sit in the headers or the import table.
const SNIFF_BYTES = 512 * 1024;

// Things that are never a translation layer and must survive any purge, checked before the layer
// signatures because they share filenames with them. OptiScaler installs as dxgi.dll (and winmm,
// version, ...), and ReShade can be d3d9.dll or dxgi.dll on its own routes.
const PROTECTED = [
  { id: 'optiscaler', signature: 'OptiScaler' },
  { id: 'reshade', signature: 'ReShade' },
];

// The folder's files, keyed by lower-cased name. Every lookup below goes through this rather than
// joining a lower-cased constant onto the path: dgVoodoo2 ships "D3D9.dll", DXVK ships "d3d9.dll",
// and a literal join finds only one of them off Windows. Reading the directory once also keeps a
// purge to a single listing instead of a stat per candidate name.
function indexDir(dir) {
  const byLower = new Map();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return byLower; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    byLower.set(e.name.toLowerCase(), e.name);
  }
  return byLower;
}

function sniff(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (!size) return null;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, SNIFF_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// What a file actually is: 'dxvk', 'dgvoodoo', 'optiscaler', 'reshade', or null when nothing in it
// says. Contents only -- the name is what got this wrong in the first place.
function identifyWrapper(file) {
  const base = path.basename(file).toLowerCase();
  for (const id of LAYER_IDS) {
    if (LAYERS[id].configs.includes(base)) return id;
  }
  const buf = sniff(file);
  if (!buf) return null;
  for (const p of PROTECTED) {
    if (buf.includes(Buffer.from(p.signature, 'latin1'))) return p.id;
  }
  for (const id of LAYER_IDS) {
    if (buf.includes(Buffer.from(LAYERS[id].signature, 'latin1'))) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Manifest

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    if (m && LAYERS[m.layer]) return m;
  } catch {}
  // A dgVoodoo2 deploy from before this module: legacy.js's marker, read as one.
  try {
    const old = JSON.parse(fs.readFileSync(path.join(dir, LEGACY_MARKER), 'utf8'));
    if (old && old.dgVoodoo) {
      return {
        version: 1,
        layer: 'dgvoodoo',
        arch: old.dgVoodoo.arch || null,
        source: old.dgVoodoo.source || null,
        placedAt: old.placedAt || null,
        files: old.files || [],
        backups: old.backups || [],
        fromLegacyMarker: true,
      };
    }
  } catch {}
  return null;
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function newManifest({ layer, arch = null, source = null, files = [], backups = [] }) {
  if (!LAYERS[layer]) throw new Error(`unknown translation layer: ${layer}`);
  return { version: 1, layer, arch, source, placedAt: new Date().toISOString(), files, backups };
}

// Which layer is in front of this game. The manifest first, because that is a record rather than a
// guess; only when there is none does it fall back to reading the folder, which is how a wrapper a
// player installed by hand is found.
function activeLayer(dir) {
  const manifest = readManifest(dir);
  if (manifest) return { layer: manifest.layer, ours: true, manifest };
  const index = indexDir(dir);
  for (const id of LAYER_IDS) {
    const spec = LAYERS[id];
    for (const lower of [...spec.owns, ...spec.configs]) {
      const actual = index.get(lower);
      if (!actual) continue;
      if (identifyWrapper(path.join(dir, actual)) === id) {
        return { layer: id, ours: false, manifest: null, foundAs: actual };
      }
    }
  }
  return { layer: null, ours: false, manifest: null };
}

// Every translation-layer file in the folder, whoever put it there, with what each one really is.
// The survey a purge works from and the UI reports.
function surveyWrappers(dir) {
  const index = indexDir(dir);
  const seen = new Map();
  for (const id of LAYER_IDS) {
    for (const lower of [...LAYERS[id].owns, ...LAYERS[id].configs]) {
      if (seen.has(lower)) continue;
      const actual = index.get(lower);
      if (!actual) continue;
      const file = path.join(dir, actual);
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      seen.set(lower, { file: actual, size, is: identifyWrapper(file) });
    }
  }
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------------------------
// Purge

// Removes the translation layer(s) from a game folder and puts back whatever they displaced.
//
// layer: one id, or null for every layer (the reset-to-stock the auto-fix needs before it swaps).
// A file is only removed when it is positively identified as belonging to the layer being purged,
// or when this app's own manifest says it put it there. Everything else is left where it is and
// listed in `skipped`, with the reason -- deleting a file we cannot account for is how a folder
// loses the game's own d3d9.dll, or OptiScaler.
async function purgeTranslationLayer(dir, { layer = null, dryRun = false } = {}) {
  const targets = layer ? [layer] : LAYER_IDS;
  for (const id of targets) if (!LAYERS[id]) throw new Error(`unknown translation layer: ${id}`);

  const removed = [];
  const restored = [];
  const skipped = [];
  const manifest = readManifest(dir);
  const manifestFiles = new Set(
    manifest && targets.includes(manifest.layer)
      ? (manifest.files || []).map((f) => f.toLowerCase())
      : [],
  );

  const rm = async (rel) => {
    if (dryRun) return true;
    try { await fsp.rm(path.join(dir, rel), { force: true }); return true; } catch { return false; }
  };

  // 1. The files themselves, identified before they are touched.
  //
  // Every candidate name across the targeted layers is gathered first and judged once. Walking the
  // layers one after another instead would let the first pass claim a file the second owns: on a
  // purge of both, DXVK's pass reaches d3d9.dll, finds dgVoodoo2 in it, sets it aside as "not
  // mine", and dgVoodoo2's pass never gets to remove it. The two file sets overlap on d3d9.dll and
  // dxgi.dll, so that is the common case, not the corner.
  const index = indexDir(dir);
  const candidates = new Map();
  for (const id of targets) {
    const spec = LAYERS[id];
    for (const lower of [...spec.owns, ...spec.configs]) {
      if (!candidates.has(lower)) candidates.set(lower, { logOf: null });
    }
    // A log carries no signature to read, so its name is what assigns it.
    for (const lower of spec.logs) {
      const seen = candidates.get(lower);
      if (seen) seen.logOf = seen.logOf || id;
      else candidates.set(lower, { logOf: id });
    }
  }

  for (const [lower, meta] of candidates) {
    const actual = index.get(lower);
    if (!actual) continue;
    const ours = manifestFiles.has(lower);
    const identity = meta.logOf || identifyWrapper(path.join(dir, actual));

    if (targets.includes(identity) || (ours && identity === null)) {
      if (await rm(actual)) removed.push(actual);
      continue;
    }
    if (identity) {
      skipped.push({ file: actual, reason: `it is ${identity}, not a translation layer being removed` });
      continue;
    }
    skipped.push({ file: actual, reason: 'nothing in it says which tool it belongs to' });
  }

  // 2. Anything the layer displaced goes back, so the folder is stock rather than merely empty of
  //    wrappers. This is what returns the player's own DXVK d3d9.dll after a dgVoodoo2 deploy.
  if (manifest && targets.includes(manifest.layer)) {
    for (const b of manifest.backups || []) {
      const cur = path.join(dir, ...b.rel.split('/'));
      const bak = path.join(dir, ...b.backup.split('/'));
      if (!fs.existsSync(bak)) continue;
      if (dryRun) { restored.push(b.rel); continue; }
      try {
        await fsp.rm(cur, { force: true });
        await fsp.rename(bak, cur);
        restored.push(b.rel);
      } catch {
        skipped.push({ file: b.rel, reason: 'its backup could not be put back' });
      }
    }
    if (!dryRun) {
      await fsp.rm(path.join(dir, MANIFEST), { force: true });
      if (manifest.fromLegacyMarker) await fsp.rm(path.join(dir, LEGACY_MARKER), { force: true });
    }
  }

  return { layer, removed, restored, skipped, wasActive: manifest ? manifest.layer : null };
}

// ---------------------------------------------------------------------------------------------
// Exclusivity

// May `layer` be deployed here as things stand? The gate every deploy goes through, so the two
// sets can never share a folder again. `purgeFirst` is the caller's cue to run the purge rather
// than refuse: a layer this app placed is ours to replace, one a player placed by hand is not.
function canDeploy(dir, layer) {
  if (!LAYERS[layer]) throw new Error(`unknown translation layer: ${layer}`);
  const active = activeLayer(dir);
  if (!active.layer || active.layer === layer) {
    return { ok: true, purgeFirst: !!active.layer, conflict: null };
  }
  if (active.ours) {
    return { ok: true, purgeFirst: true, conflict: active.layer };
  }
  return {
    ok: false,
    purgeFirst: false,
    conflict: active.layer,
    reason: `${LAYERS[active.layer].label} is already in this folder and this app did not put it there `
      + `(${active.foundAs}). Remove it yourself first, or keep using it -- deploying ${LAYERS[layer].label} `
      + 'on top would leave two translation layers fighting over the same game.',
  };
}

module.exports = {
  MANIFEST,
  LEGACY_MARKER,
  BACKUP_SUFFIX,
  LAYERS,
  LAYER_IDS,
  identifyWrapper,
  readManifest,
  writeManifest,
  newManifest,
  activeLayer,
  surveyWrappers,
  purgeTranslationLayer,
  canDeploy,
};
