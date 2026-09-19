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

// Virtual-key codes and the engine's modifier bits (OptiScaler Config.h). Only the keys the panel
// hotkey list offers -- this is not meant to become a full VK table.
const VK = { HOME: 0x24, END: 0x23, INSERT: 0x2D, DELETE: 0x2E, F10: 0x79 };
const MOD = { ALT: 0x0100, CTRL: 0x0200, SHIFT: 0x0400 };
const VK_NAME = { 0x24: 'Home', 0x23: 'End', 0x2D: 'Insert', 0x2E: 'Delete', 0x79: 'F10' };

// A bind the list does not offer -- set in the in-game panel, or by hand -- still has to read back
// honestly. Without this the dialog would show "Alt+Home (default)" over an ini that says
// something else, and the first edit of any other field would look like it had moved the key.
function describeKeybind(code) {
  const vk = code & 0x00FF;
  const parts = [];
  if (code & MOD.CTRL) parts.push('Ctrl');
  if (code & MOD.ALT) parts.push('Alt');
  if (code & MOD.SHIFT) parts.push('Shift');
  parts.push(VK_NAME[vk] || `key 0x${vk.toString(16).toUpperCase().padStart(2, '0')}`);
  return parts.join('+');
}

const PRESETS = [[0, 'Default'], [1, 'Model A'], [2, 'Model B'], [3, 'Model C']];
const STYLES = [[0, 'Default (standard)'], [1, 'Natural'], [2, 'Cinematic']];
const DOWNSCALERS = [[0, 'FSR1'], [1, 'Bicubic'], [2, 'Catmull-Rom'], [3, 'Lanczos2'], [4, 'Lanczos3'], [5, 'Kaiser2'], [6, 'Kaiser3'], [7, 'MAGIC']];
const REVERSIBLE = [[0, 'Off (soft knee)'], [1, 'Neutwo proxy + composed'], [2, 'Neutwo proxy + replace'], [3, 'Hybrid proxy + composed'], [4, 'Hybrid proxy + replace']];
// The codes the engine writes for [DlssNr] Language, lower-cased, as its own panel writes them.
const LANGUAGES = [
  ['en', 'English'], ['pt-br', 'Português (Brasil)'], ['ru', 'Русский'], ['ko', '한국어'],
  ['zh-cn', '简体中文'], ['es', 'Español'], ['de', 'Deutsch'], ['fr', 'Français'],
];

const WHITE_POINT_SOURCES = [[0, 'Paper white only'], [1, "The game's own exposure"], [2, 'A buffer the scan found']];

// group / label / order are the in-game panel's own, section for section and row for row, because
// the two are the same panel in two places and a user who learns one must not have to relearn the
// other. Anything the in-game panel draws that is not an ini key is not here: those are actions on
// a live frame (Capture 8 frames, Anchor here, Show Mask) or state the engine owns, and a window
// outside the process has nothing to write for them.
const FIELDS = [
  // The top block, above the first caption in the in-game panel. Light panel first, as there (2026-09-19).
  { key: 'LightTheme', type: 'bool', default: true, group: 'DLSS 5', label: 'Light panel',
    help: "Light is the default. The dark palette this panel was originally styled after put its dimmed text at 2.65:1 against the background, against the 4.5:1 that reads comfortably -- and an overlay is read at a glance, over a moving picture.\n\nUnticking restores NVIDIA's own colouring." },
  { key: 'Enabled', type: 'bool', default: false, group: 'DLSS 5', label: 'DLSS ON', caps: true,
    help: "Synthesises detail in the upscaler's frame, before frame generation sees it.\n\nNeeds two similarly named files beside OptiScaler, one character apart: nvngx_dlssnr.dll       NVIDIA's model (~165 MB) -- you supply it nvngx.dll_dlssnr.dll   the forwarder (~13 KB) -- ships in this package Undocumented and driven directly, so none of this is officially supported." },
  { key: 'ApplyModel', type: 'bool', default: true, group: 'DLSS 5', label: 'Apply the model',
    help: "Whether the model's edit is applied. Off shows the clean upscaler frame while the pass keeps running -- so with Hold frame, under Inspect, you can freeze a frame and toggle this to see the same frozen frame with and without Neural Rendering. Leave it on for normal use." },
  { key: 'RunBeforeSR', type: 'bool', default: false, group: 'DLSS 5', label: 'Before Super Resolution',
    help: "Where the pass sits. Off is the original placement: the model runs on the finished upscaled frame. On runs it at render resolution on the colour SR is about to consume, so SR then accumulates and upscales an already-enhanced picture.\n\nRay Reconstruction always stays on the post-upscale path -- its inputs are a different contract. A colour image padded inside a larger texture is staged at its real size; one offset from the corner still falls back after upscaling.\n\nD3D12 and its D3D11/Vulkan bridges only; native Vulkan keeps the old placement." },
  // [DlssNr] RunBeforeRR (engine v1.0.38): the same placement for Ray Reconstruction, experimentally.
  { key: 'RunBeforeRR', type: 'bool', default: false, group: 'DLSS 5', label: 'Before Ray Reconstruction (experimental)',
    dependsOn: { key: 'RunBeforeSR', is: true },
    help: "Also runs the pass before Ray Reconstruction, at render resolution, on the colour it is about to denoise and upscale -- far cheaper than after it.\n\nEXPERIMENTAL: that colour is the noisy ray-traced frame rather than a finished one, so the model may enhance noise and Ray Reconstruction may smear what it added. Try it, compare, and turn it off if it looks worse. Needs Before Super Resolution on." },
  // Adaptive resolution (engine v2.1: DlssNr_Menu.cpp DrawAutoScale, DlssNrBudget.h). Labels, ranges and
  // help are the in-game panel's own; its help is hard-wrapped there and reflowed here, like every other
  // help text in this file. AutoScalePrebuild is not a panel row in the engine either, so it is not here.
  { key: 'AutoScale', type: 'bool', default: false, group: 'Adaptive resolution', label: 'Adjust it for me',
    help: "Moves Model resolution up and down while you play, so the pass costs what you asked it to cost instead of what one number chosen before the game started happens to cost in this scene.\n\nIt only ever changes the MODEL's resolution. The frame is never reduced, so this cannot soften the picture the way a dynamic render resolution does -- the most it can cost is some of the model's own detail.\n\nIt steps between four settings a few seconds apart at most, because each change rebuilds the model and rebuilding it every frame would be slower than doing nothing." },
  { key: 'AutoScaleMode', type: 'enum', default: 2, options: [[0, 'Share of the frame'], [1, 'Milliseconds'], [2, 'Frame rate']],
    group: 'Adaptive resolution', label: 'Aim at', dependsOn: { key: 'AutoScale', is: true },
    help: "Frame rate: aim at a number of frames per second. The one most people want, and the only one that can fall short -- the pass can give back what it costs and no more, so if the game itself cannot reach the number, the panel says so.\n\nMilliseconds: hold the pass under a flat time. Exactly what the cost line above measures, with no arithmetic in between.\n\nShare of the frame: let the pass take at most a percentage of each frame. This one looks after itself as the frame rate moves - 15% is 2.5 ms at 60 fps and 1.25 at 120." },
  { key: 'AutoScaleFps', type: 'int', default: 60, min: 30, max: 240, step: 1, group: 'Adaptive resolution', label: 'Frame rate',
    dependsOn: { all: [{ key: 'AutoScale', is: true }, { key: 'AutoScaleMode', is: 2 }] },
    help: "The frame rate to aim at. Applied live - there is nothing to rebuild for a change of target, only for a change of model resolution it leads to." },
  { key: 'AutoScaleMs', type: 'float', default: 2.0, min: 0.5, max: 10, step: 0.1, group: 'Adaptive resolution', label: 'Cost ceiling',
    dependsOn: { all: [{ key: 'AutoScale', is: true }, { key: 'AutoScaleMode', is: 1 }] },
    help: "The most the pass may cost, in milliseconds. Compare it with the cost shown at the top of this panel, which is the same measurement." },
  { key: 'AutoScaleShare', type: 'int', default: 15, min: 2, max: 50, step: 1, group: 'Adaptive resolution', label: 'Share of the frame',
    dependsOn: { all: [{ key: 'AutoScale', is: true }, { key: 'AutoScaleMode', is: 0 }] },
    help: "How much of each frame the pass may take." },
  { key: 'AutoScaleFloor', type: 'float', default: 0.55, min: 0.55, max: 1, step: 0.01, percent: true, group: 'Adaptive resolution',
    label: 'Never go below', dependsOn: { key: 'AutoScale', is: true },
    help: "The lowest model resolution this may choose. Raise it to keep more of the model's detail and let the frame rate give way instead.\n\nIt stops here because this is where the trade changes character: above it the model is simply working on a smaller picture, and below it fine detail - hair, foliage, thin edges - starts to break down rather than soften." },
  // Model passes right under Adaptive resolution, as in the in-game panel (2026-09-19): the two things that
  // decide what the pass costs, together.
  { key: 'Passes', type: 'int', default: 1, min: 1, max: 3, group: 'Adaptive resolution',
    label: 'Model passes', help: "How many times the model runs before its answer is composed. Each extra layer is fed the previous layer's output and keeps its own temporal history.\n\nThe base frame stays untouched and the composition happens once at the end, so colour and transfer strength do not compound -- but the model is being asked to enhance its own output, which is outside what it was trained on.\n\nCost is very nearly linear: the model is almost the whole expense of the pass and every layer pays it again. Three is the ceiling because later layers converge while still costing full price." },
  { key: 'ChainedHistory', type: 'bool', default: true, group: 'Adaptive resolution', label: 'Chained temporal history',
    dependsOn: { key: 'Passes', atLeast: 2 },
    help: "What the stacked passes do with their temporal history between frames.\n\nOn (default): every pass keeps its own history, so each layer accumulates the way pass one does. Off: passes 2+ are reset every frame -- stateless refinement, which cannot compound ghosting.\n\nThe trade is real both ways. Keeping history is richer and can compound ghosting behind fast movement; resetting every frame cannot, but NVIDIA documents reset-per-frame as a flicker and aliasing risk -- which is what shimmering on two or three passes usually is. Try the other setting when a stacked picture shimmers, and keep whichever the game looks better with.\n\nOnly does anything with more than one pass." },
  { key: 'Pass2Preset', type: 'enum', default: null, options: PRESETS, group: 'Adaptive resolution', label: 'Pass 2 model',
    dependsOn: { key: 'Passes', atLeast: 2 }, help: "Left on default, pass 2 uses the model above." },
  { key: 'Pass2Style', type: 'enum', default: null, options: STYLES, group: 'Adaptive resolution', label: 'Pass 2 style',
    dependsOn: { key: 'Passes', atLeast: 2 }, help: "Left on default, pass 2 uses the style above." },
  { key: 'Pass3Preset', type: 'enum', default: null, options: PRESETS, group: 'Adaptive resolution', label: 'Pass 3 model',
    dependsOn: { key: 'Passes', atLeast: 3 }, help: "Left on default, pass 3 uses the model above." },
  { key: 'Pass3Style', type: 'enum', default: null, options: STYLES, group: 'Adaptive resolution', label: 'Pass 3 style',
    dependsOn: { key: 'Passes', atLeast: 3 }, help: "Left on default, pass 3 uses the style above." },
  // Model resolution beside Model passes, as in the in-game panel (2026-09-20): those two are what the pass
  // costs, and the per cent was being hunted for down in Cost. Greyed while Adaptive resolution drives it,
  // again as the panel does -- the value moving is what the controller is doing, and a hand-set number would
  // be overwritten at its next step anyway.
  { key: 'WorkingScale', type: 'float', default: 1.0, min: 0.25, max: 2, step: 0.01, percent: true,
    group: 'Adaptive resolution', label: 'Model resolution', dependsOn: { key: 'AutoScale', is: false },
    help: "What fraction of the frame the model works at. Cost falls with the square of this, so half resolution is roughly a quarter of the time. Below 100 the frame itself is never reduced -- only the model's own contribution is computed small and enlarged. Applied when the handle is let go, not while it is moving." },
  { key: 'ScalingDownscaler', type: 'enum', default: 4, options: DOWNSCALERS, group: 'Adaptive resolution',
    label: 'Downscaler', dependsOn: { key: 'WorkingScale', above: 1 },
    help: "The filter that averages the model's above-native answer back to display size -- this is what turns supersampling into LESS noise rather than more. Sharper filters (Lanczos3, Kaiser3) keep the most detail; softer ones (Bicubic, Catmull-Rom) are gentler on ringing. Independent of the Output Scaling downscaler, so the two can differ and run at the same time." },

  // [DlssNr] ForceBorderless. Lossless Scaling turns it on for its games (main.js applyLosslessMarker);
  // this is the same switch offered directly, for the pop-out panel's sake as much as anything --
  // Windows will not composite it over an exclusive-fullscreen game. Held off by dlssnr:get where the
  // engine has no hold on the window: the 32-bit route (OptiScaler is in the helper) and OpenGL/Vulkan
  // (no DXGI swapchain). Safe on a game that is already windowed since engine v1.0.36; before that it
  // rewrote every swapchain's descriptor and put Monster Hunter: World in a title-barred window.
  { key: 'ForceBorderless', type: 'bool', default: false, group: 'Display', label: 'Borderless window',
    help: "Keeps the game in a borderless window that fills its monitor, whatever its own display setting says. Exclusive fullscreen is refused when the game asks for it; a game that already runs windowed or borderless is left exactly as it is.\n\nWhat needs it: Lossless Scaling, which cannot capture exclusive fullscreen (configuring it turns this on), and the pop-out panel, which Windows cannot draw over an exclusive-fullscreen game.\n\nThis changes the window, not the picture: the game keeps rendering at its own resolution and is scaled to the monitor. Only where OptiScaler sits inside the game's process with a DirectX swapchain -- greyed out on the 32-bit route and on OpenGL or Vulkan, where it has no hold on the window." },
  // [DlssNr] BorderlessWidth / BorderlessHeight (engine v1.0.38). 0 is the monitor. Both must be set for
  // either to count, which the engine enforces (Util::BorderlessSizeRequested); the help says so.
  { key: 'BorderlessWidth', type: 'int', default: 0, min: 0, max: 7680, step: 1, group: 'Display',
    label: 'Window width', dependsOn: { key: 'ForceBorderless', is: true },
    help: "The borderless window's width in pixels; 0 (the default) means the monitor's full width. Set both width and height or neither -- one alone is ignored. Centred on the monitor.\n\nThe game is fitted into the window. Many games re-render at the window's size once they are windowed, so this then acts as a resolution; others keep their own render size and are scaled into it. Which you get is the game's own windowed-mode behaviour, not something this controls -- the frame-cost figure in this panel will tell you which happened.\n\nWith a size set, the window is also sized for a game that already runs windowed or borderless, which the switch above alone leaves untouched." },
  { key: 'BorderlessHeight', type: 'int', default: 0, min: 0, max: 4320, step: 1, group: 'Display',
    label: 'Window height', dependsOn: { key: 'ForceBorderless', is: true },
    help: "The borderless window's height in pixels; 0 (the default) means the monitor's full height. Set both width and height or neither -- one alone is ignored. See Window width." },

  // [DlssNr] PanelKey. A virtual-key code in the low byte with modifier bits above it, the same
  // encoding the engine uses (Config.h: KeyVkMask 0x00FF, Alt 0x0100, Ctrl 0x0200, Shift 0x0400).
  //
  // This has always been rebindable in the engine and in its own panel, and this app never said so.
  // The reporter on #50 asked for "re-assignment of ALT+HOME" because theirs did nothing -- some
  // other program on that machine holds the chord, which is exactly what this is for. Offered as a
  // list rather than a key capture: the point is to escape a key something else has taken, and a
  // short list of alternatives does that without another input-capture widget to get wrong.
  { key: 'PanelKey', type: 'enum', default: VK.HOME | MOD.ALT, group: 'Display', keybind: true,
    label: 'DLSS 5 panel hotkey',
    options: [
      [VK.HOME | MOD.ALT, 'Alt+Home'],
      [VK.HOME, 'Home'],
      [VK.HOME | MOD.ALT | MOD.SHIFT, 'Shift+Alt+Home'],
      [VK.HOME | MOD.CTRL, 'Ctrl+Home'],
      [VK.INSERT | MOD.ALT, 'Alt+Insert'],
      [VK.END | MOD.ALT, 'Alt+End'],
      [VK.DELETE | MOD.ALT, 'Alt+Delete'],
      [VK.F10, 'F10'],
      [VK.F10 | MOD.ALT, 'Alt+F10'],
    ],
    help: "Opens OptiScaler's own DLSS 5 panel inside the game. Alt+Home by default.\n\nChange it when something else on the machine already holds that chord -- an overlay, a capture tool, a keyboard macro -- and the panel never appears. Nothing here can tell you which program took it; the symptom is simply that the key does nothing.\n\nThis is the panel drawn INSIDE the game. It is not this app's own pop-out panel, whose hotkey lives in Settings and is Alt+Shift+Home by default. On the 32-bit route the panel is drawn by the 64-bit helper and shown over the game, and this key still reaches it." },

  { key: 'LocalStructure', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, group: 'Global Controls',
    label: 'Structure Intensity', help: "The model's structure-synthesis strength across the whole frame." },
  { key: 'LocalTone', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, group: 'Global Controls',
    label: 'Tone Intensity', help: "The model's tone-remapping strength across the whole frame." },

  { key: 'Preset', type: 'enum', default: 0, options: PRESETS, group: 'Models', segmented: true,
    label: 'Model', help: "Not the same scale as the super resolution or ray reconstruction presets -- the same letter means something different here.\n\nRead when the model is built, so a change rebuilds it after a moment." },
  { key: 'Style', type: 'enum', default: 0, options: STYLES, group: 'Models',
    label: 'Style', help: "The model's own processing profiles.\n\nDefault (standard): the strongest, and most likely to look 'stylised'. Natural: the same detail work with a gentler hand. Cinematic: tones down the shine and over-processing for a film-like look.\n\nThe names come from community testing, unlike the panel labels above -- NVIDIA ships no names for this control in the binaries." },
  { key: 'Intensity', type: 'float', default: 1.0, min: 0, max: 2, step: 0.01, group: 'Models',
    label: 'Intensity', help: "The model's own strength control, applied inside it. Distinct from the Global Controls above, and from Detail strength below, which scales the result afterwards." },

  { key: 'Transfer', type: 'enum', default: 1, options: [[0, 'Classic'], [1, 'Matched residual']], group: 'Cost',
    label: 'Enlargement', dependsOn: { key: 'WorkingScale', below: 1 },
    help: "How the model's work is brought back up when it ran below the frame's size.\n\nClassic composes the model's small picture directly against the full-size frame. Those two disagree by the shrink's blur as well as by the model's edit, and the composition cannot tell them apart.\n\nGreyed out at 100%, where there is nothing to enlarge." },

  { key: 'TransferStrength', type: 'float', default: 1.0, min: 0, max: 2, step: 0.01, group: 'How much of it lands',
    label: 'Detail strength',
    help: "How far the frame moves toward the model's picture. 0 gives back exactly what the upscaler produced. 1 is the model's picture. Above 1 carries on past it in the same direction." },
  { key: 'ColourStrength', type: 'float', default: 1.0, min: 0, max: 4, step: 0.01, group: 'How much of it lands',
    label: 'Colour strength',
    help: "Whether the model's colour arrives with its light. 0 keeps the game's own hue exactly -- every pixel the original colour, with only its brightness carrying the model's verdict. 1 brings the model's colour as well, in its own hue, clamped into AP1 so nothing unreachable is asked for.\n\nAbove 1 it over-saturates: the colour keeps its hue but grows more vivid, and rolls off at the edge of what the display can show rather than clipping into a flat blown patch. 1 is the model's own colour; push past it for punch." },

  { key: 'ReversibleMode', type: 'enum', default: 0, options: REVERSIBLE, group: 'Colour', label: 'Reversible proxy',
    help: "What the model is shown, and how its answer comes back. Experimental.\n\nOff (soft knee): the default, and byte-identical to before. It rolls highlights off so hard the model cannot resolve detail in them -- fine in soft-lit scenes, weak in bright ones.\n\nNeutwo composed: an unclipped curve, so the model sees highlight detail, then everything above it (strengths, highlight guard, palette). Wins in bright scenes, but the curve compresses midtones too, so soft-lit content can be worse than Off. It also shifts paper white -- re-check that when you switch.\n\nHybrid composed: the one to use. Identity in the midtones -- as good as Off there -- with the unclipped roll only in the highlights, so it recovers the detail Off crushes without giving up the midtones Neutwo does. Barely shifts paper white.\n\nReplace: the raw model straight back through the exact inverse, none of the composition -- no guard, no palette, no strengths. Gorgeous where there are no bright lights, but they FLASH in motion. A reference, not a daily setting.\n\nHybrid replace: Replace's raw model on the hybrid curve, so the flashing is confined to genuine highlights instead of everywhere. Most of Replace's detail, far more stable." },
  { key: 'WhitePointSource', type: 'enum', default: 1, options: WHITE_POINT_SOURCES, group: 'Colour',
    label: 'White point from',
    help: "Paper white only -- the slider below and nothing else. Right for a game whose exposure never moves, wrong the moment it does: one constant cannot serve a cave and a field.\n\nThe game's own exposure -- read from the texture the game hands the upscaler. The best source there is, because it is decided upstream and nothing this pass does can move it. Not every game supplies one.\n\nA buffer the scan found -- for games that compute an exposure and never pass it on. A guess: candidates are matched by shape, and the anchor's ratio cancels the scale. Needs anchoring once, in the Experimental section, and checking after." },
  { key: 'WhitePointTrim', type: 'float', default: 1.0, min: 0.25, max: 4, step: 0.01, log: true, group: 'Colour',
    label: "Trim (x the game's exposure)", dependsOn: { key: 'WhitePointSource', is: 1 },
    help: "A multiplier on the exposure the game supplied. 1.00x takes its number exactly, and that is the right answer here.\n\nThis is not a fudge factor. A game that needs the trim far from 1 to look right is evidence the exposure being read is wrong for that game, not that the game wants trimming. Roughly 0.8 to 1.25 is honest tuning; reaching for 4 means something upstream is broken and this is hiding it.\n\nYour manual paper white is kept separately and comes back untouched if you switch the source back." },
  { key: 'WhitePointScale', type: 'float', default: 1.0, min: 0.25, max: 2000, step: 0.01, log: true, group: 'Colour',
    label: 'Paper white',
    help: "What the frame is divided by before the model sees it. There is no other white point; this is the whole of it. Above 1 the picture handed over is darker, so highlights sit lower on the curve." },
  { key: 'MaxRatio', type: 'float', default: 2.0, min: 1, max: 8, step: 0.1, group: 'Colour',
    label: 'Highlight guard',
    help: "The most the pass may move any pixel, as a multiple of what it already was, in both directions -- a pixel may not be brightened past this nor darkened past its reciprocal. Lights are where the model has least to say and rescaling its answer does the most damage; 2x leaves detail intact while stopping a strip light turning into a string of coloured cells. Raise it only if bright areas look clipped." },

  { key: 'ScanMeter', type: 'bool', default: false, group: 'Exposure scan', label: 'Show the light meter on screen',
    dependsOn: { key: 'WhitePointSource', is: 2 }, help: "A lamp in the corner: red for dark, green for full light, and the shades between, with the reading beside it.\n\nIt is how you see at a glance that the scan is TRACKING rather than merely running. Walk into shade and it should slide toward red; step out and it should go green. If it moves the wrong way, that is what \"the number runs the other way\" below is for.\n\nPurely a readout. It changes nothing." },
  { key: 'ScanTrim', type: 'float', default: 1.0, min: 0.25, max: 4, step: 0.01, log: true, group: 'Exposure scan',
    label: 'Trim (x the scan)', dependsOn: { key: 'WhitePointSource', is: 2 },
    help: "A multiplier on the scan's white point, and the control to adjust between anchor points: dial it until the picture looks right in the current light, then press Anchor under Experimental -- that captures the trimmed value as a new point and resets this to 1." },
  { key: 'ScanInverted', type: 'bool', default: false, group: 'Exposure scan', label: 'The number runs the other way',
    dependsOn: { key: 'WhitePointSource', is: 2 },
    help: "Flip this if the picture gets worse in the direction it should be getting better. Most engines store an exposure that falls as the scene brightens; some store its reciprocal, and a buffer found by shape does not say which. Add a second anchor point in different light and this is decided for you, so it disappears." },

  { key: 'DepthConvention', type: 'enum', default: 0, group: 'Guide',
    options: [[0, 'Follow the game'], [1, 'Force normal'], [2, 'Force inverted']],
    label: 'Depth', help: "Which way round the model is told depth runs. The game states this in the flags it created its own DLSS feature with, and following it is right almost always -- but a game that states it wrongly needs correcting by hand.\n\nIf the pass looks worst where geometry meets sky, try forcing the other one." },
  { key: 'UICorrection', type: 'bool', default: true, group: 'Guide', label: 'UI correction',
    help: "Lets the model account for a UI layer laid over the frame. On is its own default and right whenever a UI resource reaches it; turn it off if the correction is itself what looks wrong.\n\nRead when the model is built." },
  { key: 'OpticalFlow', type: 'bool', default: true, group: 'Guide', label: 'Optical flow',
    help: "Gives the model motion between frames. Off is a diagnostic." },

  { key: 'AutoCapture', type: 'bool', default: true, group: 'Inspect', label: 'Auto-capture once per session',
    help: "Writes one matched before/after set automatically, without anyone asking. The folder is cleared each run, so it holds a single session and never grows." },
  { key: 'HoldFrame', type: 'bool', default: false, group: 'Inspect', label: 'Hold frame',
    help: "Freezes the frame the model works on. While held, change paper white, the strengths, the reversible mode, the model preset -- anything below the upscaler -- and only that setting moves; the scene does not. Pairs with \"Apply the model\" at the top: freeze a frame, then toggle that to see it with and without.\n\nWhat it cannot show: upscaler presets or anything upstream of this pass (the upscaler is not re-run on a held frame), and the game's own HUD and post-processing, which run after this and keep updating. The white point stops being measured and holds its value, so it cannot drift and confound the comparison.\n\nClose the panel and it stays held. Untick to resume." },
  { key: 'Compare', type: 'enum', default: 0, options: [[0, 'Off'], [1, 'Side by side'], [2, 'Wipe']], group: 'Inspect',
    label: 'Compare', help: "Shows the pass against itself. Side by side puts the whole frame in each half; wipe cuts a single frame at the split and plays normally. Neither needs the menu open to keep working." },
  { key: 'CompareSwap', type: 'bool', default: false, group: 'Inspect', label: 'Swap sides',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Which side is the frame with the pass on." },
  { key: 'CompareTags', type: 'bool', default: false, group: 'Inspect', label: 'Labels',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Draws which side is which into the frame's own plane, so a screenshot still says it. Clipped per side, so the wipe reveals and hides them exactly as it does the images." },
  { key: 'TagScale', type: 'float', default: 1.5, min: 0.5, max: 5, step: 0.1, group: 'Inspect', label: 'Label size',
    dependsOn: { key: 'CompareTags', is: true }, help: "How large those labels are drawn." },
  { key: 'CompareZoom', type: 'float', default: 1.0, min: 1, max: 2, step: 0.01, group: 'Inspect', label: 'Zoom',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Magnifies both sides equally, so fine detail is visible at all." },
  { key: 'CompareSplit', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Inspect', label: 'Split',
    dependsOn: { key: 'Compare', is: 2 }, help: "Where the wipe sits across the frame." },
  { key: 'DebugView', type: 'enum', default: 0, group: 'Inspect',
    options: [[0, 'Off'], [1, 'Proxy (what the model sees)'], [2, 'Model output (raw)'], [3, 'Difference (amplified)']],
    label: 'Debug view',
    help: "Proxy is the picture handed to the model. Difference shows what the model actually changed, amplified twenty times and centred on grey." },


  { key: 'VendorColours', type: 'bool', default: true, group: 'Appearance', label: 'Vendor colours',
    help: "NVIDIA green, or AMD red on an AMD card. Off keeps green everywhere." },
  { key: 'Language', type: 'code', default: null, options: LANGUAGES, group: 'Appearance', label: 'Language',
    help: "The language this panel and the in-game one are written in. Default follows Windows. OptiScaler's own menu stays English. A language that needs its own font (Chinese, Korean) loads it from Windows on the next frame." },
  { key: 'FontScale', type: 'float', default: 1.15, min: 0.75, max: 2, step: 0.05, group: 'Appearance',
    label: 'Font size', help: "This panel's text only -- OptiScaler's own menu keeps its [Menu] FontSize.\n\nRow widths are worked out from the font size, so far above 1.5x labels start running into their values." },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key.toLowerCase(), f]));
const GROUPS = [...new Set(FIELDS.map((f) => f.group))];

const isAuto = (raw) => raw === null || raw === undefined || String(raw).trim() === '' || /^auto$/i.test(String(raw).trim());

// A stored value as the form should show it: null means "auto", i.e. use the default.
function parseValue(field, raw) {
  if (isAuto(raw)) return null;
  const text = String(raw).trim();
  // A code, not a number: matched case-insensitively because the engine lower-cases what it writes
  // and a hand-edited ini may not have.
  if (field.type === 'code') {
    const hit = (field.options || []).find(([v]) => String(v).toLowerCase() === text.toLowerCase());
    return hit ? hit[0] : null;
  }
  if (field.type === 'bool') {
    if (/^(true|1)$/i.test(text)) return true;
    if (/^(false|0)$/i.test(text)) return false;
    return null;
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (field.type === 'int' || field.type === 'enum') {
    const v = Math.round(n);
    // A keybind is an enum for the sake of the picker, but its real range is every key on the
    // keyboard. Rejecting an unlisted one would read the player's own chord back as "default".
    if (field.keybind) return v;
    if (field.type === 'enum' && field.options && !field.options.some(([o]) => o === v)) return null;
    if (field.type === 'int') return Math.min(field.max, Math.max(field.min, v));
    return v;
  }
  return Math.min(field.max, Math.max(field.min, n));
}

function formatValue(field, value) {
  if (value === null || value === undefined) return 'auto';
  if (field.type === 'code') return String(value);
  if (field.type === 'bool') return value ? 'true' : 'false';
  if (field.type === 'float') return String(Number(value));
  return String(Math.round(Number(value)));
}

// Everything the form needs for one game: each field, its stored value (null = auto) and the
// default that applies when it is auto.
function widenKeybindOptions(field, value) {
  const options = field.options || [];
  if (value === null || value === undefined) return options;
  if (options.some(([o]) => o === value)) return options;
  return [...options, [value, describeKeybind(value)]];
}

function readSettings(iniPath) {
  let text = '';
  try { text = fs.readFileSync(iniPath, 'utf8'); } catch { text = ''; }
  return FIELDS.map((f) => ({
    key: f.key,
    group: f.group,
    label: f.label,
    help: f.help,
    type: f.type,
    // A keybind set outside the offered list gets an entry of its own, named, so the picker shows
    // what the ini really holds instead of falling back to the default.
    options: f.keybind ? widenKeybindOptions(f, parseValue(f, getIniKey(text, SECTION, f.key))) : (f.options || null),
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
    keybind: f.keybind || false,
  }));
}

// Writes only what changed, and writes "auto" for anything set back to its default -- the same
// thing the in-game panel's own save does, so the two agree about what a default looks like.
// Returns the keys actually written.
// Before Super Resolution and UI correction are one or the other, never both: the two together froze
// inZOI on the spot (issue #55, 2026-09-19), and before SR the frame has no UI on it for the correction
// to act on. Turning one on switches the other off in the same write -- the in-game panel does the same,
// and engine v2.1.3 builds the model without UI correction whenever the pass runs before SR anyway.
const EXCLUSIVE_ON = { runbeforesr: 'UICorrection', uicorrection: 'RunBeforeSR' };

function withExclusions(values) {
  const out = { ...(values || {}) };
  for (const [key, wanted] of Object.entries(values || {})) {
    const other = EXCLUSIVE_ON[String(key).toLowerCase()];
    if (!other || Object.keys(out).some((k) => k.toLowerCase() === other.toLowerCase())) continue;
    const field = BY_KEY.get(String(key).toLowerCase());
    if (field && wanted !== null && wanted !== undefined && parseValue(field, wanted) === true) out[other] = false;
  }
  return out;
}

function writeSettings(iniPath, values) {
  let text;
  try { text = fs.readFileSync(iniPath, 'utf8'); } catch { return { ok: false, error: 'OptiScaler.ini not found', written: [] }; }
  const written = [];
  for (const [key, wanted] of Object.entries(withExclusions(values))) {
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
