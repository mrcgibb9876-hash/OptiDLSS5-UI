// The game's own icon, out of its executable -- the art of last resort.
//
// A card with no art is a grey box with two letters in it, and that is what every game the Steam
// store cannot name ends up as: anything bought on Epic, GOG or Game Pass, anything renamed, and
// anything whose folder name matches nothing (reported 2026-09-14). The store search got better in
// the same change, but "better" is not "always", and the honest answer to a name nobody recognises
// is not a blank card -- every Windows game carries its own icon a few hundred bytes into its exe,
// and that icon is always the right game.
//
// Windows stores an icon as a group (RT_GROUP_ICON) naming the sizes it has, plus one RT_ICON per
// size. A .ico file is nearly the same thing with different offsets, so this reads the group,
// picks the largest image, and rebuilds the six-byte header and one directory entry a .ico needs
// around it. Chromium renders the result directly -- no image library, no conversion, no network.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openPeResources, RT_ICON, RT_GROUP_ICON } = require('./detect');

// GRPICONDIR: reserved, type, count, then count GRPICONDIRENTRYs of 14 bytes.
const GROUP_HEADER = 6;
const GROUP_ENTRY = 14;
// ICONDIRENTRY on disk is 16: the same 12 leading bytes, then a 4-byte offset in place of the
// 2-byte resource id.
const FILE_ENTRY = 16;
// Big enough for a 256x256 32-bit image (256KB) with room to spare; a guard, not a target.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function groupEntries(blob) {
  if (!blob || blob.length < GROUP_HEADER) return [];
  const count = blob.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = GROUP_HEADER + i * GROUP_ENTRY;
    if (at + GROUP_ENTRY > blob.length) break;
    out.push({
      // 0 means 256 in both the group and the file format.
      width: blob.readUInt8(at) || 256,
      height: blob.readUInt8(at + 1) || 256,
      colorCount: blob.readUInt8(at + 2),
      planes: blob.readUInt16LE(4 + at),
      bitCount: blob.readUInt16LE(6 + at),
      bytesInRes: blob.readUInt32LE(8 + at),
      id: blob.readUInt16LE(12 + at),
    });
  }
  return out;
}

// Largest first, and for one size the deepest colour -- a 256-colour 32x32 and a 32-bit 32x32
// both exist in plenty of older games' icons.
const bestFirst = (a, b) => (b.width * b.height) - (a.width * a.height) || (b.bitCount - a.bitCount);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// What an icon image says about itself, for the exes that ship RT_ICON images with no group to
// describe them (cmd.exe is one, and so are games whose icons come through an MUI resource).
// A modern icon is a PNG; an older one is a BITMAPINFOHEADER DIB whose height counts the colour
// rows and the AND mask together, hence the halving.
function imageInfo(image) {
  if (!image || image.length < 24) return null;
  if (image.subarray(0, 4).equals(PNG_SIGNATURE)) {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20), planes: 1, bitCount: 32, colorCount: 0 };
  }
  const headerSize = image.readUInt32LE(0);
  if (headerSize < 40 || headerSize > image.length) return null;
  const width = image.readInt32LE(4);
  const height = Math.abs(image.readInt32LE(8)) / 2;
  if (width <= 0 || height <= 0 || width > 1024 || height > 1024) return null;
  return { width, height, planes: image.readUInt16LE(12), bitCount: image.readUInt16LE(14), colorCount: 0 };
}

function buildIco(entry, image) {
  const header = Buffer.alloc(GROUP_HEADER + FILE_ENTRY);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(1, 4);            // one image in the file
  header.writeUInt8(entry.width >= 256 ? 0 : entry.width, 6);
  header.writeUInt8(entry.height >= 256 ? 0 : entry.height, 7);
  header.writeUInt8(entry.colorCount || 0, 8);
  header.writeUInt8(0, 9);               // reserved
  header.writeUInt16LE(entry.planes || 1, 10);
  header.writeUInt16LE(entry.bitCount || 32, 12);
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(GROUP_HEADER + FILE_ENTRY, 18);
  return Buffer.concat([header, image]);
}

// The icon of `exePath` as .ico bytes, or null when the file carries none (a packed exe, a
// launcher stub, anything that is not really a PE).
function iconBytes(exePath) {
  const res = openPeResources(exePath);
  if (!res) return null;
  try {
    // The ordinary path: a group names its sizes, and the biggest of them is the one worth showing.
    for (const groupId of res.ids(RT_GROUP_ICON)) {
      const entries = groupEntries(res.get(RT_GROUP_ICON, groupId)).sort(bestFirst);
      for (const entry of entries) {
        const image = res.get(RT_ICON, entry.id, MAX_IMAGE_BYTES);
        if (image && image.length) return buildIco(entry, image);
      }
    }
    // No group, but images all the same: read each one's own header and take the largest. Without
    // this an exe whose icons arrive through an MUI resource has no art at all, which is the case
    // this whole file exists to avoid.
    const loose = [];
    for (const id of res.ids(RT_ICON)) {
      const image = res.get(RT_ICON, id, MAX_IMAGE_BYTES);
      const info = image && image.length ? imageInfo(image) : null;
      if (info) loose.push({ ...info, image });
    }
    loose.sort(bestFirst);
    return loose.length ? buildIco(loose[0], loose[0].image) : null;
  } catch {
    return null;
  } finally {
    res.close();
  }
}

// Writes the icon into the banner cache and returns its path, or null. The name is derived from
// the exe path so a game keeps the same file across launches, and the exe's size and mtime are in
// it so a patched game gets its new icon rather than the cached old one.
function cacheIcon(exePath, cacheDir) {
  let stamp = '';
  try { const st = fs.statSync(exePath); stamp = `${st.size}-${Math.round(st.mtimeMs)}`; } catch { return null; }
  const key = Buffer.from(path.resolve(exePath).toLowerCase(), 'utf8').toString('base64url').slice(-40);
  const dest = path.join(cacheDir, `exeicon-${key}-${stamp}.ico`);
  if (fs.existsSync(dest)) return dest;
  const bytes = iconBytes(exePath);
  if (!bytes) return null;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(dest, bytes);
    return dest;
  } catch {
    return null;
  }
}

module.exports = { iconBytes, cacheIcon, groupEntries, imageInfo };
