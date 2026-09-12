'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const detect = require(path.join(REPO, 'src', 'detect'));
const nativeDlss = require(path.join(REPO, 'src', 'native-dlss'));

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
});
