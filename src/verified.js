// The verified-games registry (src/verified-games.json): routes confirmed end to end on real
// installs, kept as data so a confirmation is a pull request rather than a code change. The
// route logic stays evidence-based; the registry adds three things on top: the default route
// for games where a specific mod has been proven (Luma UE), routes known to break a game, and
// the "verified" tick and notes the card shows.

const path = require('node:path');
const registry = require('./verified-games.json');

function lookup(exePath) {
  if (!exePath) return null;
  const exe = path.basename(exePath).toLowerCase();
  const parts = path.dirname(exePath).split(/[\\/]/);
  const project = parts.length >= 3 && /^win64$/i.test(parts[parts.length - 1]) && /^binaries$/i.test(parts[parts.length - 2])
    ? parts[parts.length - 3].toLowerCase()
    : null;
  for (const g of registry.games) {
    const m = g.match || {};
    if ((m.exe || []).includes(exe)) return g;
    if (m.projectFolder && project && m.projectFolder.toLowerCase() === project) return g;
  }
  return null;
}

function defaultRoute(exePath) {
  const g = lookup(exePath);
  return g ? g.route : null;
}

function knownBad(exePath, route) {
  const g = lookup(exePath);
  return g && g.knownBad && g.knownBad[route] ? g.knownBad[route] : null;
}

// What the card shows: only a dated confirmation earns the tick.
function verification(exePath) {
  const g = lookup(exePath);
  if (!g || !g.verified) return null;
  return { id: g.id, name: g.name, route: g.route, verified: g.verified, notes: g.notes || '' };
}

module.exports = { lookup, defaultRoute, knownBad, verification, registry };
