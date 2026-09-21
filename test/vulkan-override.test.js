'use strict';
// A wrapper beside the exe may say what the game presents through; it may not say what the game IS.
//
// Issue #101, 2026-09-21. A player with DXVK in their Fallout: New Vegas folder -- the standard thing
// to have there -- was told "Not supported". The app saw DXVK, concluded Vulkan, applied "32-bit
// Vulkan is not supported", and stopped. Their digest:
//
//     api: vulkan -- d3d9.dll beside the executable is DXVK, which presents the game's Direct3D
//     bitness: 32-bit
//     route: unsupported
//
// on the same day that game shipped in the known-good catalog as working.
//
// There was already an exception, added when our OWN DXVK swap did this to Assassin's Creed II
// (2026-09-18), but it recognised only a DXVK this app deployed, via the translation manifest. A
// player's own was left reading as Vulkan on purpose. Who put the file there is not a fact about the
// game, so that distinction is gone: on 32-bit the wrapper never decides the API.
//
// 64-bit is untouched, and deliberately so -- a 64-bit game under DXVK really is served by the
// Feeder's Vulkan path, which has to be told Vulkan.
const test = require('node:test');
const assert = require('node:assert/strict');
const detect = require('../src/detect');

const dxvk = { file: 'd3d9.dll', kind: 'DXVK' };
const applies = detect.vulkanOverrideApplies;

test('a 32-bit DirectX 9 game keeps its own API, whoever placed the wrapper', () => {
  assert.equal(applies({ vulkanWrapper: dxvk, bitness: 32, api: 'dx9' }), false);
  assert.equal(applies({ vulkanWrapper: dxvk, bitness: 32, api: 'dx8' }), false);
  // 32-bit DirectX 10/11 under DXVK is a real route too (legacy.js dxvkReplacesNative), so it must
  // not be turned into Vulkan either.
  assert.equal(applies({ vulkanWrapper: dxvk, bitness: 32, api: 'dx11' }), false);
});

test('a 64-bit game under DXVK is still told Vulkan -- the Feeder has a Vulkan path for it', () => {
  assert.equal(applies({ vulkanWrapper: dxvk, bitness: 64, api: 'dx9' }), true);
  assert.equal(applies({ vulkanWrapper: { file: 'd3d12.dll', kind: 'vkd3d' }, bitness: 64, api: 'dx12' }), true);
});

test('with no wrapper, nothing is overridden', () => {
  assert.equal(applies({ vulkanWrapper: null, bitness: 64, api: 'dx11' }), false);
  assert.equal(applies({ bitness: 64, api: 'dx11' }), false);
  assert.equal(applies(), false);
});

// A game that really is Vulkan needs no override, and one whose API could not be read must not have
// one invented for it.
test('a game already known to be Vulkan, or not known at all, is left alone', () => {
  assert.equal(applies({ vulkanWrapper: dxvk, bitness: 64, api: 'vulkan' }), false);
  assert.equal(applies({ vulkanWrapper: dxvk, bitness: 64, api: null }), false);
});

// The stored-detection path is why DETECT_VERSION had to move. detectFromStored re-applies this on
// top of a saved answer, and a detection saved under the old rule already has api: 'vulkan' -- which
// this predicate then leaves alone, correctly, because it cannot tell a real Vulkan game from a
// mislabelled one. Only a full re-detect clears it, and only the version bump forces that.
test('the detect version moved, so answers saved under the old rule are re-read', () => {
  assert.ok(detect.DETECT_VERSION >= 15, `DETECT_VERSION is ${detect.DETECT_VERSION}; a stored "vulkan" would survive`);
});
