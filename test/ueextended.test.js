'use strict';
// RenoDX UE-Extended (src/ueextended.js): the cached GameSettings table, which add-on an Unreal game
// gets, and the card tag's three colours.

const test = require('node:test');
const assert = require('node:assert/strict');

const ue = require('../src/ueextended');
const addons = require('../src/addons');

const CPP = `
const std::unordered_map<std::string, GameSettings> GAME_SETTINGS = {
    {
        "P3R.exe",
        GameSettings{
            {"Upgrade_B8G8R8A8_TYPELESS", UPGRADE_TYPE_OUTPUT_SIZE},
        },
    },
    {
        "FarFarWest-Win64-Shipping.exe",  // Product name "UnrealGame"
        GameSettings{
            {"Set_Path", 0.f},
        },
    },
    {
        "Dawnwalker",
        GameSettings{
            {"Set_Path", 0.f},
        },
    },
};

auto FindGameSettings() {}
`;

test('the table parser reads keys and the native-HDR (Set_Path 0) path', () => {
  assert.deepEqual(ue.parseGameSettings(CPP), {
    'P3R.exe': { nativeHdr: false },
    'FarFarWest-Win64-Shipping.exe': { nativeHdr: true },
    Dawnwalker: { nativeHdr: true },
  });
});

test('the shipped table is the fork\'s 69 entries, Dawnwalker native-HDR', () => {
  const t = ue.bundledTable();
  assert.equal(Object.keys(t.games).length, 69);
  assert.equal(t.games.Dawnwalker.nativeHdr, true);
  assert.equal(t.games['P3R.exe'].nativeHdr, false);
  assert.ok(t.source && t.source.repo === 'mrcgibb9876-hash/renodx');
});

test('lookup is by exe file name first, then product name, exactly as the add-on does', () => {
  const table = { games: { 'Game.exe': { nativeHdr: false }, Dawnwalker: { nativeHdr: true } } };
  assert.deepEqual(ue.ueExtendedEntry({ exeName: 'D:\\x\\Game.exe', productName: 'Dawnwalker' }, table), { key: 'Game.exe', nativeHdr: false, how: 'exe' });
  assert.deepEqual(ue.ueExtendedEntry({ exeName: 'Dawnwalker.exe', productName: 'Dawnwalker' }, table), { key: 'Dawnwalker', nativeHdr: true, how: 'product' });
  assert.equal(ue.ueExtendedEntry({ exeName: 'dawnwalker', productName: 'dawnwalker' }, table), null, 'case-sensitive');
  assert.equal(ue.ueExtendedEntry({ exeName: 'x.exe' }, table), null);
});

test('source: snapshot when it carries the asset, the test pre-release only with the dev override', () => {
  assert.equal(ue.ueExtendedSource({ snapshotAssets: ['renodx-unrealengine.addon64'] }), null);
  assert.equal(ue.ueExtendedSource({ snapshotAssets: [ue.UE_EXTENDED_ARTIFACT] }).tag, 'snapshot');
  assert.equal(ue.ueExtendedSource({ snapshotAssets: null, testOverride: true }).tag, 'test-ue-extended');
  assert.equal(ue.ueExtendedSource({ snapshotAssets: [ue.UE_EXTENDED_ARTIFACT], testOverride: true }).tag, 'snapshot', 'promoted wins');
  assert.equal(ue.testOverrideEnabled({}, {}), false);
  assert.equal(ue.testOverrideEnabled({ renodxUeExtendedTest: true }, {}), true);
  assert.equal(ue.testOverrideEnabled({}, { OPTIDLSS5_UE_EXTENDED_TEST: '1' }), true);
});

const FORK = { repo: 'mrcgibb9876-hash/renodx', tag: 'snapshot', hostApi: true };
const INDEX = {
  games: [
    { id: 'ace7', title: 'Ace Combat 7', steam_appid: 502500, mods: [{ id: 'unrealengine', support: 'generic', status: 'beta', artifacts: [{ name: 'renodx-unrealengine.addon64', arch: 'x64' }] }] },
    { id: 'lop', title: 'Lies of P', steam_appid: 1627720, mods: [{ id: 'liesofp', status: 'stable', artifacts: [{ name: 'renodx-liesofp.addon64', arch: 'x64' }] }] },
  ],
};

test('an Unreal game with no mod of its own gets UE-Extended instead of the generic Unreal mod', () => {
  const params = { title: 'The Blood of Dawnwalker', bitness: 64, engineId: 'unreal' };
  const picked = addons.pickRenodxMatch({ index: INDEX, source: FORK }, null, params);
  assert.equal(picked.match.artifact, 'renodx-unrealengine.addon64');
  const src = ue.UE_EXTENDED_TEST_RELEASE;
  const entry = ue.ueExtendedEntry({ exeName: 'Dawnwalker.exe', productName: 'Dawnwalker' });
  const out = ue.applyUeExtended(picked, { engineId: 'unreal', bitness: 64, source: src, entry });
  assert.equal(out.match.artifact, ue.UE_EXTENDED_ARTIFACT);
  assert.equal(out.match.modId, 'ue-extended');
  assert.equal(out.match.how, 'ue-extended');
  assert.equal(out.match.ueExtended.nativeHdr, true);
  assert.equal(out.match.replaces, 'renodx-unrealengine.addon64');
  assert.equal(out.source, src);
  // Untuned Unreal game: still UE-Extended, but read as engine-wide everywhere (/^engine/).
  const untuned = ue.applyUeExtended(picked, { engineId: 'unreal', bitness: 64, source: src, entry: null });
  assert.equal(untuned.match.artifact, ue.UE_EXTENDED_ARTIFACT);
  assert.match(untuned.match.how, /^engine/);
  // No release has it (not promoted, no override): the generic mod, as before.
  assert.equal(ue.applyUeExtended(picked, { engineId: 'unreal', bitness: 64, source: null, entry }), picked);
  // Not Unreal, or 32-bit: untouched.
  assert.equal(ue.applyUeExtended(picked, { engineId: 'unity', bitness: 64, source: src, entry }), picked);
  assert.equal(ue.applyUeExtended(picked, { engineId: 'unreal', bitness: 32, source: src, entry }), picked);
  // No match at all in the index still gets it on an Unreal game.
  assert.equal(ue.applyUeExtended(null, { engineId: 'unreal', bitness: 64, source: src, entry }).match.artifact, ue.UE_EXTENDED_ARTIFACT);
});

test('a per-game RenoDX mod still wins over UE-Extended', () => {
  const params = { steamAppid: 1627720, title: 'Lies of P', bitness: 64, engineId: 'unreal' };
  const picked = addons.pickRenodxMatch({ index: INDEX, source: FORK }, null, params);
  const entry = ue.ueExtendedEntry({ productName: 'Lies of P' });
  assert.ok(entry, 'Lies of P is in the UE-Extended table too');
  const out = ue.applyUeExtended(picked, { engineId: 'unreal', bitness: 64, source: ue.UE_EXTENDED_RELEASE, entry });
  assert.equal(out.match.artifact, 'renodx-liesofp.addon64');
  assert.equal(ue.renodxTagClass(out, { engineId: 'unreal', entry }), 'game');
});

test('tag: gold per-game, blue for an Unreal game in the table, silver for other engine matches', () => {
  const engine = addons.pickRenodxMatch({ index: INDEX, source: FORK }, null, { title: 'X', bitness: 64, engineId: 'unreal' });
  const game = addons.pickRenodxMatch({ index: INDEX, source: FORK }, null, { steamAppid: 1627720, bitness: 64, engineId: 'unreal' });
  const entry = { key: 'Dawnwalker', nativeHdr: true, how: 'product' };
  assert.equal(ue.renodxTagClass(game, { engineId: 'unreal', entry }), 'game');
  assert.equal(ue.renodxTagClass(engine, { engineId: 'unreal', entry }), 'ue-plus');
  assert.equal(ue.renodxTagClass(engine, { engineId: 'unreal', entry: null }), 'engine');
  // With UE-Extended already applied, the classification is the same.
  const applied = ue.applyUeExtended(engine, { engineId: 'unreal', bitness: 64, source: ue.UE_EXTENDED_RELEASE, entry });
  assert.equal(ue.renodxTagClass(applied, { engineId: 'unreal', entry }), 'ue-plus');
  assert.equal(ue.renodxTagClass(null, { engineId: 'unreal', entry }), 'ue-plus');
  assert.equal(ue.renodxTagClass(null, { engineId: 'unity', entry: null }), null);
});

// ── The release's own table (ue-extended-games.json beside the add-on) ──────────────────────────

// The shape the fork's release ships: the bundled file's keys plus per-game extras and source.commit.
const RELEASE_TABLE = {
  source: { repo: 'mrcgibb9876-hash/renodx', file: 'src/games/ue-extended/addon.cpp', ref: 'feat/ue-extended', commit: 'c1', author: 'marat569', hostApiVersion: 4 },
  generated: '2026-09-26',
  count: 3,
  games: {
    'Ace7Game.exe': { nativeHdr: false, matchBy: 'exe', defaults: { Upgrade_B8G8R8A8_TYPELESS: 1 }, additionalSettings: [], customShaders: [] },
    'Alone in the Dark': { nativeHdr: true, matchBy: 'productName', defaults: { Set_Path: 0 }, additionalSettings: [], customShaders: [] },
    // Only in the release, and with nativeHdr left to its defaults.
    'NewGame-Win64-Shipping.exe': { matchBy: 'exe', defaults: { Set_Path: 0 } },
  },
};

const SOURCE = ue.UE_EXTENDED_TEST_RELEASE;
const releaseWith = (updatedAt, extra = []) => ({
  tag_name: SOURCE.tag,
  assets: [
    { name: 'renodx-ue-extended.addon64', browser_download_url: 'https://github.com/x/addon64', updated_at: updatedAt },
    { name: 'ue-extended-games.json', browser_download_url: 'https://github.com/x/ue-extended-games.json', updated_at: updatedAt, digest: `sha256:${'ab'.repeat(32)}` },
    ...extra,
  ],
});

// A stub world: counts the release reads and downloads, holds the cache in memory.
function world({ release = releaseWith('2026-09-26T20:21:04Z'), table = RELEASE_TABLE, cache = null, offline = false } = {}) {
  const w = { releases: 0, downloads: 0, cache, digests: [] };
  w.deps = {
    resolveRelease: async (repo, tag) => {
      w.releases++;
      if (offline) throw new Error('offline');
      assert.equal(repo, SOURCE.repo);
      assert.equal(tag, SOURCE.tag, 'the table comes from the same release as the add-on');
      return release;
    },
    download: async (url, asset) => {
      w.downloads++;
      w.digests.push(asset && asset.digest);
      return Buffer.from(typeof table === 'string' ? table : JSON.stringify(table));
    },
    readCache: () => w.cache,
    writeCache: (v) => { w.cache = JSON.parse(JSON.stringify(v)); },
  };
  return w;
}

test('release table: keeps the extras, and a game without nativeHdr takes it from Set_Path 0', () => {
  const t = ue.normaliseTable(RELEASE_TABLE);
  assert.equal(t.source.commit, 'c1');
  assert.equal(t.games['NewGame-Win64-Shipping.exe'].nativeHdr, true);
  assert.equal(t.games['Ace7Game.exe'].nativeHdr, false);
  assert.deepEqual(t.games['Ace7Game.exe'].defaults, { Upgrade_B8G8R8A8_TYPELESS: 1 });
  assert.equal(t.games['Alone in the Dark'].matchBy, 'productName');
  for (const bad of [null, {}, { games: [] }, { games: {} }, 'x']) assert.equal(ue.normaliseTable(bad), null);
  // The bundled file reads the same way, so the fallback and the release table are one shape.
  assert.equal(Object.keys(ue.normaliseTable(ue.bundledTable()).games).length, 69);
});

test('release table: the asset and its digest are read off the release JSON', () => {
  const a = ue.tableAsset(releaseWith('2026-09-26T20:21:04Z'));
  assert.equal(a.url, 'https://github.com/x/ue-extended-games.json');
  assert.equal(a.updatedAt, '2026-09-26T20:21:04Z');
  assert.equal(a.digest, 'ab'.repeat(32), 'hex, without the sha256: prefix');
  assert.equal(ue.tableAsset({ assets: [{ name: 'renodx-ue-extended.addon64', browser_download_url: 'u' }] }), null);
  assert.equal(ue.tableAsset(null), null);
});

test('release table: first run downloads it from the add-on\'s release and caches it with its record', async () => {
  const w = world();
  const res = await ue.loadReleaseTable(SOURCE, w.deps);
  assert.equal(res.from, 'release');
  assert.equal(w.downloads, 1);
  assert.equal(w.digests[0], 'ab'.repeat(32), 'checked against GitHub\'s published digest');
  assert.ok(res.table.games['NewGame-Win64-Shipping.exe']);
  assert.deepEqual(w.cache.meta, { repo: SOURCE.repo, tag: SOURCE.tag, updatedAt: '2026-09-26T20:21:04Z', digest: 'ab'.repeat(32), commit: 'c1' });
});

test('release table: an unchanged asset is not downloaded again', async () => {
  const w = world();
  await ue.loadReleaseTable(SOURCE, w.deps);
  const res = await ue.loadReleaseTable(SOURCE, w.deps);
  assert.equal(res.from, 'cache');
  assert.equal(w.downloads, 1);
  assert.equal(w.releases, 2, 'the release JSON is still asked (ghapi remembers it)');
});

test('release table: a new upload is fetched; the same source.commit re-uploaded keeps the cached table', async () => {
  const w = world();
  await ue.loadReleaseTable(SOURCE, w.deps);

  // Re-uploaded, same commit: downloaded (updatedAt moved) but recognised as the same table.
  w.deps.resolveRelease = async () => releaseWith('2026-09-27T08:00:00Z');
  let res = await ue.loadReleaseTable(SOURCE, w.deps);
  assert.equal(w.downloads, 2);
  assert.equal(res.from, 'cache');
  assert.equal(w.cache.meta.updatedAt, '2026-09-27T08:00:00Z', 'the record moves, so it is not fetched a third time');
  await ue.loadReleaseTable(SOURCE, w.deps);
  assert.equal(w.downloads, 2);

  // A new commit: the new table.
  const next = { ...RELEASE_TABLE, source: { ...RELEASE_TABLE.source, commit: 'c2' }, games: { ...RELEASE_TABLE.games, 'Later.exe': { nativeHdr: false } } };
  const w2 = world({ release: releaseWith('2026-09-28T08:00:00Z'), table: next, cache: w.cache });
  res = await ue.loadReleaseTable(SOURCE, w2.deps);
  assert.equal(res.from, 'release');
  assert.ok(res.table.games['Later.exe']);
  assert.equal(w2.cache.meta.commit, 'c2');
});

test('release table: offline, a bad asset or no asset falls back to the cache, then the bundled file', async () => {
  // Offline on a first run: the bundled table.
  let res = await ue.loadReleaseTable(SOURCE, world({ offline: true }).deps);
  assert.equal(res.from, 'bundled');
  assert.equal(Object.keys(res.table.games).length, 69);

  // Offline with a cached copy of THIS release: the cached one.
  const w = world();
  await ue.loadReleaseTable(SOURCE, w.deps);
  res = await ue.loadReleaseTable(SOURCE, world({ offline: true, cache: w.cache }).deps);
  assert.equal(res.from, 'cache');
  assert.ok(res.table.games['NewGame-Win64-Shipping.exe']);

  // A cached copy of ANOTHER release is not used for this one.
  res = await ue.loadReleaseTable(ue.UE_EXTENDED_RELEASE, world({ offline: true, cache: w.cache }).deps);
  assert.equal(res.from, 'bundled');

  // An asset that does not parse, or is not a table.
  res = await ue.loadReleaseTable(SOURCE, world({ table: 'not json' }).deps);
  assert.equal(res.from, 'bundled');
  res = await ue.loadReleaseTable(SOURCE, world({ table: { games: {} } }).deps);
  assert.equal(res.from, 'bundled');

  // A release without the asset (an older build), and no release at all.
  res = await ue.loadReleaseTable(SOURCE, world({ release: { assets: [] } }).deps);
  assert.equal(res.from, 'bundled');
  const none = world();
  res = await ue.loadReleaseTable(null, none.deps);
  assert.equal(res.from, 'bundled');
  assert.equal(none.releases, 0, 'no source, no network');
});

test('release table: lookups and the blue tag read it once it is active, the bundled one before and after a reset', async () => {
  const product = { exeName: 'NewGame-Win64-Shipping.exe', productName: 'NewGame' };
  assert.equal(ue.ueExtendedEntry(product), null, 'not in the bundled table');
  const res = await ue.loadReleaseTable(SOURCE, world().deps);
  ue.setActiveTable(res.table);
  try {
    const entry = ue.ueExtendedEntry(product);
    assert.deepEqual(entry, { key: 'NewGame-Win64-Shipping.exe', nativeHdr: true, how: 'exe' });
    assert.equal(ue.renodxTagClass(null, { engineId: 'unreal', entry }), 'ue-plus');
    // Matched by product name, as the add-on does.
    assert.equal(ue.ueExtendedEntry({ exeName: 'AITD-Win64-Shipping.exe', productName: 'Alone in the Dark' }).how, 'product');
  } finally {
    ue.setActiveTable(null);
  }
  assert.equal(ue.activeTable(), ue.bundledTable());
  assert.equal(ue.ueExtendedEntry(product), null);
});

test('main.js takes the table from the add-on\'s release once, in the background for the card tag', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const cap = main.slice(main.indexOf('function renodxCapability('));
  const capBody = cap.slice(0, cap.indexOf('\n}\n'));
  // Started once, not awaited, and not re-asked per card (ueExtendedSourceNow reads settings.json).
  assert.match(capBody, /if \(!ueExtendedTableStarted\) ueExtendedTableRefresh\(\)\.catch/);
  assert.doesNotMatch(capBody, /await ueExtendedTableRefresh/);
  // The same release as the add-on: the source ueExtendedSourceNow picks, through ghapi's resolveRelease.
  const refresh = main.slice(main.indexOf('async function ueExtendedTableRefresh('));
  const body = refresh.slice(0, refresh.indexOf('\n}\n'));
  assert.match(body, /ueExtendedSourceNow\(\)/);
  assert.match(body, /addonCtx\(\)\.resolveRelease/);
  assert.match(body, /ueExtendedTableMemo/);
  assert.match(body, /setActiveTable/);
});
