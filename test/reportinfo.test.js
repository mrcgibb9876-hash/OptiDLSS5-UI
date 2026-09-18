'use strict';
// "Send game failure"'s richer report (reportinfo.js + ghreport.prepareReport): the build the game really
// loaded, the machine's VRAM, Aftermath dumps from around the failed run and only those, a title and a
// header that sort by route and game, and a preview that is byte-for-byte what gets posted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, scratchDir, write } = require('./helpers');
const info = require(path.join(REPO, 'src', 'reportinfo'));
const gh = require(path.join(REPO, 'src', 'ghreport'));

const OPTI_LOG_HEAD = '[22:16:07.803352] [W] OptiScaler v2.1.0-final (09d0aee3) loaded\n[22:16:07.803392] [W] ---------------------------------\n';

test('the engine version is the one OptiScaler.log says the game loaded', () => {
  assert.equal(info.engineFromLog(OPTI_LOG_HEAD), 'v2.1.0-final (09d0aee3)');
  assert.equal(info.engineFromLog('[00:00:00.1] [W] OptiScaler v0.7.9 loaded\n'), 'v0.7.9');
  assert.equal(info.engineFromLog('nothing useful'), null);
});

test('VRAM comes from the 64-bit registry size, matched to the gaming adapter', () => {
  const rows = info.parseVram('[{"name":"AMD Radeon(TM) Graphics","bytes":536870912},{"name":"NVIDIA GeForce RTX 4080 Laptop GPU","bytes":12884901888},{"name":"NVIDIA GeForce RTX 4080 Laptop GPU","bytes":12884901888}]');
  assert.equal(rows.length, 2, 'duplicate registry rows (ControlSet copies) collapse');
  assert.equal(info.vramFor('NVIDIA GeForce RTX 4080 Laptop GPU', rows), 12884901888);
  assert.equal(info.vramFor(null, rows), 12884901888, 'no name: the largest adapter');
  assert.equal(info.gb(12884901888), '12 GB');
  assert.deepEqual(info.parseVram('{"name":"One","bytes":8589934592}'), [{ name: 'One', bytes: 8589934592 }], 'a single adapter is an object, not an array');
  assert.deepEqual(info.parseVram('garbage'), []);
  assert.equal(info.vramFor('x', []), null);
});

test('Aftermath dumps are found beside the game, in TEMP and in Cyberpunk\'s report queue -- from around the run only', () => {
  const root = scratchDir('aftermath');
  const game = path.join(root, 'game');
  const temp = path.join(root, 'temp');
  const local = path.join(root, 'local');
  const run = Date.parse('2026-09-16T21:20:00Z');
  const at = (p, ms) => { fs.utimesSync(p, ms / 1000, ms / 1000); return p; };
  at(write(game, 'crash.nv-gpudmp', 'BIN'), run + 60 * 1000);
  at(write(temp, '2026-09-16_21.21.50.920.nv-gpudmp', 'BIN'), run + 90 * 1000);
  at(write(temp, 'old.nv-gpudmp', 'BIN'), run - 3 * 24 * 3600 * 1000);
  at(write(temp, 'unrelated.log', 'x'), run);
  at(write(path.join(local, 'REDEngine', 'ReportQueue', 'run1', 'attch'), 'gpucrash-2026-09-16.log', 'Device Removed Reason: 0x887a0006'), run + 30 * 1000);

  const found = info.findAftermath({ dirs: [game], tempDir: temp, localAppData: local, around: run });
  const names = found.map((f) => f.name).sort();
  assert.deepEqual(names, ['2026-09-16_21.21.50.920.nv-gpudmp', 'crash.nv-gpudmp', 'gpucrash-2026-09-16.log']);
  assert.match(found.find((f) => f.name.startsWith('gpucrash')).text, /0x887a0006/, 'the readable dump carries its text');
  assert.equal(found.find((f) => f.name === 'crash.nv-gpudmp').text, undefined, 'a binary dump is never read');
  assert.deepEqual(info.findAftermath({ dirs: [path.join(root, 'nope')], tempDir: '', localAppData: '' }), []);
});

test('the report title and header sort by route and game, with a machine-readable copy', () => {
  const assembled = info.assemble({
    base: { title: '[Game Help] RE2: nr-not-active', body: '**Game:** RE2\n\n<digest>' },
    game: { name: 'RESIDENT EVIL 2', exe: 're2.exe' },
    finding: 'nr-not-active',
    route: { route: 'reengine', label: 'RE Engine' },
    detection: { api: 'dx12', badge: 'RE Engine', bitness: 64 },
    gpu: { name: 'NVIDIA GeForce RTX 4080 Laptop GPU', vendor: 'nvidia', driverVersion: '32.0.16.1692' },
    vram: [{ name: 'NVIDIA GeForce RTX 4080 Laptop GPU', bytes: 12884901888 }],
    versions: { app: '2.2.2', bundled: 'v1.0.41', setting: 'v1.0.41' },
    files: [{ name: 'OptiScaler.log', text: OPTI_LOG_HEAD + 'x'.repeat(10) }, { name: '.dlss5ui-api.json', text: '{}' }],
    aftermath: [
      { name: 'gpucrash-1.log', path: 'C:\\Users\\Yathin\\AppData\\Local\\REDEngine\\ReportQueue\\r\\attch\\gpucrash-1.log', bytes: 400, mtime: '2026-09-16T21:20:30.000Z', text: 'Device Removed' },
      { name: 'a.nv-gpudmp', path: 'C:\\Users\\Yathin\\AppData\\Local\\Temp\\a.nv-gpudmp', bytes: 204800, mtime: '2026-09-16T21:21:00.000Z' },
    ],
  });
  assert.equal(assembled.title, '[Game failure] [reengine] RESIDENT EVIL 2: nr-not-active');
  const json = JSON.parse(/<!-- dlss5ui-report (.*) -->/.exec(assembled.body)[1]);
  assert.equal(json.route, 'reengine');
  assert.equal(json.game, 'RESIDENT EVIL 2');
  assert.equal(json.engineLoaded, 'v2.1.0-final (09d0aee3)');
  assert.equal(json.vramBytes, 12884901888);
  assert.equal(json.driver, '32.0.16.1692');
  assert.match(assembled.body, /\| VRAM \| 12 GB \|/);
  assert.match(assembled.body, /\| App \| v2\.2\.2 \|/);
  assert.match(assembled.body, /<digest>/, 'the renderer\'s body and digest follow the header');
  assert.match(assembled.body, /a\.nv-gpudmp.*200 KB/, 'binary dumps are listed, not uploaded');
  assert.equal(assembled.files.find((f) => f.name === 'OptiScaler.log').maxBytes, info.LOG_TAIL_BYTES, 'logs are capped to their tail');
  assert.ok(assembled.files.some((f) => f.name === 'aftermath-gpucrash-1.log'), 'Aftermath\'s text dump goes in as a file');
  assert.ok(!assembled.files.some((f) => /nv-gpudmp/.test(f.name)));

  // An unknown route still sorts, under "unknown".
  assert.equal(info.reportTitle({ route: null, game: 'X', code: null }), '[Game failure] [unknown] X');
});

test('the preview is exactly what is posted: redacted, the log cut to its tail, nothing added after', async () => {
  const redactOpts = { userName: 'Yathin', homeDir: 'D:\\Home\\Yathin', computerName: 'YATHIN-LAPTOP' };
  const bigLog = OPTI_LOG_HEAD + 'y'.repeat(info.LOG_TAIL_BYTES + 5000) + '\nPath D:\\Home\\Yathin\\Games on YATHIN-LAPTOP\nlast line: crashed';
  const assembled = info.assemble({
    base: { body: 'Game at D:/Home/Yathin/Games, JSON "D:\\\\Home\\\\Yathin\\\\Games"' },
    game: { name: 'G', exe: 'g.exe' },
    route: { route: 'feeder', label: 'Feeder' },
    files: [{ name: 'OptiScaler.log', text: bigLog }, { name: 'app-view.json', text: JSON.stringify({ dir: 'C:\\Users\\Yathin\\G', pc: 'YATHIN-LAPTOP' }) }],
    aftermath: [{ name: 'x.nv-gpudmp', path: 'D:\\Home\\Yathin\\x.nv-gpudmp', bytes: 1024, mtime: '2026-09-16T00:00:00.000Z' }],
  });
  const prepared = gh.prepareReport({ ...assembled, redactOpts });
  const everything = JSON.stringify(prepared);
  assert.doesNotMatch(everything, /Yathin/i, 'no user name, home folder or PC name anywhere');
  assert.match(prepared.body, /<home>[\\/]Games/);
  assert.match(everything, /<pc>/);
  const log = prepared.files.find((f) => f.name === 'OptiScaler.log');
  assert.ok(log.cut);
  assert.ok(log.bytes <= info.LOG_TAIL_BYTES + 100);
  assert.match(log.text, /last line: crashed$/);

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (url.endsWith('/gists')) return { ok: true, status: 201, json: async () => ({ html_url: 'https://gist.github.com/g1' }) };
    return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/issues/7', number: 7 }) };
  };
  const out = await gh.postReport({ token: 't', prepared, fetchImpl });
  assert.equal(out.issueNumber, 7);
  assert.deepEqual(out.cut, ['OptiScaler.log']);
  for (const f of prepared.files) assert.equal(calls[0].body.files[f.name].content, f.text, `${f.name} is posted as previewed`);
  assert.equal(Object.keys(calls[0].body.files).length, prepared.files.length);
  assert.equal(calls[1].body.title, prepared.title);
  assert.equal(calls[1].body.body, prepared.body.replace('**Logs:** (link to the log gist, added when sent)', '**Logs:** https://gist.github.com/g1'),
    'the issue text differs from the preview only by the gist link');
});
