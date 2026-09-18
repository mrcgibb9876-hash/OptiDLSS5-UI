// Did Windows Defender take a file this app just wrote? A file that vanished a moment after it was
// placed is what quarantine looks like (legacy.js says so about dgVoodoo2), but "check Windows
// Security's protection history" leaves the user to find the entry, work out whether it was ours,
// and know what to do next. Defender's own detection history answers the first two, so the notice
// can name the file and the detection and send them straight to the page that restores it.
//
// Only ever asked after something is already missing -- one powershell.exe, never per game or per
// render (the rule v1.59.0 was about).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Threat names by id, then each detection with its resources, as one JSON array.
const QUERY = [
  "$ErrorActionPreference='Stop'",
  '$n=@{}; Get-MpThreat | ForEach-Object { $n[[string]$_.ThreatID]=$_.ThreatName }',
  '@(Get-MpThreatDetection | ForEach-Object { [pscustomobject]@{ id=[string]$_.ThreatID; name=$n[[string]$_.ThreatID]; at=$(if ($_.InitialDetectionTime) { $_.InitialDetectionTime.ToString(\'o\') } else { $null }); resources=@($_.Resources) } }) | ConvertTo-Json -Depth 3 -Compress',
].join('; ');

// "file:_C:\Games\x\dxgi.dll", "containerfile:_C:\...\a.zip", "webfile:_C:\...|https://..." ->
// the path, lower case with backslashes. Anything that is not a file resource is skipped.
function resourcePath(resource) {
  const m = /^(?:file|containerfile|webfile):_(.+)$/i.exec(String(resource || '').trim());
  if (!m) return null;
  return m[1].split('|')[0].replace(/\//g, '\\').toLowerCase();
}

function parseDetections(json) {
  const text = String(json || '').trim();
  if (!text) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(data) ? data : [data];
  return list.filter(Boolean).map((d) => ({
    id: d.id != null ? String(d.id) : null,
    name: d.name || null,
    at: d.at || null,
    resources: (Array.isArray(d.resources) ? d.resources : d.resources ? [d.resources] : []).map(resourcePath).filter(Boolean),
  }));
}

// The detections that touched any of `targets` (files, or folders -- a folder matches everything
// under it), newest first, with the file each one hit.
function matchDetections(detections, targets, { since = 0 } = {}) {
  const norm = (p) => path.win32.normalize(String(p)).toLowerCase().replace(/\\+$/, '');
  const wanted = targets.filter(Boolean).map(norm);
  const hits = [];
  for (const d of detections) {
    const at = d.at ? Date.parse(d.at) : NaN;
    if (since && Number.isFinite(at) && at < since) continue;
    for (const r of d.resources) {
      const target = wanted.find((w) => r === w || r.startsWith(w + '\\'));
      if (target) { hits.push({ file: r, threat: d.name, at: d.at }); break; }
    }
  }
  return hits.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// null when Defender cannot be asked (another antivirus, the cmdlets missing, a policy): the notice
// then says "an antivirus" instead of naming Defender.
async function defenderRemovals(targets, { execFileAsync, since = 0 } = {}) {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 20_000 });
    return matchDetections(parseDetections(stdout), targets, { since });
  } catch {
    return null;
  }
}

// The binaries a finished install leaves beside the game, from its journal -- not the journal's whole
// `added` list, which also holds OptiScaler.dll (renamed to the proxy by then) and names from older
// installs that a sync has since taken away. Each of those would read as quarantine.
//   proxy              the renamed OptiScaler.dll, when the rename happened (OptiScaler.dll gone)
//   nvngx_dlssnr.dll   the model, always copied beside the exe
//   companions         engine DLLs that ride along, when this install added them
function expectedInstallBinaries(dir, journal, { companions = [] } = {}) {
  const j = journal || {};
  const out = [];
  if (j.proxy && !fs.existsSync(path.join(dir, 'OptiScaler.dll'))) out.push(j.proxy);
  out.push('nvngx_dlssnr.dll');
  for (const c of companions) if ((j.added || []).includes(c)) out.push(c);
  return out.map((rel) => path.join(dir, rel));
}

// Windows Security's protection history, where a quarantined file is allowed and restored.
const PROTECTION_HISTORY_URI = 'windowsdefender://threat/';

module.exports = { resourcePath, parseDetections, matchDetections, defenderRemovals, expectedInstallBinaries, PROTECTION_HISTORY_URI, QUERY };
