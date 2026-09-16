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
  $('#p-theme').textContent = light ? t('Dark') : t('Light');
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

function renderFields() {
  const host = $('#p-fields');
  host.innerHTML = '';
  if (fields.length === 0) return;

  for (const group of [...new Set(fields.map((f) => f.group))]) {
    const cap = document.createElement('div');
    cap.className = 'p-caption';
    cap.textContent = t(group);
    host.appendChild(cap);

    for (const field of fields.filter((f) => f.group === group)) {
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
      } else if (field.type === 'enum' && field.segmented) {
        // The Models row: one pill per model across the whole row, the selected one filled with the
        // accent. No label column -- the section caption above it already says Models, and the
        // engine gives the pills the full row width so four model names fit without being cut.
        el = row(field, 'is-seg');
        const seg = document.createElement('span');
        seg.className = 'p-seg';
        for (const [v, text] of field.options || []) {
          const b = document.createElement('button');
          b.textContent = t(text);
          b.disabled = !met;
          b.setAttribute('data-tip', t(field.help));
          if (String(shown) === String(v)) b.classList.add('on');
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
      host.appendChild(el);
    }
  }
}

async function apply(key, value) {
  if (!current) return;
  const res = await window.api.dlssNrSet(current.exePath, { [key]: value });
  if (!res || !res.ok) {
    setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') }));
    return;
  }
  fields = res.fields;
  applyChrome();
  setStatus(res.written.length
    ? (current.running ? t('Saved. A running game picks it up within a second.') : t('Saved. Applies the next time the game starts.'))
    : t('Nothing to change.'), true);
  renderFields();
}

async function loadGame(exePath) {
  current = targets.find((g) => g.exePath === exePath) || null;
  fields = [];
  forced = {};

  if (!current) {
    renderFields();
    setStatus(t('Pick a game.'));
    return;
  }

  const res = await window.api.dlssNrGet(current.exePath);
  if (!res || !res.ok) {
    renderFields();
    setStatus(res && res.error === 'not-installed'
      ? t('OptiScaler is not installed for this game yet.')
      : t('Could not read the settings: {error}', { error: (res && res.error) || t('unknown') }));
    return;
  }

  fields = res.fields || [];
  forced = res.forced || {};
  applyChrome();
  renderFields();
  setStatus(res.inHelper
    ? t('Editing the 64-bit helper this 32-bit game uses.')
    : current.running ? t('Game is running. Changes land within a second.') : t('Game is not running. Changes apply when it starts.'));
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
$('#p-close').addEventListener('click', () => window.api.panelClose());
// Writes [DlssNr] LightTheme, so the in-game panel changes with it.
$('#p-theme').addEventListener('click', () => apply('LightTheme', !light));

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
window.api.onSettingsChanged((next) => { settings = next || {}; applyChrome(); renderFields(); });

(async () => {
  try {
    const gpu = await window.api.gpuInfo();
    amd = !!gpu && gpu.vendor === 'amd';
  } catch { amd = false; }
  await reload();
})();
