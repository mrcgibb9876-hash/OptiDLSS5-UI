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
