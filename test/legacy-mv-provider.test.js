'use strict';
// The 32-bit route's motion-vector provider (legacy.js deployLegacyShaders / setMvProvider).
//
// Assassin's Creed II (2026-09-18, 32-bit DX9 on DXVK + ReShade's 32-bit Vulkan layer) jumped, UI
// and all, on VORT -- the only provider this route could use, because main.js refused anything that
// was not auto-fetchable. The Feeder recommends LumeniteFX, whose licence needs per-action consent.
// These pin down: LumeniteFX is allowed with consent and refused without (before anything is
// written); a switch on an installed game takes the old provider's files out, journals the new
// ones, and leaves Remove able to clean everything; and the UI is wired to it. No test here reaches
// the network: every fetch is a stub, and VORT comes from a zip already in the cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratchDir, write, loadMain, pinFixture } = require('./helpers');
const legacy = require('../src/legacy');
const feeder = require('../src/feeder');
const { diagnose } = require('../src/gamehelp');

const onWindows = process.platform === 'win32';
const LUMENITE_RAW = require('../src/integrity').URLS.lumeniteRaw;
const integrity = require('../src/integrity');

// A stub answer, with its URL pinned to exactly this content (the real files are pinned in
// integrity.js); every pin is put back after the test file.
const pinned = new Map();
function answer(url, text) {
  if (!pinned.has(url)) pinned.set(url, integrity.PINS[url]);
  integrity.PINS[url] = integrity.sha256(Buffer.from(text));
  const b = Buffer.from(text);
  return { ok: true, status: 200, text: async () => text, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
}
test.after(() => { for (const [url, prev] of pinned) { if (prev === undefined) delete integrity.PINS[url]; else integrity.PINS[url] = prev; } });

// Answers the ReShade headers and LumeniteFX's files; anything else fails the test loudly.
function stubFetch() {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const name = url.split('/').pop();
    if (/ReShade(UI)?\.fxh$/.test(name)) return answer(url, `#pragma once\n// ${name}\n`);
    if (url.startsWith(LUMENITE_RAW)) return answer(url, `// lumenite ${name}\n`);
    throw new Error(`unexpected fetch in a test: ${url}`);
  };
  return { fetchImpl, urls };
}

const VORT_FILES = [
  'reshade-shaders/Licenses/VORT-LICENSE.txt',
  'reshade-shaders/Shaders/Includes/vort_Defs.fxh',
  'reshade-shaders/Shaders/Includes/vort_Motion_UI.fxh',
  'reshade-shaders/Shaders/vort_Motion.fx',
  'reshade-shaders/Textures/vort_BlueNoise.png',
  'reshade-shaders/Textures/vort_MLUT.png',
];

// A folder as the 32-bit route left Assassin's Creed II before this change: VORT in the journal as
// plain files (no mvProvider record), the preset compiled for provider 2.
function installedOnVort(name) {
  const base = scratchDir(name);
  const game = path.join(base, 'game');
  write(game, 'Game.exe', 'exe');
  write(game, 'dlss5-feed.addon32', 'addon');
  write(game, 'reshade-shaders/Shaders/DLSS5_Feed.fx', '// feed');
  write(game, 'reshade-shaders/Shaders/ReShade.fxh', '#pragma once');
  write(game, 'reshade-shaders/Shaders/ReShadeUI.fxh', '#pragma once');
  write(game, 'host64/dlss5-feed-host64.exe', 'host');
  for (const f of VORT_FILES) write(game, f, '// vort');
  write(game, 'ReShade.ini', '[GENERAL]\n');
  write(game, 'ReShadePreset.ini', 'PreprocessorDefinitions=DLSS5_MV_PROVIDER=2\n' +
    'Techniques=vort_MotionEffects@vort_Motion.fx,DLSS5_Feed@DLSS5_Feed.fx\n' +
    'TechniqueSorting=vort_MotionEffects@vort_Motion.fx,DLSS5_Feed@DLSS5_Feed.fx\n\n' +
    '[DLSS5_Feed.fx]\nPreprocessorDefinitions=DLSS5_MV_PROVIDER=2\n');
  fs.writeFileSync(path.join(game, legacy.MARKER), JSON.stringify({
    version: 1,
    files: ['dlss5-feed.addon32', 'reshade-shaders/Shaders/DLSS5_Feed.fx', 'ReShade.ini', 'ReShadePreset.ini',
      ...VORT_FILES, 'reshade-shaders/Shaders/ReShade.fxh', 'reshade-shaders/Shaders/ReShadeUI.fxh', 'host64/dlss5-feed-host64.exe'],
    backups: [], dirs: ['host64', 'reshade-shaders'],
    host32: { api: 'dx9', reshadeName: 'dxgi.dll' },
  }, null, 2));
  return { base, game, cache: path.join(base, 'cache') };
}

const exists = (game, rel) => fs.existsSync(path.join(game, ...rel.split('/')));
const presetOf = (game) => fs.readFileSync(path.join(game, 'ReShadePreset.ini'), 'utf8');

test('deployLegacyShaders: LumeniteFX is refused without licence consent, before anything is written', async () => {
  const game = scratchDir('legacy-mv-refuse');
  const { fetchImpl, urls } = stubFetch();
  await assert.rejects(
    legacy.deployLegacyShaders(game, 'lumenite-kernel', { cacheDir: path.join(game, '..', 'cache'), fetchImpl }),
    /licen[cs]e/i);
  assert.deepEqual(urls, [], 'nothing fetched');
  assert.ok(!fs.existsSync(path.join(game, 'reshade-shaders')) && !fs.existsSync(path.join(game, 'ReShadePreset.ini')), 'nothing written');
  // DRME stays unselectable, and iMMERSE is never fetched: without the player's copy it is refused.
  await assert.rejects(legacy.deployLegacyShaders(game, 'reshade-motion-estimation', { fetchImpl }), /cannot be used/);
  await assert.rejects(legacy.deployLegacyShaders(game, 'immerse-launchpad', { fetchImpl }), /MartysMods_LAUNCHPAD\.fx is not in/);
});

test('deployLegacyShaders: LumeniteFX with consent is fetched from its official repo and wired into the preset', async () => {
  const game = scratchDir('legacy-mv-lumenite');
  const { fetchImpl, urls } = stubFetch();
  const res = await legacy.deployLegacyShaders(game, 'lumenite-kernel', { cacheDir: path.join(game, '..', 'cache-l'), licenseConfirmed: true, fetchImpl });
  const lumenite = urls.filter((u) => u.startsWith(LUMENITE_RAW));
  assert.equal(lumenite.length, 4, 'the kernel and its three includes, live from the official repo');
  assert.ok(exists(game, 'reshade-shaders/Shaders/lumenite_Kernel.fx'));
  assert.ok(exists(game, 'reshade-shaders/Shaders/include/lumenite_Compute.fxh'));
  assert.ok(res.written.includes('reshade-shaders/Shaders/lumenite_Kernel.fx'));
  assert.ok(res.created.some((f) => /lumenite_Kernel\.fx$/.test(f)));
  const preset = presetOf(game);
  assert.match(preset, /Techniques=Lumenite_Kernel@lumenite_Kernel\.fx,DLSS5_Feed@DLSS5_Feed\.fx/);
  assert.match(preset, /\[DLSS5_Feed\.fx\][^[]*DLSS5_MV_PROVIDER=3/);
});

test('setMvProvider: VORT -> LumeniteFX takes VORT\'s files out, journals LumeniteFX\'s, and Remove still cleans everything', async () => {
  const { game, cache } = installedOnVort('legacy-mv-switch');
  assert.deepEqual(legacy.currentMvProvider(game), { id: 'vort', source: 'preset' }, 'an older install is read from its preset');

  // Declined: nothing changes.
  const { fetchImpl } = stubFetch();
  await assert.rejects(legacy.setMvProvider(game, 'lumenite-kernel', { cacheDir: cache, fetchImpl }), /licen[cs]e/i);
  for (const f of VORT_FILES) assert.ok(exists(game, f), `${f} still there after a declined switch`);
  assert.match(presetOf(game), /DLSS5_MV_PROVIDER=2/);

  const res = await legacy.setMvProvider(game, 'lumenite-kernel', { cacheDir: cache, licenseConfirmed: true, fetchImpl });
  assert.equal(res.from, 'vort');
  assert.equal(res.to, 'lumenite-kernel');
  assert.equal(res.mvProviderValue, 3);
  for (const f of VORT_FILES) assert.ok(!exists(game, f), `${f} removed`);
  assert.ok(!exists(game, 'reshade-shaders/Textures') && !exists(game, 'reshade-shaders/Licenses'), 'VORT\'s own folders go once empty');
  assert.ok(exists(game, 'reshade-shaders/Shaders/DLSS5_Feed.fx'), 'the Feeder\'s shader stays');

  const marker = legacy.readMarker(game);
  assert.equal(marker.mvProvider.id, 'lumenite-kernel');
  for (const f of VORT_FILES) assert.ok(!marker.files.includes(f), `${f} no longer journaled`);
  const low = marker.files.map((f) => f.toLowerCase());
  for (const f of ['reshade-shaders/shaders/lumenite_kernel.fx', 'reshade-shaders/shaders/include/lumenite_helpers.fxh']) {
    assert.ok(low.includes(f), `${f} journaled for Remove`);
  }
  assert.deepEqual(legacy.currentMvProvider(game), { id: 'lumenite-kernel', source: 'marker' });
  const preset = presetOf(game);
  assert.doesNotMatch(preset, /vort_MotionEffects/, 'VORT\'s technique is gone from the preset');
  assert.match(preset, /^Techniques=Lumenite_Kernel@lumenite_Kernel\.fx,DLSS5_Feed@DLSS5_Feed\.fx/m);
  assert.match(preset, /^PreprocessorDefinitions=DLSS5_MV_PROVIDER=3/m);
  assert.match(preset, /\[DLSS5_Feed\.fx\][^[]*DLSS5_MV_PROVIDER=3/);

  await legacy.removeLegacy(game);
  assert.ok(!exists(game, 'reshade-shaders'), 'Remove takes LumeniteFX and the folders with it');
  assert.ok(!exists(game, 'host64') && !exists(game, legacy.MARKER));
});

// VORT back again, from a zip already in the cache (downloadToCache never fetches when it is there).
// On Windows LumeniteFX's Shaders\include and VORT's Shaders\Includes are one folder.
test('setMvProvider: LumeniteFX -> VORT takes LumeniteFX\'s files out and brings VORT\'s back', { skip: !onWindows }, async () => {
  const { base, game, cache } = installedOnVort('legacy-mv-back');
  const { fetchImpl } = stubFetch();
  await legacy.setMvProvider(game, 'lumenite-kernel', { cacheDir: cache, licenseConfirmed: true, fetchImpl });

  const src = path.join(base, 'vort-src', 'vort_Shaders-test');
  write(src, 'Shaders/vort_Motion.fx', '// vort motion');
  write(src, 'Shaders/Includes/vort_Defs.fxh', '// defs');
  write(src, 'Textures/vort_BlueNoise.png', 'png');
  write(src, 'Textures/vort_MLUT.png', 'png');
  write(src, 'LICENSE', 'MIT');
  fs.mkdirSync(cache, { recursive: true });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path $env:SRC -DestinationPath $env:DEST -Force'],
  { env: { ...process.env, SRC: src, DEST: path.join(cache, 'vort.zip') } });
  const unpin = pinFixture({ [integrity.URLS.vortZip]: path.join(cache, 'vort.zip') });

  const res = await legacy.setMvProvider(game, 'vort', { cacheDir: cache, fetchImpl }).finally(unpin);
  assert.equal(res.from, 'lumenite-kernel');
  assert.ok(!exists(game, 'reshade-shaders/Shaders/lumenite_Kernel.fx'));
  for (const f of ['lumenite_Compute.fxh', 'lumenite_Helpers.fxh', 'lumenite_Projections.fxh']) {
    assert.ok(!exists(game, `reshade-shaders/Shaders/include/${f}`), `${f} removed`);
  }
  assert.ok(exists(game, 'reshade-shaders/Shaders/vort_Motion.fx') && exists(game, 'reshade-shaders/Shaders/Includes/vort_Defs.fxh'));
  assert.match(presetOf(game), /^Techniques=vort_MotionEffects@vort_Motion\.fx,DLSS5_Feed@DLSS5_Feed\.fx/m);
  const marker = legacy.readMarker(game);
  assert.equal(marker.mvProvider.id, 'vort');
  assert.ok(!marker.files.some((f) => /lumenite/i.test(f)), 'LumeniteFX is out of the journal');
  assert.ok(marker.files.includes('reshade-shaders/Shaders/vort_Motion.fx'));
  await legacy.removeLegacy(game);
  assert.ok(!exists(game, 'reshade-shaders'));
});

test('setMvProvider refuses a game the 32-bit route is not installed in', async () => {
  const game = scratchDir('legacy-mv-none');
  await assert.rejects(legacy.setMvProvider(game, 'vort', {}), /not installed/);
});

test('main.js: the 32-bit route no longer refuses every provider but VORT, and the IPC keeps the licence gate', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /uses the default motion-vector provider only/);
  const { game } = installedOnVort('legacy-mv-ipc');
  const exePath = path.join(game, 'Game.exe');
  const { invoke } = loadMain();
  const status = await invoke('legacy:mvProvider', { exePath });
  assert.equal(status.ok && status.host32, true);
  assert.equal(status.id, 'vort');
  const refused = await invoke('legacy:setMvProvider', { exePath, mvProviderId: 'lumenite-kernel' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /licen[cs]e/i);
  assert.ok(exists(game, 'reshade-shaders/Shaders/vort_Motion.fx'), 'nothing changed');
});

test('Game Help on the 32-bit route: no motion points at LumeniteFX, and a working run on VORT names it too', () => {
  const route = { route: 'feeder32', complete: true, optiInstalled: true };
  const vort = { id: 'vort', displayName: 'VORT (vortigern11)' };
  const noMotion = diagnose({ detected: { bitness: 32 }, route, legacyMv: vort, run: { ran: true, verdict: 'feed-no-motion', detail: 'x' } });
  assert.equal(noMotion.status, 'step', 'not redeploy-feeder, which is the 64-bit stack and refuses here');
  assert.equal(noMotion.code, 'feed-no-motion-legacy');
  assert.equal(noMotion.vars.onLumenite, 0);
  const ok = diagnose({ detected: { bitness: 32 }, route, legacyMv: vort, run: { ran: true, verdict: 'nr-ran', nrFrames: 600 } });
  assert.equal(ok.code, 'ok-panel-in-helper');
  assert.equal(ok.vars.otherMv, 'VORT (vortigern11)');
  const onLumenite = diagnose({ detected: { bitness: 32 }, route, legacyMv: { id: 'lumenite-kernel' }, run: { ran: true, verdict: 'nr-ran', nrFrames: 600 } });
  assert.equal(onLumenite.vars.otherMv, '');
});

test('the UI: Edit\'s 32-bit picker and the card\'s Motion vectors entry reach legacy:setMvProvider through the licence dialog', () => {
  const root = path.join(__dirname, '..', 'src');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

  for (const id of ['game-legacy-mv-section', 'game-legacy-mv-provider', 'btn-legacy-mv-apply', 'game-legacy-mv-status']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html has #${id}`);
  }
  // Not advanced-only: the card entry has to be able to show it with advanced options off.
  assert.doesNotMatch(/<div id="game-legacy-mv-section"[^>]*>/.exec(html)[0], /advanced-only/);

  assert.match(preload, /legacySetMvProvider:[^\n]*\n?[^\n]*'legacy:setMvProvider'/);
  assert.match(preload, /legacyMvProvider:[^\n]*'legacy:mvProvider'/);
  assert.match(main, /ipcMain\.handle\('legacy:setMvProvider'/);
  assert.match(main, /ipcMain\.handle\('legacy:mvProvider'/);

  // Apply: the licence question first, then the IPC with its answer, then the card refreshed.
  const apply = /async function applyLegacyMvProvider[\s\S]*?\r?\n}\r?\n/.exec(js);
  assert.ok(apply, 'applyLegacyMvProvider exists');
  const body = apply[0];
  assert.ok(body.indexOf('confirmMvProviderLicense(') > -1 && body.indexOf('confirmMvProviderLicense(') < body.indexOf('legacySetMvProvider('),
    'the licence is asked before the switch');
  assert.match(body, /legacySetMvProvider\(game\.exePath, providerId, \{ licenseConfirmed \}\)/);
  assert.match(body, /renderGrid\(\)/);
  assert.match(js, /\$\('#btn-legacy-mv-apply'\)\.addEventListener\('click'[\s\S]{0,200}applyLegacyMvProvider\(game, \$\('#game-legacy-mv-provider'\)\.value\)/);
  // The same licence dialog as the 64-bit Feeder's Deploy, not a copy of it.
  assert.match(/async function confirmMvProviderLicense[\s\S]*?\r?\n}\r?\n/.exec(js)[0], /feederConfirmProviderLicense\(providerId\)/);
  assert.match(/async function deployFeederStack[\s\S]*?\r?\n}\r?\n/.exec(js)[0], /confirmMvProviderLicense\(providerId\)/);

  // The card: a menu entry naming the provider, opening Edit at the picker.
  assert.match(js, /class="btn btn-ghost btn-mv-provider hidden"/);
  assert.match(js, /\.btn-mv-provider'\)\.addEventListener\('click', \(\) => openGameModal\(game, \{ focus: 'legacy-mv' \}\)\)/);
  assert.match(js, /t\('Motion vectors: \{provider\} — change…'/);
  assert.match(js, /opts\.focus === 'legacy-mv'/);
  assert.match(js, /await loadLegacyMvSection\(game\);/);
});

// The provider table is what both pickers show; LumeniteFX must stay behind consent in it.
test('LumeniteFX stays a non-auto-fetchable, selectable provider', () => {
  const p = feeder.MV_PROVIDERS['lumenite-kernel'];
  assert.equal(p.autoFetchable, false);
  assert.equal(p.selectable, true);
  assert.equal(p.mvProviderValue, 3);
});
