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
const { scratchDir } = require(path.join(__dirname, 'helpers'));
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
