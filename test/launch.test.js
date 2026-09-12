'use strict';
// Launch runs the exe OptiScaler is installed beside. For an Unreal game whose card points at
// the launcher stub in the install root, that is <Project>\Binaries\Win64\<Project>-Win64-Shipping.exe;
// for anything else it is the exe as recorded. Dry run only: nothing is spawned in a test.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scratchDir, write, fakeExe, loadMain } = require('./helpers');

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

test('the store lookup tries the spellings Steam actually finds', () => {
  const { bannerSearchTerms } = require(path.join(__dirname, '..', 'src', 'library'));
  const t = bannerSearchTerms('Star Wars Jedi - Fallen Order');
  assert.equal(t[0], 'Star Wars Jedi - Fallen Order', 'as given first');
  assert.ok(t.includes('Star Wars Jedi Fallen Order'), 'then without the dash');
  const e = bannerSearchTerms('The.Witcher.3.Wild.Hunt.GOTY.v4.04');
  assert.ok(e.includes('The Witcher 3 Wild Hunt'), 'dots, edition and version stripped: ' + JSON.stringify(e));
  assert.deepEqual(bannerSearchTerms('ab'), [], 'too short to search');
});
