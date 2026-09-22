// The OptiScaler engine build this app installs: this project's own OptiScaler_DLSSNR fork (the
// DLSS 5 developer-controls panel on Alt+Home). It runs Neural Rendering before or after DLSS
// upscaling ([DlssNr] RunBeforeSR) for 1-3 passes ([DlssNr] Passes), both editable in Edit Game.
//
// wilsjo2's OptiScaler-DLSSNR-PreSR-Multipass is offered as a second build. It was here in
// v1.54.0-1.63.x, dropped in v1.64.0 to keep the app simple, and asked for again on 2026-09-19. The
// machinery never went away -- only this table's entry and the renderer's selector did -- so the
// release fetch, the per-build managed folder and the per-game marker all still work by engine id.
//
// The difference that matters to a user: this build has no Alt+Home developer panel. Its DLSS 5
// settings are reachable from the break-away panel instead (Alt+Shift+Home, panelwindow.js), which
// edits OptiScaler.ini and so needs nothing drawn inside the game. `panel: false` is what tells the
// rest of the app to say that rather than promising a key that does nothing (route-explain.js).
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
  presr: {
    id: 'presr',
    label: 'OptiScaler-DLSSNR-PreSR-Multipass',
    repo: 'wilsjo2/OptiScaler-DLSSNR-PreSR-Multipass',
    // Its own folder, so switching a game between builds never mixes two releases' files.
    folderName: 'OptiScalerRelease-presr',
    bundled: false,
    panel: false,
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

function releaseByTagApi(id, tag) {
  return `https://api.github.com/repos/${engine(id).repo}/releases/tags/${encodeURIComponent(tag)}`;
}

// The engine release this app version was built and tested with: package.json's engineVersion,
// the same pin release.yml bundles. null in a checkout without one (then "latest" is used).
function pinnedEngineTag(pkg = null) {
  try {
    const p = pkg || require('../package.json');
    const tag = p && typeof p.engineVersion === 'string' ? p.engineVersion.trim() : '';
    return /^v?\d+(\.\d+)*/.test(tag) ? tag : null;
  } catch {
    return null;
  }
}

// v1.0.41 vs v1.0.40 -> 1; anything after the numbers ("-final") is ignored.
function compareEngineTags(a, b) {
  const nums = (t) => (String(t || '').replace(/^v/i, '').match(/^\d+(\.\d+)*/) || ['0'])[0].split('.').map(Number);
  const x = nums(a); const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// What the updater offers: the pinned release when there is a pin (a newer "latest" is only
// reported, as untested with this app version), otherwise the latest release.
function chooseEngineOffer({ pin, pinned, latest }) {
  if (!pin) return { offer: latest || null, newerUntested: null };
  const newer = latest && latest.tag_name && compareEngineTags(latest.tag_name, pin) > 0 ? latest.tag_name : null;
  return { offer: pinned || null, newerUntested: newer };
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
// count. A marker with no explicit values asks for nothing -- the Insert panel owns both keys,
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
  normalizeEngine, engine, releasesApi, releaseByTagApi, releasePageUrl, pickAssets, parseSha256Text,
  pinnedEngineTag, compareEngineTags, chooseEngineOffer,
  readEngineMarker, writeEngineMarker, clampPasses, iniEditsFor, markerForInstall,
};
