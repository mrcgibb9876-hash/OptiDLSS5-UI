'use strict';
// The Vulkan neural pass serves ONE viewport, and a run where the wrong one was picked looks like a
// clean run: no crash, no error, and no change on screen when the user moves a DLSS slider.
//
// The Great Circle (2026-09-24) is the case, and the fault was ours. Engine v2.2.14 keyed "the
// viewport we serve" on the NGX feature handle; idTech makes a new feature for every setting change,
// so the engine latched to a dead handle (1000000) and skipped every evaluate after it. The reporter
// said only "no crash now but dlss5 settings are not changing on screen", and nothing in the report
// carried the log lines that said why -- it took them attaching a whole support bundle.
//
// So these tests are about the digest carrying it. The engine now keys on OUTPUT SIZE, which is what
// the served viewport actually is, and the digest names the size served and the sizes skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir } = require(path.join(__dirname, 'helpers'));
const runlog = require(path.join(__dirname, '..', 'src', 'runlog'));

// analyzeRun reads OptiScaler.log out of the folder it is given.
async function runWith(name, lines) {
  const dir = scratchDir(name);
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'), lines.map((l) => `[11:22:09.983457] [I] DlssNr::EvaluateAfterUpscaleVk ${l}`).join('\n') + '\n');
  return runlog.analyzeRun(dir);
}

test('the served viewport and the skipped ones reach the digest', async () => {
  const run = await runWith('vk-healthy', [
    'DLSS-NR Vulkan: serving the 3840x2160 viewport (feature 1000000)',
    'DLSS-NR Vulkan: 1280x720 (feature 1000001) is a second viewport (3840x2160 is being served); skipping it rather than rebuilding for its size',
    'DLSS-NR Vulkan: 960x540 (feature 1000005) is a second viewport (3840x2160 is being served); skipping it rather than rebuilding for its size',
  ]);
  assert.deepEqual(run.vkViewport, { serving: '3840x2160', skipped: ['1280x720', '960x540'], handleGuard: false });
  assert.match(runlog.reportDigest(run), /vulkan viewport: serving 3840x2160; skipped 1280x720, 960x540/);
});

test('a size is named once however many frames it is skipped on', async () => {
  const run = await runWith('vk-repeat', [
    'DLSS-NR Vulkan: serving the 3840x2160 viewport (feature 1)',
    ...Array.from({ length: 12 }, () => 'DLSS-NR Vulkan: 1280x720 (feature 2) is a second viewport (3840x2160 is being served); skipping it rather than rebuilding for its size'),
  ]);
  assert.deepEqual(run.vkViewport.skipped, ['1280x720']);
});

test('the LAST size adopted is the one served, whichever shape adopted it', async () => {
  // A larger viewport turning up takes over ...
  const bigger = await runWith('vk-bigger', [
    'DLSS-NR Vulkan: serving the 1280x720 viewport (feature 1)',
    'DLSS-NR Vulkan: 3840x2160 (feature 2) is larger than the 1280x720 being served; following it',
  ]);
  assert.equal(bigger.vkViewport.serving, '3840x2160');

  // ... and so does the hand-back, when the served size stops being drawn. This is the line that
  // makes the guard recoverable rather than a latch, so a digest that missed it would hide a
  // recovery and read like the bug it replaced.
  const handback = await runWith('vk-handback', [
    'DLSS-NR Vulkan: serving the 3840x2160 viewport (feature 1)',
    'DLSS-NR Vulkan: 1920x1080 (feature 2) is a second viewport (3840x2160 is being served); skipping it rather than rebuilding for its size',
    'DLSS-NR Vulkan: 3840x2160 has not been drawn for 120 evaluates; serving 1920x1080 (feature 2) instead',
  ]);
  assert.equal(handback.vkViewport.serving, '1920x1080');
});

test("engine v2.2.14's handle-keyed guard is named as the install's problem", async () => {
  // Its own wording, verbatim from the reporter's bundle. There is no WxH in it to read, so without
  // this the digest would go quiet on exactly the build that is broken.
  const run = await runWith('vk-1046', [
    'DLSS-NR Vulkan: serving upscaler feature 1000000',
    'DLSS-NR Vulkan: feature 1000001 is a second viewport (1000000 is being served); skipping it rather than rebuilding for its size',
    'DLSS-NR Vulkan: feature 1000005 is a second viewport (1000000 is being served); skipping it rather than rebuilding for its size',
  ]);
  assert.equal(run.vkViewport.handleGuard, true);
  assert.equal(run.vkViewport.serving, null, 'a handle is not a size, so nothing is claimed as served');
  assert.match(runlog.reportDigest(run), /engine v2\.2\.14 skipped a feature by handle -- update the engine/);
});

test('a run that is not Vulkan says nothing about viewports', async () => {
  const run = await runWith('vk-none', ['DLSS-NR heartbeat: 600 frames run (0 model failures), 60 fps, GPU 2.10 ms | intensity 1.0']);
  assert.equal(run.vkViewport, null);
  assert.doesNotMatch(runlog.reportDigest(run), /vulkan viewport/);
});
