'use strict';
// Minimal ZIP central-directory reader/extractor. No dependency needed for this: the only
// tricky case is ReShade's setup exe, a zip appended after an NSIS stub (and sometimes an
// authenticode signature after that) -- a standard reader that insists the End Of Central
// Directory record is the very last thing in the file (yauzl/extract-zip both do) throws
// "invalid comment length" on it. Scanning backward for the EOCD signature itself, then
// deriving a base offset from where it actually landed, handles both a plain zip (base 0)
// and this self-extracting case with the same code path -- verified against a real
// ReShade_Setup_*_Addon.exe before this was relied on for anything.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf) {
  const minLen = 22;
  for (let i = buf.length - minLen; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

// Accepts a Buffer or a file path.
function openZip(bufOrPath) {
  const buf = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath);
  const eocdOff = findEocd(buf);
  if (eocdOff < 0) throw new Error('no End Of Central Directory record found -- not a zip');

  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdCount = buf.readUInt16LE(eocdOff + 10);
  const cdOffsetField = buf.readUInt32LE(eocdOff + 16);
  // See file header comment: this correction is what makes a self-extracting exe readable.
  const base = eocdOff - cdSize - cdOffsetField;
  const cdOffset = cdOffsetField + base;

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('bad central directory entry at ' + p);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42) + base;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

// Pattern is matched against the entry's name with backslashes normalised to forward slashes,
// same as the entries a real zip tool reports.
function findEntry(zip, pattern) {
  return zip.entries.find((e) => pattern.test(e.name.replace(/\\/g, '/')));
}

function findEntries(zip, pattern) {
  return zip.entries.filter((e) => pattern.test(e.name.replace(/\\/g, '/')));
}

function extractEntry(zip, entry) {
  const { buf } = zip;
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== LOCAL_SIG) throw new Error('bad local file header at ' + p);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error('unsupported compression method ' + entry.method + ' for ' + entry.name);
}

function extractEntryTo(zip, entry, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, extractEntry(zip, entry));
}

module.exports = { openZip, findEntry, findEntries, extractEntry, extractEntryTo };
