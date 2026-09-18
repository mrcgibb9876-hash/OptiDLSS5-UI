// How main.js uses the watched launch's stored facts (src/probe.js): the card's route follows them,
// Edit still wins, the proxy helpers read the hint, and a changed exe drops them. Facts are written
// straight into the test userData -- no game is started.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const probe = require('../src/probe');
const { scratchDir, fakeExe, loadMain } = require('./helpers');

const facts = (over = {}) => ({
  version: probe.PROBE_VERSION, capturedAt: new Date().toISOString(), method: 'etw', started: true,
  api: 'dx12', apiEvidence: 'D3D12Core.dll loaded', apiUncertain: false, moduleCount: 120,
  proxies: [{ name: 'dxgi.dll', order: 3 }, { name: 'winmm.dll', order: 1 }], ignoredProxies: [], ...over,
});

test('a stored watched launch sets the route\'s API, and Edit still overrides it', async () => {
  const dir = scratchDir('wiring-api');
  const exe = fakeExe(dir, 'Game.exe');
  const { invoke, userData } = loadMain();
  probe.writeFacts(path.join(userData, 'probe-facts.json'), exe, facts({ api: 'dx12' }));

  const summary = await invoke('game:probe-facts', { exePath: exe });
  assert.equal(summary.summary.api, 'dx12');
  // Static detection alone would say DX11 here (DX11 is all it found).
  const route = await invoke('game:route', { exePath: exe, detected: { api: 'dx11', apis: ['dx11'], bitness: 64, recommend: 'optiscaler' } });
  assert.equal(route.effectiveApi, 'dx12');

  const set = await invoke('game:setApiOverride', { exePath: exe, api: 'dx11' });
  assert.equal(set.ok, true, set.error);
  const overridden = await invoke('game:route', { exePath: exe, detected: { api: 'dx11', apis: ['dx11', 'dx12'], bitness: 64, recommend: 'optiscaler' } });
  assert.equal(overridden.effectiveApi, 'dx11');
  await invoke('game:setApiOverride', { exePath: exe, api: null });
});

test('the facts expire when the exe changes (a game update)', async () => {
  const dir = scratchDir('wiring-expire');
  const exe = fakeExe(dir, 'Game.exe');
  const { invoke, userData } = loadMain();
  probe.writeFacts(path.join(userData, 'probe-facts.json'), exe, facts());
  assert.equal((await invoke('game:probe-facts', { exePath: exe })).summary.api, 'dx12');
  fs.appendFileSync(exe, Buffer.alloc(64));
  assert.equal((await invoke('game:probe-facts', { exePath: exe })).summary, null);
});

test('the proxy hint rides along: dxgi.dll ignored in favour of System32\'s means winmm.dll (the RDR2 shape)', async () => {
  const dir = scratchDir('wiring-proxy');
  const exe = fakeExe(dir, 'Game.exe');
  const { invoke, userData } = loadMain();
  probe.writeFacts(path.join(userData, 'probe-facts.json'), exe, facts({ ignoredProxies: ['dxgi.dll'] }));
  assert.equal((await invoke('game:probe-facts', { exePath: exe })).proxyHint, 'winmm.dll');
  probe.writeFacts(path.join(userData, 'probe-facts.json'), exe, facts());
  assert.equal((await invoke('game:probe-facts', { exePath: exe })).proxyHint, null, 'dxgi.dll loaded from the folder is fine');
});

test('the analysis handlers are registered and refuse a missing exe without starting anything', async () => {
  const { handlers, invoke } = loadMain();
  for (const ch of ['game:probe', 'game:probe-facts', 'game:preflight', 'game:preflight-fix', 'game:verify']) assert.ok(handlers[ch], ch);
  const missing = path.join(scratchDir('wiring-missing'), 'nope.exe');
  for (const ch of ['game:probe', 'game:preflight', 'game:preflight-fix', 'game:verify']) {
    const res = await invoke(ch, { exePath: missing });
    assert.equal(res.ok, false, ch);
  }
});
