// Verify install (src/verify.js): the verdict from what was watched and what the logs said, and the
// runner driven by a fake poller and a fake clock. No game is started and nothing is focused.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const verify = require('../src/verify');

const START = Date.parse('2026-09-18T20:00:00Z');
const freshRun = (over = {}) => ({ ran: true, at: new Date(START + 20000).toISOString(), verdict: 'ok', nrFrames: 1800, ...over });
const OK = { status: 'ok' };

test('crash codes: NTSTATUS errors count, our own kill and a clean exit do not', () => {
  assert.equal(verify.isCrashCode(0xC0000005), true);
  assert.equal(verify.isCrashCode(-1073741819), true, 'the same access violation as a signed int');
  assert.equal(verify.isCrashCode(0xC0000409), true);
  assert.equal(verify.isCrashCode(0xFFFFFFFF), false);
  assert.equal(verify.isCrashCode(-1), false);
  assert.equal(verify.isCrashCode(0), false);
  assert.equal(verify.isCrashCode(null), false);
});

test('DLSS 5 ran: a fresh log that Game Help calls ok, with the frame count', () => {
  const v = verify.verdictFor({ seen: true, startedAt: START }, freshRun(), OK);
  assert.equal(v.result, 'ok');
  assert.equal(v.code, 'ran');
  assert.equal(v.frames, 1800);
});

test('a log from before this launch says nothing about it', () => {
  const stale = freshRun({ at: new Date(START - 60000).toISOString() });
  const v = verify.verdictFor({ seen: true, startedAt: START }, stale, OK);
  assert.equal(v.code, 'no-log');
  assert.equal(v.fresh, false);
  assert.equal(v.frames, 0);
});

test('Game Help finding something is a warning that carries the diagnosis', () => {
  const diag = { status: 'problem', code: 'no-dlss' };
  const v = verify.verdictFor({ seen: true, startedAt: START }, freshRun({ verdict: 'no-dlss', nrFrames: 0 }), diag);
  assert.equal(v.result, 'warn');
  assert.equal(v.code, 'diagnosis');
  assert.equal(v.diag, diag);
});

test('never seen is not-started; closing itself with 0 is a warning; any other early exit is a crash', () => {
  assert.equal(verify.verdictFor({ seen: false, startedAt: START }, null, null).code, 'not-started');
  assert.equal(verify.verdictFor({ seen: true, exitedEarly: true, exitCodes: [0], startedAt: START }, null, null).code, 'exited');
  const av = verify.verdictFor({ seen: true, exitedEarly: true, exitCodes: [0xC0000005], startedAt: START }, null, null);
  assert.deepEqual([av.result, av.code], ['crash', 'crash']);
  // An exit whose code nobody could read is counted as the crash it nearly always is.
  assert.equal(verify.verdictFor({ seen: true, exitedEarly: true, exitCodes: [null], startedAt: START }, null, null).code, 'crash');
  assert.equal(verify.verdictFor({ seen: true, exitedEarly: true, exitCodes: [], startedAt: START }, null, null).code, 'crash');
});

test('a fresh log that recorded a crash is a crash even when the game was still up at the end', () => {
  const v = verify.verdictFor({ seen: true, startedAt: START }, freshRun({ crash: true }), OK);
  assert.equal(v.code, 'crash');
  // A crash in an OLD log does not.
  const old = freshRun({ crash: true, at: new Date(START - 60000).toISOString() });
  assert.equal(verify.verdictFor({ seen: true, startedAt: START }, old, OK).code, 'no-log');
});

// A fake poller: `script` is the list of ticks it hands out, one per sleep of the runner.
function fakeEnv(script) {
  let clock = START;
  let onTick = null;
  let i = 0;
  const calls = { launch: 0, closed: null, stopped: false, pollerOpts: null };
  const env = {
    exePath: 'D:\\Games\\Fake\\Fake.exe',
    execFileAsync: async () => ({ stdout: '' }),
    seconds: 5, appearSeconds: 3, settleMs: 0,
    now: () => clock,
    sleep: async (ms) => { clock += ms; if (onTick && i < script.length) onTick(script[i++]); },
    startPollerImpl: (opts) => { calls.pollerOpts = opts; onTick = opts.onTick; return { stop: () => { calls.stopped = true; }, done: Promise.resolve([]) }; },
    closeTreeImpl: async (pids) => { calls.closed = pids; return { asked: pids.length, killed: 0 }; },
    launch: async () => { calls.launch++; return { ok: true, via: 'exe' }; },
  };
  return { env, calls, at: (ms) => new Date(START + ms).toISOString() };
}

test('the runner watches for the full window, closes what it saw, then reads the logs', async () => {
  const up = { procs: [{ pid: 4242, name: 'Fake.exe' }] };
  const { env, calls, at } = fakeEnv(Array(30).fill(up));
  const phases = [];
  const res = await verify.runVerify({
    ...env,
    onProgress: (p) => phases.push(p.phase),
    readRun: async () => ({ run: freshRun({ at: at(4000) }), diag: OK }),
  });
  assert.equal(res.ok, true);
  assert.equal(calls.launch, 1);
  assert.deepEqual(calls.closed, [4242]);
  assert.equal(calls.stopped, true);
  assert.deepEqual(calls.pollerOpts.names, ['Fake.exe']);
  assert.equal(calls.pollerOpts.modules, false, 'no module listing: only liveness is needed');
  assert.equal(res.verdict.code, 'ran');
  assert.deepEqual(res.verdict.exitCodes, [], 'our own close is not an exit code');
  assert.ok(phases.includes('running') && phases.includes('closing') && phases.indexOf('reading') > phases.indexOf('closing'));
});

test('the runner calls it a crash when the game dies inside the window, and closes nothing', async () => {
  const up = { procs: [{ pid: 7, name: 'Fake.exe' }] };
  const gone = { procs: [], exits: [{ pid: 7, exitCode: 3221225477 }] };
  const { env, calls } = fakeEnv([up, up, gone, { procs: [] }, { procs: [] }]);
  const res = await verify.runVerify({ ...env, readRun: async () => ({ run: { ran: false }, diag: null }) });
  assert.equal(res.verdict.code, 'crash');
  assert.equal(calls.closed, null);
});

test('the runner gives up after the appear window when the game never shows', async () => {
  const { env, calls } = fakeEnv([]);
  const res = await verify.runVerify({ ...env, readRun: async () => ({ run: null, diag: null }) });
  assert.equal(res.verdict.code, 'not-started');
  assert.equal(calls.closed, null);
});

test('a cancelled launch (the anti-cheat question answered no) stops the poller and reads nothing', async () => {
  const { env, calls } = fakeEnv([]);
  let read = false;
  const res = await verify.runVerify({ ...env, launch: async () => ({ ok: true, cancelled: true }), readRun: async () => { read = true; return {}; } });
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.equal(calls.stopped, true);
  assert.equal(read, false);
});
