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
const STYLES = [[0, 'Standard'], [1, 'Natural'], [2, 'Cinematic']];

// group: how the panel itself lays these out, kept so the two do not drift apart.
const FIELDS = [
  {
    key: 'Enabled', type: 'bool', default: false, group: 'Neural Rendering',
    label: 'Neural Rendering on',
    help: 'The pass itself. Install turns this on when the model file is in place; off here is off for this game.',
  },
  {
    key: 'RunBeforeSR', type: 'bool', default: false, group: 'Neural Rendering',
    label: 'Run before Super Resolution',
    help: 'Runs the pass on the pre-upscale colour at render resolution instead of after upscaling. Leave off on a Feeder game: there is no real pre-upscale frame there, and on Armored Core VI it faulted inside the model every time.',
  },
  {
    key: 'Passes', type: 'int', default: 1, min: 1, max: 3, group: 'Neural Rendering',
    label: 'Passes',
    help: 'Sequential model layers. 1 is normal; 2 and 3 are deliberately over-processed and cost almost exactly twice and three times the model time.',
  },

  {
    key: 'Preset', type: 'enum', default: 0, options: PRESETS, group: 'Model',
    label: 'Model', help: 'Which built-in model profile the pass uses. Undocumented, and not the same scale Super Resolution or Ray Reconstruction uses. Changing it rebuilds the feature.',
  },
  {
    key: 'Style', type: 'enum', default: 0, options: STYLES, group: 'Model',
    label: 'Style', help: 'The model profile\'s look. Changing it rebuilds the feature.',
  },
  { key: 'Pass2Preset', type: 'enum', default: null, options: PRESETS, group: 'Model', label: 'Pass 2 model', help: 'Left on default, pass 2 uses the model above. Only meaningful with Passes at 2 or more.', dependsOn: { key: 'Passes', atLeast: 2 } },
  { key: 'Pass2Style', type: 'enum', default: null, options: STYLES, group: 'Model', label: 'Pass 2 style', help: 'Left on default, pass 2 uses the style above.', dependsOn: { key: 'Passes', atLeast: 2 } },
  { key: 'Pass3Preset', type: 'enum', default: null, options: PRESETS, group: 'Model', label: 'Pass 3 model', help: 'Left on default, pass 3 uses the model above. Only meaningful with Passes at 3.', dependsOn: { key: 'Passes', atLeast: 3 } },
  { key: 'Pass3Style', type: 'enum', default: null, options: STYLES, group: 'Model', label: 'Pass 3 style', help: 'Left on default, pass 3 uses the style above.', dependsOn: { key: 'Passes', atLeast: 3 } },

  {
    key: 'Intensity', type: 'float', default: 1.0, min: 0, max: 2, step: 0.05, group: 'Strength',
    label: 'Intensity', help: 'The model\'s own strength control. Create-time: changing it rebuilds the feature.',
  },
  {
    key: 'TransferStrength', type: 'float', default: 1.0, min: 0, max: 2, step: 0.05, group: 'Strength',
    label: 'Detail strength',
    help: 'How far the frame moves toward the model\'s picture. 0 gives back exactly what the upscaler produced, 1 is the model\'s picture, above 1 carries on past it.',
  },
  {
    key: 'ColourStrength', type: 'float', default: 1.0, min: 0, max: 1, step: 0.05, group: 'Strength',
    label: 'Colour strength',
    help: '0 keeps the game\'s own hue exactly and lets only brightness carry the model\'s verdict; 1 brings the model\'s colour as well.',
  },
  { key: 'LocalStructure', type: 'float', default: 1.0, min: 0, max: 1, step: 0.05, group: 'Strength', label: 'Structure intensity', help: 'The model\'s local structure control.' },
  { key: 'LocalTone', type: 'float', default: 1.0, min: 0, max: 1, step: 0.05, group: 'Strength', label: 'Tone intensity', help: 'The model\'s local tone control.' },

  { key: 'AutoMask', type: 'bool', default: true, group: 'Masking', label: 'Model automask', help: 'The model\'s own masking.' },
  {
    key: 'SkinStructure', type: 'float', default: -1.0, min: -1, max: 1, step: 0.05, group: 'Masking',
    label: 'Skin structure',
    help: '-1 means follow the structure intensity above, which is the model\'s own default -- not a strength of zero.',
    dependsOn: { key: 'AutoMask', is: true },
  },

  {
    key: 'WhitePointScale', type: 'float', default: 1.0, min: 0.25, max: 4, step: 0.05, group: 'Colour',
    label: 'Paper white',
    help: 'Multiplies the white point the encode maps to display white before the model sees the frame. Applies only to a linear buffer.',
  },
  {
    key: 'MaxRatio', type: 'float', default: 2.0, min: 1, max: 8, step: 0.1, group: 'Colour',
    label: 'Highlight guard',
    help: 'The most the pass may brighten any pixel, as a multiple of what it already was. Darkening is not capped. Guards against a bright light becoming a string of coloured cells.',
  },
  { key: 'UICorrection', type: 'bool', default: true, group: 'Colour', label: 'UI correction', help: 'Holds the game\'s UI still while the model works on the frame behind it, so text and crosshairs are not redrawn by the model.' },

  {
    key: 'WorkingScale', type: 'float', default: 1.0, min: 0.25, max: 2, step: 0.05, group: 'Cost',
    label: 'Model resolution',
    help: 'What fraction of the frame the model works at. The frame itself is never reduced. Cost falls with the square of this. Above 1.0 (DX12 and Vulkan) the model supersamples.',
  },
  {
    key: 'ScalingDownscaler', type: 'enum', default: 4, group: 'Cost',
    options: [[0, 'FSR1'], [1, 'Bicubic'], [2, 'CatmullRom'], [3, 'Lanczos2'], [4, 'Lanczos3'], [5, 'Kaiser2'], [6, 'Kaiser3'], [7, 'MAGIC']],
    label: 'Supersample downscaler',
    help: 'Averages the model\'s answer back to native when model resolution is above 1.0. Only used then.',
    dependsOn: { key: 'WorkingScale', above: 1 },
  },

  {
    key: 'DepthConvention', type: 'enum', default: 0, group: 'Guide',
    options: [[0, 'Detect from the frame'], [1, 'Force reversed-Z (near = 1)'], [2, 'Force conventional (near = 0)']],
    label: 'Depth', help: 'Which end of the depth buffer is near. Only worth touching if the in-game Guide section reports the wrong one.',
  },
  {
    key: 'DebugView', type: 'enum', default: 0, group: 'Guide',
    options: [[0, 'Off'], [1, 'What the model sees'], [2, 'Its raw answer'], [3, 'What it changed, amplified 20x']],
    label: 'Debug view', help: 'A flat grey difference view means the model is doing nothing. Leave off for play.',
  },
  { key: 'AutoCapture', type: 'bool', default: true, group: 'Guide', label: 'Auto-capture once per run', help: 'Writes matched before/after frames to a dlssnr-capture folder beside OptiScaler when the pass first runs. Bounded to eight frames; each run overwrites the last.' },
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
