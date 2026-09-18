// Performance guard for a full library: fifty installed games, synced the way app start does it.
//
// The UI went slow twice for the same reason -- work repeated per game on every sync pass
// (v1.59.0, 2026-09-14): detectGame scanning every exe uncached (52 s for twenty games) and a
// powershell.exe per game folder to read one version string (15 s). Both were invisible in the
// per-feature tests because each of those runs one game. These tests run fifty and hold the three
// properties that fixed it: a sync pass has a time budget, the exe is scanned once and then
// served from the cache, and nothing starts a process per game folder.
'use strict';

// Spy on child_process BEFORE main.js (or anything it requires) loads: main.js destructures
// spawn/execFile at require time, so a wrapper installed later would never be seen.
const childProcess = require('node:child_process');
const spawned = [];
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = childProcess[name];
  childProcess[name] = function (...args) {
    spawned.push({ name, cmd: String(args[0]) });
    return real.apply(this, args);
  };
}

// Count opens of the fake executables: detect.js reads an exe through fs/promises (the byte scan)
// and fs.openSync (the PE header walks). An exe that is opened again on a later pass was not
// served from the detection cache.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const exeOpens = new Map();
const isGameExe = (p) => /PerfGame\d+\.exe$/i.test(String(p));
const countOpen = (p) => { if (isGameExe(p)) exeOpens.set(String(p), (exeOpens.get(String(p)) || 0) + 1); };
const realOpen = fsp.open;
fsp.open = function (p, ...rest) { countOpen(p); return realOpen.call(this, p, ...rest); };
const realOpenSync = fs.openSync;
fs.openSync = function (p, ...rest) { countOpen(p); return realOpenSync.call(this, p, ...rest); };
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) { countOpen(p); return realReadFileSync.call(this, p, ...rest); };

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scratchDir, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain } = require('./helpers');
const onWindows = process.platform === 'win32';

const GAMES = 50;
// Measured on the dev laptop: first pass ~1.5 s, later passes well under 0.5 s for fifty games.
// The budgets leave several times that for a slow CI runner while still failing loudly on either
// old regression (a powershell.exe per folder alone costs ~35 s for fifty games).
const FIRST_PASS_BUDGET_MS = 15000;
const LATER_PASS_BUDGET_MS = 4000;

async function syncPass(invoke, games, release, nr) {
  const started = performance.now();
  for (const g of games) {
    const r = await invoke('game:sync-if-stale', { exePath: g.exe, releaseFolder: release, nrDllPath: nr });
    assert.equal(r.ok, true, r.error);
  }
  return performance.now() - started;
}

test(`a ${GAMES}-game library syncs within budget, scans each exe once, and spawns nothing per game`, { skip: !onWindows, timeout: 180000 }, async () => {
  const base = scratchDir('perf-library');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const { invoke } = loadMain();

  const games = [];
  for (let i = 0; i < GAMES; i++) {
    const dir = path.join(base, 'library', `Game ${String(i).padStart(2, '0')}`);
    const exe = fakeExe(dir, `PerfGame${String(i).padStart(2, '0')}.exe`);
    const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll', engine: 'dlssnr' });
    assert.equal(inst.ok, true, inst.error);
    games.push({ dir, exe });
  }

  // Pass 1: what app start does after an update -- every game checked.
  spawned.length = 0;
  exeOpens.clear();
  const first = await syncPass(invoke, games, release, nr);
  const firstSpawns = spawned.slice();
  assert.ok(first < FIRST_PASS_BUDGET_MS, `first sync pass took ${Math.round(first)} ms for ${GAMES} games (budget ${FIRST_PASS_BUDGET_MS} ms)`);

  // Pass 2 and 3: a settings change, the NR-model fetch finishing. Nothing on disk moved, so no exe
  // may be read again and the pass has to be cheap.
  for (const label of ['second', 'third']) {
    spawned.length = 0;
    exeOpens.clear();
    const ms = await syncPass(invoke, games, release, nr);
    assert.ok(ms < LATER_PASS_BUDGET_MS, `${label} sync pass took ${Math.round(ms)} ms for ${GAMES} games (budget ${LATER_PASS_BUDGET_MS} ms)`);
    const reread = [...exeOpens.entries()].filter(([, n]) => n > 0);
    assert.deepEqual(reread, [], `${label} pass re-read ${reread.length} exe(s) -- detection was not served from the cache`);
    assert.equal(spawned.length, 0, `${label} pass started processes: ${JSON.stringify(spawned.slice(0, 5))}`);
  }

  // A process per game folder is the v1.59.0 powershell.exe regression. A single process for the
  // whole pass (a driver query, say) would be allowed; one per game never is.
  assert.ok(firstSpawns.length < GAMES / 2, `first pass started ${firstSpawns.length} processes for ${GAMES} games: ${JSON.stringify(firstSpawns.slice(0, 5))}`);
});

test('the grid\'s detection refresh reuses the cache for every game in the library', { skip: !onWindows, timeout: 60000 }, async () => {
  const base = scratchDir('perf-detect');
  const { invoke } = loadMain();
  const exes = [];
  for (let i = 0; i < GAMES; i++) exes.push(fakeExe(path.join(base, `G${i}`), `PerfGame${100 + i}.exe`));

  const firsts = [];
  for (const exe of exes) firsts.push(await invoke('game:detect-path', exe));

  exeOpens.clear();
  spawned.length = 0;
  const started = performance.now();
  for (let i = 0; i < GAMES; i++) {
    const again = await invoke('game:detect-path', exes[i]);
    assert.equal(again, firsts[i], `game ${i}: the cached detection object was not handed back`);
  }
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${GAMES} cached detections took ${Math.round(ms)} ms`);
  assert.equal(exeOpens.size, 0, 'no exe read on a cached detection');
  assert.equal(spawned.length, 0, 'no process started on a cached detection');
});
