'use strict';
// The Feeder deploy's network edges and its Unity profile: a host's bad minute is retried and
// mirrored rather than shown to the user, the two ReShade headers are cached after the first
// fetch, and a Unity game gets the Generic Depth settings its depth needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { scratchDir, write } = require('./helpers');
const feeder = require(path.join(__dirname, '..', 'src', 'feeder'));

const HEADER = '#pragma once\n#include "ReShadeUI.fxh"\n';
const okResponse = (text) => ({ ok: true, status: 200, text: async () => text });
const failResponse = (status) => ({ ok: false, status, text: async () => 'Service Unavailable' });

test('a 503 is retried and then succeeds; a 404 is final at once', async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? failResponse(503) : okResponse(HEADER));
  const res = await feeder.fetchWithRetry('https://x/a', {}, { fetchImpl: flaky, pauses: [0, 0, 0] });
  assert.equal(res.ok, true);
  assert.equal(calls, 3);

  let gone = 0;
  const missing = async () => { gone++; return failResponse(404); };
  const res404 = await feeder.fetchWithRetry('https://x/b', {}, { fetchImpl: missing, pauses: [0, 0, 0] });
  assert.equal(res404.status, 404);
  assert.equal(gone, 1);
});

test('a ReShade header comes from the mirror when GitHub keeps failing, and an error page is not accepted', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('raw.githubusercontent.com')) return failResponse(503);
    return okResponse(HEADER);
  };
  const text = await feeder.fetchReShadeHeader('ReShade.fxh', { 'User-Agent': 't' }, { fetchImpl, pauses: [0] });
  assert.equal(text, HEADER);
  assert.ok(seen.some((u) => u.includes('cdn.jsdelivr.net')), 'mirror was tried');

  const htmlOnly = async () => okResponse('<html><body>Cloudflare</body></html>');
  await assert.rejects(() => feeder.fetchReShadeHeader('ReShade.fxh', { 'User-Agent': 't' }, { fetchImpl: htmlOnly, pauses: [] }), /did not return a shader header|Could not fetch/);
});

test('the headers are fetched once per machine: the second deploy reads the cache, no network', async () => {
  const cacheDir = path.join(scratchDir('feeder-cache'), 'cache');
  const gameA = scratchDir('feeder-game-a');
  const gameB = scratchDir('feeder-game-b');
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return okResponse(HEADER); };
  const first = await feeder.deployReShadeCommonHeaders(gameA, { 'User-Agent': 't' }, { cacheDir, fetchImpl, pauses: [] });
  assert.deepEqual(first.files, ['ReShade.fxh', 'ReShadeUI.fxh']);
  assert.equal(fetches, 2);
  const second = await feeder.deployReShadeCommonHeaders(gameB, { 'User-Agent': 't' }, { cacheDir, fetchImpl, pauses: [] });
  assert.deepEqual(second.files, ['ReShade.fxh', 'ReShadeUI.fxh']);
  assert.equal(fetches, 2, 'served from the cache');
  assert.equal(fs.readFileSync(path.join(gameB, 'reshade-shaders', 'Shaders', 'ReShade.fxh'), 'utf8'), HEADER);
});

test('a Unity game gets copy-before-clears and reversed depth, without losing what the ini already said', () => {
  const dir = scratchDir('feeder-unity');
  write(dir, 'ReShade.ini', '[GENERAL]\nPreprocessorDefinitions=RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000.0\n\n[DEPTH]\nUseAspectRatioHeuristics=3\n');
  feeder.configureReShadeIni(dir, { unity: true });
  const ini = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
  assert.match(ini, /DepthCopyBeforeClears=1/);
  assert.match(ini, /UseAspectRatioHeuristics=3/);
  assert.match(ini, /PreprocessorDefinitions=RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000\.0,RESHADE_DEPTH_INPUT_IS_REVERSED=1/);

  // A value someone already chose stays; the definition is not added twice.
  write(dir, 'ReShade.ini', '[DEPTH]\nDepthCopyBeforeClears=2\n[GENERAL]\nPreprocessorDefinitions=RESHADE_DEPTH_INPUT_IS_REVERSED=0\n');
  feeder.configureReShadeIni(dir, { unity: true });
  const kept = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
  assert.match(kept, /DepthCopyBeforeClears=2/);
  assert.equal((kept.match(/RESHADE_DEPTH_INPUT_IS_REVERSED/g) || []).length, 1);
  assert.match(kept, /RESHADE_DEPTH_INPUT_IS_REVERSED=0/);

  // Not Unity: neither key is written.
  const plain = scratchDir('feeder-plain');
  feeder.configureReShadeIni(plain);
  const none = fs.readFileSync(path.join(plain, 'ReShade.ini'), 'utf8');
  assert.doesNotMatch(none, /DepthCopyBeforeClears|RESHADE_DEPTH_INPUT_IS_REVERSED/);
});
