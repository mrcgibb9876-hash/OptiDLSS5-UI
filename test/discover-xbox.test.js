'use strict';
// A Microsoft Store / Xbox install keeps the game under Content\, and Content is the one folder name
// the exe walker skips -- because in an Unreal tree it holds assets and nothing else. The two
// meanings collided, and the Store lost: the walker could not see an Xbox game's executable at all.
//
// Microsoft Flight Simulator 2024 under C:\XboxGames is the report (#93, 2026-09-21). The app ended
// up with the Content FOLDER recorded as the exe, put its dxgi.dll in the package root, detected no
// graphics API, and nothing ever loaded. What the user saw was "DLSS 5 makes no difference".
//
// So: Content stays skipped in an ordinary game, is walked in a Store one, and a path that is not an
// executable is never accepted or kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write } = require('./helpers');
const discover = require('../src/discover');

const CONFIG = '<?xml version="1.0" encoding="utf-8"?><Game configVersion="1">'
  + '<ExecutableList><Executable Name="FlightSimulator2024.exe" Id="Game"/></ExecutableList></Game>';

function xboxGame() {
  const dir = scratchDir('discover-xbox-store');
  write(dir, 'gamelaunchhelper.exe', 'stub');
  write(dir, path.join('Content', 'MicrosoftGame.config'), CONFIG);
  write(dir, path.join('Content', 'FlightSimulator2024.exe'), 'x'.repeat(4096));
  return dir;
}

test('a Store folder is recognised as one from its MicrosoftGame.config', () => {
  assert.equal(discover.isXboxInstall(xboxGame()), true);
});

test('a Store folder is recognised from its location even when unreadable', () => {
  assert.equal(discover.isXboxInstall('C:\\XboxGames\\Microsoft Flight Simulator 2024'), true);
  assert.equal(discover.isXboxInstall('C:\\Program Files\\WindowsApps\\Something'), true);
});

test('an ordinary game folder is not a Store one', () => {
  const dir = scratchDir('discover-xbox-ordinary');
  write(dir, 'Game.exe', 'x'.repeat(4096));
  assert.equal(discover.isXboxInstall(dir), false);
  assert.equal(discover.isXboxInstall('D:\\Games\\Some Game'), false);
});

test('the walker finds an executable inside Content on a Store install', () => {
  const found = discover.walkExes(xboxGame());
  assert.ok(
    found.some((p) => /FlightSimulator2024\.exe$/i.test(p)),
    'the Store game\'s exe lives in Content\\ and must be reachable; found: ' + JSON.stringify(found),
  );
});

test('Content is still skipped in an ordinary game, where it is only assets', () => {
  const dir = scratchDir('discover-xbox-unreal');
  write(dir, 'Game.exe', 'x'.repeat(4096));
  write(dir, path.join('Content', 'NotTheGame.exe'), 'x'.repeat(4096));
  const found = discover.walkExes(dir);
  assert.ok(found.some((p) => /[\\/]Game\.exe$/i.test(p)));
  assert.ok(!found.some((p) => /NotTheGame\.exe$/i.test(p)), 'Unreal Content\\ is assets, not exes');
});

test('chooseExe picks the game inside Content, not the Store stub', () => {
  const chosen = discover.chooseExe(xboxGame(), 'Microsoft Flight Simulator 2024');
  assert.ok(chosen && chosen.exePath, 'a Store game must resolve to something');
  assert.match(chosen.exePath, /FlightSimulator2024\.exe$/i);
});

test('a folder recorded as the exe is repaired to the executable inside it', () => {
  const dir = xboxGame();
  const broken = path.join(dir, 'Content');          // exactly what #93 had stored
  assert.ok(fs.statSync(broken).isDirectory());
  assert.match(discover.repairExePath(broken), /FlightSimulator2024\.exe$/i);
});

test('a good exe path is left exactly alone', () => {
  const dir = xboxGame();
  const good = path.join(dir, 'Content', 'FlightSimulator2024.exe');
  assert.equal(discover.repairExePath(good), good);
});

test('a path that is merely missing is left alone: that is an unplugged drive, not a bad record', () => {
  const missing = 'Z:\\NotPluggedIn\\Game.exe';
  assert.equal(discover.repairExePath(missing), missing);
});

test('resolvePickedExe never hands back a directory', () => {
  const dir = xboxGame();
  const resolved = discover.resolvePickedExe(path.join(dir, 'Content'));
  assert.match(resolved, /FlightSimulator2024\.exe$/i);
});
