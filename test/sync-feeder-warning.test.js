'use strict';
// The Feeder update a sync runs can come back with a warning instead of a throw (feeder.js
// deployReShade layerWarnOnly, 2026-09-18): ReShade's Vulkan layer will not load in this game. The
// renderer can only show it if game:sync-if-stale hands feederUpdated back on every path -- before
// this, only the "not installed" return carried it and a Feeder game with OptiScaler beside it
// dropped the warning on the floor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, scratchDir, write, loadMain } = require('./helpers');
const feeder = require(path.join(REPO, 'src', 'feeder'));

const WARNING = 'ReShade\'s Vulkan layer is on this PC, but Game.exe is not on its app list.';

function stubFeederUpdate() {
  const saved = {};
  const stub = (name, fn) => { saved[name] = feeder[name]; feeder[name] = fn; };
  stub('feederDeployed', () => true);
  stub('readFeederDeployMarker', () => ({ feederVersion: 'v1.0.0' }));
  stub('resolveFeederAsset', async () => ({ tag: 'v1.1.0' }));
  stub('feederProviderStatus', () => ({ id: null }));
  stub('deployFeederStack', async (_dir, _api, _provider, opts) => {
    assert.equal(opts.layerWarnOnly, true, 'a sync never throws over the Vulkan layer');
    return { reshade: { deployed: false, warning: WARNING }, addon: { version: 'v1.1.0' } };
  });
  return () => { for (const [k, v] of Object.entries(saved)) feeder[k] = v; };
}

test('game:sync-if-stale carries the Feeder update\'s Vulkan-layer warning back to the renderer', async () => {
  const restore = stubFeederUpdate();
  try {
    const { invoke } = loadMain();
    // Installed, with no release folder given: the "no release set" return, which used to drop it.
    const game = scratchDir('sync-feeder-warning');
    const exe = write(game, 'Game.exe', 'MZ fake');
    write(game, 'OptiScaler.ini', '[DlssNr]\nEnabled=auto\n');
    const res = await invoke('game:sync-if-stale', { exePath: exe, releaseFolder: null, nrDllPath: null });
    assert.equal(res.ok, true, res.error);
    assert.ok(res.feederUpdated, 'feederUpdated is on the result');
    assert.equal(res.feederUpdated.warning, WARNING);
    assert.equal(res.feederUpdated.to, 'v1.1.0');
  } finally {
    restore();
  }
});

test('the renderer turns that warning into a card hint and a toast', () => {
  // renderer.js is a plain script with no module system; this pins the wiring by its text.
  const js = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.match(js, /function noteSyncResult\(game, res\)/);
  assert.match(js, /res && res\.feederUpdated/);
  assert.match(js, /if \(noteSyncResult\(game, res\)\) layerWarned\.push\(game\.name\)/);
  assert.match(js, /syncNotice: syncNoticeFor\(game\.exePath\)/);
  assert.match(js, /const state = withSyncNotice\(card\._state \|\| \{\}\)/);
});
