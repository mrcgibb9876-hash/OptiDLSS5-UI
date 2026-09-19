// High performance for the game and the Feeder's helper on hybrid laptops (src/gpupref.js), and
// Remove putting back exactly what was there. The registry is a fake reg.exe over a Map.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, scratchDir, write } = require('./helpers');
const gpupref = require(path.join(REPO, 'src', 'gpupref'));

const HYBRID = { devices: [{ vendorId: 0x10de, deviceId: 0x2820, vendor: 'nvidia' }, { vendorId: 0x8086, deviceId: 0xa7a0 }] };
const DESKTOP = { devices: [{ vendorId: 0x10de, deviceId: 0x2684, vendor: 'nvidia' }] };

function fakeRegistry(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  const execFileAsync = async (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'query') {
      const lines = [...values].map(([k, v]) => `    ${k}    REG_SZ    ${v}`);
      return { stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\DirectX\\UserGpuPreferences\r\n${lines.join('\r\n')}\r\n` };
    }
    if (args[0] === 'add') { values.set(args[3], args[7]); return { stdout: '' }; }
    if (args[0] === 'delete') { values.delete(args[3]); return { stdout: '' }; }
    throw new Error('unexpected ' + args[0]);
  };
  return { values, calls, execFileAsync };
}

test('a hybrid laptop gets High performance for the game and the helper; Remove puts it all back', async () => {
  const dir = scratchDir('gpupref-hybrid');
  const exe = write(dir, 'Game.exe', 'x');
  const host = write(dir, 'host64/dlss5-feed-host64.exe', 'x');
  const reg = fakeRegistry({ [exe]: 'SwapEffectUpgradeEnable=1;' });
  const r = await gpupref.ensureHighPerformance(dir, [exe], { execFileAsync: reg.execFileAsync, gpuInfo: HYBRID });
  assert.deepEqual(r.set.sort(), [exe, host].sort());
  assert.equal(reg.values.get(exe), 'GpuPreference=2;SwapEffectUpgradeEnable=1;');
  assert.equal(reg.values.get(host), 'GpuPreference=2;');
  assert.ok(fs.existsSync(path.join(dir, gpupref.MARKER)));

  const back = await gpupref.restore(dir, { execFileAsync: reg.execFileAsync });
  assert.equal(back.restored.length, 2);
  assert.equal(reg.values.get(exe), 'SwapEffectUpgradeEnable=1;');
  assert.equal(reg.values.has(host), false);
  assert.ok(!fs.existsSync(path.join(dir, gpupref.MARKER)));
});

test('a desktop with one GPU is left alone', async () => {
  const dir = scratchDir('gpupref-desktop');
  const exe = write(dir, 'Game.exe', 'x');
  const reg = fakeRegistry();
  const r = await gpupref.ensureHighPerformance(dir, [exe], { execFileAsync: reg.execFileAsync, gpuInfo: DESKTOP });
  assert.equal(r.skipped, 'not-hybrid');
  assert.deepEqual(reg.calls, []);
});

test('sync only looks at exes it has not seen, and a player\'s later choice survives Remove', async () => {
  const dir = scratchDir('gpupref-sync');
  const exe = write(dir, 'Game.exe', 'x');
  const reg = fakeRegistry();
  await gpupref.ensureHighPerformance(dir, [exe], { execFileAsync: reg.execFileAsync, gpuInfo: HYBRID });
  reg.calls.length = 0;
  // Nothing new: no registry read at all.
  await gpupref.ensureHighPerformance(dir, [exe], { execFileAsync: reg.execFileAsync, gpuInfo: HYBRID, onlyNew: true });
  assert.deepEqual(reg.calls, []);
  // The 32-bit route's helper arrives: only it is set.
  const host = write(dir, 'host64/dlss5-feed-host64.exe', 'x');
  const r = await gpupref.ensureHighPerformance(dir, [exe], { execFileAsync: reg.execFileAsync, gpuInfo: HYBRID, onlyNew: true });
  assert.deepEqual(r.set, [host]);

  // The player switches the game to Power saving in Windows Settings: Remove leaves that alone.
  reg.values.set(exe, 'GpuPreference=1;');
  await gpupref.restore(dir, { execFileAsync: reg.execFileAsync });
  assert.equal(reg.values.get(exe), 'GpuPreference=1;');
  assert.equal(reg.values.has(host), false);
});

test('an exe already on High performance is not recorded as ours', async () => {
  const dir = scratchDir('gpupref-already');
  const exe = write(dir, 'Game.exe', 'x');
  const reg = fakeRegistry({ [exe]: 'GpuPreference=2;' });
  const r = await gpupref.ensureHighPerformance(dir, [exe], { execFileAsync: reg.execFileAsync, gpuInfo: HYBRID });
  assert.deepEqual(r.set, []);
  await gpupref.restore(dir, { execFileAsync: reg.execFileAsync });
  assert.equal(reg.values.get(exe), 'GpuPreference=2;');
});
