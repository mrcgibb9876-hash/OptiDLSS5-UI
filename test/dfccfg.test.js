'use strict';
// deep-fried-chicken.cfg, read and written by our panel (src/dfccfg.js).
//
// Writing this file is what Chicken's LICENSE.txt expressly allows ("create and share your own
// Deep Fried Chicken configuration and preset files"), while shipping its binaries is what it
// forbids -- which is why dfc.js still never downloads anything.
//
// The load-bearing property is that a rewrite loses nothing. The real file is 663 keys of flat
// key=value with comments, and this app understands about a tenth of them; every other line has to
// survive byte-for-byte or a player's tuning quietly resets.

const test = require('node:test');
const assert = require('node:assert');

const cfg = require('../src/dfccfg');

// Shaped like the real CP376 file: schema line, plain ints, fixed-point floats, a comment block,
// repeated per-layer keys, and a trailing comment. Not the author's own file -- a stand-in with
// the same structure, so nothing of his is carried in this repo.
const SAMPLE = [
  'config_schema=13',
  'arm=1',
  'enabled=1',
  'passes=1.0',
  'layers=1',
  'neural_work_percent=100',
  'texture_boost=0',
  'texture_boost_strength=1.000',
  'layer_1_nr_preset=1',
  'layer_1_intensity=1.000',
  'layer_2_nr_preset=1',
  'layer_2_intensity=1.000',
  '',
  '# Live neural residual controls; neutral preserves the normal result.',
  'residual_shadow_multiplier=1.000',
  'glow_suppression=0.000',
  '',
].join('\n');

test('a rewrite that changes one key changes exactly one line', () => {
  const { text, changed } = cfg.applyEdits(SAMPLE, { passes: 4 });
  assert.deepStrictEqual(changed, ['passes']);

  const before = SAMPLE.split('\n');
  const after = text.split('\n');
  assert.strictEqual(before.length, after.length, 'no lines added or lost');
  const differing = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
  assert.deepStrictEqual(differing.map((i) => after[i]), ['passes=4']);
});

test('comments, blank lines, ordering and keys this app has never heard of all survive', () => {
  const { text } = cfg.applyEdits(SAMPLE, { enabled: 0 });
  assert.ok(text.includes('# Live neural residual controls; neutral preserves the normal result.'));
  assert.ok(text.includes('glow_suppression=0.000'), 'an unknown key is untouched');
  assert.ok(text.includes('layer_2_intensity=1.000'), 'per-layer blocks are untouched');
  assert.match(text, /^config_schema=13\n/, 'the schema line stays first');
  assert.ok(text.endsWith('\n'), 'the trailing newline is kept');
});

test('a repeated key is rewritten at every occurrence, not just the first', () => {
  // The sibling transport config ships disable_motion_vectors twice on purpose. Rewriting one and
  // leaving the other would produce a file that contradicts itself, and the last one is what wins.
  const twice = 'config_schema=13\ndisable_motion_vectors=0\nmode=2\ndisable_motion_vectors=0\n';
  const { text } = cfg.applyEdits(twice, { disable_motion_vectors: 1 });
  assert.strictEqual(text, 'config_schema=13\ndisable_motion_vectors=1\nmode=2\ndisable_motion_vectors=1\n');
});

test('CRLF stays CRLF, so a rewrite does not show up as every line changed', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const { text } = cfg.applyEdits(crlf, { layers: 2 });
  assert.ok(text.includes('\r\n'), 'still CRLF');
  assert.ok(!/[^\r]\n/.test(text), 'and no bare LF crept in');
});

test('a key the file does not have is appended, inside the body', () => {
  const { text, changed } = cfg.applyEdits(SAMPLE, { motion_stability_enabled: 1 });
  assert.deepStrictEqual(changed, ['motion_stability_enabled']);
  const lines = text.split('\n');
  const added = lines.indexOf('motion_stability_enabled=1');
  const comment = lines.indexOf('# Live neural residual controls; neutral preserves the normal result.');
  assert.ok(added !== -1, 'it is there');
  assert.ok(added > lines.indexOf('config_schema=13'), 'after the body starts');
  assert.ok(added > comment, 'after the last key line, which here follows the comment block');
});

test('values are written in a form Chicken can parse', () => {
  assert.strictEqual(cfg.formatValue(true), '1');
  assert.strictEqual(cfg.formatValue(false), '0');
  assert.strictEqual(cfg.formatValue(4), '4');
  assert.strictEqual(cfg.formatValue(0.65), '0.650');
  assert.strictEqual(cfg.formatValue('auto'), 'auto');
});

test('a cfg from a newer Chicken is left completely alone', () => {
  // config_schema is the version of the format these defaults were read from (CP376 = 13). A file
  // claiming something higher came from a build that may have changed what a key means, and
  // rewriting it from a stale field table is how a good setting becomes a wrong one.
  const newer = SAMPLE.replace('config_schema=13', 'config_schema=14');
  const r = cfg.applyEdits(newer, { passes: 9 });
  assert.strictEqual(r.text, newer, 'byte for byte unchanged');
  assert.deepStrictEqual(r.changed, []);
  assert.deepStrictEqual(r.skipped, ['passes']);
  assert.match(r.refused, /newer than the 13 this app knows/);
});

test('reading tells the panel what it covers and what it does not', () => {
  const r = cfg.readFields(SAMPLE);
  assert.strictEqual(r.schema, 13);
  assert.strictEqual(r.tooNew, false);
  const passes = r.fields.find((f) => f.key === 'passes');
  assert.deepStrictEqual({ value: passes.value, present: passes.present }, { value: '1.0', present: true });
  const absent = r.fields.find((f) => f.key === 'motion_stability_enabled');
  assert.strictEqual(absent.present, false, 'a field the file lacks is reported, not invented');
  // The panel says how much of the file it covers, so nobody reads it as all of Chicken's settings.
  assert.ok(r.totalKeys > r.offeredKeys, `${r.offeredKeys} of ${r.totalKeys} offered`);
});

test('every offered field names a key, a type and a label', () => {
  for (const f of cfg.FIELDS) {
    assert.match(f.key, /^[a-z0-9_]+$/, `${f.key} is a real cfg key name`);
    assert.ok(['bool', 'number'].includes(f.type), `${f.key} has a known type`);
    assert.ok(f.label && f.label.length, `${f.key} has a label`);
    if (f.type === 'number' && f.min !== undefined) assert.ok(f.max > f.min, `${f.key} range`);
    if (f.dependsOn) assert.ok(cfg.FIELD_KEYS.has(f.dependsOn), `${f.key} depends on an offered field`);
  }
});

test('the field table stays a subset: nothing is offered that the shipped file does not carry', () => {
  // Guards against a field being invented from a plausible-sounding name. Every key here was read
  // out of a real CP376 deep-fried-chicken.cfg.
  const REAL_KEYS = new Set([
    'config_schema', 'arm', 'hook_mode', 'enabled', 'passes', 'layers', 'neural_work_percent',
    'neural_work_divisor', 'texture_boost', 'texture_boost_strength', 'clean_fry_enabled',
    'clean_fry_cleanup_strength', 'clean_fry_detail_retention', 'motion_stability_enabled',
    'motion_stability_strength', 'motion_stability_detail_retention', 'frame_generation_coexistence',
    'preserve_native_tone_color', 'preserve_native_tone_color_strength',
  ]);
  for (const f of cfg.FIELDS) assert.ok(REAL_KEYS.has(f.key), `${f.key} is not a key the shipped cfg has`);
});

test('mixed line endings in one file survive, because a real Chicken config has them', () => {
  // dfc-universal-feed.cfg in CP376 Beta is genuinely mixed: 3 CRLF and 36 LF. A file-wide "is this
  // CRLF" flag normalised the lot, which rewrote every line -- found by round-tripping the real
  // file rather than by the hand-written sample above, which was uniform and passed happily.
  const mixed = 'config_schema=13\r\nmode=2\npassthrough=0\r\nmv_scale_x=1.0\n';
  assert.strictEqual(cfg.serialise(cfg.parse(mixed)), mixed, 'a no-op round trip is byte-identical');

  const { text } = cfg.applyEdits(mixed, { passthrough: 1 });
  assert.strictEqual(text, 'config_schema=13\r\nmode=2\npassthrough=1\r\nmv_scale_x=1.0\n');
});

test('a file with no trailing newline stays that way, and an append still lands on its own line', () => {
  const noEol = 'config_schema=13\nenabled=1';
  assert.strictEqual(cfg.serialise(cfg.parse(noEol)), noEol);
  const { text } = cfg.applyEdits(noEol, { layers: 3 });
  assert.strictEqual(text, 'config_schema=13\nenabled=1\nlayers=3\n');
});

// Read out of Chicken 3.0's own menu (its add-on's draw code), 2026-09-22. The table had drifted from
// it: a whole-number pass count where his slider is 1.0-30.0 in tenths, a 1-100 work range where his is
// 10-150, and five keys his menu never shows.
test('the offered fields match Chicken\'s own menu: its labels, its ranges, nothing it does not show', () => {
  const by = Object.fromEntries(cfg.FIELDS.map((f) => [f.key, f]));
  assert.deepStrictEqual({ min: by.passes.min, max: by.passes.max, step: by.passes.step, label: by.passes.label },
    { min: 1, max: 30, step: 0.1, label: 'Pass amount' });
  assert.deepStrictEqual({ min: by.neural_work_percent.min, max: by.neural_work_percent.max, label: by.neural_work_percent.label },
    { min: 10, max: 150, label: 'Resolution scale' });
  for (const gone of ['arm', 'layers', 'texture_boost', 'texture_boost_strength', 'preserve_native_tone_color',
    'preserve_native_tone_color_strength', 'frame_generation_coexistence']) {
    assert.ok(!cfg.FIELD_KEYS.has(gone), `${gone} is not in Chicken's menu, so it is not offered here`);
  }
  // A fractional pass count is written as the decimal it is, not rounded to a whole pass.
  const { text } = cfg.applyEdits('config_schema=13\npasses=1.0\n', { passes: 2.5 });
  assert.match(text, /^passes=2\.500$/m);
});
