// DLSS5-Feeder integration for games with no native DLSS at all.
//
// OptiScaler's Neural Rendering pass only fires when it catches a real DLSS evaluate call.
// A native-DLSS game makes that call on its own -- see hasNativeDlss()/DLSS5_ONLY_FORCED in
// main.js. A game with no native DLSS never makes that call, so a bare OptiScaler install
// there does nothing. The DLSS5-Feeder (jlrouzies-fr, MIT) is a ReShade add-on that
// synthesises a fake DLSS DLAA evaluate from ReShade's own depth/colour/motion-vector
// capture, purely so a consumer has something to hook. We are that consumer -- via
// OptiScaler_DLSSNR's own fork patch (ConflictingNrAddon no longer refuses dlss5-feed.addon64,
// see that repo's commit f2290a39), not a third-party consumer like Deep Fried Chicken.
//
// Two conflicts this deploy has to route around, both already solved elsewhere in this app:
//   * OptiScaler and ReShade must not independently fight over hooking the swapchain. The
//     first version of this integration tried "OptiScaler via the injector, ReShade as its own
//     proxy (dxgi.dll/d3d11.dll)" -- that broke TWO different ways on a real game (Batman:
//     Arkham Knight, 2026-09-09): the Feeder couldn't find an injected OptiScaler at all
//     ("this game never loaded a DLL of that name"), and even after switching OptiScaler back
//     to proxy-file, ReShade's own Present hook never engaged (its own overlay never opened,
//     zero effects ever compiled) as long as the two were independent proxies. The fix that
//     actually worked: OptiScaler proxy-installs normally (installProxy() in main.js, same as
//     every other game), ReShade deploys as a plain, non-proxying ReShade64.dll beside it, and
//     OptiScaler.ini's [Plugins] LoadReshade=true makes OptiScaler itself explicitly load and
//     coordinate with it -- see forceLoadReshadeForFeederGames() in main.js. Do not reintroduce
//     the injector for this path; it looked reasonable and was empirically wrong.
//   * OptiScaler must not drive its own upscaler/FrameGen alongside the Feeder -- that is
//     exactly the conflict the Feeder's own README warns about ("turn off OptiScaler"). The
//     DLSS5-only profile (hasNativeDlss()/DLSS5_ONLY_FORCED in main.js) already forces that
//     narrow NR-only mode; this path must always end up in that mode, never full config.
//
// Caveats inherent to the Feeder itself, not this integration: motion vectors are *estimated*
// (ghosting in fast motion, softer thin geometry vs. native-DLSS-fed NR), and this needs ReShade
// add-on support in the game, which rides on the same dxgi/ReShade coexistence the injector
// solves. Scope of this pass: 64-bit DX11/DX12 games only. 32-bit games (which need
// dlss5-feed.addon32 + a host64\dlss5-feed-host64.exe helper process) and Vulkan games (which
// need a Vulkan layer, not a ReShade add-on, and a different injection story entirely) are
// deliberately NOT handled here -- the release zip has the files for both, but wiring them up is
// real, untested extra work, not a corner worth cutting silently. Both are reported as
// "not yet supported" by feederReadiness() rather than a dead button or a silent wrong action.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

const { openZip, findEntry, extractEntryTo } = require('./zip');
const { setIniKey, getIniKey } = require('./ini-merge');

const FEEDER_RELEASES_API = 'https://api.github.com/repos/jlrouzies-fr/DLSS5-Feeder/releases/latest';
const FEEDER_ASSET_PATTERN = /^DLSS5-Feeder-.*\.zip$/i;

// The "_Addon" build specifically -- ReShade's plain build refuses third-party add-ons, and
// dlss5-feed.addon64 is exactly that. Verified this is the add-on-enabled build by its name;
// the alternative (opening the installer as an archive and checking which DLL variant is
// inside) was not re-verified this pass since a prior, since-removed integration in this same
// repo already downloaded and confirmed this exact URL's contents (see git history on the
// deleted src/native-feeder/reshade.js, commit 0738a9e removed it, ec3083d added it).
const RESHADE_SETUP_URL = 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe';

// Plain filename, not a proxy name -- see the file header for why ReShade no longer proxies
// anything itself in this integration. OptiScaler.ini's [Plugins] LoadReshade=true is what
// makes OptiScaler actually load this.
const RESHADE_DLL_NAME = 'ReShade64.dll';

// ReShade's own universal shared headers -- #include'd by virtually every effect, including
// DLSS5_Feed.fx itself ("ReShade.fxh") and the motion-vector shader's UI half
// ("ReShadeUI.fxh"). Neither the Feeder's release zip nor any motion-vector-provider repo
// ships these -- every real ReShade shader assumes they're already present from a full
// reshade-shaders install. Missing them fails compilation with a preprocessor error naming
// the include, not a missing-file error -- easy to miss in the log. Found the hard way on a
// real deploy (Batman: Arkham Knight, 2026-09-09): compilation failed on both shaders until
// these were fetched by hand from ReShade's own community shader repo.
const RESHADE_COMMON_HEADERS = ['ReShade.fxh', 'ReShadeUI.fxh'];
const RESHADE_SHADERS_REPO_RAW = 'https://raw.githubusercontent.com/crosire/reshade-shaders/slim/Shaders/';

// LumeniteFX's own official repo, fetched live (never cached/mirrored) -- see the licence
// note on MV_PROVIDERS['lumenite-kernel'] for why that matters, not just why it's convenient.
// lumenite_Kernel.fx's own #include lines name exactly these four files (checked against the
// real source, 2026-09-09: ReShade.fxh -- already covered by RESHADE_COMMON_HEADERS -- plus
// three from its own include/ subfolder; lumenite_ColorManagement.fxh in that same folder is
// NOT included by Kernel.fx and is deliberately left out).
const LUMENITEFX_REPO_RAW = 'https://raw.githubusercontent.com/umar-afzaal/LumeniteFX/mainline/Shaders/';
const LUMENITEFX_KERNEL_FILE = 'lumenite_Kernel.fx';
const LUMENITEFX_KERNEL_INCLUDES = [
  'include/lumenite_Projections.fxh',
  'include/lumenite_Helpers.fxh',
  'include/lumenite_Compute.fxh',
];

// Written into a game's folder after a successful Feeder deploy -- deploy functions only know
// "is the file there", not "is it current"; this is what feederUpdateCheck() compares against
// the Feeder's actual latest release tag.
const FEEDER_DEPLOY_MARKER = '.dlss5ui-feeder-deploy.json';

// Motion-vector provider. DLSS5_Feed.fx reads whichever shader DLSS5_MV_PROVIDER selects (a
// preprocessor definition, five options per the Feeder's own README). Only two are wired up
// here -- see MV_PROVIDERS below for why: the other three (iMMERSE Launchpad, VORT,
// LumeniteFX QuantMotion) are real, valid choices the Feeder's README documents, just not ones
// this pass sourced a verified download URL for. Not a licensing question for those three,
// just unfinished breadth -- add them the same shape as reshade-motion-estimation below once a
// URL is confirmed.
//
// reshade-motion-estimation uses provider value 0 ("anything writing the shared
// texMotionVectors" -- the Feeder's own README calls this "the old convention"), not one of
// the four specifically-numbered/tuned providers (1-4). It is not literally broken -- the
// README's only correctness warning under provider 0 is that a *different* shader called DRME
// fails to compile on ReShade 6.8, not this one -- but it hasn't been confirmed against a real
// deploy either. Flagged here rather than silently presented as equally proven as the
// Feeder's own recommended default (LumeniteFX Kernel, provider 3).
const MV_PROVIDERS = {
  'reshade-motion-estimation': {
    id: 'reshade-motion-estimation',
    displayName: 'ReShade Motion Estimation (JakobPCoder)',
    mvProviderValue: 0,
    license: 'CC BY-NC 4.0',
    autoFetchable: true,
    zipUrl: 'https://github.com/JakobPCoder/ReshadeMotionEstimation/archive/refs/heads/master.zip',
    // The real ReShade technique declared inside MotionEstimation.fx ("technique DRME") --
    // must run before DLSS5_Feed's own technique so its motion vectors exist for DLSS5_Feed to
    // read. configurePreset() below enables this explicitly rather than counting on ReShade's
    // own "auto-enable a newly found technique" behaviour, which is real but not something to
    // depend on for correctness (confirmed inconsistent in practice, 2026-09-09: the ordering
    // came out right once by that path and can't be trusted to every time).
    techniqueFile: 'MotionEstimation.fx',
    techniqueName: 'DRME',
    default: true,
  },
  'lumenite-kernel': {
    id: 'lumenite-kernel',
    displayName: 'LumeniteFX Kernel (recommended by the Feeder)',
    mvProviderValue: 3,
    license: 'AGNYA (all rights reserved) -- umar-afzaal/LumeniteFX',
    // Not auto-fetchable through the generic deployMvProvider() path -- that path has no way
    // to carry real per-action consent, and this licence is real, not a formality (AGNYA
    // ss.1: redistribution must "exclusively use the official links provided by the author";
    // independently hosting a copy is explicitly prohibited). deployLumeniteFx() below is the
    // only way this ever gets fetched: it fetches live from this exact repo every time (never
    // a cached/mirrored copy, satisfying "official links"), and refuses outright unless the
    // caller passes licenseConfirmed:true -- enforced here, not just in the UI, so a UI bug
    // can't silently bypass consent.
    autoFetchable: false,
    officialUrl: 'https://github.com/umar-afzaal/LumeniteFX',
    licenseUrl: 'https://github.com/umar-afzaal/LumeniteFX/blob/mainline/LICENSE.md',
    licenseSummary: 'AGNYA licence (Rev 1.4), Copyright (C) 2025-2026 Afzaal (Kaidō). All rights ' +
      'reserved. Redistribution must exclusively use the author\'s own official links -- ' +
      'independently hosting a copy is explicitly prohibited, which is why this always ' +
      'fetches live from the official repo rather than a cached copy. No warranty of any kind.',
    // The real declared technique name inside lumenite_Kernel.fx ("technique Lumenite_Kernel").
    // Same ordering requirement as reshade-motion-estimation above.
    techniqueFile: 'lumenite_Kernel.fx',
    techniqueName: 'Lumenite_Kernel',
    default: false,
  },
};

function mvProviderList() {
  return Object.values(MV_PROVIDERS);
}

// --- detection ----------------------------------------------------------------------

// The inverse of hasNativeDlss() in main.js (not imported from there to avoid main.js<->this
// module becoming circular -- every other module in this app that needs a main.js-side check
// takes it as a parameter or duplicates the two-line fs check; this does the same). A game
// needing the Feeder has neither a Streamline interposer nor its own nvngx_dlss.dll.
function needsFeeder(dir) {
  return !fs.existsSync(path.join(dir, 'sl.interposer.dll')) &&
    !fs.existsSync(path.join(dir, 'sl.interposer.dll.original')) &&
    !fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));
}

// Stable marker that a Feeder deploy has actually happened here -- unlike needsFeeder(), this
// does NOT flip once the deploy itself places nvngx_dlss.dll (needsFeeder()'s absence check is
// about whether a game needs the Feeder in the first place; this is about whether one has
// already been deployed, which main.js needs to know separately -- e.g. to force
// [Plugins] LoadReshade=true even after nvngx_dlss.dll's presence would otherwise make
// needsFeeder() say "false" here).
function feederDeployed(dir) {
  return fs.existsSync(path.join(dir, 'dlss5-feed.addon64'));
}

// What's deployed, what's missing, and the real reason anything blocking is blocking -- same
// "explain, don't just disable" posture as injectorReadiness() in injector.js.
function feederReadiness(dir, api) {
  if (api === 'vulkan') return { ready: false, supported: false, reason: 'Vulkan needs a layer, not a ReShade add-on -- not yet supported by this app.' };
  if (api !== 'dx11' && api !== 'dx12') {
    return { ready: false, supported: false, reason: `Render API not detected (${api || 'unknown'}) -- not yet supported by this app.` };
  }

  const reshadeInstalled = fs.existsSync(path.join(dir, RESHADE_DLL_NAME));
  const addonInstalled = fs.existsSync(path.join(dir, 'dlss5-feed.addon64'));
  const fxInstalled = fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'));
  const headersInstalled = RESHADE_COMMON_HEADERS.every((f) => fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', f)));
  const dlssInstalled = fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));
  const dlssnrInstalled = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));

  return {
    ready: true,
    supported: true,
    reshadeInstalled,
    addonInstalled,
    fxInstalled,
    headersInstalled,
    dlssInstalled,
    dlssnrInstalled,
    complete: reshadeInstalled && addonInstalled && fxInstalled && headersInstalled && dlssInstalled && dlssnrInstalled,
  };
}

// --- download + cache, mirroring framegen.js's ensureFrameGenDllCache shape -----------

async function downloadToCache(url, cacheDir, fileName, ghHeaders) {
  const dest = path.join(cacheDir, fileName);
  if (fs.existsSync(dest)) return dest;
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(cacheDir, { recursive: true });
  const tmp = dest + '.part';
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, dest);
  return dest;
}

async function resolveFeederAsset(ghHeaders) {
  const res = await fetch(FEEDER_RELEASES_API, { headers: ghHeaders });
  if (!res.ok) throw new Error(`Could not check the DLSS5-Feeder release: HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) => FEEDER_ASSET_PATTERN.test(a.name));
  if (!asset) throw new Error('No matching asset in the latest DLSS5-Feeder release');
  return { url: asset.browser_download_url, name: asset.name, tag: release.tag_name };
}

// --- deploy steps ---------------------------------------------------------------------

// ReShade itself, as a plain file (RESHADE_DLL_NAME) -- NOT a proxy. OptiScaler takes the
// proxy slot in this integration (installProxy() in main.js) and explicitly loads this one
// itself via [Plugins] LoadReshade=true; see the file header for why. Its setup .exe is a
// self-extracting archive (an NSIS stub in front of a zip); a plain Expand-Archive (what the
// rest of this app uses for ordinary zips -- see deployStreamlineFolder/ensureREFrameworkForGame
// in main.js) fails on it because the End Of Central Directory record isn't the very last thing
// in the file. zip.js's EOCD scan handles both a plain zip and this case with the same code path.
async function deployReShade(dir, cacheDir, ghHeaders, { force = false } = {}) {
  const dest = path.join(dir, RESHADE_DLL_NAME);
  if (fs.existsSync(dest) && !force) return { deployed: false, reason: 'already present', file: RESHADE_DLL_NAME };

  const setupPath = await downloadToCache(RESHADE_SETUP_URL, cacheDir, path.basename(RESHADE_SETUP_URL), ghHeaders);
  const zip = openZip(setupPath);
  const entry = findEntry(zip, /^ReShade64\.dll$/i);
  if (!entry) throw new Error('ReShade64.dll not found in the downloaded ReShade setup');
  extractEntryTo(zip, entry, dest);
  return { deployed: true, file: RESHADE_DLL_NAME };
}

// ReShade.fxh / ReShadeUI.fxh -- see the RESHADE_COMMON_HEADERS comment above for why these
// are needed at all. Small text files, fetched directly rather than through the zip-cache
// machinery the other deploy steps use.
async function deployReShadeCommonHeaders(dir, ghHeaders, { force = false } = {}) {
  const shaderDir = path.join(dir, 'reshade-shaders', 'Shaders');
  await fsp.mkdir(shaderDir, { recursive: true });
  const deployed = [];
  for (const name of RESHADE_COMMON_HEADERS) {
    const dest = path.join(shaderDir, name);
    if (fs.existsSync(dest) && !force) continue;
    const res = await fetch(RESHADE_SHADERS_REPO_RAW + name, { headers: { 'User-Agent': ghHeaders['User-Agent'] } });
    if (!res.ok) throw new Error(`Could not fetch ${name}: HTTP ${res.status}`);
    await fsp.writeFile(dest, await res.text(), 'utf8');
    deployed.push(name);
  }
  return { deployed: deployed.length > 0, files: deployed };
}

// The Feeder add-on + its .fx, both from the one release zip -- the earlier, unrelated deploy
// on Alien: Isolation only extracted the addon and skipped the shader, which is why the
// technique never registered ("unknown technique 'DLSS5_Feed@DLSS5_Feed.fx'" in ReShade.log).
// This extracts both from the same zip on purpose.
async function deployFeederAddon(dir, cacheDir, ghHeaders, { force = false } = {}) {
  const addonDest = path.join(dir, 'dlss5-feed.addon64');
  const fxDest = path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx');
  if (fs.existsSync(addonDest) && fs.existsSync(fxDest) && !force) {
    return { deployed: false, reason: 'already present' };
  }

  const asset = await resolveFeederAsset(ghHeaders);
  const zipPath = await downloadToCache(asset.url, cacheDir, asset.name, ghHeaders);
  const zip = openZip(zipPath);

  const addonEntry = findEntry(zip, /(^|\/)dlss5-feed\.addon64$/i);
  if (!addonEntry) throw new Error('dlss5-feed.addon64 not found in the Feeder release');
  extractEntryTo(zip, addonEntry, addonDest);

  const fxEntry = findEntry(zip, /(^|\/)DLSS5_Feed\.fx$/i);
  if (!fxEntry) throw new Error('DLSS5_Feed.fx not found in the Feeder release');
  extractEntryTo(zip, fxEntry, fxDest);

  return { deployed: true, version: asset.tag };
}

// The motion-vector provider shader. Only the auto-fetchable providers reach here --
// LumeniteFX (and any future non-fetchable entry) is the caller's job to detect, not deploy.
async function deployMvProvider(dir, providerId, cacheDir, ghHeaders) {
  const provider = MV_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown motion-vector provider: ${providerId}`);
  if (!provider.autoFetchable) {
    throw new Error(`${provider.displayName} is not auto-fetchable (${provider.license}) -- install it yourself, then re-check readiness.`);
  }

  const shaderDir = path.join(dir, 'reshade-shaders', 'Shaders');
  const zipName = `${providerId}.zip`;
  const zipPath = await downloadToCache(provider.zipUrl, cacheDir, zipName, ghHeaders);
  const zip = openZip(zipPath);

  // .fx AND .fxh -- a provider repo's .fx commonly #includes sibling .fxh files (found the hard
  // way: JakobPCoder/ReshadeMotionEstimation ships MotionEstimation.fx alongside
  // MotionEstimation.fxh/MotionEstimationUI.fxh/MotionVectors.fxh, and compilation fails on the
  // missing includes if only the .fx is extracted).
  const shaderEntries = zip.entries.filter((e) => /\.fxh?$/i.test(e.name));
  if (!shaderEntries.some((e) => /\.fx$/i.test(e.name))) {
    throw new Error(`No .fx files found in ${provider.displayName}'s zip`);
  }
  const deployedFiles = [];
  for (const entry of shaderEntries) {
    const dest = path.join(shaderDir, path.basename(entry.name));
    extractEntryTo(zip, entry, dest);
    deployedFiles.push(path.basename(entry.name));
  }
  return { deployed: true, files: deployedFiles };
}

// LumeniteFX Kernel -- the ONLY path that ever fetches it, and only with real, per-action
// consent. Deliberately separate from deployMvProvider(): that function's autoFetchable guard
// exists precisely so nothing generic ever reaches this licence by accident. Fetches every
// file individually and live from LUMENITEFX_REPO_RAW (the official repo, not a cache/mirror)
// on every call -- see the licence note on MV_PROVIDERS['lumenite-kernel'] for why that's not
// just tidiness, it's the actual condition the licence sets for redistribution.
async function deployLumeniteFx(dir, ghHeaders, { licenseConfirmed = false } = {}) {
  if (!licenseConfirmed) {
    throw new Error('LumeniteFX requires explicit licence confirmation before it can be fetched -- ' +
      'see MV_PROVIDERS["lumenite-kernel"].licenseSummary. Refusing.');
  }

  const shaderDir = path.join(dir, 'reshade-shaders', 'Shaders');
  const includeDir = path.join(shaderDir, 'include');
  await fsp.mkdir(includeDir, { recursive: true });

  const files = [LUMENITEFX_KERNEL_FILE, ...LUMENITEFX_KERNEL_INCLUDES];
  const deployed = [];
  for (const relPath of files) {
    const res = await fetch(LUMENITEFX_REPO_RAW + relPath, { headers: { 'User-Agent': ghHeaders['User-Agent'] } });
    if (!res.ok) throw new Error(`Could not fetch ${relPath} from LumeniteFX's official repo: HTTP ${res.status}`);
    const dest = path.join(shaderDir, ...relPath.split('/'));
    await fsp.writeFile(dest, await res.text(), 'utf8');
    deployed.push(relPath);
  }
  return { deployed: true, files: deployed };
}

// nvngx_dlss.dll: public-SDK, fetchable via the app's shared RHI manifest (same fetch the
// Streamline and Frame Gen version lists already use). Mirrors framegen.js's "never overwrite
// a game's own copy" posture -- a game-local DLL sitting alongside a mismatched driver copy is
// exactly the kind of duplicate-NGX-module condition that crashes other tools (see the
// removed native-feeder/install.js's own comment on this, same underlying risk).
async function deployNvngxDlss(dir, getRhiManifest, compareVersions, cacheDir, ghHeaders) {
  const dest = path.join(dir, 'nvngx_dlss.dll');
  if (fs.existsSync(dest)) return { deployed: false, reason: 'already present, not overwritten' };

  const manifest = await getRhiManifest();
  const list = Array.isArray(manifest && manifest.dlss) ? manifest.dlss : [];
  if (list.length === 0) throw new Error('No dlss entries in the RHI manifest');
  const newest = [...list].sort((a, b) => compareVersions(b.version, a.version))[0];

  const zipName = `nvngx_dlss_${newest.version.replace(/[^0-9A-Za-z.]/g, '_')}.zip`;
  const zipPath = await downloadToCache(newest.url, cacheDir, zipName, ghHeaders);
  const zip = openZip(zipPath);
  const entry = findEntry(zip, /(^|\/)nvngx_dlss\.dll$/i);
  if (!entry) throw new Error('nvngx_dlss.dll not found in the downloaded RHI package');
  extractEntryTo(zip, entry, dest);
  return { deployed: true, version: newest.version };
}

// ReShadePreset.ini: the motion-vector provider's technique must run before DLSS5_Feed, and
// DLSS5_Feed.fx's own DLSS5_MV_PROVIDER preprocessor definition must match. Structure-
// preserving (setIniKey/getIniKey from ini-merge.js) rather than a template overwrite -- this
// file is also where the user's own ReShade effect list and settings live.
function configurePreset(dir, providerId) {
  const provider = MV_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown motion-vector provider: ${providerId}`);

  const presetPath = path.join(dir, 'ReShadePreset.ini');
  const feedTechnique = 'DLSS5_Feed@DLSS5_Feed.fx';
  const existing = fs.existsSync(presetPath) ? fs.readFileSync(presetPath, 'utf8') : '';

  // Order matters: the motion-vector provider's own technique must run BEFORE DLSS5_Feed's, so
  // its motion vectors already exist when DLSS5_Feed reads them. Both are added explicitly and
  // in this order -- ReShade will auto-add a newly-compiled technique to TechniqueSorting on its
  // own once it actually runs, but that's ReShade's own runtime behaviour firing after the fact,
  // not something this app's deploy step should rely on for a correct first launch. Confirmed
  // missing on a real deploy (Bodycam, 2026-09-09) where only DLSS5_Feed had ever been added
  // here -- the motion-vector technique was absent until ReShade itself corrected it.
  const mvTechnique = provider.techniqueFile && provider.techniqueName
    ? `${provider.techniqueName}@${provider.techniqueFile}`
    : null;
  const orderedTechniques = [mvTechnique, feedTechnique].filter(Boolean);

  // Strip every OTHER provider's technique too, not just the one being set now -- otherwise
  // switching providers leaves the old one's technique orphaned in the list alongside the new
  // one instead of replacing it (found this exact bug testing the fix above, same session).
  const anyKnownMvTechnique = Object.values(MV_PROVIDERS)
    .filter((p) => p.techniqueFile && p.techniqueName)
    .map((p) => `${p.techniqueName}@${p.techniqueFile}`.toLowerCase());

  let next = existing;
  for (const key of ['Techniques', 'TechniqueSorting']) {
    const cur = getIniKey(next, '', key);
    let list = cur ? cur.split(',').map((s) => s.trim()).filter(Boolean) : [];
    list = list.filter((t) => {
      const lower = t.toLowerCase();
      return lower !== feedTechnique.toLowerCase() && !anyKnownMvTechnique.includes(lower);
    });
    list.push(...orderedTechniques);
    next = setIniKey(next, '', key, list.join(','));
  }
  const curDefs = getIniKey(next, 'DLSS5_Feed.fx', 'PreprocessorDefinitions');
  let defParts = curDefs ? curDefs.split(',').map((s) => s.trim()).filter((s) => s && !/^DLSS5_MV_PROVIDER\s*=/i.test(s)) : [];
  defParts.push(`DLSS5_MV_PROVIDER=${provider.mvProviderValue}`);
  next = setIniKey(next, 'DLSS5_Feed.fx', 'PreprocessorDefinitions', defParts.join(','));

  fs.writeFileSync(presetPath, next, 'utf8');
  return { configured: true, mvProviderValue: provider.mvProviderValue };
}

// ReShade.ini: make sure add-on loading and the shaders folder are actually enabled. A fresh
// ReShade64.dll deploy has no ini yet; an existing one (the user already had ReShade for other
// effects) is merged into, never replaced.
function configureReShadeIni(dir) {
  const iniPath = path.join(dir, 'ReShade.ini');
  const existing = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, 'utf8') : '';
  let next = existing;
  next = setIniKey(next, 'ADDON', 'AddonPath', '.\\');
  next = setIniKey(next, 'GENERAL', 'EffectSearchPaths', '.\\reshade-shaders\\Shaders\\**');
  if (!getIniKey(next, 'GENERAL', 'PresetPath')) next = setIniKey(next, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  // Marks ReShade's own first-run tutorial as already complete, so its "ReShade is now
  // installed successfully! Press Home to start the tutorial" banner never shows. This app's
  // users are here for the Feeder running silently, not for ReShade's own onboarding/UI.
  //
  // [OVERLAY], not [GENERAL] -- confirmed against ReShade's actual source (runtime_gui.cpp):
  // `global_config().get("OVERLAY", "TutorialProgress", _tutorial_index)`, falling back to the
  // per-preset config under the same section/key if the global one has no value. Verified wrong
  // on a real deploy (Bodycam, 2026-09-09) -- [GENERAL] silently did nothing since ReShade never
  // reads that section for this key.
  if (!getIniKey(next, 'OVERLAY', 'TutorialProgress')) next = setIniKey(next, 'OVERLAY', 'TutorialProgress', '4');
  fs.writeFileSync(iniPath, next, 'utf8');
  return { configured: true };
}

// --- update checking --------------------------------------------------------------------

function readFeederDeployMarker(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, FEEDER_DEPLOY_MARKER), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeFeederDeployMarker(dir, data) {
  fs.writeFileSync(path.join(dir, FEEDER_DEPLOY_MARKER), JSON.stringify(data, null, 2), 'utf8');
}

// Every deploy function's own "already present" check answers "is the file there", never "is
// it current" -- there was no way to tell a stale Feeder deploy from a fresh one until now.
// Only tracks the Feeder add-on's own release tag: that's the piece with a real "latest
// release" concept (a GitHub releases API). ReShade is pinned to one URL in code (an update
// means bumping RESHADE_SETUP_URL, not something a running app can detect on its own), and the
// motion-vector shaders/nvngx_dlss.dll don't meaningfully go stale the same way a day-to-day
// tool like the Feeder does.
async function feederUpdateCheck(dir, ghHeaders) {
  const marker = readFeederDeployMarker(dir);
  if (!marker || !marker.feederVersion) {
    return { checked: false, reason: feederDeployed(dir) ? 'deployed before update-checking existed -- deploy again once to start tracking' : 'not deployed yet' };
  }

  const latest = await resolveFeederAsset(ghHeaders);
  return {
    checked: true,
    currentVersion: marker.feederVersion,
    latestVersion: latest.tag,
    upToDate: marker.feederVersion === latest.tag,
    mvProviderId: marker.mvProviderId,
  };
}

// --- orchestration ---------------------------------------------------------------------

// Deploys the whole Feeder stack for one game: ReShade (plain file, not a proxy) + its common
// shared headers, the add-on + its shader, the chosen motion-vector provider, and
// nvngx_dlss.dll. Does NOT install OptiScaler and does NOT set [Plugins] LoadReshade -- the
// caller (main.js's game:install handler, via autoConfigureGame/forceLoadReshadeForFeederGames)
// does both afterward, proxy-installing OptiScaler the same way it does for every other game
// and forcing LoadReshade=true so OptiScaler itself loads this ReShade64.dll. Keeping that step
// out of this module avoids feeder.js depending on main.js's ini-patching helpers and vice
// versa -- main.js is the one place that already composes both.
//
// force: true re-fetches and overwrites everything (used by an update). licenseConfirmed: only
// consulted when providerId names a non-auto-fetchable provider (currently just LumeniteFX) --
// deployLumeniteFx() itself refuses without it, this just threads it through.
async function deployFeederStack(dir, api, providerId, { cacheDir, getRhiManifest, compareVersions, ghHeaders, force = false, licenseConfirmed = false }) {
  const results = {};
  results.reshade = await deployReShade(dir, cacheDir, ghHeaders, { force });
  results.commonHeaders = await deployReShadeCommonHeaders(dir, ghHeaders, { force });
  results.addon = await deployFeederAddon(dir, cacheDir, ghHeaders, { force });

  const provider = MV_PROVIDERS[providerId];
  results.mvProvider = provider && provider.autoFetchable
    ? await deployMvProvider(dir, providerId, cacheDir, ghHeaders)
    : await deployLumeniteFx(dir, ghHeaders, { licenseConfirmed });

  results.dlss = await deployNvngxDlss(dir, getRhiManifest, compareVersions, cacheDir, ghHeaders);
  results.ini = configureReShadeIni(dir);
  results.preset = configurePreset(dir, providerId);

  // The addon step only resolves the release tag when it actually deploys (fresh install, or
  // force). On a "already present, skip" run there's nothing fresh to record -- keep whatever
  // the marker already said rather than losing the version history feederUpdateCheck needs.
  const previousMarker = readFeederDeployMarker(dir);
  const feederVersion = results.addon.version || (previousMarker && previousMarker.feederVersion) || null;
  if (feederVersion) {
    writeFeederDeployMarker(dir, { feederVersion, mvProviderId: providerId, deployedAt: new Date().toISOString() });
  }

  return results;
}

module.exports = {
  MV_PROVIDERS,
  downloadToCache,
  mvProviderList,
  needsFeeder,
  feederDeployed,
  feederReadiness,
  feederUpdateCheck,
  deployReShade,
  deployReShadeCommonHeaders,
  deployFeederAddon,
  deployMvProvider,
  deployLumeniteFx,
  deployNvngxDlss,
  configurePreset,
  configureReShadeIni,
  deployFeederStack,
};
