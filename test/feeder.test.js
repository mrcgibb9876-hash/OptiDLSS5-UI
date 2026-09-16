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

  // A run that began at the main menu, which is every run. The Feeder writes its no-motion and
  // flat-depth annotations at the first probe, and a menu has neither -- so those two lines alone
  // used to decide the verdict, and Tomb Raider I-III Remastered was told "DLSS is getting no
  // motion vectors" while its own later probes measured 23.8 px mean and 50.4 px max (2026-09-16).
  write(dir, 'dlss5-feed.log', [
    '[feed] MV probe (centre 64x64, frame 600): mean |mv| 0.000 px, max 0.00 px, 0% non-zero  <-- DLSS is getting (almost) no motion vectors',
    '[feed] Depth probe (4x 32x32, frame 600): min 1, max 1, mean 1, variance 0, 100% finite  <-- sampled depth is flat; inspect the depth debug view / Generic Depth settings',
    '[feed] MV probe (centre 64x64, frame 26400): mean |mv| 23.771 px, max 50.39 px, 96% non-zero',
    '[feed] Depth probe (4x 32x32, frame 26400): min 0.979905, max 0.996492, mean 0.987121, variance 4.91e-05, 100% finite',
    '',
  ].join('\n'));
  run = await runlog.analyzeRun(dir);
  assert.equal(run.feedNoMotion, false, 'one probe that saw real motion settles it');
  assert.equal(run.feedDepthFlat, false, 'and a real depth spread settles the depth half');
  assert.notEqual(run.verdict, 'feed-no-motion');

  // A run where nothing ever moved still reports it: the annotation is not being ignored, and a
  // still scene in 3D (0.5 px) stays below the threshold that real movement clears by 10x.
  write(dir, 'dlss5-feed.log', [
    '[feed] MV probe (centre 64x64, frame 600): mean |mv| 0.000 px, max 0.00 px, 0% non-zero  <-- DLSS is getting (almost) no motion vectors',
    '[feed] MV probe (centre 64x64, frame 6000): mean |mv| 0.062 px, max 0.50 px, 99% non-zero',
    '',
  ].join('\n'));
  run = await runlog.analyzeRun(dir);
  assert.equal(run.feedNoMotion, true, 'still-scene probes never clear it');
  assert.equal(run.verdict, 'feed-no-motion');

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

// Dolphin on DX12 (support bundle, 2026-09-15): DLSS created, the model crashed in the Feeder's first
// evaluate, the Feeder stopped. It used to read as dlss-no-nr, "not a known case".
test('a model crash in the Feeder\'s evaluate is named, and an emulator is pointed at Direct3D 11', async () => {
  const dir = scratchDir('feed-model-crash');
  write(dir, 'OptiScaler.log', [
    '[02:10:02.680701] [I] LogLevel: 2',
    '[02:10:14.029176] [I] NVSDK_NGX_D3D12_Init_Ext calling NVNGXProxy::D3D12_Init_Ext result: 1',
    '[02:10:15.097170] [I] TryCreateOptiFeature Creating OptiScaler feature, HandleId: 1000000',
    '[02:10:15.652671] [I] DlssNr_Dx12::Dispatch DLSS-NR: white point meter up, 64x64 tiles',
  ].join('\n'));
  write(dir, 'dlss5-feed.log', [
    '02:10:09.431  NVIDIA Smooth Motion is active in this process (NvPresent64.dll). It presents more than once per game frame from its own thread',
    '02:10:11.486  [feed] NGX init: transport same-device D3D12, device created with none -- this is the game\'s own device',
    '02:10:15.759  [feed] evaluate raised 0xC0000005 (reading address FFFFFFFFFFFFFFFF) (caught; nothing submitted)',
    '02:10:15.759  [feed] evaluate fault stack, by module (innermost first): D3D12Core.dll <- nvngx_dlssnr.dll <- nvngx.dll_dlssnr.dll <- dxgi.dll <- dlss5-feed.addon64 <- ReShade64.dll <- Dolphin.exe',
    '02:10:15.759  stopped: the DLSS evaluate crashed (the DLSS 5 add-on may be incompatible with this game/resolution). The game renders normally. See dlss5-feed.log for the detail.',
  ].join('\n'));
  const run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'nr-model-crash');
  assert.match(run.detail, /nvngx_dlssnr\.dll/);
  assert.equal(run.feedSmoothMotion, true);
  assert.equal(run.feedSameDevice, true);

  const route = { route: 'feeder', optiInstalled: true, feederDeployed: true };
  const emu = diagnose({ detected: { bitness: 64, emulator: { name: 'Dolphin' } }, route, run });
  assert.equal(emu.status, 'step');
  assert.equal(emu.code, 'nr-model-crash-emulator');
  assert.equal(emu.vars.name, 'Dolphin');
  assert.equal(emu.vars.smoothMotion, 1);
  assert.equal(diagnose({ detected: { bitness: 64 }, route, run }).code, 'nr-model-crash');
});

// Grid 2 (support bundle, 2026-09-15): 1,800 neural frames read as "10 passes", because the count was
// of log lines. The heartbeat and the Feeder's frame milestones carry the real number.
test('the run\'s frame count comes from the heartbeat, not from how many lines the log has', async () => {
  const dir = scratchDir('feed-frame-count');
  write(dir, 'OptiScaler.log', [
    'Log.LogLevel: 2', 'NVSDK_NGX_D3D12_Init',
    '[02:43:09.094957] [I] DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 3840x1949',
    '[02:43:09.106372] [I] DlssNr_Dx12::Dispatch DLSS-NR composition: paper white 1.00x',
    '[02:43:25.592502] [I] DlssNr_Dx12::Dispatch DLSS-NR heartbeat: 600 frames run (0 model failures), 36 fps',
    '[02:44:01.131607] [I] DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 1176x664',
    '[02:44:11.866974] [I] DlssNr_Dx12::Dispatch DLSS-NR heartbeat: 1800 frames run (0 model failures), 39 fps',
  ].join('\n'));
  write(dir, 'dlss5-feed.log', '02:43:08.654  [feed32] frame 1 delivered (3840x1949, reset=0)\n02:43:08.660  [feed32] frame 2 delivered\n02:44:11.865  [feed32] frame 1800 delivered (3840x1949, reset=0)\n');
  const run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'nr-ran');
  assert.equal(run.nrFrames, 1800);
  assert.equal(run.feedFrames, 1800);
  const ok = diagnose({ detected: { bitness: 64 }, route: { route: 'feeder', optiInstalled: true, feederDeployed: true }, run });
  assert.equal(ok.code, 'ok');
  assert.equal(ok.vars.count, 1800);
});

// DOOM 3 BFG (support bundle, 2026-09-13): no OptiScaler.log (LogToFile never on), so Game Help waited for
// "a run" -- while dlss5-feed.log held the run, the crash, and the reason: driver 610.88 reports feature 18
// OutOfDate and needs 616.56.
test('with no OptiScaler.log the Feeder log is the run, and an out-of-date driver is named before anything else', async () => {
  const dir = scratchDir('feed-driver-outdated');
  write(dir, 'dlss5-feed.log', [
    '18:05:08.595  [feed] first frame fed from thread 18452',
    '18:05:08.611  [feed] same (the game\'s) device adapter: NVIDIA GeForce RTX 4070 Ti SUPER  LUID 00000000:0CDD9F4C  PCI 10DE:2705  driver 610.88',
    '18:05:10.214  [feed] NGX feature requirements: feature 18 (neural rendering, what nvngx_dlssnr.dll backs) -> the query itself failed 0xBAD0000C (OutOfDate)',
    '18:05:10.214  [feed]   *** The installed NVIDIA driver reports feature 18 as OutOfDate. Plain DLSS/DLAA may still initialise, but DLSS 5 neural rendering is unavailable until the driver is updated to 616.56 or newer. ***',
    '18:05:18.342  [feed] evaluate raised 0xC0000005 (reading address FFFFFFFFFFFFFFFF) (caught; nothing submitted)',
  ].join('\n'));
  const run = await runlog.analyzeRun(dir);
  assert.equal(run.ran, true, 'the Feeder log counts as a run');
  assert.equal(run.optiLogMissing, true);
  assert.equal(run.verdict, 'driver-outdated');
  assert.equal(run.detail, '616.56');
  assert.equal(run.driverVersion, '610.88');
  const d = diagnose({ detected: { bitness: 64, optiScalerProxy: { file: 'winmm.dll', matchesOurBuild: false } }, route: { route: 'feeder', optiInstalled: true, feederDeployed: true }, run });
  assert.equal(d.code, 'driver-outdated', 'named ahead of anything in the folder');
  assert.deepEqual(d.vars, { min: '616.56', current: '610.88' });

  // A Feeder that only attached and never fed a frame is still no run.
  write(dir, 'dlss5-feed.log', '18:05:03.690  dlss5-feed 1.16.0-beta.1 attached.\n');
  assert.equal((await runlog.analyzeRun(dir)).verdict, 'no-log');
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

test('switching away from a provider deployed before mvFiles existed still takes its files out', async () => {
  const dir = scratchDir('feeder-legacy-switch');
  const cacheDir = path.join(dir, 'cache');
  for (const rel of ['ReShade64.dll', 'dlss5-feed.addon64', 'nvngx_dlss.dll']) write(dir, rel);
  for (const rel of ['DLSS5_Feed.fx', 'ReShade.fxh', 'ReShadeUI.fxh']) write(dir, `reshade-shaders/Shaders/${rel}`);
  // DRME's four files, and a marker of the shape v1.56.0 wrote: provider id, no file list.
  for (const rel of ['MotionEstimation.fx', 'MotionEstimation.fxh', 'MotionEstimationUI.fxh', 'MotionVectors.fxh']) {
    write(dir, `reshade-shaders/Shaders/${rel}`);
  }
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({
    feederVersion: 'v1.16.0-beta.1', mvProviderId: 'reshade-motion-estimation', placedNvngxDlss: true,
  }));

  await feeder.deployFeederStack(dir, 'dx11', 'vort', {
    cacheDir, ghHeaders: { 'User-Agent': 't' },
    getRhiManifest: async () => ({ dlss: [] }), compareVersions: () => 0,
  });

  for (const rel of ['MotionEstimation.fx', 'MotionEstimation.fxh', 'MotionEstimationUI.fxh', 'MotionVectors.fxh']) {
    assert.equal(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', rel)), false,
      `${rel} left behind: ReShade would fail to compile it on every launch`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'vort_Motion.fx')), 'and the new provider is in');
});

test('a Feeder game is configured with Neural Rendering before SR switched off', async () => {
  // Measured on Armored Core VI: pre-SR on that path faults inside the model and stops the feed,
  // because a Feeder game has no pre-upscale colour of its own for the pass to run on.
  const { loadMain, fakeExe, fakeReleaseFolder, fakeNrModel } = require('./helpers');
  const base = scratchDir('presr-off');
  const dir = path.join(base, 'common', 'Feeder Game');
  const exe = fakeExe(dir, 'game.exe');
  if (!fs.existsSync(exe)) return; // needs a real PE (Windows only)
  write(dir, 'dlss5-feed.addon64');
  write(dir, 'ReShade64.dll');
  write(dir, 'nvngx_dlss.dll');
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({ feederVersion: 'v1', mvProviderId: 'vort', reshadeMode: 'local' }));
  write(dir, 'OptiScaler.ini', '[DlssNr]\nEnabled = true\nRunBeforeSR = true\n\n[Plugins]\nLoadReshade = auto\n');

  const { invoke } = loadMain({ userData: scratchDir('presr-ud') });
  // The same entry point Game Help's Reconfigure uses.
  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'reconfigure' });
  assert.ok(res.ok, res.error || 'reconfigured');
  const ini = fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8');
  assert.match(ini, /RunBeforeSR\s*=\s*false/, 'pre-SR is forced off for a Feeder game');
  assert.match(ini, /LoadReshade\s*=\s*true/, 'and the existing forcing still happens');
});

test('a stuck Inspect tool does not survive the app configuring the game', async () => {
  // "Hold frame" freezes the picture while the game runs on behind it, and it persists in the ini
  // -- a user who ticks it once sees a broken-looking game on every later launch. Reported from a
  // user on two DX12 games with no upscaler of their own.
  const { loadMain, fakeExe } = require('./helpers');
  const base = scratchDir('inspect-neutral');
  const dir = path.join(base, 'common', 'Some Game');
  const exe = fakeExe(dir, 'game.exe');
  if (!fs.existsSync(exe)) return; // needs a real PE (Windows only)
  write(dir, 'OptiScaler.ini', [
    '[DlssNr]', 'Enabled = true', 'HoldFrame = true', 'Compare = 2', 'CompareSwap = true',
    'DebugView = 3', 'ApplyModel = false', '',
  ].join('\n'));

  const { invoke } = loadMain({ userData: scratchDir('inspect-ud') });
  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'reconfigure' });
  assert.ok(res.ok, res.error || 'reconfigured');

  const ini = fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8');
  assert.match(ini, /HoldFrame\s*=\s*false/, 'the frozen frame is released');
  assert.match(ini, /^Compare\s*=\s*0/m);
  assert.match(ini, /CompareSwap\s*=\s*false/);
  assert.match(ini, /DebugView\s*=\s*0/);
  assert.match(ini, /ApplyModel\s*=\s*true/, 'and the model is applied again');
});

test('OptiScaler switching DLSS off for a missing nvngx_dlss.dll is read straight out of its log', async () => {
  // From a user's Resident Evil 2 log: everything else looked healthy, and one line at load said
  // DLSS was off for the session. Without that file no route this app builds can make a DLSS call.
  const dir = scratchDir('dlss-runtime-missing');
  write(dir, 'OptiScaler.log', [
    '[22:26:04.759650] [W] OptiScaler v10.0.0-dev loaded',
    '[22:26:04.766916] [I] Check for DLSS files',
    '[22:26:04.814388] [W] nvngx_dlss.dll not found, disabling DLSS',
    '[22:26:04.816287] [I] CheckWorkingMode OptiScaler working as dxgi.dll, system dll loaded',
  ].join('\n'));

  const run = await runlog.analyzeRun(dir);
  assert.equal(run.dlssRuntimeMissing, true);
  assert.equal(run.verdict, 'no-dlss', 'nothing called DLSS, because DLSS was switched off');

  const diag = diagnose({
    detected: { bitness: 64 },
    route: { route: 'reframework-pd', optiInstalled: true },
    run,
  });
  assert.equal(diag.code, 'dlss-runtime-missing');
  assert.equal(diag.fix.id, 'reconfigure', 'and Reconfigure is what places the file');
});

test('a run that dropped every frame, and a run that was not DLSS at all, stop reading as "DLSS 5 ran"', async () => {
  // Both taken from a real Resident Evil 2 session (REFramework pd-upscaler + PureDark's plugin,
  // 2026-09-13). The neural pass dispatches in both, which is exactly why they used to come back
  // as a clean run while the user was looking at a black screen.
  const dir = scratchDir('re2-verdicts');
  const nrRan = 'DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 2560x1570, model 2560x1570, guides 1157x710\n';
  const head = 'Log.LogLevel: 1\nNVSDK_NGX_D3D12_Init_Ext AppId: 231313132\nTryCreateOptiFeature Creating OptiScaler feature, HandleId: 1000000\n';

  // The black screen: OptiScaler refused to dispatch on PureDark's command list, every frame.
  write(dir, 'OptiScaler.log', head + nrRan
    + "TryEvaluateOptiFeature Skipping upscaling because can't restore root signature\n".repeat(3));
  let run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'upscale-skipped', 'not nr-ran, even though the neural pass dispatched');
  assert.equal(run.upscaleSkipped, 3);
  let diag = diagnose({
    detected: { bitness: 64 },
    route: { route: 'reframework-pd', optiInstalled: true },
    run,
  });
  assert.equal(diag.code, 'upscale-skipped');
  assert.equal(diag.status, 'unavailable', 'no fix is offered: the alternative is a crash');

  // The silent substitution: DLSS would not create, so something else did the upscaling.
  write(dir, 'OptiScaler.log', head
    + 'DLSSFeatureDx12::InitDLSS _CreateFeature result: BAD0000B\n'
    + "TryCreateOptiFeature Feature 'DLSS' initialization failed falling back to FSR 2.1.2\n"
    + nrRan);
  run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'sr-backend-fallback');
  assert.deepEqual(run.srBackendFallback, { from: 'DLSS', to: 'FSR 2.1.2' });
  assert.equal(run.srCreateResult, 'BAD0000B', 'the NGX result is carried for a bug report');
  diag = diagnose({ detected: { bitness: 64 }, route: { route: 'reframework-pd', optiInstalled: true }, run });
  assert.equal(diag.code, 'sr-backend-fallback');
  assert.equal(diag.vars.backend, 'FSR 2.1.2');

  // A clean run is still a clean run.
  write(dir, 'OptiScaler.log', head + nrRan);
  run = await runlog.analyzeRun(dir);
  assert.equal(run.verdict, 'nr-ran');
});

// --- pre-release opt-in ----------------------------------------------------------------
// GitHub's /releases/latest hides pre-releases, so a beta the Feeder's author asks someone to
// test used to be unreachable from this app. Opting in walks the release list instead; opting
// out has to keep making the exact call it always did.
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const ghZip = (name) => ({ name, browser_download_url: `https://example.invalid/${name}` });

test('stable stays on /releases/latest; the opt-in takes the newest non-draft release', async () => {
  const seen = [];
  const stable = async (url) => {
    seen.push(url);
    return jsonResponse({ tag_name: 'v1.15.3', prerelease: false, assets: [ghZip('DLSS5-Feeder-1.15.3.zip')] });
  };
  const off = await feeder.resolveFeederAsset({}, { fetchImpl: stable });
  assert.equal(off.tag, 'v1.15.3');
  assert.equal(off.prerelease, false);
  assert.ok(seen[0].endsWith('/releases/latest'), 'the default path must not change endpoint');

  seen.length = 0;
  const listed = async (url) => {
    seen.push(url);
    return jsonResponse([
      { tag_name: 'v1.17.0', draft: true, prerelease: true, assets: [ghZip('DLSS5-Feeder-1.17.0.zip')] },
      { tag_name: 'v1.16.0-beta.2', draft: false, prerelease: true, assets: [ghZip('DLSS5-Feeder-1.16.0-beta.2.zip')] },
      { tag_name: 'v1.15.3', draft: false, prerelease: false, assets: [ghZip('DLSS5-Feeder-1.15.3.zip')] },
    ]);
  };
  const on = await feeder.resolveFeederAsset({}, { allowPrerelease: true, fetchImpl: listed });
  assert.equal(on.tag, 'v1.16.0-beta.2', 'a draft is skipped, the newest real release wins');
  assert.equal(on.prerelease, true);
  assert.ok(seen[0].includes('per_page'), 'the opt-in has to ask for the list');
});

test('a release published without the zip is skipped, and nothing usable is an error', async () => {
  const gappy = async () => jsonResponse([
    { tag_name: 'v1.16.1-beta.1', draft: false, prerelease: true, assets: [] },
    { tag_name: 'v1.16.0-beta.2', draft: false, prerelease: true, assets: [ghZip('DLSS5-Feeder-1.16.0-beta.2.zip')] },
  ]);
  const found = await feeder.resolveFeederAsset({}, { allowPrerelease: true, fetchImpl: gappy });
  assert.equal(found.tag, 'v1.16.0-beta.2', 'one bad release must not break the deploy');

  const allDrafts = async () => jsonResponse([{ tag_name: 'v9', draft: true, assets: [ghZip('DLSS5-Feeder-9.zip')] }]);
  await assert.rejects(() => feeder.resolveFeederAsset({}, { allowPrerelease: true, fetchImpl: allDrafts }),
    /pre-releases included/);

  // A rate-limit body is an object, not an array: it must not be walked as one.
  const limited = async () => jsonResponse({ message: 'API rate limit exceeded' });
  await assert.rejects(() => feeder.resolveFeederAsset({}, { allowPrerelease: true, fetchImpl: limited }),
    /Unexpected answer/);
});

test('a game that crashes inside dgVoodoo2 as it starts is a run, and Game Help offers Remove', async () => {
  // The Feeder's own log from Castlevania: Lords of Shadow 2 (32-bit DX9, 2026-09-14). The helper
  // never started, so there is no OptiScaler.log anywhere -- which used to read as "not run yet".
  const game = scratchDir('wrapper-crash');
  const feedLog = (dll) => [
    '13:54:58.631  dlss5-feed32 1.16.0-beta.2 commit a6c23bd (built Sep 14 2026 08:15:48) attached AGAIN in the same process.',
    `13:54:58.671  ### EXCEPTION RECORDED ###  exception 0xC0000005 (reading address 00000000) at 69611E10 in ${dll}; this add-on was last doing: nothing yet -- no feed work has run in this process`,
    `13:54:58.776  [feed32] crash dump written: ${path.join(game, 'dlss5-feed-crash.dmp')}`,
  ].join('\n');
  write(game, 'dlss5-feed.log', feedLog(path.join(game, 'd3d9.dll')));
  const host = path.join(game, 'host64');

  const run = await runlog.analyzeRun(game, { optiDir: host });
  assert.equal(run.ran, true, 'the crash is the run');
  assert.equal(run.verdict, 'wrapper-crash');
  assert.equal(run.detail, 'd3d9.dll');
  assert.ok(run.at);

  const legacyRoute = { route: 'feeder32', complete: true, optiInstalled: true, dgVoodooDeployed: true, legacy: { dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' } } };
  const diag = diagnose({ detected: { bitness: 32, api: 'dx9' }, route: legacyRoute, run });
  assert.equal(diag.code, 'dgvoodoo-crash');
  assert.equal(diag.fix.id, 'remove-all');

  // The same crash in a wrapper this app did not place: named, not removed.
  const other = diagnose({ detected: { bitness: 32, api: 'dx11' }, route: { ...legacyRoute, dgVoodooDeployed: false, legacy: { dgVoodoo: null } }, run });
  assert.equal(other.code, 'wrapper-crash');
  assert.equal(other.fix, null);

  // Windows' own d3d9.dll faulting is not a wrapper in the game folder.
  write(game, 'dlss5-feed.log', feedLog('C:\Windows\SysWOW64\d3d9.dll'));
  assert.equal((await runlog.analyzeRun(game, { optiDir: host })).verdict, 'no-log');

  // An older helper log from a run that worked does not hide a newer wrapper crash.
  write(host, 'OptiScaler.log', 'DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 2560x1600\nDLL_PROCESS_DETACH\n');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(host, 'OptiScaler.log'), past, past);
  write(game, 'dlss5-feed.log', feedLog(path.join(game, 'd3d9.dll')));
  const again = await runlog.analyzeRun(game, { optiDir: host });
  assert.equal(again.verdict, 'wrapper-crash');
  assert.ok(Date.parse(again.at) > past.getTime(), 'the run is dated by the newer log');
});

test('the frame-time readout takes the newest heartbeat, from the end of a long log', async () => {
  // The same number the in-game panel shows as "Running - N ms per frame": Alien: Isolation read
  // 16.43 there against GPU 16.49 in the log. Read from the tail, because a long session writes
  // past the 6 MB readHead cap and the newest lines are exactly the ones that fall outside it.
  const dir = scratchDir('nr-timing');
  const beat = (frames, fps, gpu) => `[00:00:00.000] [I] DlssNr_Dx12::Dispatch DLSS-NR heartbeat: ${frames} frames run (0 model failures), ${fps} fps, GPU ${gpu} ms | intensity 1.00, preset 0, style 0, passes 1 (1 this frame), full resolution`;
  const cost = (total, model, ours) => `[00:00:00.000] [I] DlssNr_Dx12::Dispatch DLSS-NR cost: ${total} ms total = ${model} ms model + ${ours} ms ours (2% ours)`;

  write(dir, 'OptiScaler.log', [
    'x'.repeat(400000),
    beat(600, 50, '20.10'), cost('20.20', '19.90', '0.30'),
    beat(5400, 48, '16.49'), cost('16.38', '16.11', '0.27'),
    '',
  ].join('\n'));

  const t = await runlog.nrTiming(dir);
  assert.equal(t.ok, true);
  assert.equal(t.msPerFrame, 16.49, 'the newest heartbeat wins, not the first');
  assert.equal(t.fps, 48);
  assert.equal(t.frames, 5400);
  assert.equal(t.failures, 0);
  assert.equal(t.modelMs, 16.11);
  assert.equal(t.oursMs, 0.27);

  // The engine does not always have a GPU time. Those are reasons, not a fake 0.00 ms.
  write(dir, 'OptiScaler.log', beat(1200, 60, 'n/a (timer unreliable)').replace(' ms |', ' |') + '\n');
  const untimed = await runlog.nrTiming(dir);
  assert.equal(untimed.ok, true);
  assert.equal(untimed.msPerFrame, null);
  assert.equal(untimed.gpuUnavailable, 'n/a (timer unreliable)');
  assert.equal(untimed.fps, 60, 'the rest of the heartbeat is still usable');

  // A log with no heartbeat yet, and no log at all, are told apart: the first is a game that has
  // not reached 600 frames, the second is a game that has never run.
  write(dir, 'OptiScaler.log', 'Log.LogLevel: 2\nNVSDK_NGX_D3D12_Init\n');
  assert.equal((await runlog.nrTiming(dir)).reason, 'no-heartbeat');
  assert.equal((await runlog.nrTiming(scratchDir('nr-timing-empty'))).reason, 'no-log');
});

test('a game keeps the Feeder it was deployed with only until a newer one is released', async () => {
  // Games were left on whatever the Feeder was the day they were installed, so a library built up
  // over weeks ran a different add-on per game -- and the fixes that matter most on this route
  // (the Close() failure, the cast's input forwarding) ship in the add-on itself. Four of this
  // machine's games sat on beta.1/beta.2 while beta.3 was out (2026-09-16).
  const dir = scratchDir('feeder-stale');
  assert.equal(feeder.readFeederDeployMarker(dir), null, 'no marker at all is not a version');

  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({ feederVersion: 'v1.16.0-beta.2', mvProviderId: 'vort' }));
  assert.equal(feeder.readFeederDeployMarker(dir).feederVersion, 'v1.16.0-beta.2');

  // A marker written before version tracking existed carries no tag, and is left alone rather than
  // force-redeployed on every sync.
  write(dir, '.dlss5ui-feeder-deploy.json', JSON.stringify({ mvProviderId: 'vort' }));
  assert.equal(feeder.readFeederDeployMarker(dir).feederVersion, undefined);
});
