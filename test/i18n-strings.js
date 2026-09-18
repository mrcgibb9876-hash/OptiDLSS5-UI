'use strict';
// Every English string the renderer shows through the i18n layer, read from the source as text:
// literal t('...') calls in the renderer scripts, and data-i18n / data-i18n-placeholder /
// data-i18n-title / data-tip in the HTML. Used by i18n-coverage.test.js, and handy from the command
// line when adding strings:  node test/i18n-strings.js --report [--list]  lists what each language is missing.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const SCRIPTS = ['renderer.js', 'panel.js'];
const PAGES = ['index.html', 'panel.html'];

// i18n.js's own key normalisation.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// A JS string literal starting at src[i] (quote included); returns [value, end] or null.
function readJsString(src, i) {
  const q = src[i];
  if (q !== '\'' && q !== '"' && q !== '`') return null;
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j += 2;
    else if (q === '`' && src[j] === '$' && src[j + 1] === '{') return null; // an interpolated template is not a key
    else j += 1;
  }
  const literal = src.slice(i, j + 1);
  const value = q === '`'
    ? vm.runInNewContext(literal)
    : vm.runInNewContext(literal);
  return [value, j + 1];
}

// t('a') and t('a' + 'b') with only literals: the first argument, if it is one.
function tCalls(src) {
  const out = [];
  const re = /(^|[^A-Za-z0-9_$.])t\(\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let value = '';
    let ok = false;
    for (;;) {
      const r = readJsString(src, i);
      if (!r) { ok = false; break; }
      value += r[0];
      i = r[1];
      ok = true;
      const plus = /^\s*\+\s*/.exec(src.slice(i));
      if (!plus || !/^['"`]/.test(src.slice(i + plus[0].length))) break;
      i += plus[0].length;
    }
    if (!ok) continue;
    if (!/^\s*[,)]/.test(src.slice(i))) continue; // 'a' + something else: not a whole key
    out.push(value);
  }
  return out;
}

const decodeEntities = (s) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&apos;/g, '\'')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// innerHTML as a browser would serialise it for the simple markup these pages use: void elements
// without the slash, text entities other than &amp; &lt; &gt; decoded.
function serialiseInner(s) {
  return s
    .replace(/<(br|hr|img|input|wbr)([^>]*?)\s*\/>/gi, '<$1$2>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&apos;/g, '\'').replace(/&nbsp;/g, ' ');
}

function htmlStrings(html) {
  const out = [];
  // <tag ... data-i18n ...>inner</tag>, matched to the same tag name; nested same-name tags are not
  // used on data-i18n elements in these pages.
  for (const m of html.matchAll(/<([a-zA-Z0-9]+)((?:\s[^>]*?)?\sdata-i18n(?=[\s>=])[^>]*)>([\s\S]*?)<\/\1>/g)) {
    out.push(norm(serialiseInner(m[3])));
  }
  for (const attr of ['placeholder', 'title', 'data-tip']) {
    const marker = attr === 'data-tip' ? null : `data-i18n-${attr}`;
    for (const m of html.matchAll(/<[a-zA-Z0-9]+(\s[^>]*)>/g)) {
      const attrs = m[1];
      if (marker && !new RegExp(`\\s${marker}(?=[\\s>=]|$)`).test(attrs)) continue;
      const v = new RegExp(`\\s${attr}="([^"]*)"`).exec(attrs);
      if (v && v[1].trim() && !v[1].includes('${')) out.push(norm(decodeEntities(v[1])));
    }
  }
  return out;
}

function collect() {
  const keys = new Map(); // normalised key -> first place it was seen
  const add = (k, where) => { const n = norm(k); if (n && !keys.has(n)) keys.set(n, where); };
  for (const f of SCRIPTS) for (const k of tCalls(fs.readFileSync(path.join(RENDERER, f), 'utf8'))) add(k, f);
  for (const f of PAGES) for (const k of htmlStrings(fs.readFileSync(path.join(RENDERER, f), 'utf8'))) add(k, f);
  return keys;
}

function locales() {
  const dir = path.join(RENDERER, 'locales');
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const ctx = { window: { I18N: { register: (code, dict) => { out[code] = Object.fromEntries(Object.entries(dict).map(([k, v]) => [norm(k), v])); } } } };
    vm.runInNewContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return out;
}

function missing() {
  const keys = collect();
  const locs = locales();
  const out = {};
  for (const [code, dict] of Object.entries(locs)) out[code] = [...keys.keys()].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
  return { keys, locs, missing: out };
}

module.exports = { norm, tCalls, htmlStrings, collect, locales, missing };

if (require.main === module && process.argv.includes('--report')) {
  const { keys, missing: m } = missing();
  console.log(`${keys.size} strings`);
  for (const [code, list] of Object.entries(m)) console.log(`${code}: ${list.length} missing`);
  if (process.argv.includes('--list')) {
    const union = [...new Set(Object.values(m).flat())];
    console.log(JSON.stringify(union.map((k) => [k, keys.get(k)]), null, 1));
  }
}
