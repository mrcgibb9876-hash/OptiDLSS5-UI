// The DLSS 5 neural-rendering settings, as data, so they can be tuned from this app instead of
// only from the in-game panel.
//
// Why this exists: on the 32-bit route OptiScaler runs in a helper process with no window of its
// own, so the in-game panel is reachable only through the Feeder add-on ("Show the DLSS 5 panel
// in-game", then Insert) -- and a user with a working install and 3976 frames delivered still had
// no way to change a single setting (reported 2026-09-14). The settings themselves are only an ini
// file, in host64\OptiScaler.ini or beside the exe depending on the route, so the app can edit them
// wherever they live. It is also the only way to change anything without launching the game first.
//
// Every field below is transcribed from the [DlssNr] section of the OptiScaler_DLSSNR release ini,
// which is the authority for names, defaults and ranges; the older reverse-engineered panel notes
// agree on the ones they cover. "auto" in the file means "use the default" -- it is a real third
// state, not a missing value, and the in-game panel writes it back for anything that equals its
// default, so a value and its default-as-auto must read the same way round-trip.

'use strict';

const fs = require('node:fs');
const { setIniKey, getIniKey } = require('./ini-merge');

const SECTION = 'DlssNr';

const PRESETS = [[0, 'Default'], [1, 'Model A'], [2, 'Model B'], [3, 'Model C']];
const STYLES = [[0, 'Default (standard)'], [1, 'Natural'], [2, 'Cinematic']];
const DOWNSCALERS = [[0, 'FSR1'], [1, 'Bicubic'], [2, 'Catmull-Rom'], [3, 'Lanczos2'], [4, 'Lanczos3'], [5, 'Kaiser2'], [6, 'Kaiser3'], [7, 'MAGIC']];
const REVERSIBLE = [[0, 'Off (soft knee)'], [1, 'Neutwo proxy + composed'], [2, 'Neutwo proxy + replace'], [3, 'Hybrid proxy + composed'], [4, 'Hybrid proxy + replace']];
const WHITE_POINT_SOURCES = [[0, 'Paper white only'], [1, "The game's own exposure"], [2, 'A buffer the scan found']];

// group / label / order are the in-game panel's own, section for section and row for row, because
// the two are the same panel in two places and a user who learns one must not have to relearn the
// other. Anything the in-game panel draws that is not an ini key is not here: those are actions on
// a live frame (Capture 8 frames, Anchor here, Show Mask) or state the engine owns, and a window
// outside the process has nothing to write for them.
const FIELDS = [
  // The top block, above the first caption in the in-game panel.
  { key: 'Enabled', type: 'bool', default: false, group: 'DLSS 5', label: 'DLSS ON', caps: true,
    help: "Synthesises detail in the upscaler's frame, before frame generation sees it. Install turns this on when the model file is in place; off here is off for this game." },
  { key: 'ApplyModel', type: 'bool', default: true, group: 'DLSS 5', label: 'Apply the model',
    help: "Off runs the whole pass and throws the answer away -- the cost without the picture. A measurement, not a setting." },
  { key: 'RunBeforeSR', type: 'bool', default: false, group: 'DLSS 5', label: 'Before Super Resolution',
    help: "Runs the pass on the pre-upscale colour at render resolution instead of after upscaling. Leave off on a Feeder game: there is no real pre-upscale frame there, and on Armored Core VI it faulted inside the model every time." },

  { key: 'LocalStructure', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, group: 'Global Controls',
    label: 'Structure Intensity', help: "The model's local structure control." },
  { key: 'LocalTone', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, group: 'Global Controls',
    label: 'Tone Intensity', help: "The model's local tone control." },
  { key: 'AutoMask', type: 'bool', default: true, group: 'Global Controls', label: 'Model Automask', caps: true,
    help: "The model's own masking." },
  { key: 'SkinStructure', type: 'float', default: -1.0, min: -1, max: 1, step: 0.01, group: 'Global Controls',
    label: 'Structure Intensity', dependsOn: { key: 'AutoMask', is: true },
    help: "Structure intensity for what the automask reads as skin. -1 means follow the structure intensity above, which is the model's own default -- not a strength of zero." },

  { key: 'Preset', type: 'enum', default: 0, options: PRESETS, group: 'Models', segmented: true,
    label: 'Model', help: "Which built-in model profile the pass uses. Undocumented, and not the same scale Super Resolution or Ray Reconstruction uses. Changing it rebuilds the feature." },
  { key: 'Style', type: 'enum', default: 0, options: STYLES, group: 'Models',
    label: 'Style', help: "The model profile's look. Changing it rebuilds the feature." },
  { key: 'Intensity', type: 'float', default: 1.0, min: 0, max: 2, step: 0.01, group: 'Models',
    label: 'Intensity', help: "The model's own strength control. Create-time: changing it rebuilds the feature." },

  { key: 'Passes', type: 'int', default: 1, min: 1, max: 3, group: 'Cost',
    label: 'Model passes', help: "Sequential model layers. 1 is normal; 2 often reads as richer; 3 is usually visibly over-processed. Each costs another whole run of the model." },
  { key: 'ChainedHistory', type: 'bool', default: true, group: 'Cost', label: 'Chained temporal history',
    dependsOn: { key: 'Passes', atLeast: 2 },
    help: "What the stacked passes do with their temporal history between frames." },
  { key: 'Pass2Preset', type: 'enum', default: null, options: PRESETS, group: 'Cost', label: 'Pass 2 model',
    dependsOn: { key: 'Passes', atLeast: 2 }, help: "Left on default, pass 2 uses the model above." },
  { key: 'Pass2Style', type: 'enum', default: null, options: STYLES, group: 'Cost', label: 'Pass 2 style',
    dependsOn: { key: 'Passes', atLeast: 2 }, help: "Left on default, pass 2 uses the style above." },
  { key: 'Pass3Preset', type: 'enum', default: null, options: PRESETS, group: 'Cost', label: 'Pass 3 model',
    dependsOn: { key: 'Passes', atLeast: 3 }, help: "Left on default, pass 3 uses the model above." },
  { key: 'Pass3Style', type: 'enum', default: null, options: STYLES, group: 'Cost', label: 'Pass 3 style',
    dependsOn: { key: 'Passes', atLeast: 3 }, help: "Left on default, pass 3 uses the style above." },
  { key: 'WorkingScale', type: 'float', default: 1.0, min: 0.25, max: 2, step: 0.01, percent: true, group: 'Cost',
    label: 'Model resolution',
    help: "What fraction of the frame the model works at. Cost falls with the square of this, so half resolution is roughly a quarter of the time. Below 100% the frame itself is never reduced -- only the model's own contribution is computed small and enlarged. Above 100% (DX12 and Vulkan) the model supersamples." },
  { key: 'ScalingDownscaler', type: 'enum', default: 4, options: DOWNSCALERS, group: 'Cost', label: 'Downscaler',
    dependsOn: { key: 'WorkingScale', above: 1 },
    help: "The filter that averages the model's above-native answer back to display size. Sharper filters (Lanczos3, Kaiser3) keep the most detail; softer ones (Bicubic, Catmull-Rom) are gentler on ringing. Only used above 100%." },
  { key: 'Transfer', type: 'enum', default: 1, options: [[0, 'Classic'], [1, 'Matched residual']], group: 'Cost',
    label: 'Enlargement', dependsOn: { key: 'WorkingScale', below: 1 },
    help: "How the model's work is brought back up when it ran below the frame's size. Classic composes the model's small picture directly against the full-size frame, which cannot tell the shrink's blur apart from the model's edit. Only used below 100%." },

  { key: 'TransferStrength', type: 'float', default: 1.0, min: 0, max: 2, step: 0.01, group: 'How much of it lands',
    label: 'Detail strength',
    help: "How far the frame moves toward the model's picture. 0 gives back exactly what the upscaler produced, 1 is the model's picture, above 1 carries on past it." },
  { key: 'ColourStrength', type: 'float', default: 1.0, min: 0, max: 4, step: 0.01, group: 'How much of it lands',
    label: 'Colour strength',
    help: "0 keeps the game's own hue exactly and lets only brightness carry the model's verdict; 1 brings the model's colour as well." },

  { key: 'ReversibleMode', type: 'enum', default: 0, options: REVERSIBLE, group: 'Colour', label: 'Reversible proxy',
    help: "What the model is shown, and how its answer comes back. Experimental. Off (soft knee) is the default. Hybrid composed is the one to use: identity in the midtones, with the unclipped roll only in the highlights. Replace is a reference, not a daily setting -- bright lights flash in motion." },
  { key: 'WhitePointSource', type: 'enum', default: 1, options: WHITE_POINT_SOURCES, group: 'Colour',
    label: 'White point from',
    help: "Paper white only -- the slider below and nothing else; wrong the moment the game's exposure moves. The game's own exposure -- the best source there is, when the game supplies one. A buffer the scan found -- a guess, for games that compute an exposure and never pass it on." },
  { key: 'WhitePointTrim', type: 'float', default: 1.0, min: 0.25, max: 4, step: 0.01, log: true, group: 'Colour',
    label: "Trim (x the game's exposure)", dependsOn: { key: 'WhitePointSource', is: 1 },
    help: "Multiplies the exposure read from the game before the encode uses it." },
  { key: 'WhitePointScale', type: 'float', default: 1.0, min: 0.25, max: 2000, step: 0.01, log: true, group: 'Colour',
    label: 'Paper white',
    help: "Multiplies the white point the encode maps to display white before the model sees the frame. Applies only to a linear buffer." },
  { key: 'MaxRatio', type: 'float', default: 2.0, min: 1, max: 8, step: 0.1, group: 'Colour',
    label: 'Highlight guard',
    help: "The most the pass may brighten any pixel, as a multiple of what it already was. Darkening is not capped. Guards against a bright light becoming a string of coloured cells." },

  { key: 'ScanMeter', type: 'bool', default: false, group: 'Exposure scan', label: 'Show the light meter on screen',
    dependsOn: { key: 'WhitePointSource', is: 2 }, help: "Draws what the scan is reading, over the game." },
  { key: 'ScanTrim', type: 'float', default: 1.0, min: 0.25, max: 4, step: 0.01, log: true, group: 'Exposure scan',
    label: 'Trim (x the scan)', dependsOn: { key: 'WhitePointSource', is: 2 },
    help: "Multiplies the scanned value before the encode uses it." },
  { key: 'ScanInverted', type: 'bool', default: false, group: 'Exposure scan', label: 'The number runs the other way',
    dependsOn: { key: 'WhitePointSource', is: 2 },
    help: "Some games store the reciprocal of the exposure. Set this when brighter scenes come out darker." },

  { key: 'DepthConvention', type: 'enum', default: 0, group: 'Guide',
    options: [[0, 'Follow the game'], [1, 'Force normal'], [2, 'Force inverted']],
    label: 'Depth', help: "Which end of the depth buffer is near. Only worth touching if the in-game Guide section reports the wrong one." },
  { key: 'UICorrection', type: 'bool', default: true, group: 'Guide', label: 'UI correction',
    help: "Holds the game's UI still while the model works on the frame behind it, so text and crosshairs are not redrawn by the model." },

  { key: 'AutoCapture', type: 'bool', default: true, group: 'Inspect', label: 'Auto-capture once per session',
    help: "Writes matched before/after frames to a dlssnr-capture folder beside OptiScaler when the pass first runs. Bounded to eight frames; each run overwrites the last." },
  { key: 'HoldFrame', type: 'bool', default: false, group: 'Inspect', label: 'Hold frame',
    help: "Freezes the picture the comparison views draw, so a still can be studied while the game carries on." },
  { key: 'Compare', type: 'enum', default: 0, options: [[0, 'Off'], [1, 'Side by side'], [2, 'Wipe']], group: 'Inspect',
    label: 'Compare', help: "Puts the frame with the pass next to (or behind a wipe against) the frame without it." },
  { key: 'CompareSwap', type: 'bool', default: false, group: 'Inspect', label: 'Swap sides',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Which side is the frame with the pass on." },
  { key: 'CompareTags', type: 'bool', default: false, group: 'Inspect', label: 'Labels',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Names each side on screen." },
  { key: 'TagScale', type: 'float', default: 1.5, min: 0.5, max: 5, step: 0.1, group: 'Inspect', label: 'Label size',
    dependsOn: { key: 'CompareTags', is: true }, help: "How large those labels are drawn." },
  { key: 'CompareZoom', type: 'float', default: 1.0, min: 1, max: 2, step: 0.01, group: 'Inspect', label: 'Zoom',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Magnifies both sides equally, so fine detail is visible at all." },
  { key: 'CompareSplit', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Inspect', label: 'Split',
    dependsOn: { key: 'Compare', is: 2 }, help: "Where the wipe sits across the frame." },
  { key: 'DebugView', type: 'enum', default: 0, group: 'Inspect',
    options: [[0, 'Off'], [1, 'Proxy (what the model sees)'], [2, 'Model output (raw)'], [3, 'Difference (amplified)']],
    label: 'Debug view',
    help: "Proxy is the picture handed to the model. Difference shows what the model actually changed, amplified twenty times and centred on grey. A flat grey difference view means the model is doing nothing. Leave off for play." },

  { key: 'ProxyProbe', type: 'bool', default: false, group: 'Experimental', label: 'Probe the driver',
    help: "Asks the driver what it would do with the proxy, without using the answer. Experimental." },
  { key: 'UseProxy', type: 'bool', default: false, group: 'Experimental', label: 'Run through the driver',
    help: "Runs the pass through the driver's own path rather than this build's. Experimental." },
  { key: 'OpticalFlow', type: 'bool', default: true, group: 'Experimental', label: 'Optical flow',
    help: "Gives the model motion between frames. Off is a diagnostic." },

  { key: 'LightTheme', type: 'bool', default: true, group: 'Appearance', label: 'Light panel',
    help: "The in-game panel's own colours. This window follows the same setting." },
  { key: 'VendorColours', type: 'bool', default: true, group: 'Appearance', label: 'Vendor colours',
    help: "NVIDIA green, or AMD red on an AMD card. Off keeps green everywhere." },
  { key: 'FontScale', type: 'float', default: 1.15, min: 0.75, max: 2, step: 0.05, group: 'Appearance',
    label: 'Font size', help: "The in-game panel's text only -- OptiScaler's own menu keeps its [Menu] FontSize." },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key.toLowerCase(), f]));
const GROUPS = [...new Set(FIELDS.map((f) => f.group))];

const isAuto = (raw) => raw === null || raw === undefined || String(raw).trim() === '' || /^auto$/i.test(String(raw).trim());

// A stored value as the form should show it: null means "auto", i.e. use the default.
function parseValue(field, raw) {
  if (isAuto(raw)) return null;
  const text = String(raw).trim();
  if (field.type === 'bool') {
    if (/^(true|1)$/i.test(text)) return true;
    if (/^(false|0)$/i.test(text)) return false;
    return null;
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (field.type === 'int' || field.type === 'enum') {
    const v = Math.round(n);
    if (field.type === 'enum' && field.options && !field.options.some(([o]) => o === v)) return null;
    if (field.type === 'int') return Math.min(field.max, Math.max(field.min, v));
    return v;
  }
  return Math.min(field.max, Math.max(field.min, n));
}

function formatValue(field, value) {
  if (value === null || value === undefined) return 'auto';
  if (field.type === 'bool') return value ? 'true' : 'false';
  if (field.type === 'float') return String(Number(value));
  return String(Math.round(Number(value)));
}

// Everything the form needs for one game: each field, its stored value (null = auto) and the
// default that applies when it is auto.
function readSettings(iniPath) {
  let text = '';
  try { text = fs.readFileSync(iniPath, 'utf8'); } catch { text = ''; }
  return FIELDS.map((f) => ({
    key: f.key,
    group: f.group,
    label: f.label,
    help: f.help,
    type: f.type,
    options: f.options || null,
    min: f.min === undefined ? null : f.min,
    max: f.max === undefined ? null : f.max,
    step: f.step === undefined ? null : f.step,
    dependsOn: f.dependsOn || null,
    // How the row is drawn, as opposed to what it means: the segmented Models pills, the
    // letter-tracked caps of a section-level row, a log track for a range no linear slider can
    // resolve, and a value shown as a percentage. All four match the in-game panel.
    segmented: f.segmented || false,
    caps: f.caps || false,
    log: f.log || false,
    percent: f.percent || false,
    default: f.default,
    value: parseValue(f, getIniKey(text, SECTION, f.key)),
  }));
}

// Writes only what changed, and writes "auto" for anything set back to its default -- the same
// thing the in-game panel's own save does, so the two agree about what a default looks like.
// Returns the keys actually written.
function writeSettings(iniPath, values) {
  let text;
  try { text = fs.readFileSync(iniPath, 'utf8'); } catch { return { ok: false, error: 'OptiScaler.ini not found', written: [] }; }
  const written = [];
  for (const [key, wanted] of Object.entries(values || {})) {
    const field = BY_KEY.get(String(key).toLowerCase());
    if (!field) continue;
    let next = wanted === null || wanted === undefined ? null : parseValue(field, wanted);
    // A value set back to its default is stored as auto rather than as the literal. The in-game
    // panel does the same on its own save, so without this the two disagree about what a default
    // looks like on disk and every round trip through one of them rewrites the other's work.
    if (next !== null && field.default !== null && next === field.default) next = null;
    const current = parseValue(field, getIniKey(text, SECTION, field.key));
    if (next === current) continue;
    text = setIniKey(text, SECTION, field.key, formatValue(field, next));
    written.push(field.key);
  }
  if (written.length === 0) return { ok: true, written: [] };
  try {
    fs.writeFileSync(iniPath, text, 'utf8');
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), written: [] };
  }
  return { ok: true, written };
}

module.exports = { FIELDS, GROUPS, SECTION, readSettings, writeSettings, parseValue, formatValue, isAuto };
