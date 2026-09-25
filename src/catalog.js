'use strict';
// The known-good catalog: per game, the setup that has been PROVEN to run DLSS 5 and the setups that
// are known dead ends, keyed by the exe's lower-case name (optionally narrowed by exe size / version).
//
// Why a catalog on top of the route rules (route.js) and the verified registry (verified.js): the rules
// encode what the app learned as code, one `if` per lesson, and the registry only carries a tick. What
// neither kept was the NEGATIVE evidence per game -- "DXVK makes the camera shake here" (Assassin's Creed
// II, DXVK #2249), "the Feeder crashed the model on its first frame" (Elden Ring, Armored Core VI), "the
// dxgi.dll proxy is never loaded" (Monster Hunter: World, RDR2) -- so each one had to be rediscovered by
// the next person, or turned into another special case in route.js. Here it is data, with its source.
//
// Two layers:
//   shipped  data/known-good.json, bundled with the app, hash-checked (sha256 over its `entries`) so a
//            half-written or hand-edited file is refused rather than trusted; tools/catalog/build.js
//            writes the hash, and the maintainer grows it from issue-body run digests.
//   local    <userData>/known-good.local.json, written by learnFromRun: this machine's own runs. A run
//            that worked records its setup; a run that failed with a verdict that means "this setup
//            cannot work here" (DEAD_END_VERDICTS) records a dead end. Local entries merge OVER shipped
//            ones (mergeEntries): this machine's own evidence is the most specific there is.
//
// Consumers: routescore.js (proven routes are boosted, dead ends penalised), fgsuggest.js (a frame
// generator that is a dead end for this game is not suggested), and the card's badge (badgeFor).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SHIPPED_FILE = path.join(__dirname, '..', 'data', 'known-good.json');

// Verdicts (runlog.js) that say the SETUP cannot work on this game, as opposed to a setting that can
// be fixed (feed-no-motion, opti-not-fork, nr-disabled ...) or a machine problem (driver-outdated).
// Each is the one a real game met on a route that was then abandoned for it:
const DEAD_END_VERDICTS = {
  // Elden Ring / Armored Core VI on the Feeder (2026-09-15), Dolphin on DX12 same-device (2026-09-15).
  'nr-model-crash': 'the neural model crashed in its first evaluate',
  // Code Vein 2 / Mortal Shell II: a Feeder on a game that ships DLSS in its plugin tree (2026-09-11).
  'duplicate-dlss': 'two DLSS DLLs loaded and the game crashed',
  // Castlevania: Lords of Shadow 2 under dgVoodoo2 (2026-09-14).
  'wrapper-crash': 'the game crashed inside its DirectX wrapper as it started',
  // Resident Evil 2 on the retired pd-upscaler route (2026-09-13): a black screen behind a running game.
  'upscale-skipped': 'every upscale was skipped (black screen)',
  // Unreal's crash reporter wrote a report within minutes of the run (Spyro under Luma UE, 2026-09-12).
  'ue-crash': 'the game crashed (Unreal crash report)',
  // The Feeder's Vulkan transport could not open on this device.
  'feed-vulkan-interop': 'the Feeder\'s Vulkan interop could not open',
};

// A run that proves the setup: the neural pass dispatched. A fault only on the way out still counts
// when passes ran (gamehelp.js ok-exit-crash).
function runWorked(run) {
  if (!run || !run.ran) return false;
  if (run.verdict === 'nr-ran') return true;
  return run.verdict === 'shutdown-fault' && (run.nrDispatch || 0) > 0;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// The hash covers the entries exactly as JSON.stringify writes them, so the file's own formatting
// (indentation, the _readme) can change without re-hashing, and any change to an entry cannot.
const entriesHash = (entries) => sha256(JSON.stringify(entries || []));

function verifyCatalog(doc) {
  if (!doc || !Array.isArray(doc.entries)) return { ok: false, reason: 'no entries' };
  if (typeof doc.sha256 !== 'string') return { ok: false, reason: 'no sha256' };
  const actual = entriesHash(doc.entries);
  return actual === doc.sha256 ? { ok: true } : { ok: false, reason: `sha256 mismatch (file ${doc.sha256.slice(0, 12)}, entries ${actual.slice(0, 12)})` };
}

// ── loading ─────────────────────────────────────────────────────────────────────────────────────
// Both files are read once and re-read only when their mtime changes: the card asks for every game on
// every grid render (route.js), and this must stay a Map lookup there.
const state = {
  shippedFile: SHIPPED_FILE,
  localFile: null, // a path, or a function returning one (main.js: under app.getPath('userData'))
  shipped: { key: null, entries: [], error: null },
  local: { key: null, entries: [] },
};

function configure({ shippedFile, localFile } = {}) {
  if (shippedFile !== undefined) { state.shippedFile = shippedFile; state.shipped.key = null; }
  if (localFile !== undefined) { state.localFile = localFile; state.local.key = null; }
}

const localPath = () => (typeof state.localFile === 'function' ? state.localFile() : state.localFile) || null;

function statKey(file) {
  try { const st = fs.statSync(file); return `${file}|${st.size}|${st.mtimeMs}`; } catch { return `${file}|missing`; }
}

function loadShipped() {
  const key = statKey(state.shippedFile);
  if (state.shipped.key === key) return state.shipped;
  let entries = [];
  let error = null;
  try {
    const doc = JSON.parse(fs.readFileSync(state.shippedFile, 'utf8'));
    const v = verifyCatalog(doc);
    if (v.ok) entries = doc.entries;
    else error = v.reason;
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  state.shipped = { key, entries, error };
  return state.shipped;
}

function readLocalDoc(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && Array.isArray(doc.entries) ? doc : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function loadLocal() {
  const file = localPath();
  if (!file) return { entries: [] };
  const key = statKey(file);
  if (state.local.key === key) return state.local;
  state.local = { key, entries: readLocalDoc(file).entries };
  return state.local;
}

// ── matching and merging ────────────────────────────────────────────────────────────────────────
const exeKey = (exePathOrName) => path.basename(String(exePathOrName || '').replace(/\\/g, '/')).toLowerCase();

// An entry narrowed by exe size or file version only applies to that build; one without either applies
// to every build of that exe name. A narrowed entry whose field the caller could not provide is skipped
// rather than assumed: the narrowing exists because another build behaves differently.
function entryMatches(entry, exe, { size = null, version = null } = {}) {
  if (!entry || exeKey(entry.exe) !== exe) return false;
  const m = entry.match || {};
  if (m.size != null && Number(m.size) !== Number(size)) return false;
  if (m.version != null && String(m.version) !== String(version || '')) return false;
  return true;
}

const deadEndKey = (d) => [d.route || '', d.via || '', d.api || '', d.feature || ''].join('|').toLowerCase();

// Local over shipped. Setup fields: the local value wins where it has one. Verdict counts add up (a
// local run is one more report). Dead ends: the union, local first, one per route/via/api/feature.
// Status: a local entry that has seen DLSS 5 run says "works", whatever the shipped one said -- a
// shipped "no working route" is a statement about the reports so far, and this machine has just
// produced a counter-example.
function mergeEntries(shipped, local) {
  if (!shipped) return local ? { ...local, local: true } : null;
  if (!local) return shipped;
  const setup = { ...(shipped.setup || {}) };
  for (const [k, v] of Object.entries(local.setup || {})) if (v !== null && v !== undefined && v !== '') setup[k] = v;
  const reports = {
    works: ((shipped.reports || {}).works || 0) + ((local.reports || {}).works || 0),
    fails: ((shipped.reports || {}).fails || 0) + ((local.reports || {}).fails || 0),
  };
  const dead = [];
  const seen = new Set();
  for (const d of [...(local.dead_ends || []), ...(shipped.dead_ends || [])]) {
    const k = deadEndKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    dead.push(d);
  }
  const localWorks = ((local.reports || {}).works || 0) > 0;
  return {
    ...shipped,
    name: shipped.name || local.name,
    status: localWorks ? 'works' : (local.status || shipped.status),
    setup,
    reports,
    dead_ends: dead,
    notes: [shipped.notes, local.notes].filter(Boolean).join(' '),
    sources: [...(local.sources || []), ...(shipped.sources || [])],
    local: true,
  };
}

function lookup(exePath, facts = {}) {
  if (!exePath) return null;
  const exe = exeKey(exePath);
  const shipped = loadShipped().entries.find((e) => entryMatches(e, exe, facts)) || null;
  const local = loadLocal().entries.find((e) => entryMatches(e, exe, facts)) || null;
  return mergeEntries(shipped, local);
}

// Whether any entry for this exe is narrowed by size/version -- so route.js reads the exe's size (or
// version) only for the handful of games where that decides the match.
function needsFacts(exePath) {
  const exe = exeKey(exePath);
  const all = [...loadShipped().entries, ...loadLocal().entries].filter((e) => exeKey(e.exe) === exe);
  return {
    size: all.some((e) => e.match && e.match.size != null),
    version: all.some((e) => e.match && e.match.version != null),
  };
}

// Dead ends that concern a route (the ones scoring uses), matched on the fields the dead end names.
function deadEndsFor(entry, { route, via = null, api = null } = {}) {
  if (!entry) return [];
  return (entry.dead_ends || []).filter((d) => d.route
    && d.route === route
    && (d.via == null || d.via === via)
    && (d.api == null || d.api === api));
}

// A dead end that is not a route but a feature on it (OptiScaler's own frame generation on Cyberpunk,
// the dxgi.dll proxy on Monster Hunter: World).
function featureDeadEnd(entry, feature) {
  if (!entry) return null;
  return (entry.dead_ends || []).find((d) => d.feature === feature) || null;
}

// The translation layer (setup.via: dgvoodoo, dxvk or native) PROVEN for this game on this route, or
// null. Proven means a "works" entry whose run used exactly this route and layer; a dead end on the
// route (or on that layer of it, whatever API it names) cancels it, and DXVK never counts where it is
// blocked (translation.js DXVK_BLOCKED, the Ezio-era Assassin's Creed games). This is the only thing
// that may move a game's default layer away from dgVoodoo2 / its own Direct3D (layerdefault.js) -- per
// game, never across the board. { via, source }, source being the entry's newest source line.
function provenLayer(entry, { route, dxvkBlocked = false } = {}) {
  if (!entry || entry.status !== 'works' || !(((entry.reports || {}).works || 0) > 0)) return null;
  const setup = entry.setup || {};
  if (!route || setup.route !== route || !VIAS.has(setup.via)) return null;
  if (setup.via === 'dxvk' && dxvkBlocked) return null;
  if (layerDeadEnd(entry, route, setup.via)) return null;
  return { via: setup.via, source: (entry.sources || [])[0] || null };
}

// A dead end for this layer on this route (or for the whole route), whatever API it was recorded on.
function layerDeadEnd(entry, route, via) {
  if (!entry) return null;
  return (entry.dead_ends || []).find((d) => d.route === route && (d.via == null || d.via === via)) || null;
}

// ── the card's badge ────────────────────────────────────────────────────────────────────────────
// { kind: 'good' | 'issue', text, vars, title } or null. Text is an English template for the
// renderer's t(); the title is the entry's notes, which stay English like every catalog field.
//
// Order: a game with no working route at all says so first (it is the one thing worth knowing before
// Install). Then a dead end that is exactly the route this card is on. Then "Known good" when the
// catalog's proven route IS this card's route. A launcher entry names the exe to pick instead.
function badgeFor(entry, route = null, api = null) {
  if (!entry) return null;
  const title = entry.notes || '';
  if (entry.status === 'launcher') {
    return { kind: 'issue', text: 'Known issue: {what}', vars: { what: entry.issue || 'this exe is a launcher, not the game' }, title };
  }
  if (entry.status === 'no-route') {
    return { kind: 'issue', text: 'Known issue: {what}', vars: { what: entry.issue || `no working route (${entry.updated || '?'})` }, title };
  }
  if (route && route.route) {
    // A route result names its wrapper only through its legacy plan (routescore.pickVia); required
    // here, not at the top, because routescore.js requires this module.
    const via = route.via !== undefined ? route.via : require('./routescore').pickVia(route);
    const dead = deadEndsFor(entry, { route: route.route, via, api: api || route.api || null })[0];
    if (dead) return { kind: 'issue', text: 'Known issue: {what}', vars: { what: dead.why || dead.what || 'this route failed here before' }, title: dead.source ? `${dead.why || ''} (${dead.source})` : title };
  }
  const works = (entry.reports || {}).works || 0;
  const setup = entry.setup || {};
  if (entry.status === 'works' && works > 0 && (!route || !setup.route || setup.route === route.route)) {
    return { kind: 'good', text: 'Known good', vars: { n: works }, title: title || `Proven on ${works} report(s)` };
  }
  return null;
}

// ── local learning ──────────────────────────────────────────────────────────────────────────────
// One record per run: game:help (main.js) is asked for every card on every render, so a run's own
// timestamp is what keeps one launch from being counted a hundred times. Returns what changed, or
// null when this run was already recorded or says nothing either way.
const SEEN_RUNS_CAP = 50;

function learnFromRun({ exePath, name = null, run, setup = {}, file = localPath(), now = new Date() } = {}) {
  if (!file || !exePath || !run || !run.ran || !run.at) return null;
  const good = runWorked(run);
  const why = DEAD_END_VERDICTS[run.verdict];
  if (!good && !why) return null;

  const doc = readLocalDoc(file);
  const exe = exeKey(exePath);
  let entry = doc.entries.find((e) => exeKey(e.exe) === exe && !(e.match && (e.match.size != null || e.match.version != null)));
  if (!entry) {
    entry = { exe, name: name || null, setup: {}, reports: { works: 0, fails: 0 }, dead_ends: [], sources: [], seenRuns: [] };
    doc.entries.push(entry);
  }
  entry.seenRuns = entry.seenRuns || [];
  if (entry.seenRuns.includes(run.at)) return null;
  entry.seenRuns.push(run.at);
  if (entry.seenRuns.length > SEEN_RUNS_CAP) entry.seenRuns = entry.seenRuns.slice(-SEEN_RUNS_CAP);
  entry.reports = entry.reports || { works: 0, fails: 0 };
  const clean = {};
  for (const [k, v] of Object.entries(setup || {})) if (v !== null && v !== undefined && v !== '') clean[k] = v;

  let kind;
  if (good) {
    kind = 'works';
    entry.status = 'works';
    entry.reports.works += 1;
    entry.setup = clean;
    entry.updated = now.toISOString().slice(0, 10);
    // A setup that has now worked is no longer a dead end on this machine.
    entry.dead_ends = (entry.dead_ends || []).filter((d) => !(d.route === clean.route && (d.via || null) === (clean.via || null)));
  } else {
    kind = 'dead-end';
    entry.reports.fails += 1;
    const dead = {
      route: clean.route || null, via: clean.via || null, api: clean.api || null,
      verdict: run.verdict, why, source: `local run ${run.at}`,
    };
    entry.dead_ends = [dead, ...(entry.dead_ends || []).filter((d) => deadEndKey(d) !== deadEndKey(dead))];
  }
  entry.sources = [`local run ${run.at} (${run.verdict})`, ...(entry.sources || [])].slice(0, 20);
  if (name && !entry.name) entry.name = name;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: doc.entries }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  state.local.key = null;
  return { kind, entry };
}

// ── the shipped file's shape (tools/catalog/build.js) ───────────────────────────────────────────
// Every shipped entry has to say where it came from: a catalog entry is a claim about a game, and a
// claim with no source is exactly what this file exists to keep out.
const ROUTES = new Set(['optiscaler', 'nr-model-only', 'feeder', 'feeder32', 'lumaue', 'present', 'reframework-pd', 'amdnr']);
const VIAS = new Set(['dgvoodoo', 'dxvk', 'native']);
const STATUSES = new Set(['works', 'no-route', 'launcher']);
// Frame generators, as fgsuggest.js names them. A feature dead end may also name one of these.
const FG_KINDS = new Set(['native-dlssg', 'rtxmfg', 'lossless', 'optifg']);

function validateEntry(e) {
  const problems = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  if (typeof e.exe !== 'string' || !/^[^\\/]+\.exe$/.test(e.exe) || e.exe !== e.exe.toLowerCase()) problems.push('exe must be a lower-case file name ending .exe');
  if (e.status != null && !STATUSES.has(e.status)) problems.push(`status "${e.status}" is not one of ${[...STATUSES].join(', ')}`);
  const setup = e.setup || {};
  if (setup.route != null && !ROUTES.has(setup.route)) problems.push(`setup.route "${setup.route}" is not a route`);
  if (setup.via != null && !VIAS.has(setup.via)) problems.push(`setup.via "${setup.via}" is not a wrapper`);
  // A layer only exists on the Feeder routes (layerdefault.js), and "native" -- the game's own
  // Direct3D -- only on the 32-bit route: a proven layer anywhere else could never be applied.
  if (setup.via != null && !(setup.route === 'feeder32' || setup.route === 'feeder')) problems.push(`setup.via "${setup.via}" on route "${setup.route}", which has no translation layer`);
  if (setup.via === 'native' && setup.route !== 'feeder32') problems.push('setup.via "native" is only a choice on the feeder32 route');
  if (e.status === 'works' && !setup.route) problems.push('a "works" entry needs setup.route');
  if (e.status === 'works' && !((e.reports || {}).works > 0)) problems.push('a "works" entry needs reports.works > 0');
  for (const [i, d] of (e.dead_ends || []).entries()) {
    if (!d.route && !d.feature) problems.push(`dead_ends[${i}] names neither a route nor a feature`);
    if (d.route && !ROUTES.has(d.route)) problems.push(`dead_ends[${i}].route "${d.route}" is not a route`);
    if (d.via != null && !VIAS.has(d.via)) problems.push(`dead_ends[${i}].via "${d.via}" is not a wrapper`);
    if (!d.why) problems.push(`dead_ends[${i}] has no why`);
    if (!d.source) problems.push(`dead_ends[${i}] has no source`);
  }
  for (const k of (e.fg || {}).works || []) if (!FG_KINDS.has(k)) problems.push(`fg.works "${k}" is not a frame generator`);
  if (!Array.isArray(e.sources) || e.sources.length === 0) problems.push('no sources');
  return problems;
}

// A run digest (digest.parseDigest) as a catalog entry: a report that DLSS 5 ran records its setup, one
// that failed with a DEAD_END_VERDICTS verdict records a dead end, anything else says nothing (null).
function entryFromDigest(facts, { source, date = null } = {}) {
  if (!facts || !facts.exe || !facts.route || !ROUTES.has(facts.route)) return null;
  const worked = facts.verdict === 'nr-ran'
    || (facts.verdict === 'shutdown-fault' && ((facts.neuralPasses || 0) > 0 || !!facts.neuralRan));
  const why = DEAD_END_VERDICTS[facts.verdict];
  if (!worked && !why) return null;
  const onWrapper = facts.route === 'feeder' || facts.route === 'feeder32';
  const via = !onWrapper ? null
    : facts.wrapper || (facts.route === 'feeder32' && (facts.api === 'dx10' || facts.api === 'dx11') ? 'native' : null);
  const setup = { route: facts.route, via, api: facts.runtimeApi || facts.api || null };
  const when = date || (facts.at ? String(facts.at).slice(0, 10) : null);
  const src = `${source}${when ? ` (${when})` : ''}: ${facts.verdict}`;
  const entry = {
    exe: facts.exe, name: facts.game || null, setup: worked ? setup : {},
    reports: { works: worked ? 1 : 0, fails: worked ? 0 : 1 }, dead_ends: [], sources: [src],
  };
  if (worked) { entry.status = 'works'; if (when) entry.updated = when; }
  else entry.dead_ends.push({ ...setup, verdict: facts.verdict, why, source: src });
  return entry;
}

// One more report into the shipped entries: merged like a local entry (mergeEntries), the local-only
// fields dropped. Returns a new array.
function addReport(entries, incoming) {
  const out = [...(entries || [])];
  const i = out.findIndex((e) => exeKey(e.exe) === exeKey(incoming.exe) && !(e.match && (e.match.size != null || e.match.version != null)));
  const merged = mergeEntries(i >= 0 ? out[i] : null, incoming);
  delete merged.local;
  delete merged.seenRuns;
  if (!merged.notes) delete merged.notes;
  if (i >= 0) out[i] = merged; else out.push(merged);
  return out;
}

module.exports = {
  SHIPPED_FILE, DEAD_END_VERDICTS, ROUTES, FG_KINDS, runWorked,
  entriesHash, verifyCatalog, configure, loadShipped, lookup, needsFacts, entryMatches, mergeEntries,
  deadEndsFor, featureDeadEnd, provenLayer, layerDeadEnd, badgeFor, learnFromRun, exeKey, validateEntry, entryFromDigest, addReport,
};
