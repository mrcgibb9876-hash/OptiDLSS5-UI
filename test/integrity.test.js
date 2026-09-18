'use strict';
// src/integrity.js: every download the app places is checked against a sha256 -- a pin for fixed
// URLs, GitHub's published asset digest for release assets -- and a mismatch is refused with a
// message that names the likely cause. Also the engine updater's pin (engines.js). No network:
// every fetch is a stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const integrity = require('../src/integrity');
const feeder = require('../src/feeder');
const engines = require('../src/engines');
const { scratchDir } = require('./helpers');

const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const ok = (buf, url) => ({ ok: true, status: 200, url, arrayBuffer: async () => ab(buf), json: async () => JSON.parse(buf.toString()) });

test('every fixed URL the app downloads is pinned, and the pins are well-formed', () => {
  const expected = [
    feeder.RESHADE_SETUP_URL,
    feeder.MV_PROVIDERS.vort.zipUrl,
    integrity.URLS.dgVoodoo,
    integrity.URLS.dxvk,
    integrity.URLS.reshadeShadersRaw + 'ReShade.fxh', integrity.URLS.reshadeShadersMirror + 'ReShade.fxh',
    integrity.URLS.reshadeShadersRaw + 'ReShadeUI.fxh', integrity.URLS.reshadeShadersMirror + 'ReShadeUI.fxh',
    integrity.URLS.lumeniteRaw + 'lumenite_Kernel.fx',
    integrity.URLS.lumeniteRaw + 'include/lumenite_Projections.fxh',
    integrity.URLS.lumeniteRaw + 'include/lumenite_Helpers.fxh',
    integrity.URLS.lumeniteRaw + 'include/lumenite_Compute.fxh',
  ];
  for (const url of expected) assert.match(integrity.pinFor(url) || '', /^[0-9a-f]{64}$/, url);
  // Pinned text downloads name a commit, never a branch, so the pin cannot go stale by itself.
  for (const url of Object.keys(integrity.PINS)) assert.doesNotMatch(url, /\/(slim|main|master|mainline)\//, url);
  // The modules that own dgVoodoo2 and DXVK read their hash from here.
  assert.equal(require('../src/legacy').DGVOODOO.sha256, integrity.pinFor(require('../src/legacy').DGVOODOO.url));
  assert.equal(integrity.pinFor(integrity.URLS.dxvk), '40565b4a724aadc4433fa4e010b4b23916d9b1f1baeee64e17186db94f54e608');
});

test('GitHub asset digests and release URLs are read', () => {
  assert.equal(integrity.digestFromAsset({ digest: 'sha256:' + 'AB'.repeat(32) }), 'ab'.repeat(32));
  assert.equal(integrity.digestFromAsset({ digest: 'md5:xyz' }), null);
  assert.equal(integrity.digestFromAsset(null), null);
  assert.deepEqual(integrity.parseReleaseUrl('https://github.com/RankFTW/rhi-repo/releases/download/dlss-310.9.1/nvngx_dlss_310.9.1.zip'),
    { owner: 'RankFTW', repo: 'rhi-repo', tag: 'dlss-310.9.1', name: 'nvngx_dlss_310.9.1.zip' });
  assert.equal(integrity.parseReleaseUrl('https://reshade.me/downloads/x.exe'), null);
});

test('a release asset is checked against the digest GitHub publishes for it', async () => {
  integrity._resetDigestCache();
  const good = Buffer.from('the real zip');
  const url = 'https://github.com/o/r/releases/download/v1/pkg.zip';
  const api = [];
  const fetchImpl = async (u) => {
    api.push(u);
    return ok(Buffer.from(JSON.stringify({ assets: [{ name: 'pkg.zip', digest: 'sha256:' + integrity.sha256(good) }] })));
  };
  assert.equal(await integrity.expectedSha256(url, { fetchImpl }), integrity.sha256(good));
  assert.equal(await integrity.expectedSha256(url, { fetchImpl }), integrity.sha256(good));
  assert.equal(api.length, 1, 'one lookup per release per run');
  // A digest the caller already has wins without a lookup; a pin wins over both.
  assert.equal(await integrity.expectedSha256('https://github.com/o/r/releases/download/v2/x.zip', { sha256: 'AA'.repeat(32), fetchImpl: async () => { throw new Error('no'); } }), 'aa'.repeat(32));
  assert.equal(await integrity.expectedSha256(integrity.URLS.dxvk, { sha256: 'aa'.repeat(32) }), integrity.pinFor(integrity.URLS.dxvk));
  // Offline: nothing to check against, so null (the download is used unverified, not refused).
  integrity._resetDigestCache();
  assert.equal(await integrity.expectedSha256(url, { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('downloadToCache refuses a download that does not match, and names the likely cause', async () => {
  integrity._resetDigestCache();
  const cacheDir = scratchDir('integrity-cache');
  const url = 'https://github.com/o/r/releases/download/v1/pkg.zip';
  const real = Buffer.from('the real zip');
  const bad = Buffer.from('a damaged zip');
  const fetchImpl = async (u) => (u.startsWith('https://api.github.com/')
    ? ok(Buffer.from(JSON.stringify({ assets: [{ name: 'pkg.zip', digest: 'sha256:' + integrity.sha256(real) }] })))
    : ok(bad, u));
  await assert.rejects(feeder.downloadToCache(url, cacheDir, 'pkg.zip', {}, { fetchImpl }), (e) => {
    assert.equal(e.code, 'checksum-mismatch');
    assert.match(e.message, /Windows Defender/);
    assert.match(e.message, /Protection history/);
    return true;
  });
  assert.ok(!fs.existsSync(path.join(cacheDir, 'pkg.zip')), 'nothing cached after a mismatch');

  const good = await feeder.downloadToCache(url, cacheDir, 'pkg.zip', {}, { fetchImpl: async (u) => (u.startsWith('https://api.github.com/') ? fetchImpl(u) : ok(real, u)) });
  assert.equal(fs.readFileSync(good, 'utf8'), 'the real zip');
});

test('a cached file damaged since it was downloaded is fetched again when its hash is known', async () => {
  const cacheDir = scratchDir('integrity-recache');
  const real = Buffer.from('pinned content');
  const url = 'https://example.invalid/pinned.bin';
  integrity.PINS[url] = integrity.sha256(real);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'pinned.bin'), 'rotted');
    let fetched = 0;
    const p = await feeder.downloadToCache(url, cacheDir, 'pinned.bin', {}, { fetchImpl: async (u) => { fetched++; return ok(real, u); } });
    assert.equal(fetched, 1);
    assert.equal(fs.readFileSync(p, 'utf8'), 'pinned content');
    // Intact: served from the cache, no network.
    await feeder.downloadToCache(url, cacheDir, 'pinned.bin', {}, { fetchImpl: async () => { throw new Error('should not fetch'); } });
  } finally {
    delete integrity.PINS[url];
  }
});

test('a redirect off GitHub, or to plain http, is refused', () => {
  const from = 'https://github.com/o/r/releases/download/v1/pkg.zip';
  assert.doesNotThrow(() => integrity.checkFinalUrl(from, { url: 'https://release-assets.githubusercontent.com/x?sig=1' }));
  assert.doesNotThrow(() => integrity.checkFinalUrl(from, { url: from }));
  assert.doesNotThrow(() => integrity.checkFinalUrl(from, {}));
  assert.throws(() => integrity.checkFinalUrl(from, { url: 'https://evil.example/pkg.zip' }), /redirected off GitHub/);
  assert.throws(() => integrity.checkFinalUrl('https://reshade.me/downloads/x.exe', { url: 'http://reshade.me/x.exe' }), /non-https/);
  // A non-GitHub host may move within https (a CDN).
  assert.doesNotThrow(() => integrity.checkFinalUrl('https://reshade.me/downloads/x.exe', { url: 'https://cdn.reshade.me/x.exe' }));
});

test('the engine updater offers the pinned engine; a newer one is only reported as untested', () => {
  assert.equal(engines.pinnedEngineTag({ engineVersion: 'v1.0.41' }), 'v1.0.41');
  assert.equal(engines.pinnedEngineTag({}), null);
  assert.equal(engines.pinnedEngineTag({ engineVersion: 'latest' }), null);
  assert.equal(engines.pinnedEngineTag(), require('../package.json').engineVersion, 'reads package.json');

  assert.equal(engines.compareEngineTags('v1.0.41', 'v1.0.40'), 1);
  assert.equal(engines.compareEngineTags('v2.1.0-final', 'v2.1.0'), 0);
  assert.equal(engines.compareEngineTags('v1.0.9', 'v1.0.10'), -1);

  const pinned = { tag_name: 'v1.0.41' };
  const newer = { tag_name: 'v1.0.42' };
  assert.deepEqual(engines.chooseEngineOffer({ pin: 'v1.0.41', pinned, latest: newer }), { offer: pinned, newerUntested: 'v1.0.42' });
  assert.deepEqual(engines.chooseEngineOffer({ pin: 'v1.0.41', pinned, latest: pinned }), { offer: pinned, newerUntested: null });
  assert.deepEqual(engines.chooseEngineOffer({ pin: 'v1.0.41', pinned, latest: null }), { offer: pinned, newerUntested: null });
  assert.deepEqual(engines.chooseEngineOffer({ pin: null, pinned: null, latest: newer }), { offer: newer, newerUntested: null });
});
