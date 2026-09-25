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

test('a new Manager is announced, not downloaded or installed on its own; Download fetches it', async () => {
  const handlers = {};
  let downloads = 0;
  const fake = {
    on: (ev, fn) => { handlers[ev] = fn; },
    checkForUpdates: async () => { handlers['update-available']({ version: '9.9.9' }); },
    downloadUpdate: async () => { downloads++; handlers['update-downloaded']({ version: '9.9.9' }); },
    quitAndInstall: () => {},
  };
  managerUpdate.setup({ app: { getVersion: () => '1.0.0', isPackaged: true }, autoUpdater: fake, onChange: () => {} });
  assert.equal(fake.autoDownload, false, 'nothing downloads without the player');
  assert.equal(fake.autoInstallOnAppQuit, false, 'quitting never installs');
  await managerUpdate.check();
  assert.equal(managerUpdate.snapshot().phase, 'available');
  assert.equal(downloads, 0);
  assert.equal(managerUpdate.restart(), false, 'nothing to install before Download');
  await managerUpdate.download();
  assert.equal(downloads, 1);
  assert.equal(managerUpdate.snapshot().phase, 'downloaded');
});
