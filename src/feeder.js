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
const integrity = require('./integrity');

const FEEDER_RELEASES_API = 'https://api.github.com/repos/jlrouzies-fr/DLSS5-Feeder/releases/latest';
// GitHub's /releases/latest deliberately excludes pre-releases, so a beta the Feeder's author
// asks someone to test is invisible to this app -- the reason 1.16.0-beta.2 had to be installed
// by hand. This list endpoint sees them; it is only consulted when a user opted in, so the
// default path still makes the same single call to the same endpoint it always did.
const FEEDER_RELEASES_LIST_API = 'https://api.github.com/repos/jlrouzies-fr/DLSS5-Feeder/releases?per_page=20';
const FEEDER_ASSET_PATTERN = /^DLSS5-Feeder-.*\.zip$/i;

// The "_Addon" build specifically -- ReShade's plain build refuses third-party add-ons, and
// dlss5-feed.addon64 is exactly that. Verified this is the add-on-enabled build by its name;
// the alternative (opening the installer as an archive and checking which DLL variant is
// inside) was not re-verified this pass since a prior, since-removed integration in this same
// repo already downloaded and confirmed this exact URL's contents (see git history on the
// deleted src/native-feeder/reshade.js, commit 0738a9e removed it, ec3083d added it).
const RESHADE_SETUP_URL = integrity.URLS.reshadeSetup;

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
// Pinned to one commit (integrity.js) so each header's sha256 can be checked.
const RESHADE_SHADERS_REPO_RAW = integrity.URLS.reshadeShadersRaw;

// LumeniteFX's own official repo, fetched live (never cached/mirrored) -- see the licence
// note on MV_PROVIDERS['lumenite-kernel'] for why that matters, not just why it's convenient.
// lumenite_Kernel.fx's own #include lines name exactly these four files (checked against the
// real source, 2026-09-09: ReShade.fxh -- already covered by RESHADE_COMMON_HEADERS -- plus
// three from its own include/ subfolder; lumenite_ColorManagement.fxh in that same folder is
// NOT included by Kernel.fx and is deliberately left out).
// Still the official repo, fetched live -- at a pinned commit, so each file's sha256 is checked.
const LUMENITEFX_REPO_RAW = integrity.URLS.lumeniteRaw;
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

// Motion-vector provider. DLSS5_Feed.fx does not estimate motion itself: it reads whichever
// provider's output texture the DLSS5_MV_PROVIDER preprocessor definition selects (five values,
// per the Feeder's README). Each entry here carries the provider's real technique name -- it
// must run BEFORE DLSS5_Feed in the technique list or no vectors exist when the feed reads them
// -- and a way of getting the shader that respects its licence.
//
// Why VORT is the default and DRME is not: this is the bug behind "the Feeder is deployed and
// nothing happens".
//
//   DLSS5_MV_PROVIDER=0 is the Feeder's "old convention" value ("anything writing the shared
//   texMotionVectors texture"), and JakobPCoder's ReshadeMotionEstimation -- technique DRME --
//   was this app's default for it. The Feeder's README is explicit that **DRME does not compile
//   on ReShade 6.8**, the version this app pins and installs (RESHADE_SETUP_URL), and lists it
//   as one of the four causes of its classic silent failure: the image is static-sharp but
//   smears in motion because no vectors ever reach DLSS. So every deploy this app made with the
//   old default shipped a motion-vector shader that could not compile -- on every game, Unity or
//   not. The comment that used to live here read that README warning as being about a different
//   shader; it is about this one.
//
//   VORT (value 2) is MIT, fetchable from its author's own repo, and the Feeder's own shader
//   source calls it "the recommended provider". It is the default now.
//
// The other three are real, documented choices rather than defaults: LumeniteFX Kernel (3) is
// what the Feeder's beta was tuned on and what its README recommends, but its licence needs
// per-action consent (deployLumeniteFx below); iMMERSE Launchpad (1) may not be redistributed at
// all, so it is offered only when the user's own iMMERSE install is already in the game's shader
// folder; DRME (0) stays listed but unselectable, so a game deployed with it before this change
// is still recognised, reported and cleaned up.
const VORT_COMMIT = integrity.VORT_COMMIT;
const MV_PROVIDERS = {
  vort: {
    id: 'vort',
    displayName: 'VORT (vortigern11)',
    mvProviderValue: 2,
    license: 'MIT',
    autoFetchable: true,
    selectable: true,
    default: true,
    // Pinned to one commit rather than a branch head: this shader is what every Feeder deploy
    // depends on to compile, and an upstream change that broke it would break new installs
    // silently. It is the same commit DLSS5-Swapper pins and ships with a sha256, so two
    // projects have independently run this exact one.
    zipUrl: `https://codeload.github.com/vortigern11/vort_Shaders/zip/${VORT_COMMIT}`,
    // Path-preserving, unlike the flat providers below. vort_Motion.fx's own #include lines name
    // "Includes/vort_Defs.fxh" (ReShade resolves those against the effect search path root), and
    // the shaders it pulls in declare a texture with `source = "vort_BlueNoise.png"` -- which
    // ReShade only finds through TextureSearchPaths, so configureReShadeIni writes that too.
    // The whole Includes folder goes in rather than a hand-resolved include closure: the closure
    // runs ~11 files deep through four levels, and one missing .fxh fails compilation with a
    // preprocessor error naming the include -- exactly the silent failure this provider is here
    // to end.
    layout: [
      { from: 'Shaders/vort_Motion.fx', to: 'Shaders/vort_Motion.fx' },
      { fromDir: 'Shaders/Includes', to: 'Shaders/Includes', match: /\.fxh$/i },
      { from: 'Textures/vort_BlueNoise.png', to: 'Textures/vort_BlueNoise.png' },
      { from: 'Textures/vort_MLUT.png', to: 'Textures/vort_MLUT.png' },
      { from: 'LICENSE', to: 'Licenses/VORT-LICENSE.txt' },
    ],
    techniqueFile: 'vort_Motion.fx',
    techniqueName: 'vort_MotionEffects',
    // vort_Static.fx is deliberately not deployed: only one provider technique may be enabled,
    // and an unused effect is one more thing to compile and to explain. `files` is the static
    // fallback for removal; a real deploy records every path it wrote in the deploy marker
    // (mvFiles) and removeFeederStack() prefers that.
    files: ['vort_Motion.fx'],
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
    selectable: true,
    recommended: true,
    officialUrl: 'https://github.com/umar-afzaal/LumeniteFX',
    licenseUrl: 'https://github.com/umar-afzaal/LumeniteFX/blob/mainline/LICENSE.md',
    licenseSummary: 'AGNYA licence (Rev 1.4), Copyright (C) 2025-2026 Afzaal (Kaidō). All rights ' +
      'reserved. Redistribution must exclusively use the author\'s own official links -- ' +
      'independently hosting a copy is explicitly prohibited, which is why this always ' +
      'fetches live from the official repo rather than a cached copy. No warranty of any kind.',
    // The real declared technique name inside lumenite_Kernel.fx ("technique Lumenite_Kernel").
    techniqueFile: 'lumenite_Kernel.fx',
    techniqueName: 'Lumenite_Kernel',
    files: [LUMENITEFX_KERNEL_FILE, ...LUMENITEFX_KERNEL_INCLUDES],
  },
  'immerse-launchpad': {
    id: 'immerse-launchpad',
    displayName: 'iMMERSE Launchpad (MartysMods) -- your own copy',
    mvProviderValue: 1,
    license: 'All rights reserved -- martymcmodding/iMMERSE',
    // Bring-your-own, and not for the same reason as LumeniteFX. iMMERSE's licence forbids
    // propagation outright -- "Public propagation of this project or parts of it is strictly
    // forbidden. This means that independently hosting a copy of this project and propagating
    // it using this hosted version is prohibited" -- with no official-links carve-out to fetch
    // through. So this app never downloads it: the provider becomes available only when the
    // user's own iMMERSE install already has MartysMods_LAUNCHPAD.fx in the game's shader
    // folder, and all this app does then is point DLSS5_MV_PROVIDER and the technique list at
    // it. The Feeder's README also rates it the weakest of the numbered providers ("warping
    // around flames/transparents is worst here") and its troubleshooting sends you to provider
    // 3 -- so it is a choice for someone who already has iMMERSE, never a recommendation.
    autoFetchable: false,
    bringYourOwn: true,
    selectable: true,
    officialUrl: 'https://github.com/martymcmodding/iMMERSE',
    licenseSummary: 'Copyright (c) Pascal Gilcher. All rights reserved. Public propagation of ' +
      'the project or parts of it is forbidden, so this app never fetches or ships it -- ' +
      'install iMMERSE yourself from its own official release and this provider lights up.',
    techniqueFile: 'MartysMods_LAUNCHPAD.fx',
    techniqueName: 'MartysMods_Launchpad',
    // Never ours to remove: the user installed it, and other iMMERSE effects share its includes.
    files: [],
  },
  'reshade-motion-estimation': {
    id: 'reshade-motion-estimation',
    displayName: 'ReShade Motion Estimation / DRME (JakobPCoder)',
    mvProviderValue: 0,
    license: 'CC BY-NC 4.0',
    autoFetchable: true,
    // Cannot compile on the ReShade this app installs -- see the block comment above. Left in
    // the table, and out of the UI, purely so an existing deploy that used it is recognised:
    // feederReadiness() reports it as broken, removeFeederStack() still takes its files back
    // out, and configurePreset() still strips its technique when another provider replaces it.
    selectable: false,
    unsupportedReason: 'DRME does not compile on ReShade 6.8 (the version this app installs), ' +
      'so it feeds no motion vectors at all -- the picture looks sharp when still and smears ' +
      'when moving. The Feeder\'s own README names this. Deploy again with VORT or LumeniteFX.',
    zipUrl: 'https://github.com/JakobPCoder/ReshadeMotionEstimation/archive/refs/heads/master.zip',
    techniqueFile: 'MotionEstimation.fx',
    techniqueName: 'DRME',
    files: ['MotionEstimation.fx', 'MotionEstimation.fxh', 'MotionEstimationUI.fxh', 'MotionVectors.fxh'],
  },
};

// Every provider, for the Edit dialog's picker. The unselectable ones (DRME) are filtered out
// there, not here -- main.js and the readiness report both need to look them up by id.
function mvProviderList() {
  return Object.values(MV_PROVIDERS);
}

// The provider a fresh deploy should use when nobody has chosen one.
function defaultMvProviderId() {
  const chosen = Object.values(MV_PROVIDERS).find((p) => p.default && p.selectable !== false);
  return (chosen || MV_PROVIDERS.vort).id;
}

// Is a bring-your-own provider's shader actually in this game's folder? The only check that
// makes sense for iMMERSE Launchpad, which this app never places itself.
function mvProviderPresent(dir, providerId) {
  const provider = MV_PROVIDERS[providerId];
  if (!provider || !provider.techniqueFile) return false;
  return fs.existsSync(path.join(dir, 'reshade-shaders', 'Shaders', provider.techniqueFile));
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

// Which motion-vector provider this game is actually set up for, and whether that set-up agrees
// with itself. This is the check that would have caught the DRME default: a Feeder deploy can be
// complete in every file sense and still feed no vectors, because the shader cannot compile, or
// because the preset enables one provider's technique while DLSS5_Feed is compiled for another --
// what the Feeder's README calls its classic silent failure. Everything here is read from the
// game's own files, so it stays true for a deploy made by hand or by an older version of this app.
function feederProviderStatus(dir) {
  const marker = readFeederDeployMarker(dir);
  const id = (marker && marker.mvProviderId) || null;
  const provider = id ? MV_PROVIDERS[id] : null;
  const presetPath = path.join(dir, 'ReShadePreset.ini');
  let preset = '';
  try { preset = fs.readFileSync(presetPath, 'utf8'); } catch {}

  const definedValue = (() => {
    for (const section of ['DLSS5_Feed.fx', '']) {
      const defs = getIniKey(preset, section, 'PreprocessorDefinitions') || '';
      const hit = /DLSS5_MV_PROVIDER\s*=\s*(\d+)/i.exec(defs);
      if (hit) return Number(hit[1]);
    }
    return null;
  })();

  const techniques = (getIniKey(preset, '', 'Techniques') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const enabled = Object.values(MV_PROVIDERS).find((p) => p.techniqueFile && p.techniqueName &&
    techniques.includes(`${p.techniqueName}@${p.techniqueFile}`.toLowerCase())) || null;

  const shaderPresent = provider ? mvProviderPresent(dir, id) : false;
  return {
    id,
    displayName: provider ? provider.displayName : null,
    broken: !!(provider && provider.selectable === false),
    unsupportedReason: provider ? provider.unsupportedReason || null : null,
    bringYourOwn: !!(provider && provider.bringYourOwn),
    shaderPresent,
    definedValue,
    expectedValue: provider ? provider.mvProviderValue : null,
    enabledTechnique: enabled ? `${enabled.techniqueName}@${enabled.techniqueFile}` : null,
    // The two disagreements worth naming, both silent in-game: the shader is compiled for a
    // provider the preset does not enable, and the enabled technique belongs to a different
    // provider than the compiled-for value.
    valueMismatch: !!(provider && definedValue !== null && definedValue !== provider.mvProviderValue),
    techniqueMismatch: !!(enabled && definedValue !== null && enabled.mvProviderValue !== definedValue),
  };
}

// What's deployed, what's missing, and the real reason anything blocking is blocking -- same
// "explain, don't just disable" posture as injectorReadiness() in injector.js.
// The Feeder runs on D3D11, D3D12, Vulkan and OpenGL (its README: DOOM 2016 on Vulkan, MX
// Bikes on OpenGL, "any ... game with a working ReShade depth buffer"); on the last two the
// DLSS evaluate still happens on a private D3D12 device, and only how ReShade gets into the
// game differs (reshadeModeForApi). Async because the Vulkan layer is a registry read.
async function feederReadiness(dir, api, { execFileAsync = null, exePath = null } = {}) {
  // dx9: a 64-bit DirectX 9 game behind dgVoodoo2 (legacy.js) renders D3D11, so ReShade goes in the
  // same local way as for D3D11. Experimental.
  if (!['dx11', 'dx12', 'vulkan', 'opengl', 'dx9'].includes(api)) {
    return { ready: false, supported: false, reason: 'Render API not detected ({api}) -- not yet supported by this app.', reasonVars: { api: api || 'unknown' } };
  }

  const mode = reshadeModeForApi(api);
  let reshadeInstalled = false;
  let vulkanLayer = null;
  if (mode === 'vulkan-layer') {
    vulkanLayer = await vulkanLayerStatus({ execFileAsync, exePath });
    // The layer, with add-ons, and switched on for this exe (reshadeAppsListing): all three, or
    // ReShade is not in this game whatever the registry says.
    reshadeInstalled = vulkanLayer.registered && vulkanLayer.addon && vulkanLayer.appListed !== false;
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
  // The motion-vector half of the stack, and the reason a "complete" deploy can still do nothing.
  // Only worth saying once something is actually deployed -- before that, missing files are the
  // story and the picker in Edit is where the choice gets made.
  const mvProvider = feederProviderStatus(dir);
  const mvBlocking = [];
  if (addonInstalled && mvProvider.id) {
    if (mvProvider.broken) {
      mvBlocking.push(`${mvProvider.displayName} is the motion-vector shader here, and it cannot work: ${mvProvider.unsupportedReason}`);
    } else if (!mvProvider.shaderPresent) {
      mvBlocking.push(`The motion-vector shader for ${mvProvider.displayName} is not in reshade-shaders\\Shaders. ` +
        'Deploy again to put it back -- without it DLSS is fed no motion at all, which looks like a sharp still image that smears as soon as you move.');
    } else if (mvProvider.valueMismatch || mvProvider.techniqueMismatch) {
      mvBlocking.push('This game\'s ReShade preset and the Feeder\'s shader disagree about which motion-vector provider to use ' +
        `(the shader is compiled for value ${mvProvider.definedValue}, ${mvProvider.enabledTechnique || 'no provider technique'} is enabled). ` +
        'Deploy again to write both from one answer.');
    }
  }
  notes.push(...mvBlocking);
  if (api === 'vulkan') {
    notes.push('NVIDIA Smooth Motion must be off for this game: on Vulkan the driver invents its extra frames after the Feeder has run, so half the frames carry no neural pass (the Feeder\'s README, "Smooth Motion off on Vulkan"). NVIDIA app or Profile Inspector, per game.');
    if (vulkanLayer && vulkanLayer.registered && !vulkanLayer.addon) notes.push(`The ReShade Vulkan layer on this PC (${vulkanLayer.dllPath || vulkanLayer.manifestPath}) has no add-on support. ${VULKAN_LAYER_INSTRUCTION}`);
    else if (vulkanLayer && !vulkanLayer.registered) notes.push(`ReShade is not installed as a Vulkan layer on this PC. ${VULKAN_LAYER_INSTRUCTION}`);
    else if (vulkanLayer && vulkanLayer.appListed === false) notes.push(VULKAN_APP_NOT_LISTED(exePath, vulkanLayer.appsPath));
    // A DirectX 9 game presented through DXVK: the Feeder's README makes dxvk.conf's allowFse the one
    // setting its DXVK route needs (configureDxvkConf); the deploy writes it, and this says so.
    const dxvk = dxvkWrapperFile(dir);
    if (dxvk) {
      const conf = readDxvkConf(dir);
      notes.push(conf.allowFse === 'false'
        ? `${dxvk} is DXVK, so this game renders through Vulkan; dxvk.conf has dxvk.allowFse = False, as the Feeder's DXVK route needs.`
        : `${dxvk} is DXVK, so this game renders through Vulkan. The Feeder's DXVK route needs dxvk.allowFse = False in dxvk.conf beside the exe -- Deploy writes it.`);
    }
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
    mvProvider,
    // A deploy whose motion-vector half cannot work is not "ready", however many files are in
    // place -- the whole route exists to feed DLSS motion, and this is the half that does it.
    mvProviderOk: mvBlocking.length === 0,
    depthProfile: (readFeederDeployMarker(dir) || {}).depthProfile || null,
    notes,
    complete: reshadeInstalled && addonInstalled && fxInstalled && headersInstalled && dlssInstalled && dlssnrInstalled
      && mvBlocking.length === 0,
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

// sha256: the digest the caller already has (a GitHub release asset's). Pinned URLs need none, and
// a GitHub release URL without one is looked up (integrity.js). A cached copy is re-checked when
// its hash is known without the network, so a file damaged in the cache is fetched again.
async function downloadToCache(url, cacheDir, fileName, ghHeaders, { sha256: given = null, fetchImpl = fetch } = {}) {
  const dest = path.join(cacheDir, fileName);
  if (fs.existsSync(dest)) {
    const known = integrity.pinFor(url) || given;
    if (!known || integrity.sha256(fs.readFileSync(dest)) === String(known).toLowerCase()) return dest;
    await fsp.rm(dest, { force: true });
  }
  const res = await fetchWithRetry(url, { headers: ghHeaders }, { fetchImpl });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  integrity.checkFinalUrl(url, res);
  const buf = Buffer.from(await res.arrayBuffer());
  const expected = await integrity.expectedSha256(url, { sha256: given, fetchImpl, headers: ghHeaders });
  integrity.verifyBuffer(buf, expected, fileName);
  await fsp.mkdir(cacheDir, { recursive: true });
  const tmp = dest + '.part';
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, dest);
  return dest;
}

function feederAssetFromRelease(release) {
  const asset = ((release && release.assets) || []).find((a) => FEEDER_ASSET_PATTERN.test(a.name));
  if (!asset) return null;
  return {
    url: asset.browser_download_url,
    name: asset.name,
    digest: integrity.digestFromAsset(asset),
    tag: release.tag_name,
    prerelease: !!release.prerelease,
  };
}

// The newest Feeder build this app should install. Stable by default; with allowPrerelease the
// release list is walked newest-first instead, skipping drafts and any release published without
// the zip, so one malformed release cannot break the deploy for everyone.
async function resolveFeederAsset(ghHeaders, { allowPrerelease = false, fetchImpl = fetch } = {}) {
  if (!allowPrerelease) {
    const res = await fetchWithRetry(FEEDER_RELEASES_API, { headers: ghHeaders }, { fetchImpl });
    if (!res.ok) throw new Error(`Could not check the DLSS5-Feeder release: HTTP ${res.status}`);
    const found = feederAssetFromRelease(await res.json());
    if (!found) throw new Error('No matching asset in the latest DLSS5-Feeder release');
    return found;
  }

  const res = await fetchWithRetry(FEEDER_RELEASES_LIST_API, { headers: ghHeaders }, { fetchImpl });
  if (!res.ok) throw new Error(`Could not list the DLSS5-Feeder releases: HTTP ${res.status}`);
  const releases = await res.json();
  if (!Array.isArray(releases)) throw new Error('Unexpected answer listing the DLSS5-Feeder releases');

  for (const release of releases) {
    if (!release || release.draft) continue;
    const found = feederAssetFromRelease(release);
    if (found) return found;
  }

  throw new Error('No DLSS5-Feeder release, pre-releases included, carries a matching asset');
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
// The layer's per-app switch. ReShade's Vulkan layer is loaded into every Vulkan process on the PC,
// and it attaches only to the exes its own installer listed in ReShadeApps.ini beside the manifest
// (its setup writes `Apps=<full exe path>,<...>` at the top of that file, no section header). For any
// other exe the layer stays inert: no overlay, no add-on, no dlss5-feed.log -- a game that was never
// run through ReShade's installer looks exactly like a layer that "did not load". The Feeder's own
// installer checks the same list and adds the exe under UAC; this app cannot write it (ProgramData),
// so the answer is a yes/no the readiness and Game Help can name. null when nothing to compare.
function reshadeAppsListing(manifestPath, exePath) {
  const appsPath = path.join(path.dirname(manifestPath), 'ReShadeApps.ini');
  let text;
  try { text = fs.readFileSync(appsPath, 'utf8').replace(/^﻿/, ''); } catch { return { appsPath, apps: null, listed: null }; }
  const line = text.split(/\r?\n/).find((l) => /^\s*Apps\s*=/i.test(l));
  const apps = line ? line.replace(/^\s*Apps\s*=/i, '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!exePath) return { appsPath, apps, listed: null };
  // Both sides normalised the same way. The entries used to be compared raw while the exe was
  // path.resolve'd, so an entry written with forward slashes, a `.\` segment or quotes never matched,
  // and a game that WAS on the list read as not listed -- which blocks Deploy (review of 2026-09-18).
  const norm = (p) => path.resolve(String(p).replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '').toLowerCase();
  const want = norm(exePath);
  const listed = apps.some((a) => { try { return norm(a) === want; } catch { return false; } });
  return { appsPath, apps, listed };
}

// bitness 32: the layer a 32-bit game loads. ReShade's setup registers ReShade32.json under
// HKLM\Software\Wow6432Node\Khronos\Vulkan\ImplicitLayers on a 64-bit Windows (setup/MainWindow.xaml.cs,
// v6.8.0), because that is the view a 32-bit Vulkan loader reads -- a 64-bit layer registration does
// nothing for it. Needed for a 32-bit DirectX 9 game swapped to DXVK (Assassin's Creed II, 2026-09-18).
async function vulkanLayerStatus({ execFileAsync, regQuery = null, exePath = null, bitness = 64 } = {}) {
  const out = { registered: false, manifestPath: null, dllPath: null, addon: false, hive: null, appsPath: null, appListed: null };
  const is32 = Number(bitness) === 32;
  const keyFor = (hive) => (is32 && hive === 'HKLM'
    ? `${hive}\\SOFTWARE\\WOW6432Node\\Khronos\\Vulkan\\ImplicitLayers`
    : `${hive}\\SOFTWARE\\Khronos\\Vulkan\\ImplicitLayers`);
  const query = regQuery || (execFileAsync
    ? async (hive) => (await execFileAsync('reg.exe', ['query', keyFor(hive)], { windowsHide: true })).stdout
    : null);
  if (!query) return out;
  const manifestRe = is32 ? /reshade32\.json\s+REG_DWORD/i : /reshade64\.json\s+REG_DWORD/i;
  for (const hive of ['HKLM', 'HKCU']) {
    let stdout = '';
    try { stdout = await query(hive); } catch { continue; }
    const line = (stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => manifestRe.test(l));
    if (!line) continue;
    const manifestPath = line.replace(/\s+REG_DWORD.*$/i, '').trim();
    out.registered = true;
    out.hive = hive;
    out.manifestPath = manifestPath;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const lib = manifest && manifest.layer && manifest.layer.library_path ? String(manifest.layer.library_path) : (is32 ? '.\\ReShade32.dll' : '.\\ReShade64.dll');
      out.dllPath = path.isAbsolute(lib) ? lib : path.resolve(path.dirname(manifestPath), lib);
      out.addon = isAddonReShadeDll(out.dllPath);
    } catch {}
    // A missing ReShadeApps.ini is not "not listed": an older ReShade setup, or a layer registered by
    // hand, has none and attaches everywhere. Only a list that exists and lacks the exe is a finding.
    const apps = reshadeAppsListing(manifestPath, exePath);
    out.appsPath = apps.apps ? apps.appsPath : null;
    out.appListed = apps.listed;
    return out;
  }
  return out;
}

const VULKAN_LAYER_INSTRUCTION = 'Run ReShade\'s installer, pick this game\'s exe, choose Vulkan and tick "Enable loading of add-ons" -- then deploy again.';
const VULKAN_APP_NOT_LISTED = (exePath, appsPath) => `ReShade's Vulkan layer is on this PC, but ${path.basename(exePath)} is not on its app list (${appsPath}), so the layer stays inert in this game and the Feeder never loads. ${VULKAN_LAYER_INSTRUCTION}`;

// layerWarnOnly: the background sync's re-deploy (main.js updateFeederIfStale). A Vulkan layer problem
// is machine-wide and needs the user at ReShade's installer, so on a sync it is reported as a warning
// and the rest of the update goes ahead -- throwing there aborted the whole add-on update for a reason
// the sync can do nothing about, and the sync's catch swallowed the message too (review, 2026-09-18).
async function deployReShade(dir, cacheDir, ghHeaders, { force = false, api = 'dx11', execFileAsync = null, exePath = null, layerWarnOnly = false, vulkanStatus = null } = {}) {
  const mode = reshadeModeForApi(api);

  if (mode === 'vulkan-layer') {
    // Machine-wide and shared: an add-on build already registered is used as it is (its
    // version does not matter to the Feeder). Anything else is the user's installer run --
    // the setup exe is cached so the button in the Edit dialog can open it for them.
    const status = vulkanStatus || await vulkanLayerStatus({ execFileAsync, exePath });
    if (status.registered && status.addon && status.appListed !== false) return { deployed: false, reason: 'add-on Vulkan layer already registered', file: status.dllPath, mode, manifestPath: status.manifestPath };
    const message = status.registered && status.addon
      ? VULKAN_APP_NOT_LISTED(exePath, status.appsPath)
      : status.registered
        ? `The ReShade Vulkan layer on this PC (${status.dllPath || status.manifestPath}) is a build without add-on support, so the Feeder would never load. ${VULKAN_LAYER_INSTRUCTION}`
        : `ReShade is not installed as a Vulkan layer on this PC. ${VULKAN_LAYER_INSTRUCTION}`;
    if (layerWarnOnly) return { deployed: false, reason: 'Vulkan layer needs the user', warning: message, mode, manifestPath: status.manifestPath };
    const setupPath = await downloadToCache(RESHADE_SETUP_URL, cacheDir, path.basename(RESHADE_SETUP_URL), ghHeaders);
    const err = new Error(message);
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
const RESHADE_SHADERS_MIRROR_RAW = integrity.URLS.reshadeShadersMirror;

async function fetchReShadeHeader(name, ghHeaders, { fetchImpl = fetch, pauses } = {}) {
  const init = { headers: { 'User-Agent': ghHeaders['User-Agent'] } };
  let lastError = null;
  for (const base of [RESHADE_SHADERS_REPO_RAW, RESHADE_SHADERS_MIRROR_RAW]) {
    try {
      const res = await fetchWithRetry(base + name, init, { fetchImpl, pauses });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status} for ${base + name}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      integrity.verifyBuffer(buf, integrity.pinFor(base + name), name);
      const text = buf.toString('utf8');
      // A host's error page is not a shader: the real file opens with ReShade's own guard.
      if (!/#pragma once|#ifndef|#define/.test(text.slice(0, 400))) { lastError = new Error(`${base + name} did not return a shader header`); continue; }
      return text;
    } catch (e) {
      // A mismatch is final, not a reason to try the mirror: both serve the same pinned commit.
      if (e && e.code === 'checksum-mismatch') throw e;
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
    const pinned = integrity.pinFor(RESHADE_SHADERS_REPO_RAW + name);
    if (cached && fs.existsSync(cached) && (!pinned || integrity.sha256(fs.readFileSync(cached)) === pinned)) {
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
async function deployFeederAddon(dir, cacheDir, ghHeaders, { force = false, allowPrerelease = false } = {}) {
  const addonDest = path.join(dir, 'dlss5-feed.addon64');
  const fxDest = path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx');
  if (fs.existsSync(addonDest) && fs.existsSync(fxDest) && !force) {
    return { deployed: false, reason: 'already present' };
  }

  const asset = await resolveFeederAsset(ghHeaders, { allowPrerelease });
  const zipPath = await downloadToCache(asset.url, cacheDir, asset.name, ghHeaders, { sha256: asset.digest });
  const zip = openZip(zipPath);

  const addonEntry = findEntry(zip, /(^|\/)dlss5-feed\.addon64$/i);
  if (!addonEntry) throw new Error('dlss5-feed.addon64 not found in the Feeder release');
  extractEntryTo(zip, addonEntry, addonDest);

  const fxEntry = findEntry(zip, /(^|\/)DLSS5_Feed\.fx$/i);
  if (!fxEntry) throw new Error('DLSS5_Feed.fx not found in the Feeder release');
  extractEntryTo(zip, fxEntry, fxDest);

  return { deployed: true, version: asset.tag };
}

// A GitHub source zip wraps everything in one folder named after the repo and ref
// (vort_Shaders-b410b9f0…/). Layout paths are written against the repo, so that wrapper has to
// come off; it is found rather than assumed, so a zip without one still works.
function zipTopPrefix(zip) {
  const first = zip.entries.map((e) => e.name.replace(/\\/g, '/')).find((n) => n.includes('/'));
  if (!first) return '';
  const top = first.slice(0, first.indexOf('/') + 1);
  return zip.entries.every((e) => e.name.replace(/\\/g, '/').startsWith(top)) ? top : '';
}

// The motion-vector provider shader. Only the auto-fetchable providers reach here -- LumeniteFX
// (deployLumeniteFx, consent) and iMMERSE Launchpad (bring-your-own, never fetched) are the
// caller's job to detect, not deploy.
//
// Returns every path it wrote, relative to the game's reshade-shaders\ folder, so the deploy
// marker can record exactly what to take back out later -- see removeFeederStack().
async function deployMvProvider(dir, providerId, cacheDir, ghHeaders) {
  const provider = MV_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown motion-vector provider: ${providerId}`);
  if (!provider.autoFetchable) {
    throw new Error(`${provider.displayName} is not auto-fetchable (${provider.license}) -- install it yourself, then re-check readiness.`);
  }

  const rootDir = path.join(dir, 'reshade-shaders');
  const zipName = `${providerId}.zip`;
  const zipPath = await downloadToCache(provider.zipUrl, cacheDir, zipName, ghHeaders);
  const zip = openZip(zipPath);
  const deployedFiles = [];

  // A provider whose shader resolves its own includes by path (VORT: #include "Includes/…")
  // needs its folder structure kept, and may need textures as well as shaders -- so the entry
  // describes where each piece goes instead of everything being flattened into Shaders\.
  if (provider.layout) {
    const top = zipTopPrefix(zip);
    const byName = new Map(zip.entries.map((e) => [e.name.replace(/\\/g, '/'), e]));
    for (const item of provider.layout) {
      if (item.fromDir) {
        const prefix = `${top}${item.fromDir}/`;
        const matched = [...byName.entries()].filter(([name]) => name.startsWith(prefix) &&
          !name.endsWith('/') && (!item.match || item.match.test(name)));
        if (matched.length === 0) throw new Error(`${provider.displayName}'s zip has nothing under ${item.fromDir}`);
        for (const [name, entry] of matched) {
          const rel = `${item.to}/${name.slice(prefix.length)}`;
          extractEntryTo(zip, entry, path.join(rootDir, ...rel.split('/')));
          deployedFiles.push(rel);
        }
        continue;
      }
      const entry = byName.get(`${top}${item.from}`);
      // Only the licence copy is allowed to be absent: it is courtesy, not a dependency, and a
      // repo that renames LICENSE must not fail a deploy over it. Anything else missing means
      // the pinned layout no longer matches the source, which is a real error, not a warning.
      if (!entry) {
        if (/licen[cs]e/i.test(item.from)) continue;
        throw new Error(`${provider.displayName}'s zip has no ${item.from}`);
      }
      extractEntryTo(zip, entry, path.join(rootDir, ...item.to.split('/')));
      deployedFiles.push(item.to);
    }
    return { deployed: true, files: deployedFiles };
  }

  // Flat providers: .fx AND .fxh -- a provider repo's .fx commonly #includes sibling .fxh files
  // (found the hard way: JakobPCoder/ReshadeMotionEstimation ships MotionEstimation.fx alongside
  // MotionEstimation.fxh/MotionEstimationUI.fxh/MotionVectors.fxh, and compilation fails on the
  // missing includes if only the .fx is extracted).
  const shaderEntries = zip.entries.filter((e) => /\.fxh?$/i.test(e.name));
  if (!shaderEntries.some((e) => /\.fx$/i.test(e.name))) {
    throw new Error(`No .fx files found in ${provider.displayName}'s zip`);
  }
  for (const entry of shaderEntries) {
    const rel = `Shaders/${path.basename(entry.name)}`;
    extractEntryTo(zip, entry, path.join(rootDir, ...rel.split('/')));
    deployedFiles.push(rel);
  }
  return { deployed: true, files: deployedFiles };
}

// LumeniteFX Kernel -- the ONLY path that ever fetches it, and only with real, per-action
// consent. Deliberately separate from deployMvProvider(): that function's autoFetchable guard
// exists precisely so nothing generic ever reaches this licence by accident. Fetches every
// file individually and live from LUMENITEFX_REPO_RAW (the official repo, not a cache/mirror)
// on every call -- see the licence note on MV_PROVIDERS['lumenite-kernel'] for why that's not
// just tidiness, it's the actual condition the licence sets for redistribution.
// fetchImpl is for tests, which must never reach the network; the app passes nothing, so every
// real call is a live fetch from the official repo, as the licence requires.
async function deployLumeniteFx(dir, ghHeaders, { licenseConfirmed = false, fetchImpl = fetch } = {}) {
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
    const res = await fetchImpl(LUMENITEFX_REPO_RAW + relPath, { headers: { 'User-Agent': ghHeaders['User-Agent'] } });
    if (!res.ok) throw new Error(`Could not fetch ${relPath} from LumeniteFX's official repo: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    integrity.verifyBuffer(buf, integrity.pinFor(LUMENITEFX_REPO_RAW + relPath), relPath);
    const dest = path.join(shaderDir, ...relPath.split('/'));
    await fsp.writeFile(dest, buf);
    // reshade-shaders-relative, same as deployMvProvider's, so the deploy marker's mvFiles list
    // means one thing whichever provider wrote it.
    deployed.push(`Shaders/${relPath}`);
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
  // DLSS5_MV_PROVIDER goes in at both levels ReShade reads for this preset: the per-effect
  // [DLSS5_Feed.fx] section and the preset's own root list. Per-effect wins where both exist, so
  // setting it alone is enough for a preset this app wrote -- but a preset the user already had
  // can carry a root-level DLSS5_MV_PROVIDER of its own, and the two then disagree the moment
  // someone reloads effects from the overlay (which re-reads the root list). Writing both keeps
  // the answer the same from either direction. The Feeder calls a provider mismatch its "classic
  // silent failure": the shader compiles for one provider while a different technique is enabled,
  // and no vectors reach DLSS.
  for (const section of ['DLSS5_Feed.fx', '']) {
    const cur = getIniKey(next, section, 'PreprocessorDefinitions');
    const parts = cur ? cur.split(',').map((s) => s.trim()).filter((s) => s && !/^DLSS5_MV_PROVIDER\s*=/i.test(s)) : [];
    parts.push(`DLSS5_MV_PROVIDER=${provider.mvProviderValue}`);
    next = setIniKey(next, section, 'PreprocessorDefinitions', parts.join(','));
  }

  fs.writeFileSync(presetPath, next, 'utf8');
  return { configured: true, mvProviderValue: provider.mvProviderValue };
}

// Depth is where a Unity game quietly fails. The Feeder reads ReShade's depth buffer through the
// Generic Depth add-on, and if that buffer is the wrong one -- cleared, UI-only, flipped or
// reversed -- the feed still runs, DLSS still evaluates, the log still says "frame N delivered",
// and the result is a picture that reconstructs from nothing. The Feeder's own troubleshooting
// calls this "depth probe says sampled depth is flat" and offers no automatic guess.
//
// Two profiles, and the difference between them is how much is engine truth:
//
//   unity            Engine truth for Unity on D3D11/D3D12, so it is what an install writes by
//                    itself: Unity renders reversed-Z (UNITY_REVERSED_Z on every D3D target),
//                    which the shaders learn from RESHADE_DEPTH_INPUT_IS_REVERSED, and it clears
//                    the depth buffer between the scene and its UI pass, so the copy has to be
//                    taken before clears (DepthCopyBeforeClears=1 is exactly "Copy depth buffer
//                    before clear operations" in the add-on's own UI, generic_depth_addon.cpp).
//                    Gap-filling only: a value someone already chose on the Generic Depth page
//                    is left alone.
//
//   unity-verified   The one Unity profile a human has actually confirmed end to end: the
//                    Feeder's README carries it as the Subnautica profile (64-bit D3D11 Unity,
//                    contributor-verified at 4K with DLAA + neural rendering). It picks a
//                    specific clear index and aspect-ratio heuristic and declares the depth
//                    upside down as well as reversed -- choices that are about how that game
//                    draws, not about Unity as such, which is why it is an explicit action in
//                    Edit ("the depth looks flat") rather than something an install assumes.
//                    Forced, not gap-filled: it is a profile, and half of one is not it.
//
// Anything beyond these two is ReShade's own Add-ons -> Generic Depth page, which lists the real
// buffers the running game has and is the only thing that can settle a stubborn case.
const DEPTH_PROFILES = {
  unity: {
    force: false,
    depth: { DepthCopyBeforeClears: '1' },
    defines: { RESHADE_DEPTH_INPUT_IS_REVERSED: '1' },
  },
  'unity-verified': {
    force: true,
    depth: {
      DepthCopyAtClearIndex: '1',
      DepthCopyBeforeClears: '2',
      DrawStatsHeuristic: '0',
      FilterFormat: '0',
      UseAspectRatioHeuristics: '3',
    },
    defines: {
      RESHADE_DEPTH_LINEARIZATION_FAR_PLANE: '1000.0',
      RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN: '1',
      RESHADE_DEPTH_INPUT_IS_REVERSED: '1',
      RESHADE_DEPTH_INPUT_IS_LOGARITHMIC: '0',
    },
  },
};

function depthProfileIds() {
  return Object.keys(DEPTH_PROFILES);
}

// ReShade's own setup can seed a recursive search path as `Shaders\**\**`. Windows rejects the
// unresolved wildcard directory with ERROR_INVALID_NAME, so the runtime finds no effects at all
// while every .fx file is sitting right there -- a failure that looks exactly like a bad deploy.
// (DLSS5-Swapper hit this and documents it; the collapse below is the same fix.) This also keeps
// the user's own search locations instead of overwriting the list, which is what this function
// used to do: someone with their own shader collection lost it from the list on every deploy.
function mergeSearchPath(current, required) {
  const canonical = (item) => String(item || '').trim().replace(/\//g, '\\').replace(/(?:\\\*\*){2,}$/g, '\\**');
  const base = (item) => canonical(item).replace(/\\\*\*$/, '').replace(/\\+$/, '').toLowerCase();
  const wanted = base(required);
  const kept = String(current || '').split(',').map(canonical).filter(Boolean).filter((item) => base(item) !== wanted);
  return [required, ...kept].join(',');
}

// ReShade.ini: everything that has to be true for the add-on to load, the shaders to be found and
// the preset to be applied. A fresh ReShade64.dll deploy has no ini yet; an existing one (the user
// already had ReShade for other effects) is merged into, never replaced.
function configureReShadeIni(dir, {
  effectSearchPaths = '.\\reshade-shaders\\Shaders\\**',
  textureSearchPaths = '.\\reshade-shaders\\Textures\\**',
  unity = false,
  depthProfile = null,
} = {}) {
  const iniPath = path.join(dir, 'ReShade.ini');
  const existing = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, 'utf8') : '';
  let next = existing;
  next = setIniKey(next, 'ADDON', 'AddonPath', '.\\');
  next = setIniKey(next, 'GENERAL', 'EffectSearchPaths',
    mergeSearchPath(getIniKey(next, 'GENERAL', 'EffectSearchPaths'), effectSearchPaths));
  // Textures, not just shaders: VORT's motion estimation declares a texture with
  // `source = "vort_BlueNoise.png"`, and ReShade only resolves that through TextureSearchPaths.
  // Without this the shader fails to compile and the Feeder has no motion vectors -- the same
  // silent failure as a missing include, one directory over.
  next = setIniKey(next, 'GENERAL', 'TextureSearchPaths',
    mergeSearchPath(getIniKey(next, 'GENERAL', 'TextureSearchPaths'), textureSearchPaths));
  if (!getIniKey(next, 'GENERAL', 'PresetPath')) next = setIniKey(next, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');

  // NoReloadOnInit=1 tells ReShade not to compile effects when it initialises. Nothing then
  // compiles until someone opens the overlay and asks -- so the Feeder's technique never runs,
  // and a game launched normally shows no sign of anything. A user's own ReShade install can
  // carry it; it is not compatible with this route, so it goes to 0.
  if (getIniKey(next, 'GENERAL', 'NoReloadOnInit')) next = setIniKey(next, 'GENERAL', 'NoReloadOnInit', '0');
  // A startup preset overrides the preset ReShade would otherwise load, which is the one this
  // deploy just wrote the Feeder's techniques into. Cleared only when it points somewhere else --
  // if it already names our own preset there is nothing to fix.
  const startup = getIniKey(next, 'GENERAL', 'StartupPresetPath');
  const preset = getIniKey(next, 'GENERAL', 'PresetPath') || '.\\ReShadePreset.ini';
  if (startup && startup.trim() && startup.trim().toLowerCase() !== preset.trim().toLowerCase()) {
    next = setIniKey(next, 'GENERAL', 'StartupPresetPath', '');
  }
  // ReShade remembers add-ons someone switched off, by name, and honours that on every launch.
  // A deploy that leaves dlss5-feed in this list installs a feed that never loads and says
  // nothing about why. Only our own add-on is taken off the list; anything else the user
  // disabled stays disabled.
  const disabled = getIniKey(next, 'ADDON', 'DisabledAddons');
  if (disabled && /dlss5-feed/i.test(disabled)) {
    const kept = disabled.split(',').map((s) => s.trim()).filter((s) => s && !/dlss5-feed/i.test(s));
    next = setIniKey(next, 'ADDON', 'DisabledAddons', kept.join(','));
  }

  const profile = DEPTH_PROFILES[depthProfile] || (unity ? DEPTH_PROFILES.unity : null);
  if (profile) {
    for (const [key, value] of Object.entries(profile.depth)) {
      if (profile.force || !getIniKey(next, 'DEPTH', key)) next = setIniKey(next, 'DEPTH', key, value);
    }
    const cur = getIniKey(next, 'GENERAL', 'PreprocessorDefinitions');
    let defs = cur ? cur.split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const [name, value] of Object.entries(profile.defines)) {
      const already = defs.findIndex((d) => new RegExp(`^${name}\\s*=`, 'i').test(d));
      if (already === -1) defs.push(`${name}=${value}`);
      else if (profile.force) defs[already] = `${name}=${value}`;
    }
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
  return { configured: true, depthProfile: depthProfile || (unity ? 'unity' : null) };
}

// DXVK in front of a DirectX 9/10/11 game: the Direct3D DLL beside the exe is DXVK's, and the game
// reaches the GPU through Vulkan. Star Wars: The Old Republic (2026-09-16) is the case: a 64-bit
// DirectX 9 game the player runs through DXVK's d3d9.dll, so ReShade is the Vulkan layer and the
// Feeder's Vulkan transport carries the frame. The Feeder's README gives that route for exactly this
// shape ("A 64-bit D3D9 game has a second route ... put DXVK in front of it instead") with one
// setting to it: `dxvk.allowFse = False` in dxvk.conf, "the only setting that mattered" on its
// user-confirmed DXVK games. Exclusive fullscreen is what it turns off -- ReShade's overlay, the
// Feeder's cast panel and the present it feeds from all need the swapchain DXVK builds without it.
// The same literal detect.js reads (its HOOK_NEEDLES); a copy here keeps feeder.js off detect.js.
const DXVK_WRAPPER_NAMES = ['d3d9.dll', 'dxgi.dll', 'd3d11.dll', 'd3d10core.dll'];
const DXVK_CONF = 'dxvk.conf';

function dxvkWrapperFile(dir) {
  for (const name of DXVK_WRAPPER_NAMES) {
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      const buf = fs.readFileSync(p);
      if (buf.includes(Buffer.from('DXVK', 'latin1')) && !buf.includes(Buffer.from('ReShade', 'latin1'))) return name;
    } catch {}
  }
  return null;
}

// dxvk.conf: `key = value` lines, `#` comments, no sections. Read for the one key this route cares
// about (lower-cased value, or null when the file or key is absent).
function readDxvkConf(dir) {
  let text = null;
  try { text = fs.readFileSync(path.join(dir, DXVK_CONF), 'utf8'); } catch {}
  const m = text && /^\s*dxvk\.allowFse\s*=\s*([^#\r\n]*)/im.exec(text);
  return { exists: text !== null, allowFse: m ? m[1].trim().toLowerCase() || null : null };
}

// Sets dxvk.allowFse = False, keeping everything else in the file. Returns what was there before so
// Remove can put it back: { added: the file did not exist, previous: the key's old value or null }.
// What the deploy marker keeps for Remove: the first deploy's record (a re-deploy sees its own value),
// and { untouched: true } when the conf already had the setting, so Remove does not take away a line
// that was the player's own (restoreDxvkConf).
function dxvkConfRecord(dxvkResult, previousMarker) {
  if (!dxvkResult) return null;
  if (previousMarker && previousMarker.dxvkConf) return previousMarker.dxvkConf;
  if (dxvkResult.untouched) return { untouched: true };
  return { added: dxvkResult.added, previous: dxvkResult.previous };
}

// The exact two lines this app writes. Restore matches these verbatim and nothing looser, so a line
// the player wrote themselves -- even one that says the same thing -- is never taken for ours.
const DXVK_CONF_LINE = 'dxvk.allowFse = False';
const DXVK_CONF_COMMENT = '# DLSS5 Feeder through ReShade\'s Vulkan layer: no exclusive fullscreen (OptiDLSS5-UI)';

// Sets dxvk.allowFse = False, keeping everything else in the file. Returns what was there before so
// Remove can put it back: { added: the file did not exist, previous: the key's old value or null }.
// A conf that already had it off is left alone and says so (untouched), so Remove leaves it alone too.
function configureDxvkConf(dir) {
  const confPath = path.join(dir, DXVK_CONF);
  const before = readDxvkConf(dir);
  if (before.allowFse === 'false') return { configured: false, untouched: true, file: DXVK_CONF, added: false, previous: 'false' };
  let text = '';
  try { text = fs.readFileSync(confPath, 'utf8'); } catch {}
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const at = lines.findIndex((l) => /^\s*dxvk\.allowFse\s*=/i.test(l));
  if (at !== -1) lines[at] = DXVK_CONF_LINE;
  else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(DXVK_CONF_COMMENT);
    lines.push(DXVK_CONF_LINE);
  }
  fs.writeFileSync(confPath, lines.join(eol) + eol, 'utf8');
  return { configured: true, file: DXVK_CONF, added: !before.exists, previous: before.allowFse };
}

// The reverse, from what the deploy recorded: a file this app created goes, a key it changed goes
// back to its old value in place, a key it added is taken out. A file the user has since edited past
// that point keeps everything else it holds.
//
// Only ever this app's own line. The first cut removed any `dxvk.allowFse = false` it found, so a
// player whose dxvk.conf already had exclusive fullscreen off -- a deploy that changed nothing --
// lost their own setting on Remove (review of 2026-09-18). A record that says untouched, or the
// older marker shape for the same case (previous 'false'), now restores nothing.
function restoreDxvkConf(dir, record) {
  if (!record || record.untouched || record.previous === 'false') return false;
  const confPath = path.join(dir, DXVK_CONF);
  let text;
  try { text = fs.readFileSync(confPath, 'utf8'); } catch { return false; }
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const at = lines.indexOf(DXVK_CONF_LINE);
  const commentAt = lines.indexOf(DXVK_CONF_COMMENT);
  if (at === -1 && commentAt === -1) return false;
  if (at !== -1) {
    if (record.previous) lines[at] = `dxvk.allowFse = ${record.previous === 'true' ? 'True' : record.previous}`;
    else lines[at] = null;
  }
  if (commentAt !== -1) {
    lines[commentAt] = null;
    // The blank line configureDxvkConf put before its comment goes with it.
    if (commentAt > 0 && lines[commentAt - 1] !== null && lines[commentAt - 1].trim() === '') lines[commentAt - 1] = null;
  }
  const rest = lines.filter((l) => l !== null);
  if (record.added && rest.every((l) => l.trim() === '')) {
    fs.rmSync(confPath, { force: true });
    return true;
  }
  while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
  fs.writeFileSync(confPath, rest.join(eol) + eol, 'utf8');
  return true;
}

// dlss5-feed.cfg: the add-on's own settings, plain `key=value` lines with no sections. The Feeder
// writes the whole file when the user changes something in its panel and reads only the keys that
// are present, defaulting the rest -- so a file holding one key is valid and everything else stays
// at the Feeder's own defaults.
//
// Only `cast_key` is set here, and only when nobody has chosen one. It is the virtual-key code that
// shows and hides the DLSS 5 panel inside the game, and it ships as 0, meaning "no key": out of the
// box the panel can only be summoned by finding "Show the DLSS 5 panel in-game" in ReShade's add-on
// tab, which is exactly the step players never discover. VK_HOME (0x24) makes it Alt+Home, the same
// chord as the engine's own panel on the 64-bit routes, so there is one thing to tell players
// whatever route their game takes.
//
// Alt+Home rather than Home because ReShade's own overlay is Home with no modifier and matches its
// modifiers exactly. Holding Alt reaches the cast and leaves ReShade's overlay shut -- opening that
// overlay is what broke the panel for Luma users before.
//
// `cast_mods` is why Alt gets there. Up to Feeder 1.16.0-beta.5 the cast matched the bare virtual key
// and ignored modifiers, so cast_key alone was enough and Alt came free. beta.6 (jlrouzies-fr/
// DLSS5-Feeder#118, 2026-09-20) makes the match exact in BOTH directions: with cast_mods absent or 0
// the bare key toggles and Alt+Home does not. Writing the modifier keeps Alt+Home working -- which is
// what every route text, the engine's panel and the docs tell players, on every route -- and it is
// safe on older builds, which read only the keys they know and default the rest.
//
// 1 = Alt, 2 = Ctrl, 4 = Shift, added together.
const CAST_KEY_HOME = 0x24;
const CAST_MODS_ALT = 1;

function setLine(lines, key, value) {
  const at = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`, 'i').test(line));
  if (at !== -1) lines[at] = `${key}=${value}`;
  else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(`${key}=${value}`);
  }
}

// Games that have to be left in EXCLUSIVE FULLSCREEN, because the dgVoodoo2 keys that would make them
// borderless black-screen them instead. legacy.js reads this same list to decide to write a minimal
// dgVoodoo.conf, so the two halves of the decision cannot drift apart.
//
// The consequence lands here: the compositor cast cannot draw over an exclusive-fullscreen swapchain,
// so on such a game the helper starts windowless and dlss5-feed.log says "the in-game panel is
// unavailable this session". host_window=3 keeps the helper's window even when the swapchain reports
// fullscreen (Feeder #118), and cast_mode=1 brings the panel in as a texture drawn by the game's own
// ReShade, which works in exclusive fullscreen (cast_mode=0, the compositor thumbnail, does not).
//
// Assassin's Creed II, confirmed 2026-09-21: minimal conf + these two = picture, DLSS 5, and Alt+Home
// opens the panel.
const FULLSCREEN_ONLY_EXES = ['AssassinsCreedIIGame.exe'];

function needsFullscreenHost(dir) {
  return FULLSCREEN_ONLY_EXES.some((exe) => {
    try { return fs.existsSync(path.join(dir, exe)); } catch { return false; }
  });
}

function configureFeedCfg(dir, { castKey = CAST_KEY_HOME, castMods = CAST_MODS_ALT } = {}) {
  const cfgPath = path.join(dir, 'dlss5-feed.cfg');
  const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const at = lines.findIndex((line) => /^\s*cast_key\s*=/i.test(line));
  const hasMods = lines.some((line) => /^\s*cast_mods\s*=/i.test(line));

  // Before anything to do with the cast key, because these have to land even on an install whose key
  // the user chose themselves -- without them that user simply has no panel. Neither is overwritten
  // if it is already in the file: both are settings someone may have a reason to have changed.
  let extra = false;
  if (needsFullscreenHost(dir)) {
    if (!lines.some((line) => /^\s*host_window\s*=/i.test(line))) { setLine(lines, 'host_window', 3); extra = true; }
    if (!lines.some((line) => /^\s*cast_mode\s*=/i.test(line))) { setLine(lines, 'cast_mode', 1); extra = true; }
  }

  if (at !== -1) {
    const current = Number(String(lines[at]).split('=')[1]);
    // A key the user picked in the Feeder's own panel is theirs; only "none" is ours to fill in.
    if (Number.isFinite(current) && current > 0) {
      // ... except for the one upgrade the beta.6 change forces. An install this app made before
      // cast_mods existed carries our own Home with no modifier line, and on beta.6 that means the
      // cast answers to a BARE Home -- the very chord that opens ReShade's overlay instead. The
      // modifier is added only when the key is still the one we wrote and nobody has set mods of
      // their own; a user who chose their own key or their own modifiers is left alone entirely.
      if (current === CAST_KEY_HOME && !hasMods) {
        setLine(lines, 'cast_mods', castMods);
        fs.writeFileSync(cfgPath, `${lines.join('\n')}\n`, 'utf8');
        return { configured: true, castKey: current, castMods, kept: true };
      }
      if (extra) fs.writeFileSync(cfgPath, `${lines.join('\n')}\n`, 'utf8');
      return { configured: extra, castKey: current, kept: true };
    }
    lines[at] = `cast_key=${castKey}`;
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(`cast_key=${castKey}`);
  }
  if (!hasMods) setLine(lines, 'cast_mods', castMods);

  fs.writeFileSync(cfgPath, `${lines.join('\n')}\n`, 'utf8');
  return { configured: true, castKey, castMods, kept: false };
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
async function feederUpdateCheck(dir, ghHeaders, { allowPrerelease = false } = {}) {
  const marker = readFeederDeployMarker(dir);
  if (!marker || !marker.feederVersion) {
    return { checked: false, reason: feederDeployed(dir) ? 'deployed before update-checking existed -- deploy again once to start tracking' : 'not deployed yet' };
  }

  const latest = await resolveFeederAsset(ghHeaders, { allowPrerelease });
  return {
    checked: true,
    currentVersion: marker.feederVersion,
    latestVersion: latest.tag,
    latestIsPrerelease: !!latest.prerelease,
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
async function deployFeederStack(dir, api, providerId, { cacheDir, getRhiManifest, compareVersions, ghHeaders, force = false, licenseConfirmed = false, unity = false, depthProfile = null, execFileAsync = null, allowPrerelease = false, exePath = null, layerWarnOnly = false }) {
  const results = {};
  results.reshade = await deployReShade(dir, cacheDir, ghHeaders, { force, api, execFileAsync, exePath, layerWarnOnly });
  results.reshadeMode = results.reshade.mode || reshadeModeForApi(api);
  results.commonHeaders = await deployReShadeCommonHeaders(dir, ghHeaders, { force, cacheDir });
  results.addon = await deployFeederAddon(dir, cacheDir, ghHeaders, { force, allowPrerelease });

  const provider = MV_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown motion-vector provider: ${providerId}`);
  if (provider.selectable === false) {
    // Nothing in the UI offers DRME any more, but a saved per-game choice or an old caller could
    // still name it. Refusing here rather than deploying a shader that cannot compile is the
    // whole point of the change -- the readiness report says the same thing in the user's words.
    throw new Error(`${provider.displayName} cannot be used: ${provider.unsupportedReason}`);
  }
  // Switching provider: the one that was here goes first. configurePreset() below stops the old
  // technique being enabled, but its files would otherwise stay in the shader folder for good --
  // ReShade would go on compiling them, and a later Remove works from the marker, which records
  // one provider. Never for a bring-your-own provider: those files are the user's own install.
  const outgoingMarker = readFeederDeployMarker(dir);
  if (outgoingMarker && outgoingMarker.mvProviderId && outgoingMarker.mvProviderId !== providerId) {
    const outgoing = MV_PROVIDERS[outgoingMarker.mvProviderId];
    if (outgoing && !outgoing.bringYourOwn) {
      // What the deploy recorded, or -- for a marker written before mvFiles existed -- that
      // provider's own static list. The fallback is the case that actually bites: every game
      // deployed before v1.57.0 carries DRME, whose marker has no file list, so a re-deploy with
      // VORT used to leave MotionEstimation.fx sitting there. ReShade then compiles it on every
      // launch and fails ("error X3020 ... cannot sample from texture that is also used as render
      // target"), which is both the noise that made DRME unusable and a second provider in the
      // folder for the Feeder's own "which one is enabled" check to trip over.
      const stale = (Array.isArray(outgoingMarker.mvFiles) && outgoingMarker.mvFiles.length)
        ? outgoingMarker.mvFiles
        : (outgoing.files || []).map((f) => `Shaders/${f}`);
      for (const rel of stale) {
        await fsp.rm(path.join(dir, 'reshade-shaders', ...rel.split('/')), { force: true }).catch(() => {});
      }
    }
  }
  if (provider.bringYourOwn) {
    // Never fetched (see the licence note on the provider). Either the user's own copy is in the
    // game's shader folder and this is just a preset/definition change, or there is nothing to
    // point at and saying so beats writing a preset that names a technique nobody has.
    if (!mvProviderPresent(dir, providerId)) {
      throw new Error(`${provider.displayName}: ${provider.techniqueFile} is not in this game's ` +
        'reshade-shaders\\Shaders folder. Install it there yourself (this app cannot redistribute ' +
        'it), or pick VORT, which it can fetch.');
    }
    results.mvProvider = { deployed: false, bringYourOwn: true, files: [] };
  } else if (provider.autoFetchable) {
    results.mvProvider = await deployMvProvider(dir, providerId, cacheDir, ghHeaders);
  } else {
    results.mvProvider = await deployLumeniteFx(dir, ghHeaders, { licenseConfirmed });
  }

  results.dlss = await deployNvngxDlss(dir, getRhiManifest, compareVersions, cacheDir, ghHeaders);
  results.ini = configureReShadeIni(dir, { unity, depthProfile });
  results.preset = configurePreset(dir, providerId);
  // DXVK in front of the game (dxvkWrapperFile): the README's one dxvk.conf setting for this route.
  const previousMarker = readFeederDeployMarker(dir);
  const dxvk = dxvkWrapperFile(dir);
  results.dxvk = dxvk ? { wrapper: dxvk, ...configureDxvkConf(dir) } : null;
  // What Remove has to undo: the first deploy's record, since a re-deploy sees its own value.
  const dxvkConf = dxvkConfRecord(results.dxvk, previousMarker);

  // The addon step only resolves the release tag when it actually deploys (fresh install, or
  // force). On a "already present, skip" run there's nothing fresh to record -- keep whatever
  // the marker already said rather than losing the version history feederUpdateCheck needs.
  const feederVersion = results.addon.version || (previousMarker && previousMarker.feederVersion) || null;
  if (feederVersion) {
    // placedNvngxDlss: whether THIS app put nvngx_dlss.dll here (as opposed to skipping one
    // already present) -- removeFeederStack() only takes back what was placed.
    const placedNvngxDlss = results.dlss.deployed || !!(previousMarker && previousMarker.placedNvngxDlss);
    // mvFiles: every path the provider step wrote, reshade-shaders-relative. The static per-
    // provider `files` list can only describe a flat provider; VORT writes into Shaders\Includes\
    // and Textures\, and removal has to know exactly which of those files are ours rather than
    // guessing at a folder the user may also keep their own shaders in.
    const mvFiles = (results.mvProvider && results.mvProvider.files && results.mvProvider.files.length)
      ? results.mvProvider.files
      : (previousMarker && previousMarker.mvProviderId === providerId ? previousMarker.mvFiles : null) || [];
    writeFeederDeployMarker(dir, {
      feederVersion,
      mvProviderId: providerId,
      mvFiles,
      depthProfile: results.ini.depthProfile,
      placedNvngxDlss,
      reshadeMode: results.reshadeMode,
      dxvkConf,
      deployedAt: new Date().toISOString(),
    });
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
  for (const rel of ['DLSS5_Feed.fx', ...RESHADE_COMMON_HEADERS]) await rm(path.join(shaderDir, ...rel.split('/')));

  // The provider's own files. What this deploy actually wrote is recorded in the marker
  // (reshade-shaders-relative), and that is what comes back out -- a folder like Shaders\Includes\
  // can hold the user's own shader packs too, so nothing is removed by folder. The static per-
  // provider lists are the fallback for a deploy made before the marker carried mvFiles, and
  // every provider's list is tried there because the old marker may not say which was used.
  const mvFiles = (marker && Array.isArray(marker.mvFiles) && marker.mvFiles.length)
    ? marker.mvFiles
    : Object.values(MV_PROVIDERS).flatMap((p) => p.files.map((f) => `Shaders/${f}`));
  for (const rel of mvFiles) await rm(path.join('reshade-shaders', ...rel.split('/')));

  // Only the folders the deploy created, and only once nothing else is left in them. Deepest
  // first, so a folder emptied by the level below it can go in the same pass.
  for (const rel of [path.join(shaderDir, 'include'), path.join(shaderDir, 'Includes'), shaderDir,
    path.join('reshade-shaders', 'Textures'), path.join('reshade-shaders', 'Licenses'), 'reshade-shaders']) {
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
  // DXVK's dxvk.conf: only the allowFse line this deploy wrote (or the file, when it made it) goes.
  if (marker && marker.dxvkConf && restoreDxvkConf(dir, marker.dxvkConf)) removed.push(marker.dxvkConf.added ? DXVK_CONF : `${DXVK_CONF} (dxvk.allowFse line)`);

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

// Which depth profile this game's last deploy wrote, so a re-deploy keeps it rather than
// silently dropping back to the engine default (feeder.js's DEPTH_PROFILES).
function feederDepthProfile(dir) {
  const marker = readFeederDeployMarker(dir);
  return (marker && marker.depthProfile) || null;
}

module.exports = {
  MV_PROVIDERS,
  downloadToCache,
  reshadeModeForApi,
  feederReShadeMode,
  feederDepthProfile,
  vulkanLayerStatus,
  isAddonReShadeDll,
  isReShadeDll,
  RESHADE_SETUP_URL,
  mvProviderList,
  defaultMvProviderId,
  mvProviderPresent,
  feederProviderStatus,
  depthProfileIds,
  needsFeeder,
  feederDeployed,
  feederReadiness,
  feederUpdateCheck,
  readFeederDeployMarker,
  removeFeederStack,
  deployReShade,
  deployReShadeCommonHeaders,
  deployFeederAddon,
  deployMvProvider,
  deployLumeniteFx,
  deployNvngxDlss,
  configurePreset,
  configureReShadeIni,
  configureFeedCfg,
  needsFullscreenHost,
  FULLSCREEN_ONLY_EXES,
  CAST_KEY_HOME,
  dxvkWrapperFile,
  readDxvkConf,
  configureDxvkConf,
  restoreDxvkConf,
  dxvkConfRecord,
  deployFeederStack,
  fetchWithRetry,
  fetchReShadeHeader,
  resolveFeederAsset,
};
