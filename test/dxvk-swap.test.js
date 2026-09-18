'use strict';
// The DXVK <-> dgVoodoo2 swap on a legacy game, end to end: what translation.js recognises, what a
// purge may take, the 32-bit helper route's ReShade moving to the Vulkan layer, Game Help's way back,
// Remove, and the three places the swap can be started from.
//
// The game behind all of it is Assassin's Creed II (32-bit DirectX 9, 2026-09-18): dgVoodoo2 cannot
// draw it, DXVK can, and a review of the 2.2.3 swap found it one-way, silently fatal to DLSS 5 on the
// helper route, invisible to Remove and blind to every real wrapper binary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { REPO, scratchDir, write, fakeReleaseFolder, fakeNrModel, loadMain, listing } = require('./helpers');
const translation = require(path.join(REPO, 'src', 'translation'));
const legacy = require(path.join(REPO, 'src', 'legacy'));
const feeder = require(path.join(REPO, 'src', 'feeder'));
const elevate = require(path.join(REPO, 'src', 'elevate'));
const detect = require(path.join(REPO, 'src', 'detect'));
const route = require(path.join(REPO, 'src', 'route'));
const { diagnose, FIX_IDS } = require(path.join(REPO, 'src', 'gamehelp'));

const onWindows = process.platform === 'win32';
const SYS = process.env.SystemRoot || 'C:\\Windows';
process.env.LEGACY_QUARANTINE_WAIT_MS = '0';

const dll = (signature) => `MZ${'\0'.repeat(64)}${signature}${'x'.repeat(4096)}`;

function exeWith(dir, name, { bits = 64, marker = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(SYS, bits === 32 ? 'SysWOW64' : 'System32', 'notepad.exe');
  const dest = path.join(dir, name);
  fs.copyFileSync(src, dest);
  if (marker) fs.appendFileSync(dest, Buffer.from(`\0${marker}\0`, 'latin1'));
  return dest;
}

function zipDir(srcDir, zipPath) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:SRC "*") -DestinationPath $env:DEST -Force'],
    { env: { ...process.env, SRC: srcDir, DEST: zipPath } });
  return zipPath;
}

function fakeComponents(base) {
  const feederSrc = path.join(base, 'feeder-src');
  write(feederSrc, 'dlss5-feed.addon32', 'addon32');
  write(feederSrc, 'host64/dlss5-feed-host64.exe', 'host exe');
  write(feederSrc, 'reshade-shaders/Shaders/DLSS5_Feed.fx', '// feed fx');
  const reshadeSrc = path.join(base, 'reshade-src');
  write(reshadeSrc, 'ReShade32.dll', 'ReShade 32-bit build');
  write(reshadeSrc, 'ReShade64.dll', 'ReShade 64-bit build');
  const dgSrc = path.join(base, 'dg-src');
  write(dgSrc, 'MS/x86/D3D9.dll', 'dgVoodoo x86 d3d9');
  write(dgSrc, 'MS/x86/D3D8.dll', 'dgVoodoo x86 d3d8');
  write(dgSrc, 'MS/x64/D3D9.dll', 'dgVoodoo x64 d3d9');
  write(dgSrc, 'dgVoodooCpl.exe', 'dgVoodoo control panel');
  write(dgSrc, 'dgVoodoo.conf', '[General]\nOutputAPI = bestavailable\n[DirectX]\nDisableAndPassThru = false\n');
  return {
    feederZip: zipDir(feederSrc, path.join(base, 'DLSS5-Feeder-test.zip')),
    reshadeSetup: zipDir(reshadeSrc, path.join(base, 'ReShade_Setup_test_Addon.zip')),
    dgZip: zipDir(dgSrc, path.join(base, 'dgVoodoo2_test.zip')),
  };
}

function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'latin1');
  h.write('0000644\0', 100, 8, 'latin1');
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1');
  h.write('0', 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

// DXVK's real d3d9.dll carries 'DXVK' and vkGetInstanceProcAddr, which is what detect.js keys on.
function fakeDxvkTarGz() {
  const parts = [];
  for (const arch of ['x32', 'x64']) {
    for (const n of ['d3d8.dll', 'd3d9.dll', 'd3d10core.dll', 'd3d11.dll', 'dxgi.dll']) {
      parts.push(tarEntry(`dxvk-3.1.1/${arch}/${n}`, Buffer.from(dll(`DXVK ${arch} ${n} vkGetInstanceProcAddr`))));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

// A 32-bit DirectX 9 game on the helper route with dgVoodoo2, as Install leaves it.
async function host32Game(base) {
  const comps = fakeComponents(base);
  const game = path.join(base, 'game');
  const exe = exeWith(game, 'AssassinsCreedIIGame.exe', { bits: 32, marker: 'Direct3DCreate9' });
  write(game, 'DataPC.forge', 'game data');
  const before = listing(game);
  const plan = legacy.planFor({ bitness: 32, api: 'dx9' });
  const dgSource = await legacy.importDgVoodooZip(comps.dgZip, path.join(base, 'cache'));
  await legacy.deployDgVoodoo(game, plan, dgSource);
  await legacy.deployHost32(game, plan, {
    ...comps,
    releaseFolder: fakeReleaseFolder(base),
    nrDllPath: fakeNrModel(base),
    deployShaders: async (dir) => {
      write(dir, 'ReShade.ini', '[ADDON]\nAddonPath=.\\\n[INPUT]\nKeyOverlay=36,0,0,0\n');
      write(dir, 'ReShadePreset.ini', 'Techniques=DLSS5_Feed@DLSS5_Feed.fx\n');
      return [];
    },
  });
  return { game, exe, plan, before, dgSource, comps };
}

// ── translation.js: recognising the real binaries ──────────────────────────────────────────────────

test('a wrapper is recognised wherever its name sits in the file, and in UTF-16 too', () => {
  // The real offsets (2026-09-18): 'ReShade' at 3.46 MB in ReShade's DLL, 'DXVK' at 2.3 MB in DXVK's
  // d3d9.dll, 'OptiScaler' at 24.8 MB, and dgVoodoo2's D3D9.dll carrying its name only as UTF-16.
  // A 512 KB latin1 sniff recognised none of them.
  const dir = scratchDir('tl-deep');
  const pad = (mb) => Buffer.alloc(Math.round(mb * 1024 * 1024), 0x41);
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), Buffer.concat([Buffer.from('MZ'), pad(3.4), Buffer.from('ReShade vkGetInstanceProcAddr'), pad(0.5)]));
  fs.writeFileSync(path.join(dir, 'd3d9.dll'), Buffer.concat([Buffer.from('MZ'), pad(2.3), Buffer.from('DXVK'), pad(1)]));
  fs.writeFileSync(path.join(dir, 'D3D8.dll'), Buffer.concat([Buffer.from('MZ'), pad(0.45), Buffer.from('dgVoodoo', 'utf16le'), pad(0.01)]));
  // OptiScaler carries 'ReShade' and 'DXVK' too; its own name outranks them.
  fs.writeFileSync(path.join(dir, 'winmm.dll'), Buffer.concat([Buffer.from('MZ'), pad(1), Buffer.from('ReShade DXVK'), pad(4.5), Buffer.from('OptiScaler', 'utf16le')]));

  const id = (f) => translation.identifyWrapper(path.join(dir, f));
  assert.equal(id('dxgi.dll'), 'reshade');
  assert.equal(id('d3d9.dll'), 'dxvk');
  assert.equal(id('D3D8.dll'), 'dgvoodoo');
  assert.equal(id('winmm.dll'), 'optiscaler');

  // A name straddling the 4 MB chunk boundary is still found.
  const edge = Buffer.concat([pad(4 - 3 / (1024 * 1024)), Buffer.from('DXVK'), pad(0.1)]);
  fs.writeFileSync(path.join(dir, 'd3d11.dll'), edge);
  assert.equal(id('d3d11.dll'), 'dxvk');

  // Cached by size and mtime: a changed file is read again.
  fs.writeFileSync(path.join(dir, 'd3d9.dll'), dll('dgVoodoo'));
  assert.equal(id('d3d9.dll'), 'dgvoodoo');
});

test('a dgVoodoo2 purge from the legacy marker takes dgVoodoo2 and nothing else of the helper install', async () => {
  // A dry run on the real Assassin's Creed II folder listed the game-side ReShade dxgi.dll for removal
  // and the marker was deleted outright: the only record of host64\ and the ReShade proxy.
  const dir = scratchDir('tl-legacy-marker');
  write(dir, 'D3D9.dll', dll('dgVoodoo'));
  write(dir, 'dgVoodooCpl.exe', 'MZ cpl');
  write(dir, 'dgVoodoo.conf', '[General]');
  write(dir, 'dxgi.dll', 'MZ an unrecognisable proxy');
  write(dir, 'dlss5-feed.addon32', 'addon');
  write(dir, 'dinput8.dll.dlss5ui-orig', 'the game\'s own');
  write(dir, translation.LEGACY_MARKER, JSON.stringify({
    version: 1,
    files: ['D3D9.dll', 'dgVoodooCpl.exe', 'dgVoodoo.conf', 'dxgi.dll', 'dlss5-feed.addon32', 'host64/winmm.dll'],
    backups: [{ rel: 'dinput8.dll', backup: 'dinput8.dll.dlss5ui-orig' }],
    dirs: ['host64'],
    dgVoodoo: { arch: 'x86', dll: 'D3D9.dll', source: 'dgVoodoo2_87_4' },
    host32: { api: 'dx9', reshadeName: 'dxgi.dll' },
  }));

  const m = translation.readManifest(dir);
  assert.deepEqual(m.files.sort(), ['D3D9.dll', 'dgVoodoo.conf', 'dgVoodooCpl.exe'].sort(), 'only dgVoodoo2\'s own names');
  assert.deepEqual(m.backups, [], 'and none of the helper route\'s backups');

  const out = await translation.purgeTranslationLayer(dir, { layer: 'dgvoodoo' });
  assert.deepEqual(out.removed.sort(), ['D3D9.dll', 'dgVoodoo.conf', 'dgVoodooCpl.exe'].sort());
  assert.ok(fs.existsSync(path.join(dir, 'dxgi.dll')), 'the ReShade proxy stays');
  assert.ok(fs.existsSync(path.join(dir, 'dinput8.dll.dlss5ui-orig')), 'a backup of the helper route is not restored by a wrapper purge');

  const marker = JSON.parse(fs.readFileSync(path.join(dir, translation.LEGACY_MARKER), 'utf8'));
  assert.equal(marker.dgVoodoo, undefined, 'dgVoodoo2 is out of the marker');
  assert.deepEqual(marker.host32, { api: 'dx9', reshadeName: 'dxgi.dll' }, 'the helper install is still recorded');
  assert.deepEqual(marker.files, ['dxgi.dll', 'dlss5-feed.addon32', 'host64/winmm.dll']);
  assert.deepEqual(marker.backups, [{ rel: 'dinput8.dll', backup: 'dinput8.dll.dlss5ui-orig' }]);
});

test('DXVK\'s logs, named after the exe that loaded it, go with a DXVK purge', async () => {
  const dir = scratchDir('tl-dxvk-logs');
  write(dir, 'd3d9.dll', dll('DXVK'));
  write(dir, 'AssassinsCreedIIGame_d3d9.log', 'info: DXVK: v2.7');
  write(dir, 'Game_dxgi.log', 'x');
  write(dir, 'Game_d3d11.log', 'x');
  write(dir, 'ReShade.log', 'not DXVK\'s');
  const out = await translation.purgeTranslationLayer(dir, { layer: 'dxvk' });
  assert.deepEqual(out.removed.sort(), ['AssassinsCreedIIGame_d3d9.log', 'Game_d3d11.log', 'Game_dxgi.log', 'd3d9.dll'].sort());
  assert.ok(fs.existsSync(path.join(dir, 'ReShade.log')));
});

test('dgVoodoo2 goes through the same gate as DXVK and writes the record DXVK reads', { skip: !onWindows }, async () => {
  const base = scratchDir('dg-gate');
  const comps = fakeComponents(base);
  const dgSource = await legacy.importDgVoodooZip(comps.dgZip, path.join(base, 'cache'));
  const plan = legacy.planFor({ bitness: 64, api: 'dx9' });

  // Someone else's DXVK: refused, not buried as "the game's own d3d9.dll".
  const theirs = path.join(base, 'theirs');
  write(theirs, 'd3d9.dll', dll('DXVK'));
  await assert.rejects(legacy.deployDgVoodoo(theirs, plan, dgSource), /did not put it there/);
  assert.match(fs.readFileSync(path.join(theirs, 'd3d9.dll'), 'latin1'), /DXVK/);

  // Ours: purged first, then dgVoodoo2 in, recorded in both places.
  const ours = path.join(base, 'ours');
  write(ours, 'd3d9.dll', dll('DXVK'));
  translation.writeManifest(ours, translation.newManifest({ layer: 'dxvk', files: ['d3d9.dll'] }));
  await legacy.deployDgVoodoo(ours, plan, dgSource);
  assert.equal(translation.identifyWrapper(path.join(ours, 'D3D9.dll')), 'dgvoodoo');
  assert.ok(!fs.existsSync(path.join(ours, 'D3D9.dll.dlss5ui-orig')), 'DXVK was purged, not backed up as the game\'s own');
  const m = translation.readManifest(ours);
  assert.equal(m.layer, 'dgvoodoo');
  assert.equal(m.fromLegacyMarker, undefined, 'its own manifest, not the marker read as one');
  assert.deepEqual(m.files.sort(), ['D3D9.dll', 'dgVoodoo.conf', 'dgVoodooCpl.exe'].sort());
});

// ── The 32-bit helper route under DXVK ─────────────────────────────────────────────────────────────

test('the game-side ReShade is parked while DXVK is in, and back with dgVoodoo2', { skip: !onWindows }, async () => {
  const base = scratchDir('park');
  const { game, plan, dgSource } = await host32Game(base);
  const cache = path.join(base, 'dxvk-cache');
  const sourceDir = await translation.unpackDxvk(fakeDxvkTarGz(), cache);

  const r = await translation.deployDxvk(game, { sourceDir, api: 'dx9', bitness: 32 });
  assert.equal(r.ok, true);
  assert.equal(legacy.status(game).dgVoodoo, false, 'dgVoodoo2 is out of the marker');
  assert.equal(legacy.status(game).host32, true, 'and the helper install is still in it');

  const parked = await legacy.parkReShadeProxy(game);
  assert.equal(parked.parked, 'dxgi.dll');
  assert.ok(!fs.existsSync(path.join(game, 'dxgi.dll')), 'no ReShade proxy beside the Vulkan layer\'s ReShade');
  assert.equal(fs.readFileSync(path.join(game, `dxgi.dll${legacy.PARK_SUFFIX}`), 'utf8'), 'ReShade 32-bit build');
  assert.ok(legacy.removalPlan(game).remove.includes('dxgi.dll'), 'Remove\'s preview still names it');
  // What the Vulkan layer and the panel need is untouched by the swap.
  assert.ok(fs.existsSync(path.join(game, 'ReShade.ini')));
  assert.ok(fs.existsSync(path.join(game, 'dlss5-feed.addon32')));
  assert.match(fs.readFileSync(path.join(game, 'dlss5-feed.cfg'), 'utf8'), /cast_key=/);
  assert.match(fs.readFileSync(path.join(game, 'host64', 'ReShade.ini'), 'utf8'), /KeyOverlay=0,0,0,0/);

  // Back to dgVoodoo2: DXVK purged by the gate, the proxy unparked.
  await legacy.deployDgVoodoo(game, plan, dgSource);
  assert.equal(fs.readFileSync(path.join(game, 'dxgi.dll'), 'utf8'), 'ReShade 32-bit build');
  assert.ok(!fs.existsSync(path.join(game, `dxgi.dll${legacy.PARK_SUFFIX}`)));
  assert.equal(translation.identifyWrapper(path.join(game, 'D3D9.dll')), 'dgvoodoo');
  assert.equal(legacy.status(game).dgVoodoo, true);
});

test('ReShade\'s setup runs headless and elevated for the 32-bit layer, around our ReShade.ini', async () => {
  const dir = scratchDir('vk-layer');
  write(dir, legacy.MARKER, JSON.stringify({ version: 1, files: [], backups: [], dirs: [], host32: { api: 'dx9', reshadeName: 'dxgi.dll' } }));
  const ours = '[ADDON]\nAddonPath=.\\\n[INPUT]\nKeyOverlay=36,0,0,0\n';
  write(dir, 'ReShade.ini', ours);
  const setupPath = write(dir, 'ReShade_Setup_6.8.0_Addon.exe', 'setup');
  const exe = path.join(dir, 'AssassinsCreedIIGame.exe');
  const appsPath = path.join(dir, 'ProgramData-ReShade', 'ReShadeApps.ini');

  let status = { registered: false, addon: false, appListed: null, appsPath: null };
  const calls = [];
  const res = await legacy.setUpVulkanLayer32(dir, exe, {
    setupPath,
    layerStatus: async () => status,
    runElevated: async (file, args) => {
      calls.push({ file, args, iniThere: fs.existsSync(path.join(dir, 'ReShade.ini')) });
      // What the real setup does: writes its own ReShade.ini and registers the layer.
      write(dir, 'ReShade.ini', '[GENERAL]\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\n');
      status = { registered: true, addon: true, appListed: true, appsPath };
      return { ok: true, code: 0, cancelled: false };
    },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(calls[0].args, [exe, '--api', 'vulkan', '--headless', '--elevated'],
    'the exact command line ReShade\'s setup parses (setup/MainWindow.xaml.cs, v6.8.0)');
  assert.equal(calls[0].iniThere, false, 'held aside: a headless Vulkan install refuses when ReShade.ini exists');
  assert.equal(fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8'), ours, 'ours back byte for byte');
  assert.ok(!fs.existsSync(path.join(dir, 'ReShade.ini.dlss5ui-hold')));
  const rec = legacy.vulkanLayerRecord(dir);
  assert.equal(rec.listedByUs, true, 'journaled: Remove owes taking the exe off the list');
  assert.equal(rec.exe, exe);

  // Already set up: no second admin prompt.
  const again = await legacy.setUpVulkanLayer32(dir, exe, {
    setupPath, layerStatus: async () => status, runElevated: async () => { throw new Error('must not run'); },
  });
  assert.equal(again.ok, true);
  assert.equal(again.ran, false);
  assert.equal(legacy.vulkanLayerRecord(dir).listedByUs, true, 'and the record stays ours');
});

test('a declined admin prompt is reported as that, with our ReShade.ini untouched', async () => {
  const dir = scratchDir('vk-layer-cancel');
  write(dir, legacy.MARKER, JSON.stringify({ version: 1, files: [], backups: [], dirs: [], host32: { api: 'dx9' } }));
  write(dir, 'ReShade.ini', 'ours');
  const setupPath = write(dir, 'setup.exe', 'setup');
  const res = await legacy.setUpVulkanLayer32(dir, path.join(dir, 'Game.exe'), {
    setupPath,
    layerStatus: async () => ({ registered: false, addon: false, appListed: null }),
    runElevated: async () => ({ ok: false, code: 1223, cancelled: true, output: 'ELEVATION-FAILED: The operation was canceled by the user.' }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /administrator prompt was declined/);
  assert.equal(fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8'), 'ours');
  assert.equal(legacy.vulkanLayerRecord(dir).listedByUs, false, 'nothing of ours on the list');
});

test('Remove takes only this exe off ReShade\'s app list, elevating when the file is admin-owned', { skip: !onWindows }, async () => {
  const dir = scratchDir('vk-unlist');
  const appsPath = write(dir, 'ReShadeApps.ini', 'Apps=C:\\Other\\Game.exe,D:\\Games\\Assassins Creed II\\AssassinsCreedIIGame.exe\r\n[Other]\r\nX=1\r\n');
  const rec = { exe: 'D:\\Games\\Assassins Creed II\\AssassinsCreedIIGame.exe', appsPath, listedByUs: true };
  const direct = await legacy.unlistVulkanLayerApp(rec);
  assert.equal(direct.ok, true);
  assert.equal(direct.changed, true);
  assert.equal(fs.readFileSync(appsPath, 'utf8'), 'Apps=C:\\Other\\Game.exe\r\n[Other]\r\nX=1\r\n');

  // Admin-owned: the plain write fails and the elevated copy does it.
  fs.writeFileSync(appsPath, 'Apps=D:\\Games\\Assassins Creed II\\AssassinsCreedIIGame.exe\n');
  fs.chmodSync(appsPath, 0o444);
  let command = null;
  const elevated = await legacy.unlistVulkanLayerApp(rec, {
    runElevatedPowerShell: async (c) => {
      command = c;
      const src = /-LiteralPath '([^']+)'/.exec(c)[1];
      fs.chmodSync(appsPath, 0o644);
      fs.copyFileSync(src, appsPath);
      return { ok: true };
    },
  });
  assert.equal(elevated.ok, true, elevated.error);
  assert.equal(elevated.elevated, true);
  assert.match(command, /^Copy-Item -LiteralPath '.+' -Destination '.+ReShadeApps\.ini' -Force$/);
  assert.equal(fs.readFileSync(appsPath, 'utf8'), 'Apps=\n', 'the layer itself is not uninstalled');
});

test('the elevated launch passes a spaced path as one argument and reports a declined prompt', async () => {
  const script = elevate.elevatedScript('C:\\cache\\ReShade_Setup_6.8.0_Addon.exe', ['D:\\Games\\Assassins Creed II\\AssassinsCreedIIGame.exe', '--api', 'vulkan', "O'Neil"]);
  assert.match(script, /Start-Process -FilePath 'C:\\cache\\ReShade_Setup_6\.8\.0_Addon\.exe' -ArgumentList @\('"D:\\Games\\Assassins Creed II\\AssassinsCreedIIGame\.exe"','--api','vulkan','O''Neil'\) -Verb RunAs -Wait -PassThru/);
  const declined = await elevate.runElevated('x.exe', [], {
    execFileAsync: async () => { throw Object.assign(new Error('exit 1223'), { code: 1223, stdout: 'ELEVATION-FAILED: The operation was canceled by the user.\r\n' }); },
  });
  assert.equal(declined.ok, false);
  assert.equal(declined.cancelled, true);
  const failed = await elevate.runElevated('x.exe', [], {
    execFileAsync: async () => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: '' }); },
  });
  assert.equal(failed.cancelled, false);
  assert.equal(failed.code, 1);
});

test('the 32-bit layer is looked up where a 32-bit Vulkan loader looks', async () => {
  const dir = scratchDir('vk32-status');
  const manifest = write(dir, 'ReShade32.json', JSON.stringify({ layer: { library_path: '.\\ReShade32.dll' } }));
  write(dir, 'ReShade32.dll', 'MZ ReShadeRegisterAddon');
  const exe = 'D:\\Games\\Assassins Creed II\\AssassinsCreedIIGame.exe';
  write(dir, 'ReShadeApps.ini', `Apps=${exe}\n`);
  const keys = [];
  const status = await feeder.vulkanLayerStatus({
    exePath: exe,
    bitness: 32,
    execFileAsync: async (_cmd, args) => {
      keys.push(args[1]);
      return { stdout: args[1].includes('WOW6432Node') ? `    ${manifest}    REG_DWORD    0x0\r\n    C:\\ProgramData\\ReShade\\ReShade64.json    REG_DWORD    0x0\r\n` : '' };
    },
  });
  assert.equal(keys[0], 'HKLM\\SOFTWARE\\WOW6432Node\\Khronos\\Vulkan\\ImplicitLayers');
  assert.equal(status.registered, true);
  assert.equal(status.manifestPath, manifest, 'the 32-bit manifest, not the 64-bit one beside it');
  assert.equal(status.addon, true);
  assert.equal(status.appListed, true);
});

// ── Detection, route and Game Help after the swap ──────────────────────────────────────────────────

test('our DXVK does not turn a 32-bit DirectX 9 game into "32-bit Vulkan"; someone else\'s still does', { skip: !onWindows }, async () => {
  const base = scratchDir('det-dxvk');
  const ours = path.join(base, 'ours');
  const exe = exeWith(ours, 'AssassinsCreedIIGame.exe', { bits: 32, marker: 'Direct3DCreate9' });
  write(ours, 'd3d9.dll', dll('DXVK vkGetInstanceProcAddr'));
  translation.writeManifest(ours, translation.newManifest({ layer: 'dxvk', arch: 'x32', files: ['d3d9.dll'] }));
  const d = await detect.detectGame(ours, exe);
  assert.equal(d.api, 'dx9');
  assert.equal(d.translatedBy, 'dxvk');
  assert.notEqual(d.recommend, 'unsupported');
  // And the stored-detection path (what the card actually uses) agrees.
  const again = await detect.detectGameCached(ours, exe, { stored: { ...d, api: 'dx9', exeStamp: detect.exeStamp(exe) } });
  assert.equal(again.api, 'dx9');

  const plan = legacy.planFor({ bitness: 32, api: d.api });
  assert.equal(plan.supported, true);
  assert.deepEqual(plan.dgVoodoo, { arch: 'x86', dll: 'D3D9.dll' }, 'so the way back to dgVoodoo2 is still planned');

  const r = route.recommendRoute(ours, exe, d, 'nvidia');
  assert.equal(r.route, 'feeder32');
  assert.equal(r.dxvkDeployed, true);
  assert.deepEqual(r.steps.map((s) => [s.key, s.done]), [['dxvk', true], ['feeder32', false]], 'DXVK does dgVoodoo2\'s step');

  const theirsDir = path.join(base, 'theirs');
  const exe2 = exeWith(theirsDir, 'Game.exe', { bits: 32, marker: 'Direct3DCreate9' });
  write(theirsDir, 'd3d9.dll', dll('DXVK vkGetInstanceProcAddr'));
  const stored = await detect.detectGameCached(theirsDir, exe2, { stored: { ...d, api: 'dx9', translatedBy: null, exeStamp: detect.exeStamp(exe2) } });
  assert.equal(stored.api, 'vulkan', 'a DXVK the player placed is still read as what it is');
});

test('the route shows a DXVK chosen before installing, and Install is the next step', () => {
  const dir = scratchDir('route-pref');
  const exe = write(dir, 'Game.exe', 'MZ');
  translation.writePreference(dir, 'dxvk');
  const r = route.recommendRoute(dir, exe, { api: 'dx9', apis: ['dx9'], bitness: 32, recommend: 'optiscaler' }, 'nvidia');
  assert.equal(r.wrapperPreference, 'dxvk');
  assert.equal(r.steps[0].key, 'dxvk');
  assert.equal(r.steps[0].done, false);
  translation.writePreference(dir, null);
  assert.equal(translation.readPreference(dir), null);
});

test('Game Help after the swap: the layer, the add-on, the panel, and the way back', () => {
  const route32 = {
    route: 'feeder32', complete: true, optiInstalled: true, dxvkDeployed: true, dgVoodooDeployed: false,
    legacy: { supported: true, host32: true, api: 'dx9', dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } },
  };
  const good = { exe: 'AssassinsCreedIIGame.exe', layerRegistered: true, layerAddon: true, appListed: true, reshadeIni: true, proxyBack: null, ranSinceSwap: true, feedLogSinceSwap: true, feedExclusive: false };
  const base = { detected: { bitness: 32, api: 'dx9' }, route: route32 };
  const run = (verdict, extra = {}) => ({ ran: true, verdict, at: 't1', nrFrames: 1200, ...extra });

  // Not "dgVoodoo2 missing -> Install", which would put dgVoodoo2 straight back.
  const noRun = diagnose({ ...base, dxvkHost32: { ...good, ranSinceSwap: false, feedLogSinceSwap: false }, run: { ran: false, verdict: 'no-log' } });
  assert.equal(noRun.code, 'dxvk-needs-run');

  const missing = diagnose({ ...base, dxvkHost32: { ...good, layerRegistered: false }, run: run('no-dlss') });
  assert.equal(missing.code, 'dxvk-layer-missing');
  assert.equal(missing.fix.id, 'swap-to-dxvk', 're-running the swap is what installs the layer');
  assert.equal(diagnose({ ...base, dxvkHost32: { ...good, appListed: false }, run: run('no-dlss') }).vars.why, 'not-listed');

  assert.equal(diagnose({ ...base, dxvkHost32: { ...good, reshadeIni: false }, run: run('no-dlss') }).code, 'dxvk-reshade-ini-missing');
  assert.equal(diagnose({ ...base, dxvkHost32: { ...good, proxyBack: 'dxgi.dll' }, run: run('no-dlss') }).code, 'dxvk-two-reshades');
  assert.equal(diagnose({ ...base, dxvkHost32: { ...good, feedLogSinceSwap: false }, run: run('no-dlss') }).code, 'dxvk-addon-not-loaded');

  const back = diagnose({ ...base, dxvkHost32: good, run: run('no-dlss') });
  assert.equal(back.code, 'dxvk-no-dlss');
  assert.equal(back.fix.id, 'swap-to-dgvoodoo');
  const crash = diagnose({ ...base, dxvkHost32: good, run: run('wrapper-crash', { detail: 'd3d9.dll' }) });
  assert.equal(crash.fix.id, 'swap-to-dgvoodoo');
  const crashAgain = diagnose({ ...base, dxvkHost32: good, run: run('wrapper-crash', { detail: 'd3d9.dll' }), fixesTried: ['swap-to-dgvoodoo'] });
  assert.equal(crashAgain.fix.id, 'remove-all');

  assert.equal(diagnose({ ...base, dxvkHost32: good, run: run('nr-ran') }).code, 'ok-panel-in-helper');
  assert.equal(diagnose({ ...base, dxvkHost32: { ...good, feedExclusive: true }, run: run('nr-ran') }).code, 'dxvk-panel-fullscreen');

  assert.ok(FIX_IDS.includes('swap-to-dgvoodoo'));
});

// ── main.js: the swap itself, and Remove ───────────────────────────────────────────────────────────

test('the swap is offered only in dgVoodoo2\'s place, and a choice made before Install is recorded', { skip: !onWindows }, async () => {
  const base = scratchDir('swap-main');
  const { invoke } = loadMain({ dialogResponse: 0 });

  // 32-bit DirectX 11: the helper route's ReShade is its dxgi.dll, which DXVK's D3D11 set needs.
  const dx11 = path.join(base, 'dx11');
  const exe11 = exeWith(dx11, 'Game.exe', { bits: 32, marker: 'D3D11CreateDevice' });
  const refused = await invoke('game:help-apply', { exePath: exe11, fixId: 'swap-to-dxvk' });
  assert.equal(refused.ok, true, refused.error);
  assert.equal(refused.done, false);
  assert.match(refused.text, /only in place of dgVoodoo2/);
  assert.ok(!fs.existsSync(path.join(dx11, 'd3d11.dll')), 'and nothing was placed');

  // 32-bit DirectX 9 with nothing installed: the choice is written down, nothing deployed.
  const dx9 = path.join(base, 'dx9');
  const exe9 = exeWith(dx9, 'AssassinsCreedIIGame.exe', { bits: 32, marker: 'Direct3DCreate9' });
  const chosen = await invoke('game:help-apply', { exePath: exe9, fixId: 'swap-to-dxvk' });
  assert.equal(chosen.done, true, chosen.text);
  assert.match(chosen.text, /Install puts it in front of the game/);
  assert.equal(translation.readPreference(dx9), 'dxvk');
  assert.ok(!fs.existsSync(path.join(dx9, 'd3d9.dll')));
  const r = await invoke('game:route', { exePath: exe9, detected: { api: 'dx9', apis: ['dx9'], bitness: 32, recommend: 'optiscaler', legacyApis: ['dx9'] } });
  assert.equal(r.wrapperPreference, 'dxvk');

  // And back, before anything was placed: the choice is simply forgotten.
  const undone = await invoke('game:help-apply', { exePath: exe9, fixId: 'swap-to-dgvoodoo' });
  assert.equal(undone.done, true, undone.text);
  assert.equal(translation.readPreference(dx9), null);
});

test('a 64-bit DirectX 9 game swaps to DXVK and back, and the message says what happened', { skip: !onWindows }, async () => {
  const base = scratchDir('swap-64');
  const comps = fakeComponents(base);
  const { invoke, userData } = loadMain({ dialogResponse: 0 });
  // The pinned downloads, already in the caches, so nothing here reaches the network.
  await translation.unpackDxvk(fakeDxvkTarGz(), path.join(userData, 'dxvk-cache'));
  await legacy.importDgVoodooZip(comps.dgZip, path.join(userData, 'feeder-cache'));

  const game = path.join(base, 'game');
  const exe = exeWith(game, 'Game.exe', { bits: 64, marker: 'Direct3DCreate9' });
  const before = listing(game);
  const plan = legacy.planFor({ bitness: 64, api: 'dx9' });
  await legacy.deployDgVoodoo(game, plan, legacy.cachedDgVoodoo(path.join(userData, 'feeder-cache')));

  const toDxvk = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-dxvk' });
  assert.equal(toDxvk.done, true, toDxvk.text);
  assert.match(toDxvk.text, /^DXVK \(d3d9\.dll\) replaced dgVoodoo2/);
  assert.equal(translation.activeLayer(game).layer, 'dxvk');
  assert.ok(!fs.existsSync(path.join(game, 'dgVoodoo.conf')));

  const toDg = await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-dgvoodoo' });
  assert.equal(toDg.done, true, toDg.text);
  assert.match(toDg.text, /dgVoodoo2 \(D3D9\.dll\) is back in place of DXVK/);
  assert.equal(translation.activeLayer(game).layer, 'dgvoodoo');

  // Once more to DXVK, then Remove: nothing of either layer survives.
  await invoke('game:help-apply', { exePath: exe, fixId: 'swap-to-dxvk' });
  write(game, 'Game_d3d9.log', 'DXVK log');
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.deepEqual(listing(game), before);
});

test('Remove on a helper-route game under DXVK: DXVK, the parked proxy and the app-list entry all go', { skip: !onWindows }, async () => {
  const base = scratchDir('remove-dxvk32');
  const { game, exe, before } = await host32Game(base);
  const { invoke } = loadMain({ dialogResponse: 0 });
  const sourceDir = await translation.unpackDxvk(fakeDxvkTarGz(), path.join(base, 'dxvk-cache'));
  await translation.deployDxvk(game, { sourceDir, api: 'dx9', bitness: 32 });
  await legacy.parkReShadeProxy(game);
  write(game, 'AssassinsCreedIIGame_d3d9.log', 'DXVK log');
  // What setUpVulkanLayer32 journals after ReShade's setup listed the exe.
  const appsPath = write(base, 'ProgramData-ReShade/ReShadeApps.ini', `Apps=C:\\Other\\Game.exe,${exe}\n`);
  const marker = legacy.readMarker(game);
  marker.vulkanLayer = { exe, appsPath, listedByUs: true, layerInstalledByUs: true };
  fs.writeFileSync(path.join(game, legacy.MARKER), JSON.stringify(marker));

  const preview = await invoke('game:uninstallPlan', exe);
  for (const n of ['d3d9.dll', 'dxgi.dll', translation.MANIFEST, legacy.MARKER, 'AssassinsCreedIIGame_d3d9.log']) {
    assert.ok(preview.remove.includes(n), `${n} in the Remove preview`);
  }

  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.deepEqual(listing(game), before, 'the folder is back to how it was');
  assert.equal(fs.readFileSync(appsPath, 'utf8'), 'Apps=C:\\Other\\Game.exe\n', 'this exe off the list, the other game kept, the layer left');
});

// ── The three entry points share one swap ──────────────────────────────────────────────────────────

test('the card menu, Edit and Game Help all start the same main-process swap', () => {
  const root = path.join(REPO, 'src', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  // The card's overflow: the button is in the template and wired to the shared helper.
  const tpl = js.slice(js.indexOf('card.innerHTML = `'), js.indexOf('setBannerWithFallback(game, card.querySelector'));
  assert.match(tpl, /class="btn btn-ghost btn-swap-layer hidden"/);
  assert.match(js, /card\.querySelector\('\.btn-swap-layer'\)\.addEventListener\('click', \(e\) => applyLayerSwap\(game, e\.currentTarget\.dataset\.fix\)\)/);

  // Edit: the Translation layer choice exists and applies through the same helper.
  assert.match(html, /id="game-layer-section"/);
  assert.match(html, /id="game-layer-select"/);
  const editHandler = js.slice(js.indexOf("$('#game-layer-select').addEventListener"));
  assert.match(editHandler.slice(0, 600), /applyLayerSwap\(game, id\)/);
  assert.match(js, /await loadLayerSection\(game\);/);

  // The helper is the Game Help IPC, nothing of its own.
  const helper = js.slice(js.indexOf('async function applyLayerSwap'), js.indexOf('async function loadLayerSection'));
  assert.match(helper, /window\.api\.gameHelpApply\(game\.exePath, id\)/);
  assert.match(helper, /renderGrid\(\)/, 'and the card is refreshed afterwards');

  // Game Help's More-row button follows the same rule for which way the swap goes.
  assert.match(js, /const layerSwap = layerSwapFor\(r\);/);
  const rule = js.slice(js.indexOf('function layerSwapFor'), js.indexOf('async function applyLayerSwap'));
  assert.match(rule, /route\.legacy\.dgVoodoo/, 'offered only where dgVoodoo2 is the plan');
  assert.match(rule, /swap-to-dgvoodoo/);
  assert.match(rule, /swap-to-dxvk/);
});
