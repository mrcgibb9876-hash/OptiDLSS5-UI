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

const MANUAL_KEYS = ['CleanUpStrength', 'CleanUpEdge', 'CleanUpBalance', 'CleanUpMotion'];

test('the Image Clean Up keys match the engine contract', () => {
  const mode = field('CleanUpMode');
  assert.equal(mode.type, 'enum');
  assert.equal(mode.default, 0);
  assert.deepEqual(mode.options, [[0, 'Off'], [1, 'Auto'], [2, 'Manual']]);
  assert.equal(mode.label, 'Mode');

  const expect = {
    CleanUpMaxStrength: { min: 0, max: 1, default: 0.8, label: 'Max strength' },
    CleanUpStrength: { min: 0, max: 1, default: 0.6, label: 'Strength' },
    CleanUpEdge: { min: 0.25, max: 4, default: 1.5, label: 'Edge threshold' },
    CleanUpBalance: { min: 0, max: 1, default: 0.5, label: 'Fine / wide' },
    CleanUpMotion: { min: 0, max: 1, default: 0.5, label: 'Motion protection' },
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
  // Left on default (null in the ini) is Off.
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
  assert.equal(cleanUpStatus(null, reading), '', 'default (Off) says nothing');
  assert.equal(cleanUpStatus(1, null), '', 'no live reading (no game) says nothing');
  assert.equal(cleanUpStatus(1, undefined), '', 'an engine without the block says nothing');
  for (const mode of [1, 2]) {
    assert.equal(cleanUpStatus(mode, { mode, strength: null, haloBefore: null, haloAfter: null, composeMs: null }), 'Measuring the glow...');
    assert.equal(cleanUpStatus(mode, { mode, strength: 0.6, haloBefore: null, haloAfter: 0.01, composeMs: null }), 'Measuring the glow...');
  }
});

test('the read-out: the engine\'s numbers, and a null one left out rather than shown as 0', () => {
  assert.equal(cleanUpStatus(1, { mode: 1, strength: 0.42, haloBefore: 0.1234, haloAfter: 0.0456, composeMs: 0.1 }),
    'Strength 0.42 -- glow 0.123 stops from the model, 0.046 after');
  // A tiny negative "after" is drawn as 0, as the in-game panel does.
  assert.equal(cleanUpStatus(2, { mode: 2, strength: 0.6, haloBefore: 0.2, haloAfter: -0.001 }),
    'Strength 0.60 -- glow 0.200 stops from the model, 0.000 after');
  assert.equal(cleanUpStatus(1, { mode: 1, strength: null, haloBefore: 0.2, haloAfter: 0.05 }),
    'Glow 0.200 stops from the model, 0.050 after');
  assert.equal(cleanUpStatus(1, { mode: 1, strength: 0.5, haloBefore: 0.2, haloAfter: null }),
    'Strength 0.50 -- glow 0.200 stops from the model');
  assert.equal(cleanUpStatus(1, { mode: 1, strength: null, haloBefore: 0.2, haloAfter: null }),
    'Glow 0.200 stops from the model');
});

test('the read-out follows each live poll, drawn under the Mode row', () => {
  assert.match(fnSource('refreshLive'), /renderCleanUpStatus\(\)/);
  assert.match(fnSource('renderFields'), /section\.cleanup && key === 'CleanUpMode'/);
});
