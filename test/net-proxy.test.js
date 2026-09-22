'use strict';
// Downloads go through Chromium's network stack, not Node's.
//
// Node's fetch ignores the Windows system proxy completely -- nothing configures a ProxyAgent and
// nothing reads HTTPS_PROXY -- so a VPN or DPI-bypass tool that works as a PROXY rather than as a
// virtual adapter does nothing for this app while the user's browser sails through the same
// connection. A Fallout: New Vegas user lost a day to that on 2026-09-22.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const net = require(path.join(REPO, 'src', 'net'));
const readSrc = (...rel) => fs.readFileSync(path.join(REPO, 'src', ...rel), 'utf8').replace(/\r\n/g, '\n');

test('outside Electron it is the plain fetch, and electron is never required', () => {
  assert.equal(net.chromiumAvailable(), false, 'this test process is not Electron');
  // The load-bearing part. Requiring the electron package outside Electron returns a path STRING
  // and poisons Node's per-(parent, request) resolution cache, after which test/helpers.js's stub
  // stops being reachable and every loadMain throws on ipcMain. Seven tests went red on exactly
  // that, and making the require lazy was not enough -- the first download still triggered it.
  const src = readSrc('net.js');
  const guard = src.indexOf('process.versions.electron');
  const req = src.indexOf("require('electron')");
  assert.notStrictEqual(guard, -1, 'the Electron check must be there');
  assert.notStrictEqual(req, -1);
  assert.ok(guard < req, "require('electron') must sit behind the process.versions.electron guard");
  assert.ok(!/^(const|let|var)[^\n]*require\('electron'\)/m.test(src), 'and never at module scope');
});

test('every downloader defaults to netFetch, so none of them quietly bypasses the proxy', () => {
  // A new download added with `fetchImpl = fetch` would work perfectly for anyone unproxied and
  // fail for exactly the users this exists for, which is the hardest kind of bug to be told about.
  const offenders = [];
  for (const name of fs.readdirSync(path.join(REPO, 'src'))) {
    if (!name.endsWith('.js') || name === 'net.js') continue;
    const src = readSrc(name);
    if (/fetchImpl = fetch\b/.test(src)) offenders.push(`${name}: a downloader still defaults to Node's fetch`);
    if (/\bawait fetch\(/.test(src)) offenders.push(`${name}: a bare await fetch( call`);
    if (/netFetch/.test(src) && !/require\('\.\/net'\)/.test(src)) offenders.push(`${name}: uses netFetch without requiring it`);
  }
  assert.deepEqual(offenders, []);
});

test('Chromium is tried first, and its answer is the answer', async () => {
  const calls = [];
  const res = await net.fetchThrough(
    async () => { calls.push('chromium'); return { ok: true, status: 200 }; },
    async () => { calls.push('direct'); throw new Error('must not be reached'); },
    'https://example.invalid/x', {},
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['chromium'], 'the proxy-aware path is the one that runs');
});

// A system proxy can be misconfigured: Chromium refuses while a direct connection still works.
// Trading one failed download for another would be no gain, so Node gets the second go.
test('a Chromium failure falls back to a direct connection', async () => {
  const calls = [];
  const res = await net.fetchThrough(
    async () => { calls.push('chromium'); throw Object.assign(new Error('proxy refused'), { cause: { code: 'ERR_PROXY_CONNECTION_FAILED' } }); },
    async () => { calls.push('direct'); return { ok: true, status: 200 }; },
    'https://example.invalid/x', {},
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['chromium', 'direct']);
});

test('when both fail the user is told BOTH reasons, not just the last one', async () => {
  await assert.rejects(
    () => net.fetchThrough(
      async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ERR_PROXY_CONNECTION_FAILED' } }); },
      async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); },
      'https://example.invalid/x', {},
    ),
    (err) => {
      assert.match(err.message, /ERR_PROXY_CONNECTION_FAILED/, 'what the system proxy did');
      assert.match(err.message, /without the system proxy: ECONNRESET/, 'and what happened without it');
      assert.doesNotMatch(err.message, /^fetch failed$/, 'never the bare two words again');
      return true;
    },
  );
});

test('with no Chromium at all it is simply the direct fetch', async () => {
  const res = await net.fetchThrough(null, async () => ({ ok: true, status: 204 }), 'https://example.invalid/x', {});
  assert.equal(res.status, 204);
});
