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
// remove-luma, reconfigure. 'install' is the card's own Install button, run by the renderer.
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
  if (d.antiCheat) return out('unavailable', 'anticheat', { antiCheat: d.antiCheat });
  if (route.route === 'unsupported') return out('unavailable', 'unsupported', { reason: route.reason || '' });

  // Two stacks on one DLSS call crash before anything else can be judged.
  if (foreign.length) return fix('foreign', 'remove-foreign', { tool: foreign.map((f) => f.tool).join(', ') });
  if (route.feederMisdeployed) return fix('feeder-misdeployed', 'remove-feeder');
  if (route.lumaDeployed && ctx.lumaKnownBad) return fix('luma-known-bad', 'remove-luma', { reason: ctx.lumaKnownBad });

  // Not installed, or the route's first step is missing: Install is the fix.
  if (!route.optiInstalled) return fix('not-installed', 'install');
  if (route.route === 'feeder' && !route.feederDeployed) return fix('feeder-missing', 'install');
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
  if (!run.ran || run.verdict === 'no-log') return out('needs-run', 'needs-run');
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
      if (run.detail === 'feeder-technique-missing') return fix('feeder-technique', 'install');
      if (route.lumaDeployed) return out('step', 'luma-select-dlss');
      return out('unknown', 'init-no-feature');
    case 'no-dlss':
      if (route.lumaDeployed) return out('step', 'luma-select-dlss');
      if (route.route === 'feeder' && route.feederDeployed) return out('unknown', 'no-hook');
      if (route.route === 'lumaue') return out('step', 'luma-missing');
      return out('unknown', 'no-hook');
    case 'ue-crash':
      if (route.lumaDeployed && !(route.verified && route.verified.route === 'lumaue')) return fix('ue-crash-luma', 'remove-luma', { message: run.detail || '' });
      if (route.feederDeployed && !(route.verified && route.verified.route === 'feeder')) return fix('ue-crash-feeder', 'remove-feeder', { message: run.detail || '' });
      return out('unknown', 'ue-crash', { message: run.detail || '' });
    case 'feed-stopped':
      return fix('feed-stopped', 'reconfigure');
    default:
      return out('unknown', 'unknown', { verdict: run.verdict });
  }
}

// The fixes in the order Game Help would try them, for the AI tier's tool list and the tests.
const FIX_IDS = ['remove-foreign', 'remove-feeder', 'remove-luma', 'reconfigure', 'install'];

module.exports = { diagnose, FIX_IDS };
