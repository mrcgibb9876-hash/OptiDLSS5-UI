'use strict';
// A graphics debugger beside the exe WRAPS Direct3D 12: it replaces the device and the command queue
// with its own, and that wrapper carries none of the vendor paths DLSS and XeSS need. FSR 2 and 3 are
// OptiScaler's own compute passes and go straight through. So the tell is an asymmetry -- the two
// hardware upscalers fail while FSR keeps working -- and that is exactly what an Uncharted 4 reporter
// described on 2026-09-24, with a 19 MB renderdoc.dll in the folder.
//
// The discipline this is built with: PRESENCE IS NOT LOADING. Uncharted 4 ships renderdoc.dll itself
// -- its timestamp matches the game's own exe -- and nothing in that reporter's logs put it in the
// process. Naming the file is ours to do; claiming it ran is not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir } = require(path.join(__dirname, 'helpers'));
const detect = require(path.join(__dirname, '..', 'src', 'detect'));
const runlog = require(path.join(__dirname, '..', 'src', 'runlog'));
const { diagnose } = require(path.join(__dirname, '..', 'src', 'gamehelp'));

test('the wrappers are found beside the exe, whatever case they are written in', () => {
  const dir = scratchDir('gd-found');
  fs.writeFileSync(path.join(dir, 'RenderDoc.dll'), 'x');
  fs.writeFileSync(path.join(dir, 'WinPixGpuCapturer.dll'), 'x');
  const found = detect.inspectGraphicsDebuggers(dir);
  assert.deepEqual(found.map((g) => g.tool).sort(), ['PIX GPU capture', 'RenderDoc']);
  // The name is reported as it is on disk, so the user can find the file they have to move.
  assert.equal(found.find((g) => g.tool === 'RenderDoc').file, 'RenderDoc.dll');
});

test('the two files that would be false alarms are not flagged', () => {
  const dir = scratchDir('gd-benign');
  // PIX event markers hook nothing and wrap nothing, and Uncharted 4 ships this very file. Flagging
  // it would accuse every game that ships markers of carrying a debugger.
  fs.writeFileSync(path.join(dir, 'WinPixEventRuntime.dll'), 'x');
  // Microsoft's shader compiler. Shipped by many games, not a debugger.
  fs.writeFileSync(path.join(dir, 'dxcompiler.dll'), 'x');
  assert.equal(detect.inspectGraphicsDebuggers(dir), null);

  // An empty folder and a folder that is not there are both "nothing found", never a throw.
  assert.equal(detect.inspectGraphicsDebuggers(scratchDir('gd-empty')), null);
  assert.equal(detect.inspectGraphicsDebuggers(path.join(dir, 'no-such-folder')), null);
});

test('the digest names the file and refuses to claim it ran', () => {
  const run = { ran: true, at: new Date().toISOString(), verdict: 'nr-ran' };
  const digest = runlog.reportDigest(run, {
    detected: { api: 'dx12', graphicsDebuggers: [{ tool: 'RenderDoc', file: 'renderdoc.dll' }] },
  });
  assert.match(digest, /graphics debugger: RenderDoc \(renderdoc\.dll\)/);
  assert.match(digest, /this app cannot tell whether the game loaded it/);
  // A folder with none says nothing at all about debuggers.
  assert.doesNotMatch(runlog.reportDigest(run, { detected: { api: 'dx12' } }), /graphics debugger/);
});

test('on an FSR fallback the debugger outranks the override advice, because it explains more', () => {
  const base = (detected) => ({
    detected: { bitness: 64, ...detected },
    route: { route: 'reframework-pd', optiInstalled: true },
    run: {
      ran: true, verdict: 'sr-backend-fallback', detail: 'FSR 2.1.2',
      srCreateResult: 'BAD0000B', srCreateResultName: 'UnableToInitializeFeature -- feature is not available on the system',
    },
  });
  // A DLSS Override explains DLSS being refused. It does not explain XeSS failing too, and a debugger
  // does -- so where one is in the folder, that is the answer offered first.
  const withDebugger = diagnose(base({ graphicsDebuggers: [{ tool: 'RenderDoc', file: 'renderdoc.dll' }] }));
  assert.equal(withDebugger.code, 'sr-backend-debugger');
  assert.equal(withDebugger.vars.debugger, 'RenderDoc');
  assert.equal(withDebugger.vars.debuggerFile, 'renderdoc.dll');
  assert.equal(withDebugger.vars.backend, 'FSR 2.1.2');

  // With no debugger in the folder the override advice is unchanged.
  assert.equal(diagnose(base({})).code, 'sr-backend-fallback');
});

test('a stored detection from before this rule is re-read rather than trusted', () => {
  // A detection saved by an older version carries no graphicsDebuggers at all, which is not the same
  // as a folder that was looked at and found clean -- so DETECT_VERSION has to have moved.
  assert.ok(detect.DETECT_VERSION >= 20, `DETECT_VERSION is ${detect.DETECT_VERSION}, expected at least 20`);
});
