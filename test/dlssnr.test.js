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
  'ChainedHistory=auto',
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
    // { all: [...] } names several (Adaptive resolution's targets need it on AND the matching mode); { any: [...] }
    // too (Enlargement matters whenever the model runs small, whichever setting made it).
    if (f.dependsOn) {
      // The groups nest, and both evaluators (panel.js, renderer.js) recurse, so this walk does too:
      // Enlargement's third clause is an { all: [...] } inside the { any: [...] }.
      const walk = (d) => {
        const list = d.all || d.any;
        if (list) { for (const c of list) walk(c); return; }
        assert.ok(dlssnr.FIELDS.some((o) => o.key === d.key), `${f.key} depends on a field that is not there`);
      };
      walk(f.dependsOn);
    }
  }
});

test('auto reads as auto, not as a value', () => {
  const file = freshIni('nr-auto');
  const fields = dlssnr.readSettings(file);
  assert.ok(fields.every((f) => f.value === null), 'a fresh ini has nothing set');
  // The default is carried alongside so the form can show what auto actually means.
  assert.equal(fields.find((f) => f.key === 'MaxRatio').default, 2.0);
  assert.equal(fields.find((f) => f.key === 'ChainedHistory').default, true);
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

  dlssnr.writeSettings(file, { ChainedHistory: true });
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'ChainedHistory'), 'auto', 'bools too');
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

test('the borderless window is a switch of its own, written the way the engine reads it', () => {
  // [DlssNr] ForceBorderless: Lossless Scaling turned it on behind the scenes (applyLosslessMarker);
  // this offers the same switch directly, in Edit and in the pop-out panel. Where the engine has no
  // hold on the window -- the 32-bit route, OpenGL, Vulkan -- dlssnr:get holds it off with a reason
  // rather than offering a switch that does nothing.
  const field = dlssnr.FIELDS.find((f) => f.key === 'ForceBorderless');
  assert.ok(field, 'the field exists');
  assert.equal(field.type, 'bool');
  assert.equal(field.default, false);
  assert.equal(field.group, 'Window');
  assert.ok(dlssnr.GROUPS.includes('Window'), 'its group is listed for the form');
  assert.match(field.help, /not the picture/, 'the help says what it does not do: change render resolution');

  const ini = freshIni('dlssnr-borderless');

  const on = dlssnr.writeSettings(ini, { ForceBorderless: true });
  assert.ok(on.ok);
  assert.equal(getIniKey(fs.readFileSync(ini, 'utf8'), 'DlssNr', 'ForceBorderless'), 'true');
  assert.equal(dlssnr.readSettings(ini).find((f) => f.key === 'ForceBorderless').value, true);

  // Back to default is stored as auto, as every other field is, so the engine's own default applies.
  const off = dlssnr.writeSettings(ini, { ForceBorderless: false });
  assert.ok(off.ok);
  assert.equal(getIniKey(fs.readFileSync(ini, 'utf8'), 'DlssNr', 'ForceBorderless'), 'auto');
});

test('the window size rides on the borderless switch and is written as the engine reads it', () => {
  // [DlssNr] BorderlessWidth / BorderlessHeight (engine v1.0.38): 0 is the monitor; both or neither
  // count, which the engine enforces. Greyed unless the switch is on, since it is meaningless alone.
  const w = dlssnr.FIELDS.find((f) => f.key === 'BorderlessWidth');
  const h = dlssnr.FIELDS.find((f) => f.key === 'BorderlessHeight');
  for (const f of [w, h]) {
    assert.ok(f, 'both fields exist');
    assert.equal(f.type, 'int');
    assert.equal(f.default, 0);
    assert.equal(f.group, 'Window');
    assert.deepEqual(f.dependsOn, { key: 'ForceBorderless', is: true });
    assert.match(f.help, /both width and height or neither/i, 'the help states the both-or-neither rule');
  }
  assert.match(w.help, /not something this controls/, 'the help does not promise a render-resolution change');

  const ini = freshIni('dlssnr-window-size');
  assert.ok(dlssnr.writeSettings(ini, { ForceBorderless: true, BorderlessWidth: 1920, BorderlessHeight: 1080 }).ok);
  const text = fs.readFileSync(ini, 'utf8');
  assert.equal(getIniKey(text, 'DlssNr', 'BorderlessWidth'), '1920');
  assert.equal(getIniKey(text, 'DlssNr', 'BorderlessHeight'), '1080');

  // Out of range is clamped, as every other field is, and back to 0 is stored as auto.
  assert.ok(dlssnr.writeSettings(ini, { BorderlessWidth: 99999 }).ok);
  assert.equal(getIniKey(fs.readFileSync(ini, 'utf8'), 'DlssNr', 'BorderlessWidth'), '7680');
  assert.ok(dlssnr.writeSettings(ini, { BorderlessWidth: 0, BorderlessHeight: 0 }).ok);
  assert.equal(getIniKey(fs.readFileSync(ini, 'utf8'), 'DlssNr', 'BorderlessWidth'), 'auto');
  assert.equal(getIniKey(fs.readFileSync(ini, 'utf8'), 'DlssNr', 'BorderlessHeight'), 'auto');
});

// [DlssNr] PanelKey. Alt+Home has always been rebindable in the engine and this app never offered
// it, so #50's reporter asked for a feature that already existed. The trap in exposing it as a
// picker is the bind that is NOT on the list: read that back as "default" and the dialog is lying
// about the player's own key, and the first edit of any other field looks like it moved it.
test('the panel hotkey reads back whatever is set, listed or not', () => {
  const dir = scratchDir('dlssnr-panelkey');
  const ini = path.join(dir, 'OptiScaler.ini');
  const panelKey = (text) => {
    write(dir, 'OptiScaler.ini', text);
    return dlssnr.readSettings(ini).find((f) => f.key === 'PanelKey');
  };

  const VK_HOME = 0x24, ALT = 0x0100, CTRL = 0x0200, SHIFT = 0x0400;

  const unset = panelKey('[DlssNr]\nPanelKey=auto\n');
  assert.equal(unset.value, null, 'auto is auto, not the default written out');
  // Insert since engine v2.2.7: one key for this project's panel on every route.
  assert.equal(unset.default, 0x2D, 'the default is Insert, as the engine has it');

  const plainHome = panelKey(`[DlssNr]\nPanelKey=${VK_HOME}\n`);
  assert.equal(plainHome.value, VK_HOME);
  assert.ok(plainHome.options.some(([v, l]) => v === VK_HOME && l === 'Home'));

  // Ctrl+Shift+F7: a real bind the list does not offer.
  const custom = 0x76 | CTRL | SHIFT;
  const chosen = panelKey(`[DlssNr]\nPanelKey=${custom}\n`);
  assert.equal(chosen.value, custom, "a key the player chose is not read back as the default");
  const extra = chosen.options.find(([v]) => v === custom);
  assert.ok(extra, 'an unlisted bind gets an option of its own so the picker can show it');
  assert.match(extra[1], /^Ctrl\+Shift\+/, 'and it is named by its modifiers');

  // The engine writes hex for these (Config.cpp GetIntValue with the hex flag), so both forms read.
  const hex = panelKey('[DlssNr]\nPanelKey=0x124\n');
  assert.equal(hex.value, VK_HOME | ALT, 'hex reads the same as decimal, as the engine writes it');
});

test('the panel hotkey is offered where the dialog can reach it', () => {
  // The Settings dialog renders only the Display group (renderer.js EDITABLE_GROUPS). A hotkey in
  // any other group would be in the file and reachable from nowhere.
  const field = dlssnr.readSettings(path.join(scratchDir('dlssnr-panelkey-group'), 'none.ini'))
    .find((f) => f.key === 'PanelKey');
  assert.equal(field.group, 'Window');
});

// Issue #55 (inZOI, 2026-09-19): Before Super Resolution together with UI correction froze the game on
// the spot. Turning either on switches the other off in the same write, as the in-game panel does.
test('Before Super Resolution and UI correction are never both on', () => {
  const file = freshIni('nr-exclusive');
  dlssnr.writeSettings(file, { RunBeforeSR: true });
  assert.equal(valueOf(file, 'RunBeforeSR'), true);
  assert.equal(valueOf(file, 'UICorrection'), false, 'UI correction goes off with the pass before SR');

  dlssnr.writeSettings(file, { UICorrection: true });
  assert.notEqual(valueOf(file, 'RunBeforeSR'), true, 'Before SR goes off when UI correction comes back');
  assert.notEqual(valueOf(file, 'UICorrection'), false);

  // Turning one OFF leaves the other alone, and a write that names both keeps what it was given.
  dlssnr.writeSettings(file, { UICorrection: false });
  assert.notEqual(valueOf(file, 'RunBeforeSR'), true);
  dlssnr.writeSettings(file, { RunBeforeSR: true, UICorrection: false });
  assert.equal(valueOf(file, 'RunBeforeSR'), true);
});

// The up-leg's filter (engine v2.2.4). Before it existed this direction had no control at all: it
// was FSR1 if the downscale filter happened to be FSR1 and bicubic otherwise. The engine keeps that
// rule for an unset key, so the row's default has to be null -- a number here would be a confident
// label over a picture that depends on the row above.
test('the upscale filter offers no FSR1 and defaults to the one that cannot go wrong', () => {
  const field = dlssnr.FIELDS.find((f) => f.key === 'ScalingUpscaler');

  // FSR1 stays a DOWNscaler. It is still the first entry of the downscale list beside this one, so
  // this also guards against the two lists being wired to the same constant by mistake.
  assert.deepEqual(field.options.map(([, name]) => name),
    ['Bicubic', 'EWA Lanczos', 'xBR-lv2', 'Sharp bilinear', 'Integer scale', 'Nearest']);
  const downscaleRow = dlssnr.FIELDS.find((f) => f.key === 'ScalingDownscaler');
  assert.equal(downscaleRow.options[0][1], 'FSR1');

  assert.equal(field.default, 0);
  assert.equal(field.options[field.default][1], 'Bicubic');

  // It is the enlarging direction, so it belongs to a model running SMALLER than the frame. The
  // downscale filter beside it is the opposite case, and showing both at once would offer a choice
  // that does nothing.
  assert.deepEqual(field.dependsOn, { key: 'WorkingScale', below: 1 });
  const down = dlssnr.FIELDS.find((f) => f.key === 'ScalingDownscaler');
  assert.deepEqual(down.dependsOn, { key: 'WorkingScale', above: 1 });
});

test('an ini with no upscale filter reads as auto and writing one puts the number in', () => {
  const file = freshIni('nr-upscaler');
  assert.equal(valueOf(file, 'ScalingUpscaler'), null);

  const result = dlssnr.writeSettings(file, { ScalingUpscaler: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.written, ['ScalingUpscaler']);
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'ScalingUpscaler'), '2');
  assert.equal(valueOf(file, 'ScalingUpscaler'), 2);
});

// Someone who tried xBR on a 3D game has to be able to get back, and picking the default in the
// list is how they will do it -- so that has to land on disk as auto, the way every other row does.
test('the upscale filter set back to its default is stored as auto', () => {
  const file = freshIni('nr-upscaler-back');
  dlssnr.writeSettings(file, { ScalingUpscaler: 2 });

  const result = dlssnr.writeSettings(file, { ScalingUpscaler: 0 });
  assert.deepEqual(result.written, ['ScalingUpscaler']);
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'ScalingUpscaler'), 'auto');
  assert.equal(valueOf(file, 'ScalingUpscaler'), null);
});

// The four tuning rows only do anything to EWA Lanczos. The engine reads them for that filter
// alone, so offering any of them beside Nearest would be a control that does nothing.
const TUNING = ['ScalingSharpness', 'ScalingAntiRinging', 'ScalingSigmoid', 'ScalingDither'];

test('the tuning rows are shown only for EWA Lanczos', () => {
  const ewaLanczos = dlssnr.FIELDS.find((f) => f.key === 'ScalingUpscaler')
    .options.find(([, name]) => name === 'EWA Lanczos')[0];

  for (const key of TUNING) {
    const field = dlssnr.FIELDS.find((f) => f.key === key);
    assert.deepEqual(field.dependsOn, {
      all: [{ key: 'WorkingScale', below: 1 }, { key: 'ScalingUpscaler', is: ewaLanczos }],
    });
  }
});

// Four identical sliders read as one set to be balanced against each other. A checkbox among them
// would read as an unrelated thing that happens to sit there -- and Sigmoid WAS a checkbox before
// the engine made its strength the curve's slope.
test('every tuning row is a percentage slider from zero', () => {
  for (const key of TUNING) {
    const field = dlssnr.FIELDS.find((f) => f.key === key);
    assert.equal(field.type, 'float', key);
    assert.equal(field.min, 0, key);
    assert.equal(field.max, 1, key);
    assert.equal(field.percent, true, key);
  }
});

// The panel window only ever sees what readSettings hands it over IPC, so the flag that makes a
// group open on a press has to travel on the fields themselves.
test('the upscale filter group is marked collapsed and the everyday groups are not', () => {
  const rows = dlssnr.readSettings(freshIni('nr-collapsed'));
  const upscale = rows.filter((f) => f.group === 'Upscale filter');

  assert.equal(upscale.length, 5);
  assert.ok(upscale.every((f) => f.collapsed === true));
  assert.ok(rows.filter((f) => f.group !== 'Upscale filter').every((f) => f.collapsed === false));

  // And it has to be somewhere in the order, or it would fall in after the panel's own settings.
  assert.ok(dlssnr.GROUPS.includes('Upscale filter'));
});

// These are the NR pass's own keys, not Output Scaling's. Both passes have a set and they used to
// share one, so setting one moved the other.
test('the tuning rows write the DlssNr keys', () => {
  const file = freshIni('nr-upscaler-tuning');
  for (const key of TUNING) assert.equal(valueOf(file, key), null);

  dlssnr.writeSettings(file, { ScalingSharpness: 0.5, ScalingAntiRinging: 0.5, ScalingSigmoid: 0.5, ScalingDither: 0.5 });
  const text = fs.readFileSync(file, 'utf8');
  for (const key of TUNING) assert.equal(getIniKey(text, 'DlssNr', key), '0.5', key);

  // And the defaults still fold back to auto, the way every other row does. Ring suppression's is
  // 0.8 and the other three are 0, so this also proves the fold is per-field and not a blanket zero.
  dlssnr.writeSettings(file, { ScalingSharpness: 0, ScalingAntiRinging: 0.8, ScalingSigmoid: 0, ScalingDither: 0 });
  const back = fs.readFileSync(file, 'utf8');
  for (const key of TUNING) assert.equal(getIniKey(back, 'DlssNr', key), 'auto', key);
});

// The Present route had no motion vectors in some games and kept accumulating temporal history
// anyway, against vectors that said nothing had moved -- which is the rippling across textures in
// motion that no setting could touch, because nothing about it was a setting. Engine v2.2.5 resets
// the history instead, and this row is how a game that would rather have the old behaviour gets it.
test('forgetting history when motion is unknown is offered, on, beside the other model inputs', () => {
  const field = dlssnr.FIELDS.find((f) => f.key === 'ResetWhenBlind');

  assert.equal(field.type, 'bool');
  assert.equal(field.default, true);
  assert.equal(field.group, 'What the model is told');

  // It has no dependency: the condition it covers is a route and a game's depth buffer, neither of
  // which is a row in this dialog, so there is nothing here to hide it behind.
  assert.equal(field.dependsOn, undefined);

  // It is the fix for a visible artefact, so the help has to name the symptom in the words someone
  // would use for it, or nobody finds the row that fixes what they are looking at.
  assert.match(field.help, /pulse|ripple|swim/i);
});

test('the default folds back to auto so the engine decides, like every other row', () => {
  const file = freshIni('nr-reset-when-blind');
  assert.equal(valueOf(file, 'ResetWhenBlind'), null);

  assert.deepEqual(dlssnr.writeSettings(file, { ResetWhenBlind: false }).written, ['ResetWhenBlind']);
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'ResetWhenBlind'), 'false');

  dlssnr.writeSettings(file, { ResetWhenBlind: true });
  assert.equal(getIniKey(fs.readFileSync(file, 'utf8'), 'DlssNr', 'ResetWhenBlind'), 'auto');
});
