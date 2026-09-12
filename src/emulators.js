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
// (https://github.com/Kizzuwatnaa/DLSS5-Autopilot/blob/main/core/emulators.py). The API names are
// mapped to this app's: DLSS5-Swapper's 'dxgi' (Direct3D 11/12) becomes dx11 and dx12.
//
// Known limits, from the Feeder's own documentation and DLSS5-Swapper's notes: ReShade often
// cannot find the console game's real depth buffer inside an emulator, and without depth the
// Feeder has little to work with; a Vulkan renderer needs ReShade's machine-wide Vulkan layer
// and NVIDIA Smooth Motion off; the emulator's HUD and menus are part of the frame.
'use strict';

const path = require('node:path');

// [key, name, system, exe names, APIs (DLSS5-Swapper naming), where the renderer setting is]
const TABLE = [
  ['duckstation', 'DuckStation', 'PlayStation 1', ['duckstation-qt-x64.exe', 'duckstation-qt-x64-releaseltcg.exe', 'duckstation-nogui-x64.exe', 'duckstation.exe'], ['dxgi', 'vulkan', 'opengl'], 'Settings > Graphics > Renderer: Direct3D 11/12'],
  ['pcsx2', 'PCSX2', 'PlayStation 2', ['pcsx2-qt.exe', 'pcsx2x64.exe', 'pcsx2x64-avx2.exe', 'pcsx2.exe'], ['dxgi', 'vulkan', 'opengl'], 'Settings > Graphics > Renderer: Direct3D 11/12'],
  ['dolphin', 'Dolphin', 'GameCube / Wii', ['dolphin.exe', 'dolphinqt.exe'], ['dxgi', 'vulkan', 'opengl'], 'Graphics > Backend: Direct3D 11/12'],
  ['ppsspp', 'PPSSPP', 'PSP', ['ppssppwindows64.exe', 'ppssppwindows.exe'], ['dxgi', 'vulkan', 'opengl'], 'Settings > Graphics > Backend: Direct3D 11'],
  ['xenia', 'Xenia', 'Xbox 360', ['xenia.exe', 'xenia_canary.exe'], ['dxgi', 'vulkan'], 'Use the Direct3D 12 backend'],
  ['cemu', 'Cemu', 'Wii U', ['cemu.exe'], ['vulkan', 'opengl'], 'Options > General settings > Graphics: Vulkan'],
  ['rpcs3', 'RPCS3', 'PlayStation 3', ['rpcs3.exe'], ['vulkan', 'opengl'], 'Configuration > GPU > Renderer: Vulkan'],
  ['ryujinx', 'Ryujinx', 'Nintendo Switch', ['ryujinx.exe', 'ryujinx.ava.exe', 'ryujinx.headless.sdl2.exe'], ['vulkan', 'opengl'], 'Settings > Graphics > Backend: Vulkan'],
  ['yuzu', 'yuzu / suyu / Eden / Citron', 'Nintendo Switch', ['yuzu.exe', 'suyu.exe', 'eden.exe', 'citron.exe', 'sudachi.exe'], ['vulkan', 'opengl'], 'Graphics API: Vulkan'],
  ['shadps4', 'shadPS4', 'PlayStation 4', ['shadps4.exe'], ['vulkan'], 'Vulkan renderer'],
  ['azahar', 'Azahar / Citra / Lime3DS', 'Nintendo 3DS', ['azahar.exe', 'citra.exe', 'citra-qt.exe', 'lime3ds.exe'], ['vulkan', 'opengl'], 'Graphics API: Vulkan'],
  ['melonds', 'melonDS', 'Nintendo DS', ['melonds.exe'], ['opengl'], 'OpenGL renderer'],
  ['flycast', 'Flycast', 'Dreamcast', ['flycast.exe'], ['dxgi', 'vulkan', 'opengl'], 'Video > Renderer: DirectX 11'],
  ['xemu', 'xemu', 'Xbox', ['xemu.exe'], ['vulkan', 'opengl'], 'Renderer: Vulkan'],
  ['vita3k', 'Vita3K', 'PlayStation Vita', ['vita3k.exe'], ['vulkan', 'opengl'], 'Backend Renderer: Vulkan'],
  ['retroarch', 'RetroArch', 'Multi-system', ['retroarch.exe'], ['dxgi', 'vulkan', 'opengl'], 'Video driver: d3d11 or d3d12'],
  ['mgba', 'mGBA', 'Game Boy Advance', ['mgba.exe'], ['opengl'], 'OpenGL renderer'],
  ['snes9x', 'Snes9x', 'SNES', ['snes9x-x64.exe', 'snes9x.exe'], ['dxgi'], 'Output method: Direct3D'],
  // DLSS5-Swapper's table also has Play! (PlayStation 2) as play.exe -- left out here: a name that
  // generic would turn any game launcher called play.exe into an "emulator".
];

// DLSS5-Swapper's 'dxgi' covers D3D11 and D3D12. The first API is the one assumed until the user
// picks otherwise in Edit: D3D11 where offered (ReShade loads locally, no machine-wide layer),
// else Vulkan (Xenia: its own hint says D3D12, so that one leads with dx12).
function toAppApis(key, apis) {
  const out = [];
  for (const a of apis) {
    if (a === 'dxgi') out.push(...(key === 'xenia' ? ['dx12', 'dx11'] : ['dx11', 'dx12']));
    else out.push(a);
  }
  return out;
}

const PROFILES = TABLE.map(([key, name, system, exes, apis, hint]) => ({
  key, name, system, exes, hint, apis: toAppApis(key, apis),
}));

const BY_EXE = new Map(PROFILES.flatMap((p) => p.exes.map((exe) => [exe.toLowerCase(), p])));

function profileFor(exePath) {
  if (!exePath) return null;
  return BY_EXE.get(path.basename(String(exePath)).toLowerCase()) || null;
}

module.exports = { PROFILES, profileFor };
