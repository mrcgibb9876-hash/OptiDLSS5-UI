'use strict';
// A run that worked becomes evidence wherever the app already looks at it -- not only inside Game
// Help.
//
// learnFromRun was called from helpContext alone, so a game counted as working only if the user
// happened to open Game Help on it after a run. On a real library (2026-09-21) that left 8 of 18
// games with zero recorded runs and the Experimental chip still on, while the handful that had been
// debugged through Game Help carried 14, 18, 39 and 44. The proof was already in hand on every card
// render: game:lastRun analyses the log, and the card reads `nr-ran` off it to draw its evidence
// chip. Only the recording was missing.
//
// The threshold was never the problem and is not changed here: route.js proves a route at
// reports.works > 0, so ONE real run is enough -- once something records it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, fakeExe, write, loadMain } = require('./helpers');
const catalog = require('../src/catalog');

const DETECTED = { api: 'dx12', apis: ['dx12'], bitness: 64, recommend: 'optiscaler' };

// main.js points the catalog at userData from inside app.whenReady(), and the electron stub's
// whenReady never resolves (test/helpers.js), so that line does not run here. Without it
// localPath() is null and learnFromRun writes nowhere -- silently, which is why nothing in the
// suite could see the local catalog before. This stands in for exactly that one line.
function loadMainWithCatalog() {
  const loaded = loadMain();
  catalog.configure({ localFile: () => path.join(loaded.userData, 'known-good.local.json') });
  return loaded;
}

// A game with OptiScaler installed whose log says the neural pass dispatched.
function ranGame(name) {
  const dir = scratchDir(name);
  // What route.js optiScalerInstalled looks for: the ini, the neural model, and a proxy in one of
  // the slots. All three, or the route says nothing is installed and no run is recorded.
  write(dir, 'OptiScaler.ini', '[DlssNr]\nEnabled=true\n');
  write(dir, 'nvngx_dlssnr.dll', 'model');
  write(dir, 'dxgi.dll', 'OptiScaler');
  write(dir, 'OptiScaler.log', [
    '[00:00:01.000000] [I] NVSDK_NGX_D3D12_Init',
    '[00:00:02.000000] [I] TryCreateOptiFeature Creating OptiScaler feature',
    '[00:00:03.000000] [I] DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 1920x1080',
    '',
  ].join('\n'));
  return dir;
}

const localEntries = (userData) => {
  const p = path.join(userData, 'known-good.local.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')).entries || [];
};

test('a card render records the run that proves the route', async () => {
  const dir = ranGame('learn-card');
  const exe = fakeExe(dir, 'Proven.exe');
  const { invoke, userData } = loadMainWithCatalog();

  // The card asks for the route first, then the run -- the same order and the same render.
  const route = await invoke('game:route', { exePath: exe, detected: DETECTED });
  const run = await invoke('game:lastRun', exe);
  assert.equal(run.verdict, 'nr-ran', `expected nr-ran, got ${run.verdict}`);

  const entry = localEntries(userData).find((e) => e.exe === 'proven.exe');
  assert.ok(entry, 'the run was not recorded');
  assert.equal(entry.status, 'works');
  assert.equal(entry.reports.works, 1);
  assert.equal(entry.setup.route, route.route, 'recorded against the route the card showed');
});

// The card re-renders constantly. learnFromRun keys on the run's timestamp, so the same run must
// count once however many times it is looked at -- otherwise "works" would just measure renders.
test('the same run is counted once, however often the card renders', async () => {
  const dir = ranGame('learn-once');
  const exe = fakeExe(dir, 'Once.exe');
  const { invoke, userData } = loadMainWithCatalog();

  for (let i = 0; i < 5; i++) {
    await invoke('game:route', { exePath: exe, detected: DETECTED });
    await invoke('game:lastRun', exe);
  }
  const entry = localEntries(userData).find((e) => e.exe === 'once.exe');
  assert.ok(entry, 'the run was not recorded');
  assert.equal(entry.reports.works, 1, 'one run, counted once');
});

// Nothing is recorded for a game this app has not installed: the log could be any other tool's, and
// the route would be a guess about a setup that is not there.
test('a game with no OptiScaler installed records nothing', async () => {
  const dir = scratchDir('learn-not-installed');
  write(dir, 'OptiScaler.log', '[00:00:03.000000] [I] DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 1920x1080\n');
  const exe = fakeExe(dir, 'Bare.exe');
  const { invoke, userData } = loadMainWithCatalog();

  await invoke('game:route', { exePath: exe, detected: DETECTED });
  await invoke('game:lastRun', exe);
  assert.equal(localEntries(userData).find((e) => e.exe === 'bare.exe'), undefined);
});

// game:lastRun on its own has no route, and must not invent one. Before game:route has ever run for
// this exe it simply does not record -- which is exactly where the app was.
test('a run looked at without a route first is not recorded', async () => {
  const dir = ranGame('learn-no-route');
  const exe = fakeExe(dir, 'NoRoute.exe');
  const { invoke, userData } = loadMainWithCatalog();

  const run = await invoke('game:lastRun', exe);
  assert.equal(run.verdict, 'nr-ran');
  assert.equal(localEntries(userData).find((e) => e.exe === 'noroute.exe'), undefined);
});
