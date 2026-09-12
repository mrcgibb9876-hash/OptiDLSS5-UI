// The OptiScaler engine builds this app can install. There used to be exactly one: this
// project's own OptiScaler_DLSSNR fork (the DLSS 5 developer-controls panel on Alt+Home). A user
// asked for wilsjo2's OptiScaler-DLSSNR-PreSR-Multipass fork as an option: it can run Neural
// Rendering BEFORE DLSS upscaling (the model then works on the DLSS input, e.g. 1920x1080 in 4K
// Performance, instead of the full output frame -- a large speed-up), and it can run 1-3 passes.
// Both zips share the layout game:install already understands (setup_windows.bat, OptiScaler.dll,
// OptiScaler.ini with a [DlssNr] section, nvngx.dll_dlssnr.dll), so the install path is the same;
// what differs is where the release comes from, which managed folder it lives in, and the two
// [DlssNr] keys (RunBeforeSR, Passes) that make the Pre-SR build worth choosing.
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

// What the marker asks the game's OptiScaler.ini [DlssNr] section to say. The Pre-SR fork
// defaults RunBeforeSR to off (auto = false), so an install that never set it would be the
// fork without its point; on by default here, one pass. Any other engine gets both keys put
// back to auto so a game moved off the Pre-SR build does not keep asking for what the other
// build cannot do (those keys are simply unknown there, but a clean ini is easier to reason
// about in a support bundle).
function iniEditsFor(marker) {
  const id = normalizeEngine(marker && marker.engine);
  if (!engine(id).preSr) {
    return [
      { section: 'DlssNr', key: 'RunBeforeSR', value: 'auto' },
      { section: 'DlssNr', key: 'Passes', value: 'auto' },
    ];
  }
  const runBeforeSR = marker.runBeforeSR === undefined || marker.runBeforeSR === null ? true : !!marker.runBeforeSR;
  return [
    { section: 'DlssNr', key: 'RunBeforeSR', value: runBeforeSR ? 'true' : 'false' },
    { section: 'DlssNr', key: 'Passes', value: String(clampPasses(marker.passes)) },
  ];
}

module.exports = {
  DEFAULT_ENGINE, ENGINES, ENGINE_MARKER,
  normalizeEngine, engine, releasesApi, releasePageUrl, pickAssets, parseSha256Text,
  readEngineMarker, writeEngineMarker, clampPasses, iniEditsFor,
};
