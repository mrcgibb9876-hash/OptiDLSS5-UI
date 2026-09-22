'use strict';
// reshade.me's /downloads/ serves only ReShade's CURRENT version. The app pinned exactly one URL
// to exactly one version, so the day 6.9 ships, `ReShade_Setup_6.8.0_Addon.exe` 404s and every
// fresh Feeder install on every machine fails at the same step at once -- while machines that had
// already deployed once carry on from their cache and notice nothing. Invisible to us, total for
// anyone new, and a release the only way out.
//
// So the setup is resolved rather than downloaded: the cache, then a copy the user supplied, then
// each known version in turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { scratchDir, pinFixture } = require(path.join(__dirname, 'helpers'));
const feeder = require(path.join(__dirname, '..', 'src', 'feeder'));

const BIG = 2 * 1024 * 1024;

// A stand-in ReShade setup: a real zip holding a ReShade64.dll, add-on build or not. The app reads
// the export table out of the DLL inside, so the zip has to be genuine.
function fakeSetup(file, { addon = true } = {}) {
  const dll = Buffer.concat([
    Buffer.from('MZ'), Buffer.alloc(BIG),
    Buffer.from(addon ? 'ReShadeRegisterAddon' : 'ReShade', 'latin1'),
  ]);
  const name = Buffer.from('ReShade64.dll', 'latin1');
  const body = zlib.deflateRawSync(dll);
  const crc = require('node:zlib').crc32 ? require('node:zlib').crc32(dll) : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(dll.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localOffset = 0;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(dll.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(localOffset, 42);
  const centralStart = local.length + name.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(centralStart, 16);
  fs.writeFileSync(file, Buffer.concat([local, name, body, central, name, eocd]));
  return file;
}

test('the known setups are a list, every entry carrying a version and a pinned URL', () => {
  assert.ok(Array.isArray(feeder.RESHADE_SETUPS), 'a list, so a version that goes is not fatal');
  assert.ok(feeder.RESHADE_SETUPS.length >= 1);
  const integrity = require(path.join(__dirname, '..', 'src', 'integrity'));
  for (const s of feeder.RESHADE_SETUPS) {
    assert.match(s.version, /^\d+\.\d+(\.\d+)?$/, `${s.version} is a version`);
    assert.ok(integrity.pinFor(s.url), `${s.version} is hash-pinned -- resilience never means installing something unidentified`);
  }
});

test('a cached setup is used without touching the network at all', async () => {
  const cache = scratchDir('rs-cached');
  const name = path.basename(feeder.RESHADE_SETUPS[0].url);
  fs.writeFileSync(path.join(cache, name), Buffer.alloc(BIG + 1));
  const got = await feeder.ensureReShadeSetup(cache, {}, {
    fetchImpl: () => { throw new Error('the network must not be touched when the cache has it'); },
  });
  assert.equal(got, path.join(cache, name));
});

// THE ORDINARY PATH, and the one that must not have changed. Nobody adds ReShade by hand: with an
// empty cache and a host that answers, the installer is fetched automatically exactly as before.
// The user-supplied copy is a rescue for when that fails, never a step anyone is asked to take.
test('an empty cache and a working host still fetch the installer automatically', async () => {
  const cache = scratchDir('rs-auto');
  const body = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(BIG)]);
  const setup = feeder.RESHADE_SETUPS[0];
  const restore = pinFixture({ [setup.url]: body });
  try {
    let asked = null;
    const got = await feeder.ensureReShadeSetup(cache, { 'User-Agent': 'test' }, {
      fetchImpl: async (url) => {
        asked = url;
        return { ok: true, status: 200, url, headers: new Map(), arrayBuffer: async () => body };
      },
    });
    assert.equal(asked, setup.url, 'it went to reshade.me on its own');
    assert.equal(got, path.join(cache, path.basename(setup.url)));
    assert.ok(fs.existsSync(got), 'and cached it, so the next game needs no network at all');
  } finally {
    restore();
  }
});

test("a user's own copy is preferred, and survives a version this app no longer knows", async () => {
  const cache = scratchDir('rs-user');
  fs.writeFileSync(path.join(cache, feeder.RESHADE_USER_SETUP), Buffer.alloc(BIG + 1));
  const got = await feeder.ensureReShadeSetup(cache, {}, {
    fetchImpl: () => { throw new Error('no network'); },
  });
  assert.equal(got, path.join(cache, feeder.RESHADE_USER_SETUP));
});

// The whole point: the pinned version is gone from the host.
test('a 404 on every known version is an error that says what happened and what to do', async () => {
  const cache = scratchDir('rs-gone');
  const fetchImpl = async () => ({ ok: false, status: 404, headers: new Map(), url: feeder.RESHADE_SETUPS[0].url });
  await assert.rejects(
    () => feeder.ensureReShadeSetup(cache, {}, { fetchImpl }),
    (err) => {
      assert.equal(err.code, 'reshade-setup-unavailable');
      assert.ok(err.needsReShadeSetup, 'flagged so the caller can offer the picker');
      assert.match(err.message, /only its current version/, 'names the real cause');
      assert.match(err.message, /Addon\.exe/, 'and says which build to pick');
      return true;
    },
  );
});

// Node throws a bare "fetch failed" for everything below HTTP, with the cause buried. A user on a
// filtered network got exactly those two words (Fallout: New Vegas, 2026-09-22).
test('a connection that never completes names the host and the cause, not "fetch failed"', () => {
  const bare = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const said = feeder.describeFetchFailure(bare, 'https://reshade.me/downloads/x.exe');
  assert.match(said, /reshade\.me/);
  assert.match(said, /ECONNRESET/);
  assert.doesNotMatch(said, /^fetch failed$/);
});

test("a user's file is taken only when it is the Add-on build", async () => {
  const cache = scratchDir('rs-import');
  const src = scratchDir('rs-src');

  const addon = fakeSetup(path.join(src, 'ReShade_Setup_9.9.9_Addon.exe'), { addon: true });
  const got = await feeder.importReShadeSetup(addon, cache);
  assert.equal(got, path.join(cache, feeder.RESHADE_USER_SETUP));
  assert.ok(fs.existsSync(got));
  assert.ok(!fs.existsSync(path.join(cache, '.reshade-addon-probe.dll')), 'the probe is cleaned up');

  // The plain build deploys perfectly and then never loads the Feeder, so refusing it is the
  // kinder answer. The file name is not the test -- this one is named like the add-on build.
  const plain = fakeSetup(path.join(src, 'ReShade_Setup_9.9.9_Addon.exe'), { addon: false });
  await assert.rejects(() => feeder.importReShadeSetup(plain, cache), /PLAIN build/);

  // Something that is not a ReShade setup at all.
  const junk = path.join(src, 'notasetup.exe');
  fs.writeFileSync(junk, Buffer.from('MZ not a zip'));
  await assert.rejects(() => feeder.importReShadeSetup(junk, cache), /not a ReShade setup/);
  await assert.rejects(() => feeder.importReShadeSetup(path.join(src, 'nope.exe'), cache), /does not exist/);
});

// On Vulkan, ReShade is a machine-wide layer that only its own installer can register, so
// deployReShade's job there is to TELL the user which of the three layer faults they have. That
// diagnosis is something the app is certain of; a failed download is not a reason to replace it
// with a network error on the one route where the user has to act.
test('a Vulkan layer fault is still reported when the installer cannot be fetched', async () => {
  const dir = scratchDir('rs-vk-dir');
  const cache = scratchDir('rs-vk-cache');
  await assert.rejects(
    () => feeder.deployReShade(dir, cache, { 'User-Agent': 'test' }, {
      api: 'vulkan',
      exePath: path.join(dir, 'game.exe'),
      vulkanStatus: { registered: false, addon: false, appListed: false },
      fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); },
    }),
    (err) => {
      assert.ok(err.needsReShadeInstaller, 'still the Vulkan-installer case');
      assert.match(err.message, /not installed as a Vulkan layer/, 'the diagnosis survives');
      assert.match(err.message, /could not fetch it for you/, 'and the download failure is added, not substituted');
      assert.equal(err.setupPath, null, 'so the caller can offer the user their own copy');
      assert.match(err.setupError, /reshade\.me/, 'naming the host');
      return true;
    },
  );
});
