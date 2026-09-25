'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const route = require(path.join(REPO, 'src', 'route'));
const explain = require(path.join(REPO, 'src', 'route-explain'));
const nrmodelonly = require(path.join(REPO, 'src', 'nrmodelonly'));
const engines = require(path.join(REPO, 'src', 'engines'));

test('every route id recommendRoute can return has an explanation, and the RE Engine id shares the Present one', () => {
  for (const id of ['optiscaler', 'feeder', 'feeder32', 'lumaue', 'amdnr', 'unsupported', 'unknown', 'present', 'reframework-pd']) {
    const e = explain.explainRoute({ route: id });
    assert.ok(e && e.does, `${id} has a "does" line`);
  }
  assert.equal(explain.explainKey({ route: 'reframework-pd' }), 'present');
  assert.equal(explain.explainRoute({ route: 'no-such-route' }), null);
  assert.equal(explain.explainRoute(null), null);
});

test('the explanation follows the route that was actually picked, API and all', () => {
  const vk = scratchDir('explain-vk');
  const vkExe = fakeExe(vk, 'Doom.exe');
  const r = route.recommendRoute(vk, vkExe, { api: 'vulkan', apis: ['vulkan'] }, 'nvidia');
  assert.equal(r.explain.key, 'feeder-vulkan');
  assert.match(r.explain.limits, /Smooth Motion/);
  assert.match(r.explain.panel, /Insert/);

  const dx = scratchDir('explain-dx11');
  const dxExe = fakeExe(dx, 'Foo.exe');
  const f = route.recommendRoute(dx, dxExe, { api: 'dx11', apis: ['dx11'] }, 'nvidia');
  assert.equal(f.route, 'feeder');
  assert.equal(f.explain.key, 'feeder');
  assert.match(f.explain.limits, /estimated/);
  assert.equal(f.layerExplain, null, 'no translation layer to choose on a plain 64-bit route');
});

test('RE Engine\'s Present route says there are no motion vectors, so fast motion may ghost', () => {
  const dir = scratchDir('explain-re2');
  const exe = fakeExe(dir, 're2.exe');
  write(dir, 're_chunk_000.pak', 'x');
  const r = route.recommendRoute(dir, exe, { api: 'dx12', apis: ['dx12'], engineId: 're' }, 'nvidia');
  assert.equal(r.route, 'reframework-pd');
  assert.equal(r.explain.key, 'present');
  assert.match(r.explain.limits, /no motion vectors/);
  // REFramework owns Insert on RE Engine, so its panel line alone names Alt+Home; the other Present
  // games (Elden Ring, Armored Core VI, Nightreign) say Insert like everything else.
  assert.match(r.explain.panel, /Press Alt\+Home/);
  assert.match(r.explain.panel, /REFramework keeps Insert/);
  assert.match(explain.explainRoute({ route: 'present' }).panel, /Press Insert/);
  assert.match(r.explain.limits, /ghost/);
});

test('a 32-bit game gets the helper explanation, Insert, and the layer choices', () => {
  const dir = scratchDir('explain-32');
  const exe = fakeExe(dir, 'Old.exe');
  const r = route.recommendRoute(dir, exe, { api: 'dx9', apis: ['dx9'], bitness: 32, legacyApis: ['dx9'] }, 'nvidia');
  assert.equal(r.route, 'feeder32');
  assert.equal(r.explain.key, 'feeder32');
  assert.match(r.explain.does, /64-bit helper/);
  assert.match(r.explain.panel, /Insert/);
  assert.ok(r.layerExplain && r.layerExplain.dgvoodoo && r.layerExplain.dxvk && r.layerExplain.native);
});

test('emulators name themselves, and on OpenGL the panel offered is this app\'s own window', () => {
  const emu = { name: 'Dolphin', system: 'GameCube', hint: 'Graphics > Backend' };
  const d3d = explain.explainRoute({ route: 'feeder', emulator: emu }, 'dx11');
  assert.equal(d3d.key, 'emulator');
  assert.deepEqual(d3d.vars, { name: 'Dolphin' });
  assert.match(d3d.does, /\{name\}/);
  // OptiScaler cannot draw over OpenGL, so there is no in-game panel -- but it is in the process, so
  // the break-away panel edits its ini as anywhere else. Saying "no panel" sent people away with
  // nothing when a working one was a keypress off.
  const gl = explain.explainRoute({ route: 'feeder', emulator: emu }, 'opengl');
  assert.equal(gl.key, 'emulator-opengl');
  assert.equal(gl.panel, null, 'nothing of OptiScaler is drawn in the game on OpenGL');
  assert.equal(gl.popout, 'only', 'but it is in the process, so its ini can still be edited');
  assert.equal(explain.explainRoute({ route: 'feeder', legacy: { api: 'dx9' } }, 'dx9').key, 'dx9');
});

// "I need the in-game menu to work in all games": the overlay OptiScaler draws cannot be made universal
// (a game can swallow the key, an anti-cheat can block the hook, the 32-bit route only mirrors the
// helper's), but the break-away panel can -- it is our own window and it writes the ini the engine
// re-reads. So every route with OptiScaler in the game offers it. Whether its hotkey actually works is
// the renderer's to decide (popoutHotkeyUsable), which is why this is a flag and not a sentence.
test('every route with OptiScaler in the game offers the break-away panel, and the others offer nothing', () => {
  const withOptiScaler = ['optiscaler', 'feeder', 'feeder-vulkan', 'feeder-opengl', 'feeder32', 'dx9',
    'emulator', 'present', 'lumaue'];
  for (const key of withOptiScaler) {
    const e = explain.explainRoute({ route: key === 'feeder-vulkan' || key === 'feeder-opengl' ? 'feeder' : key },
      key === 'feeder-vulkan' ? 'vulkan' : key === 'feeder-opengl' ? 'opengl' : null);
    assert.ok(e && e.panel, `${key} draws a panel in the game`);
    assert.equal(e.popout, 'fallback', `${key} should offer the break-away panel as a fallback`);
  }
  // OpenGL in an emulator draws nothing, but OptiScaler is still there to be configured.
  assert.equal(explain.explainRoute({ route: 'feeder', emulator: { name: 'x' } }, 'opengl').popout, 'only');

  // No OptiScaler in the game: neither panel can reach it, so neither is promised.
  for (const key of ['nr-model-only', 'amdnr', 'unsupported', 'unknown']) {
    const e = key === 'nr-model-only'
      ? explain.explainRoute({ route: 'optiscaler', nrModelOnly: true })
      : explain.explainRoute({ route: key });
    assert.equal(e.popout, null, `${key} has no OptiScaler, so no panel of either kind`);
  }
});

test('every locale translates every route explanation, keeping its placeholders', () => {
  // The card's folded 'How this route works' block and its 'What it does' / 'Limits' headings went with
  // the card's route text (2026-09-25); 'Panel' still heads the pop-out line.
  const keys = ['Panel', ...explain.allStrings()];
  const dir = path.join(REPO, 'src', 'renderer', 'locales');
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    let dict = null;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    new Function('window', src)({ I18N: { register: (_code, d) => { dict = d; } } });
    const have = new Map(Object.entries(dict).map(([k, v]) => [norm(k), v]));
    for (const k of keys) {
      assert.ok(have.has(norm(k)), `${file} is missing: ${k}`);
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(have.get(norm(k))).match(/\{\w+\}/g) || []).sort().join();
      assert.equal(got, want, `${file} placeholders for: ${k}`);
    }
  }
});

// Assassin's Creed Black Flag Resynced, 2026-09-19: "the in-game menu used to open and now it does not".
// Game Help's model-only route had taken OptiScaler out of the game (the trade it states), but route.js
// goes on recommending `optiscaler` for a game that ships its own DLSS -- so the card kept showing that
// route's "Press Insert for the DLSS 5 panel" line for a game with no OptiScaler left in it.
test('a game left on the model-only route says the panel is gone, not "press Insert"', () => {
  const dir = scratchDir('explain-model-only');
  const exe = fakeExe(dir, 'acblackflag.exe');
  write(dir, 'nvngx_dlss.dll', 'the game\'s own DLSS');
  const det = { api: 'dx12', apis: ['dx12'], bitness: 64 };

  const before = route.recommendRoute(dir, exe, det, 'nvidia');
  assert.equal(before.route, 'optiscaler');
  assert.equal(before.explain.key, 'optiscaler');
  assert.match(before.explain.panel, /Press Insert/);

  // What the route leaves behind: the model, and the marker recording that we placed it.
  write(dir, 'nvngx_dlssnr.dll', 'the model');
  write(dir, nrmodelonly.NRMODEL_MARKER, JSON.stringify({ target: '.', placed: true }));
  const after = route.recommendRoute(dir, exe, det, 'nvidia');
  assert.equal(after.route, 'optiscaler', 'the route the game could have is unchanged');
  assert.equal(after.explain.key, 'nr-model-only');
  assert.match(after.explain.panel, /No panel on this route/);
  assert.doesNotMatch(after.explain.panel, /Press Insert/);
  assert.match(after.explain.does, /loads the Neural Rendering model by itself/);
});

// The second engine build came back on 2026-09-19 (engines.js presr, wilsjo2's Pre-SR fork). It draws
// no panel inside the game, so a game on it must not be told to press Insert -- the break-away panel
// is the whole answer there. Same failure this file already guards for the model-only route.
test('a game on an engine build with no in-game panel is pointed at the pop-out only', () => {
  const dir = scratchDir('explain-presr');
  const exe = fakeExe(dir, 'FakeGame.exe');
  write(dir, 'nvngx_dlss.dll', 'the game\'s own DLSS');
  const det = { api: 'dx12', apis: ['dx12'], bitness: 64 };

  const ours = route.recommendRoute(dir, exe, det, 'nvidia');
  assert.match(ours.explain.panel, /Press Insert/, 'our build draws one');

  write(dir, engines.ENGINE_MARKER, JSON.stringify({ engine: 'presr' }));
  const presr = route.recommendRoute(dir, exe, det, 'nvidia');
  assert.equal(presr.explain.key, 'optiscaler', 'the route is unchanged -- only the panel changes');
  assert.equal(presr.explain.panel, null, 'this build draws nothing in the game');
  assert.equal(presr.explain.popout, 'only', 'so the break-away panel is the only way in');

  // A marker naming a build that does draw one, and a marker naming nothing we ship, both get ours.
  write(dir, engines.ENGINE_MARKER, JSON.stringify({ engine: 'dlssnr' }));
  assert.match(route.recommendRoute(dir, exe, det, 'nvidia').explain.panel, /Press Insert/);
  write(dir, engines.ENGINE_MARKER, JSON.stringify({ engine: 'nonsense' }));
  assert.match(route.recommendRoute(dir, exe, det, 'nvidia').explain.panel, /Press Insert/);
});

// The model-only route has no OptiScaler in the game at all, so the build it once used is irrelevant:
// its own line (press Install) must survive a stale engine marker rather than being replaced.
test('the model-only line is not overwritten by a panel-less build marker', () => {
  const dir = scratchDir('explain-presr-modelonly');
  const exe = fakeExe(dir, 'FakeGame.exe');
  write(dir, 'nvngx_dlss.dll', 'the game\'s own DLSS');
  write(dir, 'nvngx_dlssnr.dll', 'the model');
  write(dir, nrmodelonly.NRMODEL_MARKER, JSON.stringify({ target: '.', placed: true }));
  write(dir, engines.ENGINE_MARKER, JSON.stringify({ engine: 'presr' }));
  const r = route.recommendRoute(dir, exe, { api: 'dx12', apis: ['dx12'], bitness: 64 }, 'nvidia');
  assert.equal(r.explain.key, 'nr-model-only');
  assert.match(r.explain.panel, /Press Install/);
});
