// Which install route a game should take, in one answer the card can show as a tag and the
// Install button can act on. Every rule here already exists somewhere else in the app -- the
// DLSS 5 only profile (hasNativeDlss in main.js), the Feeder gate (feeder.needsFeeder), the Luma
// gate (lumaue.isFallenOrder), the API support table (feeder.feederReadiness) -- but a user only
// ever met them one at a time, as a section that appeared or refused in the Edit dialog after
// they had already clicked Install on the card. This puts the decision first:
//
//   optiscaler   The game ships its own DLSS. OptiScaler adds Neural Rendering on top of it (the
//                DLSS 5 only profile) and nothing else is needed. Frame Generation is the game's
//                own DLSS Frame Generation.
//   feeder       No DLSS of its own, DX11/DX12. A bare OptiScaler install would have no DLSS call
//                to hook, so the DLSS5 Feeder has to be deployed first. Install on the card does
//                both, in that order. Frame Generation is Lossless Scaling.
//   lumaue       Fallen Order specifically: no DLSS of its own, Luma UE supplies the DLSS call.
//                Luma needs a per-action licence confirmation, so Install only does the OptiScaler
//                half and the card says what is still to do. Frame Generation is Lossless Scaling.
//   unsupported  Nothing here can hook it: an old-API-only game (DX9/DX10/OpenGL), or a no-DLSS
//                Vulkan game (the Feeder is a ReShade add-on, which needs DX11/DX12).
//   unknown      No DLSS of its own and the API could not be detected, so it is not yet clear
//                whether the Feeder can run here.
//   amdnr        This machine runs an AMD card. None of the routes above produce Neural
//                Rendering there (OptiScaler's NR pass needs NVIDIA's NGX runtime); the only
//                route is danielblnc's DLSS-NR-on-AMD, which replaces our stack rather than
//                joining it -- see amdnr.js. DX12 games only; anything else is unsupported on
//                AMD, and Intel has no NR route at all. OptiScaler itself still installs on any
//                GPU (its upscaler swap and FSR frame gen are vendor-neutral), so the button
//                stays, with a warning.
//
// "Ships its own DLSS" means the game had it before this app touched the folder: both the Feeder
// and Luma deploys place nvngx_dlss.dll into a game that had none, and their deploy markers are
// what keeps those games on their own route afterwards. Same trap, same guard, as
// autoConfigureGame's isFeederGame and losslessEligibility in main.js.
//
// Pure disk checks plus the detection result the renderer already caches per game (games.json,
// detectedPath) -- deliberately no exe scan of its own, since this runs for every card on every
// grid render and detectGame streams the whole executable.

const path = require('node:path');
const fs = require('node:fs');

const feeder = require('./feeder');
const lumaue = require('./lumaue');
const { readFileVersion } = require('./detect');
const amdnr = require('./amdnr');
const nativeDlss = require('./native-dlss');
const verified = require('./verified');
const reengine = require('./reengine');
const presentroute = require('./presentroute');
const legacy = require('./legacy');
const rtxmfg = require('./rtxmfg');

// A user's per-game API choice laid over the detection result: the chosen API becomes the
// primary, joins the list of APIs the game runs on (so keepGamesOwnDlss writes its upscaler key
// too), and an "old API only" verdict is lifted, since the user is saying a modern path exists.
// Pure so it can be tested; main.js reads the marker and calls this.
const API_OVERRIDE_VALUES = ['dx11', 'dx12', 'vulkan', 'opengl'];
const API_NAMES = { dx12: 'DX12', dx11: 'DX11', vulkan: 'Vulkan', opengl: 'OpenGL', dx9: 'DX9', dx8: 'DX8', dx10: 'DX10' };

// The experimental routes' words, as fixed templates so the renderer can translate them; the parts
// that vary are placeholders filled from reasonVars.
const ROUTE_TEXT = {
  labelHost32: 'OptiScaler + Feeder (32-bit)',
  labelDx9: 'OptiScaler + Feeder (DX9)',
  stepDgVoodoo: 'Put dgVoodoo2 in front of the game',
  stepFeeder32: 'Deploy the 32-bit Feeder and its 64-bit helper with OptiScaler',
  // How to reach OptiScaler on this route, in the add-on's own words. Photographed on a live
  // install 2026-09-14: "OptiScaler has its own menu with every neural-rendering control ... It
  // opens with Insert in the host window: press 'Show the DLSS 5 panel in-game' above and then
  // Insert, or run with host_window=1." Alt+Home is the DLSS 5 panel's key inside OptiScaler; it
  // is Insert that opens OptiScaler in the helper, and this text said Alt+Home until then.
  host32Panel:
    'Nothing appears in the game itself -- no OptiScaler splash when it loads, no menu on any key -- because ' +
    'OptiScaler is in that helper, which has no window of its own. To reach it: Home opens ReShade in the game, ' +
    'Add-ons -> DLSS 5 Feed, press "Show the DLSS 5 panel in-game", then Insert. The add-on\'s Toggle key starts as ' +
    '"none", so set one there if you want it back without opening ReShade each time. Windowed or borderless; ' +
    '"Show as texture (fullscreen too)" is the Feeder\'s option for exclusive fullscreen.',
  host32Lead:
    'Experimental. A 32-bit game cannot run DLSS in its own process -- NVIDIA ships no 32-bit version -- so the DLSS5 ' +
    'Feeder\'s 32-bit add-on sends each frame to its 64-bit helper beside the game, and OptiScaler runs Neural Rendering ' +
    'there. ',
  emulator:
    'Experimental. {name} emulates {system} and makes no DLSS call, so the DLSS5 Feeder synthesises one inside it, for ' +
    'every game it runs. Set its renderer first ({hint}) and pick the same API in Edit if it is not {api}. Depth is the ' +
    'weak point: ReShade often cannot see the console game\'s depth buffer inside an emulator, and Neural Rendering has ' +
    'less to work with then. The DLSS 5 panel (Alt+Home) opens over the emulator\'s window as in any game.',
  emulatorVulkan:
    'Experimental. {name} emulates {system} and makes no DLSS call, so the DLSS5 Feeder synthesises one inside it, for ' +
    'every game it runs. Set its renderer first ({hint}) and pick the same API in Edit if it is not {api}. Depth is the ' +
    'weak point: ReShade often cannot see the console game\'s depth buffer inside an emulator, and Neural Rendering has ' +
    'less to work with then. On Vulkan, ReShade runs as its machine-wide Vulkan layer (ReShade\'s own installer, with ' +
    'add-on support), and NVIDIA Smooth Motion must be off. The DLSS 5 panel (Alt+Home) opens over the emulator\'s ' +
    'window as in any game.',
  emulatorOpenGl:
    'Experimental. {name} emulates {system} and makes no DLSS call, so the DLSS5 Feeder synthesises one inside it, for ' +
    'every game it runs. Set its renderer first ({hint}) and pick the same API in Edit if it is not {api}. Depth is the ' +
    'weak point: ReShade often cannot see the console game\'s depth buffer inside an emulator, and Neural Rendering has ' +
    'less to work with then. On OpenGL, ReShade goes in as the emulator\'s opengl32.dll -- but OptiScaler cannot draw ' +
    'over OpenGL, so the DLSS 5 panel (Alt+Home) will not appear; use the emulator\'s Direct3D or Vulkan renderer ' +
    'if it has one.',
  dx9:
    'Experimental. DirectX 9 has no Feeder path of its own, so dgVoodoo2 turns it into DirectX 11, ' +
    'then the DLSS5 Feeder synthesises the DLSS call and OptiScaler ' +
    'runs Neural Rendering. The DLSS 5 panel (Alt+Home) opens over the game as usual. If dgVoodoo2 crashes the game, ' +
    'this route is not for it yet.',
};

// A game that offers both DX12 and DX11 is set up for DX12, with no choice offered (the user's call,
// 2026-09-15: fewer decisions, and DX12 is where every DLSS 5 route works best). The one thing that
// outranks it is proof: OptiScaler's own log saying the game really ran on DX11 last time
// (runtimeApi) -- configuring DX12 for a game that is running DX11 would break its route, and it is
// what an emulator switched to Direct3D 11 on Game Help's advice has to follow.
function preferDx12(base) {
  const apis = base.apis || [];
  if (!apis.includes('dx12') || !apis.includes('dx11') || base.api === 'dx12' || base.runtimeApi === 'dx11') return base;
  if (base.api !== 'dx11') return base;
  return { ...base, api: 'dx12', apis: ['dx12', ...apis.filter((a) => a !== 'dx12')], detectedApi: base.api };
}

// `opts.luma`: the game has a Luma route (a DLSS-adding Luma mod matched or deployed, lumaue.js). Luma is a
// DirectX 11 framework, so for those games the most compatible API wins instead of DX12: DX11 whenever the
// game offers it (the user's call, 2026-09-15).
function withApiOverride(detected, override, opts = {}) {
  const raw = detected || {};
  if (opts.luma && (raw.apis || []).includes('dx11')) {
    const apis = ['dx11', ...(raw.apis || []).filter((a) => a !== 'dx11')];
    return { ...raw, api: 'dx11', apis, apiOverride: null, detectedApi: raw.api || null, lumaApi: true };
  }
  const base = preferDx12(raw);
  // An old DX11 choice on a game that has DX12 no longer applies.
  if (override === 'dx11' && (base.apis || []).includes('dx12') && base.runtimeApi !== 'dx11') override = null;
  if (!override || !API_OVERRIDE_VALUES.includes(override)) return { ...base, apiOverride: null };
  const apis = [override, ...(base.apis || []).filter((a) => a !== override)];
  return {
    ...base,
    api: override,
    apis,
    recommend: base.recommend === 'unsupported' ? 'optiscaler' : base.recommend,
    apiOverride: override,
    detectedApi: base.api || null,
  };
}

// The payload, and something sitting in a slot the game will actually load from.
//
// The payload alone used to be the whole test, so a folder holding OptiScaler.ini and the NR model
// with no proxy at all passed it, and the card said "Install OptiScaler: done" about an install
// that could never load. Not hypothetical: an install whose proxy step failed, or one that adopted
// a proxy somebody else had put there, leaves exactly that shape -- a user's DOOM 3 BFG, where the
// DLL in the slot turned out to be an upstream OptiScaler (2026-09-13).
//
// Presence only, deliberately. Whether that DLL is OptiScaler at all, and whether it is OURS, needs
// the file read: detect.js does it (inspectHookDlls -> optiScalerProxy) and Game Help reports it.
// This runs for every card on every render and stays a handful of existsSync calls.
const PROXY_SLOTS = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll', 'd3d12.dll', 'wininet.dll',
  'winhttp.dll', 'OptiScaler.asi'];

function optiScalerInstalled(dir) {
  if (!fs.existsSync(path.join(dir, 'OptiScaler.ini')) || !fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'))) return false;
  // RTXMFG (rtxmfg.js) can sit in one of these slots; it is not an OptiScaler proxy.
  const rtxmfgFile = (rtxmfg.ourFile(dir) || '').toLowerCase();
  return PROXY_SLOTS.some((name) => name.toLowerCase() !== rtxmfgFile && fs.existsSync(path.join(dir, name)));
}

// The route runs for every card on every render; a DLL's version only changes with the file.
const dllVersionCache = new Map();
function dllVersionCached(file) {
  let key = file;
  try { const st = fs.statSync(file); key = `${file}|${st.size}|${st.mtimeMs}`; } catch { return null; }
  if (!dllVersionCache.has(key)) {
    if (dllVersionCache.size > 256) dllVersionCache.clear();
    dllVersionCache.set(key, readFileVersion(file));
  }
  return dllVersionCache.get(key);
}

// opts.lumaMod: the Luma-Framework catalog entry matched for this game's names (main.js lumaModFor), or null.
function recommendRoute(dir, exePath, detected = {}, gpuVendor = 'unknown', opts = {}) {
  const api = detected.api || null;
  const feederDeployed = feeder.feederDeployed(dir);
  const lumaDeployed = lumaue.lumaUeDeployed(dir);
  // The experimental legacy routes (legacy.js): a 32-bit game's OptiScaler lives in host64\, and
  // DX8/DX9 need dgVoodoo2 in front of the game.
  const legacyStatus = legacy.status(dir);
  const optiInstalled = optiScalerInstalled(dir) || (detected.bitness === 32 && legacyStatus.hostOptiScaler);
  // shipsNativeDlss: the game's own Streamline/DLSS files (beside the exe or in an Unreal
  // plugin tree) -- evidence no deploy of ours can fake, so it wins over the markers. Otherwise
  // needsFeeder() is the inverse of hasNativeDlss() and flips the moment a Feeder or Luma
  // deploy places nvngx_dlss.dll -- hence the two markers.
  const shipsDlss = nativeDlss.shipsNativeDlss(dir);
  const shippedDlss = shipsDlss || (!feeder.needsFeeder(dir) && !feederDeployed && !lumaDeployed);
  // A Feeder on a game that ships DLSS: an older version of this app could not see DLSS kept
  // under an Unreal plugin folder and deployed it anyway. The two crash together.
  const feederMisdeployed = shipsDlss && feederDeployed;

  const finish = (route, label, reason, steps, reasonVars = null, extra = {}) => {
    const next = steps.find((s) => !s.done) || null;
    return {
      experimental: false, emulator: null, legacy: null, dgVoodooDeployed: legacyStatus.dgVoodoo,
      ...extra,
      route, label, reason, reasonVars, steps, gpuVendor,
      optiInstalled, feederDeployed, lumaDeployed, feederMisdeployed,
      verified: verified.verification(exePath),
      complete: steps.length > 0 && !next,
      nextStep: next ? next.label : null,
    };
  };

  // Vendor first: on a non-NVIDIA card the NVIDIA-stack routes below all end in an install that
  // runs but renders nothing new, whatever the game's own DLSS situation is.
  if (gpuVendor === 'amd') {
    const gate = amdnr.amdNrEligibility(gpuVendor, api);
    if (!gate.supported && detected.recommend !== 'unsupported' && api) {
      return finish('unsupported', 'No NR route on AMD',
        `${gate.reason} OptiScaler still installs here for its upscaler swap, but its Neural Rendering needs an NVIDIA GPU.`, [],
        gate.reasonVars || null);
    }
    if (gate.supported) {
      const st = amdnr.amdNrStatus(dir);
      return finish('amdnr', 'DLSS NR on AMD',
        'This is an AMD card: OptiScaler\'s own Neural Rendering needs NVIDIA\'s NGX runtime, so the route here is ' +
        'danielblnc\'s DLSS-NR-on-AMD instead (alpha; DX12 game running FSR 3/4, Windows 11, Adrenalin 26.1.1+, ' +
        'no anti-cheat). Get its installer from the official release page, run it in this game\'s folder, and ' +
        'put the plain 310.8.0 nvngx_dlssnr.dll beside it -- Edit fetches that file for you.',
        [
          { key: 'amdnr-tool', label: 'Get DLSS NR on AMD from its release page and run its installer in this folder (Edit)', done: st.toolPresent },
          { key: 'amdnr-model', label: 'Fetch nvngx_dlssnr.dll 310.8.0 into the game folder (Edit)', done: st.nrDllPresent },
        ]);
    }
  } else if (gpuVendor === 'intel') {
    if (detected.recommend !== 'unsupported' && api) {
      return finish('unsupported', 'No NR route on Intel',
        'Neural Rendering needs an NVIDIA GPU (or an AMD RX 7000/9000 via DLSS-NR-on-AMD). OptiScaler still installs ' +
        'here for its upscaler swap, but its Neural Rendering pass will not run.', []);
    }
  }

  if (detected.recommend === 'unsupported') {
    return finish('unsupported', 'Not supported',
      `${detected.reason || 'This game only uses a graphics API OptiScaler cannot hook (DX9/DX10/OpenGL).'}`, []);
  }

  if (feederMisdeployed) {
    return finish('optiscaler', 'OptiScaler',
      'This game ships its own DLSS, but the DLSS5 Feeder was deployed here too (an older version of this app ' +
      'could not see DLSS kept under an Unreal plugin folder). The two crash together -- remove the Feeder from ' +
      'Edit, then OptiScaler alone adds Neural Rendering on top of the game\'s own DLSS.',
      [
        { key: 'feeder-remove', label: 'Remove the DLSS5 Feeder (Edit)', done: false },
        { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
      ]);
  }

  // EXPERIMENTAL -- 32-bit games (legacy.js). NVIDIA ships no 32-bit NGX, so the Feeder's 32-bit
  // add-on hands each frame to its 64-bit helper in host64\, where OptiScaler runs Neural
  // Rendering. D3D8/D3D9 go through dgVoodoo2 first. Install does all of it.
  if (detected.bitness === 32) {
    const plan = legacy.planFor({ bitness: 32, api });
    if (!plan.supported) {
      return finish('unsupported', 'Not supported', `32-bit executable: ${plan.reason}.`, []);
    }
    const steps = [];
    if (plan.dgVoodoo) steps.push({ key: 'dgvoodoo', label: ROUTE_TEXT.stepDgVoodoo, done: legacyStatus.dgVoodoo });
    steps.push({ key: 'feeder32', label: ROUTE_TEXT.stepFeeder32, done: legacyStatus.host32 && legacyStatus.feeder32 && legacyStatus.hostOptiScaler });
    const middle = plan.dgVoodoo
      ? '{dx} has no Feeder path of its own, so dgVoodoo2 turns it into DirectX 11 first. '
      : plan.api === 'opengl' ? 'On OpenGL, ReShade goes in as the game\'s opengl32.dll. ' : '';
    const text = ROUTE_TEXT.host32Lead + middle + ROUTE_TEXT.host32Panel;
    return finish('feeder32', ROUTE_TEXT.labelHost32, text, steps,
      { dx: plan.api === 'dx8' ? 'DirectX 8' : 'DirectX 9' }, { experimental: true, legacy: plan });
  }

  // EXPERIMENTAL -- emulators (emulators.js): the ordinary Feeder route, run inside the emulator, with
  // the one thing detection cannot know said up front: which renderer it is set to.
  if (detected.emulator) {
    const emu = detected.emulator;
    const text = api === 'vulkan' ? ROUTE_TEXT.emulatorVulkan : api === 'opengl' ? ROUTE_TEXT.emulatorOpenGl : ROUTE_TEXT.emulator;
    return finish('feeder', 'OptiScaler + Feeder', text,
      [
        { key: 'feeder', label: 'Deploy the DLSS5 Feeder', done: feederDeployed },
        { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
      ],
      { name: emu.name, system: emu.system, hint: emu.hint, api: API_NAMES[api] || String(api || '').toUpperCase() },
      { experimental: true, emulator: emu });
  }

  // EXPERIMENTAL -- a 64-bit DirectX 9 game: dgVoodoo2's x64 D3D9.dll turns it into DirectX 11, and
  // from there it is the ordinary 64-bit Feeder route.
  if (api === 'dx9') {
    const plan = legacy.planFor({ bitness: 64, api });
    return finish('feeder', ROUTE_TEXT.labelDx9, ROUTE_TEXT.dx9,
      [
        { key: 'dgvoodoo', label: ROUTE_TEXT.stepDgVoodoo, done: legacyStatus.dgVoodoo },
        { key: 'feeder', label: 'Deploy the DLSS5 Feeder', done: feederDeployed },
        { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
      ], null, { experimental: true, legacy: plan });
  }

  // Resident Evil 2/3/4/7/Village: RE Engine, no DLSS of their own. Not the Feeder -- praydog's
  // pd-upscaler REFramework build has a TemporalUpscaler that makes a real DLSS call from the
  // engine's own motion vectors and jitter (reengine.js; what RHI does for these five). Three
  // files: the pd build (Install fetches it), nvngx_dlss.dll (Install places it), and PureDark's
  // Upscaler Base Plugin, which the user fetches from Nexus themselves. Before the shipped-DLSS
  // branch on purpose: the nvngx_dlss.dll Install places here would otherwise read as the game's
  // own. A Feeder already on disk keeps the Feeder route, since someone chose it.
  //
  // Not gated on shipsDlss: these five ship no Streamline or DLSS at all, so any found beside the
  // exe is another tool's leftover. A user's RE2 folder (2026-09-12) held a full Streamline 2.x set
  // with `.original` backups from an earlier DLSS 5 tool; that read as "ships its own DLSS", sent
  // the game down the plain OptiScaler route ("just Install"), and hid the PDPerfPlugin.dll step
  // and its Game Help -- OptiScaler then waited for a DLSS call RE2 never makes.
  //
  // Since the engine's Present route (2026-09-14) none of those files is the route any more: DLSS 5 runs at
  // Present over the game's own TAA and the engine finds the depth itself, so Install needs no plugin and
  // no DLSS DLL -- one step. The route id stays 'reframework-pd' so a game's saved state still matches.
  //
  // The same route covers Devil May Cry 5 and Street Fighter 6 (reengine.presentRouteGame). A Feeder this
  // app deployed on one of them is not someone's choice but the old route, and sync removes it -- so it
  // does not hold the game on the Feeder route; one deployed by hand still does.
  const pd = reengine.pdStatus(dir, exePath);
  const presentGame = reengine.presentRouteGame(exePath);
  const feederIsOurs = feederDeployed && fs.existsSync(path.join(dir, '.dlss5ui-feeder-deploy.json'));
  if (presentGame && (!feederDeployed || feederIsOurs)) {
    const reframeworkPresent = pd ? pd.reframeworkPresent : fs.existsSync(path.join(dir, 'dinput8.dll'));
    const temporalUpscalerOn = pd ? pd.temporalUpscalerOn : reengine.temporalUpscalerOn(dir);
    return finish('reframework-pd', 'OptiScaler + REFramework',
      'No DLSS of its own. DLSS 5 runs at the end of each frame on top of the game\'s own anti-aliasing, and ' +
      'OptiScaler finds the game\'s depth itself -- nothing to download by hand. Install places OptiScaler and ' +
      'REFramework and keeps REFramework\'s TemporalUpscaler off. Load a save: menus have no depth to work with.',
      [
        { key: 'optiscaler', label: 'Install OptiScaler (and REFramework)', done: optiInstalled && reframeworkPresent && !temporalUpscalerOn && !feederDeployed },
      ]);
  }

  // Elden Ring, Armored Core VI, Nightreign (presentroute.js): the same Present route, switched on in
  // OptiScaler.ini rather than by REFramework. The Feeder crashed the model on this engine, so it is the old
  // route here too -- one this app deployed goes on sync, one placed by hand keeps the game on the Feeder.
  if (presentroute.iniPresentGame(exePath) && (!feederDeployed || feederIsOurs)) {
    return finish('present', 'OptiScaler',
      'No DLSS of its own. DLSS 5 runs at the end of each frame on top of the game\'s own anti-aliasing, and ' +
      'OptiScaler finds the game\'s depth itself -- no Feeder, nothing to download by hand. Install places ' +
      'OptiScaler. Load a save: menus have no depth to work with.',
      [{ key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled && !feederDeployed }]);
  }

  // A Luma-Framework mod that adds DLSS to this game (lumacatalog.js, matched by name in main.js) beats both
  // the Feeder's estimated call and a native DLSS too old for Neural Rendering -- Monster Hunter: World
  // ships DLSS 1.1.13. A game with DLSS 2 or newer of its own keeps it.
  const lumaMod = opts.lumaMod || null;
  const nativeDlssPath = shipsDlss ? nativeDlss.shippedDlssPath(dir) : null;
  const nativeVersion = nativeDlssPath ? dllVersionCached(nativeDlssPath) : null;
  const nativeMajor = nativeVersion ? parseInt(nativeVersion.split('.')[0], 10) : null;
  const nativeTooOld = shipsDlss && nativeMajor !== null && nativeMajor < 2 && !lumaDeployed;
  const lumaWanted = lumaDeployed || (lumaue.isLumaUeDefault(exePath, lumaMod) && (!shipsDlss || nativeTooOld));

  if (shippedDlss && !lumaWanted) {
    return finish('optiscaler', 'OptiScaler',
      'This game ships its own DLSS, so OptiScaler only adds Neural Rendering on top of it (the DLSS 5 only ' +
      'profile) -- just Install. Frame Generation: the game\'s own DLSS Frame Generation in its video settings.',
      [{ key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled }]);
  }

  if (lumaWanted) {
    const profile = lumaue.deployedProfile(dir) || lumaue.lumaProfileFor(exePath, detected, lumaMod);
    if (profile && profile.catalog) {
      if (feederDeployed && !lumaDeployed) {
        return finish('feeder', 'OptiScaler + Feeder',
          'The DLSS5 Feeder deployed here is doing the job, but Luma-Framework has a mod for this game that adds real ' +
          'DLSS with the game\'s own motion vectors -- better than the Feeder\'s estimate. Game Help switches it over.',
          [
            { key: 'feeder', label: 'Deploy the DLSS5 Feeder', done: true },
            { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
          ], null, { lumaAvailable: true });
      }
      return finish('lumaue', 'OptiScaler + Luma',
        (nativeTooOld
          ? 'This game\'s own DLSS ({version}) is too old for Neural Rendering. '
          : 'No DLSS of its own. ') +
        'Luma-Framework\'s mod for it adds real DLSS with the game\'s own motion vectors, which gives OptiScaler a ' +
        'DLSS call to hook. Install sets up OptiScaler and Luma (after you confirm Luma\'s licence). Luma needs ' +
        'DirectX 11: pick it in the game\'s settings and turn the game\'s own DLSS off. The app switches DLSS on in Luma ' +
        'for you.',
        [
          { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
          { key: 'lumaue', label: 'Deploy Luma', done: lumaDeployed },
        ], { version: nativeVersion || '' }, { experimental: profile.status !== 'working', lumaMod: lumaMod ? lumaMod.key : (profile.id || null) });
    }
  }

  if (lumaWanted) {
    // Luma UE is this game's preferred DLSS source, but a Feeder already deployed here is a
    // working one (confirmed on a real install: frames fed, NR running) -- the card says what is
    // actually in place and names the better option, rather than reporting a done setup as a
    // missing step. Luma's own readiness refuses while the Feeder is on, so the order is fixed.
    if (feederDeployed && !lumaDeployed) {
      return finish('feeder', 'OptiScaler + Feeder',
        'No DLSS of its own; the DLSS5 Feeder deployed here is doing that job. Luma UE is the alternative for ' +
        'this game (it replaces the stock TAA with real DLAA, so no estimated motion vectors): remove the Feeder ' +
        'in Edit first, then deploy Luma UE there. Frame Generation: Lossless Scaling.',
        [
          { key: 'feeder', label: 'Deploy the DLSS5 Feeder', done: true },
          { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
        ]);
    }
    // Prey (2017) gets Luma's own Prey mod (lumaue.js LUMA_PROFILES.prey): real DLSS with the engine's
    // motion vectors, better than anything the Feeder can estimate.
    if (lumaue.isPrey2017(exePath)) {
      return finish('lumaue', 'OptiScaler + Luma',
        'No DLSS of its own. Luma\'s Prey mod adds real DLSS with the game\'s own motion vectors and depth, which ' +
        'gives OptiScaler a DLSS call to hook. Install sets up OptiScaler and Luma (after you confirm Luma\'s licence) ' +
        'and switches DLSS on in Luma for you.',
        [
          { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
          { key: 'lumaue', label: 'Deploy Luma', done: lumaDeployed },
        ]);
    }
    return finish('lumaue', 'OptiScaler + Luma UE',
      'No DLSS of its own. Luma UE replaces its stock TAA with DLAA, which gives OptiScaler a real DLSS call to ' +
      'hook. Install OptiScaler here, then deploy Luma UE from Edit (it needs your licence confirmation). ' +
      'Frame Generation: Lossless Scaling.',
      [
        { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
        { key: 'lumaue', label: 'Deploy Luma UE (Edit)', done: lumaDeployed },
      ]);
  }

  // The Feeder runs on all four APIs. On Vulkan and OpenGL the DLSS evaluate still happens on
  // a private D3D12 device; what differs is how ReShade gets into the game (feeder.js,
  // reshadeModeForApi) -- and on Vulkan, NVIDIA Smooth Motion has to be off for the game.
  if (feederDeployed || api === 'dx11' || api === 'dx12' || api === 'vulkan' || api === 'opengl') {
    const how = api === 'vulkan'
      ? ' On Vulkan, ReShade runs as its machine-wide Vulkan layer (ReShade\'s own installer, with add-on support), ' +
        'and NVIDIA Smooth Motion must be off for this game.'
      : api === 'opengl'
        ? ' On OpenGL, ReShade goes in as the game\'s opengl32.dll.'
        : '';
    return finish('feeder', 'OptiScaler + Feeder',
      'No DLSS of its own, so OptiScaler alone would have nothing to hook. The DLSS5 Feeder synthesises the DLSS ' +
      'call from ReShade\'s depth and motion vectors; Install deploys it first, then OptiScaler.' + how +
      ' Frame Generation: Lossless Scaling.',
      [
        { key: 'feeder', label: 'Deploy the DLSS5 Feeder', done: feederDeployed },
        { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
      ]);
  }

  return finish('unknown', 'Undetermined',
    'No DLSS of its own, and its graphics API could not be detected yet -- the DLSS5 Feeder route needs to know ' +
    'whether this is DX11, DX12, Vulkan or OpenGL. For a Unity game, run it once and this is re-checked from its ' +
    'Player.log; otherwise choose the API in Edit.', []);
}

module.exports = { recommendRoute, optiScalerInstalled, withApiOverride, API_OVERRIDE_VALUES, ROUTE_TEXT };
