// The break-away DLSS 5 panel: a small always-on-top window of this app's own, opened by a global
// hotkey, that edits the running game's OptiScaler.ini directly.
//
// Why this exists at all. The in-game panel (Alt+Home) is drawn by OptiScaler inside the game, so it
// inherits every way a game can refuse an overlay: a game that swallows the hotkey, one whose window
// OptiScaler never subclassed, an anti-cheat that blocks the hook. On a 32-bit game it is worse --
// NVIDIA ships no 32-bit NGX, so the panel lives in the 64-bit helper and the game only shows a
// mirror of it, which cannot be clicked unless the Feeder's input forwarding lands. Users report
// both: sometimes it will not open, and sometimes it opens and does nothing.
//
// This window sidesteps all of it. It is our own process, so no game has to cooperate: the hotkey is
// registered with the OS rather than hooked out of the game, and the controls write to the ini,
// which the engine re-reads within a second (its LiveReload). The same path Edit already uses --
// dlssnr:get / dlssnr:set -- so there is one implementation of what a setting means, not two.
//
// The one thing it cannot beat is exclusive fullscreen: Windows will not composite another window
// over a game that owns the display. Borderless and windowed are fine, and [DlssNr] ForceBorderless
// already exists for the rest.

// Electron is required on use rather than at load, so the tests -- which run under plain node, with
// no electron module to resolve -- can exercise the parts that are only arithmetic and strings.
const electron = () => require('electron');
const editmenu = require('./editmenu');

// Insert by default, the same key as the in-game panel (2026-09-23): one key opens this project's
// panel whatever the game; Settings can bind another. It is only registered while a game that needs the pop-out is running --
// main.js routePanelKey and panelroute.js decide that -- because a registered hotkey never reaches the
// game, and the in-game panel lives on Insert everywhere else.
const DEFAULT_ACCELERATOR = 'Insert';

// Wide enough that a slider row still fits its label, the slider, the readout and its Default
// button side by side; below that the row wraps and the window stops being readable at a glance.
const MIN_WIDTH = 430;
const MIN_HEIGHT = 320;
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 640;

let panel = null;
let registered = null;

// The player's own key if they bound one in Settings, else Insert. The one value this app itself
// ever wrote as the default, Alt+Shift+Home, is read as "never chosen": it is the old default saved
// by an older build, not a choice, and it moves to Insert with everyone else.
function accelerator(settings) {
  const value = settings && typeof settings.panelHotkey === 'string' ? settings.panelHotkey.trim() : '';
  if (!value || value.toLowerCase() === 'alt+shift+home') return DEFAULT_ACCELERATOR;
  return value;
}

// Bounds are remembered so the panel comes back where it was left, but only after being checked
// against the displays attached right now: a window restored onto a monitor that has since been
// unplugged is invisible and cannot be dragged back.
function visibleBounds(saved, displays = null) {
  const fallback = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  if (!saved || typeof saved !== 'object') return fallback;

  const width = Math.max(MIN_WIDTH, Math.round(Number(saved.width) || DEFAULT_WIDTH));
  const height = Math.max(MIN_HEIGHT, Math.round(Number(saved.height) || DEFAULT_HEIGHT));
  const x = Math.round(Number(saved.x));
  const y = Math.round(Number(saved.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };

  const attached = displays || electron().screen.getAllDisplays();
  const onScreen = attached.some((display) => {
    const a = display.workArea;
    // Its title bar has to be reachable, not merely some pixel of it: overlap on the top edge.
    return x + width > a.x && x < a.x + a.width && y + 40 > a.y && y < a.y + a.height;
  });

  return onScreen ? { x, y, width, height } : { width, height };
}

function isOpen() {
  return panel !== null && !panel.isDestroyed() && panel.isVisible();
}

function create({ preload, page, savedBounds, onBoundsChanged }) {
  const { BrowserWindow } = electron();
  const win = new BrowserWindow({
    ...visibleBounds(savedBounds),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    // Out of the alt-tab list: this is a heads-up panel over a game, not a second app window, and
    // alt-tabbing to it is exactly the round trip it exists to remove.
    skipTaskbar: true,
    backgroundColor: '#14161a',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });

  // Right-click Cut/Copy/Paste/Select all here too (editmenu.js). This window is frameless, so it
  // has no menu bar at all: a value read off this panel had no way out of it before.
  const { Menu, clipboard } = electron();
  editmenu.attach(win.webContents, { Menu, clipboard });

  win.loadFile(page);

  // 'screen-saver' is the highest ordinary level and the one that actually sits over a borderless
  // game; plain alwaysOnTop loses to a game that raises itself every frame.
  win.setAlwaysOnTop(true, 'screen-saver');

  if (typeof onBoundsChanged === 'function') {
    const save = () => {
      if (win.isDestroyed() || win.isMinimized()) return;
      onBoundsChanged(win.getBounds());
    };
    win.on('moved', save);
    win.on('resized', save);
  }

  win.on('closed', () => { panel = null; });
  return win;
}

function show(options = {}) {
  if (panel === null || panel.isDestroyed()) panel = create(options);
  panel.setAlwaysOnTop(true, 'screen-saver');
  if (options.overGame) {
    // Opened by the hotkey over a running game: shown without taking the focus, and kept from ever
    // taking it (WS_EX_NOACTIVATE on Windows), so clicks and drags land on the panel while the game
    // stays the active window. A game that minimises itself the moment it loses focus -- Max Payne 2
    // did, 2026-09-23, behind dgVoodoo -- then keeps running under the panel. The cost is the
    // keyboard: arrow-key stepping needs focus, so over a game the panel is mouse-driven.
    panel.setFocusable(false);
    panel.showInactive();
  } else {
    // Opened from Settings: an ordinary window, focused, with the keyboard.
    panel.setFocusable(true);
    panel.show();
    panel.focus();
  }
  // On the very first open this lands before the page exists and is dropped; that open is covered
  // by the renderer reading its targets as it loads. Every later open needs this, because the panel
  // was only hidden and would otherwise still be showing whatever was true when it was put away.
  panel.webContents.send('panel:opened');
  return panel;
}

function hide() {
  if (panel !== null && !panel.isDestroyed()) panel.hide();
}

// Closing the panel only hides it, so it is still a window as far as Electron is concerned. That
// matters when the main window goes: window-all-closed would never fire and the app would sit in
// the background with nothing the user can click. The main window's 'closed' calls this.
function destroy() {
  if (panel !== null && !panel.isDestroyed()) panel.destroy();
  panel = null;
}

function toggle(options) {
  if (isOpen()) {
    hide();
    return false;
  }
  show(options);
  return true;
}

// Returns what happened so the caller can tell the user, rather than failing silently: a hotkey
// another application already owns is the common case and is worth a message, not a shrug.
function registerHotkey(settings, onPressed) {
  const wanted = accelerator(settings);
  if (registered === wanted && electron().globalShortcut.isRegistered(wanted)) return { ok: true, accelerator: wanted };

  unregisterHotkey();

  let ok = false;
  try {
    ok = electron().globalShortcut.register(wanted, onPressed);
  } catch (error) {
    return { ok: false, accelerator: wanted, error: String(error && error.message ? error.message : error) };
  }

  if (!ok) {
    return { ok: false, accelerator: wanted, error: 'another application already has that key combination' };
  }

  registered = wanted;
  return { ok: true, accelerator: wanted };
}

// "Reset layout", at the foot of the panel's Main page -- the in-game panel's own button, for the
// window this copy of the panel lives in: back to the size it opens at, centred on the display it is
// on. The caller throws the remembered bounds away, since settings.json is its.
function resetBounds() {
  if (panel === null || panel.isDestroyed()) return false;
  panel.setBounds({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  panel.center();
  return true;
}

function unregisterHotkey() {
  if (registered !== null) {
    try { electron().globalShortcut.unregister(registered); } catch { /* going away anyway */ }
    registered = null;
  }
}

module.exports = {
  DEFAULT_ACCELERATOR,
  accelerator,
  visibleBounds,
  isOpen,
  show,
  hide,
  destroy,
  toggle,
  resetBounds,
  registerHotkey,
  unregisterHotkey,
};
