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

// A fake electron-updater whose next check or download can be told to fail, raising both the 'error'
// event and the rejected promise the way the real one does.
function flakyUpdater() {
  const handlers = {};
  const fake = {
    failCheck: false,
    failDownload: false,
    on: (ev, fn) => { handlers[ev] = fn; },
    checkForUpdates: async () => {
      handlers['checking-for-update']();
      if (fake.failCheck) { const e = new Error('net::ERR_INTERNET_DISCONNECTED'); handlers.error(e); throw e; }
      handlers['update-available']({ version: '9.9.9' });
    },
    downloadUpdate: async () => {
      handlers['download-progress']({ percent: 40 });
      if (fake.failDownload) { const e = new Error('sha512 checksum mismatch'); handlers.error(e); throw e; }
      handlers['update-downloaded']({ version: '9.9.9' });
    },
    quitAndInstall: () => {},
  };
  return fake;
}

test('a background check that fails while an update is on offer keeps the offer', async () => {
  const fake = flakyUpdater();
  managerUpdate.setup({ app: { getVersion: () => '1.0.0', isPackaged: true }, autoUpdater: fake, onChange: () => {} });
  await managerUpdate.check();
  assert.equal(managerUpdate.snapshot().phase, 'available');
  fake.failCheck = true;
  await managerUpdate.check();
  const s = managerUpdate.snapshot();
  assert.equal(s.phase, 'available', 'the banner still offers Download');
  assert.equal(s.version, '9.9.9');
  assert.match(s.error, /DISCONNECTED/, 'the failure is still told');
  assert.equal(s.failed, 'check');
});

test('a failed download keeps the version and can be retried', async () => {
  const fake = flakyUpdater();
  managerUpdate.setup({ app: { getVersion: () => '1.0.0', isPackaged: true }, autoUpdater: fake, onChange: () => {} });
  await managerUpdate.check();
  fake.failDownload = true;
  await managerUpdate.download();
  let s = managerUpdate.snapshot();
  assert.equal(s.phase, 'error');
  assert.equal(s.failed, 'download');
  assert.equal(s.version, '9.9.9', 'the renderer can say which update failed');
  assert.match(s.error, /checksum/);
  assert.equal(managerUpdate.canDownload(), true, 'Retry is allowed');
  fake.failDownload = false;
  await managerUpdate.download();
  s = managerUpdate.snapshot();
  assert.equal(s.phase, 'downloaded');
  assert.equal(s.failed, null);
  assert.equal(s.error, null);
});
