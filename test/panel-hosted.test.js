// The pop-out panel's Pacing (ReLimiter) and HDR (RenoDX) pages.
//
// Neither add-on can be changed through a file while the game runs -- each reads its ini once, and
// ReLimiter writes its own back on exit -- so these pages go through the running game: the engine
// publishes OptiScaler.hosted.json and applies OptiScaler.hosted.set.json (dlssnr.js "hosted pages",
// engine DlssNr_Hosted.cpp). What can be tested without a game is the contract: what counts as a live
// answer, which rows survive the check, and how a command is numbered and merged so that nothing a
// user changed is lost between two writes.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./helpers');
const dlssnr = require(path.join(REPO, 'src', 'dlssnr'));

const NOW = 1_800_000_000_000;

function answer(over = {}) {
  return {
    v: 1, pid: 4242, at: NOW - 400, ack: 0,
    pacing: {
      available: true, version: '3.3.5',
      settings: [
        { key: 'target_fps', label: 'Target FPS', group: 'Limiter', tooltip: 'Line one\nLine two', type: 'double',
          min: 30, max: 1000, zeroLabel: 'Below the VRR ceiling', value: 0 },
        { key: 'enabled', label: 'Enabled', group: 'Limiter', tooltip: '', type: 'bool', value: true },
        { key: 'mode', label: 'Mode', group: 'Limiter', tooltip: '', type: 'enum', choices: ['vrr', 'fixed'], value: 'vrr' },
      ],
    },
    hdr: {
      available: true, module: 'renodx-unrealengine.addon64', addon: 'renodx',
      settings: [
        { key: 'ToneMapType', label: 'Tone Mapper', section: 'Tone Mapping', tooltip: '', type: 'combo',
          labels: ['Vanilla', 'None', 'ACES'], enabled: true, value: 2 },
        { key: 'ToneMapPeakNits', label: 'Peak Brightness', section: 'Tone Mapping', tooltip: '', type: 'float',
          min: 48, max: 4000, enabled: false, value: 1000 },
      ],
    },
    ...over,
  };
}

test('the panel has a Pacing page and an HDR page, each drawn from the running game', () => {
  const pacing = dlssnr.PAGES.find((p) => p.page === 'Pacing');
  const hdr = dlssnr.PAGES.find((p) => p.page === 'HDR');
  assert.ok(pacing && hdr, 'both pages are in the table');
  assert.deepEqual(pacing.sections.map((s) => s.hosted), ['pacing']);
  assert.deepEqual(hdr.sections.map((s) => s.hosted), ['hdr']);
  // Not ini keys: nothing here may be written to OptiScaler.ini, and "every setting is on exactly one
  // page" must not start counting add-on settings as ours.
  for (const s of [...pacing.sections, ...hdr.sections]) assert.deepEqual(s.keys, []);
  // After Setup, as in the in-game panel's page strip.
  const order = dlssnr.PAGES.map((p) => p.page);
  assert.ok(order.indexOf('Setup') < order.indexOf('Pacing') && order.indexOf('Pacing') < order.indexOf('HDR'));
});

test('an answer is only live while it is fresh and in the format this app knows', () => {
  assert.equal(dlssnr.checkHosted(null, NOW).reason, 'unknown-format');
  assert.equal(dlssnr.checkHosted({ ...answer(), v: 2 }, NOW).reason, 'unknown-format');
  assert.equal(dlssnr.checkHosted({ ...answer(), at: 'soon' }, NOW).reason, 'unknown-format');
  assert.equal(dlssnr.checkHosted({ ...answer(), pid: undefined }, NOW).reason, 'unknown-format');
  // The engine writes at least every second; past the stale window the game has stopped.
  const old = dlssnr.checkHosted(answer({ at: NOW - dlssnr.HOSTED_STALE_MS - 1 }), NOW);
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'stale');

  const ok = dlssnr.checkHosted(answer({ ack: 7 }), NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.hosted.pid, 4242);
  assert.equal(ok.hosted.ack, 7);
  assert.equal(ok.hosted.pacing.available, true);
  assert.equal(ok.hosted.pacing.version, '3.3.5');
  assert.equal(ok.hosted.hdr.module, 'renodx-unrealengine.addon64');
});

test('rows keep what the renderer needs and the add-on\'s own grouping', () => {
  const { hosted } = dlssnr.checkHosted(answer(), NOW);
  const target = hosted.pacing.settings.find((s) => s.key === 'target_fps');
  assert.equal(target.caption, 'Limiter', 'ReLimiter\'s group is the caption');
  assert.equal(target.zeroLabel, 'Below the VRR ceiling', 'a labelled zero is kept, so it becomes a mode');
  assert.equal(target.tooltip, 'Line one\nLine two', 'line breaks survive');
  assert.equal(target.enabled, true, 'ReLimiter has no enabled flag, so every row is live');

  const peak = hosted.hdr.settings.find((s) => s.key === 'ToneMapPeakNits');
  assert.equal(peak.caption, 'Tone Mapping', 'RenoDX\'s section is the caption');
  assert.equal(peak.enabled, false, 'a row RenoDX greys is greyed');
  assert.deepEqual(hosted.hdr.settings.find((s) => s.key === 'ToneMapType').labels, ['Vanilla', 'None', 'ACES']);
});

test('a row that cannot be drawn honestly is dropped, as the in-game page drops it', () => {
  const bad = answer();
  bad.pacing.settings.push(
    { key: 'no_range', label: 'No range', type: 'int', min: 0, max: 0, value: 3 },   // min == max
    { key: 'hotkey', label: 'Hotkey', type: 'keybind', value: 'F9' },                  // not offered
    { key: 'half', label: 'Half', type: 'bool', value: 1 },                            // not a bool
    { label: 'Nameless', type: 'bool', value: true },                                  // no key
  );
  bad.hdr.settings.push(
    { key: 'Out', label: 'Out of range', section: '', type: 'combo', labels: ['A'], value: 3 },
    { key: 'Path', label: 'Path', section: '', type: 'text', value: 'x' },
  );
  const { hosted } = dlssnr.checkHosted(bad, NOW);
  assert.deepEqual(hosted.pacing.settings.map((s) => s.key), ['target_fps', 'enabled', 'mode']);
  assert.deepEqual(hosted.hdr.settings.map((s) => s.key), ['ToneMapType', 'ToneMapPeakNits']);
});

test('an add-on that cannot be driven is unavailable, with the engine\'s reason for the greyed page', () => {
  const none = dlssnr.checkHosted(answer({
    pacing: { available: true, settings: [] },
    hdr: { available: false, reason: 'no-api', settings: [] },
  }), NOW);
  assert.equal(none.ok, true, 'the game still answered');
  assert.equal(none.hosted.pacing.available, false);
  assert.equal(none.hosted.pacing.reason, 'empty', 'there, but nothing the panel can draw');
  assert.equal(none.hosted.hdr.available, false);
  assert.equal(none.hosted.hdr.reason, 'no-api', 'the engine\'s own code is passed on');

  // No reason given (or no section at all) reads as "not installed", the ordinary case.
  const missing = dlssnr.checkHosted({ v: 1, pid: 1, at: NOW }, NOW);
  assert.equal(missing.hosted.pacing.available, false);
  assert.equal(missing.hosted.pacing.reason, 'not-loaded');
  assert.deepEqual(missing.hosted.hdr.settings, []);

  assert.equal(dlssnr.checkHosted(answer(), NOW).hosted.pacing.reason, null, 'no reason while available');
});

test('the pages are always listed; an absent add-on greys its page and leaves a hook for its switch', () => {
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const panel = strip(fs.readFileSync(path.join(REPO, 'src', 'renderer', 'panel.js'), 'utf8'));
  const render = panel.slice(panel.indexOf('function renderPages()'), panel.indexOf('function renderHead()'));
  assert.doesNotMatch(render, /\.filter\(/, 'no page is filtered out of the strip');

  const hosted = panel.slice(panel.indexOf('function renderHosted('), panel.indexOf('function hostedNumberRow('));
  // The container the app's own on/off control is drawn into, first on the page, whatever the state.
  assert.match(hosted, /enable\.className = 'hosted-enable'/);
  assert.ok(hosted.indexOf("'hosted-enable'") < hosted.indexOf('if (!h || !h.available)'), 'drawn before the unavailable early return');
  assert.match(hosted, /hostedMissingText\(kind\)/, 'and the greyed page says why');

  // Every ReLimiter number is typed, never dragged: a cap has to land on 72 or 141 exactly.
  assert.match(hosted, /kind === 'pacing' \? s\.type !== 'bool' && s\.type !== 'enum' : s\.type === 'int'/);
  assert.match(panel, /box\.type = 'number'/);
});

test('each command is numbered past what the game has acknowledged', () => {
  const hosted = dlssnr.checkHosted(answer({ ack: 0 }), NOW).hosted;
  const first = dlssnr.nextHostedCommand(undefined, hosted, { pacing: { target_fps: 120 } });
  assert.deepEqual(first.command, { seq: 1, pid: 4242, pacing: { target_fps: 120 }, hdr: {} });

  // An app restarted mid-game starts past the game's ack -- a seq it already applied would be ignored.
  const later = dlssnr.checkHosted(answer({ ack: 9 }), NOW).hosted;
  assert.equal(dlssnr.nextHostedCommand(undefined, later, { hdr: { ToneMapType: 1 } }).command.seq, 10);
});

test('a change not yet acknowledged rides along with the next one, and is dropped once it lands', () => {
  const at0 = dlssnr.checkHosted(answer({ ack: 0 }), NOW).hosted;
  const a = dlssnr.nextHostedCommand(undefined, at0, { pacing: { target_fps: 120 } });
  // The game has not read seq 1 yet; the file is REPLACED, so seq 2 must carry both changes.
  const b = dlssnr.nextHostedCommand(a.state, at0, { hdr: { ToneMapType: 1 } });
  assert.deepEqual(b.command, { seq: 2, pid: 4242, pacing: { target_fps: 120 }, hdr: { ToneMapType: 1 } });
  // A newer value for the same key wins.
  const c = dlssnr.nextHostedCommand(b.state, at0, { pacing: { target_fps: 90 } });
  assert.deepEqual(c.command.pacing, { target_fps: 90 });

  // Everything up to seq 3 has landed: the next command carries only what is new.
  const at3 = dlssnr.checkHosted(answer({ ack: 3 }), NOW).hosted;
  const d = dlssnr.nextHostedCommand(c.state, at3, { pacing: { enabled: false } });
  assert.deepEqual(d.command, { seq: 4, pid: 4242, pacing: { enabled: false }, hdr: {} });
});

test('a new game process starts over, and values of no JSON kind are not sent', () => {
  const first = dlssnr.checkHosted(answer({ ack: 0 }), NOW).hosted;
  const a = dlssnr.nextHostedCommand(undefined, first, { pacing: { target_fps: 120 } });
  const restarted = dlssnr.checkHosted(answer({ pid: 5151, ack: 0 }), NOW).hosted;
  const b = dlssnr.nextHostedCommand(a.state, restarted, { hdr: { ToneMapType: 2, Bad: NaN, Obj: {} } });
  assert.deepEqual(b.command, { seq: 1, pid: 5151, pacing: {}, hdr: { ToneMapType: 2 } });
});

test('the wiring: main answers both channels, preload bridges them, the panel draws hosted sections', () => {
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const main = strip(fs.readFileSync(path.join(REPO, 'src', 'main.js'), 'utf8'));
  const preload = fs.readFileSync(path.join(REPO, 'src', 'preload.js'), 'utf8');
  const panel = strip(fs.readFileSync(path.join(REPO, 'src', 'renderer', 'panel.js'), 'utf8'));

  assert.match(main, /ipcMain\.handle\('panel:hosted',/);
  assert.match(main, /ipcMain\.handle\('panel:hosted-set',/);
  assert.match(preload, /panelHosted: .*'panel:hosted'/);
  assert.match(preload, /panelHostedSet: .*'panel:hosted-set'/);
  assert.match(panel, /if \(section\.hosted\) renderHosted\(host, section\.hosted\)/);
  assert.match(panel, /window\.api\.panelHosted\(/);
  assert.match(panel, /window\.api\.panelHostedSet\(/);

  // The game card's frame-rate target goes into the running game when it can: relimiter.ini is read
  // once at start and rewritten by ReLimiter on exit, so writing it mid-game was silently undone.
  const setTarget = main.slice(main.indexOf("ipcMain.handle('relimiter:set-target'"));
  const body = setTarget.slice(0, setTarget.indexOf('\n});'));
  assert.ok(body.indexOf('sendHosted(') > 0, 'set-target sends through the hosted channel');
  assert.ok(body.indexOf('sendHosted(') < body.indexOf('patchIniValues('), 'and falls back to the ini only after');
});
