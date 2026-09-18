'use strict';
// A launch that falls over (launchwatch.js), antivirus taking a file (defender.js), and the rules
// around both: nothing is restored without a click, and every new string is translated.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lw = require('../src/launchwatch');
const defender = require('../src/defender');

const root = path.join(__dirname, '..', 'src');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererJs = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-safety-'));
}

// ── launchwatch ──────────────────────────────────────────────────────────────────────────────

test('the tasklist listing is read as lower-case image names', () => {
  const out = '"System Idle Process","0","Services","0","8 K"\r\n"re2.exe","1234","Console","1","2,000,000 K"\r\n\r\n"Cyberpunk2077.exe","99","Console","1","1 K"';
  const names = lw.runningImageNames(out);
  assert.ok(names.has('re2.exe'));
  assert.ok(names.has('cyberpunk2077.exe'));
  assert.ok(names.has('system idle process'));
  assert.strictEqual(lw.runningImageNames('').size, 0);
});

test('a game that comes up and goes away inside 30 s is an early exit', () => {
  const w = lw.createWatch({ exeName: 'Game.exe', startedAt: 0 });
  assert.strictEqual(lw.step(w, false, 3000), null, 'not up yet');
  assert.strictEqual(lw.step(w, true, 6000), null);
  assert.strictEqual(lw.step(w, true, 9000), null);
  assert.strictEqual(lw.step(w, false, 12000), null, 'one missed poll is not enough');
  assert.deepStrictEqual(lw.step(w, false, 15000), { kind: 'early-exit', upMs: 3000 });
});

test('a game that restarts itself is not an early exit, and one that stays up is fine', () => {
  const w = lw.createWatch({ exeName: 'game.exe', startedAt: 0 });
  lw.step(w, true, 3000);
  assert.strictEqual(lw.step(w, false, 6000), null, 'gone for one poll (Steam DRM restart)');
  assert.strictEqual(lw.step(w, true, 9000), null, 'and back');
  assert.strictEqual(lw.step(w, true, 30000), null);
  assert.deepStrictEqual(lw.step(w, true, 3000 + lw.EARLY_EXIT_MS), { kind: 'ok' });
});

test('a game that never appears is reported only after the appear window, longer through a launcher', () => {
  const direct = lw.createWatch({ exeName: 'g.exe', startedAt: 1000 });
  assert.strictEqual(lw.step(direct, false, 1000 + lw.APPEAR_MS - 1), null);
  assert.deepStrictEqual(lw.step(direct, false, 1000 + lw.APPEAR_MS), { kind: 'never-started' });
  const viaLauncher = lw.createWatch({ exeName: 'g.exe', startedAt: 0, via: 'launcher' });
  assert.strictEqual(lw.step(viaLauncher, false, lw.APPEAR_MS), null, 'a sign-in screen takes time');
  assert.deepStrictEqual(lw.step(viaLauncher, false, lw.APPEAR_LAUNCHER_MS), { kind: 'never-started' });
});

test('"first run since the install" follows the recorded install stamp, not the journal\'s mtime', () => {
  const dir = tmpDir();
  try {
    assert.strictEqual(lw.firstRunSinceInstall(dir, {}), false, 'nothing installed');
    const at = Date.parse('2026-09-18T20:00:00Z');
    fs.writeFileSync(path.join(dir, '.optiscaler-manager-install.json'), JSON.stringify({ installedAt: new Date(at).toISOString(), added: [] }));
    assert.strictEqual(lw.installedAt(dir), at);
    const key = dir.toLowerCase();
    assert.strictEqual(lw.firstRunSinceInstall(dir, {}), true, 'never launched');
    assert.strictEqual(lw.firstRunSinceInstall(dir, { [key]: at - 1000 }), true, 'last launch was before the install');
    assert.strictEqual(lw.firstRunSinceInstall(dir, { [key]: at + 1000 }), false, 'already launched since');
    // A later step rewrites the journal (Streamline, REFramework...) without a new install.
    fs.writeFileSync(path.join(dir, '.optiscaler-manager-install.json'), JSON.stringify({ installedAt: new Date(at).toISOString(), reframework: true }));
    assert.strictEqual(lw.firstRunSinceInstall(dir, { [key]: at + 1000 }), false);
    // A Feeder deploy after that is a new install.
    fs.writeFileSync(path.join(dir, '.dlss5ui-feeder-deploy.json'), JSON.stringify({ deployedAt: new Date(at + 5000).toISOString() }));
    assert.strictEqual(lw.firstRunSinceInstall(dir, { [key]: at + 1000 }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker without a stamp falls back to its mtime', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, '.dlss5ui-lumaue-deploy.json'), '{}');
    const at = lw.installedAt(dir);
    assert.ok(at && Math.abs(at - Date.now()) < 60_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what the renderer is told: early exits always, a no-show only with anti-cheat to blame', () => {
  const early = lw.outcomeNotice({ kind: 'early-exit', upMs: 4400 }, { exePath: 'C:\\g\\g.exe', canRestore: true, firstRun: true });
  assert.deepStrictEqual(early, { exePath: 'C:\\g\\g.exe', kind: 'early-exit', upSeconds: 4, firstRun: true, antiCheat: null, canRestore: true });
  assert.strictEqual(lw.outcomeNotice({ kind: 'early-exit', upMs: 0 }, {}).upSeconds, 1, 'never "0 s"');
  assert.strictEqual(lw.outcomeNotice({ kind: 'never-started' }, { exePath: 'x' }), null, 'Steam updating is not our business');
  assert.strictEqual(lw.outcomeNotice({ kind: 'never-started' }, { exePath: 'x', antiCheat: 'EasyAntiCheat' }).kind, 'never-started');
  assert.deepStrictEqual(lw.outcomeNotice({ kind: 'ok' }, { exePath: 'x' }), { exePath: 'x', kind: 'ok' });
  assert.strictEqual(lw.outcomeNotice(null, {}), null);
});

// ── defender ─────────────────────────────────────────────────────────────────────────────────

test('Defender resource strings become plain lower-case paths', () => {
  assert.strictEqual(defender.resourcePath('file:_C:\\Games\\RE2\\dxgi.dll'), 'c:\\games\\re2\\dxgi.dll');
  assert.strictEqual(defender.resourcePath('containerfile:_C:\\Users\\a\\AppData\\cache\\dgVoodoo2_87_4.zip'), 'c:\\users\\a\\appdata\\cache\\dgvoodoo2_87_4.zip');
  assert.strictEqual(defender.resourcePath('webfile:_C:\\Users\\a\\Downloads\\x.zip|https://example.com/x.zip|pid:1'), 'c:\\users\\a\\downloads\\x.zip');
  assert.strictEqual(defender.resourcePath('regkey:_HKLM\\Software\\x'), null);
  assert.strictEqual(defender.resourcePath(''), null);
});

test('detections parse from one object, an array, nothing, or garbage', () => {
  const one = JSON.stringify({ id: 2147735503, name: 'Trojan:Win32/Kepavll!rfn', at: '2026-09-14T10:00:00Z', resources: 'file:_C:\\Games\\X\\D3D9.dll' });
  const parsed = defender.parseDetections(one);
  assert.strictEqual(parsed.length, 1);
  assert.deepStrictEqual(parsed[0].resources, ['c:\\games\\x\\d3d9.dll']);
  assert.strictEqual(parsed[0].id, '2147735503');
  assert.strictEqual(defender.parseDetections(JSON.stringify([JSON.parse(one), JSON.parse(one)])).length, 2);
  assert.deepStrictEqual(defender.parseDetections(''), []);
  assert.deepStrictEqual(defender.parseDetections('not json'), []);
});

test('a detection matches a file or anything under a folder, never a sibling folder with a longer name', () => {
  const dets = defender.parseDetections(JSON.stringify([
    { id: '1', name: 'A', at: '2026-09-18T10:00:00Z', resources: ['file:_C:\\Games\\X\\dxgi.dll'] },
    { id: '2', name: 'B', at: '2026-09-18T11:00:00Z', resources: ['file:_C:\\Games\\XY\\dxgi.dll'] },
    { id: '3', name: 'C', at: '2026-09-18T12:00:00Z', resources: ['file:_C:\\Cache\\dg\\MS\\x86\\D3D9.dll'] },
    { id: '4', name: 'D', at: '2026-01-01T00:00:00Z', resources: ['file:_C:\\Games\\X\\old.dll'] },
  ]));
  const hits = defender.matchDetections(dets, ['C:\\Games\\X\\', 'C:\\Cache\\dg'], { since: Date.parse('2026-09-01T00:00:00Z') });
  assert.deepStrictEqual(hits.map((h) => h.threat), ['C', 'A'], 'newest first; XY and the old one left out');
  assert.strictEqual(hits[1].file, 'c:\\games\\x\\dxgi.dll');
  assert.deepStrictEqual(defender.matchDetections(dets, ['C:\\Games\\X\\dxgi.dll']).map((h) => h.threat), ['A']);
});

test('Defender is asked once through PowerShell, and an unanswerable query is null, not "nothing found"', async () => {
  const calls = [];
  const execFileAsync = async (file, args) => {
    calls.push([file, args]);
    return { stdout: JSON.stringify([{ id: '9', name: 'Trojan:Win32/Kepavll!rfn', at: new Date().toISOString(), resources: ['file:_C:\\G\\dgVoodooCpl.exe'] }]) };
  };
  const hits = await defender.defenderRemovals(['C:\\G'], { execFileAsync });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'powershell.exe');
  assert.match(calls[0][1].join(' '), /Get-MpThreatDetection/);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].threat, 'Trojan:Win32/Kepavll!rfn');
  assert.deepStrictEqual(await defender.defenderRemovals(['C:\\G'], { execFileAsync: async () => ({ stdout: '' }) }), []);
  assert.strictEqual(await defender.defenderRemovals(['C:\\G'], { execFileAsync: async () => { throw new Error('not recognized'); } }), null);
});

test('only what a finished install leaves in place is checked -- never the renamed OptiScaler.dll', () => {
  const dir = tmpDir();
  try {
    const journal = { proxy: 'dxgi.dll', added: ['OptiScaler.dll', 'OptiScaler.ini', 'OptiScaler_OpticalFlow.dll', 'setup_windows.bat'] };
    const names = (list) => list.map((f) => path.basename(f));
    assert.deepStrictEqual(names(defender.expectedInstallBinaries(dir, journal, { companions: ['OptiScaler_OpticalFlow.dll'] })),
      ['dxgi.dll', 'nvngx_dlssnr.dll', 'OptiScaler_OpticalFlow.dll']);
    // The rename did not happen this time (proxyError): OptiScaler.dll is still there, so the old
    // proxy name in the journal is not expected.
    fs.writeFileSync(path.join(dir, 'OptiScaler.dll'), 'x');
    assert.deepStrictEqual(names(defender.expectedInstallBinaries(dir, journal)), ['nvngx_dlssnr.dll']);
    assert.deepStrictEqual(names(defender.expectedInstallBinaries(dir, null)), ['nvngx_dlssnr.dll']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the wiring ───────────────────────────────────────────────────────────────────────────────

test('nothing is restored without a click: the launch outcome handler never uninstalls', () => {
  const start = rendererJs.indexOf('window.api.onLaunchOutcome(');
  assert.ok(start > 0, 'the renderer listens for launch outcomes');
  const body = rendererJs.slice(start, rendererJs.indexOf('\n});', start));
  assert.doesNotMatch(body, /runUninstall|confirmRemoveOnCard|offerRestore/);
  // The restore runs only from the confirm on the flipped card.
  const offer = rendererJs.slice(rendererJs.indexOf('function offerRestore('), rendererJs.indexOf('window.api.onLaunchOutcome('));
  assert.match(offer, /confirmRemoveOnCard\(/);
  assert.doesNotMatch(offer, /runUninstall/);
  // main.js sends the notice; it never removes anything in response to a launch.
  const watch = mainJs.slice(mainJs.indexOf('function watchLaunch('), mainJs.indexOf('// ── Did something take the files'));
  assert.doesNotMatch(watch, /uninstallEverything|rmSync|unlinkSync/);
});

test('the launch watch shares the running-games listing and only watches folders this app modified', () => {
  assert.match(mainJs, /ipcMain\.handle\('games:running'[\s\S]{0,200}runningImageSet\(\)/);
  const watch = mainJs.slice(mainJs.indexOf('function watchLaunch('), mainJs.indexOf('async function tickLaunchWatches('));
  assert.match(watch, /if \(!stackInstalledHere\(dir\)\) return;/);
  assert.match(mainJs, /const res = await launchGame\(\{ exePath, launcher, dryRun \}\);[\s\S]{0,700}watchLaunch\(exePath, res\)/);
  // Only the card's Launch is watched: Analyse and Verify close the game themselves within ~30 s, and
  // a watch on them would report a false early close and offer Restore.
  assert.equal((mainJs.match(/\bwatchLaunch\(exePath, res\)/g) || []).length, 1);
});

test('every safety API the renderer calls is exposed by the preload', () => {
  for (const name of ['onLaunchOutcome', 'safetyCheckInstalled', 'safetyDgVoodooQuarantine', 'openProtectionHistory']) {
    assert.match(rendererJs, new RegExp(`window\\.api\\.${name}\\(`), `renderer uses ${name}`);
    assert.match(preloadJs, new RegExp(`\\b${name}:`), `preload exposes ${name}`);
  }
  assert.match(mainJs, /shell\.openExternal\(defender\.PROTECTION_HISTORY_URI\)/, 'a fixed URI, nothing from the renderer');
});

test('every string the safety notices show is translated in every language', () => {
  const start = rendererJs.indexOf('function launchIssueText(');
  const end = rendererJs.indexOf('function flipToConfirm(');
  const block = rendererJs.slice(start, end);
  const keys = new Set();
  for (const m of block.matchAll(/\bt\((['"])((?:\\.|(?!\1)[^\\])*)\1/g)) keys.add(m[2].replace(/\\'/g, "'"));
  for (const k of ['Did not start', 'Closed early', 'Restore originals']) keys.add(k);
  assert.ok(keys.size >= 12, `found ${keys.size} keys`);
  const dir = path.join(root, 'renderer', 'locales');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    let dict = null;
    const sandbox = { I18N: { register: (_c, d) => { dict = d; } } };
    new Function('window', fs.readFileSync(path.join(dir, file), 'utf8'))(sandbox);
    for (const k of keys) {
      if (k === 'Remove OptiScaler?' || !/[a-z]/.test(k)) continue;
      assert.ok(Object.prototype.hasOwnProperty.call(dict, k), `${file} is missing: ${k}`);
      for (const ph of k.match(/\{\w+\}/g) || []) assert.ok(dict[k].includes(ph), `${file} drops ${ph} in: ${k}`);
    }
  }
});
