// A reader for the one archive format this app cannot already open. zip.js covers every other
// download (dgVoodoo2, ReShade, the Feeder, the shader packs); DXVK publishes only
// `dxvk-<version>.tar.gz`, so its release needs gzip plus tar.
//
// Deliberately small. It reads a tar into memory and hands back the regular files, because that is
// all a DXVK release is: `dxvk-3.1.1/x32/` and `dxvk-3.1.1/x64/`, five DLLs each, no symlinks, no
// long names, nothing over a few megabytes. It is not a general tar implementation and should not
// grow into one -- anything more elaborate is a sign the wrong archive is being opened.
//
// Integrity is not this module's job. The caller checks the SHA-256 of the whole .tar.gz against a
// pinned value before a byte of it is unpacked (translation.js ensureDxvk), which is stronger than
// the per-header checksums tar carries.

'use strict';

const zlib = require('node:zlib');

const BLOCK = 512;
// Regular files. '0' is POSIX, '\0' is the pre-POSIX spelling some writers still emit, and '7' is
// a contiguous file, which is read the same way.
const FILE_TYPES = new Set(['0', '\0', '7']);

function cstr(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('latin1');
}

// Tar sizes are octal, space- or NUL-padded. A malformed field reads as zero rather than NaN, which
// keeps the walk moving to the next header instead of running off the end of the buffer.
function octal(buf, start, length) {
  const text = cstr(buf, start, length).trim();
  if (!text) return 0;
  const n = parseInt(text, 8);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Every regular file in the archive, as { name, size, data }. `data` is a view onto the same buffer
// rather than a copy, so the caller should write it out or copy it before the buffer goes away.
function readTar(buf) {
  const files = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    // Two zero blocks end the archive; one is enough to stop on.
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) if (header[i] !== 0) { allZero = false; break; }
    if (allZero) break;

    const name = cstr(header, 0, 100);
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]);
    // ustar splits a long path across a 155-byte prefix and the 100-byte name.
    const prefix = cstr(header, 345, 155);
    off += BLOCK;

    if (FILE_TYPES.has(type) && name) {
      files.push({ name: prefix ? `${prefix}/${name}` : name, size, data: buf.subarray(off, off + size) });
    }
    // Directories, symlinks, GNU long-name records and anything else are skipped, contents and all.
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

function readTarGz(buf) {
  return readTar(zlib.gunzipSync(buf));
}

// The entry whose path ends in `rel` (forward slashes), ignoring the archive's top-level folder --
// a DXVK release wraps everything in `dxvk-<version>/`, and the version is in the name.
function findTarEntry(files, rel) {
  const want = `/${rel.toLowerCase()}`;
  return files.find((f) => {
    const p = f.name.replace(/\\/g, '/').toLowerCase();
    return p === rel.toLowerCase() || p.endsWith(want);
  }) || null;
}

module.exports = { readTar, readTarGz, findTarEntry };
