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

function helpMarker(text) {
  const el = document.createElement('span');
  el.className = 'p-help';
  el.textContent = '(?)';
  el.setAttribute('data-tip', text);
  return el;
}

// One row, drawn the way the in-game panel draws that kind of row.
function fieldRow(field) {
    const held = forced[field.key] || null;
    const met = dependencyMet(field) && !held;
    const shown = field.value === null ? field.default : field.value;

    const label = document.createElement('span');
    label.className = 'p-row-label';
    label.textContent = t(field.label);

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
      box.addEventListener('click', () => apply(field.key, !shown));
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
        b.textContent = t(text);
        b.disabled = !met;
        b.setAttribute('data-tip', t(field.help));
        const on = v === null ? field.value === null : String(shown) === String(v);
        if (on) b.classList.add('on');
        b.addEventListener('click', () => apply(field.key, v));
        seg.appendChild(b);
      }
      ctl.appendChild(seg);
      el.append(ctl);
    } else if (field.type === 'enum' || field.type === 'code') {
      el = row(field);
      const sel = document.createElement('select');
      sel.className = 'p-select';
      sel.disabled = !met;
      const def = document.createElement('option');
      def.value = 'auto';
      const defOption = (field.options || []).find(([v]) => v === field.default);
      def.textContent = field.default === null
        ? t(field.type === 'code' ? 'Default (follow Windows)' : 'Default (follow pass 1)')
        : t('Default ({state})', { state: defOption ? t(defOption[1]) : String(field.default) });
      sel.appendChild(def);
      for (const [v, text] of field.options || []) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = t(text);
        sel.appendChild(o);
      }
      sel.value = field.value === null ? 'auto' : String(field.value);
      sel.addEventListener('change', () => apply(field.key, sel.value === 'auto' ? null : sel.value));
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
      slider.value = String(Math.round(toSlider(field, Number(shown)) * 1000));
      slider.style.setProperty('--fill', `${(Number(slider.value) / 10).toFixed(1)}%`);
      value.textContent = held ? t('held off') : formatNumber(field, shown);

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
        pending = setTimeout(() => apply(field.key, next), 180);
      });
      // Applied when the handle is let go, not while it is moving -- the engine does the same,
      // because every move would otherwise rewrite the ini and rebuild the feature.
      slider.addEventListener('change', () => {
        const v = fromSlider(field, Number(slider.value) / 1000);
        apply(field.key, field.type === 'int' ? Math.round(v) : Number(v.toFixed(4)));
      });
      ctl.appendChild(slider);

      const reset = document.createElement('button');
      reset.className = 'p-small';
      reset.textContent = t('Reset');
      reset.disabled = !met || field.value === null;
      reset.addEventListener('click', () => apply(field.key, null));

      el.append(label, ctl, value, reset);
    }

    el.classList.toggle('is-off', !met);
    el.appendChild(helpMarker(held ? t(held) : t(field.help)));
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

function stopLive() {
  if (liveFor) window.api.panelLiveStop(liveFor).catch(() => {});
  liveFor = null;
  lastLive = null;
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
}

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

function renderOptiFg(host) {
  const s = optiFgState;
  const note = document.createElement('div');
  note.className = 'p-note';
  if (!s || !s.ok || !s.armed) {
    note.textContent = t('This game has no NVIDIA DLSS Frame Generation of its own.');
    host.appendChild(note);
    const hint = document.createElement('div');
    hint.className = 'p-note';
    hint.textContent = t('OptiScaler can generate frames here instead: pick XeFG or FSR FG for this game in Edit. It applies on the next launch, then switches on and off right here.');
    host.appendChild(hint);
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
