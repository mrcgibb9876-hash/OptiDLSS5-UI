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

// RenoFX and Lilium's HDR shaders, for the ReShade add-on catalogue (addons.js). Pinned the same
// way LumeniteFX is -- a commit, not a branch head, and every file hashed -- because these are
// shader sources fetched one at a time from raw.githubusercontent.com. A zip of the whole repo
// would be one pin instead of forty-nine, and that is what VORT does, but codeload.github.com is
// not reachable from the sandbox these hashes were computed in; per-file raw fetches are, and are
// already how the ReShade headers and LumeniteFX arrive.
const RENOFX_COMMIT = '942a2c83da6f291fbb5a98cb4bde1b320f06ae83'; // clshortfuse/renofx
const LILIUM_HDR_COMMIT = 'b1ada21b27666aa0703c6f9b9d83c389e92063a1'; // EndlesslyFlowering/ReShade_HDR_shaders

const RENOFX_SHA256 = {
  'Shaders/RenoFXHAnS.fx': 'df90733217c2e7f495058215009cac97f0ed4087f3b95770a38963bea87418e3',
  'Shaders/RenoFXHDRToolkit.fx': '2247d4bb50cabf8735909b1dcf89d8d8274342416cc949db28a2414b2c6fd96c',
};

const LILIUM_HDR_SHA256 = {
  'Shaders/lilium__blue_noise_dithering.fx': 'fa5153779332c62af3615015519ee4c2cfccd9df487923fb7e4ccbca538ea00a',
  'Shaders/lilium__cas_hdr.fx': '6615017194179df0b6ab9c260f0ac9561875be804d6ba5da517b8e8b610b7b81',
  'Shaders/lilium__filmgrain.fx': '2e1445c9f34824f295be51ddac9b9a3987914bcf1879bd0c718db88b651ae9f7',
  'Shaders/lilium__hdr_and_sdr_analysis.fx': '2aa911d0c6e5547b46466be3ced17a3de7bc51b1f5eb532e0e8bf0f316c0175e',
  'Shaders/lilium__hdr_black_floor_fix.fx': 'ec4bd17256714577f41e14587a751b9ec950733343b2f5c7d88f556a6039b625',
  'Shaders/lilium__hdr_brightness_adjustment.fx': '9a97398b91f156de6149e5a49e2203685e8ef6c3779c780def63ae3e9c6a62cc',
  'Shaders/lilium__include/cas.fxh': 'ee7d347f971b85abeb6eb00e169dd66326a412d91a3f77dab9e9dccf64be0df6',
  'Shaders/lilium__include/cas_helpers.fxh': '7f2f5d3eb0979a9e653d709578d7d8ff891e5f8d132df5bb89d5419662c32046',
  'Shaders/lilium__include/colour_space/cie_xyz_xy_uv.fxh': 'e93b517ed6e901ffddcceeb1b51ba9a1911fc027e762f4b4944a3fa3c5e4caf7',
  'Shaders/lilium__include/colour_space/colour_object.fxh': 'cb54f3624acd5018810b58a7d93f1b37eeb4b204c65eaaa1800f5f9fc6b29be4',
  'Shaders/lilium__include/colour_space/darktable_ucs.fxh': 'f6b749cda7666442edb47224c7f540810e05314332fdf192984c8325899bf020',
  'Shaders/lilium__include/colour_space/hdr10_to_linear_lut.fxh': 'ef459a7481a47f91e72c2a47425fbd21bfc92701cf1e27e2a17a659962e91d93',
  'Shaders/lilium__include/colour_space/hdr_trcs.fxh': '8674759b781874e5c501a0b1529a70127aab9b893044167ab1bce28f1ac34578',
  'Shaders/lilium__include/colour_space/helpers.fxh': '64e642d959696f3c12590f0c95ce1989a51a1dde1641c975c7674063e41c4448',
  'Shaders/lilium__include/colour_space/ictcp.fxh': '3e09cbbf890fc5c3149218b7d42393db2dd48774d586625773139d151659d99d',
  'Shaders/lilium__include/colour_space/ipt.fxh': '190b31f66fb78c58e7f5313d9785d44ea923d5a4f0d5b1433ab9f448d5728a67',
  'Shaders/lilium__include/colour_space/jzazbz.fxh': '662392bba466baf821bfeef33cbe9df169715e4ffa5ab279875c12e74d6ea5cd',
  'Shaders/lilium__include/colour_space/matrices.fxh': 'ff9ec7aa7757cafdc3e530c500ffdfcf980ccb87da5b30fa8ce430ff40c459ce',
  'Shaders/lilium__include/colour_space/oklab.fxh': '19c3ab49653248f1b9634a5d38251503d0cf86d756f8400b9818049229349468',
  'Shaders/lilium__include/colour_space/sdr_trcs.fxh': '23a7b7a91219739e16c56cddc34a2a82a651cfa946542c68ed17709e3c539051',
  'Shaders/lilium__include/colour_space/ycbcr.fxh': 'e3c79a9fd708bc9f80bc2459d80814525b6d466f02394173a5a0dfc1c7d19a98',
  'Shaders/lilium__include/draw_font.fxh': '7aa83e9e2ed9fbb2c31353c85fa94e8e8bf6e7ad838e923789c792c3ece4fa88',
  'Shaders/lilium__include/draw_text_fix.fxh': 'f1fb1664b846014a7573d34e30cb8ce790e737b8fd10ad16f828a04ce64b7295',
  'Shaders/lilium__include/hdr_and_sdr_analysis/active_area.fxh': 'bb4ea5946892787a76e7af96abc15775cca1c08f8c23d505998001ab6694838c',
  'Shaders/lilium__include/hdr_and_sdr_analysis/cie.fxh': '878e8ea23769d27d3bebfe5778fc4c1928d1b6466c0a23dff4dbf624e0aad3f6',
  'Shaders/lilium__include/hdr_and_sdr_analysis/cie_datasets.fxh': '6e49f3d8bb3177b5ae0c980887c1ed83098933100c85eb4e15477d7757db4998',
  'Shaders/lilium__include/hdr_and_sdr_analysis/draw_text.fxh': '6c6aecdc1472fb885b3ae314d7616d9621b2362d12dbb07569aa4949105c249f',
  'Shaders/lilium__include/hdr_and_sdr_analysis/gamut.fxh': '7a9edc59bd4a299760d447bc76d1321ba159262c7155c51bf29151c892b41434',
  'Shaders/lilium__include/hdr_and_sdr_analysis/luminance.fxh': '0de70b1fa04016f1918af54ec49e3591642ded9ac873b79ee8970e84719562a0',
  'Shaders/lilium__include/hdr_and_sdr_analysis/main.fxh': '1903eeb552eb28bf36ffc9b537be0b14510a6cc1f2b60a336e7b33acb0e2da50',
  'Shaders/lilium__include/hdr_and_sdr_analysis/waveform.fxh': '85b6486b04ca3fbcf47b6ab582a8a5399036b0131c22afdda1486d0b7d8ed5dc',
  'Shaders/lilium__include/hdr_black_floor_fix.fxh': '5d49d02ba80b971395c0e669d9cdf8d5ca03f14d4a336ee114dbcaa55e39210f',
  'Shaders/lilium__include/include_main.fxh': '5b3543ee59c82d0e8bd477f4f8d4dff2e469bd6828c917cf8ff224071fabc11f',
  'Shaders/lilium__include/inverse_tone_mappers.fxh': '2d18f85a5a8c2164b804d70e708544c51becd36a5e2b9ddeff282311c5afe818',
  'Shaders/lilium__include/math.fxh': 'f4e24157f6cfa37ec37ec533b540649f43ee190910c04891a800acf2a1e75880',
  'Shaders/lilium__include/rcas.fxh': '5be72fb3f3fbb178ba21c2eb949a371aa318b74e6c91260c973cd441caa478af',
  'Shaders/lilium__include/reshade_setup.fxh': '4d7db86fb16c9f9ed339f4084b0935591ad471b6a34b231a46e505cc91ef8352',
  'Shaders/lilium__include/tone_mappers.fxh': 'c65d0dbc5fe0f895becbc0b3ce899760b8345f4a28d9d4153532a9f7f24c79f7',
  'Shaders/lilium__inverse_tone_mapping.fx': '38e1dea334ef9347e1e62350f86b025d7c1014f857fb7a60f739474ff2c8dfda',
  'Shaders/lilium__map_sdr_into_hdr.fx': 'b93dcf838310906b8c426e13aff6e506e33b8ecc73213fc5c67472ecbd938f28',
  'Shaders/lilium__rcas_hdr.fx': '45227c02b539dc5d21206c2815ae756f8cb979bae41a518604fba1073dff6022',
  'Shaders/lilium__sdr_trc_fix.fx': '078ed56f9555472f0756ab05cf3cac7e476cdd9a5b1891024f540130c8ed9637',
  'Shaders/lilium__test_pattern_generator.fx': '1674e36b3b0a8431307f3569356baef32c72032d0ad68d93094af1e3454acb35',
  'Shaders/lilium__tone_mapping.fx': '0bf538bbc5b250073be0ddaa3a7f17500ee6d8bedb9c8b37d4e67bbe5cbf5a0b',
  'Textures/lilium__blue_noise_64x64.png': '53281972ecf792473ec5ca390e96353facf10a8e8677b64e8316a3178a9290cb',
  'Textures/lilium__font_atlas.png': '11a711a8167d1c1606892e6fa6f661a477e749d6cbdb1ff700ac381842066ec3',
  'Textures/lilium__font_atlas_mtsdf.png': 'fcfc9e30cd66af73f5e9d51f2bd881bab805e38196aaf4de874b63132ec8f738',
};

const URLS = {
  reshadeSetup: 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe',
  vortZip: `https://codeload.github.com/vortigern11/vort_Shaders/zip/${VORT_COMMIT}`,
  reshadeShadersRaw: `https://raw.githubusercontent.com/crosire/reshade-shaders/${RESHADE_SHADERS_COMMIT}/Shaders/`,
  reshadeShadersMirror: `https://cdn.jsdelivr.net/gh/crosire/reshade-shaders@${RESHADE_SHADERS_COMMIT}/Shaders/`,
  lumeniteRaw: `https://raw.githubusercontent.com/umar-afzaal/LumeniteFX/${LUMENITEFX_COMMIT}/Shaders/`,
  renofxRaw: `https://raw.githubusercontent.com/clshortfuse/renofx/${RENOFX_COMMIT}/`,
  liliumHdrRaw: `https://raw.githubusercontent.com/EndlesslyFlowering/ReShade_HDR_shaders/${LILIUM_HDR_COMMIT}/`,
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
for (const [rel, sha] of Object.entries(RENOFX_SHA256)) PINS[URLS.renofxRaw + rel] = sha;
for (const [rel, sha] of Object.entries(LILIUM_HDR_SHA256)) PINS[URLS.liliumHdrRaw + rel] = sha;

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
  RESHADE_SHADERS_COMMIT, LUMENITEFX_COMMIT, VORT_COMMIT, RENOFX_COMMIT, LILIUM_HDR_COMMIT,
  RENOFX_SHA256, LILIUM_HDR_SHA256,
  sha256, pinFor, digestFromAsset, parseReleaseUrl, releaseAssetDigest, expectedSha256,
  verifyBuffer, checkFinalUrl, mismatchError,
  _resetDigestCache: () => digestCache.clear(),
};
