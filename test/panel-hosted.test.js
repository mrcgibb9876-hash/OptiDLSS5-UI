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

  // Only the frame-rate cap is typed: it has to land on 72 or 141 exactly. Every other number,
  // pacing and RenoDX, is a slider.
  assert.match(hosted, /const typed = kind === 'pacing' && s\.key === 'target_fps';/);
  // Reset only when the engine says the add-on can, sent as the reserved `$reset` key.
  assert.match(hosted, /if \(h\.canReset\)/);
  assert.match(hosted, /hostedApply\(kind, \{ key: '\$reset' \}, true\)/);
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

// ── RenoDX host API version 4: the whole overlay, row by row ─────────────────────────────────────

function v4hdr(over = {}) {
  return {
    available: true, module: 'renodx-ue-extended.addon64', addon: 'renodx', canReset: true, apiVersion: 4,
    title: 'RenoDX UE-Extended',
    presets: { count: 4, selected: 1, segmented: true, labels: ['Off', 'Preset #1', 'Preset #2', 'Preset #3'] },
    settings: [
      { key: 'ToneMapPeakNits', label: 'Peak Brightness', section: 'Tone Mapping', tooltip: '', type: 'float', min: 48, max: 4000, enabled: true, value: 1000 },
    ],
    rows: [
      { index: 0, kind: 'int', key: 'SettingsMode', label: 'Settings Mode', section: '', sectionOpen: true, tooltip: '', enabled: true,
        sticky: true, segmented: true, multiline: false, tint: null, canReset: false, isUsingDefault: true,
        labels: ['Simple', 'Intermediate', 'Advanced'], min: 0, max: 2, logarithmic: false, value: 0, default: 0 },
      { index: 1, kind: 'float', key: 'ToneMapPeakNits', label: 'Peak Brightness', section: 'Tone Mapping', sectionOpen: true, tooltip: 'Nits',
        enabled: true, sticky: false, segmented: false, multiline: false, tint: '#3B8EEA', canReset: true, isUsingDefault: false,
        min: 48, max: 4000, logarithmic: true, value: 1000, default: 203 },
      { index: 2, kind: 'bool', key: 'Blowout', label: 'Blowout', section: 'Tone Mapping', sectionOpen: true, tooltip: '', enabled: false,
        sticky: false, segmented: false, multiline: false, tint: null, canReset: true, isUsingDefault: true, value: true, default: false },
      { index: 3, kind: 'button', key: '', label: 'Discord', section: 'About', sectionOpen: false, tooltip: '', enabled: true,
        sticky: false, segmented: false, multiline: false, tint: '#5865F2', canReset: false, isUsingDefault: true },
      { index: 4, kind: 'text', key: '', label: '', section: 'About', sectionOpen: false, tooltip: '', enabled: true, sticky: false,
        segmented: false, multiline: true, tint: null, canReset: false, isUsingDefault: true, labels: ['Line one\nLine two'] },
      { index: 5, kind: 'inputText', key: 'Name', label: 'Name', section: 'About', sectionOpen: false, tooltip: '', enabled: true, sticky: false,
        segmented: false, multiline: false, tint: null, canReset: true, isUsingDefault: true, value: 'x', default: '', placeholder: 'type', maxLength: 32, inputTextFlags: 0 },
      // Not drawable: a float with no range, a kind nobody knows.
      { index: 6, kind: 'float', key: 'Broken', label: 'Broken', section: 'X', enabled: true, value: 1 },
      { index: 7, kind: 'hologram', key: 'Nope', label: 'Nope', section: 'X', enabled: true },
    ],
    ...over,
  };
}

test('v4: rows, presets, title, apiVersion and canReset come through; undrawable rows are dropped', () => {
  const r = dlssnr.checkHosted(answer({ hdr: v4hdr() }), NOW);
  assert.equal(r.ok, true);
  const h = r.hosted.hdr;
  assert.equal(h.available, true);
  assert.equal(h.apiVersion, 4);
  assert.equal(h.canReset, true);
  assert.equal(h.title, 'RenoDX UE-Extended');
  assert.deepEqual(h.presets, { count: 4, selected: 1, segmented: true, labels: ['Off', 'Preset #1', 'Preset #2', 'Preset #3'] });
  assert.deepEqual(h.rows.map((x) => x.index), [0, 1, 2, 3, 4, 5], 'the broken float and the unknown kind are dropped');
  const peak = h.rows[1];
  assert.equal(peak.logarithmic, true);
  assert.equal(peak.default, 203);
  assert.equal(peak.tint, '#3B8EEA');
  assert.equal(peak.isUsingDefault, false);
  assert.equal(h.rows[0].sticky, true);
  assert.deepEqual(h.rows[0].labels, ['Simple', 'Intermediate', 'Advanced']);
  assert.equal(h.rows[3].sectionOpen, false);
  assert.equal(h.rows[4].multiline, true);
  assert.equal(h.rows[5].placeholder, 'type');
  assert.equal(h.rows[5].maxLength, 32);
  // Old settings stay parsed for older app code paths.
  assert.equal(h.settings.length, 1);
});

test('v4: an older add-on has rows null (the panel draws settings), and apiVersion alone', () => {
  const h = dlssnr.checkHosted(answer({ hdr: { ...answer().hdr, apiVersion: 3, canReset: true } }), NOW).hosted.hdr;
  assert.equal(h.rows, null);
  assert.equal(h.presets, null);
  assert.equal(h.title, '');
  assert.equal(h.apiVersion, 3);
  assert.equal(h.canReset, true);
  // A mod with no presets: null.
  assert.equal(dlssnr.checkHosted(answer({ hdr: v4hdr({ presets: null }) }), NOW).hosted.hdr.presets, null);
});

test('v4 commands: preset, one row\'s reset and text go out; a press or reset-all is never sent twice', () => {
  const at0 = dlssnr.checkHosted(answer({ ack: 0, hdr: v4hdr() }), NOW).hosted;
  const a = dlssnr.nextHostedCommand(undefined, at0, { hdr: { $press: 3, $preset: 2, Name: 'hello' } });
  assert.deepEqual(a.command.hdr, { $press: 3, $preset: 2, Name: 'hello' });
  // Not yet acknowledged: the values ride along, the press does not (the engine may already have done it).
  const b = dlssnr.nextHostedCommand(a.state, at0, { hdr: { $resetSetting: 'ToneMapPeakNits' } });
  assert.deepEqual(b.command.hdr, { $preset: 2, Name: 'hello', $resetSetting: 'ToneMapPeakNits' });
  const c = dlssnr.nextHostedCommand(b.state, at0, { hdr: { $reset: true } });
  const d = dlssnr.nextHostedCommand(c.state, at0, { hdr: { ToneMapPeakNits: 400 } });
  assert.equal(c.command.hdr.$reset, true);
  assert.equal(d.command.hdr.$reset, undefined);
});

test('the pop-out draws v4 rows when present, and settings otherwise', () => {
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const panel = strip(fs.readFileSync(path.join(REPO, 'src', 'renderer', 'panel.js'), 'utf8'));
  assert.match(panel, /if \(kind === 'hdr' && Array\.isArray\(h\.rows\)\) \{\s*renderHdrRows\(host, h\);\s*return;/);
  for (const cmd of ['$press', '$preset', '$resetSetting', '$reset']) {
    assert.ok(panel.includes(`key: '${cmd}' }`), `${cmd} is sent`);
  }
  // The only typed number box in the pop-out is ReLimiter's frame-rate cap.
  assert.equal((panel.match(/hostedNumberRow\(/g) || []).length, 2, 'defined once, called once');
  assert.match(panel, /const typed = kind === 'pacing' && s\.key === 'target_fps';/);
  assert.doesNotMatch(panel.slice(panel.indexOf('function renderHdrRows'), panel.indexOf('function hostedNumberRow')), /type = 'number'/);
});

test('RenoDX active: the pop-out hides Brightness, Contrast and both Auto rows and says why', () => {
  const panel = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'panel.js'), 'utf8');
  assert.match(panel, /const TONE_TRIM_KEYS = \['Brightness', 'Contrast', 'AutoBrightness', 'AutoContrast'\];/);
  assert.match(panel, /lastLive\.renodxActive === true/);
  assert.match(panel, /t\('Brightness and contrast are handled by RenoDX in this game\.'\)/);
});
