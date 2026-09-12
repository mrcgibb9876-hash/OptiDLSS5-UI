'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain } = require('./helpers');
const verified = require(path.join(REPO, 'src', 'verified'));
const route = require(path.join(REPO, 'src', 'route'));

test('the registry matches by exe name or by Unreal project folder, and only dated entries verify', () => {
  assert.equal(verified.lookup('D:/g/SwGame/Binaries/Win64/starwarsjedifallenorder.exe').id, 'star-wars-jedi-fallen-order');
  assert.equal(verified.lookup('D:/g/SwGame/Binaries/Win64/anything.exe').id, 'star-wars-jedi-fallen-order', 'project folder wins');
  assert.equal(verified.defaultRoute('D:/g/SwGame/Binaries/Win64/x.exe'), 'lumaue');
  assert.equal(verified.knownBad('D:/g/Spyro/Binaries/Win64/Spyro-Win64-Shipping.exe', 'lumaue') !== null, true);
  assert.equal(verified.verification('D:/g/Spyro/Binaries/Win64/Spyro-Win64-Shipping.exe'), null, 'no date, no tick');
  assert.equal(verified.verification('C:/x/BatmanAK.exe').route, 'feeder');
  assert.equal(verified.lookup('C:/x/unknown.exe'), null);
});

test('every registry entry is well formed', () => {
  for (const g of verified.registry.games) {
    assert.ok(g.id && g.name && g.match && g.route, g.id);
    assert.ok(['optiscaler', 'feeder', 'lumaue'].includes(g.route), g.id + ' route');
    assert.ok(g.verified === null || /^\d{4}-\d{2}-\d{2}$/.test(g.verified), g.id + ' date');
    for (const exe of g.match.exe || []) assert.equal(exe, exe.toLowerCase(), g.id + ' exe names are lower-case');
  }
});

test('the route carries the verification so the card can show the tick', () => {
  const dir = scratchDir('verified-route');
  const exe = fakeExe(path.join(dir, 'SwGame', 'Binaries', 'Win64'), 'SwGame-Win64-Shipping.exe');
  const r = route.recommendRoute(path.dirname(exe), exe, { engineId: 'unreal', engine: 'Unreal Engine 4.21', api: 'dx11' }, 'nvidia');
  assert.equal(r.route, 'lumaue');
  assert.equal(r.verified.route, 'lumaue');
  assert.match(r.verified.verified, /^\d{4}-/);
});

test('the Remove preview names what the real Remove then takes', { skip: process.platform !== 'win32' }, async () => {
  const base = scratchDir('plan');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  write(game, 'game.pak', 'not ours');
  const { invoke } = loadMain();
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(inst.ok, true, inst.error);
  const plan = await invoke('game:uninstallPlan', exe);
  assert.equal(plan.ok, true);
  for (const n of ['dxgi.dll', 'OptiScaler.ini', 'nvngx_dlssnr.dll', 'OptiScaler', '.optiscaler-manager-install.json']) assert.ok(plan.remove.includes(n), n + ' in the preview');
  assert.ok(!plan.remove.includes('game.pak'));
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  const left = fs.readdirSync(game);
  for (const n of plan.remove) assert.ok(!left.includes(n.split('/')[0]) || n.includes('/'), n + ' was removed as previewed');
  assert.deepEqual(left.sort(), ['Game.exe', 'game.pak']);
});
