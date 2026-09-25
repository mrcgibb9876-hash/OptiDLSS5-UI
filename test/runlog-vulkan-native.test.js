'use strict';
// The engine's native Vulkan pass (DlssNrFeature_Vk.cpp) proves it ran with one line and no heartbeat,
// and the current engine words feature creation as "CreateFeature1 ... DLSS upscaler". Both were missed,
// so No Man's Sky (#132, 2026-09-25) read init-no-feature with the pass up at 2560x1440 for ten minutes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runlog = require('../src/runlog');

test('a native Vulkan run that proves itself with "running natively" reads as nr-ran', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-vknative-'));
  fs.writeFileSync(path.join(dir, 'OptiScaler.log'), [
    '[18:59:36.785302] [W] OptiScaler v2.1.0-final (9243da1) loaded',
    '[18:59:50.939691] [I] hkvkCreateSwapchainKHR DLSS-NR: swapchain colour space 0 -- sRGB (SDR) (relative -- no scale to be had), format 37',
    '[19:00:28.838234] [I] NVSDK_NGX_VULKAN_CreateFeature1 HandleId: 1000000',
    '[19:00:28.838258] [I] NVSDK_NGX_VULKAN_CreateFeature1 Creating new DLSS upscaler',
    '[19:00:30.194924] [I] DlssNr::EvaluateAfterUpscaleVk DLSS-NR Vulkan: the model initialised on this device',
    '[19:00:30.530509] [I] DlssNr::EvaluateAfterUpscaleVk DLSS-NR Vulkan: running natively at 2560x1440, guides 1520x848',
    '[19:09:40.881625] [I] NVSDK_NGX_VULKAN_ReleaseFeature releasing feature with id 1000000',
    '',
  ].join('\n'));
  const run = await runlog.analyzeRun(dir, { optiDir: dir });
  assert.equal(run.ran, true);
  assert.equal(run.verdict, 'nr-ran');
  assert.ok(run.nrDispatch >= 1);
});

// OptiScaler words feature creation "Creating new {UpscalerDisplayName} upscaler": a game upscaled
// with XeSS or FSR (the Vulkan and D3D11 defaults) never says "DLSS" on that line, and its run read as
// init-no-feature -- NGX initialised and nothing ever created.
test('a feature created under a non-DLSS upscaler still counts as created', async () => {
  for (const name of ['XeSS', 'FSR 3.1.4', 'XeSS 2.1.0']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-xess-'));
    fs.writeFileSync(path.join(dir, 'OptiScaler.log'), [
      '[18:59:36.785302] [W] OptiScaler v2.1.0-final (9243da1) loaded',
      '[18:59:40.000000] [I] NVSDK_NGX_VULKAN_Init_ProjectID calling',
      `[19:00:28.838258] [I] NVSDK_NGX_VULKAN_CreateFeature1 Creating new ${name} upscaler`,
      '',
    ].join('\n'));
    const run = await runlog.analyzeRun(dir, { optiDir: dir });
    assert.equal(run.dlssCreated, 1, name);
    assert.equal(run.verdict, 'dlss-no-nr', name);
  }
});

// No heartbeat means no frame count: the one "running natively" line is not "1 pass".
test('the digest does not turn a line count into a pass count', () => {
  const noBeat = runlog.reportDigest({ ran: true, verdict: 'nr-ran', at: 'now', nrFrames: 0, nrDispatch: 1 });
  assert.match(noBeat, /neural passes: ran \(this engine logs no frame count\)/);
  const beat = runlog.reportDigest({ ran: true, verdict: 'nr-ran', at: 'now', nrFrames: 5400, nrDispatch: 3 });
  assert.match(beat, /neural passes: 5400/);
});
