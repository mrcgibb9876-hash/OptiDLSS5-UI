// Verify install: after Install, and only when the user asks, start the game for about 30 seconds,
// then read the run the same way Game Help does (runlog.analyzeRun -> gamehelp.diagnose) and close
// the game again. One of three answers:
//   ok     DLSS 5 ran, with the frame count from the log.
//   warn   the game ran and the logs say something is off -- Game Help's own diagnosis, or no fresh
//          log at all, or the game never appeared, or it closed itself cleanly inside the window.
//   crash  the game died inside the window. Remove is OFFERED (the renderer asks); nothing is rolled
//          back here, because a crash can have a cause that has nothing to do with the install and
//          the user may want the files for a report.
//
// LAUNCH AND WAIT ONLY. This never focuses a window, never sends a key, never clicks. Some games die
// on a focus change: Assassin's Creed II under DXVK (2026-09-18, and DXVK issue #3653 describes the
// same crash on alt-tab), so a verifier that brought the app back to the front to show progress
// would itself be the crash it then reports. The progress shows in the app's window whether or not
// it is in front. Closing at the end is WM_CLOSE to the game's main window (Process.CloseMainWindow,
// which does not activate it), then a kill after a grace period.

'use strict';

const path = require('node:path');
const os = require('node:os');
const probe = require('./probe');

const VERIFY_SECONDS = 30;
// How long a launch may take to show a process at all: Steam's own start-up and a launcher that
// signs in first both come before the game.
const APPEAR_SECONDS = 60;
// A process that ended with an NTSTATUS error code (0xC0000005 access violation, 0xC0000409 stack
// buffer overrun, ...) crashed. 0xFFFFFFFF is what our own kill leaves, and is never counted.
const isCrashCode = (code) => code != null && Number.isFinite(Number(code)) && (Number(code) >>> 0) >= 0xC0000000 && (Number(code) >>> 0) !== 0xFFFFFFFF;

// The verdict from what was watched and what the logs said. Pure; the renderer turns it into words.
// watch: { seen, exitedEarly, exitCodes: [..], startedAt (ms), seconds }
// run:   runlog.analyzeRun result; diag: gamehelp.diagnose result.
function verdictFor({ seen, exitedEarly, exitCodes = [], startedAt = 0 }, run, diag) {
  const r = run || { ran: false };
  const at = Date.parse(r.at || '') || 0;
  // A log older than this launch is the previous run's, and says nothing about this one. Two
  // seconds of slack for a filesystem that rounds mtimes.
  const fresh = !!r.ran && at >= startedAt - 2000;
  const frames = fresh ? (r.nrFrames || r.nrDispatch || r.feedFrames || 0) : 0;
  const base = { fresh, frames, exitCodes, diag: diag || null, runVerdict: fresh ? r.verdict : null };
  if (!seen) return { ...base, result: 'warn', code: 'not-started' };
  const crashed = exitCodes.some(isCrashCode) || (fresh && (r.crash || r.wrapperCrash || r.feedEvaluateCrash));
  if (exitedEarly) {
    // Exit code 0 is the game closing itself -- a launcher that wanted a sign-in, a settings prompt.
    // An exit nobody could read the code of is counted as a crash: that is what it nearly always is.
    const clean = exitCodes.length > 0 && exitCodes.every((c) => c === 0);
    if (crashed || !clean) return { ...base, result: 'crash', code: 'crash' };
    return { ...base, result: 'warn', code: 'exited' };
  }
  if (crashed) return { ...base, result: 'crash', code: 'crash' };
  if (!fresh) return { ...base, result: 'warn', code: 'no-log' };
  if (diag && diag.status === 'ok') return { ...base, result: 'ok', code: 'ran' };
  return { ...base, result: 'warn', code: 'diagnosis' };
}

// launch(): main.js launchGame. readRun(): { run, diag } from Game Help's own context.
async function runVerify({
  exePath, launch, readRun, execFileAsync, seconds = VERIFY_SECONDS, appearSeconds = APPEAR_SECONDS,
  workDir = os.tmpdir(), onProgress = () => {}, startPollerImpl = probe.startPoller, closeTreeImpl = probe.closeTree,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 2000,
}) {
  const startedAt = now();
  const alive = new Set();
  const seen = new Set();
  const exitCodes = new Map();
  let emptyTicks = 0;
  let firstSeenAt = null;
  const poller = startPollerImpl({
    root: probe.gameRootFor(exePath), seconds: appearSeconds + seconds + 15, modules: false,
    names: [path.basename(exePath)], workDir,
    onTick: (tick) => {
      const procs = Array.isArray(tick.procs) ? tick.procs : tick.procs ? [tick.procs] : [];
      const exits = Array.isArray(tick.exits) ? tick.exits : tick.exits ? [tick.exits] : [];
      alive.clear();
      for (const p of procs) { alive.add(Number(p.pid)); seen.add(Number(p.pid)); }
      for (const e of exits) exitCodes.set(Number(e.pid), e.exitCode == null ? null : Number(e.exitCode));
      if (procs.length && firstSeenAt == null) firstSeenAt = now();
      emptyTicks = procs.length ? 0 : emptyTicks + 1;
    },
  });
  let launched;
  try { launched = await launch(); } catch (e) { launched = { ok: false, error: String(e && e.message ? e.message : e) }; }
  if (!launched || launched.ok === false || launched.cancelled) {
    poller.stop();
    return { ok: false, cancelled: !!(launched && launched.cancelled), error: (launched && launched.error) || null };
  }
  onProgress({ phase: 'waiting' });
  let exitedEarly = false;
  for (;;) {
    const t = now();
    if (firstSeenAt == null) {
      if (t - startedAt >= appearSeconds * 1000) break;
    } else {
      // Two empty ticks in a row: one can fall between a launcher exiting and its child being listed.
      if (emptyTicks >= 2) { exitedEarly = true; break; }
      if (t - firstSeenAt >= seconds * 1000) break;
      onProgress({ phase: 'running', elapsed: Math.round((t - firstSeenAt) / 1000), seconds });
    }
    await sleep(500);
  }
  let closed = null;
  if (seen.size && !exitedEarly) {
    onProgress({ phase: 'closing' });
    closed = await closeTreeImpl([...seen], { execFileAsync });
  }
  poller.stop();
  await poller.done;
  // Let the game's logs reach the disk before they are read.
  await sleep(settleMs);
  onProgress({ phase: 'reading' });
  const { run, diag } = await readRun();
  const watch = {
    seen: seen.size > 0, exitedEarly, startedAt,
    // Exit codes of processes that ended on their own. Our own kill does not count (it is not a crash).
    exitCodes: exitedEarly ? [...exitCodes.values()] : [],
  };
  return { ok: true, verdict: verdictFor(watch, run, diag), run, diag, closed, launched };
}

module.exports = { VERIFY_SECONDS, APPEAR_SECONDS, isCrashCode, verdictFor, runVerify };
