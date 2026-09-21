'use strict';
// Right-click Cut / Copy / Paste / Select all, on every window this app opens.
//
// Why it has to be built: an Electron window gets the default application menu, whose Edit roles
// carry the Ctrl+C/X/V/A accelerators, but nothing gives it a CONTEXT menu -- Chromium's own
// right-click menu is not wired up in a BrowserWindow. So a right-click anywhere in this app did
// nothing at all, and the main window sets autoHideMenuBar, so there was not even a visible Edit
// menu to point at. Pasting into a text field was reachable only by knowing the shortcut, and
// copying a path or an error message out of a panel had no discoverable route at all.
//
// Built from the click's own params rather than a fixed template: Chromium reports what is under
// the cursor (editFlags, whether the element is editable, what is selected), so the menu offers only
// what would actually do something. A Paste greyed out on a label is the difference between a menu
// that explains itself and one that lies.
//
// electron is passed in rather than required, so the decisions are unit-testable without a browser
// window -- the same shape panelwindow.js uses.

// The menu for one right-click. Pure: params in, item descriptors out.
//
// params is Chromium's context-menu payload:
//   { isEditable, selectionText, editFlags: { canCut, canCopy, canPaste, canSelectAll }, linkURL }
//
// An item is either a `role` (Electron does the work, and does it against the right webContents) or
// `copyText`, which this module's own click handler puts on the clipboard. Roles are preferred: a
// role-driven Cut/Copy/Paste goes through Chromium's own editing path, so it behaves correctly in a
// text field, in a selection spanning elements, and with the undo stack.
function templateFor(params = {}, t = (s) => s) {
  const flags = params.editFlags || {};
  const editable = !!params.isEditable;
  const selected = !!String(params.selectionText || '').trim();
  const items = [];

  // A link's address is worth copying where there is no selection to copy -- Game Help's panels and
  // the catalog notes both carry them.
  if (params.linkURL) items.push({ label: t('Copy link address'), copyText: params.linkURL });
  if (editable) items.push({ label: t('Cut'), role: 'cut', enabled: !!flags.canCut && selected });
  items.push({ label: t('Copy'), role: 'copy', enabled: !!flags.canCopy && selected });
  if (editable) items.push({ label: t('Paste'), role: 'paste', enabled: !!flags.canPaste });
  items.push({ type: 'separator' });
  items.push({ label: t('Select all'), role: 'selectAll', enabled: flags.canSelectAll !== false });
  return items;
}

// Gives one webContents its context menu. Safe on a window that is later destroyed: the listener
// goes with it.
function attach(webContents, { Menu, clipboard = null, translate = (s) => s } = {}) {
  if (!webContents || !Menu || typeof webContents.on !== 'function') return false;
  webContents.on('context-menu', (_event, params) => {
    try {
      const template = templateFor(params || {}, translate).map((item) => (
        item.copyText
          ? { label: item.label, click: () => { try { if (clipboard) clipboard.writeText(item.copyText); } catch {} } }
          : item
      ));
      Menu.buildFromTemplate(template).popup({});
    } catch {
      // A menu that cannot be shown must never take the window down with it.
    }
  });
  return true;
}

module.exports = { templateFor, attach };
