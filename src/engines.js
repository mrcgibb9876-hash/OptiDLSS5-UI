// The OptiScaler engine builds this app can install. There used to be exactly one: this
// project's own OptiScaler_DLSSNR fork (the DLSS 5 developer-controls panel on Alt+Home). A user
// asked for wilsjo2's OptiScaler-DLSSNR-PreSR-Multipass fork as an option.
//
// Both builds can run Neural Rendering BEFORE DLSS upscaling ([DlssNr] RunBeforeSR, where the
// model works on the DLSS input, e.g. 1920x1080 in 4K Performance, instead of the full output
// frame) and both run 1-3 passes ([DlssNr] Passes): our fork ported the first version of that
// work on 2026-09-08. What the Pre-SR fork has on top, as of its v0.7.7: padded colour inputs
// (2558x1439 inside a 2560x1440 texture, max-size allocations under dynamic resolution) stay on
// the pre-SR path, where ours falls back to after-SR and so loses the speed-up; an experimental
// carry of the pre-SR edit across Ray Reconstruction; finished-picture NR. It has no Alt+Home panel.
//
// Both zips share the layout game:install already understands (setup_windows.bat, OptiScaler.dll,
// OptiScaler.ini with a [DlssNr] section, nvngx.dll_dlssnr.dll), so the install path is the same;
// what differs is where the release comes from and which managed folder it lives in.
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
    // Ships inside this app's installer (release.yml bundles it); the other engine is fetched.
    bundled: true,
    panel: true,
    preSr: false,
  },
  presr: {
    id: 'presr',
    label: 'OptiScaler-DLSSNR-PreSR-Multipass',
    repo: 'wilsjo2/OptiScaler-DLSSNR-PreSR-Multipass',
    folderName: 'OptiScalerRelease-presr',
    bundled: false,
    // No Alt+Home developer panel in this build: NR is toggled from OptiScaler's own Insert menu.
    panel: false,
    preSr: true,
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
// count: runBeforeSR/passes the user set in Edit Game, or the Pre-SR build's install default
// (RunBeforeSR on, since that fork ships it off and choosing it is choosing the speed-up).
// A marker naming our own build with no explicit values asks for nothing -- its Alt+Home panel
// owns both keys, and an earlier version of this reset them to auto on every sync.
function iniEditsFor(marker) {
  if (!marker) return [];
  const edits = [];
  if (typeof marker.runBeforeSR === 'boolean') edits.push({ section: 'DlssNr', key: 'RunBeforeSR', value: marker.runBeforeSR ? 'true' : 'false' });
  if (Number.isInteger(marker.passes)) edits.push({ section: 'DlssNr', key: 'Passes', value: String(clampPasses(marker.passes)) });
  return edits;
}

// What Install records for a build: the Pre-SR fork gets RunBeforeSR on unless the user already
// chose; ours keeps whatever the user chose (nothing, by default). pendingApply makes the next
// autoConfigureGame write the values once -- Install copies the release ini over the game's, so
// they have to go back in -- and then the in-game menu owns them again.
function markerForInstall(prev, id) {
  const engineId = normalizeEngine(id);
  const next = { ...(prev || {}), engine: engineId, pendingApply: true };
  if (engine(engineId).preSr && typeof next.runBeforeSR !== 'boolean') next.runBeforeSR = true;
  return next;
}

module.exports = {
  DEFAULT_ENGINE, ENGINES, ENGINE_MARKER,
  normalizeEngine, engine, releasesApi, releasePageUrl, pickAssets, parseSha256Text,
  readEngineMarker, writeEngineMarker, clampPasses, iniEditsFor, markerForInstall,
};
