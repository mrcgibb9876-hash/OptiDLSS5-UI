// The pop-out DLSS 5 panel's renderer.
//
// This window is the in-game DLSS 5 Developer Controls panel, outside the game: the same sections in
// the same order, the same rows with the same labels, drawn in the engine's own palette (panel.css).
// The two are the same panel in two places, so a user who learns one does not have to relearn the
// other -- and the settings themselves are the same file, because every row here goes through
// dlssnr:get / dlssnr:set onto the game's OptiScaler.ini, which the engine re-reads within a second.
//
// What is deliberately not here: the in-game panel's live actions -- Capture 8 frames, Anchor here,
// Show Mask, Retry, the frame-generation state readout. Those act on a frame being drawn right now,
// or report what the engine is doing; there is no ini key to write for them, so a window outside the
// process has nothing to say.

const $ = (sel) => document.querySelector(sel);

let targets = [];
let current = null;
let fields = [];
let forced = {};
let settings = {};
let light = true;   // the engine's own default is the light panel
let amd = false;

const valueOf = (key) => {
  const f = fields.find((x) => x.key === key);
  return f ? (f.value === null ? f.default : f.value) : null;
};

// ── Chrome ──────────────────────────────────────────────────────────────────────────────────────

// The language is the game's own [DlssNr] Language -- the very key the in-game panel reads -- so
// the two panels are never in different languages for the same game. It falls back to this app's
// Settings, and then to Windows. Resolved through I18N.resolve because the engine lower-cases what
// it writes (pt-br, zh-cn) and the dictionaries are keyed pt-BR and zh-CN.
function applyLanguage() {
  const field = fields.find((f) => f.key === 'Language');
  const fromGame = field ? I18N.resolve(field.value) : null;
  I18N.setLocale(fromGame || I18N.resolve(settings.language) || I18N.detect());
}

// The panel's own look is a DLSS 5 setting like any other: [DlssNr] LightTheme and VendorColours are
// what the in-game panel reads, so this window reads them too and the two always agree.
function applyChrome() {
  applyLanguage();
  I18N.applyStatic();
  applyStaticTips();
  applyPalette();
}

function applyPalette() {
  const themeField = fields.find((f) => f.key === 'LightTheme');
  const vendorField = fields.find((f) => f.key === 'VendorColours');
  if (themeField) light = themeField.value === null ? themeField.default : themeField.value;
  const vendor = vendorField ? (vendorField.value === null ? vendorField.default : vendorField.value) : true;
  document.body.classList.toggle('is-light', !!light);
  document.body.classList.toggle('is-amd', !!vendor && amd);
}

let tipEl = null;
function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'p-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.classList.toggle('is-lines', target.dataset.tipLines === '1');
  tipEl.classList.remove('show');
  const r = target.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(r.left + r.width / 2 - tipEl.offsetWidth / 2, window.innerWidth - tipEl.offsetWidth - margin));
  let top = r.top - tipEl.offsetHeight - margin;
  if (top < margin) top = r.bottom + margin;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
  tipEl.classList.add('show');
}
const hideTip = () => { if (tipEl) tipEl.classList.remove('show'); };
document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el); });
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hideTip();
});
document.addEventListener('click', hideTip, true);
window.addEventListener('scroll', hideTip, true);

function setStatus(text, accent) {
  const el = $('#p-status');
  el.textContent = text;
  el.className = `p-note${accent ? ' is-accent' : ''}`;
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────

function dependencyMet(field) {
  const d = field.dependsOn;
  if (!d) return true;
  // { all: [...] }: every condition, e.g. Adaptive resolution's "Frame rate" needs it on AND aimed at fps.
  if (Array.isArray(d.all)) return d.all.every((c) => dependencyMet({ dependsOn: c }));
  // { any: [...] }: one condition is enough, e.g. Enlargement matters whenever the model runs small.
  if (Array.isArray(d.any)) return d.any.some((c) => dependencyMet({ dependsOn: c }));
  const v = valueOf(d.key);
  if (d.is !== undefined) return v === d.is;
  if (d.atLeast !== undefined) return Number(v) >= d.atLeast;
  if (d.above !== undefined) return Number(v) > d.above;
  if (d.below !== undefined) return Number(v) < d.below;
  return true;
}

// Paper white runs 0.25 to 2000: linear, its whole usable range would be the first pixel of the
// track. The engine puts those sliders on a log scale and so does this.
const toSlider = (f, v) => (f.log ? Math.log(v / f.min) / Math.log(f.max / f.min) : (v - f.min) / (f.max - f.min));
const fromSlider = (f, t) => (f.log ? f.min * Math.pow(f.max / f.min, t) : f.min + t * (f.max - f.min));

// Keyboard stepping. The sliders are positioned on a 0..1000 scale so a log range can be resolved
// at all, which means the browser's own arrow-key step is a thousandth of the range -- 0.002 of a
// Model pass, 0.175% of Model resolution -- and each field's declared step went unused. These move
// by that step instead, snapped to its grid so repeated presses land on round numbers (1.1, 1.2,
// 1.3) rather than drifting off them, with Page Up/Down for ten at a time and Home/End for the ends.
const STEP_DIR = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 };

function stepOf(field) {
  return Number(field.step) || (field.type === 'int' ? 1 : 0.05);
}

function steppedValue(field, value, dir, big) {
  const step = stepOf(field) * (big ? 10 : 1);
  const snapped = Math.round(value / step) * step;
  // Already on the grid, or snapping moved it the way we were going anyway.
  const next = Math.abs(snapped - value) > 1e-9 && Math.sign(snapped - value) === dir ? snapped : snapped + dir * step;
  const clamped = Math.min(field.max, Math.max(field.min, next));
  return field.type === 'int' ? Math.round(clamped) : Number(clamped.toFixed(6));
}

function formatNumber(field, value) {
  if (field.percent) return `${Math.round(value * 100)}%`;
  if (field.type === 'int') return String(Math.round(value));
  if (field.log) return `${Number(value).toFixed(2)}x`;
  return Number(value).toFixed(2);
}

function row(field, cls) {
  const el = document.createElement('div');
  el.className = `p-row${cls ? ' ' + cls : ''}${field.caps ? ' is-caps' : ''}`;
  return el;
}

// `lines`: keep the text's own line breaks. An add-on's tooltip is written for its own overlay, where
// "\n" is a line break (ReLimiter's run to several paragraphs); this app's tips are single sentences.
function helpMarker(text, lines) {
  const el = document.createElement('span');
  el.className = 'p-help';
  el.textContent = '(?)';
  el.setAttribute('data-tip', text);
  if (lines) el.dataset.tipLines = '1';
  return el;
}

// One row, drawn the way the in-game panel draws that kind of row.
//
// `set` is where a change goes: the ini (apply) for DLSS 5's own rows, the running game for a hosted
// page's (hostedField). A hosted row is the add-on's own text, not ours -- it is shown as written, not
// looked up as a translation key (which would also fold its line breaks), it has no "default" of ours
// to go back to, and the add-on may say it is greyed right now (`disabled`).
function fieldRow(field, set = apply) {
    const tx = field.raw ? (s) => s : t;
    const held = forced[field.key] || null;
    const met = dependencyMet(field) && !held && !field.disabled;
    const shown = field.value === null ? field.default : field.value;

    const label = document.createElement('span');
    label.className = 'p-row-label';
    label.textContent = tx(field.label);

    const ctl = document.createElement('span');
    ctl.className = 'p-row-ctl';

    const value = document.createElement('span');
    value.className = 'p-row-value';

    let el;

    if (field.type === 'bool') {
      el = row(field, 'is-check');
      const box = document.createElement('button');
      box.className = `p-check${shown ? ' on' : ''}`;
      box.disabled = !met;
      box.addEventListener('click', () => set(field.key, !shown));
      ctl.appendChild(box);
      value.textContent = held ? t('held off') : field.value === null ? t('default') : '';
      el.append(ctl, label, value);
    } else if (field.type === 'enum' && (field.segmented || boxedChoices(field))) {
      // Boxed choices rather than a dropdown: the Models row across the whole width, and -- since
      // engine v2.2.8 -- any short list, because the in-game panel now draws a two-to-four option
      // choice as boxes with the active one ringed in the accent. A dropdown hides what the
      // alternatives are until it is opened, and these are choices you flick between.
      el = row(field, 'is-seg');
      if (!field.segmented) el.append(label);
      const seg = document.createElement('span');
      seg.className = 'p-seg';
      // Only where the default is "follow something else" rather than one of the listed values:
      // picking a listed value that happens to be the default is stored as auto anyway.
      const choices = field.default === null ? [[null, t('Default')], ...(field.options || [])] : (field.options || []);
      for (const [v, text] of choices) {
        const b = document.createElement('button');
        b.textContent = tx(text);
        b.disabled = !met;
        b.setAttribute('data-tip', tx(field.help));
        const on = v === null ? field.value === null : String(shown) === String(v);
        if (on) b.classList.add('on');
        b.addEventListener('click', () => set(field.key, v));
        seg.appendChild(b);
      }
      ctl.appendChild(seg);
      el.append(ctl);
    } else if (field.type === 'enum' || field.type === 'code') {
      el = row(field);
      const sel = document.createElement('select');
      sel.className = 'p-select';
      sel.disabled = !met;
      if (!field.hosted) {
        const def = document.createElement('option');
        def.value = 'auto';
        const defOption = (field.options || []).find(([v]) => v === field.default);
        def.textContent = field.default === null
          ? t(field.type === 'code' ? 'Default (follow Windows)' : 'Default (follow pass 1)')
          : t('Default ({state})', { state: defOption ? t(defOption[1]) : String(field.default) });
        sel.appendChild(def);
      }
      for (const [v, text] of field.options || []) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = tx(text);
        sel.appendChild(o);
      }
      sel.value = field.value === null ? 'auto' : String(field.value);
      sel.addEventListener('change', () => set(field.key, sel.value === 'auto' ? null : sel.value));
      ctl.appendChild(sel);
      el.append(label, ctl, value);
    } else {
      el = row(field);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'p-slider';
      slider.min = '0';
      slider.max = '1000';
      slider.step = '1';
      slider.disabled = !met;
      // Auto in charge (dlssnr.js autoKey): the slider shows what Auto is applying, from the live
      // readings, the way the in-game panel does -- and updates with them (renderAutoTone).
      const autoOn = !!(field.autoKey && valueOf(field.autoKey));
      const autoNow = autoOn ? autoToneValue(field) : null;
      const drawn = autoNow !== null ? autoNow : Number(shown);
      slider.value = String(Math.round(toSlider(field, drawn) * 1000));
      slider.style.setProperty('--fill', `${(Number(slider.value) / 10).toFixed(1)}%`);
      value.textContent = held ? t('held off') : formatNumber(field, drawn);
      if (field.autoKey) {
        slider.dataset.autoFor = field.key;
        value.dataset.autoFor = field.key;
      }

      const live = () => {
        const v = fromSlider(field, Number(slider.value) / 1000);
        slider.style.setProperty('--fill', `${(Number(slider.value) / 10).toFixed(1)}%`);
        value.textContent = formatNumber(field, field.type === 'int' ? Math.round(v) : v);
        return v;
      };
      slider.addEventListener('input', live);

      // Held keys repeat, and one ini write per repeat would be dozens a second, so the picture
      // moves at once and the write follows the last press.
      let pending = null;
      slider.addEventListener('keydown', (e) => {
        const dir = STEP_DIR[e.key];
        const ends = e.key === 'Home' || e.key === 'End';
        if (dir === undefined && !ends) return;
        e.preventDefault();
        const at = fromSlider(field, Number(slider.value) / 1000);
        const next = ends ? (e.key === 'Home' ? field.min : field.max)
                          : steppedValue(field, at, dir, e.key.startsWith('Page'));
        slider.value = String(Math.round(toSlider(field, next) * 1000));
        live();
        value.textContent = formatNumber(field, next);
        clearTimeout(pending);
        pending = setTimeout(() => set(field.key, next), 180);
      });
      // Applied when the handle is let go, not while it is moving -- the engine does the same,
      // because every move would otherwise rewrite the ini and rebuild the feature.
      slider.addEventListener('change', () => {
        const v = fromSlider(field, Number(slider.value) / 1000);
        set(field.key, field.type === 'int' ? Math.round(v) : Number(v.toFixed(4)));
      });
      ctl.appendChild(slider);

      const reset = document.createElement('button');
      reset.className = 'p-small';
      reset.textContent = t('Reset');
      reset.disabled = !met || field.value === null;
      reset.addEventListener('click', () => set(field.key, null));

      // A hosted row has no default of ours to reset to -- the add-on's own is not published.
      if (field.hosted) el.append(label, ctl, value);
      else el.append(label, ctl, value, reset);

      // Auto, right beside Reset, as in the in-game panel. Never greyed by the slider's own condition --
      // it is the thing that turns that condition off again.
      if (field.autoKey) {
        const auto = document.createElement('button');
        auto.className = `p-check${autoOn ? ' on' : ''}`;
        auto.disabled = !!held;
        auto.addEventListener('click', () => set(field.autoKey, !autoOn));
        const autoLabel = document.createElement('span');
        autoLabel.className = 'p-auto-label';
        autoLabel.textContent = t('Auto');
        el.append(auto, autoLabel);
      }
    }

    // An Auto row greyed because Auto is on dims only the slider side: the Auto box in the same row is
    // live, and opacity on the whole row would make it look switched off too.
    const autoInCharge = !!(field.autoKey && valueOf(field.autoKey)) && !held;
    el.classList.toggle('is-off', !met && !autoInCharge);
    el.classList.toggle('is-auto', autoInCharge);
    // An add-on setting may come with no tooltip at all; a (?) that opens nothing is noise.
    const help = held ? t(held) : tx(field.help);
    if (help) el.appendChild(helpMarker(help, field.raw));
  return el;
}

// Two to four options are drawn as boxes rather than a dropdown, as the in-game panel's NrCombo
// does. More than four and the boxes are too narrow to read, so those stay a dropdown -- and a
// keybind is a list of every key on the keyboard, whatever it is offering today.
function boxedChoices(field) {
  if (field.keybind || !Array.isArray(field.options)) return false;
  const count = field.options.length + (field.default === null ? 1 : 0);
  return count >= 2 && count <= 4;
}

// A label wider than its column used to run into the slider beside it. When it does, the row stacks:
// label on its own line, control under it -- the same thing the in-game panel does when the label
// measures wider than 44% of the row.
function stackLongLabels(host) {
  for (const label of host.querySelectorAll('.p-row > .p-row-label')) {
    if (label.scrollWidth > label.clientWidth + 1) label.parentElement.classList.add('is-stack');
  }
  // The same for boxed choices whose words do not fit the boxes. The engine measures the widest
  // option first and falls back to a dropdown; here the row gets the whole width instead, which
  // keeps the choice visible rather than folding it away.
  for (const box of host.querySelectorAll('.p-row.is-seg .p-seg button')) {
    if (box.scrollWidth > box.clientWidth + 1) box.closest('.p-row').classList.add('is-stack');
  }
}

// ── The panel's pages ───────────────────────────────────────────────────────────────────────────
//
// The in-game panel is six pages picked at the top, and this window is that panel: the same pages,
// holding the same sections, in the same order, under the same names. The layout comes with the
// fields (src/dlssnr.js PAGES), so there is one description of it rather than two that drift.
//
// The page is where you are, not a setting: it lasts as long as the window and opens on Main, which
// is exactly what the engine's own does.
let pages = [];
let headerKeys = [];
let page = 'Main';

function renderPages() {
  const host = $('#p-pages');
  host.innerHTML = '';
  if (pages.length === 0) return;

  // Every page is listed, Pacing and HDR included whether or not their add-on is in the game -- as
  // in-game. Without it the page greys itself and says why (renderHosted).
  for (const p of pages) {
    const b = document.createElement('button');
    b.textContent = t(p.page);
    if (p.page === page) b.classList.add('on');
    b.addEventListener('click', () => { page = p.page; renderPages(); renderFields(); });
    host.appendChild(b);
  }
}

// Above the pages' rows and on every one of them: whether the pass runs, where it sits, and the
// badge saying whether it is actually doing anything. The in-game panel draws these three rows and
// the badge before any page, for the same reason -- they are the answer to "is this on", and going
// looking for that on a page would be one click too many.
function renderHead() {
  const host = $('#p-head');
  host.innerHTML = '';
  if (fields.length === 0) return;

  for (const key of headerKeys) {
    const field = fields.find((f) => f.key === key);
    if (field) host.appendChild(fieldRow(field));
  }

  const badge = document.createElement('div');
  badge.id = 'p-badge';
  host.appendChild(badge);
  renderBadge();
}

// The state of the pass in one word, filled in the accent when it is running and flat when it is
// not, so "is this doing anything" is answered before a sentence is read. The engine's StatusBadge,
// in the same place and the same words.
function renderBadge() {
  const el = document.getElementById('p-badge');
  if (!el) return;
  const nr = (lastLive && lastLive.nr) || null;
  const enabled = !!valueOf('Enabled');
  const live = enabled && !!(nr && nr.running);
  const text = !enabled ? t('Paused')
    : live ? t('Ready')
    : nr && nr.reason ? t('Blocked')
    : t('Waiting');
  el.className = `p-badge${live ? ' is-live' : ''}`;
  el.textContent = text;
}

// The two resets, at the foot of Main: one puts the window back where it opens, the other puts this
// game's tuning back to what it ships with. Together at the bottom rather than in the top strip --
// a reset is a thing you go looking for, not something to have under a thumb.
function renderResets(host) {
  const foot = document.createElement('div');
  foot.className = 'p-foot';

  const layout = document.createElement('button');
  layout.className = 'p-small';
  layout.textContent = t('Reset layout');
  layout.addEventListener('click', () => window.api.panelResetLayout());
  foot.append(layout, helpMarker(t('Puts this window back where it opens, at its own size.')));

  const all = document.createElement('button');
  all.className = 'p-small';
  all.textContent = t('Reset all to defaults');
  all.addEventListener('click', resetAll);
  foot.append(all, helpMarker(t('Every DLSS 5 setting for this game back to what it ships with. Kept: the keys that open the panel, and whether it is light or dark.')));

  host.appendChild(foot);
}

// What the engine's ResetSettingsToDefaults keeps: the keys that open the panel, and how the panel
// itself looks. Those are the user's, not this game's tuning, and a reset that changed the language
// out from under someone would be a poor way to find that out.
const PERSONAL_KEYS = ['PanelKey', 'LightTheme', 'VendorColours', 'Language', 'FontScale'];

async function resetAll() {
  const values = {};
  for (const f of fields) {
    if (!PERSONAL_KEYS.includes(f.key) && f.value !== null) values[f.key] = null;
  }
  if (Object.keys(values).length === 0) { setStatus(t('Nothing to change.'), true); return; }
  await applyMany(values);
}

function renderFields() {
  const host = $('#p-fields');
  host.innerHTML = '';
  if (fields.length === 0) return;

  const shown = pages.find((p) => p.page === page) || pages[0];
  if (!shown) return;

  for (const section of shown.sections) {
    if (section.caption) {
      const cap = document.createElement('div');
      cap.className = 'p-caption';
      cap.textContent = t(section.caption);
      host.appendChild(cap);
    }

    // Before the keys, as in the engine's own Guide section: it is the one thing here that can be
    // wrong rather than merely set badly.
    if (section.motion) renderMotion(host);

    // An add-on's own settings, as the running game reports them -- not ini keys, so drawn from there.
    if (section.hosted) renderHosted(host, section.hosted);

    for (const key of section.keys) {
      const field = fields.find((f) => f.key === key);
      if (field) host.appendChild(fieldRow(field));
    }

    // Frame Generation is the game's own DLSS-G rather than a list of ini rows, so it draws itself.
    if (section.frameGen) renderFrameGen(host);
  }

  if (shown.page === 'Main') renderResets(host);
  stackLongLabels(host);
}

const apply = (key, value) => applyMany({ [key]: value });

// One write, whatever it touches: a row, or every row at once for "Reset all to defaults". The ini
// is written once either way, so a reset is a single change for a running game to pick up rather
// than sixty.
async function applyMany(values) {
  if (!current) return;
  const res = await window.api.dlssNrSet(current.exePath, values);
  if (!res || !res.ok) {
    setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') }));
    return;
  }
  fields = res.fields;
  applyChrome();
  setStatus(res.written.length
    ? (current.running ? t('Saved. A running game picks it up within a second.') : t('Saved. Applies the next time the game starts.'))
    : t('Nothing to change.'), true);
  renderHead();
  renderFields();
}

async function loadGame(exePath) {
  current = targets.find((g) => g.exePath === exePath) || null;
  fields = [];
  forced = {};
  // The last game's Pacing/HDR pages are not this one's; they come back with its first answer.
  forgetHosted();

  if (!current) {
    stopTimingPoll();
    renderTiming(null);
    renderHead();
    renderFields();
    setStatus(t('Pick a game.'));
    return;
  }

  const res = await window.api.dlssNrGet(current.exePath);
  if (!res || !res.ok) {
    stopTimingPoll();
    renderTiming(null);
    renderHead();
    renderFields();
    setStatus(res && res.error === 'not-installed'
      ? t('OptiScaler is not installed for this game yet.')
      : t('Could not read the settings: {error}', { error: (res && res.error) || t('unknown') }));
    return;
  }

  fields = res.fields || [];
  forced = res.forced || {};
  // The page layout comes with the fields, so this window cannot end up drawing a different panel
  // from the one in the game.
  pages = res.pages || pages;
  headerKeys = res.headerKeys || headerKeys;
  await loadFrameGen();
  await loadMotion();
  applyChrome();
  renderPages();
  renderHead();
  renderFields();
  setStatus(res.inHelper
    ? t('Editing the 64-bit helper this 32-bit game uses.')
    : current.running ? t('Game is running. Changes land within a second.') : t('Game is not running. Changes apply when it starts.'));
  startTimingPoll();
}

// The engine writes its timing every 600 frames, so there is nothing to gain from asking faster
// than a few seconds -- and this reads a file, so asking faster would only cost. The poll runs
// while the panel is open and stops when it is hidden, since the window is only hidden, never
// destroyed: a timer left running would keep reading logs for a panel nobody is looking at.
const TIMING_POLL_MS = 3000;
// Past this the reading is from a session that has stopped, not from what is on screen now.
const TIMING_STALE_MS = 30000;
let timingTimer = null;

function renderTiming(timing) {
  // The live readout owns the box while the engine answers; the log timing is the fallback for an
  // engine without the live writer, or a game that is not running.
  if (lastLive) return;
  const box = $('#p-timing');
  if (!timing || !timing.ok || timing.msPerFrame === null) {
    // A game that is running but has not reached its first report yet is worth saying, because the
    // wait is otherwise unexplained. Anything else just leaves the readout off.
    if (timing && timing.ok && timing.gpuUnavailable && current && current.running) {
      box.hidden = false;
      box.classList.add('is-stale');
      $('#p-timing-ms').textContent = t('No GPU timing');
      $('#p-timing-fps').textContent = '';
      $('#p-timing-sub').textContent = t('The engine could not time the GPU here ({reason}).', { reason: timing.gpuUnavailable });
      return;
    }
    box.hidden = true;
    return;
  }

  const stale = !current || !current.running || (Date.now() - timing.atMs) > TIMING_STALE_MS;
  box.hidden = false;
  box.classList.toggle('is-stale', stale);
  $('#p-timing-ms').textContent = t('{ms} ms per frame', { ms: timing.msPerFrame.toFixed(2) });
  $('#p-timing-fps').textContent = timing.fps ? t('at {fps} fps', { fps: Math.round(timing.fps) }) : '';

  const parts = [];
  if (timing.modelMs !== null) {
    parts.push(t('{model} ms model + {ours} ms ours', { model: timing.modelMs.toFixed(2), ours: timing.oursMs.toFixed(2) }));
  }
  parts.push(t('{frames} frames', { frames: timing.frames.toLocaleString() }));
  if (timing.failures > 0) parts.push(t('{n} model failures', { n: timing.failures }));
  if (stale) parts.push(t('from the last run'));
  $('#p-timing-sub').textContent = parts.join('  ·  ');
}

async function refreshTiming() {
  if (!current || !current.exePath) { renderTiming(null); return; }
  try {
    renderTiming(await window.api.panelTiming(current.exePath));
  } catch {
    renderTiming(null);
  }
}

function startTimingPoll() {
  stopTimingPoll();
  refreshTiming();
  timingTimer = setInterval(refreshTiming, TIMING_POLL_MS);
  refreshLive();
  liveTimer = setInterval(refreshLive, LIVE_POLL_MS);
}

function stopTimingPoll() {
  if (timingTimer !== null) { clearInterval(timingTimer); timingTimer = null; }
  if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }
  stopLive();
}

// The panel is hidden rather than closed, so 'hidden' is the only signal that nobody is watching.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTimingPoll();
  else if (current) startTimingPoll();
});

// ── Live ────────────────────────────────────────────────────────────────────────────────────────
//
// What the in-game panel shows from inside the process -- fps, VRAM, whether the pass is running,
// Adaptive resolution's state, frame generation's -- read from OptiScaler.live.json, which the engine
// writes about twice a second only while this panel asks (main.js panel:live). Half a second here
// matches the writer; the log timing above stays as the fallback for an engine that never answers.
const LIVE_POLL_MS = 500;
let liveTimer = null;
let lastLive = null;
let liveFor = null;

// What Auto brightness / Auto contrast are applying now (OptiScaler.live.json tone), or null before the
// first reading -- the slider then shows its own value.
function autoToneValue(field) {
  const tone = lastLive && lastLive.tone;
  const v = tone && field.autoLive ? tone[field.autoLive] : null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Moves the greyed sliders with the live readings, without redrawing the page under the cursor.
function renderAutoTone() {
  for (const field of fields) {
    if (!field.autoKey || !valueOf(field.autoKey)) continue;
    const v = autoToneValue(field);
    if (v === null) continue;
    for (const el of document.querySelectorAll(`[data-auto-for="${field.key}"]`)) {
      if (el.tagName === 'INPUT') {
        el.value = String(Math.round(toSlider(field, v) * 1000));
        el.style.setProperty('--fill', `${(Number(el.value) / 10).toFixed(1)}%`);
      } else {
        el.textContent = formatNumber(field, v);
      }
    }
  }
}

function stopLive() {
  if (liveFor) window.api.panelLiveStop(liveFor).catch(() => {});
  liveFor = null;
  lastLive = null;
  forgetHosted();
}

async function refreshLive() {
  if (!current || !current.exePath) return;
  const exePath = current.exePath;
  let res = null;
  try { res = await window.api.panelLive(exePath); } catch { res = null; }
  if (!current || current.exePath !== exePath || liveTimer === null) return;
  liveFor = exePath;
  const had = !!lastLive;
  lastLive = res && res.ok ? res.live : null;
  if (lastLive) renderLive(lastLive);
  else if (had) refreshTiming();
  renderBadge();
  renderFrameGenStatus();
  renderAutoTone();
  await refreshHosted();
}

// The status line Adaptive resolution shows under its rows in the in-game panel, in the same words.
function autoScaleText(a, shownFps) {
  if (!a || !a.on) return null;
  if (a.state === 'settling' || a.scale === null) return t('Adaptive resolution: waiting for the pass to run');
  const scale = Math.round(a.scale * 100);
  if (a.state === 'short') return t('At {scale}% and still short of {fps} fps - the rest of the frame is the game\'s, not DLSS 5\'s.', { scale, fps: a.fps });
  if (a.mode === 1) return t('Holding the pass under {ms} ms - model at {scale}%', { ms: Number(a.ms).toFixed(1), scale });
  if (a.mode === 0) return t('Holding the pass to {share}% of the frame - model at {scale}%', { share: a.share, scale });
  // "Holding" only when it is: below the target and not at the floor, the controller is still stepping down.
  if (shownFps > 0 && shownFps < a.fps * 0.95) {
    return t('Heading for {fps} fps - now {now}, model at {scale}%', { fps: a.fps, now: Math.round(shownFps), scale });
  }
  return t('Holding {fps} fps - model at {scale}%', { fps: a.fps, scale });
}

function renderLive(l) {
  const box = $('#p-timing');
  box.hidden = false;
  box.classList.remove('is-stale');
  // With frame generation on, the frames the game rendered and what reaches the screen are both shown -- a
  // frame rate target means the second, and the two are easy to confuse (engine v2.1.4 "rates").
  const r = l.rates || null;
  if (r && r.multiplier >= 2 && r.rendered > 0) {
    $('#p-timing-ms').textContent = t('{rendered} fps rendered, {shown} with frame generation', {
      rendered: Math.round(r.rendered),
      shown: (r.estimated ? '~' : '') + Math.round(r.shown),
    });
  } else {
    $('#p-timing-ms').textContent = l.fps === null ? t('Measuring...') : t('{fps} fps', { fps: Math.round(l.fps) });
  }

  const main = [];
  if (l.frameMs !== null) main.push(t('{ms} ms per frame', { ms: Number(l.frameMs).toFixed(1) }));
  if (l.vramUsedGb !== null && l.vramBudgetGb !== null) {
    main.push(t('VRAM {used} / {budget} GB', { used: Number(l.vramUsedGb).toFixed(1), budget: Number(l.vramBudgetGb).toFixed(1) }));
  }
  $('#p-timing-fps').textContent = main.join('  ·  ');

  const sub = [];
  const nr = l.nr || {};
  if (!nr.enabled) sub.push(t('DLSS 5 off'));
  else if (!nr.running) sub.push(t('DLSS 5 on, waiting for the game'));
  else if (nr.modelMs !== null && nr.modelMs !== undefined) sub.push(t('DLSS 5 running, model {ms} ms', { ms: Number(nr.modelMs).toFixed(2) }));
  else sub.push(t('DLSS 5 running'));
  const adaptive = autoScaleText(l.autoScale, r && r.shown > 0 ? r.shown : (l.fps || 0));
  if (adaptive) sub.push(adaptive);
  $('#p-timing-sub').textContent = sub.join('  ·  ');
}

// ── Pacing and HDR ──────────────────────────────────────────────────────────────────────────────
//
// The in-game panel's last two pages: ReLimiter's frame pacing and RenoDX's HDR, each drawn from what
// the add-on itself describes. Neither can be changed through a file while the game runs (they read
// their ini once, and ReLimiter writes its own back on exit), so these rows reach the running game
// instead: the engine publishes the add-ons' settings (main.js panel:hosted) and applies what is
// changed here through their host APIs (panel:hosted-set). No game running, no page.
//
// What a row shows is what the add-on reports. A change is shown at once, then held until the engine
// acknowledges it -- the file read in between still carries the value from before, and drawing that
// would flick the control back for a moment.
let lastHosted = null;        // dlssnr.checkHosted's answer for the current game, or null
let hostedSig = '';           // what was last drawn, so an unchanged poll redraws nothing
let hostedWait = null;        // { seq, pid } of the last command not yet acknowledged
let hostedDragging = false;   // a slider is held: redrawing would drop it out of the user's hand
let hostedPending = null;     // { exePath, pacing, hdr }: changes gathered for the next write
let hostedTimer = null;
// A burst of changes -- a held arrow key, a Reset-and-pick -- goes out as one command.
const HOSTED_COALESCE_MS = 150;

document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('.p-hosted .p-slider')) hostedDragging = true; });
document.addEventListener('pointerup', () => { hostedDragging = false; });
// A slider let go outside the window never sends this document its pointerup, and the flag then held
// every hosted redraw off for good. Leaving the window, or the pointer being taken away, ends the drag.
document.addEventListener('pointercancel', () => { hostedDragging = false; });
window.addEventListener('blur', () => { hostedDragging = false; });

function forgetHosted() {
  if (hostedTimer !== null) { clearTimeout(hostedTimer); hostedTimer = null; flushHosted(); }
  lastHosted = null;
  hostedSig = '';
  hostedWait = null;
}

async function refreshHosted() {
  if (!current || !current.exePath) return;
  const exePath = current.exePath;
  let res = null;
  try { res = await window.api.panelHosted(exePath); } catch { res = null; }
  if (!current || current.exePath !== exePath) return;
  const next = res && res.ok ? res.hosted : null;

  // Our last change has not landed yet: keep showing it. A different process means the game was
  // restarted and that change never will land, so stop waiting.
  if (next && hostedWait && next.pid === hostedWait.pid && next.ack < hostedWait.seq) return;
  hostedWait = null;
  if (hostedPending) return;

  // Whether the live readings answer is part of it: it is what tells "too old an engine" from "no game".
  const sig = JSON.stringify(next ? [next.pacing, next.hdr] : [null, !!lastLive]);
  if (sig === hostedSig) return;
  // Not while a slider is held or a number is being typed; the next poll after that draws this.
  if (hostedDragging || hostedTyping()) return;
  lastHosted = next;
  hostedSig = sig;
  const shown = pages.find((p) => p.page === page);
  if (shown && shown.sections.some((s) => s.hosted)) renderFields();
}

// Why a hosted page is greyed, in one plain line. The engine's codes are DlssNr_ReLimiter.h's and
// DlssNr_RenoDx.h's, and the in-game page says the same thing in the same words.
function hostedMissingText(kind) {
  const h = lastHosted && lastHosted[kind];
  if (!h) {
    // The game answers the live readings but not this: its engine predates the hosted pages.
    if (lastLive) return t('This game\'s DLSS 5 engine is too old to show these settings here. Update DLSS 5 from the app.');
    return t('The game is not running. These settings can be changed here while it runs.');
  }
  const pacing = kind === 'pacing';
  switch (h.reason) {
    case 'no-api':
      return pacing
        ? t('ReLimiter is running, but this build of it cannot be driven from this panel -- its own overlay still works. Adding frame pacing again from the app installs one that can.')
        : t('RenoDX is running, but this build of it cannot be driven from this panel -- its own overlay still works.');
    case 'api-version':
      return pacing
        ? t('ReLimiter is running, but it speaks a different version of the panel\'s interface than this DLSS 5 engine. Update DLSS 5 or frame pacing from the app.')
        : t('RenoDX is running, but it speaks a different version of the panel\'s interface than this DLSS 5 engine. Update DLSS 5 or RenoDX from the app.');
    case 'empty':
      return t('The add-on is running but offers no settings this panel can show.');
    default:
      return pacing
        ? t('Frame pacing is not installed on this game -- turn it on from the app\'s card or the pop-out; it takes effect the next time the game starts.')
        : t('HDR (RenoDX) is not installed on this game -- turn it on from the app\'s card or the pop-out; it takes effect the next time the game starts.');
  }
}

// A setting as a row fieldRow can draw. The key is prefixed so it can never meet an ini key of the
// same name in `forced` or a dependency; the add-on's own key goes to the game.
function hostedField(kind, s) {
  const base = {
    key: `${kind}:${s.key}`, label: s.label, help: s.tooltip, raw: true, hosted: true,
    disabled: !s.enabled, value: s.value, default: s.value, dependsOn: null,
  };
  if (s.type === 'bool') return { ...base, type: 'bool' };
  if (s.type === 'enum') return { ...base, type: 'enum', options: s.choices.map((c) => [c, c]) };
  // RenoDX's combo: the value IS the index, as in-game.
  if (s.type === 'combo') return { ...base, type: 'enum', options: s.labels.map((l, i) => [i, l]) };
  const int = s.type === 'int';
  // A keyboard step of about a hundredth of the range, on a round number: 30..1000 moves by 10.
  const step = int ? 1 : Number(((s.max - s.min) / 100).toPrecision(1));
  return { ...base, type: int ? 'int' : 'float', min: s.min, max: s.max, step };
}

// What a control hands back, as the add-on's type wants it: a select gives strings.
function hostedValue(s, v) {
  if (s.type === 'bool') return !!v;
  if (s.type === 'enum') return String(v);
  if (s.type === 'combo' || s.type === 'int') return Math.round(Number(v));
  return Number(v);
}

function hostedApply(kind, s, value) {
  if (!current) return;
  s.value = value;
  if (!hostedPending || hostedPending.exePath !== current.exePath) {
    if (hostedTimer !== null) { clearTimeout(hostedTimer); flushHosted(); }
    hostedPending = { exePath: current.exePath, pacing: {}, hdr: {} };
  }
  hostedPending[kind][s.key] = value;
  clearTimeout(hostedTimer);
  hostedTimer = setTimeout(flushHosted, HOSTED_COALESCE_MS);
  renderFields();
}

async function flushHosted() {
  hostedTimer = null;
  const batch = hostedPending;
  hostedPending = null;
  if (!batch) return;
  let res = null;
  try { res = await window.api.panelHostedSet(batch.exePath, { pacing: batch.pacing, hdr: batch.hdr }); } catch { res = null; }
  if (!current || current.exePath !== batch.exePath) return;
  if (!res || !res.ok) {
    // The game went away between drawing the row and the change: show what is really there.
    hostedSig = '';
    setStatus(t('The game did not answer, so nothing was changed. Is it still running?'));
    return;
  }
  hostedWait = { seq: res.seq, pid: res.pid };
  setStatus(t('Sent to the running game.'), true);
}

function renderHosted(host, kind) {
  const h = lastHosted && lastHosted[kind];

  // THE HOOK for turning the add-on on or off from here. Empty on purpose: installing it is the app's
  // job (relimiter:install, the add-ons picker), not the running game's, and that control is drawn by
  // whoever fills this -- a function renderHostedEnable(el, kind, state) defined in this file, called
  // on every draw of the page. `state` is what this page knows: whether the game answered at all, and
  // the add-on's availability and reason as the engine reported them.
  const enable = document.createElement('div');
  enable.className = 'hosted-enable';
  enable.dataset.kind = kind;
  host.appendChild(enable);
  if (typeof renderHostedEnable === 'function') {
    renderHostedEnable(enable, kind, { answered: !!lastHosted, available: !!(h && h.available), reason: h ? h.reason : null });
  }

  // Not drivable here: the page stays, greyed, with one line saying why and what to do.
  if (!h || !h.available) {
    const why = document.createElement('div');
    why.className = 'p-note p-hosted-missing is-off';
    why.textContent = hostedMissingText(kind);
    host.appendChild(why);
    return;
  }

  // Which add-on is answering, and for RenoDX which game's mod -- a per-game add-on and the
  // engine-wide one look the same in the folder, and this line is where the difference shows.
  const who = document.createElement('div');
  who.className = 'p-note';
  who.textContent = kind === 'pacing'
    ? `ReLimiter ${h.version || '?'}`
    : `RenoDX -- ${h.module || '?'}`;
  who.appendChild(helpMarker(kind === 'pacing'
    ? t('ReLimiter holds the frame rate steady for a G-Sync or VRR display rather than making more frames. These are its own settings, changed live in the running game.')
    : t('RenoDX replaces this game\'s tone mapping to give it real HDR. What appears here is whatever this game\'s mod offers, changed live in the running game.')));
  host.appendChild(who);

  const wrap = document.createElement('div');
  wrap.className = 'p-hosted';
  let caption = null;
  for (const s of h.settings) {
    // The add-on's own grouping is the caption, as in-game -- not a list kept here that goes stale.
    if (s.caption && s.caption !== caption) {
      const cap = document.createElement('div');
      cap.className = 'p-caption';
      cap.textContent = s.caption;
      wrap.appendChild(cap);
      caption = s.caption;
    }

    // A labelled zero is a MODE (ReLimiter's target_fps = 0 is "stay below the VRR ceiling"), so it is
    // its own tick box, as in-game; the number is offered only when the mode is off. Leaving the mode
    // lands on the range's low end, a real value the add-on keeps.
    if (s.zeroLabel) {
      const autoOn = s.value === 0;
      const box = {
        key: `${kind}:${s.key}:zero`, label: s.zeroLabel, help: s.tooltip, raw: true, hosted: true,
        disabled: !s.enabled, type: 'bool', value: autoOn, default: autoOn, dependsOn: null,
      };
      wrap.appendChild(fieldRow(box, (_k, on) => hostedApply(kind, s, on ? 0 : s.min)));
      if (autoOn) continue;
    }

    // Typed, not dragged, for every ReLimiter number and RenoDX's whole numbers: a frame-rate cap has
    // to land on 72 or 141 exactly, which a track from 30 to 1000 cannot do. RenoDX's floats (peak
    // brightness, saturation) are looked at while they move, so they keep the slider.
    const typed = kind === 'pacing' ? s.type !== 'bool' && s.type !== 'enum' : s.type === 'int';
    const set = (_k, v) => hostedApply(kind, s, hostedValue(s, v));
    wrap.appendChild(typed ? hostedNumberRow(hostedField(kind, s), s, set) : fieldRow(hostedField(kind, s), set));
  }
  host.appendChild(wrap);
}

// A typed number: the Edit dialog's frame-rate box (renderer.js relimiterTypedFps) and the in-game
// NrNumberBox, here. Committed on change or Enter, never per keystroke; clamped to the setting's own
// range, because a typed value ignores the input's min/max and the add-on would clamp it silently.
function hostedNumberRow(field, s, set) {
  const el = row(field);
  const label = document.createElement('span');
  label.className = 'p-row-label';
  label.textContent = field.label;
  const ctl = document.createElement('span');
  ctl.className = 'p-row-ctl';
  const box = document.createElement('input');
  box.type = 'number';
  box.className = 'p-select p-number';
  box.min = String(s.min);
  box.max = String(s.max);
  box.step = s.type === 'int' ? '1' : 'any';
  box.value = String(s.value);
  box.disabled = !!field.disabled;
  const commit = () => {
    let n = Number(box.value);
    if (box.value.trim() === '' || !Number.isFinite(n)) { box.value = String(s.value); return; }
    n = Math.min(s.max, Math.max(s.min, n));
    if (s.type === 'int') n = Math.round(n);
    // Show what is actually stored, so a 5 typed into a 30..1000 box does not sit there reading 5.
    box.value = String(n);
    if (n !== s.value) set(field.key, n);
  };
  box.addEventListener('change', commit);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  ctl.appendChild(box);
  el.append(label, ctl);
  el.classList.toggle('is-off', !!field.disabled);
  if (field.help) el.appendChild(helpMarker(field.help, true));
  return el;
}

// Focus in one of the page's number boxes: a redraw from the poll would throw away what is being typed.
function hostedTyping() {
  const a = document.activeElement;
  return !!(a && a.classList && a.classList.contains('p-number') && a.closest('.p-hosted'));
}

// ── Frame Generation ────────────────────────────────────────────────────────────────────────────
//
// The in-game panel's Frame Generation section, for a game with NVIDIA DLSS Frame Generation of its
// own: the multiplier it asks the driver for, and Dynamic. Written through framegen:setMultiplier --
// the same per-game marker the game card uses -- not straight into [DLSSG], because a sync re-applies
// that marker and would undo a direct write. Turning FG on and off stays the game's own setting.
let fgState = null;
let motionState = null;

async function loadMotion() {
  motionState = null;
  if (!current || !current.exePath) return;
  try { motionState = await window.api.panelMotion(current.exePath); } catch { motionState = null; }
}

// The Guide row: what is feeding motion to the model, and -- when the answer is "nothing can be" --
// which of the three checkable faults it is, with the swap right there.
//
// The in-game panel shows the truth (did vectors actually arrive this frame); this side cannot see
// into the process, so it reports the configuration instead and only claims a fault it can prove
// from the files. That division is deliberate: between them the two rows cover both "it is set up
// wrong" and "it is set up fine and still nothing arrives", which are different problems.
function renderMotion(host) {
  const m = motionState;
  if (!m || !m.ok || !m.id) return;

  const row = document.createElement('div');
  row.className = 'p-row p-motion';
  const label = document.createElement('div');
  label.className = 'p-row-label';
  label.textContent = t('Motion');
  row.appendChild(label);

  const val = document.createElement('div');
  val.className = 'p-motion-value';
  const name = document.createElement('div');
  name.textContent = m.displayName || m.id;
  val.appendChild(name);

  const fault = {
    'broken': m.unsupportedReason || t('This provider cannot compile on the ReShade this app installs, so it feeds nothing.'),
    'shader-missing': t('Its shader is not in reshade-shaders\\Shaders, so nothing writes motion vectors.'),
    'byo-missing': t('This one is your own copy and it is not in the shader folder yet, so nothing writes motion vectors.'),
    'value-mismatch': t('The shader is compiled for provider {defined}, but this game is set to {expected}. No vectors reach DLSS.', { defined: m.definedValue, expected: m.expectedValue }),
    'technique-mismatch': t('The enabled technique belongs to a different provider than the one the shader is compiled for. No vectors reach DLSS.'),
  }[m.fault];

  if (fault) {
    const why = document.createElement('div');
    why.className = 'p-motion-fault';
    why.textContent = fault;
    val.appendChild(why);

    // Naming the fault without offering the fix is the thing this app has been told off for. The
    // swap is one press, and it is the same call the add-on list makes.
    const pick = document.createElement('div');
    pick.className = 'p-motion-pick';
    for (const p of (m.providers || []).filter((x) => x.id !== m.id).slice(0, 3)) {
      const b = document.createElement('button');
      b.className = 'p-small';
      b.textContent = t('Use {name}', { name: p.displayName.replace(/\s*\(.*$/, '') });
      b.addEventListener('click', async () => {
        b.disabled = true;
        let licenseConfirmed = false;
        if (/AGNYA/.test(p.license || '')) {
          licenseConfirmed = await window.api.feederConfirmProviderLicense(p.id);
          if (!licenseConfirmed) { b.disabled = false; return; }
        }
        setStatus(t('Switching to {name}…', { name: p.displayName }));
        const out = await window.api.addonsSetMvProvider(current.exePath, p.id, { licenseConfirmed });
        setStatus(out && out.ok
          ? t('Motion vectors now come from {name}. Launch the game and see how it looks.', { name: p.displayName })
          : (out && out.error) || t('That did not work.'));
        await loadMotion();
        render();
      });
      pick.appendChild(b);
    }
    if (pick.children.length) val.appendChild(pick);
  }

  row.appendChild(val);
  host.appendChild(row);
}

async function loadFrameGen() {
  fgState = null;
  optiFgState = null;
  if (!current || !current.exePath) return;
  try { fgState = await window.api.frameGenMultiplier(current.exePath); } catch { fgState = null; }
  try { optiFgState = await window.api.optiFgLive(current.exePath); } catch { optiFgState = null; }
  try { optiFgReady = await window.api.optiFgReadiness(current.exePath); } catch { optiFgReady = null; }
}

// Whether XeFG can be offered here at all (main.js optiFgReadiness: D3D12, no DLSS Frame Generation of
// the game's own, not a Feeder game, the files present) and why not when it cannot.
let optiFgReady = null;

// OptiScaler's own XeFG / FSR FG, when Edit armed one for this game (main.js optifg:live). The same two
// live switches the in-game panel has; which generator is a launch-time choice and stays in Edit.
let optiFgState = null;

async function setOptiFg(values) {
  if (!current) return;
  const res = await window.api.optiFgLiveSet(current.exePath, values);
  if (!res || !res.ok) {
    setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') }));
    return;
  }
  optiFgState = res;
  setStatus(current.running ? t('Saved. A running game picks it up within a second.') : t('Saved. Applies the next time the game starts.'), true);
  renderFields();
}

function optiFgCheckRow(host, on, text, tip, onClick) {
  const row = document.createElement('div');
  row.className = 'p-row is-check';
  const ctl = document.createElement('span');
  ctl.className = 'p-row-ctl';
  const box = document.createElement('button');
  box.className = `p-check${on ? ' on' : ''}`;
  box.addEventListener('click', onClick);
  ctl.appendChild(box);
  const label = document.createElement('span');
  label.className = 'p-row-label';
  label.textContent = text;
  row.append(ctl, label);
  if (tip) row.appendChild(helpMarker(tip));
  host.appendChild(row);
}

// ── Frame pacing / RenoDX on and off (the hook at the top of each hosted page) ────────────────────
//
// Listed always, off until asked for (2026-09-25). The switch is what is INSTALLED in the game folder,
// read by the app (main.js panel:addonToggles), not what the running game reports: the game only picks
// an add-on up when it starts, so turning one on here says exactly that. Where Install would be refused,
// the switch is greyed with the reason, from the same checks the install runs.
let addonToggles = null;      // { exe, pacing: {installed, blocker}, hdr: {installed, blocker} }
let addonTogglesLoading = null; // { exe, promise } of the read in flight
let addonTogglesSeq = 0;        // only the newest read may write addonToggles
const addonToggleBusy = new Set(); // `${exe}|${kind}` being installed or removed right now

function addonBlockerText(kind, code) {
  const name = kind === 'pacing' ? t('Frame pacing') : 'RenoDX';
  switch (code) {
    case 'bitness-32': return t('{name} needs a 64-bit game. This one is 32-bit.', { name });
    case 'vulkan-layer': return t('{name} on a Vulkan game needs ReShade’s own setup run for this game first.', { name });
    case 'reshade-dlss-crash': return t('{name} needs a newer DLSS 5 engine on this game: update DLSS 5 here first.', { name });
    case 'optifg-armed': return t('{name} can’t run beside frame generation on this game: switch frame generation off in Edit first, or to XeFG once DLSS 5 here is up to date.', { name });
    case 'no-mod': return t('RenoDX has no mod for this game or its engine yet.');
    case 'no-index': return t('Could not reach RenoDX’s list of mods. Check the connection and open the panel again.');
    // From the main-process fixes (2026-09-25): Remove refuses while the game runs, keeps what it could
    // not delete, and never takes over a plain ReShade the player put in themselves.
    case 'game-running': return t('Close the game first: {name} can only be switched on or off while the game is not running.', { name });
    case 'remove-failed': return t('Some of {name}\'s files could not be deleted, so they are still listed as installed. Close the game, and check your antivirus is not holding them, then try again.', { name });
    case 'foreign-plain-reshade': return t('This game already has your own ReShade, and it is the plain build, which never loads add-ons. Install ReShade with full add-on support over it yourself, or remove yours, then try again.');
    default: return '';
  }
}

// Keyed by game: a read in flight for the game before, or one started before an install (force), used to
// be handed back as if it were this one, and the switch then showed the old answer.
async function loadAddonToggles(force = false) {
  if (!current || !current.exePath) { addonToggles = null; return; }
  if (!force && addonToggles && addonToggles.exe === current.exePath) return;
  const exe = current.exePath;
  if (!force && addonTogglesLoading && addonTogglesLoading.exe === exe) return addonTogglesLoading.promise;
  const seq = ++addonTogglesSeq;
  const promise = (async () => {
    let next;
    try {
      const res = await window.api.panelAddonToggles(exe);
      next = res && res.ok ? { exe, ...res } : { exe, error: (res && res.error) || '' };
    } catch (e) {
      next = { exe, error: String((e && e.message) || e) };
    }
    if (seq === addonTogglesSeq) addonToggles = next;
  })();
  addonTogglesLoading = { exe, promise };
  try { await promise; } finally { if (addonTogglesLoading && addonTogglesLoading.promise === promise) addonTogglesLoading = null; }
  if (seq === addonTogglesSeq && current && current.exePath === exe) renderFields();
}

function renderHostedEnable(el, kind) {
  el.innerHTML = '';
  if (!current || !current.exePath) return;
  if (!addonToggles || addonToggles.exe !== current.exePath) { loadAddonToggles(); return; }
  const s = addonToggles[kind];
  if (!s) {
    // A read that failed says so, rather than the switch just not being there.
    if (addonToggles.error !== undefined) {
      const why = document.createElement('div');
      why.className = 'p-note';
      why.textContent = `${t('Could not read this game.')}${addonToggles.error ? ' ' + addonToggles.error : ''}`;
      el.appendChild(why);
    }
    return;
  }
  const exe = current.exePath;
  const busyKey = `${exe}|${kind}`;
  const blocked = !s.installed && !!s.blocker;
  const label = kind === 'pacing' ? t('Frame pacing on this game') : t('HDR (RenoDX) on this game');
  optiFgCheckRow(el, s.installed, label,
    s.installed
      ? t('On. Turning it off takes it out of the game folder; the game drops it the next time it starts.')
      : t('Off. Turning it on installs it into the game folder; the game picks it up the next time it starts.'),
    async () => {
      // One change at a time: a second click while the first install ran started it twice.
      if (blocked || addonToggleBusy.has(busyKey)) return;
      addonToggleBusy.add(busyKey);
      const box = el.querySelector('.p-check');
      if (box) box.disabled = true;
      setStatus(s.installed ? t('Removing…') : t('Fetching and placing…'));
      let res;
      try {
        res = kind === 'pacing'
          ? (s.installed ? await window.api.relimiterRemove(exe) : await window.api.relimiterInstall(exe))
          : (s.installed ? await window.api.addonsRemove(exe, 'renodx') : await window.api.addonsInstall(exe, 'renodx'));
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      } finally {
        addonToggleBusy.delete(busyKey);
      }
      if (!res || !res.ok) {
        const why = (res && addonBlockerText(kind, res.code)) || (res && res.error) || t('unknown');
        setStatus(t('Could not save: {error}', { error: why }));
      } else {
        setStatus(s.installed
          ? t('Turned off. The game drops it the next time it starts.')
          : t('Turned on. Start the game again to use it; its settings then appear below.'), true);
      }
      await loadAddonToggles(true);
    });
  const row = el.lastElementChild;
  if (addonToggleBusy.has(busyKey) && row) {
    const box = row.querySelector('.p-check');
    if (box) box.disabled = true;
  }
  if (blocked && row) {
    row.classList.add('is-off');
    const box = row.querySelector('.p-check');
    if (box) box.disabled = true;
    const why = document.createElement('div');
    why.className = 'p-note';
    why.textContent = addonBlockerText(kind, s.blocker);
    el.appendChild(why);
  }
}

function renderOptiFg(host) {
  const s = optiFgState;
  const note = document.createElement('div');
  note.className = 'p-note';
  if (!s || !s.ok || !s.armed) {
    // Listed always, off until asked for (2026-09-25): XeFG is offered right here where the game has no
    // DLSS Frame Generation of its own, and shown greyed with the reason where it cannot be. Turning it
    // on arms it for the next launch -- a generator is built when the swap chain is, so it cannot start
    // mid-game -- and from then on the live switch below turns it on and off.
    const r = optiFgReady;
    const ok = !!(r && r.supported && r.available && r.available.xefg);
    note.textContent = t('This game has no NVIDIA DLSS Frame Generation of its own.');
    host.appendChild(note);
    const row = document.createElement('div');
    row.className = `p-row is-check${ok ? '' : ' is-off'}`;
    const ctl = document.createElement('span');
    ctl.className = 'p-row-ctl';
    const box = document.createElement('button');
    box.className = 'p-check';
    box.disabled = !ok;
    box.addEventListener('click', async () => {
      box.disabled = true;
      const res = await window.api.optiFgChoose(current.exePath, 'xefg', false);
      if (!res || !res.ok) { setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') })); box.disabled = false; return; }
      await loadFrameGen();
      setStatus(t('XeFG is set up for this game. Start the game again, then switch it on here or in the in-game panel.'), true);
      renderFields();
    });
    ctl.appendChild(box);
    const label = document.createElement('span');
    label.className = 'p-row-label';
    label.textContent = t('XeFG frame generation');
    row.append(ctl, label);
    row.appendChild(helpMarker(ok
      ? t('Intel\'s frame generation, run by OptiScaler. Off until you turn it on here; it is then set up for the next time the game starts, and switches on and off live from then on. Frame pacing works beside it.')
      : t((r && r.reason) || 'Not available for this game.', (r && r.reasonVars) || {})));
    host.appendChild(row);
    if (!ok && r && r.reason) {
      const why = document.createElement('div');
      why.className = 'p-note';
      why.textContent = t(r.reason, r.reasonVars || {});
      host.appendChild(why);
    }
    return;
  }
  note.classList.add('is-accent');
  note.textContent = t('OptiScaler Frame Generation: {name}', { name: s.generator === 'xefg' ? 'XeFG' : 'FSR FG' });
  host.appendChild(note);
  optiFgCheckRow(host, s.enabled, t('Frame Generation on'),
    t('Takes effect at once. To change the generator, use Edit -- that applies on the next launch.'),
    () => setOptiFg({ enabled: !s.enabled }));
  optiFgCheckRow(host, s.hudfix, t('HUD fix'),
    t('Keeps the HUD and subtitles from warping in generated frames. OptiScaler warns it can crash some games -- if this game crashes with it on, leave it off.'),
    () => setOptiFg({ hudfix: !s.hudfix }));
}

function frameGenChoice() {
  const m = fgState && fgState.marker;
  const ini = (fgState && fgState.ini) || {};
  const iniFrames = parseInt(ini.frames, 10);
  const iniTarget = Number(ini.target);
  return {
    frames: m ? (m.frames || null) : (Number.isInteger(iniFrames) && iniFrames >= 1 ? iniFrames : null),
    dynamic: m ? !!m.dynamic : /^(true|1)$/i.test(String(ini.dynamic || '')),
    target: m ? (m.target || 0) : (Number.isFinite(iniTarget) ? iniTarget : 0),
  };
}

async function setFrameGen(next) {
  if (!current) return;
  const res = await window.api.frameGenSetMultiplier({ exePath: current.exePath, ...next });
  if (!res || !res.ok) {
    setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') }));
    return;
  }
  await loadFrameGen();
  await loadMotion();
  setStatus(current.running ? t('Saved. A running game picks it up within a second.') : t('Saved. Applies the next time the game starts.'), true);
  renderFields();
}

function renderFrameGenStatus() {
  const el = document.getElementById('p-fg-status');
  if (!el) return;
  const fg = lastLive && lastLive.fg;
  if (!fg || !fg.gameDlssg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = fg.liveMultiplier
    ? t('Game\'s DLSS Frame Generation: running at {n}X', { n: fg.liveMultiplier })
    : t('Game\'s DLSS Frame Generation: off in the game\'s video settings.');
}

// The caption is the section's, drawn by renderFields from the page table -- this draws what goes
// under it.
function renderFrameGen(host) {
  if (!fgState || !fgState.hasFrameGen) {
    renderOptiFg(host);
    return;
  }

  const status = document.createElement('div');
  status.id = 'p-fg-status';
  status.className = 'p-note is-accent';
  status.hidden = true;
  host.appendChild(status);
  renderFrameGenStatus();

  const choice = frameGenChoice();
  const dmfgOk = !(lastLive && lastLive.fg && lastLive.fg.gameDlssg && lastLive.fg.gameDmfgSupported === false);

  // Game / 2X..6X, as the in-game pills: 1 generated frame is 2X. Greyed while Dynamic is on.
  const seg = document.createElement('div');
  seg.className = `p-row is-seg${choice.dynamic ? ' is-off' : ''}`;
  const ctl = document.createElement('span');
  ctl.className = 'p-row-ctl';
  const pills = document.createElement('span');
  pills.className = 'p-seg';
  const options = [[null, t('Game')], [1, '2X'], [2, '3X'], [3, '4X'], [4, '5X'], [5, '6X']];
  for (const [frames, text] of options) {
    const b = document.createElement('button');
    b.textContent = text;
    b.disabled = choice.dynamic;
    if (choice.frames === frames) b.classList.add('on');
    b.addEventListener('click', () => setFrameGen({ frames, dynamic: false, target: choice.target }));
    pills.appendChild(b);
  }
  ctl.appendChild(pills);
  seg.append(ctl, helpMarker(t('This game has NVIDIA DLSS Frame Generation of its own. Turn it on or off in the game\'s video settings as usual -- the row below only changes the multiplier it asks the driver for.')
    + '\n\n' + t('Overrides how many extra frames the game\'s DLSS-G inserts between real ones. "Game" leaves it at whatever the game\'s own menu says. 2X inserts one, 3X inserts two, and so on. 3X and 4X need an RTX 50 series -- other cards are capped at 2X by the driver, whatever is picked here.\n\nGreyed out while Multi is on below -- the driver picks the count then.')));
  host.appendChild(seg);

  if (!dmfgOk) return;

  const dyn = document.createElement('div');
  dyn.className = 'p-row is-check';
  const boxCtl = document.createElement('span');
  boxCtl.className = 'p-row-ctl';
  const box = document.createElement('button');
  box.className = `p-check${choice.dynamic ? ' on' : ''}`;
  box.addEventListener('click', () => setFrameGen({ frames: choice.frames, dynamic: !choice.dynamic, target: choice.target }));
  boxCtl.appendChild(box);
  const label = document.createElement('span');
  label.className = 'p-row-label';
  label.textContent = t('Multi (Dynamic Frame Generation)');
  dyn.append(boxCtl, label, helpMarker(t('Lets NVIDIA\'s driver vary the multiplier itself, frame to frame, to hold the FPS target below -- instead of a fixed 2X/3X/4X.')));
  host.appendChild(dyn);

  if (!choice.dynamic) return;

  // 0..200, 0 = the display's refresh rate -- the in-game slider's own range.
  const tr = document.createElement('div');
  tr.className = 'p-row';
  const tl = document.createElement('span');
  tl.className = 'p-row-label';
  tl.textContent = t('DMFG FPS Target');
  const tc = document.createElement('span');
  tc.className = 'p-row-ctl';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'p-slider';
  slider.min = '0';
  slider.max = '200';
  slider.step = '1';
  slider.value = String(Math.round(choice.target || 0));
  const fill = () => slider.style.setProperty('--fill', `${(Number(slider.value) / 2).toFixed(1)}%`);
  fill();
  const tv = document.createElement('span');
  tv.className = 'p-row-value';
  const show = () => { tv.textContent = Number(slider.value) === 0 ? t('auto') : slider.value; };
  show();
  slider.addEventListener('input', () => { fill(); show(); });
  slider.addEventListener('change', () => setFrameGen({ frames: null, dynamic: true, target: Number(slider.value) }));
  tc.appendChild(slider);
  tr.append(tl, tc, tv, helpMarker(t('0 auto-detects your display\'s refresh rate.')));
  host.appendChild(tr);
}

async function refreshTargets() {
  const res = await window.api.panelTargets();
  targets = (res && res.ok && Array.isArray(res.games)) ? res.games : [];

  const select = $('#p-game');
  const previous = current ? current.exePath : null;
  select.innerHTML = '';

  if (targets.length === 0) {
    setStatus(t('No games added yet.'));
    renderFields();
    return;
  }

  for (const game of targets) {
    const o = document.createElement('option');
    o.value = game.exePath;
    o.textContent = game.running ? t('{name} (running)', { name: game.name }) : game.name;
    select.appendChild(o);
  }

  const running = targets.find((g) => g.running);
  const keep = previous && targets.some((g) => g.exePath === previous) ? previous : null;
  const installed = targets.find((g) => g.installed);
  const chosen = (running && running.exePath) || keep || (installed && installed.exePath) || targets[0].exePath;
  select.value = chosen;
  await loadGame(chosen);
}

$('#p-game').addEventListener('change', (e) => loadGame(e.target.value));

// No close button and no theme button in the top strip: the in-game panel dropped both on
// 2026-09-22 (Light panel is a setting and lives under Setup; the panel closes on its own key), and
// this window is that panel. Escape closes it, as does the key that opened it.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.panelClose(); });

function applyStaticTips() {
  for (const el of document.querySelectorAll('[data-tip-key]')) el.setAttribute('data-tip', t(el.getAttribute('data-tip-key')));
}

async function reload() {
  const data = await window.api.loadData();
  settings = data.settings || {};
  applyChrome();
  await refreshTargets();
}

window.api.onPanelOpened(() => reload());
window.api.onSettingsChanged((next) => {
  settings = next || {};
  applyChrome();
  renderPages();
  renderHead();
  renderFields();
});

(async () => {
  try {
    const gpu = await window.api.gpuInfo();
    amd = !!gpu && gpu.vendor === 'amd';
  } catch { amd = false; }
  await reload();
})();
