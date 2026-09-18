'use strict';
// legacyPlanFor has to be given the game's detection.
//
// effectiveDetection(dir, exePath, {}) returns an object with no bitness and no api -- the API
// override on disk is the only thing it can fill in, and most games have none. legacy.planFor then
// falls straight through to "not a legacy game", so the DXVK swap answered "this game has no
// translation-layer route" on every game it was ever offered for: from the wrapper-crash verdict
// as well as from Game Help's button. Assassin's Creed II showed it (2026-09-18) -- 32-bit
// DirectX 9, a plan that is plainly supported, refused.
//
// Detection reads a real PE header, so an end-to-end test of the handler would be Windows-only.
// These two are not: one pins the behaviour that made the empty object wrong, and one guards the
// call site, the same way renderer-dom.test.js guards the renderer's element lookups.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const legacy = require(path.join(__dirname, '..', 'src', 'legacy'));

test('an empty detection is not a legacy plan, which is why {} was the bug', () => {
  assert.equal(legacy.planFor({}).supported, false);
  assert.equal(legacy.planFor({ api: 'dx9' }).supported, false, 'bitness alone missing is enough to fail');
  assert.equal(legacy.planFor({ bitness: 32 }).supported, false, 'api alone missing is enough to fail');
});

test('a 32-bit DirectX 9 game -- Assassin\'s Creed II -- has a supported plan DXVK serves', () => {
  const plan = legacy.planFor({ bitness: 32, api: 'dx9' });
  assert.equal(plan.supported, true);
  assert.equal(plan.host32, true);
  assert.equal(plan.api, 'dx9');
  assert.equal(plan.dgVoodoo.dll, 'D3D9.dll');
  assert.ok(['dx8', 'dx9', 'dx10', 'dx11'].includes(plan.api), 'DXVK ships a file set for this API');
});

test('no caller asks legacyPlanFor for a plan without a detection', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const empty = main.match(/legacyPlanFor\([^)]*,\s*\{\s*\}\s*\)/g) || [];
  assert.deepEqual(empty, [], 'legacyPlanFor with a literal {} always yields "not a legacy game"');
});
