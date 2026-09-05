// Native (no PowerShell) installer for the common case: a 64-bit game on Direct3D 11, Direct3D 12
// or OpenGL, with Deep Fried Chicken as the neural consumer. Ported from the D3D/OpenGL branch of
// Install-DLSS5Feeder.ps1 -- see the plan doc for the line-by-line mapping. Vulkan, 32-bit games and
// dgVoodoo2 (Direct3D 8/9) are not covered here; main.js routes those to the existing manual
// fallback instead of calling this.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { FEEDER_RELEASES_API, FEEDER_ASSET_PATTERN, LUMENITE_ZIP_URL, RESHADE_HEADERS } = require('./sources');
const { downloadToCache, resolveGithubAsset } = require('./download');
const { extractReShadeDll } = require('./reshade');
const { openZip, findEntry, findEntries, extractEntryTo } = require('./zip');
const { setIniKey, getIniKey } = require('./ini-merge');

const RESHADE_INI_TEMPLATE = [
  '[ADDON]',
  'AddonPath=.\\',
  '',
  '[DEPTH]',
  'DepthCopyBeforeClears=0',
  '',
  '[GENERAL]',
  'EffectSearchPaths=.\\reshade-shaders\\Shaders\\**',
  'TextureSearchPaths=.\\reshade-shaders\\Textures\\**',
  'IntermediateCachePath=',
  'NoDebugInfo=1',
  'NoEffectCache=0',
  'NoReloadOnInit=0',
  'PerformanceMode=0',
  'PreprocessorDefinitions=',
  'PresetPath=.\\ReShadePreset.ini',
  'PresetShortcutKeys=',
  'PresetShortcutPaths=',
  'PresetTransitionDuration=1000',
  'SkipLoadingDisabledEffects=0',
  'StartupPresetPath=',
  '',
  '[INPUT]',
  'ForceShortcutModifiers=1',
  'InputProcessing=2',
  'KeyEffects=222,0,0,0',
  'KeyOverlay=36,0,0,0',
  'KeyReload=0,0,0,0',
  'KeyScreenshot=220,0,0,0',
  '',
  '[OVERLAY]',
  'TutorialProgress=4',
  ''
].join('\r\n');

function providerTechnique(mvProvider) {
  return mvProvider === 4 ? 'Lumenite_QuantMotion@lumenite_QuantMotion.fx' : 'Lumenite_Kernel@lumenite_Kernel.fx';
}

function providerFx(mvProvider) {
  return mvProvider === 4 ? 'lumenite_QuantMotion.fx' : 'lumenite_Kernel.fx';
}

async function sha256(filePath) {
  try {
    const buf = await fsp.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const bak = `${filePath}.bak-${stamp}`;
  await fsp.copyFile(filePath, bak);
  return bak;
}

// Renames a conflicting file out of the way rather than deleting it -- same as the script's
// Disable-Conflict, minus the interactive confirmation (this app already gates the whole feeder
// install behind an explicit button click, so a second per-file prompt would just be noise).
async function disableConflict(filePath, why, onProgress) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const disabled = `${filePath}.disabled-by-installer`;
  try {
    await fsp.rename(filePath, disabled);
    onProgress({ kind: 'info', line: `${path.basename(filePath)} renamed to .disabled-by-installer (${why}).` });
  } catch (err) {
    onProgress({ kind: 'warn', line: `Could not rename ${path.basename(filePath)}: ${err.message}` });
  }
}

async function findExisting(dir, name) {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? p : null;
}

async function installFeederNative(options, onProgress = () => {}) {
  const { exePath, api, mvProvider = 3, nrDllPath, dlssDllPath, dfcZipPath, cacheDir } = options;
  const gameDir = path.dirname(exePath);
  const shaderDir = path.join(gameDir, 'reshade-shaders', 'Shaders');
  const textureDir = path.join(gameDir, 'reshade-shaders', 'Textures');
  const isGL = api === 'opengl';

  await fsp.mkdir(cacheDir, { recursive: true });

  // 1. ReShade itself, as a local dxgi.dll (D3D) or opengl32.dll (OpenGL).
  const localName = isGL ? 'opengl32.dll' : 'dxgi.dll';
  const reshadeLocalDll = path.join(gameDir, localName);
  if (!fs.existsSync(reshadeLocalDll)) {
    await extractReShadeDll({ cacheDir, bits: 64, destPath: reshadeLocalDll });
    onProgress({ kind: 'info', line: `ReShade installed as ${localName}.` });
  } else {
    onProgress({ kind: 'info', line: `${localName} already present, kept.` });
  }

  // 2. The feeder add-on + shader, from the latest DLSS5-Feeder GitHub release.
  const feederAsset = await resolveGithubAsset(FEEDER_RELEASES_API, FEEDER_ASSET_PATTERN);
  const feederZipPath = await downloadToCache(feederAsset.url, cacheDir, feederAsset.name);
  const feederZip = openZip(feederZipPath);

  const addonEntry = findEntry(feederZip, /(^|\/)dlss5-feed\.addon64$/i);
  if (!addonEntry) throw new Error('dlss5-feed.addon64 not found in the Feeder release');
  extractEntryTo(feederZip, addonEntry, path.join(gameDir, 'dlss5-feed.addon64'));

  const fxEntry = findEntry(feederZip, /(^|\/)DLSS5_Feed\.fx$/i);
  if (!fxEntry) throw new Error('DLSS5_Feed.fx not found in the Feeder release');
  extractEntryTo(feederZip, fxEntry, path.join(shaderDir, 'DLSS5_Feed.fx'));
  onProgress({ kind: 'info', line: `dlss5-feed.addon64 and DLSS5_Feed.fx installed (${feederAsset.tag}).` });

  // 3. ReShade framework headers.
  for (const [name, url] of Object.entries(RESHADE_HEADERS)) {
    const dest = path.join(shaderDir, name);
    if (fs.existsSync(dest)) continue;
    const cached = await downloadToCache(url, cacheDir, name);
    await fsp.mkdir(shaderDir, { recursive: true });
    await fsp.copyFile(cached, dest);
  }
  onProgress({ kind: 'info', line: 'ReShade framework headers in place.' });

  // 4. Motion vectors: LumeniteFX.
  const lumeniteZipPath = await downloadToCache(LUMENITE_ZIP_URL, cacheDir, 'LumeniteFX-mainline.zip');
  const lumeniteZip = openZip(lumeniteZipPath);
  let lumeniteCount = 0;
  for (const entry of findEntries(lumeniteZip, /.?/)) {
    const name = entry.name.replace(/\\/g, '/');
    let m = name.match(/(^|\/)Shaders\/(lumenite_[^/]+\.fx)$/i);
    if (m) { extractEntryTo(lumeniteZip, entry, path.join(shaderDir, m[2])); lumeniteCount++; continue; }
    m = name.match(/(^|\/)Shaders\/include\/([^/]+\.fxh)$/i);
    if (m) { extractEntryTo(lumeniteZip, entry, path.join(shaderDir, 'include', m[2])); lumeniteCount++; continue; }
    m = name.match(/(^|\/)Textures\/([^/]+)$/i);
    if (m && !name.endsWith('/')) { extractEntryTo(lumeniteZip, entry, path.join(textureDir, m[2])); lumeniteCount++; }
  }
  if (lumeniteCount === 0) throw new Error('no Shaders/ or Textures/ entries found in the LumeniteFX zip');
  onProgress({ kind: 'info', line: `LumeniteFX installed (${lumeniteCount} files).` });

  // 5. Neural consumer: Deep Fried Chicken, and the exclusivity rules from the script.
  await disableConflict(await findExisting(gameDir, 'renodx-dlss5.addon64'), 'Deep Fried Chicken stays inert while a RenoDX neural provider is loaded', onProgress);
  await disableConflict(await findExisting(gameDir, 'alexs-toolkit.addon64'), "a third interposer on the same NGX module; Chicken's docs ask for it to be removed", onProgress);
  await disableConflict(await findExisting(gameDir, 'dlss5-dx11-bridge.addon64'), 'the DX11 bridge must never be combined with DLSS5-Feeder', onProgress);

  if (dfcZipPath && fs.existsSync(dfcZipPath)) {
    const dfcZip = openZip(dfcZipPath);
    const dfcFiles = ['deep-fried-chicken.addon64', 'deep-fried-chicken-nvngx.dll', 'deep-fried-chicken.cfg'];
    for (const name of dfcFiles) {
      const dest = path.join(gameDir, name);
      if (name === 'deep-fried-chicken.cfg' && fs.existsSync(dest)) continue; // keep the user's settings
      const entry = findEntry(dfcZip, new RegExp(`(^|/)${name.replace('.', '\\.')}$`, 'i'));
      if (!entry) throw new Error(`${name} not found in the Deep Fried Chicken zip`);
      extractEntryTo(dfcZip, entry, dest);
    }
    onProgress({ kind: 'info', line: 'Deep Fried Chicken installed (add-on, NGX bridge, cfg).' });
  } else {
    onProgress({ kind: 'warn', line: 'No Deep Fried Chicken zip set in Settings -- the neural consumer was not installed. Set it and re-run.' });
  }

  // NVIDIA runtimes, deduped by hash so a re-run doesn't needlessly rewrite an identical file.
  for (const [name, srcPath] of [['nvngx_dlssnr.dll', nrDllPath], ['nvngx_dlss.dll', dlssDllPath]]) {
    if (!srcPath || !fs.existsSync(srcPath)) continue;
    const dest = path.join(gameDir, name);
    if (fs.existsSync(dest) && (await sha256(dest)) === (await sha256(srcPath))) continue;
    await fsp.copyFile(srcPath, dest);
    onProgress({ kind: 'info', line: `${name} installed.` });
  }

  // The script's d3dcompiler_47.dll trap (renaming a Windows 8.1-era copy that can't compile the
  // neural pass) needs a FileVersion resource read, which has no dependency-free path in Node --
  // deliberately not ported in Phase A rather than faked. Tracked as a known gap, not silently
  // dropped: it only matters for a small number of older game bundles, and worst case a bad DLL
  // there just means the game falls back to System32's copy failing to compile until removed by
  // hand, not a crash or a security issue.

  // 7. ReShade.ini
  const iniPath = path.join(gameDir, 'ReShade.ini');
  const existingIni = await readTextIfExists(iniPath);
  if (existingIni) {
    let next = existingIni;
    next = setIniKey(next, 'ADDON', 'AddonPath', '.\\');
    next = setIniKey(next, 'GENERAL', 'EffectSearchPaths', '.\\reshade-shaders\\Shaders\\**');
    next = setIniKey(next, 'GENERAL', 'TextureSearchPaths', '.\\reshade-shaders\\Textures\\**');
    if (!getIniKey(next, 'GENERAL', 'PresetPath')) next = setIniKey(next, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
    if (next.trimEnd() !== existingIni.trimEnd()) {
      const bak = await backupFile(iniPath);
      await fsp.writeFile(iniPath, next, 'utf8');
      onProgress({ kind: 'info', line: `ReShade.ini: existing file kept, keys merged in (backup: ${bak}).` });
    } else {
      onProgress({ kind: 'info', line: 'ReShade.ini already has the required keys.' });
    }
  } else {
    await fsp.writeFile(iniPath, RESHADE_INI_TEMPLATE, 'utf8');
    onProgress({ kind: 'info', line: 'ReShade.ini written from the template.' });
  }

  // 8. ReShadePreset.ini: the motion-vector provider must run before DLSS5_Feed.
  const presetPath = path.join(gameDir, 'ReShadePreset.ini');
  const feedTechnique = 'DLSS5_Feed@DLSS5_Feed.fx';
  const provTechnique = providerTechnique(mvProvider);
  const existingPreset = await readTextIfExists(presetPath);
  if (existingPreset) {
    let next = existingPreset;
    for (const key of ['Techniques', 'TechniqueSorting']) {
      const cur = getIniKey(next, '', key);
      let list = cur ? cur.split(',').map((s) => s.trim()).filter(Boolean) : [];
      list = list.filter((t) => t.toLowerCase() !== provTechnique.toLowerCase() && t.toLowerCase() !== feedTechnique.toLowerCase() && !/^DLSS5_Feed_Debug@/i.test(t));
      list.push(provTechnique, feedTechnique);
      if (key === 'TechniqueSorting') list.push('DLSS5_Feed_Debug@DLSS5_Feed.fx');
      next = setIniKey(next, '', key, list.join(','));
    }
    const curDefs = getIniKey(next, 'DLSS5_Feed.fx', 'PreprocessorDefinitions');
    let defParts = curDefs ? curDefs.split(',').map((s) => s.trim()).filter((s) => s && !/^DLSS5_MV_PROVIDER\s*=/i.test(s)) : [];
    defParts.push(`DLSS5_MV_PROVIDER=${mvProvider}`);
    next = setIniKey(next, 'DLSS5_Feed.fx', 'PreprocessorDefinitions', defParts.join(','));
    if (next.trimEnd() !== existingPreset.trimEnd()) {
      const bak = await backupFile(presetPath);
      await fsp.writeFile(presetPath, next, 'utf8');
      onProgress({ kind: 'info', line: `ReShadePreset.ini: existing preset kept; ${provTechnique.split('@')[0]} and DLSS5_Feed enabled (backup: ${bak}).` });
    } else {
      onProgress({ kind: 'info', line: 'ReShadePreset.ini already correct.' });
    }
  } else {
    const preset = `Techniques=${provTechnique},${feedTechnique}\r\n` +
      `TechniqueSorting=${provTechnique},${feedTechnique},DLSS5_Feed_Debug@DLSS5_Feed.fx\r\n\r\n` +
      `[DLSS5_Feed.fx]\r\nDEBUG_VIEW=0\r\nMV_SCALE=1.000000\r\nMV_SIGN=1.000000,1.000000\r\n` +
      `PreprocessorDefinitions=DLSS5_MV_PROVIDER=${mvProvider}\r\n`;
    await fsp.writeFile(presetPath, preset, 'utf8');
    onProgress({ kind: 'info', line: `ReShadePreset.ini written: ${provTechnique.split('@')[0]} then DLSS5_Feed.` });
  }

  return { ok: true, dir: gameDir, feederVersion: feederAsset.tag };
}

module.exports = { installFeederNative, providerFx };
