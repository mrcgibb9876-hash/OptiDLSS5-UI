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
const crypto = require('node:crypto');
const { readTarGz, findTarEntry } = require('./tar');

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
    // DXVK names its logs after the exe that loaded it: <exe>_d3d9.log, <exe>_d3d11.log,
    // <exe>_dxgi.log. The bare names above are what a DXVK_LOG_PATH-less older build wrote. The
    // Assassin's Creed II folder (2026-09-18) held AssassinsCreedIIGame_d3d9.log from a DXVK try the
    // purge never saw, because only the bare names were on the list.
    logPattern: /^.+_(d3d8|d3d9|d3d10core|d3d11|dxgi)\.log$/i,
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

// The whole file is read, in chunks, and in both encodings a name can be stored in. The first 512 KB
// in latin1 used to be enough in theory ("the signatures all sit in the headers") and in practice
// recognised nothing real. Measured on the Assassin's Creed II folder and the DXVK 3.1.1 release
// (2026-09-18): 'ReShade' first appears at 3.46 MB in ReShade's own DLL, 'DXVK' at 2.3 MB in DXVK's
// d3d9.dll, 'OptiScaler' at 24.8 MB in OptiScaler, and dgVoodoo2's D3D9.dll carries its name ONLY
// as UTF-16 (its version resource, at 480 KB). So every identification returned null, and the guard
// in deployDxvk that keeps DXVK off a name OptiScaler or ReShade is loading under never fired.
const SCAN_CHUNK = 4 * 1024 * 1024;
// Past this a file is not a translation layer or a proxy DLL; it is left unidentified rather than
// streamed for every card render. OptiScaler is the largest thing that can sit here (26 MB).
const SCAN_MAX_BYTES = 128 * 1024 * 1024;

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

// In priority order: the protected tools first, because they carry the layers' names too (the
// OptiScaler_DLSSNR build mentions both 'ReShade' and 'DXVK'), then the layers.
const SIGNATURES = [
  ...PROTECTED.map((p) => ({ id: p.id, text: p.signature })),
  ...LAYER_IDS.map((id) => ({ id, text: LAYERS[id].signature })),
].map((s) => ({ ...s, variants: [Buffer.from(s.text, 'latin1'), Buffer.from(s.text, 'utf16le')] }));
const SCAN_OVERLAP = Math.max(...SIGNATURES.flatMap((s) => s.variants.map((v) => v.length)));

// Which signatures a file carries, streamed through one fixed buffer. Stops early only once the
// top-priority signature is found, since nothing can outrank it.
function scanSignatures(file, size) {
  const found = new Set();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(SCAN_CHUNK + SCAN_OVERLAP);
    let carry = 0;
    let pos = 0;
    while (pos < size) {
      const bytesRead = fs.readSync(fd, buf, carry, SCAN_CHUNK, pos);
      if (bytesRead <= 0) break;
      const view = buf.subarray(0, carry + bytesRead);
      for (const s of SIGNATURES) {
        if (found.has(s.id)) continue;
        if (s.variants.some((v) => view.includes(v))) found.add(s.id);
      }
      if (found.has(SIGNATURES[0].id)) break;
      pos += bytesRead;
      carry = Math.min(SCAN_OVERLAP, view.length);
      view.copy(buf, 0, view.length - carry, view.length);
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return found;
}

// Keyed by path, size and mtime: activeLayer runs for a card render (native-dlss.js), and a 7 MB
// DXVK d3d9.dll does not change between two renders.
const identityCache = new Map();

// What a file actually is: 'dxvk', 'dgvoodoo', 'optiscaler', 'reshade', or null when nothing in it
// says. Contents only -- the name is what got this wrong in the first place.
function identifyWrapper(file) {
  const base = path.basename(file).toLowerCase();
  for (const id of LAYER_IDS) {
    if (LAYERS[id].configs.includes(base)) return id;
  }
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || !st.size || st.size > SCAN_MAX_BYTES) return null;
  const key = `${path.resolve(file)}|${st.size}|${st.mtimeMs}`;
  if (identityCache.has(key)) return identityCache.get(key);
  const found = scanSignatures(file, st.size);
  const id = found ? (SIGNATURES.find((s) => found.has(s.id)) || {}).id || null : null;
  if (identityCache.size > 512) identityCache.clear();
  identityCache.set(key, id);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Manifest

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    if (m && LAYERS[m.layer]) return m;
  } catch {}
  // A dgVoodoo2 deploy from before this module: legacy.js's marker, read as one.
  //
  // Only dgVoodoo2's own entries are taken from it. That marker is also the one record of the whole
  // 32-bit helper install -- the game-side ReShade dxgi.dll, the add-on, host64\ -- and handing ALL
  // of its files and backups to a purge meant a dgVoodoo2 purge took the ReShade proxy (unidentified
  // at the time, so "ours by the manifest") and then deleted the marker itself. A dry run on the
  // real Assassin's Creed II folder (2026-09-18) listed dxgi.dll for removal exactly that way.
  try {
    const old = readLegacyMarker(dir);
    if (old && old.dgVoodoo) {
      const mine = dgVoodooNames(old);
      return {
        version: 1,
        layer: 'dgvoodoo',
        arch: old.dgVoodoo.arch || null,
        source: old.dgVoodoo.source || null,
        placedAt: old.placedAt || null,
        files: (old.files || []).filter((f) => mine.has(String(f).toLowerCase())),
        backups: (old.backups || []).filter((b) => b && mine.has(String(b.rel).toLowerCase())),
        fromLegacyMarker: true,
      };
    }
  } catch {}
  return null;
}

function readLegacyMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, LEGACY_MARKER), 'utf8')); } catch { return null; }
}

// The names legacy.js's deployDgVoodoo writes: the wrapper DLL it chose, its control panel and its
// config. Nothing else in that marker is dgVoodoo2's.
function dgVoodooNames(marker) {
  const dll = marker && marker.dgVoodoo && marker.dgVoodoo.dll ? String(marker.dgVoodoo.dll) : 'D3D9.dll';
  return new Set([dll, 'dgVoodooCpl.exe', 'dgVoodoo.conf'].map((n) => n.toLowerCase()));
}

// Takes dgVoodoo2 out of legacy.js's marker and leaves every other record in it. The marker is
// rewritten, never deleted, while it still records anything -- it is how Remove finds host64\ and
// the ReShade proxy. Only a marker with nothing else left in it goes.
function stripDgVoodooFromLegacyMarker(dir) {
  const marker = readLegacyMarker(dir);
  if (!marker || !marker.dgVoodoo) return false;
  const mine = dgVoodooNames(marker);
  const next = { ...marker };
  delete next.dgVoodoo;
  next.files = (marker.files || []).filter((f) => !mine.has(String(f).toLowerCase()));
  next.backups = (marker.backups || []).filter((b) => !(b && mine.has(String(b.rel).toLowerCase())));
  const markerPath = path.join(dir, LEGACY_MARKER);
  const { version, placedAt, ...rest } = next;
  const holdsNothing = Object.entries(rest).every(([, v]) => (Array.isArray(v) ? v.length === 0 : !v));
  if (holdsNothing) fs.rmSync(markerPath, { force: true });
  else fs.writeFileSync(markerPath, JSON.stringify(next, null, 2), 'utf8');
  return true;
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
    const logNames = [...spec.logs];
    if (spec.logPattern) for (const lower of index.keys()) if (spec.logPattern.test(lower)) logNames.push(lower);
    for (const lower of logNames) {
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
    }
  }
  // dgVoodoo2's entries in legacy.js's marker go with it -- whether the manifest was read from that
  // marker or dgVoodoo2 also wrote one of its own (deployDgVoodoo does both now). Left in, the marker
  // would go on saying dgVoodoo2 is deployed after its files were gone, and Install would put it
  // straight back over whatever replaced it.
  if (!dryRun && targets.includes('dgvoodoo') && manifest && manifest.layer === 'dgvoodoo') stripDgVoodooFromLegacyMarker(dir);

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

// ---------------------------------------------------------------------------------------------
// DXVK: acquiring it, and putting it in front of a game

// The pinned release. Fetched on demand and never bundled, the same shape as legacy.js's dgVoodoo2
// pin, so the installer carries no third-party binaries. DXVK is zlib/libpng licensed, which does
// permit redistribution; fetching still beats bundling because it keeps the manager small and lets
// the pin move without a release of ours.
//
// Verified against the real archive, not from memory: dxvk-3.1.1.tar.gz is 18,041,512 bytes and
// unpacks to dxvk-3.1.1/x32/ and dxvk-3.1.1/x64/, each holding d3d8, d3d9, d3d10core, d3d11 and
// dxgi. That is where the d3d8.dll in DXVK's file set above comes from.
const DXVK = {
  version: '3.1.1',
  url: 'https://github.com/doitsujin/dxvk/releases/download/v3.1.1/dxvk-3.1.1.tar.gz',
  sha256: '40565b4a724aadc4433fa4e010b4b23916d9b1f1baeee64e17186db94f54e608',
  fileName: 'dxvk-3.1.1.tar.gz',
  cacheName: 'dxvk-3.1.1',
  page: 'https://github.com/doitsujin/dxvk/releases',
  licence: 'zlib/libpng',
};

// Which of DXVK's DLLs a game actually needs, by the API it renders with. Only what the game loads
// goes in: every extra file is another name that can collide with OptiScaler, ReShade or the game's
// own, and the whole point of this module is to stop that happening.
//
// dxgi.dll is the one to watch. DXVK needs it for D3D10/11, and it is also the name OptiScaler
// installs under, so those two routes cannot both have it. deployDxvk refuses rather than choosing.
const DXVK_FILES_FOR_API = {
  dx8: ['d3d8.dll', 'd3d9.dll'],
  dx9: ['d3d9.dll'],
  dx10: ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll'],
  dx11: ['d3d11.dll', 'dxgi.dll'],
};

const DXVK_MANIFEST_FILE = 'files.json';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function archDir(bitness) {
  return Number(bitness) === 32 ? 'x32' : 'x64';
}

// Is this cache folder a usable DXVK unpack?
function cachedDxvk(cacheDir) {
  const dest = path.join(cacheDir, DXVK.cacheName);
  for (const arch of ['x32', 'x64']) {
    if (!fs.existsSync(path.join(dest, arch, 'd3d9.dll'))) return null;
  }
  return dest;
}

// The pinned release, verified, unpacked into the cache as x32/ and x64/. Errors are told apart the
// way legacy.js tells them apart, because the remedies differ: a bad download is worth retrying and
// a file that vanished after being written is antivirus, which is not.
async function ensureDxvk(cacheDir, { fetchImpl = fetch, headers = {} } = {}) {
  const cached = cachedDxvk(cacheDir);
  if (cached) return cached;
  await fsp.mkdir(cacheDir, { recursive: true });

  const res = await fetchImpl(DXVK.url, { headers });
  if (!res.ok) throw Object.assign(new Error(`DXVK download failed: HTTP ${res.status}`), { code: 'dxvk-network' });
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== DXVK.sha256) {
    throw Object.assign(
      new Error(`DXVK download did not match its checksum (expected ${DXVK.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`),
      { code: 'dxvk-checksum' },
    );
  }
  return unpackDxvk(buf, cacheDir);
}

async function unpackDxvk(buf, cacheDir) {
  const files = readTarGz(buf);
  const dest = path.join(cacheDir, DXVK.cacheName);
  const partial = `${dest}.partial`;
  await fsp.rm(partial, { recursive: true, force: true });

  const written = {};
  const wanted = [...new Set(Object.values(DXVK_FILES_FOR_API).flat())];
  for (const arch of ['x32', 'x64']) {
    for (const name of wanted) {
      const entry = findTarEntry(files, `${arch}/${name}`);
      if (!entry) continue;
      const out = path.join(partial, arch, name);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, entry.data);
      written[`${arch}/${name}`] = sha256(entry.data);
    }
  }
  if (!written['x64/d3d9.dll'] || !written['x32/d3d9.dll']) {
    await fsp.rm(partial, { recursive: true, force: true });
    throw Object.assign(new Error('that archive is not a DXVK release (no x32/d3d9.dll and x64/d3d9.dll)'), { code: 'dxvk-not-a-release' });
  }

  await fsp.writeFile(
    path.join(partial, DXVK_MANIFEST_FILE),
    JSON.stringify({ source: `official ${DXVK.version}`, archiveSha256: sha256(buf), files: written }, null, 2),
    'utf8',
  );
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.rename(partial, dest);
  return dest;
}

// Puts DXVK in front of a game.
//
// sourceDir is an ensureDxvk() unpack. api decides which DLLs go in, bitness which build. Anything
// of the game's own under one of those names is backed up and recorded, so a purge gives it back.
//
// It refuses rather than overwrites when a name is held by OptiScaler or ReShade. Backing those up
// would take the file out from under their own install journals, which is how the SWTOR folder
// ended up with OptiScaler's dxgi.dll and DXVK's buried under three different names at once.
async function deployDxvk(dir, { sourceDir, api, bitness }) {
  const wanted = DXVK_FILES_FOR_API[api];
  if (!wanted) throw new Error(`DXVK has no file set for ${api || 'an unknown API'}`);

  const gate = canDeploy(dir, 'dxvk');
  if (!gate.ok) return { deployed: [], backedUp: [], refused: [{ file: gate.conflict, reason: gate.reason }], ok: false };

  const arch = archDir(bitness);

  // Every name is judged BEFORE anything is purged or copied, and one refusal stops the whole
  // deploy. Refusing per file used to leave half a DXVK: a 32-bit DirectX 11 game on the helper
  // route has ReShade as its dxgi.dll, so dxgi.dll was refused, d3d11.dll went in anyway, dgVoodoo2
  // (had there been one) was already purged, and the swap reported success. D3D11 without DXVK's
  // dxgi.dll is not a working DXVK. (Review of the 2.2.3 swap, 2026-09-18.)
  const before = indexDir(dir);
  const refused = [];
  for (const name of wanted) {
    const src = path.join(sourceDir, arch, name);
    if (!fs.existsSync(src)) {
      refused.push({ file: name, reason: `the cached DXVK release has no ${arch}/${name}` });
      continue;
    }
    const existingName = before.get(name);
    if (!existingName) continue;
    const identity = identifyWrapper(path.join(dir, existingName));
    if (identity === 'optiscaler' || identity === 'reshade') {
      refused.push({
        file: existingName,
        reason: `${existingName} is ${identity === 'optiscaler' ? 'OptiScaler' : 'ReShade'}, which loads under that name here. `
          + 'Moving it would break its own install record, so DXVK was not put in on top of it.',
      });
    }
  }
  if (refused.length) return { deployed: [], backedUp: [], refused, ok: false };

  if (gate.purgeFirst) await purgeTranslationLayer(dir, { layer: gate.conflict || 'dxvk' });

  const index = indexDir(dir);
  const deployed = [];
  const backedUp = [];

  for (const name of wanted) {
    const src = path.join(sourceDir, arch, name);
    const existingName = index.get(name);
    if (existingName) {
      const identity = identifyWrapper(path.join(dir, existingName));
      if (identity !== 'dxvk') {
        // The game's own, or something unidentifiable: preserved under the suffix a purge restores from.
        const backup = `${existingName}${BACKUP_SUFFIX}`;
        if (!fs.existsSync(path.join(dir, backup))) {
          await fsp.rename(path.join(dir, existingName), path.join(dir, backup));
          backedUp.push({ rel: existingName, backup });
        }
      }
    }
    await fsp.copyFile(src, path.join(dir, name));
    deployed.push(name);
  }

  if (!deployed.length) return { deployed, backedUp, refused, ok: false };

  writeManifest(dir, newManifest({
    layer: 'dxvk',
    arch,
    source: `official ${DXVK.version}`,
    files: deployed,
    backups: backedUp,
  }));
  return { deployed, backedUp, refused, ok: true };
}

// ---------------------------------------------------------------------------------------------
// The player's choice of layer, before there is anything to swap
//
// The swap was reachable only from Game Help, and only once a layer was in -- so a player who
// already knew a game wanted DXVK (Assassin's Creed II: dgVoodoo2 cannot draw it, 2026-09-18) had
// to install dgVoodoo2 first just to swap it out. Choosing DXVK on a game with nothing installed
// records the choice here instead, and Install places DXVK where it would have placed dgVoodoo2.
// Remove deletes it with the other markers.
const PREFERENCE = '.dlss5ui-wrapper-choice.json';

function readPreference(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, PREFERENCE), 'utf8'));
    return p && LAYERS[p.layer] ? p.layer : null;
  } catch {
    return null;
  }
}

function writePreference(dir, layer) {
  const file = path.join(dir, PREFERENCE);
  if (!layer) { fs.rmSync(file, { force: true }); return null; }
  if (!LAYERS[layer]) throw new Error(`unknown translation layer: ${layer}`);
  fs.writeFileSync(file, JSON.stringify({ layer, chosenAt: new Date().toISOString() }, null, 2), 'utf8');
  return layer;
}

module.exports = {
  MANIFEST,
  PREFERENCE,
  readPreference,
  writePreference,
  stripDgVoodooFromLegacyMarker,
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
  DXVK,
  DXVK_FILES_FOR_API,
  ensureDxvk,
  unpackDxvk,
  deployDxvk,
  cachedDxvk,
};
