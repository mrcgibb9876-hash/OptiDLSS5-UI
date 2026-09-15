'use strict';
// The engine build (this project's own OptiScaler_DLSSNR) and the two [DlssNr] keys (RunBeforeSR,
// Passes) a per-game marker drives through autoConfigureGame. The second build (wilsjo2's Pre-SR
// fork) was dropped in v1.64.0; anything still naming it must land on ours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain } = require('./helpers');
const engines = require('../src/engines');

const onWindows = process.platform === 'win32';

function iniValue(iniPath, key) {
  const m = fs.readFileSync(iniPath, 'utf-8').match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

test('release assets: the zip is the zip, its .sha256 file is the checksum, never the other way round', () => {
  const release = { assets: [
    { name: 'OptiScaler-DLSSNR-v0.7.7.zip.sha256', browser_download_url: 'https://x/sha' },
    { name: 'OptiScaler-DLSSNR-v0.7.7.zip', browser_download_url: 'https://x/zip' },
  ] };
  const picked = engines.pickAssets(release);
  assert.equal(picked.zip.browser_download_url, 'https://x/zip');
  assert.equal(picked.sha256.browser_download_url, 'https://x/sha');
  assert.equal(engines.pickAssets({ assets: [{ name: 'OptiScaler_v1.0.16.zip' }] }).sha256, null);
  assert.equal(engines.parseSha256Text('4a315a3b3ee495631bd7cb1f562f609af577443602e507bfc7a7e6749c296258 *OptiScaler-DLSSNR-v0.7.7.zip'), '4a315a3b3ee495631bd7cb1f562f609af577443602e507bfc7a7e6749c296258');
  assert.equal(engines.parseSha256Text('not a hash'), null);
});

test('engine ids fall back to the default; only explicit choices become ini edits', () => {
  assert.equal(engines.normalizeEngine('presr'), 'dlssnr', 'the dropped Pre-SR build lands on ours');
  assert.equal(engines.normalizeEngine('nonsense'), 'dlssnr');
  assert.equal(engines.normalizeEngine(undefined), 'dlssnr');
  assert.deepEqual(Object.keys(engines.ENGINES), ['dlssnr']);
  assert.match(engines.releasesApi('presr'), /mrcgibb9876-hash\/OptiScaler_DLSSNR\/releases\/latest$/);
  assert.match(engines.releasesApi('dlssnr'), /mrcgibb9876-hash\/OptiScaler_DLSSNR\/releases\/latest$/);
  // Only explicit choices produce ini edits; a bare marker asks for nothing (our build's panel owns them).
  assert.deepEqual(engines.iniEditsFor({ engine: 'dlssnr' }), []);
  assert.deepEqual(engines.iniEditsFor({ engine: 'dlssnr', runBeforeSR: false, passes: 7 }), [
    { section: 'DlssNr', key: 'RunBeforeSR', value: 'false' },
    { section: 'DlssNr', key: 'Passes', value: '1' },
  ]);
  assert.deepEqual(engines.iniEditsFor({ engine: 'dlssnr', runBeforeSR: true, passes: 3 }), [
    { section: 'DlssNr', key: 'RunBeforeSR', value: 'true' },
    { section: 'DlssNr', key: 'Passes', value: '3' },
  ]);
  // Install adds nothing of its own; an old Pre-SR marker keeps the user's choice but names our build.
  assert.deepEqual(engines.markerForInstall(null, 'dlssnr'), { engine: 'dlssnr', pendingApply: true });
  assert.deepEqual(engines.markerForInstall({ engine: 'presr', runBeforeSR: true }, 'presr'), { engine: 'dlssnr', pendingApply: true, runBeforeSR: true });
});

test('a game on the old Pre-SR build re-installs onto ours; Edit choices apply and survive a re-install', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-install');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'FakeGame.exe');
  const { invoke } = loadMain();

  write(game, engines.ENGINE_MARKER, JSON.stringify({ engine: 'presr', runBeforeSR: true }));
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll', engine: 'presr' });
  assert.equal(inst.ok, true, inst.error);
  const ini = path.join(game, 'OptiScaler.ini');
  assert.equal(iniValue(ini, 'RunBeforeSR'), 'true', 'the choice the old marker carried is kept');
  assert.equal(iniValue(ini, 'Passes'), null, 'nobody chose a pass count, so none is written');
  assert.equal(JSON.parse(fs.readFileSync(path.join(game, engines.ENGINE_MARKER), 'utf8')).engine, 'dlssnr');
  assert.equal((await invoke('game:status', exe)).engine, 'dlssnr', 'the card names our build');

  const set = await invoke('engine:setForGame', { exePath: exe, engine: 'dlssnr', runBeforeSR: false, passes: 3 });
  assert.equal(set.ok, true, set.error);
  assert.equal(set.deferred, false);
  assert.equal(iniValue(ini, 'RunBeforeSR'), 'false');
  assert.equal(iniValue(ini, 'Passes'), '3');
  const state = await invoke('engine:forGame', exe);
  assert.equal(state.marker.passes, 3);
  assert.equal(state.ini.runBeforeSR, 'false');

  // Re-installing copies the release ini wholesale; the explicit choices ride along.
  const back = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll', engine: 'dlssnr' });
  assert.equal(back.ok, true, back.error);
  assert.equal(iniValue(ini, 'RunBeforeSR'), 'false');
  assert.equal(iniValue(ini, 'Passes'), '3');
  assert.equal((await invoke('game:status', exe)).engine, 'dlssnr');

  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.ok(!fs.existsSync(path.join(game, engines.ENGINE_MARKER)), 'Remove clears the marker');
});

// The v1.54.0 draft reset these keys to auto on every sync, which silently undid the Alt+Home
// panel's "Before Super Resolution" toggle and passes slider. The marker applies once, then the
// in-game menu owns the keys.
test('a value set in the game after install survives every later sync', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-panel');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const { invoke } = loadMain();
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'FakeGame.exe');
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll', engine: 'dlssnr' });
  assert.equal(inst.ok, true, inst.error);
  const ini = path.join(game, 'OptiScaler.ini');
  assert.equal(iniValue(ini, 'RunBeforeSR'), null, 'install default');
  assert.equal(JSON.parse(fs.readFileSync(path.join(game, engines.ENGINE_MARKER), 'utf8')).pendingApply, false, 'applied once');

  // What the in-game panel does: RunBeforeSR on and 2 passes.
  let text = fs.readFileSync(ini, 'utf8').replace(/^RunBeforeSR\s*=.*$/m, '').replace(/^Passes\s*=.*$/m, '');
  text = text.replace('[DlssNr]', '[DlssNr]\nRunBeforeSR=true\nPasses=2');
  fs.writeFileSync(ini, text);

  for (let i = 0; i < 2; i++) {
    const sync = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: release, nrDllPath: nr });
    assert.equal(sync.ok, true, sync.error);
  }
  assert.equal(iniValue(ini, 'RunBeforeSR'), 'true', 'in-game RunBeforeSR kept');
  assert.equal(iniValue(ini, 'Passes'), '2', 'in-game Passes kept');
});

// Resident Evil Requiem (2026-09-14): working, and its owner wanted it kept on the engine it has when a
// new engine shipped. A game marked keep-as-is gets nothing from sync: not the new OptiScaler.dll, not the
// new NR model, not an ini edit.
test('a game marked keep-as-is is not touched by sync: engine, model and ini all stay', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-keep');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 're9.exe');
  const { invoke } = loadMain();
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(inst.ok, true, inst.error);

  const dxgi = path.join(game, 'dxgi.dll');
  const model = path.join(game, 'nvngx_dlssnr.dll');
  const ini = path.join(game, 'OptiScaler.ini');
  fs.writeFileSync(dxgi, 'the engine this game works on OptiScaler');
  fs.writeFileSync(model, 'older model');
  fs.writeFileSync(ini, fs.readFileSync(ini, 'utf8').replace(/^LogLevel\s*=.*$/m, 'LogLevel=0'));
  const iniBefore = fs.readFileSync(ini, 'utf8');
  write(game, '.dlss5ui-keep-as-is', '');

  const sync = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: release, nrDllPath: nr });
  assert.equal(sync.ok, true, sync.error);
  assert.equal(sync.updated, false);
  assert.equal(sync.reason, 'kept as is');
  assert.equal(fs.readFileSync(dxgi, 'utf8'), 'the engine this game works on OptiScaler', 'engine not replaced');
  assert.equal(fs.readFileSync(model, 'utf8'), 'older model', 'model not replaced');
  assert.equal(fs.readFileSync(ini, 'utf8'), iniBefore, 'ini untouched');

  // Remove still takes everything, the marker included.
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.ok(!fs.existsSync(path.join(game, '.dlss5ui-keep-as-is')));
});

// Engine v1.0.27 ships OptiScaler_OpticalFlow.dll beside OptiScaler.dll. A game installed before it existed
// gets it on sync, a changed one is refreshed, and Remove takes it.
test('the engine\'s optical-flow DLL reaches an already-installed game on sync and leaves with Remove', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-companion');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'FakeGame.exe');
  const { invoke } = loadMain();
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(inst.ok, true, inst.error);
  const companion = path.join(game, 'OptiScaler_OpticalFlow.dll');
  assert.ok(!fs.existsSync(companion), 'the old release had none');

  write(release, 'OptiScaler_OpticalFlow.dll', 'optical flow v1');
  const sync = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: release, nrDllPath: nr });
  assert.equal(sync.ok, true, sync.error);
  assert.equal(fs.readFileSync(companion, 'utf8'), 'optical flow v1', 'placed on sync');

  write(release, 'OptiScaler_OpticalFlow.dll', 'optical flow v2');
  await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: release, nrDllPath: nr });
  assert.equal(fs.readFileSync(companion, 'utf8'), 'optical flow v2', 'refreshed when the release changes');

  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.ok(!fs.existsSync(companion), 'Remove takes it');
});

// Monster Hunter: World (2026-09-14): its exe never loads a dxgi.dll from its folder, so OptiScaler installed
// as dxgi.dll never started. New installs take winmm.dll; an install of ours at dxgi.dll moves on sync.
test('Monster Hunter: World installs its proxy as winmm.dll, and an earlier dxgi.dll install of ours is moved on sync', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-mhw-proxy');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const { invoke } = loadMain();

  const fresh = path.join(base, 'fresh');
  const freshExe = fakeExe(fresh, 'MonsterHunterWorld.exe');
  const inst = await invoke('game:install', { exePath: freshExe, releaseFolder: release, nrDllPath: nr });
  assert.equal(inst.ok, true, inst.error);
  assert.ok(fs.existsSync(path.join(fresh, 'winmm.dll')), 'installed as winmm.dll');
  assert.ok(!fs.existsSync(path.join(fresh, 'dxgi.dll')));

  const old = path.join(base, 'old');
  const oldExe = fakeExe(old, 'MonsterHunterWorld.exe');
  const inst2 = await invoke('game:install', { exePath: oldExe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(inst2.ok, true, inst2.error);
  assert.ok(fs.existsSync(path.join(old, 'dxgi.dll')), 'the old install, as dxgi.dll');
  const sync = await invoke('game:sync-if-stale', { exePath: oldExe, releaseFolder: release, nrDllPath: nr });
  assert.equal(sync.ok, true, sync.error);
  assert.ok(fs.existsSync(path.join(old, 'winmm.dll')), 'moved to winmm.dll');
  assert.ok(!fs.existsSync(path.join(old, 'dxgi.dll')), 'dxgi.dll gone');
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, '.optiscaler-manager-install.json'), 'utf8')).proxy, 'winmm.dll');

  // A dxgi.dll install of any other game stays exactly where it is.
  const other = path.join(base, 'other');
  const otherExe = fakeExe(other, 'SomeGame.exe');
  await invoke('game:install', { exePath: otherExe, releaseFolder: release, nrDllPath: nr });
  await invoke('game:sync-if-stale', { exePath: otherExe, releaseFolder: release, nrDllPath: nr });
  assert.ok(fs.existsSync(path.join(other, 'dxgi.dll')));
  assert.ok(!fs.existsSync(path.join(other, 'winmm.dll')));
});

test('a game installed before there was a choice is left alone (no marker, no key edits)', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-legacy');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'FakeGame.exe');
  const { invoke } = loadMain();
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(inst.ok, true, inst.error);
  assert.ok(!fs.existsSync(path.join(game, engines.ENGINE_MARKER)));
  assert.equal(iniValue(path.join(game, 'OptiScaler.ini'), 'RunBeforeSR'), null);
  assert.equal((await invoke('game:status', exe)).engine, null);
});

// GitHub is stubbed: update:check must ask the chosen fork's releases and hand back its checksum
// asset; update:install must refuse a zip whose bytes do not match that checksum before it
// touches the managed folder, and accept one that does.
test('update:check and update:install per engine, with the sha256 asset checked', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-update');
  const { invoke, userData } = loadMain();
  const releaseDir = fakeReleaseFolder(base);
  const zipPath = path.join(base, 'engine.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path $env:SRC -DestinationPath $env:DEST -Force'],
    { env: { ...process.env, SRC: path.join(releaseDir, '*'), DEST: zipPath } });
  const zipBytes = fs.readFileSync(zipPath);
  const goodSha = crypto.createHash('sha256').update(zipBytes).digest('hex');

  const seen = [];
  let shaText = `${goodSha} *OptiScaler-DLSSNR-v0.7.7.zip`;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    seen.push(String(url));
    if (/releases\/latest$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.7.7', name: 'v0.7.7', published_at: 'x', assets: [
        { name: 'OptiScaler-DLSSNR-v0.7.7.zip.sha256', browser_download_url: 'https://dl/zip.sha256' },
        { name: 'OptiScaler-DLSSNR-v0.7.7.zip', browser_download_url: 'https://dl/zip' },
      ] }) };
    }
    if (String(url) === 'https://dl/zip') return { ok: true, status: 200, arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) };
    if (String(url) === 'https://dl/zip.sha256') return { ok: true, status: 200, text: async () => shaText };
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const check = await invoke('update:check', {});
    assert.equal(check.ok, true, check.error);
    assert.equal(check.engine, 'dlssnr');
    assert.match(seen[0], /mrcgibb9876-hash\/OptiScaler_DLSSNR/);
    assert.equal(check.downloadUrl, 'https://dl/zip');
    assert.equal(check.sha256Url, 'https://dl/zip.sha256');

    shaText = 'deadbeef'.repeat(8) + ' *OptiScaler-DLSSNR-v0.7.7.zip';
    const bad = await invoke('update:install', { downloadUrl: check.downloadUrl, tag: check.tag, sha256Url: check.sha256Url });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /sha256/);
    assert.ok(!fs.existsSync(path.join(userData, 'OptiScalerRelease')), 'nothing extracted after a checksum failure');

    shaText = `${goodSha} *OptiScaler-DLSSNR-v0.7.7.zip`;
    const good = await invoke('update:install', { downloadUrl: check.downloadUrl, tag: check.tag, sha256Url: check.sha256Url });
    assert.equal(good.ok, true, good.error);
    assert.equal(good.engine, 'dlssnr');
    assert.equal(path.basename(good.folder), 'OptiScalerRelease', 'the managed folder');
    assert.ok(fs.existsSync(path.join(good.folder, 'setup_windows.bat')));
  } finally {
    global.fetch = realFetch;
  }
});
