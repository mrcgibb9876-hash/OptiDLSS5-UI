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
  frameGen: over.frameGen || [],
  vulkanFeeder: over.vulkanFeeder || null,
});

// Prey through Luma (a player's bundle, 2026-09-15): Luma's DLSS replaces the game's TAA / SMAA 2TX pass.
test('a Luma Prey run with no DLSS carries the Prey flag so the steps name the anti-aliasing setting', () => {
  const luma = (lumaPrey) => ({ ...base({ route: { route: 'lumaue', lumaDeployed: true }, run: { ran: true, verdict: 'init-no-feature' } }), lumaPrey });
  assert.deepEqual(diagnose(luma(true)).vars, { prey: true });
  assert.deepEqual(diagnose(luma(false)).vars, { prey: false });
});

// Ryujinx on Vulkan (a player's bundle, 2026-09-15): the Feeder never loaded, and Game Help said "no known fix".
test('a Vulkan Feeder game whose Feeder never loaded names the ReShade layer fault', () => {
  const vk = (vulkanFeeder) => base({
    detected: { api: 'vulkan' }, route: { route: 'feeder', feederDeployed: true },
    run: { ran: true, verdict: 'no-dlss' }, vulkanFeeder,
  });
  assert.equal(diagnose(vk({ layerRegistered: false, layerAddon: false, feederLogPresent: false })).code, 'vulkan-layer-missing');
  assert.equal(diagnose(vk({ layerRegistered: true, layerAddon: false, feederLogPresent: false })).code, 'vulkan-layer-no-addon');
  assert.equal(diagnose(vk({ layerRegistered: true, layerAddon: true, feederLogPresent: false })).code, 'vulkan-layer-not-loaded');
  assert.equal(diagnose(vk({ layerRegistered: true, layerAddon: true, feederLogPresent: true })).code, 'no-hook', 'the Feeder loaded: another fault');
  // The layer is there, with add-ons, and its own app list (ReShadeApps.ini) leaves this exe out: the
  // usual reason it "did not load", and the one with a precise step.
  const skipped = diagnose(vk({ layerRegistered: true, layerAddon: true, appListed: false, exe: 'swtor.exe', feederLogPresent: false }));
  assert.equal(skipped.code, 'vulkan-layer-app-not-listed');
  assert.deepEqual(skipped.vars, { exe: 'swtor.exe' });
  assert.equal(diagnose(vk({ layerRegistered: true, layerAddon: true, appListed: true, feederLogPresent: false })).code, 'vulkan-layer-not-loaded');
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
  // The 32-bit route runs the neural pass in a helper process, so the panel is not in the game and
  // Alt+Home alone reaches nothing. A working run has to say so -- it used to say only 'ok'.
  ['NR ran on the 32-bit route: ok, and the panel is in the helper', base({ route: { route: 'feeder32', complete: true } }), { status: 'ok', code: 'ok-panel-in-helper' }],
  ['D3D11 native DLSS (Fallen Order before dlss_12): reconfigure', base({ run: { ran: true, verdict: 'dlss-no-nr', detail: 'd3d11-native' } }), { status: 'fix', fix: 'reconfigure' }],
  ['DLSS ran with NR off in the ini: reconfigure', base({ run: { ran: true, verdict: 'dlss-no-nr' }, nrEnabledInIni: false }), { status: 'fix', fix: 'reconfigure' }],
  ['DLSS ran, NR on, still no NR: unknown', base({ run: { ran: true, verdict: 'dlss-no-nr' } }), { status: 'unknown', code: 'dlss-no-nr' }],
  ['Luma deployed but DLSS never selected: a user step', base({ route: { route: 'lumaue', lumaDeployed: true }, run: { ran: true, verdict: 'init-no-feature' } }), { status: 'step', code: 'luma-select-dlss' }],
  ['Feeder technique missing: Install again', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'init-no-feature', detail: 'feeder-technique-missing' } }), { status: 'fix', fix: 'install' }],
  ['two DLSS DLLs crashed it: remove the Feeder', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'duplicate-dlss' } }), { status: 'fix', fix: 'remove-feeder' }],
  ['UE crash with unverified Luma: remove Luma', base({ route: { route: 'lumaue', lumaDeployed: true }, run: { ran: true, verdict: 'ue-crash', detail: 'Assertion failed' } }), { status: 'fix', fix: 'remove-luma' }],
  // Two frame generators. Smooth Motion is the driver's own, invisible to everything here except
  // the Feeder's log line, so this is reported and never acted on. It has to reach a WORKING run --
  // a game that "works" while quietly running two generators is the whole point -- without ever
  // outranking a hard stop or a real failure.
  ['Smooth Motion alongside a configured generator: say so, even on a good run',
    base({ run: { ran: true, verdict: 'nr-ran', nrDispatch: 400, feedSmoothMotion: true }, frameGen: ['Lossless Scaling'] }),
    { status: 'step', code: 'smooth-motion-stacked' }],
  ['Smooth Motion with no generator of ours: nothing to say',
    base({ run: { ran: true, verdict: 'nr-ran', nrDispatch: 400, feedSmoothMotion: true } }),
    { status: 'ok', code: 'ok' }],
  ['a generator of ours with no Smooth Motion: nothing to say',
    base({ frameGen: ['Lossless Scaling'] }),
    { status: 'ok', code: 'ok' }],
  ['anti-cheat still outranks it',
    base({ detected: { antiCheat: 'EasyAntiCheat.exe' }, run: { ran: true, verdict: 'nr-ran', feedSmoothMotion: true }, frameGen: ['Lossless Scaling'] }),
    { status: 'unavailable', code: 'anticheat' }],
  ['another DLSS 5 toolchain still outranks it',
    base({ run: { ran: true, verdict: 'nr-ran', feedSmoothMotion: true }, frameGen: ['Lossless Scaling'], foreign: [{ tool: 'X' }] }),
    { status: 'fix', code: 'foreign' }],

  // The wrapper crash. dgVoodoo2 failing used to end the road, because it was the only way to put
  // DirectX 8/9 in front of a modern pipeline. translation.js owns DXVK too now, so the other layer
  // is offered first and "put the game back" is what is left once that has been tried and the
  // wrapper is still crashing. These run everywhere; the end-to-end version in feeder.test.js
  // parses a real Feeder log and is Windows-only.
  ['dgVoodoo2 crashed it: try the other layer first',
    base({ route: { route: 'feeder32', complete: true, dgVoodooDeployed: true, legacy: { api: 'dx9', dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } } }, detected: { bitness: 32, api: 'dx9' }, run: { ran: true, verdict: 'wrapper-crash', detail: 'd3d9.dll', at: 'T1' } }),
    { status: 'fix', code: 'wrapper-crash-swap', fix: 'swap-to-dxvk' }],
  ['the swap was tried and it still crashes: put the game back',
    base({ route: { route: 'feeder32', complete: true, dgVoodooDeployed: true, legacy: { api: 'dx9', dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } } }, detected: { bitness: 32, api: 'dx9' }, run: { ran: true, verdict: 'wrapper-crash', detail: 'd3d9.dll', at: 'T2' }, fixesTried: ['swap-to-dxvk'] }),
    { status: 'fix', code: 'dgvoodoo-crash', fix: 'remove-all' }],
  ['an API DXVK has no file set for: straight to putting the game back',
    base({ route: { route: 'feeder32', complete: true, dgVoodooDeployed: true, legacy: { api: 'opengl', dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } } }, detected: { bitness: 32, api: 'opengl' }, run: { ran: true, verdict: 'wrapper-crash', detail: 'd3d9.dll', at: 'T3' } }),
    { status: 'fix', code: 'dgvoodoo-crash', fix: 'remove-all' }],
  ['a wrapper this app did not place: named, never swapped or removed',
    base({ route: { route: 'feeder32', complete: true, dgVoodooDeployed: false, legacy: { api: 'dx9', dgVoodoo: null } }, detected: { bitness: 32, api: 'dx9' }, run: { ran: true, verdict: 'wrapper-crash', detail: 'd3d9.dll', at: 'T4' } }),
    { status: 'unknown', code: 'wrapper-crash' }],
  ['UE crash on a verified Luma game: unknown, bundle', base({ route: { route: 'lumaue', lumaDeployed: true, verified: { route: 'lumaue' } }, run: { ran: true, verdict: 'ue-crash', detail: 'x' } }), { status: 'unknown', code: 'ue-crash' }],
  ['Feeder gave up: reconfigure', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'feed-stopped' } }), { status: 'fix', fix: 'reconfigure' }],
  ['a fix already tried and the verdict unchanged: unknown, not the same fix again', base({ run: { ran: true, verdict: 'dlss-no-nr', detail: 'd3d11-native' }, fixesTried: ['reconfigure'] }), { status: 'unknown', code: 'fix-failed' }],
  ['exit-only crash with NR having run: ok', base({ run: { ran: true, verdict: 'shutdown-fault', nrDispatch: 200 } }), { status: 'ok', code: 'ok-exit-crash' }],
  ['exit-only crash with NR having run on a Feeder game: still ok, the Feeder stays', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'shutdown-fault', nrDispatch: 200 } }), { status: 'ok', code: 'ok-exit-crash' }],
  ['shutdown fault with nothing run and a Feeder deployed: remove the Feeder', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'shutdown-fault', nrDispatch: 0 } }), { status: 'fix', fix: 'remove-feeder' }],
  ['a fix applied against this same run: needs a run, not failed', base({ run: { ran: true, at: 'T1', verdict: 'dlss-no-nr', detail: 'd3d11-native' }, fixesTried: [{ id: 'reconfigure', runAt: 'T1' }] }), { status: 'needs-run', code: 'needs-run-after-fix' }],
  ['the same fix after a newer run says the same thing: failed', base({ run: { ran: true, at: 'T2', verdict: 'dlss-no-nr', detail: 'd3d11-native' }, fixesTried: [{ id: 'reconfigure', runAt: 'T1' }] }), { status: 'unknown', code: 'fix-failed' }],
  ['a fix applied before any log, still no log: needs a run', base({ run: { ran: false, verdict: 'no-log' }, route: { optiInstalled: false }, fixesTried: [{ id: 'install', runAt: null }] }), { status: 'needs-run', code: 'needs-run-after-fix' }],
  // Install offers Luma itself now (2026-09-15, "as little friction as possible"), so this is Install, one button.
  ['Luma route with no Luma yet: Install sets it up', base({ route: { route: 'lumaue', lumaDeployed: false }, run: { ran: false, verdict: 'no-log' } }), { status: 'fix', code: 'luma-missing', fix: 'install' }],
  ['a Feeder where Luma-Framework has a DLSS mod: switch to Luma', base({ route: { route: 'feeder', feederDeployed: true, lumaAvailable: true }, run: { ran: true, verdict: 'nr-ran', nrDispatch: 10 } }), { status: 'fix', code: 'luma-available', fix: 'switch-to-luma' }],
  ['Luma deployed but the game ran DX12: switch the game to DX11', base({ route: { route: 'lumaue', lumaDeployed: true }, run: { ran: true, verdict: 'no-dlss', runtimeApi: 'dx12' } }), { status: 'step', code: 'luma-needs-dx11' }],
  // SWTOR (2026-09-16): the Feeder said "OptiScaler: not present" -- installed as dxgi.dll beside DXVK.
  ['Feeder found no OptiScaler and the app knows the name the game loads: reconfigure moves it', { ...base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'opti-not-loaded' } }), optiProxy: 'dxgi.dll', wantedProxy: 'winmm.dll' }, { status: 'fix', code: 'opti-proxy-name', fix: 'reconfigure' }],
  ['Feeder found no OptiScaler and the name is already the best guess: a user step', { ...base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'opti-not-loaded' } }), optiProxy: 'winmm.dll', wantedProxy: null }, { status: 'step', code: 'opti-not-loaded' }],

  // A game with DLSS of its own does not need the proxy at all: the model beside the exe is enough
  // and the game's own Streamline loads it. So "OptiScaler never loaded" on such a game is answered
  // by the route that never wanted a proxy, not by another guess at a DLL name. (RHI works on
  // Assassin's Creed Black Flag Resynced for exactly this reason -- it never proxies.)
  ['OptiScaler never loaded and the game has its own DLSS: offer the model-only route',
    { ...base({ route: { shipsDlss: true }, run: { ran: true, verdict: 'opti-not-loaded' } }), optiProxy: 'dxgi.dll', wantedProxy: null },
    { status: 'fix', code: 'nr-model-only', fix: 'nr-model-only' }],
  // The proxy name is still the better first answer when the app knows a name the exe imports:
  // renaming keeps the panel, and the model-only route costs it.
  ['a known-better proxy name outranks the model-only route',
    { ...base({ route: { shipsDlss: true }, run: { ran: true, verdict: 'opti-not-loaded' } }), optiProxy: 'dxgi.dll', wantedProxy: 'winmm.dll' },
    { status: 'fix', code: 'opti-proxy-name', fix: 'reconfigure' }],
  // Applied, and no newer run to judge it by yet: the table says so rather than re-offering it.
  // That is the shared rule for every fix, not this one's own -- asserted here so the model-only
  // route is known to be inside it.
  ['the model-only route awaits a run before it is judged',
    { ...base({ route: { shipsDlss: true }, run: { ran: true, verdict: 'opti-not-loaded', at: 200 } }), optiProxy: 'dxgi.dll', wantedProxy: null, fixesTried: [{ id: 'nr-model-only', runAt: 200 }] },
    { status: 'needs-run', code: 'needs-run-after-fix' }],
  // Applied, then run again, and OptiScaler still did not load. Offering to take it out a second
  // time is no answer, so the rule steps aside and the rename step comes back.
  ['the model-only route is not offered twice',
    { ...base({ route: { shipsDlss: true }, run: { ran: true, verdict: 'opti-not-loaded', at: 900 } }), optiProxy: 'dxgi.dll', wantedProxy: null, fixesTried: [{ id: 'nr-model-only', runAt: 200 }] },
    { status: 'step', code: 'opti-not-loaded' }],
  // A game without its own DLSS has nothing to fall back to: the model alone dispatches nothing
  // there, so the step stays "rename it".
  ['a game with no DLSS of its own still gets the rename step',
    { ...base({ route: { shipsDlss: false }, run: { ran: true, verdict: 'opti-not-loaded' } }), optiProxy: 'dxgi.dll', wantedProxy: null },
    { status: 'step', code: 'opti-not-loaded' }],
  ['the driver answered the Feeder\'s probe instead of OptiScaler: reconfigure', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'opti-not-routed' } }), { status: 'fix', code: 'opti-not-routed', fix: 'reconfigure' }],
  ['a stock OptiScaler answered the Feeder: Install puts the fork back', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'opti-not-fork' } }), { status: 'fix', code: 'opti-not-fork', fix: 'install' }],
  ['the Feeder\'s Vulkan interop never opened: the fallback layer is the step', base({ route: { route: 'feeder', feederDeployed: true }, run: { ran: true, verdict: 'feed-vulkan-interop' } }), { status: 'step', code: 'feed-vulkan-interop' }],
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

test('Resident Evil 2: the Present route needs no plugin or DLSS DLL, only REFramework\'s TemporalUpscaler off', () => {
  const pdBase = (run) => base({ route: { route: 'reframework-pd' }, run, reEngine: true, reframeworkPresent: true });
  // No plugin, no nvngx_dlss.dll, a standard REFramework: nothing to ask for any more.
  const t1 = pdBase({ ran: false, verdict: 'no-log' });
  t1.pdUpscaler = { game: 'RE2', reframeworkPresent: true, reframeworkBuild: 'standard', dlssPresent: false, pluginPresent: false, temporalUpscalerOn: false };
  assert.equal(diagnose(t1).code, 'needs-run');
  // TemporalUpscaler left on from the old pd route: Reconfigure switches it off.
  const t2 = pdBase({ ran: false, verdict: 'no-log' });
  t2.pdUpscaler = { ...t1.pdUpscaler, temporalUpscalerOn: true };
  const d2 = diagnose(t2);
  assert.equal(d2.status, 'fix');
  assert.equal(d2.code, 'pd-temporal-on');
  // A run where the pass dispatched is a clean run.
  const t3 = pdBase({ ran: true, verdict: 'nr-ran', nrDispatch: 50 });
  t3.pdUpscaler = t1.pdUpscaler;
  assert.equal(diagnose(t3).status, 'ok');
});

test('anti-cheat is a hard stop only when there is no stub to step around', () => {
  const base = {
    detected: { bitness: 64, antiCheat: 'EasyAntiCheat' },
    route: { route: 'feeder', optiInstalled: true, feederDeployed: true },
    run: { ran: false, verdict: 'no-log' },
  };
  // No stub: nothing this app installs can ever run, and saying so is the honest answer.
  const blocked = diagnose(base);
  assert.equal(blocked.status, 'unavailable');
  assert.equal(blocked.code, 'anticheat');

  // A stub: the route stays open, and "no log at all" is explained rather than waited on -- that
  // launch cannot write a log, so Game Help points at the button that starts the game directly.
  const withStub = diagnose({
    ...base,
    detected: { ...base.detected, protectedLauncher: { stub: 'start_protected_game.exe', antiCheat: 'EasyAntiCheat' } },
  });
  assert.equal(withStub.status, 'step');
  assert.equal(withStub.code, 'anticheat-launch-direct');
  assert.equal(withStub.vars.stub, 'start_protected_game.exe');

  // Once a run has happened, the run is the finding again -- the stub note never hides a verdict.
  const ran = diagnose({
    ...base,
    detected: { ...base.detected, protectedLauncher: { stub: 'start_protected_game.exe' } },
    run: { ran: true, verdict: 'nr-ran', nrDispatch: 40, fps: 90 },
  });
  assert.equal(ran.status, 'ok');
});
