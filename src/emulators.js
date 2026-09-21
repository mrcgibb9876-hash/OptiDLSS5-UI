// Emulators as games (EXPERIMENTAL). An emulator draws its console's frames with an ordinary
// PC graphics API and makes no DLSS call of its own, so it takes the DLSS5 Feeder route: ReShade
// in the emulator's process, the Feeder synthesising the DLSS call from depth and estimated
// motion, OptiScaler_DLSSNR running Neural Rendering on it. One install covers every game that
// emulator runs. What static detection cannot know is which renderer the user picked in the
// emulator's settings -- so each profile names the renderers it offers, the one this app assumes,
// and where the setting lives.
//
// The profile table is ported from DLSS5-Swapper (src/core/emulators.js, MIT, Copyright (c) 2026
// Rakan Alkhaldi -- third_party/DLSS5-Swapper-LICENSE.txt), whose table is in turn based on the
// MIT-licensed detection table in DLSS5-Autopilot
// (https://github.com/Kizzuwatnaa/DLSS5-Autopilot/blob/main/core/emulators.py). The API lists are
// this app's own since #106: each emulator's real renderers, ordered by what suits this app best.
//
// Known limits, from the Feeder's own documentation and DLSS5-Swapper's notes: ReShade often
// cannot find the console game's real depth buffer inside an emulator, and without depth the
// Feeder has little to work with; a Vulkan renderer needs ReShade's machine-wide Vulkan layer
// and NVIDIA Smooth Motion off; the emulator's HUD and menus are part of the frame.
'use strict';

const path = require('node:path');

// Which renderer each emulator is set up for (issue #106, 2026-09-21): the one that suits this app's
// stack best, and the route is always built for it -- not for whatever the emulator happened to run
// last. The order, best first:
//   dx11    ReShade loads locally beside the exe, and the Feeder makes its own D3D12 device for the
//           model. On an emulator's own D3D12 device the model crashed on its first frame (Dolphin,
//           2026-09-15, gamehelp 'nr-model-crash-emulator'), so D3D12 is not first even where offered.
//   vulkan  Works, but ReShade only reaches Vulkan as a machine-wide layer the player installs, and
//           NVIDIA Smooth Motion has to be off.
//   dx12    Xenia only, whose Vulkan backend is the weaker one.
//   opengl  Last: DLSS 5 cannot draw its panel over OpenGL. Only melonDS and mGBA have nothing else.
// A Dolphin run on OpenGL left DLSS 5 with nothing to hook (#106) -- the emulator's setting and the
// route disagreed, and nothing said so. Every emulator is warned about now, on the card and in Game
// Help, with where the setting lives.
//
// [key, name, system, exe names, APIs best first, the renderer's name in the emulator, where to set it,
//  and the whole hint where "where: renderer" does not read right]
const TABLE = [
  ['duckstation', 'DuckStation', 'PlayStation 1', ['duckstation-qt-x64.exe', 'duckstation-qt-x64-releaseltcg.exe', 'duckstation-nogui-x64.exe', 'duckstation.exe'], ['dx11', 'vulkan', 'dx12', 'opengl'], 'Direct3D 11', 'Settings > Graphics > Renderer'],
  ['pcsx2', 'PCSX2', 'PlayStation 2', ['pcsx2-qt.exe', 'pcsx2x64.exe', 'pcsx2x64-avx2.exe', 'pcsx2.exe'], ['dx11', 'vulkan', 'dx12', 'opengl'], 'Direct3D 11', 'Settings > Graphics > Renderer'],
  ['dolphin', 'Dolphin', 'GameCube / Wii', ['dolphin.exe', 'dolphinqt.exe'], ['dx11', 'vulkan', 'dx12', 'opengl'], 'Direct3D 11', 'Graphics > General > Backend'],
  ['ppsspp', 'PPSSPP', 'PSP', ['ppssppwindows64.exe', 'ppssppwindows.exe'], ['dx11', 'vulkan', 'opengl'], 'Direct3D 11', 'Settings > Graphics > Backend'],
  ['xenia', 'Xenia', 'Xbox 360', ['xenia.exe', 'xenia_canary.exe'], ['dx12', 'vulkan'], 'Direct3D 12', 'its .config.toml, [GPU]', 'its .config.toml, [GPU]: gpu = "d3d12" (the default)'],
  ['cemu', 'Cemu', 'Wii U', ['cemu.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Options > General settings > Graphics > Graphics API'],
  ['rpcs3', 'RPCS3', 'PlayStation 3', ['rpcs3.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Configuration > GPU > Renderer'],
  ['ryujinx', 'Ryujinx', 'Nintendo Switch', ['ryujinx.exe', 'ryujinx.ava.exe', 'ryujinx.headless.sdl2.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Options > Settings > Graphics > Graphics Backend'],
  ['yuzu', 'yuzu / suyu / Eden / Citron', 'Nintendo Switch', ['yuzu.exe', 'suyu.exe', 'eden.exe', 'citron.exe', 'sudachi.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Emulation > Configure > Graphics > API'],
  ['shadps4', 'shadPS4', 'PlayStation 4', ['shadps4.exe'], ['vulkan'], 'Vulkan', 'Settings', 'Vulkan is its only renderer'],
  ['azahar', 'Azahar / Citra / Lime3DS', 'Nintendo 3DS', ['azahar.exe', 'citra.exe', 'citra-qt.exe', 'lime3ds.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Emulation > Configure > Graphics > Graphics API'],
  ['melonds', 'melonDS', 'Nintendo DS', ['melonds.exe'], ['opengl'], 'OpenGL', 'Config > Video settings > Renderer'],
  ['flycast', 'Flycast', 'Dreamcast', ['flycast.exe'], ['dx11', 'vulkan', 'opengl'], 'DirectX 11', 'Settings > Video > Graphics API'],
  ['xemu', 'xemu', 'Xbox', ['xemu.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Machine > Settings > Display > Renderer'],
  ['vita3k', 'Vita3K', 'PlayStation Vita', ['vita3k.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Configuration > Settings > GPU > Backend Renderer'],
  ['retroarch', 'RetroArch', 'Multi-system', ['retroarch.exe'], ['dx11', 'vulkan', 'dx12', 'opengl'], 'd3d11', 'Settings > Drivers > Video (a core that needs Vulkan: vulkan)'],
  ['mgba', 'mGBA', 'Game Boy Advance', ['mgba.exe'], ['opengl'], 'OpenGL', 'Tools > Settings > Display > Display driver'],
  // Snes9x's Windows "Direct3D" output is Direct3D 9, which is no modern route here; its Vulkan output
  // (1.61 and later) is.
  ['snes9x', 'Snes9x', 'SNES', ['snes9x-x64.exe', 'snes9x.exe'], ['vulkan', 'opengl'], 'Vulkan', 'Config > Display Configuration > Output Method'],
  // DLSS5-Swapper's table also has Play! (PlayStation 2) as play.exe -- left out here: a name that
  // generic would turn any game launcher called play.exe into an "emulator".
];

const PROFILES = TABLE.map(([key, name, system, exes, apis, renderer, where, hint]) => ({
  key, name, system, exes, apis, renderer, where, hint: hint || `${where}: ${renderer}`,
}));

const BY_EXE = new Map(PROFILES.flatMap((p) => p.exes.map((exe) => [exe.toLowerCase(), p])));

function profileFor(exePath) {
  if (!exePath) return null;
  return BY_EXE.get(path.basename(String(exePath)).toLowerCase()) || null;
}

const API_LABEL = { dx12: 'Direct3D 12', dx11: 'Direct3D 11', vulkan: 'Vulkan', opengl: 'OpenGL' };

// The renderer the emulator actually used last, newest evidence first: OptiScaler's own log
// (detect.js runtimeApi) or a watched launch (probe.js, kept on the detection even though it no
// longer moves the route for an emulator).
function seenApi(detected) {
  const d = detected || {};
  const probeApi = d.probe && d.probe.api ? d.probe.api : null;
  const probeAt = probeApi ? Date.parse(d.probe.capturedAt || '') || 0 : 0;
  if (probeApi && (!d.runtimeApi || probeAt > (d.runtimeLogMtime || 0))) return probeApi;
  return d.runtimeApi || null;
}

// What the card and Game Help tell the player: which renderer to pick in the emulator and where,
// and whether the last run used another one. `api` is the one the route is set up for -- the
// profile's best, or what was chosen in Edit.
function rendererAdvice(detected, api) {
  const emu = detected && detected.emulator;
  if (!emu || !api) return null;
  const profile = PROFILES.find((p) => p.key === emu.key) || emu;
  const best = api === (profile.apis || [])[0];
  const seen = seenApi(detected);
  return {
    name: emu.name,
    api,
    renderer: best && profile.renderer ? profile.renderer : (API_LABEL[api] || String(api).toUpperCase()),
    // The menu path; the renderer's own name only when it is the one being asked for.
    hint: best ? (profile.hint || '') : (profile.where || profile.hint || ''),
    seen: seen && seen !== api ? (API_LABEL[seen] || String(seen).toUpperCase()) : null,
    // No renderer DLSS 5 can draw over: the panel is the break-away one only.
    openglOnly: api === 'opengl' && (profile.apis || []).every((a) => a === 'opengl'),
  };
}

module.exports = { PROFILES, profileFor, rendererAdvice, seenApi };
