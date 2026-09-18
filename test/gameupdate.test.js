'use strict';
// A game update under an install (gameupdate.js, 2026-09-18): each sync fingerprints the exe and
// remembers which of our files were in the folder, so a store update or a Steam verify that
// rewrote the exe -- and deleted the DLLs it did not know -- is noticed at the next sync rather
// than at the next launch that silently runs without DLSS 5.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, scratchDir, write, loadMain } = require('./helpers');
const gameupdate = require(path.join(REPO, 'src', 'gameupdate'));

// A different exe the way an update makes one: other bytes, other size, a later mtime.
function updateExe(exe, text) {
  fs.writeFileSync(exe, text);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(exe, later, later);
}

function steamGame(base, { buildid = '100', installdir = 'Some Game' } = {}) {
  const apps = path.join(base, 'steamapps');
  write(apps, 'appmanifest_4242.acf', `"AppState"\n{\n\t"appid"\t\t"4242"\n\t"installdir"\t\t"${installdir}"\n\t"buildid"\t\t"${buildid}"\n}\n`);
  const exe = write(apps, `common/${installdir}/Game.exe`, 'MZ v1');
  return { apps, exe, dir: path.dirname(exe) };
}

test('first sync only records; an unchanged exe says nothing', () => {
  const base = scratchDir('gameupdate-first');
  const store = path.join(base, 'userData', gameupdate.STORE_NAME);
  const exe = write(base, 'game/Game.exe', 'MZ v1');
  const dir = path.dirname(exe);
  write(dir, 'OptiScaler.ini', '[DlssNr]\n');
  write(dir, 'nvngx_dlssnr.dll', 'model');

  const first = gameupdate.inspect(store, exe, dir);
  assert.equal(first.prev, null);
  assert.equal(first.changed, false);
  assert.equal(gameupdate.commit(store, exe, dir, first), null);

  const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
  const entry = Object.values(saved)[0];
  assert.deepEqual(entry.files, ['OptiScaler.ini', 'nvngx_dlssnr.dll']);
  assert.ok(entry.exe.head, 'the header hash is recorded');

  const again = gameupdate.inspect(store, exe, dir);
  assert.equal(again.changed, false);
  assert.equal(gameupdate.commit(store, exe, dir, again), null);
});

test('an updated exe with our files intact is "rechecked"', () => {
  const base = scratchDir('gameupdate-rechecked');
  const store = path.join(base, gameupdate.STORE_NAME);
  const exe = write(base, 'game/Game.exe', 'MZ v1');
  const dir = path.dirname(exe);
  write(dir, 'OptiScaler.ini', '[DlssNr]\n');
  gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));

  updateExe(exe, 'MZ v2, a bigger exe');
  const seen = gameupdate.inspect(store, exe, dir);
  assert.equal(seen.changed, true);
  const res = gameupdate.commit(store, exe, dir, seen);
  assert.deepEqual(res, { rechecked: true, needsReinstall: false, missing: [], buildFrom: null, buildTo: null });
  // Recorded: the next sync is quiet again.
  assert.equal(gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir)), null);
});

test('an update that deleted our files asks for a reinstall until they are back', () => {
  const base = scratchDir('gameupdate-reinstall');
  const store = path.join(base, gameupdate.STORE_NAME);
  const exe = write(base, 'game/Game.exe', 'MZ v1');
  const dir = path.dirname(exe);
  write(dir, 'OptiScaler.ini', '[DlssNr]\n');
  write(dir, 'winmm.dll', 'optiscaler as winmm');
  write(dir, 'nvngx_dlssnr.dll', 'model');
  gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir), { extra: ['winmm.dll'] });

  // A Steam verify: the exe re-written, the proxy and the model deleted, the ini left.
  updateExe(exe, 'MZ v1 re-written');
  fs.rmSync(path.join(dir, 'winmm.dll'));
  fs.rmSync(path.join(dir, 'nvngx_dlssnr.dll'));
  const res = gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir), { extra: [] });
  assert.equal(res.rechecked, true);
  assert.equal(res.needsReinstall, true);
  assert.deepEqual(res.missing.sort(), ['nvngx_dlssnr.dll', 'winmm.dll']);

  // An app restart and another sync: the exe is the same now, the hint is not lost.
  const later = gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));
  assert.equal(later.rechecked, false);
  assert.equal(later.needsReinstall, true);

  // Reinstalled: quiet again.
  write(dir, 'winmm.dll', 'optiscaler as winmm');
  write(dir, 'nvngx_dlssnr.dll', 'model');
  assert.equal(gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir), { extra: ['winmm.dll'] }), null);
});

test('a file the sync itself puts back is not reported missing', () => {
  const base = scratchDir('gameupdate-sync-restores');
  const store = path.join(base, gameupdate.STORE_NAME);
  const exe = write(base, 'game/Game.exe', 'MZ v1');
  const dir = path.dirname(exe);
  write(dir, 'OptiScaler.ini', '[DlssNr]\n');
  write(dir, 'nvngx_dlssnr.dll', 'model');
  gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));

  updateExe(exe, 'MZ v2');
  fs.rmSync(path.join(dir, 'nvngx_dlssnr.dll'));
  const seen = gameupdate.inspect(store, exe, dir);
  assert.deepEqual(seen.missing, ['nvngx_dlssnr.dll']);
  write(dir, 'nvngx_dlssnr.dll', 'model, re-copied by the sync');
  const res = gameupdate.commit(store, exe, dir, seen);
  assert.equal(res.rechecked, true);
  assert.equal(res.needsReinstall, false);
});

test('an update that took every file of ours is said once, then left to the card\'s Install', () => {
  const base = scratchDir('gameupdate-all-gone');
  const store = path.join(base, gameupdate.STORE_NAME);
  const exe = write(base, 'game/Game.exe', 'MZ v1');
  const dir = path.dirname(exe);
  write(dir, 'OptiScaler.ini', '[DlssNr]\n');
  gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));

  updateExe(exe, 'MZ v2');
  fs.rmSync(path.join(dir, 'OptiScaler.ini'));
  const res = gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));
  assert.equal(res.needsReinstall, true);
  assert.equal(gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir)), null);
});

test('a game that never had our files is never flagged', () => {
  const base = scratchDir('gameupdate-not-ours');
  const store = path.join(base, gameupdate.STORE_NAME);
  const exe = write(base, 'game/Game.exe', 'MZ v1');
  const dir = path.dirname(exe);
  gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));
  updateExe(exe, 'MZ v2');
  assert.equal(gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir)), null);
});

test('a Steam buildid that moved is an update even when the exe did not change', () => {
  const base = scratchDir('gameupdate-steam');
  const { apps, exe, dir } = steamGame(base, { buildid: '100' });
  const store = path.join(base, gameupdate.STORE_NAME);
  write(dir, 'OptiScaler.ini', '[DlssNr]\n');
  assert.deepEqual(gameupdate.steamBuild(exe), { appid: '4242', buildid: '100' });
  gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));

  const acf = path.join(apps, 'appmanifest_4242.acf');
  fs.writeFileSync(acf, fs.readFileSync(acf, 'utf8').replace('"100"', '"205"'));
  const res = gameupdate.commit(store, exe, dir, gameupdate.inspect(store, exe, dir));
  assert.equal(res.rechecked, true);
  assert.equal(res.buildFrom, '100');
  assert.equal(res.buildTo, '205');
});

test('a game outside steamapps has no Steam build', () => {
  const base = scratchDir('gameupdate-nonsteam');
  assert.equal(gameupdate.steamBuild(write(base, 'Games/X/Game.exe', 'MZ')), null);
});

test('exeChanged: header, size, mtime and buildid', () => {
  const fp = { size: 10, mtimeMs: 1, head: 'a', steam: { buildid: '1' } };
  assert.equal(gameupdate.exeChanged(fp, { ...fp }), false);
  assert.equal(gameupdate.exeChanged(fp, { ...fp, head: 'b' }), true);
  assert.equal(gameupdate.exeChanged(fp, { ...fp, size: 11 }), true);
  assert.equal(gameupdate.exeChanged(fp, { ...fp, mtimeMs: 2 }), true);
  assert.equal(gameupdate.exeChanged(fp, { ...fp, steam: { buildid: '2' } }), true);
  assert.equal(gameupdate.exeChanged(null, fp), false);
  assert.equal(gameupdate.exeChanged(fp, null), false);
});

test('a legacy marker\'s DLLs and a Feeder deploy\'s ReShade are ours too', () => {
  const base = scratchDir('gameupdate-ourfiles');
  const dir = path.join(base, 'game');
  write(dir, '.dlss5ui-legacy.json', JSON.stringify({ files: ['d3d9.dll', 'dgVoodoo.conf', 'readme.txt'] }));
  write(dir, 'd3d9.dll', 'x');
  write(dir, 'readme.txt', 'x');
  write(dir, '.dlss5ui-feeder-deploy.json', '{}');
  write(dir, 'ReShade64.dll', 'x');
  assert.deepEqual(gameupdate.ourFiles(dir), ['ReShade64.dll', 'd3d9.dll']);
});

test('game:sync-if-stale reports a game update on its result', async () => {
  const { invoke, userData } = loadMain();
  const game = scratchDir('gameupdate-ipc');
  const exe = write(game, 'Game.exe', 'MZ fake v1');
  write(game, 'OptiScaler.ini', '[DlssNr]\nEnabled=auto\n');
  const first = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: null, nrDllPath: null });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.gameUpdated, undefined);
  assert.ok(fs.existsSync(gameupdate.storeFile(userData)), 'the fingerprint is kept in userData, not the game folder');

  updateExe(exe, 'MZ fake v2, patched');
  const second = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: null, nrDllPath: null });
  assert.equal(second.ok, true, second.error);
  assert.ok(second.gameUpdated, 'gameUpdated is on the result');
  assert.equal(second.gameUpdated.rechecked, true);
  assert.equal(second.gameUpdated.needsReinstall, false);
});

test('a game kept as is is never fingerprinted', async () => {
  const { invoke, userData } = loadMain();
  const game = scratchDir('gameupdate-keep');
  const exe = write(game, 'Game.exe', 'MZ fake v1');
  write(game, 'OptiScaler.ini', '[DlssNr]\nEnabled=auto\n');
  write(game, '.dlss5ui-keep-as-is', '');
  await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: null, nrDllPath: null });
  const store = JSON.parse(fs.existsSync(gameupdate.storeFile(userData)) ? fs.readFileSync(gameupdate.storeFile(userData), 'utf8') : '{}');
  assert.equal(store[path.resolve(exe).toLowerCase()], undefined);
});

test('the renderer shows the update on the card, with Reinstall, and toasts it', () => {
  const js = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.match(js, /const gu = res && res\.gameUpdated/);
  assert.match(js, /label: t\('Reinstall'\)/);
  assert.match(js, /await installGame\(game\)/);
  assert.match(js, /res\.gameUpdated\.needsReinstall \? gameBroken : gameRechecked/);
});
