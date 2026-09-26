// RenoDX UE-Extended (marat569/renodx src/games/ue-extended, ported into our RenoDX fork): the
// RenoDX add-on for Unreal games that have no mod of their own. It replaces the generic
// renodx-unrealengine.addon64 for them -- proven on The Blood of Dawnwalker with the game's own DLSS
// Frame Generation and ReLimiter (2026-09-25), where the generic mod loaded and changed nothing.
//
// WHICH GAMES IT IS TUNED FOR. The add-on carries a GameSettings table (addon.cpp, GAME_SETTINGS)
// keyed by the running exe's FILE NAME first, then by the exe's PRODUCT NAME (its version resource),
// both matched exactly (a std::unordered_map<std::string, ...>). A game in the table gets defaults
// someone chose for it; one that is not still works, untuned. The card says which (renderer.js
// renodxTag: blue "RenoDX UE+" for tuned, silver for the rest).
//
// Entries whose defaults set Set_Path to 0 are the NATIVE-HDR path: the add-on fixes the game's own
// HDR output instead of upgrading an SDR swap chain, so Unreal's HDR has to be switched on in the
// game's Engine.ini -- which the add-on does not do. ueini.js does it (see there).
//
// THE TABLE IS CACHED, NOT READ AT RUN TIME. The release UE-Extended installs from ships its own
// ue-extended-games.json (loadReleaseTable below); main.js fetches that once per session in the
// background and caches it beside the add-on. Until then, and whenever it cannot be had, the copy
// shipped with the app is used -- generated from the fork's addon.cpp by tools/gen-ue-extended-table.js
// (the file records the ref and commit it was made from). Either way the card tag (asked on every grid
// render through game:status) is a Map lookup: no network, no folder scan, no exe read.
//
// WHERE THE ADD-ON COMES FROM. The fork's `snapshot` release once it carries
// renodx-ue-extended.addon64 (main.js checks the release's asset list, memoised). Until UE-Extended
// is promoted there it is only on the `test-ue-extended` pre-release, and a DEV-ONLY override takes
// it from there -- never offered in the UI:
//   * environment variable  OPTIDLSS5_UE_EXTENDED_TEST=1   or
//   * settings.json (userData) "renodxUeExtendedTest": true
// Without either, and with no asset on `snapshot`, Unreal games keep getting the generic mod exactly
// as before.
'use strict';

const path = require('node:path');

const UE_EXTENDED_ARTIFACT = 'renodx-ue-extended.addon64';
const UE_EXTENDED_MOD_ID = 'ue-extended';
const UE_EXTENDED_TITLE = 'RenoDX UE-Extended';
const UE_EXTENDED_FORK = 'mrcgibb9876-hash/renodx';
const UE_EXTENDED_RELEASE = { repo: UE_EXTENDED_FORK, tag: 'snapshot', hostApi: true };
const UE_EXTENDED_TEST_RELEASE = { repo: UE_EXTENDED_FORK, tag: 'test-ue-extended', hostApi: true, test: true };

// Parse GAME_SETTINGS out of addon.cpp: { key: { nativeHdr } }. Each top-level entry is
// `{ "Key", [// comment] GameSettings{ ... } }`; the entry runs to the next such opening. Set_Path's
// default lives in the entry's first brace list, and nothing else in an entry spells that key.
function parseGameSettings(cpp) {
  const text = String(cpp || '');
  const start = text.indexOf('GAME_SETTINGS');
  if (start < 0) throw new Error('addon.cpp has no GAME_SETTINGS table');
  const end = text.indexOf('\n};', start);
  const body = text.slice(start, end < 0 ? undefined : end);
  const re = /\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*(?:\/\/[^\n]*\n\s*)?GameSettings\s*\{/g;
  const starts = [];
  let m;
  while ((m = re.exec(body)) !== null) starts.push({ key: m[1].replace(/\\(.)/g, '$1'), at: m.index });
  const games = {};
  starts.forEach((s, i) => {
    const seg = body.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : undefined);
    games[s.key] = { nativeHdr: /\{\s*"Set_Path"\s*,\s*0(?:\.0*)?f?\s*\}/.test(seg) };
  });
  return games;
}

let bundled = null;
function bundledTable() {
  if (!bundled) {
    try {
      bundled = require('./ue-extended-games.json');
    } catch {
      bundled = { games: {} };
    }
  }
  return bundled;
}

// ── The release's own table ─────────────────────────────────────────────────────────────────────
//
// The fork's UE-Extended release ships ue-extended-games.json beside the add-on: the same shape as the
// bundled file (source, generated, count, games{key:{nativeHdr}}) plus, per game, matchBy / defaults /
// additionalSettings / customShaders, and source.commit / author / hostApiVersion. Taken from the SAME
// release the add-on installs from, so the blue tag and the Engine.ini HDR step describe the build that
// is actually going in, not the one the app was shipped beside. The bundled file stays the fallback:
// offline on first run, a release without the asset, or an asset that does not parse.
//
// Cached next to the add-on (main.js feeder-cache) with a small record of which asset it was. The
// release JSON comes through ghapi's cached GET, and the file itself is fetched again only when the
// asset's updated_at moves (a new upload) or the release is a different one; a re-upload whose
// source.commit is unchanged is recognised as the same table. Once per session, never per game.
const UE_EXTENDED_TABLE_ASSET = 'ue-extended-games.json';

// The release table as ueExtendedEntry reads it, or null when it is not one. Extras are kept; a game
// without nativeHdr gets it from its defaults (Set_Path 0 is the native-HDR path, as parseGameSettings
// reads it out of addon.cpp).
function normaliseTable(json) {
  if (!json || typeof json !== 'object' || !json.games || typeof json.games !== 'object' || Array.isArray(json.games)) return null;
  const games = {};
  for (const [key, g] of Object.entries(json.games)) {
    if (!key || !g || typeof g !== 'object') continue;
    const setPath = g.defaults && typeof g.defaults === 'object' ? g.defaults.Set_Path : undefined;
    games[key] = { ...g, nativeHdr: typeof g.nativeHdr === 'boolean' ? g.nativeHdr : setPath !== undefined && setPath !== null && Number(setPath) === 0 };
  }
  if (Object.keys(games).length === 0) return null;
  return { ...json, games };
}

// The table asset on a release (the GitHub release JSON), or null.
function tableAsset(release) {
  const a = ((release && release.assets) || []).find((x) => x && x.name === UE_EXTENDED_TABLE_ASSET);
  if (!a || !a.browser_download_url) return null;
  // GitHub's published digest ("sha256:<hex>"), so the download is checked without a second API call.
  const digest = typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : null;
  return { url: a.browser_download_url, updatedAt: a.updated_at || null, digest };
}

// Whether the cached copy (its record, `meta`) is still the asset on `source`'s release.
function tableIsCurrent(meta, asset, source) {
  if (!meta || !asset || !source) return false;
  return meta.repo === source.repo && meta.tag === source.tag && !!asset.updatedAt && meta.updatedAt === asset.updatedAt;
}

// The table to use for `source`, with everything that touches the network or disk injected:
//   resolveRelease(repo, tag) -> release JSON (ghapi-cached)
//   download(url, asset)      -> Buffer of the asset (asset.digest to check it against)
//   readCache()               -> { table, meta } | null     writeCache({ table, meta })
// Returns { table, meta, from: 'cache' | 'release' | 'bundled' }. Never throws: any failure falls back
// to the cached copy for this release, then the bundled file.
async function loadReleaseTable(source, { resolveRelease, download, readCache, writeCache }) {
  let cached = null;
  try { cached = readCache ? readCache() : null; } catch { cached = null; }
  const cachedTable = cached && normaliseTable(cached.table);
  const sameRelease = !!(cachedTable && source && cached.meta && cached.meta.repo === source.repo && cached.meta.tag === source.tag);
  const fallback = () => (sameRelease ? { table: cachedTable, meta: cached.meta, from: 'cache' } : { table: bundledTable(), meta: null, from: 'bundled' });
  if (!source) return { table: bundledTable(), meta: null, from: 'bundled' };
  try {
    const asset = tableAsset(await resolveRelease(source.repo, source.tag));
    if (!asset) return { table: bundledTable(), meta: null, from: 'bundled' };
    if (sameRelease && tableIsCurrent(cached.meta, asset, source)) return { table: cachedTable, meta: cached.meta, from: 'cache' };
    const table = normaliseTable(JSON.parse(Buffer.from(await download(asset.url, asset)).toString('utf8')));
    if (!table) return fallback();
    const commit = (table.source && table.source.commit) || null;
    const meta = { repo: source.repo, tag: source.tag, updatedAt: asset.updatedAt, digest: asset.digest, commit };
    // Re-uploaded with the same source commit: the same table, so only the record moves.
    const unchanged = sameRelease && commit && cached.meta.commit === commit;
    try { if (writeCache) writeCache({ table: unchanged ? cachedTable : table, meta }); } catch {}
    return { table: unchanged ? cachedTable : table, meta, from: unchanged ? 'cache' : 'release' };
  } catch {
    return fallback();
  }
}

// The table lookups read: the release's once main.js has loaded it, the bundled one until then.
let active = null;
function setActiveTable(table) { active = normaliseTable(table); }
function activeTable() { return active || bundledTable(); }

// The table entry for a game, or null: exe file name first, then product name -- the add-on's own
// order (FindGameSettings), exact and case-sensitive like its std::unordered_map.
function ueExtendedEntry({ exeName = null, productName = null } = {}, table = activeTable()) {
  const games = (table && table.games) || {};
  const own = (k) => Object.prototype.hasOwnProperty.call(games, k);
  const name = exeName ? path.basename(String(exeName)) : null;
  if (name && own(name)) return { key: name, nativeHdr: !!games[name].nativeHdr, how: 'exe' };
  if (productName && own(productName)) return { key: productName, nativeHdr: !!games[productName].nativeHdr, how: 'product' };
  return null;
}

// Whether the dev-only test override is on. `settings` is the app's settings.json object.
function testOverrideEnabled(settings = {}, env = process.env) {
  return env.OPTIDLSS5_UE_EXTENDED_TEST === '1' || !!(settings && settings.renodxUeExtendedTest);
}

// Which release UE-Extended installs from, or null when none has it. `snapshotAssets` is the list of
// asset names on the fork's snapshot release (null when it could not be read).
function ueExtendedSource({ snapshotAssets = null, testOverride = false } = {}) {
  if (Array.isArray(snapshotAssets) && snapshotAssets.includes(UE_EXTENDED_ARTIFACT)) return UE_EXTENDED_RELEASE;
  if (testOverride) return UE_EXTENDED_TEST_RELEASE;
  return null;
}

// Put UE-Extended in place of the generic Unreal mod. `picked` is addons.pickRenodxMatch's answer
// ({ match, source, fromUpstream } or null). A per-game mod always wins; UE-Extended takes over only
// an Unreal, 64-bit game whose best answer is an engine-wide match (or nothing), and only when a
// release carries it (`source`). `entry` is ueExtendedEntry's answer: tuned or not.
function applyUeExtended(picked, { engineId = null, bitness = null, source = null, entry = null, title = null } = {}) {
  if (!source || engineId !== 'unreal' || bitness === 32) return picked;
  if (picked && picked.match && !/^engine/.test(picked.match.how || '')) return picked;
  const replaced = picked && picked.match ? picked.match.artifact : null;
  return {
    match: {
      gameId: null,
      gameTitle: title || (picked && picked.match && picked.match.gameTitle) || null,
      modId: UE_EXTENDED_MOD_ID,
      title: UE_EXTENDED_TITLE,
      status: 'beta',
      compatibility: entry ? 'tuned' : 'untuned',
      summary: '',
      maintainers: ['marat569'],
      notes: [],
      artifact: UE_EXTENDED_ARTIFACT,
      arch: 'x64',
      size: null,
      // 'ue-extended' when the add-on has settings for this game; 'engine-ue-extended' when it only
      // matches the engine -- the /^engine/ test everywhere else then still reads it as engine-wide.
      how: entry ? 'ue-extended' : 'engine-ue-extended',
      ueExtended: entry ? { key: entry.key, nativeHdr: !!entry.nativeHdr, how: entry.how } : { key: null, nativeHdr: false, how: null },
      replaces: replaced,
    },
    source,
    fromUpstream: false,
  };
}

// The card tag: 'game' (gold, a mod made for this game), 'ue-plus' (blue, an Unreal game UE-Extended
// has settings for), 'engine' (silver, any other engine-wide match), or null. Pure: `picked` is the
// memoised index match, `entry` the cached table lookup.
function renodxTagClass(picked, { engineId = null, entry = null } = {}) {
  const isGame = !!(picked && picked.match && !/^engine/.test(picked.match.how || '') && picked.match.modId !== UE_EXTENDED_MOD_ID);
  if (isGame) return 'game';
  if (engineId === 'unreal' && entry) return 'ue-plus';
  if (picked && picked.match) return 'engine';
  return null;
}

module.exports = {
  UE_EXTENDED_ARTIFACT, UE_EXTENDED_MOD_ID, UE_EXTENDED_TITLE,
  UE_EXTENDED_RELEASE, UE_EXTENDED_TEST_RELEASE,
  UE_EXTENDED_TABLE_ASSET,
  parseGameSettings, bundledTable, ueExtendedEntry,
  normaliseTable, tableAsset, tableIsCurrent, loadReleaseTable, setActiveTable, activeTable,
  testOverrideEnabled, ueExtendedSource, applyUeExtended, renodxTagClass,
};
