'use strict';
// Every string the renderer shows through i18n has a translation in every language (#80: "Install"
// itself and the whole Analyse/Verify/Checks flow shipped in English because nothing noticed).
// The strings are read from the source as text by i18n-strings.js: literal t('...') calls in
// renderer.js and panel.js, and data-i18n / data-i18n-placeholder / data-i18n-title / data-tip in
// index.html and panel.html. A string built at run time (t(variable)) is not seen here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const strings = require('./i18n-strings');

// Names and key combinations that read the same in every language.
const SAME_EVERYWHERE = new Set(['Luma', 'Discord', 'Alt+Shift+Home']);

const LANGUAGES = ['de', 'es', 'fr', 'ko', 'pt-BR', 'ru', 'zh-CN'];

test('the scanner sees the renderer\'s strings', () => {
  const keys = strings.collect();
  assert.ok(keys.size > 900, `${keys.size} strings found`);
  for (const k of ['Install', 'Analyse game', 'Verify install', 'Why this route?', 'Scan for Games', 'Settings']) {
    assert.ok(keys.has(k), `"${k}" is collected`);
  }
});

test('the scanner reads t() arguments and markup the way i18n.js keys them', () => {
  assert.deepEqual(strings.tCalls("x = t('A \\'quoted\\' key'); y = t(\"B\" + ' c', { n }); z = t(name); w = it('no');"), ["A 'quoted' key", 'B c']);
  assert.deepEqual(strings.tCalls('t(`templ ${x}`); t(`plain`);'), ['plain']);
  assert.deepEqual(strings.htmlStrings('<p class="h" data-i18n>Two\n   lines<br/>here</p> <input data-i18n-placeholder placeholder="Find &amp; go"> <span data-tip="Tip &quot;x&quot;">?</span>'),
    ['Two lines<br>here', 'Find & go', 'Tip "x"']);
});

test('every language has every string the renderer shows', () => {
  const { missing } = strings.missing();
  assert.deepEqual(Object.keys(missing).sort(), [...LANGUAGES].sort(), 'all seven locale files load');
  for (const code of LANGUAGES) {
    const gaps = missing[code].filter((k) => !SAME_EVERYWHERE.has(k));
    assert.deepEqual(gaps, [], `${code} is missing ${gaps.length} string(s)`);
  }
});

test('every translation keeps its key\'s {placeholders}', () => {
  const locs = strings.locales();
  const holes = (s) => (String(s).match(/\{[A-Za-z]+\}/g) || []).sort().join(',');
  for (const code of LANGUAGES) {
    const bad = Object.entries(locs[code]).filter(([k, v]) => [...new Set(holes(k).split(','))].join() !== [...new Set(holes(v).split(','))].join());
    assert.deepEqual(bad.map(([k]) => k), [], `${code}: translations that drop or rename a placeholder`);
  }
});

test('main-window tooltips go through t(), so English data-tip markup is translated', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const body = /function showTip\(target\) \{([\s\S]*?)\n\}/.exec(js);
  assert.ok(body, 'showTip exists');
  assert.match(body[1], /t\(raw\)/, 'showTip translates the data-tip text');
});
