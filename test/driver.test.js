'use strict';
// The NVIDIA driver floor for DLSS 5, and turning the version Windows reports into the one NVIDIA
// and every error message actually use.
//
// The app already knew a driver could be too old, but only after the fact: the Feeder's log carries
// the driver's own "feature 18 as OutOfDate ... updated to 616.56 or newer" line, runlog.js reads
// it into feedDriverOutdated, and Game Help shows it for that one game once it has been run. A
// machine below the floor cannot run the neural pass in ANY game, so the user was installing to
// game after game and watching each one quietly do nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO } = require('./helpers');
const gpu = require(path.join(REPO, 'src', 'gpu'));

test('a Windows driver version becomes the number NVIDIA calls it', () => {
  // The two that are not arithmetic but evidence. Issue #50 reported "driver 32.0.16.1692" and its
  // owner wrote "Game Ready Driver 616.92"; the Dolphin bundle of 2026-09-15 reported
  // "32.0.16.1664" and its dlss5-feed.log logged "driver 616.64".
  assert.equal(gpu.nvidiaDriverBranch('32.0.16.1692'), '616.92');
  assert.equal(gpu.nvidiaDriverBranch('32.0.16.1664'), '616.64');
  // And two older shapes, where the third part is shorter.
  assert.equal(gpu.nvidiaDriverBranch('32.0.15.7602'), '576.02');
  assert.equal(gpu.nvidiaDriverBranch('31.0.15.5222'), '552.22');

  // Anything that is not one of these says so, rather than inventing a number to compare.
  for (const junk of [null, undefined, '', 'unknown', '32.0.16', '1.2.3.4']) {
    assert.equal(gpu.nvidiaDriverBranch(junk), null, `${junk} should not parse`);
  }
});

test('616.9 is newer than 616.56, which a string or a float would both get wrong', () => {
  // parseFloat makes 616.9 look older than 616.56, and a string compare makes "616.9" < "616.56".
  // The minor part is two digits, so 616.9 is 616.90.
  assert.ok(gpu.compareDriverBranch('616.9', '616.56') > 0);
  assert.ok(gpu.compareDriverBranch('616.90', '616.56') > 0);
  assert.ok(gpu.compareDriverBranch('616.56', '616.56') === 0);
  assert.ok(gpu.compareDriverBranch('610.88', '616.56') < 0);
  assert.ok(gpu.compareDriverBranch('580.00', '616.56') < 0);
  assert.ok(gpu.compareDriverBranch('700.10', '616.56') > 0);
});

test('the floor is the driver\'s own number, and only NVIDIA is judged against it', () => {
  assert.equal(gpu.MIN_NVIDIA_DRIVER, '616.56', 'quoted from the driver\'s OutOfDate message, not chosen here');

  // DOOM 3 BFG, 2026-09-13: driver 610.88, the model crashed in its first evaluate.
  const old = gpu.driverStatus({ vendor: 'nvidia', driverVersion: '32.0.16.1088' });
  assert.deepEqual(old, { checked: true, outdated: true, branch: '610.88', minimum: '616.56' });

  const fine = gpu.driverStatus({ vendor: 'nvidia', driverVersion: '32.0.16.1692' });
  assert.equal(fine.checked, true);
  assert.equal(fine.outdated, false);
  assert.equal(fine.branch, '616.92');

  // Exactly the minimum is not "too old".
  assert.equal(gpu.driverStatus({ vendor: 'nvidia', driverVersion: '32.0.16.1656' }).outdated, false);
});

test('an unknown or non-NVIDIA driver produces no warning at all', () => {
  // A false alarm on the app's front page is worse than saying nothing: AMD and Intel have their
  // own routes (amdnr.js, and route.js's unsupported branch), and this number means nothing there.
  for (const vendor of ['amd', 'intel', 'unknown']) {
    const s = gpu.driverStatus({ vendor, driverVersion: '32.0.12033.1030' });
    assert.equal(s.checked, false, vendor);
    assert.equal(s.outdated, false, vendor);
  }
  // NVIDIA but the version did not parse: still silent.
  const unparsed = gpu.driverStatus({ vendor: 'nvidia', driverVersion: null });
  assert.equal(unparsed.checked, false);
  assert.equal(unparsed.outdated, false);
});

test('detectGpu carries the verdict, so the front page does not recompute it', async () => {
  // The driver version comes from Chromium's own adapter here rather than from
  // Win32_VideoController: describeAdapters short-circuits off Windows, so the PowerShell half
  // cannot run in this suite. The fallback it exercises is the same one a real machine uses when
  // that query fails, which is worth covering either way.
  const app = {
    getGPUInfo: async () => ({ gpuDevice: [{ vendorId: 0x10de, deviceId: 0x2803, active: true, driverVersion: '32.0.16.1088' }] }),
  };
  const info = await gpu.detectGpu(app, async () => ({ stdout: '' }));
  assert.equal(info.vendor, 'nvidia');
  assert.equal(info.driverVersion, '32.0.16.1088');
  assert.deepEqual(info.driver, { checked: true, outdated: true, branch: '610.88', minimum: '616.56' },
    'the verdict rides along, so the banner does not have to parse a version itself');

  // A machine whose driver cannot be read at all: vendor known, nothing claimed about the driver.
  const quiet = await gpu.detectGpu(
    { getGPUInfo: async () => ({ gpuDevice: [{ vendorId: 0x10de, active: true }] }) },
    async () => ({ stdout: '' }),
  );
  assert.equal(quiet.driver.checked, false);
  assert.equal(quiet.driver.outdated, false);
});

test('an Optimus laptop, whose window draws on the Intel iGPU, still gets the NVIDIA verdict', async () => {
  // Chromium marks the iGPU active, so the primary vendor is 'intel' -- the NVIDIA card the games run
  // on is only in the device list. Review of 2026-09-18: the banner never showed on such a laptop.
  const s = gpu.driverStatus({
    vendor: 'intel',
    driverVersion: '31.0.101.5186',
    adapters: [{ vendorId: 0x8086, driverVersion: '31.0.101.5186' }, { vendorId: 0x10de, driverVersion: '32.0.16.1088' }],
  });
  assert.deepEqual(s, { checked: true, outdated: true, branch: '610.88', minimum: '616.56' });
  // An AMD or Intel machine with no NVIDIA adapter anywhere stays silent.
  assert.equal(gpu.driverStatus({ vendor: 'amd', driverVersion: '32.0.12033.1030', adapters: [{ vendorId: 0x1002, driverVersion: '32.0.12033.1030' }] }).checked, false);

  // Through detectGpu, from Chromium's own device list.
  const info = await gpu.detectGpu({
    getGPUInfo: async () => ({ gpuDevice: [
      { vendorId: 0x8086, deviceId: 0x46a6, active: true, driverVersion: '31.0.101.5186' },
      { vendorId: 0x10de, deviceId: 0x28a0, active: false, driverVersion: '32.0.16.1088' },
    ] }),
  }, async () => ({ stdout: '' }));
  assert.equal(info.vendor, 'nvidia', 'and since the same day the vendor is the NVIDIA card too (pickPrimary)');
  assert.equal(info.driver.outdated, true);
  assert.equal(info.driver.branch, '610.88');
});

// User report, 2026-09-18: an AMD iGPU + RTX 4060 laptop was treated as an AMD machine, because
// Chromium marks the adapter the app's own window renders on (the iGPU) active and that one won.
test('the vendor is the adapter games run on, not the one the app window renders on', async () => {
  const amdIgpu = { vendorId: 0x1002, deviceId: 0x15bf, active: true, driverVersion: '31.0.24002.92' };
  const intelIgpu = { vendorId: 0x8086, deviceId: 0x46a6, active: true, driverVersion: '31.0.101.5186' };
  const rtx4060 = { vendorId: 0x10de, deviceId: 0x28a0, active: false, driverVersion: '32.0.16.1692' };
  const radeon7800 = { vendorId: 0x1002, deviceId: 0x747e, active: false, driverVersion: '32.0.12033.1030' };

  assert.equal(gpu.vendorFromId(gpu.pickPrimary([amdIgpu, rtx4060]).vendorId), 'nvidia', 'AMD iGPU (active) + NVIDIA');
  assert.equal(gpu.vendorFromId(gpu.pickPrimary([intelIgpu, rtx4060]).vendorId), 'nvidia', 'Intel iGPU (active) + NVIDIA');
  assert.equal(gpu.vendorFromId(gpu.pickPrimary([{ ...radeon7800, active: true }]).vendorId), 'amd', 'AMD only');
  assert.equal(gpu.vendorFromId(gpu.pickPrimary([{ ...rtx4060, active: true }]).vendorId), 'nvidia', 'NVIDIA only');
  // AMD APU + discrete Radeon: the discrete card, by device ID or by name.
  assert.equal(gpu.pickPrimary([amdIgpu, radeon7800]).deviceId, 0x747e);
  const unknownApu = { vendorId: 0x1002, deviceId: 0x1900, active: true };
  const rows = [
    { vendorId: 0x1002, deviceId: 0x1900, name: 'AMD Radeon(TM) Graphics' },
    { vendorId: 0x1002, deviceId: 0x747e, name: 'AMD Radeon RX 7800 XT' },
  ];
  assert.equal(gpu.pickPrimary([unknownApu, radeon7800], rows).deviceId, 0x747e);
  // Intel iGPU + Intel Arc: the Arc card; Intel iGPU + discrete Radeon: the Radeon.
  assert.equal(gpu.isIntegrated({ vendorId: 0x8086 }, { name: 'Intel(R) Arc(TM) A770 Graphics' }), false);
  assert.equal(gpu.isIntegrated({ vendorId: 0x8086 }, { name: 'Intel(R) Arc(TM) Graphics' }), true);
  assert.equal(gpu.vendorFromId(gpu.pickPrimary([intelIgpu, radeon7800]).vendorId), 'amd');
  for (const name of ['AMD Radeon 780M Graphics', 'AMD Radeon(TM) Graphics', 'AMD Radeon(TM) Vega 8 Graphics', 'AMD Radeon(TM) 8060S Graphics']) {
    assert.equal(gpu.isIntegrated({ vendorId: 0x1002, deviceId: 0x1 }, { name }), true, name);
  }
  for (const name of ['AMD Radeon RX 7600M XT', 'AMD Radeon RX 9070 XT', 'AMD Radeon Pro W7900', null]) {
    assert.equal(gpu.isIntegrated({ vendorId: 0x1002, deviceId: 0x1 }, { name }), false, String(name));
  }
  // Chromium listed only the adapter it renders on; Win32_VideoController still has the NVIDIA card.
  assert.equal(gpu.vendorFromId(gpu.pickPrimary([amdIgpu], [{ vendorId: 0x10de, deviceId: 0x28a0, name: 'NVIDIA GeForce RTX 4060 Laptop GPU', driverVersion: '32.0.16.1692' }]).vendorId), 'nvidia');

  // Through detectGpu: vendor, the NVIDIA card's name and driver, and the window's adapter kept apart.
  const cim = JSON.stringify([
    { Name: 'AMD Radeon 780M Graphics', DriverVersion: '31.0.24002.92', PNPDeviceID: 'PCI\\VEN_1002&DEV_15BF&SUBSYS_1' },
    { Name: 'NVIDIA GeForce RTX 4060 Laptop GPU', DriverVersion: '32.0.16.1088', PNPDeviceID: 'PCI\\VEN_10DE&DEV_28A0&SUBSYS_2' },
  ]);
  const info = await gpu.detectGpu({ getGPUInfo: async () => ({ gpuDevice: [amdIgpu, { ...rtx4060, driverVersion: undefined }] }) }, async () => ({ stdout: cim }));
  assert.equal(info.vendor, 'nvidia');
  assert.equal(info.devices.length, 2, 'every adapter is still reported');
  assert.equal(info.renderAdapter.vendor, 'amd', 'the adapter the app renders on is kept, separately');
  if (process.platform === 'win32') {
    assert.equal(info.name, 'NVIDIA GeForce RTX 4060 Laptop GPU');
    assert.equal(info.driver.branch, '610.88', 'the NVIDIA card\'s driver is the one judged');
    assert.equal(info.driver.outdated, true);
  }
});

test('the warning is wired into the front page and can be dismissed', () => {
  // The renderer is a plain script, so this is the only thing standing between a typo here and a
  // banner that never appears -- or worse, a listener bound to null that kills the whole window.
  const renderer = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'index.html'), 'utf8');

  for (const id of ['driver-banner', 'driver-banner-text', 'btn-driver-download', 'btn-driver-dismiss']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html is missing ${id}`);
  }
  assert.match(renderer, /function refreshDriverBanner\(\)/);
  assert.match(renderer, /refreshDriverBanner\(\);/, 'and it runs at init, once the GPU is known');
  // Dismissal is remembered against the version it was shown for, so a driver update brings it back.
  assert.match(renderer, /localStorage\.setItem\('driver-warning-dismissed'/);
  assert.match(renderer, /localStorage\.getItem\('driver-warning-dismissed'\) === branch/);
});
