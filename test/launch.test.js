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
