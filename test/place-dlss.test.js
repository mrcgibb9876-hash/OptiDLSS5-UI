'use strict';
// nvngx_dlss.dll beside the exe on the plain OptiScaler route (main.js placeNvngxDlssBesideExe).
// Baldur's Gate 3 (#83) shipped its DLSS away from bg3_dx11.exe, OptiScaler switched DLSS off for
// want of it, and nothing on this route could put it there. Game Help's place-dlss fix and Install
// both run the step now; these cover the game's-own-copy source, Remove, and the gates. The RHI
// download (the other source) is feeder.deployNvngxDlss, covered where the Feeder uses it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write, fakeExe, loadMain } = require('./helpers');

const INSTALL_MARKER = '.optiscaler-manager-install.json';

// <scratch>\steamapps\common\<Game>: "common" is what bounds the install-tree walk to this game.
function gameWithDlssElsewhere(name) {
  const root = path.join(scratchDir(name), 'steamapps', 'common', 'Game');
  const exeDir = path.join(root, 'bin');
  const exe = fakeExe(exeDir, 'Game.exe');
  const shipped = write(root, 'Engine/Plugins/DLSS/Binaries/nvngx_dlss.dll', 'the game\'s own DLSS');
  write(exeDir, INSTALL_MARKER, JSON.stringify({ added: ['OptiScaler.ini'], replaced: [] }));
  return { exe, exeDir, shipped };
}

test('place-dlss copies the game\'s own nvngx_dlss.dll beside the exe and journals it', async () => {
  const { invoke } = loadMain();
  const { exe, exeDir, shipped } = gameWithDlssElsewhere('place-dlss-own');

  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'place-dlss' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.done, true, res.text);

  const dest = path.join(exeDir, 'nvngx_dlss.dll');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'the game\'s own DLSS');
  assert.equal(fs.readFileSync(shipped, 'utf8'), 'the game\'s own DLSS', 'the game\'s copy stays where it was');
  const journal = JSON.parse(fs.readFileSync(path.join(exeDir, INSTALL_MARKER), 'utf8'));
  assert.ok(journal.added.includes('nvngx_dlss.dll'), 'Remove knows the file is ours');
  assert.ok(journal.added.includes('OptiScaler.ini'), 'what the journal already had is kept');
  assert.equal(journal.nvngxDlss.source, 'game');
});

test('Remove takes the placed copy away and leaves the game\'s own', async () => {
  const { invoke } = loadMain({ dialogResponse: 0 });
  const { exe, exeDir, shipped } = gameWithDlssElsewhere('place-dlss-remove');
  await invoke('game:help-apply', { exePath: exe, fixId: 'place-dlss' });
  assert.ok(fs.existsSync(path.join(exeDir, 'nvngx_dlss.dll')));

  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'remove-all' });
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.existsSync(path.join(exeDir, 'nvngx_dlss.dll')), false);
  assert.ok(fs.existsSync(shipped));
});

// A DLL-sized copy. The fixture used to be the string "already here" -- twelve bytes, which is now
// read as a placeholder rather than a copy, so the test was asserting the opposite of its own name.
const dllSized = (text) => text + '\0'.repeat(128 * 1024);

test('a copy already beside the exe is never replaced', async () => {
  const { invoke } = loadMain();
  const { exe, exeDir } = gameWithDlssElsewhere('place-dlss-present');
  write(exeDir, 'nvngx_dlss.dll', dllSized('already here'));

  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'place-dlss' });
  assert.equal(res.done, false);
  assert.equal(fs.readFileSync(path.join(exeDir, 'nvngx_dlss.dll'), 'utf8'), dllSized('already here'));
  const journal = JSON.parse(fs.readFileSync(path.join(exeDir, INSTALL_MARKER), 'utf8'));
  assert.ok(!journal.added.includes('nvngx_dlss.dll'), 'not claimed as ours');
});

test('a placeholder too small to be a DLL is replaced, not respected', async () => {
  // #89 (2026-09-20): a PCSX2 folder carried a TWELVE-byte nvngx_dlss.dll. OptiScaler checks the
  // name, finds it, logs "Enabling DLSS" and carries on, so the run never says the file is missing
  // -- and "a copy is never replaced" would have made Fix it a no-op that reports success and
  // changes nothing, which is precisely the dead button #83 was about.
  const { invoke } = loadMain();
  const { exe, exeDir } = gameWithDlssElsewhere('place-dlss-stub');
  write(exeDir, 'nvngx_dlss.dll', 'not a dll!!!');

  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'place-dlss' });
  assert.equal(res.done, true, res.text);
  const placed = fs.readFileSync(path.join(exeDir, 'nvngx_dlss.dll'), 'utf8');
  assert.notEqual(placed, 'not a dll!!!', 'the placeholder is gone');
  const journal = JSON.parse(fs.readFileSync(path.join(exeDir, INSTALL_MARKER), 'utf8'));
  assert.ok(journal.added.includes('nvngx_dlss.dll'), 'and the real copy is ours to remove again');
});

// The file beside the exe would make the game look like it ships DLSS, and a game that needs the
// Feeder would lose its route before the Feeder is ever deployed.
test('a game that ships no DLSS gets nothing', async () => {
  const { invoke } = loadMain();
  const root = path.join(scratchDir('place-dlss-none'), 'steamapps', 'common', 'Game');
  const exe = fakeExe(root, 'Game.exe');

  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'place-dlss' });
  assert.equal(res.done, false);
  // A game with no DLSS of its own counts as a Feeder game, and that gate answers first.
  assert.match(res.text, /Feeder or Luma deploy places it|ships no DLSS/);
  assert.equal(fs.existsSync(path.join(root, 'nvngx_dlss.dll')), false);
});
