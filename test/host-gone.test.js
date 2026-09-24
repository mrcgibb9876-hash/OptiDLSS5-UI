'use strict';
// The 32-bit route's DLSS work runs in a second process -- the Feeder's 64-bit helper in host64\
// beside the game (legacy.js) -- and frames cross a process boundary to reach it. When that helper
// dies the game carries on rendering perfectly and the feed simply stops, which is the hardest
// shape there is to report: to the player, DLSS 5 "does nothing".
//
// Reported through the Feeder's own panel, 2026-09-24: "Stopped: the 64-bit host went away -- its
// own dlss5-feed-host.log (in host64\) names the reason", on a Vulkan run with the host not
// running. Before this, none of that reached us: the log it names was not in the support bundle,
// and the run matched no rule -- "The feed stops here" is not what the Feeder writes for this -- so
// it fell through to no-dlss, which Game Help answers with "no known fix".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir } = require(path.join(__dirname, 'helpers'));
const runlog = require(path.join(__dirname, '..', 'src', 'runlog'));
const legacy = require(path.join(__dirname, '..', 'src', 'legacy'));
const { diagnose } = require(path.join(__dirname, '..', 'src', 'gamehelp'));

// Two real reason lines, quoted from runs in the wild. They are different faults with different
// answers, which is the whole reason the line is kept verbatim rather than paraphrased.
const STARTUP = '[feed32] host lost: exited during startup with code 1 (it rejected its own command line -- see dlss5-feed-host.log) (exit code 1)';
const MIDRUN = '[feed32] host lost: frame message failed (exit code 3765269347)';
const STOPPED = 'stopped: the 64-bit host went away -- its own dlss5-feed-host.log (in host64\\) names the reason. The game renders normally. See dlss5-feed.log for the detail.';

function feedOnly(name, body) {
  const dir = scratchDir(name);
  fs.writeFileSync(path.join(dir, 'dlss5-feed.log'), body, 'utf8');
  return dir;
}

test('a dead helper is its own verdict, and the reason rides with it verbatim', async () => {
  const run = await runlog.analyzeRun(feedOnly('hg-midrun', `${MIDRUN}\n${STOPPED}\n`));
  assert.equal(run.ran, true, 'the Feeder judged this run; there being no OptiScaler.log is the point');
  assert.equal(run.verdict, 'feed-host-gone');
  assert.equal(run.feedHostGone, true);
  // Verbatim: "frame message failed" and "rejected its own command line" are not the same problem.
  assert.match(run.detail, /frame message failed/);
});

test('the Feeder\'s stopped line alone is enough -- the host lost line may be past the read cap', async () => {
  const run = await runlog.analyzeRun(feedOnly('hg-stopped', `${STOPPED}\n`));
  assert.equal(run.verdict, 'feed-host-gone');
  assert.equal(run.feedHostLost, null, 'nothing to quote, and nothing invented');
});

test('a crashed model keeps the verdict, because on this route it is what killed the helper', async () => {
  const dir = feedOnly('hg-model', [
    '[feed] evaluate raised 0xC0000005 (reading address FFFFFFFFFFFFFFFF) (caught; nothing submitted)',
    'stopped: the DLSS evaluate crashed (...)',
    MIDRUN,
    STOPPED,
  ].join('\n'));
  const run = await runlog.analyzeRun(dir);
  // The evaluate runs INSIDE the helper, so both are true at once. The model is the cause.
  assert.equal(run.verdict, 'nr-model-crash');
  assert.equal(run.feedHostGone, true, 'still reported, so the digest still says the helper died');
});

test('the helper\'s own log reaches the bundle, from host64 as well as beside the game', async () => {
  const dir = scratchDir('hg-bundle');
  const host = path.join(dir, 'host64');
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dlss5-feed.log'), STOPPED, 'utf8');
  fs.writeFileSync(path.join(host, 'dlss5-feed-host.log'), 'host says why\n', 'utf8');
  const { files } = await runlog.gatherSupportFiles(dir, { optiDir: host, extra: {} });
  const names = files.map((f) => f.name);
  // Named for where it came from: the file the Feeder's panel sends the user to is in host64\.
  assert.ok(names.includes('host64-dlss5-feed-host.log'), names.join(', '));
});

test('the digest names the file, because the panel already sends the user to it', () => {
  const text = runlog.reportDigest({ ran: true, verdict: 'feed-host-gone', at: '2026-09-24T18:18:00.000Z', feedHostGone: true, feedHostLost: 'frame message failed (exit code 3765269347)' });
  assert.match(text, /64-bit helper: frame message failed/);
  assert.match(text, /host64\\dlss5-feed-host\.log/);
});

test('Game Help splits the two shapes: Install rebuilds a startup refusal, a crash gets the log', () => {
  const ctx = (verdict, detail) => ({
    detected: { api: 'dx9', bitness: 32, antiCheat: null },
    // optiInstalled: on this route OptiScaler lives inside the helper folder as winmm.dll
    // (route.js: bitness 32 + legacyStatus.hostOptiScaler), and it is still there -- it is the exe
    // beside it that died. Without this the generic not-installed rule answers first.
    route: { route: 'feeder32', optiInstalled: true, complete: true, legacy: { host32: true } },
    run: { ran: true, verdict, detail },
    foreign: [], fixesTried: [], frameGen: [],
  });
  const startup = diagnose(ctx('feed-host-gone', 'exited during startup with code 1 (it rejected its own command line)'));
  assert.equal(startup.status, 'fix');
  assert.equal(startup.fix.id, 'install', 'mismatched halves are what one download rebuilds');

  const midrun = diagnose(ctx('feed-host-gone', 'frame message failed (exit code 3765269347)'));
  assert.equal(midrun.status, 'step');
  assert.equal(midrun.code, 'feed-host-gone');
  // This app cannot see inside another process, so it names the log rather than guessing.
  assert.match(midrun.vars.why, /frame message failed/);
});

test('the helper exe removed after we wrote it is antivirus, not an incomplete install', () => {
  const dir = scratchDir('hg-exe');
  const host = path.join(dir, 'host64');
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dlss5-feed.addon32'), 'x');
  fs.writeFileSync(path.join(dir, '.dlss5ui-legacy.json'), JSON.stringify({
    host32: true, files: ['host64/dlss5-feed-host64.exe', 'host64/winmm.dll'],
  }), 'utf8');
  fs.writeFileSync(path.join(host, 'winmm.dll'), 'x');

  const gone = legacy.status(dir);
  assert.equal(gone.hostExeGone, true, 'our marker lists it, so it was removed rather than never placed');
  assert.equal(gone.feeder32, false, 'and this is exactly why the route reads as unfinished');

  // Which is the trap: without the flag, "unfinished" means Game Help offers Install, and Install
  // writes the file straight back into whatever is deleting it.
  const advice = diagnose({
    detected: { api: 'dx9', bitness: 32, antiCheat: null },
    route: { route: 'feeder32', optiInstalled: true, complete: false, hostExeGone: true, legacy: { host32: true } },
    run: { ran: false, verdict: 'no-log' },
    foreign: [], fixesTried: [], frameGen: [],
  });
  assert.equal(advice.status, 'step');
  assert.equal(advice.code, 'host32-exe-gone');

  fs.writeFileSync(path.join(host, 'dlss5-feed-host64.exe'), 'x');
  assert.equal(legacy.status(dir).hostExeGone, false);
});

test('an exe that was never placed is not an exe that was removed', () => {
  const dir = scratchDir('hg-never');
  fs.mkdirSync(path.join(dir, 'host64'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dlss5ui-legacy.json'), JSON.stringify({ host32: true, files: [] }), 'utf8');
  assert.equal(legacy.status(dir).hostExeGone, false);
});
