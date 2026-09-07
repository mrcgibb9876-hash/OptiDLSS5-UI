// Native (no PowerShell) installer for the common case: a 64-bit game on Direct3D 11, Direct3D 12
// or OpenGL, with Deep Fried Chicken as the neural consumer. Ported from the D3D/OpenGL branch of
// Install-DLSS5Feeder.ps1 -- see the plan doc for the line-by-line mapping. Vulkan, 32-bit games and
// dgVoodoo2 (Direct3D 8/9) are not covered here; main.js routes those to the existing manual
// fallback instead of calling this.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { FEEDER_RELEASES_API, FEEDER_ASSET_PATTERN, LUMENITE_ZIP_URL } = require('./sources');
const { downloadToCache, resolveGithubAsset } = require('./download');
const { openZip, findEntry, findEntries, extractEntryTo } = require('./zip');
const { setIniKey, getIniKey } = require('./ini-merge');

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

  // Note: ReShade support has been removed. The installer still places feeder add-on and
  // motion-vector provider shaders into a shader directory for Lumenite/DLSS5_Feed usage.

  // 1. The feeder add-on + shader, from the latest DLSS5-Feeder GitHub release.
  const feederAsset = await resolveGithubAsset(FEEDER_RELEASES_API, FEEDER_ASSET_PATTERN);
  const feederZipPath = await downloadToCache(feederAsset.url, cacheDir, feederAsset.name);
  const feederZip = openZip(feederZipPath);

  const addonEntry = findEntry(feederZip, /(^|\/)dlss5-feed\.addon64$/i);
  if (!addonEntry) throw new Error('dlss5-feed.addon64 not found in the Feeder release');
  extractEntryTo(feederZip, addonEntry, path.join(gameDir, 'dlss5-feed.addon64'));

  const fxEntry = findEntry(feederZip, /(^|\/)DLSS5_Feed\.fx$/i);
  if (!fxEntry) throw new Error('DLSS5_Feed.fx not found in the Feeder release');
  await fsp.mkdir(shaderDir, { recursive: true });
  extractEntryTo(feederZip, fxEntry, path.join(shaderDir, 'DLSS5_Feed.fx'));
  onProgress({ kind: 'info', line: `dlss5-feed.addon64 and DLSS5_Feed.fx installed (${feederAsset.tag}).` });

  // 2. Motion vectors: LumeniteFX.
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

  // 3. Neural consumer: Deep Fried Chicken, and the exclusivity rules from the script.
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

  // nvngx_dlssnr.dll: deduped by hash so a re-run doesn't needlessly rewrite an identical file --
  // DLSS Neural Rendering is rarely something a game already ships, so introducing or updating it
  // here is exactly the point.
  if (nrDllPath && fs.existsSync(nrDllPath)) {
    const dest = path.join(gameDir, 'nvngx_dlssnr.dll');
    if (!fs.existsSync(dest) || (await sha256(dest)) !== (await sha256(nrDllPath))) {
      await fsp.copyFile(nrDllPath, dest);
      onProgress({ kind: 'info', line: 'nvngx_dlssnr.dll installed.' });
    }
  }
  if (dlssDllPath && fs.existsSync(dlssDllPath)) {
    const dest = path.join(gameDir, 'nvngx_dlss.dll');
    if (fs.existsSync(dest)) {
      onProgress({ kind: 'info', line: 'nvngx_dlss.dll already present in this game -- left as-is, not overwritten.' });
    } else {
      await fsp.copyFile(dlssDllPath, dest);
      onProgress({ kind: 'info', line: 'nvngx_dlss.dll installed.' });
    }
  }

  // The script's d3dcompiler_47.dll trap (renaming a Windows 8.1-era copy that can't compile the
  // neural pass) needs a FileVersion resource read, which has no dependency-free path in Node --
  // deliberately not ported in Phase A rather than faked. Tracked as a known gap, not silently
  // dropped: it only matters for a small number of older game bundles, and worst case a bad DLL
  // there just means the game falls back to System32's copy failing to compile until removed by
  // hand, not a crash or a security issue.

  return { ok: true, dir: gameDir, feederVersion: feederAsset.tag };
}

module.exports = { installFeederNative, providerFx };