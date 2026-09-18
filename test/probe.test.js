// Watched launch (src/probe.js): the parser on two recorded traces, the API rules on module lists,
// the precedence against static detection and OptiScaler's log, the proxy hint, the store, and the
// runner driven with a fake launcher, poller and closer. No game is launched.
//
// The two fixtures are real captures from the dev machine (2026-09-18) of a self-made "game": two
// copies of node.exe, FakeGame\Launcher.exe starting FakeGame\Binaries\Game.exe and exiting, the
// game loading a winmm.dll copy from its own folder and d3d11.dll/dxgi.dll from System32. The ETW
// one is tracerpt's XML trimmed to those processes plus three unrelated image loads; the poll one is
// the PowerShell poller's own output. Paths were rewritten to C:\Games / D:\Games.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const probe = require('../src/probe');
const { scratchDir, write } = require('./helpers');

const FIX = path.join(__dirname, 'fixtures', 'probe');
const etwXml = () => fs.readFileSync(path.join(FIX, 'etw-fakegame.xml'));
const pollLines = () => fs.readFileSync(path.join(FIX, 'poll-fakegame.jsonl'), 'utf8').split('\n').filter(Boolean);

test('the ETW trace: the launcher hands off to the game, and its proxy load is seen coming from the game folder', () => {
  const trace = probe.parseEtwXml(etwXml());
  const facts = probe.analyzeTrace(trace, { exePath: 'C:\\Games\\FakeGame\\Launcher.exe', folderFiles: [] });
  assert.equal(facts.method, 'etw');
  assert.equal(facts.processes.length, 2, 'the three unrelated image loads belong to no game process');
  assert.equal(facts.realExe, 'C:\\Games\\FakeGame\\Binaries\\Game.exe');
  assert.equal(facts.handoff, true);
  assert.deepEqual(facts.chain.map((c) => path.win32.basename(c.exe)), ['Launcher.exe', 'Game.exe']);
  assert.equal(facts.chain[0].exitCode, 0, 'the launcher exited cleanly after the hand-off');
  // The game loaded d3d11.dll from System32, and no Direct3D driver (node never creates a device).
  assert.equal(facts.api, 'dx11');
  assert.equal(facts.apiUncertain, true);
  const byName = Object.fromEntries(facts.proxies.map((p) => [p.name, p]));
  assert.equal(byName['winmm.dll'].from, 'game');
  assert.equal(byName['winmm.dll'].path, 'C:\\Games\\FakeGame\\Binaries\\winmm.dll');
  assert.equal(byName['d3d11.dll'].from, 'system');
  assert.equal(byName['dxgi.dll'].from, 'system');
  assert.ok(byName['winmm.dll'].order < byName['d3d11.dll'].order, 'load order is kept');
  assert.deepEqual(facts.gameFolderDlls, ['C:\\Games\\FakeGame\\Binaries\\winmm.dll']);
});

test('the poll trace gives the same hand-off and proxy, with nothing of the API it did not see', () => {
  const facts = probe.analyzeTrace(probe.collectPoll(pollLines()), { exePath: 'D:\\Games\\FakeGame\\Launcher.exe', method: 'poll' });
  assert.equal(facts.method, 'poll');
  assert.equal(facts.realExe, 'D:\\Games\\FakeGame\\Binaries\\Game.exe', 'the survivor is the game when no API was seen');
  assert.equal(facts.handoff, true);
  // node.exe dlopen()s d3d11.dll, finds no addon in it and unloads it again -- between two polls.
  // That is exactly what the poller misses and ETW does not.
  assert.equal(facts.api, null);
  assert.equal(facts.proxies.find((p) => p.name === 'winmm.dll').from, 'game');
});

test('a proxy that sits in the folder but was loaded from System32 is reported as ignored (the RDR2 shape)', () => {
  const trace = {
    processes: [{ pid: 10, ppid: 1, image: 'D:\\Games\\RDR2\\RDR2.exe' }],
    loads: [
      'D:\\Games\\RDR2\\RDR2.exe', 'C:\\Windows\\System32\\winmm.dll', 'C:\\Windows\\System32\\dxgi.dll',
      'C:\\Windows\\System32\\d3d12.dll', 'C:\\Windows\\System32\\D3D12Core.dll', 'C:\\Windows\\System32\\DriverStore\\FileRepository\\nv\\nvwgf2umx.dll',
    ].map((image, seq) => ({ pid: 10, image, seq })),
  };
  const facts = probe.analyzeTrace(trace, { exePath: 'D:\\Games\\RDR2\\RDR2.exe', folderFiles: ['dxgi.dll', 'optiscaler.ini'] });
  assert.equal(facts.api, 'dx12');
  assert.equal(facts.handoff, false);
  assert.deepEqual(facts.ignoredProxies, ['dxgi.dll']);
  assert.equal(probe.proxyHint(facts), 'winmm.dll');
});

test('the API rules: a device, not a link', () => {
  const api = (names, opts) => probe.apiFromModules(names.map((n) => ({ image: n.includes('\\') ? n : `C:\\Windows\\System32\\${n}` })), opts).api;
  // Unreal's D3D11 renderer imports d3d9.dll for D3DPERF markers; no D3D9 driver, so not DX9.
  assert.equal(api(['d3d9.dll', 'd3d11.dll', 'dxgi.dll', 'nvwgf2umx.dll']), 'dx11');
  // A real D3D9 device loads NVIDIA's D3D9 driver; a video player's d3d11 later is not the renderer.
  assert.equal(api(['d3d9.dll', 'nvd3dumx.dll', 'd3d11.dll']), 'dx9');
  assert.equal(api(['d3d11.dll', 'd3d12.dll', 'dxgi.dll', 'D3D12Core.dll', 'nvwgf2umx.dll']), 'dx12');
  assert.equal(api(['d3d11.dll', 'd3d12.dll', 'dxgi.dll', 'nvwgf2umx.dll']), 'dx11', 'd3d12.dll linked but never used');
  assert.equal(api(['vulkan-1.dll', 'nvoglv64.dll', 'd3d11.dll']), 'vulkan');
  assert.equal(api(['opengl32.dll', 'nvoglv64.dll']), 'opengl');
  // dgVoodoo2 as the game's d3d9.dll: the game asked for D3D9, whatever dgVoodoo turns it into.
  assert.equal(api(['D:\\Games\\AC2\\d3d9.dll', 'd3d11.dll', 'nvwgf2um.dll'], { gameDir: 'D:\\Games\\AC2' }), 'dx9');
  // A Steam overlay-style late d3d9 load after a DX12 device changes nothing.
  assert.equal(api(['d3d12.dll', 'D3D12Core.dll', 'd3d9.dll']), 'dx12');
  assert.equal(api(['kernel32.dll']), null);
});

test('anti-cheat and overlays are named from the modules and processes seen', () => {
  const trace = {
    processes: [{ pid: 1, ppid: 0, image: 'D:\\G\\start_protected_game.exe' }, { pid: 2, ppid: 1, image: 'D:\\G\\Game.exe' }],
    loads: [
      { pid: 2, image: 'D:\\G\\Game.exe', seq: 0 }, { pid: 2, image: 'C:\\Windows\\System32\\d3d11.dll', seq: 1 },
      { pid: 2, image: 'C:\\Program Files (x86)\\RivaTuner Statistics Server\\RTSSHooks64.dll', seq: 2 },
      { pid: 2, image: 'D:\\G\\EasyAntiCheat\\EasyAntiCheat_x64.dll', seq: 3 },
    ],
  };
  const facts = probe.analyzeTrace(trace, { exePath: 'D:\\G\\start_protected_game.exe' });
  assert.deepEqual(facts.antiCheat, ['EasyAntiCheat']);
  assert.deepEqual(facts.overlays, ['RivaTuner Statistics Server']);
  assert.equal(facts.realExe, 'D:\\G\\Game.exe');
});

test('the game root takes in a launcher above an Unreal Binaries tree and a Steam library folder', () => {
  assert.equal(probe.gameRootFor('D:\\SteamLibrary\\steamapps\\common\\Space Marine 2\\client_pc\\root\\bin\\pc_dx12\\Warhammer 40000 Space Marine 2 - Retail.exe'),
    'D:\\SteamLibrary\\steamapps\\common\\Space Marine 2');
  assert.equal(probe.gameRootFor('E:\\Games\\Stray\\Hk_project\\Binaries\\Win64\\Stray-Win64-Shipping.exe'), 'E:\\Games\\Stray');
  assert.equal(probe.gameRootFor('E:\\Games\\Old\\game.exe'), 'E:\\Games\\Old');
});

// ── Precedence ─────────────────────────────────────────────────────────────────────────────────────
const facts = (over = {}) => ({ version: probe.PROBE_VERSION, capturedAt: '2026-09-18T10:00:00.000Z', api: 'dx12', apiEvidence: 'D3D12Core.dll loaded', apiUncertain: false, started: true, ...over });

test('precedence: fresh probe facts beat static detection', () => {
  const detected = { api: 'dx11', apis: ['dx11', 'dx12'], recommend: 'optiscaler', bitness: 64, uncertain: true };
  const out = probe.applyProbe(detected, facts());
  assert.equal(out.api, 'dx12');
  assert.deepEqual(out.apis, ['dx12', 'dx11']);
  assert.equal(out.staticApi, 'dx11');
  assert.equal(out.probeApi, 'dx12');
  assert.equal(out.uncertain, false);
  assert.equal(out.probe.applied, true);
});

test('precedence: OptiScaler\'s log wins only when it is newer than the probe', () => {
  const base = { api: 'dx11', apis: ['dx11', 'dx12'], runtimeApi: 'dx11', bitness: 64 };
  const older = probe.applyProbe({ ...base, runtimeLogMtime: Date.parse('2026-09-17T10:00:00Z') }, facts());
  assert.equal(older.api, 'dx12', 'the probe is the newer observation');
  const newer = probe.applyProbe({ ...base, runtimeLogMtime: Date.parse('2026-09-18T12:00:00Z') }, facts());
  assert.equal(newer.api, 'dx11');
  assert.equal(newer.probe.applied, false);
  assert.equal(newer.probe.why, 'optiscaler-log-newer');
});

test('precedence: an API chosen in Edit still wins over the probe', () => {
  const { withApiOverride } = require('../src/route');
  const detected = probe.applyProbe({ api: 'dx11', apis: ['dx11', 'dx12'], bitness: 64 }, facts());
  assert.equal(withApiOverride(detected, 'dx11').api, 'dx11');
});

test('precedence: a probe that saw DX11 on a DX11/DX12 game keeps it on DX11, like a DX11 runtime log does', () => {
  const { withApiOverride } = require('../src/route');
  const detected = probe.applyProbe({ api: 'dx12', apis: ['dx12', 'dx11'], bitness: 64 }, facts({ api: 'dx11', apiEvidence: 'd3d11.dll loaded' }));
  assert.equal(withApiOverride(detected, null).api, 'dx11');
});

test('precedence: a player-placed DXVK and an emulator profile keep the static answer', () => {
  const dxvk = probe.applyProbe({ api: 'vulkan', apis: ['vulkan', 'dx9'], vulkanWrapper: { file: 'd3d9.dll', kind: 'DXVK' }, translatedBy: null }, facts({ api: 'dx9' }));
  assert.equal(dxvk.api, 'vulkan');
  assert.equal(dxvk.probe.why, 'player-wrapper');
  const emu = probe.applyProbe({ api: 'vulkan', emulator: { apis: ['vulkan', 'opengl'] } }, facts({ api: 'dx12' }));
  assert.equal(emu.api, 'vulkan');
});

test('a probe that sees DirectX 9 on a 64-bit game puts it on the legacy route; DX8 on 64-bit is unsupported', () => {
  const dx9 = probe.applyProbe({ api: 'dx11', apis: ['dx11'], bitness: 64, recommend: 'optiscaler' }, facts({ api: 'dx9' }));
  assert.equal(dx9.api, 'dx9');
  assert.equal(dx9.legacy, true);
  assert.deepEqual(dx9.legacyApis, ['dx9']);
  assert.equal(dx9.recommend, 'optiscaler');
  const dx8 = probe.applyProbe({ api: null, apis: [], bitness: 64, recommend: 'unknown' }, facts({ api: 'dx8' }));
  assert.equal(dx8.recommend, 'unsupported');
  const vk32 = probe.applyProbe({ api: 'dx11', apis: ['dx11'], bitness: 32 }, facts({ api: 'vulkan' }));
  assert.equal(vk32.recommend, 'unsupported');
});

test('no facts, or facts without an API, change nothing about the API', () => {
  const d = { api: 'dx11', apis: ['dx11'] };
  assert.equal(probe.applyProbe(d, null), d);
  assert.equal(probe.applyProbe(d, facts({ api: null })).api, 'dx11');
});

test('proxy hint: dxgi.dll is fine when the game loaded it; otherwise the earliest early-loading name', () => {
  const f = (proxies, ignored = []) => ({ started: true, moduleCount: 50, proxies, ignoredProxies: ignored });
  assert.equal(probe.proxyHint(f([{ name: 'winmm.dll', order: 3 }, { name: 'dxgi.dll', order: 9 }])), null);
  assert.equal(probe.proxyHint(f([{ name: 'version.dll', order: 7 }, { name: 'winmm.dll', order: 3 }])), 'winmm.dll');
  assert.equal(probe.proxyHint(f([{ name: 'dxgi.dll', order: 2 }, { name: 'version.dll', order: 5 }], ['dxgi.dll'])), 'version.dll');
  assert.equal(probe.proxyHint(null), null);
  assert.equal(probe.proxyHint({ started: false, proxies: [] }), null, 'a probe that never saw the game says nothing');
});

// ── Store ─────────────────────────────────────────────────────────────────────────────────────────
test('facts are stored per exe and expire when the exe changes', () => {
  const dir = scratchDir('probe-store');
  const exe = write(dir, 'Game/Game.exe', 'MZ one');
  const store = path.join(dir, 'userData', '.dlss5ui-probe.json');
  probe.writeFacts(store, exe, facts());
  assert.equal(probe.freshFacts(store, exe).api, 'dx12');
  assert.equal(probe.freshFacts(store, exe.toUpperCase().replace('GAME.EXE', 'Game.exe'), { stamp: probe.exeStamp(exe) }).api, 'dx12', 'keyed case-insensitively');
  fs.writeFileSync(exe, 'MZ patched, a different size');
  assert.equal(probe.freshFacts(store, exe), null, 'a game update expires the facts');
  probe.writeFacts(store, exe, facts({ version: 0 }));
  assert.equal(probe.freshFacts(store, exe), null, 'facts from an older probe format are not used');
});

// ── Runner ────────────────────────────────────────────────────────────────────────────────────────
function fakePoller(lines) {
  return ({ onTick }) => {
    // Ticks arrive at once: the runner's clock is fake, so the whole window passes in microtasks.
    for (const l of lines) if (onTick) onTick(JSON.parse(l));
    return { done: Promise.resolve(lines), stop: () => {} };
  };
}

test('the runner falls back to polling when ETW cannot start, launches once, closes what it saw and stores nothing itself', async () => {
  const work = scratchDir('probe-run');
  const exePath = path.join(work, 'FakeGame', 'Launcher.exe');
  write(work, 'FakeGame/Launcher.exe', 'MZ');
  const lines = pollLines().map((l) => l.split('D:\\\\Games\\\\FakeGame').join(JSON.stringify(path.join(work, 'FakeGame')).slice(1, -1)));
  let launches = 0;
  let closedPids = null;
  const progress = [];
  let clock = 0;
  const res = await probe.runProbe({
    exePath, seconds: 2, workDir: path.join(work, 'tmp'),
    execFileAsync: async (file) => { if (file === 'logman.exe') throw Object.assign(new Error('Access is denied.'), { stdout: 'Error: Access is denied.' }); return { stdout: '' }; },
    launch: async () => { launches++; return { ok: true, via: 'exe' }; },
    startPollerImpl: fakePoller(lines),
    closeTreeImpl: async (pids) => { closedPids = pids; return { asked: 1, killed: 0 }; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onProgress: (p) => progress.push(p.phase),
  });
  assert.equal(res.ok, true);
  assert.equal(launches, 1);
  assert.equal(res.facts.method, 'poll');
  assert.match(res.etwError, /Access is denied/);
  assert.equal(res.facts.handoff, true);
  assert.ok(closedPids.length >= 1, 'every process of the tree that was seen is closed');
  assert.deepEqual([...new Set(progress)], ['launching', 'watching', 'closing']);
});

test('the runner stops cleanly when the launch is cancelled (the anti-cheat question answered no)', async () => {
  const work = scratchDir('probe-cancel');
  const exePath = write(work, 'G/Game.exe', 'MZ');
  const calls = [];
  const res = await probe.runProbe({
    exePath, seconds: 1, workDir: path.join(work, 'tmp'),
    execFileAsync: async (file, args) => { calls.push(`${file} ${args[0]}`); return { stdout: '' }; },
    launch: async () => ({ ok: true, cancelled: true }),
    startPollerImpl: fakePoller([]),
    closeTreeImpl: async () => { throw new Error('nothing to close'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.ok(calls.includes('logman.exe stop'), 'an ETW session that was started is stopped again');
});
