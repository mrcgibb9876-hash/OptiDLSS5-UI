'use strict';
// The frame-generation suggestion: once DLSS 5 runs, whether a frame generator is worth adding for this
// game, which one, and at what multiplier. Game Help shows it under a working run; the tests run it on
// run digests (digest.js), which carry the same numbers.
//
// Which generators exist for a game is settled experience, not a guess:
//   native-dlssg  the game's own DLSS Frame Generation (nvngx_dlssg.dll / sl.dlss_g.dll beside it), set
//                 by the multiplier in Edit (framegen.js, engine v1.0.16+). Needs an RTX 40 or 50;
//                 RTX 40 runs it at 2x only. Cyberpunk 2077 ran it at 2x-4x with DLSS 5 (2026-09-16).
//   rtxmfg        the RTX 40 multi-frame unlock (rtxmfg.js) over that same native frame generation,
//                 for 3x/4x on an RTX 40. RTX 50 has it natively.
//   lossless      Lossless Scaling (lossless.js): outside the game, on any GPU and any route -- the one
//                 generator that works with the DLSS5 Feeder (Batman: Arkham Knight, 2026-09-10).
//   optifg        OptiScaler's own frame generation is NEVER suggested: the engine hard-blocks it while
//                 the Feeder is loaded (the Feeder crashes on the second Present), and with a game's own
//                 Streamline it caused a TDR crash (Cyberpunk 2077, 2026-09-08). The app keeps it off.
//
// The thresholds below are tunables, not measurements: frame generation multiplies what is there, so a
// base frame rate already at the target gains nothing, and one far below it feels as laggy as it was.
//
// Pure: everything comes in through the arguments. main.js's Game Help context fills them in.

const rtxmfg = require('./rtxmfg');
const catalogLib = require('./catalog');

const DEFAULT_TARGET_FPS = 60;
const MIN_BASE_FPS = 30;
const MAX_MULTIPLIER = 4;

// facts: {
//   fps            the base frame rate with DLSS 5 running (the engine's heartbeat, else the run's fps)
//   fpsTarget      what the player aims for (null: DEFAULT_TARGET_FPS)
//   route          the route result (route.js)
//   hasNativeFg    the game ships DLSS Frame Generation (framegen.frameGenSwapState(dir).hasFrameGen)
//   gpu            { vendor, name }
//   lossless       { installed } -- Lossless Scaling found in the Steam library
//   configured     the generators this app already set up for the game (main.js helpContext.frameGen)
//   smoothMotion   NVIDIA Smooth Motion active in the process (the Feeder saw it)
//   catalog        the game's known-good entry (catalog.lookup), for per-game proof and dead ends
// }
// Returns null when there is no frame rate to judge by, else
//   { suggest, code, generator, multiplier, vars }
// where suggest=false says why nothing is offered (code), and suggest=true names the generator.
function suggestFrameGen(facts = {}) {
  const fps = Number(facts.fps) > 0 ? Number(facts.fps) : null;
  if (!fps) return null;
  const target = Number(facts.fpsTarget) > 0 ? Number(facts.fpsTarget) : DEFAULT_TARGET_FPS;
  const vars = { fps: Math.round(fps), target };
  const no = (code, extra = {}) => ({ suggest: false, code, generator: null, multiplier: null, vars: { ...vars, ...extra } });

  // One generator at a time: a second one interleaves its frames with the first.
  const configured = facts.configured || [];
  if (configured.length) return no('fg-already', { generator: configured.join(' and ') });
  if (facts.smoothMotion) return no('fg-smooth-motion');
  if (fps >= target) return no('fg-not-needed');
  if (fps < MIN_BASE_FPS) return no('fg-base-too-low', { min: MIN_BASE_FPS });

  const multiplier = Math.min(MAX_MULTIPLIER, Math.max(2, Math.ceil(target / fps)));
  const entry = facts.catalog || null;
  const dead = (kind) => !!catalogLib.featureDeadEnd(entry, kind);
  const proven = (kind) => !!(entry && entry.fg && (entry.fg.works || []).includes(kind));
  const route = (facts.route && facts.route.route) || null;
  const gpu = facts.gpu || {};
  const series = gpu.vendor === 'nvidia' ? rtxmfg.gpuSeries(gpu.name) : null;
  const give = (generator, mult, code, extra = {}) => ({
    suggest: true, code, generator, multiplier: mult,
    vars: { ...vars, multiplier: mult, reach: Math.round(fps * mult), proven: proven(generator), ...extra },
  });

  // The game's own frame generation: only where its own Streamline is what runs (the Feeder and Luma
  // routes bring their own DLSS, and the Feeder's ReShade cannot survive a second Present).
  const ownStreamline = route === 'optiscaler' || route === 'nr-model-only';
  if (facts.hasNativeFg && ownStreamline && series && series >= 40 && !dead('native-dlssg')) {
    if (series >= 50) return give('native-dlssg', multiplier, 'fg-native');
    if (multiplier <= 2) return give('native-dlssg', 2, 'fg-native');
    if (!dead('rtxmfg')) return give('rtxmfg', multiplier, 'fg-rtxmfg');
    return give('native-dlssg', 2, 'fg-native');
  }

  if (dead('lossless')) return no('fg-none');
  return give('lossless', multiplier, facts.lossless && facts.lossless.installed ? 'fg-lossless' : 'fg-lossless-get');
}

module.exports = { suggestFrameGen, DEFAULT_TARGET_FPS, MIN_BASE_FPS, MAX_MULTIPLIER };
