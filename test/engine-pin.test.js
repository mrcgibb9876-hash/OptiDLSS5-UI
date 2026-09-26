// The manager bundles one exact engine release, named in package.json's engineVersion.
//
// release.yml used to fetch the engine's /releases/latest at build time. That tied every manager
// build to whatever engine happened to be newest that day, forced "release the engine first", and
// (because /latest skips pre-releases) let a v2 manager silently carry a v1 engine. These tests hold
// the pin in place: an exact tag in package.json, and a workflow that reads it and never "latest".
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./helpers');

const EXACT_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

test('package.json pins the bundled engine to an exact release tag', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(typeof pkg.engineVersion, 'string', 'package.json needs an "engineVersion" field');
  assert.match(pkg.engineVersion, EXACT_TAG, `engineVersion must be an exact engine tag like v1.0.41, got "${pkg.engineVersion}"`);
});

test('release.yml bundles the pinned engine and never the latest release', () => {
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(wf.includes('.engineVersion'), 'the engine step reads package.json engineVersion');
  assert.ok(!/OptiScaler_DLSSNR(-releases)?\/releases\/latest/.test(wf), 'no fallback to the engine\'s /releases/latest');
  assert.ok(/OptiScaler_DLSSNR-releases\/releases\/tags\/\$engineTag/.test(wf), 'the engine is fetched by its exact tag, from the public releases repository');
  // The GPL source zip sits beside the build on every release there; it must never be what is bundled.
  assert.ok(/-source\.zip/.test(wf), 'the engine step skips the source zip');
});
