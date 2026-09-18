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
