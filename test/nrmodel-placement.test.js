'use strict';
// Where the model-only route puts nvngx_dlssnr.dll.
//
// The first cut of that route always wrote beside the exe, because deployAmdNrModel was written for
// the AMD route where there is no game-shipped Streamline to think about. That is a no-op on exactly
// the games most likely to need this route: an Unreal game's NGX looks in the plugin tree its own
// DLSS plugin passes to it, not in the exe folder. framegen.js already swaps the game's frame-gen
// DLL wherever the game itself put it; this is the same rule for the model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The function main.js's 'nr-model-only' now uses to pick its target folder (was a copy of it here).
const { targetDirFor } = require(path.join(__dirname, '..', 'src', 'nrmodelonly'));

const tmpGame = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nrmodel-'));

test('a game whose Streamline sits beside the exe keeps the model beside the exe', () => {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'sl.interposer.dll'), 'x');
  assert.equal(targetDirFor(dir), dir);
});

test("an Unreal game gets the model in the plugin tree, not beside the exe", () => {
  const dir = tmpGame();
  const plugin = path.join(dir, 'Engine', 'Plugins', 'DLSS', 'Binaries', 'ThirdParty', 'Win64');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'nvngx_dlss.dll'), 'x');
  assert.equal(targetDirFor(dir), plugin);
  assert.notEqual(targetDirFor(dir), dir);
});

// The route is only ever offered when route.shipsDlss is true, so this is the shape of a bug rather
// than a real call -- but falling back to the exe folder is the right answer if it ever happens,
// because that is where NGX looks when nothing else has told it otherwise.
test('a game with no DLSS of its own falls back to the exe folder', () => {
  const dir = tmpGame();
  assert.equal(targetDirFor(dir), dir);
});
