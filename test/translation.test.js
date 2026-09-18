'use strict';
// The translation-layer manager (translation.js): which wrapper is in front of a legacy game, and
// removing one without taking the folder's other tenants with it.
//
// Every case here is drawn from one real support bundle -- SWTOR, issue #50, 2026-09-17 -- whose
// game folder held both wrappers at once: dgVoodoo2's D3D9.dll live at 564 KB, DXVK's buried
// underneath as D3D9.dll.dlss5ui-orig at 7.2 MB, DXVK's dxgi.dll buried again as
// dxgi.optiscaler_original_backup, a hand-made "d3d9 - Copy.dll", and a one-byte dxvk.conf this
// app wrote while dgVoodoo2 was the live wrapper.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write } = require('./helpers');
const translation = require(path.join(REPO, 'src', 'translation'));

// A DLL big enough to look real, carrying the signature the identifier looks for.
const dll = (signature) => `MZ${'\0'.repeat(64)}${signature}${'x'.repeat(4096)}`;

test('a wrapper is identified by what is in it, never by its name', () => {
  const dir = scratchDir('tl-identify');
  write(dir, 'd3d9.dll', dll('dgVoodoo'));
  write(dir, 'dxgi.dll', dll('OptiScaler'));
  write(dir, 'd3d11.dll', dll('DXVK'));
  write(dir, 'opengl32.dll', dll('ReShade'));
  write(dir, 'binkw64.dll', dll('Bink Video'));
  write(dir, 'dgVoodoo.conf', '[General]');

  const id = (f) => translation.identifyWrapper(path.join(dir, f));
  assert.equal(id('d3d9.dll'), 'dgvoodoo', 'the same filename DXVK also uses');
  assert.equal(id('d3d11.dll'), 'dxvk');
  assert.equal(id('dgVoodoo.conf'), 'dgvoodoo', 'only dgVoodoo2 ever writes this name');

  // The two that must never be mistaken for a wrapper: OptiScaler installs as dxgi.dll, and
  // ReShade takes d3d9.dll or opengl32.dll on its own routes.
  assert.equal(id('dxgi.dll'), 'optiscaler', 'dxgi.dll is in DXVK\'s file set AND is our proxy name');
  assert.equal(id('opengl32.dll'), 'reshade');
  assert.equal(id('binkw64.dll'), null, 'a game\'s own DLL claims nothing');
});

test('purging one layer leaves OptiScaler, ReShade and the game\'s own files where they are', async () => {
  const dir = scratchDir('tl-purge-safe');
  write(dir, 'D3D9.dll', dll('dgVoodoo'));
  write(dir, 'dgVoodoo.conf', '[General]');
  write(dir, 'dgVoodooCpl.exe', 'MZ cpl');
  write(dir, 'ddraw.dll', dll('ReShade'));             // dgVoodoo2's own set, but not dgVoodoo2
  write(dir, 'dxgi.dll', dll('OptiScaler'));          // DXVK's set, so untouched by this purge
  write(dir, 'binkw64.dll', dll('Bink Video'));

  const out = await translation.purgeTranslationLayer(dir, { layer: 'dgvoodoo' });

  assert.deepEqual(out.removed.sort(), ['D3D9.dll', 'dgVoodoo.conf', 'dgVoodooCpl.exe'].sort());
  assert.ok(fs.existsSync(path.join(dir, 'ddraw.dll')), 'ReShade under a dgVoodoo2 filename is not ours to remove');
  assert.ok(fs.existsSync(path.join(dir, 'dxgi.dll')), 'OptiScaler is untouched');
  assert.ok(fs.existsSync(path.join(dir, 'binkw64.dll')), 'the game keeps its own DLLs');

  const why = Object.fromEntries(out.skipped.map((s) => [s.file, s.reason]));
  assert.match(why['ddraw.dll'], /reshade/, 'and the reason says what it actually is');
});

test('purging puts back what the layer displaced, so the folder is stock and not merely empty', async () => {
  // The SWTOR case exactly: the player had DXVK's d3d9.dll, our dgVoodoo2 deploy backed it up and
  // took the name. Removing dgVoodoo2 has to give DXVK back, or the game loses its renderer.
  const dir = scratchDir('tl-restore');
  write(dir, 'D3D9.dll', dll('dgVoodoo'));
  write(dir, 'D3D9.dll.dlss5ui-orig', dll('DXVK'));
  write(dir, 'dgVoodoo.conf', '[General]');
  translation.writeManifest(dir, translation.newManifest({
    layer: 'dgvoodoo',
    arch: 'x64',
    source: 'dgVoodoo2_87_4',
    files: ['D3D9.dll', 'dgVoodoo.conf'],
    backups: [{ rel: 'D3D9.dll', backup: 'D3D9.dll.dlss5ui-orig' }],
  }));

  const out = await translation.purgeTranslationLayer(dir, { layer: 'dgvoodoo' });

  assert.deepEqual(out.restored, ['D3D9.dll']);
  assert.equal(translation.identifyWrapper(path.join(dir, 'D3D9.dll')), 'dxvk', 'DXVK is back under its own name');
  assert.ok(!fs.existsSync(path.join(dir, 'D3D9.dll.dlss5ui-orig')), 'the backup is consumed, not left to rot');
  assert.ok(!fs.existsSync(path.join(dir, translation.MANIFEST)), 'and the manifest goes with it');
});

test('the manifest decides which layer is in charge, not a guess at the folder', () => {
  const dir = scratchDir('tl-active');
  assert.equal(translation.activeLayer(dir).layer, null, 'a stock folder has no layer');

  // A wrapper a player put there by hand: found by reading it, and marked as not ours.
  write(dir, 'd3d9.dll', dll('DXVK'));
  const found = translation.activeLayer(dir);
  assert.equal(found.layer, 'dxvk');
  assert.equal(found.ours, false);
  assert.equal(found.foundAs, 'd3d9.dll');

  // Once we deploy, the record answers instead of the folder.
  translation.writeManifest(dir, translation.newManifest({ layer: 'dxvk', arch: 'x64', files: ['d3d9.dll'] }));
  const ours = translation.activeLayer(dir);
  assert.equal(ours.layer, 'dxvk');
  assert.equal(ours.ours, true);
  assert.equal(ours.manifest.arch, 'x64');
});

test('a dgVoodoo2 deploy from before this module is read as one, not treated as a stock folder', () => {
  // Folders in the wild carry legacy.js's .dlss5ui-legacy.json and nothing else. Reading it is what
  // lets the guard in native-dlss.js know a translation layer is in front of the game.
  const dir = scratchDir('tl-back-compat');
  write(dir, '.dlss5ui-legacy.json', JSON.stringify({
    version: 1,
    files: ['dgVoodooCpl.exe', 'dgVoodoo.conf'],
    backups: [{ rel: 'D3D9.dll', backup: 'D3D9.dll.dlss5ui-orig' }],
    dgVoodoo: { arch: 'x64', dll: 'D3D9.dll', source: 'dgVoodoo2_87_4' },
    placedAt: '2026-09-17T07:01:54.914Z',
  }));

  const m = translation.readManifest(dir);
  assert.equal(m.layer, 'dgvoodoo');
  assert.equal(m.arch, 'x64');
  assert.equal(m.fromLegacyMarker, true);
  assert.equal(translation.activeLayer(dir).layer, 'dgvoodoo');
});

test('the two layers can never share a folder', () => {
  const dir = scratchDir('tl-exclusive');
  assert.deepEqual(translation.canDeploy(dir, 'dxvk'), { ok: true, purgeFirst: false, conflict: null });

  // Ours: replaceable, but only after a purge.
  translation.writeManifest(dir, translation.newManifest({ layer: 'dgvoodoo', files: ['D3D9.dll'] }));
  write(dir, 'D3D9.dll', dll('dgVoodoo'));
  const overOurs = translation.canDeploy(dir, 'dxvk');
  assert.equal(overOurs.ok, true);
  assert.equal(overOurs.purgeFirst, true);
  assert.equal(overOurs.conflict, 'dgvoodoo');

  // Someone else's: refused, with a reason naming the file, rather than silently buried. Burying
  // it is what produced the SWTOR folder this module exists for.
  fs.rmSync(path.join(dir, translation.MANIFEST));
  const overTheirs = translation.canDeploy(dir, 'dxvk');
  assert.equal(overTheirs.ok, false);
  assert.equal(overTheirs.conflict, 'dgvoodoo');
  assert.match(overTheirs.reason, /did not put it there/);
  assert.match(overTheirs.reason, /D3D9\.dll/i);
});

test('DXVK\'s d3d8.dll is part of its set, and the two layers both claiming that name is resolved by contents', async () => {
  // DXVK 3.x ships d3d8.dll: the v3.1.1 release has x32/ and x64/, each with d3d8, d3d9, d3d10core,
  // d3d11 and dxgi. dgVoodoo2 owns a d3d8.dll too, so the name alone settles nothing.
  const dxvkDir = scratchDir('tl-d3d8-dxvk');
  write(dxvkDir, 'd3d8.dll', dll('DXVK'));
  assert.equal(translation.activeLayer(dxvkDir).layer, 'dxvk', 'a DXVK d3d8.dll is DXVK');
  const gone = await translation.purgeTranslationLayer(dxvkDir, { layer: 'dxvk' });
  assert.deepEqual(gone.removed, ['d3d8.dll'], 'and a DXVK purge takes it');

  const dgDir = scratchDir('tl-d3d8-dg');
  write(dgDir, 'd3d8.dll', dll('dgVoodoo'));
  assert.equal(translation.activeLayer(dgDir).layer, 'dgvoodoo', 'the same name from dgVoodoo2 is dgVoodoo2');
  const kept = await translation.purgeTranslationLayer(dgDir, { layer: 'dxvk' });
  assert.deepEqual(kept.removed, [], 'so a DXVK purge leaves it alone');
  assert.match(kept.skipped.find((x) => x.file === 'd3d8.dll').reason, /dgvoodoo/);
});

test('a purge with no layer named resets the folder to stock, which is what a retry needs', async () => {
  const dir = scratchDir('tl-purge-all');
  write(dir, 'D3D9.dll', dll('dgVoodoo'));
  write(dir, 'dgVoodoo.conf', '[General]');
  write(dir, 'd3d11.dll', dll('DXVK'));
  write(dir, 'dxvk.conf', 'dxvk.allowFse = False');
  write(dir, 'dxgi.dll', dll('OptiScaler'));

  const out = await translation.purgeTranslationLayer(dir);
  assert.deepEqual(out.removed.sort(), ['D3D9.dll', 'd3d11.dll', 'dgVoodoo.conf', 'dxvk.conf'].sort(),
    'both sets go, and neither layer\'s pass steals a file the other owns');

  // dxgi.dll is in DXVK's file set and is also the name OptiScaler installs under. This is the
  // assertion that stops a future refactor turning the purge back into a list of filenames.
  assert.ok(fs.existsSync(path.join(dir, 'dxgi.dll')), 'OptiScaler survives a full reset');
  const why = Object.fromEntries(out.skipped.map((s) => [s.file, s.reason]));
  assert.match(why['dxgi.dll'], /optiscaler/);
});

test('a dry run reports exactly what it would do and changes nothing', async () => {
  const dir = scratchDir('tl-dry');
  write(dir, 'D3D9.dll', dll('dgVoodoo'));
  write(dir, 'dgVoodoo.conf', '[General]');

  const out = await translation.purgeTranslationLayer(dir, { layer: 'dgvoodoo', dryRun: true });
  assert.deepEqual(out.removed.sort(), ['D3D9.dll', 'dgVoodoo.conf'].sort());
  assert.ok(fs.existsSync(path.join(dir, 'D3D9.dll')), 'still there');
  assert.ok(fs.existsSync(path.join(dir, 'dgVoodoo.conf')), 'still there');
});
