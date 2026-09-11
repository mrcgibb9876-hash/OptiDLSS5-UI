// UI language for the renderer. gettext-style: the English text IS the key, so the code stays
// readable in English, a language file is a flat English -> translation map, and anything a
// language file does not cover falls back to English rather than to a bare key.
//
//   t('Installing…')                         -> looked up as-is
//   t('Installed {tag}.', { tag })           -> looked up, then {tag} substituted
//   <button data-i18n>Settings</button>      -> static HTML, translated by applyStatic() below;
//                                               the element's original English is kept in
//                                               data-i18n-src so re-applying (language change)
//                                               translates from English again, not from the
//                                               previous translation.
//   <input data-i18n-placeholder>            -> same for placeholder, data-i18n-title for title.
//
// Keys and HTML sources are whitespace-normalised (runs of whitespace collapse to one space, ends
// trimmed) so a hint wrapped across several lines in index.html matches its single-line key.
//
// Language files register themselves: window.I18N.register('pt-BR', { ... }). They are plain
// scripts loaded before renderer.js, like everything else in this renderer -- no bundler, no
// modules. English needs no file.

window.I18N = (() => {
  const dicts = { en: {} };
  let locale = 'en';

  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  function register(code, dict) {
    const out = {};
    for (const [k, v] of Object.entries(dict || {})) out[norm(k)] = v;
    dicts[code] = out;
  }

  function available() {
    return Object.keys(dicts);
  }

  // What the OS says, narrowed to a language this app ships. Portuguese of any region gets
  // pt-BR: it is the only Portuguese here, and a pt-PT file can take precedence later. Russian
  // and Korean have no regional variants worth splitting.
  function detect() {
    const lang = String(navigator.language || 'en').toLowerCase();
    if (lang.startsWith('pt')) return 'pt-BR';
    if (lang.startsWith('ru')) return 'ru';
    if (lang.startsWith('ko')) return 'ko';
    return 'en';
  }

  function t(key, vars) {
    const k = norm(key);
    const dict = dicts[locale] || {};
    let s = Object.prototype.hasOwnProperty.call(dict, k) ? dict[k] : k;
    if (vars) for (const [name, value] of Object.entries(vars)) s = s.split(`{${name}}`).join(String(value));
    return s;
  }

  function applyStatic(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
      if (!el.dataset.i18nSrc) el.dataset.i18nSrc = norm(el.innerHTML);
      el.innerHTML = t(el.dataset.i18nSrc);
    }
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
      if (!el.dataset.i18nSrc) el.dataset.i18nSrc = norm(el.placeholder);
      el.placeholder = t(el.dataset.i18nSrc);
    }
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      if (!el.dataset.i18nSrc) el.dataset.i18nSrc = norm(el.title);
      el.title = t(el.dataset.i18nSrc);
    }
  }

  function setLocale(code) {
    locale = dicts[code] ? code : 'en';
    document.documentElement.lang = locale;
    applyStatic();
    return locale;
  }

  return { t, register, available, detect, setLocale, applyStatic, get locale() { return locale; } };
})();

// Short alias for the renderer.
window.t = window.I18N.t;
