// Which games Luma-Framework (github.com/Filoppi/Luma-Framework) has a DLSS-adding mod for -- read from
// the project itself, so a mod published tomorrow is picked up without a release of this app.
//
// The user's rule (2026-09-15): per-game Luma installs are based on the GitHub Luma-Framework, not Nexus.
// Why only DLSS-adding mods matter here: OptiScaler's Neural Rendering hooks a DLSS call. A Luma mod built
// with DLSS (its project sets UseLumaNGX, which defines ENABLE_NGX) makes that call from the game's own
// render pipeline, with the engine's real motion vectors and depth -- far better than the DLSS5 Feeder's
// estimate, and the fix for games whose own DLSS is too old for Neural Rendering (Monster Hunter: World
// ships DLSS 1.1.13). An HDR-only Luma mod (Sekiro, NieR:Automata) gives OptiScaler nothing.
//
// How it is read, without downloading a single mod:
//   1. The rolling release (latest-<n>) lists one zip per game: Luma-<Game_Name>.zip, plus -Test/-Dev
//      builds and -x32 variants. Generic mods (Unreal_Engine, Unity_Engine, Generic_Mod,
//      Graphics_Analyzer) are not per-game and are left to their own logic (lumaue.js).
//   2. Each zip's central directory is fetched with an HTTP Range request (the last 128 KB): Luma's CI
//      copies nvngx_dlss.dll into a mod's package only when the mod is built with NGX, so that file being
//      at the zip root IS the answer. The root .addon's name is recorded for deploy and Remove. Measured:
//      ~0.7 s per zip against GitHub (Sekiro: no nvngx_dlss.dll; Monster Hunter World: yes).
//   3. The wiki's mods table (Home.md) supplies each mod's status: ✅ working, 🚧 work in progress.
//
// Results are cached in userData by asset name and re-probed after a week or when the asset changes size;
// src/luma-catalog.json is the snapshot this app ships with, for a first run with no network.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const RELEASES_API = 'https://api.github.com/repos/Filoppi/Luma-Framework/releases/latest';
const WIKI_HOME_RAW = 'https://raw.githubusercontent.com/wiki/Filoppi/Luma-Framework/Home.md';
const GENERIC_MODS = new Set(['unreal_engine', 'unity_engine', 'generic_mod', 'graphics_analyzer']);
const REPROBE_MS = 7 * 24 * 60 * 60 * 1000;
const BUNDLED = path.join(__dirname, 'luma-catalog.json');

// ---- names -------------------------------------------------------------------------------------

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16 };

// "Call of Duty®: Black Ops III" -> ['call','of','duty','black','ops','3']. Roman numerals become digits
// so III matches the asset's 3; trademark marks and punctuation are separators.
function nameTokens(name) {
  return String(name || '')
    .replace(/[™®©]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // GreedFall stays one word below, ReFantazio too: only camel humps split
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (ROMAN[t] !== undefined ? String(ROMAN[t]) : t));
}

// Luma-Deus_Ex_Human_Revolution_Director.s_Cut-x32.zip -> { key: 'Deus_Ex_Human_Revolution_Director.s_Cut', x32: true }.
// In asset names '_' is a space and '.' stands for a character GitHub dropped (an apostrophe, a bracket).
function parseAssetName(name) {
  const m = /^Luma-(.+?)(-Test|-Dev)?(-x32)?\.zip$/i.exec(String(name || ''));
  if (!m || m[2]) return null;
  const key = m[1];
  if (GENERIC_MODS.has(key.toLowerCase())) return null;
  return { key, x32: !!m[3], title: key.replace(/_/g, ' ').replace(/\./g, '') };
}

const joined = (tokens) => tokens.join('');

// Does a game named `gameName` match a mod keyed `modKey`? Every token of the mod's name, in order, at the
// start of the game's name -- compared both as words and run together, so "Greed Fall" and "GreedFall"
// agree. A sequel is refused: when the game's name continues with a number right after the mod's words
// ("Nioh 2" against Luma's "Nioh", "Kingdom Come Deliverance II"), it is a different game.
function nameMatches(gameName, modKey) {
  const game = nameTokens(gameName);
  const mod = nameTokens(String(modKey).replace(/_/g, ' ').replace(/\./g, ' '));
  if (!game.length || !mod.length) return false;
  let consumed = -1;
  if (mod.every((t, i) => game[i] === t)) consumed = mod.length;
  else {
    // Run-together comparison: grow a prefix of the game's tokens until its letters equal the mod's.
    const target = joined(mod);
    let acc = '';
    for (let i = 0; i < game.length && acc.length < target.length; i++) {
      acc += game[i];
      if (acc === target) { consumed = i + 1; break; }
    }
  }
  if (consumed < 0) return false;
  const next = game[consumed];
  return !(next && /^\d+$/.test(next));
}

// ---- remote zip listing ------------------------------------------------------------------------

// The root entry names of a remote zip, from its central directory alone.
async function listRemoteZip(url, { fetchImpl = fetch, headers = {}, size = null } = {}) {
  let total = size;
  if (!total) {
    const head = await fetchImpl(url, { method: 'HEAD', headers, redirect: 'follow' });
    total = Number(head.headers.get('content-length'));
  }
  if (!total) throw new Error('unknown size');
  const tailLen = Math.min(total, 128 * 1024);
  const res = await fetchImpl(url, { headers: { ...headers, Range: `bytes=${total - tailLen}-${total - 1}` }, redirect: 'follow' });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (res.status === 200) buf = buf.subarray(Math.max(0, buf.length - tailLen));
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end-of-central-directory record in the tail');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const count = buf.readUInt16LE(eocd + 10);
  let p = eocd - cdSize;
  if (p < 0) throw new Error('central directory larger than the fetched tail');
  const names = [];
  for (let n = 0; n < count && p + 46 <= eocd; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/'));
    p += 46 + nameLen + extra + comment;
  }
  return names;
}

// ---- wiki status -------------------------------------------------------------------------------

// Home.md's tables: "| Prey | Pumbo | ...download... | ✅➕ | ...". Name -> 'working' | 'wip' | 'planned'.
function parseWikiStatuses(markdown) {
  const out = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const name = cells[1];
    if (!name || /^-+$/.test(name) || name === 'Name') continue;
    const status = cells.find((c) => /✅|🚧|💡/.test(c)) || '';
    const s = status.includes('✅') ? 'working' : status.includes('🚧') ? 'wip' : status.includes('💡') ? 'planned' : null;
    if (s) out.push({ name, status: s });
  }
  return out;
}

function wikiStatusFor(statuses, modKey) {
  const hit = (statuses || []).find((s) => nameMatches(s.name, modKey) || nameMatches(String(modKey).replace(/_/g, ' '), s.name));
  return hit ? hit.status : null;
}

// ---- catalog -----------------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

let current = null;

// The catalog in memory: the userData cache when there is one, else the bundled snapshot.
function load(cachePath) {
  current = (cachePath && readJson(cachePath)) || readJson(BUNDLED) || { tag: null, mods: [] };
  return current;
}

function get() {
  return current || load(null);
}

// Reads the release and the wiki, probes every per-game zip it has not probed recently, writes the cache.
async function refresh({ cachePath, fetchImpl = fetch, headers = {}, concurrency = 6, now = Date.now() } = {}) {
  const prev = (cachePath && readJson(cachePath)) || readJson(BUNDLED) || { mods: [] };
  const byAsset = new Map((prev.mods || []).map((m) => [m.asset, m]));
  const relRes = await fetchImpl(RELEASES_API, { headers });
  if (!relRes.ok) throw new Error(`Luma-Framework release: HTTP ${relRes.status}`);
  const release = await relRes.json();
  let statuses = [];
  try {
    const w = await fetchImpl(WIKI_HOME_RAW, { headers });
    if (w.ok) statuses = parseWikiStatuses(await w.text());
  } catch {}

  const candidates = (release.assets || []).map((a) => ({ a, parsed: parseAssetName(a.name) })).filter((c) => c.parsed);
  const mods = [];
  let i = 0;
  const worker = async () => {
    while (i < candidates.length) {
      const { a, parsed } = candidates[i++];
      const cached = byAsset.get(a.name);
      const fresh = cached && cached.size === a.size && now - (cached.probedAt || 0) < REPROBE_MS;
      let entry = fresh ? { ...cached } : null;
      if (!entry) {
        try {
          const names = await listRemoteZip(a.browser_download_url, { fetchImpl, headers, size: a.size });
          const root = names.filter((n) => !n.includes('/'));
          entry = {
            asset: a.name, key: parsed.key, title: parsed.title, x32: parsed.x32, size: a.size,
            addon: root.find((n) => /^Luma-.+\.addon(32|64)?$/i.test(n)) || null,
            dlss: root.some((n) => n.toLowerCase() === 'nvngx_dlss.dll'),
            probedAt: now,
          };
        } catch {
          if (cached) entry = { ...cached };
          else continue;
        }
      }
      entry.status = wikiStatusFor(statuses, parsed.key) || entry.status || null;
      mods.push(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  mods.sort((x, y) => x.asset.localeCompare(y.asset));
  const catalog = { tag: release.tag_name || null, fetchedAt: new Date(now).toISOString(), mods };
  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(catalog, null, 2), 'utf8');
  }
  current = catalog;
  return catalog;
}

// The DLSS-adding Luma mod for a game, or null. `names`: every name the game goes by (its card name, its
// Steam manifest name, its folder). A 32-bit game can never run one (DLSS is 64-bit only), and a mod
// packaged only as -x32 never carries DLSS.
function matchGame(names, { bitness = 64, catalog = get() } = {}) {
  if (bitness === 32) return null;
  const list = (catalog && catalog.mods) || [];
  for (const name of (names || []).filter(Boolean)) {
    const hit = list.find((m) => m.dlss && !m.x32 && m.addon && nameMatches(name, m.key));
    if (hit) return hit;
  }
  return null;
}

module.exports = {
  RELEASES_API, WIKI_HOME_RAW, BUNDLED,
  nameTokens, nameMatches, parseAssetName, listRemoteZip, parseWikiStatuses, wikiStatusFor,
  load, get, refresh, matchGame,
};
