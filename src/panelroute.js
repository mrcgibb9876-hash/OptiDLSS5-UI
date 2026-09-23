// Which panel Insert opens, decided by the game that is running. One key, no second hotkey to learn:
//
//   engine    The DLSS 5 panel inside the game. Every 64-bit game whose in-game panel can draw -- the
//             engine owns Insert there (Alt+Home on RE Engine, written per game), and this app must
//             NOT register the key, because a registered hotkey never reaches the game at all.
//   popout    This app's pop-out panel, on Insert, while that game runs. The games where the in-game
//             panel is out of reach or is only a mirror: the 32-bit route (the panel lives in the
//             64-bit helper), OpenGL (no swapchain for the menu), and a game whose ini turned the
//             overlay off (MSFS 2024 needs OverlayMenu=false, #123).
//   chicken   Deep Fried Chicken's own menu. Neither of our panels is in that game, so this app keeps
//             its hands off the key.
//
// The exception inside popout: a game that must stay in exclusive fullscreen (legacy.js/feeder.js
// FULLSCREEN_ONLY_EXES). Windows cannot put the pop-out over it, and the Feeder's cast drawn by the
// game's own ReShade is the only panel that shows -- so that one stays with the engine.
'use strict';

const MODES = { ENGINE: 'engine', POPOUT: 'popout', CHICKEN: 'chicken' };

// engineHasPanel false: the game is on an engine build with no in-game panel (engines.js panel:false),
// so there is nothing for Insert to open inside it.
function panelModeFor({ chicken = false, host32 = false, api = null, overlayMenuOff = false, fullscreenOnly = false, engineHasPanel = true } = {}) {
  if (chicken) return MODES.CHICKEN;
  if (fullscreenOnly) return MODES.ENGINE;
  if (host32 || api === 'opengl' || overlayMenuOff || !engineHasPanel) return MODES.POPOUT;
  return MODES.ENGINE;
}

// [Menu] OverlayMenu=false in an ini's text: the one setting that removes the in-game panel.
function overlayMenuOff(iniText) {
  let section = null;
  for (const line of String(iniText || '').split(/\r?\n/)) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (s) { section = s[1].toLowerCase(); continue; }
    const kv = /^\s*OverlayMenu\s*=\s*(\S+)/i.exec(line);
    if (kv && section === 'menu') return kv[1].toLowerCase() === 'false';
  }
  return false;
}

module.exports = { MODES, panelModeFor, overlayMenuOff };
