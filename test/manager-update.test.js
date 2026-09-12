'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { REPO } = require('./helpers');
const managerUpdate = require(path.join(REPO, 'src', 'manager-update'));

test('the self-updater reports unsupported outside a packaged install and never restarts with nothing downloaded', () => {
  const s = managerUpdate.setup({ app: { getVersion: () => '1.0.0', isPackaged: false }, autoUpdater: null, onChange: () => {} });
  assert.equal(s.supported, false);
  assert.equal(managerUpdate.restart(), false);
  assert.equal(managerUpdate.snapshot().currentVersion, '1.0.0');
});
