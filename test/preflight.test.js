// Checks before Install (src/preflight.js): each check against stubbed facts, the parsers for what
// gather() reads (reg.exe and tasklist output as this machine prints it), and the one registry write
// with a fake reg.exe. Nothing here touches the real registry.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pf = require('../src/preflight');
const { scratchDir, write } = require('./helpers');

const NVIDIA = { vendor: 'nvidia', vendorId: 0x10de, deviceId: 0x2f58, active: false };
const INTEL_IGPU = { vendor: 'intel', vendorId: 0x8086, deviceId: 0x7d67, active: true };
const EXE = 'D:\\Games\\Assassins Creed 2\\AssassinsCreedIIGame.exe';

const base = (over = {}) => ({
  exePath: EXE, dir: 'D:\\Games\\Assassins Creed 2', exes: [EXE],
  gpuInfo: { vendor: 'nvidia', devices: [NVIDIA], driver: { checked: true, outdated: false, branch: '620.10', minimum: '616.56' } },
  gpuPrefs: new Map(), running: new Set(), folderFiles: [], detected: { api: 'dx11' }, route: {}, run: null,
  antiCheat: null, antiCheatStub: null, displayScale: 100, ourReShade: false, probe: null, ...over,
});
const ids = (f) => pf.evaluate(f).map((c) => c.id);

test('a clean machine and folder has nothing to say', () => {
  assert.deepEqual(pf.evaluate(base()), []);
});

test('hybrid laptop without a GPU preference: offer High performance (Assassin\'s Creed II, 2026-09-18)', () => {
  const f = base({ gpuInfo: { ...base().gpuInfo, devices: [INTEL_IGPU, NVIDIA] } });
  const [check] = pf.evaluate(f);
  assert.equal(check.id, 'gpu-preference');
  assert.equal(check.severity, 'warn');
  assert.deepEqual(check.fix, { id: 'set-gpu-preference', exes: [EXE] });
  assert.equal(check.vars.exe, 'AssassinsCreedIIGame.exe');
  // Already on High performance: nothing to do. Another value in the same string is fine.
  const set = new Map([[EXE.toLowerCase(), { data: 'SwapEffectUpgradeEnable=1;GpuPreference=2;' }]]);
  assert.deepEqual(ids({ ...f, gpuPrefs: set }), []);
  // Power saving (1) is the wrong answer here, not "set".
  assert.deepEqual(ids({ ...f, gpuPrefs: new Map([[EXE.toLowerCase(), { data: 'GpuPreference=1;' }]]) }), ['gpu-preference']);
  // A desktop with one NVIDIA card, or a registry that could not be read: no finding.
  assert.deepEqual(ids(base()), []);
  assert.deepEqual(ids({ ...f, gpuPrefs: null }), []);
});

test('hybrid means NVIDIA plus integrated graphics, not NVIDIA plus a discrete card', () => {
  assert.equal(pf.isHybrid({ devices: [NVIDIA, INTEL_IGPU] }), true);
  assert.equal(pf.isHybrid({ devices: [NVIDIA, { vendorId: 0x1002, deviceId: 0x15bf }] }), true, 'an AMD APU');
  assert.equal(pf.isHybrid({ devices: [NVIDIA, { vendorId: 0x1002, deviceId: 0x744c }] }), false, 'a discrete Radeon');
  assert.equal(pf.isHybrid({ devices: [INTEL_IGPU] }), false);
});

test('the GPU preference string keeps whatever else Windows stored in it', () => {
  assert.equal(pf.withGpuPreference('AppStatus=4096;'), 'GpuPreference=2;AppStatus=4096;');
  assert.equal(pf.withGpuPreference('GpuPreference=1;SwapEffectUpgradeEnable=1;'), 'GpuPreference=2;SwapEffectUpgradeEnable=1;');
  assert.equal(pf.withGpuPreference(null), 'GpuPreference=2;');
  assert.equal(pf.gpuPreferenceOf('AppStatus=0;GpuPreference=2;'), 2);
  assert.equal(pf.gpuPreferenceOf(''), 0);
});

test('reg.exe output parses with spaces in the exe path, as this machine prints it', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\DirectX\\UserGpuPreferences\r\n' +
    '    D:\\Games\\Dragons Dogma 2\\DD2.exe    REG_SZ    AppStatus=4096;\r\n' +
    '    C:\\Program Files (x86)\\Steam\\steamapps\\common\\Batman Arkham Knight\\Binaries\\Win64\\BatmanAK.exe    REG_SZ    GpuPreference=2;\r\n\r\n';
  const v = pf.parseRegValues(out);
  assert.equal(v.get('d:\\games\\dragons dogma 2\\dd2.exe').data, 'AppStatus=4096;');
  assert.equal(pf.gpuPreferenceOf(v.get('c:\\program files (x86)\\steam\\steamapps\\common\\batman arkham knight\\binaries\\win64\\batmanak.exe').data), 2);
  const dpi = pf.parseRegValues('\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\\WindowMetrics\r\n    AppliedDPI    REG_DWORD    0x90\r\n\r\n');
  assert.equal(pf.scaleFromDpi(dpi.get('applieddpi').data), 150);
  assert.equal(pf.scaleFromDpi('0x60'), 100);
});

test('setting the preference writes one reg add per exe, merged with what was there', async () => {
  const calls = [];
  const execFileAsync = async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; };
  const prefs = new Map([[EXE.toLowerCase(), { data: 'AppStatus=4096;' }]]);
  const done = await pf.setGpuPreference([EXE], { execFileAsync, prefs });
  assert.deepEqual(calls, [['reg.exe', 'add', pf.GPU_PREF_KEY, '/v', EXE, '/t', 'REG_SZ', '/d', 'GpuPreference=2;AppStatus=4096;', '/f']]);
  assert.equal(done[0].data, 'GpuPreference=2;AppStatus=4096;');
});

test('RTSS running, or its hooks seen by a watched launch, is a warning; Afterburner alone is information', () => {
  assert.deepEqual(ids(base({ running: new Set(['rtss.exe']) })), ['overlay-rtss']);
  assert.deepEqual(ids(base({ probe: { overlays: ['RivaTuner Statistics Server'] } })), ['overlay-rtss']);
  const both = pf.evaluate(base({ running: new Set(['rtss.exe', 'msiafterburner.exe']) }));
  assert.deepEqual(both.map((c) => [c.id, c.severity]), [['overlay-rtss', 'warn'], ['overlay-afterburner', 'info']]);
});

test('Special K in the folder offers the folder; global injection says where to exclude the game', () => {
  const [local] = pf.evaluate(base({ folderFiles: ['SpecialK64.dll', 'game.exe'] }));
  assert.equal(local.id, 'overlay-specialk');
  assert.deepEqual(local.fix, { id: 'open-folder', path: 'D:\\Games\\Assassins Creed 2' });
  assert.deepEqual(ids(base({ running: new Set(['skif.exe']) })), ['overlay-specialk-global']);
});

test('a ReShade that is not ours is flagged; ours (a Feeder or Luma deploy) is not', () => {
  const f = base({ folderFiles: ['ReShade64.dll'], detected: { api: 'dx11', reshadeProxy: 'dxgi.dll' } });
  const [c] = pf.evaluate(f);
  assert.equal(c.id, 'reshade-foreign');
  assert.equal(c.vars.files, 'dxgi.dll, ReShade64.dll');
  assert.deepEqual(ids({ ...f, ourReShade: true }), []);
});

test("Nukem's dlssg_to_fsr3 files are flagged with the folder to open", () => {
  const [c] = pf.evaluate(base({ folderFiles: ['dlssg_to_fsr3_amd_is_better.dll', 'nvngx.dll'] }));
  assert.equal(c.id, 'dlssg-to-fsr3');
  assert.equal(c.fix.id, 'open-folder');
});

test('Smooth Motion is only claimed when a Feeder run saw it', () => {
  assert.deepEqual(ids(base({ run: { feedSmoothMotion: true } })), ['smooth-motion']);
  assert.deepEqual(ids(base({ run: { feedSmoothMotion: false } })), []);
});

test('anti-cheat warns either way and never withholds Install', () => {
  // With no stub this used to be a 'block', the one severity that takes Install away -- which made
  // this app the one deciding, about somebody else's account (2026-09-20). Both shapes warn now.
  // What they SAY is the difference between them, and the facts in the text did not soften.
  const stub = pf.evaluate(base({ antiCheat: 'EasyAntiCheat', antiCheatStub: { stub: 'start_protected_game.exe', antiCheat: 'EasyAntiCheat' } }));
  assert.deepEqual(stub.map((c) => [c.id, c.severity]), [['anti-cheat-stub', 'warn']]);
  const hard = pf.evaluate(base({ antiCheat: 'Vanguard', running: new Set(['rtss.exe']) }));
  assert.deepEqual(hard.map((c) => [c.id, c.severity]), [['anti-cheat', 'warn'], ['overlay-rtss', 'warn']]);
  assert.ok(/BANNED/.test(hard[0].text), 'the ban risk is still stated, and stated loudly');
  assert.ok(pf.evaluate(base({ antiCheat: 'Vanguard' })).every((c) => c.severity !== 'block'),
    'nothing about anti-cheat blocks Install any more');
});

test('display scaling above 100% warns on the dgVoodoo2 route for DX8/DX9 only (Assassin\'s Creed II at 150%)', () => {
  const dg = { legacy: { dgVoodoo: true }, dxvkDeployed: false, wrapperPreference: null };
  const [c] = pf.evaluate(base({ displayScale: 150, route: dg, detected: { api: 'dx9', legacyApis: ['dx9'] } }));
  assert.equal(c.id, 'dpi-dgvoodoo');
  assert.equal(c.vars.scale, '150');
  assert.equal(c.fix, null, 'no automatic fix');
  assert.deepEqual(ids(base({ displayScale: 100, route: dg, detected: { api: 'dx9' } })), []);
  assert.deepEqual(ids(base({ displayScale: 150, route: { ...dg, dxvkDeployed: true }, detected: { api: 'dx9' } })), [], 'DXVK in its place');
  assert.deepEqual(ids(base({ displayScale: 150, route: {}, detected: { api: 'dx11' } })), []);
});

test('an NVIDIA driver below the DLSS 5 floor is a warning with both numbers', () => {
  const [c] = pf.evaluate(base({ gpuInfo: { devices: [NVIDIA], driver: { checked: true, outdated: true, branch: '610.88', minimum: '616.56' } } }));
  assert.equal(c.id, 'driver-old');
  assert.deepEqual(c.vars, { branch: '610.88', minimum: '616.56' });
});

test('gather reads the folder and the anti-cheat helpers, and survives a registry it cannot read', async () => {
  const dir = scratchDir('preflight-gather');
  write(dir, 'Game.exe', 'MZ');
  write(dir, 'start_protected_game.exe', 'MZ');
  write(dir, 'EasyAntiCheat/EasyAntiCheat_x64.dll', 'x');
  const detect = require('../src/detect');
  const execFileAsync = async (file) => {
    if (file === 'tasklist.exe') return { stdout: '"RTSS.exe","123","Console","1","10,000 K"\r\n' };
    throw Object.assign(new Error('Access is denied'), { stderr: 'ERROR: Access is denied.' });
  };
  const f = await pf.gather({ exePath: `${dir}\\Game.exe`, dir, exes: [], gpuInfo: {}, detected: {}, route: {} }, { execFileAsync, detect });
  assert.equal(f.gpuPrefs, null, 'unreadable is not "nothing set"');
  assert.equal(f.displayScale, null);
  assert.ok(f.running.has('rtss.exe'));
  assert.ok(f.folderFiles.includes('start_protected_game.exe'));
  assert.equal(f.antiCheatStub.stub, 'start_protected_game.exe');
  assert.ok(f.antiCheat);
  // A missing key is "nothing set".
  const none = await pf.readGpuPrefs(async () => { throw Object.assign(new Error('x'), { stderr: 'ERROR: The system was unable to find the specified registry key or value.' }); });
  assert.deepEqual([...none], []);
});

// Asked for on 2026-09-19: "add support for 30 series" turned out to need no support added. The model
// this app deploys (ShortFuse's 310.8.SF-v2) already covers RTX 20/30/40 and the engine's NR path has
// no architecture check, so a 30-series card installs and runs today -- it is the cost that surprises
// people. Warn, never block: the user's call, on their own frame rate.
test('a pre-Blackwell NVIDIA card is warned about the neural pass cost, and never blocked', () => {
  const withCard = (name) => base({ gpuInfo: { ...base().gpuInfo, name } });

  const [ampere] = pf.evaluate(withCard('NVIDIA GeForce RTX 3080'));
  assert.equal(ampere.id, 'nr-cost-pre-ada');
  assert.equal(ampere.severity, 'warn', 'a warning, not a block');
  assert.deepEqual(ampere.vars, { card: 'NVIDIA GeForce RTX 3080' });
  assert.match(ampere.text, /138 FPS to 4/, 'the reported figure, attributed as a report');

  // Ada pays less than Ampere, so it gets its own milder wording rather than that figure.
  const [ada] = pf.evaluate(withCard('NVIDIA GeForce RTX 4070 Laptop GPU'));
  assert.equal(ada.id, 'nr-cost-ada');
  assert.equal(ada.severity, 'info');
  assert.doesNotMatch(ada.text, /138/);

  // The card the model was built for, a card too old to be an RTX at all, and a non-NVIDIA machine:
  // nothing to say in any of the three.
  assert.deepEqual(ids(withCard('NVIDIA GeForce RTX 5090')), []);
  assert.deepEqual(ids(withCard('NVIDIA GeForce GTX 1080')), []);
  assert.deepEqual(ids(base({ gpuInfo: { ...base().gpuInfo, vendor: 'amd', name: 'AMD Radeon RX 9070 XT' } })), []);
});

// Every check's sentence reaches the renderer as data and is translated with t(variable), which
// test/i18n-coverage.js cannot see -- so until 2026-09-19 none of this file's text had ever been
// translated, and a German user read every pre-install warning in English. The texts are read back out
// of the source here (by check id, both quote styles: one of them uses double quotes for "Nukem's"),
// so a check added later fails this until its translation is in.
function preflightTexts() {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preflight.js'), 'utf8');
  const lit = String.raw`(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")`;
  const re = new RegExp(String.raw`add\('([a-z0-9-]+)',\s*'(?:block|warn|info)',\s*((?:${lit}(?:\s*\+\s*)?)+)`, 'g');
  const out = new Map();
  for (const m of src.matchAll(re)) out.set(m[1], new Function(`return ${m[2]}`)());
  return out;
}

test('every locale translates every preflight check, keeping its placeholders', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const texts = preflightTexts();
  // Guards the extractor itself: a check whose text it cannot read would silently pass everything.
  const ids = [...texts.keys()].sort();
  assert.ok(ids.length >= 14, `extracted only ${ids.length} checks`);
  for (const id of ['gpu-preference', 'driver-old', 'dlssg-to-fsr3', 'anti-cheat', 'nr-cost-pre-ada']) {
    assert.ok(texts.has(id), `${id} was not extracted`);
    assert.ok(texts.get(id).length > 40, `${id}'s text looks truncated`);
  }

  const dir = path.join(__dirname, '..', 'src', 'renderer', 'locales');
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const marks = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    let dict = null;
    new Function('window', fs.readFileSync(path.join(dir, file), 'utf8'))({ I18N: { register: (_c, d) => { dict = d; } } });
    const have = new Map(Object.entries(dict).map(([k, v]) => [norm(k), v]));
    for (const [id, english] of texts) {
      assert.ok(have.has(norm(english)), `${file} is missing the ${id} check`);
      assert.equal(marks(have.get(norm(english))), marks(english), `${file} placeholders for ${id}`);
    }
  }
});
