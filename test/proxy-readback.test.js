'use strict';
// Every name this app can INSTALL OptiScaler under has to be a name it can READ BACK. Those were
// two hand-kept lists and they had drifted: main.js would install a Vulkan, OpenGL or DirectX 9
// Feeder game's OptiScaler under the first of EARLY_PROXY_CANDIDATES the exe imports -- winmm,
// version, dbghelp, wininet or winhttp -- while detect.js scanned only the first two of those.
//
// A game importing dbghelp.dll but neither winmm.dll nor version.dll therefore got an OptiScaler
// the app could no longer see: the folder read came back empty, the route read as "not installed
// yet", and Install would write a second copy beside the first. Found from a No Man's Sky report
// (#132, 2026-09-25) asking where the proxy name is changed -- the honest answer being that the
// app can install under a name it cannot read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir } = require(path.join(__dirname, 'helpers'));
const detect = require(path.join(__dirname, '..', 'src', 'detect'));

// Over the scan's floor, and carrying the string the scan actually keys on.
const optiScalerBytes = () => Buffer.concat([
  Buffer.from('MZ'), Buffer.alloc(4096, 0x41), Buffer.from('OptiScaler', 'latin1'), Buffer.alloc(4096, 0x42),
]);

test('the read list covers every name the app can install under', () => {
  for (const name of detect.EARLY_PROXY_CANDIDATES) {
    assert.ok(detect.HOOK_DLLS.includes(name), `${name} is installable and unreadable`);
  }
  // Structural, not a copy: one list feeding the other is what stops this drifting again.
  assert.ok(detect.HOOK_DLLS.includes('dxgi.dll'), 'and the ordinary Direct3D name is still there');
  assert.equal(new Set(detect.HOOK_DLLS).size, detect.HOOK_DLLS.length, 'no duplicates from the merge');
});

test('an OptiScaler installed as dbghelp.dll is found, not invisible', async () => {
  const dir = scratchDir('proxy-dbghelp');
  fs.writeFileSync(path.join(dir, 'dbghelp.dll'), optiScalerBytes());
  const hooks = await detect.inspectHookDlls(dir);
  assert.ok(hooks.optiScalerProxy, 'the folder read saw nothing at all');
  assert.equal(hooks.optiScalerProxy.file, 'dbghelp.dll');
});

test("a game's own genuine dbghelp.dll is read and passed over", async () => {
  const dir = scratchDir('proxy-real-dbghelp');
  // Microsoft's debug helper ships beside plenty of games. The scan is gated on CONTENT, which is
  // what makes widening the name list safe: no OptiScaler string, no finding.
  fs.writeFileSync(path.join(dir, 'dbghelp.dll'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(8192, 0x43)]));
  const hooks = await detect.inspectHookDlls(dir);
  assert.equal(hooks.optiScalerProxy, null);
  assert.equal(hooks.reshadeProxy, null);
});

test('a stored detection from before the fix is not kept', () => {
  // It would go on answering "no OptiScaler here" for exactly the folders this changes.
  assert.ok(detect.DETECT_VERSION >= 21);
});
