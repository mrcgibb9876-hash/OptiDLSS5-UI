'use strict';
// On a dgVoodoo2 or DXVK game the layer that faults is the layer the bundle never carried.
// OptiScaler.log describes what OptiScaler saw and says nothing about the D3D9-to-D3D11 or
// D3D-to-Vulkan translation underneath it, so the one log that would name the faulting layer was
// the one missing. SWTOR (#50) got settled only because the reporter's crash dump happened to name
// `d3d9!00065af0` and the adapter string said "(dgVoodoo DX API Layer)".
//
// Two shapes, which is why a flat name list could not do this. dgVoodoo writes one fixed name; DXVK
// writes `<exe basename>_<api>.log`, so the name depends on the game and only a pattern finds it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir } = require(path.join(__dirname, 'helpers'));
const runlog = require(path.join(__dirname, '..', 'src', 'runlog'));

const write = (dir, ...names) => names.forEach((n) => fs.writeFileSync(path.join(dir, n), 'x\n'));

test('both shapes of wrapper log are found, and our own logs are not mistaken for them', () => {
  const dir = scratchDir('wrap-both');
  write(dir, 'dgVoodoo.log', 'swtor_d3d9.log', 'u4_dxgi.log', 'game_d3d11.log', 'dxvk.log');
  // Ours, and a user's stray file. None of these is a wrapper log.
  write(dir, 'OptiScaler.log', 'ReShade.log', 'dlss5-feed.log', 'nvngx.log', 'notes.log', 'd3d9.txt');
  assert.deepEqual(runlog.wrapperLogs(dir),
    ['dgVoodoo.log', 'dxvk.log', 'game_d3d11.log', 'swtor_d3d9.log', 'u4_dxgi.log']);
});

test('the pattern needs the underscore, so it cannot swallow an arbitrary .log', () => {
  const dir = scratchDir('wrap-strict');
  write(dir, 'mydxgi.log', 'somed3d11.log', 'log_d3d9.log.bak', 'd3d11.log');
  // `d3d11.log` with no exe prefix is not a name DXVK writes, and the other three do not match.
  assert.deepEqual(runlog.wrapperLogs(dir), []);
});

test('a folder full of logs cannot make the bundle enormous', () => {
  const dir = scratchDir('wrap-many');
  for (let i = 0; i < 20; i++) write(dir, `game${i}_d3d11.log`);
  const found = runlog.wrapperLogs(dir);
  assert.equal(found.length, 8, 'capped');
  // Sorted, so the cap takes a stable set rather than whatever readdir happened to return -- the
  // readdir-order trap that made a dfc test pass on Linux and fail on Windows.
  assert.deepEqual(found, [...found].sort());
});

test('no wrapper, no noise, and a missing folder does not throw', () => {
  assert.deepEqual(runlog.wrapperLogs(scratchDir('wrap-none')), []);
  assert.deepEqual(runlog.wrapperLogs(path.join(scratchDir('wrap-none2'), 'nope')), []);
});

test('they reach the bundle, prefixed so the layer that wrote each one is obvious', async () => {
  const dir = scratchDir('wrap-bundle');
  write(dir, 'OptiScaler.log', 'dgVoodoo.log', 'swtor_d3d9.log');
  const { files } = await runlog.gatherSupportFiles(dir, { extra: {} });
  const names = files.map((f) => f.name);
  assert.ok(names.includes('wrapper-dgVoodoo.log'), names.join(', '));
  assert.ok(names.includes('wrapper-swtor_d3d9.log'), names.join(', '));
  // Ours keeps its own name: four files ending in .log in one zip is exactly the confusion the
  // prefix exists to prevent, and OptiScaler.log is the one nobody should have to guess about.
  assert.ok(names.includes('OptiScaler.log'));
  assert.ok(!names.includes('wrapper-OptiScaler.log'));
});
