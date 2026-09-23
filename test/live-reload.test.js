// [DlssNr] LiveReload=true reaches every game's ini, including one that has no LiveReload line yet.
//
// The pop-out panel and Edit work only by writing OptiScaler.ini, and until 2026-09-23 a DX11/DX12
// game never re-read it after launch: the app's LiveReload edit went through patchIniDefaults, which
// only rewrites lines already in the file, and OptiScaler's template has no such line. So the edit
// silently did nothing and the pop-out changed nothing (MSFS 2024, #123).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, fakeExe, loadMain } = require('./helpers');

// The shape of OptiScaler's shipped ini: a [DlssNr] section, and no LiveReload line in it.
const TEMPLATE = ['[Upscalers]', 'Dx12Upscaler=auto', '', '[DlssNr]', 'Enabled=auto', '', '[Log]', 'LogToFile=auto', ''].join('\r\n');

const liveReload = (dir) => {
  const m = /^\s*LiveReload\s*=\s*(.*)$/im.exec(fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8'));
  return m ? m[1].trim() : null;
};

test('configuring a game adds LiveReload=true when its ini has no such line', async () => {
  const dir = scratchDir('live-reload-configure');
  const exe = fakeExe(dir, 'Game.exe');
  fs.writeFileSync(path.join(dir, 'OptiScaler.ini'), TEMPLATE);
  const { invoke } = loadMain();

  // game:setApiOverride re-runs autoConfigureGame on an installed game, as every sync does.
  const res = await invoke('game:setApiOverride', { exePath: exe, api: 'dx12' });
  assert.equal(res.ok, true, res.error);
  assert.equal(liveReload(dir), 'true');
  await invoke('game:setApiOverride', { exePath: exe, api: null });
});

test('configuring puts LiveReload back to true whatever it was left at', async () => {
  const dir = scratchDir('live-reload-heal');
  const exe = fakeExe(dir, 'Game.exe');
  fs.writeFileSync(path.join(dir, 'OptiScaler.ini'), TEMPLATE.replace('Enabled=auto', 'Enabled=auto\r\nLiveReload=auto'));
  const { invoke } = loadMain();

  await invoke('game:setApiOverride', { exePath: exe, api: 'dx11' });
  assert.equal(liveReload(dir), 'true');
  await invoke('game:setApiOverride', { exePath: exe, api: null });
});

test('a pop-out or Edit save turns LiveReload on for a game installed before this fix', async () => {
  const dir = scratchDir('live-reload-save');
  const exe = fakeExe(dir, 'Game.exe');
  fs.writeFileSync(path.join(dir, 'OptiScaler.ini'), TEMPLATE);
  const { invoke } = loadMain();

  const res = await invoke('dlssnr:set', { exePath: exe, values: {} });
  assert.equal(res.ok, true, res.error);
  assert.equal(liveReload(dir), 'true');
});
