'use strict';
// Game Help's 'nr-model-only' route (src/nrmodelonly.js, main.js applyHelpFix) and what Remove does
// after it. Every case here is one the review of 2026-09-18 found losing or stranding a model:
// the route running on a game with no DLSS of its own, the game's own model in its Streamline folder
// not being looked for, nothing recorded for Remove, a failed step leaving the only copy in the
// app's cache, deployAmdNrModel deleting a model when a backup already existed, and the AMD build
// being fetched on NVIDIA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write, fakeExe, loadMain } = require('./helpers');
const nrmodelonly = require(path.join(__dirname, '..', 'src', 'nrmodelonly'));
const amdnr = require(path.join(__dirname, '..', 'src', 'amdnr'));
const helpfix = require(path.join(__dirname, '..', 'src', 'helpfix'));

const PLUGIN = 'Engine/Plugins/DLSS/Binaries/ThirdParty/Win64';
const read = (p) => fs.readFileSync(p, 'utf8');

// An Unreal-shaped game: its own DLSS in the plugin tree, which is where its NGX looks for the model.
function unrealGame(name) {
  const dir = scratchDir(name);
  write(dir, `${PLUGIN}/nvngx_dlss.dll`, 'the game\'s own DLSS');
  return { dir, target: path.join(dir, ...PLUGIN.split('/')), cacheDir: path.join(dir, '..', `${path.basename(dir)}-cache`) };
}
// What uninstallEverything does to the model beside the exe (uninstallOptiScaler removes it).
const fakeUninstall = (dir) => async () => {
  fs.rmSync(path.join(dir, 'nvngx_dlssnr.dll'), { force: true });
  return { removed: ['OptiScaler.dll', 'nvngx_dlssnr.dll'] };
};
const noFetch = async () => { throw new Error('no network in this test'); };
const cacheLeft = (cacheDir) => { try { return fs.readdirSync(cacheDir).filter((n) => n.startsWith('preserved-')); } catch { return []; } };

test('a game with no DLSS of its own is refused before anything changes', async () => {
  const dir = scratchDir('nronly-refuse');
  assert.match(nrmodelonly.refusal(dir), /no DLSS of its own/);
  const game = unrealGame('nronly-allowed');
  assert.equal(nrmodelonly.refusal(game.dir), null);

  // Through main.js, the path the AI tier reaches: the refusal comes before the dialog and the uninstall.
  const exe = fakeExe(dir, 'NoDlss.exe');
  write(dir, 'OptiScaler.dll', 'ours');
  const { invoke } = loadMain({ dialogResponse: 0 });
  const r = await invoke('game:help-apply', { exePath: exe, fixId: 'nr-model-only' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.done, false);
  assert.match(r.text, /no DLSS of its own/);
  assert.ok(fs.existsSync(path.join(dir, 'OptiScaler.dll')), 'nothing was taken out');
});

test('the model beside the exe is kept and placed in the plugin tree; Remove takes our copy back', async () => {
  const { dir, target, cacheDir } = unrealGame('nronly-beside');
  write(dir, 'nvngx_dlssnr.dll', 'the user\'s model');
  const r = await nrmodelonly.nrModelOnly({ dir, cacheDir, uninstall: fakeUninstall(dir), resolveSource: noFetch });
  assert.equal(r.done, true, r.text);
  assert.match(r.text, /the model this game already had/);
  assert.equal(read(path.join(target, 'nvngx_dlssnr.dll')), 'the user\'s model');
  assert.deepEqual(cacheLeft(cacheDir), [], 'the preserved cache copy is deleted on success');

  const marker = nrmodelonly.readMarker(dir);
  assert.equal(path.resolve(dir, marker.target), target);
  assert.equal(marker.placed, true);
  assert.equal(nrmodelonly.nrModelPresent(dir), true, 'the card sees the model where the route put it');

  const rm = await nrmodelonly.removeNrModelOnly(dir);
  assert.ok(rm.removed.includes(path.join(...PLUGIN.split('/'), 'nvngx_dlssnr.dll')));
  assert.equal(fs.existsSync(path.join(target, 'nvngx_dlssnr.dll')), false);
  assert.equal(fs.existsSync(path.join(dir, nrmodelonly.NRMODEL_MARKER)), false);
  assert.equal(nrmodelonly.nrModelPresent(dir), false);
});

test('a model the game keeps in its own Streamline folder stays where it is, and Remove leaves it', async () => {
  const { dir, target, cacheDir } = unrealGame('nronly-own');
  write(dir, `${PLUGIN}/nvngx_dlssnr.dll`, 'the game\'s own model');
  // Nothing to fetch: the first cut looked only beside the exe, found nothing and downloaded over it.
  const r = await nrmodelonly.nrModelOnly({ dir, cacheDir, uninstall: fakeUninstall(dir), resolveSource: noFetch });
  assert.equal(r.done, true, r.text);
  assert.equal(read(path.join(target, 'nvngx_dlssnr.dll')), 'the game\'s own model');
  assert.equal(fs.existsSync(path.join(target, 'nvngx_dlssnr.dll.amdnr_backup')), false, 'identical: not shuffled into a backup');
  assert.equal(nrmodelonly.readMarker(dir).placed, false);

  await nrmodelonly.removeNrModelOnly(dir);
  assert.equal(read(path.join(target, 'nvngx_dlssnr.dll')), 'the game\'s own model', 'never ours to delete');
});

test('a different model already in the target is backed up, and Remove puts it back', async () => {
  const { dir, target, cacheDir } = unrealGame('nronly-backup');
  write(dir, `${PLUGIN}/nvngx_dlssnr.dll`, 'the game\'s own model');
  // nrModelOnly itself keeps a model already in the target (existingModel prefers it), so the
  // replacing deploy is driven directly here, as a re-run with a different model would.
  const src = write(cacheDir, 'fetched.dll', 'a fetched model');
  const placed = await amdnr.deployAmdNrModel(target, src, { replace: true });
  assert.equal(placed.backedUp, 'nvngx_dlssnr.dll.amdnr_backup');
  fs.writeFileSync(path.join(dir, nrmodelonly.NRMODEL_MARKER), JSON.stringify({ target: PLUGIN, backedUp: placed.backedUp, placed: true }));

  const plan = nrmodelonly.removalPlan(dir);
  assert.equal(plan.restore.length, 1);
  const rm = await nrmodelonly.removeNrModelOnly(dir);
  assert.equal(rm.restored.length, 1);
  assert.equal(read(path.join(target, 'nvngx_dlssnr.dll')), 'the game\'s own model');
  assert.equal(fs.existsSync(path.join(target, 'nvngx_dlssnr.dll.amdnr_backup')), false);
});

test('deployAmdNrModel never destroys a model when a backup already exists', async () => {
  const dir = scratchDir('amdnr-nodestroy');
  write(dir, 'nvngx_dlssnr.dll.amdnr_backup', 'first original');
  write(dir, 'nvngx_dlssnr.dll', 'the game put its own back after an update');
  const src = write(dir, 'cache/model.dll', 'our model');
  const r = await amdnr.deployAmdNrModel(dir, src, { replace: true });
  assert.equal(r.deployed, true);
  assert.match(r.backedUp, /^nvngx_dlssnr\.dll\.amdnr_backup-\d+$/);
  assert.equal(read(path.join(dir, r.backedUp)), 'the game put its own back after an update');
  assert.equal(read(path.join(dir, 'nvngx_dlssnr.dll.amdnr_backup')), 'first original');
  // The same file again is not a replacement at all.
  const again = await amdnr.deployAmdNrModel(dir, src, { replace: true });
  assert.equal(again.already, true);
  assert.equal(again.backedUp, null);
});

test('a step that fails after the uninstall took the model puts it back, and says so', async () => {
  const { dir, cacheDir } = unrealGame('nronly-fail');
  write(dir, 'nvngx_dlssnr.dll', 'the user\'s model');
  const r = await nrmodelonly.nrModelOnly({
    dir, cacheDir, uninstall: fakeUninstall(dir), resolveSource: noFetch,
    deploy: async () => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; },
  });
  assert.equal(r.done, false);
  assert.match(r.text, /EBUSY/);
  assert.match(r.text, /put back in the game folder/);
  assert.equal(read(path.join(dir, 'nvngx_dlssnr.dll')), 'the user\'s model');
  assert.deepEqual(cacheLeft(cacheDir), []);
  assert.equal(nrmodelonly.readMarker(dir), null, 'nothing recorded for a route that did not happen');

  // The uninstall itself throwing (a locked proxy DLL) after it had already deleted the model.
  const g2 = unrealGame('nronly-fail2');
  write(g2.dir, 'nvngx_dlssnr.dll', 'the user\'s model');
  const r2 = await nrmodelonly.nrModelOnly({
    dir: g2.dir, cacheDir: g2.cacheDir, resolveSource: noFetch,
    uninstall: async () => { fs.rmSync(path.join(g2.dir, 'nvngx_dlssnr.dll')); throw new Error('EPERM: dxgi.dll is in use'); },
  });
  assert.equal(r2.done, false);
  assert.match(r2.text, /could not be taken out: EPERM/);
  assert.equal(read(path.join(g2.dir, 'nvngx_dlssnr.dll')), 'the user\'s model');
});

test('when the model cannot be put back, the error names where it is', async () => {
  const { dir, cacheDir } = unrealGame('nronly-strand');
  write(dir, 'nvngx_dlssnr.dll', 'the user\'s model');
  const r = await nrmodelonly.nrModelOnly({
    dir, cacheDir, resolveSource: noFetch,
    // The game folder is gone and a file sits in its place: nothing can be copied back into it.
    uninstall: async () => { fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(dir, 'x'); throw new Error('gone'); },
  });
  assert.equal(r.done, false);
  const kept = cacheLeft(cacheDir);
  assert.equal(kept.length, 1, 'the only copy is not deleted');
  assert.ok(r.text.includes(path.join(cacheDir, kept[0])), r.text);
  fs.rmSync(dir, { force: true });
});

test('the fetched model is the NVIDIA one on NVIDIA and the pinned AMD build on AMD', async () => {
  const dir = scratchDir('nronly-source');
  const settingsModel = write(dir, 'settings-model.dll', 'x');
  const calls = [];
  const deps = {
    fetchNvidia: async () => { calls.push('nvidia'); return 'nvidia.dll'; },
    fetchAmd: async () => { calls.push('amd'); return 'amd.dll'; },
  };
  assert.equal(await nrmodelonly.pickModelSource({ vendor: 'nvidia', settingsPath: settingsModel, ...deps }), settingsModel, 'the model Install uses');
  assert.equal(await nrmodelonly.pickModelSource({ vendor: 'nvidia', settingsPath: path.join(dir, 'missing.dll'), ...deps }), 'nvidia.dll');
  assert.equal(await nrmodelonly.pickModelSource({ vendor: 'unknown', settingsPath: null, ...deps }), 'nvidia.dll');
  assert.equal(await nrmodelonly.pickModelSource({ vendor: 'amd', settingsPath: settingsModel, ...deps }), 'amd.dll');
  assert.deepEqual(calls, ['nvidia', 'nvidia', 'amd']);
});

test('through main.js: the route, the card, the Remove preview and Remove itself', { skip: process.platform !== 'win32' }, async () => {
  const { dir, target } = unrealGame('nronly-main');
  const exe = fakeExe(dir, 'UnrealGame-Win64-Shipping.exe');
  write(dir, 'nvngx_dlssnr.dll', 'the user\'s model');
  write(dir, 'OptiScaler.ini', '[DlssNr]\nEnabled=true\n');
  const { invoke } = loadMain({ dialogResponse: 0 });

  const r = await invoke('game:help-apply', { exePath: exe, fixId: 'nr-model-only' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.done, true, r.text);
  assert.equal(fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll')), false, 'nothing of ours beside the exe');
  assert.equal(read(path.join(target, 'nvngx_dlssnr.dll')), 'the user\'s model');

  const status = await invoke('game:status', exe);
  assert.equal(status.hasNr, true, 'the card sees the model in the plugin tree');

  const preview = await invoke('game:uninstallPlan', exe);
  assert.equal(preview.ok, true, preview.error);
  assert.ok(preview.remove.includes(path.join(...PLUGIN.split('/'), 'nvngx_dlssnr.dll')), JSON.stringify(preview.remove));
  assert.ok(preview.remove.includes(nrmodelonly.NRMODEL_MARKER));

  const rm = await invoke('game:help-apply', { exePath: exe, fixId: 'remove-all' });
  assert.equal(rm.ok, true, rm.error);
  assert.equal(fs.existsSync(path.join(target, 'nvngx_dlssnr.dll')), false);
  assert.equal(fs.existsSync(path.join(dir, nrmodelonly.NRMODEL_MARKER)), false);
  assert.ok(fs.existsSync(path.join(target, 'nvngx_dlss.dll')), 'the game\'s own DLSS is untouched');
});

test('Reconfigure says when moving the proxy failed instead of "nothing needed changing"', () => {
  const failed = helpfix.reconfigureSummary({ migrateError: new Error('EBUSY: dxgi.dll is locked'), applied: [] });
  assert.equal(failed.done, false);
  assert.match(failed.text, /could not move OptiScaler.*EBUSY/);
  assert.doesNotMatch(failed.text, /nothing needed changing/);

  assert.deepEqual(helpfix.reconfigureSummary({}), { done: true, text: 'nothing needed changing' });
  const moved = helpfix.reconfigureSummary({ migration: { from: 'dxgi.dll', to: 'winmm.dll' }, applied: [{ section: 'DlssNr', key: 'Enabled', value: 'true' }], reframeworkPlaced: true });
  assert.equal(moved.text, 'moved OptiScaler from dxgi.dll to winmm.dll; set DlssNr.Enabled=true, REFramework placed');
});
