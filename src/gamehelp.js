// Game Help, tier one: a rule table from what the app already knows about a game -- detection,
// the recommended route and what is deployed, the last run's verdict from the logs, other
// toolchains, the registry -- to one finding and, where one exists, one fix the app can apply
// itself. Deterministic and offline; every rule has a test. Language-free: it returns a code
// and variables, the renderer turns those into words.
//
// Statuses: ok (DLSS 5 ran), fix (the app can do something), step (the user has to do
// something in-game), needs-run (no log yet), unavailable (DLSS 5 cannot work here, with the
// reason), unknown (no rule fits -- the support bundle, or the AI tier, is the next step).
//
// Fix ids are what main.js's game:help-apply knows how to run: remove-foreign, remove-feeder,
// remove-luma, redeploy-feeder, feeder-depth-profile, disable-agility-redist, reconfigure,
// remove-all (the card's Remove, after a confirmation).
// 'install' is the card's own Install button, run by the renderer.
//
// fixesTried: what the renderer already applied this session, as { id, runAt } (runAt: the
// last run's timestamp when the fix ran; a bare id string means "judge it now"). A fix that
// changes settings only shows on the next run, and the old log still says what it said -- so
// while run.at is unchanged the same rule answers "needs a run", not "the fix failed".

function diagnose(ctx) {
  const d = ctx.detected || {};
  const route = ctx.route || {};
  const run = ctx.run || { ran: false, verdict: 'no-log' };
  const runAt = run.at || null;
  const tried = new Set();
  const pending = new Set();
  for (const e of ctx.fixesTried || []) {
    if (typeof e === 'string') tried.add(e);
    else if (e && e.id) ((e.runAt || null) === runAt ? pending : tried).add(e.id);
  }
  const foreign = ctx.foreign || [];

  const out = (status, code, vars = {}) => ({ status, code, vars, fix: null });
  const fix = (code, id, vars = {}) => {
    if (pending.has(id)) return out('needs-run', 'needs-run-after-fix', { ...vars, fix: id, code });
    if (tried.has(id)) return out('unknown', 'fix-failed', { ...vars, fix: id, code });
    return { status: 'fix', code, vars, fix: { id } };
  };

  // Hard stops first: nothing the app deploys can run in these. A 32-bit game has an experimental
  // route now (legacy.js); only one that route cannot serve (32-bit Vulkan) is a stop.
  if (d.bitness === 32 && route.route !== 'feeder32') return out('unavailable', 'bit32');
  // Anti-cheat with no way past it is still a hard stop. Anti-cheat the game is *launched through*
  // is not: that stub can be stepped around (detect.js's antiCheatStub; game:launch does it, after
  // asking), so the route stays open and the trade -- no online play, and a ban risk for going
  // online anyway -- is the user's to make. The card shows the anti-cheat warning either way.
  if (d.antiCheat && !d.protectedLauncher) return out('unavailable', 'anticheat', { antiCheat: d.antiCheat });
  if (route.route === 'unsupported') return out('unavailable', 'unsupported', { reason: route.reason || '' });

  // Two stacks on one DLSS call crash before anything else can be judged.
  if (foreign.length) return fix('foreign', 'remove-foreign', { tool: foreign.map((f) => f.tool).join(', ') });
  // The driver says DLSS 5 cannot run on it. No file in the game folder changes that, so it goes
  // before every per-folder finding -- otherwise the user fixes those first and still gets nothing.
  if (run.ran && run.verdict === 'driver-outdated') {
    return out('step', 'driver-outdated', { min: run.detail || '', current: run.driverVersion || '' });
  }
  // A second OptiScaler, under a proxy name, that is not the build this app installed. It is the
  // one the game loads and the one that answers the NGX calls -- so an upstream build there means
  // no neural pass, whatever this app has put beside it. Nothing here deletes another tool's DLL
  // without being asked, so this is the user's move, with the file named.
  const otherOpti = d.optiScalerProxy;
  if (otherOpti && otherOpti.file && otherOpti.matchesOurBuild === false) {
    return out('step', 'foreign-optiscaler', { file: otherOpti.file });
  }
  if (route.feederMisdeployed) return fix('feeder-misdeployed', 'remove-feeder');
  if (route.lumaDeployed && ctx.lumaKnownBad) return fix('luma-known-bad', 'remove-luma', { reason: ctx.lumaKnownBad });

  // Not installed, or the route's first step is missing: Install is the fix.
  if (!route.optiInstalled) return fix('not-installed', 'install');
  if (route.route === 'feeder' && !route.feederDeployed) return fix('feeder-missing', 'install');

  // A Feeder whose motion-vector half cannot work is a finding now, before any run: the shader is
  // missing, the preset and the shader name different providers, or -- for every game deployed
  // before v1.57.0 -- the provider is DRME, which cannot compile on the ReShade this app installs
  // and therefore writes no vectors at all. Waiting for a run would only rediscover it slowly.
  const mv = ctx.mvProvider;
  if (route.feederDeployed && mv && mv.id && (mv.broken || !mv.shaderPresent || mv.valueMismatch || mv.techniqueMismatch)) {
    const why = mv.broken ? 'broken' : !mv.shaderPresent ? 'missing' : 'mismatched';
    return fix('feeder-mv-broken', 'redeploy-feeder', { provider: mv.displayName || mv.id, why });
  }
  // The experimental legacy routes: dgVoodoo2 or the 32-bit helper still to place. Install does both.
  if (route.route === 'feeder32' && !route.complete) return fix('not-installed', 'install');
  if (route.legacy && route.legacy.dgVoodoo && !route.dgVoodooDeployed) return fix('dgvoodoo-missing', 'install');
  // Install offers Luma itself (with its licence in the question), so a missing Luma is a one-button fix.
  if (route.route === 'lumaue' && !route.lumaDeployed) return fix('luma-missing', 'install');
  // A Feeder doing a job Luma-Framework's own mod for this game does better (lumacatalog.js).
  if (route.lumaAvailable && route.feederDeployed) return fix('luma-available', 'switch-to-luma');
  // Luma is DirectX 11 only; a game that ran on DX12 last time never loaded it.
  if (route.lumaDeployed && run.ran && run.runtimeApi === 'dx12') return out('step', 'luma-needs-dx11');
  if (ctx.reEngine && ctx.reframeworkPresent === false) return fix('reframework-missing', 'reconfigure');
  // RE2/3/4/7/Village (reengine.js) take the engine's Present route: nothing to fetch and nothing to
  // switch on in REFramework. The one thing that gets in its way is REFramework's TemporalUpscaler
  // still on from the old pd route, which Reconfigure switches off.
  const pd = ctx.pdUpscaler;
  if (pd && route.route === 'reframework-pd' && pd.temporalUpscalerOn) return fix('pd-temporal-on', 'reconfigure');

  // What the last run said.
  if (!run.ran || run.verdict === 'no-log') {
    // On a stub game, "no log at all" is the expected outcome of launching through Steam: the
    // anti-cheat refuses to start a game with an unsigned DLL beside it and writes nothing
    // anywhere, so waiting for a run that can never happen is the wrong answer. Say which button
    // starts the game without the stub instead.
    if (d.protectedLauncher && route.optiInstalled) {
      return out('step', 'anticheat-launch-direct', {
        antiCheat: d.antiCheat || '', stub: d.protectedLauncher.stub || '',
      });
    }
    return out('needs-run', 'needs-run');
  }
  // Two frame generators at once. NVIDIA Smooth Motion IS frame generation -- the driver's own,
  // done outside the process after the frame is handed over -- so it stacks with whichever one
  // this app configured, and the two interleave their generated frames.
  //
  // This app already refuses that pattern everywhere it owns both ends: configuring Lossless
  // Scaling turns OptiScaler's Frame Generation off, and the Lossless section says "one frame
  // generator at a time" in as many words. It has never said it about the driver's, because the
  // driver's cannot be seen from here at all -- NVIDIA publishes no NVAPI setting for Smooth
  // Motion (NvApiDriverSettings.h carries 125 ids and every DLSSG one, and none for this), so the
  // ONLY evidence is the DLSS5 Feeder noticing it in the process and saying so in its log.
  //
  // Hence: reported, never acted on, and only when the Feeder actually saw it. It sits ahead of
  // the verdict switch so a working run still gets told -- a game that "works" while quietly
  // running two generators is the case worth catching -- and behind the hard stops, so it can
  // never mask a real failure.
  if (run.feedSmoothMotion && (ctx.frameGen || []).length) {
    return out('step', 'smooth-motion-stacked', { generator: ctx.frameGen.join(' and '), verdict: run.verdict });
  }

  switch (run.verdict) {
    // Every frame reached the upscaler and none came back. OptiScaler will not dispatch unless it
    // can put the root signature back afterwards, and on the pd-upscaler route it never can: the
    // DLSS call comes in on PureDark's own command list, which carries no root signature to track.
    // Nothing is written to the output texture, so the game presents a black frame and keeps
    // running behind it. There is no setting this app can change that fixes it -- clearing the
    // [Hotfix] restores lets the dispatch through and OptiScaler then crashes in it instead
    // (measured on Resident Evil 2, 2026-09-13, on every OptiScaler build tried) -- so this names
    // what is happening rather than offering a fix that trades one broken state for another.
    case 'upscale-skipped':
      return out('unavailable', 'upscale-skipped', { count: run.detail || '', route: route.route || '' });
    // DLSS could not be created and OptiScaler substituted another upscaler without saying so.
    // The neural pass still runs on top, which is why this used to read as a clean run.
    case 'sr-backend-fallback':
      return out('step', 'sr-backend-fallback', {
        backend: run.detail || '', result: run.srCreateResult || '',
      });
    case 'nr-ran':
      // The 32-bit route's one surprise, and it only bites once everything works: OptiScaler is
      // not in the game's process at all -- NVIDIA ships no 32-bit NGX, so the Feeder's add-on
      // hands each frame to a 64-bit helper beside the game and the neural pass happens there
      // (legacy.js). Alt+Home on the game window therefore reaches nothing, and the sequence that
      // does reach it was written only in the route chip's tooltip. A user with a working feed on
      // Castlevania: Lords of Shadow tried Insert and Alt+Tab and concluded the menu was missing
      // (2026-09-14) -- which is a fair reading of an app that never said otherwise.
      if (route.route === 'feeder32') {
        return out('ok', 'ok-panel-in-helper', { count: run.nrFrames || run.nrDispatch, fps: run.fps || 0, api: (run.runtimeApi || '').toUpperCase() });
      }
      return out('ok', 'ok', { count: run.nrFrames || run.nrDispatch, fps: run.fps || 0, api: (run.runtimeApi || '').toUpperCase() });
    case 'shutdown-fault':
      // NR ran and only the exit faulted: that is a working game, whatever is deployed. A
      // Feeder reaching here is one the route accepts (feederMisdeployed was handled above), so
      // it is only removed when nothing ran at all.
      if (run.nrDispatch > 0) return out('ok', 'ok-exit-crash', { count: run.nrFrames || run.nrDispatch });
      return route.feederDeployed ? fix('feeder-misdeployed', 'remove-feeder') : out('unknown', 'unknown', { verdict: run.verdict });
    case 'duplicate-dlss':
      return fix('feeder-misdeployed', 'remove-feeder');
    case 'dlss-no-nr':
      if (run.detail === 'd3d11-native') return fix('d3d11-native', 'reconfigure');
      if (ctx.nrEnabledInIni === false) return fix('nr-disabled', 'reconfigure');
      return out('unknown', 'dlss-no-nr');
    case 'init-no-feature':
      if (run.dlssRuntimeMissing) return fix('dlss-runtime-missing', 'reconfigure');
      if (run.detail === 'feeder-technique-missing') return fix('feeder-technique', 'install');
      if (route.lumaDeployed) return out('step', 'luma-select-dlss', { prey: !!ctx.lumaPrey });
      return out('unknown', 'init-no-feature');
    case 'no-dlss':
      // OptiScaler said why itself, a line into the log: no nvngx_dlss.dll beside the exe, so it
      // switched DLSS off before the game drew anything. That turns "nothing called DLSS" -- which
      // reads as a mystery -- into one missing file that Reconfigure puts back.
      if (run.dlssRuntimeMissing) return fix('dlss-runtime-missing', 'reconfigure');
      if (route.lumaDeployed) return out('step', 'luma-select-dlss', { prey: !!ctx.lumaPrey });
      // Vulkan (Ryujinx, a player's bundle 2026-09-15): the Feeder is a ReShade add-on, and on Vulkan ReShade
      // is only ever the machine-wide Vulkan layer. No dlss5-feed.log at all means the add-on never loaded,
      // so nothing could call DLSS; which of the two layer faults it is decides the step.
      if (route.route === 'feeder' && route.feederDeployed && ctx.vulkanFeeder && !ctx.vulkanFeeder.feederLogPresent) {
        if (!ctx.vulkanFeeder.layerRegistered) return out('step', 'vulkan-layer-missing');
        if (!ctx.vulkanFeeder.layerAddon) return out('step', 'vulkan-layer-no-addon');
        // The layer attaches only to exes on its own app list (feeder.js reshadeAppsListing); one that
        // was never run through ReShade's installer is the usual reason "the layer did not load".
        if (ctx.vulkanFeeder.appListed === false) return out('step', 'vulkan-layer-app-not-listed', { exe: ctx.vulkanFeeder.exe || '' });
        return out('step', 'vulkan-layer-not-loaded');
      }
      if (route.route === 'feeder' && route.feederDeployed) return out('unknown', 'no-hook');
      if (route.route === 'lumaue') return out('step', 'luma-missing');
      return out('unknown', 'no-hook');
    case 'ue-crash':
      if (route.lumaDeployed && !(route.verified && route.verified.route === 'lumaue')) return fix('ue-crash-luma', 'remove-luma', { message: run.detail || '' });
      if (route.feederDeployed && !(route.verified && route.verified.route === 'feeder')) return fix('ue-crash-feeder', 'remove-feeder', { message: run.detail || '' });
      return out('unknown', 'ue-crash', { message: run.detail || '' });
    // The Feeder ran and DLSS still got nothing. Three separate faults, each with the Feeder's
    // own log line behind it (runlog.js), and each invisible from inside the game:
    case 'feed-no-motion':
      // No motion vectors: the provider is missing, disabled, mismatched, or -- for anything
      // deployed before v1.57.0 -- a shader (DRME) that cannot compile on ReShade 6.8 at all.
      // One re-deploy rewrites the provider, its shader, both definition levels and the preset.
      return fix('feed-no-motion', 'redeploy-feeder', { detail: run.detail || '' });
    case 'feed-depth-flat':
      // Depth read flat while the vectors said the scene was moving: ReShade's Generic Depth is
      // bound to the wrong buffer, which is the classic Unity failure. The verified Unity profile
      // is the one automatic move left; after that it is Generic Depth's own page.
      return fix('feed-depth-flat', 'feeder-depth-profile');
    case 'feed-agility-redist':
      // A game-local Agility SDK folder failing every D3D12 create in the process. Moving it
      // aside is only possible when it is actually there; otherwise the redirect comes from
      // somewhere this app cannot reach, and saying so is the honest answer.
      return ctx.agilityRedist && ctx.agilityRedist.folder
        ? fix('feed-agility-redist', 'disable-agility-redist')
        : out('step', 'feed-agility-redist-elsewhere');
    // The neural model crashed in its first evaluate on the game's own D3D12 device and the Feeder
    // stopped (runlog.js). Nothing in the ini brings it back: RunBeforeSR is already forced off on
    // Feeder games and the model's preset was the default. What does work on the same GPU and driver
    // is the model on a device the Feeder creates itself -- which is what it does for a D3D11 game --
    // so an emulator, which lets you pick, is pointed at its Direct3D 11 backend. NVIDIA Smooth Motion
    // in the process is named when the Feeder saw it, as the one other variable in play.
    case 'nr-model-crash': {
      const vars = { smoothMotion: run.feedSmoothMotion ? 1 : 0, stack: run.detail || '' };
      if (d.emulator && run.feedSameDevice) return out('step', 'nr-model-crash-emulator', { ...vars, name: d.emulator.name || '' });
      return out('step', 'nr-model-crash', vars);
    }
    case 'feed-stopped':
      return fix('feed-stopped', 'reconfigure');
    // The Feeder ran and said, itself, that OptiScaler was not in the loop (runlog.js). Three
    // faults, each with the Feeder's own line behind it:
    //
    // Not loaded at all. On a Vulkan, OpenGL or DirectX 9 game nothing loads a dxgi.dll from the
    // folder, and an install made while the game was misread (Star Wars: The Old Republic, 2026-09-16:
    // OptiScaler as dxgi.dll beside DXVK's d3d9.dll, 18,000 frames of plain DLAA) keeps that name
    // until the sync migration moves it (main.js migrateProxyIfNeeded). When the app knows a better
    // name, Reconfigure runs that migration; when it does not, the name is the user's to change.
    case 'opti-not-loaded': {
      const from = ctx.optiProxy || run.detail || '';
      if (ctx.wantedProxy && ctx.optiProxy && ctx.wantedProxy.toLowerCase() !== ctx.optiProxy.toLowerCase()) {
        return fix('opti-proxy-name', 'reconfigure', { from, to: ctx.wantedProxy });
      }
      // A game with DLSS of its own does not need the proxy to reach Neural Rendering at all: the
      // model file beside the exe is enough, and the game's own Streamline loads it. So when the
      // proxy is the thing that did not load, the route that never wanted one is a better answer
      // than guessing at another DLL name to rename it to.
      //
      // This is the difference between this app and RHI on a game like Assassin's Creed Black Flag
      // Resynced: RHI never proxies, it swaps the DLLs the game already loads. The trade is real
      // and stated in the dialog -- no proxy means no in-game panel and no DLSS 5 controls -- so it
      // is offered on a failure rather than taken automatically.
      if (route.shipsDlss && !tried.has('nr-model-only')) {
        return fix('nr-model-only', 'nr-model-only', { file: from });
      }
      return out('step', 'opti-not-loaded', { file: from });
    }
    // Loaded, and a stock OptiScaler rather than the DLSS-NR fork: Install puts the fork back.
    case 'opti-not-fork':
      return fix('opti-not-fork', 'install');
    // Loaded, and the driver answered the Feeder's NGX probe instead of it: the two ini keys the
    // Feeder names ([Inputs] EnableDlssInputs, [Hooks] HookOriginalNvngxOnly) are forced on Feeder
    // games by Reconfigure (main.js FEEDER_NGX_REDIRECT).
    case 'opti-not-routed':
      return fix('opti-not-routed', 'reconfigure');
    // The Feeder's Vulkan transport could not open: its vkCreateDevice hook did not get the interop
    // extensions onto the game's device. The Feeder's README has one fallback, its out-of-process
    // layer, which this app does not deploy; the step names it.
    case 'feed-vulkan-interop':
      return out('step', 'feed-vulkan-interop', { hook: run.detail || '' });
    // The game died inside a DirectX 8/9 wrapper in its own folder as it started. When that wrapper
    // is the dgVoodoo2 this app placed, no dgVoodoo2 SETTING is worth trying: on Castlevania: Lords
    // of Shadow 2 (2026-09-14) VRAM, output API, windowed mode, adapter, GPU preference, CPU
    // affinity and the previous dgVoodoo2 release all hung or crashed the same way, while the game
    // ran clean without it.
    //
    // What has changed since is that dgVoodoo2 is no longer the only way to present DirectX 8/9 to
    // a modern pipeline. translation.js owns DXVK too, so the first answer is the other layer
    // rather than giving up -- and the evidence for it is better than a hunch: on #50 the same
    // SWTOR install crashed at d3d9!00065af0 under dgVoodoo2 on one machine while running through
    // DXVK's d3d9.dll on the reporter's other one.
    //
    // It is still offered, never applied on its own. The two layers take different paths (D3D11
    // against Vulkan) so the swap can make a nearly-working game worse, and nothing here can tell
    // whether it helped until the game is run again. If it has been tried and the wrapper is still
    // crashing, putting the game back is what is left. A wrapper that is not ours is named and
    // left alone.
    case 'wrapper-crash': {
      const ours = route.dgVoodooDeployed && route.legacy && route.legacy.dgVoodoo &&
        String(route.legacy.dgVoodoo.dll || '').toLowerCase() === String(run.detail || '').toLowerCase();
      if (!ours) return out('unknown', 'wrapper-crash', { dll: run.detail || '' });
      // The APIs DXVK ships a file set for (translation.js DXVK_FILES_FOR_API). Inlined rather than
      // imported: this table stays a pure function of its context, with no module of its own to load.
      const dxvkServes = ['dx8', 'dx9', 'dx10', 'dx11'].includes(route.legacy.api);
      if (dxvkServes && !tried.has('swap-to-dxvk')) {
        return fix('wrapper-crash-swap', 'swap-to-dxvk', { dll: run.detail || '', api: route.legacy.api });
      }
      return fix('dgvoodoo-crash', 'remove-all', { dll: run.detail || '' });
    }
    default:
      return out('unknown', 'unknown', { verdict: run.verdict });
  }
}

// The fixes in the order Game Help would try them, for the AI tier's tool list and the tests.
// 'switch-to-luma' is applied by the renderer, which asks for Luma's licence first; main.js declines it.
const FIX_IDS = ['remove-foreign', 'remove-feeder', 'remove-luma', 'redeploy-feeder', 'feeder-depth-profile', 'disable-agility-redist', 'reconfigure', 'remove-all', 'install', 'switch-to-luma', 'swap-to-dxvk', 'nr-model-only'];

module.exports = { diagnose, FIX_IDS };
