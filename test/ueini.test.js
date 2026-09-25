'use strict';
// Engine.ini for UE-Extended's native-HDR path (src/ueini.js): where it goes, what is merged, that it
// ends read-only (the game deletes an unchanged Engine.ini on exit), and that Remove undoes exactly
// what Install did.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ueini = require('../src/ueini');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-ueini-'));
  const localAppData = path.join(root, 'Local');
  fs.mkdirSync(localAppData);
  const exe = path.join(root, 'Games', 'The Blood of Dawnwalker', 'Dawnwalker', 'Binaries', 'Win64', 'Dawnwalker.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'MZ');
  return { root, localAppData, exe };
}

test('the project folder is the one above Binaries; WinGDK for a Store build', () => {
  const lad = path.join(os.tmpdir(), 'lad');
  const loc = ueini.engineIniLocation('D:\\Games\\The Blood of Dawnwalker\\Dawnwalker\\Binaries\\Win64\\Dawnwalker.exe', { localAppData: lad });
  assert.equal(loc.project, 'Dawnwalker');
  assert.equal(loc.platform, 'Windows');
  assert.equal(loc.file, path.join(lad, 'Dawnwalker', 'Saved', 'Config', 'Windows', 'Engine.ini'));
  const gdk = ueini.engineIniLocation('C:\\XboxGames\\Hell is Us\\Content\\HellIsUs\\Binaries\\WinGDK\\HellIsUs-WinGDK-Shipping.exe', { localAppData: lad });
  assert.equal(gdk.project, 'HellIsUs');
  assert.equal(gdk.platform, 'WinGDK');
  // Not an Unreal layout: nothing is guessed.
  assert.equal(ueini.engineIniLocation('D:\\Games\\Foo\\foo.exe', { localAppData: lad }), null);
  assert.equal(ueini.engineIniLocation('D:\\Games\\Foo\\Engine\\Binaries\\Win64\\x.exe', { localAppData: lad }), null);
});

test('merge replaces our keys in [SystemSettings], adds the missing ones, keeps everything else', () => {
  const before = '[Core.System]\r\nPaths=../x\r\n\r\n[SystemSettings]\r\nr.AllowHDR=0\r\nr.Tonemapper.Sharpen=1\r\n\r\n[/Script/Engine.RendererSettings]\r\nr.Foo=2\r\n';
  const out = ueini.mergeHdrKeys(before);
  assert.match(out, /\[Core\.System\]\r\nPaths=\.\.\/x/);
  assert.match(out, /r\.AllowHDR=1/);
  assert.doesNotMatch(out, /r\.AllowHDR=0/);
  assert.match(out, /r\.Tonemapper\.Sharpen=1/);
  assert.match(out, /\[\/Script\/Engine\.RendererSettings\]\r\nr\.Foo=2/);
  for (const [k, v] of ueini.HDR_KEYS) assert.equal(out.split(`${k}=${v}`).length - 1, 1, `${k} once`);
  // Our keys land inside [SystemSettings], before the next section.
  const sys = out.slice(out.indexOf('[SystemSettings]'), out.indexOf('[/Script'));
  for (const [k] of ueini.HDR_KEYS) assert.ok(sys.includes(k), `${k} is in [SystemSettings]`);
  // No section at all: it is added.
  assert.match(ueini.mergeHdrKeys('[Core.System]\nA=1\n'), /\[Core\.System\]\nA=1\n\n\[SystemSettings\]\nr\.AllowHDR=1/);
});

test('install creates the file read-only; remove deletes it and the folders it made', () => {
  const { localAppData, exe } = scratch();
  const rec = ueini.applyEngineIniHdr(exe, { localAppData });
  const file = path.join(localAppData, 'Dawnwalker', 'Saved', 'Config', 'Windows', 'Engine.ini');
  assert.equal(rec.file, file);
  assert.equal(rec.created, true);
  assert.equal(rec.backup, null);
  assert.ok(ueini.isReadOnly(file), 'read-only, or the game deletes it on exit');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\[SystemSettings\]/);
  for (const [k, v] of ueini.HDR_KEYS) assert.ok(text.includes(`${k}=${v}`));

  const r = ueini.revertEngineIniHdr(JSON.parse(JSON.stringify(rec)));
  assert.equal(r.deleted, true);
  assert.ok(!fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(localAppData, 'Dawnwalker')), 'the folders we made are gone');
});

test('install over an existing Engine.ini merges, backs up once, and remove restores the original', () => {
  const { localAppData, exe } = scratch();
  const dir = path.join(localAppData, 'Dawnwalker', 'Saved', 'Config', 'Windows');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Engine.ini');
  const original = '[SystemSettings]\nr.AllowHDR=0\nr.Mine=7\n';
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o444); // already read-only (the player's own trick): still handled

  const rec = ueini.applyEngineIniHdr(exe, { localAppData });
  assert.equal(rec.created, false);
  assert.equal(rec.backup, file + ueini.BACKUP_SUFFIX);
  assert.equal(fs.readFileSync(rec.backup, 'utf8'), original);
  const merged = fs.readFileSync(file, 'utf8');
  assert.match(merged, /r\.AllowHDR=1/);
  assert.match(merged, /r\.Mine=7/);
  assert.ok(ueini.isReadOnly(file));

  // A second apply keeps the first backup (the real original), not our edited copy.
  const rec2 = ueini.applyEngineIniHdr(exe, { localAppData });
  assert.equal(fs.readFileSync(rec2.backup, 'utf8'), original);

  const r = ueini.revertEngineIniHdr(rec2);
  assert.equal(r.restored, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!fs.existsSync(rec.backup));
  assert.ok(!ueini.isReadOnly(file), 'writable again');
  assert.ok(fs.existsSync(dir), 'folders that were there stay');
});

test('a file we created that has gained other lines keeps them; only our keys come out', () => {
  const { localAppData, exe } = scratch();
  const rec = ueini.applyEngineIniHdr(exe, { localAppData });
  fs.chmodSync(rec.file, 0o666);
  fs.appendFileSync(rec.file, '[Core.Log]\nLogFoo=Verbose\n');
  const r = ueini.revertEngineIniHdr(rec);
  assert.equal(r.deleted, false);
  assert.equal(r.stripped, true);
  const left = fs.readFileSync(rec.file, 'utf8');
  assert.match(left, /\[Core\.Log\]\nLogFoo=Verbose/);
  assert.doesNotMatch(left, /r\.HDR|SystemSettings/);
});

test('no Unreal project folder: nothing is written, the reason is returned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-ueini-'));
  const rec = ueini.applyEngineIniHdr(path.join(root, 'game.exe'), { localAppData: root });
  assert.equal(rec.skipped, 'no-project');
  assert.deepEqual(ueini.revertEngineIniHdr(rec), { restored: false, deleted: false, stripped: false, removedDirs: [] });
});

test('the player\'s own ReShade.ini Set_Path wins over the table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-ueini-'));
  assert.equal(ueini.wantsNativeHdr({ nativeHdr: true }, dir), true, 'table default');
  assert.equal(ueini.wantsNativeHdr(null, dir), false);
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[GENERAL]\nX=1\n[renodx]\nSet_Path=0.000000\n');
  assert.equal(ueini.reshadeSetPath(dir), 0);
  assert.equal(ueini.wantsNativeHdr(null, dir), true);
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[renodx]\nSet_Path=1\n');
  assert.equal(ueini.wantsNativeHdr({ nativeHdr: true }, dir), false);
});
