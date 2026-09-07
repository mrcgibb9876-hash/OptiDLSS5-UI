'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Return true when the given archive/file exists and matches the provided sha256 (if given).
function cached(filePath, sha256) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (!sha256) return true;
  try {
    const buf = fs.readFileSync(filePath);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    return h === sha256;
  } catch {
    return false;
  }
}

// Fetch a URL to destPath and verify sha256 when provided. Overwrites destPath when done.
async function fetchVerified(url, sha256, destPath) {
  if (!url || !destPath) throw new Error('invalid args');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== sha256) throw new Error('download checksum mismatch');
  }
  // ensure dest dir
  const ddir = path.dirname(destPath);
  fs.mkdirSync(ddir, { recursive: true });
  fs.writeFileSync(destPath, buf);
}

module.exports = { cached, fetchVerified };