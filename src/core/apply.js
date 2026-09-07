'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Minimal file-journal helpers used by optiscaler.copyPlan
function safePath(root, rel) {
  if (!rel) return path.join(root);
  if (path.isAbsolute(rel)) return rel;
  return path.join(root, rel);
}

async function beginManifest(gameDir, exePath, api) {
  return { gameDir, exePath, api, added: [], replaced: [] };
}

async function copyTracked(manifest, gameDir, src, dest, opts = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  const rel = path.relative(gameDir, dest).replace(/\\/g, '/');
  manifest.added.push(rel);
  return rel;
}

async function writeTracked(manifest, gameDir, dest, text, opts = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, text, 'utf8');
  const rel = path.relative(gameDir, dest).replace(/\\/g, '/');
  manifest.added.push(rel);
  return rel;
}

async function saveActiveManifest(gameDir, manifest) {
  const file = path.join(gameDir, '.optdlss5-active-manifest.json');
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

async function backupAndDisableConflicts(exeDir, targetHook) {
  if (!exeDir || !fs.existsSync(exeDir)) return [];
  const candidates = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll', 'd3d12.dll', 'd3d11.dll', 'wininet.dll', 'winhttp.dll'];
  const disabled = [];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);

  for (const name of candidates) {
    if (targetHook && name.toLowerCase() === targetHook.toLowerCase()) continue;
    const file = path.join(exeDir, name);
    if (fs.existsSync(file)) {
      const bak = `${file}.bak-${stamp}`;
      const dis = `${file}.disabled-by-installer`;
      try {
        await fsp.copyFile(file, bak);
        await fsp.rename(file, dis);
        disabled.push({ name, backup: bak, disabledPath: dis });
      } catch {
      }
    }
  }
  return disabled;
}

module.exports = { safePath, beginManifest, copyTracked, writeTracked, saveActiveManifest, backupAndDisableConflicts };
