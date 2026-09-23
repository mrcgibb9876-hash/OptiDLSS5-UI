'use strict';
// A game that has to stay in exclusive fullscreen still needs a panel.
//
// Assassin's Creed II is the case (2026-09-21). The dgVoodoo2 keys that would make it borderless --
// WindowedAttributes, AppControlledScreenMode, FullScreenMode -- black-screen it, so legacy.js writes
// it a minimal dgVoodoo.conf and the game stays in exclusive fullscreen. The Feeder's default cast is
// the compositor thumbnail, which cannot draw over an exclusive-fullscreen swapchain, so without the
// two keys below dlss5-feed.log just says "the in-game panel is unavailable this session" and Alt+Home
// does nothing.
//
//   host_window=3  keeps the helper's own window even though the swapchain reports fullscreen (#118)
//   cast_mode=1    brings the panel in as a texture drawn by the game's ReShade, which works there
//
// Both halves key off the SAME list (feeder.FULLSCREEN_ONLY_EXES), so a game cannot end up with the
// minimal conf but no way to see the panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write } = require('./helpers');
const feeder = require('../src/feeder');
const legacy = require('../src/legacy');

const read = (dir) => fs.readFileSync(path.join(dir, 'dlss5-feed.cfg'), 'utf8');

test('a fresh install of a fullscreen-only game gets host_window=3 and cast_mode=1', () => {
  const game = scratchDir('feeder-fullscreen-fresh');
  write(game, 'AssassinsCreedIIGame.exe', 'x');
  assert.equal(feeder.needsFullscreenHost(game), true);

  feeder.configureFeedCfg(game);
  const cfg = read(game);
  assert.match(cfg, /^host_window=3$/m);
  assert.match(cfg, /^cast_mode=1$/m);
});

test('Max Payne 2 gets the in-game cast too, but not the minimal dgVoodoo.conf', () => {
  // Any second window minimises it, the pop-out included, so the panel has to be drawn in the game by
  // ReShade -- and Insert stays with the in-game panel (panelroute.js) instead of opening the pop-out.
  const game = scratchDir('feeder-incast-mp2');
  write(game, 'MaxPayne2.exe', 'x');
  assert.equal(feeder.needsInGameCast(game), true);
  assert.equal(feeder.needsFullscreenHost(game), false, 'it runs windowed; the minimal dgVoodoo.conf is not for it');

  feeder.configureFeedCfg(game);
  const cfg = read(game);
  assert.match(cfg, /^host_window=3$/m);
  assert.match(cfg, /^cast_mode=1$/m);

  const panelroute = require('../src/panelroute');
  assert.equal(panelroute.panelModeFor({ host32: true, fullscreenOnly: feeder.needsInGameCast(game) }), panelroute.MODES.ENGINE);
});

test('an ordinary game gets neither: it is borderless, and the thumbnail cast works there', () => {
  const game = scratchDir('feeder-fullscreen-ordinary');
  write(game, 'SomeOtherGame.exe', 'x');
  assert.equal(feeder.needsFullscreenHost(game), false);

  feeder.configureFeedCfg(game);
  const cfg = read(game);
  assert.doesNotMatch(cfg, /host_window/);
  assert.doesNotMatch(cfg, /cast_mode/);
});

test('the keys still land on an install whose cast key the user chose themselves', () => {
  const game = scratchDir('feeder-fullscreen-userkey');
  write(game, 'AssassinsCreedIIGame.exe', 'x');
  // A key of their own, with their own modifiers: configureFeedCfg leaves that alone and used to
  // return before it could write anything else -- which left exactly this game with no panel.
  write(game, 'dlss5-feed.cfg', 'cast_key=45\ncast_mods=2\n');

  const r = feeder.configureFeedCfg(game);
  assert.equal(r.kept, true, 'their cast key is theirs');
  const cfg = read(game);
  assert.match(cfg, /^cast_key=45$/m, 'their key is untouched');
  assert.match(cfg, /^cast_mods=2$/m);
  assert.match(cfg, /^host_window=3$/m, 'and they still get a panel');
  assert.match(cfg, /^cast_mode=1$/m);
});

test('a value already in the file is somebody\'s choice and is not overwritten', () => {
  const game = scratchDir('feeder-fullscreen-respect');
  write(game, 'AssassinsCreedIIGame.exe', 'x');
  write(game, 'dlss5-feed.cfg', 'cast_key=36\ncast_mods=1\nhost_window=1\ncast_mode=0\n');

  feeder.configureFeedCfg(game);
  const cfg = read(game);
  assert.match(cfg, /^host_window=1$/m);
  assert.match(cfg, /^cast_mode=0$/m);
});

test('the two halves of the decision come from one list', () => {
  const game = scratchDir('feeder-fullscreen-onelist');
  write(game, 'AssassinsCreedIIGame.exe', 'x');
  // legacy.js must agree with feeder.js about this game, or it gets the minimal conf with no panel,
  // or the borderless conf with a black screen.
  const conf = legacy.configureDgVoodoo('[General]\n\n[GeneralExt]\n\n[DirectX]\n',
    { windowed: true, minimal: feeder.needsFullscreenHost(game) });
  assert.doesNotMatch(conf, /WindowedAttributes\s*=\s*borderless/);
  assert.match(conf, /VRAM\s*=\s*4096/);
});
