// OptiScaler's own frame generation, per game (main.js optifg:*): the generator is chosen in Edit and
// armed at launch; on/off and HUD fix switch live. Driven through the real IPC handlers against a fake
// game folder -- no game is started.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write, fakeExe, loadMain } = require('./helpers');

// The [FrameGen] / [OptiFG] / [DlssNr] shape of OptiScaler's shipped ini, with DlssNr's own Enabled in
// it so a test can tell the two apart.
const INI = [
  '[FrameGen]', 'Enabled=auto', 'FGInput=auto', 'FGOutput=auto', '',
  '[OptiFG]', 'HUDFix=auto', '',
  '[Upscalers]', 'Dx12Upscaler=auto', '',
  '[DlssNr]', 'Enabled=true', '',
].join('\r\n');

function dx12Game(name) {
  const dir = scratchDir(name);
  const exe = fakeExe(dir, 'Game.exe');
  fs.writeFileSync(path.join(dir, 'OptiScaler.ini'), INI);
  write(dir, 'nvngx_dlss.dll');
  for (const f of ['libxess_fg.dll', 'libxell.dll', 'amd_fidelityfx_loader_dx12.dll', 'amd_fidelityfx_framegeneration_dx12.dll']) {
    write(dir, path.join('OptiScaler', f));
  }
  return { dir, exe };
}

const iniKey = (dir, section, key) => {
  const text = fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8');
  const body = (new RegExp(`^\\[${section}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'im').exec(text) || [])[1] || '';
  return ((new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, 'im').exec(body)) || [])[1] || null;
};

test('XeFG armed but off: the swapchain gets the generator, frame generation starts off', async () => {
  const { dir, exe } = dx12Game('optifg-arm');
  const { invoke } = loadMain();
  await invoke('game:setApiOverride', { exePath: exe, api: 'dx12' });

  const ready = await invoke('optifg:readiness', exe);
  assert.equal(ready.supported, true, ready.reason);
  assert.equal(ready.recommended, 'xefg');

  const res = await invoke('optifg:set', { exePath: exe, generator: 'xefg', startOn: false });
  assert.equal(res.ok, true, res.error);
  assert.equal(iniKey(dir, 'FrameGen', 'FGOutput'), 'xefg');
  assert.equal(iniKey(dir, 'FrameGen', 'FGInput'), 'upscaler');
  assert.equal(iniKey(dir, 'FrameGen', 'Enabled'), 'false');
  // DLSS 5's own switch is a different key in a different section, and is left alone.
  assert.equal(iniKey(dir, 'DlssNr', 'Enabled'), 'true');
});

test('the live switches write [FrameGen] Enabled and [OptiFG] HUDFix, and only once armed', async () => {
  const { dir, exe } = dx12Game('optifg-live');
  const { invoke } = loadMain();
  await invoke('game:setApiOverride', { exePath: exe, api: 'dx12' });

  const early = await invoke('optifg:live-set', { exePath: exe, enabled: true });
  assert.equal(early.ok, false, 'nothing to switch before a generator is armed');

  await invoke('optifg:set', { exePath: exe, generator: 'fsrfg', startOn: false });
  const on = await invoke('optifg:live-set', { exePath: exe, enabled: true, hudfix: true });
  assert.equal(on.ok, true, on.error);
  assert.deepEqual({ armed: on.armed, generator: on.generator, enabled: on.enabled, hudfix: on.hudfix },
    { armed: true, generator: 'fsrfg', enabled: true, hudfix: true });
  assert.equal(iniKey(dir, 'OptiFG', 'HUDFix'), 'true');
  assert.equal(iniKey(dir, 'DlssNr', 'LiveReload'), 'true', 'the engine has to re-read the ini for this to be live');
});

test('None disarms: the generator this app put there comes back out, not only switched off', async () => {
  const { dir, exe } = dx12Game('optifg-none');
  const { invoke } = loadMain();
  await invoke('game:setApiOverride', { exePath: exe, api: 'dx12' });
  await invoke('optifg:set', { exePath: exe, generator: 'xefg', startOn: true });
  assert.equal(iniKey(dir, 'FrameGen', 'FGOutput'), 'xefg');

  const res = await invoke('optifg:set', { exePath: exe, generator: 'none' });
  assert.equal(res.ok, true, res.error);
  assert.equal(iniKey(dir, 'FrameGen', 'FGOutput'), 'auto');
  assert.equal(iniKey(dir, 'FrameGen', 'Enabled'), 'false');
});

test('a game with DLSS Frame Generation of its own is refused, and keeps it', async () => {
  const { dir, exe } = dx12Game('optifg-own-dlssg');
  write(dir, 'nvngx_dlssg.dll');
  const { invoke } = loadMain();
  await invoke('game:setApiOverride', { exePath: exe, api: 'dx12' });

  const ready = await invoke('optifg:readiness', exe);
  assert.equal(ready.supported, false);
  const res = await invoke('optifg:set', { exePath: exe, generator: 'xefg', startOn: true });
  assert.equal(res.ok, false);
  assert.equal(iniKey(dir, 'FrameGen', 'FGOutput'), 'auto');
});

test('an old marker (a bare timestamp) still reads as FSR FG, on', async () => {
  const { dir, exe } = dx12Game('optifg-old-marker');
  fs.writeFileSync(path.join(dir, '.dlss5ui-optifg-enabled'), '2026-09-09T10:00:00.000Z');
  const { invoke } = loadMain();
  await invoke('game:setApiOverride', { exePath: exe, api: 'dx12' });

  const ready = await invoke('optifg:readiness', exe);
  assert.equal(ready.generator, 'fsrfg');
  assert.equal(ready.startOn, true);
  assert.equal(iniKey(dir, 'FrameGen', 'FGOutput'), 'fsrfg');
  assert.equal(iniKey(dir, 'FrameGen', 'Enabled'), 'true');
});
