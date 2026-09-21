'use strict';
// Deep Fried Chicken on 32-bit games (src/dfc.js switchToDfc32).
//
// Chicken 3.0 runs a 32-bit game through its own companion: a 32-bit ReShade with its add-on beside
// the game, a hidden x64 worker in host64\ that runs DLSS and the model. This app's own 32-bit route
// has a host64\ too, so the switch takes that whole stack out first and puts Chicken's tree in its
// place; the way back takes Chicken's tree out whole. Nothing of the two is ever mixed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dfc = require('../src/dfc');
const { foreignToolchains } = require('../src/detect');

const onWindows = process.platform === 'win32';

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dlss5ui-dfc32-${name}-`));
}

function write(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

// Chicken 3.0 as it unpacks: 64-bit/, 32-bit/ (with host64\ and reshade-shaders\) and the licence at the root.
function fakeRelease(base) {
  const root = path.join(base, 'Deep-Fried-Chicken-v3.0.0');
  write(root, '64-bit/deep-fried-chicken.addon64', 'addon64');
  write(root, '64-bit/deep-fried-chicken-nvngx.dll', 'nvngx');
  write(root, '64-bit/deep-fried-chicken.cfg', 'passes=1\n');
  write(root, '32-bit/deep-fried-chicken.addon32', 'addon32');
  write(root, '32-bit/deep-fried-chicken-bridge.cfg', 'enabled=1\n');
  write(root, '32-bit/host64/deep-fried-chicken.addon64', 'addon64 (worker)');
  write(root, '32-bit/host64/deep-fried-chicken-nvngx.dll', 'nvngx (worker)');
  write(root, '32-bit/host64/deep-fried-chicken.cfg', 'passes=1\n');
  write(root, '32-bit/host64/dfc-universal-host64.exe', 'worker exe');
  write(root, '32-bit/reshade-shaders/Shaders/DFC_Universal_Feed.fx', 'technique DFC_Universal_Feed {}');
  write(root, '32-bit/reshade-shaders/Shaders/ReShade.fxh', '#pragma once');
  write(root, 'LICENSE-Deep-Fried-Chicken.md', 'their licence');
  write(root, 'README.txt', 'readme');
  return root;
}

// ReShade's add-on setup is a zip holding both builds (feeder.js / legacy.js read it the same way).
function fakeReShadeSetup(base) {
  const src = path.join(base, 'reshade-src');
  write(src, 'ReShade32.dll', 'ReShade 32-bit add-on build');
  write(src, 'ReShade64.dll', 'ReShade 64-bit add-on build');
  const zip = path.join(base, 'ReShade_Setup_Addon.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:SRC "*") -DestinationPath $env:DEST -Force'],
  { env: { ...process.env, SRC: src, DEST: zip } });
  return zip;
}

// A 32-bit DirectX 9 game on this app's route: dgVoodoo2's D3D9.dll, a 32-bit ReShade dxgi.dll with
// the Feeder's add-on, and the host64\ helper with OptiScaler as winmm.dll.
function our32Route(base) {
  const game = path.join(base, 'game');
  write(game, 'Game.exe', 'x');
  write(game, 'D3D9.dll', 'dgVoodoo2');
  write(game, 'dxgi.dll', 'ReShade 32 (the Feeder\'s)');
  write(game, 'dlss5-feed.addon32', 'feeder32');
  write(game, 'host64/dlss5-feed-host64.exe', 'helper');
  write(game, 'host64/winmm.dll', 'OptiScaler');
  return game;
}

// What main.js's removeOur32Stack does to that folder.
async function fakeRemoveOur32(dir) {
  for (const rel of ['D3D9.dll', 'dxgi.dll', 'dlss5-feed.addon32', 'host64']) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
  return { removed: ['the 32-bit route'], failed: [] };
}

function deps(base, overrides = {}) {
  const model = path.join(base, 'model.dll');
  if (!fs.existsSync(model)) fs.writeFileSync(model, 'NR model');
  const setup = path.join(base, 'ReShade_Setup_Addon.zip');
  return {
    api: 'dx9',
    nrDllPath: model,
    removeOurStack: fakeRemoveOur32,
    occupiedAfterRemoval: () => false,
    reshadeSetup: async () => setup,
    placeNvngxDlss: async (hostDir) => fs.writeFileSync(path.join(hostDir, 'nvngx_dlss.dll'), 'DLSS x64'),
    ...overrides,
  };
}

async function supplied(base) {
  const cache = path.join(base, 'cache');
  await dfc.importDfcSource(fakeRelease(base), cache);
  fakeReShadeSetup(base);
  return cache;
}

test('the import keeps Chicken\'s 32-bit tree whole, beside the 64-bit payload', async () => {
  const base = tmp('import');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeRelease(base), cache);
    const tree = dfc.cached32(cache);
    assert.ok(tree, 'the 32-bit tree is cached');
    for (const rel of ['deep-fried-chicken.addon32', 'host64/dfc-universal-host64.exe', 'reshade-shaders/Shaders/DFC_Universal_Feed.fx']) {
      assert.ok(fs.existsSync(path.join(tree, ...rel.split('/'))), rel);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a 32-bit DirectX 9 game: this app\'s route out whole, Chicken\'s companion in, the feed switched on', { skip: !onWindows }, async () => {
  const base = tmp('in');
  try {
    const cache = await supplied(base);
    const game = our32Route(base);
    const r = await dfc.switchToDfc32(game, cache, deps(base));
    assert.strictEqual(r.deployed, true);
    const read = (rel) => fs.readFileSync(path.join(game, ...rel.split('/')), 'utf8');
    assert.strictEqual(read('d3d9.dll'), 'ReShade 32-bit add-on build', 'ReShade is the game\'s d3d9.dll: Chicken hooks D3D9 itself');
    assert.strictEqual(fs.existsSync(path.join(game, 'dxgi.dll')), false, 'no dgVoodoo2, no Feeder ReShade left');
    assert.strictEqual(fs.existsSync(path.join(game, 'dlss5-feed.addon32')), false);
    assert.strictEqual(fs.existsSync(path.join(game, 'host64', 'winmm.dll')), false, 'nothing of our helper is in Chicken\'s host64');
    assert.strictEqual(read('deep-fried-chicken.addon32'), 'addon32');
    assert.strictEqual(read('host64/dfc-universal-host64.exe'), 'worker exe');
    assert.strictEqual(read('host64/dxgi.dll'), 'ReShade 64-bit add-on build', 'the worker\'s x64 ReShade');
    assert.strictEqual(read('host64/nvngx_dlssnr.dll'), 'NR model');
    assert.strictEqual(read('host64/nvngx_dlss.dll'), 'DLSS x64');
    assert.match(read('ReShade.ini'), /EffectSearchPaths=\.\\reshade-shaders\\Shaders\\\*\*/);
    assert.match(read('ReShadePreset.ini'), /Techniques=DFC_Universal_Feed@DFC_Universal_Feed\.fx/);
    assert.match(read('host64/ReShade.ini'), /AddonPath=\.\\/);
    const m = dfc.readMarker(game);
    assert.strictEqual(m.bits, 32);
    assert.deepStrictEqual(m.dirs, ['host64']);
    assert.strictEqual(m.reshadeProxy, 'd3d9.dll');
    assert.strictEqual(dfc.dfcOurs(game), true);
    assert.deepStrictEqual(foreignToolchains(game), [], 'nothing of ours reads as a foreign Chicken');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a 32-bit DirectX 11 game gets ReShade as dxgi.dll', { skip: !onWindows }, async () => {
  const base = tmp('dx11');
  try {
    const cache = await supplied(base);
    const game = our32Route(base);
    await dfc.switchToDfc32(game, cache, deps(base, { api: 'dx11' }));
    assert.strictEqual(fs.readFileSync(path.join(game, 'dxgi.dll'), 'utf8'), 'ReShade 32-bit add-on build');
    assert.strictEqual(dfc.readMarker(game).reshadeProxy, 'dxgi.dll');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the way back takes Chicken\'s tree out whole and keeps the player\'s 32-bit settings for next time', { skip: !onWindows }, async () => {
  const base = tmp('back');
  try {
    const cache = await supplied(base);
    const game = our32Route(base);
    await dfc.switchToDfc32(game, cache, deps(base));
    // The player tunes both cfgs; the worker and ReShade write their own files while running.
    fs.writeFileSync(path.join(game, 'deep-fried-chicken-bridge.cfg'), 'enabled=1\nmode=3\n');
    fs.writeFileSync(path.join(game, 'host64', 'deep-fried-chicken.cfg'), 'passes=6\n');
    fs.writeFileSync(path.join(game, 'host64', 'dfc-universal-feed-host.log'), 'worker log');
    fs.writeFileSync(path.join(game, 'ReShade.log'), 'log');

    const r = await dfc.removeDfc(game, { cacheDir: cache });
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(fs.readdirSync(game), ['Game.exe'], 'only the game is left for this app\'s route to go back into');

    // Back to Chicken later: both tuned cfgs come with it.
    const again = await dfc.switchToDfc32(game, cache, deps(base));
    assert.strictEqual(again.restoredCfg, true);
    assert.strictEqual(fs.readFileSync(path.join(game, 'deep-fried-chicken-bridge.cfg'), 'utf8'), 'enabled=1\nmode=3\n');
    assert.strictEqual(fs.readFileSync(path.join(game, 'host64', 'deep-fried-chicken.cfg'), 'utf8'), 'passes=6\n');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a 32-bit switch that would have to refuse refuses before this app\'s route is taken out', { skip: !onWindows }, async () => {
  const base = tmp('refuse');
  try {
    const cache = await supplied(base);
    let removed = 0;
    const counting = { removeOurStack: async (d) => { removed++; return fakeRemoveOur32(d); } };

    // The game's own d3d9.dll would come back from behind dgVoodoo2.
    const g1 = our32Route(path.join(base, 'a'));
    await assert.rejects(() => dfc.switchToDfc32(g1, cache, deps(base, { ...counting, occupiedAfterRemoval: (rel) => rel === 'd3d9.dll' })), /d3d9\.dll here is not this app's/);
    // Somebody else's host64\ folder.
    const g2 = our32Route(path.join(base, 'b'));
    await assert.rejects(() => dfc.switchToDfc32(g2, cache, deps(base, { ...counting, occupiedAfterRemoval: (rel) => rel === 'host64' })), /host64 folder here is not this app's/);
    // Offline: no ReShade setup.
    const g3 = our32Route(path.join(base, 'c'));
    await assert.rejects(() => dfc.switchToDfc32(g3, cache, deps(base, { ...counting, reshadeSetup: async () => { throw new Error('getaddrinfo ENOTFOUND reshade.me'); } })), /ENOTFOUND/);
    // DirectX 8 is not one of Chicken's 32-bit renderers.
    const g4 = our32Route(path.join(base, 'd'));
    await assert.rejects(() => dfc.switchToDfc32(g4, cache, deps(base, { ...counting, api: 'dx8' })), /DirectX 9 to 11/);

    assert.strictEqual(removed, 0, 'this app\'s route was never taken out for a switch that could not finish');
    assert.ok(fs.existsSync(path.join(g1, 'host64', 'winmm.dll')));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a copy added without its 32-bit folder says what to add', async () => {
  const base = tmp('no32');
  try {
    const release = fakeRelease(base);
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(path.join(release, '64-bit'), cache);
    assert.strictEqual(dfc.cached32(cache), null);
    const game = our32Route(base);
    await assert.rejects(() => dfc.switchToDfc32(game, cache, deps(base)), /no 32-bit part/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a hand-copied 32-bit Chicken reads as a foreign install; ours does not', { skip: !onWindows }, async () => {
  const base = tmp('foreign');
  try {
    const theirs = path.join(base, 'theirs');
    write(theirs, 'deep-fried-chicken.addon32', 'x');
    assert.ok(foreignToolchains(theirs).some((f) => f.tool === 'Deep Fried Chicken'));
    await assert.rejects(async () => {
      const cache = await supplied(path.join(base, 's'));
      await dfc.switchToDfc32(theirs, cache, deps(path.join(base, 's')));
    }, /copied in by hand/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
