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
  assert.match(panel, /for \(const group of \[\.\.\.new Set\(fields\.map\(\(f\) => f\.group\)\)\]\)/);
  assert.ok(!panel.includes('EDITABLE_GROUPS'), 'the pop-out panel must not filter groups');
});

test('the card shows the run as numbers, and keeps the sentence for the tooltip', () => {
  // At the card's 300px the full "Neural Rendering ran (1240 passes, 71 fps, DX12)" wrapped across
  // the chip line mid-phrase, and a longer game name made it worse. The chip beside it already says
  // the pass ran, so the card takes the numbers alone. renderer.js cannot be required here -- it
  // touches document at module scope -- so this guards the wiring rather than the output.
  const block = js.slice(js.indexOf("ev.className = 'card-evidence'"), js.indexOf('line.appendChild(ev)'));
  assert.ok(block.includes('runEvidenceShort(run)'), 'the card text comes from the short form');
  assert.ok(!/ev\.textContent\s*=\s*`?\s*\$?\{?\s*describeRun/.test(block), 'not the full sentence');
  assert.ok(block.includes('describeRun(run)'), 'and the full sentence is still the hover text');
  assert.match(js, /function runEvidenceShort\(run\)/);
});

test('the DLSS 5 field table is not offered in two places at once', () => {
  // The in-game panel and Settings both write the same OptiScaler.ini, and the panel saves the
  // whole file whenever it changes something -- so a second copy of those controls in Settings
  // does not just duplicate them, it loses edits. Only the Display group stays in the dialog.
  assert.match(js, /const EDITABLE_GROUPS = \['Display'\]/);
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
  const named = [...js.matchAll(/hotkey: settings\.panelHotkey \|\| DEFAULT_PANEL_HOTKEY/g)];
  assert.ok(named.length >= 2, 'expected the card hint and the Game Help step');
  for (const m of named) {
    const before = js.slice(Math.max(0, m.index - 700), m.index);
    assert.ok(before.includes('popoutHotkeyUsable()'), `hotkey named without a popoutHotkeyUsable() check near: ${js.slice(m.index - 120, m.index)}`);
  }
});

test('Game Help does not apply one game\'s route lookup to another game\'s dialog', () => {
  // 2026-09-18: openHelp awaited gameRoute and then toggled the Run without OptiScaler / Try DXVK
  // buttons with no check that the dialog was still on the same game.
  const body = js.slice(js.indexOf('async function openHelp(game)'), js.indexOf("$('#help-dxvk').addEventListener"));
  assert.ok(body.length > 0, 'could not find openHelp');
  const routeAt = body.indexOf('await window.api.gameRoute(');
  assert.ok(routeAt > 0);
  assert.ok(body.slice(routeAt, routeAt + 300).includes('if (helpGame !== game) return;'), 'no helpGame check after gameRoute');
  const firstAwait = body.indexOf('await ');
  const hideNative = body.indexOf("$('#help-native').classList.add('hidden')");
  const hideDxvk = body.indexOf("$('#help-dxvk').classList.add('hidden')");
  assert.ok(hideNative > 0 && hideNative < firstAwait, 'Run without OptiScaler is not hidden before the first await');
  assert.ok(hideDxvk > 0 && hideDxvk < firstAwait, 'Try DXVK is not hidden before the first await');
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
