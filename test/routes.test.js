'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const route = require(path.join(REPO, 'src', 'route'));
const lumaue = require(path.join(REPO, 'src', 'lumaue'));
const runlog = require(path.join(REPO, 'src', 'runlog'));
const discover = require(path.join(REPO, 'src', 'discover'));

const UE4_DX11 = { engineId: 'unreal', engine: 'Unreal Engine 4.21', engineVersion: '4.21', api: 'dx11' };

test('Luma UE is the default route only where verified; other UE4 D3D11 games default to the Feeder', () => {
  const fo = scratchDir('fo');
  const foExe = fakeExe(path.join(fo, 'SwGame', 'Binaries', 'Win64'), 'starwarsjedifallenorder.exe');
  write(path.dirname(foExe), 'SwGame-Win64-Shipping.exe', 'x');
  assert.equal(lumaue.isFallenOrder(foExe), true, 'any exe beside SwGame-Win64-Shipping.exe in SwGame\\Binaries\\Win64 is Fallen Order');
  assert.equal(route.recommendRoute(path.dirname(foExe), foExe, UE4_DX11, 'nvidia').route, 'lumaue');

  const other = scratchDir('ue4');
  const exe = fakeExe(path.join(other, 'Foo', 'Binaries', 'Win64'), 'Foo-Win64-Shipping.exe');
  assert.equal(lumaue.isLumaUeGame(exe, UE4_DX11), true, 'eligible in Edit');
  assert.equal(lumaue.isLumaUeDefault(exe), false);
  assert.equal(route.recommendRoute(path.dirname(exe), exe, UE4_DX11, 'nvidia').route, 'feeder');
  assert.equal(lumaue.lumaUeReadiness(path.dirname(exe), exe, UE4_DX11).experimental, true);
});

// Prey (2017), 2026-09-15: Luma's own Prey mod (a real DLSS call with engine motion vectors) instead of the
// Feeder. Prey (2006) shares the exe name and is not it.
test('Prey (2017) takes the Luma route with the Prey mod; Prey (2006) does not', () => {
  const root = scratchDir('prey2017');
  const exe = fakeExe(path.join(root, 'Binaries', 'Danielle', 'x64', 'Release'), 'Prey.exe');
  const dir = path.dirname(exe);
  const cry = { engineId: 'cryengine', engine: 'CryEngine', api: 'dx11', apis: ['dx11'] };
  assert.equal(lumaue.isPrey2017(exe), true);
  assert.equal(lumaue.isLumaUeDefault(exe), true);
  assert.equal(lumaue.lumaProfileFor(exe, cry).id, 'prey');
  const r = route.recommendRoute(dir, exe, cry, 'nvidia');
  assert.equal(r.route, 'lumaue');
  assert.equal(r.label, 'OptiScaler + Luma');
  const ready = lumaue.lumaUeReadiness(dir, exe, cry);
  assert.equal(ready.supported, true);
  assert.equal(ready.profile, 'prey');
  assert.equal(ready.experimental, false);

  // Deployed: the add-on on disk is what counts, whichever mod it is.
  write(dir, 'Luma-Prey.addon', 'x');
  assert.equal(lumaue.lumaUeDeployed(dir), true);
  assert.equal(lumaue.deployedProfile(dir).id, 'prey');

  const old = scratchDir('prey2006');
  const oldExe = fakeExe(path.join(old, 'System'), 'prey.exe');
  assert.equal(lumaue.isPrey2017(oldExe), false);
  assert.equal(lumaue.lumaProfileFor(oldExe, { engineId: null, api: 'opengl' }), null);
});

test('Luma deploy picks the game\'s mod from the release and Remove takes it back out', async () => {
  const zlib = require('node:zlib');
  const makeZip = (files) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const data = Buffer.from(text);
      const comp = zlib.deflateRawSync(data);
      const nameBuf = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
      locals.push(local, nameBuf, comp);
      centrals.push(cd, nameBuf);
      offset += local.length + nameBuf.length + comp.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
  };
  const preyZip = makeZip({ 'Luma/Global/Luma_Copy_PS.hlsl': 'shader', 'dxgi.dll': 'MZ reshade', 'Luma-Prey.addon': 'MZ prey addon', 'nvngx_dlss.dll': 'MZ dlss' });
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (/releases\/latest$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'latest-676', assets: [
        { name: 'Luma-Unreal_Engine.zip', browser_download_url: 'https://dl/ue' },
        { name: 'Luma-Prey-Test.zip', browser_download_url: 'https://dl/prey-test' },
        { name: 'Luma-Prey.zip', browser_download_url: 'https://dl/prey' },
      ] }) };
    }
    if (url === 'https://dl/prey') return { ok: true, status: 200, arrayBuffer: async () => preyZip.buffer.slice(preyZip.byteOffset, preyZip.byteOffset + preyZip.byteLength) };
    throw new Error('unexpected ' + url);
  };
  try {
    const root = scratchDir('prey-deploy');
    const exe = fakeExe(path.join(root, 'Binaries', 'Danielle', 'x64', 'Release'), 'Prey.exe');
    const dir = path.dirname(exe);
    write(dir, 'nvngx_dlss.dll', 'already here');
    const feeder = require(path.join(REPO, 'src', 'feeder'));
    const origDlss = feeder.deployNvngxDlss;
    feeder.deployNvngxDlss = async () => ({ deployed: false });
    try {
      await assert.rejects(lumaue.deployLumaUeStack(dir, { cacheDir: path.join(root, 'cache'), profile: lumaue.LUMA_PROFILES.prey }), /licence/);
      const res = await lumaue.deployLumaUeStack(dir, { cacheDir: path.join(root, 'cache'), licenseConfirmed: true, profile: lumaue.LUMA_PROFILES.prey });
      assert.equal(res.deployed, true);
    } finally {
      feeder.deployNvngxDlss = origDlss;
    }
    assert.ok(seen.includes('https://dl/prey'), 'the Prey mod, not the Test build or the Unreal one');
    assert.equal(fs.readFileSync(path.join(dir, 'Luma-Prey.addon'), 'utf8'), 'MZ prey addon');
    assert.equal(fs.readFileSync(path.join(dir, 'ReShade64.dll'), 'utf8'), 'MZ reshade', "Luma's ReShade goes in as ReShade64.dll");
    assert.ok(!fs.existsSync(path.join(dir, 'dxgi.dll')), 'the dxgi.dll slot stays free for OptiScaler');
    assert.ok(fs.existsSync(path.join(dir, 'Luma', 'Global', 'Luma_Copy_PS.hlsl')));
    const { getIniKey } = require(path.join(REPO, 'src', 'ini-merge'));
    const reshadeIni = () => fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
    assert.equal(getIniKey(reshadeIni(), 'Luma', 'SRUserType'), '2', 'Luma starts with DLSS, no overlay trip');
    // A player's own None or FSR 3 stays; Auto is brought to DLSS on the next sync.
    fs.writeFileSync(path.join(dir, 'ReShade.ini'), reshadeIni().replace('SRUserType=2', 'SRUserType=3'));
    assert.equal(lumaue.ensureLumaDlss(dir), false);
    assert.equal(getIniKey(reshadeIni(), 'Luma', 'SRUserType'), '3');
    fs.writeFileSync(path.join(dir, 'ReShade.ini'), reshadeIni().replace('SRUserType=3', 'SRUserType=1'));
    assert.equal(lumaue.ensureLumaDlss(dir), true);
    assert.equal(getIniKey(reshadeIni(), 'Luma', 'SRUserType'), '2');

    const r = await lumaue.removeLumaStack(dir);
    assert.ok(r.removed.includes('Luma-Prey.addon'));
    assert.ok(!fs.existsSync(path.join(dir, 'Luma')));
    assert.equal(lumaue.lumaUeDeployed(dir), false);
  } finally {
    global.fetch = realFetch;
  }
});

test('Spyro is refused for Luma, with the reason', () => {
  const dir = scratchDir('spyro');
  const exe = fakeExe(path.join(dir, 'Spyro', 'Binaries', 'Win64'), 'Spyro-Win64-Shipping.exe');
  const r = lumaue.lumaUeReadiness(path.dirname(exe), exe, UE4_DX11);
  assert.equal(r.supported, false);
  assert.match(r.reason, /known not to work/);
});

test('a game that ships DLSS in its Unreal plugin tree is never routed to the Feeder, and a Feeder there is flagged', () => {
  const root = scratchDir('cv2');
  fs.mkdirSync(path.join(root, 'Engine', 'Plugins', 'DLSS', 'Binaries', 'ThirdParty', 'Win64'), { recursive: true });
  write(root, 'Engine/Plugins/DLSS/Binaries/ThirdParty/Win64/nvngx_dlss.dll', 'game');
  const exe = fakeExe(path.join(root, 'CodeVein2', 'Binaries', 'Win64'), 'CodeVein2-Win64-Shipping.exe');
  const dir = path.dirname(exe);
  const det = { engineId: 'unreal', engine: 'Unreal Engine', api: 'dx12' };
  assert.equal(route.recommendRoute(dir, exe, det, 'nvidia').route, 'optiscaler');
  write(dir, 'dlss5-feed.addon64', 'x');
  const r = route.recommendRoute(dir, exe, det, 'nvidia');
  assert.equal(r.route, 'optiscaler');
  assert.equal(r.feederMisdeployed, true);
  assert.equal(r.nextStep, 'Remove the DLSS5 Feeder (Edit)');
});

test('runlog turns the logs into the verdict the card shows', async () => {
  const head = '[00:00:00.000000] [W] OptiScaler v10 loaded\n[00:00:00.000001] [I] Log.LogLevel: 2\n';
  const cases = [
    ['nr-ran', head + '[00:00:01.000000] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n' + '[00:00:03.000000] [I] DlssNr_Dx12::Dispatch DLSS-NR running before SR: x\n'.repeat(4) + '[00:00:09.000000] [I] DLL_PROCESS_DETACH\n'],
    ['dlss-no-nr', head + '[00:00:01.000000] [I] hkD3D11CreateDeviceAndSwapChain Device captured\n[00:00:02.000000] [I] NVSDK_NGX_D3D11_Init_ProjectID calling\n[00:00:03.000000] [I] NVSDK_NGX_D3D11_CreateFeature Creating new DLSS feature\n[00:00:03.100000] [I] DLSSFeatureDx11::InitInternal Creating DLSS feature\n'],
    ['init-no-feature', head + '[00:00:02.000000] [I] NVSDK_NGX_D3D11_Init_ProjectID calling\n'],
    ['no-dlss', head + '[00:00:01.000000] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n'],
  ];
  for (const [want, log] of cases) {
    const dir = scratchDir('run-' + want);
    write(dir, 'OptiScaler.log', log);
    const r = await runlog.analyzeRun(dir);
    assert.equal(r.verdict, want);
  }
  const dup = scratchDir('run-dup');
  write(dup, 'OptiScaler.log', head);
  write(dup, 'dlss5-feed.log', '[feed] CreateFeature raised 0xC0000005 (reading address FFFFFFFFFFFFFFFF)\n[feed] two copies of the DLSS NGX module are loaded\n');
  assert.equal((await runlog.analyzeRun(dup)).verdict, 'duplicate-dlss');
  assert.equal((await runlog.analyzeRun(scratchDir('run-none'))).ran, false);
});

test('Vulkan and OpenGL games with no DLSS of their own take the Feeder route, with the API-specific note', () => {
  const vk = scratchDir('route-vk');
  const vkExe = fakeExe(vk, 'Doom.exe');
  const r = route.recommendRoute(vk, vkExe, { api: 'vulkan', apis: ['vulkan'] }, 'nvidia');
  assert.equal(r.route, 'feeder');
  assert.match(r.reason, /Vulkan layer/);
  assert.match(r.reason, /Smooth Motion/);

  const gl = scratchDir('route-gl');
  const glExe = fakeExe(gl, 'MXBikes.exe');
  const g = route.recommendRoute(gl, glExe, { api: 'opengl', apis: ['opengl'] }, 'nvidia');
  assert.equal(g.route, 'feeder');
  assert.match(g.reason, /opengl32\.dll/);

  assert.ok(route.API_OVERRIDE_VALUES.includes('opengl'));
});

test('Resident Evil 2 takes the REFramework pd-upscaler route, before and after the DLSS DLL it places; a Feeder on disk keeps the Feeder route', () => {
  const reengine = require(path.join(REPO, 'src', 'reengine'));
  const dir = scratchDir('route-re2');
  const exe = fakeExe(dir, 're2.exe');
  write(dir, 're_chunk_000.pak', 'x');
  assert.equal(reengine.pdUpscalerGame(exe), 'RE2');
  assert.equal(reengine.pdUpscalerGame(path.join(dir, 'dd2.exe')), null);

  const before = route.recommendRoute(dir, exe, { api: 'dx12', apis: ['dx12'], engineId: 're' }, 'nvidia');
  assert.equal(before.route, 'reframework-pd');
  // The Present route: one step, no plugin to fetch.
  assert.deepEqual(before.steps.map((s) => s.key), ['optiscaler']);

  // An old pd-route install (pd build + nvngx_dlss.dll) is still this route, not "ships its own DLSS".
  write(dir, 'dinput8.dll', 'pd');
  write(dir, 'nvngx_dlss.dll', 'x');
  reengine.writeBuildMarker(dir, { build: 'pd-upscaler', revision: 'abc' });
  const after = route.recommendRoute(dir, exe, { api: 'dx12', apis: ['dx12'], engineId: 're' }, 'nvidia');
  assert.equal(after.route, 'reframework-pd');
  const st = reengine.pdStatus(dir, exe);
  assert.equal(st.reframeworkBuild, 'pd-upscaler');
  assert.equal(st.dlssPresent, true);
  assert.equal(st.temporalUpscalerOn, false);

  // TemporalUpscaler left on from that install: seen, and switched off by presentRouteConfigure.
  write(dir, 're2_fw_config.txt', 'TemporalUpscaler_Enabled=true\r\nTemporalUpscaler_UpscaleQuality=1\r\n');
  assert.equal(reengine.pdStatus(dir, exe).temporalUpscalerOn, true);
  assert.deepEqual(reengine.presentRouteConfigure(dir), ['re2_fw_config.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 're2_fw_config.txt'), 'utf8'), 'TemporalUpscaler_Enabled=false\r\nTemporalUpscaler_UpscaleQuality=1\r\n');
  assert.equal(reengine.pdStatus(dir, exe).temporalUpscalerOn, false);
  assert.deepEqual(reengine.presentRouteConfigure(dir), [], 'nothing left to change');

  const feederDir = scratchDir('route-re2-feeder');
  const feederExe = fakeExe(feederDir, 're2.exe');
  write(feederDir, 're_chunk_000.pak', 'x');
  write(feederDir, 'dlss5-feed.addon64', 'x');
  assert.equal(route.recommendRoute(feederDir, feederExe, { api: 'dx12', apis: ['dx12'], engineId: 're' }, 'nvidia').route, 'feeder');
});

// Devil May Cry 5 (2026-09-14) took the Feeder route, which collides with the engine's Present route.
test('Devil May Cry 5 and Street Fighter 6 take the Present route; a Feeder this app deployed does not hold them, one placed by hand does', () => {
  const reengine = require(path.join(REPO, 'src', 'reengine'));
  const detected = { api: 'dx12', apis: ['dx12'], engineId: 're' };
  for (const exeName of ['DevilMayCry5.exe', 'StreetFighter6.exe']) {
    const dir = scratchDir('route-present-' + exeName);
    const exe = fakeExe(dir, exeName);
    write(dir, 're_chunk_000.pak', 'x');
    assert.ok(reengine.presentRouteGame(exe));
    assert.equal(reengine.pdUpscalerGame(exe), null, 'not one of the five pd games');
    assert.equal(route.recommendRoute(dir, exe, detected, 'nvidia').route, 'reframework-pd');

    write(dir, 'dlss5-feed.addon64', 'x');
    assert.equal(route.recommendRoute(dir, exe, detected, 'nvidia').route, 'feeder', 'a hand-placed Feeder is a choice');
    write(dir, '.dlss5ui-feeder-deploy.json', '{}');
    assert.equal(route.recommendRoute(dir, exe, detected, 'nvidia').route, 'reframework-pd', 'ours is the old route');
  }
});

test('Elden Ring, Armored Core VI and Nightreign take the Present route by ini; our old Feeder does not hold them', () => {
  const presentroute = require(path.join(REPO, 'src', 'presentroute'));
  const detected = { api: 'dx12', apis: ['dx12'] };
  for (const exeName of ['eldenring.exe', 'armoredcore6.exe', 'nightreign.exe']) {
    const dir = scratchDir('route-ini-present-' + exeName);
    const exe = fakeExe(dir, exeName);
    write(dir, 'start_protected_game.exe', 'x');
    assert.ok(presentroute.iniPresentGame(exe));
    assert.equal(route.recommendRoute(dir, exe, detected, 'nvidia').route, 'present');

    write(dir, 'dlss5-feed.addon64', 'x');
    assert.equal(route.recommendRoute(dir, exe, detected, 'nvidia').route, 'feeder', 'a hand-placed Feeder is a choice');
    write(dir, '.dlss5ui-feeder-deploy.json', '{}');
    assert.equal(route.recommendRoute(dir, exe, detected, 'nvidia').route, 'present', 'ours is the route that crashed the model');
  }
  const other = fakeExe(scratchDir('route-ini-present-other'), 'sekiro.exe');
  assert.equal(presentroute.iniPresentGame(other), null);
});

// A user's RE2 folder (2026-09-12): another DLSS 5 tool had left a full Streamline set beside the
// exe, with `.original` backups. That read as "this game ships its own DLSS", so the card said
// "just Install" -- the wrong route for a game with no DLSS call. The RE route must win over
// leftovers on these five games; since the Present route it asks for nothing to be downloaded.
test('Resident Evil 2 with another tool\'s Streamline/DLSS leftovers still takes the RE route, which needs no download', () => {
  const reengine = require(path.join(REPO, 'src', 'reengine'));
  const { diagnose } = require(path.join(REPO, 'src', 'gamehelp'));
  const nativeDlss = require(path.join(REPO, 'src', 'native-dlss'));
  const dir = scratchDir('route-re2-leftovers');
  const exe = fakeExe(dir, 're2.exe');
  write(dir, 're_chunk_000.pak', 'x');
  for (const f of ['sl.interposer.dll', 'sl.interposer.dll.original', 'sl.common.dll', 'sl.common.dll.original', 'sl.dlss.dll',
    'sl.dlss_g.dll', 'sl.dlss_nr.dll', 'nvngx_dlss.dll', 'nvngx_dlss.dll.original', 'nvngx_dlssg.dll', 'nvngx_dlssnr.dll.original']) {
    write(dir, f, 'leftover');
  }
  assert.equal(nativeDlss.shipsNativeDlss(dir), true, 'the leftovers do look like shipped DLSS -- which is the trap');

  const detected = { api: 'dx12', apis: ['dx12', 'dx11'], engineId: 're' };
  const r = route.recommendRoute(dir, exe, detected, 'nvidia');
  assert.equal(r.route, 'reframework-pd');
  assert.equal(r.steps.some((s) => s.key === 'pd-plugin'), false);

  // After Install (REFramework + OptiScaler), Game Help asks for a run, not a download.
  write(dir, 'dinput8.dll', 'pd');
  reengine.writeBuildMarker(dir, { build: 'pd-upscaler', revision: 'abc' });
  const after = route.recommendRoute(dir, exe, detected, 'nvidia');
  assert.equal(after.route, 'reframework-pd');
  const help = diagnose({
    detected: { api: 'dx12', bitness: 64, antiCheat: null },
    route: { ...after, optiInstalled: true },
    run: { ran: false, verdict: 'no-log' },
    foreign: [], lumaKnownBad: null, reEngine: true, reframeworkPresent: true, nrEnabledInIni: true, fixesTried: [],
    pdUpscaler: reengine.pdStatus(dir, exe), pdPluginPage: 'https://example/plugin',
  });
  assert.equal(help.code, 'needs-run');
});

test('the pd-upscaler REFramework download (zip inside a zip) yields dinput8.dll and its revision', { skip: !fs.existsSync(path.join(process.env.TEMP || '', '..', 'claude')) }, () => {
  const reengine = require(path.join(REPO, 'src', 'reengine'));
  const zip = 'C:/Users/mrcgi/AppData/Local/Temp/claude/C--Windows-system32/e7f1a758-15c5-4699-ba97-a565704fb4ec/scratchpad/pd-REFramework.zip';
  if (!fs.existsSync(zip)) return;
  const dest = path.join(scratchDir('pd-extract'), 'dinput8.dll');
  const rev = reengine.extractPdReframework(zip, dest);
  assert.ok(fs.statSync(dest).size > 1024 * 1024);
  assert.ok(rev && rev.length >= 7, 'revision text present');
});

test('a game already on the grid is not re-proposed after its exe was changed by hand', () => {
  // The library scan used to dedupe on the exact exe it would pick. Someone who corrected a game's
  // exe in Edit got that game offered again as a new card, pointing back at the wrong exe.
  const root = path.join(scratchDir('rescan'), 'common');
  const dir = path.join(root, 'Some Game');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'SomeGame.exe', 'x'.repeat(4096));
  write(dir, 'SomeGame_Launcher.exe', 'x'.repeat(4096));
  const picked = discover.chooseExe(dir, 'Some Game');
  assert.ok(picked, 'the scan picks something');

  const scan = (knownExePaths) => discover.scanForGames({ extraFolders: [root], knownExePaths }).games
    .filter((g) => g.dir.toLowerCase() === dir.toLowerCase());

  assert.equal(scan([]).length, 1, 'an unknown game is offered');
  assert.equal(scan([picked.exePath]).length, 0, 'the exe the scan would pick is known');
  // The one that matters: a different exe in the same folder, which is what a hand-correction
  // leaves behind.
  assert.equal(scan([path.join(dir, 'SomeGame_Launcher.exe')]).length, 0, 'same folder, different exe: still known');
});

// A game with both DX12 and DX11 defaults to DX12 (2026-09-15) -- unless OptiScaler's log proves it actually
// ran DX11 last time. What changed on 2026-09-16 is that this is a default rather than the final word: a DX11
// choice made in Edit used to be dropped on the way through, so the setting appeared to do nothing and fell
// back to Auto with nothing to say it had.
test('both DX12 and DX11: DX12 is the default, and a choice made in Edit wins over it', () => {
  const { withApiOverride } = require('../src/route');
  const both = { api: 'dx11', apis: ['dx11', 'dx12'], recommend: 'optiscaler' };

  // Auto, unchanged.
  assert.equal(withApiOverride(both, null).api, 'dx12');
  assert.equal(withApiOverride({ ...both, runtimeApi: 'dx11' }, null).api, 'dx11', 'the game really ran DX11');
  assert.equal(withApiOverride({ api: 'dx11', apis: ['dx11'] }, null).api, 'dx11', 'DX11-only stays DX11');
  assert.equal(withApiOverride({ api: 'vulkan', apis: ['vulkan', 'dx11', 'dx12'], runtimeApi: 'vulkan' }, null).api, 'vulkan');

  // Chosen, and honoured -- including DX11, which was the one that used to be thrown away.
  const picked = withApiOverride(both, 'dx11');
  assert.equal(picked.api, 'dx11', 'a DX11 choice applies');
  assert.equal(picked.apiOverride, 'dx11', 'and is reported as a choice, so the card and Edit show it');
  assert.equal(picked.apis[0], 'dx11');
  assert.equal(withApiOverride(both, 'vulkan').api, 'vulkan');

  // Nonsense is still ignored rather than taken as an API.
  assert.equal(withApiOverride(both, 'glide').apiOverride, null);
  assert.equal(withApiOverride(both, 'glide').api, 'dx12');
});

// Luma is a DX11 framework, so its games default to DX11 -- but that is also only a default now. The choice
// used to be discarded outright here too, with apiOverride nulled, so Edit showed Auto whatever was picked.
test('a Luma game defaults to DX11, and still takes a choice', () => {
  const { withApiOverride } = require('../src/route');
  const both = { api: 'dx12', apis: ['dx12', 'dx11'], recommend: 'optiscaler' };

  const auto = withApiOverride(both, null, { luma: true });
  assert.equal(auto.api, 'dx11', 'Luma prefers the API its framework is built on');
  assert.equal(auto.apiOverride, null);

  const chosen = withApiOverride(both, 'dx12', { luma: true });
  assert.equal(chosen.api, 'dx12', 'and the user can still say otherwise');
  assert.equal(chosen.apiOverride, 'dx12');
});

test('a DirectX 9 game through DXVK does not "ship DLSS" because a DLSS 5 mod put Streamline beside it', () => {
  // Star Wars: The Old Republic, 2026-09-16: sl.* files from a RenoDX DLSS 5 setup (renamed
  // Xrenodx-dlss5.addon64), D3D9.dll = DXVK. It was routed as native DLSS and got an OptiScaler its
  // renderer never loads; the renamed add-on went unseen as another DLSS 5 toolchain.
  const nativeDlss = require(path.join(REPO, 'src', 'native-dlss'));
  const detect = require(path.join(REPO, 'src', 'detect'));
  const dir = scratchDir('swtor');
  for (const f of ['swtor.exe', 'sl.interposer.dll', 'sl.dlss_nr.dll', 'D3D9.dll', 'Xrenodx-dlss5.addon64']) write(dir, f, 'x');
  const det = { api: 'vulkan', apis: ['vulkan', 'dx9'], bitness: 64, recommend: 'optiscaler', vulkanWrapper: { file: 'd3d9.dll', kind: 'DXVK' } };
  assert.equal(nativeDlss.rendererCannotCallDlss(det), true);
  assert.notEqual(route.recommendRoute(dir, path.join(dir, 'swtor.exe'), det, 'nvidia').route, 'optiscaler');
  assert.deepEqual(detect.foreignToolchains(dir).map((f) => f.tool), ['a RenoDX DLSS 5 add-on']);

  assert.equal(nativeDlss.rendererCannotCallDlss({ api: 'dx12', apis: ['dx12', 'dx9'] }), false, 'a modern path keeps native DLSS possible');
  assert.equal(nativeDlss.rendererCannotCallDlss({ api: 'vulkan', apis: ['vulkan'] }), false, 'native Vulkan can call DLSS');
});
