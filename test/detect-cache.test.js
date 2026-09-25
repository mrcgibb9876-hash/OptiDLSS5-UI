// The detection cache, and the native version-resource read that replaced a powershell.exe spawn.
//
// Both exist for one reason: detectGame scans the executable byte by byte when a string it looks
// for is absent, so on a big title it reads the whole file -- measured on a real library, 11 s for
// Star Wars Outlaws and 52 s for twenty games. autoConfigureGame called it uncached for every
// installed game on every sync, which is what made the app itself slow. These tests hold the two
// properties that has to keep: the executable is read once, and the folder is read every time.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const detect = require(path.join(REPO, 'src', 'detect'));
const onWindows = process.platform === 'win32';

test('a detection is scanned once and then reused', async () => {
  const dir = scratchDir('cache-reuse');
  const exe = fakeExe(dir);
  const first = await detect.detectGameCached(dir, exe);
  const second = await detect.detectGameCached(dir, exe);
  assert.equal(first, second, 'the same object, so nothing was scanned a second time');
});

test('a file appearing beside the exe is seen, and invalidateDetection drops the answer', async () => {
  const dir = scratchDir('cache-folder');
  const exe = fakeExe(dir);
  const before = await detect.detectGameCached(dir, exe);
  assert.equal(before.oldShaderCompiler, null);

  // The folder's own mtime moves when an entry is added, which is what the signature watches.
  write(dir, 'EasyAntiCheat.dll', 'x');
  const after = await detect.detectGameCached(dir, exe);
  assert.notEqual(after, before, 'the folder changed, so the cached answer was not handed back');
  assert.ok(after.antiCheat, 'anti-cheat beside the exe is seen without being told');

  const held = await detect.detectGameCached(dir, exe);
  assert.equal(held, after);
  detect.invalidateDetection(dir);
  assert.notEqual(await detect.detectGameCached(dir, exe), held, 'invalidateDetection drops it');
});

test('a stored detection is reused for the exe and re-read for the folder', async () => {
  const dir = scratchDir('cache-stored');
  const exe = fakeExe(dir);
  // Deliberately not what a scan of this exe would say: if any of it survives, the exe was not
  // scanned -- which is the whole point on a start-up with twenty installed games.
  const stored = {
    api: 'vulkan', apis: ['vulkan'], engine: 'Stored Engine', engineId: 'stored', apiBadge: 'Vulkan',
    badge: 'Stored Engine', recommend: 'optiscaler', reason: 'stored', uncertain: false, bitness: 64,
    experimental: false, emulator: null, vulkanWrapper: null, reshadeProxy: null, optiScalerProxy: null,
    antiCheat: null, protectedLauncher: null, oldShaderCompiler: null, runtimeApi: null,
    runtimeLogMtime: null, detectVersion: detect.DETECT_VERSION,
  };
  const found = await detect.detectGameCached(dir, exe, { stored });
  assert.equal(found.engine, 'Stored Engine', 'the engine came from the stored answer');
  assert.equal(found.api, 'vulkan');

  // ... while everything a file beside the exe decides is read again rather than trusted.
  detect.invalidateDetection(dir);
  write(dir, 'EasyAntiCheat.dll', 'x');
  const refreshed = await detect.detectGameCached(dir, exe, { stored });
  assert.equal(refreshed.engine, 'Stored Engine', 'still no exe scan');
  assert.ok(refreshed.antiCheat, 'but the folder evidence is current');
});

test('a stored detection the rules have moved past is scanned properly', async () => {
  const dir = scratchDir('cache-stale');
  const exe = fakeExe(dir);
  const stale = { api: 'vulkan', engine: 'Stored Engine', engineId: 'stored', detectVersion: detect.DETECT_VERSION - 1 };
  const found = await detect.detectGameCached(dir, exe, { stored: stale });
  assert.notEqual(found.engine, 'Stored Engine', 'an out-of-date stored answer is not reused');
  assert.equal(found.detectVersion, detect.DETECT_VERSION);
});

test('peOriginalFilename reads the name a DLL was built as', { skip: !onWindows }, () => {
  // What tells this app's OptiScaler apart from a game's own dxgi.dll, whatever it is renamed to.
  // Read out of the PE version resource; PowerShell used to be asked for it, at about 700 ms a
  // folder. Checked against that PowerShell on twenty real installs: the same answer every time.
  const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
  assert.equal(detect.peOriginalFilename(notepad).toLowerCase(), 'notepad.exe');
  assert.match(detect.peVersionString(notepad, 'ProductName'), /Windows/);
  assert.equal(detect.peVersionString(notepad, 'NoSuchKeyHere'), null);

  const dir = scratchDir('origname');
  const plain = write(dir, 'notes.txt', 'not a PE file at all');
  assert.equal(detect.peOriginalFilename(plain), null, 'anything unparseable simply has no answer');
  assert.equal(detect.peOriginalFilename(path.join(dir, 'missing.dll')), null);

  // A renamed copy still says what it was built as -- the property the proxy check relies on.
  const renamed = path.join(dir, 'dxgi.dll');
  fs.copyFileSync(notepad, renamed);
  assert.equal(detect.peOriginalFilename(renamed).toLowerCase(), 'notepad.exe');
});

test('a game patched by its store expires its stored detection', async () => {
  // Until v1.59.0 nothing needed to notice this: autoConfigureGame re-scanned the exe on every
  // sync and absorbed the cost. Now that a stored answer is reused instead, a patched game --
  // which can ship a renderer it did not ship before -- has to expire it.
  const dir = scratchDir('cache-patched');
  const exe = fakeExe(dir);
  const found = await detect.detectGameCached(dir, exe);
  assert.ok(found.exeStamp, 'the detection records the exe it describes');
  assert.equal(detect.isDetectionStale(found, dir, exe), false);

  const later = new Date(Date.now() + 120_000);
  fs.utimesSync(exe, later, later);
  assert.equal(detect.isDetectionStale(found, dir, exe), true, 'a changed exe is a changed answer');

  // A detection stored before exeStamp existed has nothing to compare, and must not send a whole
  // library back through a full scan on the first launch after an update.
  const beforeThisExisted = { ...found };
  delete beforeThisExisted.exeStamp;
  assert.equal(detect.isDetectionStale(beforeThisExisted, dir, exe), false);
  // ... and reusing one re-stamps it, so it is watched from then on.
  const reused = await detect.detectGameCached(dir, exe, { stored: beforeThisExisted });
  assert.ok(reused.exeStamp, 'the reused answer carries a current stamp');
});

// Batman: Arkham Knight (2026-09-15): games.json held an optiScalerProxy reading from before an engine update
// (another size, matchesOurBuild false), the exe half was still current so nothing refreshed it, and Game Help
// said "Another OptiScaler loads first" about a dxgi.dll byte-identical to this app's own build.
test('a saved reading of the folder is refreshed even when the exe half is current', async () => {
  const { loadMain } = require('./helpers');
  const { invoke } = loadMain();
  const dir = scratchDir('stale-folder-evidence');
  const exe = fakeExe(dir);
  write(dir, 'OptiScaler.dll', 'OptiScaler build v1.0.30');
  write(dir, 'dxgi.dll', 'OptiScaler build v1.0.30');
  const current = await detect.detectGameCached(dir, exe);
  assert.equal(current.optiScalerProxy.matchesOurBuild, true);

  // What games.json kept: the same detection, with the proxy as it was before the update.
  const stored = { ...current, optiScalerProxy: { file: 'dxgi.dll', size: 26447360, matchesOurBuild: false } };
  const fresh = await invoke('game:detect-path-if-stale', { exePath: exe, stored });
  assert.ok(fresh, 'a changed folder reading is handed back');
  assert.equal(fresh.optiScalerProxy.matchesOurBuild, true);

  // Nothing changed: nothing to hand back, so the renderer does not rewrite games.json every render.
  assert.equal(await invoke('game:detect-path-if-stale', { exePath: exe, stored: current }), null);
});

test('productName is on a fresh detection and filled in once on an older stored one', async () => {
  const dir = scratchDir('cache-product');
  const exe = fakeExe(dir);
  const fresh = await detect.detectGameCached(dir, exe);
  assert.ok('productName' in fresh, 'detectGame reports it (null when the exe has no version resource)');
  const stored = { ...fresh };
  delete stored.productName;
  detect.invalidateDetection(dir);
  const again = await detect.detectGameCached(dir, exe, { stored });
  assert.ok('productName' in again, 'a stored answer from before the field gets it');
  if (onWindows) assert.equal(detect.productNameOf(process.execPath), 'Node.js', 'read from the version resource');
});
