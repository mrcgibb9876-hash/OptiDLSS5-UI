// Every file this app downloads and places in a game folder is checked against a sha256 before it
// is used. Two kinds of check:
//
//   - PINS: fixed URLs (a pinned commit, a versioned installer, a tagged release). The hash is known
//     ahead of time and lives here, in one place. A mismatch is refused.
//   - GitHub release assets resolved at run time ("latest" Feeder, Luma, the engine, RHI's DLSS
//     packages...). GitHub publishes a sha256 `digest` for each asset; the caller passes it along
//     from the release JSON it already fetched, or releaseAssetDigest() looks it up. When GitHub
//     has no digest (old uploads, or the API is unreachable) the file is used unverified -- there
//     is nothing to compare against, and refusing would block installs over a missing field.
//
// A mismatch almost always means a damaged download or antivirus (Windows Defender) rewriting the
// file, so the error says that. Hashes computed 2026-09-19 by fetching each exact URL once.
'use strict';
const crypto = require('node:crypto');
const { netFetch } = require('./net');

// Commits the text downloads are pinned to. A branch head moves; a commit does not, so the pin
// below stays valid. Bumping one means re-hashing its files here.
const RESHADE_SHADERS_COMMIT = '6db142b4b1a05c764222e5b0bd9a644b7ccfe1dc'; // crosire/reshade-shaders, 2026-04-12
const LUMENITEFX_COMMIT = 'f8cbbb4eccfcb7adf0d74bb358ba349272e3c1e9'; // umar-afzaal/LumeniteFX, 2026-09-06
const VORT_COMMIT = 'b410b9f0c0fbb83c8cb42164aaf1655fab386f4a'; // vortigern11/vort_Shaders

const RESHADE_HEADER_SHA256 = {
  'ReShade.fxh': '6dabfbbaf968c3871905d2ea17f96572ff7b1cec01310b5d0e5252b66b30174f',
  'ReShadeUI.fxh': '78adf672df47460297eb9fe6dd238d2aafa24510b52b84feb1a745dff70eb901',
};

const LUMENITEFX_SHA256 = {
  'lumenite_Kernel.fx': 'dc44d101c568a8492606884037c86059a31b844fd5e144e733fb70dabc91f25c',
  'include/lumenite_Projections.fxh': '709ec414649b74e573ca0f12a5ef25998d332238f7cab14a3d91053c8d388cab',
  'include/lumenite_Helpers.fxh': '8826d613944be27e14095982b20098fff6d45e91c7d4028473c2f5b784c80028',
  'include/lumenite_Compute.fxh': '736e3f39fc0c48a405c4d10b0d158502009db940e2673ff778e6b919d3c1a55f',
};

const URLS = {
  reshadeSetup: 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe',
  vortZip: `https://codeload.github.com/vortigern11/vort_Shaders/zip/${VORT_COMMIT}`,
  reshadeShadersRaw: `https://raw.githubusercontent.com/crosire/reshade-shaders/${RESHADE_SHADERS_COMMIT}/Shaders/`,
  reshadeShadersMirror: `https://cdn.jsdelivr.net/gh/crosire/reshade-shaders@${RESHADE_SHADERS_COMMIT}/Shaders/`,
  lumeniteRaw: `https://raw.githubusercontent.com/umar-afzaal/LumeniteFX/${LUMENITEFX_COMMIT}/Shaders/`,
  dgVoodoo: 'https://github.com/dege-diosg/dgVoodoo2/releases/download/v2.87.4/dgVoodoo2_87_4.zip',
  dxvk: 'https://github.com/doitsujin/dxvk/releases/download/v3.1.1/dxvk-3.1.1.tar.gz',
};

// url -> sha256 (lowercase hex).
const PINS = {
  [URLS.reshadeSetup]: 'afe4c8f13048306307983b8b3d41d5bf00a86820440b0e57dea10950e1176445',
  [URLS.vortZip]: '231ba34a75556f9943e359559a89b0d0cc2caa322d9dcdee5630061bf9fe13b6',
  [URLS.dgVoodoo]: '74aeb464d829db80e3f4aa8fae235e6e3b38fc01188776c5c2376bb0dea0956e',
  [URLS.dxvk]: '40565b4a724aadc4433fa4e010b4b23916d9b1f1baeee64e17186db94f54e608',
};
for (const [name, sha] of Object.entries(RESHADE_HEADER_SHA256)) {
  PINS[URLS.reshadeShadersRaw + name] = sha;
  PINS[URLS.reshadeShadersMirror + name] = sha;
}
for (const [rel, sha] of Object.entries(LUMENITEFX_SHA256)) PINS[URLS.lumeniteRaw + rel] = sha;

// Downloads that cannot be pinned, and why. Listed so "is everything pinned?" has an answer.
const UNPINNED = {
  'https://github.com/JakobPCoder/ReshadeMotionEstimation/archive/refs/heads/master.zip':
    'DRME: a branch head, and not selectable any more (it cannot compile on ReShade 6.8); kept only so old deploys are recognised',
  'https://github.com/praydog/REFramework-nightly/releases/latest/download/REFramework.zip':
    'REFramework nightly "latest": checked against the release asset digest instead',
};

// Hosts a GitHub download may legitimately end up on after its redirects.
const GITHUB_HOSTS = new Set([
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  'raw.githubusercontent.com', 'api.github.com',
]);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pinFor(url) {
  return PINS[url] || null;
}

// GitHub's asset field is "sha256:<hex>".
function digestFromAsset(asset) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String((asset && asset.digest) || ''));
  return m ? m[1].toLowerCase() : null;
}

// https://github.com/<owner>/<repo>/releases/download/<tag>/<name>
function parseReleaseUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/.exec(String(url || ''));
  return m ? { owner: m[1], repo: m[2], tag: decodeURIComponent(m[3]), name: decodeURIComponent(m[4]) } : null;
}

// The published digest of a GitHub release asset, or null (not a release URL, no digest, offline).
// One API call per distinct release per app run; only made when something is actually downloaded.
const digestCache = new Map();
async function releaseAssetDigest(url, { fetchImpl = netFetch, headers = {} } = {}) {
  const parsed = parseReleaseUrl(url);
  if (!parsed) return null;
  const key = `${parsed.owner}/${parsed.repo}@${parsed.tag}`;
  if (!digestCache.has(key)) {
    digestCache.set(key, (async () => {
      try {
        const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/tags/${encodeURIComponent(parsed.tag)}`;
        const res = await fetchImpl(api, { headers });
        if (!res.ok) return null;
        return (await res.json()).assets || [];
      } catch {
        return null;
      }
    })());
  }
  const assets = await digestCache.get(key);
  if (!assets) { digestCache.delete(key); return null; }
  return digestFromAsset(assets.find((a) => a && a.name === parsed.name));
}

// What a download should hash to: the pin, else the digest the caller has, else GitHub's.
async function expectedSha256(url, { sha256: given = null, fetchImpl, headers } = {}) {
  return pinFor(url) || (given ? String(given).toLowerCase() : null) || await releaseAssetDigest(url, { fetchImpl, headers });
}

function mismatchError(label, expected, got) {
  return Object.assign(new Error(
    `${label} did not match its published checksum (expected ${expected.slice(0, 12)}…, got ${got.slice(0, 12)}…). ` +
    'The download was damaged, or something on this PC -- usually antivirus such as Windows Defender -- changed it. ' +
    'Try again; if it keeps happening, check Windows Security > Protection history.'), { code: 'checksum-mismatch', expected, got });
}

// Throws on a mismatch; returns true when checked, false when there was nothing to check against.
function verifyBuffer(buf, expected, label) {
  if (!expected) return false;
  const got = sha256(buf);
  if (got !== expected) throw mismatchError(label, expected, got);
  return true;
}

// After redirects: still https, and a GitHub download still on a GitHub host. fetch follows
// redirects without saying where it went, so this reads res.url. A hash covers integrity; this
// catches a redirect to somewhere unexpected before a large unpinned file is used.
function checkFinalUrl(requestedUrl, res) {
  const finalUrl = res && res.url;
  if (!finalUrl || finalUrl === requestedUrl) return;
  let from, to;
  try { from = new URL(requestedUrl); to = new URL(finalUrl); } catch { return; }
  if (to.protocol !== 'https:') throw Object.assign(new Error(`${requestedUrl} redirected to a non-https address`), { code: 'redirect-refused' });
  if (GITHUB_HOSTS.has(from.hostname) && !GITHUB_HOSTS.has(to.hostname)) {
    throw Object.assign(new Error(`${requestedUrl} redirected off GitHub (to ${to.hostname})`), { code: 'redirect-refused' });
  }
}

module.exports = {
  PINS, UNPINNED, URLS, GITHUB_HOSTS,
  RESHADE_SHADERS_COMMIT, LUMENITEFX_COMMIT, VORT_COMMIT,
  sha256, pinFor, digestFromAsset, parseReleaseUrl, releaseAssetDigest, expectedSha256,
  verifyBuffer, checkFinalUrl, mismatchError,
  _resetDigestCache: () => digestCache.clear(),
};
