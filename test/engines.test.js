'use strict';
// A second engine build: wilsjo2's OptiScaler-DLSSNR-PreSR-Multipass fork beside this project's
// own OptiScaler_DLSSNR. Same zip layout, different GitHub source, its own managed folder, and
// two [DlssNr] keys (RunBeforeSR, Passes) that a per-game marker drives through autoConfigureGame.
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

test('engine ids fall back to the default; the Pre-SR keys follow the marker and clear elsewhere', () => {
  assert.equal(engines.normalizeEngine('presr'), 'presr');
  assert.equal(engines.normalizeEngine('nonsense'), 'dlssnr');
  assert.equal(engines.normalizeEngine(undefined), 'dlssnr');
  assert.match(engines.releasesApi('presr'), /wilsjo2\/OptiScaler-DLSSNR-PreSR-Multipass\/releases\/latest$/);
  assert.match(engines.releasesApi('dlssnr'), /mrcgibb9876-hash\/OptiScaler_DLSSNR\/releases\/latest$/);
  assert.deepEqual(engines.iniEditsFor({ engine: 'presr' }), [
    { section: 'DlssNr', key: 'RunBeforeSR', value: 'true' },
    { section: 'DlssNr', key: 'Passes', value: '1' },
  ]);
  assert.deepEqual(engines.iniEditsFor({ engine: 'presr', runBeforeSR: false, passes: 7 }), [
    { section: 'DlssNr', key: 'RunBeforeSR', value: 'false' },
    { section: 'DlssNr', key: 'Passes', value: '1' },
  ]);
  assert.deepEqual(engines.iniEditsFor({ engine: 'dlssnr', runBeforeSR: true, passes: 3 }), [
    { section: 'DlssNr', key: 'RunBeforeSR', value: 'auto' },
    { section: 'DlssNr', key: 'Passes', value: 'auto' },
  ]);
});

test('installing with the Pre-SR build writes the marker and RunBeforeSR=true; switching back clears it', { skip: !onWindows }, async () => {
  const base = scratchDir('engine-install');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'FakeGame.exe');
  const { invoke } = loadMain();

  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll', engine: 'presr' });
  assert.equal(inst.ok, true, inst.error);
  const ini = path.join(game, 'OptiScaler.ini');
  assert.equal(iniValue(ini, 'RunBeforeSR'), 'true');
  assert.equal(iniValue(ini, 'Passes'), '1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(game, engines.ENGINE_MARKER), 'utf8')).engine, 'presr');
  assert.equal((await invoke('game:status', exe)).engine, 'presr', 'the card can name the build');

  const set = await invoke('engine:setForGame', { exePath: exe, engine: 'presr', runBeforeSR: false, passes: 3 });
  assert.equal(set.ok, true, set.error);
  assert.equal(set.deferred, false);
  assert.equal(iniValue(ini, 'RunBeforeSR'), 'false');
  assert.equal(iniValue(ini, 'Passes'), '3');
  const state = await invoke('engine:forGame', exe);
  assert.equal(state.marker.passes, 3);
  assert.equal(state.ini.runBeforeSR, 'false');

  // Re-installing (what the renderer does to switch builds) copies the release ini wholesale;
  // the marker keeps the passes but the build changes, so the keys go back to auto.
  const back = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll', engine: 'dlssnr' });
  assert.equal(back.ok, true, back.error);
  assert.equal(iniValue(ini, 'RunBeforeSR'), 'auto');
  assert.equal(iniValue(ini, 'Passes'), 'auto');
  assert.equal((await invoke('game:status', exe)).engine, 'dlssnr');

  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.ok(!fs.existsSync(path.join(game, engines.ENGINE_MARKER)), 'Remove clears the marker');
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
  const zipPath = path.join(base, 'presr.zip');
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
    const check = await invoke('update:check', { engine: 'presr' });
    assert.equal(check.ok, true, check.error);
    assert.equal(check.engine, 'presr');
    assert.match(seen[0], /wilsjo2\/OptiScaler-DLSSNR-PreSR-Multipass/);
    assert.equal(check.downloadUrl, 'https://dl/zip');
    assert.equal(check.sha256Url, 'https://dl/zip.sha256');

    shaText = 'deadbeef'.repeat(8) + ' *OptiScaler-DLSSNR-v0.7.7.zip';
    const bad = await invoke('update:install', { downloadUrl: check.downloadUrl, tag: check.tag, engine: 'presr', sha256Url: check.sha256Url });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /sha256/);
    assert.ok(!fs.existsSync(path.join(userData, 'OptiScalerRelease-presr')), 'nothing extracted after a checksum failure');

    shaText = `${goodSha} *OptiScaler-DLSSNR-v0.7.7.zip`;
    const good = await invoke('update:install', { downloadUrl: check.downloadUrl, tag: check.tag, engine: 'presr', sha256Url: check.sha256Url });
    assert.equal(good.ok, true, good.error);
    assert.equal(good.engine, 'presr');
    assert.equal(path.basename(good.folder), 'OptiScalerRelease-presr', 'its own managed folder, not the default build\'s');
    assert.ok(fs.existsSync(path.join(good.folder, 'setup_windows.bat')));
    assert.ok(!fs.existsSync(path.join(userData, 'OptiScalerRelease')), 'the default build\'s folder was not touched');
  } finally {
    global.fetch = realFetch;
  }
});
