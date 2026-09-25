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
