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
const { scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain, listing } = require('./helpers');
const legacy = require('../src/legacy');
const emulators = require('../src/emulators');
const detect = require('../src/detect');
const route = require('../src/route');
const { diagnose } = require('../src/gamehelp');

const nativeDlss = require('../src/native-dlss');
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
  assert.deepEqual(emulators.profileFor('pcsx2-qt.exe').apis, ['dx11', 'vulkan', 'dx12', 'opengl']);
  assert.equal(emulators.profileFor('RPCS3.EXE').apis[0], 'vulkan');
  assert.equal(emulators.profileFor('xenia_canary.exe').apis[0], 'dx12');
  assert.equal(emulators.profileFor('eden.exe').system, 'Nintendo Switch');
  assert.equal(emulators.profileFor('notagame.exe'), null);
});

test('an emulator never counts as having DLSS of its own, so the Feeder stays its route (RPCS3)', () => {
  const feeder = require('../src/feeder');
  const emu = scratchDir('rpcs3-native');
  write(emu, 'rpcs3.exe', 'x');
  // What the Feeder deploy places beside the exe, and a Streamline file the tree walk could find.
  write(emu, 'nvngx_dlss.dll', 'x');
  write(emu, 'sl.interposer.dll', 'x');
  assert.equal(nativeDlss.isEmulatorDir(emu), true);
  assert.equal(nativeDlss.shipsNativeDlss(emu), false);
  assert.equal(nativeDlss.hasNativeDlss(emu), false);
  assert.equal(feeder.needsFeeder(emu), true);
  const det = { api: 'vulkan', apis: ['vulkan', 'opengl'], bitness: 64, recommend: 'optiscaler', emulator: { key: 'rpcs3', name: 'RPCS3', system: 'PlayStation 3', hint: 'x' } };
  write(emu, 'dlss5-feed.addon64', 'x');
  const r = route.recommendRoute(emu, path.join(emu, 'rpcs3.exe'), det, 'nvidia');
  assert.equal(r.route, 'feeder');
  assert.equal(r.feederMisdeployed, false);

  const game = scratchDir('not-an-emulator');
  write(game, 'game.exe', 'x');
  write(game, 'sl.interposer.dll', 'x');
  assert.equal(nativeDlss.hasNativeDlss(game), true, 'the same files on an ordinary game still mean shipped DLSS');
});

test('FIFA 16: a protected exe that names no API is still DX11, so the Feeder is offered', { skip: !onWindows }, async () => {
  // notepad.exe carries no D3D import or string, which is what FIFA 16's protected exe looks like to the scan.
  const dir = scratchDir('fifa16');
  const exe = exeWith(dir, 'fifa16.exe');
  const det = await detect.detectGame(dir, exe);
  assert.equal(det.api, 'dx11');
  assert.equal(det.recommend, 'optiscaler');
  assert.equal(route.recommendRoute(dir, exe, det, 'nvidia').route, 'feeder');

  const other = exeWith(scratchDir('no-api'), 'somegame.exe');
  assert.equal((await detect.detectGame(path.dirname(other), other)).api, null, 'only the named game is assumed');
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
  // The three 32-bit route texts used to be three copies of one paragraph, and all three said the
  // wrong key. They share it now, so assert what the reader is told rather than which constant
  // was concatenated.
  assert.match(r32.reason, /dgVoodoo2 turns it into DirectX 11/, 'the DX9 half');
  // The cast took no clicks until engine v1.0.34 (Metal Gear Rising: Revengeance, 2026-09-15) and
  // needed the Feeder's cast_key set and the panel already open in the helper until v1.0.35, so this
  // text used to send the reader to Edit and to the real host window instead. Both are fixed and the
  // deploy writes the key, so the reader is told the one thing that is now true everywhere.
  assert.match(r32.reason, /Press Insert in the game for the DLSS 5 panel/, 'the same key as every other route');
  assert.match(r32.reason, /take clicks/, 'the cast is no longer display-only');
  // Edit no longer carries the DLSS 5 field table -- it was a second copy of the in-game panel
  // writing the same ini, and the panel rewrites the whole file whenever it changes something. This
  // paragraph must not send the reader there; the pop-out panel is the alternative now.
  assert.ok(!/from Edit/.test(r32.reason), 'Edit no longer holds those settings');
  assert.ok(!/press Insert/.test(r32.reason), 'Insert in the host window is no longer the way in');

  const r32gl = route.recommendRoute(dir, exe, { api: 'opengl', apis: ['opengl'], bitness: 32, recommend: 'optiscaler' }, 'nvidia');
  assert.deepEqual(r32gl.steps.map((s) => s.key), ['feeder32']);
  assert.equal(r32gl.legacy.reshadeName, 'opengl32.dll');
  assert.match(r32gl.reason, /On OpenGL, ReShade goes in as the game's opengl32\.dll/, 'the OpenGL half');
  assert.match(r32gl.reason, /Press Insert in the game/, 'and the shared paragraph, from the one place it lives');

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

  // A download that does not match the pin is refused, and nothing is cached.
  await assert.rejects(
    legacy.ensureDgVoodoo(path.join(base, 'cache-a'), { fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('not dgvoodoo') }) }),
    (e) => e.code === 'dgvoodoo-checksum');
  assert.equal(legacy.cachedDgVoodoo(path.join(base, 'cache-a')), null);

  // A file that is written and then taken away (what antivirus quarantine looks like) is reported as such.
  const cache = path.join(base, 'cache-b');
  process.env.LEGACY_QUARANTINE_WAIT_MS = '60';
  const timer = setInterval(() => { try { fs.rmSync(path.join(cache, 'dgVoodoo2-user', 'MS', 'x86', 'D3D9.dll'), { force: true }); } catch {} }, 5);
  try {
    await assert.rejects(legacy.importDgVoodooZip(dgZip, cache), (e) => e.code === 'dgvoodoo-quarantined');
  } finally {
    clearInterval(timer);
    process.env.LEGACY_QUARANTINE_WAIT_MS = '0';
  }
  assert.equal(legacy.cachedDgVoodoo(cache), null, 'a folder missing a file is not a usable cache');
  await assert.rejects(legacy.importDgVoodooZip(path.join(base, 'feeder-src', 'dlss5-feed.addon32'), cache), /not a dgVoodoo2 release zip/);
});

test('dgVoodoo2: the release zip Defender flags is never written -- only the files a route uses are cached', { skip: !onWindows }, async () => {
  // Windows Defender deletes the official dgVoodoo2 2.87.4 zip on sight ("Kepavll!rfn", reputation
  // based) but not the DLLs inside it (checked 2026-09-14). The pin is pointed at this fake zip.
  const base = scratchDir('legacy-dg-memory');
  const { dgZip } = fakeComponents(base);
  const zipBytes = fs.readFileSync(dgZip);
  const pinned = legacy.DGVOODOO.sha256;
  legacy.DGVOODOO.sha256 = require('node:crypto').createHash('sha256').update(zipBytes).digest('hex');
  const cache = path.join(base, 'cache');
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, status: 200, arrayBuffer: async () => zipBytes }; };
  try {
    const folder = await legacy.ensureDgVoodoo(cache, { fetchImpl });
    assert.equal(fetches, 1);
    assert.deepEqual(fs.readdirSync(cache).filter((f) => /\.zip$/i.test(f)), [], 'no zip in the cache');
    assert.equal(path.basename(folder), legacy.DGVOODOO.cacheName);
    for (const rel of ['MS/x86/D3D9.dll', 'MS/x86/D3D8.dll', 'MS/x64/D3D9.dll', 'dgVoodoo.conf', 'dgVoodooCpl.exe']) {
      assert.ok(fs.existsSync(path.join(folder, ...rel.split('/'))), rel);
    }
    assert.equal(await legacy.ensureDgVoodoo(cache, { fetchImpl }), folder);
    assert.equal(fetches, 1, 'a complete cache is not downloaded again');

    // A zip an older build cached is unpacked instead of downloading, then removed.
    const cache2 = path.join(base, 'cache-old');
    fs.mkdirSync(cache2, { recursive: true });
    fs.writeFileSync(path.join(cache2, legacy.DGVOODOO.fileName), zipBytes);
    await legacy.ensureDgVoodoo(cache2, { fetchImpl });
    assert.equal(fetches, 1);
    assert.ok(!fs.existsSync(path.join(cache2, legacy.DGVOODOO.fileName)), 'the old cached zip is gone');
    assert.ok(legacy.cachedDgVoodoo(cache2));

    // It deploys from the folder.
    const game = path.join(base, 'game');
    exeWith(game, 'OldGame.exe', { bits: 32, marker: 'Direct3DCreate9' });
    const res = await legacy.deployDgVoodoo(game, legacy.planFor({ bitness: 32, api: 'dx9' }), folder);
    assert.equal(res.dll, 'D3D9.dll');
    assert.equal(fs.readFileSync(path.join(game, 'D3D9.dll'), 'utf8'), 'dgVoodoo x86 d3d9');
  } finally {
    legacy.DGVOODOO.sha256 = pinned;
  }
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
  // Held in a borderless, screen-sized window: in exclusive fullscreen Mirror of Fate HD froze the
  // moment the helper started (it lost focus, minimised and slept in its window procedure).
  const conf32 = fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8');
  assert.match(conf32, /\[General\][^[]*FullScreenMode\s*=\s*false/);
  assert.match(conf32, /\[DirectX\][^[]*AppControlledScreenMode\s*=\s*false/);
  assert.match(conf32, /\[GeneralExt\][^[]*WindowedAttributes\s*=\s*borderless, fullscreensize/);
  // The game's own small default resolution fills the screen, keeping its shape (2026-09-15: DirectX 8/9
  // games opened as a small picture until their resolution was changed in a menu too small to read).
  assert.match(conf32, /\[General\][^[]*ScalingMode\s*=\s*stretched_ar/);

  const res = await legacy.deployHost32(game, plan, {
    ...comps,
    releaseFolder: release,
    nrDllPath: nr,
    // VORT's real layout: its includes, texture and licence sit in folders of their own, and Remove
    // has to take those folders too (Castlevania: Lords of Shadow 2 kept them, empty).
    deployShaders: async (dir) => {
      const mv = ['reshade-shaders/Shaders/vort_Motion.fx', 'reshade-shaders/Shaders/Includes/vort_Defs.fxh',
        'reshade-shaders/Textures/vort_BlueNoise.png', 'reshade-shaders/Licenses/VORT-LICENSE.txt'];
      for (const f of mv) write(dir, f, '// vort');
      write(dir, 'ReShade.ini', '[ADDON]\nAddonPath=.\\\n');
      write(dir, 'ReShadePreset.ini', 'Techniques=DLSS5_Feed@DLSS5_Feed.fx\n');
      return mv;
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
  // Pre-SR off, the same as every other Feeder game. It is held off because a Feeder game has no
  // pre-upscale frame for the pass to run on -- the "upscaler input" is a synthetic contract built
  // from ReShade's capture -- and switching it on faulted the model on Armored Core VI every run.
  // autoConfigureGame enforces that on the ini beside the exe; this route's OptiScaler reads
  // host64\OptiScaler.ini instead, and nothing was writing it there. A live Alien: Isolation ran
  // with it on (2026-09-14) because of exactly that gap.
  assert.match(ini, /RunBeforeSR=false/, 'the Pre-SR guard reaches the helper ini too');
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
  const feeder64 = await invoke('feeder:deploy', { exePath: exe, mvProviderId: 'vort' });
  assert.equal(feeder64.ok, false, 'the 64-bit Feeder is refused on a 32-bit game');
  assert.match(feeder64.error, /32-bit game/);
  assert.ok(!fs.existsSync(path.join(game, 'dlss5-feed.addon64')) && !fs.existsSync(path.join(game, 'ReShade64.dll')));

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
  const conf64 = fs.readFileSync(path.join(g64, 'dgVoodoo.conf'), 'utf8');
  assert.doesNotMatch(conf64, /FullScreenMode\s*=\s*false/, 'no helper, no forced window');
  assert.match(conf64, /ScalingMode\s*=\s*stretched_ar/, 'but the image still fills the screen');
  assert.equal(legacy.ensureDgVoodooWindowed(g64), false, 'already current: no rewrite');
  const removed = await legacy.removeLegacy(g64);
  assert.ok(removed.removed.includes('D3D9.dll'));
  assert.ok(!fs.existsSync(path.join(g64, legacy.MARKER)));
});

test('the helper folder is ours: a 32-bit game is not mistaken for one that ships DLSS', { skip: !onWindows }, () => {
  // Reported as "Alien: Isolation is falsely reporting DLSS 5 unavailable" (2026-09-14), on an
  // install that was running Neural Rendering at the time -- 3600 frames and a clean shutdown in
  // its own log. The 32-bit route puts nvngx_dlss.dll inside host64\ for the helper to load, the
  // game-tree walk in native-dlss.js descended into it, and our own DLL read as the game's. That
  // made route.js call the Feeder mis-deployed and drop the game off feeder32, and Game Help --
  // seeing a 32-bit game not on that route -- answered "it is a 32-bit game, DLSS 5 is not
  // available". Every gate went the wrong way from one wrong answer.
  const game = scratchDir('host64-ours');
  const exe = fakeExe(game, 'AI.exe');
  write(game, 'host64/nvngx_dlss.dll', 'the DLL this app puts there for the helper');

  assert.equal(nativeDlss.shippedDlssPath(game), null, 'our own helper folder is not evidence the game ships DLSS');
  assert.equal(nativeDlss.shipsNativeDlss(game), false);

  // A game that really does ship DLSS is still found: the same file anywhere the game itself owns.
  const real = scratchDir('host64-real');
  fakeExe(real, 'Game.exe');
  write(real, 'Engine/Plugins/DLSS/Binaries/ThirdParty/Win64/nvngx_dlss.dll', 'the game\'s own');
  assert.ok(nativeDlss.shippedDlssPath(real), 'a genuine plugin-tree DLSS is still detected');
});

test('an older 32-bit install is brought to the borderless window once, and left alone after', () => {
  const game = scratchDir('legacy-windowed-upgrade');
  write(game, legacy.MARKER, JSON.stringify({ version: 1, files: ['D3D9.dll', 'dgVoodoo.conf'], backups: [], dirs: ['host64'], dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' }, host32: { api: 'dx9', reshadeName: 'dxgi.dll' } }));
  // As installs before v1.63.6 wrote it: the game decides, and exclusive fullscreen wins.
  write(game, 'dgVoodoo.conf', '[General]\nOutputAPI = d3d11_fl11_0\nFullScreenMode = true\n\n[GeneralExt]\nWindowedAttributes = \n\n[DirectX]\nAppControlledScreenMode = true\nVRAM = 4096\n');
  assert.equal(legacy.ensureDgVoodooWindowed(game), true);
  const conf = fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8');
  assert.match(conf, /FullScreenMode\s*=\s*false/);
  assert.match(conf, /AppControlledScreenMode\s*=\s*false/);
  assert.match(conf, /WindowedAttributes\s*=\s*borderless, fullscreensize/);
  assert.match(conf, /ScalingMode\s*=\s*stretched_ar/, 'an older install gets the scaled image too');
  assert.match(conf, /VRAM\s*=\s*4096/, 'nothing else touched');
  assert.equal(legacy.ensureDgVoodooWindowed(game), false, 'already windowed: no rewrite');
});

test('the 32-bit in-game panel gets Insert, and a key the player chose is left alone', () => {
  // Without this the Feeder's cast_key ships as 0 -- "no key" -- so the only way to put the panel
  // on screen is to find "Show the DLSS 5 panel in-game" in ReShade's add-on tab. 45 is VK_INSERT,
  // the key the engine's panel takes on every route since v2.2.7, and here the cast IS the panel.
  // cast_mods=0 is bare: since Feeder 1.16.0-beta.6 the cast matches modifiers exactly, and nothing
  // needs holding because ReShade's own overlay is Home.
  const game = scratchDir('legacy-cast-key');
  write(game, legacy.MARKER, JSON.stringify({ version: 1, files: [], backups: [], dirs: ['host64'], host32: { api: 'dx11', reshadeName: 'dxgi.dll' } }));
  write(game, 'dlss5-feed.cfg', 'enabled=1\nmode=2\ncast_key=0\ncast_scale=100\n');

  assert.equal(legacy.ensureCastKey(game), true);
  const cfg = fs.readFileSync(path.join(game, 'dlss5-feed.cfg'), 'utf8');
  assert.match(cfg, /^cast_key=45$/m);
  assert.match(cfg, /^cast_mods=0$/m);
  assert.match(cfg, /^mode=2$/m, 'every other setting is left as it was');
  assert.match(cfg, /^cast_scale=100$/m);

  assert.equal(legacy.ensureCastKey(game), false, 'already set: no rewrite');

  // Both forms this app ever wrote move to the panel's new key -- Home alone (before cast_mods
  // existed) and Alt+Home -- because a cast on one key with the panel inside it on another is worse
  // than either. A player who picked Home for themselves loses it here; nothing tells the two apart.
  for (const before of ['enabled=1\ncast_key=36\ncast_scale=100\n', 'enabled=1\ncast_key=36\ncast_mods=1\n']) {
    write(game, 'dlss5-feed.cfg', before);
    assert.equal(legacy.ensureCastKey(game), true, 'our own old key is moved to the new one');
    const upgraded = fs.readFileSync(path.join(game, 'dlss5-feed.cfg'), 'utf8');
    assert.match(upgraded, /^cast_key=45$/m);
    assert.match(upgraded, /^cast_mods=0$/m);
    assert.equal(legacy.ensureCastKey(game), false, 'and only once');
  }

  // Modifiers the player chose in the Feeder's own panel are theirs, even on our old key.
  write(game, 'dlss5-feed.cfg', 'enabled=1\ncast_key=36\ncast_mods=6\n');
  assert.equal(legacy.ensureCastKey(game), false);
  assert.match(fs.readFileSync(path.join(game, 'dlss5-feed.cfg'), 'utf8'), /^cast_mods=6$/m);

  // A key chosen in the Feeder's own panel is the player's, not ours to replace -- and neither are
  // its modifiers, which stay the Feeder's own default rather than being given ours.
  write(game, 'dlss5-feed.cfg', 'enabled=1\ncast_key=121\n');
  assert.equal(legacy.ensureCastKey(game), false);
  const chosen = fs.readFileSync(path.join(game, 'dlss5-feed.cfg'), 'utf8');
  assert.match(chosen, /^cast_key=121$/m);
  assert.doesNotMatch(chosen, /^cast_mods=/m);

  // No cfg yet (the Feeder writes one on its first save): the key still lands, and the Feeder
  // defaults every key the file does not carry.
  const fresh = scratchDir('legacy-cast-key-fresh');
  write(fresh, legacy.MARKER, JSON.stringify({ version: 1, files: [], backups: [], dirs: ['host64'], host32: { api: 'dx11', reshadeName: 'dxgi.dll' } }));
  assert.equal(legacy.ensureCastKey(fresh), true);
  assert.equal(fs.readFileSync(path.join(fresh, 'dlss5-feed.cfg'), 'utf8'), 'cast_key=45\ncast_mods=0\n');

  // Not this route: a cast_key would toggle a picture of a host process that is not running.
  const other = scratchDir('legacy-cast-key-not-host32');
  write(other, legacy.MARKER, JSON.stringify({ version: 1, files: [], backups: [], dirs: [], dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } }));
  assert.equal(legacy.ensureCastKey(other), false);
  assert.equal(fs.existsSync(path.join(other, 'dlss5-feed.cfg')), false);
});

// #106: Dolphin was set up for DX12 (its DX11 lead turned into DX12 by preferDx12) while it ran on
// OpenGL, and nothing told the player. Each emulator is set up for its best renderer for this app,
// the route says which and where, and a run on another one is named.
test('emulators: set up for the renderer that suits DLSS 5 best, never OpenGL where there is another', () => {
  for (const p of emulators.PROFILES) {
    assert.ok(p.renderer && p.hint, `${p.key} names its renderer and where to set it`);
    if (p.apis.length > 1) assert.notEqual(p.apis[0], 'opengl', `${p.key} leads with OpenGL`);
    if (p.apis.includes('dx11')) assert.equal(p.apis[0], 'dx11', `${p.key} offers D3D11 and should lead with it`);
  }
  assert.deepEqual(emulators.profileFor('Dolphin.exe').apis, ['dx11', 'vulkan', 'dx12', 'opengl']);
  assert.ok(!emulators.profileFor('xenia_canary.exe').apis.includes('dx11'), 'Xenia has no Direct3D 11 backend');
  assert.equal(emulators.profileFor('snes9x-x64.exe').apis[0], 'vulkan', 'Snes9x\'s "Direct3D" is D3D9');
});

test('emulators: a renderer the emulator does not have is not what it ran on (RPCS3, 2026-09-23)', () => {
  const dir = scratchDir('emu-rpcs3-dx12');
  write(dir, 'rpcs3.exe', 'x');
  const emu = emulators.profileFor('rpcs3.exe');
  assert.ok(!emu.apis.includes('dx12'), 'RPCS3 has no Direct3D 12 renderer');

  // The Feeder makes its own D3D12 device to run the model on, and OptiScaler's log records it
  // without being able to say whose device it was. Read literally, a correct Vulkan run reported
  // as Direct3D 12 and the card asked for the setting the player already had.
  const det = {
    api: 'vulkan', apis: emu.apis, bitness: 64, recommend: 'optiscaler',
    emulator: { key: emu.key, name: emu.name, system: emu.system, hint: emu.hint, apis: emu.apis, renderer: emu.renderer, where: emu.where },
    runtimeApi: 'dx12', runtimeLogMtime: 1,
  };
  assert.equal(emulators.seenApi(det), null, 'RPCS3 cannot have run on D3D12');
  assert.equal(emulators.rendererAdvice(det, 'vulkan').seen, null, 'no "set Vulkan" on a Vulkan run');

  // Same for a watched launch, which sees the Feeder's d3d12.dll load in the tree.
  const probed = { ...det, runtimeApi: null, probe: { api: 'dx12', capturedAt: new Date(10).toISOString() } };
  assert.equal(emulators.seenApi(probed), null);

  // ... and a renderer it DOES have is still reported.
  assert.equal(emulators.seenApi({ ...det, runtimeApi: 'opengl' }), 'opengl');
  assert.equal(emulators.rendererAdvice({ ...det, runtimeApi: 'opengl' }, 'vulkan').seen, 'OpenGL');

  // Game Help must not reach the mismatch step, whose only advice is to change a correct setting.
  const r = route.recommendRoute(dir, path.join(dir, 'rpcs3.exe'), route.withApiOverride(det, null), 'nvidia');
  assert.equal(r.emulatorRenderer.seen, null);
  const d = diagnose({
    detected: det,
    route: { ...r, complete: true, nextStep: null, optiInstalled: true, feederDeployed: true },
    run: { ran: true, verdict: 'no-dlss' }, foreign: [], fixesTried: [],
  });
  assert.notEqual(d.code, 'emulator-renderer-mismatch');

  // A profile with no API list claims nothing, so the evidence stands.
  assert.equal(emulators.canRender({ apis: [] }, 'dx12'), true);
});

test('emulators: a renderer the emulator does not have cannot be installed either (RPCS3, DX12)', () => {
  const dir = scratchDir('emu-rpcs3-override');
  write(dir, 'rpcs3.exe', 'x');
  const emu = emulators.profileFor('rpcs3.exe');
  const det = {
    api: 'vulkan', apis: emu.apis, bitness: 64, recommend: 'optiscaler',
    emulator: { key: emu.key, name: emu.name, system: emu.system, hint: emu.hint, apis: emu.apis, renderer: emu.renderer, where: emu.where },
  };

  // Picking DX12 in Edit used to configure the whole DX12 route for an emulator that has had no
  // Direct3D backend since 2017. Refused now -- and said, not silently dropped back to Auto.
  const forced = route.withApiOverride(det, 'dx12');
  assert.equal(forced.api, 'vulkan', 'DX12 never becomes the route API on RPCS3');
  assert.equal(forced.apiOverride, null);
  assert.equal(forced.apiOverrideRefused.api, 'dx12');
  assert.deepEqual(forced.apiOverrideRefused.apis, emu.apis);
  assert.ok(!route.recommendRoute(dir, path.join(dir, 'rpcs3.exe'), forced, 'nvidia').steps.some((st) => /dx12/i.test(st.label)));

  // The legacy overrides are the same answer: RPCS3 has no Direct3D at all.
  for (const api of ['dx11', 'dx10', 'dx9', 'dx8']) {
    const r = route.withApiOverride(det, api);
    assert.equal(r.api, 'vulkan', `${api} is not a renderer RPCS3 has`);
    assert.equal(r.apiOverrideRefused.api, api);
  }

  // A renderer it DOES have is honoured exactly as before.
  const gl = route.withApiOverride(det, 'opengl');
  assert.equal(gl.api, 'opengl');
  assert.equal(gl.apiOverride, 'opengl');
  assert.equal(gl.apiOverrideRefused, null);

  // Dolphin has Direct3D 12, so choosing it there is still the user's to make.
  const dol = emulators.profileFor('Dolphin.exe');
  const dolDet = { api: 'dx11', apis: dol.apis, bitness: 64, recommend: 'optiscaler', emulator: { key: dol.key, name: dol.name, apis: dol.apis } };
  assert.equal(route.withApiOverride(dolDet, 'dx12').api, 'dx12');

  // And a game that is not an emulator is untouched: nothing here narrows an ordinary override.
  const plain = route.withApiOverride({ api: 'dx11', apis: ['dx11'], bitness: 64, recommend: 'optiscaler' }, 'dx12');
  assert.equal(plain.api, 'dx12');
  assert.equal(plain.apiOverrideRefused, null);
});

test('emulators: DX11 stays DX11 (no DX12 preference), and the route carries the renderer advice', () => {
  const dir = scratchDir('emu-106');
  write(dir, 'Dolphin.exe', 'x');
  const emu = { key: 'dolphin', name: 'Dolphin', system: 'GameCube / Wii', apis: ['dx11', 'vulkan', 'dx12', 'opengl'], renderer: 'Direct3D 11', where: 'Graphics > General > Backend', hint: 'Graphics > General > Backend: Direct3D 11' };
  const det = { api: 'dx11', apis: emu.apis, bitness: 64, recommend: 'optiscaler', emulator: emu, runtimeApi: 'opengl', runtimeLogMtime: 1 };
  assert.equal(route.withApiOverride(det, null).api, 'dx11');
  const r = route.recommendRoute(dir, path.join(dir, 'Dolphin.exe'), route.withApiOverride(det, null), 'nvidia');
  assert.deepEqual(r.emulatorRenderer, { name: 'Dolphin', api: 'dx11', renderer: 'Direct3D 11', hint: emu.hint, seen: 'OpenGL', openglOnly: false });

  // Picked in Edit: the advice follows the choice, with the menu path but not the D3D11 name.
  const vk = emulators.rendererAdvice({ ...det, runtimeApi: 'vulkan' }, 'vulkan');
  assert.equal(vk.renderer, 'Vulkan');
  assert.equal(vk.hint, 'Graphics > General > Backend');
  assert.equal(vk.seen, null);

  // A watched launch newer than OptiScaler's log is the fresher evidence.
  const probed = { ...det, probe: { api: 'vulkan', capturedAt: new Date(10).toISOString() } };
  assert.equal(emulators.seenApi(probed), 'vulkan');
  assert.equal(emulators.rendererAdvice({ emulator: { key: 'melonds', name: 'melonDS' } }, 'opengl').openglOnly, true);

  // Game Help: a run with no DLSS in it names the setting instead of "no known fix".
  const ctx = (routeObj) => ({ detected: det, route: { ...routeObj, complete: true, nextStep: null, optiInstalled: true, feederDeployed: true }, run: { ran: true, verdict: 'no-dlss' }, foreign: [], fixesTried: [] });
  const d = diagnose(ctx({ ...r, emulatorRenderer: { ...r.emulatorRenderer, seen: null } }));
  assert.equal(d.code, 'emulator-renderer');
  assert.equal(diagnose(ctx(r)).code, 'emulator-renderer-mismatch');
  assert.equal(diagnose(ctx(r)).vars.seen, 'OpenGL');
});

test('emulators: a watched launch no longer moves the route, it is kept for the warning', () => {
  const probe = require('../src/probe');
  const d = { api: 'dx11', apis: ['dx11', 'vulkan', 'dx12', 'opengl'], emulator: { key: 'dolphin', apis: ['dx11', 'vulkan', 'dx12', 'opengl'] } };
  const out = probe.applyProbe(d, { version: 1, api: 'opengl', apiEvidence: 'wglCreateContext', capturedAt: new Date().toISOString() });
  assert.equal(out.api, 'dx11');
  assert.equal(out.probe.api, 'opengl');
  assert.equal(out.probe.applied, false);
});

// Castlevania LoS2 (2026-09-22): sync returned before the Feeder on the 32-bit route, so the game kept
// 1.16.0-beta.5 after beta.6 fixed the in-game panel's cursor.
test('a 32-bit install\'s Feeder follows the release on sync, all three files or none', { skip: !onWindows }, async () => {
  const base = scratchDir('feeder32-refresh');
  const src = path.join(base, 'feeder-src');
  write(src, 'dlss5-feed.addon32', 'addon32 beta.7');
  write(src, 'host64/dlss5-feed-host64.exe', 'host exe beta.7');
  write(src, 'reshade-shaders/Shaders/DLSS5_Feed.fx', '// feed fx beta.7');
  const zip = zipDir(src, path.join(base, 'DLSS5-Feeder-new.zip'));

  const game = path.join(base, 'game');
  const addon = write(game, 'dlss5-feed.addon32', 'addon32 beta.5');
  const host = write(game, 'host64/dlss5-feed-host64.exe', 'host exe beta.5');
  const fx = write(game, 'reshade-shaders/Shaders/DLSS5_Feed.fx', '// feed fx beta.5');
  write(game, '.dlss5ui-legacy.json', JSON.stringify({ version: 1, files: [], dirs: ['host64'], host32: { api: 'dx9', reshadeName: 'dxgi.dll' } }));

  // The helper exe locked: nothing may be left half-updated, the add-on included.
  fs.chmodSync(host, 0o444);
  await assert.rejects(legacy.refreshFeeder32(game, zip));
  assert.equal(fs.readFileSync(addon, 'utf8'), 'addon32 beta.5', 'the add-on was put back');
  assert.equal(fs.readFileSync(host, 'utf8'), 'host exe beta.5');
  fs.chmodSync(host, 0o666);

  const res = await legacy.refreshFeeder32(game, zip);
  assert.equal(res.updated, true);
  assert.equal(fs.readFileSync(addon, 'utf8'), 'addon32 beta.7');
  assert.equal(fs.readFileSync(host, 'utf8'), 'host exe beta.7');
  assert.equal(fs.readFileSync(fx, 'utf8'), '// feed fx beta.7');
  assert.equal((await legacy.refreshFeeder32(game, zip)).updated, false, 'nothing to do the second time');

  // Not a 32-bit install: never touched.
  const other = path.join(base, 'other');
  write(other, 'dlss5-feed.addon32', 'someone else\'s');
  assert.equal((await legacy.refreshFeeder32(other, zip)).updated, false);
});
