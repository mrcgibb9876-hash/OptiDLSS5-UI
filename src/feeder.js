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
const nativeDlss = require('./native-dlss');

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
    // Everything deployMvProvider() extracts from that repo (its .fx and .fxh files), so
    // removeFeederStack() can take exactly these back out and nothing else.
    files: ['MotionEstimation.fx', 'MotionEstimation.fxh', 'MotionEstimationUI.fxh', 'MotionVectors.fxh'],
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
    files: [LUMENITEFX_KERNEL_FILE, ...LUMENITEFX_KERNEL_INCLUDES],
    default: false,
  },
};

function mvProviderList() {
  return Object.values(MV_PROVIDERS);
}

// --- detection ----------------------------------------------------------------------

// The inverse of hasNativeDlss() -- shared through native-dlss.js rather than imported from
// main.js (which would make main.js<->this module circular). A game needing the Feeder has
// neither a Streamline interposer nor its own nvngx_dlss.dll, beside the exe OR anywhere in
// an Unreal plugin tree -- the second half is what an exe-folder-only check missed, and it
// put the Feeder on top of a game's real DLSS (see native-dlss.js).
function needsFeeder(dir) {
  return !nativeDlss.hasNativeDlss(dir);
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
// The Feeder runs on D3D11, D3D12, Vulkan and OpenGL (its README: DOOM 2016 on Vulkan, MX
// Bikes on OpenGL, "any ... game with a working ReShade depth buffer"); on the last two the
// DLSS evaluate still happens on a private D3D12 device, and only how ReShade gets into the
// game differs (reshadeModeForApi). Async because the Vulkan layer is a registry read.
async function feederReadiness(dir, api, { execFileAsync = null } = {}) {
  // dx9: a 64-bit DirectX 9 game behind dgVoodoo2 (legacy.js) renders D3D11, so ReShade goes in the
  // same local way as for D3D11. Experimental.
  if (!['dx11', 'dx12', 'vulkan', 'opengl', 'dx9'].includes(api)) {
    return { ready: false, supported: false, reason: 'Render API not detected ({api}) -- not yet supported by this app.', reasonVars: { api: api || 'unknown' } };
  }

  const mode = reshadeModeForApi(api);
  let reshadeInstalled = false;
  let vulkanLayer = null;
  if (mode === 'vulkan-layer') {
    vulkanLayer = await vulkanLayerStatus({ execFileAsync });
    reshadeInstalled = vulkanLayer.registered && vulkanLayer.addon;
  } else if (mode === 'opengl32') {
    reshadeInstalled = isReShadeDll(path.join(dir, OPENGL_PROXY_NAME));
  } else {
    reshadeInstalled = fs.existsSync(path.join(dir, RESHADE_DLL_NAME));
  }
  const addonInstalled = fs.existsSync(path.join(dir, 'dlss5-feed.addon64'));
  const fxInstalled = fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'));
  const headersInstalled = RESHADE_COMMON_HEADERS.every((f) => fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', f)));
  const dlssInstalled = fs.existsSync(path.join(dir, 'nvngx_dlss.dll'));
  const dlssnrInstalled = fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));

  const notes = [];
  if (api === 'vulkan') {
    notes.push('NVIDIA Smooth Motion must be off for this game: on Vulkan the driver invents its extra frames after the Feeder has run, so half the frames carry no neural pass (the Feeder\'s README, "Smooth Motion off on Vulkan"). NVIDIA app or Profile Inspector, per game.');
    if (vulkanLayer && vulkanLayer.registered && !vulkanLayer.addon) notes.push(`The ReShade Vulkan layer on this PC (${vulkanLayer.dllPath || vulkanLayer.manifestPath}) has no add-on support. ${VULKAN_LAYER_INSTRUCTION}`);
    else if (vulkanLayer && !vulkanLayer.registered) notes.push(`ReShade is not installed as a Vulkan layer on this PC. ${VULKAN_LAYER_INSTRUCTION}`);
  }

  return {
    ready: true,
    supported: true,
    reshadeMode: mode,
    reshadeInstalled,
    vulkanLayer,
    addonInstalled,
    fxInstalled,
    headersInstalled,
    dlssInstalled,
    dlssnrInstalled,
    notes,
    complete: reshadeInstalled && addonInstalled && fxInstalled && headersInstalled && dlssInstalled && dlssnrInstalled,
  };
}

// --- download + cache, mirroring framegen.js's ensureFrameGenDllCache shape -----------

// A fetch that rides out the hosts' bad minutes. raw.githubusercontent.com answered a user's
// Feeder deploy with HTTP 503 on ReShade.fxh (2026-09-12), and both it and reshade.me do that
// now and then: a 5xx, a 429 or a dropped connection is retried a few times with a growing
// pause before it becomes the error the user sees. A 4xx is final at once.
const RETRY_PAUSES_MS = [1000, 3000, 6000];
async function fetchWithRetry(url, init = {}, { fetchImpl = fetch, pauses = RETRY_PAUSES_MS } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= pauses.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, pauses[attempt - 1]));
    try {
      const res = await fetchImpl(url, init);
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function downloadToCache(url, cacheDir, fileName, ghHeaders) {
  const dest = path.join(cacheDir, fileName);
  if (fs.existsSync(dest)) return dest;
  const res = await fetchWithRetry(url, { headers: ghHeaders });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(cacheDir, { recursive: true });
  const tmp = dest + '.part';
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, dest);
  return dest;
}

async function resolveFeederAsset(ghHeaders) {
  const res = await fetchWithRetry(FEEDER_RELEASES_API, { headers: ghHeaders });
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
// How ReShade reaches the game, by graphics API (the Feeder's README, "Install for a Vulkan
// game" / "Install for an OpenGL game"):
//   local         D3D11/D3D12: a plain ReShade64.dll beside the exe that OptiScaler loads itself
//                 ([Plugins] LoadReshade=true). Not a proxy.
//   opengl32      OpenGL: ReShade *is* the game's opengl32.dll -- the only way its GL hooks run.
//                 Add-ons load from its own folder, so the game folder still holds the add-on.
//   vulkan-layer  Vulkan: ReShade only runs as a Vulkan implicit layer, machine-wide, registered
//                 in the registry (Khronos\Vulkan\ImplicitLayers) and shared by every Vulkan game.
//                 The add-on is still found per game through AddonPath=.\ in the game's
//                 ReShade.ini. This app never writes that registration itself: it is a
//                 machine-wide change under HKLM, and ReShade's own installer (cached here) is
//                 the right tool -- the user runs it once, choosing Vulkan and "Enable loading
//                 of add-ons".
// OptiScaler in the last two takes a name the game imports at start (winmm.dll / version.dll,
// main.js picks from the exe's import table) and must not try to load a ReShade64.dll that is
// not there.
const RESHADE_MODE_FOR_API = { dx11: 'local', dx12: 'local', opengl: 'opengl32', vulkan: 'vulkan-layer' };
function reshadeModeForApi(api) { return RESHADE_MODE_FOR_API[api] || 'local'; }

const OPENGL_PROXY_NAME = 'opengl32.dll';
const OPENGL_BACKUP_NAME = 'opengl32.dll.dlss5ui-orig';

// The add-on build of ReShade exports the registration entry points add-ons look up by name;
// the plain build does not. Same version number, same product name (the README's issue #53),
// so the export table is the only honest tell.
function isAddonReShadeDll(file) {
  try {
    return fs.readFileSync(file).includes(Buffer.from('ReShadeRegisterAddon', 'latin1'));
  } catch {
    return false;
  }
}

// Whether a file is a ReShade build at all (for an opengl32.dll that might be the game's own).
function isReShadeDll(file) {
  try {
    return fs.statSync(file).size > 1024 * 1024 && fs.readFileSync(file).includes(Buffer.from('ReShade', 'latin1'));
  } catch {
    return false;
  }
}

// The machine's ReShade Vulkan layer, if any: where ReShade's own installer puts it (HKLM,
// C:\ProgramData\ReShade\ReShade64.json -> .\ReShade64.dll) or a per-user registration (HKCU).
// Read-only. The Vulkan loader takes the first layer of a given name it finds, HKLM before
// HKCU, so the registration that counts is the first one -- which is why a plain build
// registered by an old ReShade install for some other game silently wins over anything
// registered later.
async function vulkanLayerStatus({ execFileAsync, regQuery = null } = {}) {
  const out = { registered: false, manifestPath: null, dllPath: null, addon: false, hive: null };
  const query = regQuery || (execFileAsync
    ? async (hive) => (await execFileAsync('reg.exe', ['query', `${hive}\\SOFTWARE\\Khronos\\Vulkan\\ImplicitLayers`], { windowsHide: true })).stdout
    : null);
  if (!query) return out;
  for (const hive of ['HKLM', 'HKCU']) {
    let stdout = '';
    try { stdout = await query(hive); } catch { continue; }
    const line = (stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /reshade64\.json\s+REG_DWORD/i.test(l));
    if (!line) continue;
    const manifestPath = line.replace(/\s+REG_DWORD.*$/i, '').trim();
    out.registered = true;
    out.hive = hive;
    out.manifestPath = manifestPath;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const lib = manifest && manifest.layer && manifest.layer.library_path ? String(manifest.layer.library_path) : '.\\ReShade64.dll';
      out.dllPath = path.isAbsolute(lib) ? lib : path.resolve(path.dirname(manifestPath), lib);
      out.addon = isAddonReShadeDll(out.dllPath);
    } catch {}
    return out;
  }
  return out;
}

const VULKAN_LAYER_INSTRUCTION = 'Run ReShade\'s installer, pick this game\'s exe, choose Vulkan and tick "Enable loading of add-ons" -- then deploy again.';

async function deployReShade(dir, cacheDir, ghHeaders, { force = false, api = 'dx11', execFileAsync = null } = {}) {
  const mode = reshadeModeForApi(api);

  if (mode === 'vulkan-layer') {
    // Machine-wide and shared: an add-on build already registered is used as it is (its
    // version does not matter to the Feeder). Anything else is the user's installer run --
    // the setup exe is cached so the button in the Edit dialog can open it for them.
    const status = await vulkanLayerStatus({ execFileAsync });
    if (status.registered && status.addon) return { deployed: false, reason: 'add-on Vulkan layer already registered', file: status.dllPath, mode, manifestPath: status.manifestPath };
    const setupPath = await downloadToCache(RESHADE_SETUP_URL, cacheDir, path.basename(RESHADE_SETUP_URL), ghHeaders);
    const err = new Error(status.registered
      ? `The ReShade Vulkan layer on this PC (${status.dllPath || status.manifestPath}) is a build without add-on support, so the Feeder would never load. ${VULKAN_LAYER_INSTRUCTION}`
      : `ReShade is not installed as a Vulkan layer on this PC. ${VULKAN_LAYER_INSTRUCTION}`);
    err.needsReShadeInstaller = true;
    err.setupPath = setupPath;
    throw err;
  }

  const fileName = mode === 'opengl32' ? OPENGL_PROXY_NAME : RESHADE_DLL_NAME;
  const dest = path.join(dir, fileName);
  if (fs.existsSync(dest) && !force) {
    if (mode !== 'opengl32' || isReShadeDll(dest)) return { deployed: false, reason: 'already present', file: fileName, mode };
    // The game's own opengl32.dll (rare, but a wrapper such as dgVoodoo ships one): kept
    // under a backup name so Remove can put it back.
    await fsp.copyFile(dest, path.join(dir, OPENGL_BACKUP_NAME));
  }

  const setupPath = await downloadToCache(RESHADE_SETUP_URL, cacheDir, path.basename(RESHADE_SETUP_URL), ghHeaders);
  const zip = openZip(setupPath);
  const entry = findEntry(zip, /^ReShade64\.dll$/i);
  if (!entry) throw new Error('ReShade64.dll not found in the downloaded ReShade setup');
  extractEntryTo(zip, entry, dest);
  return { deployed: true, file: fileName, mode };
}

// ReShade.fxh / ReShadeUI.fxh -- see the RESHADE_COMMON_HEADERS comment above for why these
// are needed at all. Small text files, fetched directly rather than through the zip-cache
// machinery the other deploy steps use.
// The same two files, from a second host: jsDelivr serves any GitHub repo's files, so a bad
// minute at raw.githubusercontent.com (a real HTTP 503 on a user's deploy, 2026-09-12) is not
// the end of the install. Fetched once and kept in the cache folder with the other downloads,
// so every later deploy on this machine needs no network for them at all.
const RESHADE_SHADERS_MIRROR_RAW = 'https://cdn.jsdelivr.net/gh/crosire/reshade-shaders@slim/Shaders/';

async function fetchReShadeHeader(name, ghHeaders, { fetchImpl = fetch, pauses } = {}) {
  const init = { headers: { 'User-Agent': ghHeaders['User-Agent'] } };
  let lastError = null;
  for (const base of [RESHADE_SHADERS_REPO_RAW, RESHADE_SHADERS_MIRROR_RAW]) {
    try {
      const res = await fetchWithRetry(base + name, init, { fetchImpl, pauses });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status} for ${base + name}`); continue; }
      const text = await res.text();
      // A host's error page is not a shader: the real file opens with ReShade's own guard.
      if (!/#pragma once|#ifndef|#define/.test(text.slice(0, 400))) { lastError = new Error(`${base + name} did not return a shader header`); continue; }
      return text;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Could not fetch ${name} from GitHub or its mirror (${lastError && lastError.message ? lastError.message : lastError}). Try again in a minute -- this is the host, not the game.`);
}

async function deployReShadeCommonHeaders(dir, ghHeaders, { force = false, cacheDir = null, fetchImpl = fetch, pauses } = {}) {
  const shaderDir = path.join(dir, 'reshade-shaders', 'Shaders');
  await fsp.mkdir(shaderDir, { recursive: true });
  const deployed = [];
  for (const name of RESHADE_COMMON_HEADERS) {
    const dest = path.join(shaderDir, name);
    if (fs.existsSync(dest) && !force) continue;
    const cached = cacheDir ? path.join(cacheDir, 'reshade-headers', name) : null;
    let text = null;
    if (cached && fs.existsSync(cached)) {
      text = await fsp.readFile(cached, 'utf8');
    } else {
      text = await fetchReShadeHeader(name, ghHeaders, { fetchImpl, pauses });
      if (cached) {
        await fsp.mkdir(path.dirname(cached), { recursive: true });
        await fsp.writeFile(cached, text, 'utf8');
      }
    }
    await fsp.writeFile(dest, text, 'utf8');
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
function configureReShadeIni(dir, { effectSearchPaths = '.\\reshade-shaders\\Shaders\\**', unity = false } = {}) {
  const iniPath = path.join(dir, 'ReShade.ini');
  const existing = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, 'utf8') : '';
  let next = existing;
  next = setIniKey(next, 'ADDON', 'AddonPath', '.\\');
  next = setIniKey(next, 'GENERAL', 'EffectSearchPaths', effectSearchPaths);
  if (!getIniKey(next, 'GENERAL', 'PresetPath')) next = setIniKey(next, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  // Unity: the Feeder is engine-agnostic (its README lists Subnautica, 64-bit D3D11 Unity, as
  // verified) but Unity's depth needs two things said to ReShade's Generic Depth add-on, or
  // the Feeder's depth probe reads flat and DLSS reconstructs from nothing. Unity clears the
  // depth buffer after the scene and before its UI pass, so the copy has to be taken before
  // clears (DepthCopyBeforeClears=1 is exactly "Copy depth buffer before clear operations" in
  // the add-on's own UI, generic_depth_addon.cpp); and Unity renders reversed-Z on D3D11/D3D12,
  // which the shaders learn from RESHADE_DEPTH_INPUT_IS_REVERSED=1. Both only fill a gap: a
  // value someone already chose on the Generic Depth page is left alone, and the definitions
  // list keeps everything else in it.
  if (unity) {
    if (!getIniKey(next, 'DEPTH', 'DepthCopyBeforeClears')) next = setIniKey(next, 'DEPTH', 'DepthCopyBeforeClears', '1');
    const cur = getIniKey(next, 'GENERAL', 'PreprocessorDefinitions');
    const defs = cur ? cur.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!defs.some((d) => /^RESHADE_DEPTH_INPUT_IS_REVERSED\s*=/i.test(d))) defs.push('RESHADE_DEPTH_INPUT_IS_REVERSED=1');
    next = setIniKey(next, 'GENERAL', 'PreprocessorDefinitions', defs.join(','));
  }
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
async function deployFeederStack(dir, api, providerId, { cacheDir, getRhiManifest, compareVersions, ghHeaders, force = false, licenseConfirmed = false, unity = false, execFileAsync = null }) {
  const results = {};
  results.reshade = await deployReShade(dir, cacheDir, ghHeaders, { force, api, execFileAsync });
  results.reshadeMode = results.reshade.mode || reshadeModeForApi(api);
  results.commonHeaders = await deployReShadeCommonHeaders(dir, ghHeaders, { force, cacheDir });
  results.addon = await deployFeederAddon(dir, cacheDir, ghHeaders, { force });

  const provider = MV_PROVIDERS[providerId];
  results.mvProvider = provider && provider.autoFetchable
    ? await deployMvProvider(dir, providerId, cacheDir, ghHeaders)
    : await deployLumeniteFx(dir, ghHeaders, { licenseConfirmed });

  results.dlss = await deployNvngxDlss(dir, getRhiManifest, compareVersions, cacheDir, ghHeaders);
  results.ini = configureReShadeIni(dir, { unity });
  results.preset = configurePreset(dir, providerId);

  // The addon step only resolves the release tag when it actually deploys (fresh install, or
  // force). On a "already present, skip" run there's nothing fresh to record -- keep whatever
  // the marker already said rather than losing the version history feederUpdateCheck needs.
  const previousMarker = readFeederDeployMarker(dir);
  const feederVersion = results.addon.version || (previousMarker && previousMarker.feederVersion) || null;
  if (feederVersion) {
    // placedNvngxDlss: whether THIS app put nvngx_dlss.dll here (as opposed to skipping one
    // already present) -- removeFeederStack() only takes back what was placed.
    const placedNvngxDlss = results.dlss.deployed || !!(previousMarker && previousMarker.placedNvngxDlss);
    writeFeederDeployMarker(dir, { feederVersion, mvProviderId: providerId, placedNvngxDlss, reshadeMode: results.reshadeMode, deployedAt: new Date().toISOString() });
  }

  return results;
}

// Reverses deployFeederStack(): the add-on and its files, the shaders it placed (exactly the
// ones the deploy lists, never the user's own effects), ReShade itself unless keepReShade
// (Luma UE deploys the same plain ReShade64.dll and still needs it), and nvngx_dlss.dll when
// this app placed it or the game ships its own elsewhere (the Unreal-plugin case: the copy
// beside the exe is the duplicate that crashes the game's own DLSS). Does NOT touch
// OptiScaler.ini -- main.js's feeder:remove resets [Plugins] LoadReshade and re-runs the
// profile, for the same reason deployFeederStack() leaves the ini to main.js.
async function removeFeederStack(dir, { keepReShade = false } = {}) {
  const removed = [];
  const kept = [];
  const marker = readFeederDeployMarker(dir);
  const rm = async (rel) => {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) return;
    await fsp.rm(p, { force: true });
    removed.push(rel);
  };

  for (const name of ['dlss5-feed.addon64', 'dlss5-feed.cfg', 'dlss5-feed.log']) await rm(name);

  const shaderDir = path.join('reshade-shaders', 'Shaders');
  const shaders = ['DLSS5_Feed.fx', ...RESHADE_COMMON_HEADERS];
  for (const provider of Object.values(MV_PROVIDERS)) shaders.push(...provider.files);
  for (const rel of shaders) await rm(path.join(shaderDir, ...rel.split('/')));
  // Only the folders the deploy created, and only once nothing else is left in them.
  for (const rel of [path.join(shaderDir, 'include'), shaderDir, 'reshade-shaders']) {
    const p = path.join(dir, rel);
    try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch {}
  }

  if (keepReShade) {
    kept.push(RESHADE_DLL_NAME + ' (Luma UE still needs it)');
  } else {
    for (const name of [RESHADE_DLL_NAME, 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log']) await rm(name);
  }
  // OpenGL: ReShade was the game's opengl32.dll. Only a ReShade build is taken (never a
  // game's own), and a backed-up original goes back in its place.
  const gl = path.join(dir, OPENGL_PROXY_NAME);
  if (fs.existsSync(gl) && isReShadeDll(gl)) {
    await rm(OPENGL_PROXY_NAME);
    const backup = path.join(dir, OPENGL_BACKUP_NAME);
    if (fs.existsSync(backup)) {
      await fsp.rename(backup, gl);
      kept.push(OPENGL_PROXY_NAME + ' (the game\'s own, put back)');
    }
  }
  // Vulkan: the ReShade layer is machine-wide and shared by every Vulkan game; it stays.
  if (marker && marker.reshadeMode === 'vulkan-layer') kept.push('the ReShade Vulkan layer (machine-wide, shared by other games)');

  const shipped = nativeDlss.shippedDlssPath(dir);
  if (shipped || !(marker && marker.placedNvngxDlss === false)) {
    await rm('nvngx_dlss.dll');
  } else {
    kept.push('nvngx_dlss.dll (was already here before the Feeder)');
  }

  await rm(FEEDER_DEPLOY_MARKER);
  return { removed, kept, shippedDlss: shipped };
}

// How ReShade reached this game's Feeder deploy, from the marker; 'local' for a deploy from
// before the marker carried it (every such deploy was D3D11/D3D12).
function feederReShadeMode(dir) {
  const marker = readFeederDeployMarker(dir);
  return (marker && marker.reshadeMode) || 'local';
}

module.exports = {
  MV_PROVIDERS,
  downloadToCache,
  reshadeModeForApi,
  feederReShadeMode,
  vulkanLayerStatus,
  isAddonReShadeDll,
  isReShadeDll,
  RESHADE_SETUP_URL,
  mvProviderList,
  needsFeeder,
  feederDeployed,
  feederReadiness,
  feederUpdateCheck,
  removeFeederStack,
  deployReShade,
  deployReShadeCommonHeaders,
  deployFeederAddon,
  deployMvProvider,
  deployLumeniteFx,
  deployNvngxDlss,
  configurePreset,
  configureReShadeIni,
  deployFeederStack,
  fetchWithRetry,
  fetchReShadeHeader,
  resolveFeederAsset,
};
