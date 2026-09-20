'use strict';
// dgVoodoo2's ColorSpace is left at its own default (appdriven), and a REJECTED value is repaired.
//
// The history matters, because it cost two days. Assassin's Creed II, 2026-09-18: appdriven looked
// like a black screen and argb8888_srgb looked like the fix, so the app wrote argb8888_srgb. On
// 2026-09-19 the Castlevania: Lords of Shadow 2 demo refused to start with it, so it was narrowed to
// one game. On 2026-09-21 a dgVoodoo DEBUG build finally said what was really happening:
//
//     ERROR: Invalid value ("argb8888_srgb") is defined for GeneralExt/ColorSpace. It can only be
//            unspecified or one of: 'appdriven', 'argb8888_sdr', 'argb2101010_sdr_wcg',
//            'argb16161616_hdr'.
//
// argb8888_srgb is not a value at all in 2.87.4 -- the names were changed and dgVoodoo's own shipped
// .conf comments were not, which is where the app got it. And a rejected value makes dgVoodoo ABANDON
// THE REST OF THE FILE: ColorSpace is in [GeneralExt] around line 121, [DirectX] starts at 186, so
// VRAM never applied and the emulated card stayed at its 256MB default. AC2 filled it, CreateTexture
// returned NULL, and the game dereferenced NULL -- the 00BE89B7 crash. The "black screen fix" was the
// same accident from the other side: the parse error was switching off WindowedAttributes and
// AppControlledScreenMode below it.
//
// So the rule these tests hold the app to: never write a value the binary rejects, and repair one
// found on disk, whoever wrote it -- because while it is there, nothing below it is being read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write } = require('./helpers');
const legacy = require('../src/legacy');

const MARKER = JSON.stringify({
  version: 1, files: ['D3D9.dll', 'dgVoodoo.conf'], backups: [],
  dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' },
});
const BASE = '[General]\n\n[GeneralExt]\n\n[DirectX]\n';

test('a fresh dgVoodoo.conf keeps its own ColorSpace and the rest of the display block', () => {
  const fresh = legacy.configureDgVoodoo('[General]\nOutputAPI = bestavailable\n\n[GeneralExt]\nPresentationModel = auto\nColorSpace                           = appdriven\nDesktopResolution = \n');
  assert.match(fresh, /ColorSpace\s*=\s*appdriven/);
  assert.doesNotMatch(fresh, /argb8888_srgb/);
  assert.match(fresh, /PresentationModel = auto/, 'presentation model untouched');
  assert.match(fresh, /DesktopResolution = \r?\n/, 'desktop resolution untouched');
});

// The one that would have caught the whole thing.
test('every ColorSpace the app can write is a value the binary accepts', () => {
  for (const opts of [{}, { windowed: true }, { minimal: true }]) {
    const conf = legacy.configureDgVoodoo(BASE, opts);
    const m = /^[ \t]*ColorSpace[ \t]*=[ \t]*(.*)$/m.exec(conf);
    if (m === null) continue;            // unspecified is legitimate
    const value = m[1].trim();
    if (value === '') continue;
    assert.ok(
      legacy.DG_COLORSPACE_VALID.has(value.toLowerCase()),
      `the app wrote ColorSpace=${value}, which dgVoodoo rejects -- and a rejected value silently `
      + 'voids every key below it, including VRAM',
    );
  }
});

test('the VRAM line is always written: at 256MB the card runs out and CreateTexture returns NULL', () => {
  for (const opts of [{}, { windowed: true }, { minimal: true }]) {
    const conf = legacy.configureDgVoodoo(BASE, opts);
    assert.match(conf, /VRAM\s*=\s*4096/, `VRAM missing with ${JSON.stringify(opts)}`);
    assert.match(conf, /OutputAPI\s*=\s*d3d11_fl11_0/, `OutputAPI missing with ${JSON.stringify(opts)}`);
  }
});

test('minimal writes the two keys that matter and none of the presentation ones', () => {
  const conf = legacy.configureDgVoodoo(BASE, { windowed: true, minimal: true });
  assert.doesNotMatch(conf, /WindowedAttributes\s*=\s*borderless/, 'forced borderless black-screens a minimal game');
  assert.doesNotMatch(conf, /AppControlledScreenMode\s*=\s*false/);
  assert.doesNotMatch(conf, /ScalingMode\s*=\s*stretched_ar/);
});

test('an install synced while argb8888_srgb was written goes back to appdriven, once', () => {
  const game = scratchDir('legacy-colorspace-undo');
  write(game, legacy.MARKER, MARKER);
  write(game, 'dgVoodoo.conf', '[General]\nOutputAPI = d3d11_fl11_0\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = argb8888_srgb\nWindowedAttributes = borderless, fullscreensize\nPresentationModel = auto\n\n[DirectX]\nVRAM = 4096\n');
  assert.equal(legacy.ensureDgVoodooWindowed(game), true);
  const conf = fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8');
  assert.match(conf, /ColorSpace\s*=\s*appdriven/);
  assert.match(conf, /PresentationModel = auto/);
  assert.equal(legacy.ensureDgVoodooWindowed(game), false, 'already appdriven: no rewrite');
});

// argb2101010_sdr is in dgVoodoo's shipped comments and is NOT in its parser -- exactly the trap the
// app fell into. Someone who picks it by hand has the same silently-void config, so it is repaired
// too. This test used to assert the opposite.
test('a ColorSpace the binary rejects is repaired even when nobody here wrote it', () => {
  const game = scratchDir('legacy-colorspace-hand-bad');
  write(game, legacy.MARKER, MARKER);
  write(game, 'dgVoodoo.conf', '[General]\nOutputAPI = d3d11_fl11_0\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = argb2101010_sdr\nWindowedAttributes = borderless, fullscreensize\n\n[DirectX]\nVRAM = 4096\n');
  legacy.ensureDgVoodooWindowed(game);
  assert.match(fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8'), /ColorSpace\s*=\s*appdriven/);
});

test('a colour space someone chose by hand, and the binary accepts, is left alone', () => {
  const game = scratchDir('legacy-colorspace-hand-good');
  write(game, legacy.MARKER, MARKER);
  write(game, 'dgVoodoo.conf', '[General]\nOutputAPI = d3d11_fl11_0\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = argb16161616_hdr\nWindowedAttributes = borderless, fullscreensize\n\n[DirectX]\nVRAM = 4096\n');
  legacy.ensureDgVoodooWindowed(game);
  assert.match(fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8'), /ColorSpace\s*=\s*argb16161616_hdr/);
});
