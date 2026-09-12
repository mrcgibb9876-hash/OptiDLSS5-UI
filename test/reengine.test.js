'use strict';
// RE Engine games (Capcom: re_chunk_000.pak beside the exe) get three things on Install that
// nothing else does: REFramework's dinput8.dll (OptiScaler does nothing there without it), the
// Hotfix ini values that stop Dragon's Dogma 2 crashing, and REFramework's own config fixed so
// its menu opens on Insert at a readable size. Remove must take the two REFramework files back
// out, and the preview must name them. Offline: the REFramework cache is pre-seeded and fetch
// is made to fail, which is the "offline or rate-limited" path the app already handles.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain } = require('./helpers');

const onWindows = process.platform === 'win32';

function iniValue(ini, section, key) {
  const m = ini.match(new RegExp(`\\[${section}\\][\\s\\S]*?^${key}\\s*=\\s*(.*)$`, 'mi'));
  return m ? m[1].trim() : null;
}

test('an RE Engine game gets REFramework, the Hotfix ini values and a fixed REFramework config; Remove takes them out', { skip: !onWindows }, async () => {
  const base = scratchDir('reengine');
  const release = fakeReleaseFolder(base);
  // The real release ini carries these sections; patchIniValues only edits keys already present.
  fs.appendFileSync(path.join(release, 'OptiScaler.ini'),
    '[Menu]\nShortcutKey=auto\n[Hotfix]\nRestoreComputeSignature=auto\nRestoreGraphicSignature=auto\nExtendedStateRestore=auto\n');
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'DD2.exe');
  write(game, 're_chunk_000.pak', 'capcom');
  // REFramework writes this on the game's first run; a real generated one had NUMPAD0 (96) as
  // the menu key, and 22-point fonts.
  write(game, 're2_fw_config.txt', 'REFrameworkConfig_MenuKey_V2=96\nREFrameworkConfig_FontSize=22\nREFrameworkConfig_UIFontSize=22.000000\nREFrameworkConfig_AlwaysShowCursor=false\n');

  const { invoke, userData } = loadMain();
  write(path.join(userData, 'reframework-cache'), 'dinput8.dll', 'fake REFramework');
  write(path.join(userData, 'reframework-cache'), '.version', '01302');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
    assert.equal(inst.ok, true, inst.error);
    assert.equal(inst.reEngine, true);
    assert.equal(fs.readFileSync(path.join(game, 'dinput8.dll'), 'utf8'), 'fake REFramework', 'REFramework placed from the cache');
    const journal = JSON.parse(fs.readFileSync(path.join(game, '.optiscaler-manager-install.json'), 'utf8'));
    assert.equal(journal.reframework, true, 'journaled as this app\'s deploy');

    const ini = fs.readFileSync(path.join(game, 'OptiScaler.ini'), 'utf8');
    assert.equal(iniValue(ini, 'Hotfix', 'RestoreComputeSignature'), 'true');
    assert.equal(iniValue(ini, 'Hotfix', 'RestoreGraphicSignature'), 'false');
    assert.equal(iniValue(ini, 'Hotfix', 'ExtendedStateRestore'), 'false');
    assert.equal(iniValue(ini, 'Menu', 'ShortcutKey'), '0x14F');
    assert.equal(iniValue(ini, 'Upscalers', 'Dx12Upscaler'), 'auto', 'no DLSS of its own: OptiScaler upscales');

    const cfg = fs.readFileSync(path.join(game, 're2_fw_config.txt'), 'utf8');
    assert.match(cfg, /^REFrameworkConfig_MenuKey_V2=45$/m, 'menu key back on Insert');
    assert.match(cfg, /^REFrameworkConfig_FontSize=34$/m);
    assert.match(cfg, /^REFrameworkConfig_UIFontSize=34\.000000$/m);
    assert.match(cfg, /^REFrameworkConfig_AlwaysShowCursor=false$/m, 'other keys untouched');

    const plan = await invoke('game:uninstallPlan', exe);
    assert.ok(plan.remove.includes('dinput8.dll') && plan.remove.includes('re2_fw_config.txt'), 'preview names the REFramework files');

    const un = await invoke('game:run-uninstall', exe);
    assert.equal(un.ok, true, un.error);
    assert.deepEqual(fs.readdirSync(game).sort(), ['DD2.exe', 're_chunk_000.pak']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a hand-placed REFramework is never overwritten, and Remove leaves it alone', { skip: !onWindows }, async () => {
  const base = scratchDir('reengine-own');
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'RE4.exe');
  write(game, 're_chunk_000.pak', 'capcom');
  write(game, 'dinput8.dll', 'the user\'s own REFramework build');

  const { invoke } = loadMain();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const inst = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
    assert.equal(inst.ok, true, inst.error);
    assert.equal(fs.readFileSync(path.join(game, 'dinput8.dll'), 'utf8'), 'the user\'s own REFramework build');
    const journal = JSON.parse(fs.readFileSync(path.join(game, '.optiscaler-manager-install.json'), 'utf8'));
    assert.notEqual(journal.reframework, true);
    const un = await invoke('game:run-uninstall', exe);
    assert.equal(un.ok, true, un.error);
    assert.deepEqual(fs.readdirSync(game).sort(), ['RE4.exe', 'dinput8.dll', 're_chunk_000.pak']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
