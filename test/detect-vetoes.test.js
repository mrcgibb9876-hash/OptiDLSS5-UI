// What an executable's own build says it cannot be using (detect.js peBuildFacts/apiVetoes), and every
// place that now listens to it: static detection, OptiScaler's log, a watched launch, and the probe's
// renderer pick, which used to crown our own 64-bit helper. The Godfather II (32-bit Direct3D 9, 2009)
// came out as DX12 (2026-09-19) and its player could not even choose DX9 in Edit.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, scratchDir, write } = require('./helpers');
const detect = require(path.join(REPO, 'src', 'detect'));
const probe = require(path.join(REPO, 'src', 'probe'));
const { withApiOverride, API_OVERRIDE_VALUES } = require(path.join(REPO, 'src', 'route'));

// A minimal PE: DOS header (with a Rich marker in the stub when msvc), COFF header, an optional header
// with empty data directories, no sections, and whatever strings the body should carry.
function fakePe(file, { bits = 32, linked = '2009-02-01', linker = 9, msvc = true, strings = [] } = {}) {
  const pe = 0x80;
  const optSize = bits === 64 ? 240 : 224;
  const buf = Buffer.alloc(0x400);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(pe, 60);
  if (msvc) buf.write('Rich', 0x70, 'latin1');
  buf.writeUInt32LE(0x4550, pe);
  buf.writeUInt16LE(bits === 64 ? 0x8664 : 0x14c, pe + 4);
  buf.writeUInt16LE(0, pe + 6);
  buf.writeUInt32LE(Math.floor(Date.parse(linked + 'T00:00:00Z') / 1000), pe + 8);
  buf.writeUInt16LE(optSize, pe + 20);
  buf.writeUInt16LE(bits === 64 ? 0x20b : 0x10b, pe + 24);
  buf.writeUInt8(linker, pe + 26);
  buf.writeUInt32LE(16, pe + 24 + (bits === 64 ? 108 : 92));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([buf, Buffer.from(strings.join('\0') + '\0', 'latin1')]));
  return file;
}

test('build facts: link date, linker, the Rich header', async () => {
  const dir = scratchDir('vetoes-facts');
  const b = await detect.peBuildFacts(fakePe(path.join(dir, 'Old.exe')));
  assert.deepEqual(b, { linkTime: '2009-02-01', linker: 9, msvc: true, repro: false });
  const mingw = await detect.peBuildFacts(fakePe(path.join(dir, 'Mingw.exe'), { msvc: false, linker: 2, linked: '2021-05-01' }));
  assert.equal(mingw.msvc, false);
  assert.equal(await detect.peBuildFacts(write(dir, 'not.exe', 'hello')), null);
});

test('vetoes: what an old build rules out, and nothing for a modern one', () => {
  const old = detect.apiVetoes({ linkTime: '2009-02-01', linker: 9, msvc: true }, { bitness: 32, imports: [] });
  assert.ok(old.dx12 && old.vulkan);
  assert.equal(old.dx11, undefined, 'D3D11 existed in 2009');
  assert.ok(detect.apiVetoes({ linkTime: '2007-01-01', linker: 8, msvc: true }).dx11);
  // An untrusted date (a /Brepro hash) leaves only the linker to go on.
  assert.ok(detect.apiVetoes({ linkTime: null, linker: 12, msvc: true }, { bitness: 64 }).dx12);
  // A non-MSVC linker's version says nothing about D3D12.
  assert.deepEqual(detect.apiVetoes({ linkTime: null, linker: 2, msvc: false }, { bitness: 64 }), {});
  assert.deepEqual(detect.apiVetoes({ linkTime: '2023-07-05', linker: 14, msvc: true }, { bitness: 64, imports: ['d3d12.dll'] }), {});
  // A modern 32-bit exe: DX12 only when it imports d3d12.dll itself; unknown imports rule out nothing.
  assert.ok(detect.apiVetoes({ linkTime: '2020-01-01', linker: 14, msvc: true }, { bitness: 32, imports: ['d3d11.dll'] }).dx12);
  assert.equal(detect.apiVetoes({ linkTime: '2020-01-01', linker: 14, msvc: true }, { bitness: 32, imports: ['d3d12.dll'] }).dx12, undefined);
  assert.equal(detect.apiVetoes({ linkTime: '2020-01-01', linker: 14, msvc: true }, { bitness: 32, imports: null }).dx12, undefined);
});

test('a 2009 32-bit game that mentions D3D12 is still its own Direct3D 9', async () => {
  const dir = scratchDir('vetoes-godfather');
  const exe = fakePe(path.join(dir, 'godfather.exe'), { strings: ['d3d9.dll', 'd3d12.dll', 'D3D12CreateDevice', 'vulkan-1.dll'] });
  const det = await detect.detectGame(dir, exe);
  assert.equal(det.bitness, 32);
  assert.equal(det.api, 'dx9');
  assert.ok(!det.apis.includes('dx12'));
  assert.ok(det.apiVetoes.dx12);
  assert.equal(det.build.linkTime, '2009-02-01');
});

test('OptiScaler\'s log naming a device the exe cannot have made is not taken as the game\'s', async () => {
  const dir = scratchDir('vetoes-runtime');
  const exe = fakePe(path.join(dir, 'godfather.exe'), { strings: ['d3d9.dll'] });
  write(dir, 'OptiScaler.log', '[00:00:01.000000] [I] hkD3D12CreateDevice Adapter Desc: NVIDIA\n');
  assert.equal((await detect.optiScalerRuntimeApi(dir)).api, 'dx12', 'the log itself does say DX12');
  const det = await detect.detectGame(dir, exe);
  assert.equal(det.api, 'dx9');
  assert.equal(det.runtimeApi, null);
  assert.equal(det.runtimeIgnored.api, 'dx12');
});

test('a modern 64-bit DX12 game is unaffected', async () => {
  const dir = scratchDir('vetoes-modern');
  const exe = fakePe(path.join(dir, 'game.exe'), { bits: 64, linked: '2023-07-05', linker: 14, strings: ['d3d12.dll', 'D3D12CreateDevice'] });
  const det = await detect.detectGame(dir, exe);
  assert.equal(det.api, 'dx12');
  assert.deepEqual(det.apiVetoes, {});
});

test('the watched launch never crowns our own helper, and cannot outvote the build date', () => {
  const trace = {
    processes: [
      { pid: 1, ppid: 0, image: 'D:\\Games\\Godfather II\\godfather.exe' },
      { pid: 2, ppid: 1, image: 'D:\\Games\\Godfather II\\host64\\dlss5-feed-host64.exe' },
    ],
    loads: [
      { pid: 1, image: 'D:\\Games\\Godfather II\\godfather.exe', seq: 0 },
      { pid: 1, image: 'C:\\Windows\\SysWOW64\\d3d9.dll', seq: 1 },
      { pid: 2, image: 'D:\\Games\\Godfather II\\host64\\dlss5-feed-host64.exe', seq: 2 },
      { pid: 2, image: 'C:\\Windows\\System32\\d3d12.dll', seq: 3 },
      { pid: 2, image: 'C:\\Windows\\System32\\D3D12Core.dll', seq: 4 },
      { pid: 2, image: 'C:\\Windows\\System32\\dxgi.dll', seq: 5 },
    ],
  };
  const facts = probe.analyzeTrace(trace, { exePath: 'D:\\Games\\Godfather II\\godfather.exe' });
  assert.notEqual(facts.api, 'dx12');
  assert.ok(probe.isOurProcess('D:\\G\\host64\\dlss5-feed-host64.exe'));
  assert.ok(!probe.isOurProcess('D:\\G\\Game.exe'));

  const kept = probe.applyProbe({ api: 'dx9', apis: ['dx9'], apiVetoes: { dx12: 'built 2009' }, bitness: 32 },
    { api: 'dx12', apiEvidence: 'd3d12.dll', capturedAt: new Date().toISOString() });
  assert.equal(kept.api, 'dx9');
  assert.equal(kept.probe.why, 'predates-api');
});

test('Edit can set DX9, DX8 and DX10, shaped like a legacy detection', () => {
  for (const api of ['dx9', 'dx8', 'dx10']) assert.ok(API_OVERRIDE_VALUES.includes(api));
  const wrong = { api: 'dx12', apis: ['dx12', 'dx11'], bitness: 32, recommend: 'optiscaler' };
  const dx9 = withApiOverride(wrong, 'dx9');
  assert.equal(dx9.api, 'dx9');
  assert.deepEqual(dx9.apis, ['dx9']);
  assert.equal(dx9.legacy, true);
  assert.ok(dx9.legacyApis.includes('dx9'));
  assert.equal(dx9.recommend, 'optiscaler');
  assert.equal(dx9.detectedApi, 'dx12');
  // No 64-bit D3D8, no 64-bit DX10 add-on.
  assert.equal(withApiOverride({ ...wrong, bitness: 64 }, 'dx8').recommend, 'unsupported');
  assert.equal(withApiOverride({ ...wrong, bitness: 32 }, 'dx10').recommend, 'optiscaler');
});
