// Watching a launch this app started, to catch the one outcome a card cannot see on its own: a game
// that came up and fell over within seconds. That is what a bad install looks like from outside --
// Cyberpunk's VRAM overcommit, Code Vein 2 on the Feeder, a proxy DLL the game rejects -- and until
// now the only way back was the user finding Remove themselves.
//
// Nothing here restores anything. It decides what happened; the renderer offers the restore and the
// user clicks it. Same listing as games:running (one tasklist for everything), polled only while a
// launch is being watched, so it costs nothing when no game was started from here.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A game that stays up this long got past loading its DLLs and building its device -- where every
// install-caused crash seen so far has happened.
const EARLY_EXIT_MS = 30_000;
// How long to wait for the process to appear at all. Steam checks for updates and a launcher wants a
// sign-in first, so the launcher route gets much longer.
const APPEAR_MS = 120_000;
const APPEAR_LAUNCHER_MS = 300_000;
const POLL_MS = 3_000;
// Gone on this many polls in a row before it counts. A game that restarts itself (Steam DRM, a
// launcher handing over to the same exe) disappears for a moment and comes back.
const GONE_POLLS = 2;

// tasklist /NH /FO CSV -> the set of image names, lower case. Shared with games:running.
function runningImageNames(stdout) {
  const running = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) running.add(m[1].toLowerCase());
  }
  return running;
}

function createWatch({ exeName, startedAt, via = 'exe' }) {
  return {
    exeName: String(exeName).toLowerCase(),
    startedAt,
    appearMs: via === 'launcher' ? APPEAR_LAUNCHER_MS : APPEAR_MS,
    firstSeen: null,
    lastSeen: null,
    goneTicks: 0,
  };
}

// One poll. Returns null while it is still undecided, else the outcome:
//   { kind: 'ok' }                           up for EARLY_EXIT_MS -- stop watching
//   { kind: 'early-exit', upMs }             came up, then went away inside EARLY_EXIT_MS
//   { kind: 'never-started' }                never showed up inside the appear window
function step(watch, isRunning, now) {
  if (isRunning) {
    if (watch.firstSeen === null) watch.firstSeen = now;
    watch.lastSeen = now;
    watch.goneTicks = 0;
    if (now - watch.firstSeen >= EARLY_EXIT_MS) return { kind: 'ok' };
    return null;
  }
  if (watch.firstSeen === null) {
    return now - watch.startedAt >= watch.appearMs ? { kind: 'never-started' } : null;
  }
  watch.goneTicks += 1;
  if (watch.goneTicks >= GONE_POLLS) return { kind: 'early-exit', upMs: watch.lastSeen - watch.firstSeen };
  return null;
}

// The files that say this app installed something here, and the stamp each records; the newest is
// "the install". The recorded stamp, not the file's mtime: the install journal is rewritten by later
// steps (Streamline, REFramework, the PureDark plugin), which would make every launch look like the
// first one after an install. The mtime is only the fallback for a marker without a stamp.
const INSTALL_MARKERS = [
  ['.optiscaler-manager-install.json', 'installedAt'],
  ['.dlss5ui-feeder-deploy.json', 'deployedAt'],
  ['.dlss5ui-lumaue-deploy.json', 'deployedAt'],
];

function installedAt(dir) {
  let newest = 0;
  for (const [name, key] of INSTALL_MARKERS) {
    const file = path.join(dir, name);
    let at = NaN;
    try { at = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8'))[key]); } catch {}
    if (!Number.isFinite(at)) { try { at = fs.statSync(file).mtimeMs; } catch {} }
    if (Number.isFinite(at)) newest = Math.max(newest, at);
  }
  return newest || null;
}

// Whether this is the first watched launch since the install. `history` is { [dir lower]: ms } of
// the last watched launch per folder -- kept by main.js in userData, never in the game folder.
function firstRunSinceInstall(dir, history) {
  const at = installedAt(dir);
  if (!at) return false;
  const last = history && history[String(dir).toLowerCase()];
  return !last || last < at;
}

// What the renderer is told. Only outcomes worth a word: a clean run says nothing, and a game that
// never appeared is only explained when anti-cheat is the likely reason -- otherwise it is Steam
// updating, a sign-in screen, or the user closing the launcher, none of which this app caused.
function outcomeNotice(outcome, { exePath, antiCheat = null, canRestore = false, firstRun = false } = {}) {
  if (!outcome) return null;
  if (outcome.kind === 'early-exit') {
    return { exePath, kind: 'early-exit', upSeconds: Math.max(1, Math.round(outcome.upMs / 1000)), firstRun, antiCheat, canRestore };
  }
  if (outcome.kind === 'never-started' && antiCheat) {
    return { exePath, kind: 'never-started', antiCheat, firstRun, canRestore };
  }
  if (outcome.kind === 'ok') return { exePath, kind: 'ok' };
  return null;
}

module.exports = {
  EARLY_EXIT_MS, APPEAR_MS, APPEAR_LAUNCHER_MS, POLL_MS, GONE_POLLS,
  runningImageNames, createWatch, step, installedAt, firstRunSinceInstall, outcomeNotice,
};
