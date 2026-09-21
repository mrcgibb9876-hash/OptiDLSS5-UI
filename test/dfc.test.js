'use strict';
// Deep Fried Chicken as a neural consumer this app can choose (src/dfc.js).
//
// The Feeder's rule is "exactly one neural consumer" (v0.11.0-beta.1). Ours is OptiScaler_DLSSNR;
// Chicken is the other one people use. These cover the half of that choice that does not depend on
// Chicken's own config schema: taking the user's copy, deploying it, knowing whose copy is whose,
// taking ours back out, and reading the state it reports.
//
// Nothing here downloads anything, and nothing here writes deep-fried-chicken.cfg. Chicken has no
// public release and no stated licence, and its README says not to edit its settings file.

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
    await assert.rejects(() => dfc.deployDfc(game, cache), /no Deep Fried Chicken copy has been supplied/);
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
    assert.match(r.reason, /this app did not put it there/);
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
    assert.match(r.kept.join(' '), /UNINSTALL-DEEP-FRIED-CHICKEN\.cmd/, 'and says what does own it');
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
