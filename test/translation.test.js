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
const tar = require(path.join(REPO, 'src', 'tar'));
const zlib = require('node:zlib');

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

// ── DXVK acquisition and deploy ───────────────────────────────────────────────────────────────
// The archive is built here rather than downloaded: the real dxvk-3.1.1.tar.gz is 18 MB, and what
// these tests are about is the layout and the collision rules, not the bytes.

function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'latin1');
  h.write('0000644\0', 100, 8, 'latin1');
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1');
  h.write('0', 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

// The real release's shape: everything under dxvk-<version>/, with x32 and x64 beside each other.
function fakeDxvkTarGz(root = 'dxvk-3.1.1') {
  const names = ['d3d8.dll', 'd3d9.dll', 'd3d10core.dll', 'd3d11.dll', 'dxgi.dll'];
  const parts = [];
  for (const arch of ['x32', 'x64']) {
    for (const n of names) {
      parts.push(tarEntry(`${root}/${arch}/${n}`, Buffer.from(dll(`DXVK ${arch} ${n}`))));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

test('the tar reader finds a release file without knowing the version folder', () => {
  const files = tar.readTarGz(fakeDxvkTarGz());
  assert.equal(files.length, 10, 'five DLLs in each of the two architectures');

  const hit = tar.findTarEntry(files, 'x64/d3d9.dll');
  assert.ok(hit, 'found through the dxvk-3.1.1/ wrapper folder');
  assert.match(hit.data.toString('latin1'), /DXVK x64 d3d9\.dll/);
  assert.equal(hit.size, hit.data.length, 'the octal size field matches what came out');

  // The version is in the folder name, so a pin bump must not need the reader changed.
  const other = tar.readTarGz(fakeDxvkTarGz('dxvk-9.9.9'));
  assert.ok(tar.findTarEntry(other, 'x32/d3d8.dll'));
  assert.equal(tar.findTarEntry(files, 'x64/nope.dll'), null);
});

test('a DXVK archive unpacks to both architectures, and anything else is refused', async () => {
  const cache = scratchDir('dxvk-cache');
  const dest = await translation.unpackDxvk(fakeDxvkTarGz(), cache);

  assert.equal(dest, path.join(cache, translation.DXVK.cacheName));
  for (const arch of ['x32', 'x64']) {
    for (const n of ['d3d8.dll', 'd3d9.dll', 'd3d11.dll', 'dxgi.dll']) {
      assert.ok(fs.existsSync(path.join(dest, arch, n)), `${arch}/${n}`);
    }
  }
  assert.equal(translation.cachedDxvk(cache), dest, 'and it is found again without downloading');

  const notDxvk = zlib.gzipSync(Buffer.concat([tarEntry('readme.txt', Buffer.from('hello')), Buffer.alloc(1024)]));
  await assert.rejects(translation.unpackDxvk(notDxvk, scratchDir('dxvk-bad')), /not a DXVK release/);
});

test('a download that does not match the pinned checksum never reaches the cache', async () => {
  const cache = scratchDir('dxvk-hash');
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => fakeDxvkTarGz() });
  await assert.rejects(
    translation.ensureDxvk(cache, { fetchImpl }),
    (e) => e.code === 'dxvk-checksum',
    'the synthetic archive is not the pinned one, so it is rejected',
  );
  assert.equal(translation.cachedDxvk(cache), null, 'nothing was left behind');

  const offline = async () => ({ ok: false, status: 503 });
  await assert.rejects(translation.ensureDxvk(scratchDir('dxvk-net'), { fetchImpl: offline }), (e) => e.code === 'dxvk-network');
});

test('DXVK goes in with only the DLLs that API needs, and the game\'s own file is kept', async () => {
  const cache = scratchDir('dxvk-dep-cache');
  const sourceDir = await translation.unpackDxvk(fakeDxvkTarGz(), cache);
  const dir = scratchDir('dxvk-dep');
  write(dir, 'd3d9.dll', dll('the game\'s own d3d9'));

  const out = await translation.deployDxvk(dir, { sourceDir, api: 'dx9', bitness: 64 });

  assert.equal(out.ok, true);
  assert.deepEqual(out.deployed, ['d3d9.dll'], 'a DirectX 9 game needs one file, not all five');
  assert.ok(!fs.existsSync(path.join(dir, 'dxgi.dll')), 'and definitely not dxgi.dll');
  assert.deepEqual(out.backedUp, [{ rel: 'd3d9.dll', backup: `d3d9.dll${translation.BACKUP_SUFFIX}` }]);
  assert.match(fs.readFileSync(path.join(dir, 'd3d9.dll'), 'latin1'), /DXVK x64 d3d9/);

  const m = translation.readManifest(dir);
  assert.equal(m.layer, 'dxvk');
  assert.equal(m.arch, 'x64');

  // And the round trip: purging gives the game its own file back.
  await translation.purgeTranslationLayer(dir, { layer: 'dxvk' });
  assert.match(fs.readFileSync(path.join(dir, 'd3d9.dll'), 'latin1'), /the game's own d3d9/);
});

test('DXVK will not take a name OptiScaler is loading under', async () => {
  // dxgi.dll is in DXVK's D3D11 set and is also the name OptiScaler installs under. Backing
  // OptiScaler up would take the file out from under its own install journal, so the deploy refuses
  // and says so instead of quietly winning.
  const cache = scratchDir('dxvk-clash-cache');
  const sourceDir = await translation.unpackDxvk(fakeDxvkTarGz(), cache);
  const dir = scratchDir('dxvk-clash');
  write(dir, 'dxgi.dll', dll('OptiScaler'));

  const out = await translation.deployDxvk(dir, { sourceDir, api: 'dx11', bitness: 64 });

  // All or nothing: d3d11.dll without DXVK's dxgi.dll is not a working DXVK, and placing it anyway
  // is how a refused deploy came back "ok" (the 2.2.3 swap review, 2026-09-18).
  assert.equal(out.ok, false);
  assert.deepEqual(out.deployed, [], 'nothing goes in when one name is refused');
  assert.ok(!fs.existsSync(path.join(dir, 'd3d11.dll')));
  assert.ok(!fs.existsSync(path.join(dir, translation.MANIFEST)), 'and no manifest claims a layer that is not there');
  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].file, 'dxgi.dll');
  assert.match(out.refused[0].reason, /OptiScaler/);
  assert.match(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'latin1'), /OptiScaler/, 'untouched');
  assert.ok(!fs.existsSync(path.join(dir, `dxgi.dll${translation.BACKUP_SUFFIX}`)), 'and not quietly moved aside');
});

test('deploying DXVK over our own dgVoodoo2 purges it first, so the two never share a folder', async () => {
  const cache = scratchDir('dxvk-swap-cache');
  const sourceDir = await translation.unpackDxvk(fakeDxvkTarGz(), cache);
  const dir = scratchDir('dxvk-swap');
  write(dir, 'D3D9.dll', dll('dgVoodoo'));
  write(dir, 'dgVoodoo.conf', '[General]');
  write(dir, 'dgVoodooCpl.exe', 'MZ cpl');
  translation.writeManifest(dir, translation.newManifest({
    layer: 'dgvoodoo', arch: 'x64', files: ['D3D9.dll', 'dgVoodoo.conf', 'dgVoodooCpl.exe'],
  }));

  const out = await translation.deployDxvk(dir, { sourceDir, api: 'dx9', bitness: 64 });

  assert.equal(out.ok, true);
  assert.ok(!fs.existsSync(path.join(dir, 'dgVoodoo.conf')), 'dgVoodoo2 is gone, not buried');
  assert.ok(!fs.existsSync(path.join(dir, 'dgVoodooCpl.exe')));
  assert.equal(translation.identifyWrapper(path.join(dir, 'd3d9.dll')), 'dxvk');
  assert.equal(translation.activeLayer(dir).layer, 'dxvk', 'and the manifest says so');
});

test('a 32-bit game gets the 32-bit build', async () => {
  const cache = scratchDir('dxvk-32-cache');
  const sourceDir = await translation.unpackDxvk(fakeDxvkTarGz(), cache);
  const dir = scratchDir('dxvk-32');

  const out = await translation.deployDxvk(dir, { sourceDir, api: 'dx9', bitness: 32 });
  assert.equal(out.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'd3d9.dll'), 'latin1'), /DXVK x32 d3d9/);
  assert.equal(translation.readManifest(dir).arch, 'x32');
});
