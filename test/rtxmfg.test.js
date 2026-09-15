'use strict';
// RTXMFG (dashdogy/RTX40MFG-Unlock): fetched and checksum-verified, placed under a free proxy name,
// recognised as ours by every check that would otherwise read it as a rival hook, and removed only
// while it is still the copy this app placed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain } = require('./helpers');
const rtxmfg = require('../src/rtxmfg');
const detect = require('../src/detect');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A one-entry deflate zip, enough for zip.js.
function makeZip(name, data) {
  const comp = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const crc = zlib.crc32 ? zlib.crc32(data) : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc >>> 0, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, comp, cd, nameBuf, eocd]);
}

function fakeGitHub({ dll, zipName = 'RTXMFG-v1.3.3.zip', sums }) {
  const zip = makeZip('RTXMFG.dll', dll);
  const sumsText = sums || `${sha(dll)}  RTXMFG.dll\n${sha(zip)}  ${zipName}\n`;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === rtxmfg.RELEASES_API) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.3.3', assets: [
        { name: zipName, browser_download_url: 'https://dl/zip' },
        { name: 'SHA256SUMS.txt', browser_download_url: 'https://dl/sums' },
      ] }) };
    }
    if (url === 'https://dl/sums') return { ok: true, status: 200, text: async () => sumsText };
    if (url === 'https://dl/zip') return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}

test('GPU series: RTX 40 is supported, RTX 30 experimental, RTX 50 native, the rest not', () => {
  assert.equal(rtxmfg.gpuSeries('NVIDIA GeForce RTX 4070 Laptop GPU'), 40);
  assert.equal(rtxmfg.gpuSeries('NVIDIA GeForce RTX 5070 Ti'), 50);
  assert.equal(rtxmfg.gpuSeries('NVIDIA GeForce RTX 3060'), 30);
  assert.equal(rtxmfg.gpuSeries('NVIDIA GeForce GTX 1080'), null);
  assert.equal(rtxmfg.gpuSupport({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090' }).status, 'supported');
  assert.equal(rtxmfg.gpuSupport({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3080' }).status, 'experimental');
  assert.equal(rtxmfg.gpuSupport({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU' }).status, 'native');
  assert.equal(rtxmfg.gpuSupport({ vendor: 'amd', name: 'AMD Radeon RX 7900' }).status, 'unsupported');
});

test('the download is refused when it does not match SHA256SUMS.txt, and cached when it does', async () => {
  const dll = Buffer.concat([Buffer.from('MZ'), Buffer.from('ReShade inside the menu code'), crypto.randomBytes(64)]);
  const cacheRoot = scratchDir('rtxmfg-cache');
  const bad = fakeGitHub({ dll, sums: `${'0'.repeat(64)}  RTXMFG.dll\n` });
  const refused = await rtxmfg.ensureCache({ cacheRoot, fetchImpl: bad.fetchImpl });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /sha256/);
  assert.ok(!fs.existsSync(path.join(cacheRoot, 'v1.3.3', 'RTXMFG.dll')));

  const good = fakeGitHub({ dll });
  const ok = await rtxmfg.ensureCache({ cacheRoot, fetchImpl: good.fetchImpl });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.sha256, sha(dll));
  assert.deepEqual(fs.readFileSync(ok.dllPath), dll);

  const again = fakeGitHub({ dll });
  await rtxmfg.ensureCache({ cacheRoot, fetchImpl: again.fetchImpl });
  assert.ok(!again.calls.includes('https://dl/zip'), 'a verified cached copy is not downloaded again');
});

test('placed under a free name, never over someone else\'s DLL, not mistaken for ReShade or OptiScaler, removed only while ours', async () => {
  const dll = Buffer.concat([Buffer.from('MZ'), Buffer.from('ReShade'), crypto.randomBytes(64)]);
  const cacheRoot = scratchDir('rtxmfg-cache2');
  const cache = await rtxmfg.ensureCache({ cacheRoot, fetchImpl: fakeGitHub({ dll }).fetchImpl });
  const game = scratchDir('rtxmfg-game');
  fakeExe(game, 'Game.exe');
  write(game, 'version.dll', 'the game\'s own version.dll');

  const choice = rtxmfg.proxyChoice(game);
  assert.ok(choice.occupied.includes('version.dll'));
  assert.equal(choice.suggested, 'winhttp.dll', 'the first free name');
  assert.throws(() => rtxmfg.deploy(game, { ...cache, proxyName: 'version.dll' }), /already exists/);
  assert.equal(fs.readFileSync(path.join(game, 'version.dll'), 'utf8'), 'the game\'s own version.dll');

  rtxmfg.deploy(game, { dllPath: cache.dllPath, sha256: cache.sha256, tag: cache.tag, proxyName: 'dinput8.dll' });
  assert.equal(rtxmfg.ourFile(game), 'dinput8.dll');
  // dinput8.dll is one of detect.js's hook DLLs and RTXMFG carries "ReShade": it must not read as a ReShade proxy.
  detect.invalidateDetection && detect.invalidateDetection(game);
  const hooks = await detect.inspectHookDlls(game);
  assert.equal(hooks.reshadeProxy, null);

  // Moving to another name takes our old copy with it.
  rtxmfg.deploy(game, { dllPath: cache.dllPath, sha256: cache.sha256, tag: cache.tag, proxyName: 'dsound.dll' });
  assert.ok(!fs.existsSync(path.join(game, 'dinput8.dll')));
  assert.equal(rtxmfg.ourFile(game), 'dsound.dll');

  write(game, rtxmfg.SETTINGS_FILE, '{}');
  assert.deepEqual(rtxmfg.removalPlan(game).sort(), [rtxmfg.MARKER, rtxmfg.SETTINGS_FILE, 'dsound.dll'].sort());

  // A copy changed since (the user dropped a newer release over it) stays.
  fs.writeFileSync(path.join(game, 'dsound.dll'), 'MZ newer build');
  const r = rtxmfg.remove(game);
  assert.ok(fs.existsSync(path.join(game, 'dsound.dll')));
  assert.equal(r.kept.length, 1);
  assert.ok(!fs.existsSync(path.join(game, rtxmfg.MARKER)));
  assert.equal(fs.readFileSync(path.join(game, 'version.dll'), 'utf8'), 'the game\'s own version.dll', 'the game\'s DLL is untouched throughout');
});

test('with OptiScaler installed beside it, the route still sees one OptiScaler, and the card\'s Remove takes RTXMFG too', { skip: process.platform !== 'win32' }, async () => {
  const base = scratchDir('rtxmfg-with-opti');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  const { invoke } = loadMain();
  const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(inst.ok, true, inst.error);

  const dll = Buffer.concat([Buffer.from('MZ'), Buffer.from('ReShade'), crypto.randomBytes(64)]);
  const cache = await rtxmfg.ensureCache({ cacheRoot: path.join(base, 'cache'), fetchImpl: fakeGitHub({ dll }).fetchImpl });
  rtxmfg.deploy(game, { dllPath: cache.dllPath, sha256: cache.sha256, tag: cache.tag, proxyName: rtxmfg.proxyChoice(game).suggested });
  assert.equal(rtxmfg.ourFile(game), 'version.dll');

  const plan = await invoke('game:uninstallPlan', exe);
  assert.ok(plan.remove.includes('version.dll') && plan.remove.includes(rtxmfg.MARKER), 'the preview names it');
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.ok(!fs.existsSync(path.join(game, 'version.dll')), 'RTXMFG gone');
  assert.ok(!fs.existsSync(path.join(game, 'dxgi.dll')), 'OptiScaler gone');
  assert.ok(!fs.existsSync(path.join(game, rtxmfg.MARKER)));
});
