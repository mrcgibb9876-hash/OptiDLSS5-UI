'use strict';
// Deep Fried Chicken as a per-game neural consumer (dfc.js), instead of only a clash to clear out.
//
// The facts these tests pin down come from the DLSS5-Feeder README, which documents the interop:
// DFC "does the neural rendering on top of what this project feeds it", its three files go beside
// the exe for a 64-bit game but "in the host64\ folder next to dlss5-feed-host64.exe" for a 32-bit
// one, and "If Deep Fried Chicken finds RenoDX's add-on or Alex's Toolkit loaded beside it, it does
// nothing at all for the whole session." That last one is silent, which is what makes it dangerous.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe, loadMain } = require('./helpers');
const dfc = require(path.join(REPO, 'src', 'dfc'));
const detect = require(path.join(REPO, 'src', 'detect'));
const route = require(path.join(REPO, 'src', 'route'));

const DX12 = { api: 'dx12', apis: ['dx12'], bitness: 64, recommend: 'optiscaler' };

function putDfc(dir) {
  for (const f of dfc.DFC_FILES) write(dir, f, 'x');
}

test('a game nobody has touched is on OptiScaler, and choosing it back leaves no marker behind', () => {
  const dir = scratchDir('dfc-default');
  assert.equal(dfc.consumerFor(dir), 'optiscaler');
  assert.equal(dfc.dfcChosen(dir), false);
  assert.ok(!fs.existsSync(path.join(dir, dfc.MARKER)), 'the default writes nothing');

  dfc.setConsumer(dir, 'dfc');
  assert.equal(dfc.consumerFor(dir), 'dfc');
  assert.ok(fs.existsSync(path.join(dir, dfc.MARKER)));

  // Back to the default: the marker goes, so the folder is what it was before anyone chose.
  dfc.setConsumer(dir, 'optiscaler');
  assert.equal(dfc.consumerFor(dir), 'optiscaler');
  assert.ok(!fs.existsSync(path.join(dir, dfc.MARKER)));

  assert.throws(() => dfc.setConsumer(dir, 'renodx'), /unknown neural consumer/);
});

test('a 32-bit game\'s DFC files belong in host64, not beside the exe', () => {
  const dir = scratchDir('dfc-host64');
  assert.equal(dfc.dfcDir(dir, 64), dir);
  assert.equal(dfc.dfcDir(dir, 32), path.join(dir, 'host64'));

  // Beside the exe is the wrong place for a 32-bit game, and the status says so rather than
  // reporting the files as present.
  putDfc(dir);
  const asked32 = dfc.dfcStatus(dir, 32);
  assert.equal(asked32.present, false);
  assert.equal(asked32.inHostDir, true);
  assert.deepEqual(asked32.missing, dfc.DFC_FILES);

  for (const f of dfc.DFC_FILES) write(dir, `host64/${f}`, 'x');
  const now32 = dfc.dfcStatus(dir, 32);
  assert.equal(now32.present, true);
  assert.deepEqual(now32.missing, []);
});

test('a half-copied DFC is reported as half-copied, naming what is missing', () => {
  const dir = scratchDir('dfc-partial');
  write(dir, 'deep-fried-chicken.addon64', 'x');
  const st = dfc.dfcStatus(dir, 64);
  assert.equal(st.present, false);
  assert.equal(st.partial, true);
  assert.deepEqual(st.missing, ['deep-fried-chicken-nvngx.dll', 'deep-fried-chicken.cfg']);

  const blockers = dfc.dfcBlockers(dir, { bitness: 64 });
  assert.match(blockers.find((b) => b.key === 'dfc-files').detail, /only half here/);
});

test('the silent killers are both named: OptiScaler\'s own pass, and another add-on in the folder', () => {
  const dir = scratchDir('dfc-blockers');
  putDfc(dir);
  assert.deepEqual(dfc.dfcBlockers(dir, { bitness: 64 }), [], 'files in place and nothing else running');

  const withOpti = dfc.dfcBlockers(dir, { bitness: 64, optiScalerNrOn: true });
  assert.match(withOpti.find((b) => b.key === 'dfc-optiscaler-nr').detail, /does nothing at all/);

  // ReShade loads every .addon64 whatever it is called, so a renamed one still counts -- the same
  // trap that hid a RenoDX add-on on SWTOR.
  write(dir, 'Xrenodx-dlss5.addon64', 'x');
  assert.deepEqual(dfc.rivalNeuralAddons(dir, 64), ['Xrenodx-dlss5.addon64']);
  assert.ok(dfc.dfcBlockers(dir, { bitness: 64 }).some((b) => b.key === 'dfc-rival-addon'));
});

test('DFC is a conflict until it is the chosen consumer, and then it is not', () => {
  const dir = scratchDir('dfc-foreign');
  putDfc(dir);

  const asRival = detect.foreignToolchains(dir);
  assert.deepEqual(asRival.map((f) => f.tool), ['Deep Fried Chicken'],
    'unchosen, it is still the silent clash it always was');

  dfc.setConsumer(dir, 'dfc');
  assert.deepEqual(detect.foreignToolchains(dir), [],
    'chosen, offering to delete it would delete the route the user just picked');

  dfc.setConsumer(dir, 'optiscaler');
  assert.deepEqual(detect.foreignToolchains(dir).map((f) => f.tool), ['Deep Fried Chicken']);
});

test('DFC in host64 is seen too, so the clash on a 32-bit game is not invisible', () => {
  const dir = scratchDir('dfc-foreign-32');
  for (const f of dfc.DFC_FILES) write(dir, `host64/${f}`, 'x');
  const found = detect.foreignToolchains(dir);
  assert.deepEqual(found.map((f) => f.tool), ['Deep Fried Chicken']);
  assert.ok(found[0].files.some((f) => f.startsWith('host64/')), 'and it says where');
});

test('choosing DFC overlays the route rather than replacing it', () => {
  const dir = scratchDir('dfc-route');
  const exe = fakeExe(dir, 'Game.exe');
  write(dir, 'OptiScaler.ini', '[DlssNr]\nEnabled=true\n');
  write(dir, 'nvngx_dlssnr.dll', 'x');
  write(dir, 'dxgi.dll', 'OptiScaler');

  const before = route.recommendRoute(dir, exe, DX12, 'nvidia');
  assert.equal(before.neuralConsumer, 'optiscaler');
  assert.equal(before.dfc, null);
  const stepsBefore = before.steps.length;

  dfc.setConsumer(dir, 'dfc');
  const after = route.recommendRoute(dir, exe, DX12, 'nvidia');

  assert.equal(after.route, before.route, 'the route id is unchanged -- DFC consumes, it does not hook');
  assert.equal(after.neuralConsumer, 'dfc');
  assert.match(after.label, /Deep Fried Chicken$/);
  assert.ok(after.steps.length > stepsBefore, 'the original steps survive and DFC\'s are appended');

  const keys = after.steps.map((s) => s.key);
  assert.ok(keys.includes('dfc-files'));
  assert.ok(keys.includes('dfc-optiscaler-nr'));

  // OptiScaler's NR is still on in the ini, so that step is not done and the route is incomplete.
  assert.equal(after.steps.find((s) => s.key === 'dfc-optiscaler-nr').done, false);
  assert.equal(after.complete, false);
});

test('with the files in place and OptiScaler\'s pass off, the DFC route completes', () => {
  const dir = scratchDir('dfc-route-ok');
  const exe = fakeExe(dir, 'Game.exe');
  write(dir, 'OptiScaler.ini', '[DlssNr]\nEnabled=false\n');
  write(dir, 'nvngx_dlssnr.dll', 'x');
  write(dir, 'dxgi.dll', 'OptiScaler');
  putDfc(dir);
  dfc.setConsumer(dir, 'dfc');

  const r = route.recommendRoute(dir, exe, DX12, 'nvidia');
  assert.equal(r.steps.find((s) => s.key === 'dfc-files').done, true);
  assert.equal(r.steps.find((s) => s.key === 'dfc-optiscaler-nr').done, true);
  assert.equal(r.dfc.present, true);
  assert.deepEqual(r.dfc.blockers, []);
});

test('a route with no neural pass of ours to swap is left alone', () => {
  // Nothing consumes a DLSS call on an unsupported game, and the AMD route is a different runtime
  // entirely (danielblnc's, not OptiScaler's), so neither gains DFC steps.
  const dir = scratchDir('dfc-route-skip');
  const exe = fakeExe(dir, 'Game.exe');
  dfc.setConsumer(dir, 'dfc');

  const unsupported = route.recommendRoute(dir, exe, { ...DX12, recommend: 'unsupported' }, 'nvidia');
  assert.equal(unsupported.route, 'unsupported');
  assert.equal(unsupported.neuralConsumer, 'optiscaler', 'not overlaid');
  assert.ok(!unsupported.steps.some((s) => String(s.key).startsWith('dfc-')));

  const amd = route.recommendRoute(dir, exe, DX12, 'amd');
  assert.ok(!amd.steps.some((s) => String(s.key).startsWith('dfc-')));
});

test('choosing a consumer switches OptiScaler\'s own Neural Rendering with it', async () => {
  // Not a convenience. Two neural add-ons is the case DFC refuses outright and silently, so leaving
  // the ini alone would hand back an install that looks right and never renders anything.
  const dir = scratchDir('dfc-ipc');
  const exe = fakeExe(dir, 'Game.exe');
  write(dir, 'OptiScaler.ini', '[Upscalers]\nDx12Upscaler=auto\n[DlssNr]\nEnabled=true\n');
  const { invoke } = loadMain();

  const toDfc = await invoke('game:setNeuralConsumer', { exePath: exe, consumer: 'dfc' });
  assert.equal(toDfc.ok, true);
  assert.equal(toDfc.consumer, 'dfc');
  assert.match(fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8'), /^Enabled\s*=\s*false$/m);
  assert.deepEqual(toDfc.applied, [{ key: 'DlssNr.Enabled', value: 'false' }]);

  const back = await invoke('game:setNeuralConsumer', { exePath: exe, consumer: 'optiscaler' });
  assert.equal(back.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8'), /^Enabled\s*=\s*true$/m);
  assert.equal(dfc.consumerFor(dir), 'optiscaler');

  const bad = await invoke('game:setNeuralConsumer', { exePath: exe, consumer: 'nonsense' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a neural consumer/);
});

test('the choice is a preference, so an install never reads it as a leftover', async () => {
  // A preference marker in main.js's `leftovers` list turns the card's Install button into a red
  // "Remove leftovers" that deletes the choice. That happened once with .dlss5ui-api.json.
  const dir = scratchDir('dfc-leftover');
  const exe = fakeExe(dir, 'Game.exe');
  dfc.setConsumer(dir, 'dfc');
  const { invoke } = loadMain();

  const status = await invoke('game:status', exe);
  const leftovers = (status && status.leftovers) || [];
  assert.ok(!leftovers.includes(dfc.MARKER), `${dfc.MARKER} must not be a leftover: ${leftovers.join(', ')}`);
});
