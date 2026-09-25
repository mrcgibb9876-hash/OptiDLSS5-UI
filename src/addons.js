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
const { HOOK_DLLS } = require('./detect');

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
      + 'shaders. Where one exists it is the best-looking option there is. Where one does not, '
      + 'RenoDX may still have a mod for the whole engine -- an Unreal game usually does -- and '
      + 'this row offers that instead, saying so.',
    // Offered alongside DLSS 5 rather than instead of it, and the picker says once that the pair
    // is untested here. Both touch the final picture -- RenoDX rewrites the game's tone mapping,
    // the neural pass denoises what the game drew -- and nobody on this side has a GPU to watch
    // them run together. Blocking the combination would take away the thing most people want; not
    // saying anything would leave the first person whose colours go strange with no idea why.
    warnWithNeuralRendering: true,
    release: { repo: RENODX_REPO, tag: RENODX_TAG },
    // See EXCLUSIVE_GROUPS below: RenoDX and AutoHDR are two answers to the same question and
    // only one can be installed at a time -- but choosing the other one swaps them rather than
    // greying anything out.
    exclusiveGroup: 'hdr-source',
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
    // The pack's own final tone mapping goes LAST, not with the rest of it. Its job is to clamp
    // the finished frame to what the display can actually show, so anything running after it
    // would push the picture back past that ceiling -- which is exactly the overblown-highlights
    // failure it exists to prevent. The HDR guides put it at the bottom of the chain for this
    // reason, and that is true whether the HDR came from AutoHDR or from a native-HDR mod.
    bandFor: (file) => (/tone_mapping\.fx$/i.test(file) && !/inverse/i.test(file)
      ? BAND.HDR_OUTPUT
      : BAND.INVERSE_TONEMAP),
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
    exclusiveGroup: 'hdr-source',
  },
];

// Two add-ons that cannot both be installed, and why it is these two and not "RenoDX vs Lilium".
//
// They are two answers to the SAME question -- where does the HDR signal come from -- and both
// answer it by upgrading the swap chain:
//
//   RenoDX   replaces the game's own tone mapping and works on the scene data BEFORE the game
//            tonemapped it. The game outputs HDR natively; nothing is being converted.
//   AutoHDR  makes the swap chain HDR so an SDR game can output HDR at all, and then an inverse
//            tonemapper expands the finished SDR image into that range.
//
// Running both means two things upgrading one swap chain and an inverse tonemapper expanding a
// picture that is already HDR. That is a conflict of substance, not of file names.
//
// What is NOT in this group, deliberately: the Lilium HDR SHADER PACK. It is the thing people
// assume conflicts with RenoDX and it does not -- the HDR guides put its final tone mapping at
// the very bottom of the chain precisely so a native-HDR game does not blow past the display's
// peak brightness, and its analysis shaders are how anyone checks a RenoDX result rather than
// guessing at it. Only the pack's own inverse tonemapper is redundant next to RenoDX, and
// whether that technique is switched on is a choice inside ReShade, not something installing
// the pack decides.
const EXCLUSIVE_GROUPS = { 'hdr-source': ['renodx', 'lilium-autohdr'] };

// What installing `id` here would have to remove first: the other members of its group that are
// installed. Empty for everything else.
//
// A swap, never a lock. The button for the other one stays live and pressing it moves the
// install across -- being told "you cannot have this" by an app that could simply do the swap
// is the kind of thing that makes people go and do it by hand, badly.
function conflictsFor(dir, id) {
  const spec = byId.get(id);
  if (!spec || !spec.exclusiveGroup) return [];
  const group = EXCLUSIVE_GROUPS[spec.exclusiveGroup] || [];
  const here = new Set(installedIds(dir));
  return group.filter((other) => other !== id && here.has(other));
}

const byId = new Map(CATALOGUE.map((a) => [a.id, a]));

// ---- is there a ReShade here at all? ----------------------------------------------------------
//
// The header above says every route this app installs puts ReShade in the game folder, and that is
// true. The add-ons card is not a route: its button sits on every game card, including a game this
// app has never installed anything into. Before this check, Install there placed a .addon64 beside
// an exe with no ReShade to load it -- nothing failed, nothing loaded, and the row then read
// "Remove" as though it had worked.
//
// Found by CONTENT, wherever it sits, and deliberately NOT through relimiter.reshadeFileIn(): that
// recognises a proxy ReShade only when our own marker recorded it, so someone who installed ReShade
// himself as dxgi.dll -- which is most of the people who want RenoDX -- would read as having none
// and be refused the one thing he came for.
//
// HOOK_DLLS is the single proxy-name list (see the proxy note in CLAUDE.md; do not start a second
// one), plus the two names a non-proxying ReShade uses. isReShadeProxy is the strict check: it reads
// the PE OriginalFilename, so OptiScaler sitting in the dxgi.dll slot does not pass for ReShade
// merely because OptiScaler.dll carries the string.
const RESHADE_NAMES = [...new Set([...HOOK_DLLS, 'ReShade64.dll', 'ReShade32.dll'])];

function reshadeIn(dir) {
  // Required late: feeder reaches back into this module (installedTechniqueBands), so a top-level
  // require here would close the loop.
  const { isReShadeProxy } = require('./relimiter');
  const { isAddonReShadeDll } = require('./feeder');

  const found = [];
  for (const name of RESHADE_NAMES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || !isReShadeProxy(file)) continue;
    found.push({ file: name, addonBuild: isAddonReShadeDll(file) });
  }
  if (!found.length) return null;
  // An Add-on build anywhere in the folder wins. It is the build that decides whether an add-on can
  // load at all, and a plain ReShade64.dll lying beside it does not take that away.
  return found.find((f) => f.addonBuild) || found[0];
}

// What stops this entry being installed here, or null. Two tiers, because the two shapes need
// different things (see THE TWO SHAPES above):
//
//   'no-reshade'     Nothing to load either shape. Both are refused.
//   'plain-reshade'  ReShade is here but it is the plain build, which carries the same version and
//                    product name as the Add-on build and simply never loads an add-on (feeder.js's
//                    issue-#53 note). Shader packs are fine -- they are effects, not add-ons -- so
//                    only kind: 'addon' is refused.
//
// `rs` lets a caller that has already looked (the IPC handler builds the whole picker from one scan)
// hand the answer in rather than making every row walk the folder again.
function installBlocker(dir, id, rs) {
  const spec = byId.get(id);
  if (!spec) return null;
  const found = rs !== undefined ? rs : reshadeIn(dir);
  if (!found) return 'no-reshade';
  if (spec.kind === 'addon' && !found.addonBuild) return 'plain-reshade';
  return null;
}

// The list as the renderer sees it, so data only. An entry can carry a function (Lilium's bandFor),
// and one function anywhere in an IPC reply makes Electron refuse the whole thing -- "An object
// could not be cloned" -- which left the picker stuck on "Looking at this game…" for every game.
// The install path reads functions through addonById, which keeps them.
function catalogue() {
  return CATALOGUE.map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v !== 'function')));
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

// Upstream's engine-wide mods, keyed by our own detect.engineId.
//
// RenoDX is per-game by nature -- 271 add-ons, each compiled against one game's shader hashes --
// and there is no universal build: src/games/generic exists in its source with an empty
// custom_shaders list and publishes no artifact at all. But the project has started shipping
// ENGINE-wide mods (support: 'generic', category: 'engine'), and it is moving towards them: eight
// per-game entries now carry a note reading "Superseded by Generic <engine> mod".
//
// The catch is how the index carries them. They are ordinary mods attached to games, so
// renodx-unrealengine.addon64 is listed against exactly ONE game (Ace Combat 7) even though it is
// the same binary for every Unreal title. An index lookup therefore finds it for almost nobody.
// Matching on the engine instead is what takes RenoDX from "the 239 games in the index" to "any
// Unreal game", which is most of a modern library.
//
// Unity is in the map because the index marks unityengine generic too -- but it has no artifact
// today, and engineGenericMod refuses a mod it cannot actually download, so Unity games simply keep
// saying "no mod for this game" until upstream publishes one. Nothing to change here when it does.
const ENGINE_GENERIC_MODS = { unreal: 'unrealengine', unity: 'unityengine' };

// The engine-wide mod for this engine, found wherever the index happens to hang it, or null.
// Requires an artifact for the bitness asked for: offering a download that does not exist is worse
// than offering nothing, and unityengine is exactly that case today.
function engineGenericMod(index, engineId, bitness) {
  const wanted = ENGINE_GENERIC_MODS[engineId];
  if (!wanted) return null;
  for (const game of (index && index.games) || []) {
    for (const mod of game.mods || []) {
      if (mod.id !== wanted || mod.support !== 'generic') continue;
      if (!pickArtifact(mod, bitness)) continue;
      return mod;
    }
  }
  return null;
}

function describeMatch(mod, { gameId, gameTitle, bitness, how }) {
  const artifact = pickArtifact(mod, bitness);
  if (!artifact) return null;
  return {
    gameId,
    gameTitle,
    modId: mod.id,
    title: mod.title || gameTitle,
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

// The RenoDX add-on for a game, or null. `how` says what the match rested on so the caller can be
// honest about it: 'steam-appid' is an identifier match, 'title' is a name match that could be
// the wrong game with a similar name.
function matchRenodx(index, { steamAppid = null, title = null, bitness = null, engineId = null } = {}) {
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

  // No bespoke mod for this game. Its engine may still have one, and for an Unreal game it usually
  // does -- 'engine' is a weaker claim than an appid and the caller is told so through `how`.
  const generic = engineGenericMod(index, engineId, bitness);
  if (!entry) {
    return generic
      ? describeMatch(generic, { gameId: null, gameTitle: title || null, bitness, how: 'engine' })
      : null;
  }

  // Several mods can target one game (a bespoke one and a generic fallback, or an Archive
  // variant). Prefer the one whose status is furthest along rather than the first in the file:
  // the index lists them in build order, which says nothing about which to install.
  const rank = (m) => (m.status === 'stable' ? 0 : m.status === 'beta' ? 1 : 2);
  const mod = [...entry.mods].sort((a, b) => rank(a) - rank(b))[0];

  // Upstream's own verdict, not ours: eight entries say "Superseded by Generic <engine> mod", so
  // installing the bespoke one there would knowingly place the worse of the two. Taken only when
  // the replacement is really downloadable -- five of those eight point at unityengine, which has
  // no artifact, and dropping a working per-game mod for a file that does not exist would be a
  // regression dressed up as an upgrade.
  if (generic && (mod.notes || []).some((n) => /supersed/i.test(n))) {
    const swap = describeMatch(generic, { gameId: entry.id, gameTitle: entry.title, bitness, how: 'engine-supersedes' });
    if (swap) return swap;
  }

  return describeMatch(mod, { gameId: entry.id, gameTitle: entry.title, bitness, how });
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
    // entry.bands holds the techniques that do NOT take the pack's default band (Lilium's final
    // tone mapping, which belongs last rather than with the inverse tonemappers it ships beside).
    for (const technique of entry.techniques || []) {
      const own = (entry.bands || {})[technique];
      out.push({ technique, band: own === undefined ? band : own });
    }
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

  // Checked here and not only in the picker. A disabled button is a courtesy, not a gate: this is
  // also reached from the IPC handler directly, and placing a file that can never load is the
  // failure this whole check exists to stop -- before the swap below takes anything out.
  const blocker = installBlocker(dir, id, opts.reshade);
  if (blocker === 'no-reshade') {
    throw Object.assign(new Error('This game folder has no ReShade, so there is nothing to load this -- install DLSS 5 or frame pacing here first, or put your own ReShade in'), { code: blocker });
  }
  if (blocker === 'plain-reshade') {
    throw Object.assign(new Error('The ReShade in this folder is the plain build, which never loads an add-on -- the Add-on build is the one that can'), { code: blocker });
  }

  const written = [];

  // Swap rather than refuse. Done before anything is fetched so a failed download cannot leave
  // the game with neither -- and reported back, so the UI can say what moved instead of the
  // other row silently flipping to "Install".
  const swappedOut = [];
  for (const other of conflictsFor(dir, id)) {
    await removeAddon(dir, other);
    swappedOut.push(other);
  }

  if (spec.kind === 'shaders') {
    const files = packFiles(spec);
    const base = integrity.URLS[spec.source.baseKey];
    if (!base) throw new Error(`No pinned base URL ${spec.source.baseKey} for ${id}`);
    const techniques = [];
    // Per technique, not per pack. Lilium's pack carries both an inverse tonemapper (which
    // expands SDR into HDR, so it belongs before the effects that assume HDR) and a final tone
    // mapping shader (which clamps to the display's peak brightness, so it belongs last, after
    // everything). One band for the whole pack would put one of them in the wrong place.
    const bands = {};
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
        const file = path.basename(rel);
        for (const name of techniquesIn(buf.toString('utf8'))) {
          const key = `${name}@${file}`;
          techniques.push(key);
          const band = spec.bandFor ? spec.bandFor(file) : spec.band;
          if (band !== spec.band) bands[key] = band;
        }
      }
    }
    recordInstall(dir, { id, kind: spec.kind, band: spec.band, bands, files: written, techniques });
    return { id, files: written, techniques, swappedOut };
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
    return { id, files: written, techniques: [], swappedOut };
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
  ENGINE_GENERIC_MODS, engineGenericMod,
  releaseAssetUrl, renodxIndexUrl,
  readMarker, writeMarker, filesPlaced, installedIds,
  techniquesIn, installedTechniqueBands,
  packFiles, destForPackFile, installAddon, removeAddon,
  RESHADE_NAMES, reshadeIn, installBlocker,
  EXCLUSIVE_GROUPS, conflictsFor,
};
