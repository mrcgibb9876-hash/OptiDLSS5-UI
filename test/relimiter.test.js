'use strict';
// ReLimiter is a frame-pacing ReShade add-on (MIT, RankFTW/Lazorr/UltraMatt). MIT is why this app may
// place it at all -- Deep Fried Chicken, LumeniteFX and the AMD installer all forbid exactly that.
//
// The fact that shapes every test here: ReLimiter is DRIVEN by ReShade, not merely loaded by it. Its
// frame pipeline is ReShade's events, `present` above all, and its DoInit returns false outright with
// no ReShade module in the process. So "deployed" means the add-on AND an add-on-build ReShade, and
// the arrangement is the one the Feeder route already proved: OptiScaler keeps the proxy slot, ReShade
// goes down as a plain ReShade64.dll, [Plugins] LoadReshade=true has OptiScaler load it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain } = require(path.join(__dirname, 'helpers'));
const relimiter = require(path.join(__dirname, '..', 'src', 'relimiter'));

// A stand-in that satisfies the content check: a PE header, over the size floor, with both needles.
function fakeAddon(dir, name = 'relimiter.addon64') {
  const buf = Buffer.alloc(200 * 1024, 7);
  buf.write('MZ', 0, 'latin1');
  buf.write('ReLimiter', 1024, 'latin1');
  buf.write('AddonInit', 4096, 'latin1');
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}
// ReShade, by the same content rules feeder.js uses: over 1 MB, says ReShade, and for the add-on
// build exports ReShadeRegisterAddon.
function fakeReShade(dir, { addonBuild = true, name = 'ReShade64.dll' } = {}) {
  const buf = Buffer.alloc(2 * 1024 * 1024, 3);
  buf.write('ReShade', 512, 'latin1');
  if (addonBuild) buf.write('ReShadeRegisterAddon', 2048, 'latin1');
  fs.writeFileSync(path.join(dir, name), buf);
}

test('which games can be set up without the user doing anything by hand', () => {
  // D3D11/D3D12 is the fully automatic case and the one this work is for: a plain ReShade64.dll that
  // OptiScaler loads itself, no proxy contest.
  for (const api of ['dx11', 'dx12']) {
    assert.equal(relimiter.reshadeModeFor(api), 'local', api);
    assert.equal(relimiter.isAutomatic(api), true, api);
  }
  // OpenGL works too, with ReShade as the game's own opengl32.dll.
  assert.equal(relimiter.reshadeModeFor('opengl'), 'opengl32');
  assert.equal(relimiter.isAutomatic('opengl'), true);
  // Vulkan cannot be: ReShade only runs there as a machine-wide implicit layer registered under HKLM,
  // attaching only to exes in ReShadeApps.ini, and this app can write neither. Saying so is the point
  // -- claiming Vulkan works would send a user hunting for a fault that is not theirs.
  assert.equal(relimiter.reshadeModeFor('vulkan'), 'vulkan-layer');
  assert.equal(relimiter.isAutomatic('vulkan'), false);
});

test('an add-on is identified by its contents, never by its file name', () => {
  const dir = scratchDir('rl-identify');
  assert.equal(relimiter.isReLimiterAddon(fakeAddon(dir)), true);

  // A file with the right name and the wrong contents is refused. This app places a DLL under a name
  // ReShade will load, so "it was called relimiter.addon64" is not good enough.
  const liar = path.join(dir, 'liar.addon64');
  fs.writeFileSync(liar, Buffer.alloc(200 * 1024, 1));
  assert.equal(relimiter.isReLimiterAddon(liar), false);

  // Right strings, but far too small to be a real build -- a truncated download.
  const stub = path.join(dir, 'stub.addon64');
  const small = Buffer.alloc(2048); small.write('MZ', 0, 'latin1'); small.write('ReLimiterAddonInit', 8, 'latin1');
  fs.writeFileSync(stub, small);
  assert.equal(relimiter.isReLimiterAddon(stub), false);

  // Big enough and says ReLimiter, but is not a PE image at all.
  const notPe = path.join(dir, 'notpe.addon64');
  const b = Buffer.alloc(200 * 1024, 9); b.write('ReLimiter', 100, 'latin1'); b.write('AddonInit', 200, 'latin1');
  fs.writeFileSync(notPe, b);
  assert.equal(relimiter.isReLimiterAddon(notPe), false);

  assert.equal(relimiter.isReLimiterAddon(path.join(dir, 'nothing-here.dll')), false);
});

test('complete means the add-on AND an add-on-build ReShade, because a plain build never loads it', () => {
  const dir = scratchDir('rl-status');
  let s = relimiter.status(dir, { api: 'dx12' });
  assert.deepEqual([s.addon, s.reshade, s.complete], [false, false, false]);
  assert.deepEqual(relimiter.missing(dir, { api: 'dx12' }), ['reshade', 'addon']);

  // The plain ReShade build has the same version and product name as the add-on build and simply never
  // loads an add-on, so ReLimiter would sit in the folder doing nothing. That is not "complete".
  fakeReShade(dir, { addonBuild: false });
  s = relimiter.status(dir, { api: 'dx12' });
  assert.equal(s.reshade, true);
  assert.equal(s.reshadeIsAddonBuild, false);
  assert.equal(s.complete, false);
  assert.deepEqual(relimiter.missing(dir, { api: 'dx12' }), ['reshade-addon-build', 'addon']);

  fakeReShade(dir, { addonBuild: true });
  relimiter.deploy(dir, fakeAddon(scratchDir('rl-src')));
  s = relimiter.status(dir, { api: 'dx12' });
  assert.equal(s.complete, true);
  assert.equal(s.ours, true);
  assert.deepEqual(relimiter.missing(dir, { api: 'dx12' }), []);
});

test('a Vulkan game is never reported as complete, however many files are in place', () => {
  const dir = scratchDir('rl-vk');
  fakeReShade(dir);
  relimiter.deploy(dir, fakeAddon(scratchDir('rl-vk-src')));
  // Both files are there, and it still is not set up: the layer registration is machine-wide and ours
  // to ask for, not to write.
  assert.ok(relimiter.missing(dir, { api: 'vulkan' }).includes('vulkan-layer-registration'));
  assert.equal(relimiter.status(dir, { api: 'vulkan' }).automatic, false);
});

test('deploy refuses a file it cannot identify, and leaves the folder alone', () => {
  const dir = scratchDir('rl-refuse');
  const junk = path.join(dir, 'whatever.dll');
  fs.writeFileSync(junk, Buffer.alloc(200 * 1024, 1));
  assert.throws(() => relimiter.deploy(dir, junk), /not a ReLimiter add-on/);
  assert.equal(fs.existsSync(path.join(dir, 'relimiter.addon64')), false, 'nothing was placed');
  assert.equal(relimiter.marker(dir), null, 'no marker was written');
});

test('Remove takes back what we placed and deliberately leaves ReShade', () => {
  const dir = scratchDir('rl-remove');
  fakeReShade(dir);
  relimiter.deploy(dir, fakeAddon(scratchDir('rl-remove-src')), { version: '3.3.5' });
  assert.equal(relimiter.marker(dir).version, '3.3.5');

  const removed = relimiter.remove(dir);
  assert.ok(removed.includes('relimiter.addon64'));
  assert.ok(removed.includes('.dlss5ui-relimiter.json'));
  // ReShade stays. The Feeder route needs it and a user may have installed it for shaders -- removing
  // a dependency someone else is using is how a clean-up becomes a bug report.
  assert.equal(fs.existsSync(path.join(dir, 'ReShade64.dll')), true, 'ReShade must survive Remove');
  assert.equal(relimiter.deployed(dir), false);
  // Idempotent: removing twice is not an error.
  assert.deepEqual(relimiter.remove(dir), []);
});

test('an add-on our marker claims but that is gone from disk is told apart from never installed', () => {
  const dir = scratchDir('rl-gone');
  fakeReShade(dir);
  relimiter.deploy(dir, fakeAddon(scratchDir('rl-gone-src')));
  fs.rmSync(path.join(dir, 'relimiter.addon64'));
  const s = relimiter.status(dir, { api: 'dx12' });
  assert.equal(s.addonGone, true, 'the antivirus shape that cost Max Payne 2 a diagnosis');
  assert.equal(s.ours, true);
  // A folder that never had one is not "gone".
  assert.equal(relimiter.status(scratchDir('rl-never'), { api: 'dx12' }).addonGone, false);
});

// ── The one thing that must not run alongside it ──
//
// [DlssNr] AutoScale with AutoScaleMode 2 ("Aim at: Frame rate") moves the NR MODEL's working
// resolution until the game reaches a target frame rate. ReLimiter HOLDS the frame rate at a target by
// sleeping. Both aim at fps, and together they degrade rather than merely duplicate: ReLimiter caps the
// game, our loop reads a frame rate short of its own target, sheds model resolution to close a gap the
// limiter will never allow to close, and keeps shedding. Detail lost, nothing gained.
//
// The engine's own help for that row already says the mechanism without knowing the cause: "Frame rate
// ... the only one that can fall short -- if the game itself cannot reach the number, the panel says
// so." Under a limiter it can never reach the number.

test('only frame-rate mode conflicts -- the cost-budget modes are safe beside a limiter', () => {
  // The conflict.
  const c = relimiter.nrConflict({ autoScale: true, autoScaleMode: relimiter.NR_FPS_TARGET_MODE });
  assert.ok(c, 'AutoScale aiming at a frame rate conflicts');
  assert.equal(c.setting, 'AutoScale');
  assert.match(c.why, /frame rate/);

  // Modes 0 and 1 bound what the PASS may spend -- a share of the frame, or a flat millisecond budget.
  // Neither targets frames per second, so neither fights a frame limiter. Disabling all of AutoScale
  // would remove a feature that works perfectly well here.
  assert.equal(relimiter.nrConflict({ autoScale: true, autoScaleMode: 0 }), null, 'share-of-frame is safe');
  assert.equal(relimiter.nrConflict({ autoScale: true, autoScaleMode: 1 }), null, 'milliseconds is safe');

  // AutoScale off is no conflict whatever the mode says, because the mode is then inert.
  assert.equal(relimiter.nrConflict({ autoScale: false, autoScaleMode: 2 }), null);
  assert.equal(relimiter.nrConflict({}), null);
  assert.equal(relimiter.nrConflict(), null);

  // Values read from an ini are strings, which is how they will actually arrive.
  assert.ok(relimiter.nrConflict({ autoScale: 'true', autoScaleMode: '2' }), 'string values from the ini');
  assert.equal(relimiter.nrConflict({ autoScale: 'false', autoScaleMode: '2' }), null);
});

test('ours is the setting that gives way, and only that one', () => {
  // The user deployed a frame pacer to pace frames, so ReLimiter keeps its target and AutoScale goes
  // off. Nothing of ReLimiter's is touched -- reaching into another tool's config to win an argument
  // it does not know it is having would be worse than the conflict.
  assert.deepEqual(relimiter.NR_CONFLICT_EDITS, [{ section: 'DlssNr', key: 'AutoScale', value: 'false' }]);
  const touched = relimiter.NR_CONFLICT_EDITS.map((e) => e.section);
  assert.ok(!touched.includes('ReLimiter'), "ReLimiter's own settings are not ours to rewrite");
  // AutoScaleFps is deliberately left alone: the number the user chose is still their number, and it
  // comes back meaning what it meant if they turn AutoScale on again after removing ReLimiter.
  assert.ok(!relimiter.NR_CONFLICT_EDITS.some((e) => e.key === 'AutoScaleFps'));
});

// A real PE whose version resource names it ReShade: notepad.exe with its OriginalFilename
// rewritten in place (NOTEPAD.EXE and RESHADE.DLL are the same length), padded past ReShade's size
// floor and carrying the add-on export's name. Windows only, because that is where notepad.exe is.
const NOTEPAD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
const canFakePe = process.platform === 'win32' && fs.existsSync(NOTEPAD);
function realishReShade(dir, name) {
  const buf = fs.readFileSync(NOTEPAD);
  const at = buf.indexOf(Buffer.from('NOTEPAD.EXE', 'utf16le'));
  Buffer.from('RESHADE.DLL', 'utf16le').copy(buf, at);
  const pad = Buffer.alloc(2 * 1024 * 1024, 0);
  pad.write('ReShade ReShadeRegisterAddon', 64, 'latin1');
  fs.writeFileSync(path.join(dir, name), Buffer.concat([buf, pad]));
}

test('ReShade in a proxy slot is recognised by its version resource, and OptiScaler never is', { skip: !canFakePe }, () => {
  const dir = scratchDir('rl-proxy-identity');
  realishReShade(dir, 'dxgi.dll');
  assert.equal(relimiter.isReShadeProxy(path.join(dir, 'dxgi.dll')), true);
  // OptiScaler carries the string "ReShade" (LoadReshade) and is megabytes, so the loose check
  // feeder.isReShadeDll would take it. This one decides what is renamed in a proxy slot.
  const opti = Buffer.alloc(2 * 1024 * 1024, 5);
  opti.write('OptiScaler LoadReshade ReShade', 128, 'latin1');
  fs.writeFileSync(path.join(dir, 'winmm.dll'), opti);
  assert.equal(relimiter.isReShadeProxy(path.join(dir, 'winmm.dll')), false);
});

test('a game with no OptiScaler gets ReShade as its proxy, and it moves back when DLSS 5 arrives', { skip: !canFakePe }, () => {
  const dir = scratchDir('rl-standalone');
  realishReShade(dir, 'ReShade64.dll');
  assert.equal(relimiter.standaloneProxyName('dx12'), 'dxgi.dll');
  assert.equal(relimiter.standaloneProxyName('dx9'), 'd3d9.dll');

  relimiter.promoteToStandalone(dir, 'dx12');
  assert.equal(fs.existsSync(path.join(dir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(dir, 'ReShade64.dll')), false, 'one ReShade, not two');
  relimiter.deploy(dir, fakeAddon(scratchDir('rl-standalone-src')), { version: 'v1' });
  const st = relimiter.status(dir, { api: 'dx12' });
  assert.equal(st.standalone, true, 'the deploy kept the proxy on record');
  assert.equal(st.reshadeFile, 'dxgi.dll');
  assert.equal(st.complete, true);

  // DLSS 5 installing: OptiScaler takes the slot, so ReShade goes back to where OptiScaler loads it.
  assert.equal(relimiter.demoteStandaloneReShade(dir), 'dxgi.dll');
  assert.equal(fs.existsSync(path.join(dir, 'dxgi.dll')), false);
  assert.equal(fs.existsSync(path.join(dir, 'ReShade64.dll')), true);
  assert.equal(relimiter.status(dir, { api: 'dx12' }).standalone, false);
  assert.equal(relimiter.status(dir, { api: 'dx12' }).complete, true);
});

test('a proxy slot holding something else is refused, not overwritten', { skip: !canFakePe }, () => {
  const dir = scratchDir('rl-standalone-taken');
  realishReShade(dir, 'ReShade64.dll');
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'somebody else\'s dxgi');
  assert.throws(() => relimiter.promoteToStandalone(dir, 'dx12'), (e) => e.code === 'proxy-taken');
  assert.equal(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'utf8'), 'somebody else\'s dxgi');
});

test('Remove takes back a standalone ReShade it placed, because nothing else loads it', { skip: !canFakePe }, () => {
  const dir = scratchDir('rl-standalone-remove');
  realishReShade(dir, 'ReShade64.dll');
  relimiter.promoteToStandalone(dir, 'dx11');
  relimiter.deploy(dir, fakeAddon(scratchDir('rl-standalone-remove-src')));
  const removed = relimiter.remove(dir);
  assert.ok(removed.includes('dxgi.dll'));
  assert.deepEqual(fs.readdirSync(dir).sort(), []);
});

test('the fork is tried first for its host API, and upstream stands in when it has no release', async () => {
  const calls = [];
  const release = (tag) => ({ tag_name: tag, assets: [
    { name: 'relimiter.addon32', browser_download_url: `https://github.com/x/y/releases/download/${tag}/relimiter.addon32` },
    { name: 'relimiter.addon64', browser_download_url: `https://github.com/x/y/releases/download/${tag}/relimiter.addon64`, digest: `sha256:${'a'.repeat(64)}` },
  ] });
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('mrcgibb9876-hash')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => release('v3.3.5') };
  };
  const got = await relimiter.resolveAddonAsset({}, { fetchImpl });
  assert.equal(got.repo, 'RankFTW/ReLimiter');
  assert.equal(got.hostApi, false);
  assert.equal(got.name, 'relimiter.addon64');
  assert.equal(got.digest, 'a'.repeat(64));
  assert.match(calls[0], /mrcgibb9876-hash/, 'the fork is asked first');

  const fork = await relimiter.resolveAddonAsset({}, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => release('v3.4.0') }) });
  assert.equal(fork.repo, 'mrcgibb9876-hash/ReLimiter');
  assert.equal(fork.hostApi, true);

  await assert.rejects(relimiter.resolveAddonAsset({}, { fetchImpl: async () => ({ ok: false, status: 500 }) }), /No ReLimiter build/);
});

test('ReShade.ini is pointed at the add-on and un-disables ReLimiter, keeping the rest', () => {
  const dir = scratchDir('rl-reshade-ini');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[ADDON]\nDisabledAddons=ReLimiter,Other\n[GENERAL]\nMine=1\n');
  relimiter.configureReShadeIni(dir);
  const ini = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
  assert.match(ini, /DisabledAddons=Other/);
  assert.match(ini, /AddonPath=\.\\/);
  assert.match(ini, /Mine=1/);
});

// Deep Fried Chicken: OptiScaler is out and Chicken's own ReShade is the proxy. ReLimiter is one more
// add-on on it, and nothing about pacing may ever move or delete that ReShade.
test('on a Chicken game the add-on rides on Chicken\'s ReShade, and Remove never takes it', () => {
  const dir = scratchDir('rl-chicken');
  fakeReShade(dir, { name: 'dxgi.dll' });
  fs.writeFileSync(path.join(dir, '.dlss5ui-dfc.json'), JSON.stringify({ reshadeProxy: 'dxgi.dll' }));
  relimiter.deploy(dir, fakeAddon(scratchDir('rl-chicken-src')));
  const st = relimiter.status(dir, { api: 'dx12' });
  assert.equal(st.chicken, true);
  assert.equal(st.reshadeFile, 'dxgi.dll');
  assert.equal(st.standalone, false, 'Chicken\'s ReShade is never recorded as our standalone one');
  assert.equal(st.complete, true);
  // Even a marker that somehow claims that slot does not get it deleted.
  relimiter.writeMarker(dir, { reshadeProxy: 'dxgi.dll', reshadePlaced: true });
  relimiter.remove(dir);
  assert.equal(fs.existsSync(path.join(dir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(dir, 'relimiter.addon64')), false);
});

test('a ReShade64.dll frame pacing placed is one Chicken\'s swap may take over, and only that one', { skip: !canFakePe }, () => {
  const dir = scratchDir('rl-placed');
  realishReShade(dir, 'ReShade64.dll');
  assert.equal(relimiter.placedReShade(dir), false, 'not recorded: somebody else\'s');
  relimiter.writeMarker(dir, { reshadePlaced: true });
  assert.equal(relimiter.placedReShade(dir), true);
  // While it stands in the proxy slot it is not ReShade64.dll at all.
  relimiter.promoteToStandalone(dir, 'dx12');
  assert.equal(relimiter.placedReShade(dir), false);
  relimiter.demoteStandaloneReShade(dir);
  assert.equal(relimiter.placedReShade(dir), true);
});

// Shadow of the Tomb Raider, 2026-09-24: ReShade loaded by OptiScaler with any add-on in it crashes the
// moment DLSS starts on the game's own device. So pacing never goes in beside OptiScaler's upscaler,
// and installing DLSS 5 on a game that already has pacing takes pacing out rather than crash it.
test('frame pacing is refused beside DLSS 5 on a non-Feeder game, before anything is placed', { skip: !canFakePe }, async () => {
  const base = scratchDir('rl-refuse');
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  fs.writeFileSync(path.join(game, 'nvngx_dlss.dll'), 'the game own DLSS, as SOTTR ships it');
  const release = fakeReleaseFolder(path.join(base, 'release'));
  fakeNrModel(path.join(base, 'model'));
  const { invoke } = loadMain({});
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: path.join(base, 'model', 'nvngx_dlssnr.dll') });
  assert.equal(inst.ok, true, inst.error);
  // Install tidies a stand-in nvngx_dlss.dll away, so the game's own DLSS is put back after it.
  fs.writeFileSync(path.join(game, 'nvngx_dlss.dll'), 'the game own DLSS, as SOTTR ships it');
  const before = fs.readdirSync(game).sort();
  const r = await invoke('relimiter:install', exe);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'reshade-dlss-crash');
  assert.deepEqual(fs.readdirSync(game).sort(), before, 'nothing placed');
});

test('installing DLSS 5 on a game with standalone pacing takes pacing out, and says so', { skip: !canFakePe }, async () => {
  const base = scratchDir('rl-then-dlss5');
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  fs.writeFileSync(path.join(game, 'nvngx_dlss.dll'), 'the game own DLSS, as SOTTR ships it');
  realishReShade(game, 'ReShade64.dll');
  relimiter.writeMarker(game, { reshadePlaced: true });
  relimiter.promoteToStandalone(game, 'dx12');
  relimiter.deploy(game, fakeAddon(scratchDir('rl-then-dlss5-src')));
  const release = fakeReleaseFolder(path.join(base, 'release'));
  fakeNrModel(path.join(base, 'model'));
  const { invoke } = loadMain({});
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: path.join(base, 'model', 'nvngx_dlssnr.dll') });
  assert.equal(inst.ok, true, inst.error);
  assert.ok(inst.pacingRemoved && inst.pacingRemoved.includes('relimiter.addon64'), 'reported');
  assert.equal(fs.existsSync(path.join(game, 'relimiter.addon64')), false);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), false, 'our standalone ReShade went with it');
  assert.equal(inst.proxy && inst.proxy.proxy, 'dxgi.dll', 'OptiScaler has the slot');
  const ini = fs.readFileSync(path.join(game, 'OptiScaler.ini'), 'utf8');
  assert.doesNotMatch(ini, /^LoadReshade\s*=\s*true/m);
});
