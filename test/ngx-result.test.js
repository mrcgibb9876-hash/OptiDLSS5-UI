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

// nvngx.log turned out to carry more than the refusal reason, and one hazard.
//
// The hazard: NGX writes it into the process's WORKING directory and only when its logging hooks
// initialise, so the copy beside the exe can be from another launch entirely. The Uncharted log ended
// 25 hours before the failing run and NGX wrote nothing during the failure itself. Read as this run's
// account of itself it is worse than no log at all -- so the age is stated every time.
//
// The finding: "Feature dlss override enabled" plus a snippet loaded out of
// C:\ProgramData\NVIDIA\NGX\models means the driver substituted its own DLSS for the one this app
// placed. For an app whose job is putting those DLLs in the folder and letting people choose a
// version, that is worth saying out loud.
const NGX_UNCHARTED = [
  '[2026-09-23 09:17:11] [NGXSafeInitializeLog:139] App logging hooks successfully initialized',
  '[2026-09-23 09:17:12] [NGXSecureLoadFeature:1348] Feature dlss override enabled',
  '[2026-09-23 09:17:12] [NGXSecureLoadFeature:1499] app 876232C feature dlss snippet: C:\\ProgramData\\NVIDIA\\NGX\\models\\dlss\\versions\\20318464\\files/160_E658700.bin version: 310.9.0',
  '[2026-09-23 09:17:12] [NGXSecureLoadFeature:1348] Feature dlssg override enabled',
  '[2026-09-23 09:17:12] [NGXSecureLoadFeature:1499] app 876232C feature dlssg snippet: C:\\ProgramData\\NVIDIA\\NGX\\models\\dlssg\\versions\\20318464\\files/160_E658700.bin version: 310.9.0',
  '[2026-09-23 09:22:02] [NGXNVAPITelemetryShutdown:124] warning: attempted to shut down telemetry without an active instance',
].join('\n') + '\n';

async function withNgx(name, ngxText, runAt) {
  const dir = scratchDir(name);
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'), 'DLSS-NR heartbeat: 600 frames run (0 model failures), 60 fps, GPU 2.10 ms |\n');
  if (ngxText !== null) fs.writeFileSync(path.join(dir, 'nvngx.log'), ngxText);
  // analyzeRun dates the run from OptiScaler.log's mtime, so the gap is set by moving that.
  if (runAt) fs.utimesSync(path.join(dir, 'OptiScaler.log'), runAt, runAt);
  return runlog.analyzeRun(dir);
}

test('a stale nvngx.log is called stale, in the direction and by the gap', async () => {
  // The real one: log ends 2026-09-23 09:22, run a day later.
  const run = await withNgx('ngx-stale', NGX_UNCHARTED, new Date('2026-09-24T10:27:10Z'));
  assert.equal(run.ngx.lastAt, '2026-09-23 09:22:02');
  assert.match(runlog.reportDigest(run), /nvngx\.log: its last line is 2026-09-23 09:22:02, about 25 h BEFORE this run: it describes a DIFFERENT launch/);
});

test('a small gap is never called a different launch, because NGX stamps local time with no zone', async () => {
  // NGX writes local time; the run is dated in UTC. A machine at UTC+13 would otherwise have every
  // log it ever wrote reported as "13 h before this run", which is an invented finding.
  const near = await withNgx('ngx-near', NGX_UNCHARTED, new Date('2026-09-23T22:00:00Z'));
  assert.match(runlog.reportDigest(near), /nvngx\.log: its last line is 2026-09-23 09:22:02 \(NGX's own clock\) -- around this run/);
  assert.doesNotMatch(runlog.reportDigest(near), /DIFFERENT launch/);
});

test('the override is reported per feature, with the upscaler first', async () => {
  const run = await withNgx('ngx-override', NGX_UNCHARTED, new Date('2026-09-23T09:30:00Z'));
  assert.deepEqual(run.ngx.overrides, ['dlss', 'dlssg']);
  const digest = runlog.reportDigest(run);
  assert.match(digest, /ngx override: dlss, dlssg -- the driver loads its own copy/);
  // dlss before dlssg, whatever order the log listed them in: an upscaling question is answered by
  // the upscaler's line, and taking the log's last snippet answered with frame generation instead.
  assert.ok(digest.indexOf('ngx dlss:') < digest.indexOf('ngx dlssg:'), 'the upscaler is named first');
  assert.match(digest, /ngx dlss: 310\.9\.0 loaded from C:\\ProgramData\\NVIDIA\\NGX\\models\\dlss\\/);
});

test('a snippet loaded from the game folder is not reported as a substitution', async () => {
  const dir = scratchDir('ngx-ownfolder');
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'), 'x\n');
  fs.writeFileSync(path.join(dir, 'nvngx.log'),
    '[2026-09-23 09:17:12] [NGXSecureLoadFeature:1499] app 876232C feature dlss snippet: '
    + path.join(dir, 'nvngx_dlss.dll') + ' version: 310.9.1\n');
  const run = await runlog.analyzeRun(dir);
  assert.equal(run.ngx.snippets.dlss.fromGameFolder, true);
  // Nothing was substituted, so there is nothing to report -- only the age line stands.
  assert.doesNotMatch(runlog.reportDigest(run), /ngx dlss:/);
  assert.doesNotMatch(runlog.reportDigest(run), /ngx override:/);
});

test('no nvngx.log at all says nothing, rather than implying one was expected', async () => {
  const run = await withNgx('ngx-absent', null, new Date('2026-09-24T10:00:00Z'));
  assert.equal(run.ngx, null);
  assert.doesNotMatch(runlog.reportDigest(run), /nvngx\.log/);
});
