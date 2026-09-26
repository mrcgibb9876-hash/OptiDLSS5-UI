'use strict';
// Reading the Unreal crash report for WHO faulted, not just what the message said.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runlog = require('../src/runlog');


// ── whose crash was it ─────────────────────────────────────────────────────────────────────────
//
// The Unreal crash report is collected into every bundle and only its <ErrorMessage> was ever read,
// which is the one line that does NOT say who faulted. Silent Hill: Townfall (2026-09-26) died
// reading 0x18 with five NvPresent64 frames under FD3D12Viewport::PresentInternal and OptiScaler
// nowhere on the stack; the answer was in the bundle from the start.
//
// The fixture is that real report with LoginId, EpicAccountId, MachineId, CrashGUID and
// ExecutionGuid zeroed. It is kept real because a hand-written one would have matched whatever
// regex was written first -- the frame shapes here are the point.
const CRASH_XML = fs.readFileSync(path.join(__dirname, 'fixtures', 'townfall-CrashContext.runtime-xml'), 'latin1');

test('the crashing thread\'s modules are read innermost first, and only that thread\'s', () => {
  const mods = runlog.crashModules(CRASH_XML);
  assert.deepEqual(mods, ['D3D12Core', 'NvPresent64', 'Townfall_Win64_Shipping']);
  // The file has a <CallStack> per thread inside <Threads>; only the first one faulted. GameThread
  // frames leaking in here would make every crash look like it happened everywhere at once.
  assert.ok(!mods.includes('KERNEL32'), 'the unsymbolised PCallStack is a fallback, not a supplement');
});

test('all three frame shapes in a real report yield the module', () => {
  // bare, module!symbol with a source path, and module + offset -- the three the file mixes.
  const mods = runlog.crashModules(`<CallStack>
D3D12Core
Game_Win64_Shipping!FD3D12Viewport::Present() [C:\\jenkins\\D3D12Viewport.cpp:604]
nvwgf2umx.dll 0x00007ff9 + 47f60
</CallStack>`);
  assert.deepEqual(mods, ['D3D12Core', 'Game_Win64_Shipping', 'nvwgf2umx']);
});

test('PCallStack is used only when there is no symbolised stack', () => {
  const only = runlog.crashModules('<PCallStack>\nNvPresent64 0x1 + 2\nKERNEL32 0x3 + 4\n</PCallStack>');
  assert.deepEqual(only, ['NvPresent64', 'KERNEL32']);
  const both = runlog.crashModules('<CallStack>\nD3D12Core\n</CallStack><PCallStack>\nOther 0x1 + 2\n</PCallStack>');
  assert.deepEqual(both, ['D3D12Core'], 'the symbolised stack wins');
});

test('a report with no stack at all is empty, not a throw', () => {
  assert.deepEqual(runlog.crashModules('<RuntimeProperties></RuntimeProperties>'), []);
  assert.deepEqual(runlog.crashModules(''), []);
  assert.deepEqual(runlog.crashModules('<CallStack></CallStack>'), []);
});

test('the digest carries the crash stack, and the triage parser reads it back', () => {
  const digest = require('../src/digest');
  const run = {
    ran: true, verdict: 'nvpresent-crash', detail: 'D3D12Core', at: '2026-09-26T06:42:50Z',
    crash: { message: 'EXCEPTION_ACCESS_VIOLATION reading address 0x18', modules: runlog.crashModules(CRASH_XML) },
  };
  const text = runlog.reportDigest(run, {});
  assert.match(text, /crash stack: D3D12Core < NvPresent64 < Townfall_Win64_Shipping/);

  // The whole point: triage can tell whose crash it is from an issue body, with no bundle.
  const parsed = digest.parseDigest(text);
  assert.equal(parsed.verdict, 'nvpresent-crash');
  assert.deepEqual(parsed.crashStack, ['D3D12Core', 'NvPresent64', 'Townfall_Win64_Shipping']);
  assert.equal(parsed.nvPresent, true);
  // A crash with nothing of NVIDIA's on it must not read as one.
  const other = digest.parseDigest(runlog.reportDigest({
    ran: true, verdict: 'ue-crash', at: 'x', crash: { message: 'm', modules: ['UnrealEditor-Core', 'Game'] },
  }, {}));
  assert.equal(other.nvPresent, false);
  assert.deepEqual(other.crashStack, ['UnrealEditor-Core', 'Game']);
});
