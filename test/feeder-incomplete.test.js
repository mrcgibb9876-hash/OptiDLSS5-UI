'use strict';
// A Feeder that is deployed but not all there.
//
// main.js's helpContext has gathered `feederReady` for exactly this since the field was added --
// its own comment says "a no-dlss verdict on this route is almost always one of them missing,
// above all ReShade, which the add-on needs to load at all" -- and no rule in gamehelp.js ever
// read it. Dolphin (#106, 2026-09-21) is what that costs: the report's own digest said
//
//     feeder: INCOMPLETE -- missing ReShade, DLSS5_Feed.fx, the ReShade headers
//
// and the card said "Not working -- no known fix", because an incomplete deploy fell straight
// through the pre-run checks into the run rules and ended at no-hook.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { diagnose } = require(path.join(__dirname, '..', 'src', 'gamehelp'));

const READY = {
  supported: true, reshadeMode: 'local', reshadeInstalled: true, addonInstalled: true,
  fxInstalled: true, headersInstalled: true, dlssInstalled: true, dlssnrInstalled: true,
  mvProviderOk: true, complete: true,
};

const base = (feederReady, over = {}) => ({
  detected: { api: 'dx11', bitness: 64, antiCheat: null, ...(over.detected || {}) },
  route: { route: 'feeder', optiInstalled: true, feederDeployed: true, ...(over.route || {}) },
  run: over.run || { ran: true, verdict: 'no-dlss' },
  feederReady,
  foreign: [],
});

test('Dolphin’s exact digest: the three missing pieces are named, and Install is the fix', () => {
  const d = diagnose(base({ ...READY, reshadeInstalled: false, fxInstalled: false, headersInstalled: false }));
  assert.equal(d.status, 'fix');
  assert.equal(d.code, 'feeder-incomplete');
  assert.equal(d.fix.id, 'install');
  assert.equal(d.vars.missing, 'ReShade, DLSS5_Feed.fx, the ReShade headers');
  assert.equal(d.vars.count, 3);
});

test('a complete Feeder is not touched by this rule', () => {
  assert.equal(diagnose(base(READY)).code, 'no-hook', 'the run rules still get their turn');
  // No feederReady at all (an older card, or a route that never gathers it) changes nothing.
  assert.equal(diagnose(base(null)).code, 'no-hook');
  assert.equal(diagnose(base(undefined)).code, 'no-hook');
});

// The Vulkan layer is machine-wide, not a file in this folder, and the vulkan-layer-* rules under
// no-dlss already say which of its three faults it is. Claiming "ReShade is missing" over the top
// of those would be both vaguer and wrong.
test('ReShade is not called missing on the Vulkan layer -- those rules own that case', () => {
  const vk = diagnose({
    ...base({ ...READY, reshadeMode: 'vulkan-layer', reshadeInstalled: false }, { detected: { api: 'vulkan' } }),
    vulkanFeeder: { layerRegistered: false, layerAddon: false, feederLogPresent: false },
  });
  assert.equal(vk.code, 'vulkan-layer-missing');

  // A file piece missing on Vulkan is still ours, though: the add-on is a file in the game folder.
  const addon = diagnose(base({ ...READY, reshadeMode: 'vulkan-layer', reshadeInstalled: false, addonInstalled: false }));
  assert.equal(addon.code, 'feeder-incomplete');
  assert.equal(addon.vars.missing, 'the Feeder add-on', 'ReShade left out, the add-on named');
});

// OptiScaler writes its own line about nvngx_dlss.dll and the existing rules quote it. Answering
// the same fault twice, in worse words, is how one of the two answers gets missed.
test('the nvngx DLLs are left to the dlss-runtime rules', () => {
  const d = diagnose({
    ...base({ ...READY, dlssInstalled: false, dlssnrInstalled: false }),
    run: { ran: true, verdict: 'no-dlss', dlssRuntimeMissing: true },
  });
  assert.equal(d.code, 'dlss-runtime-missing');
});

// An unsupported render API already has its own answer from feederReadiness; do not overwrite it
// with a file list that was never computed.
test('an unsupported route reports nothing here', () => {
  assert.equal(diagnose(base({ ready: false, supported: false, reason: 'Render API not detected' })).code, 'no-hook');
});

test('the motion-vector rule still wins -- it is the more specific of the two', () => {
  const d = diagnose({
    ...base({ ...READY, fxInstalled: false }),
    mvProvider: { id: 'vort', displayName: 'VORT', shaderPresent: false },
  });
  assert.equal(d.code, 'feeder-mv-broken');
});

// #107, Kingdom Come: Deliverance -- a 2018 CryEngine game with no upscaler of any kind, routed as
// "ships its own DLSS" and then left at "no known fix".
//
// route.js: shippedDlss = shipsDlss || (!legacyRenderer && !needsFeeder(dir) && ...)
// feeder.js: needsFeeder(dir) = !hasNativeDlss(dir)
// native-dlss.js: hasNativeDlss(dir) = shipsNativeDlss(dir) || exists(dir/nvngx_dlss.dll)
//
// So the optiscaler route has two very different grounds: the game's OWN DLSS found in its tree
// (shipsDlss -- evidence), or one loose nvngx_dlss.dll beside the exe that any tool could have
// dropped (an inference). The card states the second as the first: "This game ships its own DLSS".
// A run with no DLSS in it falsifies that, and the app knew which ground it stood on all along.
test('an optiscaler route with no DLSS of the game’s own says so when the run proves it', () => {
  const kcd = (over = {}) => diagnose({
    detected: { api: 'dx11', bitness: 64, antiCheat: null },
    route: { route: 'optiscaler', optiInstalled: true, shipsDlss: false, ...over },
    run: { ran: true, verdict: 'no-dlss' },
    foreign: [],
  });
  const d = kcd();
  assert.equal(d.status, 'step');
  assert.equal(d.code, 'optiscaler-no-native-dlss');
  assert.equal(d.vars.file, 'nvngx_dlss.dll');

  // The game's own DLSS really was found: the route rests on evidence, so this rule keeps out of it
  // and the old answer stands (they probably just have DLSS switched off in the game).
  assert.equal(kcd({ shipsDlss: true }).code, 'no-hook');
  // An older card that never carried the field is not guessed at either.
  assert.equal(kcd({ shipsDlss: undefined }).code, 'no-hook');
  // Luma owns its own no-dlss answer.
  assert.equal(kcd({ lumaDeployed: true }).code, 'luma-select-dlss');
});

test('OptiScaler naming a missing nvngx_dlss.dll still wins -- it read its own log', () => {
  const d = diagnose({
    detected: { api: 'dx11', bitness: 64 },
    route: { route: 'optiscaler', optiInstalled: true, shipsDlss: false },
    run: { ran: true, verdict: 'no-dlss', dlssRuntimeMissing: true },
    foreign: [],
  });
  assert.equal(d.code, 'dlss-runtime-missing');
});
