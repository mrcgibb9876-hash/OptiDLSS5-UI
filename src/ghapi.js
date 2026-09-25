// Every read from GitHub's REST API, remembered -- so the app stops running out of it.
//
// GitHub gives an app that is not signed in 60 API calls an hour per internet address, and this app
// asks at every launch: the engine's update check, the Feeder, Luma, ReLimiter, the Manager's own
// release... Restart it a handful of times in an hour, or share an address with other players, and
// every one of those starts answering 403 -- which read as "No ReLimiter build could be found (HTTP
// 403; HTTP 403)" on 2026-09-25, when nothing was missing at all.
//
// So net.js hands every GET to api.github.com through here, and:
//   1. An answer younger than FRESH_MS is reused without asking again.
//   2. An older one is re-asked WITH its ETag, and "not changed" (304) returns the remembered answer.
//      For a signed-in call GitHub does not count a 304 against the limit at all.
//   3. Signed in to GitHub (the Report issue sign-in), the call carries that token: 5,000 an hour
//      instead of 60. A token GitHub rejects (401) is not offered again this session, and that call
//      is made again without it.
//   4. Refused for the hour (403/429 with no calls left), the last answer is returned however old --
//      a release list from this morning beats no list -- and until the reset time nothing more is
//      sent. With nothing remembered, it fails with words a player can act on, and code
//      'github-rate-limit', instead of a bare 403.
// Remembered answers live in memory and in one JSON file (configure's cacheFile), so they outlast a
// restart, which is exactly when they are needed.
'use strict';

const fs = require('node:fs');

const FRESH_MS = 20 * 60 * 1000;
const MAX_ENTRIES = 200;

let cacheFile = null;
let tokenProvider = null;
let entries = null; // url -> { etag, body, at }
let blockedUntil = 0;
let saveTimer = null;
// Until this time every read asks GitHub (with its ETag) instead of trusting the 20-minute window. Set by
// the top bar's Check for Updates, so a release published a minute ago is seen when someone asks.
let liveUntil = 0;

function goLive(ms = 60 * 1000, now = Date.now) { liveUntil = now() + ms; }

function configure({ cacheFile: file = null, token = null } = {}) {
  cacheFile = file;
  tokenProvider = token;
  entries = null;
}

function load() {
  if (entries) return entries;
  entries = new Map();
  if (!cacheFile) return entries;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (const [url, e] of Object.entries(raw || {})) if (e && typeof e.body === 'string') entries.set(url, e);
  } catch {}
  return entries;
}

// Written off the main thread's hot path (fs.promises): the file can be a few MB with the unpaginated
// release lists, and a synchronous rewrite after every change stalled the main process.
function saveSoon() {
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const all = [...load().entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_ENTRIES);
      fs.promises.writeFile(cacheFile, JSON.stringify(Object.fromEntries(all))).catch(() => {});
    } catch {}
  }, 1000);
  if (saveTimer.unref) saveTimer.unref();
}

// A caller that must never be given an old answer -- integrity.releaseAssetDigest: `snapshot` is a
// rolling tag whose assets are replaced in place, so a remembered digest would fail a fresh download's
// checksum and blame antivirus. It marks the request with this header; it is stripped before sending,
// always asks GitHub, and on a refusal gets GitHub's own answer back (the digest is then skipped, as it
// was before this cache existed) instead of a stale one.
const LIVE_HEADER = 'x-optidlss5-live';

// Several callers asking for the same URL at once (a grid render, the startup checks) share one request.
const inFlight = new Map();
// A token GitHub has rejected (revoked, expired) is not offered again this session: re-sending it made
// every uncached call two requests and repeated bad credentials can draw GitHub's lockout.
let tokenRejected = false;

// Only plain reads of the public API. Writes (the report's gist and issue) and calls that already
// carry their own credentials are left exactly as they were.
function handles(url, init) {
  // Off until main.js configures it at startup: anything else that runs this code (the test suite,
  // whose stubbed fetches answer the same URL differently test to test) gets fetch exactly as before.
  if (!cacheFile) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.hostname !== 'api.github.com') return false;
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method !== 'GET') return false;
  const h = (init && init.headers) || {};
  const has = (k) => Object.keys(h).some((x) => x.toLowerCase() === k);
  return !has('authorization');
}

function asResponse(entry, status = 200) {
  return new Response(entry.body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-optidlss5-cache': 'hit' } });
}

function resetWords(ms) {
  const at = new Date(ms);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function rateLimitError(resetMs) {
  return Object.assign(
    new Error(`GitHub's hourly limit for this PC is used up, so this could not be looked up. Try again after ${resetWords(resetMs)}, or sign in to GitHub (Report issue) for a much higher limit.`),
    { code: 'github-rate-limit', resetAt: resetMs },
  );
}

function isRateLimited(res) {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const remaining = res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining');
  // A 403 with calls still left is a real refusal (a private repo, say), not the limit.
  return remaining === null || remaining === undefined || remaining === '0';
}

function resetFrom(res, now) {
  const reset = Number(res.headers && res.headers.get && res.headers.get('x-ratelimit-reset'));
  const retry = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  if (Number.isFinite(retry) && retry > 0) return now + retry * 1000;
  return now + 15 * 60 * 1000;
}

async function githubGet(rawFetch, url, init = {}, opts = {}) {
  const headers = { ...(init.headers || {}) };
  let live = false;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === LIVE_HEADER) { live = true; delete headers[k]; }
  }
  const key = `${live ? 'live:' : ''}${String(url)}`;
  const copy = (r) => (r && typeof r.clone === 'function' ? r.clone() : r);
  if (inFlight.has(key)) return copy(await inFlight.get(key));
  const p = fetchOnce(rawFetch, String(url), { ...init, headers }, live, opts);
  inFlight.set(key, p);
  try {
    return copy(await p);
  } finally {
    inFlight.delete(key);
  }
}

async function fetchOnce(rawFetch, url, init, live, { now = Date.now } = {}) {
  const cache = load();
  const cached = cache.get(url);
  const t = now();
  const stale = live ? null : cached; // what a refusal or an outage may fall back to
  if (!live && cached && t - cached.at < FRESH_MS && t >= liveUntil) return asResponse(cached);
  if (t < blockedUntil) {
    if (stale) return asResponse(stale);
    if (live) return new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } });
    throw rateLimitError(blockedUntil);
  }

  const baseHeaders = { ...(init.headers || {}) };
  if (cached && cached.etag) baseHeaders['If-None-Match'] = cached.etag;
  let token = null;
  if (!tokenRejected) {
    try { token = tokenProvider ? await tokenProvider() : null; } catch {}
  }

  let res;
  try {
    res = await rawFetch(url, { ...init, headers: token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders });
    if (res.status === 401 && token) {
      tokenRejected = true;
      res = await rawFetch(url, { ...init, headers: baseHeaders });
    }
  } catch (e) {
    // Offline, DNS, a proxy refusing: the last answer, however old, beats none -- except for a caller
    // that asked never to be given an old one.
    if (stale) return asResponse(stale);
    throw e;
  }

  if (res.status === 304 && cached) {
    cached.at = t;
    saveSoon();
    return asResponse(cached);
  }
  if (res.ok) {
    const body = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
    const etag = res.headers && res.headers.get ? res.headers.get('etag') : null;
    cache.set(url, { etag: etag || null, body, at: t });
    saveSoon();
    return new Response(body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  if (isRateLimited(res)) {
    blockedUntil = resetFrom(res, t);
    if (stale) return asResponse(stale);
    if (live) return res;
    throw rateLimitError(blockedUntil);
  }
  return res;
}

// For tests.
function _reset() { entries = null; blockedUntil = 0; liveUntil = 0; cacheFile = null; tokenProvider = null; tokenRejected = false; inFlight.clear(); }

module.exports = { configure, handles, githubGet, goLive, FRESH_MS, LIVE_HEADER, _reset };
