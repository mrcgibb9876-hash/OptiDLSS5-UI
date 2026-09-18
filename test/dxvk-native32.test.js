'use strict';
// DXVK in place of a 32-bit DirectX 10/11 game's own Direct3D (2026-09-18).
//
// Until then the swap refused these games: on the helper route the game-folder ReShade is dxgi.dll,
// the very name DXVK's D3D11 set needs, and the 2.2.3 swap had placed d3d11.dll, refused dxgi.dll and
// called that success. The DX9 swap has since learned to park that proxy and run ReShade as its
// 32-bit Vulkan layer, so the same order serves DX10/11: park first (journaled), then DXVK's
// d3d10core/d3d11/dxgi (all or nothing, the game's own files backed up), then the Vulkan layer.
// EasyAIO DLSS5 3.0.1 ships the full DXVK x86 set on every 32-bit route; here it is a choice.
//
// Nothing reaches the network: the DXVK and ReShade caches are filled with fakes and the elevated
// ReShade setup and the Vulkan layer lookup are stubbed on their modules, which main.js calls
// through at run time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { REPO, scratchDir, write, fakeReleaseFolder, fakeNrModel, loadMain, listing } = require('./helpers');
const translation = require(path.join(REPO, 'src', 'translation'));
const legacy = require(path.join(REPO, 'src', 'legacy'));
const feeder = require(path.join(REPO, 'src', 'feeder'));
const elevate = require(path.join(REPO, 'src', 'elevate'));
const detect = require(path.join(REPO, 'src', 'detect'));
const route = require(path.join(REPO, 'src', 'route'));
const runlog = require(path.join(REPO, 'src', 'runlog'));
const { diagnose, FIX_IDS } = require(path.join(REPO, 'src', 'gamehelp'));

const onWindows = process.platform === 'win32';
const SYS = process.env.SystemRoot || 'C:\\Windows';
process.env.LEGACY_QUARANTINE_WAIT_MS = '0';

const dll = (signature) => `MZ${'\0'.repeat(64)}${signature}${'x'.repeat(4096)}`;
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'latin1');

function exeWith(dir, name, { bits = 32, marker = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  fs.copyFileSync(path.join(SYS, bits === 32 ? 'SysWOW64' : 'System32', 'notepad.exe'), dest);
  if (marker) fs.appendFileSync(dest, Buffer.from(`\0${marker}\0`, 'latin1'));
  return dest;
}

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

function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'latin1');
  h.write('0000644\0', 100, 8, 'latin1');
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1');
  h.write('0', 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

// The layout of the real dxvk-3.1.1.tar.gz: x32/ and x64/, each with d3d8, d3d9, d3d10core, d3d11, dxgi.
function fakeDxvkTarGz() {
  const parts = [];
  for (const arch of ['x32', 'x64']) {
    for (const n of ['d3d8.dll', 'd3d9.dll', 'd3d10core.dll', 'd3d11.dll', 'dxgi.dll']) {
      parts.push(tarEntry(`dxvk-3.1.1/${arch}/${n}`, Buffer.from(dll(`DXVK ${arch} ${n} vkGetInstanceProcAddr`))));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const shaders = async (dir) => {
  write(dir, 'ReShade.ini', '[ADDON]\nAddonPath=.\\\n[INPUT]\nKeyOverlay=36,0,0,0\n');
  write(dir, 'ReShadePreset.ini', 'Techniques=DLSS5_Feed@DLSS5_Feed.fx\n');
  return [];
};

// A 32-bit DirectX 11 game on the helper route as Install leaves it, with a d3d11.dll of its own
// (some games ship one) that DXVK's has to displace and hand back.
async function dx11Game(base, { exeName = 'Game.exe', marker = 'D3D11CreateDevice' } = {}) {
  const comps = fakeComponents(base);
  const game = path.join(base, 'game');
  const exe = exeWith(game, exeName, { marker });
  write(game, 'd3d11.dll', dll('the game\'s own d3d11'));
  const before = listing(game);
  const plan = legacy.planFor({ bitness: 32, api: 'dx11' });
  await legacy.deployHost32(game, plan, {
    ...comps, releaseFolder: fakeReleaseFolder(base), nrDllPath: fakeNrModel(base), deployShaders: shaders,
  });
  return { game, exe, plan, before, comps };
}

// ReShade's elevated setup and the 32-bit layer lookup, stubbed where main.js reaches them.
function stubVulkanLayer(base) {
  const appsPath = write(base, 'ProgramData-ReShade/ReShadeApps.ini', 'Apps=C:\\Other\\Game.exe\n');
  const state = { status: { registered: false, addon: false, appListed: null, appsPath }, calls: [] };
  const saved = { runElevated: elevate.runElevated, vulkanLayerStatus: feeder.vulkanLayerStatus };
  elevate.runElevated = async (file, args) => {
    state.calls.push({ file, args });
    fs.writeFileSync(appsPath, `Apps=C:\\Other\\Game.exe,${args[0]}\n`);
    state.status = { registered: true, addon: true, appListed: true, appsPath };
    return { ok: true, code: 0, cancelled: false };
  };
  feeder.vulkanLayerStatus = async () => state.status;
  state.restore = () => { elevate.runElevated = saved.runElevated; feeder.vulkanLayerStatus = saved.vulkanLayerStatus; };
  return state;
}

// The confirm dialogs main.js shows, captured instead of answered blind.
function captureDialogs() {
  const dialog = require.cache['electron-stub'].exports.dialog;
  const saved = dialog.showMessageBox;
  const seen = [];
  dialog.showMessageBox = async (opts) => { seen.push(opts); return { response: 0 }; };
  seen.restore = () => { dialog.showMessageBox = saved; };
  return seen;
}

// ── The file set, from the release itself ──────────────────────────────────────────────────────────

test('a 32-bit DirectX 10/11 game takes DXVK\'s whole D3D10/11 set; the rest keep theirs', () => {
  assert.deepEqual(translation.dxvkFilesFor('dx11', 32), ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll']);
  assert.deepEqual(translation.dxvkFilesFor('dx10', 32), ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll']);
  assert.deepEqual(translation.dxvkFilesFor('dx9', 32), ['d3d9.dll'], 'dgVoodoo2\'s swap is unchanged');
  assert.deepEqual(translation.dxvkFilesFor('dx11', 64), ['d3d11.dll', 'dxgi.dll']);
  // Every name in it is one DXVK 3.1.1 ships under x32/ (no d3d10.dll or d3d10_1.dll since 2.x).
  const cached = path.join(process.env.APPDATA || '', 'OptiDLSS5-UI', 'dxvk-cache', 'dxvk-3.1.1', 'files.json');
  if (fs.existsSync(cached)) {
    const files = Object.keys(JSON.parse(fs.readFileSync(cached, 'utf8')).files);
    for (const n of translation.DXVK_FILES_32BIT_D3D1X) assert.ok(files.includes(`x32/${n}`), `x32/${n} in the real release`);
    assert.ok(!files.some((f) => /d3d10(_1)?\.dll$/i.test(f)), 'and no d3d10.dll/d3d10_1.dll to deploy');
  }
});

// ── The swap and the way back, end to end through main.js ──────────────────────────────────────────

test('a 32-bit DirectX 11 game swaps to DXVK and back, and the journal puts everything back', { skip: !onWindows }, async (t) => {
  const base = scratchDir('native32-swap');
  const { game, exe, before } = await dx11Game(base);
  const { invoke, userData } = loadMain({ dialogResponse: 0 });
  await translation.unpackDxvk(fakeDxvkTarGz(), path.join(userData, 'dxvk-cache'));
  write(path.join(userData, 'feeder-cache'), path.basename(feeder.RESHADE_SETUP_URL), 'setup');
  const layer = stubVulkanLayer(base);
  const dialogs = captureDialogs();
  t.after(() => { layer.restore(); dialogs.restore(); });
  const installed = listing(game);
  assert.equal(translation.identifyWrapper(path.join(game, 'dxgi.dll')), 'reshade', 'Install put ReShade in as dxgi.dll');

  const on = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-dxvk' });
  assert.equal(on.ok, true, on.error);
  assert.equal(on.done, true, on.text);
  assert.match(on.text, /^DXVK \(d3d10core\.dll, d3d11\.dll, dxgi\.dll\) is in front of the game instead of native Direct3D 11/);
  assert.match(on.text, /set aside as dxgi\.dll\.dlss5ui-parked/);

  // The confirm said what this is: no dgVoodoo2, the admin prompt, the machine-wide layer.
  const asked = dialogs[dialogs.length - 1];
  assert.match(asked.message, /instead of native Direct3D 11/);
  assert.doesNotMatch(`${asked.message}\n${asked.detail}`, /in place of dgVoodoo2|dgVoodoo2 displaced|comes back with dgVoodoo2/);
  assert.match(asked.detail, /administrator permission/);
  assert.match(asked.detail, /whole PC/);

  // DXVK's three files, the game's own d3d11.dll kept, ReShade parked -- all journaled.
  for (const n of ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll']) assert.equal(translation.identifyWrapper(path.join(game, n)), 'dxvk', n);
  assert.match(read(game, 'd3d11.dll.dlss5ui-orig'), /the game's own d3d11/);
  assert.equal(read(game, `dxgi.dll${legacy.PARK_SUFFIX}`), 'ReShade 32-bit build');
  const m = translation.readManifest(game);
  assert.equal(m.layer, 'dxvk');
  assert.equal(m.arch, 'x32');
  assert.deepEqual(m.files, ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll']);
  assert.deepEqual(m.backups, [{ rel: 'd3d11.dll', backup: 'd3d11.dll.dlss5ui-orig' }]);
  assert.deepEqual(legacy.readMarker(game).parked, [{ rel: 'dxgi.dll', parked: `dxgi.dll${legacy.PARK_SUFFIX}` }]);
  // Then ReShade's 32-bit Vulkan layer, elevated, with the command line the DX9 swap uses.
  assert.equal(layer.calls.length, 1);
  assert.deepEqual(layer.calls[0].args, [exe, '--api', 'vulkan', '--headless', '--elevated']);
  assert.equal(legacy.vulkanLayerRecord(game).listedByUs, true);
  assert.match(on.text, /ReShade's 32-bit Vulkan layer is now set up/);

  // Detection keeps the game's own API, so the route and the way back survive the swap.
  const d = await detect.detectGame(game, exe);
  assert.equal(d.api, 'dx11');
  assert.equal(d.translatedBy, 'dxvk');
  const r = await invoke('game:route', { exePath: exe, detected: d });
  assert.equal(r.route, 'feeder32');
  assert.equal(r.dxvkDeployed, true);
  assert.deepEqual(r.steps.map((s) => [s.key, s.done]), [['feeder32', true], ['dxvk', true]], 'DXVK is the route\'s wrapper step, done');
  // And Game Help runs the DXVK layer checks on it, from the real context.
  write(game, 'ReShade.log', 'new');
  // antiCheat cleared: detection climbs into the shared scratch root, where other tests' folders live.
  const help = await invoke('game:help', { exePath: exe, detected: { ...d, antiCheat: null } });
  assert.equal(help.ok, true, help.error);
  assert.equal(help.code, 'dxvk-addon-not-loaded', 'the layer loaded (ReShade.log) and the Feeder add-on has not written since the swap');

  // The way back: DXVK out, the game's d3d11.dll and the ReShade proxy back where they were.
  const off = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-native' });
  assert.equal(off.done, true, off.text);
  assert.match(off.text, /native Direct3D 11 again; the game's own d3d11\.dll is back; the game-folder ReShade is back/);
  assert.match(read(game, 'd3d11.dll'), /the game's own d3d11/);
  assert.equal(read(game, 'dxgi.dll'), 'ReShade 32-bit build');
  assert.equal(translation.readManifest(game), null);
  assert.equal(legacy.readMarker(game).parked, undefined);
  fs.rmSync(path.join(game, 'ReShade.log'));
  assert.deepEqual(listing(game), installed, 'the folder is as Install left it');

  // Once more to DXVK, then Remove: the folder as it was before anything, the exe off the app list.
  const again = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-dxvk' });
  assert.equal(again.done, true, again.text);
  write(game, 'Game_d3d11.log', 'DXVK log');
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.deepEqual(listing(game), before);
  assert.match(read(game, 'd3d11.dll'), /the game's own d3d11/);
  assert.equal(fs.readFileSync(layer.status.appsPath, 'utf8'), 'Apps=C:\\Other\\Game.exe\n');
});

test('DXVK chosen before Install goes in after the helper, over the proxy it parks', { skip: !onWindows }, async (t) => {
  const base = scratchDir('native32-install');
  const comps = fakeComponents(base);
  const game = path.join(base, 'game');
  const exe = exeWith(game, 'Game.exe', { marker: 'D3D11CreateDevice' });
  const { invoke, userData } = loadMain({ dialogResponse: 0 });
  await translation.unpackDxvk(fakeDxvkTarGz(), path.join(userData, 'dxvk-cache'));
  const cache = path.join(userData, 'feeder-cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.copyFileSync(comps.reshadeSetup, path.join(cache, path.basename(feeder.RESHADE_SETUP_URL)));
  fs.copyFileSync(comps.feederZip, path.join(cache, 'DLSS5-Feeder-test.zip'));
  const layer = stubVulkanLayer(base);
  const saved = { asset: feeder.resolveFeederAsset, shaders: legacy.deployLegacyShaders, nvngx: feeder.deployNvngxDlss };
  feeder.resolveFeederAsset = async () => ({ url: 'https://example.invalid/feeder.zip', name: 'DLSS5-Feeder-test.zip', tag: 'test' });
  legacy.deployLegacyShaders = shaders;
  feeder.deployNvngxDlss = async () => {};
  t.after(() => {
    layer.restore();
    Object.assign(feeder, { resolveFeederAsset: saved.asset, deployNvngxDlss: saved.nvngx });
    legacy.deployLegacyShaders = saved.shaders;
  });

  const chosen = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-dxvk' });
  assert.equal(chosen.done, true, chosen.text);
  const d = await detect.detectGame(game, exe);
  const pending = route.recommendRoute(game, exe, d, 'nvidia');
  assert.deepEqual(pending.steps.map((s) => [s.key, s.done]), [['feeder32', false], ['dxvk', false]], 'Install still owes the DXVK step');

  const res = await invoke('legacy:installHost32', {
    exePath: exe, detected: d, releaseFolder: fakeReleaseFolder(base), nrDllPath: fakeNrModel(base), mvProviderId: 'vort',
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.dxvkLayer && res.dxvkLayer.ok, true, JSON.stringify(res.dxvkLayer));
  for (const n of ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll']) assert.equal(translation.identifyWrapper(path.join(game, n)), 'dxvk', n);
  assert.equal(read(game, `dxgi.dll${legacy.PARK_SUFFIX}`), 'ReShade 32-bit build', 'ReShade went in first and was parked, not buried as "the game\'s own"');
  assert.ok(!fs.existsSync(path.join(game, 'dxgi.dll.dlss5ui-orig')));
  assert.equal(translation.readPreference(game), null, 'the choice is spent');
  assert.equal(layer.calls.length, 1);

  // A re-install while DXVK is in refreshes the parked copy and leaves DXVK's dxgi.dll alone.
  const again = await invoke('legacy:installHost32', {
    exePath: exe, detected: d, releaseFolder: fakeReleaseFolder(base), nrDllPath: fakeNrModel(base), mvProviderId: 'vort',
  });
  assert.equal(again.ok, true, again.error);
  assert.equal(translation.identifyWrapper(path.join(game, 'dxgi.dll')), 'dxvk');
  assert.equal(read(game, `dxgi.dll${legacy.PARK_SUFFIX}`), 'ReShade 32-bit build');
});

// ── What is refused ────────────────────────────────────────────────────────────────────────────────

test('the early Assassin\'s Creed games are still refused, DirectX 10 exe included', { skip: !onWindows }, async () => {
  const base = scratchDir('native32-blocked');
  const { game, exe } = await dx11Game(base, { exeName: 'AssassinsCreed_Dx10.exe', marker: 'D3D10CreateDevice' });
  const { invoke } = loadMain({ dialogResponse: 0 });
  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-dxvk' });
  assert.equal(res.done, false);
  assert.match(res.text, /DXVK issue #2249/);
  assert.equal(translation.readPreference(game), null);
  assert.ok(!fs.existsSync(path.join(game, 'd3d10core.dll')));
  assert.equal(translation.identifyWrapper(path.join(game, 'dxgi.dll')), 'reshade');

  // A choice recorded before the list existed is not acted on, and nothing offers DXVK.
  translation.writePreference(game, 'dxvk');
  const d = { api: 'dx10', apis: ['dx10'], bitness: 32, recommend: 'optiscaler', legacyApis: ['dx10'] };
  const r = route.recommendRoute(game, exe, d, 'nvidia');
  assert.ok(r.dxvkBlocked);
  assert.ok(!r.steps.some((s) => s.key === 'dxvk'));
  const run = { ran: true, verdict: 'no-dlss', at: 't1' };
  const diag = diagnose({ detected: d, route: { ...r, complete: true, optiInstalled: true }, run });
  assert.notEqual(diag.fix && diag.fix.id, 'swap-to-dxvk');
});

test('an OptiScaler dxgi.dll refuses the whole swap, and the folder is left as it was', { skip: !onWindows }, async () => {
  const base = scratchDir('native32-opti');
  const { game, plan } = await dx11Game(base);
  // Someone's OptiScaler under the helper route's proxy name.
  fs.writeFileSync(path.join(game, 'dxgi.dll'), dll('OptiScaler ReShade DXVK'));
  const sourceDir = await translation.unpackDxvk(fakeDxvkTarGz(), path.join(base, 'dxvk-cache'));
  const beforeSwap = listing(game);

  const r = await legacy.swapNativeToDxvk(game, plan, () => translation.deployDxvk(game, { sourceDir, api: plan.api, bitness: 32 }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.refused.map((x) => x.file), ['dxgi.dll']);
  assert.match(r.refused[0].reason, /OptiScaler/);
  assert.deepEqual(listing(game), beforeSwap, 'no d3d10core.dll, no d3d11.dll, nothing parked');
  assert.match(read(game, 'd3d11.dll'), /the game's own d3d11/);
  assert.equal(translation.readManifest(game), null);

  // A ReShade dxgi.dll that is not our parked proxy (no helper install records it) is refused too.
  const theirs = path.join(base, 'theirs');
  write(theirs, 'dxgi.dll', dll('ReShade'));
  const r2 = await legacy.swapNativeToDxvk(theirs, plan, () => translation.deployDxvk(theirs, { sourceDir, api: 'dx11', bitness: 32 }));
  assert.equal(r2.ok, false);
  assert.match(r2.refused[0].reason, /ReShade/);
  assert.deepEqual(listing(theirs), ['dxgi.dll']);

  // A refusal after the proxy was parked puts it straight back.
  const { game: g2, plan: p2 } = await dx11Game(path.join(base, 'second'));
  const back = await legacy.swapNativeToDxvk(g2, p2, async () => ({ ok: false, refused: [{ file: 'd3d11.dll', reason: 'test' }] }));
  assert.equal(back.ok, false);
  assert.deepEqual(back.unparked, ['dxgi.dll']);
  assert.equal(read(g2, 'dxgi.dll'), 'ReShade 32-bit build');
});

// ── Game Help and the run log ──────────────────────────────────────────────────────────────────────

test('Game Help on a DirectX 11 game under DXVK: the layer checks, and native as the way back', async () => {
  const plan = legacy.planFor({ bitness: 32, api: 'dx11' });
  assert.equal(legacy.dxvkReplacesNative(plan), true);
  assert.equal(legacy.dxvkReplacesNative(legacy.planFor({ bitness: 32, api: 'dx9' })), false);
  assert.equal(legacy.dxvkReplacesNative(legacy.planFor({ bitness: 32, api: 'dx12' })), false);
  const route32 = { route: 'feeder32', complete: true, optiInstalled: true, dxvkDeployed: true, dgVoodooDeployed: false, legacy: plan };
  const good = { exe: 'Game.exe', layerRegistered: true, layerAddon: true, appListed: true, reshadeIni: true, proxyBack: null, ranSinceSwap: true, feedLogSinceSwap: true, feedExclusive: false };
  const base = { detected: { bitness: 32, api: 'dx11' }, route: route32 };
  const run = (verdict, extra = {}) => ({ ran: true, verdict, at: 't1', nrFrames: 1200, ...extra });

  const missing = diagnose({ ...base, dxvkHost32: { ...good, layerRegistered: false }, run: run('no-dlss') });
  assert.equal(missing.code, 'dxvk-layer-missing');
  assert.equal(missing.fix.id, 'swap-to-dxvk', 're-running the swap installs the layer');
  assert.equal(diagnose({ ...base, dxvkHost32: { ...good, proxyBack: 'dxgi.dll' }, run: run('no-dlss') }).code, 'dxvk-two-reshades');
  assert.equal(diagnose({ ...base, dxvkHost32: { ...good, ranSinceSwap: false, feedLogSinceSwap: false }, run: { ran: false, verdict: 'no-log' } }).code, 'dxvk-needs-run');

  const back = diagnose({ ...base, dxvkHost32: good, run: run('no-dlss') });
  assert.equal(back.code, 'dxvk-no-dlss-native');
  assert.equal(back.fix.id, 'swap-to-native');
  assert.ok(FIX_IDS.includes('swap-to-native'));

  const crash = diagnose({ ...base, dxvkHost32: good, run: run('wrapper-crash', { detail: 'd3d11.dll' }) });
  assert.equal(crash.code, 'dxvk-crash-native');
  assert.equal(crash.fix.id, 'swap-to-native');
  assert.equal(diagnose({ ...base, dxvkHost32: good, run: run('wrapper-crash', { detail: 'dxgi.dll' }), fixesTried: ['swap-to-native'] }).fix.id, 'remove-all');

  // A blocked game on DXVK anyway goes back to native, not to a dgVoodoo2 it never had.
  const blocked = diagnose({ ...base, route: { ...route32, dxvkBlocked: { game: 'Assassin\'s Creed' } }, dxvkHost32: good, run: run('no-dlss') });
  assert.equal(blocked.fix.id, 'swap-to-native');
});

test('a crash in a game-folder dxgi.dll is a wrapper crash only when that dxgi.dll is DXVK', async () => {
  const feedLog = (file) => `13:54:58.671  ### EXCEPTION RECORDED ###  exception 0xC0000005 (reading address 00000000) at 69611E10 in ${file}; this add-on was last doing: nothing yet\n`;
  const dxvkDir = scratchDir('native32-crash-dxvk');
  write(dxvkDir, 'dxgi.dll', dll('DXVK'));
  write(dxvkDir, 'dlss5-feed.log', feedLog(path.join(dxvkDir, 'dxgi.dll')));
  const a = await runlog.analyzeRun(dxvkDir, { optiDir: path.join(dxvkDir, 'host64') });
  assert.equal(a.verdict, 'wrapper-crash');
  assert.equal(a.detail, 'dxgi.dll');

  const reshadeDir = scratchDir('native32-crash-reshade');
  write(reshadeDir, 'dxgi.dll', dll('ReShade'));
  write(reshadeDir, 'dlss5-feed.log', feedLog(path.join(reshadeDir, 'dxgi.dll')));
  const b = await runlog.analyzeRun(reshadeDir, { optiDir: path.join(reshadeDir, 'host64') });
  assert.notEqual(b.verdict, 'wrapper-crash', 'the helper route\'s ReShade proxy is not a wrapper');
});

test('the route names DXVK\'s step on a DirectX 10/11 game, chosen or placed', () => {
  const dir = scratchDir('native32-route');
  const exe = write(dir, 'Game.exe', 'MZ');
  const d = { api: 'dx11', apis: ['dx11'], bitness: 32, recommend: 'optiscaler' };
  assert.ok(!route.recommendRoute(dir, exe, d, 'nvidia').steps.some((s) => s.key === 'dxvk'), 'native is the default: no DXVK step');
  translation.writePreference(dir, 'dxvk');
  const chosen = route.recommendRoute(dir, exe, d, 'nvidia');
  assert.deepEqual(chosen.steps.map((s) => s.key), ['feeder32', 'dxvk']);
  assert.match(chosen.steps[1].label, /chosen instead of native Direct3D/);
  assert.equal(chosen.reasonVars.dx, 'Direct3D 11');
  translation.writePreference(dir, null);
  translation.writeManifest(dir, translation.newManifest({ layer: 'dxvk', arch: 'x32', files: ['d3d11.dll'] }));
  const placed = route.recommendRoute(dir, exe, d, 'nvidia');
  assert.equal(placed.dxvkDeployed, true);
  assert.deepEqual(placed.steps.find((s) => s.key === 'dxvk'), { key: 'dxvk', label: route.ROUTE_TEXT.stepDxvkNative, done: true });
});

// ── The renderer: the three entry points know the DirectX 10/11 side ──────────────────────────────

test('the card menu, Edit and Game Help offer DXVK against native Direct3D on a DirectX 10/11 game', () => {
  const js = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'index.html'), 'utf8');
  const rule = js.slice(js.indexOf('function layerSwapFor'), js.indexOf('async function applyLayerSwap'));
  assert.match(rule, /plan\.host32 && !plan\.dgVoodoo && \(plan\.api === 'dx10' \|\| plan\.api === 'dx11'\)/);
  assert.match(rule, /id: 'swap-to-native'/);
  assert.match(rule, /Try DXVK instead of native \{d3d\}/);
  assert.match(rule, /route\.dxvkBlocked && !onDxvk\) return null/, 'the blocked list still gates it');

  const helper = js.slice(js.indexOf('async function applyLayerSwap'), js.indexOf('async function loadLayerSection'));
  assert.match(helper, /'swap-to-native'/);
  const edit = js.slice(js.indexOf('async function loadLayerSection'));
  assert.match(edit.slice(0, 1500), /\['native', t\('\{d3d\} \(native\)'/, 'Edit\'s choice reads "Direct3D 11 (native)"');
  assert.match(js, /e\.target\.value === 'native' \? 'swap-to-native'/);
  assert.match(js, /fixId === 'swap-to-dgvoodoo' \|\| fixId === 'swap-to-native'/, 'Game Help\'s button can go back to native');
  assert.match(js, /case 'swap-to-native': return t\('Use native Direct3D 11'\)/);
  for (const code of ['dxvk-no-dlss-native', 'dxvk-crash-native']) {
    assert.ok(js.split(`case '${code}'`).length - 1 >= 3, `${code} has words, steps and a short line`);
  }
  assert.match(html, /A 32-bit DirectX 10\/11 game runs natively by default, and DXVK can run it on Vulkan instead/);

  const main = fs.readFileSync(path.join(REPO, 'src', 'main.js'), 'utf8');
  assert.match(main, /case 'swap-to-native': \{/);
});
