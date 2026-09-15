// The OptiScaler engine build this app installs: this project's own OptiScaler_DLSSNR fork (the
// DLSS 5 developer-controls panel on Alt+Home). It runs Neural Rendering before or after DLSS
// upscaling ([DlssNr] RunBeforeSR) for 1-3 passes ([DlssNr] Passes), both editable in Edit Game.
//
// v1.54.0-1.63.x also offered wilsjo2's OptiScaler-DLSSNR-PreSR-Multipass as a second build. It was
// dropped in v1.64.0 to keep the app simple: a marker or setting that still names it ('presr')
// normalises to this build, so the next sync moves those games back onto ours.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ENGINE = 'dlssnr';

const ENGINES = {
  dlssnr: {
    id: 'dlssnr',
    label: 'OptiScaler_DLSSNR',
    repo: 'mrcgibb9876-hash/OptiScaler_DLSSNR',
    folderName: 'OptiScalerRelease',
    // Ships inside this app's installer (release.yml bundles it), then kept current from GitHub.
    bundled: true,
    panel: true,
  },
};

const ENGINE_MARKER = '.dlss5ui-engine.json';

function normalizeEngine(id) {
  return Object.prototype.hasOwnProperty.call(ENGINES, id) ? id : DEFAULT_ENGINE;
}

function engine(id) {
  return ENGINES[normalizeEngine(id)];
}

function releasesApi(id) {
  return `https://api.github.com/repos/${engine(id).repo}/releases/latest`;
}

function releasePageUrl(id) {
  return `https://github.com/${engine(id).repo}/releases/latest`;
}

// The zip to install and, when the release carries one, the .sha256 file to check it against.
// A `.zip.sha256` asset must not be mistaken for the zip itself.
function pickAssets(release) {
  const assets = (release && release.assets) || [];
  const zip = assets.find((a) => /\.zip$/i.test(a.name || ''));
  const sha = zip ? assets.find((a) => (a.name || '').toLowerCase() === `${zip.name.toLowerCase()}.sha256`) : null;
  return { zip: zip || null, sha256: sha || null };
}

// "<hex> *file" or "<hex>  file" or a bare hex string.
function parseSha256Text(text) {
  const m = /\b([0-9a-f]{64})\b/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

function readEngineMarker(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, ENGINE_MARKER), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeEngineMarker(dir, marker) {
  fs.writeFileSync(path.join(dir, ENGINE_MARKER), JSON.stringify(marker, null, 2), 'utf-8');
}

function clampPasses(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 1;
}

// The [DlssNr] values a marker asks for, or [] when it asks for nothing. Only explicit choices
// count. A marker with no explicit values asks for nothing -- the Alt+Home panel owns both keys,
// and an earlier version of this reset them to auto on every sync.
function iniEditsFor(marker) {
  if (!marker) return [];
  const edits = [];
  if (typeof marker.runBeforeSR === 'boolean') edits.push({ section: 'DlssNr', key: 'RunBeforeSR', value: marker.runBeforeSR ? 'true' : 'false' });
  if (Number.isInteger(marker.passes)) edits.push({ section: 'DlssNr', key: 'Passes', value: String(clampPasses(marker.passes)) });
  return edits;
}

// What Install records: the build, plus whatever the user already chose. pendingApply makes the
// next autoConfigureGame write the values once -- Install copies the release ini over the game's,
// so they have to go back in -- and then the in-game menu owns them again.
function markerForInstall(prev, id) {
  return { ...(prev || {}), engine: normalizeEngine(id), pendingApply: true };
}

module.exports = {
  DEFAULT_ENGINE, ENGINES, ENGINE_MARKER,
  normalizeEngine, engine, releasesApi, releasePageUrl, pickAssets, parseSha256Text,
  readEngineMarker, writeEngineMarker, clampPasses, iniEditsFor, markerForInstall,
};
