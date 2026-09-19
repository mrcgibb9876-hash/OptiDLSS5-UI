'use strict';
// [DlssNr] PanelShownOnce in host64\OptiScaler.ini belongs to the engine (2026-09-18): the DLSS 5
// panel auto-opens once in the Feeder helper and the engine then writes PanelShownOnce=true. The app
// must carry it through everything that rewrites that file -- a re-install copies the release's
// template over it, a sync edits Language / Enabled / the cast key -- or the panel pops open again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPO, scratchDir, write, fakeReleaseFolder, fakeNrModel, loadMain } = require('./helpers');
const legacy = require(path.join(REPO, 'src', 'legacy'));
const dlssnr = require(path.join(REPO, 'src', 'dlssnr'));
const { getIniKey } = require(path.join(REPO, 'src', 'ini-merge'));

const onWindows = process.platform === 'win32';
const SYS = process.env.SystemRoot || 'C:\\Windows';
process.env.LEGACY_QUARANTINE_WAIT_MS = '0';

function zipDir(srcDir, zipPath) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:SRC "*") -DestinationPath $env:DEST -Force'],
    { env: { ...process.env, SRC: srcDir, DEST: zipPath } });
  return zipPath;
}

function fakeComponents(base) {
  const feederSrc = path.join(base, 'feeder-src');
  write(feederSrc, 'dlss5-feed.addon32', 'addon32');
  write(feederSrc, 'host64/dlss5-feed-host64.exe', 'host exe');
  write(feederSrc, 'reshade-shaders/Shaders/DLSS5_Feed.fx', '// feed fx');
  const reshadeSrc = path.join(base, 'reshade-src');
  write(reshadeSrc, 'ReShade32.dll', 'ReShade 32-bit build');
  write(reshadeSrc, 'ReShade64.dll', 'ReShade 64-bit build');
  return {
    feederZip: zipDir(feederSrc, path.join(base, 'DLSS5-Feeder-test.zip')),
    reshadeSetup: zipDir(reshadeSrc, path.join(base, 'ReShade_Setup_test_Addon.zip')),
  };
}

const shaders = async (dir) => {
  write(dir, 'ReShade.ini', '[ADDON]\nAddonPath=.\\\n');
  write(dir, 'ReShadePreset.ini', 'Techniques=DLSS5_Feed@DLSS5_Feed.fx\n');
  return [];
};

// What the engine does after the panel's first auto-open: one line in [DlssNr].
function engineMarksPanelShown(hostIni) {
  const text = fs.readFileSync(hostIni, 'utf8').replace(/\[DlssNr\]\r?\n/, (m) => `${m}PanelShownOnce=true\r\n`);
  fs.writeFileSync(hostIni, text, 'utf8');
}

test('a re-install of the 32-bit route keeps the engine\'s PanelShownOnce', { skip: !onWindows }, async () => {
  const base = scratchDir('panel-shown-once-reinstall');
  const comps = fakeComponents(base);
  const game = path.join(base, 'game');
  fs.mkdirSync(game, { recursive: true });
  fs.copyFileSync(path.join(SYS, 'SysWOW64', 'notepad.exe'), path.join(game, 'Game.exe'));
  const plan = legacy.planFor({ bitness: 32, api: 'dx11' });
  const deps = { ...comps, releaseFolder: fakeReleaseFolder(base), nrDllPath: fakeNrModel(base), deployShaders: shaders };

  await legacy.deployHost32(game, plan, deps);
  const hostIni = path.join(game, legacy.HOST_DIR, 'OptiScaler.ini');
  assert.equal(getIniKey(fs.readFileSync(hostIni, 'utf8'), 'DlssNr', 'PanelShownOnce'), null, 'a fresh install has no such key');

  engineMarksPanelShown(hostIni);
  // The release template has no PanelShownOnce; this copy would have wiped it.
  await legacy.deployHost32(game, plan, deps);
  const after = fs.readFileSync(hostIni, 'utf8');
  assert.equal(getIniKey(after, 'DlssNr', 'PanelShownOnce'), 'true');
  assert.equal(getIniKey(after, 'DlssNr', 'Enabled'), 'true', 'the install\'s own keys still go in');
});

test('sync, the panel language, DLSS 5 on at start and the settings panel leave PanelShownOnce alone', async () => {
  const { invoke, userData } = loadMain();
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ language: 'de' }));
  const game = scratchDir('panel-shown-once-sync');
  const exe = write(game, 'Game.exe', 'MZ fake');
  write(game, legacy.MARKER, JSON.stringify({ version: 1, files: [], backups: [], dirs: ['host64'], host32: { api: 'dx11', reshadeName: 'dxgi.dll' } }));
  write(game, 'dlss5-feed.cfg', 'cast_key=0\n');
  write(game, 'host64/ReShade.ini', '[ADDON]\nAddonPath=.\\\n');
  write(game, 'host64/nvngx_dlssnr.dll', 'model');
  const hostIni = write(game, 'host64/OptiScaler.ini', '[DlssNr]\r\nEnabled=false\r\nPanelShownOnce=true\r\nLanguage=auto\r\n');

  const res = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: null, nrDllPath: null });
  assert.equal(res.ok, true);
  let text = fs.readFileSync(hostIni, 'utf8');
  assert.equal(getIniKey(text, 'DlssNr', 'PanelShownOnce'), 'true');
  assert.equal(getIniKey(text, 'DlssNr', 'Language'), 'de', 'the sync did edit the file');
  assert.equal(getIniKey(text, 'DlssNr', 'Enabled'), 'true');

  // The app's DLSS 5 settings panel writes this same file.
  assert.deepEqual(dlssnr.writeSettings(hostIni, { ApplyModel: false }).written, ['ApplyModel']);
  text = fs.readFileSync(hostIni, 'utf8');
  assert.equal(getIniKey(text, 'DlssNr', 'PanelShownOnce'), 'true');
});
