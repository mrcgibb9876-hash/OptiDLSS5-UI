'use strict';
// A game's translation layer becomes something other than the standard one (dgVoodoo2 on DirectX 8/9,
// the game's own Direct3D on a 32-bit DirectX 10/11 game) ONLY when the known-good catalog proves that
// layer for that exact game (layerdefault.js, catalog.provenLayer) -- never across the board. A layer
// picked by hand, or already installed, always wins; DXVK_BLOCKED always wins; a dead-end layer is never
// the default. All fixtures: no game is launched and nothing is fetched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, scratchDir, write, loadMain } = require('./helpers');
const catalog = require(path.join(REPO, 'src', 'catalog'));
const layerdefault = require(path.join(REPO, 'src', 'layerdefault'));
const legacy = require(path.join(REPO, 'src', 'legacy'));
const translation = require(path.join(REPO, 'src', 'translation'));
const route = require(path.join(REPO, 'src', 'route'));
const routescore = require(path.join(REPO, 'src', 'routescore'));
const build = require(path.join(REPO, 'tools', 'catalog', 'build'));
const detect = require(path.join(REPO, 'src', 'detect'));

const onWindows = process.platform === 'win32';
const SYS = process.env.SystemRoot || 'C:\\Windows';

const works = (exe, routeId, via, extra = {}) => ({
  exe, name: exe, status: 'works', setup: { route: routeId, via, api: 'dx11' },
  reports: { works: 1, fails: 0 }, dead_ends: [], sources: ['test fixture'], ...extra,
});
const DX11_32 = { api: 'dx11', apis: ['dx11'], bitness: 32, recommend: 'optiscaler' };
const DX9_32 = { api: 'dx9', apis: ['dx9'], bitness: 32, recommend: 'optiscaler', legacyApis: ['dx9'] };
const DX9_64 = { api: 'dx9', apis: ['dx9'], bitness: 64, recommend: 'optiscaler', legacyApis: ['dx9'] };

// ── catalog.provenLayer ──────────────────────────────────────────────────────────────────────────

test('a layer is proven only by a working run on that route, and a dead end or DXVK_BLOCKED cancels it', () => {
  const e = works('game.exe', 'feeder32', 'dxvk');
  assert.deepEqual(catalog.provenLayer(e, { route: 'feeder32' }), { via: 'dxvk', source: 'test fixture' });
  assert.equal(catalog.provenLayer(e, { route: 'feeder' }), null, 'proof on another route says nothing');
  assert.equal(catalog.provenLayer(e, { route: 'feeder32', dxvkBlocked: true }), null);
  assert.equal(catalog.provenLayer({ ...e, status: 'no-route' }, { route: 'feeder32' }), null);
  assert.equal(catalog.provenLayer({ ...e, reports: { works: 0, fails: 1 } }, { route: 'feeder32' }), null);
  assert.equal(catalog.provenLayer(works('game.exe', 'feeder32', null), { route: 'feeder32' }), null, 'no layer recorded, none proven');
  const dead = { ...e, dead_ends: [{ route: 'feeder32', via: 'dxvk', api: 'dx9', why: 'shakes', source: 's' }] };
  assert.equal(catalog.provenLayer(dead, { route: 'feeder32' }), null, 'a dead end on that layer, whatever its API');
  const routeDead = { ...e, dead_ends: [{ route: 'feeder32', why: 'crash', source: 's' }] };
  assert.equal(catalog.provenLayer(routeDead, { route: 'feeder32' }), null, 'a dead end on the whole route');
});

test('the validator refuses a layer on a route that has none, and "native" off the 32-bit route', () => {
  assert.match(catalog.validateEntry(works('a.exe', 'present', 'dxvk')).join('\n'), /no translation layer/);
  assert.match(catalog.validateEntry(works('a.exe', 'feeder', 'native')).join('\n'), /only a choice on the feeder32 route/);
  assert.deepEqual(catalog.validateEntry(works('a.exe', 'feeder32', 'dxvk')), []);
});

// ── layerdefault.resolve ─────────────────────────────────────────────────────────────────────────

test('order: a hand pick, then what is installed, then the proven layer, then the standard one', () => {
  const plan32dx11 = legacy.planFor({ bitness: 32, api: 'dx11' });
  const plan32dx9 = legacy.planFor({ bitness: 32, api: 'dx9' });
  const entry = works('game.exe', 'feeder32', 'dxvk');
  const r = (o) => layerdefault.resolve({ route: 'feeder32', plan: plan32dx11, entry, ...o });
  assert.equal(layerdefault.standardLayer('feeder32', plan32dx11), 'native');
  assert.equal(layerdefault.standardLayer('feeder32', plan32dx9), 'dgvoodoo');
  assert.equal(layerdefault.standardLayer('optiscaler', null), null);
  assert.deepEqual([r({}).layer, r({}).from], ['dxvk', 'proven']);
  assert.deepEqual([r({ handPick: 'native' }).layer, r({ handPick: 'native' }).from], ['native', 'hand']);
  assert.deepEqual([r({ installed: 'native' }).layer, r({ installed: 'native' }).from], ['native', 'installed']);
  assert.deepEqual([r({ entry: null }).layer, r({ entry: null }).from], ['native', 'standard']);
  // Blocked: neither the hand pick nor the proof can make it DXVK.
  const blocked = r({ handPick: 'dxvk', dxvkBlocked: true });
  assert.deepEqual([blocked.layer, blocked.from, blocked.proven], ['native', 'standard', null]);
  // dgVoodoo2 is not a choice on a DirectX 10/11 game, whatever a hand-written marker says.
  assert.equal(r({ handPick: 'dgvoodoo', entry: null }).from, 'standard');
  assert.equal(layerdefault.resolve({ route: 'optiscaler', plan: null, entry }), null, 'a route with no layer');
});

// ── route.js ─────────────────────────────────────────────────────────────────────────────────────

test('a 32-bit DirectX 10/11 game proven on DXVK defaults to DXVK; unproven, it stays native', () => {
  const dir = scratchDir('layer-proven-dx11');
  const exe = write(dir, 'Game.exe', 'MZ');
  const plain = route.recommendRoute(dir, exe, DX11_32, 'nvidia', { catalog: null });
  assert.equal(plain.wrapperPreference, null);
  assert.deepEqual(plain.steps.map((s) => s.key), ['feeder32'], 'no proof: the game\'s own Direct3D, as before');
  assert.equal(plain.layerChoice.from, 'standard');

  const proven = route.recommendRoute(dir, exe, DX11_32, 'nvidia', { catalog: works('game.exe', 'feeder32', 'dxvk') });
  assert.equal(proven.wrapperPreference, 'dxvk');
  assert.deepEqual(proven.steps.map((s) => [s.key, s.done]), [['feeder32', false], ['dxvk', false]]);
  assert.equal(proven.layerChoice.from, 'proven');
  assert.equal(routescore.pickVia(proven), 'dxvk');
  assert.equal(routescore.placedVia(proven), 'native', 'nothing placed: a run here would have been on native');
});

test('a hand pick of the standard layer, an installed game and an API set in Edit all keep the proven DXVK out', () => {
  const entry = works('game.exe', 'feeder32', 'dxvk');
  // Picked back by hand (Edit / Game Help record it): stays native.
  const hand = scratchDir('layer-hand');
  const exeH = write(hand, 'Game.exe', 'MZ');
  translation.writePreference(hand, 'native');
  const h = route.recommendRoute(hand, exeH, DX11_32, 'nvidia', { catalog: entry });
  assert.deepEqual([h.wrapperPreference === 'dxvk', h.layerChoice.from], [false, 'hand']);
  assert.ok(!h.steps.some((s) => s.key === 'dxvk'));
  assert.equal(h.layerChoice.proven.via, 'dxvk', 'the proof is still shown');

  // Already installed on its own Direct3D: a proven default never swaps an installed game.
  const inst = scratchDir('layer-installed');
  const exeI = write(inst, 'Game.exe', 'MZ');
  write(inst, legacy.MARKER, JSON.stringify({ host32: true }));
  const i = route.recommendRoute(inst, exeI, DX11_32, 'nvidia', { catalog: entry });
  assert.deepEqual([i.wrapperPreference === 'dxvk', i.layerChoice.from], [false, 'installed']);
  assert.ok(!i.steps.some((s) => s.key === 'dxvk'));

  // An API chosen in Edit: the catalog's evidence was for the detected API.
  const api = scratchDir('layer-apioverride');
  const exeA = write(api, 'Game.exe', 'MZ');
  const a = route.recommendRoute(api, exeA, { ...DX11_32, apiOverride: 'dx11' }, 'nvidia', { catalog: entry });
  assert.equal(a.layerChoice.from, 'standard');
});

test('DXVK_BLOCKED wins over a proof, and a dead-end layer is never the default', () => {
  const dir = scratchDir('layer-blocked');
  const exe = write(dir, 'AssassinsCreedIIGame.exe', 'MZ');
  const r = route.recommendRoute(dir, exe, DX9_32, 'nvidia', { catalog: works('assassinscreediigame.exe', 'feeder32', 'dxvk') });
  assert.equal(r.layerChoice.layer, 'dgvoodoo');
  assert.ok(r.steps.some((s) => s.key === 'dgvoodoo') && !r.steps.some((s) => s.key === 'dxvk'));

  const dead = scratchDir('layer-dead');
  const exeD = write(dead, 'Game.exe', 'MZ');
  const entry = { ...works('game.exe', 'feeder32', 'dxvk'), dead_ends: [{ route: 'feeder32', via: 'dxvk', why: 'crash', source: 's' }] };
  assert.equal(route.recommendRoute(dead, exeD, DX9_32, 'nvidia', { catalog: entry }).layerChoice.from, 'standard');
});

test('a 64-bit DirectX 9 game proven on DXVK names DXVK as the step Install owes', () => {
  const dir = scratchDir('layer-dx9-64');
  const exe = write(dir, 'Game.exe', 'MZ');
  const r = route.recommendRoute(dir, exe, DX9_64, 'nvidia', { catalog: works('game.exe', 'feeder', 'dxvk') });
  assert.equal(r.route, 'feeder');
  assert.equal(r.wrapperPreference, 'dxvk');
  assert.deepEqual(r.steps[0], { key: 'dxvk', label: route.ROUTE_TEXT.stepDxvkChosen, done: false });
  const plain = route.recommendRoute(dir, exe, DX9_64, 'nvidia', { catalog: null });
  assert.equal(plain.steps[0].key, 'dgvoodoo', 'unproven: dgVoodoo2, as before');
});

// ── the shipped catalog ──────────────────────────────────────────────────────────────────────────

test('a shipped DXVK default needs a real run behind it; Max Payne 2 is the one, Alien: Isolation is proven on native', () => {
  // Moving a game off its standard layer by default is a claim about that game, so the entry has to
  // carry the run that proved it: a success count and a live-run source. Max Payne 2 (2026-09-24) is
  // the first -- 4,500 DLSS 5 frames on DXVK, where dgVoodoo2 cannot work at all (its dead end).
  const doc = JSON.parse(fs.readFileSync(catalog.SHIPPED_FILE, 'utf8'));
  const dxvkDefaults = [];
  for (const e of doc.entries) {
    const p = catalog.provenLayer(e, { route: (e.setup || {}).route, dxvkBlocked: !!translation.dxvkBlockedFor(e.exe) });
    if (!p || p.via !== 'dxvk') continue;
    dxvkDefaults.push(e.exe);
    assert.ok(((e.reports || {}).works || 0) > 0, `${e.exe}: a shipped DXVK default needs a successful run counted`);
    assert.ok((e.sources || []).some((s) => /^live (test|run)/.test(s)), `${e.exe}: a shipped DXVK default needs a real run behind it`);
  }
  assert.deepEqual(dxvkDefaults, ['maxpayne2.exe']);
  assert.deepEqual(catalog.provenLayer(catalog.lookup('D:\\Games\\Alien Isolation\\AI.exe'), { route: 'feeder32' }).via, 'native');
  const lines = build.provenLayerLines(doc.entries).join('\n');
  assert.match(lines, /proven layer: ai\.exe feeder32:native/);
  assert.match(lines, /dead-end layer: assassinscreediigame\.exe feeder32:dxvk/);
  assert.match(lines, /proven layer: maxpayne2\.exe feeder32:dxvk {2}<- Install now defaults to DXVK for this game/);
  assert.match(lines, /dead-end layer: maxpayne2\.exe feeder32:dgvoodoo/);
});

// ── learning from this machine's runs ────────────────────────────────────────────────────────────

test('a run is recorded with the layer that was PLACED, and a DXVK run makes DXVK the proven default', () => {
  const dir = scratchDir('layer-learn');
  const local = path.join(dir, 'known-good.local.json');
  catalog.configure({ localFile: local });
  try {
    const game = path.join(dir, 'game');
    const exe = write(game, 'Game.exe', 'MZ');
    translation.writeManifest(game, translation.newManifest({ layer: 'dxvk', arch: 'x32', files: ['d3d11.dll'] }));
    write(game, legacy.MARKER, JSON.stringify({ host32: true }));
    const placed = route.recommendRoute(game, exe, DX11_32, 'nvidia');
    assert.equal(routescore.placedVia(placed), 'dxvk');
    const learned = catalog.learnFromRun({
      exePath: exe, run: { ran: true, verdict: 'nr-ran', at: '2026-09-19T01:00:00Z' },
      setup: { route: placed.route, via: routescore.placedVia(placed), api: 'dx11' },
    });
    assert.equal(learned.kind, 'works');
    const entry = catalog.lookup(exe);
    assert.deepEqual(catalog.provenLayer(entry, { route: 'feeder32' }).via, 'dxvk');

    // The same game, reinstalled from scratch in a new folder: Install now defaults to DXVK.
    const fresh = path.join(dir, 'fresh');
    const exe2 = write(fresh, 'Game.exe', 'MZ');
    const r = route.recommendRoute(fresh, exe2, DX11_32, 'nvidia');
    assert.deepEqual([r.wrapperPreference, r.layerChoice.from], ['dxvk', 'proven']);

    // A run that did not show DLSS 5 running proves nothing.
    const other = path.join(dir, 'other');
    const exe3 = write(other, 'Other.exe', 'MZ');
    assert.equal(catalog.learnFromRun({ exePath: exe3, run: { ran: true, verdict: 'feed-no-motion', at: 'x' }, setup: { route: 'feeder32', via: 'dxvk' } }), null);
    assert.equal(route.recommendRoute(other, exe3, DX11_32, 'nvidia').layerChoice.from, 'standard');
  } finally {
    catalog.configure({ localFile: null });
  }
});

// ── main.js: Install and the swap-backs follow the same answer ──────────────────────────────────

test('picking native back over a proven DXVK records it, so the proof does not simply return', { skip: !onWindows }, async () => {
  const base = scratchDir('layer-swapback');
  const game = path.join(base, 'game');
  fs.mkdirSync(game, { recursive: true });
  const exe = path.join(game, 'Game.exe');
  fs.copyFileSync(path.join(SYS, 'SysWOW64', 'notepad.exe'), exe);
  fs.appendFileSync(exe, Buffer.from('\0D3D11CreateDevice\0', 'latin1'));
  const { invoke } = loadMain({ dialogResponse: 0 });
  const local = path.join(base, 'known-good.local.json');
  fs.writeFileSync(local, JSON.stringify({ version: 1, entries: [works('game.exe', 'feeder32', 'dxvk')] }));
  catalog.configure({ localFile: local });
  try {
    const detected = await detect.detectGame(game, exe);
    const before = await invoke('game:route', { exePath: exe, detected });
    assert.deepEqual([before.route, before.wrapperPreference, before.layerChoice.from], ['feeder32', 'dxvk', 'proven']);
    const res = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-native' });
    assert.equal(res.done, true, res.text);
    assert.equal(translation.readPreference(game), 'native');
    assert.ok(!fs.existsSync(path.join(game, 'd3d11.dll')), 'nothing was placed');
    const after = await invoke('game:route', { exePath: exe, detected });
    assert.deepEqual([after.wrapperPreference === 'dxvk', after.layerChoice.from, after.layerChoice.proven.via], [false, 'hand', 'dxvk']);
  } finally {
    catalog.configure({ localFile: null });
  }
});

test('Install asks for the layer before it places anything, and learning uses the placed layer', () => {
  const main = fs.readFileSync(path.join(REPO, 'src', 'main.js'), 'utf8');
  const host = main.slice(main.indexOf("ipcMain.handle('legacy:installHost32'"));
  const asked = host.indexOf('const dxvkForNative');
  const deployed = host.indexOf('legacy.deployHost32(');
  assert.ok(asked > 0 && asked < deployed, 'dxvkWanted is asked before the helper goes in');
  const dg = main.slice(main.indexOf("ipcMain.handle('legacy:dgvoodoo'"));
  assert.ok(dg.indexOf('await dxvkWanted(dir, exePath, detected)') > 0 && dg.indexOf('await dxvkWanted(dir, exePath, detected)') < dg.indexOf('legacy.deployDgVoodoo('));
  assert.match(main, /via: routescore\.placedVia\(route\)/);
  assert.doesNotMatch(main, /translation\.readPreference\(dir\) === 'dxvk' && !translation\.dxvkBlockedFor\(exePath\)\) \{/, 'no install path reads the hand pick alone');
});

test('the proven-layer strings are in every locale', () => {
  // The card's proven-layer chip and its two hover lines left with the chip line (2026-09-25).
  const keys = ['Proven layer', 'native Direct3D',
    'DXVK is proven on this game, so Install puts it in front of the game. Pick the other layer here to keep the usual one.'];
  const dir = path.join(REPO, 'src', 'renderer', 'locales');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    let dict = null;
    global.window = { I18N: { register: (_l, o) => { dict = o; } } };
    try {
      delete require.cache[require.resolve(path.join(dir, f))];
      require(path.join(dir, f));
    } finally {
      delete global.window;
    }
    for (const k of keys) {
      assert.ok(dict[k], `${f}: ${k}`);
      if (k.includes('{layer}')) assert.ok(dict[k].includes('{layer}'), `${f}: placeholder kept in ${k}`);
    }
  }
});
