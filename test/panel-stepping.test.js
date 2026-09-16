// Keyboard stepping on the DLSS 5 sliders.
//
// The sliders are positioned on a 0..1000 scale so a log range (Paper white runs 0.25 to 2000) can
// be resolved at all. The cost is that the browser's own arrow-key step becomes a thousandth of the
// range, which is not a number anybody wants: 0.002 of a Model pass, 0.175% of Model resolution.
// Each field's declared step is what should move, and repeated presses should land on round values
// -- 1.1, 1.2, 1.3 -- because tuning is done by nudging one control and looking at the picture.
//
// The stepping helpers live in the renderer, which has no module system (plain scripts, no bundler),
// so this reads them out of the shipped file rather than testing a copy that could drift from it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO } = require('./helpers');
const dlssnr = require(path.join(REPO, 'src', 'dlssnr'));

function stepping(file) {
  const src = fs.readFileSync(path.join(REPO, 'src', 'renderer', file), 'utf8');
  const start = src.indexOf('const STEP_DIR');
  assert.ok(start > 0, `${file} has no STEP_DIR -- keyboard stepping was removed?`);
  const end = src.indexOf('\nfunction ', src.indexOf('function steppedValue'));
  const scope = {};
  new Function('exports', src.slice(start, end) + '\nexports.steppedValue = steppedValue; exports.stepOf = stepOf;')(scope);
  return scope;
}

const field = (key) => dlssnr.FIELDS.find((f) => f.key === key);

for (const file of ['panel.js', 'renderer.js']) {
  test(`${file}: a press moves the field's own step, not a thousandth of the range`, () => {
    const { steppedValue } = stepping(file);

    // 0.1 at a time, landing on 0.1 boundaries every time.
    const guard = field('MaxRatio');
    let v = guard.default;
    const seen = [];
    for (let i = 0; i < 5; i++) { v = steppedValue(guard, v, 1, false); seen.push(Number(v.toFixed(4))); }
    assert.deepEqual(seen, [2.1, 2.2, 2.3, 2.4, 2.5]);

    // An integer field moves whole numbers, not fractions of one.
    const passes = field('Passes');
    assert.equal(steppedValue(passes, 1, 1, false), 2);
    assert.equal(steppedValue(passes, 2, 1, false), 3);
  });

  test(`${file}: a value off the grid snaps onto it instead of carrying the drift`, () => {
    const { steppedValue } = stepping(file);
    const guard = field('MaxRatio');
    // 2.037 came from dragging the handle. Stepping up should reach 2.1, not 2.137.
    assert.equal(Number(steppedValue(guard, 2.037, 1, false).toFixed(4)), 2.1);
    assert.equal(Number(steppedValue(guard, 2.037, -1, false).toFixed(4)), 2.0);
  });

  test(`${file}: stepping never leaves the field's range`, () => {
    const { steppedValue } = stepping(file);
    for (const f of dlssnr.FIELDS.filter((x) => x.type === 'float' || x.type === 'int')) {
      const up = steppedValue(f, f.max, 1, true);
      const down = steppedValue(f, f.min, -1, true);
      assert.ok(up <= f.max, `${f.key} stepped above its max: ${up}`);
      assert.ok(down >= f.min, `${f.key} stepped below its min: ${down}`);
      assert.ok(Number.isFinite(up) && Number.isFinite(down), `${f.key} produced a non-number`);
    }
  });

  test(`${file}: Page Up moves ten steps, so a long range is crossable`, () => {
    const { steppedValue, stepOf } = stepping(file);
    const detail = field('TransferStrength');
    const one = steppedValue(detail, 1, 1, false);
    const ten = steppedValue(detail, 1, 1, true);
    assert.equal(Number((one - 1).toFixed(4)), stepOf(detail));
    assert.equal(Number((ten - 1).toFixed(4)), Number((stepOf(detail) * 10).toFixed(4)));
  });
}
