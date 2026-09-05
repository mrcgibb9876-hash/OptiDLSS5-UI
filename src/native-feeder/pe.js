'use strict';
// Minimal PE reader: import table + version resource. Lifted verbatim from DLSS5-Swapper
// (MIT, see LICENSE-DLSS5-Swapper.txt) -- same file already credited there for library.js.
// Used here to tell which render API a game actually links against, real import-table parsing
// rather than a substring search, matching what ReShade's own installer does.
const fs = require('fs');

function readAt(fd, size, pos) {
  const buf = Buffer.alloc(size);
  const n = fs.readSync(fd, buf, 0, size, pos);
  return n === size ? buf : buf.subarray(0, n);
}

// Parses just enough of the headers to map RVAs onto file offsets.
function readHeaders(fd) {
  const dos = readAt(fd, 0x40, 0);
  if (dos.length < 0x40 || dos.readUInt16LE(0) !== 0x5a4d) return null;
  const peOff = dos.readUInt32LE(0x3c);
  const coff = readAt(fd, 24, peOff);
  if (coff.length < 24 || coff.readUInt32LE(0) !== 0x00004550) return null;

  const numSections = coff.readUInt16LE(6);
  const optSize = coff.readUInt16LE(20);
  const optOff = peOff + 24;
  const opt = readAt(fd, optSize, optOff);
  if (opt.length < 2) return null;
  const magic = opt.readUInt16LE(0);
  const is64 = magic === 0x20b;
  const ddOff = is64 ? 112 : 96;

  const dirs = [];
  for (let i = 0; i < 16; i++) {
    const o = ddOff + i * 8;
    if (o + 8 > opt.length) break;
    dirs.push({ rva: opt.readUInt32LE(o), size: opt.readUInt32LE(o + 4) });
  }

  const secTable = readAt(fd, numSections * 40, optOff + optSize);
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const o = i * 40;
    if (o + 40 > secTable.length) break;
    sections.push({
      virtualSize: secTable.readUInt32LE(o + 8),
      virtualAddress: secTable.readUInt32LE(o + 12),
      rawSize: secTable.readUInt32LE(o + 16),
      rawOffset: secTable.readUInt32LE(o + 20)
    });
  }
  return { is64, dirs, sections };
}

function rvaToOffset(h, rva) {
  for (const s of h.sections) {
    const span = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      return s.rawOffset + (rva - s.virtualAddress);
    }
  }
  return null;
}

function readCString(fd, pos) {
  const buf = readAt(fd, 256, pos);
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('latin1');
}

function readNameTable(fd, h, dirIndex, stride, nameFieldOffset) {
  const dir = h.dirs[dirIndex];
  if (!dir || !dir.rva) return [];
  const off = rvaToOffset(h, dir.rva);
  if (off === null) return [];
  const table = readAt(fd, Math.min(dir.size || 4096, 64 * 1024), off);
  const names = [];
  for (let o = 0; o + stride <= table.length; o += stride) {
    const nameRva = table.readUInt32LE(o + nameFieldOffset);
    if (nameRva === 0) break;
    const nameOff = rvaToOffset(h, nameRva);
    if (nameOff !== null) names.push(readCString(fd, nameOff).toLowerCase());
  }
  return names;
}

// Names of the DLLs the executable links against, lower-cased. Delay-loaded
// imports count too -- plenty of games bind d3d12 that way.
function getImports(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = readHeaders(fd);
    if (!h) return [];
    const normal = readNameTable(fd, h, 1, 20, 12);
    const delayed = readNameTable(fd, h, 13, 32, 4);
    return [...new Set([...normal, ...delayed])];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Returns the executable architecture without loading or executing it. The
// optional-header magic is authoritative: PE32 is 32-bit and PE32+ is 64-bit.
function getBitness(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = readHeaders(fd);
    return h ? (h.is64 ? 64 : 32) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Which of the given ASCII markers appear anywhere in the file. A game that
// loads Direct3D with LoadLibrary has no import entry for it, but the DLL name
// and the entry point it asks for are still sitting there as plain strings.
function findMarkers(file, markers) {
  const needles = markers.map((m) => ({ text: m, buf: Buffer.from(m, 'latin1') }));
  const longest = Math.max(...needles.map((n) => n.buf.length));
  const found = new Set();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const chunkSize = 4 * 1024 * 1024;
    const overlap = longest;
    const buf = Buffer.alloc(chunkSize + overlap);
    let pos = 0;
    let carry = 0;
    while (pos < size) {
      const read = fs.readSync(fd, buf, carry, chunkSize, pos);
      if (read <= 0) break;
      const view = buf.subarray(0, carry + read);
      for (const n of needles) {
        if (!found.has(n.text) && view.includes(n.buf)) found.add(n.text);
      }
      if (found.size === needles.length) break;
      carry = Math.min(overlap, view.length);
      view.subarray(view.length - carry).copy(buf, 0);
      pos += read;
    }
  } catch {
    /* unreadable file: report nothing rather than guessing */
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return found;
}

module.exports = { getImports, getBitness, findMarkers };
