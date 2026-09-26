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

// ── findings that were wired to one route's log ────────────────────────────────────────────────

test('the Agility redist error is read from OptiScaler.log, not only the Feeder\'s', async () => {
  // D3D12_ERROR_INVALID_REDIST is the GAME's own Agility SDK refusing every device create. It has
  // nothing to do with the Feeder being present, but only `feed` was ever tested -- so on the
  // Present route, where there is no feed log at all, the identical line was invisible and the run
  // fell through to no-dlss with no explanation. Same shape as the Smooth Motion blind spot.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'redist-'));
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'),
    '[00:00:01.000] [W] OptiScaler v2.1.0 loaded\n'
    + '[00:00:02.000] [E] D3D12CreateDevice failed: 0x887E0003 D3D12_ERROR_INVALID_REDIST\n');
  const run = await runlog.analyzeRun(dir);
  assert.equal(run.feedInvalidRedist, true, 'seen with no Feeder log in the folder');
  assert.equal(run.verdict, 'feed-agility-redist');
});

test('the neural pass is counted by its message, not by the function that logged it', async () => {
  // The prefix in a log line is __FUNCTION__ at runtime, so requiring "DlssNr_Dx12::Dispatch "
  // coupled this to one build's internal structure. wilsjo2/OptiScaler-DLSSNR-PreSR-Multipass moved
  // the same work into a State class, and Max Payne 3 (2026-09-25) reported dlss-no-nr with the pass
  // running 2 passes at 2316x1302 and 23 ms of model time.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nrmsg-'));
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'),
    '[00:00:01.000] [W] OptiScaler v2.1.0 loaded\n'
    + '[00:00:02.000] [I] DlssNr_Dx12::State::Run DLSS-NR model passes: configured 2, effective 2\n'
    + '[00:00:03.000] [I] DlssNr_Dx12::State::MakeResolveConstants DLSS-NR composition: paper white 1.00x\n');
  const run = await runlog.analyzeRun(dir);
  assert.ok(run.nrDispatch > 0, 'a fork that renamed the function still reports its pass');
  assert.equal(run.verdict, 'nr-ran');
});

test('our own engine\'s wording still counts, and an idle log still does not', async () => {
  const os = require('node:os');
  const ours = fs.mkdtempSync(path.join(os.tmpdir(), 'nrours-'));
  fs.writeFileSync(path.join(ours, 'OptiScaler.log'),
    '[00:00:01.000] [W] OptiScaler v2.1.0 loaded\n'
    + '[00:00:02.000] [I] DlssNr_Dx12::Dispatch DLSS-NR running native SR: target 2560x1440, model 2560x1440\n');
  assert.equal((await runlog.analyzeRun(ours)).verdict, 'nr-ran');

  // The regexes must not fire on a log that merely mentions the feature. A false "the pass ran" is
  // worse than the false negative this replaced: it closes a real report as working.
  const idle = fs.mkdtempSync(path.join(os.tmpdir(), 'nridle-'));
  fs.writeFileSync(path.join(idle, 'OptiScaler.log'),
    '[00:00:01.000] [W] OptiScaler v2.1.0 loaded\n'
    + '[00:00:02.000] [I] DLSS-NR proxy probe: feature 18 -> 0x1 (ok)\n'
    + '[00:00:03.000] [I] DlssNr::ExposureScan::NoteResource DLSS-NR scan near-miss #6: UAV dim 1\n'
    + '[00:00:04.000] [I] MenuHdrCheck Output HDR: false\n');
  const run = await runlog.analyzeRun(idle);
  assert.equal(run.nrDispatch, 0, 'probes and scan near-misses are not a dispatched pass');
  assert.notEqual(run.verdict, 'nr-ran');
});
