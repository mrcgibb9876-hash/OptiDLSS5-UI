// The support bundle -- the "send me your logs" feature. Its one job is to contain the files a
// diagnosis starts from, and on the 32-bit route those are not in the game folder at all.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { REPO, scratchDir, write } = require('./helpers');
const runlog = require(path.join(REPO, 'src', 'runlog'));
const onWindows = process.platform === 'win32';

// A 32-bit game as legacy.js lays it out: ReShade and the Feeder beside the exe, OptiScaler and
// everything it writes in host64\.
function legacyGame(name) {
  const dir = scratchDir(name);
  write(dir, 'dlss5-feed.log', 'feed: started\nfeed: 1200 frames\n');
  write(dir, 'ReShade.log', 'reshade: loaded DLSS5_Feed.fx\n');
  write(dir, '.dlss5ui-legacy.json', JSON.stringify({ host32: { api: 'dx9' } }));
  write(dir, 'host64/OptiScaler.log', [
    '[00:00:01.000000] [I] NVSDK_NGX_D3D12_Init',
    '[00:00:02.000000] [I] TryCreateOptiFeature Creating OptiScaler feature',
    '[00:00:03.000000] [I] DlssNr_Dx12::Dispatch DLSS-NR running after SR: target 1920x1080',
    '',
  ].join('\n'));
  write(dir, 'host64/OptiScaler.ini', '[DlssNr]\nEnabled=true\n[Menu]\nShortcutKey=auto\n');
  return dir;
}

test('a 32-bit game\'s bundle carries the helper\'s log, not an empty folder', { skip: !onWindows }, async () => {
  const dir = legacyGame('bundle-32bit');
  const optiDir = path.join(dir, 'host64');
  const zipPath = path.join(os.tmpdir(), `bundle-test-${process.pid}-${Date.now()}.zip`);

  const out = await runlog.collectSupportBundle(dir, { zipPath, execFileAsync, optiDir, extra: {} });

  // OptiScaler writes nothing into the game folder on this route, so before this the bundle had
  // no OptiScaler.log at all -- the one file every diagnosis starts from.
  assert.ok(out.files.includes('host64-OptiScaler.log'), `missing the helper's log: ${JSON.stringify(out.files)}`);
  assert.ok(out.files.includes('host64-OptiScaler.ini'), `missing the helper's ini: ${JSON.stringify(out.files)}`);
  // The game folder's own files still come through, under their own names.
  assert.ok(out.files.includes('dlss5-feed.log'));
  assert.ok(out.files.includes('ReShade.log'));
  assert.ok(fs.existsSync(zipPath), 'the zip was written');

  // And the verdict in the bundle is read from the helper too: it used to say "no-log" about a
  // run whose log was sitting in host64\ full of neural passes.
  assert.equal(out.run.ran, true, 'the run was seen');
  assert.equal(out.run.verdict, 'nr-ran', `expected nr-ran, got ${out.run.verdict}`);

  fs.rmSync(zipPath, { force: true });
});

test('an ordinary game is unaffected: no helper, no duplicate names', { skip: !onWindows }, async () => {
  const dir = scratchDir('bundle-plain');
  write(dir, 'OptiScaler.log', '[00:00:01.000000] [I] NVSDK_NGX_D3D12_Init\n');
  write(dir, 'OptiScaler.ini', '[DlssNr]\nEnabled=true\n');
  const zipPath = path.join(os.tmpdir(), `bundle-plain-${process.pid}-${Date.now()}.zip`);

  const out = await runlog.collectSupportBundle(dir, { zipPath, execFileAsync, extra: {} });

  assert.ok(out.files.includes('OptiScaler.log'));
  assert.ok(!out.files.some((f) => /^host/.test(f)), 'nothing prefixed when there is no helper');
  fs.rmSync(zipPath, { force: true });
});
