'use strict';
// dgVoodoo2's ColorSpace: SDR on every dgVoodoo route, on install and on sync.
// Assassin's Creed II, 2026-09-18: ColorSpace=appdriven was a black screen on an HDR laptop panel,
// argb8888_srgb gave a picture. PresentationModel / DesktopResolution forced exclusive fullscreen,
// so they must stay as they were.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write } = require('./helpers');
const legacy = require('../src/legacy');

test('a fresh dgVoodoo.conf gets argb8888_srgb and nothing else in the display block moves', () => {
  const fresh = legacy.configureDgVoodoo('[General]\nOutputAPI = bestavailable\n\n[GeneralExt]\nPresentationModel = auto\nColorSpace                           = appdriven\nDesktopResolution = \n');
  assert.match(fresh, /\[GeneralExt\][^[]*ColorSpace\s*=\s*argb8888_srgb/);
  assert.doesNotMatch(fresh, /appdriven/);
  assert.match(fresh, /PresentationModel = auto/, 'presentation model untouched');
  assert.match(fresh, /DesktopResolution = \r?\n/, 'desktop resolution untouched');
});

test('an existing dgVoodoo2 install is moved to SDR on sync, once', () => {
  const game = scratchDir('legacy-colorspace-sync');
  write(game, legacy.MARKER, JSON.stringify({ version: 1, files: ['D3D9.dll', 'dgVoodoo.conf'], backups: [], dgVoodoo: { arch: 'x64', dll: 'D3D9.dll' } }));
  write(game, 'dgVoodoo.conf', '[General]\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = appdriven\nWindowedAttributes = borderless, fullscreensize\nPresentationModel = auto\n');
  assert.equal(legacy.ensureDgVoodooWindowed(game), true);
  const conf = fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8');
  assert.match(conf, /ColorSpace\s*=\s*argb8888_srgb/);
  assert.doesNotMatch(conf, /FullScreenMode/, 'no helper: not forced windowed');
  assert.match(conf, /PresentationModel = auto/);
  assert.equal(legacy.ensureDgVoodooWindowed(game), false, 'already SDR: no rewrite');
});
