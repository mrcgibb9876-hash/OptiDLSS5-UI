'use strict';
// When NGX refuses to create DLSS, OptiScaler quietly substitutes another upscaler and the run looks
// clean. The verdict for that has existed for a while; what it did NOT have was the reason.
//
// Uncharted (2026-09-24) is the case. The result was BAD0000B and the advice was "check
// nvngx_dlss.dll is beside the exe and that the game's own settings ask for DLSS" -- both of which
// were already true: a full 58 MB nvngx_dlss.dll was in the folder and OptiScaler.ini said
// `Dx12Upscaler = dlss`. BAD0000B is FAIL_UnableToInitializeFeature, "feature is not available on
// the system", which is neither of those things. So the code is decoded now, from NVIDIA's own
// header, and nvngx.log -- NGX's own log, which was sitting in that folder uncollected -- is in the
// bundle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir } = require(path.join(__dirname, 'helpers'));
const runlog = require(path.join(__dirname, '..', 'src', 'runlog'));
const { diagnose } = require(path.join(__dirname, '..', 'src', 'gamehelp'));

test('the NGX result codes decode to NVIDIA\'s own wording, and an unknown one stays undecoded', () => {
  // Spot-checked against external/nvngx_dlss_sdk/nvsdk_ngx_defs.h in the engine: the failure base is
  // 0xBAD00000 and the reason is the low nibble, so B is `| 11`, the eleventh entry.
  assert.match(runlog.ngxResultName('BAD0000B'), /^UnableToInitializeFeature -- feature is not available on the system$/);
  assert.match(runlog.ngxResultName('BAD00001'), /^FeatureNotSupported/);
  assert.match(runlog.ngxResultName('BAD0000A'), /^MissingInput/);
  assert.match(runlog.ngxResultName('BAD0000D'), /OutOfGPUMemory/);
  assert.match(runlog.ngxResultName('BAD00012'), /NotImplemented/);
  assert.equal(runlog.ngxResultName('1'), 'Success');

  // Never guessed at. A wrong name is worse than the hex, which at least searches.
  assert.equal(runlog.ngxResultName('BAD000FF'), null);
  assert.equal(runlog.ngxResultName('ZZZZZZZZ'), null);
  assert.equal(runlog.ngxResultName(null), null);
  assert.equal(runlog.ngxResultName(''), null);
});

test('the reporter\'s own log lines produce the fallback verdict with the reason attached', async () => {
  const dir = scratchDir('ngx-fallback');
  // Verbatim from the Uncharted bundle.
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'), [
    '[10:25:59.300882] [I] TryCreateOptiFeature Creating OptiScaler feature, HandleId: 1000000',
    '[10:25:59.801311] [I] DLSSFeatureDx12::InitDLSS Creating DLSS feature',
    '[10:25:59.801385] [E] DLSSFeatureDx12::InitDLSS _CreateFeature result: BAD0000B',
    "[10:25:59.801397] [E] TryCreateOptiFeature Feature 'DLSS' initialization failed falling back to FSR 2.1.2",
    '[10:26:01.939830] [I] FeatureProvider_Dx12::ChangeFeature init successful for FSR 2.1.2, upscaler changed',
  ].join('\n') + '\n');

  const run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'sr-backend-fallback');
  assert.deepEqual(run.srBackendFallback, { from: 'DLSS', to: 'FSR 2.1.2' });
  assert.equal(run.srCreateResult, 'BAD0000B');
  assert.match(run.srCreateResultName, /UnableToInitializeFeature/);

  // The digest carries the meaning, not just the code -- this is the line a triager reads.
  assert.match(runlog.reportDigest(run), /DLSS could not be created \(BAD0000B: UnableToInitializeFeature -- feature is not available on the system\), fell back to FSR 2\.1\.2/);
});

test('Game Help hands the decoded reason on, and says nothing false when it cannot decode one', () => {
  const ctx = (result, name) => ({
    detected: { bitness: 64 },
    route: { route: 'reframework-pd', optiInstalled: true },
    run: { ran: true, verdict: 'sr-backend-fallback', detail: 'FSR 2.1.2', srCreateResult: result, srCreateResultName: name },
  });
  const known = diagnose(ctx('BAD0000B', 'UnableToInitializeFeature -- feature is not available on the system'));
  assert.equal(known.code, 'sr-backend-fallback');
  assert.equal(known.vars.result, 'BAD0000B');
  assert.match(known.vars.why, /UnableToInitializeFeature/);

  // An undecoded code still reports, with an empty reason rather than an invented one: the renderer
  // picks its older wording on that, which sends the reader to the log instead of to a guess.
  const unknown = diagnose(ctx('BAD000FF', null));
  assert.equal(unknown.vars.result, 'BAD000FF');
  assert.equal(unknown.vars.why, '');
});

test('nvngx.log is collected, because it is the only file that says more than the code', async () => {
  const dir = scratchDir('ngx-bundle');
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'), 'x\n');
  fs.writeFileSync(path.join(dir, 'nvngx.log'), 'NGX says why here\n');
  const { files } = await runlog.gatherSupportFiles(dir, { extra: {} });
  assert.ok(files.some((f) => f.name === 'nvngx.log'), 'nvngx.log should be in the bundle');

  // And a folder without one is not a problem: the bundle only ever collects what exists.
  const bare = scratchDir('ngx-bundle-bare');
  fs.writeFileSync(path.join(bare, 'OptiScaler.log'), 'x\n');
  const { files: bareFiles } = await runlog.gatherSupportFiles(bare, { extra: {} });
  assert.ok(!bareFiles.some((f) => f.name === 'nvngx.log'));
});
