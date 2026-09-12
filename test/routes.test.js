'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const route = require(path.join(REPO, 'src', 'route'));
const lumaue = require(path.join(REPO, 'src', 'lumaue'));
const runlog = require(path.join(REPO, 'src', 'runlog'));

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
