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

test('a copy already beside the exe is never replaced', async () => {
  const { invoke } = loadMain();
  const { exe, exeDir } = gameWithDlssElsewhere('place-dlss-present');
  write(exeDir, 'nvngx_dlss.dll', 'already here');

  const res = await invoke('game:help-apply', { exePath: exe, fixId: 'place-dlss' });
  assert.equal(res.done, false);
  assert.equal(fs.readFileSync(path.join(exeDir, 'nvngx_dlss.dll'), 'utf8'), 'already here');
  const journal = JSON.parse(fs.readFileSync(path.join(exeDir, INSTALL_MARKER), 'utf8'));
  assert.ok(!journal.added.includes('nvngx_dlss.dll'), 'not claimed as ours');
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
