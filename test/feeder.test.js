'use strict';
// The Feeder deploy's network edges and its Unity profile: a host's bad minute is retried and
// mirrored rather than shown to the user, the two ReShade headers are cached after the first
// fetch, and a Unity game gets the Generic Depth settings its depth needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { scratchDir, write } = require('./helpers');
const feeder = require(path.join(__dirname, '..', 'src', 'feeder'));
const runlog = require(path.join(__dirname, '..', 'src', 'runlog'));
const { diagnose } = require(path.join(__dirname, '..', 'src', 'gamehelp'));
const { agilityRedistRisk } = require(path.join(__dirname, '..', 'src', 'detect'));
const onWindows = process.platform === 'win32';

const HEADER = '#pragma once\n#include "ReShadeUI.fxh"\n';
const okResponse = (text) => ({ ok: true, status: 200, text: async () => text });
const failResponse = (status) => ({ ok: false, status, text: async () => 'Service Unavailable' });

test('a 503 is retried and then succeeds; a 404 is final at once', async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? failResponse(503) : okResponse(HEADER));
  const res = await feeder.fetchWithRetry('https://x/a', {}, { fetchImpl: flaky, pauses: [0, 0, 0] });
  assert.equal(res.ok, true);
  assert.equal(calls, 3);

  let gone = 0;
  const missing = async () => { gone++; return failResponse(404); };
  const res404 = await feeder.fetchWithRetry('https://x/b', {}, { fetchImpl: missing, pauses: [0, 0, 0] });
  assert.equal(res404.status, 404);
  assert.equal(gone, 1);
});

test('a ReShade header comes from the mirror when GitHub keeps failing, and an error page is not accepted', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('raw.githubusercontent.com')) return failResponse(503);
    return okResponse(HEADER);
  };
  const text = await feeder.fetchReShadeHeader('ReShade.fxh', { 'User-Agent': 't' }, { fetchImpl, pauses: [0] });
  assert.equal(text, HEADER);
  assert.ok(seen.some((u) => u.includes('cdn.jsdelivr.net')), 'mirror was tried');

  const htmlOnly = async () => okResponse('<html><body>Cloudflare</body></html>');
  await assert.rejects(() => feeder.fetchReShadeHeader('ReShade.fxh', { 'User-Agent': 't' }, { fetchImpl: htmlOnly, pauses: [] }), /did not return a shader header|Could not fetch/);
});

test('the headers are fetched once per machine: the second deploy reads the cache, no network', async () => {
  const cacheDir = path.join(scratchDir('feeder-cache'), 'cache');
  const gameA = scratchDir('feeder-game-a');
  const gameB = scratchDir('feeder-game-b');
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return okResponse(HEADER); };
  const first = await feeder.deployReShadeCommonHeaders(gameA, { 'User-Agent': 't' }, { cacheDir, fetchImpl, pauses: [] });
  assert.deepEqual(first.files, ['ReShade.fxh', 'ReShadeUI.fxh']);
  assert.equal(fetches, 2);
  const second = await feeder.deployReShadeCommonHeaders(gameB, { 'User-Agent': 't' }, { cacheDir, fetchImpl, pauses: [] });
  assert.deepEqual(second.files, ['ReShade.fxh', 'ReShadeUI.fxh']);
  assert.equal(fetches, 2, 'served from the cache');
  assert.equal(fs.readFileSync(path.join(gameB, 'reshade-shaders', 'Shaders', 'ReShade.fxh'), 'utf8'), HEADER);
});

test('a Unity game gets copy-before-clears and reversed depth, without losing what the ini already said', () => {
  const dir = scratchDir('feeder-unity');
  write(dir, 'ReShade.ini', '[GENERAL]\nPreprocessorDefinitions=RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000.0\n\n[DEPTH]\nUseAspectRatioHeuristics=3\n');
  feeder.configureReShadeIni(dir, { unity: true });
  const ini = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
  assert.match(ini, /DepthCopyBeforeClears=1/);
  assert.match(ini, /UseAspectRatioHeuristics=3/);
  assert.match(ini, /PreprocessorDefinitions=RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000\.0,RESHADE_DEPTH_INPUT_IS_REVERSED=1/);

  // A value someone already chose stays; the definition is not added twice.
  write(dir, 'ReShade.ini', '[DEPTH]\nDepthCopyBeforeClears=2\n[GENERAL]\nPreprocessorDefinitions=RESHADE_DEPTH_INPUT_IS_REVERSED=0\n');
  feeder.configureReShadeIni(dir, { unity: true });
  const kept = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
  assert.match(kept, /DepthCopyBeforeClears=2/);
  assert.equal((kept.match(/RESHADE_DEPTH_INPUT_IS_REVERSED/g) || []).length, 1);
  assert.match(kept, /RESHADE_DEPTH_INPUT_IS_REVERSED=0/);

  // Not Unity: neither key is written.
  const plain = scratchDir('feeder-plain');
  feeder.configureReShadeIni(plain);
  const none = fs.readFileSync(path.join(plain, 'ReShade.ini'), 'utf8');
  assert.doesNotMatch(none, /DepthCopyBeforeClears|RESHADE_DEPTH_INPUT_IS_REVERSED/);
});

test('ReShade reaches the game differently per API, and the Vulkan layer is judged by its add-on exports', async () => {
  assert.equal(feeder.reshadeModeForApi('dx11'), 'local');
  assert.equal(feeder.reshadeModeForApi('dx12'), 'local');
  assert.equal(feeder.reshadeModeForApi('vulkan'), 'vulkan-layer');
  assert.equal(feeder.reshadeModeForApi('opengl'), 'opengl32');

  const layerDir = scratchDir('vk-layer');
  const manifest = path.join(layerDir, 'ReShade64.json');
  // The manifest's library_path is what ReShade's own ships: ".\ReShade64.dll" (one backslash).
  write(layerDir, 'ReShade64.json', JSON.stringify({ layer: { name: 'VK_LAYER_reshade', library_path: '.' + path.sep + 'ReShade64.dll' } }));
  write(layerDir, 'ReShade64.dll', 'MZ plain build without the add-on entry points');
  const regQuery = async (hive) => (hive === 'HKLM'
    ? ['', 'HKEY_LOCAL_MACHINE' + path.sep + 'SOFTWARE' + path.sep + 'Khronos' + path.sep + 'Vulkan' + path.sep + 'ImplicitLayers', `    ${manifest}    REG_DWORD    0x0`, '    C:' + path.sep + 'Steam' + path.sep + 'SteamOverlayVulkanLayer64.json    REG_DWORD    0x0', ''].join('\r\n')
    : '');
  const plain = await feeder.vulkanLayerStatus({ regQuery });
  assert.equal(plain.registered, true);
  assert.equal(plain.hive, 'HKLM');
  assert.equal(plain.addon, false);
  assert.equal(path.resolve(plain.dllPath), path.resolve(layerDir, 'ReShade64.dll'));

  write(layerDir, 'ReShade64.dll', 'MZ build with ReShadeRegisterAddon and ReShadeRegisterEvent exported');
  const addon = await feeder.vulkanLayerStatus({ regQuery });
  assert.equal(addon.addon, true);

  const none = await feeder.vulkanLayerStatus({ regQuery: async () => '' });
  assert.equal(none.registered, false);
});

test('readiness on Vulkan wants the add-on layer and warns about Smooth Motion; on OpenGL it wants ReShade as opengl32.dll', async () => {
  const vk = scratchDir('ready-vk');
  const r = await feeder.feederReadiness(vk, 'vulkan', {});
  assert.equal(r.supported, true);
  assert.equal(r.reshadeMode, 'vulkan-layer');
  assert.equal(r.reshadeInstalled, false);
  assert.ok(r.notes.some((n) => /Smooth Motion/.test(n)));

  const gl = scratchDir('ready-gl');
  const before = await feeder.feederReadiness(gl, 'opengl', {});
  assert.equal(before.reshadeMode, 'opengl32');
  assert.equal(before.reshadeInstalled, false);
  fs.writeFileSync(path.join(gl, 'opengl32.dll'), Buffer.concat([Buffer.from('MZ ReShade '), Buffer.alloc(1024 * 1024 + 1)]));
  const after = await feeder.feederReadiness(gl, 'opengl', {});
  assert.equal(after.reshadeInstalled, true);

  // DX10 has no 64-bit Feeder path. DX9 does now (experimental): behind dgVoodoo2 it renders D3D11,
  // so ReShade goes in the local way (legacy.js).
  const dx10 = await feeder.feederReadiness(gl, 'dx10', {});
  assert.equal(dx10.supported, false);
  const dx9 = await feeder.feederReadiness(gl, 'dx9', {});
  assert.equal(dx9.supported, true);
  assert.equal(dx9.reshadeMode, 'local');
});

test('Remove takes a ReShade opengl32.dll out and puts the game\'s own back; never a non-ReShade one', async () => {
  const dir = scratchDir('remove-gl');
  fs.writeFileSync(path.join(dir, 'opengl32.dll'), Buffer.concat([Buffer.from('MZ ReShade '), Buffer.alloc(1024 * 1024 + 1)]));
  write(dir, 'opengl32.dll.dlss5ui-orig', 'the game\'s own wrapper');
  write(dir, 'dlss5-feed.addon64', 'x');
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({ feederVersion: '1', reshadeMode: 'opengl32', placedNvngxDlss: true }));
  const res = await feeder.removeFeederStack(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'opengl32.dll'), 'utf8'), 'the game\'s own wrapper');
  assert.equal(fs.existsSync(path.join(dir, 'opengl32.dll.dlss5ui-orig')), false);
  assert.ok(res.removed.includes('opengl32.dll'));

  const own = scratchDir('remove-gl-own');
  write(own, 'opengl32.dll', 'a small game-owned file');
  write(own, 'dlss5-feed.addon64', 'x');
  await feeder.removeFeederStack(own);
  assert.equal(fs.existsSync(path.join(own, 'opengl32.dll')), true);
});

// ── The motion-vector provider: the half of the stack that decides whether DLSS is fed anything
// at all, and the one that was quietly broken until v1.57.0 ──────────────────────────────────

test('VORT is the default provider and DRME is not offered at all: it cannot compile on ReShade 6.8', () => {
  const providers = feeder.mvProviderList();
  const def = providers.filter((p) => p.default && p.selectable !== false);
  assert.equal(def.length, 1, 'exactly one selectable default');
  assert.equal(def[0].id, 'vort');
  assert.equal(def[0].mvProviderValue, 2);
  assert.equal(def[0].license, 'MIT');
  assert.equal(feeder.defaultMvProviderId(), 'vort');

  const drme = feeder.MV_PROVIDERS['reshade-motion-estimation'];
  assert.equal(drme.selectable, false, 'DRME is in the table for cleanup only');
  assert.match(drme.unsupportedReason, /does not compile on ReShade 6\.8/);
  assert.equal(drme.default, undefined, 'and it is not the default any more');

  // Launchpad is offered but never fetched: its licence forbids propagation outright.
  const launchpad = feeder.MV_PROVIDERS['immerse-launchpad'];
  assert.equal(launchpad.bringYourOwn, true);
  assert.equal(launchpad.autoFetchable, false);
  assert.equal(launchpad.mvProviderValue, 1);
});

test('the preset names the provider\'s real technique first, at both definition levels, and switching provider replaces the old one', () => {
  const dir = scratchDir('feeder-preset');
  write(dir, 'ReShadePreset.ini', 'Techniques=MyOwnEffect@MyOwn.fx\nTechniqueSorting=MyOwnEffect@MyOwn.fx\n');
  feeder.configurePreset(dir, 'vort');
  let preset = fs.readFileSync(path.join(dir, 'ReShadePreset.ini'), 'utf8');
  // Order matters: the provider writes the vectors DLSS5_Feed reads in the same frame.
  assert.match(preset, /Techniques=MyOwnEffect@MyOwn\.fx,vort_MotionEffects@vort_Motion\.fx,DLSS5_Feed@DLSS5_Feed\.fx/);
  assert.match(preset, /TechniqueSorting=.*vort_MotionEffects@vort_Motion\.fx,DLSS5_Feed@DLSS5_Feed\.fx/);
  // Both levels ReShade reads, so a reload from the overlay cannot disagree with the deploy.
  assert.match(preset, /\[DLSS5_Feed\.fx\][\s\S]*PreprocessorDefinitions=DLSS5_MV_PROVIDER=2/);
  assert.match(preset.split('[')[0], /PreprocessorDefinitions=DLSS5_MV_PROVIDER=2/);

  feeder.configurePreset(dir, 'lumenite-kernel');
  preset = fs.readFileSync(path.join(dir, 'ReShadePreset.ini'), 'utf8');
  assert.doesNotMatch(preset, /vort_MotionEffects/, 'the old provider\'s technique is gone, not orphaned');
  assert.match(preset, /Lumenite_Kernel@lumenite_Kernel\.fx,DLSS5_Feed@DLSS5_Feed\.fx/);
  assert.equal((preset.match(/DLSS5_MV_PROVIDER=3/g) || []).length, 2);
  assert.doesNotMatch(preset, /DLSS5_MV_PROVIDER=2/);
  assert.match(preset, /MyOwnEffect@MyOwn\.fx/, 'the user\'s own effect is left in the list');
});

test('the ReShade ini is hardened the four ways a complete deploy can still load nothing', () => {
  const dir = scratchDir('feeder-ini-hard');
  write(dir, 'ReShade.ini', [
    '[GENERAL]',
    // What ReShade's own setup can seed: Windows rejects the doubled wildcard and no effect loads.
    'EffectSearchPaths=.\\reshade-shaders\\Shaders\\**\\**,.\\my-shaders\\**',
    'NoReloadOnInit=1',
    'StartupPresetPath=.\\SomeoneElse.ini',
    'PresetPath=.\\ReShadePreset.ini',
    '',
    '[ADDON]',
    'DisabledAddons=dlss5-feed,SomeOtherAddon',
    '',
  ].join('\n'));
  feeder.configureReShadeIni(dir, {});
  const ini = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');

  assert.match(ini, /EffectSearchPaths=\.\\reshade-shaders\\Shaders\\\*\*,\.\\my-shaders\\\*\*/);
  assert.doesNotMatch(ini, /\*\*\\\*\*/, 'the malformed doubled wildcard is collapsed');
  // VORT declares a texture by name; without this the shader fails to compile.
  assert.match(ini, /TextureSearchPaths=\.\\reshade-shaders\\Textures\\\*\*/);
  assert.match(ini, /NoReloadOnInit=0/, 'effects must compile at init or nothing ever runs');
  assert.match(ini, /StartupPresetPath=\s*$/m, 'a startup preset elsewhere would override ours');
  assert.match(ini, /DisabledAddons=SomeOtherAddon/, 'our add-on is re-enabled, theirs left alone');
  assert.match(ini, /AddonPath=\.\\/);

  // A startup preset that already is our preset is left exactly as it was.
  write(dir, 'ReShade.ini', '[GENERAL]\nPresetPath=.\\ReShadePreset.ini\nStartupPresetPath=.\\ReShadePreset.ini\n');
  feeder.configureReShadeIni(dir, {});
  assert.match(fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8'), /StartupPresetPath=\.\\ReShadePreset\.ini/);
});

test('the verified Unity depth profile is forced, unlike the engine default which only fills gaps', () => {
  const dir = scratchDir('feeder-depth-verified');
  write(dir, 'ReShade.ini', '[DEPTH]\nDepthCopyBeforeClears=1\n[GENERAL]\nPreprocessorDefinitions=RESHADE_DEPTH_INPUT_IS_REVERSED=0,MY_OWN=1\n');
  const res = feeder.configureReShadeIni(dir, { depthProfile: 'unity-verified' });
  assert.equal(res.depthProfile, 'unity-verified');
  const ini = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
  // The whole profile, not half of it: a value already there is overwritten this time.
  assert.match(ini, /DepthCopyBeforeClears=2/);
  assert.match(ini, /DepthCopyAtClearIndex=1/);
  assert.match(ini, /UseAspectRatioHeuristics=3/);
  assert.match(ini, /DrawStatsHeuristic=0/);
  assert.match(ini, /RESHADE_DEPTH_INPUT_IS_REVERSED=1/);
  assert.match(ini, /RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN=1/);
  assert.match(ini, /RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000\.0/);
  assert.match(ini, /MY_OWN=1/, 'unrelated definitions survive');
  assert.equal((ini.match(/RESHADE_DEPTH_INPUT_IS_REVERSED/g) || []).length, 1);
  assert.deepEqual(feeder.depthProfileIds(), ['unity', 'unity-verified']);
});

test('a game deployed with DRME is reported as broken, and readiness refuses to call it complete', async () => {
  const dir = scratchDir('feeder-drme');
  // The shape an install from before v1.57.0 left behind: every file in place, DRME as the provider.
  for (const rel of ['dlss5-feed.addon64', 'ReShade64.dll', 'nvngx_dlss.dll', 'nvngx_dlssnr.dll']) write(dir, rel);
  for (const rel of ['DLSS5_Feed.fx', 'ReShade.fxh', 'ReShadeUI.fxh', 'MotionEstimation.fx']) write(dir, `reshade-shaders/Shaders/${rel}`);
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({ feederVersion: 'v0.14.0', mvProviderId: 'reshade-motion-estimation' }));
  feeder.configurePreset(dir, 'reshade-motion-estimation');

  const status = feeder.feederProviderStatus(dir);
  assert.equal(status.id, 'reshade-motion-estimation');
  assert.equal(status.broken, true);
  assert.equal(status.shaderPresent, true, 'the file is there -- that was never the problem');
  assert.equal(status.definedValue, 0);

  const readiness = await feeder.feederReadiness(dir, 'dx11');
  assert.equal(readiness.mvProviderOk, false);
  assert.equal(readiness.complete, false, 'every file present is not "ready" when nothing can feed');
  assert.ok(readiness.notes.some((n) => /cannot work/.test(n)), 'and the reason is in the user\'s words');

  // Game Help reaches the same conclusion without waiting for a run, and offers the re-deploy.
  const diag = diagnose({
    detected: { bitness: 64 },
    route: { route: 'feeder', optiInstalled: true, feederDeployed: true },
    mvProvider: status,
    run: { ran: false, verdict: 'no-log' },
  });
  assert.equal(diag.code, 'feeder-mv-broken');
  assert.equal(diag.fix.id, 'redeploy-feeder');
});

test('a preset that enables one provider while the shader is compiled for another is caught as a mismatch', () => {
  const dir = scratchDir('feeder-mismatch');
  write(dir, 'dlss5-feed.addon64');
  write(dir, 'reshade-shaders/Shaders/vort_Motion.fx');
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({ feederVersion: 'v1', mvProviderId: 'vort' }));
  // Compiled for VORT (2) but LumeniteFX's technique is the one enabled -- the Feeder's own
  // "classic silent failure".
  write(dir, 'ReShadePreset.ini', 'Techniques=Lumenite_Kernel@lumenite_Kernel.fx,DLSS5_Feed@DLSS5_Feed.fx\n\n[DLSS5_Feed.fx]\nPreprocessorDefinitions=DLSS5_MV_PROVIDER=2\n');
  const status = feeder.feederProviderStatus(dir);
  assert.equal(status.techniqueMismatch, true);
  assert.equal(status.enabledTechnique, 'Lumenite_Kernel@lumenite_Kernel.fx');
  assert.equal(status.valueMismatch, false, 'the value matches what was deployed; the technique does not');
});

test('the deploy records every provider file it wrote, and Remove takes back exactly those', async () => {
  const dir = scratchDir('feeder-remove-mv');
  write(dir, 'dlss5-feed.addon64');
  write(dir, 'reshade-shaders/Shaders/DLSS5_Feed.fx');
  write(dir, 'reshade-shaders/Shaders/vort_Motion.fx');
  write(dir, 'reshade-shaders/Shaders/Includes/vort_Defs.fxh');
  write(dir, 'reshade-shaders/Textures/vort_BlueNoise.png');
  // The user's own shader pack, in the same folders.
  write(dir, 'reshade-shaders/Shaders/Includes/someone_elses.fxh');
  write(dir, 'reshade-shaders/Textures/someone_elses.png');
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({
    feederVersion: 'v1',
    mvProviderId: 'vort',
    mvFiles: ['Shaders/vort_Motion.fx', 'Shaders/Includes/vort_Defs.fxh', 'Textures/vort_BlueNoise.png'],
    placedNvngxDlss: true,
  }));

  await feeder.removeFeederStack(dir);
  assert.equal(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'vort_Motion.fx')), false);
  assert.equal(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'Includes', 'vort_Defs.fxh')), false);
  assert.equal(fs.existsSync(path.join(dir, 'reshade-shaders', 'Textures', 'vort_BlueNoise.png')), false);
  assert.ok(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'Includes', 'someone_elses.fxh')), 'nothing is removed by folder');
  assert.ok(fs.existsSync(path.join(dir, 'reshade-shaders', 'Textures', 'someone_elses.png')));
});

test('a bring-your-own provider is never fetched: the deploy says what to install instead', async () => {
  const dir = scratchDir('feeder-byo');
  // Everything the earlier deploy steps would fetch is already here, so the provider step is
  // reached without any network at all.
  for (const rel of ['ReShade64.dll', 'dlss5-feed.addon64', 'nvngx_dlss.dll']) write(dir, rel);
  for (const rel of ['DLSS5_Feed.fx', 'ReShade.fxh', 'ReShadeUI.fxh']) write(dir, `reshade-shaders/Shaders/${rel}`);
  assert.equal(feeder.mvProviderPresent(dir, 'immerse-launchpad'), false);
  await assert.rejects(
    () => feeder.deployFeederStack(dir, 'dx11', 'immerse-launchpad', { cacheDir: path.join(dir, 'cache'), ghHeaders: { 'User-Agent': 't' } }),
    /MartysMods_LAUNCHPAD\.fx is not in this game|cannot redistribute/);
  write(dir, 'reshade-shaders/Shaders/MartysMods_LAUNCHPAD.fx', 'technique MartysMods_Launchpad');
  assert.equal(feeder.mvProviderPresent(dir, 'immerse-launchpad'), true);
});

test('a provider whose zip keeps its own folder layout lands with its includes and textures in place', async () => {
  if (!onWindows) return; // the zip is built with Compress-Archive
  const src = scratchDir('vort-src');
  write(src, 'vort_Shaders-pinned/Shaders/vort_Motion.fx', '#include "Includes/vort_Defs.fxh"\ntechnique vort_MotionEffects');
  write(src, 'vort_Shaders-pinned/Shaders/Includes/vort_Defs.fxh', '#pragma once');
  write(src, 'vort_Shaders-pinned/Shaders/Includes/vort_MotionUtils.fxh', '#pragma once');
  write(src, 'vort_Shaders-pinned/Shaders/vort_Static.fx', 'technique vort_Static');
  write(src, 'vort_Shaders-pinned/Textures/vort_BlueNoise.png', 'PNG');
  write(src, 'vort_Shaders-pinned/Textures/vort_MLUT.png', 'PNG');
  write(src, 'vort_Shaders-pinned/LICENSE', 'MIT License');
  const cacheDir = scratchDir('vort-cache');
  const zipPath = path.join(cacheDir, 'vort.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:SRC "*") -DestinationPath $env:DEST -Force'],
    { env: { ...process.env, SRC: src, DEST: zipPath } });

  const dir = scratchDir('vort-game');
  const res = await feeder.deployMvProvider(dir, 'vort', cacheDir, { 'User-Agent': 't' });
  const at = (rel) => fs.existsSync(path.join(dir, 'reshade-shaders', ...rel.split('/')));
  assert.ok(at('Shaders/vort_Motion.fx'));
  assert.ok(at('Shaders/Includes/vort_Defs.fxh'), 'the include path the shader itself names');
  assert.ok(at('Shaders/Includes/vort_MotionUtils.fxh'));
  assert.ok(at('Textures/vort_BlueNoise.png'), 'the texture the shader declares by name');
  assert.ok(at('Licenses/VORT-LICENSE.txt'));
  assert.equal(at('Shaders/vort_Static.fx'), false, 'only the provider technique is deployed');
  assert.ok(res.files.includes('Shaders/Includes/vort_Defs.fxh'), 'and every path is recorded for Remove');
});

// ── The two traps behind a Unity report where everything looks installed ─────────────────────

test('the Agility SDK redirect is only a risk when the exports are there and no redist can be found', () => {
  const dir = scratchDir('agility');
  assert.equal(agilityRedistRisk(dir, { agility: false }), null, 'no exports, no risk');
  assert.deepEqual(agilityRedistRisk(dir, { agility: true }), { exports: true, folder: null });
  write(dir, 'D3D12/readme.txt', 'empty of what matters');
  assert.deepEqual(agilityRedistRisk(dir, { agility: true }), { exports: true, folder: 'D3D12' },
    'a folder with no D3D12Core.dll is the case the Feeder hit');
  write(dir, 'D3D12/D3D12Core.dll', 'MZ');
  assert.equal(agilityRedistRisk(dir, { agility: true }), null, 'a real redist is there: nothing to report');
});

test('the Feeder\'s own log lines become the verdict: no motion, flat depth, and the D3D12 redist refusal', async () => {
  const dir = scratchDir('feed-verdicts');
  const optiLog = (extra = '') => write(dir, 'OptiScaler.log', `Log.LogLevel: 1\nNVSDK_NGX_D3D12_Init\n${extra}`);

  optiLog();
  write(dir, 'dlss5-feed.log', '[feed] motion-vector provider DRME FAILED TO COMPILE, so it writes nothing and DLSS runs on zero vectors. ReShade.log: error X1000 -- use another provider (VORT: DLSS5_MV_PROVIDER=2).\n');
  let run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'feed-no-motion');
  assert.match(run.detail, /FAILED TO COMPILE/, 'the Feeder\'s own sentence is carried, not paraphrased');

  write(dir, 'dlss5-feed.log', '[feed] MV probe (centre 64x64, frame 600): mean |mv| 3.100 px, max 9.20 px, 74% non-zero\n[feed] Depth probe (4x 32x32, frame 600): min 0, max 0, mean 0, variance 0, 100% finite  <-- depth is FLAT while the scene moves: ReShade\'s Generic Depth is on the wrong buffer (Add-ons tab -> Generic Depth). DLSS and the neural pass get no depth until that is fixed\n');
  run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'feed-depth-flat');
  assert.equal(run.feedDepthFlatMoving, true);

  write(dir, 'dlss5-feed.log', '[feed] D3D12CreateDevice failed 0x887E0003 (D3D12_ERROR_INVALID_REDIST)\n');
  run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'feed-agility-redist');

  // And each one reaches a fix the app can actually run.
  const base = { detected: { bitness: 64 }, route: { route: 'feeder', optiInstalled: true, feederDeployed: true } };
  assert.equal(diagnose({ ...base, run: { ran: true, verdict: 'feed-no-motion', detail: 'x' } }).fix.id, 'redeploy-feeder');
  assert.equal(diagnose({ ...base, run: { ran: true, verdict: 'feed-depth-flat' } }).fix.id, 'feeder-depth-profile');
  assert.equal(diagnose({ ...base, run: { ran: true, verdict: 'feed-agility-redist' }, agilityRedist: { exports: true, folder: 'D3D12' } }).fix.id, 'disable-agility-redist');
  // With no folder to move, the honest answer is a step for the user, not a fix.
  const elsewhere = diagnose({ ...base, run: { ran: true, verdict: 'feed-agility-redist' }, agilityRedist: { exports: true, folder: null } });
  assert.equal(elsewhere.status, 'step');
  assert.equal(elsewhere.code, 'feed-agility-redist-elsewhere');
});

test('switching provider takes the old one\'s files out, but never a bring-your-own install', async () => {
  const dir = scratchDir('feeder-switch');
  const cacheDir = path.join(dir, 'cache');
  for (const rel of ['ReShade64.dll', 'dlss5-feed.addon64', 'nvngx_dlss.dll']) write(dir, rel);
  for (const rel of ['DLSS5_Feed.fx', 'ReShade.fxh', 'ReShadeUI.fxh']) write(dir, `reshade-shaders/Shaders/${rel}`);
  write(dir, 'reshade-shaders/Shaders/vort_Motion.fx');
  write(dir, 'reshade-shaders/Shaders/Includes/vort_Defs.fxh');
  write(dir, 'reshade-shaders/Shaders/MartysMods_LAUNCHPAD.fx', 'technique MartysMods_Launchpad');
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({
    feederVersion: 'v1', mvProviderId: 'vort',
    mvFiles: ['Shaders/vort_Motion.fx', 'Shaders/Includes/vort_Defs.fxh'],
  }));
  // Deploying Launchpad (bring-your-own, nothing fetched) over a VORT deploy.
  const deployed = await feeder.deployFeederStack(dir, 'dx11', 'immerse-launchpad', {
    cacheDir, ghHeaders: { 'User-Agent': 't' },
    // Enough of a stub for the nvngx_dlss.dll step, which finds a copy already present.
    getRhiManifest: async () => ({ dlss: [] }), compareVersions: () => 0,
  }).catch((e) => ({ error: e.message }));
  assert.ok(!deployed.error || !/LAUNCHPAD/.test(deployed.error), deployed.error || 'deployed');
  assert.equal(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'vort_Motion.fx')), false, 'the old provider is gone');
  assert.equal(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'Includes', 'vort_Defs.fxh')), false);
  assert.ok(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'MartysMods_LAUNCHPAD.fx')), 'the user\'s own shader stays');

  // And going back the other way never deletes the user's iMMERSE file.
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({
    feederVersion: 'v1', mvProviderId: 'immerse-launchpad', mvFiles: ['Shaders/MartysMods_LAUNCHPAD.fx'],
  }));
  await feeder.deployFeederStack(dir, 'dx11', 'vort', {
    cacheDir, ghHeaders: { 'User-Agent': 't' },
    getRhiManifest: async () => ({ dlss: [] }), compareVersions: () => 0,
  }).catch(() => {});
  assert.ok(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'MartysMods_LAUNCHPAD.fx')), 'still the user\'s own');
});
