'use strict';
// Choosing the proxy DLL name by hand. The app picks it automatically and is right nearly always,
// but OptiScaler's own wiki names a proxy for several games this app has no entry for, and there
// was no way to act on that: a No Man's Sky reporter (#132) went through every section of Edit
// looking for the setting before being told it did not exist.
//
// The rule that shapes it: only a name detect.js can read a folder BACK by is offered. Installing
// under a name the scan cannot see is the bug this came out of, and a free-text box would let a
// user reproduce it by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, fakeExe, loadMain } = require('./helpers');
const detect = require('../src/detect');

const MARKER = '.dlss5ui-proxy.json';

test('only names the folder scan can read back are offered, and anything else is refused', async () => {
  const dir = scratchDir('proxy-choice-names');
  const exe = fakeExe(dir, 'Game.exe');
  const { invoke } = loadMain();

  const info = await invoke('game:proxyInfo', { exePath: exe });
  assert.equal(info.ok, true, info.error);
  for (const name of info.names) {
    assert.ok(detect.HOOK_DLLS.includes(name), `${name} is offered and unreadable`);
  }
  assert.ok(info.names.includes('dxgi.dll') && info.names.includes('dbghelp.dll'));

  // The whole point of the list: a name outside it would install an OptiScaler the app then
  // reports as missing, so it is refused rather than accepted and quietly ignored.
  const bad = await invoke('game:setProxyName', { exePath: exe, proxy: 'totally-made-up.dll' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /read back/);
  assert.equal(fs.existsSync(path.join(dir, MARKER)), false, 'and nothing was written');
});

test('a chosen name outranks the automatic answer, and Automatic still reports what that was', async () => {
  const dir = scratchDir('proxy-choice-set');
  const exe = fakeExe(dir, 'Game.exe');
  const { invoke } = loadMain();

  const before = await invoke('game:proxyInfo', { exePath: exe });
  assert.equal(before.chosen, null);
  const automatic = before.automatic;

  const set = await invoke('game:setProxyName', { exePath: exe, proxy: 'dbghelp.dll' });
  assert.equal(set.ok, true, set.error);

  const after = await invoke('game:proxyInfo', { exePath: exe });
  assert.equal(after.chosen, 'dbghelp.dll');
  // Read past the choice: the row says "Automatic (x)" while a different name is selected, so the
  // user can see what they are overruling.
  assert.equal(after.automatic, automatic);

  // Back to Automatic clears the marker rather than storing the automatic name -- a stored copy
  // would go stale the moment the automatic answer changed.
  const cleared = await invoke('game:setProxyName', { exePath: exe, proxy: null });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal((await invoke('game:proxyInfo', { exePath: exe })).chosen, null);
  assert.equal(fs.existsSync(path.join(dir, MARKER)), false);
});

test('the 32-bit route has no proxy beside the exe, and says so instead of moving a file', async () => {
  const dir = scratchDir('proxy-choice-host32');
  const exe = fakeExe(dir, 'Game.exe');
  fs.mkdirSync(path.join(dir, 'host64'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dlss5ui-legacy.json'), JSON.stringify({ host32: true, files: [] }), 'utf8');
  const { invoke } = loadMain();

  // Hidden rather than shown-and-refused: OptiScaler is in host64\ as winmm.dll, loaded by the
  // helper, so there is nothing beside the exe that naming could move.
  const info = await invoke('game:proxyInfo', { exePath: exe });
  assert.equal(info.settable, false);

  const refused = await invoke('game:setProxyName', { exePath: exe, proxy: 'winmm.dll' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /host64/);
  assert.equal(fs.existsSync(path.join(dir, MARKER)), false);
});

test('a stored name that is no longer offered is ignored, not honoured', async () => {
  const dir = scratchDir('proxy-choice-stale');
  const exe = fakeExe(dir, 'Game.exe');
  // Written by a future version, or by hand. Honouring it would install under a name this build
  // cannot read back -- exactly the state the control exists to prevent.
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ proxy: 'nolongeroffered.dll' }), 'utf8');
  const { invoke } = loadMain();
  assert.equal((await invoke('game:proxyInfo', { exePath: exe })).chosen, null);
});

test('the digest says a name was chosen rather than picked', async () => {
  const dir = scratchDir('proxy-choice-digest');
  const exe = fakeExe(dir, 'Game.exe');
  const { invoke } = loadMain();
  await invoke('game:setProxyName', { exePath: exe, proxy: 'winmm.dll' });
  // A report where OptiScaler sits under an unexpected name has to say whether a person put it
  // there or the app did -- otherwise triage spends its first round on the wrong question.
  const runlog = require('../src/runlog');
  const text = runlog.reportDigest({ ran: true, verdict: 'no-dlss', at: 'x' }, { detected: { api: 'vulkan', proxyChoice: 'winmm.dll' } });
  assert.match(text, /proxy: winmm\.dll -- SET BY HAND in Edit/);
});

test("No Man's Sky gets dbghelp.dll automatically, and the user can still overrule it", async () => {
  const dir = scratchDir('proxy-choice-nms');
  const exe = fakeExe(dir, 'NMS.exe');
  const { invoke } = loadMain();

  // PROXY_OVERRIDES, from OptiScaler's own wiki: a Vulkan game with native DLSS is not a Feeder
  // game, so the early-proxy picker never runs for it and it would otherwise get dxgi.dll -- loaded
  // late, for adapter enumeration, after the renderer is already up.
  const info = await invoke('game:proxyInfo', { exePath: exe });
  assert.equal(info.automatic, 'dbghelp.dll');
  assert.equal(info.chosen, null, 'automatic, not a stored choice');

  // And the entry is unmeasured, so being able to undo it is the condition of shipping it.
  const set = await invoke('game:setProxyName', { exePath: exe, proxy: 'dxgi.dll' });
  assert.equal(set.ok, true, set.error);
  const after = await invoke('game:proxyInfo', { exePath: exe });
  assert.equal(after.chosen, 'dxgi.dll');
  assert.equal(after.automatic, 'dbghelp.dll', 'the row still shows what is being overruled');
});
