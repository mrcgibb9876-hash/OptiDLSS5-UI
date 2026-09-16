// The window and resolutions on the game card, read from the last run's log (runlog.js
// screenState). The engine writes the window line itself (wrapped_swapchain.cpp
// ReportWindowState); the resolutions come from lines every engine has always written.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { REPO, scratchDir, write } = require('./helpers');
const runlog = require(path.join(REPO, 'src', 'runlog'));

const line = (s) => `[00:00:01.000000] [I] ${s}`;

test('the engine\'s window line gives the size and the mode, the last one winning', () => {
  const log = [
    line('DlssNr.ForceBorderless: true'),
    line('IFeature::SetInitParameters Render Resolution: 1706x960, Display Resolution 2560x1440, Quality: 2'),
    line('WrappedIDXGISwapChain4::Present DLSS-NR window: 1920x1080 windowed on a 2560x1600 monitor'),
    line('DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 2560x1440, model 2560x1440, guides 1706x960 (preset 0)'),
    line('WrappedIDXGISwapChain4::Present DLSS-NR window: 2560x1440 borderless (the game asked for exclusive fullscreen; ForceBorderless kept it out)'),
  ].join('\n');
  const s = runlog.screenState(log, log);
  assert.deepEqual(s.window, { width: 2560, height: 1440, mode: 'borderless', monitor: null, fullscreenRefused: true });
  assert.deepEqual(s.display, { width: 2560, height: 1440 });
  assert.deepEqual(s.render, { width: 1706, height: 960 });
});

test('a windowed game names its monitor; exclusive fullscreen is its own mode', () => {
  const a = runlog.screenState(line('DLSS-NR window: 1920x1080 windowed on a 2560x1600 monitor'), '');
  assert.deepEqual(a.window, { width: 1920, height: 1080, mode: 'windowed', monitor: { width: 2560, height: 1600 }, fullscreenRefused: false });
  const b = runlog.screenState(line('DLSS-NR window: 2560x1600 exclusive fullscreen'), '');
  assert.equal(b.window.mode, 'fullscreen');
  assert.equal(b.window.fullscreenRefused, false);
  assert.deepEqual(b.display, { width: 2560, height: 1600 });
});

test('a line only in the head (before the tail begins) still counts', () => {
  const head = line('DLSS-NR window: 2560x1600 borderless');
  const tail = line('DLSS-NR heartbeat: 600 frames run (0 model failures), 60 fps, GPU 5.00 ms | intensity 1');
  assert.equal(runlog.screenState(tail, head).window.mode, 'borderless');
});

test('an older engine\'s log still gives the display size from the neural pass, and no mode', () => {
  const log = [
    line('IFeature::SetInitParameters Render Resolution: 2560x1600, Display Resolution 2560x1600, Quality: 5'),
    line('DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 2560x1600, model 2560x1600, guides 2560x1600 (preset 2)'),
  ].join('\n');
  const s = runlog.screenState(log, log);
  assert.equal(s.window, null);
  assert.deepEqual(s.display, { width: 2560, height: 1600 });
  assert.deepEqual(s.render, { width: 2560, height: 1600 });
});

test('a Present-route game (no upscaler call) has a display size and no render size', () => {
  const log = line('DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 1920x1080, model 1920x1080, guides 1920x1080 (preset 3)');
  const s = runlog.screenState(log, log);
  assert.deepEqual(s.display, { width: 1920, height: 1080 });
  assert.equal(s.render, null);
});

test('a log that says nothing about the screen gives nulls, not guesses', () => {
  assert.deepEqual(runlog.screenState('', ''), { window: null, display: null, render: null });
});

test('analyzeRun carries the screen through to the card', async () => {
  const dir = scratchDir('runlog-screen');
  write(dir, 'OptiScaler.log', [
    line('NVSDK_NGX_D3D12_Init'),
    line('NVSDK_NGX_D3D12_CreateFeature Creating new DLSS feature'),
    line('WrappedIDXGISwapChain4::Present DLSS-NR window: 2560x1600 borderless'),
    line('DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 2560x1600, model 2560x1600, guides 2560x1600 (preset 0)'),
    '',
  ].join('\n'));
  const run = await runlog.analyzeRun(dir);
  assert.equal(run.ran, true);
  assert.deepEqual(run.window, { width: 2560, height: 1600, mode: 'borderless', monitor: null, fullscreenRefused: false });
  assert.deepEqual(run.display, { width: 2560, height: 1600 });
  assert.equal(run.render, null);
});
