'use strict';
// Deep Fried Chicken as a neural consumer this app can choose (src/dfc.js).
//
// The Feeder's rule is "exactly one neural consumer" (v0.11.0-beta.1). Ours is OptiScaler_DLSSNR;
// Chicken is the other one people use. These cover the half of that choice that does not depend on
// Chicken's own config schema: taking the user's copy, deploying it, knowing whose copy is whose,
// taking ours back out, and reading the state it reports.
//
// Nothing here downloads anything. Chicken has no public release, and its LICENSE.txt forbids
// copying, mirroring or bundling it without prior written permission -- so the user supplies a copy
// and this app deploys theirs. Writing deep-fried-chicken.cfg is a different question and a settled
// one: the same licence expressly allows it, and test/dfccfg.test.js covers that half.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dfc = require('../src/dfc');
const { foreignToolchains } = require('../src/detect');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dlss5ui-dfc-${name}-`));
}

// A stand-in for the user's own copy: the two payload files plus the cfg and licence it ships.
function fakeDfcFolder(base, { cfg = 'enabled=1\npasses=1\n' } = {}) {
  const dir = path.join(base, 'chicken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, dfc.ADDON), 'fake chicken addon');
  fs.writeFileSync(path.join(dir, dfc.NVNGX), 'fake chicken nvngx');
  fs.writeFileSync(path.join(dir, dfc.CFG), cfg);
  fs.writeFileSync(path.join(dir, dfc.LICENSE), 'their licence, not ours');
  return dir;
}

// ── the choice itself ────────────────────────────────────────────────────────────────────────

test('a game with no choice recorded is on this app\'s own engine, as every existing install is', () => {
  assert.strictEqual(dfc.consumerOf(undefined), 'optiscaler');
  assert.strictEqual(dfc.consumerOf({}), 'optiscaler');
  assert.strictEqual(dfc.consumerOf({ neuralConsumer: 'dfc' }), 'dfc');
  // A record from a hand-edited file or a future version reads as the default rather than throwing:
  // an unreadable preference must not stop a game installing the way it always did.
  assert.strictEqual(dfc.consumerOf({ neuralConsumer: 'something-else' }), 'optiscaler');
});

test('the Chicken choice says who supplies it, because this app cannot', () => {
  // There is no public download and no licence to redistribute under, so the UI must never imply a
  // Download button exists. If this text ever goes, the choice starts lying.
  assert.match(dfc.CONSUMERS.dfc.supply, /you supply/i);
  assert.strictEqual(dfc.CONSUMERS.dfc.ours, false);
  assert.strictEqual(dfc.CONSUMERS.optiscaler.ours, true);
});

// ── the user's own copy ──────────────────────────────────────────────────────────────────────

test('a folder that is not Chicken is refused at the picker, not at deploy time', async () => {
  const base = tmp('reject');
  try {
    const notChicken = path.join(base, 'random');
    fs.mkdirSync(notChicken);
    fs.writeFileSync(path.join(notChicken, 'readme.txt'), 'x');
    await assert.rejects(() => dfc.importDfcSource(notChicken, path.join(base, 'cache')), /does not look like Deep Fried Chicken/);
    await assert.rejects(() => dfc.importDfcSource(path.join(base, 'nope'), path.join(base, 'cache')), /does not exist/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the user\'s folder is cached, and only the files Chicken actually ships are taken', async () => {
  const base = tmp('import');
  try {
    const src = fakeDfcFolder(base);
    // Something of theirs that is not Chicken's: it must not be swept into our cache.
    fs.writeFileSync(path.join(src, 'my-notes.txt'), 'x');
    const cache = path.join(base, 'cache');
    const r = await dfc.importDfcSource(src, cache);
    assert.deepStrictEqual(r.files, [dfc.CFG, dfc.LICENSE, dfc.ADDON, dfc.NVNGX].sort());
    assert.strictEqual(dfc.cachedDfc(cache), r.path);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('no copy supplied means no cached Chicken, and a deploy that says so rather than half-doing it', async () => {
  const base = tmp('nocache');
  try {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    assert.strictEqual(dfc.cachedDfc(cache), null);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);
    await assert.rejects(() => dfc.deployDfc(game, cache), /no Deep Fried Chicken copy has been added/);
    assert.deepStrictEqual(fs.readdirSync(game), [], 'nothing was placed');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ── deploying into a game ────────────────────────────────────────────────────────────────────

test('a deploy places the payload and records exactly what it placed', async () => {
  const base = tmp('deploy');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeDfcFolder(base), cache);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);

    const r = await dfc.deployDfc(game, cache);
    assert.strictEqual(r.deployed, true);
    assert.deepStrictEqual(r.files.sort(), [dfc.ADDON, dfc.CFG, dfc.LICENSE, dfc.NVNGX].sort());
    assert.strictEqual(dfc.dfcPresent(game), true);
    assert.strictEqual(dfc.dfcOurs(game), true);
    assert.deepStrictEqual(dfc.readMarker(game).files.sort(), r.files.sort());
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a cfg the player has tuned is never overwritten by a later deploy', async () => {
  // Chicken's README: the cfg it ships is already the right starting point. Re-deploying (a repair,
  // an engine change, a second Install) must not silently reset a game someone has tuned.
  const base = tmp('cfg');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeDfcFolder(base, { cfg: 'passes=1\n' }), cache);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);
    await dfc.deployDfc(game, cache);

    fs.writeFileSync(path.join(game, dfc.CFG), 'passes=7\n');
    const again = await dfc.deployDfc(game, cache);
    assert.strictEqual(again.deployed, true);
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.CFG), 'utf8'), 'passes=7\n', 'their settings survive');
    assert.ok(!again.files.includes(dfc.CFG), 'and the cfg is not claimed as newly placed');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a Chicken the user installed themselves is refused, not overwritten', async () => {
  // Their copy came from INSTALL-DEEP-FRIED-CHICKEN.cmd, and that installer is the only thing that
  // knows how to take it out again. Writing over it would strand both.
  const base = tmp('theirs');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeDfcFolder(base), cache);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, dfc.ADDON), 'THEIR addon');
    fs.writeFileSync(path.join(game, dfc.NVNGX), 'THEIR nvngx');

    const r = await dfc.deployDfc(game, cache);
    assert.strictEqual(r.deployed, false);
    assert.match(r.reason, /copied in by hand/);
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.ADDON), 'utf8'), 'THEIR addon');
    assert.strictEqual(dfc.dfcOurs(game), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ── removing ─────────────────────────────────────────────────────────────────────────────────

test('Remove takes back exactly what we placed, and leaves Chicken\'s log for support', async () => {
  const base = tmp('remove');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeDfcFolder(base), cache);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);
    await dfc.deployDfc(game, cache);
    fs.writeFileSync(path.join(game, dfc.LOG), 'ARMED');
    fs.writeFileSync(path.join(game, 'TheGame.exe'), 'x');

    const r = await dfc.removeDfc(game);
    assert.deepStrictEqual(r.removed.sort(), [dfc.ADDON, dfc.CFG, dfc.LICENSE, dfc.NVNGX].sort());
    assert.deepStrictEqual(r.failed, []);
    assert.match(r.kept.join(' '), /deep-fried-chicken\.log/);
    assert.deepStrictEqual(fs.readdirSync(game).sort(), [dfc.LOG, 'TheGame.exe'].sort());
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Remove never deletes a Chicken this app did not place', async () => {
  const base = tmp('remove-theirs');
  try {
    const game = path.join(base, 'game');
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, dfc.ADDON), 'THEIR addon');
    fs.writeFileSync(path.join(game, dfc.NVNGX), 'THEIR nvngx');

    const r = await dfc.removeDfc(game);
    assert.deepStrictEqual(r.removed, []);
    assert.match(r.kept.join(' '), /copied in by hand/, 'and says it is theirs');
    assert.strictEqual(fs.existsSync(path.join(game, dfc.ADDON)), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ── whose Chicken is it ──────────────────────────────────────────────────────────────────────

test('a Chicken we deployed stops being a foreign toolchain; one they installed does not', async () => {
  const base = tmp('foreign');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeDfcFolder(base), cache);

    const theirs = path.join(base, 'theirs');
    fs.mkdirSync(theirs);
    fs.writeFileSync(path.join(theirs, dfc.ADDON), 'x');
    const before = foreignToolchains(theirs).find((f) => f.tool === 'Deep Fried Chicken');
    assert.ok(before, 'a Chicken with no marker is still reported -- Install must warn on it');

    const ours = path.join(base, 'ours');
    fs.mkdirSync(ours);
    await dfc.deployDfc(ours, cache);
    const after = foreignToolchains(ours).find((f) => f.tool === 'Deep Fried Chicken');
    assert.strictEqual(after, undefined, 'the game\'s chosen consumer is not a rival stack');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('their installer leftovers are still reported beside a deploy of ours', async () => {
  // #89's folder had .dfc-installer and the .cmd scripts with no add-on deployed at all. Our marker
  // lists only what we placed, so those keep reporting -- they are the evidence of a second,
  // hand-managed Chicken in a folder we also put one in, which is worth saying out loud.
  const base = tmp('leftovers');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeDfcFolder(base), cache);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);
    await dfc.deployDfc(game, cache);
    fs.writeFileSync(path.join(game, 'CHICKEN-ASSIST.cmd'), 'x');
    fs.mkdirSync(path.join(game, '.dfc-installer'));

    const found = foreignToolchains(game).find((f) => f.tool === 'Deep Fried Chicken');
    assert.ok(found, 'the hand-installed footprint still reports');
    assert.deepStrictEqual(found.files.sort(), ['.dfc-installer', 'CHICKEN-ASSIST.cmd']);
    assert.ok(!found.files.includes(dfc.ADDON), 'but not the add-on we placed');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ── what Chicken reports ─────────────────────────────────────────────────────────────────────

test('Chicken\'s own state words are read from its log, most recent wins', () => {
  const base = tmp('state');
  try {
    const game = path.join(base, 'game');
    fs.mkdirSync(game, { recursive: true });
    assert.deepStrictEqual(dfc.readDfcState(game), { ran: false, state: null }, 'no log is not a state');

    fs.writeFileSync(path.join(game, dfc.LOG), 'start\nDISARMED waiting\nlater: ARMED and running\n');
    const armed = dfc.readDfcState(game);
    assert.strictEqual(armed.state, 'ARMED');
    assert.strictEqual(armed.conflict, false);

    // The one this app can cause: two neural consumers, and Chicken goes inert for the session.
    fs.appendFileSync(path.join(game, dfc.LOG), 'CONFLICT: another neural add-on is loaded\n');
    const clash = dfc.readDfcState(game);
    assert.strictEqual(clash.state, 'CONFLICT');
    assert.strictEqual(clash.conflict, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the cfg is readable but this app has no writer for it', () => {
  // Deliberate, and a guard so it stays deliberate: Chicken's README says not to edit its settings
  // file, its schema is not published, and the binary cannot be run here to check what a key does.
  // Inventing one is the D3D12-resource-state mistake again. Remove this test when a real cfg and
  // its documentation are in hand -- not before.
  const base = tmp('cfgread');
  try {
    const game = path.join(base, 'game');
    fs.mkdirSync(game, { recursive: true });
    assert.strictEqual(dfc.readCfgText(game), null);
    fs.writeFileSync(dfc.cfgPath(game), 'enabled=1\n');
    assert.strictEqual(dfc.readCfgText(game), 'enabled=1\n');

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dfc.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(!/function writeCfg|writeCfgText|setCfgKey/.test(src), 'no cfg writer until the schema is known');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('nothing in this module fetches Chicken from anywhere', () => {
  // There is no public release and no licence permitting redistribution. If a fetch ever appears
  // here, it was added without that changing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dfc.js'), 'utf8');
  assert.ok(!/fetch\(|https?:\/\/(?!\S*discord)/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'dfc.js must not download anything');
});

// ── wired into the app ───────────────────────────────────────────────────────────────────────

const { loadMain, scratchDir, fakeExe } = require('./helpers');

test('Settings takes the user\'s copy, and every game can use it after that', async () => {
  const app = loadMain();
  const base = scratchDir('dfc-supply');
  const r = await app.invoke('dfc:supply', fakeDfcFolder(base));
  assert.strictEqual(r.ok, true);
  assert.ok(r.files.includes(dfc.ADDON));

  const status = await app.invoke('dfc:status', null);
  assert.strictEqual(status.supplied, true, 'the copy is remembered for the next game');
});

test('the status the card draws: whose Chicken is here, and what it last reported', async () => {
  const app = loadMain();
  const base = scratchDir('dfc-status');
  await app.invoke('dfc:supply', fakeDfcFolder(base));

  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  let s = await app.invoke('dfc:status', exe);
  assert.deepStrictEqual({ present: s.present, ours: s.ours }, { present: false, ours: false });

  await dfc.deployDfc(game, path.join(app.userData, 'dfc'));
  fs.writeFileSync(path.join(game, dfc.LOG), 'ARMED\n');
  s = await app.invoke('dfc:status', exe);
  assert.deepStrictEqual({ present: s.present, ours: s.ours, state: s.state.state }, { present: true, ours: true, state: 'ARMED' });
  assert.strictEqual(s.cfg, 'enabled=1\npasses=1\n', 'their cfg is readable, for showing');
});

test('Remove takes out a Chicken we deployed, along with everything else', async () => {
  const app = loadMain();
  const base = scratchDir('dfc-uninstall');
  await app.invoke('dfc:supply', fakeDfcFolder(base));
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  await dfc.deployDfc(game, path.join(app.userData, 'dfc'));

  const res = await app.invoke('game:run-uninstall', exe);
  assert.strictEqual(res.ok, true);
  assert.ok(res.removed.includes(dfc.ADDON), `expected ${dfc.ADDON} in ${JSON.stringify(res.removed)}`);
  assert.strictEqual(fs.existsSync(path.join(game, dfc.ADDON)), false);
  assert.strictEqual(fs.existsSync(path.join(game, dfc.MARKER)), false);
});

test('Remove leaves a Chicken the user installed themselves, and says whose it is', async () => {
  const app = loadMain();
  const base = scratchDir('dfc-uninstall-theirs');
  const game = path.join(base, 'game');
  const exe = fakeExe(game, 'Game.exe');
  fs.writeFileSync(path.join(game, dfc.ADDON), 'THEIR addon');

  const res = await app.invoke('game:run-uninstall', exe);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(fs.existsSync(path.join(game, dfc.ADDON)), true, 'not ours to delete');
  assert.match(res.kept.join(' '), /copied in by hand/);
});

test('the deploy acts on the chosen consumer, and never leaves two of them in a folder', () => {
  // The Feeder allows exactly one consumer. Choosing Chicken must deploy it AND notice OptiScaler
  // is still there; choosing ours back must take our Chicken out again. Source-checked because the
  // surrounding deploy fetches ReShade and the Feeder release, which a test cannot do offline.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf("ipcMain.handle('feeder:deploy'");
  assert.notStrictEqual(at, -1);
  const end = src.indexOf('\n});\n', at);
  assert.notStrictEqual(end, -1);
  const body = src.slice(at, end);
  assert.match(body, /results\.consumer =/, 'the deploy records which consumer was chosen');
  assert.match(body, /dfc\.switchToDfc\(/, 'and swaps Chicken in when it is the one');
  assert.match(body, /removeOptiScaler: removeOptiScalerForSwap/, 'taking OptiScaler out, so two passes never share a folder');
  assert.match(body, /dfc\.dfcOurs\(dir\)[\s\S]*dfc\.removeDfc\(dir, dfcRemoveOptions\(\)\)/, 'and takes our Chicken out when switching back, keeping its cfg');
  assert.match(body, /dfc\.supportedFor\(/, 'and refuses a game the swap is not built for before touching it');
});

test('a real release layout imports from the archive root, the version folder, or 64-bit itself', async () => {
  // CP376 Beta unpacks to <name>/{64-bit,32-bit}/ with LICENSE.txt and README.txt at the root, so
  // the folder a user picks is normally a PARENT of the payload. Picking any of the three works,
  // and the 64-bit tree is the one taken -- the 32-bit tree is Chicken's own transport, not a
  // drop-in consumer for our Feeder route.
  const base = tmp('layout');
  try {
    const root = path.join(base, 'Deep-Fried-Chicken-CP376-Beta');
    fs.mkdirSync(path.join(root, '64-bit'), { recursive: true });
    fs.mkdirSync(path.join(root, '32-bit', 'host64'), { recursive: true });
    fs.writeFileSync(path.join(root, '64-bit', dfc.ADDON), '64-bit addon');
    fs.writeFileSync(path.join(root, '64-bit', dfc.NVNGX), '64-bit nvngx');
    fs.writeFileSync(path.join(root, '64-bit', dfc.CFG), 'config_schema=13\nenabled=1\n');
    fs.writeFileSync(path.join(root, dfc.LICENSE), 'Alexander, all rights reserved');
    fs.writeFileSync(path.join(root, 'README.txt'), 'Use the folder matching the GAME\x27s bitness');
    // The 32-bit tree, which must never be the one picked up.
    fs.writeFileSync(path.join(root, '32-bit', 'deep-fried-chicken.addon32'), 'x');
    fs.writeFileSync(path.join(root, '32-bit', 'host64', dfc.ADDON), 'THE 32-BIT TREE\x27S COPY');
    fs.writeFileSync(path.join(root, '32-bit', 'host64', dfc.NVNGX), 'x');

    for (const pick of [base, root, path.join(root, '64-bit')]) {
      const cache = path.join(base, 'cache-' + path.basename(pick));
      const r = await dfc.importDfcSource(pick, cache);
      assert.ok(r.files.includes(dfc.ADDON), `${pick}: payload`);
      assert.ok(r.files.includes(dfc.LICENSE), `${pick}: the licence travels with it`);
      assert.strictEqual(fs.readFileSync(path.join(r.path, dfc.ADDON), 'utf8'), '64-bit addon', `${pick}: the 64-bit tree, not the 32-bit one`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the licence and notices are placed but never rewritten', async () => {
  // Chicken's licence forbids removing or altering "copyright, authorship, version, licence, or
  // integrity information", so a re-deploy must not overwrite them either.
  const base = tmp('docs');
  try {
    const cache = path.join(base, 'cache');
    await dfc.importDfcSource(fakeDfcFolder(base), cache);
    const game = path.join(base, 'game');
    fs.mkdirSync(game);
    await dfc.deployDfc(game, cache);
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.LICENSE), 'utf8'), 'their licence, not ours');

    fs.writeFileSync(path.join(game, dfc.LICENSE), 'edited by the user');
    const again = await dfc.deployDfc(game, cache);
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.LICENSE), 'utf8'), 'edited by the user', 'left as found');
    assert.ok(!again.files.includes(dfc.LICENSE));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ── picking the copy ─────────────────────────────────────────────────────────────────────────

// The import has always accepted a folder. The DIALOG did not: it was a single openFile picker,
// so a player who unpacked the archive could see their folder and not select it -- an openFile
// dialog will not take a directory -- leaving them to guess which file inside it to point at.
// Reported within a day of v2.4.0. Windows cannot offer both in one dialog (Electron: openFile and
// openDirectory cannot be combined there), so the choice has to be asked.
test('the picker can take a FOLDER, not only a file inside one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('async function askForChicken()');
  assert.notStrictEqual(start, -1, 'the picker asks where the copy is');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  assert.ok(/properties: \['openDirectory'\]/.test(body), 'a folder can be chosen');
  assert.ok(/properties: \['openFile'\]/.test(body), 'and the .7z still can');
  // The folder is the default: it is the route that needs nothing installed, and 7-Zip is not
  // something this app can assume or offer to install.
  assert.ok(/defaultId: 0/.test(body) && body.indexOf('openDirectory') < body.indexOf('openFile'),
    'the folder is offered first and is the default');
  // The single openFile picker this replaced must not come back. Comments are stripped first, or
  // the note above askForChicken explaining what it replaced would trip this itself.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/any file in the folder you unpacked/i.test(code), 'no "pick a file inside the folder" picker');
});

test('a folder is what import wants anyway, at any of the depths a release unpacks to', async () => {
  const base = tmp('pickfolder');
  try {
    // The release unpacks to <name>/64-bit/, and people pick any level of that.
    const nested = path.join(base, 'Deep-Fried-Chicken-CP376', '64-bit');
    fs.mkdirSync(nested, { recursive: true });
    for (const [n, c] of [[dfc.ADDON, 'a'], [dfc.NVNGX, 'n'], [dfc.CFG, 'enabled=1\n'], [dfc.LICENSE, 'theirs']]) {
      fs.writeFileSync(path.join(nested, n), c);
    }
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache, { recursive: true });

    for (const pick of [nested, path.dirname(nested), base]) {
      const r = await dfc.importDfcSource(pick, cache);
      assert.ok(r.files.includes(dfc.ADDON), `picking ${path.basename(pick) || 'the top folder'} works`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// Replacing the copy used to change the cache and nothing else: a player who updated Chicken had
// the new build in the app's folder while every game they had switched kept the old binaries, with
// nothing on screen saying so. That is not "change it at will".
test('replacing the copy carries the new version into the games already using it', async () => {
  const base = tmp('redeploy');
  try {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    const game = path.join(base, 'game');
    fs.mkdirSync(game, { recursive: true });

    // v1 supplied and deployed.
    await dfc.importDfcSource(fakeDfcFolder(path.join(base, 'v1')), cache);
    await dfc.deployDfc(game, cache);
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.ADDON), 'utf8'), 'fake chicken addon');

    // v2 supplied: the game follows.
    const v2 = fakeDfcFolder(path.join(base, 'v2'));
    fs.writeFileSync(path.join(v2, dfc.ADDON), 'NEWER chicken addon');
    await dfc.importDfcSource(v2, cache);
    const r = await dfc.redeployOurs([game], cache);
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(r.updated, [game]);
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.ADDON), 'utf8'), 'NEWER chicken addon',
      'the game runs the copy the player just supplied');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a Chicken somebody placed by hand is never updated out from under them', async () => {
  const base = tmp('redeploy-hand');
  try {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    await dfc.importDfcSource(fakeDfcFolder(path.join(base, 'supplied')), cache);

    // Their own copy: the files are there, but no marker of ours.
    const game = path.join(base, 'game');
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, dfc.ADDON), 'THEIR addon');
    fs.writeFileSync(path.join(game, dfc.NVNGX), 'THEIR nvngx');

    const r = await dfc.redeployOurs([game], cache);
    assert.deepStrictEqual(r.updated, [], 'not ours, so not touched');
    assert.strictEqual(fs.readFileSync(path.join(game, dfc.ADDON), 'utf8'), 'THEIR addon');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a game that is not on Chicken at all is skipped, and a bad folder does not stop the rest', async () => {
  const base = tmp('redeploy-mixed');
  try {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    await dfc.importDfcSource(fakeDfcFolder(path.join(base, 'supplied')), cache);

    const onChicken = path.join(base, 'a');
    fs.mkdirSync(onChicken, { recursive: true });
    await dfc.deployDfc(onChicken, cache);
    const plain = path.join(base, 'b');
    fs.mkdirSync(plain, { recursive: true });

    const r = await dfc.redeployOurs([plain, path.join(base, 'gone'), onChicken, null], cache);
    assert.deepStrictEqual(r.updated, [onChicken]);
    assert.deepStrictEqual(r.failed, [], 'a game folder that no longer exists is simply not ours');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
