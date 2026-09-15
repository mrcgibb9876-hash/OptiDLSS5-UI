'use strict';
// Launch runs the exe OptiScaler is installed beside. For an Unreal game whose card points at
// the launcher stub in the install root, that is <Project>\Binaries\Win64\<Project>-Win64-Shipping.exe;
// for anything else it is the exe as recorded. Dry run only: nothing is spawned in a test.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scratchDir, write, fakeExe, loadMain } = require('./helpers');
const onWindows = process.platform === 'win32';

test('Launch targets the Unreal shipping exe when the card holds the launcher stub', async () => {
  const root = scratchDir('launch-ue');
  const stub = fakeExe(root, 'StarWarsJediFallenOrder.exe');
  write(root, 'Engine/Binaries/Win64/CrashReportClient.exe', 'x');
  const shipping = fakeExe(path.join(root, 'SwGame', 'Binaries', 'Win64'), 'SwGame-Win64-Shipping.exe');
  const { invoke } = loadMain();
  const res = await invoke('game:launch', { exePath: stub, dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(path.resolve(res.target), path.resolve(shipping));
});

test('Launch runs a non-Unreal exe as recorded, and refuses a missing one', async () => {
  const dir = scratchDir('launch-plain');
  const exe = fakeExe(dir, 'Game.exe');
  const { invoke } = loadMain();
  const res = await invoke('game:launch', { exePath: exe, dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(path.resolve(res.target), path.resolve(exe));
  const missing = await invoke('game:launch', { exePath: path.join(dir, 'nope.exe'), dryRun: true });
  assert.equal(missing.ok, false);
});

test('a game under a Steam library launches through Steam, by the appid of its install folder', async () => {
  const lib = scratchDir('launch-steam');
  write(path.join(lib, 'steamapps'), 'appmanifest_1172380.acf', '"AppState"\n{\n\t"appid"\t\t"1172380"\n\t"name"\t\t"STAR WARS Jedi: Fallen Order"\n\t"installdir"\t\t"Jedi Fallen Order"\n}\n');
  write(path.join(lib, 'steamapps'), 'appmanifest_208650.acf', '"AppState"\n{\n\t"appid"\t\t"208650"\n\t"installdir"\t\t"Batman Arkham Knight"\n}\n');
  const root = path.join(lib, 'steamapps', 'common', 'Jedi Fallen Order');
  const stub = fakeExe(root, 'StarWarsJediFallenOrder.exe');
  write(root, 'Engine/Binaries/Win64/CrashReportClient.exe', 'x');
  fakeExe(path.join(root, 'SwGame', 'Binaries', 'Win64'), 'SwGame-Win64-Shipping.exe');
  const { invoke } = loadMain();
  const res = await invoke('game:launch', { exePath: stub, dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.via, 'steam');
  assert.equal(res.steamAppId, '1172380');
  const loose = await invoke('game:launch', { exePath: fakeExe(path.join(lib, 'elsewhere'), 'Other.exe'), dryRun: true });
  assert.equal(loose.via, 'exe');
});

test('GTA V launches through Steam with -nobattleye, not by starting GTA5.exe past the launcher', async () => {
  const lib = scratchDir('launch-gta');
  write(path.join(lib, 'steamapps'), 'appmanifest_271590.acf', '"AppState"\n{\n\t"appid"\t\t"271590"\n\t"installdir"\t\t"Grand Theft Auto V"\n}\n');
  const root = path.join(lib, 'steamapps', 'common', 'Grand Theft Auto V');
  const exe = fakeExe(root, 'GTA5.exe');
  for (const f of ['GTA5_BE.exe', 'PlayGTAV.exe']) fakeExe(root, f);
  write(root, '.optiscaler-manager-install.json', '{}');
  const { invoke } = loadMain();
  const res = await invoke('game:launch', { exePath: exe, dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.via, 'steam-no-anticheat');
  assert.equal(res.steamAppId, '271590');
  assert.deepEqual(res.args, ['-nobattleye']);
  assert.equal(path.basename(res.target), 'PlayGTAV.exe');
});

test('the store lookup tries the spellings Steam actually finds', () => {
  const { bannerSearchTerms } = require(path.join(__dirname, '..', 'src', 'library'));
  const t = bannerSearchTerms('Star Wars Jedi - Fallen Order');
  assert.equal(t[0], 'Star Wars Jedi - Fallen Order', 'as given first');
  assert.ok(t.includes('Star Wars Jedi Fallen Order'), 'then without the dash');
  const e = bannerSearchTerms('The.Witcher.3.Wild.Hunt.GOTY.v4.04');
  assert.ok(e.includes('The Witcher 3 Wild Hunt'), 'dots, edition and version stripped: ' + JSON.stringify(e));
  assert.deepEqual(bannerSearchTerms('ab'), [], 'too short to search');
});

test('a card is named and pictured from the Steam manifest, and a bare exe name falls back to its folder', async () => {
  const lib = scratchDir('name-steam');
  write(path.join(lib, 'steamapps'), 'appmanifest_883710.acf', '"AppState"\n{\n\t"appid"\t\t"883710"\n\t"name"\t\t"RESIDENT EVIL 2  BIOHAZARD RE2"\n\t"installdir"\t\t"RESIDENT EVIL 2  BIOHAZARD RE2"\n}\n');
  const re2 = fakeExe(path.join(lib, 'steamapps', 'common', 'RESIDENT EVIL 2  BIOHAZARD RE2'), 're2.exe');
  const library = require(path.join(__dirname, '..', 'src', 'library'));
  assert.deepEqual(library.steamManifestFor(re2), { appid: '883710', name: 'RESIDENT EVIL 2 BIOHAZARD RE2', installdir: 'RESIDENT EVIL 2  BIOHAZARD RE2' });
  assert.equal(library.nameForExe(re2), 'RESIDENT EVIL 2 BIOHAZARD RE2');

  const { invoke } = loadMain();
  const found = await invoke('banner:resolve', { exePath: re2, name: 're2' });
  assert.equal(found.source, 'steam-manifest');
  assert.equal(found.appid, '883710');

  // Not under Steam: a short exe name says nothing, the game folder does; engine layout folders are skipped.
  const gog = fakeExe(path.join(scratchDir('name-gog'), 'Resident Evil 2', 'Binaries', 'Win64'), 're2.exe');
  assert.equal(library.nameForExe(gog), 'Resident Evil 2');
  const plain = fakeExe(scratchDir('name-plain'), 'StarWarsJediFallenOrder.exe');
  assert.equal(library.nameForExe(plain), 'StarWarsJediFallenOrder');
});

test('games:running answers for a whole library from one process listing', { skip: !onWindows }, async () => {
  // The grid asks this every few seconds for every card. Per-game it was a tasklist.exe spawn
  // each -- measured at 84 ms x 20 games a tick on this library, which is the shape of background
  // work v1.59.0 spent a release taking back out. One listing, matched in memory, instead.
  const { invoke } = loadMain();

  // node.exe is running: this test is inside it.
  const mine = process.execPath;
  const invented = path.join('C:', 'games', 'Some Game', 'definitely-not-a-real-process-xyz.exe');

  const res = await invoke('games:running', [mine, invented]);
  assert.equal(res.ok, true);
  assert.equal(res.running[mine], true, 'the process running this test is found');
  assert.equal(res.running[invented], false, 'and a game whose exe has gone is not running, not an error');

  // Every path asked about gets an answer, so the caller never has to guess at a missing key.
  assert.deepEqual(Object.keys(res.running).sort(), [mine, invented].sort());
  assert.deepEqual((await invoke('games:running', [])).running, {}, 'an empty library asks nothing');
});
