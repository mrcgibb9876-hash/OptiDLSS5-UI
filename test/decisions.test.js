'use strict';
// The decision layer: the known-good catalog (catalog.js, data/known-good.json), route scoring
// (routescore.js), run digests read back (digest.js), the frame-gen suggestion (fgsuggest.js), and
// how route.js and Game Help use them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const catalog = require(path.join(REPO, 'src', 'catalog'));
const routescore = require(path.join(REPO, 'src', 'routescore'));
const { parseDigest } = require(path.join(REPO, 'src', 'digest'));
const { suggestFrameGen } = require(path.join(REPO, 'src', 'fgsuggest'));
const runlog = require(path.join(REPO, 'src', 'runlog'));
const route = require(path.join(REPO, 'src', 'route'));
const gamehelp = require(path.join(REPO, 'src', 'gamehelp'));
const build = require(path.join(REPO, 'tools', 'catalog', 'build'));

const FIXTURES = path.join(__dirname, 'fixtures', 'digests');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ── the shipped catalog ──────────────────────────────────────────────────────────────────────────
test('the shipped catalog is hash-checked, and every entry is well formed and cites its source', () => {
  const doc = JSON.parse(fs.readFileSync(catalog.SHIPPED_FILE, 'utf8'));
  assert.deepEqual(catalog.verifyCatalog(doc), { ok: true }, 'run node tools/catalog/build.js after editing data/known-good.json');
  assert.deepEqual(build.problemsIn(doc.entries), []);
  for (const e of doc.entries) {
    assert.ok(e.sources.length > 0, `${e.exe} has sources`);
    for (const d of e.dead_ends) assert.ok(d.source, `${e.exe} dead end has a source`);
  }
  assert.equal(catalog.loadShipped().error, null);
});

test('a catalog whose entries do not match its hash is refused, not trusted', () => {
  const dir = scratchDir('kg-tamper');
  const doc = JSON.parse(fs.readFileSync(catalog.SHIPPED_FILE, 'utf8'));
  doc.entries[0].status = 'no-route';
  const file = write(dir, 'known-good.json', JSON.stringify(doc));
  catalog.configure({ shippedFile: file });
  try {
    const shipped = catalog.loadShipped();
    assert.deepEqual(shipped.entries, []);
    assert.match(shipped.error, /sha256 mismatch/);
    assert.equal(catalog.lookup('C:\\x\\eldenring.exe'), null);
  } finally {
    catalog.configure({ shippedFile: catalog.SHIPPED_FILE });
  }
});

test('the validator names what is wrong with an entry', () => {
  const bad = { exe: 'Game.EXE', status: 'great', setup: { route: 'warp' }, dead_ends: [{ route: 'feeder' }], sources: [] };
  const problems = catalog.validateEntry(bad).join('\n');
  for (const want of [/lower-case/, /status "great"/, /setup.route "warp"/, /no why/, /no source/, /no sources/]) assert.match(problems, want);
});

test('shipped proof reaches the lookup: Elden Ring is proven on the Present route, the Feeder is its dead end', () => {
  const e = catalog.lookup('D:\\Games\\ELDEN RING\\Game\\eldenring.exe');
  assert.equal(e.status, 'works');
  assert.equal(e.setup.route, 'present');
  assert.equal(catalog.deadEndsFor(e, { route: 'feeder' })[0].verdict, 'nr-model-crash');
  assert.deepEqual(catalog.badgeFor(e, { route: 'present' }).text, 'Known good');
  assert.equal(catalog.badgeFor(e, { route: 'feeder' }).kind, 'issue');
});

test('a dead end narrowed to one API only matches that API', () => {
  const e = catalog.lookup('C:\\Emu\\Dolphin.exe');
  assert.equal(catalog.badgeFor(e, { route: 'feeder' }, 'dx12').kind, 'issue');
  assert.equal(catalog.badgeFor(e, { route: 'feeder' }, 'dx11'), null, 'the Direct3D 11 backend is not the dead end');
});

// ── local learning ───────────────────────────────────────────────────────────────────────────────
test('this machine\'s runs are learned once each, and a local success outranks a shipped dead end', () => {
  const dir = scratchDir('kg-local');
  const localFile = path.join(dir, 'known-good.local.json');
  catalog.configure({ localFile });
  try {
    const exePath = 'C:\\Games\\Foo\\foo.exe';
    const crash = { ran: true, at: '2026-09-18T10:00:00Z', verdict: 'nr-model-crash' };
    assert.equal(catalog.learnFromRun({ exePath, run: crash, setup: { route: 'feeder', api: 'dx12' } }).kind, 'dead-end');
    assert.equal(catalog.learnFromRun({ exePath, run: crash, setup: { route: 'feeder', api: 'dx12' } }), null, 'the same run is not counted twice');
    assert.equal(catalog.learnFromRun({ exePath, run: { ran: true, at: 'x', verdict: 'feed-no-motion' } }), null, 'a fixable verdict says nothing');
    assert.equal(catalog.lookup(exePath).dead_ends[0].route, 'feeder');

    const ok = { ran: true, at: '2026-09-18T11:00:00Z', verdict: 'nr-ran', nrDispatch: 500 };
    assert.equal(catalog.learnFromRun({ exePath, run: ok, setup: { route: 'feeder', api: 'dx12' } }).kind, 'works');
    const e = catalog.lookup(exePath);
    assert.equal(e.status, 'works');
    assert.equal(e.dead_ends.length, 0, 'a setup that has now worked is no longer a dead end here');
    assert.equal(e.local, true);

    // Over a shipped entry: counts add, the local proof wins the status.
    catalog.learnFromRun({ exePath: 'D:\\AC6\\armoredcore6.exe', run: { ...ok, at: 'y' }, setup: { route: 'present', api: 'dx12' } });
    const ac6 = catalog.lookup('D:\\AC6\\armoredcore6.exe');
    assert.equal(ac6.reports.works, 2);
    assert.equal(ac6.status, 'works');
    assert.ok(ac6.sources[0].startsWith('local run y'));
  } finally {
    catalog.configure({ localFile: null });
  }
});

// ── digests ──────────────────────────────────────────────────────────────────────────────────────
test('a digest reads back into the facts reportDigest wrote', () => {
  const run = { ran: true, verdict: 'nr-ran', at: '2026-09-18T12:00:00Z', runtimeApi: 'dx11', nrFrames: 4800, nrDispatch: 12, fps: 44, cleanExit: true };
  const digest = runlog.reportDigest(run, {
    detected: { api: 'dx11', bitness: 64, engine: 'Unreal Engine 3' },
    route: { route: 'feeder' },
    timing: { ok: true, totalMs: 16.38, modelMs: 16.11, fps: 48 },
    fpsTarget: 90,
  });
  const f = parseDigest(`**Game:** Batman\n**Exe:** BatmanAK.exe\n\n${digest}`);
  assert.equal(f.exe, 'batmanak.exe');
  assert.equal(f.verdict, 'nr-ran');
  assert.equal(f.route, 'feeder');
  assert.equal(f.api, 'dx11');
  assert.equal(f.runtimeApi, 'dx11');
  assert.equal(f.bitness, 64);
  assert.equal(f.neuralPasses, 4800);
  assert.equal(f.fps, 44);
  assert.equal(f.neuralMs, 16.38);
  assert.equal(f.modelMs, 16.11);
  assert.equal(f.heartbeatFps, 48);
  assert.equal(f.fpsTarget, 90);
});

test('an issue body from before a key existed yields nulls, never guesses', () => {
  const f = parseDigest(fixture('old-body.md'));
  assert.equal(f.hasDigest, true);
  assert.equal(f.verdict, 'nr-model-crash');
  assert.equal(f.verdictDetail, 'D3D12Core <- nvngx_dlssnr');
  assert.equal(f.route, 'feeder');
  assert.equal(f.neuralMs, null);
  assert.equal(f.fpsTarget, null);
  assert.equal(f.exe, 'dolphin.exe');
});

test('a 32-bit dgVoodoo2 report becomes a catalog entry with its wrapper', () => {
  const f = parseDigest(fixture('feeder32-dgvoodoo.md'));
  assert.equal(f.wrapper, 'dgvoodoo');
  const e = catalog.entryFromDigest(f, { source: 'issue #99' });
  assert.equal(e.status, 'works');
  assert.deepEqual(e.setup, { route: 'feeder32', via: 'dgvoodoo', api: 'dx11' });
  assert.match(e.sources[0], /^issue #99 \(2026-09-14\): nr-ran$/);
  assert.deepEqual(catalog.validateEntry(e), []);
});

test('build.js folds reports into the catalog: a dead end, then a success on another route', () => {
  const dead = catalog.entryFromDigest(parseDigest(fixture('old-body.md')), { source: 'issue #70' });
  assert.equal(dead.dead_ends[0].route, 'feeder');
  assert.equal(dead.dead_ends[0].api, 'dx12');
  const base = [{ exe: 'other.exe', status: 'works', setup: { route: 'feeder' }, reports: { works: 1, fails: 0 }, dead_ends: [], sources: ['s'] }];
  let entries = catalog.addReport(base, dead);
  assert.equal(entries.length, 2);
  const works = catalog.entryFromDigest({ ...parseDigest(fixture('old-body.md')), verdict: 'nr-ran', runtimeApi: 'dx11', api: 'dx11' }, { source: 'issue #71' });
  entries = catalog.addReport(entries, works);
  const dolphin = entries.find((e) => e.exe === 'dolphin.exe');
  assert.equal(dolphin.status, 'works');
  assert.equal(dolphin.reports.works, 1);
  assert.equal(dolphin.reports.fails, 1);
  assert.equal(dolphin.dead_ends.length, 1, 'the DX12 dead end stays beside the DX11 success');
  assert.equal(dolphin.local, undefined);
  assert.deepEqual(build.problemsIn(entries), []);
  const out = build.build({ entries });
  assert.equal(out.entries[0].exe, 'dolphin.exe', 'sorted');
  assert.equal(catalog.verifyCatalog(out).ok, true);
});

test('a digest that says nothing either way adds nothing', () => {
  assert.equal(catalog.entryFromDigest({ exe: 'a.exe', route: 'feeder', verdict: 'feed-no-motion' }, { source: 's' }), null);
  assert.equal(catalog.entryFromDigest({ exe: 'a.exe', route: 'unknown', verdict: 'nr-ran' }, { source: 's' }), null);
});

// ── route scoring ────────────────────────────────────────────────────────────────────────────────
const FEEDER_GAME = { route: 'feeder', optiInstalled: true, feederDeployed: true, lumaDeployed: false, shipsDlss: false, lumaAvailable: true };
const DX11 = { api: 'dx11', bitness: 64 };

test('with no catalog word the scoring keeps the rules\' pick and only adds a runner-up', () => {
  const s = routescore.scoreRoutes(FEEDER_GAME, { exePath: 'C:\\g\\x.exe', detected: DX11, gpuVendor: 'nvidia' });
  assert.equal(s.chosen.key, 'feeder');
  assert.equal(s.overridden, false);
  assert.equal(s.runnerUp.key, 'lumaue');
  assert.ok(s.chosen.reasons.some((r) => /route rules/.test(r.text)));
});

test('one piece of evidence against the pick is not enough to move it; two are', () => {
  const entry = { exe: 'x.exe', setup: {}, reports: { works: 0, fails: 1 }, dead_ends: [{ route: 'feeder', why: 'crashed', source: 's' }] };
  const one = routescore.scoreRoutes(FEEDER_GAME, { exePath: 'C:\\g\\x.exe', detected: DX11, gpuVendor: 'nvidia', catalog: entry });
  assert.equal(one.chosen.key, 'feeder');
  const run = { ran: true, verdict: 'nr-model-crash', at: 't' };
  const two = routescore.scoreRoutes(FEEDER_GAME, { exePath: 'C:\\g\\x.exe', detected: DX11, gpuVendor: 'nvidia', catalog: entry, run });
  assert.equal(two.overridden, true);
  assert.equal(two.chosen.key, 'lumaue');
  assert.equal(two.chosen.fix, 'switch-to-luma');
  const proven = { ...entry, status: 'works', setup: { route: 'lumaue' }, reports: { works: 1, fails: 1 } };
  assert.equal(routescore.scoreRoutes(FEEDER_GAME, { exePath: 'C:\\g\\x.exe', detected: DX11, gpuVendor: 'nvidia', catalog: proven }).chosen.key, 'lumaue');
});

test('an infeasible route is listed with its reason and never chosen', () => {
  const s = routescore.scoreRoutes({ route: 'optiscaler', optiInstalled: true, shipsDlss: true }, { exePath: 'C:\\g\\y.exe', detected: { api: 'dx12' }, gpuVendor: 'nvidia' });
  const feeder = s.ranked.find((c) => c.key === 'feeder');
  assert.equal(feeder.feasible, false);
  assert.match(feeder.reasons[0].text, /two DLSS DLLs/);
  assert.equal(s.chosen.key, 'optiscaler');
});

// ── Game Help ────────────────────────────────────────────────────────────────────────────────────
function helpCtx(extra = {}) {
  return {
    detected: DX11, route: { ...FEEDER_GAME }, foreign: [], run: { ran: true, verdict: 'nr-model-crash', at: 't' },
    mvProvider: null, ...extra,
  };
}

test('Game Help offers the switch the evidence prefers, with the reason against the current route', () => {
  // A 32-bit DirectX 9 game on dgVoodoo2 that the catalog marks a dead end there, after a wrapper crash.
  const r = {
    route: 'feeder32', optiInstalled: true, complete: true, dgVoodooDeployed: true, dxvkDeployed: false,
    legacy: { supported: true, host32: true, api: 'dx9', dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } },
  };
  const detected = { api: 'dx9', bitness: 32 };
  const entry = { exe: 'x.exe', setup: {}, reports: {}, dead_ends: [{ route: 'feeder32', via: 'dgvoodoo', why: 'the game crashes in dgVoodoo2', source: 's' }] };
  const run = { ran: true, verdict: 'wrapper-crash', detail: 'D3D9.dll', at: 't' };
  const ctx = helpCtx({ detected, route: r, run });
  ctx.routeScore = routescore.scoreRoutes(r, { exePath: 'C:\\g\\x.exe', detected, gpuVendor: 'nvidia', catalog: entry, run });
  const d = gamehelp.diagnose(ctx);
  assert.equal(d.code, 'catalog-prefers');
  assert.equal(d.fix.id, 'swap-to-dxvk');
  assert.equal(d.vars.route, 'feeder32');
  assert.equal(d.vars.via, 'dxvk');
  assert.equal(d.vars.pick, 'feeder32:dgvoodoo');
  assert.equal(d.vars.why, 'Known dead end: {why}');
});

test('a game where DLSS 5 runs is never told to switch', () => {
  const entry = { exe: 'x.exe', setup: { route: 'lumaue' }, status: 'works', reports: { works: 3 }, dead_ends: [{ route: 'feeder', why: 'w', source: 's' }] };
  const ctx = helpCtx({ run: { ran: true, verdict: 'nr-ran', at: 't', nrDispatch: 100 } });
  ctx.routeScore = routescore.scoreRoutes(ctx.route, { exePath: 'C:\\g\\x.exe', detected: DX11, gpuVendor: 'nvidia', catalog: entry, run: ctx.run });
  assert.equal(ctx.routeScore.overridden, true);
  assert.notEqual(gamehelp.diagnose(ctx).code, 'catalog-prefers');
});

// ── frame generation ─────────────────────────────────────────────────────────────────────────────
const RTX50 = { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU' };
const RTX40 = { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070' };
const RTX30 = { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3080' };

test('no frame rate, no suggestion; a frame rate at the target needs none; too low a base is not multiplied', () => {
  assert.equal(suggestFrameGen({ route: { route: 'feeder' } }), null);
  assert.equal(suggestFrameGen({ fps: 72, route: { route: 'feeder' } }).code, 'fg-not-needed');
  assert.equal(suggestFrameGen({ fps: 100, fpsTarget: 120, route: { route: 'feeder' } }).suggest, true);
  const low = suggestFrameGen({ fps: 22, route: { route: 'feeder' } });
  assert.equal(low.suggest, false);
  assert.equal(low.code, 'fg-base-too-low');
});

test('a Feeder game gets Lossless Scaling, never OptiScaler\'s own frame generation', () => {
  const s = suggestFrameGen({ fps: 44, route: { route: 'feeder' }, gpu: RTX50, hasNativeFg: true, lossless: { installed: true } });
  assert.equal(s.generator, 'lossless');
  assert.equal(s.code, 'fg-lossless');
  assert.equal(s.multiplier, 2);
  assert.equal(suggestFrameGen({ fps: 44, route: { route: 'feeder' } }).code, 'fg-lossless-get');
});

test('a game with its own DLSS Frame Generation uses it: any multiplier on RTX 50, 2x on RTX 40 or the unlock above it', () => {
  const base = { route: { route: 'optiscaler' }, hasNativeFg: true };
  const r50 = suggestFrameGen({ ...base, fps: 24 * 1.5, fpsTarget: 90, gpu: RTX50 });
  assert.deepEqual([r50.generator, r50.multiplier], ['native-dlssg', 3]);
  const r40 = suggestFrameGen({ ...base, fps: 45, gpu: RTX40 });
  assert.deepEqual([r40.generator, r40.multiplier], ['native-dlssg', 2]);
  const r40hi = suggestFrameGen({ ...base, fps: 35, fpsTarget: 120, gpu: RTX40 });
  assert.deepEqual([r40hi.generator, r40hi.multiplier], ['rtxmfg', 4]);
  assert.equal(suggestFrameGen({ ...base, fps: 45, gpu: RTX30 }).generator, 'lossless', 'no DLSS-G below RTX 40');
});

test('one generator at a time, and the catalog\'s dead ends and proof are respected', () => {
  assert.equal(suggestFrameGen({ fps: 40, route: { route: 'feeder' }, configured: ['Lossless Scaling'] }).code, 'fg-already');
  assert.equal(suggestFrameGen({ fps: 40, route: { route: 'feeder' }, smoothMotion: true }).code, 'fg-smooth-motion');
  const deadNative = { dead_ends: [{ feature: 'native-dlssg', why: 'w', source: 's' }] };
  assert.equal(suggestFrameGen({ fps: 45, route: { route: 'optiscaler' }, hasNativeFg: true, gpu: RTX50, catalog: deadNative }).generator, 'lossless');
  const batman = catalog.lookup('C:\\Batman\\BatmanAK.exe');
  assert.equal(suggestFrameGen({ fps: 45, route: { route: 'feeder' }, catalog: batman }).vars.proven, true);
});

test('the suggestion runs on a report\'s digest', () => {
  const f = parseDigest(fixture('fg-heartbeat.md'));
  const s = suggestFrameGen({ fps: f.heartbeatFps || f.fps, fpsTarget: f.fpsTarget, route: { route: f.route }, gpu: RTX50, hasNativeFg: true });
  assert.equal(s.generator, 'native-dlssg');
  assert.equal(s.multiplier, 3, '38 fps toward a 100 fps target');
});

// ── route.js: the catalog's default, and Experimental ────────────────────────────────────────────
const UE4_DX11 = { engineId: 'unreal', engine: 'Unreal Engine 4.21', engineVersion: '4.21', api: 'dx11' };

test('a route the catalog proves is known good; one it does not is Experimental', () => {
  const er = scratchDir('kg-er');
  const exe = fakeExe(er, 'eldenring.exe');
  const r = route.recommendRoute(er, exe, { api: 'dx12', bitness: 64 }, 'nvidia');
  assert.equal(r.route, 'present');
  assert.equal(r.knownGood.proven, true);
  assert.equal(r.unproven, false);
  assert.equal(r.knownGood.badge.text, 'Known good');
  assert.equal(r.score.chosen.key, 'present');

  const other = scratchDir('kg-ue4');
  const ue = fakeExe(path.join(other, 'Foo', 'Binaries', 'Win64'), 'Foo-Win64-Shipping.exe');
  const u = route.recommendRoute(path.dirname(ue), ue, UE4_DX11, 'nvidia');
  assert.equal(u.route, 'feeder');
  assert.equal(u.knownGood, null);
  assert.equal(u.unproven, true);
});

test('a proven route becomes the default where the rules had a choice', () => {
  const other = scratchDir('kg-steer');
  const ue = fakeExe(path.join(other, 'Foo', 'Binaries', 'Win64'), 'Foo-Win64-Shipping.exe');
  const dir = path.dirname(ue);
  const provenLuma = { exe: 'foo-win64-shipping.exe', status: 'works', setup: { route: 'lumaue' }, reports: { works: 1 }, dead_ends: [] };
  const r = route.recommendRoute(dir, ue, UE4_DX11, 'nvidia', { catalog: provenLuma });
  assert.equal(r.route, 'lumaue');
  assert.equal(r.catalogDefault, true);
  assert.equal(r.knownGood.proven, true);

  const er = scratchDir('kg-er-steer');
  const exe = fakeExe(er, 'eldenring.exe');
  const provenFeeder = { exe: 'eldenring.exe', status: 'works', setup: { route: 'feeder' }, reports: { works: 1 }, dead_ends: [] };
  const f = route.recommendRoute(er, exe, { api: 'dx12', bitness: 64 }, 'nvidia', { catalog: provenFeeder });
  assert.equal(f.route, 'feeder');
  assert.equal(f.catalogDefault, true);
});

test('the catalog never overrides a choice made by hand', () => {
  const other = scratchDir('kg-hand');
  const ue = fakeExe(path.join(other, 'Foo', 'Binaries', 'Win64'), 'Foo-Win64-Shipping.exe');
  const dir = path.dirname(ue);
  const provenLuma = { exe: 'foo-win64-shipping.exe', status: 'works', setup: { route: 'lumaue' }, reports: { works: 1 }, dead_ends: [] };
  // An API chosen in Edit: the rules decide, as before.
  const byHand = route.recommendRoute(dir, ue, { ...UE4_DX11, apiOverride: 'dx11' }, 'nvidia', { catalog: provenLuma });
  assert.equal(byHand.route, 'feeder');
  assert.equal(byHand.catalogDefault, false);
  assert.equal(byHand.unproven, true);
  // A Feeder placed by hand on a game the catalog proves on the Present route stays the Feeder.
  const er = scratchDir('kg-er-hand');
  const exe = fakeExe(er, 'eldenring.exe');
  write(er, 'dlss5-feed.addon64', 'x');
  const r = route.recommendRoute(er, exe, { api: 'dx12', bitness: 64 }, 'nvidia');
  assert.equal(r.route, 'feeder');
  assert.equal(r.catalogDefault, false);
  assert.equal(r.knownGood.badge.kind, 'issue', 'and the card says the Feeder is a known dead end here');
});

// An engine with no heartbeat has no frame count, and the digest says "ran" instead of turning a
// log-line count into one. That still reads back as the pass having run.
test('a digest with no frame count still reads back as the neural pass having run', () => {
  const run = { ran: true, verdict: 'shutdown-fault', at: '2026-09-18T12:00:00Z', nrFrames: 0, nrDispatch: 1 };
  const f = parseDigest(`**Game:** NMS\n**Exe:** NMS.exe\n\n${runlog.reportDigest(run, { route: { route: 'optiscaler' } })}`);
  assert.equal(f.neuralPasses, null, 'no number claimed');
  assert.equal(f.neuralRan, true);
});
