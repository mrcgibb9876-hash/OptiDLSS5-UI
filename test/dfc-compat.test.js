'use strict';
// Deep Fried Chicken on 64-bit Vulkan and OpenGL games (src/dfc.js switchToDfcCompat).
//
// There Chicken brings its own frame producer (Compatibility\Vulkan-OpenGL) and its README says "Do
// not install another neural feeder alongside", so the switch takes this app's Feeder out with
// OptiScaler and puts Chicken's producer in. ReShade is the machine-wide layer on Vulkan (the player's
// to set up) and the game's opengl32.dll on OpenGL.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `dlss5ui-dfccompat-${name}-`));
}

function write(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function fakeRelease(base) {
  const root = path.join(base, 'Deep-Fried-Chicken-v3.0.0');
  write(root, '64-bit/deep-fried-chicken.addon64', 'addon64');
  write(root, '64-bit/deep-fried-chicken-nvngx.dll', 'nvngx');
  write(root, '64-bit/deep-fried-chicken.cfg', 'passes=1\n');
  write(root, 'Compatibility/Vulkan-OpenGL/dfc-universal-feed.addon64', 'producer');
  write(root, 'Compatibility/Vulkan-OpenGL/deep-fried-chicken-bridge.cfg', 'enabled=1\n');
  write(root, 'Compatibility/Vulkan-OpenGL/reshade-shaders/Shaders/DFC_Universal_Feed.fx', 'technique DFC_Universal_Feed {}');
  write(root, 'Compatibility/Vulkan-OpenGL/reshade-shaders/Shaders/ReShade.fxh', '#pragma once');
  write(root, 'LICENSE-Deep-Fried-Chicken.md', 'their licence');
  return root;
}

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

// A 64-bit Feeder-route game on Vulkan or OpenGL, as this app installs it.
function feederGame(base, api) {
  const game = path.join(base, 'game');
  write(game, 'Game.exe', 'x');
  write(game, 'winmm.dll', 'OptiScaler build');
  write(game, 'OptiScaler.ini', '[Plugins]\n');
  write(game, 'nvngx_dlssnr.dll', 'NR model');
  write(game, 'nvngx_dlss.dll', 'DLSS');
  write(game, 'dlss5-feed.addon64', 'feeder');
  write(game, 'reshade-shaders/Shaders/DLSS5_Feed.fx', 'feed');
  write(game, 'ReShade.ini', '[ADDON]\nAddonPath=.\\\n');
  write(game, 'ReShadePreset.ini', 'Techniques=VORT_MotionEstimation@MotionEstimation.fx,DLSS5_Feed@DLSS5_Feed.fx\n');
  if (api === 'opengl') write(game, 'opengl32.dll', 'ReShade 64-bit (the Feeder\'s)');
  return game;
}

const fakeRemoveOptiScaler = async (dir) => {
  for (const n of ['winmm.dll', 'OptiScaler.ini', 'nvngx_dlssnr.dll']) fs.rmSync(path.join(dir, n), { force: true });
  return { removed: ['OptiScaler'], failed: [] };
};
// What feeder.removeFeederStack does: the add-on, its shader and ReShade's files beside the game.
const fakeRemoveFeeder = async (dir) => {
  for (const n of ['dlss5-feed.addon64', 'reshade-shaders/Shaders/DLSS5_Feed.fx', 'ReShade.ini', 'ReShadePreset.ini', 'opengl32.dll']) fs.rmSync(path.join(dir, n), { force: true });
  return { removed: ['the Feeder'], kept: [] };
};

async function setup(base) {
  const cache = path.join(base, 'cache');
  await dfc.importDfcSource(fakeRelease(base), cache);
  fakeReShadeSetup(base);
  return cache;
}

function deps(base, api, overrides = {}) {
  const model = path.join(base, 'model.dll');
  if (!fs.existsSync(model)) fs.writeFileSync(model, 'NR model (Settings)');
  return {
    api,
    nrDllPath: model,
    removeOptiScaler: fakeRemoveOptiScaler,
    removeFeeder: fakeRemoveFeeder,
    vulkanLayerReady: async () => true,
    reshadeSetup: async () => path.join(base, 'ReShade_Setup_Addon.zip'),
    placeNvngxDlss: async (d) => fs.writeFileSync(path.join(d, 'nvngx_dlss.dll'), 'DLSS (placed)'),
    ...overrides,
  };
}

test('the import keeps Chicken\'s Vulkan/OpenGL producer set', async () => {
  const base = tmp('import');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeRelease(base), cache);
    const c = dfc.cachedCompat(cache);
    assert.ok(c);
    assert.ok(fs.existsSync(path.join(c, 'dfc-universal-feed.addon64')));
    assert.ok(fs.existsSync(path.join(c, 'reshade-shaders', 'Shaders', 'DFC_Universal_Feed.fx')));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Vulkan: the Feeder and OptiScaler out, Chicken with its producer in, on ReShade\'s layer', { skip: !onWindows }, async () => {
  const base = tmp('vk');
  try {
    const cache = await setup(base);
    const game = feederGame(base, 'vulkan');
    await dfc.switchToDfcCompat(game, cache, deps(base, 'vulkan'));
    const has = (rel) => fs.existsSync(path.join(game, ...rel.split('/')));
    const read = (rel) => fs.readFileSync(path.join(game, ...rel.split('/')), 'utf8');
    assert.strictEqual(has('dlss5-feed.addon64'), false, 'one feeder only: Chicken\'s');
    assert.strictEqual(has('winmm.dll') || has('OptiScaler.ini'), false, 'one neural pass only');
    for (const rel of ['deep-fried-chicken.addon64', 'deep-fried-chicken-nvngx.dll', 'dfc-universal-feed.addon64', 'deep-fried-chicken-bridge.cfg', 'reshade-shaders/Shaders/DFC_Universal_Feed.fx']) assert.ok(has(rel), rel);
    assert.strictEqual(read('nvngx_dlssnr.dll'), 'NR model (Settings)');
    assert.strictEqual(read('nvngx_dlss.dll'), 'DLSS', 'the DLSS already beside the exe is kept');
    assert.strictEqual(has('opengl32.dll') || has('dxgi.dll'), false, 'no proxy: Vulkan is the layer');
    assert.match(read('ReShade.ini'), /AddonPath=\.\\/);
    assert.match(read('ReShade.ini'), /EffectSearchPaths=\.\\reshade-shaders\\Shaders\\\*\*/);
    assert.match(read('ReShadePreset.ini'), /Techniques=DFC_Universal_Feed@DFC_Universal_Feed\.fx/);
    const m = dfc.readMarker(game);
    assert.strictEqual(m.compat, 'vulkan');
    assert.strictEqual(m.reshadeIni, true);
    assert.deepStrictEqual(foreignToolchains(game), []);

    const back = await dfc.removeDfc(game, { cacheDir: cache });
    assert.deepStrictEqual(back.failed, []);
    assert.deepStrictEqual(fs.readdirSync(game).sort(), ['Game.exe', 'nvngx_dlss.dll', 'nvngx_dlssnr.dll'].sort(),
      'the model and DLSS stay for the Feeder deploy that follows; everything of Chicken\'s and ReShade\'s goes');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('OpenGL: ReShade comes back as the game\'s opengl32.dll with Chicken, and goes with it', { skip: !onWindows }, async () => {
  const base = tmp('gl');
  try {
    const cache = await setup(base);
    const game = feederGame(base, 'opengl');
    await dfc.switchToDfcCompat(game, cache, deps(base, 'opengl'));
    assert.strictEqual(fs.readFileSync(path.join(game, 'opengl32.dll'), 'utf8'), 'ReShade 64-bit add-on build');
    const m = dfc.readMarker(game);
    assert.strictEqual(m.reshadeProxy, 'opengl32.dll');
    await dfc.removeDfc(game, { cacheDir: cache });
    assert.strictEqual(fs.existsSync(path.join(game, 'opengl32.dll')), false);
    assert.strictEqual(fs.existsSync(path.join(game, 'dfc-universal-feed.addon64')), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Vulkan without ReShade\'s add-on layer set up refuses before anything is touched', { skip: !onWindows }, async () => {
  const base = tmp('nolayer');
  try {
    const cache = await setup(base);
    const game = feederGame(base, 'vulkan');
    let removed = 0;
    await assert.rejects(() => dfc.switchToDfcCompat(game, cache, deps(base, 'vulkan', {
      vulkanLayerReady: async () => false,
      removeOptiScaler: async (d) => { removed++; return fakeRemoveOptiScaler(d); },
    })), (e) => e.code === 'dfc-vulkan-layer');
    assert.strictEqual(removed, 0);
    assert.ok(fs.existsSync(path.join(game, 'dlss5-feed.addon64')));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('OpenGL whose own opengl32.dll the Feeder set aside refuses before anything is touched', { skip: !onWindows }, async () => {
  const base = tmp('glorig');
  try {
    const cache = await setup(base);
    const game = feederGame(base, 'opengl');
    write(game, 'opengl32.dll.dlss5ui-orig', 'the game\'s own');
    let removed = 0;
    await assert.rejects(() => dfc.switchToDfcCompat(game, cache, deps(base, 'opengl', {
      removeOptiScaler: async (d) => { removed++; return fakeRemoveOptiScaler(d); },
    })), /set aside/);
    assert.strictEqual(removed, 0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the switch back takes Chicken out before the Feeder is deployed again', () => {
  // Source-checked: on OpenGL the Feeder's deploy would take Chicken's opengl32.dll ReShade for its
  // own, and a removeDfc after it would delete it from under the Feeder.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf("ipcMain.handle('feeder:deploy'");
  const body = src.slice(at, src.indexOf('\n});\n', at));
  assert.ok(body.indexOf('dfc.removeDfc(') < body.indexOf('feeder.deployFeederStack('), 'removeDfc runs first');
  assert.match(body, /switchToDfcCompat\(/);
});
