'use strict';
// The Ezio-era Assassin's Creed games shake under DXVK on Windows (DXVK issue #2249; reproduced on
// Assassin's Creed II, 2026-09-18, with DXVK alone). DXVK is not offered for them anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const translation = require(path.join(__dirname, '..', 'src', 'translation'));
const gamehelp = require(path.join(__dirname, '..', 'src', 'gamehelp'));

test('the early Assassin\'s Creed exes are blocked, whatever the case or folder', () => {
  for (const exe of ['AssassinsCreedIIGame.exe', 'ACBSP.exe', 'ACRSP.exe', 'AssassinsCreed_Dx9.exe']) {
    assert.ok(translation.dxvkBlockedFor(path.join('D:', 'Games', 'x', exe)), exe);
  }
  assert.equal(translation.dxvkBlockedFor('D:/Games/Other/game.exe'), null);
  assert.equal(translation.dxvkBlockedFor(null), null);
});

test('every place that offers the swap checks the list', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', ...f.split('/')), 'utf8');
  assert.match(src('main.js'), /case 'swap-to-dxvk': \{[\s\S]{0,300}dxvkBlockedFor\(exePath\)/);
  assert.match(src('renderer/renderer.js'), /route\.dxvkBlocked && !onDxvk\) return null/);
  assert.match(src('route.js'), /dxvkBlocked = translation\.dxvkBlockedFor\(exePath\)/);
  const help = src('gamehelp.js');
  for (const m of help.matchAll(/fix\('[^']+', 'swap-to-dxvk'/g)) {
    const before = help.slice(Math.max(0, m.index - 400), m.index);
    assert.ok(/dxvkBlocked|dxvk32/.test(before), 'swap-to-dxvk offer without a dxvkBlocked guard: ' + help.slice(m.index, m.index + 60));
  }
});
