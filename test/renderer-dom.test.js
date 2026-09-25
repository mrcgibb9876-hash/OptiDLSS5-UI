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
  assert.match(js, /line\.classList\.add\('hidden'\)/);
  assert.match(js, /mark\.title = t\('Deep Fried Chicken runs the neural pass here'\)/);
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

// The break-away panel's sentence lives here, not in route-explain.js, precisely so it can be withheld:
// the pop-out panel can be switched off in Settings and Windows can refuse its hotkey. The Panel row
// must therefore ask, not paste the route's text and hope.
test('the card\'s Panel row asks whether the pop-out panel can actually be offered', () => {
  const fn = js.slice(js.indexOf('function routeExplainHtml('), js.indexOf('async function loadRouteStatus('));
  assert.ok(fn.length > 0, 'could not find routeExplainHtml');
  assert.match(fn, /popoutPanelSentence\(explain\.popout\)/, 'the Panel row does not consult the pop-out state');
  const sentence = js.slice(js.indexOf('function popoutPanelSentence('), js.indexOf('function routeExplainHtml('));
  assert.match(sentence, /popoutHotkeyUsable\(\)/, 'popoutPanelSentence names the hotkey unconditionally');
});
