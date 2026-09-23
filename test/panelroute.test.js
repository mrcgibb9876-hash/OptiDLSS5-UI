// Which panel Insert opens, by the game that is running (src/panelroute.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, panelModeFor, overlayMenuOff } = require('../src/panelroute');

test('a 64-bit game keeps Insert for the in-game panel, RE Engine included', () => {
  assert.equal(panelModeFor({ api: 'dx12' }), MODES.ENGINE);
  assert.equal(panelModeFor({ api: 'dx11' }), MODES.ENGINE);
  assert.equal(panelModeFor({ api: 'vulkan' }), MODES.ENGINE);
});

test('the 32-bit route, OpenGL and an ini with the overlay off get the pop-out on Insert', () => {
  assert.equal(panelModeFor({ host32: true, api: 'dx9' }), MODES.POPOUT);
  assert.equal(panelModeFor({ api: 'opengl' }), MODES.POPOUT);
  assert.equal(panelModeFor({ api: 'dx12', overlayMenuOff: true }), MODES.POPOUT);
  assert.equal(panelModeFor({ api: 'dx12', engineHasPanel: false }), MODES.POPOUT);
});

test('Chicken keeps its own menu, and an exclusive-fullscreen game keeps the cast', () => {
  assert.equal(panelModeFor({ chicken: true, host32: true }), MODES.CHICKEN);
  assert.equal(panelModeFor({ host32: true, fullscreenOnly: true }), MODES.ENGINE);
});

test('OverlayMenu=false is read from [Menu] only', () => {
  assert.equal(overlayMenuOff('[Menu]\r\nOverlayMenu=false\r\n'), true);
  assert.equal(overlayMenuOff('[Menu]\nOverlayMenu = auto\n'), false);
  assert.equal(overlayMenuOff('[Other]\nOverlayMenu=false\n'), false);
  assert.equal(overlayMenuOff(''), false);
});
