'use strict';
// Route scoring: every route that could serve a game, scored from the evidence, ranked, with the
// reasons for each -- so the app can say WHY a route was chosen and what to try when it fails.
//
// route.js walks a fixed rule chain to one answer, and that chain is the app's accumulated experience:
// every `if` in it is a lesson from a real game. It stays the authority. What it could not give was a
// second answer: when the chosen route fails, Game Help's options were whatever rule happened to fire
// for that verdict, and the card could not say why it picked what it picked. So here:
//
//   - The rule chain's pick is one piece of evidence among the rest, and the heaviest (RULE_CHAIN). No
//     other evidence alone can outweigh it, which is what keeps the chosen route IDENTICAL to route.js's
//     answer for every game the catalog says nothing about -- this adds a runner-up and reasons, it does
//     not second-guess the rules.
//   - What CAN move the choice is evidence stronger than a rule: the known-good catalog marking the
//     rule's pick a dead end for this game while another feasible route is not (catalog.js), a probe
//     that watched the pick fail (the `probe` input), or the two together with a failed run. When that
//     happens `overridden` is set; route.route itself is left alone (Install still does what the rules
//     say -- the catalog never silently changes what gets written to a game folder) and Game Help
//     offers the switch as a one-click fix, where one exists (gamehelp.js 'catalog-prefers').
//
// Pure: everything comes in through the arguments. route.js attaches a scoring to every route result
// (without a run, which is async to read); main.js's Game Help context re-scores with the last run.

const presentroute = require('./presentroute');
const reengine = require('./reengine');
const catalogLib = require('./catalog');

// Every weight in one place. A candidate's score is the sum of the weights whose condition holds;
// the reason string beside each weight is what the user sees under "Why this route?".
const WEIGHTS = {
  // The route.js rule chain chose this route. Worth more than any single piece of evidence below, so
  // the choice only moves when the rules' pick is itself shown to be a dead end.
  RULE_CHAIN: 100,
  // The route can technically run here (its preconditions hold). Infeasible routes score nothing and
  // are listed with the reason, never ranked above a feasible one.
  FEASIBLE: 10,
  // The game ships its own DLSS/Streamline: OptiScaler only adds the neural pass on top (route.js).
  SHIPS_DLSS: 30,
  // The model file alone, loaded by the game's own Streamline (nrmodelonly.js, 2.2.0) -- works where a
  // proxy DLL will not load, and costs the in-game panel.
  NR_MODEL_ONLY: 15,
  NO_PANEL: -5,
  // An engine Present-route game (Elden Ring/AC6/Nightreign by ini; RE Engine titles via REFramework):
  // DLSS 5 runs over the game's own TAA with depth tracked by the engine (presentroute.js, reengine.js).
  PRESENT_GAME: 30,
  // A Luma-Framework mod adds a REAL DLSS call with the game's own motion vectors (lumacatalog.js) --
  // better than the Feeder's estimated one.
  LUMA_MOD: 25,
  // The Feeder on the APIs it was built for (DX11/DX12), and on the ones it reaches through ReShade's
  // Vulkan layer or opengl32.dll (feeder.js reshadeModeForApi) -- which have more ways to fail.
  FEEDER_API_DX: 20,
  FEEDER_API_OTHER: 10,
  // dgVoodoo2 is the wrapper the 32-bit route was first confirmed on (Castlevania: Lords of Shadow,
  // 2026-09-14); DXVK / native Direct3D are the alternatives (translation.js, legacy.js).
  WRAPPER_TESTED: 15,
  WRAPPER_ALT: 10,
  // DLSS-NR-on-AMD, the only NR route on an AMD card (amdnr.js).
  AMD_NR: 30,
  // What is already deployed in the folder: a small nudge, so a working stack is not churned for an
  // equal alternative.
  ALREADY_HERE: 5,
  // OptiScaler's neural pass needs NVIDIA's NGX runtime: every NVIDIA-stack route on an AMD/Intel card.
  WRONG_VENDOR: -60,
  // The last run on this route (runlog.js): DLSS 5 ran, or failed with a verdict that means the setup
  // cannot work (catalog.DEAD_END_VERDICTS). Only applied to the route that was installed when it ran.
  RUN_WORKED: 30,
  RUN_FAILED: -40,
  // The known-good catalog (catalog.js): the proven setup for this game, boosted per report up to a
  // cap; a known dead end, penalised hard enough that the rules' pick loses to a clean alternative.
  CATALOG_PROVEN: 40,
  CATALOG_PER_REPORT: 15,
  CATALOG_REPORTS_CAP: 4,
  CATALOG_DEAD_END: -80,
  // A probe (the watched launch, when one exists) that saw this route work or fail. Input field:
  // evidence.probe = { results: { '<candidate key>': { outcome: 'worked' | 'failed', note } } }.
  PROBE_WORKED: 30,
  PROBE_FAILED: -50,
  // A tie-breaker, not measured evidence: the Feeder routes run a second D3D12 device (and on the
  // 32-bit route a second process) beside the game, which costs VRAM. Only when VRAM is known.
  LOW_VRAM: -5,
  LOW_VRAM_MB: 8192,
};

const NVIDIA_ONLY = new Set(['optiscaler', 'nr-model-only', 'feeder', 'feeder32', 'lumaue', 'reframework-pd', 'present']);
const FEEDER_ROUTES = new Set(['feeder', 'feeder32']);

const keyOf = (route, via) => (via ? `${route}:${via}` : route);

// Which variant of its route the rule chain's answer is: the wrapper on the legacy routes.
function pickVia(r) {
  const steps = r.steps || [];
  const dxvkStep = steps.some((s) => s.key === 'dxvk');
  const plan = r.legacy || null;
  if (r.route === 'feeder32' && plan) {
    if (r.dxvkDeployed || dxvkStep) return 'dxvk';
    if (plan.dgVoodoo) return 'dgvoodoo';
    if (plan.api === 'dx10' || plan.api === 'dx11') return 'native';
    return null;
  }
  if (r.route === 'feeder' && plan && plan.dgVoodoo) return r.dxvkDeployed || dxvkStep ? 'dxvk' : 'dgvoodoo';
  return null;
}

// The layer actually IN the folder, from the install's own records (the translation-layer manifest and
// the legacy marker), never a choice still to be placed: what catalog.learnFromRun records as the layer
// a run used. pickVia also counts a DXVK only chosen -- by hand or proven -- which a run never ran on.
function placedVia(r) {
  const plan = r.legacy || null;
  if (!plan || !(r.route === 'feeder32' || (r.route === 'feeder' && plan.dgVoodoo))) return null;
  if (r.dxvkDeployed) return 'dxvk';
  if (plan.dgVoodoo) return r.dgVoodooDeployed ? 'dgvoodoo' : null;
  if (r.route === 'feeder32' && (plan.api === 'dx10' || plan.api === 'dx11')) return 'native';
  return null;
}

// The fix id (gamehelp.js / main.js game:help-apply) that moves a game from the current setup to this
// candidate, or null when there is no one-click way (the candidate is then only explained).
function fixFor(cand, r, pick) {
  if (cand.key === pick.key) return null;
  if (cand.route === 'nr-model-only') return r.optiInstalled ? 'nr-model-only' : null;
  if ((cand.route === 'feeder32' || cand.route === 'feeder') && cand.route === pick.route) {
    if (cand.via === 'dxvk') return 'swap-to-dxvk';
    if (cand.via === 'dgvoodoo' && pick.via === 'dxvk') return 'swap-to-dgvoodoo';
    if (cand.via === 'native' && pick.via === 'dxvk') return 'swap-to-native';
    return null;
  }
  if (cand.route === 'lumaue' && r.feederDeployed && !r.lumaDeployed) return 'switch-to-luma';
  if ((cand.route === 'present' || cand.route === 'reframework-pd' || cand.route === 'optiscaler') && r.feederDeployed) return 'remove-feeder';
  return null;
}

function candidatesFor(r, ev) {
  const d = ev.detected || {};
  const api = d.api || null;
  const exe = ev.exePath || null;
  const out = [];
  const add = (route, via, feasible, notes = []) => out.push({ route, via: via || null, key: keyOf(route, via), feasible, notes });

  const bit32 = d.bitness === 32;
  const shipsDlss = !!r.shipsDlss;
  const presentGame = !!(exe && (presentroute.iniPresentGame(exe)));
  const reGame = !!(exe && reengine.presentRouteGame(exe));

  add('optiscaler', null, !bit32 && (shipsDlss || r.route === 'optiscaler'),
    shipsDlss ? [] : [{ text: 'The game ships no DLSS of its own for OptiScaler to hook' }]);
  add('nr-model-only', null, !bit32 && shipsDlss,
    shipsDlss ? [] : [{ text: 'Needs the game\'s own DLSS/Streamline to load the model' }]);

  const feederApi = ['dx11', 'dx12', 'vulkan', 'opengl'].includes(api) || r.feederDeployed;
  if (api === 'dx9' && !bit32) {
    add('feeder', 'dgvoodoo', true);
    add('feeder', 'dxvk', !r.dxvkBlocked, r.dxvkBlocked ? [{ text: 'DXVK is blocked for this game: {why}', vars: { why: r.dxvkBlocked.why || '' } }] : []);
  } else {
    add('feeder', null, !bit32 && !shipsDlss && feederApi,
      bit32 ? [{ text: '64-bit Feeder cannot load in a 32-bit game' }]
        : shipsDlss ? [{ text: 'The game ships DLSS: a Feeder beside it loads two DLSS DLLs and crashes (Code Vein 2, 2026-09-11)' }]
          : feederApi ? [] : [{ text: 'Graphics API not known or not one the Feeder supports' }]);
  }

  if (bit32) {
    const plan = r.legacy || null;
    const supported = !!plan;
    if (plan && plan.dgVoodoo) {
      add('feeder32', 'dgvoodoo', supported);
      add('feeder32', 'dxvk', supported && !r.dxvkBlocked, r.dxvkBlocked ? [{ text: 'DXVK is blocked for this game: {why}', vars: { why: r.dxvkBlocked.why || '' } }] : []);
    } else if (plan && (plan.api === 'dx10' || plan.api === 'dx11')) {
      add('feeder32', 'native', supported);
      add('feeder32', 'dxvk', supported && !r.dxvkBlocked, r.dxvkBlocked ? [{ text: 'DXVK is blocked for this game: {why}', vars: { why: r.dxvkBlocked.why || '' } }] : []);
    } else {
      add('feeder32', null, supported, supported ? [] : [{ text: 'No 32-bit route for this API' }]);
    }
  }

  const lumaPossible = !!(ev.lumaMod || r.lumaAvailable || r.lumaDeployed || r.lumaMod || r.route === 'lumaue');
  add('lumaue', null, !bit32 && lumaPossible, lumaPossible ? [] : [{ text: 'No Luma-Framework mod matches this game' }]);
  if (presentGame || r.route === 'present') add('present', null, true);
  if (reGame || r.route === 'reframework-pd') add('reframework-pd', null, true);
  if (ev.gpuVendor === 'amd' || r.route === 'amdnr') add('amdnr', null, api === 'dx12' || r.route === 'amdnr', api === 'dx12' ? [] : [{ text: 'DLSS-NR-on-AMD is DX12 only' }]);
  if (r.route === 'unsupported' || r.route === 'unknown') add(r.route, null, true);

  // The rule chain's pick is always a candidate, whatever the table above thought of it.
  const pick = { route: r.route, via: pickVia(r) };
  pick.key = keyOf(pick.route, pick.via);
  if (!out.some((c) => c.key === pick.key)) add(pick.route, pick.via, true);
  const seen = new Set();
  return { pick, candidates: out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true))) };
}

// evidence: { exePath, detected, gpuVendor, gpu: { vramMb }, run, catalog (a catalog.lookup entry),
//             probe: { results: { key: { outcome, note } } }, lumaMod }
function scoreRoutes(r, evidence = {}) {
  if (!r || !r.route) return null;
  const ev = { ...evidence, gpuVendor: evidence.gpuVendor || r.gpuVendor || 'unknown' };
  const d = ev.detected || {};
  const { pick, candidates } = candidatesFor(r, ev);
  const entry = ev.catalog || null;
  const run = ev.run || null;
  const probe = (ev.probe && ev.probe.results) || {};
  const vram = ev.gpu && Number(ev.gpu.vramMb) > 0 ? Number(ev.gpu.vramMb) : null;

  const scored = candidates.map((c) => {
    const reasons = [];
    const give = (weight, text, vars) => reasons.push({ text, vars: vars || null, weight });
    if (!c.feasible) {
      return { ...c, score: -Infinity, reasons: c.notes.map((n) => ({ ...n, weight: 0 })), rule: false, fix: null };
    }
    const isPick = c.key === pick.key;
    if (isPick) give(WEIGHTS.RULE_CHAIN, 'The app\'s route rules choose it for this game');
    give(WEIGHTS.FEASIBLE, 'Can run here');
    if (r.shipsDlss && c.route === 'optiscaler') give(WEIGHTS.SHIPS_DLSS, 'The game ships its own DLSS');
    if (c.route === 'nr-model-only') { give(WEIGHTS.NR_MODEL_ONLY, 'The game\'s own Streamline can load the model with no proxy DLL'); give(WEIGHTS.NO_PANEL, 'No in-game DLSS 5 panel on this route'); }
    if (c.route === 'present' || c.route === 'reframework-pd') give(WEIGHTS.PRESENT_GAME, 'Engine Present route game: DLSS 5 over its own anti-aliasing');
    if (c.route === 'lumaue') give(WEIGHTS.LUMA_MOD, 'A Luma mod adds a real DLSS call with the game\'s motion vectors');
    if (c.route === 'feeder' && !c.via) {
      if (['dx11', 'dx12'].includes(d.api)) give(WEIGHTS.FEEDER_API_DX, 'The Feeder supports {api} directly', { api: String(d.api).toUpperCase() });
      else if (['vulkan', 'opengl'].includes(d.api)) give(WEIGHTS.FEEDER_API_OTHER, 'The Feeder reaches {api} through ReShade', { api: d.api === 'vulkan' ? 'Vulkan' : 'OpenGL' });
    }
    if (c.via === 'dgvoodoo') give(WEIGHTS.WRAPPER_TESTED, 'dgVoodoo2 is the wrapper this route was first confirmed on');
    if (c.via === 'dxvk' || c.via === 'native') give(WEIGHTS.WRAPPER_ALT, c.via === 'dxvk' ? 'DXVK presents the game through Vulkan instead' : 'The game\'s own Direct3D, no wrapper');
    if (c.route === 'amdnr') give(WEIGHTS.AMD_NR, 'The only Neural Rendering route on an AMD card');
    const here = (c.route === 'feeder' && r.feederDeployed) || (c.route === 'lumaue' && r.lumaDeployed)
      || (c.via === 'dxvk' && r.dxvkDeployed) || (c.via === 'dgvoodoo' && r.dgVoodooDeployed && !r.dxvkDeployed);
    if (here) give(WEIGHTS.ALREADY_HERE, 'Already set up in this folder');
    if (NVIDIA_ONLY.has(c.route) && (ev.gpuVendor === 'amd' || ev.gpuVendor === 'intel')) give(WEIGHTS.WRONG_VENDOR, 'Neural Rendering on this route needs an NVIDIA GPU');
    if (vram && vram < WEIGHTS.LOW_VRAM_MB && FEEDER_ROUTES.has(c.route)) give(WEIGHTS.LOW_VRAM, 'The Feeder runs a second D3D12 device; {mb} MB of VRAM is tight', { mb: vram });

    // The last run judged the route that was installed when it ran, which is the rules' pick.
    if (isPick && run && run.ran && r.optiInstalled) {
      if (catalogLib.runWorked(run)) give(WEIGHTS.RUN_WORKED, 'DLSS 5 ran on this route last time');
      else if (catalogLib.DEAD_END_VERDICTS[run.verdict]) give(WEIGHTS.RUN_FAILED, 'Last run failed: {why}', { why: catalogLib.DEAD_END_VERDICTS[run.verdict] });
    }

    if (entry) {
      const setup = entry.setup || {};
      const works = (entry.reports || {}).works || 0;
      const setupVia = setup.via || setup.wrapper || null;
      if (setup.route === c.route && (!setupVia || setupVia === c.via) && works > 0) {
        const n = Math.min(works, WEIGHTS.CATALOG_REPORTS_CAP);
        give(WEIGHTS.CATALOG_PROVEN + WEIGHTS.CATALOG_PER_REPORT * n, 'Proven on {n} report(s)', { n: works });
      }
      for (const dead of catalogLib.deadEndsFor(entry, { route: c.route, via: c.via, api: d.api || null })) {
        give(WEIGHTS.CATALOG_DEAD_END, 'Known dead end: {why}', { why: dead.why || dead.what || '' });
      }
    }
    const p = probe[c.key];
    if (p && p.outcome === 'worked') give(WEIGHTS.PROBE_WORKED, 'A probe saw it work{note}', { note: p.note ? `: ${p.note}` : '' });
    if (p && p.outcome === 'failed') give(WEIGHTS.PROBE_FAILED, 'A probe saw it fail{note}', { note: p.note ? `: ${p.note}` : '' });

    const score = reasons.reduce((s, x) => s + x.weight, 0);
    return { ...c, score, reasons, rule: isPick, fix: null };
  });

  // Highest score first; the rules' pick wins every tie, then the table's own order.
  const order = new Map(scored.map((c, i) => [c.key, i]));
  scored.sort((a, b) => (b.score - a.score) || ((b.rule ? 1 : 0) - (a.rule ? 1 : 0)) || (order.get(a.key) - order.get(b.key)));
  for (const c of scored) c.fix = c.feasible ? fixFor(c, r, pick) : null;
  const feasible = scored.filter((c) => c.feasible);
  const chosen = feasible[0] || null;
  const runnerUp = feasible[1] || null;
  const strip = (c) => (c ? { key: c.key, route: c.route, via: c.via, score: c.score, fix: c.fix, rule: c.rule, reasons: c.reasons } : null);
  return {
    chosen: strip(chosen),
    runnerUp: strip(runnerUp),
    overridden: !!(chosen && chosen.key !== pick.key),
    pick: pick.key,
    ranked: scored.map((c) => ({ ...strip(c), feasible: c.feasible, score: c.feasible ? c.score : null })),
  };
}

module.exports = { WEIGHTS, scoreRoutes, candidatesFor, pickVia, placedVia };
