'use strict';
// The swap between this app's engine and Deep Fried Chicken on a Feeder game (src/dfc.js
// switchToDfc / removeDfc).
//
// The first version deployed Chicken and left OptiScaler in the folder, only reporting it. Tried
// against the real Chicken 3.0 (2026-09-22), that folder could never run: with OptiScaler in, two
// neural passes; with it out, nothing loaded ReShade -- on this app's Feeder route ReShade is a plain
// ReShade64.dll that only OptiScaler loads ([Plugins] LoadReshade=true). The swap now does the whole
// move, both ways, and refuses before touching anything when it could not finish.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dfc = require('../src/dfc');
const feeder = require('../src/feeder');
const { foreignToolchains } = require('../src/detect');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dlss5ui-dfcswap-${name}-`));
}

// The user's own copy: the two payload files plus the cfg and licence it ships.
function fakeDfcFolder(base, { cfg = 'enabled=1\npasses=1\n' } = {}) {
  const dir = path.join(base, 'chicken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, dfc.ADDON), 'fake chicken addon');
  fs.writeFileSync(path.join(dir, dfc.NVNGX), 'fake chicken nvngx');
  fs.writeFileSync(path.join(dir, dfc.CFG), cfg);
  fs.writeFileSync(path.join(dir, dfc.LICENSE), 'their licence, not ours');
  return dir;
}

async function suppliedCache(base, opts) {
  const cache = path.join(base, 'cache');
  await dfc.importDfcSource(fakeDfcFolder(base, opts), cache);
  return cache;
}

// An installed D3D11/12 Feeder-route game: OptiScaler as dxgi.dll loading a plain ReShade64.dll.
function feederRouteGame(base) {
  const game = path.join(base, 'game');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'Game.exe'), 'x');
  fs.writeFileSync(path.join(game, 'dxgi.dll'), 'OptiScaler build (loads ReShade64.dll)');
  fs.writeFileSync(path.join(game, 'OptiScaler.ini'), '[Plugins]\nLoadReshade=true\n');
  fs.writeFileSync(path.join(game, 'ReShade64.dll'), 'ReShade 6.x add-on build');
  fs.writeFileSync(path.join(game, 'dlss5-feed.addon64'), 'feeder');
  fs.writeFileSync(path.join(game, 'nvngx_dlss.dll'), 'dlss');
  fs.writeFileSync(path.join(game, 'nvngx_dlssnr.dll'), 'NR model');
  fs.writeFileSync(path.join(game, '.optiscaler-manager-install.json'), JSON.stringify({ added: ['OptiScaler.ini'], proxy: 'dxgi.dll' }));
  return game;
}

// What main.js's uninstallOptiScaler does to that folder: the proxy, the ini, the journal and the model.
async function fakeRemoveOptiScaler(dir) {
  const removed = [];
  for (const n of ['dxgi.dll', 'OptiScaler.ini', '.optiscaler-manager-install.json', 'nvngx_dlssnr.dll']) {
    if (fs.existsSync(path.join(dir, n))) { fs.rmSync(path.join(dir, n)); removed.push(n); }
  }
  return { removed, kept: [], failed: [] };
}

function modelFile(base, text = 'NR model from Settings') {
  const f = path.join(base, `model-${Math.random().toString(36).slice(2)}.dll`);
  fs.writeFileSync(f, text);
  return f;
}

test('switching to Chicken takes OptiScaler out and makes ReShade load itself, with the NR model beside Chicken', async () => {
  const base = tmp('in');
  try {
    const cache = await suppliedCache(base);
    const game = feederRouteGame(base);

    const r = await dfc.switchToDfc(game, cache, { nrDllPath: modelFile(base), removeOptiScaler: fakeRemoveOptiScaler });
    assert.strictEqual(r.deployed, true);
    assert.strictEqual(fs.readFileSync(path.join(game, 'dxgi.dll'), 'utf8'), 'ReShade 6.x add-on build', 'ReShade is the proxy now');
    assert.strictEqual(fs.existsSync(path.join(game, 'ReShade64.dll')), false, 'and there is no second copy of it');
    assert.strictEqual(fs.existsSync(path.join(game, 'OptiScaler.ini')), false, 'OptiScaler is out: one neural pass');
    assert.strictEqual(fs.readFileSync(path.join(game, 'nvngx_dlssnr.dll'), 'utf8'), 'NR model from Settings', 'Chicken has its model');
    assert.strictEqual(fs.existsSync(path.join(game, 'dlss5-feed.addon64')), true, 'the Feeder stays');
    assert.strictEqual(dfc.reshadeProxyOf(game), 'dxgi.dll');
    const m = dfc.readMarker(game);
    assert.strictEqual(m.reshadeProxy, 'dxgi.dll');
    assert.strictEqual(m.nrPlaced, true);
    assert.deepStrictEqual(foreignToolchains(game), [], 'nothing of ours reads as a foreign stack');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('switching back puts ReShade under its plain name for OptiScaler, and keeps the player\'s Chicken settings', async () => {
  const base = tmp('back');
  try {
    const cache = await suppliedCache(base, { cfg: 'passes=1\n' });
    const game = feederRouteGame(base);
    await dfc.switchToDfc(game, cache, { removeOptiScaler: fakeRemoveOptiScaler, nrDllPath: modelFile(base) });
    fs.writeFileSync(path.join(game, dfc.CFG), 'passes=6\n');

    const back = await dfc.removeDfc(game, { cacheDir: cache });
    assert.deepStrictEqual(back.failed, []);
    assert.strictEqual(fs.readFileSync(path.join(game, 'ReShade64.dll'), 'utf8'), 'ReShade 6.x add-on build', 'ReShade is back for OptiScaler to load');
    assert.strictEqual(fs.existsSync(path.join(game, 'dxgi.dll')), false, 'the proxy slot is free for OptiScaler again');
    for (const n of [dfc.ADDON, dfc.NVNGX, dfc.CFG, dfc.LICENSE, dfc.MARKER]) {
      assert.strictEqual(fs.existsSync(path.join(game, n)), false, `${n} is gone`);
    }
    assert.deepStrictEqual(foreignToolchains(game), [], 'and nothing of Chicken\'s is left to be called foreign');

    // Back to Chicken (OptiScaler reinstalled in between): their settings come with it.
    fs.writeFileSync(path.join(game, 'dxgi.dll'), 'OptiScaler build');
    const again = await dfc.switchToDfc(game, cache, { removeOptiScaler: fakeRemoveOptiScaler, nrDllPath: modelFile(base) });
    assert.strictEqual(again.restoredCfg, true);
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.CFG), 'utf8'), 'passes=6\n', 'the tuned cfg, not the shipped one');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a swap that would have to refuse refuses before anything is touched', async () => {
  const base = tmp('refuse');
  try {
    const cache = await suppliedCache(base);
    let removed = 0;
    const remove = async (dir) => { removed++; return fakeRemoveOptiScaler(dir); };
    const snapshot = (dir) => fs.readdirSync(dir).sort().join(',');

    // No NR model anywhere.
    const g1 = feederRouteGame(path.join(base, 'a'));
    fs.rmSync(path.join(g1, 'nvngx_dlssnr.dll'));
    const s1 = snapshot(g1);
    await assert.rejects(() => dfc.switchToDfc(g1, cache, { removeOptiScaler: remove }), /NR model/);
    assert.strictEqual(snapshot(g1), s1);

    // The game's own dxgi.dll was set aside by the DLSS 5 install and would come back.
    const g2 = feederRouteGame(path.join(base, 'b'));
    fs.writeFileSync(path.join(g2, '.optiscaler-manager-install.json'), JSON.stringify({ proxy: 'dxgi.dll', backedUp: 'dxgi.dll.bak' }));
    const s2 = snapshot(g2);
    await assert.rejects(() => dfc.switchToDfc(g2, cache, { removeOptiScaler: remove }), /set aside/);
    assert.strictEqual(snapshot(g2), s2);

    // Somebody else's dxgi.dll that is neither ReShade nor OptiScaler.
    const g3 = feederRouteGame(path.join(base, 'c'));
    fs.writeFileSync(path.join(g3, 'dxgi.dll'), 'a wrapper of theirs');
    await assert.rejects(() => dfc.switchToDfc(g3, cache, { removeOptiScaler: remove }), /not this app's/);
    assert.strictEqual(fs.readFileSync(path.join(g3, 'dxgi.dll'), 'utf8'), 'a wrapper of theirs');

    // A Chicken copied in by hand.
    const g4 = feederRouteGame(path.join(base, 'd'));
    fs.writeFileSync(path.join(g4, dfc.ADDON), 'THEIR addon');
    await assert.rejects(() => dfc.switchToDfc(g4, cache, { removeOptiScaler: remove }), /copied in by hand/);

    // No copy supplied at all.
    const g5 = feederRouteGame(path.join(base, 'e'));
    await assert.rejects(() => dfc.switchToDfc(g5, path.join(base, 'empty-cache'), { removeOptiScaler: remove }), /has been added/);

    assert.strictEqual(removed, 0, 'OptiScaler was never taken out for a swap that could not finish');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a failed OptiScaler removal stops the swap with ReShade still where OptiScaler loads it', async () => {
  const base = tmp('locked');
  try {
    const cache = await suppliedCache(base);
    const game = feederRouteGame(base);
    const locked = async () => ({ removed: [], kept: [], failed: [{ rel: 'dxgi.dll', code: 'EBUSY' }] });
    await assert.rejects(() => dfc.switchToDfc(game, cache, { removeOptiScaler: locked, nrDllPath: modelFile(base) }), /close the game/);
    assert.strictEqual(fs.existsSync(path.join(game, 'ReShade64.dll')), true);
    assert.strictEqual(dfc.dfcPresent(game), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a second deploy does not forget the cfg and documents, so Remove leaves nothing behind', async () => {
  // Found against the real 3.0 files: the second deploy's marker listed only the two binaries, and
  // Remove then left the cfg, README and licence -- the cfg reading as a foreign Chicken install.
  const base = tmp('redeploy');
  try {
    const cache = await suppliedCache(base);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);
    await dfc.deployDfc(game, cache);
    await dfc.deployDfc(game, cache);
    assert.ok(dfc.readMarker(game).files.includes(dfc.CFG), 'the cfg is still ours after a re-deploy');
    await dfc.removeDfc(game);
    assert.deepStrictEqual(fs.readdirSync(game), []);
    assert.deepStrictEqual(foreignToolchains(game), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('uninstall takes ReShade out of the proxy slot rather than renaming it back', async () => {
  const base = tmp('uninstall');
  try {
    const cache = await suppliedCache(base);
    const game = feederRouteGame(base);
    await dfc.switchToDfc(game, cache, { removeOptiScaler: fakeRemoveOptiScaler, nrDllPath: modelFile(base) });
    const r = await dfc.removeDfc(game, { cacheDir: cache, uninstall: true });
    assert.deepStrictEqual(r.failed, []);
    assert.strictEqual(fs.existsSync(path.join(game, 'dxgi.dll')), false);
    assert.strictEqual(fs.existsSync(path.join(game, 'ReShade64.dll')), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('an OptiScaler in the proxy slot is never taken for ReShade', async () => {
  // OptiScaler's own DLL carries the word ReShade (it loads it). A leftover marker must not make a
  // ReShade update overwrite it, or Remove rename it.
  const base = tmp('not-reshade');
  try {
    const game = path.join(base, 'game');
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, 'dxgi.dll'), 'OptiScaler build that loads ReShade64.dll');
    fs.writeFileSync(path.join(game, dfc.MARKER), JSON.stringify({ files: [], reshadeProxy: 'dxgi.dll' }));
    assert.strictEqual(dfc.reshadeProxyOf(game), null);
    await dfc.removeDfc(game, { cacheDir: path.join(base, 'cache') });
    assert.strictEqual(fs.readFileSync(path.join(game, 'dxgi.dll'), 'utf8'), 'OptiScaler build that loads ReShade64.dll');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the swap is offered for 64-bit Direct3D 11/12 only, and says why elsewhere', () => {
  assert.strictEqual(dfc.supportedFor({ api: 'dx11', bitness: 64 }).ok, true);
  assert.strictEqual(dfc.supportedFor({ api: 'dx12', bitness: 64 }).ok, true);
  // Chicken 3.0 brings its own feeder on Vulkan/OpenGL: "Do not install another neural feeder alongside".
  assert.strictEqual(dfc.supportedFor({ api: 'vulkan', bitness: 64 }).code, 'dfc-vulkan-opengl');
  assert.strictEqual(dfc.supportedFor({ api: 'opengl', bitness: 64 }).code, 'dfc-vulkan-opengl');
  assert.strictEqual(dfc.supportedFor({ api: 'dx11', bitness: 32 }).code, 'dfc-32bit');
  assert.strictEqual(dfc.supportedFor({ api: 'dx9', bitness: 64 }).code, 'dfc-api');
});

test('Chicken\'s protected .7z is refused with what to do, not "not a zip"', async () => {
  const base = tmp('7z');
  try {
    const archive = path.join(base, 'Deep-Fried-Chicken-v3.0.0.7z');
    fs.writeFileSync(archive, '7z');
    await assert.rejects(() => dfc.importDfcSource(archive, path.join(base, 'cache')), /unpack it first/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the Feeder counts ReShade in the proxy slot as installed, so it does not deploy a second one', async () => {
  const base = tmp('feeder-proxy');
  try {
    const cache = await suppliedCache(base);
    const game = feederRouteGame(base);
    await dfc.switchToDfc(game, cache, { removeOptiScaler: fakeRemoveOptiScaler, nrDllPath: modelFile(base) });
    const r = await feeder.feederReadiness(game, 'dx11');
    assert.strictEqual(r.reshadeInstalled, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Install is the swap: it passes the choice, and Chicken never gets OptiScaler installed on top', () => {
  // Source-checked: the renderer has no test DOM for installGame.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('async function installGame(game)');
  const body = src.slice(at, src.indexOf("toast(t('Installing…'));", at));
  assert.match(body, /consumer, nrDllPath: settings\.nrDllPath, swapOnly: route\.feederDeployed/, 'the choice reaches the deploy');
  assert.match(body, /consumerHere[\s\S]*!== consumer/, 'a folder set up for the other one is swapped');
  assert.match(body, /deployed\.ok && consumer === 'dfc'[\s\S]*?return;/, 'and a Chicken install stops before OptiScaler');
  // A game already on Chicken still goes through the (idempotent) swap, never on to the OptiScaler
  // install below it -- found in the real app, 2026-09-22.
  assert.match(body, /!route\.feederDeployed \|\| swapNeeded \|\| consumer === 'dfc'/);
});

test('Game Help on a Chicken game reads Chicken\'s state, and never says "not installed"', () => {
  // "not installed" there sent Install to put OptiScaler back on top of Chicken.
  const { diagnose } = require('../src/gamehelp');
  const ctx = (state) => ({
    detected: { api: 'dx11', bitness: 64 },
    route: { route: 'feeder', consumerHere: 'dfc', optiInstalled: false, feederDeployed: true, complete: true },
    run: { ran: false, verdict: 'no-log' }, foreign: [], fixesTried: [],
    dfcState: state ? { ran: true, state } : { ran: false, state: null },
  });
  assert.deepStrictEqual([diagnose(ctx('ARMED')).status, diagnose(ctx('ARMED')).code], ['ok', 'dfc-here']);
  assert.deepStrictEqual([diagnose(ctx('CONFLICT')).status, diagnose(ctx('CONFLICT')).vars.state], ['step', 'CONFLICT']);
  assert.strictEqual(diagnose(ctx(null)).code, 'dfc-here');
});
