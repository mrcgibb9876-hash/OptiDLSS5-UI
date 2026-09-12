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

function diagnose(ctx) {
  const d = ctx.detected || {};
  const route = ctx.route || {};
  const run = ctx.run || { ran: false, verdict: 'no-log' };
  const tried = new Set(ctx.fixesTried || []);
  const foreign = ctx.foreign || [];

  const fix = (code, id, vars = {}) => (tried.has(id)
    ? { status: 'unknown', code: 'fix-failed', vars: { ...vars, fix: id, code }, fix: null }
    : { status: 'fix', code, vars, fix: { id } });
  const out = (status, code, vars = {}) => ({ status, code, vars, fix: null });

  // Hard stops first: nothing the app deploys can run in these.
  if (d.bitness === 32) return out('unavailable', 'bit32');
  if (d.antiCheat) return out('unavailable', 'anticheat', { antiCheat: d.antiCheat });
  if (route.route === 'unsupported') return out('unavailable', 'unsupported', { reason: route.reason || '' });

  // Two stacks on one DLSS call crash before anything else can be judged.
  if (foreign.length) return fix('foreign', 'remove-foreign', { tool: foreign.map((f) => f.tool).join(', ') });
  if (route.feederMisdeployed) return fix('feeder-misdeployed', 'remove-feeder');
  if (route.lumaDeployed && ctx.lumaKnownBad) return fix('luma-known-bad', 'remove-luma', { reason: ctx.lumaKnownBad });

  // Not installed, or the route's first step is missing: Install is the fix.
  if (!route.optiInstalled) return fix('not-installed', 'install');
  if (route.route === 'feeder' && !route.feederDeployed) return fix('feeder-missing', 'install');
  if (ctx.reEngine && ctx.reframeworkPresent === false) return fix('reframework-missing', 'reconfigure');

  // What the last run said.
  if (!run.ran || run.verdict === 'no-log') return out('needs-run', 'needs-run');
  switch (run.verdict) {
    case 'nr-ran':
      return out('ok', 'ok', { count: run.nrDispatch, fps: run.fps || 0, api: (run.runtimeApi || '').toUpperCase() });
    case 'shutdown-fault':
      return route.feederDeployed ? fix('feeder-misdeployed', 'remove-feeder') : out('ok', 'ok-exit-crash', { count: run.nrDispatch });
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
      if (route.route === 'lumaue') return fix('luma-missing', 'install');
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
