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
// remove-luma, redeploy-feeder, feeder-depth-profile, disable-agility-redist, reconfigure.
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
  // Install does not deploy Luma UE (its licence is confirmed in Edit), so this is the user's step.
  if (route.route === 'lumaue' && !route.lumaDeployed) return out('step', 'luma-missing');
  if (ctx.reEngine && ctx.reframeworkPresent === false) return fix('reframework-missing', 'reconfigure');
  // RE2/3/4/7/Village (reengine.js): the pd-upscaler REFramework build, nvngx_dlss.dll and
  // PureDark's plugin have to be there before any run can be judged; then the run says whether
  // DLSS was switched on in REFramework's menu.
  const pd = ctx.pdUpscaler;
  if (pd && route.route === 'reframework-pd') {
    if (pd.reframeworkBuild === 'standard' || !pd.dlssPresent) return fix('pd-build-missing', 'reconfigure');
    if (!pd.pluginPresent) return out('step', 'pd-plugin-missing', { url: ctx.pdPluginPage || '' });
    if (run.ran && (run.verdict === 'no-dlss' || run.verdict === 'init-no-feature')) return out('step', 'pd-enable-ingame');
  }

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
  switch (run.verdict) {
    case 'nr-ran':
      return out('ok', 'ok', { count: run.nrDispatch, fps: run.fps || 0, api: (run.runtimeApi || '').toUpperCase() });
    case 'shutdown-fault':
      // NR ran and only the exit faulted: that is a working game, whatever is deployed. A
      // Feeder reaching here is one the route accepts (feederMisdeployed was handled above), so
      // it is only removed when nothing ran at all.
      if (run.nrDispatch > 0) return out('ok', 'ok-exit-crash', { count: run.nrDispatch });
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
      if (route.lumaDeployed) return out('step', 'luma-select-dlss');
      return out('unknown', 'init-no-feature');
    case 'no-dlss':
      // OptiScaler said why itself, a line into the log: no nvngx_dlss.dll beside the exe, so it
      // switched DLSS off before the game drew anything. That turns "nothing called DLSS" -- which
      // reads as a mystery -- into one missing file that Reconfigure puts back.
      if (run.dlssRuntimeMissing) return fix('dlss-runtime-missing', 'reconfigure');
      if (route.lumaDeployed) return out('step', 'luma-select-dlss');
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
    case 'feed-stopped':
      return fix('feed-stopped', 'reconfigure');
    default:
      return out('unknown', 'unknown', { verdict: run.verdict });
  }
}

// The fixes in the order Game Help would try them, for the AI tier's tool list and the tests.
const FIX_IDS = ['remove-foreign', 'remove-feeder', 'remove-luma', 'redeploy-feeder', 'feeder-depth-profile', 'disable-agility-redist', 'reconfigure', 'install'];

module.exports = { diagnose, FIX_IDS };
