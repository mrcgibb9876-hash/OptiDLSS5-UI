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
const amdnr = require('./amdnr');

// A user's per-game API choice laid over the detection result: the chosen API becomes the
// primary, joins the list of APIs the game runs on (so keepGamesOwnDlss writes its upscaler key
// too), and an "old API only" verdict is lifted, since the user is saying a modern path exists.
// Pure so it can be tested; main.js reads the marker and calls this.
const API_OVERRIDE_VALUES = ['dx11', 'dx12', 'vulkan'];

function withApiOverride(detected, override) {
  const base = detected || {};
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

function optiScalerInstalled(dir) {
  return fs.existsSync(path.join(dir, 'OptiScaler.ini')) && fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll'));
}

function recommendRoute(dir, exePath, detected = {}, gpuVendor = 'unknown') {
  const api = detected.api || null;
  const feederDeployed = feeder.feederDeployed(dir);
  const lumaDeployed = lumaue.lumaUeDeployed(dir);
  const optiInstalled = optiScalerInstalled(dir);
  // needsFeeder() is exactly the inverse of hasNativeDlss() in main.js (same three files), and
  // flips the moment a Feeder or Luma deploy places nvngx_dlss.dll -- hence the two markers.
  const shippedDlss = !feeder.needsFeeder(dir) && !feederDeployed && !lumaDeployed;

  const finish = (route, label, reason, steps, reasonVars = null) => {
    const next = steps.find((s) => !s.done) || null;
    return {
      route, label, reason, reasonVars, steps, gpuVendor,
      optiInstalled, feederDeployed, lumaDeployed,
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

  if (shippedDlss) {
    return finish('optiscaler', 'OptiScaler',
      'This game ships its own DLSS, so OptiScaler only adds Neural Rendering on top of it (the DLSS 5 only ' +
      'profile) -- just Install. Frame Generation: the game\'s own DLSS Frame Generation in its video settings.',
      [{ key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled }]);
  }

  if (lumaue.isFallenOrder(exePath) || lumaDeployed) {
    return finish('lumaue', 'OptiScaler + Luma UE',
      'No DLSS of its own. Luma UE replaces its stock TAA with DLAA, which gives OptiScaler a real DLSS call to ' +
      'hook. Install OptiScaler here, then deploy Luma UE from Edit (it needs your licence confirmation). ' +
      'Frame Generation: Lossless Scaling.',
      [
        { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
        { key: 'lumaue', label: 'Deploy Luma UE (Edit)', done: lumaDeployed },
      ]);
  }

  if (feederDeployed || api === 'dx11' || api === 'dx12') {
    return finish('feeder', 'OptiScaler + Feeder',
      'No DLSS of its own, so OptiScaler alone would have nothing to hook. The DLSS5 Feeder synthesises the DLSS ' +
      'call from ReShade\'s depth and motion vectors; Install deploys it first, then OptiScaler. ' +
      'Frame Generation: Lossless Scaling.',
      [
        { key: 'feeder', label: 'Deploy the DLSS5 Feeder', done: feederDeployed },
        { key: 'optiscaler', label: 'Install OptiScaler', done: optiInstalled },
      ]);
  }

  if (api === 'vulkan') {
    return finish('unsupported', 'Not supported yet',
      'No DLSS of its own, and it runs on Vulkan. The DLSS5 Feeder is a ReShade add-on, which only works on ' +
      'DX11/DX12 -- Vulkan needs a layer this app does not deploy yet.', []);
  }

  return finish('unknown', 'Undetermined',
    'No DLSS of its own, and its graphics API could not be detected yet -- the DLSS5 Feeder route needs DX11 or ' +
    'DX12. For a Unity game, run it once and this is re-checked from its Player.log.', []);
}

module.exports = { recommendRoute, optiScalerInstalled, withApiOverride, API_OVERRIDE_VALUES };
