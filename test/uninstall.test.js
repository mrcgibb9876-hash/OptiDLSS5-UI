'use strict';
// Install then Remove must leave a game folder exactly as it was -- through main.js's own
// handlers, with a fake release folder and NR model. Windows only: the proxy detection shells
// out to PowerShell for the DLL's version resource, as the app does.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain, listing } = require('./helpers');

const onWindows = process.platform === 'win32';

test('install then Remove is a round trip; someone else\'s OptiScaler.ini comes back', { skip: !onWindows }, async () => {
  const base = scratchDir('roundtrip');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'FakeGame.exe');
  write(game, 'game-data.pak', 'not ours');
  write(game, 'Licenses/GAME_EULA.txt', 'the game\'s own licence');
  write(game, 'OptiScaler.ini', '; someone else\'s ini\n[Upscalers]\nDx12Upscaler=fsr31\n');
  const before = listing(game);

  const { invoke } = loadMain();
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(inst.ok, true, inst.error);
  assert.ok(fs.existsSync(path.join(game, 'dxgi.dll')), 'proxy in place');
  const journal = JSON.parse(fs.readFileSync(path.join(game, '.optiscaler-manager-install.json'), 'utf8'));
  assert.ok(journal.added.includes('OptiScaler.dll'));
  assert.ok(journal.replaced.some((r) => r.rel === 'OptiScaler.ini'), 'the foreign ini was backed up, not clobbered');

  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.deepEqual(listing(game), before, 'folder identical to before the install');
  assert.match(fs.readFileSync(path.join(game, 'OptiScaler.ini'), 'utf8'), /someone else/);
});

test('Remove also clears what older versions placed and leaves a game\'s own Streamline folder', { skip: !onWindows }, async () => {
  const base = scratchDir('legacy');
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  for (const f of ['OptiScaler_DlssNr.addon64', 'OptiScaler_DlssNr.pdb', 'Verify-DLSS5Feeder.ps1', '.optdlss5-active-manifest.json', 'OptiScaler_DLSSNR-v1.0.3.zip', 'ReShade.log1']) write(game, f);
  write(game, 'Streamline/sl.interposer.dll', 'the game\'s own');
  const { invoke } = loadMain();
  const st = await invoke('game:status', exe);
  assert.ok(st.backends.leftovers.includes('OptiScaler_DlssNr.addon64'), 'legacy names show as leftovers so the card offers Remove');
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  const left = listing(game);
  for (const f of ['OptiScaler_DlssNr.addon64', 'OptiScaler_DlssNr.pdb', 'Verify-DLSS5Feeder.ps1', '.optdlss5-active-manifest.json', 'OptiScaler_DLSSNR-v1.0.3.zip', 'ReShade.log1']) assert.ok(!left.includes(f), f + ' removed');
  assert.ok(left.includes('Streamline/'), 'an unjournaled Streamline folder is never ours to delete');
  assert.ok(un.kept.some((k) => /streamline/i.test(k)), 'and Remove says so');
});

test('the other-toolchain removal deletes only what that tool placed, after the confirmation', { skip: !onWindows }, async () => {
  const base = scratchDir('foreign');
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  for (const f of ['INSTALL-DLSSNR.md', 'Core/dlss5-feed.addon64', 'nvngx_dlssnr_proxy.dll', 'nvngx_dlss.dll.dlss5oneclick', 'DLSS5 Screenshots/shot.png', 'anadius64.dll']) write(game, f);
  write(game, 'nvngx_dlss.dll', 'their copy');
  const { invoke } = loadMain({ dialogResponse: 0 });
  const st = await invoke('game:status', exe);
  assert.ok(st.foreign.some((f) => f.tool === 'DLSS5oneclick'));
  const r = await invoke('game:removeForeign', exe);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.cancelled, false);
  const left = listing(game);
  assert.ok(!left.includes('Core/') && !left.includes('INSTALL-DLSSNR.md') && !left.includes('nvngx_dlssnr_proxy.dll'));
  assert.ok(left.includes('DLSS5 Screenshots/') && left.includes('anadius64.dll'), 'unrelated files untouched');
  assert.equal(fs.readFileSync(path.join(game, 'nvngx_dlss.dll'), 'utf8'), 'x', 'the tool\'s backup of the game file was restored');

  const declined = loadMain({ dialogResponse: 1 });
  const game2 = path.join(base, 'game2');
  const exe2 = fakeExe(game2, 'Game.exe');
  write(game2, 'INSTALL-DLSSNR.md');
  const r2 = await declined.invoke('game:removeForeign', exe2);
  assert.equal(r2.cancelled, true);
  assert.ok(fs.existsSync(path.join(game2, 'INSTALL-DLSSNR.md')), 'Cancel deletes nothing');
});
