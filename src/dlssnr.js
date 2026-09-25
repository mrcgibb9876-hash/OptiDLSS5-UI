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
const VK = { HOME: 0x24, END: 0x23, INSERT: 0x2D, DELETE: 0x2E, F10: 0x79, NUMPAD0: 0x60, DECIMAL: 0x6E };
const MOD = { ALT: 0x0100, CTRL: 0x0200, SHIFT: 0x0400 };
const VK_NAME = { 0x24: 'Home', 0x23: 'End', 0x2D: 'Insert', 0x2E: 'Delete', 0x79: 'F10', 0x60: 'Numpad 0', 0x6E: 'Numpad .' };

// A bind the list does not offer -- set in the in-game panel, or by hand -- still has to read back
// honestly. Without this the dialog would show "Insert (default)" over an ini that says
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
// The other direction, and a different list, because a filter that answers "how do I average many
// source pixels into one" is not the same question as "how do I invent the ones in between".
// Engine [DlssNr] ScalingUpscaler; before it existed this direction had no control at all.
// No FSR1. It stays a downscaler, which is what DOWNSCALERS above is; as an enlarging filter it is
// not worth having beside the rest of these.
const UPSCALERS = [[0, 'Bicubic'], [1, 'EWA Lanczos'], [2, 'xBR-lv2'], [3, 'Sharp bilinear'], [4, 'Integer scale'], [5, 'Nearest']];
const EWA_LANCZOS = 1;
// Every tuning row below is read by that one filter and by nothing else, so they all hide together
// rather than each repeating the condition.
const EWA_ONLY = { all: [{ key: 'WorkingScale', below: 1 }, { key: 'ScalingUpscaler', is: EWA_LANCZOS }] };
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
  { key: 'LightTheme', type: 'bool', default: true, group: 'Panel appearance', label: 'Light panel',
    help: "Light is the default. The dark palette this panel was originally styled after put its dimmed text at 2.65:1 against the background, against the 4.5:1 that reads comfortably -- and an overlay is read at a glance, over a moving picture.\n\nUnticking restores NVIDIA's own colouring." },
  { key: 'Enabled', type: 'bool', default: false, group: 'Turn it on', label: 'DLSS ON', caps: true,
    help: "Synthesises detail in the upscaler's frame, before frame generation sees it.\n\nNeeds two similarly named files beside OptiScaler, one character apart: nvngx_dlssnr.dll       NVIDIA's model (~165 MB) -- you supply it nvngx.dll_dlssnr.dll   the forwarder (~13 KB) -- ships in this package Undocumented and driven directly, so none of this is officially supported." },
  { key: 'ApplyModel', type: 'bool', default: true, group: 'Turn it on', label: 'Apply the model',
    help: "Whether the model's edit is applied. Off shows the clean upscaler frame while the pass keeps running -- so with Hold frame, under Inspect, you can freeze a frame and toggle this to see the same frozen frame with and without Neural Rendering. Leave it on for normal use." },
  { key: 'RunBeforeSR', type: 'bool', default: false, group: 'Speed vs quality', label: 'Before Super Resolution',
    help: "Where the pass sits. Off is the original placement: the model runs on the finished upscaled frame. On runs it at render resolution on the colour SR is about to consume, so SR then accumulates and upscales an already-enhanced picture.\n\nRay Reconstruction always stays on the post-upscale path -- its inputs are a different contract. A colour image padded inside a larger texture is staged at its real size; one offset from the corner still falls back after upscaling.\n\nD3D12 and its D3D11/Vulkan bridges only; native Vulkan keeps the old placement." },
  // [DlssNr] RunBeforeRR. Engine v1.0.38 ran the pass before Ray Reconstruction; since engine v2.2 it runs after
  // it with the model at render resolution -- the cost without the smearing -- and the label says so.
  { key: 'RunBeforeRR', type: 'bool', default: false, group: 'Speed vs quality', label: "Ray Reconstruction at render cost",
    dependsOn: { key: 'RunBeforeSR', is: true },
    help: "For games with Ray Reconstruction: the pass costs what it would before Ray Reconstruction, without the damage. It runs after Ray Reconstruction, on its clean frame, with the model at the game's render resolution instead of the output's. Ray Reconstruction's own input is never touched, so nothing is smeared, and the model never sees ray-tracing noise. Model resolution then counts from the render resolution. Needs Before Super Resolution on." },
  // Enlargement: under the render-cost toggle, which is what makes the model run small (moved from Cost).
  // Two modes, as the engine has: Classic and Matched residual. It briefly had four on the v2.2.0
  // release line -- Edge-aware and a Full-size look default -- and that line is not the one v2.2.3
  // onwards came from, so the two never shipped. Offering them here was worse than useless: picking
  // Edge-aware wrote Transfer = 2, which the shipping shader reads as "the model ran small" rather
  // than as a mode, and Full-size look wrote a 3 the engine simply treats as Matched residual while
  // this panel claimed it was doing something else.
  { key: 'Transfer', type: 'enum', default: 1, options: [[0, 'Classic'], [1, 'Matched residual']], group: 'Speed vs quality',
    label: "Enlargement", dependsOn: { any: [{ key: 'WorkingScale', below: 1 },
      { all: [{ key: 'RunBeforeSR', is: true }, { key: 'RunBeforeRR', is: true }] }] },
    help: "How the model's work is brought back up when it ran below the frame's size.\n\nClassic composes the model's small picture directly against the full-size frame. Those two disagree by the shrink's blur as well as by the model's edit, and the composition cannot tell them apart.\n\nGreyed out at 100%, where there is nothing to enlarge." },
  // Model passes near the top of Cost, as in the in-game panel (2026-09-19): with Model resolution, the two
  // things that decide what the pass costs.
  { key: 'Passes', type: 'int', default: 1, min: 1, max: 3, group: 'Speed vs quality',
    label: 'Model passes', help: "How many times the model runs before its answer is composed. Each extra layer is fed the previous layer's output and keeps its own temporal history.\n\nThe base frame stays untouched and the composition happens once at the end, so colour and transfer strength do not compound -- but the model is being asked to enhance its own output, which is outside what it was trained on.\n\nCost is very nearly linear: the model is almost the whole expense of the pass and every layer pays it again. Three is the ceiling because later layers converge while still costing full price." },
  // [DlssNr] PassRate. The engine has had this since the stacked passes did (DlssNr_Dx12.cpp, the
  // credit accumulator by effectivePasses) and it has never been on screen anywhere -- not here and
  // not in the in-game panel. It is what "a pass and a half" means: the stacked passes run on a
  // fraction of frames, so their cost is paid partly.
  //
  // Whole passes are a blunt control -- one pass, two passes, and on a 2026-09-20 measurement of a
  // game running at 80 fps on one pass, two took it to 50. Half the frames getting the second pass
  // landed at 60, which is the point of this: somewhere to stand between them, and most valuable
  // where frame generation and smooth motion are not available to make up the difference.
  //
  // Read every frame, not at create time, so it moves while the game runs and never rebuilds the
  // model -- the features for every pass stay built whatever the rate is, and a skipped frame is one
  // evaluate not made. That is also its honest cost: a skipped frame really is less processed than a
  // run one, so the picture alternates between two looks. At a low enough rate that is visible.
  { key: 'PassRate', type: 'float', default: 1.0, min: 0.05, max: 1, step: 0.05, percent: true,
    group: 'Speed vs quality', label: "How often extra passes run", dependsOn: { key: 'Passes', atLeast: 2 },
    help: "How often the passes after the first actually run. 100% is every frame, which is what Model passes has always meant.\n\nThis is how you ask for half a pass. Model passes 2 with this at 50% is the \"1.5 passes\" idea: the second pass runs on every other frame, and costs about half of what a full second pass costs. Anywhere between is fair game -- 75% is a pass and three quarters.\n\nThe saving is real and so is the trade: a frame that skipped the extra pass is genuinely less processed than one that did not, so the picture alternates between two looks. The higher the framerate the less that shows. Come down from 100% until the cost is what you want, then back up if you can see it moving.\n\nApplied while the game runs -- it is read every frame and never rebuilds the model.\n\nOnly does anything with more than one pass." },
  { key: 'ChainedHistory', type: 'bool', default: true, group: 'Speed vs quality', label: "Keep history between passes",
    dependsOn: { key: 'Passes', atLeast: 2 },
    help: "What the stacked passes do with their temporal history between frames.\n\nOn (default): every pass keeps its own history, so each layer accumulates the way pass one does. Off: passes 2+ are reset every frame -- stateless refinement, which cannot compound ghosting.\n\nThe trade is real both ways. Keeping history is richer and can compound ghosting behind fast movement; resetting every frame cannot, but NVIDIA documents reset-per-frame as a flicker and aliasing risk -- which is what shimmering on two or three passes usually is. Try the other setting when a stacked picture shimmers, and keep whichever the game looks better with.\n\nOnly does anything with more than one pass." },
  { key: 'Pass2Preset', type: 'enum', default: null, options: PRESETS, group: 'Speed vs quality', label: 'Pass 2 model',
    dependsOn: { key: 'Passes', atLeast: 2 }, help: "Left on default, pass 2 uses the model above." },
  { key: 'Pass2Style', type: 'enum', default: null, options: STYLES, group: 'Speed vs quality', label: 'Pass 2 style',
    dependsOn: { key: 'Passes', atLeast: 2 }, help: "Left on default, pass 2 uses the style above." },
  { key: 'Pass3Preset', type: 'enum', default: null, options: PRESETS, group: 'Speed vs quality', label: 'Pass 3 model',
    dependsOn: { key: 'Passes', atLeast: 3 }, help: "Left on default, pass 3 uses the model above." },
  { key: 'Pass3Style', type: 'enum', default: null, options: STYLES, group: 'Speed vs quality', label: 'Pass 3 style',
    dependsOn: { key: 'Passes', atLeast: 3 }, help: "Left on default, pass 3 uses the style above." },
  // Model resolution beside Model passes, as in the in-game panel (2026-09-20): those two are what the pass
  // costs, and the per cent was being hunted for down in Cost. A fixed setting, never greyed: the engine's
  // adaptive model resolution (AutoScale) that used to drive it is gone.
  { key: 'WorkingScale', type: 'float', default: 1.0, min: 0.25, max: 2, step: 0.01, percent: true,
    group: 'Speed vs quality', label: 'Model resolution',
    help: "What fraction of the frame the model works at. Cost falls with the square of this, so half resolution is roughly a quarter of the time. Below 100 the frame itself is never reduced -- only the model's own contribution is computed small and enlarged. Applied when the handle is let go, not while it is moving." },
  { key: 'ScalingDownscaler', type: 'enum', default: 4, options: DOWNSCALERS, group: 'Speed vs quality',
    label: "Downscale filter", dependsOn: { key: 'WorkingScale', above: 1 },
    help: "The filter that averages the model's above-native answer back to display size -- this is what turns supersampling into LESS noise rather than more. Sharper filters (Lanczos3, Kaiser3) keep the most detail; softer ones (Bicubic, Catmull-Rom) are gentler on ringing. Independent of the Output Scaling downscaler, so the two can differ and run at the same time." },

  // The up-leg's filter, and the two controls that shape it. Engine v2.2.4: before that this
  // direction had no control of its own at all -- it was FSR1 if the downscaler above happened to
  // be FSR1 and bicubic otherwise, which is exactly what leaving this on default still does. The
  // default is null rather than a number for that reason: the answer depends on the row above, so
  // naming one here would put a confident wrong label on the picture for anyone who changed it.
  { key: 'ScalingUpscaler', type: 'enum', default: 0, options: UPSCALERS, group: 'Speed vs quality',
    // Either direction since engine v2.2.7: it enlarges the model's answer when the model ran
    // smaller than the frame, and enlarges the frame for the model when it ran larger. Only at exactly
    // 100% is nothing being resized.
    label: "Upscale filter",
    dependsOn: { any: [{ key: 'WorkingScale', below: 1 }, { key: 'WorkingScale', above: 1 }] },
    help: "The filter used whenever the model is not working at the frame's own size: it enlarges the model's answer back up when Model resolution is below 100%, and enlarges the frame for the model when it is above.\n\nBicubic is the default because it is the cheapest and it cannot go wrong, not because it is good -- it is soft. For a rendered 3D game the one to try is EWA Lanczos.\n\nEWA Lanczos weighs pixels by how far away they really are rather than by row and column, so a diagonal edge comes out as clean as a horizontal one instead of as a staircase. Sharpness below is what makes it worth choosing, and it is much the most expensive here.\n\nxBR-lv2, Sharp bilinear, Integer scale and Nearest are for PIXEL ART and 2D. On a rendered 3D frame they will look wrong; on a sprite or a 2D game they are the only right answers in this list." },
  // EWA Lanczos's four controls. Every one of them is a percentage where 0 is the gentlest setting,
  // on purpose: four identical sliders read as one set to be balanced against each other, where a
  // checkbox beside a preset name reads as four unrelated things that happen to sit together.
  { key: 'ScalingSharpness', type: 'float', default: 0, min: 0, max: 1, step: 0.05, percent: true,
    group: 'Speed vs quality', label: 'Sharpness', dependsOn: EWA_ONLY,
    help: "How hard the filter is pulled in.\n\nThe three EWA filters this one is built from differ only in two numbers, so they are points on a line rather than three things to choose between, and this slider is that line. 0% is the gentlest of them. Around 15% is the middle one. 100% is the sharpest, its wider reach included.\n\nThat reach is the cost: the top of the slider looks at 100 pixels for every one it draws, against 64 at the bottom. Raise Ring suppression as you raise this." },
  { key: 'ScalingAntiRinging', type: 'float', default: 0.8, min: 0, max: 1, step: 0.05, percent: true,
    group: 'Speed vs quality', label: 'Ring suppression', dependsOn: EWA_ONLY,
    help: "The bright or dark rim sharpening buys, held back.\n\nIt keeps the filter's answer inside the brightness range the pixels it is interpolating between already had. 0% leaves the filter's own answer. 100% allows no overshoot at all.\n\nNot the same control as Halo suppression under Picture: that one bounds what the MODEL did, this one bounds what the scaling filter did. They fix rims of different origin and neither reaches the other's." },
  { key: 'ScalingSigmoid', type: 'float', default: 0, min: 0, max: 1, step: 0.05, percent: true,
    group: 'Speed vs quality', label: 'Sigmoidal light', dependsOn: EWA_ONLY,
    help: "Resample on an S-shaped curve, so an overshoot near black or near white is compressed instead of clipping into a flat band. The slider is how hard the curve bends, with the reference setting at 100%.\n\nSDR only, by construction: the curve is only defined between black and white, so anything brighter passes through untouched and an HDR frame is barely affected. Leave it at 0 unless you are on an SDR display and seeing banding at the extremes." },
  { key: 'ScalingDither', type: 'float', default: 0, min: 0, max: 1, step: 0.05, percent: true,
    group: 'Speed vs quality', label: 'Dither', dependsOn: EWA_ONLY,
    help: "Breaks a band by adding a pattern finer than one step of colour, moved on each frame so it does not settle into something you can pick out.\n\n100% is half a step of an 8-bit picture. Eight bits is an assumption -- this pass cannot see what your display will be handed -- so on a wider output the pattern simply falls under the step size and changes nothing.\n\nFor banding in a sky or a gradient, where Ring suppression is for a rim along an edge." },

  // [DlssNr] ForceBorderless. Lossless Scaling turns it on for its games (main.js applyLosslessMarker);
  // this is the same switch offered directly, for the pop-out panel's sake as much as anything --
  // Windows will not composite it over an exclusive-fullscreen game. Held off by dlssnr:get where the
  // engine has no hold on the window: the 32-bit route (OptiScaler is in the helper) and OpenGL/Vulkan
  // (no DXGI swapchain). Safe on a game that is already windowed since engine v1.0.36; before that it
  // rewrote every swapchain's descriptor and put Monster Hunter: World in a title-barred window.
  { key: 'ForceBorderless', type: 'bool', default: false, group: 'Window', label: 'Borderless window',
    help: "Keeps the game in a borderless window that fills its monitor, whatever its own display setting says. Exclusive fullscreen is refused when the game asks for it; a game that already runs windowed or borderless is left exactly as it is.\n\nWhat needs it: Lossless Scaling, which cannot capture exclusive fullscreen (configuring it turns this on), and the pop-out panel, which Windows cannot draw over an exclusive-fullscreen game.\n\nThis changes the window, not the picture: the game keeps rendering at its own resolution and is scaled to the monitor. Only where OptiScaler sits inside the game's process with a DirectX swapchain -- greyed out on the 32-bit route and on OpenGL or Vulkan, where it has no hold on the window." },
  // [DlssNr] BorderlessWidth / BorderlessHeight (engine v1.0.38). 0 is the monitor. Both must be set for
  // either to count, which the engine enforces (Util::BorderlessSizeRequested); the help says so.
  { key: 'BorderlessWidth', type: 'int', default: 0, min: 0, max: 7680, step: 1, group: 'Window',
    label: 'Window width', dependsOn: { key: 'ForceBorderless', is: true },
    help: "The borderless window's width in pixels; 0 (the default) means the monitor's full width. Set both width and height or neither -- one alone is ignored. Centred on the monitor.\n\nThe game is fitted into the window. Many games re-render at the window's size once they are windowed, so this then acts as a resolution; others keep their own render size and are scaled into it. Which you get is the game's own windowed-mode behaviour, not something this controls -- the frame-cost figure in this panel will tell you which happened.\n\nWith a size set, the window is also sized for a game that already runs windowed or borderless, which the switch above alone leaves untouched." },
  { key: 'BorderlessHeight', type: 'int', default: 0, min: 0, max: 4320, step: 1, group: 'Window',
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
  // Insert since engine v2.2.7: one key opens this project's panel on every route, so nobody has to
  // remember which renderer or which neural consumer a game ended up on. RE Engine games are the
  // exception and keep Alt+Home -- REFramework owns Insert there (main.js RE_ENGINE_HOTFIX).
  { key: 'PanelKey', type: 'enum', default: VK.INSERT, group: 'Window', keybind: true,
    label: 'DLSS 5 panel hotkey',
    options: [
      [VK.INSERT, 'Insert'],
      [VK.HOME | MOD.ALT, 'Alt+Home'],
      [VK.HOME, 'Home'],
      [VK.HOME | MOD.ALT | MOD.SHIFT, 'Shift+Alt+Home'],
      [VK.HOME | MOD.CTRL, 'Ctrl+Home'],
      [VK.INSERT | MOD.ALT, 'Alt+Insert'],
      [VK.END | MOD.ALT, 'Alt+End'],
      [VK.DELETE | MOD.ALT, 'Alt+Delete'],
      [VK.F10, 'F10'],
      [VK.F10 | MOD.ALT, 'Alt+F10'],
      // A laptop with no Insert key of its own has "Ins" on numpad 0, which sends Numpad 0 while Num
      // Lock is on -- so the default key never arrives (the maintainer's own Legion, 2026-09-23).
      [VK.NUMPAD0, 'Numpad 0'],
      [VK.DECIMAL, 'Numpad .'],
    ],
    help: "Opens the DLSS 5 panel inside the game. Insert by default, the same key on every route -- OptiScaler's own menu moved to Alt+O to free it.\n\nNo Insert key? On many laptops \"Ins\" is printed on the numpad's 0 key, and it only sends Insert with Num Lock off. Turn Num Lock off, or pick Numpad 0 here.\n\nChange it when something else on the machine already holds the key -- an overlay, a capture tool, a keyboard macro -- and the panel never appears. Nothing here can tell you which program took it; the symptom is simply that the key does nothing.\n\nRE Engine games keep Alt+Home instead: REFramework's own menu owns Insert there, and it takes the keyboard from OptiScaler a few seconds into the game.\n\nThis is the panel drawn INSIDE the game. It is not this app's own pop-out panel, whose hotkey lives in Settings. On the 32-bit route the panel is drawn by the 64-bit helper and shown over the game, and this key still reaches it." },

  { key: 'LocalStructure', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, group: 'Picture',
    label: "Texture detail", help: "The model's structure-synthesis strength across the whole frame." },
  { key: 'LocalTone', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, group: 'Picture',
    label: "Tone strength", help: "The model's tone-remapping strength across the whole frame." },

  { key: 'Preset', type: 'enum', default: 0, options: PRESETS, group: 'Picture', segmented: true,
    label: 'Model', help: "Not the same scale as the super resolution or ray reconstruction presets -- the same letter means something different here.\n\nRead when the model is built, so a change rebuilds it after a moment." },
  { key: 'Style', type: 'enum', default: 0, options: STYLES, group: 'Picture',
    label: 'Style', help: "The model's own processing profiles.\n\nDefault (standard): the strongest, and most likely to look 'stylised'. Natural: the same detail work with a gentler hand. Cinematic: tones down the shine and over-processing for a film-like look.\n\nThe names come from community testing, unlike the panel labels above -- NVIDIA ships no names for this control in the binaries." },
  { key: 'Intensity', type: 'float', default: 1.0, min: 0, max: 2, step: 0.01, group: 'Picture',
    label: "Model intensity", help: "The model's own strength control, applied inside it. Distinct from the Global Controls above, and from Detail strength below, which scales the result afterwards." },

  { key: 'TransferStrength', type: 'float', default: 1.0, min: 0, max: 2, step: 0.01, group: 'Picture',
    label: 'Detail strength',
    help: "How far the frame moves toward the model's picture. 0 gives back exactly what the upscaler produced. 1 is the model's picture. Above 1 carries on past it in the same direction." },
  { key: 'ColourStrength', type: 'float', default: 0.5, min: 0, max: 4, step: 0.01, group: 'Picture',
    label: 'Colour strength',
    help: "Washed out, grey, colour sucked out of the game? This is the control, and the answer is to turn it DOWN.\n\nIt decides whose colour you see. 0 is the game's own, exactly: every pixel its original colour, with only the brightness carrying the model's verdict. 1 is the model's colour INSTEAD of the game's -- and the model's is usually the less saturated of the two, which is exactly what that washed-out look is. 0.5, the default, lets it contribute without overruling the game's art direction.\n\nAbove 1 goes the other way and makes the picture MORE colourful than the game ever was -- the same job a colourfulness shader does, done here instead. Hue is kept and only saturation grows, and it rolls off at the edge of what the display can show rather than clipping into a flat blown patch. Try 1.5 to 2 for punch." },
  // The tone trim, engine v2.2.11 (2026-09-23: "some games come out so dark"). Both on the finished
  // picture, both exactly nothing at 1.0, and both read every frame -- no rebuild while dragging.
  //
  // Auto beside each (engine v2.2.13): autoKey names the switch, drawn in the slider's own row rather than
  // as a row of its own, and autoLive the reading in OptiScaler.live.json's tone block the slider shows
  // while it is on. The slider is greyed then -- Auto is in charge -- and its own value is kept.
  { key: 'Brightness', type: 'float', default: 1.0, min: 0.5, max: 2, step: 0.01, group: 'Picture',
    label: 'Brightness', autoKey: 'AutoBrightness', autoLive: 'brightness',
    dependsOn: { key: 'AutoBrightness', is: false },
    help: "Game too dark? Turn this UP.\n\nIt lifts the shadows and midtones. Black stays black and white stays white -- only what lies between is raised -- so the highlights do not blow out and the colours keep their hue. Below 1 darkens the same way. 1 changes nothing.\n\nAuto measures the picture and lifts it when it is darker than usual, easing over a moment rather than jumping. It only ever brightens, and only part of the way, so a scene meant to be dark stays darker than a lit one. DX12, DX11 and RE Engine games; on a Vulkan game the slider stays in charge." },
  { key: 'AutoBrightness', type: 'bool', default: false, group: 'Picture', label: 'Auto',
    help: 'Brightness set from the picture itself, for games that come out too dark. Only ever lifts, and eases over a moment.' },
  { key: 'Contrast', type: 'float', default: 1.0, min: 0.5, max: 2, step: 0.01, group: 'Picture',
    label: 'Contrast', autoKey: 'AutoContrast', autoLive: 'contrast',
    dependsOn: { key: 'AutoContrast', is: false },
    help: "How far apart the darks and the lights sit. Above 1 is punchier: darks go deeper and lights brighter around the middle grey. Below 1 is flatter and shows more in the shadows. Black and white themselves never move. 1 changes nothing.\n\nFor a picture that is simply too dark, Brightness is the one to reach for first.\n\nAuto adds a little contrast to a flat, washed-out picture and takes a little off one that is already harsh, within 0.85 to 1.25. DX12, DX11 and RE Engine games." },
  { key: 'AutoContrast', type: 'bool', default: false, group: 'Picture', label: 'Auto',
    help: 'Contrast set from the picture itself: a little more for a flat picture, a little less for a harsh one.' },

  { key: 'ReversibleMode', type: 'enum', default: 0, options: REVERSIBLE, group: 'Brightness & HDR', label: "Tone-mapping mode",
    help: "What the model is shown, and how its answer comes back. Experimental.\n\nOff (soft knee): the default, and byte-identical to before. It rolls highlights off so hard the model cannot resolve detail in them -- fine in soft-lit scenes, weak in bright ones.\n\nNeutwo composed: an unclipped curve, so the model sees highlight detail, then everything above it (strengths, highlight guard, palette). Wins in bright scenes, but the curve compresses midtones too, so soft-lit content can be worse than Off. It also shifts paper white -- re-check that when you switch.\n\nHybrid composed: the one to use. Identity in the midtones -- as good as Off there -- with the unclipped roll only in the highlights, so it recovers the detail Off crushes without giving up the midtones Neutwo does. Barely shifts paper white.\n\nReplace: the raw model straight back through the exact inverse, none of the composition -- no guard, no palette, no strengths. Gorgeous where there are no bright lights, but they FLASH in motion. A reference, not a daily setting.\n\nHybrid replace: Replace's raw model on the hybrid curve, so the flashing is confined to genuine highlights instead of everywhere. Most of Replace's detail, far more stable." },
  { key: 'WhitePointSource', type: 'enum', default: 1, options: WHITE_POINT_SOURCES, group: 'Brightness & HDR',
    label: "Brightness reference",
    help: "Paper white only -- the slider below and nothing else. Right for a game whose exposure never moves, wrong the moment it does: one constant cannot serve a cave and a field.\n\nThe game's own exposure -- read from the texture the game hands the upscaler. The best source there is, because it is decided upstream and nothing this pass does can move it. Not every game supplies one.\n\nA buffer the scan found -- for games that compute an exposure and never pass it on. A guess: candidates are matched by shape, and the anchor's ratio cancels the scale. Needs anchoring once, in the Experimental section, and checking after." },
  { key: 'WhitePointTrim', type: 'float', default: 1.0, min: 0.25, max: 4, step: 0.01, log: true, group: 'Brightness & HDR',
    label: "Trim (x the game's exposure)", dependsOn: { key: 'WhitePointSource', is: 1 },
    help: "A multiplier on the exposure the game supplied. 1.00x takes its number exactly, and that is the right answer here.\n\nThis is not a fudge factor. A game that needs the trim far from 1 to look right is evidence the exposure being read is wrong for that game, not that the game wants trimming. Roughly 0.8 to 1.25 is honest tuning; reaching for 4 means something upstream is broken and this is hiding it.\n\nYour manual paper white is kept separately and comes back untouched if you switch the source back." },
  { key: 'WhitePointScale', type: 'float', default: 1.0, min: 0.25, max: 2000, step: 0.01, log: true, group: 'Brightness & HDR',
    label: 'Paper white',
    help: "What the frame is divided by before the model sees it. There is no other white point; this is the whole of it. Above 1 the picture handed over is darker, so highlights sit lower on the curve." },
  { key: 'MaxRatio', type: 'float', default: 2.0, min: 1, max: 8, step: 0.1, group: 'Picture',
    label: "Brightness limit",
    help: "The most the pass may move any pixel, as a multiple of what it already was, in both directions -- a pixel may not be brightened past this nor darkened past its reciprocal. Lights are where the model has least to say and rescaling its answer does the most damage; 2x leaves detail intact while stopping a strip light turning into a string of coloured cells. Raise it only if bright areas look clipped." },
  // [DlssNr] HaloGuard (engine v2.2.1). Under Highlight guard, as in the in-game panel: it is the
  // other half of the same job and the half the guard cannot do -- the guard bounds a pixel against
  // itself, this bounds it against its neighbours.
  { key: 'HaloGuard', type: 'float', default: 0.0, min: 0, max: 1, step: 0.05, percent: true, group: 'Picture',
    label: 'Halo suppression',
    help: "The bright or dark rim the model can leave along a high-contrast edge.\n\nHighlight guard above cannot see one. It bounds a pixel against its own original, so a rim that doubles a dark pixel lying beside a bright edge is well inside 2x and still an obvious halo. A halo is not a property of a pixel -- it is a property of a pixel next to its neighbours.\n\nThis holds the model's edit inside the brightness range the frame's own neighbourhood already had. A real edge has both of its sides in that range and passes through untouched; only an overshoot beyond both is pulled back. 0% is off. 100% allows no overshoot at all.\n\nFlat areas are left alone at any setting, so the fine texture the model adds is not what this takes away -- it bites only where there is contrast for a halo to stand against.\n\nEnlargement already removes the halos made by running the model SMALLER than the frame. This is for the ones the model makes at any size, 100% included. Start around 50% and come up until the rim goes." },

  // [DlssNr] DepthEdge (engine v2.2.3). Beside Halo suppression because they look alike and are not:
  // that one bounds how far the edit may go, this one stops it where the depth buffer says an object
  // ends. Different faults, and only this one reaches the rim that estimated motion vectors leave.
  { key: 'DepthEdge', type: 'float', default: 0.0, min: 0, max: 1, step: 0.05, percent: true, group: 'Picture',
    label: 'Silhouette guard',
    help: "A faint double image, or a pale outline, following characters and objects as they move?\n\nThis holds the model's edit back along an outline, using the DEPTH buffer to find it.\n\nIt is a different fault from the one Halo suppression fixes, which is why that control cannot touch it. Where a game makes no upscale call of its own, the pass has no engine motion vectors and has to estimate them -- and an estimate is at its worst exactly where one object ends and another begins. The model then draws on history from the wrong side of that edge, and what lands is a rim.\n\nThat edit is wrong in ORIGIN, not in size, so bounding how far it may go does nothing to it. Fading it out where the depth says an object ends does.\n\nDepth knows an outline even when brightness does not -- a dark coat against a dark wall is no contrast edge at all. 0% is off. Raise it until the rim goes; too far and outlines lose the detail the pass is adding everywhere else.\n\nD3D12 only, and only where the game's depth buffer can be read." },

  { key: 'ScanMeter', type: 'bool', default: false, group: 'Brightness & HDR', label: 'Show the light meter on screen',
    dependsOn: { key: 'WhitePointSource', is: 2 }, help: "A lamp in the corner: red for dark, green for full light, and the shades between, with the reading beside it.\n\nIt is how you see at a glance that the scan is TRACKING rather than merely running. Walk into shade and it should slide toward red; step out and it should go green. If it moves the wrong way, that is what \"the number runs the other way\" below is for.\n\nPurely a readout. It changes nothing." },
  { key: 'ScanTrim', type: 'float', default: 1.0, min: 0.25, max: 4, step: 0.01, log: true, group: 'Brightness & HDR',
    label: 'Trim (x the scan)', dependsOn: { key: 'WhitePointSource', is: 2 },
    help: "A multiplier on the scan's white point, and the control to adjust between anchor points: dial it until the picture looks right in the current light, then press Anchor under Experimental -- that captures the trimmed value as a new point and resets this to 1." },
  { key: 'ScanInverted', type: 'bool', default: false, group: 'Brightness & HDR', label: 'The number runs the other way',
    dependsOn: { key: 'WhitePointSource', is: 2 },
    help: "Flip this if the picture gets worse in the direction it should be getting better. Most engines store an exposure that falls as the scene brightens; some store its reciprocal, and a buffer found by shape does not say which. Add a second anchor point in different light and this is decided for you, so it disappears." },

  { key: 'DepthConvention', type: 'enum', default: 0, group: 'What the model is told',
    options: [[0, 'Follow the game'], [1, 'Force normal'], [2, 'Force inverted']],
    label: "Depth direction", help: "Which way round the model is told depth runs. The game states this in the flags it created its own DLSS feature with, and following it is right almost always -- but a game that states it wrongly needs correcting by hand.\n\nIf the pass looks worst where geometry meets sky, try forcing the other one." },
  { key: 'UICorrection', type: 'bool', default: true, group: 'What the model is told', label: 'UI correction',
    dependsOn: { key: 'RunBeforeSR', is: false },
    help: "Lets the model account for a UI layer laid over the frame. On is its own default and right whenever a UI resource reaches it; turn it off if the correction is itself what looks wrong.\n\nRead when the model is built." },
  { key: 'OpticalFlow', type: 'bool', default: true, group: 'What the model is told', label: 'Optical flow',
    help: "Gives the model motion between frames. Off is a diagnostic." },
  // Engine v2.2.5. The fix for the pulsing that has been on the Present route in every game since it
  // existed: with no motion vectors the model was still accumulating temporal history, against
  // vectors that told it nothing had moved.
  { key: 'ResetWhenBlind', type: 'bool', default: true, group: 'What the model is told',
    label: 'Forget history when motion is unknown',
    help: "Textures that ripple, pulse or swim while you move the view -- and nowhere else -- are this.\n\nWhere a game makes no upscale call of its own, the pass has to work out motion from the finished frames, and sometimes it cannot: Optical flow above is off, or it would not start, or the game's depth buffer is a shape that makes the picture's place in the frame unknowable. The log says which.\n\nWhat it had then was not 'no motion' but 'motion that says nothing moved', and the model believed it. It is a model with memory, and it lines its memory up using exactly those numbers -- so it kept reaching for the previous frame at the same spot on screen. Standing still that is correct. Moving, it blends what it is looking at now against what used to be somewhere else entirely, over and over.\n\nOn (default), it keeps no memory at all in that situation, so there is nothing misaligned left to blend and the rippling goes.\n\nThe memory is what steadies a picture, though, so a game can come out slightly crawlier on fine edges instead. If one does, turn this off for that game -- you get the steadiness back and the rippling with it. Costs no performance either way.\n\nDoes nothing in a game that hands over real motion vectors, which is most of them." },

  { key: 'AutoCapture', type: 'bool', default: true, group: 'Compare & inspect', label: 'Auto-capture once per session',
    help: "Writes one matched before/after set automatically, without anyone asking. The folder is cleared each run, so it holds a single session and never grows." },
  { key: 'HoldFrame', type: 'bool', default: false, group: 'Compare & inspect', label: 'Hold frame',
    help: "Freezes the frame the model works on. While held, change paper white, the strengths, the reversible mode, the model preset -- anything below the upscaler -- and only that setting moves; the scene does not. Pairs with \"Apply the model\" at the top: freeze a frame, then toggle that to see it with and without.\n\nWhat it cannot show: upscaler presets or anything upstream of this pass (the upscaler is not re-run on a held frame), and the game's own HUD and post-processing, which run after this and keep updating. The white point stops being measured and holds its value, so it cannot drift and confound the comparison.\n\nClose the panel and it stays held. Untick to resume." },
  { key: 'Compare', type: 'enum', default: 0, options: [[0, 'Off'], [1, 'Side by side'], [2, 'Wipe']], group: 'Compare & inspect',
    label: 'Compare', help: "Shows the pass against itself. Side by side puts the whole frame in each half; wipe cuts a single frame at the split and plays normally. Neither needs the menu open to keep working." },
  { key: 'CompareSwap', type: 'bool', default: false, group: 'Compare & inspect', label: 'Swap sides',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Which side is the frame with the pass on." },
  { key: 'CompareTags', type: 'bool', default: false, group: 'Compare & inspect', label: 'Labels',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Draws which side is which into the frame's own plane, so a screenshot still says it. Clipped per side, so the wipe reveals and hides them exactly as it does the images." },
  { key: 'TagScale', type: 'float', default: 1.5, min: 0.5, max: 5, step: 0.1, group: 'Compare & inspect', label: 'Label size',
    dependsOn: { key: 'CompareTags', is: true }, help: "How large those labels are drawn." },
  { key: 'CompareZoom', type: 'float', default: 1.0, min: 1, max: 2, step: 0.01, group: 'Compare & inspect', label: 'Zoom',
    dependsOn: { key: 'Compare', atLeast: 1 }, help: "Magnifies both sides equally, so fine detail is visible at all." },
  { key: 'CompareSplit', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Compare & inspect', label: 'Split',
    dependsOn: { key: 'Compare', is: 2 }, help: "Where the wipe sits across the frame." },
  { key: 'DebugView', type: 'enum', default: 0, group: 'Compare & inspect',
    options: [[0, 'Off'], [1, 'Proxy (what the model sees)'], [2, 'Model output (raw)'], [3, 'Difference (amplified)']],
    label: 'Debug view',
    help: "Proxy is the picture handed to the model. Difference shows what the model actually changed, amplified twenty times and centred on grey." },


  { key: 'VendorColours', type: 'bool', default: true, group: 'Panel appearance', label: 'Vendor colours',
    help: "NVIDIA green, or AMD red on an AMD card. Off keeps green everywhere." },
  { key: 'Language', type: 'code', default: null, options: LANGUAGES, group: 'Panel appearance', label: 'Language',
    help: "The language this panel and the in-game one are written in. Default follows Windows. OptiScaler's own menu stays English. A language that needs its own font (Chinese, Korean) loads it from Windows on the next frame." },
  { key: 'FontScale', type: 'float', default: 1.15, min: 0.75, max: 2, step: 0.05, group: 'Panel appearance',
    label: 'Font size', help: "This panel's text only -- OptiScaler's own menu keeps its [Menu] FontSize.\n\nRow widths are worked out from the font size, so far above 1.5x labels start running into their values." },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key.toLowerCase(), f]));
// Sections in the order a player meets them, not the order the fields happen to sit in the array.
//
// It used to be first-appearance order, which was fine while the sections WERE the array's order.
// The 2026-09-20 regroup broke that: the rows are grouped by what they affect now, so a field's
// position no longer says anything about where its section belongs -- and Light panel being the
// first field would have put "Panel & window" at the top of the dialog.
//
// Anything not named here falls in after, in the old first-appearance order, so a group added to
// FIELDS and forgotten here still renders instead of vanishing.
const GROUP_ORDER = [
  'Turn it on',
  'Picture',
  'Speed vs quality',
  'Brightness & HDR',
  'What the model is told',
  'Compare & inspect',
  'Window',
  'Panel appearance',
];

const GROUPS = (() => {
  const present = [...new Set(FIELDS.map((f) => f.group))];
  const ordered = GROUP_ORDER.filter((g) => present.includes(g));
  return [...ordered, ...present.filter((g) => !ordered.includes(g))];
})();

// ── The panel's pages ───────────────────────────────────────────────────────────────────────────
//
// The in-game panel is six pages picked at the top (DlssNr_Menu.cpp, enum PanelPage), and the pop-out
// is that panel outside the game -- so it is the same six pages, holding the same sections, in the
// same order, under the same names. This table is that layout, written once. The group above is what
// a row AFFECTS and drives the game card's settings dialog; this is where the row SITS.
//
// A field added to FIELDS has to be named here too, and dlssnr.test.js fails on one that is not --
// otherwise it would quietly never be drawn in the panel.
const HEADER_KEYS = ['Enabled', 'RunBeforeSR', 'RunBeforeRR'];

const PAGES = [
  // Main carries those header rows above it, then Frame Generation -- which is not a list of ini
  // fields but the game's own DLSS-G, written through its per-game marker, so the renderer draws it
  // rather than this table naming keys.
  { page: 'Main', sections: [{ caption: 'Frame Generation', frameGen: true, keys: [] }] },
  { page: 'Model', sections: [
    { caption: 'Global Controls', keys: ['LocalStructure', 'LocalTone'] },
    { caption: 'Models', keys: ['Preset', 'Style', 'Intensity', 'Pass2Preset', 'Pass2Style', 'Pass3Preset', 'Pass3Style'] },
  ] },
  { page: 'Cost', sections: [
    { caption: 'Cost', keys: ['Passes', 'PassRate', 'ChainedHistory', 'WorkingScale', 'ScalingDownscaler'] },
  ] },
  { page: 'Image', sections: [
    // No caption on the first block, as in the engine: the page button above already says Image, and
    // these are the filters that make it.
    { caption: null, keys: ['Transfer', 'ScalingUpscaler', 'ScalingSharpness', 'ScalingAntiRinging',
                            'ScalingSigmoid', 'ScalingDither'] },
    { caption: 'How much of it lands', keys: ['TransferStrength', 'ColourStrength', 'Brightness', 'Contrast', 'HaloGuard', 'DepthEdge'] },
    { caption: 'Colour', keys: ['ReversibleMode', 'WhitePointSource', 'WhitePointTrim', 'WhitePointScale', 'MaxRatio'] },
    { caption: 'Exposure scan', keys: ['ScanMeter', 'ScanTrim', 'ScanInverted'] },
  ] },
  { page: 'Inspect', sections: [
    // motion: the read-only "is anything actually feeding the model?" row, first, as in the
    // engine's own Guide section. Not an ini field -- the in-game panel reads it from the
    // evaluate path and this one from the deployed files -- so the renderer draws it, the way
    // Frame Generation on Main already does.
    { caption: 'Guide', motion: true, keys: ['DepthConvention', 'OpticalFlow', 'UICorrection', 'ResetWhenBlind'] },
    { caption: 'Inspect', keys: ['ApplyModel', 'AutoCapture', 'HoldFrame', 'Compare', 'CompareSwap', 'CompareTags',
                                 'TagScale', 'CompareZoom', 'CompareSplit', 'DebugView'] },
  ] },
  { page: 'Setup', sections: [
    { caption: 'Keys', keys: ['PanelKey'] },
    { caption: 'Appearance', keys: ['LightTheme', 'VendorColours', 'Language', 'FontScale'] },
    // The in-game panel has no Window section: this is the 64-bit helper's window, which only exists
    // for a 32-bit game and can only be set from out here.
    { caption: 'Window', keys: ['ForceBorderless', 'BorderlessWidth', 'BorderlessHeight'] },
  ] },
  // The in-game panel's last two pages, always listed and greyed with the reason while their add-on is
  // not in the game: ReLimiter's frame pacing and RenoDX's HDR. Neither is an ini of ours -- nor can it be one, because neither
  // add-on re-reads its own ini while running and ReLimiter rewrites relimiter.ini on exit -- so the
  // rows are not listed here. The engine publishes what the add-on itself describes (its host API,
  // OptiScaler.hosted.json) and the renderer draws that, the way Frame Generation draws itself.
  { page: 'Pacing', sections: [{ caption: 'Frame pacing', hosted: 'pacing', keys: [] }] },
  { page: 'HDR', sections: [{ caption: 'HDR and tone mapping', hosted: 'hdr', keys: [] }] },
];

// key -> the page it sits on, so a field can carry its page without the layout being written twice.
const PAGE_OF = (() => {
  const map = new Map();
  for (const { page, sections } of PAGES) {
    for (const section of sections) {
      for (const key of section.keys) map.set(key, page);
    }
  }
  for (const key of HEADER_KEYS) map.set(key, 'Main');
  return map;
})();

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
    // Where the panel draws it: the in-game panel's own page (PAGES above).
    page: PAGE_OF.get(f.key) || null,
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
    // The Auto switch drawn in this slider's row, and the live reading shown while it is on.
    autoKey: f.autoKey || null,
    autoLive: f.autoLive || null,
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

// ── The hosted pages: ReLimiter and RenoDX, through the running game ──────────────────────────
//
// Pacing and HDR belong to two ReShade add-ons, not to OptiScaler.ini, and neither can be changed from
// a file while the game runs: they read their ini once at start, and ReLimiter writes its own back on
// exit, over whatever this app put there. The only live way in is each add-on's host API, callable
// only from inside the game. So the engine (DlssNr_Hosted.cpp, engine feat/popout-hosted-pages) does
// the calling and two files carry it, beside OptiScaler.live.json and under the same request:
//
//   OptiScaler.hosted.json      the engine's: {v:1, pid, at, ack, pacing:{available, reason, version,
//                               settings:[...]}, hdr:{available, reason, module, addon, settings:[...]}}.
//                               Written at least once a second while the request is live.
//   OptiScaler.hosted.set.json  ours: {seq, pid, pacing:{key:value}, hdr:{key:value}}. Applied once per
//                               new seq, only by the process whose pid it names, then acked.
//
// Everything below is pure, so the rules -- what counts as a live answer, and how a command is built
// so nothing a user changed is lost between two writes -- are tested without a game.
const HOSTED_FILE = 'OptiScaler.hosted.json';
const HOSTED_SET_FILE = 'OptiScaler.hosted.set.json';
// The engine writes at least every second; three missed writes and the game has stopped, or the writer has.
const HOSTED_STALE_MS = 3000;
const HOSTED_KINDS = ['pacing', 'hdr'];
const HOSTED_TYPES = {
  pacing: new Set(['bool', 'int', 'float', 'double', 'enum']),
  hdr: new Set(['bool', 'int', 'float', 'combo']),
};

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// One setting as the engine described it, checked rather than trusted: a row the renderer cannot draw
// honestly (a slider with no range, a choice list that does not include the value) is dropped, which is
// exactly what the in-game page does with the same setting.
function hostedSetting(kind, s) {
  if (!s || typeof s !== 'object' || !isStr(s.key) || !s.key || !HOSTED_TYPES[kind].has(s.type)) return null;
  // ReLimiter groups; RenoDX has sections. Either is the caption the row sits under.
  const caption = kind === 'pacing' ? s.group : s.section;
  const out = {
    key: s.key,
    label: isStr(s.label) && s.label ? s.label : s.key,
    caption: isStr(caption) ? caption : '',
    tooltip: isStr(s.tooltip) ? s.tooltip : '',
    type: s.type,
    enabled: s.enabled !== false,
  };
  if (s.type === 'bool') {
    if (typeof s.value !== 'boolean') return null;
    out.value = s.value;
  } else if (s.type === 'enum') {
    if (!Array.isArray(s.choices) || !s.choices.every(isStr) || !s.choices.length || !isStr(s.value)) return null;
    out.choices = s.choices;
    out.value = s.value;
  } else if (s.type === 'combo') {
    if (!Array.isArray(s.labels) || !s.labels.every(isStr) || !s.labels.length) return null;
    if (!Number.isInteger(s.value) || s.value < 0 || s.value >= s.labels.length) return null;
    out.labels = s.labels;
    out.value = s.value;
  } else {
    if (!isNum(s.min) || !isNum(s.max) || s.min >= s.max || !isNum(s.value)) return null;
    out.min = s.min;
    out.max = s.max;
    out.value = s.value;
    // ReLimiter's "0 means automatic" settings: the range is what applies ABOVE zero.
    if (isStr(s.zeroLabel) && s.zeroLabel) out.zeroLabel = s.zeroLabel;
  }
  return out;
}

// ── RenoDX host API version 4: the whole overlay ─────────────────────────────────────────────────
//
// A version-4 RenoDX add-on describes every row its own overlay draws, in order: the engine publishes
// them as hdr.rows (DlssNr_Hosted.cpp AppendHdrV4), with hdr.title and hdr.presets beside them, after
// the old hdr.settings (kept for older app builds). When rows are there the pop-out draws those rather
// than settings. Each is checked the way hostedSetting checks a setting: a row that cannot be drawn
// honestly is dropped. Invisible rows never arrive (the engine skips them).
const HDR_ROW_KINDS = new Set(['float', 'int', 'bool', 'button', 'label', 'bullet', 'text', 'textNowrap', 'custom', 'inputText']);
const isBool = (v) => typeof v === 'boolean';
const isInt = (v) => Number.isInteger(v);

function hdrRow(r) {
  if (!r || typeof r !== 'object' || !HDR_ROW_KINDS.has(r.kind) || !isInt(r.index) || r.index < 0) return null;
  const out = {
    index: r.index,
    kind: r.kind,
    key: isStr(r.key) ? r.key : '',
    label: isStr(r.label) ? r.label : '',
    section: isStr(r.section) ? r.section : '',
    sectionOpen: r.sectionOpen !== false,
    tooltip: isStr(r.tooltip) ? r.tooltip : '',
    enabled: r.enabled !== false,
    sticky: r.sticky === true,
    segmented: r.segmented === true,
    multiline: r.multiline === true,
    tint: isStr(r.tint) && /^#[0-9A-Fa-f]{6}$/.test(r.tint) ? r.tint : null,
    canReset: r.canReset === true,
    isUsingDefault: r.isUsingDefault !== false,
  };
  if (Array.isArray(r.labels) && r.labels.every(isStr)) out.labels = r.labels;
  if (r.kind === 'float' || r.kind === 'int') {
    if (!out.key || !isNum(r.min) || !isNum(r.max) || r.min >= r.max || !isNum(r.value)) return null;
    out.min = r.min;
    out.max = r.max;
    out.logarithmic = r.logarithmic === true;
    out.value = r.value;
    out.default = isNum(r.default) ? r.default : r.value;
  } else if (r.kind === 'bool') {
    if (!out.key || !isBool(r.value)) return null;
    out.value = r.value;
    out.default = isBool(r.default) ? r.default : r.value;
  } else if (r.kind === 'inputText') {
    if (!out.key || !isStr(r.value)) return null;
    out.value = r.value;
    out.default = isStr(r.default) ? r.default : '';
    out.placeholder = isStr(r.placeholder) ? r.placeholder : '';
    out.maxLength = isInt(r.maxLength) && r.maxLength > 0 ? r.maxLength : 0;
    out.inputTextFlags = isInt(r.inputTextFlags) ? r.inputTextFlags : 0;
  }
  return out;
}

// hdr.presets: null when the mod has none, else { count, selected, segmented, labels }.
function hdrPresets(p) {
  if (!p || typeof p !== 'object' || !isInt(p.count) || p.count <= 0 || !isInt(p.selected) || p.selected < 0) return null;
  const labels = Array.isArray(p.labels) && p.labels.every(isStr) ? p.labels.slice(0, p.count) : [];
  while (labels.length < p.count) labels.push(String(labels.length));
  return { count: p.count, selected: p.selected, segmented: p.segmented === true, labels };
}

// The engine's answer, or why it is not one. `now` is passed in so the staleness rule is testable.
function checkHosted(raw, now, staleMs = HOSTED_STALE_MS) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !isNum(raw.at) || !isNum(raw.pid)) {
    return { ok: false, reason: 'unknown-format' };
  }
  if (now - raw.at > staleMs) return { ok: false, reason: 'stale', at: raw.at };
  const hosted = { pid: raw.pid, at: raw.at, ack: isNum(raw.ack) && raw.ack >= 0 ? Math.floor(raw.ack) : 0 };
  for (const kind of HOSTED_KINDS) {
    const src = raw[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
    const settings = (Array.isArray(src.settings) ? src.settings : []).map((s) => hostedSetting(kind, s)).filter(Boolean);
    // Version 4 RenoDX: the overlay's own rows. null (not []) when the add-on is older, so the renderer
    // knows to draw settings instead.
    const rows = kind === 'hdr' && Array.isArray(src.rows) ? src.rows.map(hdrRow).filter(Boolean) : null;
    const available = src.available === true && (settings.length > 0 || (rows !== null && rows.length > 0));
    hosted[kind] = {
      // Available and with something to show. The page is listed either way; without this it is greyed
      // and says why.
      available,
      // Why not, as the engine's code (not-loaded / no-api / api-version), or 'empty' for an add-on
      // that is there but has nothing the panel can draw. null while available.
      reason: available ? null : src.available === true ? 'empty' : (isStr(src.reason) && src.reason ? src.reason : 'not-loaded'),
      settings,
    };
    if (kind === 'pacing') hosted[kind].version = isStr(src.version) ? src.version : '';
    if (kind === 'hdr') {
      hosted[kind].module = isStr(src.module) ? src.module : '';
      hosted[kind].addon = isStr(src.addon) ? src.addon : '';
      // Whether the add-on can put its own defaults back ('$reset'); host API version 3 and later.
      hosted[kind].canReset = src.canReset === true;
      hosted[kind].apiVersion = isNum(src.apiVersion) ? src.apiVersion : null;
      hosted[kind].rows = rows;
      hosted[kind].title = rows !== null && isStr(src.title) ? src.title : '';
      hosted[kind].presets = rows !== null ? hdrPresets(src.presets) : null;
    }
  }
  return { ok: true, hosted };
}

// The next command file, from what was sent before (`state`, ours), what the engine has acknowledged
// (`hosted`, checked above) and the new changes ({pacing:{key:value}, hdr:{...}}).
//
// A command carries every change the engine has NOT yet acked, not just the newest -- the file is
// replaced, not appended to, so two changes a quarter-second apart would otherwise lose the first if
// the engine read only the second. Once ack reaches our last seq everything before it has landed and
// the slate is clean. seq starts past the engine's ack, so a restarted app never sends a seq the game
// has already applied (and would ignore); a new game process (a different pid) starts over entirely.
// Actions rather than values: a button press and "reset everything". Setting a value twice is harmless,
// doing one of these twice is not -- the engine may already have read the command it was in, and a
// second copy riding along in the next one would press the button again. So they go in the command they
// were made in and are never carried: one lost to a replaced file is pressed again by hand.
const HOSTED_ONE_SHOT = new Set(['$press', '$reset']);

function nextHostedCommand(state, hosted, changes) {
  const pid = hosted.pid;
  const ack = hosted.ack || 0;
  const prev = state && state.pid === pid ? state : { pid, seq: 0, pending: { pacing: {}, hdr: {} } };
  const allLanded = prev.seq <= ack;
  const pending = {};
  for (const kind of HOSTED_KINDS) {
    pending[kind] = allLanded ? {} : { ...(prev.pending[kind] || {}) };
    for (const key of HOSTED_ONE_SHOT) delete pending[kind][key];
    for (const [key, value] of Object.entries((changes && changes[kind]) || {})) {
      if (typeof value === 'boolean' || isNum(value) || isStr(value)) pending[kind][key] = value;
    }
  }
  const seq = Math.max(prev.seq, ack) + 1;
  return { state: { pid, seq, pending }, command: { seq, pid, pacing: pending.pacing, hdr: pending.hdr } };
}

module.exports = { FIELDS, GROUPS, PAGES, HEADER_KEYS, SECTION, readSettings, writeSettings, parseValue, formatValue, isAuto,
                   HOSTED_FILE, HOSTED_SET_FILE, HOSTED_STALE_MS, HOSTED_KINDS, HDR_ROW_KINDS, checkHosted, nextHostedCommand };
