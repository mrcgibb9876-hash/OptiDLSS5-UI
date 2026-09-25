'use strict';
// GitHub API reads are remembered so the app stops spending the hourly 60 (ghapi.js). Found when
// "Add frame pacing" answered "HTTP 403; HTTP 403" on 2026-09-25 with nothing missing at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ghapi = require('../src/ghapi');

const URL_ = 'https://api.github.com/repos/o/r/releases/latest';
const headers = (h) => ({ get: (k) => (h[k.toLowerCase()] ?? null) });
const ok = (body, etag = '"e1"') => ({ ok: true, status: 200, headers: headers({ etag }), text: async () => JSON.stringify(body) });
const notModified = () => ({ ok: false, status: 304, headers: headers({}) });
const limited = (reset) => ({ ok: false, status: 403, headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }) });

function fresh(t0 = 1_000_000) {
  ghapi._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-ghapi-'));
  ghapi.configure({ cacheFile: path.join(dir, 'c.json') });
  let now = t0;
  return { dir, clock: { now: () => now }, advance: (ms) => { now += ms; } };
}

test('only plain GETs to api.github.com are handled; writes and signed calls pass straight through', () => {
  ghapi._reset();
  assert.equal(ghapi.handles(URL_, {}), false, 'off until configured');
  fresh();
  assert.equal(ghapi.handles(URL_, {}), true);
  assert.equal(ghapi.handles(URL_, { method: 'POST' }), false);
  assert.equal(ghapi.handles(URL_, { headers: { Authorization: 'Bearer x' } }), false);
  assert.equal(ghapi.handles('https://github.com/o/r/releases/latest/download/a.zip', {}), false);
});

test('a fresh answer is reused without asking; a stale one is re-asked with its ETag and a 304 reuses it', async () => {
  const { clock, advance } = fresh();
  const calls = [];
  const replies = [ok({ tag_name: 'v1' }), notModified()];
  const raw = async (u, init) => { calls.push(init.headers); return replies.shift(); };
  assert.equal((await (await ghapi.githubGet(raw, URL_, {}, clock)).json()).tag_name, 'v1');
  assert.equal((await (await ghapi.githubGet(raw, URL_, {}, clock)).json()).tag_name, 'v1');
  assert.equal(calls.length, 1, 'the second read inside the window cost nothing');
  advance(ghapi.FRESH_MS + 1);
  assert.equal((await (await ghapi.githubGet(raw, URL_, {}, clock)).json()).tag_name, 'v1');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]['If-None-Match'], '"e1"');
});

test('refused for the hour: the last answer however old, then nothing is sent until the reset', async () => {
  const { clock, advance } = fresh();
  let calls = 0;
  const reset = Math.floor((clock.now() + 3600_000) / 1000);
  const replies = [ok({ tag_name: 'v2' }), limited(reset)];
  const raw = async () => { calls++; return replies.shift(); };
  await ghapi.githubGet(raw, URL_, {}, clock);
  advance(ghapi.FRESH_MS + 1);
  assert.equal((await (await ghapi.githubGet(raw, URL_, {}, clock)).json()).tag_name, 'v2', 'the stale answer stands in');
  const other = 'https://api.github.com/repos/o/other/releases/latest';
  await assert.rejects(ghapi.githubGet(raw, other, {}, clock), (e) => e.code === 'github-rate-limit' && /hourly limit/.test(e.message));
  assert.equal(calls, 2, 'nothing more is sent while blocked');
});

test('answers outlast a restart, and a signed-in token rides along but is dropped when rejected', async () => {
  const { dir, clock } = fresh();
  await ghapi.githubGet(async () => ok({ tag_name: 'v3' }), URL_, {}, clock);
  await new Promise((r) => setTimeout(r, 1200)); // the debounced save
  const file = path.join(dir, 'c.json');
  assert.ok(fs.existsSync(file));
  ghapi._reset();
  ghapi.configure({ cacheFile: file, token: () => 'tok' });
  let saw = [];
  const raw = async (u, init) => { saw.push(init.headers.Authorization || null); return saw.length === 1 ? { ok: false, status: 401, headers: headers({}) } : ok({ tag_name: 'v4' }); };
  const res = await ghapi.githubGet(raw, URL_, {}, clock);
  assert.equal((await res.json()).tag_name, 'v3', 'remembered from before the restart, still fresh');
  assert.deepEqual(saw, []);
  const other = 'https://api.github.com/repos/o/x/releases/latest';
  await ghapi.githubGet(raw, other, {}, clock);
  assert.deepEqual(saw, ['Bearer tok', null], 'the rejected token is dropped and the call retried without it');
  ghapi._reset();
});

test('Check for Updates goes live: a fresh answer is re-asked (with its ETag) for the next minute', async () => {
  const { clock, advance } = fresh();
  let calls = 0;
  const raw = async () => { calls++; return calls === 1 ? ok({ tag_name: 'v5' }) : ok({ tag_name: 'v6' }, '"e2"'); };
  await ghapi.githubGet(raw, URL_, {}, clock);
  ghapi.goLive(60_000, clock.now);
  assert.equal((await (await ghapi.githubGet(raw, URL_, {}, clock)).json()).tag_name, 'v6', 'a release published a moment ago is seen');
  advance(61_000);
  await ghapi.githubGet(raw, URL_, {}, clock);
  assert.equal(calls, 2, 'after the minute the remembered answer is trusted again');
  ghapi._reset();
});

test('a live lookup never gets an old answer; a rejected token is not reused; offline falls back; same-URL calls share one request', async () => {
  const { clock } = fresh();
  ghapi.configure({ cacheFile: require('node:path').join(require('node:os').tmpdir(), `ghapi-${Date.now()}.json`), token: () => 'tok' });
  let calls = 0; const auths = [];
  const raw = async (u, init) => { calls++; auths.push(init.headers.Authorization || null); if (init.headers['x-optidlss5-live']) throw new Error('marker leaked to GitHub'); return auths.length === 1 ? { ok: false, status: 401, headers: headers({}) } : ok({ tag_name: 'v7' }); };
  await ghapi.githubGet(raw, URL_, {}, clock);
  assert.deepEqual(auths, ['Bearer tok', null]);
  await ghapi.githubGet(raw, 'https://api.github.com/repos/o/y/releases/latest', {}, clock);
  assert.equal(auths[2], null, 'the rejected token is not offered again');
  // Live: skips the fresh window, and a refusal returns GitHub's answer instead of the remembered one.
  const refused = async () => ({ ok: false, status: 403, headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(clock.now() / 1000) + 600) }) });
  const liveRes = await ghapi.githubGet(refused, URL_, { headers: { [ghapi.LIVE_HEADER]: '1' } }, clock);
  assert.equal(liveRes.status, 403, 'no stale digest for a rolling tag');
  // Offline: the remembered answer stands in for a normal read.
  ghapi._reset(); fresh(); await ghapi.githubGet(async () => ok({ tag_name: 'v8' }), URL_, {}, clock);
  const later = { now: () => clock.now() + ghapi.FRESH_MS + 1 };
  const off = await ghapi.githubGet(async () => { throw new Error('ENOTFOUND'); }, URL_, {}, later);
  assert.equal((await off.json()).tag_name, 'v8');
  // Two at once share one request.
  ghapi._reset(); fresh(); let n = 0;
  const slow = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return ok({ tag_name: 'v9' }); };
  const [a, b] = await Promise.all([ghapi.githubGet(slow, URL_, {}, clock), ghapi.githubGet(slow, URL_, {}, clock)]);
  assert.equal(n, 1);
  assert.equal((await a.json()).tag_name, 'v9'); assert.equal((await b.json()).tag_name, 'v9');
  ghapi._reset();
});
