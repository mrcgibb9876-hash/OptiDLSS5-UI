'use strict';
// dgVoodoo2's ColorSpace is left at its own default (appdriven).
// Assassin's Creed II, 2026-09-18: appdriven was a black screen on an HDR laptop panel and
// argb8888_srgb gave a picture, so the app wrote argb8888_srgb on every dgVoodoo route. On 2026-09-19
// the Castlevania: Lords of Shadow 2 demo refused to start with it ("needs at least 512 MB of video
// and AGP memory") and started again with appdriven, every other key unchanged. AC2 was dropped, so
// the key came back out, and installs synced in between are put back to appdriven.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write } = require('./helpers');
const legacy = require('../src/legacy');

test('a fresh dgVoodoo.conf keeps its own ColorSpace and the rest of the display block', () => {
  const fresh = legacy.configureDgVoodoo('[General]\nOutputAPI = bestavailable\n\n[GeneralExt]\nPresentationModel = auto\nColorSpace                           = appdriven\nDesktopResolution = \n');
  assert.match(fresh, /ColorSpace\s*=\s*appdriven/);
  assert.doesNotMatch(fresh, /argb8888_srgb/);
  assert.match(fresh, /PresentationModel = auto/, 'presentation model untouched');
  assert.match(fresh, /DesktopResolution = \r?\n/, 'desktop resolution untouched');
});

test('an install synced while argb8888_srgb was written goes back to appdriven, once', () => {
  const game = scratchDir('legacy-colorspace-undo');
  write(game, legacy.MARKER, JSON.stringify({ version: 1, files: ['D3D9.dll', 'dgVoodoo.conf'], backups: [], dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } }));
  write(game, 'dgVoodoo.conf', '[General]\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = argb8888_srgb\nWindowedAttributes = borderless, fullscreensize\nPresentationModel = auto\n');
  assert.equal(legacy.ensureDgVoodooWindowed(game), true);
  const conf = fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8');
  assert.match(conf, /ColorSpace\s*=\s*appdriven/);
  assert.match(conf, /PresentationModel = auto/);
  assert.equal(legacy.ensureDgVoodooWindowed(game), false, 'already appdriven: no rewrite');
});

test('a colour space someone chose by hand is left alone', () => {
  const game = scratchDir('legacy-colorspace-hand');
  write(game, legacy.MARKER, JSON.stringify({ version: 1, files: ['D3D9.dll', 'dgVoodoo.conf'], backups: [], dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } }));
  write(game, 'dgVoodoo.conf', '[General]\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = argb2101010_sdr\nWindowedAttributes = borderless, fullscreensize\n');
  legacy.ensureDgVoodooWindowed(game);
  assert.match(fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8'), /ColorSpace = argb2101010_sdr/);
});
