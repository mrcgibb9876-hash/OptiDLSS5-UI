'use strict';
// The multiplier of a game's OWN NVIDIA Frame Generation: a per-game marker that lands in
// OptiScaler.ini as [DLSSG] OverrideInterpolationCount (1 = 2x, 2 = 3x, 3 = 4x) / OverrideForceDMFG,
// re-applied by autoConfigureGame so an install (which copies the release ini wholesale) keeps
// it. Only for a game that has an nvngx_dlssg.dll to drive; "game setting" removes the marker
// and clears whatever it wrote, and a value set from the in-game panel is left alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write, fakeExe, loadMain } = require('./helpers');

const INI = '[Upscalers]\nDx12Upscaler=auto\n[FrameGen]\nEnabled=auto\n[DLSSG]\nInterpolationCount=auto\nOverrideInterpolationCount=auto\nOverrideForceDMFG=auto\nFramerateTargetDMFG=auto\n[Log]\nLogToFile=auto\n[DlssNr]\nEnabled=auto\n';

function iniValue(iniPath, key) {
  const m = fs.readFileSync(iniPath, 'utf-8').match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

test('a game without its own DLSS-G gets no multiplier control', async () => {
  const dir = scratchDir('fgmult-none');
  const exe = fakeExe(dir);
  write(dir, 'OptiScaler.ini', INI);
  const { invoke } = loadMain();
  const state = await invoke('framegen:multiplier', exe);
  assert.equal(state.hasFrameGen, false);
  const res = await invoke('framegen:setMultiplier', { exePath: exe, frames: 2 });
  assert.equal(res.ok, false);
  assert.match(res.error, /nvngx_dlssg\.dll/);
});

test('3x lands in the ini, is read back, and "game setting" clears it and the marker', async () => {
  const dir = scratchDir('fgmult-set');
  const exe = fakeExe(dir);
  write(dir, 'nvngx_dlssg.dll', 'fake dlssg');
  const ini = write(dir, 'OptiScaler.ini', INI);
  const { invoke } = loadMain();

  const res = await invoke('framegen:setMultiplier', { exePath: exe, frames: 2, dynamic: false });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.deferred, false);
  assert.equal(iniValue(ini, 'OverrideInterpolationCount'), '2');
  assert.equal(iniValue(ini, 'OverrideForceDMFG'), 'auto');
  assert.ok(fs.existsSync(path.join(dir, '.dlss5ui-framegen.json')));

  const state = await invoke('framegen:multiplier', exe);
  assert.equal(state.hasFrameGen, true);
  assert.equal(state.marker.frames, 2);
  assert.equal(state.marker.dynamic, false);
  assert.equal(state.ini.frames, '2');

  const dyn = await invoke('framegen:setMultiplier', { exePath: exe, dynamic: true, target: 120 });
  assert.equal(dyn.ok, true, dyn.error);
  assert.equal(iniValue(ini, 'OverrideInterpolationCount'), 'auto');
  assert.equal(iniValue(ini, 'OverrideForceDMFG'), 'true');
  assert.equal(iniValue(ini, 'FramerateTargetDMFG'), '120');

  const back = await invoke('framegen:setMultiplier', { exePath: exe, frames: null, dynamic: false });
  assert.equal(back.ok, true, back.error);
  assert.equal(back.cleared, true);
  assert.equal(iniValue(ini, 'OverrideInterpolationCount'), 'auto');
  assert.equal(iniValue(ini, 'OverrideForceDMFG'), 'auto');
  assert.equal(fs.existsSync(path.join(dir, '.dlss5ui-framegen.json')), false);
});

test('a multiplier picked before OptiScaler is installed is deferred, and a panel-set value is reported but left alone', async () => {
  const dir = scratchDir('fgmult-deferred');
  const exe = fakeExe(dir);
  write(dir, 'nvngx_dlssg.dll', 'fake dlssg');
  const { invoke } = loadMain();

  const res = await invoke('framegen:setMultiplier', { exePath: exe, frames: 3 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.deferred, true);
  const state = await invoke('framegen:multiplier', exe);
  assert.equal(state.iniPresent, false);
  assert.equal(state.marker.frames, 3);

  // No marker + a value the in-game panel wrote: reported as the ini's, never rewritten.
  fs.rmSync(path.join(dir, '.dlss5ui-framegen.json'));
  const ini = write(dir, 'OptiScaler.ini', INI.replace('OverrideInterpolationCount=auto', 'OverrideInterpolationCount=1'));
  const panel = await invoke('framegen:multiplier', exe);
  assert.equal(panel.marker, null);
  assert.equal(panel.ini.frames, '1');
  assert.equal(iniValue(ini, 'OverrideInterpolationCount'), '1');
});

test('an Unreal game keeps its DLSS-G in the plugin tree and still gets the control', async () => {
  const root = scratchDir('fgmult-ue');
  const exeDir = path.join(root, 'SB', 'Binaries', 'Win64');
  const exe = fakeExe(exeDir, 'SB-Win64-Shipping.exe');
  write(root, 'Engine/Binaries/Win64/CrashReportClient.exe', 'x');
  write(root, 'SB/Plugins/Runtime/Nvidia/Streamline/Binaries/ThirdParty/Win64/nvngx_dlssg.dll', 'fake');
  const ini = write(exeDir, 'OptiScaler.ini', INI);
  const { invoke } = loadMain();
  const res = await invoke('framegen:setMultiplier', { exePath: exe, frames: 1 });
  assert.equal(res.ok, true, res.error);
  assert.equal(iniValue(ini, 'OverrideInterpolationCount'), '1');
});
