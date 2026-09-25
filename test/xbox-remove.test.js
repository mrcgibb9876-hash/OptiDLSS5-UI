'use strict';
// Microsoft Flight Simulator 2024, Xbox app install (#123, same player as #93 and #102). After a
// flight the card offered to restore the original files; he confirmed, and the sim then would not
// start from anywhere -- not from this app, not from its Start menu tile -- and he found files of
// ours in C:\XboxGames\Microsoft Flight Simulator 2024\ itself (the package root, not Content\),
// and "a lot of leftovers" after removing the app. Two reinstalls of a 100+ GB sim.
//
// What these hold:
//   - Remove on a Store install also cleans the package's other folder when an older build put
//     files there (#93 recorded the Content FOLDER as the exe and installed into the root);
//   - Remove never touches the package's own files (MicrosoftGame.config, appxmanifest.xml,
//     gamelaunchhelper.exe, D3D12\, the game's DLLs);
//   - Remove is refused, with nothing touched, while the game is still running -- a proxy still
//     mapped cannot be deleted, and deleting the ini around it is what left OptiScaler loading on
//     its defaults at every start;
//   - a proxy that still could not be deleted is renamed off its proxy name, and swept later;
//   - the engine's runtime files (OptiScaler.live.json, OptiScaler_<ticks>.log) go with Remove;
//   - a folder can no longer be installed to as if it were the exe;
//   - Game Help never offers to rename a Store package's D3D12\ folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain, listing } = require('./helpers');
const discover = require('../src/discover');
const gamehelp = require('../src/gamehelp');

const onWindows = process.platform === 'win32';
const readSrc = (...rel) => fs.readFileSync(path.join(__dirname, '..', 'src', ...rel), 'utf8').replace(/\r\n/g, '\n');

// Above runlog's 64 KB placeholder floor: a smaller nvngx_dlss.dll is replaced by Install as a broken stub.
const GAME_DLSS = 'the game\'s own DLSS ' + 'x'.repeat(70 * 1024);
const CONFIG = '<?xml version="1.0" encoding="utf-8"?><Game configVersion="1">'
  + '<ExecutableList><Executable Name="FlightSimulator2024.exe" Id="Game"/></ExecutableList></Game>';

// The layout of C:\XboxGames\<Game>\: the package root holding Content\, and in Content\ the exe,
// the store's own files and the game's DLLs.
function xboxPackage(name, exeName = 'FlightSimulator2024.exe') {
  const root = path.join(scratchDir(name), 'Microsoft Flight Simulator 2024');
  const content = path.join(root, 'Content');
  write(content, 'MicrosoftGame.config', CONFIG);
  write(content, 'appxmanifest.xml', '<Package/>');
  write(content, 'gamelaunchhelper.exe', 'the store\'s stub');
  write(content, 'D3D12/D3D12Core.dll', 'the package\'s Agility SDK');
  write(content, 'nvngx_dlss.dll', GAME_DLSS);
  write(content, 'sl.interposer.dll', 'the game\'s own Streamline');
  write(content, 'amd_fidelityfx_dx12.dll', 'the game\'s own FSR');
  const exe = fakeExe(content, exeName);
  return { root, content, exe };
}

// ── discover.xboxPairedDir ───────────────────────────────────────────────────────────────────

test('a Store install\'s two folders find each other; nothing else has a pair', () => {
  const { root, content } = xboxPackage('xbox-pair');
  assert.equal(discover.xboxPairedDir(content), root, 'Content\\ -> the package root');
  assert.equal(discover.xboxPairedDir(root), content, 'the package root -> Content\\');
  const ordinary = scratchDir('xbox-pair-ordinary');
  fakeExe(path.join(ordinary, 'Content'), 'Game.exe');
  assert.equal(discover.xboxPairedDir(ordinary), null, 'an ordinary game with a Content folder is not a Store install');
  assert.equal(discover.xboxPairedDir(path.join(ordinary, 'Content')), null);
  assert.equal(discover.xboxPairedDir('C:\\XboxGames\\Content'), null, 'never the library folder itself');
  assert.equal(discover.xboxPairedDir('C:\\XboxGames'), null);
  assert.equal(discover.xboxPairedDir(null), null);
});

// ── Remove on a Store install ───────────────────────────────────────────────────────────────

test('Remove on the Content card also cleans what an older build put in the package root, and nothing of the store\'s', { skip: !onWindows }, async () => {
  const { root, content, exe } = xboxPackage('xbox-remove');
  const base = path.dirname(root);
  const release = fakeReleaseFolder(base);
  const nr = fakeNrModel(base);
  const rootBefore = listing(root);
  const { invoke } = loadMain();

  // The #93 install: made while the card's "exe" was the Content folder, so it landed in the root.
  // Reproduced with a stand-in exe there, taken away again after, as the repaired card leaves it.
  const stand = fakeExe(root, 'Stand-in.exe');
  const old = await invoke('game:install', { exePath: stand, releaseFolder: release, nrDllPath: nr, proxyName: 'dxgi.dll' });
  assert.equal(old.ok, true, old.error);
  fs.rmSync(stand);
  assert.ok(fs.existsSync(path.join(root, 'dxgi.dll')), 'the old install sits in the package root');

  // Today's install, where it belongs, and what the engine writes there at runtime.
  const cur = await invoke('game:install', { exePath: exe, releaseFolder: release, nrDllPath: nr, proxyName: 'winmm.dll' });
  assert.equal(cur.ok, true, cur.error);
  write(content, 'OptiScaler.live.json', '{}');
  write(content, 'OptiScaler.live.json.tmp', '{');
  write(content, 'OptiScaler_123456.log', 'a run');

  const plan = await invoke('game:uninstallPlan', exe);
  assert.equal(plan.ok, true, plan.error);
  assert.ok(plan.remove.includes('Microsoft Flight Simulator 2024\\dxgi.dll'), `the root's proxy is in the plan, named with its folder: ${plan.remove.join(', ')}`);
  assert.ok(plan.remove.includes('OptiScaler.live.json'), 'the engine\'s live stats are in the plan');

  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.deepEqual(un.failed, []);
  assert.ok(un.removed.includes('Microsoft Flight Simulator 2024\\dxgi.dll'), un.removed.join(', '));

  // The root is exactly what it was before any install (Content\ and its tree aside, checked next).
  const rootNow = listing(root).filter((r) => !r.startsWith('Content/'));
  assert.deepEqual(rootNow, rootBefore.filter((r) => !r.startsWith('Content/')), 'package root back to before');
  // Content\ holds the store's files and the game's, and nothing of ours.
  assert.deepEqual(listing(content), [
    'D3D12/', 'D3D12/D3D12Core.dll', 'FlightSimulator2024.exe', 'MicrosoftGame.config', 'amd_fidelityfx_dx12.dll',
    'appxmanifest.xml', 'gamelaunchhelper.exe', 'nvngx_dlss.dll', 'sl.interposer.dll',
  ].sort());
  for (const [f, text] of [['nvngx_dlss.dll', GAME_DLSS], ['MicrosoftGame.config', CONFIG], ['D3D12/D3D12Core.dll', 'the package\'s Agility SDK']]) {
    assert.equal(fs.readFileSync(path.join(content, ...f.split('/')), 'utf8'), text, `${f} untouched`);
  }
});

test('the package root alone (a card from before 2.3.14) cleans Content\\ too when ours is there', { skip: !onWindows }, async () => {
  const { root, content, exe } = xboxPackage('xbox-remove-root');
  const base = path.dirname(root);
  const { invoke } = loadMain();
  const r = await invoke('game:install', { exePath: exe, releaseFolder: fakeReleaseFolder(base), nrDllPath: fakeNrModel(base), proxyName: 'winmm.dll' });
  assert.equal(r.ok, true, r.error);
  // Settings > Clean a game folder, pointed at the root -- the one way to reach a root-only card now.
  loadMain({ dialogResponse: 0, openDialogPaths: [] });
  const res = await invoke('game:cleanFolder', { folder: root });
  assert.equal(res.ok, true, res.error);
  assert.ok(!fs.existsSync(path.join(content, 'winmm.dll')), 'Content\\ proxy removed from the root\'s clean');
  assert.ok(fs.existsSync(path.join(content, 'gamelaunchhelper.exe')));
});

test('Remove is refused while the game is running from its folder, and nothing is touched', { skip: !onWindows }, async () => {
  const { root, content, exe } = xboxPackage('xbox-running');
  // A real process started from the game's own folder under the game's own name: node itself,
  // copied over the fake exe and told to wait.
  fs.copyFileSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    write(content, 'OptiScaler.ini', '[Menu]\nOverlayMenu=false\n');
    write(content, 'nvngx_dlssnr.dll', 'model');
    const before = listing(root);
    const { invoke } = loadMain();
    const un = await invoke('game:run-uninstall', exe);
    assert.equal(un.ok, false);
    assert.match(un.error, /while the game is running/);
    assert.deepEqual(listing(root), before, 'not one file changed');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('a process of the same name from another folder does not block Remove', { skip: !onWindows }, async () => {
  // Named after this very process (node.exe, running from its own install folder, not this one).
  const { content, exe } = xboxPackage('xbox-same-name', path.basename(process.execPath));
  write(content, 'OptiScaler.ini', '[Menu]\nOverlayMenu=false\n');
  write(content, 'nvngx_dlssnr.dll', 'model');
  const { invoke } = loadMain();
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.ok(!fs.existsSync(path.join(content, 'OptiScaler.ini')));
});

test('a proxy moved aside by an earlier Remove is a leftover the next Remove deletes', { skip: !onWindows }, async () => {
  const { content, exe } = xboxPackage('xbox-aside');
  write(content, 'winmm.dll.dlss5ui-remove', 'a proxy that was still mapped');
  const { invoke } = loadMain();
  const st = await invoke('game:status', exe);
  assert.ok(st.backends.leftovers.includes('winmm.dll.dlss5ui-remove'), 'the card offers Remove leftovers for it');
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.ok(!fs.existsSync(path.join(content, 'winmm.dll.dlss5ui-remove')));
});

test('a proxy Remove cannot delete is renamed off its proxy name before the ini goes', () => {
  const main = readSrc('main.js');
  const start = main.indexOf('async function uninstallOptiScaler(');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  const aside = body.indexOf('moveProxyAside(proxyPath)');
  assert.ok(aside > 0, 'the failed delete falls back to moving the proxy aside');
  assert.ok(aside < body.indexOf("'OptiScaler.ini'"), 'and does so before the payload loop deletes the ini');
  assert.match(main, /LEGACY_PATTERNS = \[[^\]]*dlss5ui-remove/, 'the moved-aside name is swept as a leftover');
});

test('Remove refuses up front while the game runs, and so does Game Help\'s remove-all', () => {
  const main = readSrc('main.js');
  const h = main.indexOf("ipcMain.handle('game:run-uninstall'");
  const handler = main.slice(h, main.indexOf('\n});\n', h));
  const check = 'gameRunningFromItsFolder(exePath)';
  assert.ok(handler.indexOf(check) > 0 && handler.indexOf(check) < handler.indexOf('uninstallGameFolders('),
    'the running check comes before anything is removed');
  const ra = main.indexOf("case 'remove-all':");
  const fix = main.slice(ra, main.indexOf("case 'install':", ra));
  assert.ok(fix.indexOf(check) > 0 && fix.indexOf(check) < fix.indexOf('uninstallGameFolders('));
});

test('the card offers nothing that moves files while the game runs, Restore originals included', () => {
  const r = readSrc('renderer', 'renderer.js');
  const running = r.indexOf('} else if (running) {');
  const restore = r.indexOf('} else if (issue && issue.canRestore && card._game) {');
  assert.ok(running > 0 && restore > 0 && running < restore, 'running is checked before Restore originals');
});

// ── a folder is not an exe ────────────────────────────────────────────────────────────────────

test('Install refuses a folder recorded as the exe instead of installing into the folder above it', { skip: !onWindows }, async () => {
  const { root, content } = xboxPackage('xbox-folder-exe');
  const base = path.dirname(root);
  const before = listing(root);
  const { invoke } = loadMain();
  const r = await invoke('game:install', { exePath: content, releaseFolder: fakeReleaseFolder(base), nrDllPath: fakeNrModel(base), proxyName: 'dxgi.dll' });
  assert.equal(r.ok, false);
  assert.match(r.error, /folder/);
  assert.deepEqual(listing(root), before, 'nothing written to the package root');
});

test('Edit will not save a folder as the game\'s exe', () => {
  const r = readSrc('renderer', 'renderer.js');
  const save = r.slice(r.indexOf("$('#btn-save-game').addEventListener"));
  assert.match(save.slice(0, 1200), /if \(!\/\\\.exe\$\/i\.test\(exePath\)\) return toast/);
});

// ── Game Help never renames a Store package's files ─────────────────────────────────────────

test('the Agility SDK fix is not offered on a Store install', () => {
  const base = {
    route: { route: 'feeder', feederDeployed: true, optiInstalled: true },
    run: { ran: true, verdict: 'feed-agility-redist' },
    agilityRedist: { exports: true, folder: 'D3D12' },
    fixesTried: [],
  };
  const plain = gamehelp.diagnose({ ...base });
  const store = gamehelp.diagnose({ ...base, storeInstall: true });
  assert.equal(plain.fix && plain.fix.id, 'disable-agility-redist', 'offered on an ordinary install');
  assert.notEqual(store.status, 'fix', 'but never on a Store one');
});

test('and the fix itself refuses a Store install even when asked directly', { skip: !onWindows }, async () => {
  const { content, exe } = xboxPackage('xbox-agility');
  const { invoke } = loadMain();
  const r = await invoke('game:help-apply', { exePath: exe, fixId: 'disable-agility-redist' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.done, false);
  assert.ok(fs.existsSync(path.join(content, 'D3D12', 'D3D12Core.dll')), 'D3D12\\ is where the package put it');
  assert.ok(!fs.existsSync(path.join(content, 'D3D12.dlss5ui-off')));
});
