'use strict';
// The right-click menu offers only what would actually do something.
//
// A BrowserWindow has no context menu of its own, so this app had none: right-click did nothing in
// either window, and the main window hides its menu bar, so there was no visible Edit menu to reach
// for either. The shortcuts worked, if you knew them.
//
// The rule these tests hold it to: never offer an action that would be a no-op. A Paste on a label,
// or a Copy with nothing selected, is a menu that lies about what it can do.
const test = require('node:test');
const assert = require('node:assert/strict');
const editmenu = require('../src/editmenu');

const labels = (items) => items.filter((i) => i.type !== 'separator').map((i) => i.label);
const item = (items, label) => items.find((i) => i.label === label);

const EDITABLE = {
  isEditable: true,
  selectionText: 'C:\\Games\\Thing',
  editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
};

test('a text field offers the full set', () => {
  const items = editmenu.templateFor(EDITABLE);
  assert.deepEqual(labels(items), ['Cut', 'Copy', 'Paste', 'Select all']);
  for (const l of ['Cut', 'Copy', 'Paste']) assert.equal(item(items, l).enabled, true, `${l} should be enabled`);
});

// The case that made this worth building: pasting a path into a field. Nothing is selected, so Cut
// and Copy would do nothing -- but Paste is the whole point and must be live.
test('an empty text field still offers Paste, and nothing that would no-op', () => {
  const items = editmenu.templateFor({
    isEditable: true, selectionText: '',
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  });
  assert.equal(item(items, 'Paste').enabled, true, 'Paste is the reason this menu exists');
  assert.equal(item(items, 'Cut').enabled, false, 'nothing selected to cut');
  assert.equal(item(items, 'Copy').enabled, false, 'nothing selected to copy');
});

test('a read-only panel offers Copy and Select all, never Cut or Paste', () => {
  const items = editmenu.templateFor({
    isEditable: false, selectionText: 'DLSS GPU 1.53 ms/frame',
    editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
  });
  assert.deepEqual(labels(items), ['Copy', 'Select all']);
  assert.equal(item(items, 'Copy').enabled, true);
});

// Whitespace is not a selection. Chromium reports canCopy true for it, so the flag alone is not
// enough to decide.
test('a selection of pure whitespace does not enable Copy', () => {
  const items = editmenu.templateFor({
    isEditable: false, selectionText: '   \n ',
    editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
  });
  assert.equal(item(items, 'Copy').enabled, false);
});

test('a link offers its address, which is copyable with nothing selected', () => {
  const items = editmenu.templateFor({
    isEditable: false, selectionText: '', linkURL: 'https://github.com/example/repo/issues/42',
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
  });
  const link = item(items, 'Copy link address');
  assert.ok(link, 'no link item');
  assert.equal(link.copyText, 'https://github.com/example/repo/issues/42');
  assert.equal(item(items, 'Copy').enabled, false, 'the selection Copy is still dead');
});

test('the labels go through the translator', () => {
  const items = editmenu.templateFor(EDITABLE, (s) => `<${s}>`);
  assert.deepEqual(labels(items), ['<Cut>', '<Copy>', '<Paste>', '<Select all>']);
});

// attach must survive anything: it runs at window construction, and a menu that throws there would
// take the window with it.
test('attach wires one listener, and a menu that throws never escapes', () => {
  const listeners = [];
  const webContents = { on: (name, fn) => listeners.push([name, fn]) };
  const throwing = { buildFromTemplate: () => { throw new Error('no menu today'); } };
  assert.equal(editmenu.attach(webContents, { Menu: throwing }), true);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'context-menu');
  assert.doesNotThrow(() => listeners[0][1]({}, EDITABLE));
});

test('attach declines what it cannot wire, rather than throwing', () => {
  assert.equal(editmenu.attach(null, { Menu: {} }), false);
  assert.equal(editmenu.attach({ on: () => {} }, {}), false, 'no Menu, no menu');
});

test('the link item puts the address on the clipboard', () => {
  const listeners = [];
  const webContents = { on: (name, fn) => listeners.push([name, fn]) };
  let built = null;
  const Menu = { buildFromTemplate: (tpl) => { built = tpl; return { popup: () => {} }; } };
  const written = [];
  editmenu.attach(webContents, { Menu, clipboard: { writeText: (t) => written.push(t) } });
  listeners[0][1]({}, { isEditable: false, linkURL: 'https://example.invalid/x', editFlags: {} });
  const link = built.find((i) => i.label === 'Copy link address');
  assert.ok(link && typeof link.click === 'function', 'the link item lost its click handler');
  link.click();
  assert.deepEqual(written, ['https://example.invalid/x']);
});
