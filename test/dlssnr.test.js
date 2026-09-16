// The DLSS 5 settings, edited from this app instead of only from the in-game panel. These files
// are the game's own OptiScaler.ini -- the in-game panel reads and rewrites the same file -- so the
// rules that matter are: never lose anything else in it, and agree with the panel about what a
// default looks like on disk.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO, scratchDir, write } = require('./helpers');
const dlssnr = require(path.join(REPO, 'src', 'dlssnr'));
const { getIniKey } = require(path.join(REPO, 'src', 'ini-merge'));

// A shape close to the real release ini: other sections around the one being edited.
const INI = [
  '[Upscalers]',
  'Dx11Upscaler=dlss_12',
  'Dx12Upscaler=dlss',
  '',
  '[Menu]',
  'ShortcutKey=auto',
  'DisableSplash=auto',
  '',
  '[DlssNr]',
  '; DLSS 5 Neural Rendering.',
  'Enabled=auto',
  'RunBeforeSR=auto',
  'Passes=auto',
  'TransferStrength=auto',
  'Preset=auto',
  'AutoMask=auto',
  'WorkingScale=auto',
  '',
  '[Log]',
  'LogLevel=2',
  '',
].join('\n');

const freshIni = (name) => write(scratchDir(name), 'OptiScaler.ini', INI);
const valueOf = (file, key) => dlssnr.readSettings(file).find((f) => f.key === key).value;

test('every field is described well enough to build a control from', () => {
  for (const f of dlssnr.FIELDS) {
    assert.ok(f.key && f.label && f.help && f.group, `${f.key} is missing something`);
    assert.ok(['bool', 'int', 'float', 'enum', 'code'].includes(f.type), `${f.key} type`);
    if (f.type === 'enum' || f.type === 'code') assert.ok(Array.isArray(f.options) && f.options.length, `${f.key} options`);
    if (f.type === 'float' || f.type === 'int') {
      assert.equal(typeof f.min, 'number', `${f.key} min`);
      assert.equal(typeof f.max, 'number', `${f.key} max`);
      assert.ok(f.min < f.max, `${f.key} range`);
      if (f.default !== null) assert.ok(f.default >= f.min && f.default <= f.max, `${f.key} default is outside its own range`);
    }
    // A dependency has to name a field that exists, or a control greys itself out forever.
    if (f.dependsOn) assert.ok(dlssnr.FIELDS.some((o) => o.key === f.dependsOn.key), `${f.key} depends on a field that is not there`);
  }
});

test('auto reads as auto, not as a value', () => {
  const file = freshIni('nr-auto');
  const fields = dlssnr.readSettings(file);
  assert.ok(fields.every((f) => f.value === null), 'a fresh ini has nothing set');
  // The default is carried alongside so the form can show what auto actually means.
  assert.equal(fields.find((f) => f.key === 'MaxRatio').default, 2.0);
  assert.equal(fields.find((f) => f.key === 'AutoMask').default, true);
});

test('a value set back to its default is stored as auto, the way the panel stores it', () => {
  // The in-game panel's SaveIni writes "auto" for anything equal to its default. If this app wrote
  // the literal instead, every round trip through one of them would rewrite the other's work.
  const file = freshIni('nr-default');
  dlssnr.writeSettings(file, { TransferStrength: 1.4 });
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'TransferStrength'), '1.4');

  dlssnr.writeSettings(file, { TransferStrength: 1.0 });
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'TransferStrength'), 'auto');
  assert.equal(valueOf(file, 'TransferStrength'), null, 'and reads back as auto');

  dlssnr.writeSettings(file, { AutoMask: true });
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'AutoMask'), 'auto', 'bools too');
});

test('out-of-range values are clamped rather than written as given', () => {
  const file = freshIni('nr-clamp');
  dlssnr.writeSettings(file, { Passes: 9, WorkingScale: -3, MaxRatio: 99 });
  assert.equal(valueOf(file, 'Passes'), 3, 'Passes is clamped to 1..3');
  assert.equal(valueOf(file, 'WorkingScale'), 0.25);
  assert.equal(valueOf(file, 'MaxRatio'), 8);
});

test('an enum only accepts values it offers', () => {
  const file = freshIni('nr-enum');
  dlssnr.writeSettings(file, { Preset: 2 });
  assert.equal(valueOf(file, 'Preset'), 2);
  // 99 is not a model, so it is not stored as one.
  dlssnr.writeSettings(file, { Preset: 99 });
  assert.equal(valueOf(file, 'Preset'), null, 'a value the model does not have reads as auto');
});

test('nothing else in the file is touched', () => {
  const file = freshIni('nr-intact');
  dlssnr.writeSettings(file, { Enabled: true, Preset: 1, WorkingScale: 0.75 });
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(getIniKey(after, 'Upscalers', 'Dx11Upscaler'), 'dlss_12');
  assert.equal(getIniKey(after, 'Menu', 'ShortcutKey'), 'auto');
  assert.equal(getIniKey(after, 'Log', 'LogLevel'), '2');
  assert.match(after, /; DLSS 5 Neural Rendering\./, 'the section comments survive');
});

test('only what changed is written, and the keys written are reported', () => {
  const file = freshIni('nr-written');
  const first = dlssnr.writeSettings(file, { Enabled: true, Preset: 1 });
  assert.deepEqual(first.written.sort(), ['Enabled', 'Preset']);
  // Asking for the same values again is not a change.
  const second = dlssnr.writeSettings(file, { Enabled: true, Preset: 1 });
  assert.deepEqual(second.written, []);
  // A key this app does not know is ignored rather than written blindly into the user's file.
  const third = dlssnr.writeSettings(file, { NotARealKey: 'x' });
  assert.deepEqual(third.written, []);
  assert.ok(!/NotARealKey/.test(fs.readFileSync(file, 'utf8')));
});

test('a missing ini is an answer, not a crash', () => {
  const dir = scratchDir('nr-missing');
  const missing = path.join(dir, 'OptiScaler.ini');
  assert.ok(dlssnr.readSettings(missing).every((f) => f.value === null), 'reads as all-default');
  const res = dlssnr.writeSettings(missing, { Enabled: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

test('a file the in-game panel has already written round-trips unchanged', () => {
  const file = freshIni('nr-roundtrip');
  dlssnr.writeSettings(file, { Enabled: true, Passes: 2, Preset: 3, WorkingScale: 1.5, SkinStructure: -1 });
  const before = dlssnr.readSettings(file);
  // Writing back exactly what was read changes nothing at all.
  const values = Object.fromEntries(before.map((f) => [f.key, f.value]));
  const res = dlssnr.writeSettings(file, values);
  assert.deepEqual(res.written, [], 'a read followed by a write of the same values is a no-op');
  assert.deepEqual(dlssnr.readSettings(file), before);
});

// The language the two panels are written in is one value in one place -- the game's own
// [DlssNr] Language. It is the only setting here that is a string rather than a number or a bool,
// and it was getting dropped on the way back in: the engine lower-cases what it writes, and every
// comparison on the way through was case-sensitive.
test('Language round-trips as a code, whatever case the ini has it in', () => {
  const dir = scratchDir('dlssnr-language');
  const ini = path.join(dir, 'OptiScaler.ini');

  for (const written of ['pt-br', 'pt-BR', 'PT-BR', 'zh-cn', 'ZH-CN']) {
    write(dir, 'OptiScaler.ini', `[DlssNr]\nLanguage=${written}\n`);
    const field = dlssnr.readSettings(ini).find((f) => f.key === 'Language');
    assert.equal(field.value, written.toLowerCase(), `${written} should read back as a known code`);
  }

  // Anything this app does not ship reads as auto rather than as itself: a code nothing can render
  // would leave the panel blank in a language nobody chose.
  write(dir, 'OptiScaler.ini', '[DlssNr]\nLanguage=kl-GL\n');
  assert.equal(dlssnr.readSettings(ini).find((f) => f.key === 'Language').value, null);

  // auto is a real third state, and is what a language set back to default must write.
  write(dir, 'OptiScaler.ini', '[DlssNr]\nLanguage=de\n');
  assert.deepEqual(dlssnr.writeSettings(ini, { Language: null }).written, ['Language']);
  assert.equal(getIniKey(fs.readFileSync(ini, 'utf8'), 'DlssNr', 'Language'), 'auto');

  // And it is written as the engine writes it, so the in-game panel reads back what it set.
  assert.deepEqual(dlssnr.writeSettings(ini, { Language: 'zh-cn' }).written, ['Language']);
  assert.equal(getIniKey(fs.readFileSync(ini, 'utf8'), 'DlssNr', 'Language'), 'zh-cn');
});
