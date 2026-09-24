'use strict';
// Game Help tells an Indiana Jones player to add `+r_allowBlackListedLayers 1`, without which
// idTech refuses ReShade's Vulkan layer and the Feeder never loads. The card's Launch button then
// started the game WITHOUT it -- so the one launch this app controls was the one launch that still
// refused the layer, and the reporter kept a desktop shortcut of their own to work around our own
// button (2026-09-24, "i had also still to use my own shortcut").
//
// So: whatever the app tells someone to add, the app adds too.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const feeder = require(path.join(__dirname, '..', 'src', 'feeder'));

test('the layer-blacklist cvar is an argument for the exes that need it, and nothing for the rest', () => {
  assert.deepEqual(feeder.launchArgs('F:\\Games\\Indiana Jones\\TheGreatCircle.exe'), ['+r_allowBlackListedLayers', '1']);
  // Case and separator are the game's, not ours.
  assert.deepEqual(feeder.launchArgs('/games/x/thegreatcircle.EXE'), ['+r_allowBlackListedLayers', '1']);

  // Every other game launches exactly as before. An argument added on a hunch is a regression for
  // everyone it does not apply to, which is why LAYER_BLACKLIST_EXES is a list of confirmed exes
  // and not an engine guess.
  assert.deepEqual(feeder.launchArgs('D:\\Games\\DOOMEternalx64vk.exe'), []);
  assert.deepEqual(feeder.launchArgs('C:\\g\\Game.exe'), []);
  assert.deepEqual(feeder.launchArgs(''), []);
  assert.deepEqual(feeder.launchArgs(null), []);
});

test('the argument list is the one Game Help prints, so the two can never drift', () => {
  // renderer.js writes the cvar into its advice as a literal. If this app ever passed a different
  // string from the one it tells the user to type, one of the two would be wrong and nobody would
  // know which -- so the advice is checked against the arguments actually passed.
  const fs = require('node:fs');
  const advice = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const passed = feeder.launchArgs('TheGreatCircle.exe').join(' ');
  assert.equal(passed, '+r_allowBlackListedLayers 1');
  assert.ok(advice.includes(passed), `renderer.js should advise exactly "${passed}"`);
});
