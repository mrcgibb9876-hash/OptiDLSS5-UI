// A short, plain-language explanation for each install route: what it does, what it cannot do, and
// how to reach the DLSS 5 panel. route.js's `reason` is the full argument for a route, written for the
// hover text; this is the three-line version the card and Edit show under "How this route works".
//
// All of the words live here, as fixed English templates, so the renderer can translate them with
// t() (the English text is the key) and nothing about a route's explanation is scattered through the
// UI. The one part that varies ({name}, an emulator) is filled from `vars`.
//
// Every claim is one the app already relies on elsewhere, with where it comes from:
//   - Alt+Home opens the DLSS 5 panel on every route, 32-bit included (route.js ROUTE_TEXT.host32Panel,
//     verified on Alien: Isolation 2026-09-16), and needs the game windowed or borderless (renderer.js).
//   - Feeder motion vectors are estimated, so fast motion ghosts more (index.html, Feeder section);
//     OptiScaler's own Frame Generation is blocked while the Feeder is loaded, so it is Lossless Scaling.
//   - The Present route (RE Engine, Elden Ring, Armored Core VI, Nightreign) runs DLSS 5 over the game's
//     own anti-aliasing with no motion vectors, and menus have no depth (route.js, reengine.js).
//   - Luma needs DirectX 11 and the game's own DLSS off (route.js lumaue).
//   - DXVK on a 32-bit game needs ReShade's machine-wide 32-bit Vulkan layer (index.html, layer section);
//     Assassin's Creed II draws black under dgVoodoo2 and runs under DXVK (CLAUDE.md).
//   - Game Help's model-only route (nrmodelonly.js) takes OptiScaler out of the game's loader entirely,
//     so Alt+Home reaches nothing there. The words are applyHelpFix's own dialog for it (main.js), which
//     states the same trade before the route is taken. It is keyed off the state rather than the route id
//     because route.js keeps recommending `optiscaler` for a game that ships its own DLSS: without this
//     entry the card showed that route's "Press Alt+Home" line on a game with no OptiScaler in it.

// This module says what the ROUTE offers; whether the break-away panel (Alt+Shift+Home) can be
// offered as well is a fact about the machine, not the route -- it can be switched off in Settings, and
// Windows can refuse its hotkey to another program that already holds it. So `popout` below says
// whether that panel is the fallback or the only answer, and the renderer, which knows through
// popoutHotkeyUsable() whether the key works at all, supplies the sentence. Naming it unconditionally
// here sent people to a dead key, which is the 2026-09-18 bug renderer-dom.test.js guards against.
//   'fallback' the route draws its own panel in the game; the break-away one is the backup
//   'only'     nothing is drawn in the game, but OptiScaler is there, so its ini can still be edited
//   null       no panel of either kind: nothing of ours is in the game to draw one or take a setting
const PANEL = 'Press Alt+Home in the game for the DLSS 5 panel. Run the game windowed or borderless: Windows will not draw it over exclusive fullscreen.';

const ROUTES = {
  optiscaler: {
    does: 'Uses the game\'s own DLSS. OptiScaler adds DLSS 5 on top of it.',
    limits: 'Turn DLSS on in the game\'s own settings, or there is nothing to add to. Frame Generation is the game\'s own.',
    panel: PANEL,
  },
  'nr-model-only': {
    does: 'The game\'s own DLSS loads the Neural Rendering model by itself. Nothing this app installs is in the game\'s loader.',
    limits: 'Turn DLSS on in the game\'s own settings. Frame Generation is the game\'s own. Game Help offers this route for a game that will not start with OptiScaler in it.',
    panel: 'No panel on this route: OptiScaler is not in the game, so Alt+Home does nothing. Press Install to put OptiScaler and the panel back.',
    popout: null,
  },
  feeder: {
    does: 'The game has no DLSS, so the DLSS5 Feeder makes a DLSS call from ReShade\'s depth and estimated motion vectors.',
    limits: 'The motion vectors are estimated, so fast motion ghosts more than in a game with real DLSS. Frame Generation is Lossless Scaling.',
    panel: PANEL,
  },
  'feeder-vulkan': {
    does: 'The game has no DLSS, so the DLSS5 Feeder makes a DLSS call from ReShade\'s depth and estimated motion vectors.',
    limits: 'The motion vectors are estimated, so fast motion ghosts more. On Vulkan, ReShade is installed for the whole PC and NVIDIA Smooth Motion must be off for this game.',
    panel: PANEL,
  },
  'feeder-opengl': {
    does: 'The game has no DLSS, so the DLSS5 Feeder makes a DLSS call from ReShade\'s depth and estimated motion vectors.',
    limits: 'The motion vectors are estimated, so fast motion ghosts more. On OpenGL, ReShade goes in as the game\'s opengl32.dll.',
    panel: PANEL,
  },
  feeder32: {
    does: 'Experimental. A 32-bit game cannot run DLSS itself, so each frame goes to a 64-bit helper beside the game, where OptiScaler runs DLSS 5.',
    limits: 'Not yet confirmed on many games. The helper needs the game windowed or borderless to show anything.',
    panel: 'Press Alt+Home in the game for the DLSS 5 panel. The helper draws it over the game, and it takes clicks there.',
  },
  dx9: {
    does: 'Experimental. dgVoodoo2 turns DirectX 9 into DirectX 11, then the DLSS5 Feeder and OptiScaler work as on any DX11 game.',
    limits: 'If dgVoodoo2 crashes the game, this route is not for it yet. Motion vectors are estimated, so fast motion ghosts more.',
    panel: PANEL,
  },
  emulator: {
    does: 'Experimental. The DLSS5 Feeder makes a DLSS call inside {name}, for every game it runs.',
    limits: 'Set the emulator\'s renderer first. ReShade often cannot see a console game\'s depth inside an emulator, which leaves DLSS 5 little to work with.',
    panel: PANEL,
  },
  'emulator-opengl': {
    does: 'Experimental. The DLSS5 Feeder makes a DLSS call inside {name}, for every game it runs.',
    limits: 'OptiScaler cannot draw anything over OpenGL. Use the emulator\'s Direct3D or Vulkan renderer if it has one.',
    panel: null,
    popout: 'only',
  },
  present: {
    does: 'DLSS 5 runs at the end of each frame, on top of the game\'s own anti-aliasing. OptiScaler finds the depth itself: no Feeder, nothing to download.',
    limits: 'There are no motion vectors on this route, so fast motion may ghost. Menus have no depth: load a save to see it work.',
    panel: PANEL,
  },
  lumaue: {
    does: 'A Luma-Framework mod adds real DLSS to the game, with its own motion vectors, and OptiScaler adds DLSS 5 on top.',
    limits: 'Luma needs DirectX 11: pick it in the game\'s settings and turn the game\'s own DLSS off. Luma asks you to confirm its licence first.',
    panel: PANEL,
  },
  amdnr: {
    does: 'On an AMD card, danielblnc\'s DLSS-NR-on-AMD replaces this app\'s NVIDIA stack and hooks the game\'s own FSR 3/4.',
    limits: 'Alpha. DX12 games with FSR on only, Windows 11, Adrenalin 26.1.1 or newer, no anti-cheat.',
    panel: null,
  },
  unsupported: {
    does: 'Nothing this app installs can reach this game\'s graphics.',
    limits: null,
    panel: null,
  },
  unknown: {
    does: 'The game has no DLSS of its own, and its graphics API is not known yet.',
    limits: 'Choose the API in Edit, or for a Unity game run it once and it is re-checked.',
    panel: null,
  },
};

// The translation layer choices on a DirectX 8/9 or 32-bit DirectX 10/11 game (Edit's layer select).
const LAYERS = {
  dgvoodoo: 'dgVoodoo2 turns the game\'s DirectX 8/9 into Direct3D 11. Most games run under it, but some draw a black screen (Assassin\'s Creed II).',
  dxvk: 'DXVK turns the game\'s Direct3D into Vulkan. Some games only draw under it. On a 32-bit game it needs ReShade\'s 32-bit Vulkan layer, which asks for administrator permission and is installed for the whole PC.',
  native: 'The game draws with its own Direct3D, with nothing in between. This is the default.',
};

// Which entry explains a route result from route.js recommendRoute(), given the API the route was
// decided for (route.js knows it; the result does not carry it). Pure.
function explainKey(route, api = null) {
  if (!route || !route.route) return null;
  const r = route.route;
  // The state, not the route id: route.js goes on recommending the route the game could have.
  if (route.nrModelOnly) return 'nr-model-only';
  if (r === 'feeder') {
    if (route.emulator) return api === 'opengl' ? 'emulator-opengl' : 'emulator';
    if (route.legacy && route.legacy.api === 'dx9') return 'dx9';
    if (api === 'vulkan') return 'feeder-vulkan';
    if (api === 'opengl') return 'feeder-opengl';
    return 'feeder';
  }
  // RE Engine games keep their old route id for saved state (route.js), but it is the Present route.
  if (r === 'reframework-pd') return 'present';
  return Object.prototype.hasOwnProperty.call(ROUTES, r) ? r : null;
}

// { key, does, limits, panel, vars } with English templates, or null for a route with no entry.
function explainRoute(route, api = null) {
  const key = explainKey(route, api);
  if (!key) return null;
  const e = ROUTES[key];
  const vars = route.emulator ? { name: route.emulator.name || '' } : null;
  // An engine build that draws nothing in the game (engines.js `panel: false`) takes the in-game line
  // away and leaves the break-away panel as the only way in. The model-only route keeps its own words:
  // nothing of ours is in that game whatever the build, so neither panel can reach it.
  const buildDrawsNothing = route.enginePanel === false && key !== 'nr-model-only';
  const panel = buildDrawsNothing ? null : e.panel;
  // Default: a route that draws its own panel offers the break-away one as a fallback; a route that
  // draws none offers nothing, unless its entry says OptiScaler is still there to be configured.
  const popout = e.popout !== undefined ? e.popout : (panel ? 'fallback' : (buildDrawsNothing ? 'only' : null));
  return { key, does: e.does, limits: e.limits, panel, popout, vars };
}

function explainLayer(layer) {
  return Object.prototype.hasOwnProperty.call(LAYERS, layer) ? LAYERS[layer] : null;
}

// Every English string this module can hand the renderer, for the translation tests.
function allStrings() {
  const out = new Set([PANEL]);
  for (const e of Object.values(ROUTES)) for (const s of [e.does, e.limits, e.panel]) if (s) out.add(s);
  for (const s of Object.values(LAYERS)) out.add(s);
  return [...out];
}

module.exports = { ROUTES, LAYERS, explainKey, explainRoute, explainLayer, allStrings };
