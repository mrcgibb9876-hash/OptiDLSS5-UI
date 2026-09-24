'use strict';
// Findings of the independent review of the Chicken work (2026-09-22), each held to by a test: no
// half-done switch on a player's own ReShade, the NR model kept, the player's own ReShade files and
// shared shader headers never deleted, a takeover claimed only once the switch is past its refusals,
// and a switch that stopped half-way finished by the next Install.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dfc = require('../src/dfc');
const { diagnose } = require('../src/gamehelp');

const onWindows = process.platform === 'win32';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `dlss5ui-dfcreview-${name}-`));
function write(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const has = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));

function release(base) {
  const root = path.join(base, 'Deep-Fried-Chicken-v3.0.0');
  write(root, '64-bit/deep-fried-chicken.addon64', 'addon64');
  write(root, '64-bit/deep-fried-chicken-nvngx.dll', 'nvngx');
  write(root, '64-bit/deep-fried-chicken.cfg', 'passes=1\n');
  write(root, 'Compatibility/Vulkan-OpenGL/dfc-universal-feed.addon64', 'producer');
  write(root, 'Compatibility/Vulkan-OpenGL/deep-fried-chicken-bridge.cfg', 'enabled=1\n');
  write(root, 'Compatibility/Vulkan-OpenGL/reshade-shaders/Shaders/DFC_Universal_Feed.fx', 'technique DFC_Universal_Feed {}');
  write(root, 'Compatibility/Vulkan-OpenGL/reshade-shaders/Shaders/ReShade.fxh', 'chicken copy of ReShade.fxh');
  write(root, 'LICENSE-Deep-Fried-Chicken.md', 'their licence');
  write(root, 'README.txt', 'chicken readme');
  return root;
}
async function cacheWith(base) {
  const cache = path.join(base, 'cache');
  await dfc.importDfcSource(release(base), cache);
  return cache;
}
function reshadeSetup(base) {
  const src = path.join(base, 'reshade-src');
  write(src, 'ReShade32.dll', 'ReShade32 add-on');
  write(src, 'ReShade64.dll', 'ReShade64 add-on');
  const zip = path.join(base, 'ReShade_Setup.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:SRC "*") -DestinationPath $env:DEST -Force'],
  { env: { ...process.env, SRC: src, DEST: zip } });
  return zip;
}
const noOpti = async () => ({ removed: [], kept: [], failed: [] });
const compatDeps = (base, extra = {}) => ({
  api: 'vulkan', nrDllPath: null, removeOptiScaler: noOpti, removeFeeder: async () => null,
  vulkanLayerReady: async () => true, reshadeSetup: async () => reshadeSetup(base), placeNvngxDlss: async () => {},
  ...extra,
});

test('a player\'s own ReShade as dxgi.dll (no Chicken) is refused before OptiScaler comes out', async () => {
  const base = tmp('player-reshade');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'dxgi.dll', 'the player\'s own ReShade');
    write(game, 'winmm.dll', 'OptiScaler (ours)');
    write(game, 'nvngx_dlssnr.dll', 'model');
    let removed = 0;
    let fetched = 0;
    await assert.rejects(() => dfc.switchToDfc(game, cache, {
      removeOptiScaler: async () => { removed++; return { removed: [], failed: [] }; },
      fetchReShade: async () => { fetched++; },
    }), /dxgi\.dll here is not this app's/);
    assert.deepStrictEqual([removed, fetched], [0, 0], 'nothing was fetched and OptiScaler stayed');
    assert.strictEqual(has(game, 'ReShade64.dll'), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a ReShade64.dll that frame pacing placed is taken over like the Feeder\'s; an unclaimed one is not', async () => {
  const base = tmp('relimiter-reshade');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'dxgi.dll', 'OptiScaler build');
    write(game, 'ReShade64.dll', 'ReShade (frame pacing)');
    write(game, 'relimiter.addon64', 'ReLimiter');
    write(game, 'nvngx_dlssnr.dll', 'the model');
    const removeOpti = async (d) => { fs.rmSync(path.join(d, 'dxgi.dll')); return { removed: ['dxgi.dll'], failed: [] }; };
    // Nobody vouches for it: refused, as before.
    await assert.rejects(() => dfc.switchToDfc(game, cache, { removeOptiScaler: removeOpti }), /ReShade64\.dll here is not this app's/);
    // relimiter.placedReShade vouches for it: the swap goes ahead and ReShade becomes the proxy.
    await dfc.switchToDfc(game, cache, { removeOptiScaler: removeOpti, reshadeIsOurs: () => true });
    assert.strictEqual(read(game, 'dxgi.dll'), 'ReShade (frame pacing)');
    assert.strictEqual(has(game, 'relimiter.addon64'), true, 'the add-on stays, riding on Chicken\'s ReShade');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the NR model stays through the swap: a re-run needs no Settings path', async () => {
  const base = tmp('nr');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'dxgi.dll', 'OptiScaler build');
    write(game, 'ReShade64.dll', 'ReShade (Feeder)');
    write(game, 'dlss5-feed.addon64', 'feeder');
    write(game, 'nvngx_dlssnr.dll', 'the model');
    // What removeOptiScalerForSwap now does: OptiScaler out, the model kept.
    // Like the real one, it only takes a proxy that is OptiScaler.
    const removeKeepingNr = async (d) => {
      const p = path.join(d, 'dxgi.dll');
      if (fs.existsSync(p) && /OptiScaler/.test(fs.readFileSync(p, 'utf8'))) { fs.rmSync(p); return { removed: ['dxgi.dll'], failed: [] }; }
      return { removed: [], failed: [] };
    };
    await dfc.switchToDfc(game, cache, { removeOptiScaler: removeKeepingNr, nrDllPath: null });
    // A re-run (Edit > Deploy on a Chicken game) with no model path set.
    await dfc.switchToDfc(game, cache, { removeOptiScaler: removeKeepingNr, nrDllPath: null });
    assert.strictEqual(read(game, 'nvngx_dlssnr.dll'), 'the model');
    assert.strictEqual(read(game, 'dxgi.dll'), 'ReShade (Feeder)');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the swap\'s OptiScaler removal keeps the model (keepNr)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /async function removeOptiScalerForSwap\(dir\) \{[\s\S]{0,200}uninstallOptiScaler\(dir, \{ keepNr: true \}\)/);
  assert.match(src, /nrDllRemoved = keepNr \? false : await removeSharedNrDllIfUnneeded\(dir\)/);
});

test('a hand-made setup\'s ReShade is theirs: it stays on the way back', async () => {
  const base = tmp('adopted-reshade');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'dxgi.dll', 'their ReShade');
    write(game, 'ReShade.ini', '[GENERAL]\nmine=1\n');
    write(game, 'deep-fried-chicken.addon64', 'their addon');
    write(game, 'nvngx_dlssnr.dll', 'model');
    await dfc.switchToDfc(game, cache, { removeOptiScaler: noOpti, fetchReShade: async () => {} });
    assert.strictEqual(dfc.readMarker(game).reshadeAdopted, true);
    const back = await dfc.removeDfc(game, { cacheDir: cache });
    assert.deepStrictEqual(back.failed, []);
    assert.strictEqual(read(game, 'dxgi.dll'), 'their ReShade', 'their ReShade is left where it was');
    assert.strictEqual(read(game, 'ReShade.ini'), '[GENERAL]\nmine=1\n', 'and so is its ini');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Vulkan/OpenGL: a player\'s own ReShade.ini and preset are put back exactly, never deleted', { skip: !onWindows }, async () => {
  const base = tmp('player-ini');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'nvngx_dlssnr.dll', 'model');
    write(game, 'nvngx_dlss.dll', 'dlss');
    write(game, 'ReShade.ini', '[GENERAL]\nPresetPath=.\\Mine.ini\n');
    write(game, 'ReShadePreset.ini', 'Techniques=MyEffect@My.fx\n');
    await dfc.switchToDfcCompat(game, cache, compatDeps(base));
    assert.match(read(game, 'ReShadePreset.ini'), /DFC_Universal_Feed/);
    assert.deepStrictEqual(dfc.readMarker(game).reshadeIniBackedUp.sort(), ['ReShade.ini', 'ReShadePreset.ini']);
    await dfc.removeDfc(game, { cacheDir: cache });
    assert.strictEqual(read(game, 'ReShade.ini'), '[GENERAL]\nPresetPath=.\\Mine.ini\n');
    assert.strictEqual(read(game, 'ReShadePreset.ini'), 'Techniques=MyEffect@My.fx\n');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a shared shader header already in the folder is never overwritten or claimed', { skip: !onWindows }, async () => {
  const base = tmp('fxh');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'nvngx_dlssnr.dll', 'model');
    write(game, 'nvngx_dlss.dll', 'dlss');
    write(game, 'reshade-shaders/Shaders/ReShade.fxh', 'the player\'s ReShade.fxh');
    await dfc.switchToDfcCompat(game, cache, compatDeps(base));
    assert.strictEqual(read(game, 'reshade-shaders/Shaders/ReShade.fxh'), 'the player\'s ReShade.fxh');
    assert.ok(!dfc.readMarker(game).files.includes('reshade-shaders/Shaders/ReShade.fxh'));
    await dfc.removeDfc(game, { cacheDir: cache });
    assert.strictEqual(read(game, 'reshade-shaders/Shaders/ReShade.fxh'), 'the player\'s ReShade.fxh');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a takeover never claims the game\'s own README.txt or LICENSE.txt', async () => {
  const base = tmp('docs');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'README.txt', 'the GAME\'s readme');
    write(game, 'LICENSE.txt', 'the GAME\'s licence');
    write(game, 'deep-fried-chicken.addon64', 'their addon');
    write(game, 'nvngx_dlssnr.dll', 'model');
    await dfc.switchToDfc(game, cache, { removeOptiScaler: noOpti, fetchReShade: async (d) => write(d, 'ReShade64.dll', 'ReShade') });
    await dfc.removeDfc(game, { cacheDir: cache });
    assert.strictEqual(read(game, 'README.txt'), 'the GAME\'s readme');
    assert.strictEqual(read(game, 'LICENSE.txt'), 'the GAME\'s licence');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a takeover is claimed only after OptiScaler is out: a locked removal leaves it unclaimed', async () => {
  const base = tmp('adopt-late');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'deep-fried-chicken.addon64', 'their addon');
    write(game, 'winmm.dll', 'OptiScaler (ours)');
    write(game, 'nvngx_dlssnr.dll', 'model');
    await assert.rejects(() => dfc.switchToDfc(game, cache, {
      removeOptiScaler: async () => ({ removed: [], failed: [{ rel: 'winmm.dll', code: 'EBUSY' }] }),
      fetchReShade: async (d) => write(d, 'ReShade64.dll', 'ReShade'),
    }), /close the game/);
    assert.strictEqual(dfc.readMarker(game), null, 'no marker: the hand-copied Chicken is still theirs');
    assert.strictEqual(has(game, 'ReShade64.dll'), false, 'the fetched ReShade went again');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a switch that stopped with ReShade already in the proxy slot is finished by the next Install', async () => {
  const base = tmp('resume');
  try {
    const cache = await cacheWith(base);
    const game = path.join(base, 'game');
    // The state a stop right after the rename leaves: ReShade as dxgi.dll, recorded, no Chicken yet.
    write(game, 'Game.exe', 'x');
    write(game, 'dxgi.dll', 'ReShade (fetched)');
    write(game, 'nvngx_dlssnr.dll', 'model');
    write(game, dfc.MARKER, JSON.stringify({ files: [], reshadeProxy: 'dxgi.dll', reshadeFetched: true }));
    assert.strictEqual(dfc.reshadeProxyOf(game), 'dxgi.dll', 'the proxy reads as ours');
    await dfc.switchToDfc(game, cache, { removeOptiScaler: noOpti, fetchReShade: async () => { throw new Error('should not fetch again'); } });
    assert.ok(has(game, dfc.ADDON));
    assert.strictEqual(read(game, 'dxgi.dll'), 'ReShade (fetched)');
    assert.strictEqual(dfc.dfcOurs(game), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Game Help: Chicken beside our own OptiScaler, or where no switch is offered, keeps the remove-foreign fix', () => {
  const chicken = [{ tool: 'Deep Fried Chicken', files: ['deep-fried-chicken.addon64'] }];
  const ctx = (route) => ({ detected: { api: 'dx11', bitness: 64 }, route, run: { ran: false, verdict: 'no-log' }, foreign: chicken, fixesTried: [] });
  assert.strictEqual(diagnose(ctx({ route: 'feeder', optiInstalled: false, dfcSupport: { ok: true } })).code, 'dfc-hand-placed');
  assert.strictEqual(diagnose(ctx({ route: 'feeder', optiInstalled: true, dfcSupport: { ok: true } })).code, 'foreign', 'two neural passes: the crash fix stands');
  assert.strictEqual(diagnose(ctx({ route: 'feeder', optiInstalled: false, dfcSupport: null })).code, 'foreign', 'no switch offered here');
  // Chicken's leftovers beside a Chicken this app runs are not a finding at all.
  const own = diagnose({ ...ctx({ route: 'feeder', consumerHere: 'dfc', optiInstalled: false, dfcSupport: { ok: true }, complete: true, feederDeployed: true }), dfcState: { ran: true, state: 'ARMED' } });
  assert.strictEqual(own.code, 'dfc-here');
});

test('the route says a folder is on Chicken from the marker alone, whatever the GPU probe said', () => {
  const route = require('../src/route');
  const base = tmp('route-unknown-gpu');
  try {
    const game = path.join(base, 'game');
    write(game, 'Game.exe', 'x');
    write(game, 'deep-fried-chicken.addon64', 'x');
    write(game, dfc.MARKER, JSON.stringify({ files: ['deep-fried-chicken.addon64'] }));
    const r = route.recommendRoute(game, path.join(game, 'Game.exe'), { api: 'dx11', apis: ['dx11'], bitness: 64, recommend: 'optiscaler' }, 'unknown');
    assert.strictEqual(r.consumerHere, 'dfc');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
