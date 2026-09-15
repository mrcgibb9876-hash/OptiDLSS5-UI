// Games that take the engine's DLSS-NR Present route through OptiScaler.ini, not through the engine's own
// game list. The RE Engine titles and DMC5/SF6 are in the engine's OldOverlayMenu quirk list and come with
// REFramework (reengine.js); these need neither, only [DlssNr] Placement=present.
//
// Why FromSoftware's DirectX 12 engine is here: the DLSS5 Feeder crashed the Neural Rendering model on its
// first frame in Elden Ring and Armored Core VI (0xC0000005 in nvngx_dlssnr.dll under D3D12Core.dll, its
// same-device D3D12 session), so the Feeder route never ran DLSS 5 there. On the Present route the pass runs
// on OptiScaler's own command list over the game's TAA, with depth tracked from the game and optical-flow
// motion vectors -- ELDEN RING, 2026-09-15: 4800 frames, 0 model failures, 45 fps at 2560x1600 on an
// RTX 5070 Ti laptop, letterboxed 16:9 picture found by itself. ARMORED CORE VI the same day: 4800 frames, 0 model
// failures, 50-60 fps with one pass. Nightreign shares the engine; not yet run on this route.
//
// No Feeder on these games: its ReShade wraps the D3D12 device and the Present route then sees a different
// device from the swapchain's (the engine also stands down while the Feeder is loaded).

const path = require('node:path');

const INI_PRESENT_GAMES = {
  'eldenring.exe': 'ELDEN RING',
  'armoredcore6.exe': 'ARMORED CORE VI',
  'nightreign.exe': 'ELDEN RING NIGHTREIGN',
};

function iniPresentGame(exePath) {
  if (!exePath) return null;
  return INI_PRESENT_GAMES[path.basename(exePath).toLowerCase()] || null;
}

module.exports = { INI_PRESENT_GAMES, iniPresentGame };
