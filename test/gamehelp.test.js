'use strict';
// Game Help's rule table: each row is a situation the app has actually met (or a hard stop it
// can see coming) and the one thing it should say or do about it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { diagnose, FIX_IDS } = require(path.join(__dirname, '..', 'src', 'gamehelp'));
const aihelp = require(path.join(__dirname, '..', 'src', 'aihelp'));

const base = (over = {}) => ({
  detected: { api: 'dx12', bitness: 64, antiCheat: null, ...(over.detected || {}) },
  route: { route: 'optiscaler', optiInstalled: true, feederDeployed: false, lumaDeployed: false, feederMisdeployed: false, verified: null, ...(over.route || {}) },
  run: over.run || { ran: true, verdict: 'nr-ran', nrDispatch: 400, fps: 90, runtimeApi: 'dx12' },
  foreign: over.foreign || [],
  lumaKnownBad: over.lumaKnownBad || null,
  reEngine: !!over.reEngine,
  reframeworkPresent: over.reframeworkPresent === undefined ? null : over.reframeworkPresent,
  nrEnabledInIni: over.nrEnabledInIni === undefined ? true : over.nrEnabledInIni,
  fixesTried: over.fixesTried || [],
});

const rows = [
  ['a 32-bit game is unavailable', base({ detected: { bitness: 32 } }), { status: 'unavailable', code: 'bit32' }],
  ['anti-cheat is unavailable', base({ detected: { antiCheat: 'Easy Anti-Cheat' } }), { status: 'unavailable', code: 'anticheat' }],
  ['a Vulkan game with no DLSS is unavailable', base({ route: { route: 'unsupported', reason: 'Vulkan' } }), { status: 'unavailable', code: 'unsupported' }],
  ['another toolchain: remove it first', base({ foreign: [{ tool: 'DLSS5-Swapper', files: ['x'] }] }), { status: 'fix', fix: 'remove-foreign' }],
  ['Feeder on a game that ships DLSS (Code Vein 2): remove the Feeder', base({ route: { feederDeployed: true, feederMisdeployed: true } }), { status: 'fix', fix: 'remove-feeder' }],
  ['Luma on a known-bad game (Spyro): remove Luma', base({ route: { lumaDeployed: true }, lumaKnownBad: 'does not start' }), { status: 'fix', fix: 'remove-luma' }],
  ['not installed: Install', base({ route: { optiInstalled: false } }), { status: 'fix', fix: 'install' }],
  ['Feeder route with no Feeder: Install', base({ route: { route: 'feeder', feederDeployed: false } }), { status: 'fix', fix: 'install' }],
  ['RE Engine without REFramework: reconfigure', base({ reEngine: true, reframeworkPresent: false }), { status: 'fix', fix: 'reconfigure' }],
  ['no log yet: run it', base({ run: { ran: false, verdict: 'no-log' } }), { status: 'needs-run', code: 'needs-run' }],
  ['NR ran: ok', base(), { status: 'ok', code: 'ok' }],
  ['D3D11 native DLSS (Fallen Order before dlss_12): reconfigure', base({ run: { ran: true, verdict: 'dlss-no-nr', detail: 'd3d11-native' } }), { status: 'fix', fix: 'reconfigure' }],
  ['DLSS ran with NR off in the ini: reconfigure', base({ run: { ran: true, verdict: 'dlss-no-nr' }, nrEnabledInIni: false }), { status: 'fix', fix: 'reconfigure' }],
  ['DLSS ran, NR on, still no NR: unknown', base({ run: { ran: true, verdict: 'dlss-no-nr' } }), { status: 'unknown', code: 'dlss-no-nr' }],
  ['Luma deployed but DLSS never selected: a user step', base({ route: { route: 'lumaue', lumaDeployed: true }, run: { ran: true, verdict: 'init-no-feature' } }), { status: 'step', code: 'luma-select-dlss' }],
  ['Feeder technique missing: Install again', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'init-no-feature', detail: 'feeder-technique-missing' } }), { status: 'fix', fix: 'install' }],
  ['two DLSS DLLs crashed it: remove the Feeder', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'duplicate-dlss' } }), { status: 'fix', fix: 'remove-feeder' }],
  ['UE crash with unverified Luma: remove Luma', base({ route: { route: 'lumaue', lumaDeployed: true }, run: { ran: true, verdict: 'ue-crash', detail: 'Assertion failed' } }), { status: 'fix', fix: 'remove-luma' }],
  ['UE crash on a verified Luma game: unknown, bundle', base({ route: { route: 'lumaue', lumaDeployed: true, verified: { route: 'lumaue' } }, run: { ran: true, verdict: 'ue-crash', detail: 'x' } }), { status: 'unknown', code: 'ue-crash' }],
  ['Feeder gave up: reconfigure', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'feed-stopped' } }), { status: 'fix', fix: 'reconfigure' }],
  ['a fix already tried and the verdict unchanged: unknown, not the same fix again', base({ run: { ran: true, verdict: 'dlss-no-nr', detail: 'd3d11-native' }, fixesTried: ['reconfigure'] }), { status: 'unknown', code: 'fix-failed' }],
  ['exit-only crash with NR having run: ok', base({ run: { ran: true, verdict: 'shutdown-fault', nrDispatch: 200 } }), { status: 'ok', code: 'ok-exit-crash' }],
];

for (const [name, ctx, want] of rows) {
  test(name, () => {
    const d = diagnose(ctx);
    assert.equal(d.status, want.status, JSON.stringify(d));
    if (want.code) assert.equal(d.code, want.code, JSON.stringify(d));
    if (want.fix) { assert.ok(d.fix, 'has a fix'); assert.equal(d.fix.id, want.fix); assert.ok(FIX_IDS.includes(d.fix.id)); }
    if (want.status !== 'fix') assert.equal(d.fix, null);
  });
}

test('the AI session runs its tool loop and ends on finish, with every fix confirmed through applyFix', async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (_url, init) => {
    n++;
    const body = JSON.parse(init.body);
    assert.equal(init.headers['x-api-key'], 'sk-test');
    assert.ok(body.tools.some((t) => t.name === 'apply_fix'));
    const reply = n === 1
      ? { stop_reason: 'tool_use', content: [{ type: 'text', text: 'The Feeder is on a game that ships DLSS.' }, { type: 'tool_use', id: 'tu1', name: 'apply_fix', input: { fix: 'remove-feeder', why: 'Two DLSS DLLs crash it.' } }] }
      : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { available: true, summary: 'Removed the Feeder. Launch and reach gameplay to confirm.' } }] };
    if (n === 2) {
      const last = body.messages[body.messages.length - 1];
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].tool_use_id, 'tu1');
      assert.match(last.content[0].content, /^done: /);
    }
    return { ok: true, json: async () => reply };
  };
  const res = await aihelp.helpSession({
    apiKey: 'sk-test', evidence: 'evidence', fetchImpl,
    applyFix: async (fix, why) => { calls.push([fix, why]); return 'done: removed'; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.available, true);
  assert.deepEqual(calls, [['remove-feeder', 'Two DLSS DLLs crash it.']]);
  assert.match(res.summary, /Removed the Feeder/);
  assert.equal(res.turns, 2);
});

test('an API error surfaces as a plain message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(() => aihelp.helpSession({ apiKey: 'bad', evidence: 'x', fetchImpl, applyFix: async () => 'no' }), /invalid x-api-key/);
});
