// Fetches (or reuses a cached copy of) ReShade's own setup exe and pulls the raw DLL for the
// requested bitness out of it.
const path = require('path');
const { RESHADE_SETUP_URL } = require('./sources');
const { downloadToCache } = require('./download');
const { openZip, findEntry, extractEntryTo } = require('./zip');

async function extractReShadeDll({ cacheDir, bits, destPath }) {
  const setupPath = await downloadToCache(RESHADE_SETUP_URL, cacheDir, path.basename(RESHADE_SETUP_URL));

  const zip = openZip(setupPath);
  const entry = findEntry(zip, new RegExp(`^ReShade${bits}\\.dll$`, 'i'));
  if (!entry) throw new Error(`ReShade${bits}.dll not found in the downloaded ReShade setup`);

  extractEntryTo(zip, entry, destPath);
  return destPath;
}

module.exports = { extractReShadeDll };
