// The art of last resort: a game's own icon, read out of its exe. Every game the Steam store
// cannot name would otherwise be a grey box with two letters in it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write } = require('./helpers');
const exeicon = require(path.join(REPO, 'src', 'exeicon'));
const onWindows = process.platform === 'win32';
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

// A .ico is: reserved 0, type 1, one image, then a 16-byte directory entry, then the image.
function readIco(buf) {
  assert.ok(buf && buf.length > 22, 'no icon bytes at all');
  assert.equal(buf.readUInt16LE(0), 0, 'reserved word must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'type 1 = icon');
  assert.equal(buf.readUInt16LE(4), 1, 'exactly one image is written');
  const bytesInRes = buf.readUInt32LE(14);
  const offset = buf.readUInt32LE(18);
  assert.equal(offset, 22, 'the image starts straight after the single directory entry');
  assert.equal(offset + bytesInRes, buf.length, 'the declared length is the rest of the file');
  return { width: buf.readUInt8(6) || 256, height: buf.readUInt8(7) || 256, bitCount: buf.readUInt16LE(12), image: buf.subarray(offset) };
}

test('an executable yields its own icon as a valid .ico', { skip: !onWindows }, () => {
  const ico = readIco(exeicon.iconBytes(path.join(system32, 'notepad.exe')));
  assert.equal(ico.width, 256, 'the largest image in the group is the one taken');
  assert.equal(ico.height, 256);
  // Modern Windows icons are PNG-compressed inside the .ico, which Chromium renders as-is.
  assert.ok(ico.image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || ico.image.readUInt32LE(0) >= 40,
    'the payload is either a PNG or a DIB header');
});

test('an executable with icon images but no icon group still yields one', { skip: !onWindows }, () => {
  // cmd.exe carries RT_ICON images with no RT_GROUP_ICON to describe them. Without the fallback
  // that reads each image's own header, it would have no art.
  const ico = readIco(exeicon.iconBytes(path.join(system32, 'cmd.exe')));
  assert.ok(ico.width >= 16 && ico.width <= 256, `unexpected width ${ico.width}`);
});

test('anything that is not a PE simply has no icon, and never throws', () => {
  const dir = scratchDir('exeicon');
  assert.equal(exeicon.iconBytes(write(dir, 'notes.txt', 'plain text')), null);
  assert.equal(exeicon.iconBytes(write(dir, 'stub.exe', 'MZ but not really')), null);
  assert.equal(exeicon.iconBytes(path.join(dir, 'missing.exe')), null);
  assert.equal(exeicon.iconBytes(null), null);
});

test('imageInfo reads a size out of both icon payload formats', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png, 0);
  png.writeUInt32BE(128, 16);
  png.writeUInt32BE(128, 20);
  assert.deepEqual(exeicon.imageInfo(png), { width: 128, height: 128, planes: 1, bitCount: 32, colorCount: 0 });

  // A DIB's height counts the colour rows and the AND mask together, so it is twice the icon's.
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(48, 4);
  dib.writeInt32LE(96, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(8, 14);
  assert.deepEqual(exeicon.imageInfo(dib), { width: 48, height: 48, planes: 1, bitCount: 8, colorCount: 0 });

  assert.equal(exeicon.imageInfo(Buffer.alloc(4)), null, 'too short to say anything');
  assert.equal(exeicon.imageInfo(Buffer.alloc(64)), null, 'a zeroed buffer is not a header');
});

test('the cached icon is keyed on the exe, and a patched exe gets a fresh one', { skip: !onWindows }, () => {
  const dir = scratchDir('exeicon-cache');
  const cache = path.join(dir, 'banners');
  const exe = path.join(dir, 'Game.exe');
  fs.copyFileSync(path.join(system32, 'notepad.exe'), exe);

  const first = exeicon.cacheIcon(exe, cache);
  assert.ok(first && fs.existsSync(first), 'an icon file was written');
  assert.equal(exeicon.cacheIcon(exe, cache), first, 'asked again, the same file is reused');

  // A game patched on disk is a different file, so it must not keep serving the old icon.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(exe, later, later);
  const second = exeicon.cacheIcon(exe, cache);
  assert.ok(second && second !== first, 'a changed exe is cached under a new name');

  assert.equal(exeicon.cacheIcon(path.join(dir, 'nope.exe'), cache), null);
});
