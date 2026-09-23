// A curated list of ReShade add-ons and shader packs the app can put in a game folder, chosen per
// game.
//
// WHY THIS EXISTS. Every route this app installs already puts ReShade in the game folder -- the
// Feeder route needs it to run DLSS5_Feed.fx, the Chicken route needs it for
// deep-fried-chicken.addon64, and the Luma route deploys its own. So the expensive, fiddly part of
// installing a ReShade add-on is already done and paid for by the time anyone opens the card. What
// is missing is the list of things worth putting next to it, and the ordering that makes them work
// together.
//
// WHAT IT IS NOT. It is not a mod browser and it is not a mirror. Every entry is fetched from its
// author's own release, hash-checked (integrity.js: a pinned sha256 for a fixed URL, GitHub's own
// published digest for a release asset), and recorded so Remove takes back exactly what was
// placed. An entry whose licence does not permit this app to fetch it is listed as bring-your-own
// and never downloaded -- the same line dfc.js takes for Deep Fried Chicken and MV_PROVIDERS takes
// for iMMERSE and LumeniteFX. Being useful is not a reason to ignore a licence.
//
// THE TWO SHAPES.
//
//   kind: 'addon'    A compiled ReShade add-on (.addon64 / .addon32). It is a DLL beside the exe;
//                    ReShade loads it, and it has NO technique, so it never appears in
//                    ReShadePreset.ini's lists. Ordering does not apply to it.
//   kind: 'shaders'  A pack of .fx / .fxh files that goes in reshade-shaders\Shaders. These DO
//                    declare techniques, so each one carries the band it belongs in
//                    (preset-order.js) and installing it re-sorts the preset.
//
// Confusing the two is the mistake worth naming: "install the motion-vector shader before the HDR
// shader" is a statement about techniques, and RenoDX -- the thing most people mean by an HDR mod
// -- has no technique at all. It runs inside ReShade's add-on system, ahead of the whole effect
// chain, whatever the preset says.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { BAND } = require('./preset-order');
const integrity = require('./integrity');

const ADDONS_MARKER = '.dlss5ui-addons.json';

// RenoDX publishes every per-game add-on as an asset on one GitHub release, alongside
// games-index.json -- an index it generates from the same metadata it builds from. That index is
// what makes an auto-install honest rather than a guess: it carries the Steam appid, the title,
// the aliases and the exact artifact filename for each game, so matching a library entry to an
// add-on is a lookup rather than a string heuristic.
//
// Pinned to a tag, not to "latest". 'snapshot' is the project's own rolling build and is what its
// wiki points people at, so the pin is a tag whose CONTENT moves -- which is why every asset is
// still digest-checked at download rather than trusted for being on the right release.
const RENODX_REPO = 'clshortfuse/renodx';
const RENODX_TAG = 'snapshot';
const RENODX_INDEX_ASSET = 'games-index.json';

const CATALOGUE = [
  {
    id: 'renodx',
    displayName: 'RenoDX (per-game HDR)',
    kind: 'addon',
    perGame: true,
    licence: 'MIT -- Copyright (c) 2025 Carlos Lopez Jr.',
    homepage: 'https://github.com/clshortfuse/renodx',
    summary: 'A bespoke HDR and tone-mapping mod for this specific game, written against its own '
      + 'shaders. Where one exists it is the best-looking option there is; there is no generic '
      + 'version of it.',
    // Offered alongside DLSS 5 rather than instead of it, and the picker says once that the pair
    // is untested here. Both touch the final picture -- RenoDX rewrites the game's tone mapping,
    // the neural pass denoises what the game drew -- and nobody on this side has a GPU to watch
    // them run together. Blocking the combination would take away the thing most people want; not
    // saying anything would leave the first person whose colours go strange with no idea why.
    warnWithNeuralRendering: true,
    release: { repo: RENODX_REPO, tag: RENODX_TAG },
  },
  {
    id: 'renofx',
    displayName: 'RenoFX HDR toolkit',
    kind: 'shaders',
    licence: 'MIT -- Copyright (c) 2026 Carlos Lopez',
    homepage: 'https://github.com/clshortfuse/renofx',
    summary: 'The RenoDX shaders ported to ordinary ReShade effects. Not tailored to any one '
      + 'game, so it is what to reach for when this game has no RenoDX mod of its own.',
    band: BAND.INVERSE_TONEMAP,
    source: { kind: 'raw-files', baseKey: 'renofxRaw', shaKey: 'RENOFX_SHA256' },
  },
  {
    id: 'lilium-hdr',
    displayName: 'Lilium HDR shaders',
    kind: 'shaders',
    // GPL-3.0, not MIT. Worth stating exactly rather than as "open source": the AutoHDR add-on
    // below IS MIT and the two are by the same author, so the pair is easy to get wrong.
    // Redistribution is permitted either way, and in any case this app fetches from the author's
    // own repository on the user's machine rather than hosting a copy.
    licence: 'GPL-3.0 -- EndlesslyFlowering',
    homepage: 'https://github.com/EndlesslyFlowering/ReShade_HDR_shaders',
    summary: 'HDR analysis and inverse tone mapping. The pack the HDR guides treat as the '
      + 'baseline: the inverse tonemapper is what expands an SDR picture into HDR, and the '
      + 'analysis shaders are how you check the result rather than guess at it.',
    band: BAND.INVERSE_TONEMAP,
    source: { kind: 'raw-files', baseKey: 'liliumHdrRaw', shaKey: 'LILIUM_HDR_SHA256' },
  },
  {
    id: 'lilium-autohdr',
    displayName: 'Lilium AutoHDR add-on',
    kind: 'addon',
    licence: 'MIT -- EndlesslyFlowering',
    homepage: 'https://github.com/EndlesslyFlowering/AutoHDR-ReShade',
    summary: 'Switches the swap chain to an HDR one so an SDR game can output HDR at all. It does '
      + 'no tone mapping itself -- it needs an inverse tonemapper, which is what the Lilium '
      + 'shaders above are for.',
    // Not an ordering rule (an add-on has no technique) but a real dependency, and the one people
    // get wrong: AutoHDR on its own gives a washed-out picture, which reads as "HDR is broken"
    // rather than "nothing is expanding the range".
    wants: ['lilium-hdr'],
    source: { kind: 'github-release', repo: 'EndlesslyFlowering/AutoHDR-ReShade', assetPattern: /\.addon(64|32)$/i },
  },
];

const byId = new Map(CATALOGUE.map((a) => [a.id, a]));

function catalogue() {
  return CATALOGUE.map((a) => ({ ...a }));
}

function addonById(id) {
  const hit = byId.get(id);
  return hit ? { ...hit } : null;
}

// ---- matching a game to a RenoDX add-on ------------------------------------------------------

// Normalise a title for the fallback match: lower case, and everything that is not a letter or a
// digit dropped. "Assassin's Creed: Odyssey", "Assassins Creed Odyssey" and
// "AssassinsCreedOdyssey" all collapse to the same key, which is the point -- a library name comes
// from a folder, a store, or whatever the user typed, and none of those agree on punctuation.
function titleKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Build the lookup tables from RenoDX's games-index.json. Two indexes, deliberately separate:
//
//   byAppid   The Steam appid. This is the reliable one -- it is an identifier both sides got
//             from Steam rather than a name either side invented -- and library.js already
//             resolves it for any game under a Steam library (steamManifestFor).
//   byTitle   The normalised title and every alias the index lists. The fallback for Game Pass,
//             Epic, GOG and a loose folder, where there is no appid to match on. A name match is
//             a weaker claim than an appid match and is reported as such, so the picker can say
//             which kind it made rather than presenting both as the same fact.
function indexRenodx(index) {
  const byAppid = new Map();
  const byTitle = new Map();
  for (const game of (index && index.games) || []) {
    const mods = (game.mods || []).filter((m) => (m.artifacts || []).length);
    if (!mods.length) continue;
    const entry = { id: game.id, title: game.title, mods };
    const appid = game.steam_appid ?? (game.deploy && game.deploy.steam_appid);
    if (appid !== undefined && appid !== null) byAppid.set(String(appid), entry);
    for (const name of [game.title, ...(game.aliases || [])]) {
      const key = titleKey(name);
      if (key && !byTitle.has(key)) byTitle.set(key, entry);
    }
  }
  return { byAppid, byTitle };
}

// Which artifact to install, for a game's bitness. RenoDX builds .addon64 and .addon32 from the
// same source and a game takes the one matching ITS OWN bitness, not the machine's -- the same
// rule Chicken's README states for its two trees, and the same way round people get wrong.
// Unknown bitness falls back to 64, which is what all but a handful of these games are.
function pickArtifact(mod, bitness) {
  const want = bitness === 32 ? 'x86' : 'x64';
  const artifacts = mod.artifacts || [];
  return artifacts.find((a) => a.arch === want)
    || (bitness === 32 ? null : artifacts.find((a) => a.arch === 'x64'))
    || null;
}

// The RenoDX add-on for a game, or null. `how` says what the match rested on so the caller can be
// honest about it: 'steam-appid' is an identifier match, 'title' is a name match that could be
// the wrong game with a similar name.
function matchRenodx(index, { steamAppid = null, title = null, bitness = null } = {}) {
  const { byAppid, byTitle } = indexRenodx(index);
  let entry = null;
  let how = null;
  if (steamAppid !== null && steamAppid !== undefined && byAppid.has(String(steamAppid))) {
    entry = byAppid.get(String(steamAppid));
    how = 'steam-appid';
  } else if (title) {
    const hit = byTitle.get(titleKey(title));
    if (hit) {
      entry = hit;
      how = 'title';
    }
  }
  if (!entry) return null;

  // Several mods can target one game (a bespoke one and a generic fallback, or an Archive
  // variant). Prefer the one whose status is furthest along rather than the first in the file:
  // the index lists them in build order, which says nothing about which to install.
  const rank = (m) => (m.status === 'stable' ? 0 : m.status === 'beta' ? 1 : 2);
  const mod = [...entry.mods].sort((a, b) => rank(a) - rank(b))[0];
  const artifact = pickArtifact(mod, bitness);
  if (!artifact) return null;
  return {
    gameId: entry.id,
    gameTitle: entry.title,
    modId: mod.id,
    title: mod.title || entry.title,
    status: mod.status || 'unknown',
    compatibility: mod.compatibility || 'unknown',
    summary: mod.summary || '',
    maintainers: mod.maintainers || [],
    notes: mod.notes || [],
    artifact: artifact.name,
    arch: artifact.arch,
    size: artifact.size || null,
    how,
  };
}

// The download URL for one of the pinned release's assets. Built from the tag rather than read
// from the index: the index's own `url` fields are relative ("./renodx-x.addon64"), which is
// right for its web page and useless here.
function releaseAssetUrl(name, { repo = RENODX_REPO, tag = RENODX_TAG } = {}) {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

function renodxIndexUrl() {
  return releaseAssetUrl(RENODX_INDEX_ASSET);
}

// ---- what is installed here ------------------------------------------------------------------

// The marker is the record of what this app placed, and it is what Remove reads. Same shape and
// same reasoning as the Feeder's: a folder scan cannot tell our copy of a file from the user's,
// and this app does not delete what it did not place.
function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ADDONS_MARKER), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(dir, data) {
  fs.writeFileSync(path.join(dir, ADDONS_MARKER), JSON.stringify(data, null, 2), 'utf8');
}

// Everything this app placed here, as a flat list of paths relative to the game folder. Used by
// Remove, and by the "is this ours?" question every foreign-toolchain check has to ask.
function filesPlaced(dir) {
  const marker = readMarker(dir);
  const out = [];
  for (const entry of (marker && marker.installed) || []) {
    for (const f of entry.files || []) out.push(f);
  }
  return out;
}

// Which catalogue entries are installed here, newest record wins.
function installedIds(dir) {
  const marker = readMarker(dir);
  return ((marker && marker.installed) || []).map((e) => e.id);
}

// The technique names an effect file declares. Read from the shader itself at install time rather
// than kept in a table here, because a table would be a second copy of something the file already
// states -- and the packs this list carries are large, versioned upstream, and free to rename a
// technique between releases. A wrong name in a table fails the way this whole file is trying to
// avoid: the preset lists a technique that does not exist, ReShade ignores it, and the ordering
// silently does nothing.
//
// ReShade's grammar allows an annotation block and a newline before the body, so the name is
// followed by `<`, `{`, or whitespace. Comments are stripped first: a commented-out technique is
// not a technique, and the packs are full of them.
function techniquesIn(source) {
  const text = String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const out = [];
  const re = /\btechnique\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Every technique this app's add-ons put here, with the band it belongs in -- what feeder.js's
// presetRanks() needs to sort the preset. Taken from the marker, so a pack the user installed
// themselves is not claimed and not reordered.
function installedTechniqueBands(dir) {
  const marker = readMarker(dir);
  const out = [];
  for (const entry of (marker && marker.installed) || []) {
    const spec = byId.get(entry.id);
    if (!spec || spec.kind !== 'shaders') continue;
    const band = entry.band === undefined ? spec.band : entry.band;
    if (band === undefined || band === null) continue;
    for (const technique of entry.techniques || []) out.push({ technique, band });
  }
  return out;
}

// ---- installing ------------------------------------------------------------------------------

// The files a raw-files pack is made of, taken from its hash table in integrity.js rather than
// listed again here. The pins ARE the manifest: a file with no pin cannot be installed (nothing
// to check it against), and a file in a list but not in the pins would be exactly that. Keeping
// one list means the two can never disagree.
function packFiles(spec) {
  const table = integrity[spec.source.shaKey];
  if (!table) throw new Error(`No hash table ${spec.source.shaKey} for ${spec.id}`);
  return Object.keys(table);
}

// A pack's repo-relative path to its place in the game folder. Both packs keep Shaders/ and
// Textures/ at their root, which is the layout reshade-shaders/ wants, so this is a straight
// reparent -- but it is written out rather than assumed, so a pack that does not match is
// refused instead of scattering files into the game folder.
function destForPackFile(rel) {
  const parts = rel.split('/');
  if (parts[0] !== 'Shaders' && parts[0] !== 'Textures') return null;
  return path.join('reshade-shaders', ...parts);
}

// Install one catalogue entry. `ctx` carries the app's own plumbing rather than this module
// reaching for it: `fetchBuffer(url)` returns the bytes with the integrity check already applied,
// `resolveRelease(repo, tag)` returns the release JSON. Both are injected so the tests can run
// the whole of this without a network, which is the only way the ordering and the marker get
// exercised at all.
async function installAddon(dir, id, ctx, opts = {}) {
  const spec = byId.get(id);
  if (!spec) throw new Error(`Unknown add-on: ${id}`);
  const written = [];

  if (spec.kind === 'shaders') {
    const files = packFiles(spec);
    const base = integrity.URLS[spec.source.baseKey];
    if (!base) throw new Error(`No pinned base URL ${spec.source.baseKey} for ${id}`);
    const techniques = [];
    for (const rel of files) {
      const relDest = destForPackFile(rel);
      if (!relDest) throw new Error(`${id}: ${rel} is not under Shaders/ or Textures/`);
      const buf = await ctx.fetchBuffer(base + rel);
      const dest = path.join(dir, relDest);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
      written.push(relDest.split(path.sep).join('/'));
      // Only the .fx files declare techniques; an .fxh is an include and a .png is a texture.
      if (/\.fx$/i.test(rel)) {
        for (const name of techniquesIn(buf.toString('utf8'))) {
          techniques.push(`${name}@${path.basename(rel)}`);
        }
      }
    }
    recordInstall(dir, { id, kind: spec.kind, band: spec.band, files: written, techniques });
    return { id, files: written, techniques };
  }

  if (spec.kind === 'addon') {
    const { url, name } = await resolveAddonAsset(spec, ctx, opts);
    const buf = await ctx.fetchBuffer(url);
    const dest = path.join(dir, name);
    await fsp.writeFile(dest, buf);
    written.push(name);
    recordInstall(dir, {
      id, kind: spec.kind, files: written,
      renodxMod: opts.match ? opts.match.modId : undefined,
      renodxTitle: opts.match ? opts.match.title : undefined,
    });
    return { id, files: written, techniques: [] };
  }

  throw new Error(`${id}: unknown kind ${spec.kind}`);
}

// Which file to fetch for an 'addon' entry. RenoDX's comes from the per-game match the caller
// already made (it needed it to show the row at all); anything else picks the first asset on the
// newest release that looks like an add-on for this bitness.
async function resolveAddonAsset(spec, ctx, opts) {
  if (spec.id === 'renodx') {
    if (!opts.match) throw new Error('renodx: no per-game match was passed');
    return { url: releaseAssetUrl(opts.match.artifact, spec.release), name: opts.match.artifact };
  }
  const release = await ctx.resolveRelease(spec.source.repo, spec.source.tag || null);
  const want = opts.bitness === 32 ? /\.addon32$/i : /\.addon64$/i;
  const assets = (release && release.assets) || [];
  const asset = assets.find((a) => want.test(a.name)) || assets.find((a) => spec.source.assetPattern.test(a.name));
  if (!asset) throw new Error(`${spec.id}: no add-on asset on release ${release && release.tag_name}`);
  return { url: asset.browser_download_url, name: asset.name };
}

function recordInstall(dir, entry) {
  const marker = readMarker(dir) || { version: 1, installed: [] };
  marker.installed = (marker.installed || []).filter((e) => e.id !== entry.id);
  marker.installed.push({ ...entry, installedAt: new Date().toISOString() });
  writeMarker(dir, marker);
}

// Take one back out. Only the files the marker says this app wrote: a pack the user also had, or
// a file they edited in place, is still theirs, and this app does not delete what it did not put
// there. Empty folders left behind are left behind -- reshade-shaders\ is shared with the Feeder.
async function removeAddon(dir, id) {
  const marker = readMarker(dir);
  const entry = ((marker && marker.installed) || []).find((e) => e.id === id);
  if (!entry) return { removed: [], kept: [] };
  const removed = [];
  for (const rel of entry.files || []) {
    const p = path.join(dir, ...rel.split('/'));
    try {
      await fsp.rm(p, { force: true });
      removed.push(rel);
    } catch {
      // A file already gone, or locked by a running game: the marker entry still goes, so the
      // app stops claiming it.
    }
  }
  marker.installed = marker.installed.filter((e) => e.id !== id);
  if (marker.installed.length) writeMarker(dir, marker);
  else await fsp.rm(path.join(dir, ADDONS_MARKER), { force: true });
  return { removed, kept: [] };
}

module.exports = {
  ADDONS_MARKER,
  RENODX_REPO, RENODX_TAG, RENODX_INDEX_ASSET,
  catalogue, addonById,
  titleKey, indexRenodx, pickArtifact, matchRenodx,
  releaseAssetUrl, renodxIndexUrl,
  readMarker, writeMarker, filesPlaced, installedIds,
  techniquesIn, installedTechniqueBands,
  packFiles, destForPackFile, installAddon, removeAddon,
};
