// Image Clean Up (engine feat/image-cleanup, 2026-09-26): the glow the model leaves around characters.
//
// The pop-out has to draw it where and how the in-game panel does -- its own section on the Image page
// after the tone trim, Mode first, Max strength live only in Auto, the four tuning rows only in Manual --
// and show the engine's own reading from OptiScaler.live.json under the Mode row.
//
// The renderer has no module system, so its helpers are read out of the shipped panel.js (as
// panel-stepping.test.js does) rather than tested as a copy that could drift from it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO } = require('./helpers');
const dlssnr = require(path.join(REPO, 'src', 'dlssnr'));

const PANEL = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'panel.js'), 'utf8').replace(/\r\n/g, '\n');
const field = (key) => dlssnr.FIELDS.find((f) => f.key === key);

// One top-level function out of panel.js, by name.
function fnSource(name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(PANEL);
  assert.ok(m, `panel.js has no ${name}()`);
  const start = m.index;
  const end = PANEL.indexOf('\n}\n', start);
  return PANEL.slice(start, end + 3);
}

// English t(), with i18n.js's {placeholder} filling.
const t = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

function dependencyMetWith(values) {
  const valueOf = (key) => {
    const f = field(key);
    const v = values[key];
    return v === undefined || v === null ? (f ? f.default : null) : v;
  };
  return new Function('valueOf', `${fnSource('dependencyMet')}\nreturn dependencyMet;`)(valueOf);
}

const cleanUpStatus = new Function('t', `${fnSource('cleanUpStatus')}\nreturn cleanUpStatus;`)(t);

const MANUAL_KEYS = ['CleanUpStrength', 'CleanUpEdge', 'CleanUpBalance', 'CleanUpMotion',
  'CleanUpBleed', 'CleanUpBleedInner', 'CleanUpBleedOuter', 'CleanUpDodge', 'CleanUpBurn'];

test('the Image Clean Up keys match the engine contract', () => {
  const mode = field('CleanUpMode');
  assert.equal(mode.type, 'enum');
  assert.equal(mode.default, 1, 'Auto is the engine\'s default (b45eced6), so "auto" in the ini is Auto');
  assert.deepEqual(mode.options, [[0, 'Off'], [1, 'Auto'], [2, 'Manual']]);
  assert.equal(mode.label, 'Mode');

  const expect = {
    CleanUpMaxStrength: { min: 0, max: 1, default: 0.8, label: 'Max strength' },
    CleanUpStrength: { min: 0, max: 1, default: 0.6, label: 'Strength' },
    CleanUpEdge: { min: 0.25, max: 4, default: 1.5, label: 'Edge threshold' },
    CleanUpBalance: { min: 0, max: 1, default: 0.5, label: 'Fine / wide' },
    CleanUpMotion: { min: 0, max: 1, default: 0.5, label: 'Motion protection' },
    CleanUpBleed: { min: 0, max: 1, default: 1.0, label: 'Bleed', cleanupLive: 'bleed' },
    CleanUpBleedInner: { min: 0, max: 1, default: 0.5, label: 'Inner bleed', cleanupLive: 'bleedInner' },
    CleanUpBleedOuter: { min: 0, max: 1, default: 1.0, label: 'Outer bleed', cleanupLive: 'bleedOuter' },
    CleanUpDodge: { min: 0, max: 0.5, default: 0.0, label: 'Dodge', cleanupLive: 'dodge' },
    CleanUpBurn: { min: 0, max: 0.5, default: 0.1, label: 'Burn', cleanupLive: 'burn' },
  };
  for (const [key, want] of Object.entries(expect)) {
    const f = field(key);
    assert.ok(f, `${key} exists`);
    // A slider, never a typed box: a float with a range and a step.
    assert.equal(f.type, 'float', `${key} is a slider`);
    for (const [k, v] of Object.entries(want)) assert.equal(f[k], v, `${key}.${k}`);
    assert.ok(f.step > 0, `${key} has a step`);
    assert.ok(f.help, `${key} has help`);
  }
});

test('Image Clean Up sits on the Image page after the tone trim, before Colour, Mode first', () => {
  const image = dlssnr.PAGES.find((p) => p.page === 'Image');
  const captions = image.sections.map((s) => s.caption);
  const at = captions.indexOf('Image Clean Up');
  assert.ok(at > 0, 'the section exists');
  assert.equal(captions[at - 1], 'How much of it lands');
  assert.equal(captions[at + 1], 'Colour');
  const section = image.sections[at];
  assert.equal(section.cleanup, true, 'the renderer draws the live read-out in it');
  assert.deepEqual(section.keys, ['CleanUpMode', 'CleanUpMaxStrength', ...MANUAL_KEYS]);
  // After Brightness and Contrast, which are in the section before.
  assert.ok(image.sections[at - 1].keys.includes('Contrast'));
});

test('Off greys everything below Mode; Auto only Max strength live; Manual only the four rows', () => {
  const cases = [
    [0, []],
    [1, ['CleanUpMaxStrength']],
    [2, MANUAL_KEYS],
  ];
  for (const [mode, live] of cases) {
    const met = dependencyMetWith({ CleanUpMode: mode });
    for (const key of ['CleanUpMaxStrength', ...MANUAL_KEYS]) {
      assert.equal(met(field(key)), live.includes(key), `mode ${mode}: ${key}`);
    }
    // The mode itself is never greyed -- it is what turns the rest on.
    assert.equal(met(field('CleanUpMode')), true);
  }
  // Left on default (null in the ini) is Auto: Max strength live, the Manual rows not.
  assert.equal(dependencyMetWith({})(field('CleanUpMaxStrength')), true);
  assert.equal(dependencyMetWith({})(field('CleanUpStrength')), false);
});

test('Debug view offers the Image Clean Up mask as view 4, and says what it shows', () => {
  const dv = field('DebugView');
  assert.deepEqual(dv.options[4], [4, 'Image Clean Up mask']);
  assert.match(dv.help, /Image Clean Up mask shows the frame in grey/);
  assert.equal(dlssnr.parseValue(dv, '4'), 4);
});

test('the Clean Up keys read back from the ini, clamped to the engine range', () => {
  assert.equal(dlssnr.parseValue(field('CleanUpMode'), '2'), 2);
  assert.equal(dlssnr.parseValue(field('CleanUpMode'), '7'), null, 'an unknown mode reads as default');
  assert.equal(dlssnr.parseValue(field('CleanUpEdge'), '9'), 4);
  assert.equal(dlssnr.parseValue(field('CleanUpEdge'), '0.1'), 0.25);
  assert.equal(dlssnr.parseValue(field('CleanUpMaxStrength'), 'auto'), null);
});

test('the read-out: nothing when Off or with no reading, "Measuring" until the glow is measured', () => {
  const reading = { mode: 1, strength: 0.42, haloBefore: 0.1234, haloAfter: 0.0456, composeMs: 0.1 };
  assert.equal(cleanUpStatus(0, reading), '', 'Off says nothing');
  assert.equal(cleanUpStatus(null, reading), '', 'no mode given says nothing');
  assert.equal(cleanUpStatus(1, null), '', 'no live reading (no game) says nothing');
  assert.equal(cleanUpStatus(1, undefined), '', 'an engine without the block says nothing');
  for (const mode of [1, 2]) {
    const word = mode === 2 ? 'Manual' : 'Auto';
    assert.equal(cleanUpStatus(mode, { mode, strength: null, haloBefore: null, haloAfter: null, composeMs: null }), `${word}  ·  Measuring the glow...`);
    assert.equal(cleanUpStatus(mode, { mode, strength: 0.6, haloBefore: null, haloAfter: 0.01, composeMs: null }), `${word}  ·  Measuring the glow...`);
  }
});

test('the read-out: mode, the engine\'s numbers and the cost, a null one left out rather than shown as 0', () => {
  assert.equal(cleanUpStatus(1, { mode: 1, strength: 0.42, haloBefore: 0.1234, haloAfter: 0.0456, composeMs: 0.1 }),
    'Auto  ·  Strength 0.42 -- glow 0.123 stops from the model, 0.046 after  ·  0.10 ms');
  // A tiny negative "after" is drawn as 0, as the in-game panel does.
  assert.equal(cleanUpStatus(2, { mode: 2, strength: 0.6, haloBefore: 0.2, haloAfter: -0.001 }),
    'Manual  ·  Strength 0.60 -- glow 0.200 stops from the model, 0.000 after');
  assert.equal(cleanUpStatus(1, { mode: 1, strength: null, haloBefore: 0.2, haloAfter: 0.05, composeMs: null }),
    'Auto  ·  Glow 0.200 stops from the model, 0.050 after');
  assert.equal(cleanUpStatus(1, { mode: 1, strength: 0.5, haloBefore: 0.2, haloAfter: null }),
    'Auto  ·  Strength 0.50 -- glow 0.200 stops from the model');
  assert.equal(cleanUpStatus(1, { mode: 1, strength: null, haloBefore: 0.2, haloAfter: null }),
    'Auto  ·  Glow 0.200 stops from the model');
  // The mode is the engine's once it reports one; before it has picked up the ini, the ini's.
  assert.match(cleanUpStatus(2, { mode: 1, strength: 0.5, haloBefore: 0.2, haloAfter: 0.1 }), /^Auto  ·  /);
  assert.match(cleanUpStatus(2, { strength: 0.5, haloBefore: 0.2, haloAfter: 0.1 }), /^Manual  ·  /);
});

// Auto + Advanced (2026-09-26): the page shows Off / Auto and the read-out; Manual and every slider fold
// under an Advanced caption that starts closed.
test('Advanced holds every Clean Up slider, and only keys the section already draws', () => {
  const section = dlssnr.PAGES.find((p) => p.page === 'Image').sections.find((s) => s.cleanup);
  assert.deepEqual(section.advanced, ['CleanUpMaxStrength', ...MANUAL_KEYS]);
  for (const key of section.advanced) assert.ok(section.keys.includes(key), `${key} is in the section`);
  assert.ok(!section.advanced.includes('CleanUpMode'), 'the mode stays on the page');
  // The engine's next keys are named in a comment only, until it has them.
  for (const key of ['CleanUpGrain', 'CleanUpPrint', 'CleanUpPlate']) {
    assert.ok(!field(key), `${key} is not a field yet`);
  }
});

const CLEANUP_CONSTS = 'const CLEANUP_AUTO = 1; const CLEANUP_MANUAL = 2;';
const fromPanel = (name, args, ...values) =>
  new Function(...args, `${CLEANUP_CONSTS}\n${fnSource(name)}\nreturn ${name};`)(...values);

test('the page\'s Mode row offers Off and Auto only, still writing the one CleanUpMode key', () => {
  const drawn = [];
  const cleanUpModeRow = fromPanel('cleanUpModeRow', ['fieldRow'], (f, set) => { drawn.push({ f, set }); return f; });
  const mode = { ...field('CleanUpMode'), value: null };
  const row = cleanUpModeRow(mode);
  assert.deepEqual(row.options, [[0, 'Off'], [1, 'Auto']]);
  assert.equal(row.key, 'CleanUpMode');
  assert.equal(drawn[0].set, undefined, 'through apply(), so Off (the default) is written as auto');
  assert.deepEqual(mode.options, [[0, 'Off'], [1, 'Auto'], [2, 'Manual']], 'the field itself is untouched');
});

test('Advanced starts closed, opens by itself only on Manual, and a click wins for the window\'s life', () => {
  const section = { caption: 'Image Clean Up', cleanup: true };
  for (const [mode, open] of [[0, false], [1, false], [2, true]]) {
    const isAdvancedOpen = fromPanel('isAdvancedOpen', ['valueOf', 'advancedOpen'], () => mode, new Map());
    assert.equal(isAdvancedOpen(section), open, `mode ${mode}`);
  }
  const clicked = new Map([['Image Clean Up', false]]);
  const isAdvancedOpen = fromPanel('isAdvancedOpen', ['valueOf', 'advancedOpen'], () => 2, clicked);
  assert.equal(isAdvancedOpen(section), false, 'closed by hand stays closed on Manual');
  // In memory only, as the page and the HDR page's folds are: nothing written anywhere.
  assert.doesNotMatch(fnSource('renderAdvanced'), /localStorage|window\.api/);
});

test('the Manual switch: on is Manual, off is back to Auto', () => {
  const writes = [];
  for (const mode of [0, 1, 2]) {
    let drawn = null;
    const cleanUpManualRow = fromPanel('cleanUpManualRow', ['valueOf', 'fieldRow', 'apply', 't'],
      () => mode, (f, set) => { drawn = { f, set }; return f; }, (k, v) => writes.push([k, v]), t);
    cleanUpManualRow();
    assert.equal(drawn.f.type, 'bool');
    assert.equal(drawn.f.value, mode === 2, `mode ${mode}`);
    assert.equal(drawn.f.label, 'Manual');
    drawn.set('CleanUpMode', !drawn.f.value);
  }
  assert.deepEqual(writes, [['CleanUpMode', 2], ['CleanUpMode', 2], ['CleanUpMode', 1]]);
});

test('the read-out follows each live poll, drawn under the Mode row', () => {
  assert.match(fnSource('refreshLive'), /renderCleanUpStatus\(\)/);
  const render = fnSource('renderFields');
  assert.match(render, /section\.cleanup && key === 'CleanUpMode'/);
  assert.match(render, /cleanUpModeRow\(field\)/);
  // A folded Advanced draws its caption and none of its rows.
  assert.match(render, /if \(!advanced\.open\) continue;/);
});

// Engine b45eced6: Bleed, Inner bleed, Outer bleed, Dodge and Burn, the engine's own words, and the
// rows showing Auto's own values from live.json outside Manual, read-only.
test('the edge-treatment rows carry the engine\'s exact English', () => {
  const words = {
    CleanUpBleed: "How much of the light the model spills across a character's outline is taken back. 0 leaves the model's edges as they are.",
    CleanUpBleedInner: "The light band just inside a character's outline, on the character.",
    CleanUpBleedOuter: "The glow just outside a character's outline, on the background.",
    CleanUpDodge: "Limits how far the model may lighten an area the game's picture gives it no detail to lighten, in stops. 0 allows none.",
    CleanUpBurn: 'Limits how far the model may darken an area beyond its surroundings, so no dark ring is left behind, in stops.',
  };
  for (const [key, help] of Object.entries(words)) {
    assert.equal(field(key).help, help, key);
    assert.deepEqual(field(key).dependsOn, { key: 'CleanUpMode', is: 2 }, `${key} takes effect only in Manual`);
    // Each label and tooltip is in every language.
    for (const lang of ['de', 'es', 'fr', 'ko', 'pt-BR', 'ru', 'zh-CN']) {
      const text = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'locales', `${lang}.js`), 'utf8');
      assert.ok(text.includes(JSON.stringify(help) + ':'), `${lang}: ${key} help`);
      assert.ok(text.includes(JSON.stringify(field(key).label) + ':'), `${lang}: ${key} label`);
    }
  }
  // "auto" in the ini reads as the default; a hand-set Burn below 0 is drawn at the slider's 0.
  assert.equal(dlssnr.parseValue(field('CleanUpBurn'), 'auto'), null);
  assert.equal(dlssnr.parseValue(field('CleanUpBurn'), '-1'), 0);
  // The renderer is handed which live reading each row shows.
  const rows = dlssnr.readSettings(path.join(REPO, 'no-such-ini'));
  assert.equal(rows.find((r) => r.key === 'CleanUpBleedInner').cleanupLive, 'bleedInner');
  assert.equal(rows.find((r) => r.key === 'CleanUpEdge').cleanupLive, null, 'live.json has no reading for Edge');
});

test('outside Manual a row shows Auto\'s value from live.json; in Manual its own', () => {
  const byKey = (key) => ({ ...field(key) });
  const make = (mode, live) => {
    const isAuto = fromPanel('isCleanUpAutoRow', ['valueOf'], () => mode);
    const value = new Function('lastLive', `${fnSource('cleanUpLiveValue')}\nreturn cleanUpLiveValue;`)(live);
    return { isAuto, value };
  };
  const live = { cleanup: { mode: 1, strength: 0.42, bleed: 1, bleedInner: 0.35, bleedOuter: 0.9, dodge: 0.05, burn: -1 } };
  for (const mode of [0, 1]) {
    const { isAuto, value } = make(mode, live);
    assert.equal(isAuto(byKey('CleanUpBleedInner')), true, `mode ${mode}`);
    assert.equal(value(byKey('CleanUpBleedInner')), 0.35);
    assert.equal(value(byKey('CleanUpDodge')), 0.05);
    assert.equal(value(byKey('CleanUpStrength')), 0.42);
    assert.equal(value(byKey('CleanUpBurn')), 0, 'darkening off (below 0) is drawn at 0, as in game');
    assert.equal(isAuto(byKey('CleanUpEdge')), false, 'no live reading: the row keeps its own value');
  }
  const manual = make(2, live);
  assert.equal(manual.isAuto(byKey('CleanUpBleedInner')), false, 'Manual: the ini value, editable');
  // Before the engine reports a reading, the row shows its own value.
  const early = make(1, { cleanup: { mode: 1, bleedInner: null } });
  assert.equal(early.value(byKey('CleanUpBleedInner')), null);
  assert.equal(make(1, null).value(byKey('CleanUpBleedInner')), null);
  // Drawn from, and kept up to date with, each live poll.
  assert.match(fnSource('fieldRow'), /cleanupAuto \? cleanUpLiveValue\(field\)/);
  assert.match(fnSource('renderCleanUpStatus'), /data-cleanup-for/);
});

test('Fine / wide carries the engine\'s b45eced6 wording, in every language', () => {
  const help = 'How far out it looks: 0 only the pixels right beside each one, for a thin rim; 0.5 out to about 5 pixels; 1 out to about 12, for a glow that spreads well off the edge.';
  assert.equal(field('CleanUpBalance').help, help);
  for (const lang of ['de', 'es', 'fr', 'ko', 'pt-BR', 'ru', 'zh-CN']) {
    const text = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'locales', `${lang}.js`), 'utf8');
    assert.ok(text.includes(JSON.stringify(help) + ':'), `${lang} has the new wording`);
    assert.ok(!text.includes('"Where it looks: 0 only at the pixels'), `${lang} dropped the old wording`);
  }
});

// tools/cleanup-i18n-for-engine.json hands these translations to the engine's own tables. Keyed by the
// engine's source strings (its line breaks included); it must say what the pop-out says.
test('the translations handed to the engine match the pop-out\'s locales', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'cleanup-i18n-for-engine.json'), 'utf8'));
  assert.deepEqual(doc.languages, ['pt-BR', 'ru', 'ko', 'zh-CN', 'es', 'de', 'fr'], 'the engine\'s kLanguageCodes order');
  assert.equal(Object.keys(doc.strings).length, 10);
  const dicts = {};
  for (const lang of doc.languages) {
    let obj = null;
    const sandbox = { window: { I18N: { register(_c, o) { obj = o; } } } };
    new Function('window', fs.readFileSync(path.join(REPO, 'src', 'renderer', 'locales', `${lang}.js`), 'utf8'))(sandbox.window);
    dicts[lang] = obj;
  }
  const labels = ['CleanUpBleed', 'CleanUpBleedInner', 'CleanUpBleedOuter', 'CleanUpDodge', 'CleanUpBurn'];
  const expectKeys = labels.flatMap((k) => [field(k).label, field(k).help]);
  const all = { ...doc.strings, ...doc.alsoNew };
  const appKeys = Object.entries(doc.strings).map(([k, row]) => row._appKey || k);
  assert.deepEqual(appKeys, expectKeys, 'the ten new strings, label then tooltip');
  for (const [engineKey, row] of Object.entries(all)) {
    const appKey = row._appKey || engineKey;
    assert.equal(engineKey.replace(/\n/g, ' '), appKey, 'the same text, one line in the pop-out');
    for (const lang of doc.languages) assert.equal(row[lang], dicts[lang][appKey], `${lang}: ${appKey.slice(0, 30)}`);
  }
  assert.ok(Object.values(doc.alsoNew).some((row) => row._appKey === field('CleanUpBalance').help), 'and the new Fine / wide tooltip');
});
