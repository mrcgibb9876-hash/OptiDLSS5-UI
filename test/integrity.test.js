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

// A rolling release (`snapshot`, `test-ue-extended`) replaces its assets in place under the same name.
// An un-pinned one used to be served from the cache by file name forever; now a new upload arrives.
function rollingRelease() {
  const url = 'https://github.com/o/renodx/releases/download/snapshot/renodx-ue-extended.addon64';
  const state = { bytes: Buffer.from('build 1'), updatedAt: '2026-09-26T20:21:01Z', withDigest: true, offline: false, api: 0, downloads: 0 };
  const fetchImpl = async (u) => {
    if (state.offline) throw new Error('offline');
    if (u.startsWith('https://api.github.com/')) {
      state.api++;
      const asset = { name: 'renodx-ue-extended.addon64', updated_at: state.updatedAt };
      if (state.withDigest) asset.digest = 'sha256:' + integrity.sha256(state.bytes);
      return ok(Buffer.from(JSON.stringify({ assets: [asset] })));
    }
    state.downloads++;
    return ok(state.bytes, u);
  };
  return { url, state, fetchImpl };
}

test('a rolling release asset in the cache is reused while GitHub still describes it the same way', async () => {
  integrity._resetDigestCache();
  const cacheDir = scratchDir('integrity-rolling-same');
  const { url, state, fetchImpl } = rollingRelease();
  const file = await feeder.downloadToCache(url, cacheDir, 'renodx-ue-extended.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 1);
  const record = JSON.parse(fs.readFileSync(file + '.release.json', 'utf8'));
  assert.deepEqual(record, { url, repo: 'o/renodx', tag: 'snapshot', name: 'renodx-ue-extended.addon64',
    updatedAt: '2026-09-26T20:21:01Z', digest: integrity.sha256(Buffer.from('build 1')) });

  integrity._resetDigestCache();
  await feeder.downloadToCache(url, cacheDir, 'renodx-ue-extended.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 1, 'unchanged: served from the cache');
});

test('a rolling release asset is fetched again when its digest or updated_at moves, and checked against the new digest', async () => {
  integrity._resetDigestCache();
  const cacheDir = scratchDir('integrity-rolling-new');
  const { url, state, fetchImpl } = rollingRelease();
  await feeder.downloadToCache(url, cacheDir, 'a.addon64', {}, { fetchImpl });

  // A new upload: new bytes, new digest, new updated_at.
  integrity._resetDigestCache();
  state.bytes = Buffer.from('build 2');
  state.updatedAt = '2026-09-27T08:00:00Z';
  let file = await feeder.downloadToCache(url, cacheDir, 'a.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'build 2');
  assert.equal(JSON.parse(fs.readFileSync(file + '.release.json', 'utf8')).updatedAt, '2026-09-27T08:00:00Z');

  // Re-uploaded with the same bytes: updated_at alone moved, so it is fetched again.
  integrity._resetDigestCache();
  state.updatedAt = '2026-09-28T08:00:00Z';
  file = await feeder.downloadToCache(url, cacheDir, 'a.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 3);

  // The new download is verified against GitHub's digest: bytes that do not match are refused.
  integrity._resetDigestCache();
  state.updatedAt = '2026-09-29T08:00:00Z';
  const badFetch = async (u) => (u.startsWith('https://api.github.com/') ? fetchImpl(u) : ok(Buffer.from('tampered'), u));
  await assert.rejects(feeder.downloadToCache(url, cacheDir, 'a.addon64', {}, { fetchImpl: badFetch }), (e) => e.code === 'checksum-mismatch');
});

test('a rolling release asset without a digest is judged by updated_at; offline, the cached copy is used', async () => {
  integrity._resetDigestCache();
  const cacheDir = scratchDir('integrity-rolling-nodigest');
  const { url, state, fetchImpl } = rollingRelease();
  state.withDigest = false;
  await feeder.downloadToCache(url, cacheDir, 'b.addon64', {}, { fetchImpl });
  integrity._resetDigestCache();
  await feeder.downloadToCache(url, cacheDir, 'b.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 1, 'same updated_at: reused');
  integrity._resetDigestCache();
  state.bytes = Buffer.from('build 2');
  state.updatedAt = '2026-09-27T08:00:00Z';
  const file = await feeder.downloadToCache(url, cacheDir, 'b.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'build 2');

  integrity._resetDigestCache();
  state.offline = true;
  assert.equal(fs.readFileSync(await feeder.downloadToCache(url, cacheDir, 'b.addon64', {}, { fetchImpl }), 'utf8'), 'build 2');
});

test('a cached copy from before records existed is kept when it is the published bytes, replaced when not', async () => {
  integrity._resetDigestCache();
  const cacheDir = scratchDir('integrity-rolling-legacy');
  const { url, state, fetchImpl } = rollingRelease();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'c.addon64'), 'build 1');
  await feeder.downloadToCache(url, cacheDir, 'c.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 0, 'same bytes as published: no download');
  assert.ok(fs.existsSync(path.join(cacheDir, 'c.addon64.release.json')), 'and it gains a record');

  integrity._resetDigestCache();
  fs.writeFileSync(path.join(cacheDir, 'd.addon64'), 'an old build');
  const file = await feeder.downloadToCache(url, cacheDir, 'd.addon64', {}, { fetchImpl });
  assert.equal(state.downloads, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'build 1');
});

test('pinned and caller-digest downloads keep their own check and ask GitHub nothing on a cache hit', async () => {
  integrity._resetDigestCache();
  const cacheDir = scratchDir('integrity-rolling-given');
  const { url, state, fetchImpl } = rollingRelease();
  const given = integrity.sha256(state.bytes);
  await feeder.downloadToCache(url, cacheDir, 'e.addon64', {}, { fetchImpl, sha256: given });
  assert.ok(!fs.existsSync(path.join(cacheDir, 'e.addon64.release.json')), 'the caller\'s digest is the record');
  const apiBefore = state.api;
  await feeder.downloadToCache(url, cacheDir, 'e.addon64', {}, { fetchImpl, sha256: given });
  assert.equal(state.api, apiBefore);
  assert.equal(state.downloads, 1);
  // A different digest from the caller (a new upload it has seen) fetches again.
  state.bytes = Buffer.from('build 2');
  await feeder.downloadToCache(url, cacheDir, 'e.addon64', {}, { fetchImpl, sha256: integrity.sha256(state.bytes) });
  assert.equal(state.downloads, 2);

  // Not a release URL and not pinned: reused by name, no lookup (nothing to ask).
  const plain = 'https://example.invalid/plain.bin';
  fs.writeFileSync(path.join(cacheDir, 'plain.bin'), 'x');
  await feeder.downloadToCache(plain, cacheDir, 'plain.bin', {}, { fetchImpl: async () => { throw new Error('should not fetch'); } });
});
