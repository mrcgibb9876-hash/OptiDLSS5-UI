'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const detect = require(path.join(REPO, 'src', 'detect'));
const nativeDlss = require(path.join(REPO, 'src', 'native-dlss'));
const { diagnose } = require(path.join(REPO, 'src', 'gamehelp'));
const onWindows = process.platform === 'win32';

test('apiFromFileName reads the renderer suffix games put in exe names', () => {
  assert.equal(detect.apiFromFileName('C:/x/farcry3_d3d11.exe'), 'dx11');
  assert.equal(detect.apiFromFileName('C:/x/game-dx12.exe'), 'dx12');
  assert.equal(detect.apiFromFileName('C:/x/game_vulkan.exe'), 'vulkan');
  assert.equal(detect.apiFromFileName('C:/x/game.exe'), null);
});

test('resolveUnrealShippingExe swaps a root launcher stub for the shipping exe', () => {
  const root = scratchDir('stub');
  fs.mkdirSync(path.join(root, 'Engine'));
  write(root, 'Proj/Binaries/Win64/Proj-Win64-Shipping.exe', 'x');
  write(root, 'Proj.exe', 'stub');
  assert.equal(detect.resolveUnrealShippingExe(path.join(root, 'Proj.exe')), path.join(root, 'Proj', 'Binaries', 'Win64', 'Proj-Win64-Shipping.exe'));
  // not a UE root (no Engine folder): untouched
  const other = scratchDir('nostub');
  write(other, 'game.exe', 'x');
  assert.equal(detect.resolveUnrealShippingExe(path.join(other, 'game.exe')), path.join(other, 'game.exe'));
});

test('optiScalerRuntimeApi reads the swapchain the game really created', async () => {
  const d3d11 = scratchDir('rt11');
  write(d3d11, 'OptiScaler.log', '[00:00:01.000000] [I] hkD3D11CreateDeviceAndSwapChain Device captured\n[00:00:01.000001] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n[00:00:02.000000] [I] DxgiFactoryHooks::CreateSwapChain Failed to get ID3D12CommandQueue from pDevice, creating Dx11 swapchain!\n');
  assert.equal((await detect.optiScalerRuntimeApi(d3d11)).api, 'dx11', 'a Feeder game has one D3D12 device too; the swapchain decides');
  const d3d12 = scratchDir('rt12');
  write(d3d12, 'OptiScaler.log', '[00:00:01.000000] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n');
  assert.equal((await detect.optiScalerRuntimeApi(d3d12)).api, 'dx12');
  const vk = scratchDir('rtvk');
  write(vk, 'OptiScaler.log', '[00:00:01.000000] [W] Vulkan is creating swapchain!\n');
  assert.equal((await detect.optiScalerRuntimeApi(vk)).api, 'vulkan');
  assert.equal(await detect.optiScalerRuntimeApi(scratchDir('rtnone')), null);
});

test('foreignToolchains recognises other DLSS 5 stacks by their marker files only', () => {
  const dir = scratchDir('foreign');
  write(dir, 'INSTALL-DLSSNR.md');
  write(dir, 'nvngx_dlssnr.dll.dlss5oneclick');
  write(dir, 'Core/dlss5-feed.addon64');
  write(dir, 'nvngx_dlssnr_proxy.dll');
  const found = detect.foreignToolchains(dir);
  assert.deepEqual(found.map((f) => f.tool).sort(), ['DLSS5oneclick', 'DLSSNR-Cost-Scaler']);
  // a Feeder placed by hand (no marker of ours) is NOT foreign: the app manages any Feeder it finds
  const own = scratchDir('ownfeeder');
  write(own, 'dlss5-feed.addon64');
  assert.deepEqual(detect.foreignToolchains(own), []);
});

test('planForeignRemoval restores a game-ownable backup, deletes a tool-only one, and never touches our payload', async () => {
  const dir = scratchDir('plan');
  write(dir, 'INSTALL-DLSSNR.md');
  write(dir, 'nvngx_dlss.dll', 'theirs');
  write(dir, 'nvngx_dlss.dll.dlss5oneclick', 'the game original');
  write(dir, 'nvngx_dlssnr.dll', 'our model');
  write(dir, 'nvngx_dlssnr.dll.dlss5oneclick', 'their backup of a tool file');
  write(dir, 'OptiScaler.ini', 'ours');
  write(dir, '.optiscaler-manager-install.json', '{}');
  const plan = await detect.planForeignRemoval(dir, { ours: false });
  assert.ok(plan.restore.some((r) => r.to === 'nvngx_dlss.dll'), 'game original comes back');
  assert.ok(plan.del.includes('nvngx_dlssnr.dll.dlss5oneclick'));
  assert.ok(!plan.del.includes('nvngx_dlssnr.dll'), 'our NR model is protected while our install is present');
  assert.ok(!plan.del.includes('OptiScaler.ini'));
});

test('a Streamline folder beside the exe counts as the game\'s DLSS unless the journal says it is ours', () => {
  const root = scratchDir('wwm');
  fs.mkdirSync(path.join(root, 'common', 'Game', 'Engine'), { recursive: true });
  const exeDir = path.join(root, 'common', 'Game', 'Engine', 'Binaries', 'Win64r');
  fakeExe(exeDir, 'wwm.exe');
  write(exeDir, 'Streamline/sl.dlss.dll', 'game');
  assert.ok(nativeDlss.shippedDlssPath(exeDir), 'found in the Streamline subfolder');
  const journaled = path.join(root, 'common', 'Other', 'Engine', 'Binaries', 'Win64r');
  fs.mkdirSync(path.join(root, 'common', 'Other', 'Engine'), { recursive: true });
  fakeExe(journaled, 'o.exe');
  write(journaled, 'streamline/sl.dlss.dll', 'ours');
  write(journaled, '.optiscaler-manager-install.json', JSON.stringify({ streamline: { dir: 'streamline', files: ['sl.dlss.dll'] } }));
  assert.equal(nativeDlss.shippedDlssPath(journaled), null, 'our own deploy is not the game\'s DLSS');
});

test('peBitness tells 32-bit from 64-bit on Windows', { skip: process.platform !== 'win32' }, async () => {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  assert.equal(await detect.peBitness(path.join(sys, 'System32', 'notepad.exe')), 64);
  const wow = path.join(sys, 'SysWOW64', 'notepad.exe');
  if (fs.existsSync(wow)) assert.equal(await detect.peBitness(wow), 32);
});

test('anti-cheat is read from the files beside the exe, and Call of Duty HQ counts as Ricochet by its exe alone', () => {
  // Each game sits under a Games folder so the climb stops there, not in the shared temp dir.
  const root = path.join(scratchDir('ac'), 'Games');
  const game = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };

  const eac = game('WithEac');
  write(eac, 'EasyAntiCheat/settings.json');
  assert.equal(detect.antiCheatPresent(eac, path.join(eac, 'Game.exe')), 'EasyAntiCheat');

  const cod = game('Call of Duty');
  assert.match(detect.antiCheatPresent(cod, path.join(cod, 'cod.exe')), /Ricochet/);

  const clean = game('Clean');
  write(clean, 'data.pak');
  assert.equal(detect.antiCheatPresent(clean, path.join(clean, 'Game.exe')), null);

  // FromSoftware ships every game as <Game Name>\Game\<exe>, and "Game" is a name the
  // library-root guard matches -- so the climb used to stop on its own first step and miss
  // EasyAntiCheat sitting right beside the exe. Confirmed on the real Elden Ring and Armored
  // Core VI installs on this machine, neither of which showed any warning.
  const fromSoft = path.join(game('ARMORED CORE VI'), 'Game');
  write(fromSoft, 'EasyAntiCheat/settings.json');
  write(fromSoft, 'start_protected_game.exe');
  assert.equal(detect.antiCheatPresent(fromSoft, path.join(fromSoft, 'armoredcore6.exe')), 'EasyAntiCheat');

  // The guard still does its job for ancestors: a loose installer parked in the library folder
  // is not evidence about a game underneath it.
  write(root, 'EasyAntiCheat_Setup.exe');
  const innocent = path.join(game('Innocent'), 'Binaries', 'Win64');
  fs.mkdirSync(innocent, { recursive: true });
  assert.equal(detect.antiCheatPresent(innocent, path.join(innocent, 'Game.exe')), null);
});

test('a 64-bit game that links only OpenGL is an OpenGL Feeder game, not unsupported', async () => {
  const dir = scratchDir('gl-detect');
  const exe = path.join(dir, 'MXBikes.exe');
  fs.writeFileSync(exe, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200), Buffer.from('opengl32.dll\0kernel32.dll\0', 'latin1')]));
  const d = await detect.detectGame(dir, exe);
  assert.equal(d.api, 'opengl');
  assert.equal(d.recommend, 'optiscaler');
  assert.match(d.reason, /opengl32\.dll/);
});

test('an anti-cheat stub is told apart from anti-cheat with no way past it', () => {
  const root = path.join(scratchDir('stub'), 'Games');
  const game = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };

  // EasyAntiCheat's own launcher: the name says nothing about which exe it fronts, and the game's
  // own exe is the one the app already has on record.
  const eac = path.join(game('ARMORED CORE VI'), 'Game');
  write(eac, 'start_protected_game.exe');
  write(eac, 'EasyAntiCheat/settings.json');
  write(eac, 'armoredcore6.exe');
  assert.deepEqual(detect.antiCheatStub(eac), { stub: 'start_protected_game.exe', antiCheat: 'EasyAntiCheat', gameExe: null });

  // BattlEye's names the exe it fronts, so the launch can be pointed at it.
  const be = game('WithBattlEye');
  write(be, 'RainbowSix_BE.exe');
  write(be, 'RainbowSix.exe');
  assert.deepEqual(detect.antiCheatStub(be), { stub: 'RainbowSix_BE.exe', antiCheat: 'BattlEye', gameExe: 'RainbowSix.exe' });

  // A _BE.exe with nothing to front is not a door this app can use: guessing would launch a file
  // that is not there.
  const orphan = game('OrphanStub');
  write(orphan, 'Something_BE.exe');
  assert.equal(detect.antiCheatStub(orphan), null);

  // Anti-cheat with no stub at all (a service or a kernel driver) stays a hard stop.
  const driver = game('WithVanguard');
  write(driver, 'vgc.exe');
  write(driver, 'vanguard/readme.txt');
  assert.equal(detect.antiCheatStub(driver), null);
  assert.match(detect.antiCheatPresent(driver, path.join(driver, 'Game.exe')), /vanguard/i);
});

test('a file this app placed itself is never evidence of another toolchain', async () => {
  // A user's DOOM 3 BFG was told to "remove the other toolchain" because INSTALL-DLSSNR.md was in
  // the folder -- a file our own installer had extracted and journaled. The removal that offers
  // lists dlss5-feed.addon64, so a false positive could take out a working Feeder route.
  const dir = scratchDir('foreign-false-positive');
  write(dir, 'INSTALL-DLSSNR.md', 'ours, from the OptiScaler_DLSSNR release');
  write(dir, '.optiscaler-manager-install.json', JSON.stringify({ added: ['INSTALL-DLSSNR.md', 'OptiScaler.ini'] }));
  assert.deepEqual(detect.foreignToolchains(dir), [], 'our own file accuses nobody');

  // The unambiguous markers still work -- the suffix no other tool uses.
  write(dir, 'nvngx_dlssnr.dll.dlss5oneclick', 'theirs');
  const found = detect.foreignToolchains(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].tool, 'DLSS5oneclick');
  assert.ok(!found[0].files.includes('INSTALL-DLSSNR.md'), 'and it is not what convicted them');
});

test('a foreign removal never takes this app\'s own Feeder stack with it', async () => {
  const dir = scratchDir('foreign-keeps-feeder');
  // Their marker, and our Feeder deploy beside it.
  write(dir, 'nvngx_dlssnr.dll.dlss5oneclick', 'theirs');
  write(dir, '.optiscaler-manager-install.json', JSON.stringify({ added: [] }));
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({ feederVersion: 'v1', mvProviderId: 'vort' }));
  for (const n of ['dlss5-feed.addon64', 'dlss5-feed.cfg', 'ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini']) write(dir, n);
  write(dir, 'reshade-shaders/Shaders/DLSS5_Feed.fx');

  const plan = await detect.planForeignRemoval(dir, { ours: true });
  assert.ok(plan.found.length, 'their marker is still recognised');
  for (const kept of ['dlss5-feed.addon64', 'dlss5-feed.cfg', 'ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'reshade-shaders']) {
    assert.ok(!plan.del.includes(kept), `${kept} is ours and must survive`);
  }
  assert.ok(plan.del.includes('nvngx_dlssnr.dll.dlss5oneclick'), 'theirs still goes');
});

test('an OptiScaler under a proxy name is recognised, and told apart from ours by its file', { skip: !onWindows }, async () => {
  // A user's DOOM 3 BFG: an upstream OptiScaler as winmm.dll beside our install. That copy is the
  // one the game loads, it has no neural pass, and every other check said the route was complete.
  const dir = scratchDir('other-optiscaler');
  const ourDll = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096), Buffer.from('OptiScaler', 'latin1')]);
  fs.writeFileSync(path.join(dir, 'OptiScaler.dll'), ourDll);
  // Theirs: an OptiScaler too, but a different build, so a different size.
  fs.writeFileSync(path.join(dir, 'winmm.dll'), Buffer.concat([ourDll, Buffer.alloc(64)]));
  const hooks = await detect.inspectHookDlls(dir);
  assert.equal(hooks.optiScalerProxy.file, 'winmm.dll');
  assert.equal(hooks.optiScalerProxy.matchesOurBuild, false, 'a different build from the one we installed');

  const diag = diagnose({
    detected: { bitness: 64, optiScalerProxy: hooks.optiScalerProxy },
    route: { route: 'feeder', optiInstalled: true, feederDeployed: true },
    run: { ran: false, verdict: 'no-log' },
  });
  assert.equal(diag.code, 'foreign-optiscaler');
  assert.equal(diag.vars.file, 'winmm.dll');

  // Our own proxy, same bytes, is not a finding.
  fs.copyFileSync(path.join(dir, 'OptiScaler.dll'), path.join(dir, 'dxgi.dll'));
  fs.rmSync(path.join(dir, 'winmm.dll'));
  const mine = await detect.inspectHookDlls(dir);
  assert.equal(mine.optiScalerProxy.matchesOurBuild, true, 'our own install is not an intruder');
});
