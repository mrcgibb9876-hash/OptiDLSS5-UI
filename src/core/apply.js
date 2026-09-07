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

module.exports = { safePath, beginManifest, copyTracked, writeTracked, saveActiveManifest };
