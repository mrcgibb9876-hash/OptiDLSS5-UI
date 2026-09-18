// What "Send game failure" adds to a report beyond the support bundle's files: the machine (GPU, driver,
// VRAM), the versions that actually ran, the route and install records, and any NVIDIA Aftermath GPU crash
// dump from around the failed run -- plus the header block that lets the maintainer sort issues by route
// and by game.
//
// Why each one: the Cyberpunk FG + NR crash (2026-09-16) came down to VRAM on a 12 GB laptop card, and its
// only hard evidence was Aftermath's own gpucrash log. Reports so far carried neither, and the engine line
// printed the app's setting rather than the build the game loaded.
//
// Everything here is read at send time, once. Nothing runs per game or per sync (see the perf rules:
// no PowerShell per game folder).
'use strict';

const fs = require('fs');
const path = require('path');

// OptiScaler.log is kept to its end: the failure is there, and the digest already carries the decisive
// lines from the whole file.
const LOG_TAIL_BYTES = 256 * 1024;
// Aftermath's text dump (gpucrash-*.log) is small; a runaway one is cut like a log.
const AFTERMATH_TEXT_BYTES = 128 * 1024;
// Dumps older than this before the run's log, or written long after it, belong to some other session.
const AFTERMATH_BEFORE_MS = 2 * 60 * 60 * 1000;
const AFTERMATH_AFTER_MS = 30 * 60 * 1000;
const AFTERMATH_FALLBACK_MS = 48 * 60 * 60 * 1000;
const MAX_AFTERMATH = 6;

// The build the game actually loaded, from OptiScaler.log's first line:
//   "[22:16:07.803352] [W] OptiScaler v2.1.0-final (09d0aee3) loaded"
// The app's own engine setting can differ from what sits in the game folder (an older install, a hand
// copy), and reports used to print the setting.
function engineFromLog(text) {
  const m = /OptiScaler\s+(v?[0-9][^\s]*)(?:\s+\(([0-9a-f]{6,40})\))?\s+loaded/i.exec(String(text || '').slice(0, 64 * 1024));
  if (!m) return null;
  return m[2] ? `${m[1]} (${m[2]})` : m[1];
}

// ---- NVIDIA Aftermath ----------------------------------------------------------------------------

// Where dumps have turned up on this project's machines:
//   - the game's own folder (and OptiScaler's host folder on the 32-bit routes): Aftermath's default is
//     the working directory;
//   - %TEMP%, where the Nsight Aftermath Monitor writes *.nv-gpudmp (the 2026-09-16 Cyberpunk runs);
//   - %LOCALAPPDATA%\REDEngine\ReportQueue\<run>\attch\, Cyberpunk's own crash reporter, which also holds
//     gpucrash-*.log, Aftermath's readable text dump with the device-removed reason.
// Only one directory level of %TEMP% and two of ReportQueue are read: this is a readdir, not a crawl.
function aftermathDirs({ dirs = [], tempDir = process.env.TEMP || '', localAppData = process.env.LOCALAPPDATA || '' } = {}) {
  const out = [...dirs];
  if (tempDir) out.push(tempDir);
  if (localAppData) {
    const queue = path.join(localAppData, 'REDEngine', 'ReportQueue');
    try {
      for (const e of fs.readdirSync(queue, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        out.push(path.join(queue, e.name));
        out.push(path.join(queue, e.name, 'attch'));
      }
    } catch {}
  }
  return [...new Set(out.filter(Boolean).map((d) => path.resolve(d)))];
}

const isDump = (name) => /\.nv-gpudmp$/i.test(name);
const isAftermathText = (name) => /^gpucrash-.*\.(log|txt)$/i.test(name) || /\.nv-gpudmp\.json$/i.test(name);

// Dumps from around the run: `around` is the failed run's log time (ms). Without one, the last 48 h.
// Returns [{ path, name, bytes, mtime, text? }], newest first; `text` only for Aftermath's readable
// dumps -- the binary .nv-gpudmp cannot go in a gist, so the player is told where it is instead.
function findAftermath({ dirs = [], tempDir, localAppData, around = null, now = Date.now() } = {}) {
  const from = around ? around - AFTERMATH_BEFORE_MS : now - AFTERMATH_FALLBACK_MS;
  const to = around ? around + AFTERMATH_AFTER_MS : now + 60 * 1000;
  const found = [];
  for (const dir of aftermathDirs({ dirs, tempDir, localAppData })) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !(isDump(e.name) || isAftermathText(e.name))) continue;
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < from || st.mtimeMs > to) continue;
      const item = { path: full, name: e.name, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() };
      if (isAftermathText(e.name)) {
        try { item.text = fs.readFileSync(full, 'utf8'); } catch {}
      }
      found.push(item);
    }
  }
  found.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return found.slice(0, MAX_AFTERMATH);
}

// ---- VRAM ----------------------------------------------------------------------------------------

// Win32_VideoController.AdapterRAM is a 32-bit field and reads 4 GB on every modern card. The display
// class key's HardwareInformation.qwMemorySize is the real 64-bit size, per adapter. One PowerShell call,
// at send time only.
const VRAM_SCRIPT = [
  "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
  'Get-ChildItem $k -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match "^\\d{4}$" } | ForEach-Object {',
  '  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  "  $q = $p.'HardwareInformation.qwMemorySize'",
  "  if ($q) { [pscustomobject]@{ name = $p.DriverDesc; bytes = [uint64]$q } }",
  '} | ConvertTo-Json -Compress',
].join('\n');

function parseVram(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || '').trim() || 'null'); } catch { return []; }
  if (parsed && !Array.isArray(parsed)) parsed = [parsed];
  const seen = new Set();
  return (parsed || [])
    .filter((a) => a && a.name && Number(a.bytes) > 0)
    .map((a) => ({ name: String(a.name), bytes: Number(a.bytes) }))
    .filter((a) => { const k = `${a.name}|${a.bytes}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function readVram(execFileAsync) {
  if (process.platform !== 'win32' || !execFileAsync) return [];
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', VRAM_SCRIPT], { timeout: 8000 });
    return parseVram(stdout);
  } catch {
    return [];
  }
}

// The VRAM of the adapter the games run on (gpu.js's pick), by name; the largest one when names differ.
function vramFor(gpuName, adapters) {
  if (!Array.isArray(adapters) || !adapters.length) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/\(r\)|\(tm\)|laptop gpu|\s+/g, '');
  const same = gpuName ? adapters.find((a) => norm(a.name) === norm(gpuName)) : null;
  return (same || [...adapters].sort((a, b) => b.bytes - a.bytes)[0]).bytes;
}

const gb = (bytes) => (bytes ? `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GB` : '?');

// ---- the header ----------------------------------------------------------------------------------

// A title that sorts: GitHub's issue list sorts and searches on it, and labels need push access a
// reporting player does not have (GitHub drops them silently). Route first, so "[Game failure] [feeder]"
// groups every Feeder report; then the game and the finding.
function reportTitle({ route, game, code }) {
  return `[Game failure] [${route || 'unknown'}] ${game || 'Unknown game'}${code ? `: ${code}` : ''}`;
}

// The block that opens the issue body. The hidden JSON line is the machine-readable copy, for a triage
// script: `<!-- dlss5ui-report {...} -->`. Everything in it is also in the visible table.
function metaBlock(meta) {
  const m = {
    schema: 1,
    game: meta.game || null,
    exe: meta.exe || null,
    route: meta.route || null,
    routeLabel: meta.routeLabel || null,
    api: meta.api || null,
    engineBadge: meta.engineBadge || null,
    bitness: meta.bitness || null,
    finding: meta.finding || null,
    gpu: meta.gpu || null,
    gpuVendor: meta.gpuVendor || null,
    driver: meta.driver || null,
    vramBytes: meta.vramBytes || null,
    app: meta.app || null,
    engineLoaded: meta.engineLoaded || null,
    engineBundled: meta.engineBundled || null,
    engineSetting: meta.engineSetting || null,
    aftermath: (meta.aftermath || []).map((a) => a.name),
  };
  const row = (k, v) => `| ${k} | ${v == null || v === '' ? '?' : String(v).replace(/\|/g, '\\|')} |`;
  const lines = [
    `<!-- dlss5ui-report ${JSON.stringify(m).replace(/--/g, '- -')} -->`,
    '| | |',
    '|---|---|',
    row('Game', m.game),
    row('Exe', m.exe),
    row('Route', m.route ? `\`${m.route}\`${m.routeLabel ? ` (${m.routeLabel})` : ''}` : null),
    row('API / engine', `${m.api || '?'} / ${m.engineBadge || '?'}${m.bitness ? `, ${m.bitness}-bit` : ''}`),
    row('Finding', m.finding),
    row('GPU', `${m.gpu || '?'} (${m.gpuVendor || '?'})`),
    row('Driver', m.driver),
    row('VRAM', m.vramBytes ? gb(m.vramBytes) : null),
    row('App', m.app ? `v${String(m.app).replace(/^v/, '')}` : null),
    row('Engine the game loaded', m.engineLoaded || 'not in OptiScaler.log'),
    row('Engine bundled / set', `${m.engineBundled || '?'} / ${m.engineSetting || '?'}`),
    row('Aftermath dumps', m.aftermath.length ? m.aftermath.length : 'none found'),
  ];
  return lines.join('\n');
}

// Aftermath binaries the gist cannot carry: listed, with where they are, for the maintainer to ask for.
function aftermathNote(dumps) {
  const bin = (dumps || []).filter((d) => isDump(d.name));
  if (!bin.length) return '';
  return [
    '**NVIDIA Aftermath GPU crash dumps** (binary, not uploaded; the player can attach them if asked):',
    ...bin.map((d) => `- \`${d.path}\` (${Math.round(d.bytes / 1024)} KB, ${d.mtime})`),
  ].join('\n');
}

// The whole report, before redaction (ghreport.prepareReport does that, and the size caps' last word).
//   base:     { title, body } from the renderer's buildGameReport (body already carries the digest)
//   game:     { name, exe }, finding: Game Help's code
//   route:    route.js's recommendation ({ route, label, legacy })
//   detection, gpu (gpu.js detectGpu), vram (readVram), versions: { app, bundled, setting }
//   files:    the support bundle's files with their text; aftermath: findAftermath()'s result
// Logs keep their last LOG_TAIL_BYTES; Aftermath's text dumps go in as files, its binaries as a note.
function assemble({ base = {}, game = {}, finding = null, route = null, detection = {}, gpu = {}, vram = [], versions = {}, files = [], aftermath = [] }) {
  const optiLog = files.find((f) => /(^|-)OptiScaler\.log$/i.test(f.name) && f.text);
  const meta = {
    game: game.name,
    exe: game.exe,
    route: route ? route.route : null,
    routeLabel: route ? route.label : null,
    api: detection.api,
    engineBadge: detection.badge || detection.engine,
    bitness: detection.bitness,
    finding,
    gpu: gpu.name,
    gpuVendor: gpu.vendor,
    driver: gpu.driverVersion,
    vramBytes: vramFor(gpu.name, vram),
    app: versions.app,
    engineLoaded: optiLog ? engineFromLog(optiLog.text) : null,
    engineBundled: versions.bundled,
    engineSetting: versions.setting,
    aftermath,
  };
  const outFiles = files.map((f) => ({ name: f.name, text: f.text, maxBytes: /\.log$/i.test(f.name) ? LOG_TAIL_BYTES : undefined }));
  for (const a of aftermath) {
    if (a.text !== undefined) outFiles.push({ name: `aftermath-${a.name}`, text: a.text, maxBytes: AFTERMATH_TEXT_BYTES });
  }
  const note = aftermathNote(aftermath);
  return {
    title: reportTitle({ route: meta.route, game: game.name, code: finding }),
    body: [metaBlock(meta), '', base.body || '', ...(note ? ['', note] : [])].join('\n'),
    files: outFiles,
    meta,
  };
}

module.exports = {
  LOG_TAIL_BYTES, AFTERMATH_TEXT_BYTES,
  engineFromLog, aftermathDirs, findAftermath, parseVram, readVram, vramFor, reportTitle, metaBlock, aftermathNote, assemble, gb,
};
