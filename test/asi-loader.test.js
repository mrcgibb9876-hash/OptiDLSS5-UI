'use strict';
// An ASI loader runs plugins named *.asi out of the game folder. This app installs OptiScaler under
// a PROXY DLL name and reads a folder by those names, so it is blind to everything an ASI loader
// loads -- and "nothing hooked the game" is exactly the verdict that blindness produces.
//
// S.T.A.L.K.E.R. GAMMA (#108) is the case. The folder held a stray dxgi.dll left over from a
// reinstall, the app read it, and answered no-hook -- confidently, and about the wrong file. The
// reporter settled it in one line: "I usually load reshade and optiscaler via .asi". The app had
// no way to say that, so these tests are about it being able to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir } = require(path.join(__dirname, 'helpers'));
const detect = require(path.join(__dirname, '..', 'src', 'detect'));
const runlog = require(path.join(__dirname, '..', 'src', 'runlog'));
const { diagnose } = require(path.join(__dirname, '..', 'src', 'gamehelp'));

// A plugin with a needle in it. HOOK_NEEDLES are matched exact-case against the file's bytes, the
// same scan inspectHookDlls runs over a proxy DLL.
const plugin = (dir, rel, needle) => {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048), Buffer.from(needle || 'nothing', 'latin1')]));
};

test('an ASI loader’s plugins are found beside the exe and in plugins/, and the known ones are named', async () => {
  const dir = scratchDir('asi-found');
  plugin(dir, 'dinput8.dll');                       // the loader itself: not an .asi, not listed
  plugin(dir, 'OptiScaler.asi', 'OptiScaler');
  plugin(dir, 'plugins/ReShade.asi', 'ReShade');
  plugin(dir, 'plugins/somemod.asi');
  plugin(dir, 'readme.txt');

  const asi = await detect.inspectAsiPlugins(dir);
  assert.deepEqual(asi.files.slice().sort(), ['OptiScaler.asi', 'plugins/ReShade.asi', 'plugins/somemod.asi']);
  assert.equal(asi.optiScaler, 'OptiScaler.asi');
  assert.equal(asi.reShade, 'plugins/ReShade.asi');
});

test('OptiScaler.asi mentions ReShade, and must not be mistaken for it (#133, 2026-09-23)', async () => {
  // The fixture above gives OptiScaler.asi only its own needle, which is not what a real one is
  // like: OptiScaler looks the ReShade module up BY NAME to talk to it, so the string "ReShade" is
  // in its binary (Dxgi_Hooks.cpp alone has nine occurrences). Taking the first content hit per
  // tool in readdir order then let OptiScaler.asi, which sorts first, claim both slots.
  //
  // S.T.A.L.K.E.R. Anomaly reported the result verbatim: "OptiScaler in OptiScaler.asi and ReShade
  // in OptiScaler.asi", with a real ReShade.asi in the same folder, unmentioned.
  const both = scratchDir('asi-optiscaler-mentions-reshade');
  plugin(both, 'OptiScaler.asi', 'OptiScalerReShade');   // one file carrying both needles
  plugin(both, 'ReShade.asi', 'ReShade');
  const asi = await detect.inspectAsiPlugins(both);
  assert.equal(asi.optiScaler, 'OptiScaler.asi');
  assert.equal(asi.reShade, 'ReShade.asi', 'the file named ReShade is the ReShade');

  // The worse half: with no ReShade there at all, the mention alone used to invent one.
  const alone = scratchDir('asi-optiscaler-only');
  plugin(alone, 'OptiScaler.asi', 'OptiScalerReShade');
  const only = await detect.inspectAsiPlugins(alone);
  assert.equal(only.optiScaler, 'OptiScaler.asi');
  assert.equal(only.reShade, null, 'a mention of ReShade is not a ReShade');

  // ... while a genuinely renamed add-on is still found by content, which is why the scan exists.
  const renamed = scratchDir('asi-renamed');
  plugin(renamed, 'OptiScaler.asi', 'OptiScalerReShade');
  plugin(renamed, 'zz-visuals.asi', 'ReShade');
  const ren = await detect.inspectAsiPlugins(renamed);
  assert.equal(ren.optiScaler, 'OptiScaler.asi');
  assert.equal(ren.reShade, 'zz-visuals.asi');
});

test('a folder with no .asi in it reports none at all, rather than an empty finding', async () => {
  const dir = scratchDir('asi-none');
  plugin(dir, 'dxgi.dll', 'OptiScaler');
  assert.equal(await detect.inspectAsiPlugins(dir), null);
});

// A stored detection from before this existed carries no asiPlugins, and its absence reads as
// "no ASI loader here" -- the exact wrong answer. Only a DETECT_VERSION bump refreshes it.
test('DETECT_VERSION moved, so stored detections are re-run rather than kept ASI-blind', () => {
  assert.ok(detect.DETECT_VERSION >= 17, `DETECT_VERSION is ${detect.DETECT_VERSION}`);
});

const base = (over = {}) => ({
  detected: { api: 'dx12', bitness: 64, antiCheat: null, ...(over.detected || {}) },
  route: { route: 'optiscaler', optiInstalled: true, ...(over.route || {}) },
  run: over.run || { ran: true, verdict: 'no-dlss' },
  foreign: [],
});

test('an OptiScaler loaded as an .asi is the one answering the game, and is named as not ours', () => {
  const d = diagnose(base({ detected: { asiPlugins: { files: ['OptiScaler.asi'], optiScaler: 'OptiScaler.asi', reShade: null } } }));
  assert.equal(d.status, 'step');
  assert.equal(d.code, 'asi-optiscaler');
  assert.equal(d.vars.file, 'OptiScaler.asi');
  // Before anything else is offered: installing over it would only add a second consumer.
  const notInstalled = diagnose(base({
    detected: { asiPlugins: { files: ['OptiScaler.asi'], optiScaler: 'OptiScaler.asi', reShade: null } },
    route: { route: 'optiscaler', optiInstalled: false },
  }));
  assert.equal(notInstalled.code, 'asi-optiscaler', 'not "press Install"');
});

test('a run with no DLSS in a folder that has an ASI loader says so instead of a confident no-hook', () => {
  const blind = diagnose(base({ detected: { asiPlugins: { files: ['ui_mod.asi', 'plugins/other.asi'], optiScaler: null, reShade: 'plugins/other.asi' } } }));
  assert.equal(blind.code, 'asi-loader-blind');
  assert.equal(blind.vars.count, 2);
  assert.equal(blind.vars.files, 'ui_mod.asi, plugins/other.asi');

  // ... and with nothing of the sort in the folder, the old answer is unchanged.
  assert.equal(diagnose(base()).code, 'no-hook');
  assert.equal(diagnose(base({ detected: { asiPlugins: null } })).code, 'no-hook');
});

test('the report digest names the .asi plugins, so a report says it before the diagnosis does', async () => {
  const dir = scratchDir('asi-digest');
  const run = await runlog.analyzeRun(dir);
  const digest = runlog.reportDigest(run, {
    detected: { api: 'dx12', bitness: 64, asiPlugins: { files: ['OptiScaler.asi', 'ReShade.asi'], optiScaler: 'OptiScaler.asi', reShade: 'ReShade.asi' } },
  });
  assert.match(digest, /asi plugins: 2 beside the exe \(OptiScaler\.asi, ReShade\.asi\)/);
  assert.match(digest, /OptiScaler in OptiScaler\.asi and ReShade in ReShade\.asi/);
  assert.match(digest, /NOT by this app/);

  // Plugins this app knows nothing about are still worth reporting -- that is the whole point.
  const plain = runlog.reportDigest(run, { detected: { asiPlugins: { files: ['ui_mod.asi'], optiScaler: null, reShade: null } } });
  assert.match(plain, /asi plugins: 1 beside the exe \(ui_mod\.asi\) -- this app cannot see what they load/);

  // And a folder with none says nothing at all about ASI.
  assert.doesNotMatch(runlog.reportDigest(run, { detected: { api: 'dx12' } }), /asi/i);
});
