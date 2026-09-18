'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const route = require(path.join(REPO, 'src', 'route'));
const explain = require(path.join(REPO, 'src', 'route-explain'));

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
  assert.match(r.explain.panel, /Alt\+Home/);

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
  assert.match(r.explain.limits, /ghost/);
});

test('a 32-bit game gets the helper explanation, Alt+Home, and the layer choices', () => {
  const dir = scratchDir('explain-32');
  const exe = fakeExe(dir, 'Old.exe');
  const r = route.recommendRoute(dir, exe, { api: 'dx9', apis: ['dx9'], bitness: 32, legacyApis: ['dx9'] }, 'nvidia');
  assert.equal(r.route, 'feeder32');
  assert.equal(r.explain.key, 'feeder32');
  assert.match(r.explain.does, /64-bit helper/);
  assert.match(r.explain.panel, /Alt\+Home/);
  assert.ok(r.layerExplain && r.layerExplain.dgvoodoo && r.layerExplain.dxvk && r.layerExplain.native);
});

test('emulators name themselves, and on OpenGL there is no panel to promise', () => {
  const emu = { name: 'Dolphin', system: 'GameCube', hint: 'Graphics > Backend' };
  const d3d = explain.explainRoute({ route: 'feeder', emulator: emu }, 'dx11');
  assert.equal(d3d.key, 'emulator');
  assert.deepEqual(d3d.vars, { name: 'Dolphin' });
  assert.match(d3d.does, /\{name\}/);
  const gl = explain.explainRoute({ route: 'feeder', emulator: emu }, 'opengl');
  assert.equal(gl.key, 'emulator-opengl');
  assert.equal(gl.panel, null);
  assert.equal(explain.explainRoute({ route: 'feeder', legacy: { api: 'dx9' } }, 'dx9').key, 'dx9');
});

test('every locale translates every route explanation, keeping its placeholders', () => {
  const keys = ['How this route works', 'What it does', 'Limits', 'Panel', ...explain.allStrings()];
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
