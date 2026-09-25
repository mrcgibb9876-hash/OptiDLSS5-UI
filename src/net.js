// Every download in this app goes through Chromium's network stack, not Node's.
//
// Node's fetch (undici) ignores the Windows system proxy completely: nothing configures a
// ProxyAgent, and nothing reads HTTPS_PROXY. So a user behind a VPN or a DPI-bypass tool that works
// as a PROXY -- rather than as a virtual network adapter -- gets no benefit from it here at all,
// while their browser sails through the same connection. A Fallout: New Vegas user lost a day to
// exactly that on 2026-09-22: "fetch failed" with a VPN on AND a bypass running, because neither
// applied to us. Nothing in the app could have told them, either.
//
// Electron's net.fetch runs on Chromium's stack, which reads the system proxy settings (including
// PAC and WPAD) and the OS certificate store, the same as the browser. It is the same fetch API, so
// it drops into every call site unchanged.
//
// Outside Electron -- the test suite -- there is no net module and the global fetch is used, which
// is also why every downloader here still takes a fetchImpl it can be handed in a test.
'use strict';

// Resolved on FIRST USE, never at module load. Requiring 'electron' up here breaks the test
// suite outright: Node caches a resolution per (parent, request), so once this module has resolved
// 'electron' through the real resolver, the Module._resolveFilename override test/helpers.js
// installs to swap in its stub is skipped, main.js gets the real electron package (which exports a
// path STRING, not an object), and every ipcMain handler registration throws. Seven tests went red
// on exactly that. Lazily, none of it happens: by the time anything downloads, the stub is in place.
let resolved = false;
let electronNet = null;

function chromiumNet() {
  if (!resolved) {
    resolved = true;
    // Ask whether we are inside Electron rather than whether the package resolves. Outside it, the
    // 'electron' package is still on disk as a devDependency and require()ing it BOTH returns a
    // useless path string AND poisons Node's per-(parent, request) resolution cache, which is what
    // makes test/helpers.js's electron stub stop working. Making the require lazy was not enough --
    // the first download in a test file triggered it and broke every loadMain after.
    if (!process.versions || !process.versions.electron) return null;
    try {
      const electron = require('electron');
      // The real package exports the path to the binary as a string when it is required outside
      // Electron itself, so this has to be an object before anything is read off it.
      if (electron && typeof electron === 'object') electronNet = electron.net || null;
    } catch {}
  }
  return electronNet && typeof electronNet.fetch === 'function' ? electronNet : null;
}

function chromiumAvailable() {
  return !!chromiumNet();
}

// The reason a fallback exists at all: Chromium refuses a handful of things Node allows, and a
// system proxy that is misconfigured fails there while a direct connection still works. Trading one
// kind of failed download for another would be no gain, so Node's fetch gets the second go -- and
// if both fail the user is told both reasons rather than only the last one.
// Split out so the two-sided failure can be tested without an Electron to inject: `chromium` is
// whatever provides the proxy-aware fetch, `direct` is Node's.
async function fetchThrough(chromium, direct, url, init) {
  if (!chromium) return direct(url, init);
  let chromiumError;
  try {
    return await chromium(url, init);
  } catch (e) {
    chromiumError = e;
  }
  try {
    return await direct(url, init);
  } catch (nodeError) {
    const why = (e) => (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);
    const err = new Error(`${why(chromiumError)} (and without the system proxy: ${why(nodeError)})`);
    err.cause = chromiumError.cause || chromiumError;
    throw err;
  }
}

function rawFetch(url, init) {
  const chromium = chromiumNet();
  return fetchThrough(chromium ? (u, i) => chromium.fetch(u, i) : null, fetch, url, init);
}

// GitHub API reads are remembered and share one budget (ghapi.js); everything else goes straight out.
function netFetch(url, init) {
  const ghapi = require('./ghapi');
  if (ghapi.handles(url, init)) return ghapi.githubGet(rawFetch, url, init);
  return rawFetch(url, init);
}

module.exports = { netFetch, chromiumAvailable, fetchThrough };
