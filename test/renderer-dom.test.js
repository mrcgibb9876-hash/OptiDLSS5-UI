'use strict';
// The renderer is a plain script with no bundler and no framework: `$('#id')` returns null for an
// id that is not in index.html, and at module scope `$('#gone').addEventListener(...)` throws
// before anything else runs, taking the whole window with it. Nothing else in this repo catches
// that -- `node --check` parses the file happily, and Electron is not on a CI runner. So these
// tests read both files as text and check that every id and card class the renderer reaches for
// is one the markup actually has.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

function htmlIds() {
  const ids = [];
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.push(m[1]);
  return ids;
}

test('every id the renderer looks up exists in index.html', () => {
  const ids = new Set(htmlIds());
  // Ids the renderer creates at runtime rather than finding in the markup -- set on an element it
  // built, or written into markup it assigns to innerHTML.
  const made = new Set();
  for (const m of js.matchAll(/\.id\s*=\s*'([^']+)'/g)) made.add(m[1]);
  for (const m of js.matchAll(/\bid="([^"$]+)"/g)) made.add(m[1]);

  const missing = [];
  for (const m of js.matchAll(/\$\('#([^']+)'\)/g)) {
    const id = m[1];
    if (!ids.has(id) && !made.has(id)) missing.push(id);
  }
  assert.deepStrictEqual([...new Set(missing)], [], 'renderer.js reaches for ids index.html does not have');
});

// "Get the driver" did nothing (2026-09-18): the renderer asked for NVIDIA's download page and
// main.js's shell:openExternal allowlist silently dropped it. The two files cannot share a constant
// (the renderer is a plain script), so this keeps them agreeing.
test('the driver banner link is one shell:openExternal will open', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const page = /const NVIDIA_DRIVER_PAGE = '([^']+)'/.exec(main);
  assert.ok(page, 'main.js defines NVIDIA_DRIVER_PAGE');
  assert.match(main, /url === NVIDIA_DRIVER_PAGE/, 'the allowlist admits NVIDIA_DRIVER_PAGE');
  const asked = /#btn-driver-download'\)\.addEventListener\('click', \(\) => \{\s*window\.api\.openExternal\('([^']+)'\)/.exec(js);
  assert.ok(asked, 'the driver button opens a literal URL');
  assert.strictEqual(asked[1], page[1]);
});

test('no id appears twice in index.html', () => {
  const seen = new Set();
  const dupes = [];
  for (const id of htmlIds()) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepStrictEqual(dupes, [], 'duplicate ids: the second one is unreachable through $()');
});

test('every card class the renderer queries is in the card template', () => {
  // The card is built from a template literal in renderGrid, then addressed by class. A rename in
  // one place and not the other is silent -- card.querySelector returns null and the listener is
  // never attached, or `?.click()` quietly does nothing.
  const tpl = js.slice(js.indexOf('card.innerHTML = `'), js.indexOf('setBannerWithFallback(game, card.querySelector'));
  assert.ok(tpl.includes('card-actions'), 'could not find the card template');
  const missing = [];
  for (const m of js.matchAll(/card\.querySelector\('\.([a-z0-9-]+)'\)/g)) {
    if (!tpl.includes(`"${m[1]}`) && !tpl.includes(` ${m[1]}"`) && !tpl.includes(` ${m[1]} `)) missing.push(m[1]);
  }
  assert.deepStrictEqual([...new Set(missing)], [], 'card classes the template does not define');
});

test('the pop-out panel still renders every group', () => {
  // The Settings dialog was narrowed to the Display group; the pop-out panel must NOT be, because
  // it is the only full route to these controls on the 32-bit route -- OptiScaler runs in the
  // 64-bit helper there, so the in-game panel is a mirror the game may not let you click. Both
  // renderers read the same dlssnr.js field list, so narrowing one and then "tidying" the other to
  // match would take that route's settings away without a single test going red.
  const panel = fs.readFileSync(path.join(root, 'panel.js'), 'utf8');
  // It draws the pages the main process hands it, whole: every section, and every key in each one.
  // dlssnr.test.js is what makes sure those pages account for every field.
  assert.match(panel, /for \(const section of shown\.sections\)/);
  assert.match(panel, /for \(const key of section\.keys\)/);
  assert.ok(!panel.includes('EDITABLE_GROUPS'), 'the pop-out panel must not filter groups');
});

test('the card carries no chip line and no run counts, only the mark, the status and one row', () => {
  // Asked for 2026-09-25: the DX12/Vulkan/Experimental/route chips and "1240 passes · 71 fps" were
  // clutter. The DLSS 5 / Chicken mark and the Working chip stay. renderer.js cannot be required here
  // -- it touches document at module scope -- so this guards the wiring rather than the output.
  assert.ok(!js.includes("ev.className = 'card-evidence'"), 'the run count is back on the card');
  assert.ok(!js.includes('engine-badge api-badge'), 'the API chip is back on the card');
  assert.ok(!js.includes('engine-badge route-badge'), 'the route chip is back on the card');
  // The hidden recommend line and problem row went too: nothing is left for a chip to be drawn into.
  assert.ok(!js.includes('card-recommend'), 'the chip line is back in the card template');
  assert.ok(!js.includes('card-problem'), 'the old problem row is back in the card template');
  assert.ok(!/mark\.title =/.test(js), 'the mark carries no hover text (2026-09-25)');
  assert.match(js, /class="card-warn hidden"/, 'anti-cheat is a triangle on the art');
  assert.ok(!js.includes('detectShort'), 'the advisory warning line is back on the card');
});

test('a failed game climbs the ladder: DXVK, then Chicken, then a report', () => {
  const offers = js.slice(js.indexOf('function fallbackOffers('), js.indexOf('async function tryFallback('));
  assert.ok(offers.indexOf("offers.push('dxvk')") < offers.indexOf("offers.push('dfc')"), 'DXVK is offered before Chicken');
  assert.match(offers, /swap\.id === 'swap-to-dxvk'/, 'DXVK only where the game can take it');
  assert.match(offers, /dfcSupport\.ok/, 'Chicken only where it supports the game');
  const flip = js.slice(js.indexOf('function flipToFailure('), js.indexOf('function failureProblem('));
  assert.match(flip, /sendGameFailure\(/, 'the last rung sends the report');
  assert.ok(!/no known fix/.test(flip), 'the dead-end wording is gone from the ladder');
});

test('a Chicken rung that failed or was cancelled is not counted as tried', () => {
  // 2026-09-25: tryFallback read game.neuralConsumer, which switchNeuralPass sets BEFORE installing,
  // and installGame resolved undefined on every path -- so a refused switch read as done.
  const install = js.slice(js.indexOf('async function installGame(game)'), js.indexOf('// ── PureDark'));
  assert.doesNotMatch(install, /return;/, 'every exit of installGame says whether it worked');
  assert.match(install, /return !!res\.ok;\r?\n\}/);
  const sw = js.slice(js.indexOf('async function switchNeuralPass('), js.indexOf('async function loadSettingsDfc('));
  assert.match(sw, /const ok = await installGame\(game\);[\s\S]*game\.neuralConsumer = previous;[\s\S]*return ok;/);
  const tf = js.slice(js.indexOf('async function tryFallback('), js.indexOf('function flipToFailure('));
  assert.match(tf, /if \(await switchNeuralPass\(game, 'dfc'\)\)/);
  assert.doesNotMatch(tf, /game\.neuralConsumer === 'dfc'/);
  assert.match(tf, /fb\.at = before\.at;/, 'an undo puts the old `at` back, not 0');
});

test('a report survives the grid being redrawn under it', () => {
  // The window regaining focus after GitHub's page redraws the grid; the progress lives outside the card.
  assert.match(js, /const reportProgress = new Map\(\);/);
  const show = js.slice(js.indexOf('function showFailure('), js.indexOf('function escapeHtml('));
  assert.match(show, /reportProgress\.get\(exePath\)/, 'a redrawn card turns back to a report in progress');
  assert.match(show, /cardsByExe\.get\(exePath\)/, 'the delayed spin finds the live card');
  assert.match(js, /function reportSignInShared\(\)/, 'one device flow is shared, never a second one started');
});

test('the DLSS 5 field table is not offered in two places at once', () => {
  // The in-game panel and Settings both write the same OptiScaler.ini, and the panel saves the
  // whole file whenever it changes something -- so a second copy of those controls in Settings
  // does not just duplicate them, it loses edits. Only the Window group stays in the dialog -- it was
  // called Display until the 2026-09-20 regroup split the game's window from the panel's own
  // appearance, which is the one merge that would have leaked Language and Font size in here.
  assert.match(js, /const EDITABLE_GROUPS = \['Window'\]/);
  assert.ok(!html.includes('game-dlssnr-fields'), 'the old DLSS NR field host is still in the markup');
});

test('an AMD card never counts its lone NR model as leftovers to remove', () => {
  // 2026-09-18: detectInstalledBackends lists nvngx_dlssnr.dll as a leftover on every vendor, so
  // an AMD card's DLSS-NR-on-AMD model turned into "Remove leftovers", whose handler runs the full
  // uninstall and deletes the model. The card reads one list with that file taken out.
  assert.doesNotMatch(js, /\(backends\.leftovers \|\| \[\]\)\.length/, 'a raw leftovers length check is back');
  assert.match(js, /const leftoverFiles = \(backends\.leftovers \|\| \[\]\)\.filter\(/);
  assert.match(js, /if \(backends\.optiscaler \|\| leftoverFiles\.length\)/);
});

test('the pop-out hotkey is only named when the pop-out panel can answer it', () => {
  // 2026-09-18: the card hint and Game Help's 32-bit steps said "{hotkey} ..." with the pop-out
  // panel switched off in Settings. Every place that names it goes through popoutHotkeyUsable.
  assert.match(js, /function popoutHotkeyUsable\(\) \{\s*return panelEnabled\(\)/);
  const named = [...js.matchAll(/hotkey: panelHotkey\(\)/g)];
  assert.ok(named.length >= 2, 'expected the card hint and the Game Help step');
  for (const m of named) {
    const before = js.slice(Math.max(0, m.index - 700), m.index);
    assert.ok(before.includes('popoutHotkeyUsable()'), `hotkey named without a popoutHotkeyUsable() check near: ${js.slice(m.index - 120, m.index)}`);
  }
});

test('Game Help keeps only the fix, AI help and Close', () => {
  // 2026-09-25: launching, sending, the bundle and the other layers moved onto the card itself.
  for (const id of ['help-launch', 'help-send', 'help-more', 'help-bundle', 'help-report', 'help-dxvk', 'help-native']) {
    assert.ok(!html.includes(`id="${id}"`), `#${id} is back in Game Help`);
  }
  assert.match(html, /id="help-close"/);
});

test('the card\'s Fix it cannot run the same fix twice at once', () => {
  // 2026-09-18: modal:false makes applyHelpFix's busy() a no-op, so a double-click on the card ran
  // gameHelpApply twice concurrently.
  const at = js.indexOf("label: t('Fix it')");
  assert.ok(at > 0);
  const block = js.slice(at, at + 600);
  assert.match(block, /if \(cardFixesInFlight\.has\(game\.exePath\)\) return;/);
  assert.match(block, /btn\.disabled = true/);
  assert.match(block, /finally \{\s*cardFixesInFlight\.delete\(game\.exePath\)/);
});

// The second engine build came back on 2026-09-19. Both update paths read the default build's folder
// with no id, so a game left on the Pre-SR build would never have been offered its newer releases --
// and nothing would have said so, since the default build's check kept reporting "up to date".
test('both update paths sweep every engine build in use, not just the default', () => {
  assert.match(js, /function enginesInUse\(\)/, 'no enginesInUse to sweep with');

  const auto = js.slice(js.indexOf('async function autoUpdateOptiScalerRelease()'), js.indexOf("$('#btn-clean-folder')"));
  assert.ok(auto.length > 0, 'could not find autoUpdateOptiScalerRelease');
  assert.match(auto, /for \(const id of enginesInUse\(\)\)/, 'the 6-hourly auto-update covers the default build only');

  const check = js.slice(js.indexOf("$('#btn-check-updates').addEventListener"), js.indexOf("const scanModal ="));
  assert.ok(check.length > 0, 'could not find the Check for Updates handler');
  assert.match(check, /for \(const id of enginesInUse\(\)\)/, 'Check for Updates covers the default build only');
  // Every line names its build: with two of them, "up to date" on its own does not say which.
  assert.match(check, /engineLabel\(engineRes\.engine\)/, 'the result lines do not name the build');
});


test('the card shows where the game came from, read from status.store', () => {
  // Asked for 2026-09-25: Steam, GOG, Xbox, Epic, EA, Ubisoft, or "User" for a folder of the player's
  // own. From the game:status answer renderGrid already has -- no extra IPC per card.
  const tpl = js.slice(js.indexOf('card.innerHTML = `'), js.indexOf('setBannerWithFallback(game, card.querySelector'));
  const icons = tpl.slice(tpl.indexOf('<div class="card-icons">'), tpl.indexOf('</div>', tpl.indexOf('<div class="card-icons">')));
  assert.match(icons, /\$\{storeTag\(status\)\}/, 'the store tag sits in the icon row, beside the pill and the triangle');
  const src = js.slice(js.indexOf('const STORE_LABELS'), js.indexOf('const API_LABEL'));
  const vm = require('node:vm');
  const ctx = { t: (s) => `T(${s})`, escapeHtml: (s) => String(s) };
  vm.runInNewContext(`${src}; this.storeTag = storeTag;`, ctx);
  const label = (status) => (/>([^<]*)</.exec(ctx.storeTag(status)) || [])[1];
  for (const [id, name] of [['steam', 'Steam'], ['gog', 'GOG'], ['xbox', 'Xbox'], ['epic', 'Epic'], ['ea', 'EA'], ['ubisoft', 'Ubisoft']]) {
    assert.strictEqual(label({ store: id }), name, id);
  }
  assert.strictEqual(label({ store: 'other' }), 'T(User)', 'a folder of the player\'s own is "User", translated');
  assert.strictEqual(label({}), 'T(User)', 'no store answer reads as the player\'s own too');
  assert.strictEqual(ctx.storeTag({ exeMissing: true }), '', 'a missing exe has no install to read a store from');
  assert.match(ctx.storeTag({ store: 'steam' }), /class="card-store"/);
});

test('cards tag RenoDX capability: a gold tag for a per-game mod, a dim one for an engine-wide match', () => {
  assert.match(js, /\$\{renodxTag\(status\)\}/, 'the card template draws the RenoDX tag');
  const fn = js.slice(js.indexOf('function renodxTag('), js.indexOf('const API_LABEL'));
  assert.match(fn, /status\.renodx === 'engine'/);
  assert.match(fn, /card-renodx-engine/);
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /renodx: renodxCapability\(exePath, dir\)/, 'game:status carries the capability');
  const cap = main.slice(main.indexOf('function renodxCapability('), main.indexOf('function renodxCapability(') + 1400);
  assert.match(cap, /if \(!renodxIndexMemo\)/, 'never waits on the network during a grid render');
  assert.match(cap, /storedDetectionFor\(exePath\)/, 'never scans the exe during a grid render');
});
