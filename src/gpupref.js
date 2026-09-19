'use strict';
// Windows' per-app graphics preference ("High performance") for everything this app runs a game
// through, set automatically on a hybrid laptop (an NVIDIA card plus the processor's own graphics).
//
// Why automatic: on the 32-bit route the DLSS work runs in a second process, the Feeder's 64-bit
// helper (host64\dlss5-feed-host64.exe), which shares the game's frames through a cross-process
// fence. Windows gives each process its own GPU pick, so on a hybrid laptop the game could land on
// the NVIDIA card and the helper on the integrated one -- and the Feeder then fails with "cross-process
// fence import failed -- most often the host opened a different GPU than the game" (its issue #100,
// reported to us 2026-09-19). Every process on High performance is the one arrangement where both
// open the same card. The game itself too: DLSS only exists on the NVIDIA card.
//
// Undone exactly by Remove: the marker keeps what each value was before (or that there was none),
// and only values still holding what this app wrote are put back -- a choice the player made in
// Windows Settings afterwards stays theirs.
const fs = require('fs');
const path = require('path');
const preflight = require('./preflight');

const MARKER = '.dlss5ui-gpupref.json';
const HOST64_EXE = path.join('host64', 'dlss5-feed-host64.exe');

function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return m && Array.isArray(m.entries) ? m : null;
  } catch {
    return null;
  }
}

// The exes to set for a game folder: the ones given (the launch target, the exe the game really runs
// as) and the 32-bit route's helper when it is there.
function exesFor(dir, exes) {
  const out = new Map();
  for (const e of exes || []) if (e) out.set(String(e).toLowerCase(), String(e));
  const host = path.join(dir, HOST64_EXE);
  if (fs.existsSync(host)) out.set(host.toLowerCase(), host);
  return [...out.values()];
}

// Pure: the values to write, from the current registry values (Map(lower exe -> { data }) as
// preflight.readGpuPrefs returns it). An exe already on High performance is left alone.
function plan(exes, prefs) {
  const writes = [];
  for (const exe of exes) {
    const existing = prefs.get(String(exe).toLowerCase());
    const before = existing ? existing.data : null;
    if (preflight.gpuPreferenceOf(before) === 2) continue;
    writes.push({ exe, before, data: preflight.withGpuPreference(before, 2) });
  }
  return writes;
}

// Pure: the marker's entries after `done` writes. A "before" already on record wins -- it predates
// this app; only what was written is updated.
function remember(entries, done) {
  const out = (entries || []).map((e) => ({ ...e }));
  for (const w of done) {
    const known = out.find((e) => String(e.exe).toLowerCase() === String(w.exe).toLowerCase());
    if (known) known.wrote = w.data;
    else out.push({ exe: w.exe, before: w.before, wrote: w.data });
  }
  return out;
}

// `onlyNew`: sync's mode -- exes the marker already records are not looked at again, so a sync of
// every game costs no registry read unless something new (the helper, a new exe) turned up, and a
// player who switched one back in Windows Settings is not overruled on every sync. `readPrefs` lets
// the caller share one registry read across many games.
async function ensureHighPerformance(dir, exes, { execFileAsync, gpuInfo, onlyNew = false, readPrefs = null }) {
  if (!preflight.isHybrid(gpuInfo)) return { skipped: 'not-hybrid', set: [] };
  const marker = readMarker(dir);
  let targets = exesFor(dir, exes);
  if (onlyNew && marker) {
    const seen = new Set(marker.entries.map((e) => String(e.exe).toLowerCase()).concat((marker.alreadySet || []).map((e) => String(e).toLowerCase())));
    targets = targets.filter((e) => !seen.has(e.toLowerCase()));
  }
  if (targets.length === 0) return { skipped: null, set: [] };
  const prefs = readPrefs ? await readPrefs() : await preflight.readGpuPrefs(execFileAsync);
  if (!prefs) return { skipped: 'registry-unreadable', set: [] };
  const writes = plan(targets, prefs);
  // Exes found already on High performance are noted too, so onlyNew stops asking about them.
  const alreadySet = targets.filter((e) => !writes.some((w) => w.exe === e));
  const done = [];
  for (const w of writes) {
    try {
      await execFileAsync('reg.exe', ['add', preflight.GPU_PREF_KEY, '/v', w.exe, '/t', 'REG_SZ', '/d', w.data, '/f'], { windowsHide: true });
      done.push(w);
    } catch {}
  }
  if (done.length === 0 && alreadySet.length === 0) return { skipped: null, set: [] };
  try {
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({
      entries: remember(marker && marker.entries, done),
      alreadySet: [...new Set([...((marker && marker.alreadySet) || []), ...alreadySet])],
      setAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
  return { skipped: null, set: done.map((w) => w.exe) };
}

// Pure: what Remove does to each recorded value. A value the player changed since is left alone.
function restorePlan(entries, prefs) {
  const out = [];
  for (const e of entries || []) {
    const now = prefs.get(String(e.exe).toLowerCase());
    const current = now ? now.data : null;
    if (e.wrote && current !== e.wrote) continue;
    if (e.before == null) out.push({ exe: e.exe, action: 'delete' });
    else out.push({ exe: e.exe, action: 'set', data: e.before });
  }
  return out;
}

async function restore(dir, { execFileAsync }) {
  const marker = readMarker(dir);
  if (!marker) return { restored: [] };
  const prefs = (await preflight.readGpuPrefs(execFileAsync)) || new Map();
  const restored = [];
  for (const step of restorePlan(marker.entries, prefs)) {
    try {
      if (step.action === 'delete') {
        await execFileAsync('reg.exe', ['delete', preflight.GPU_PREF_KEY, '/v', step.exe, '/f'], { windowsHide: true });
      } else {
        await execFileAsync('reg.exe', ['add', preflight.GPU_PREF_KEY, '/v', step.exe, '/t', 'REG_SZ', '/d', step.data, '/f'], { windowsHide: true });
      }
      restored.push(step.exe);
    } catch {}
  }
  try { fs.rmSync(path.join(dir, MARKER), { force: true }); } catch {}
  return { restored };
}

module.exports = { MARKER, HOST64_EXE, exesFor, plan, remember, restorePlan, ensureHighPerformance, restore, readMarker };
