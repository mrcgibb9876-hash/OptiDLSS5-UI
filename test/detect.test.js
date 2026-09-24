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

test('resolveUnrealShippingExe swaps a Saber root launcher for client_pc\\root\\bin\\pc (#77)', () => {
  const root = scratchDir('saber');
  write(root, 'Warhammer 40000 Space Marine 2.exe', 'launcher');
  write(root, 'client_pc/root/bin/pc/Warhammer 40000 Space Marine 2 - Retail.exe', 'client');
  write(root, 'client_pc/root/bin/pc/crash_reporter.exe', 'x');
  const client = path.join(root, 'client_pc', 'root', 'bin', 'pc', 'Warhammer 40000 Space Marine 2 - Retail.exe');
  assert.equal(detect.resolveUnrealShippingExe(path.join(root, 'Warhammer 40000 Space Marine 2.exe')), client);
  // the client itself, picked directly, stays as picked
  assert.equal(detect.resolveUnrealShippingExe(client), client);
  // a client folder holding only the crash reporter resolves nothing
  const lone = scratchDir('saber-lone');
  write(lone, 'Game.exe', 'launcher');
  write(lone, 'client_pc/root/bin/pc/crash_reporter.exe', 'x');
  assert.equal(detect.resolveUnrealShippingExe(path.join(lone, 'Game.exe')), path.join(lone, 'Game.exe'));
});

test('optiScalerRuntimeApi reads the swapchain the game really created', async () => {
  const d3d11 = scratchDir('rt11');
  write(d3d11, 'OptiScaler.log', '[00:00:01.000000] [I] hkD3D11CreateDeviceAndSwapChain Device captured\n[00:00:01.000001] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n[00:00:02.000000] [I] DxgiFactoryHooks::CreateSwapChain Failed to get ID3D12CommandQueue from pDevice, creating Dx11 swapchain!\n');
  assert.equal((await detect.optiScalerRuntimeApi(d3d11)).api, 'dx11', 'a Feeder game has one D3D12 device too; the swapchain decides');
  const d3d12 = scratchDir('rt12');
  write(d3d12, 'OptiScaler.log', '[00:00:01.000000] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n');
  assert.equal((await detect.optiScalerRuntimeApi(d3d12)).api, 'dx12');
  // Shadow of the Tomb Raider: a throwaway D3D11 device at startup, then D3D12 -- and no D3D11 swapchain.
  const sottr = scratchDir('rt12with11');
  write(sottr, 'OptiScaler.log', '[21:37:49.654079] [I] hkD3D11CreateDevice Device captured\n[21:37:52.726083] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n');
  assert.equal((await detect.optiScalerRuntimeApi(sottr)).api, 'dx12', 'a D3D11 device that made no swapchain is not the renderer');
  const only11 = scratchDir('rt11dev');
  write(only11, 'OptiScaler.log', '[00:00:01.000000] [I] hkD3D11CreateDevice Device captured\n');
  assert.equal((await detect.optiScalerRuntimeApi(only11)).api, 'dx11');
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

test('foreignToolchains sees the DLSS 5 Bridge, the transport under a neural add-on', async () => {
  // The Bridge (NIGos/dlss5-bridge) mirrors a game's own D3D11/Vulkan DLSS into a private D3D12
  // session for a neural add-on. Its consumer is usually renodx-dlss5, which was already caught --
  // so the folder got a verdict naming the add-on and nothing about the transport under it.
  const both = scratchDir('bridge-with-renodx');
  write(both, 'dlss5-bridge.addon64');
  write(both, 'renodx-dlss5.addon64');
  const tools = detect.foreignToolchains(both).map((f) => f.tool);
  assert.ok(tools.includes('DLSS 5 Bridge'));
  assert.ok(tools.includes('a RenoDX DLSS 5 add-on'));
  // NOTE, not an endorsement: 'DLSS5-Swapper' also reports here, because its marker list carries
  // the bare renodx-dlss5.addon64 -- a filename it shares with every other stack that ships that
  // add-on, including this one. That is the same shape as the DOOM 3 BFG mis-attribution the
  // FOREIGN_TOOLCHAINS comment describes, and its real marker (_DLSS5_Backup/manifest.json) is
  // sitting right there in the same entry. Left alone here rather than widened into this change.
  assert.ok(tools.includes('DLSS5-Swapper'), 'documents today\'s behaviour, see the note above');

  // The case that reported nothing at all before: a Bridge with no RenoDX beside it (its own
  // add-on removed, or a different consumer such as NapXDD's Linux one).
  const alone = scratchDir('bridge-alone');
  write(alone, 'dlss5-bridge.addon64');
  assert.deepEqual(detect.foreignToolchains(alone).map((f) => f.tool), ['DLSS 5 Bridge']);

  // ... and a folder it has only ever RUN in: the add-on is gone, its own two files remain.
  const ran = scratchDir('bridge-ran');
  write(ran, 'dlss5-bridge.cfg', 'vk_mirror=1\n');
  write(ran, 'dlss5-bridge.log', '[bridge] ...\n');
  assert.deepEqual(detect.foreignToolchains(ran).map((f) => f.tool), ['DLSS 5 Bridge']);

  // Remove offers its three files and nothing of the game's -- it patches and backs up nothing.
  const plan = await detect.planForeignRemoval(alone);
  assert.deepEqual(plan.del, ['dlss5-bridge.addon64']);
  assert.deepEqual(plan.restore, []);

  // A name that merely starts the same way is not it: markers here are exact.
  const near = scratchDir('bridge-near');
  write(near, 'dlss5-bridge-notes.txt');
  assert.deepEqual(detect.foreignToolchains(near), []);
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

// Two players' bundles (2026-09-15): games under "D:\GAMES 2TB\" had the whole D: drive searched, another
// game's nvngx_dlss.dll found, and a DLSS-less OpenGL game routed as "ships its own DLSS".
test('a library folder the app does not know never makes the drive root the install root', { skip: process.platform !== 'win32' }, () => {
  const exeDir = 'D:\\GAMES 2TB\\Tomb Raider 1-3 Remastered';
  assert.equal(nativeDlss.installRoot(exeDir), path.resolve(exeDir));
  assert.equal(nativeDlss.installRoot('D:\\Game'), path.resolve('D:\\Game'));
  assert.equal(nativeDlss.installRoot('C:\\Program Files (x86)\\Steam\\steamapps\\common\\ELDEN RING\\Game'),
    path.resolve('C:\\Program Files (x86)\\Steam\\steamapps\\common\\ELDEN RING'), 'a known games folder still sets the root');
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

  // GTA V: skipping the stub skips Rockstar's launcher sign-in too, so its own -nobattleye switch on
  // the normal launch is the door.
  const gta = game('Grand Theft Auto V');
  for (const f of ['GTA5_BE.exe', 'GTA5.exe', 'PlayGTAV.exe']) write(gta, f);
  assert.deepEqual(detect.antiCheatStub(gta), {
    stub: 'GTA5_BE.exe', antiCheat: 'BattlEye', gameExe: 'GTA5.exe', launch: { exe: 'PlayGTAV.exe', args: ['-nobattleye'] },
  });

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

test('the shape a real install leaves: no OptiScaler.dll, the journal names the proxy', { skip: !onWindows }, async () => {
  // installProxy RENAMES OptiScaler.dll into the slot, so a finished install has no OptiScaler.dll
  // to measure. Comparing sizes against a file that is never there made every install look like
  // somebody else's build. The journal says which proxy this app made; that is the authority.
  const dir = scratchDir('installed-shape');
  const dll = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096), Buffer.from('OptiScaler', 'latin1')]);
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), dll);
  fs.writeFileSync(path.join(dir, '.optiscaler-manager-install.json'), JSON.stringify({ proxy: 'dxgi.dll', added: ['OptiScaler.dll'] }));
  const clean = await detect.inspectHookDlls(dir);
  assert.equal(clean.optiScalerProxy.file, 'dxgi.dll');
  assert.equal(clean.optiScalerProxy.matchesOurBuild, true, 'the proxy the journal names is ours');
  assert.equal(diagnose({
    detected: { bitness: 64, optiScalerProxy: clean.optiScalerProxy },
    route: { route: 'feeder', optiInstalled: true, feederDeployed: true },
    run: { ran: false, verdict: 'no-log' },
  }).code, 'needs-run', 'a normal install is never accused');

  // Now somebody else's build behind ours. dxgi.dll is scanned first and is ours, so the one that
  // matters is only found by looking past it -- the DOOM 3 BFG shape exactly.
  fs.writeFileSync(path.join(dir, 'winmm.dll'), Buffer.concat([dll, Buffer.alloc(64)]));
  const both = await detect.inspectHookDlls(dir);
  assert.equal(both.optiScalerProxy.file, 'winmm.dll', 'the one that is not ours is the one reported');
  assert.equal(both.optiScalerProxy.matchesOurBuild, false);
});

// Deep Fried Chicken is another neural add-on, not a rival installer -- but its clash with ours is
// silent. Its documentation says never to run two, and that when it finds a competitor it does
// nothing at all for the whole session. Without this the user gets a successful install, a panel
// that opens, and no picture change ever, with nothing saying why.
test('Deep Fried Chicken is recognised, and removal takes only its own files', () => {
  const dir = scratchDir('foreign-dfc');
  write(dir, 'Game.exe', 'x');
  write(dir, 'deep-fried-chicken.addon64', 'x');
  write(dir, 'deep-fried-chicken-nvngx.dll', 'x');
  write(dir, 'deep-fried-chicken.cfg', 'x');

  assert.deepEqual(detect.foreignToolchains(dir).map((f) => f.tool), ['Deep Fried Chicken']);

  return detect.planForeignRemoval(dir).then((plan) => {
    assert.deepEqual(plan.del, ['deep-fried-chicken-nvngx.dll', 'deep-fried-chicken.addon64', 'deep-fried-chicken.cfg']);
    // The game's own files are never in a foreign removal.
    assert.ok(!plan.del.includes('Game.exe'));
  });
});

test('a folder with our install and no other add-on accuses nobody of being Deep Fried Chicken', () => {
  const dir = scratchDir('foreign-dfc-clean');
  write(dir, 'Game.exe', 'x');
  write(dir, 'OptiScaler.ini', 'x');
  write(dir, 'nvngx_dlssnr.dll', 'x');
  assert.deepEqual(detect.foreignToolchains(dir), []);
});

test('an API the executable imports beats one it only mentions', async () => {
  // GTA V Legacy was reported as DX12 (2026-09-16). It is a DX10/11 game -- the DX12 one is
  // Enhanced, a separate executable -- but apisFromEvidence counts a DLL name found anywhere in the
  // binary as evidence, which is deliberate (a renderer loaded with LoadLibrary is named nowhere
  // else) and meant every stray mention of d3d12.dll weighed the same as a real import. MODERN_APIS
  // puts dx12 first, so the mention won.
  const linked = (...names) => names;

  // The reported shape: imports d3d11, mentions d3d12.
  assert.equal(detect.pickModern(new Set(['dx12', 'dx11']), linked('d3d11.dll', 'kernel32.dll')), 'dx11');

  // A game that genuinely imports both still resolves to dx12, exactly as before.
  assert.equal(detect.pickModern(new Set(['dx12', 'dx11']), linked('d3d11.dll', 'd3d12.dll')), 'dx12');

  // Nothing linked at all: the old behaviour stands, since a mention is all there is to go on.
  assert.equal(detect.pickModern(new Set(['dx12', 'dx11']), linked('kernel32.dll')), 'dx12');

  // Vulkan keeps its own rule -- linked, and no Direct3D linked beside it.
  assert.equal(detect.pickModern(new Set(['vulkan', 'dx12']), linked('vulkan-1.dll')), 'vulkan');
  assert.equal(detect.pickModern(new Set(['vulkan', 'dx12']), linked('vulkan-1.dll', 'd3d12.dll')), 'dx12');

  assert.equal(detect.pickModern(new Set(), linked('kernel32.dll')), null);
});
