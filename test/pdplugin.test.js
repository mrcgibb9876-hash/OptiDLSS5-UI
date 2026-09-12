'use strict';
// PureDark's PDPerfPlugin.dll for the Resident Evil pd route: found in Downloads, imported once from
// whatever the user downloaded, placed in every game that needs it, never over someone else's copy,
// and taken back by Remove only when it is still the copy this app placed. Windows only: real
// system DLLs stand in for the plugin, and zips/7z are made with Windows' own tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { scratchDir, write, fakeExe, loadMain } = require('./helpers');
const pdplugin = require('../src/pdplugin');

const onWindows = process.platform === 'win32';
const SYS = process.env.SystemRoot || 'C:\\Windows';
const DLL64 = path.join(SYS, 'System32', 'version.dll');
const DLL64_OTHER = path.join(SYS, 'System32', 'winmm.dll');
const DLL32 = path.join(SYS, 'SysWOW64', 'version.dll');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function zipFolder(srcDir, zipPath) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:SRC "*") -DestinationPath $env:DEST -Force'],
    { env: { ...process.env, SRC: srcDir, DEST: zipPath } });
}

test('only a 64-bit DLL is accepted as the plugin', { skip: !onWindows }, () => {
  assert.equal(pdplugin.peKind(fs.readFileSync(DLL64)), 'ok');
  if (fs.existsSync(DLL32)) assert.match(pdplugin.peKind(fs.readFileSync(DLL32)), /32-bit/);
  assert.equal(pdplugin.peKind(fs.readFileSync(path.join(SYS, 'System32', 'notepad.exe'))), 'not a DLL');
  assert.equal(pdplugin.peKind(Buffer.from('not a pe file at all, just text padding it out')), 'not a Windows DLL');
});

test('the download is found in Downloads by name, newest first; unrelated archives are ignored', { skip: !onWindows }, () => {
  const downloads = scratchDir('pd-downloads');
  const loose = write(downloads, 'PDPerfPlugin.dll', 'x');
  const archive = write(downloads, 'UpscalerBasePlugin-502-1-3-1-1726000000.7z', 'x');
  write(downloads, 'holiday-photos.zip', 'x');
  write(downloads, 'UpscalerBasePlugin-502/UpscalerBasePlugin/PDPerfPlugin.dll', 'x');
  const now = Date.now() / 1000;
  fs.utimesSync(loose, now - 3000, now - 3000);
  fs.utimesSync(archive, now - 10, now - 10);
  const found = pdplugin.findCandidates([downloads]);
  assert.deepEqual(found.map((c) => c.kind).sort(), ['archive', 'dll', 'dll']);
  assert.equal(found[found.length - 1].path, loose, 'oldest last');
  assert.ok(!found.some((c) => /holiday/.test(c.name)));
  assert.ok(found.some((c) => c.path.includes(path.join('UpscalerBasePlugin-502', 'UpscalerBasePlugin'))), 'an extracted folder counts');
});

test('import takes the DLL out of a .zip (nested), a .dll and a .7z, and refuses the wrong file', { skip: !onWindows }, async () => {
  const base = scratchDir('pd-import');
  const cache = path.join(base, 'cache');

  // .zip with the DLL in a subfolder, as mod archives usually are.
  const src = path.join(base, 'src');
  fs.mkdirSync(path.join(src, 'UpscalerBasePlugin'), { recursive: true });
  fs.copyFileSync(DLL64, path.join(src, 'UpscalerBasePlugin', 'PDPerfPlugin.dll'));
  const zip = path.join(base, 'UpscalerBasePlugin-502-1-3.zip');
  zipFolder(src, zip);
  const info = await pdplugin.importPlugin(zip, cache);
  assert.equal(info.sha256, sha(DLL64));
  assert.equal(info.from, path.basename(zip));
  assert.deepEqual(pdplugin.readCacheInfo(cache), info);
  assert.ok(!fs.readdirSync(cache).some((n) => n.startsWith('.incoming-')), 'work folder cleaned up');

  // A loose DLL, which must carry the plugin's name.
  const loose = path.join(base, 'PDPerfPlugin.dll');
  fs.copyFileSync(DLL64_OTHER, loose);
  assert.equal((await pdplugin.importPlugin(loose, cache)).sha256, sha(DLL64_OTHER));
  const wrongName = path.join(base, 'version.dll');
  fs.copyFileSync(DLL64, wrongName);
  await assert.rejects(pdplugin.importPlugin(wrongName, cache), /is not PDPerfPlugin\.dll/);

  // A zip without it, and a 32-bit DLL under the right name.
  const empty = path.join(base, 'empty-src');
  write(empty, 'readme.txt', 'nothing here');
  const emptyZip = path.join(base, 'UpscalerBasePlugin-empty.zip');
  zipFolder(empty, emptyZip);
  await assert.rejects(pdplugin.importPlugin(emptyZip, cache), /no PDPerfPlugin\.dll inside/);
  if (fs.existsSync(DLL32)) {
    const d32 = path.join(scratchDir('pd-32'), 'PDPerfPlugin.dll');
    fs.copyFileSync(DLL32, d32);
    await assert.rejects(pdplugin.importPlugin(d32, cache), /32-bit/);
  }
  assert.equal(pdplugin.readCacheInfo(cache).sha256, sha(DLL64_OTHER), 'a refused import leaves the good copy');

  // .7z through Windows' tar.exe (libarchive), when this Windows can write one to test with.
  const tarExe = path.join(SYS, 'System32', 'tar.exe');
  const sevenZ = path.join(base, 'UpscalerBasePlugin-502-1-4.7z');
  let made = false;
  try {
    execFileSync(tarExe, ['--format', '7zip', '-cf', sevenZ, '-C', src, 'UpscalerBasePlugin'], { stdio: 'ignore' });
    made = fs.existsSync(sevenZ) && fs.statSync(sevenZ).size > 0;
  } catch {}
  if (made) {
    assert.equal((await pdplugin.importPlugin(sevenZ, cache)).sha256, sha(DLL64), '.7z import');
  }
});

test('placing it: into an empty slot, never over someone else\'s copy, refreshing only our own', { skip: !onWindows }, async () => {
  const base = scratchDir('pd-deploy');
  const cache = path.join(base, 'cache');
  const game = path.join(base, 'game');
  fs.mkdirSync(game, { recursive: true });
  assert.equal(pdplugin.deployToGame(game, cache, null).reason, 'no plugin imported yet');

  const v1 = path.join(scratchDir('pd-v1'), 'PDPerfPlugin.dll');
  fs.copyFileSync(DLL64, v1);
  await pdplugin.importPlugin(v1, cache);
  const first = pdplugin.deployToGame(game, cache, null);
  assert.equal(first.placed, true);
  assert.equal(sha(path.join(game, 'PDPerfPlugin.dll')), sha(DLL64));
  assert.equal(pdplugin.deployToGame(game, cache, { sha256: first.sha256 }).reason, 'already the imported copy');

  // A newer import refreshes the copy we placed...
  const v2 = path.join(scratchDir('pd-v2'), 'PDPerfPlugin.dll');
  fs.copyFileSync(DLL64_OTHER, v2);
  await pdplugin.importPlugin(v2, cache);
  const upd = pdplugin.deployToGame(game, cache, { sha256: first.sha256 });
  assert.equal(upd.updated, true);
  assert.equal(sha(path.join(game, 'PDPerfPlugin.dll')), sha(DLL64_OTHER));

  // ...but a copy someone else put there is left alone.
  const other = path.join(base, 'other');
  fs.mkdirSync(other, { recursive: true });
  fs.copyFileSync(DLL64, path.join(other, 'PDPerfPlugin.dll'));
  const res = pdplugin.deployToGame(other, cache, null);
  assert.equal(res.placed || res.updated, false);
  assert.match(res.reason, /did not place/);
  assert.equal(sha(path.join(other, 'PDPerfPlugin.dll')), sha(DLL64));
});

test('import from the app places it in every installed Resident Evil, the rest get it on sync; Remove takes only ours', { skip: !onWindows }, async () => {
  const { invoke, userData } = loadMain();
  const base = scratchDir('pd-ipc');
  const re2 = path.join(base, 'RE2');
  const re8 = path.join(base, 'RE8');
  const other = path.join(base, 'Other');
  const re2Exe = fakeExe(re2, 're2.exe');
  const re8Exe = fakeExe(re8, 're8.exe');
  const otherExe = fakeExe(other, 'Game.exe');
  for (const dir of [re2, re8]) write(dir, 're_chunk_000.pak', 'x');
  write(re2, 'OptiScaler.ini', '[DlssNr]\nEnabled=auto\n');
  write(other, 'OptiScaler.ini', '[DlssNr]\nEnabled=auto\n');
  const gamesJson = path.join(userData, 'games.json');
  const before = fs.existsSync(gamesJson) ? fs.readFileSync(gamesJson) : null;
  fs.writeFileSync(gamesJson, JSON.stringify([
    { id: 'a', name: 'Resident Evil 2', exePath: re2Exe },
    { id: 'b', name: 'Resident Evil Village', exePath: re8Exe },
    { id: 'c', name: 'Other Game', exePath: otherExe },
  ]));

  try {
    // Found in the (stubbed) Downloads folder.
    const downloads = path.join(userData, 'downloads');
    const src = path.join(scratchDir('pd-ipc-src'), 'UpscalerBasePlugin');
    fs.mkdirSync(src, { recursive: true });
    fs.copyFileSync(DLL64, path.join(src, 'PDPerfPlugin.dll'));
    fs.mkdirSync(downloads, { recursive: true });
    const zip = path.join(downloads, 'UpscalerBasePlugin-502-1-3.zip');
    zipFolder(path.dirname(src), zip);
    const st = await invoke('pdplugin:status');
    assert.ok(st.candidates.some((c) => c.path === zip), 'status finds the download');
    assert.equal(st.pageUrl, 'https://www.nexusmods.com/site/mods/502');

    const res = await invoke('pdplugin:import', { sourcePath: zip });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.placed, ['Resident Evil 2']);
    assert.deepEqual(res.waiting, ['Resident Evil Village']);
    assert.ok(fs.existsSync(path.join(re2, 'PDPerfPlugin.dll')));
    assert.ok(!fs.existsSync(path.join(other, 'PDPerfPlugin.dll')), 'never into a game that does not use it');
    const journal = JSON.parse(fs.readFileSync(path.join(re2, '.optiscaler-manager-install.json'), 'utf8'));
    assert.equal(journal.pdPlugin.sha256, sha(DLL64));

    // Village installed later: the next sync places it without asking. (REFramework and
    // nvngx_dlss.dll already there, so nothing is fetched.)
    write(re8, 'OptiScaler.ini', '[DlssNr]\nEnabled=auto\n[Upscalers]\nDx12Upscaler=auto\n');
    write(re8, 'dinput8.dll', 'hand-placed REFramework');
    write(re8, 'nvngx_dlss.dll', 'x');
    const sync = await invoke('game:sync-if-stale', { exePath: re8Exe, releaseFolder: null, nrDllPath: null });
    assert.equal(sync.ok, true, sync.error);
    assert.ok(fs.existsSync(path.join(re8, 'PDPerfPlugin.dll')), 'placed on sync');

    // Remove preview and Remove take our copy...
    const plan = await invoke('game:uninstallPlan', re2Exe);
    assert.ok(JSON.stringify(plan).includes('PDPerfPlugin.dll'), 'Remove preview lists it');
    const un = await invoke('game:run-uninstall', re2Exe);
    assert.equal(un.ok, true, un.error);
    assert.ok(!fs.existsSync(path.join(re2, 'PDPerfPlugin.dll')), 'our copy removed');

    // ...but not one the user swapped in afterwards.
    fs.copyFileSync(DLL64_OTHER, path.join(re8, 'PDPerfPlugin.dll'));
    const un8 = await invoke('game:run-uninstall', re8Exe);
    assert.equal(un8.ok, true, un8.error);
    assert.ok(fs.existsSync(path.join(re8, 'PDPerfPlugin.dll')), 'a copy that is not ours stays');
  } finally {
    if (before) fs.writeFileSync(gamesJson, before);
    else fs.rmSync(gamesJson, { force: true });
  }
});
