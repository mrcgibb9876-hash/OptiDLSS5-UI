// The break-away DLSS 5 panel's window rules. What is worth pinning here is the part with no
// Electron in it: which key combination is taken, and whether a remembered position is still on a
// monitor that exists. Both fail silently if they go wrong -- a hotkey that never fires, or a panel
// that opens off the edge of the desktop and cannot be dragged back.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { REPO } = require('./helpers');
const panelwindow = require(path.join(REPO, 'src', 'panelwindow'));

const ONE_SCREEN = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const TWO_SCREENS = ONE_SCREEN.concat([{ workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }]);

test('the default hotkey is not OptiScaler\'s own panel key', () => {
  // Alt+Home opens the in-game panel. A stand-in for it that fights it for the same key would be
  // useless exactly where it is needed.
  assert.notEqual(panelwindow.DEFAULT_ACCELERATOR.toLowerCase(), 'alt+home');
  assert.equal(panelwindow.accelerator({}), panelwindow.DEFAULT_ACCELERATOR);
  assert.equal(panelwindow.accelerator(null), panelwindow.DEFAULT_ACCELERATOR);
});

test('a chosen hotkey wins, and blank falls back', () => {
  assert.equal(panelwindow.accelerator({ panelHotkey: 'Ctrl+F9' }), 'Ctrl+F9');
  // Trimmed: a trailing space makes Electron reject the accelerator outright.
  assert.equal(panelwindow.accelerator({ panelHotkey: '  Ctrl+Shift+P  ' }), 'Ctrl+Shift+P');
  assert.equal(panelwindow.accelerator({ panelHotkey: '   ' }), panelwindow.DEFAULT_ACCELERATOR);
  assert.equal(panelwindow.accelerator({ panelHotkey: 42 }), panelwindow.DEFAULT_ACCELERATOR);
});

test('nothing remembered means the default size and no position', () => {
  const bounds = panelwindow.visibleBounds(undefined, ONE_SCREEN);
  assert.equal(bounds.x, undefined);
  assert.equal(bounds.y, undefined);
  assert.ok(bounds.width > 0 && bounds.height > 0);
});

test('a position still on a monitor is kept', () => {
  assert.deepEqual(
    panelwindow.visibleBounds({ x: 120, y: 80, width: 500, height: 600 }, ONE_SCREEN),
    { x: 120, y: 80, width: 500, height: 600 }
  );
  // The second monitor's coordinates are only valid while it is attached.
  assert.deepEqual(
    panelwindow.visibleBounds({ x: 2400, y: 200, width: 500, height: 600 }, TWO_SCREENS),
    { x: 2400, y: 200, width: 500, height: 600 }
  );
});

test('a position on a monitor that has gone is dropped, keeping the size', () => {
  const saved = { x: 2400, y: 200, width: 500, height: 600 };
  const bounds = panelwindow.visibleBounds(saved, ONE_SCREEN);
  assert.equal(bounds.x, undefined);
  assert.equal(bounds.y, undefined);
  assert.equal(bounds.width, 500);
  assert.equal(bounds.height, 600);
});

test('a window dragged below the screen is dropped, not merely clamped', () => {
  // Its title bar is the only way back: the window is frameless and the bar is the drag region, so
  // overlap somewhere down its body is not enough to count as reachable.
  const bounds = panelwindow.visibleBounds({ x: 100, y: 1039, width: 500, height: 600 }, ONE_SCREEN);
  assert.equal(bounds.x, 100, 'one pixel of the bar still on screen is reachable');

  const gone = panelwindow.visibleBounds({ x: 100, y: 1100, width: 500, height: 600 }, ONE_SCREEN);
  assert.equal(gone.x, undefined);
});

test('a remembered size below the minimum is raised to it', () => {
  const bounds = panelwindow.visibleBounds({ x: 10, y: 10, width: 40, height: 20 }, ONE_SCREEN);
  assert.ok(bounds.width >= 430, `width ${bounds.width}`);
  assert.ok(bounds.height >= 320, `height ${bounds.height}`);
});

test('rubbish in settings.json does not produce a window with NaN bounds', () => {
  for (const saved of [{ x: 'left', y: 'top', width: 'wide', height: 'tall' }, { x: NaN, y: 0, width: 500, height: 600 }, 'nonsense', 7]) {
    const bounds = panelwindow.visibleBounds(saved, ONE_SCREEN);
    for (const value of Object.values(bounds)) assert.ok(Number.isFinite(value), `${JSON.stringify(saved)} -> ${JSON.stringify(bounds)}`);
  }
});

// The window is frameless, so nothing about moving or resizing it is free: without an explicit drag
// region it cannot be moved at all, and a button inside that region drags instead of clicking.
// These read the files rather than the running window, which is weak, but the failure they guard
// against is silent -- a panel that cannot be moved looks exactly like one that can.
test('the panel is draggable by its top strip, and the picker in it is not', () => {
  const css = require('node:fs').readFileSync(path.join(REPO, 'src', 'renderer', 'panel.css'), 'utf8');
  const title = css.slice(css.indexOf('.p-title {'), css.indexOf('.p-game {'));
  assert.match(title, /-webkit-app-region:\s*drag/, 'the top strip must be the drag handle');

  // The strip holds the game picker and nothing else now -- the title, the theme button and the
  // close X went when the in-game panel dropped its own title row (2026-09-22).
  const game = css.slice(css.indexOf('.p-game {'));
  assert.match(game.slice(0, 200), /-webkit-app-region:\s*no-drag/, 'the game picker must opt out of it');
});

test('the window is created resizable, with a floor', () => {
  const src = require('node:fs').readFileSync(path.join(REPO, 'src', 'panelwindow.js'), 'utf8');
  const options = src.slice(src.indexOf('const win = new BrowserWindow('), src.indexOf('win.loadFile'));
  assert.match(options, /resizable:\s*true/);
  assert.match(options, /frame:\s*false/);
  assert.match(options, /minWidth:\s*MIN_WIDTH/);
  assert.match(options, /minHeight:\s*MIN_HEIGHT/);
  // Moving or resizing it has to be remembered, or it comes back in the wrong place every time.
  assert.match(src, /win\.on\('moved'/);
  assert.match(src, /win\.on\('resized'/);
});
