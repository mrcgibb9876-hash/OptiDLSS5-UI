'use strict';
// Experimental routes: emulators (emulators.js), 32-bit games through the Feeder's 64-bit helper and
// DirectX 8/9 through dgVoodoo2 (legacy.js). Detection on real 32/64-bit Windows executables carrying
// the API entry-point names; deploys against zips shaped like the real Feeder release (backslash entry
// names), ReShade's setup and dgVoodoo2's release; Remove must leave the folder as it was.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratchDir, write, fakeReleaseFolder, fakeNrModel, loadMain, listing } = require('./helpers');
const legacy = require('../src/legacy');
const emulators = require('../src/emulators');
const detect = require('../src/detect');
const route = require('../src/route');
const { diagnose } = require('../src/gamehelp');

const onWindows = process.platform === 'win32';
const SYS = process.env.SystemRoot || 'C:\\Windows';
process.env.LEGACY_QUARANTINE_WAIT_MS = '0';

function exeWith(dir, name, { bits = 64, marker = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(SYS, bits === 32 ? 'SysWOW64' : 'System32', 'notepad.exe');
  const dest = path.join(dir, name);
  fs.copyFileSync(src, dest);
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
  write(feederSrc, 'dlss5-feed.addon64', 'addon64');
  write(feederSrc, 'host64/dlss5-feed-host64.exe', 'host exe');
  write(feederSrc, 'reshade-shaders/Shaders/DLSS5_Feed.fx', '// feed fx');
  const reshadeSrc = path.join(base, 'reshade-src');
  write(reshadeSrc, 'ReShade32.dll', 'ReShade 32-bit build');
  write(reshadeSrc, 'ReShade64.dll', 'ReShade 64-bit build');
  const dgSrc = path.join(base, 'dg-src');
  write(dgSrc, 'MS/x86/D3D9.dll', 'dgVoodoo x86 d3d9');
  write(dgSrc, 'MS/x86/D3D8.dll', 'dgVoodoo x86 d3d8');
  write(dgSrc, 'MS/x64/D3D9.dll', 'dgVoodoo x64 d3d9');
  write(dgSrc, 'dgVoodooCpl.exe', 'dgVoodoo control panel');
  write(dgSrc, 'dgVoodoo.conf', '[General]\nOutputAPI = bestavailable\nCaptureMouse = true\n\n[Glide]\nVideoCard = voodoo_2\n\n[DirectX]\nDisableAndPassThru = false\nVideoCard = internal3D\nVRAM = 256\ndgVoodooWatermark = true\n');
  return {
    feederZip: zipDir(feederSrc, path.join(base, 'DLSS5-Feeder-test.zip')),
    reshadeSetup: zipDir(reshadeSrc, path.join(base, 'ReShade_Setup_test_Addon.zip')),
    dgZip: zipDir(dgSrc, path.join(base, 'dgVoodoo2_test.zip')),
  };
}

// ---------------------------------------------------------------------------------------------

test('emulator profiles: exe names map to the emulator, with this app\'s API names', () => {
  assert.equal(emulators.profileFor('C:\\Emu\\pcsx2-qt.exe').key, 'pcsx2');
  assert.deepEqual(emulators.profileFor('pcsx2-qt.exe').apis, ['dx11', 'dx12', 'vulkan', 'opengl']);
  assert.equal(emulators.profileFor('RPCS3.EXE').apis[0], 'vulkan');
  assert.equal(emulators.profileFor('xenia_canary.exe').apis[0], 'dx12');
  assert.equal(emulators.profileFor('eden.exe').system, 'Nintendo Switch');
  assert.equal(emulators.profileFor('notagame.exe'), null);
});

test('detection: emulators, 32-bit and DirectX 8/9 games are offered experimental routes', { skip: !onWindows }, async () => {
  const base = scratchDir('legacy-detect');
  const pcsx2 = await detect.detectGame(path.join(base, 'pcsx2'), exeWith(path.join(base, 'pcsx2'), 'pcsx2-qt.exe'));
  assert.equal(pcsx2.engineId, 'emulator');
  assert.equal(pcsx2.api, 'dx11');
  assert.equal(pcsx2.experimental, true);
  assert.equal(pcsx2.emulator.name, 'PCSX2');
  assert.equal(pcsx2.recommend, 'optiscaler');

  const dx9x32 = await detect.detectGame(path.join(base, 'g1'), exeWith(path.join(base, 'g1'), 'Game.exe', { bits: 32, marker: 'Direct3DCreate9' }));
  assert.equal(dx9x32.bitness, 32);
  assert.equal(dx9x32.api, 'dx9');
  assert.equal(dx9x32.recommend, 'optiscaler');
  assert.equal(dx9x32.experimental, true);

  const dx8x32 = await detect.detectGame(path.join(base, 'g2'), exeWith(path.join(base, 'g2'), 'Game.exe', { bits: 32, marker: 'Direct3DCreate8' }));
  assert.equal(dx8x32.api, 'dx8');
  assert.equal(dx8x32.apiBadge, 'DX8');

  const dx9x64 = await detect.detectGame(path.join(base, 'g3'), exeWith(path.join(base, 'g3'), 'Game.exe', { bits: 64, marker: 'Direct3DCreate9' }));
  assert.equal(dx9x64.bitness, 64);
  assert.equal(dx9x64.api, 'dx9');
  assert.equal(dx9x64.experimental, true);

  const vk32 = await detect.detectGame(path.join(base, 'g4'), exeWith(path.join(base, 'g4'), 'Game.exe', { bits: 32, marker: 'vkCreateInstance' }));
  assert.equal(vk32.api, 'vulkan');
  assert.equal(vk32.recommend, 'unsupported', '32-bit Vulkan stays out for now');
});

test('routes and Game Help for the experimental cases', { skip: !onWindows }, () => {
  const dir = scratchDir('legacy-route');
  const exe = path.join(dir, 'Game.exe');
  fs.writeFileSync(exe, 'x');

  const r32 = route.recommendRoute(dir, exe, { api: 'dx9', apis: ['dx9'], bitness: 32, recommend: 'optiscaler' }, 'nvidia');
  assert.equal(r32.route, 'feeder32');
  assert.equal(r32.experimental, true);
  assert.deepEqual(r32.steps.map((s) => s.key), ['dgvoodoo', 'feeder32']);
  assert.equal(r32.reasonVars.dx, 'DirectX 9');
  assert.equal(r32.reason, route.ROUTE_TEXT.host32DgVoodoo);

  const r32gl = route.recommendRoute(dir, exe, { api: 'opengl', apis: ['opengl'], bitness: 32, recommend: 'optiscaler' }, 'nvidia');
  assert.deepEqual(r32gl.steps.map((s) => s.key), ['feeder32']);
  assert.equal(r32gl.legacy.reshadeName, 'opengl32.dll');

  const r64dx9 = route.recommendRoute(dir, exe, { api: 'dx9', apis: ['dx9'], bitness: 64, recommend: 'optiscaler' }, 'nvidia');
  assert.equal(r64dx9.route, 'feeder');
  assert.deepEqual(r64dx9.steps.map((s) => s.key), ['dgvoodoo', 'feeder', 'optiscaler']);
  assert.equal(r64dx9.legacy.dgVoodoo.arch, 'x64');

  const emu = route.recommendRoute(dir, path.join(dir, 'rpcs3.exe'),
    { api: 'vulkan', apis: ['vulkan', 'opengl'], bitness: 64, recommend: 'optiscaler', emulator: { key: 'rpcs3', name: 'RPCS3', system: 'PlayStation 3', hint: 'Configuration > GPU > Renderer: Vulkan' } }, 'nvidia');
  assert.equal(emu.route, 'feeder');
  assert.equal(emu.experimental, true);
  assert.equal(emu.reason, route.ROUTE_TEXT.emulatorVulkan);
  assert.equal(emu.reasonVars.name, 'RPCS3');

  const vk32 = route.recommendRoute(dir, exe, { api: 'vulkan', apis: ['vulkan'], bitness: 32, recommend: 'unsupported' }, 'nvidia');
  assert.equal(vk32.route, 'unsupported');

  const ctx = (r, d) => ({ detected: d, route: r, run: { ran: false, verdict: 'no-log' }, foreign: [], fixesTried: [] });
  assert.equal(diagnose(ctx(r32, { bitness: 32, api: 'dx9' })).code, 'not-installed', 'a 32-bit game is no longer a hard stop');
  assert.equal(diagnose(ctx(vk32, { bitness: 32, api: 'vulkan' })).code, 'bit32');
});

test('dgVoodoo2: pinned release, its layout checked, configured in the right sections, quarantine reported', { skip: !onWindows }, async () => {
  const base = scratchDir('legacy-dg');
  const { dgZip } = fakeComponents(base);
  assert.equal(legacy.isDgVoodooZip(dgZip), true);

  const conf = legacy.configureDgVoodoo('[General]\nOutputAPI = bestavailable\n[Glide]\nVideoCard = voodoo_2\n[DirectX]\nVideoCard = svga\nVRAM = 256\ndgVoodooWatermark = true\nDisableAndPassThru = true\n');
  assert.match(conf, /\[Glide\]\r?\nVideoCard\s*=\s*voodoo_2/, 'the Glide card is not touched');
  assert.match(conf, /\[DirectX\][\s\S]*VideoCard\s*=\s*internal3D/);
  assert.match(conf, /DisableAndPassThru\s*=\s*false/);
  assert.match(conf, /VRAM\s*=\s*4096/);
  assert.match(conf, /dgVoodooWatermark\s*=\s*false/);
  assert.match(conf, /OutputAPI\s*=\s*d3d11_fl11_0/);

  // A download that does not match the pin is refused.
  await assert.rejects(
    legacy.ensureDgVoodooZip(path.join(base, 'cache-a'), { fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('not dgvoodoo') }) }),
    (e) => e.code === 'dgvoodoo-checksum');

  // A zip that is written and then taken away (what antivirus quarantine looks like) is reported as such.
  const cache = path.join(base, 'cache-b');
  process.env.LEGACY_QUARANTINE_WAIT_MS = '60';
  const timer = setInterval(() => { try { fs.rmSync(path.join(cache, 'dgVoodoo2-user.zip'), { force: true }); } catch {} }, 5);
  try {
    await assert.rejects(legacy.importDgVoodooZip(dgZip, cache), (e) => e.code === 'dgvoodoo-quarantined' && /will not work around your antivirus/.test(e.message));
  } finally {
    clearInterval(timer);
    process.env.LEGACY_QUARANTINE_WAIT_MS = '0';
  }
  await assert.rejects(legacy.importDgVoodooZip(path.join(base, 'feeder-src', 'dlss5-feed.addon32'), cache), /not a dgVoodoo2 release zip/);
});

test('the 32-bit route: dgVoodoo2, the game-side ReShade and add-on, the host64 helper with OptiScaler; Remove restores the folder', { skip: !onWindows }, async () => {
  const base = scratchDir('legacy-host32');
  const comps = fakeComponents(base);
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = exeWith(game, 'OldGame.exe', { bits: 32, marker: 'Direct3DCreate9' });
  write(game, 'data.pak', 'game data');
  write(game, 'dxgi.dll', 'the game\'s own dxgi wrapper');
  const before = listing(game);

  const plan = legacy.planFor({ bitness: 32, api: 'dx9' });
  const dgZip = await legacy.importDgVoodooZip(comps.dgZip, path.join(base, 'cache'));
  const dg = await legacy.deployDgVoodoo(game, plan, dgZip);
  assert.equal(dg.dll, 'D3D9.dll');
  assert.equal(fs.readFileSync(path.join(game, 'D3D9.dll'), 'utf8'), 'dgVoodoo x86 d3d9');
  assert.match(fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8'), /dgVoodooWatermark\s*=\s*false/);

  const res = await legacy.deployHost32(game, plan, {
    ...comps,
    releaseFolder: release,
    nrDllPath: nr,
    deployShaders: async (dir) => {
      write(dir, 'reshade-shaders/Shaders/vort_Motion.fx', '// mv');
      write(dir, 'ReShade.ini', '[ADDON]\nAddonPath=.\\\n');
      write(dir, 'ReShadePreset.ini', 'Techniques=DLSS5_Feed@DLSS5_Feed.fx\n');
      return ['reshade-shaders/Shaders/vort_Motion.fx'];
    },
    deployNvngxDlss: async (hostDir) => write(hostDir, 'nvngx_dlss.dll', 'dlss'),
  });
  assert.equal(res.deployed, true);

  // Beside the 32-bit game.
  assert.equal(fs.readFileSync(path.join(game, 'dxgi.dll'), 'utf8'), 'ReShade 32-bit build');
  assert.equal(fs.readFileSync(path.join(game, 'dxgi.dll.dlss5ui-orig'), 'utf8'), 'the game\'s own dxgi wrapper', 'the game\'s own dxgi.dll kept aside');
  assert.ok(fs.existsSync(path.join(game, 'dlss5-feed.addon32')));
  assert.ok(!fs.existsSync(path.join(game, 'dlss5-feed.addon64')), 'no 64-bit add-on in a 32-bit game');
  assert.ok(fs.existsSync(path.join(game, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx')));
  assert.ok(!fs.existsSync(path.join(game, 'OptiScaler.dll')) && !fs.existsSync(path.join(game, 'OptiScaler.ini')), 'no 64-bit OptiScaler beside a 32-bit game');

  // The helper.
  const host = path.join(game, 'host64');
  assert.equal(fs.readFileSync(path.join(host, 'dlss5-feed-host64.exe'), 'utf8'), 'host exe');
  assert.equal(fs.readFileSync(path.join(host, 'dxgi.dll'), 'utf8'), 'ReShade 64-bit build');
  assert.equal(fs.readFileSync(path.join(host, 'winmm.dll'), 'utf8'), fs.readFileSync(path.join(release, 'OptiScaler.dll'), 'utf8'), 'OptiScaler as winmm.dll');
  assert.ok(!fs.existsSync(path.join(host, 'OptiScaler.dll')) && !fs.existsSync(path.join(host, 'setup_windows.bat')));
  const ini = fs.readFileSync(path.join(host, 'OptiScaler.ini'), 'utf8');
  for (const re of [/\[DlssNr\][^[]*Enabled=true/, /ScanExposure=false/, /Dx12Upscaler=dlss/, /LoadReshade=false/]) assert.match(ini, re);
  assert.match(fs.readFileSync(path.join(host, 'ReShade.ini'), 'utf8'), /AddonPath=\.\\/);
  assert.ok(fs.existsSync(path.join(host, 'nvngx_dlssnr.dll')) && fs.existsSync(path.join(host, 'nvngx_dlss.dll')));

  // Recognised as ours, not as another DLSS 5 toolchain; status and route see it as done.
  assert.deepEqual(detect.foreignToolchains(game), []);
  const st = legacy.status(game);
  assert.equal(st.host32 && st.dgVoodoo && st.hostOptiScaler && st.feeder32, true);
  const done = route.recommendRoute(game, exe, { api: 'dx9', apis: ['dx9'], bitness: 32, recommend: 'optiscaler' }, 'nvidia');
  assert.equal(done.complete, true);
  assert.equal(done.optiInstalled, true);

  // Through the app: the card sees OptiScaler installed; Remove previews and then restores the folder.
  const { invoke } = loadMain();
  const status = await invoke('game:status', exe);
  assert.equal(status.backends.optiscaler, true);
  const planRemove = await invoke('game:uninstallPlan', exe);
  assert.ok(JSON.stringify(planRemove).includes('host64/'), 'Remove preview lists the helper folder');
  const install64 = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr });
  assert.equal(install64.ok, false);
  assert.match(install64.error, /32-bit/);

  // A newer engine reaches the helper on sync.
  fs.writeFileSync(path.join(release, 'OptiScaler.dll'), 'a newer OptiScaler build OptiScaler');
  const sync = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: release, nrDllPath: nr });
  assert.equal(sync.ok && sync.updated, true, JSON.stringify(sync));
  assert.equal(fs.readFileSync(path.join(host, 'winmm.dll'), 'utf8'), 'a newer OptiScaler build OptiScaler');

  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.deepEqual(listing(game), before, 'the folder is back to how it was');
  assert.equal(fs.readFileSync(path.join(game, 'dxgi.dll'), 'utf8'), 'the game\'s own dxgi wrapper');
});

test('a host64 folder this app did not make is refused; a 64-bit DirectX 9 game gets the x64 wrapper only', { skip: !onWindows }, async () => {
  const base = scratchDir('legacy-refuse');
  const comps = fakeComponents(base);
  const game = path.join(base, 'game');
  exeWith(game, 'Game.exe', { bits: 32, marker: 'D3D11CreateDevice' });
  write(game, 'host64/renodx-dlss5.addon64', 'someone else\'s');
  await assert.rejects(legacy.deployHost32(game, legacy.planFor({ bitness: 32, api: 'dx11' }), {
    ...comps, releaseFolder: fakeReleaseFolder(base), nrDllPath: fakeNrModel(base), deployShaders: async () => [],
  }), /not made by this app/);

  const g64 = path.join(base, 'game64');
  exeWith(g64, 'Game.exe', { bits: 64, marker: 'Direct3DCreate9' });
  const plan = legacy.planFor({ bitness: 64, api: 'dx9' });
  assert.equal(plan.host32, false);
  const dgZip = await legacy.importDgVoodooZip(comps.dgZip, path.join(base, 'cache'));
  await legacy.deployDgVoodoo(g64, plan, dgZip);
  assert.equal(fs.readFileSync(path.join(g64, 'D3D9.dll'), 'utf8'), 'dgVoodoo x64 d3d9');
  const removed = await legacy.removeLegacy(g64);
  assert.ok(removed.removed.includes('D3D9.dll'));
  assert.ok(!fs.existsSync(path.join(g64, legacy.MARKER)));
});
