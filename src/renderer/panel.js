// The pop-out DLSS 5 panel's renderer.
//
// It draws the same controls as the Edit dialog's DLSS 5 tab, from the same source -- dlssnr:get
// and dlssnr:set -- so what a setting means, what its default is and how "auto" round-trips are
// defined once, in src/dlssnr.js. What differs is only the window it lives in.
//
// It is a separate file from renderer.js because that one is bound to the Edit dialog's element
// ids and its module state, and loading a 3000-line file to show one dialog's worth of rows would
// pull in the grid, the installer and the updater with it. Anything shared here is shared through
// style.css and the locales, which is where sharing costs nothing.

const $ = (sel) => document.querySelector(sel);

let targets = [];
let current = null;   // { name, exePath, detectedPath, running, installed }
let fields = [];
let forced = {};
let isEmulator = false;
let settings = {};

// ── The app's own chrome ────────────────────────────────────────────────────────────────────────
//
// Language, theme and the vendor accent all come from the same settings.json the main window uses,
// so the panel is never a different-looking app from the one that opened it.

function applyLanguage() {
  const wanted = settings.language && settings.language !== 'auto' ? settings.language : I18N.detect();
  I18N.setLocale(wanted);
}

function applyTheme() {
  const light = settings.theme === 'light';
  document.body.classList.toggle('theme-light', light);
  document.documentElement.classList.toggle('theme-light', light);
}

async function applyVendor() {
  try {
    const gpu = await window.api.gpuInfo();
    document.body.classList.toggle('vendor-amd', !!gpu && gpu.vendor === 'amd');
  } catch {
    // The accent is cosmetic; a panel in the default green beats no panel.
  }
}

// One floating tip for every [data-tip] element, the same behaviour as the main window: positioned
// above, flipped below when there is no room, kept inside the window either way. Every row's help
// text is on its label, which is the only place the long explanations fit in a window this size.
let tipEl = null;
function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'floating-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.classList.remove('show');
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const margin = 8;
  let left = Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - margin));
  let top = r.top - h - margin;
  if (top < margin) top = r.bottom + margin;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
  tipEl.classList.add('show');
}
function hideTip() { if (tipEl) tipEl.classList.remove('show'); }
document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el); });
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hideTip();
});
document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('click', hideTip, true);
window.addEventListener('scroll', hideTip, true);

function setStatus(text, kind) {
  const el = $('#panel-status');
  el.textContent = text;
  el.className = `status-line${kind ? ' ' + kind : ''}`;
}

// ── The rows ────────────────────────────────────────────────────────────────────────────────────

function valueOf(key) {
  const field = fields.find((f) => f.key === key);
  if (!field) return null;
  return field.value === null ? field.default : field.value;
}

// The same three forms the field data uses. A field whose condition is not met is greyed rather
// than hidden: a control that vanishes leaves the reader wondering whether they imagined it.
function dependencyMet(field) {
  const d = field.dependsOn;
  if (!d) return true;
  const v = valueOf(d.key);
  if (d.is !== undefined) return v === d.is;
  if (d.atLeast !== undefined) return Number(v) >= d.atLeast;
  if (d.above !== undefined) return Number(v) > d.above;
  return true;
}

function displayPixels() {
  const ratio = window.devicePixelRatio || 1;
  return { width: Math.round(window.screen.width * ratio), height: Math.round(window.screen.height * ratio) };
}

// What the settings above cost, in the only terms that mean anything while a game is running: the
// size the model actually works at, and that as a share of what it would cost at display size.
// Model resolution is squared (it is an area) and each extra pass costs another whole run of the
// model, which is what the engine's own timings show.
function costNote() {
  const scale = Number(valueOf('WorkingScale'));
  const passes = Math.max(1, Math.round(Number(valueOf('Passes')) || 1));
  if (!Number.isFinite(scale) || scale <= 0) return '';
  const display = displayPixels();
  const size = `${Math.round(display.width * scale)}x${Math.round(display.height * scale)}`;
  const pct = Math.round(scale * scale * passes * 100);
  return passes > 1
    ? t('Model works at {size}, {passes} passes -- about {pct}% of the cost of one pass at display resolution.', { size, passes, pct })
    : t('Model works at {size} -- about {pct}% of the cost at display resolution.', { size, pct });
}

// CSS cannot read an input's value, so the filled part of a slider's track is a percentage this
// sets on the element (see input[type="range"] in style.css).
function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`);
}

function renderFields() {
  const host = $('#panel-fields');
  host.innerHTML = '';
  if (fields.length === 0) return;

  for (const groupName of [...new Set(fields.map((f) => f.group))]) {
    const head = document.createElement('div');
    head.className = 'field-label dlssnr-group';
    head.textContent = t(groupName);
    host.appendChild(head);

    for (const field of fields.filter((f) => f.group === groupName)) {
      const row = document.createElement('div');
      row.className = 'dlssnr-row';
      const heldReason = forced[field.key] || null;
      const met = dependencyMet(field) && !heldReason;
      row.classList.toggle('dlssnr-inactive', !met);

      const label = document.createElement('label');
      label.className = 'dlssnr-label has-tip';
      label.textContent = t(field.label);
      label.setAttribute('data-tip', heldReason ? t(heldReason) : t(field.help));
      row.appendChild(label);

      const shown = field.value === null ? field.default : field.value;
      let input;

      if (field.type === 'bool') {
        input = document.createElement('select');
        for (const [value, text] of [
          ['auto', t('Default ({state})', { state: field.default ? t('on') : t('off') })],
          ['true', t('On')],
          ['false', t('Off')],
        ]) {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = text;
          input.appendChild(o);
        }
        input.value = field.value === null ? 'auto' : String(field.value);
      } else if (field.type === 'enum') {
        input = document.createElement('select');
        const def = document.createElement('option');
        def.value = 'auto';
        const defOption = (field.options || []).find(([v]) => v === field.default);
        def.textContent = field.default === null
          ? t('Default (follow pass 1)')
          : t('Default ({state})', { state: defOption ? t(defOption[1]) : String(field.default) });
        input.appendChild(def);
        for (const [value, text] of field.options || []) {
          const o = document.createElement('option');
          o.value = String(value);
          o.textContent = t(text);
          input.appendChild(o);
        }
        input.value = field.value === null ? 'auto' : String(field.value);
      } else {
        // Numbers get a slider and a readout, with "Default" as its own button rather than a magic
        // position on the track -- auto is a state, not a value. Same as the Edit dialog.
        input = document.createElement('input');
        input.type = 'range';
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step || (field.type === 'int' ? 1 : 0.05));
        input.value = String(shown);
        paintRange(input);
      }

      input.className = 'dlssnr-input';
      input.disabled = !met;
      row.appendChild(input);

      const readout = document.createElement('span');
      readout.className = 'dlssnr-readout';
      readout.textContent = heldReason
        ? t('held off')
        : field.type === 'bool' || field.type === 'enum'
          ? (field.value === null ? t('default') : '')
          : (field.value === null ? t('{n} (default)', { n: shown }) : String(shown));
      row.appendChild(readout);

      if (field.type === 'float' || field.type === 'int') {
        const reset = document.createElement('button');
        reset.className = 'btn btn-ghost btn-small';
        reset.textContent = t('Default');
        reset.disabled = !met;
        reset.addEventListener('click', () => apply(field.key, null));
        row.appendChild(reset);
        input.addEventListener('input', () => { readout.textContent = String(input.value); paintRange(input); });
        input.addEventListener('change', () => apply(field.key, Number(input.value)));
      } else {
        input.addEventListener('change', () => apply(field.key, input.value === 'auto' ? null : input.value));
      }

      host.appendChild(row);
    }

    // The cost readout belongs with the two controls it reads, not at the bottom of the window.
    if (groupName === 'Cost') {
      const note = document.createElement('div');
      note.className = 'status-line panel-cost';
      note.textContent = costNote();
      host.appendChild(note);
    }
  }
}

// An emulator hands DLSS 5 its whole window, so the model works at display resolution whatever the
// emulator renders at internally. This names Model resolution the way that user thinks of it.
const EMULATOR_MODEL_HEIGHTS = [2160, 1800, 1440, 1080, 900, 720];

function renderEmulator() {
  $('#panel-emulator').classList.toggle('hidden', !isEmulator);
  if (!isEmulator) return;

  const select = $('#panel-emulator-res');
  const display = displayPixels();
  const scale = Number(valueOf('WorkingScale')) || 1;
  const sizeAt = (s) => `${Math.round(display.width * s)}x${Math.round(display.height * s)}`;

  select.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    select.appendChild(o);
  };
  add('1', t('Display resolution ({size}) -- default', { size: `${display.width}x${display.height}` }));
  for (const h of EMULATOR_MODEL_HEIGHTS) {
    const s = h / display.height;
    if (s >= 0.999 || s < 0.25) continue;
    add(String(Math.round(s * 100) / 100), t('{h}p ({size}, {pct}% of the work area)', { h, size: sizeAt(s), pct: Math.round(s * 100) }));
  }
  const currentScale = String(Math.round(scale * 100) / 100);
  if (![...select.options].some((o) => o.value === currentScale)) {
    add(currentScale, t('Custom: {pct}% ({size})', { pct: Math.round(scale * 100), size: sizeAt(scale) }));
  }
  select.value = currentScale;

  $('#panel-emulator-note').textContent = scale < 0.999
    ? t('The model works at {size}: about {pct}% of the display-resolution cost.', { size: sizeAt(scale), pct: Math.round(scale * scale * 100) })
    : '';
  select.onchange = () => apply('WorkingScale', Number(select.value) >= 0.999 ? null : Number(select.value));
}

function render() {
  renderEmulator();
  renderFields();
}

// The engine re-reads the ini while the game runs, so a change lands within about a second. That is
// what this window is for, and why its wording differs from the Edit dialog's "next time it starts".
async function apply(key, value) {
  if (!current) return;
  const res = await window.api.dlssNrSet(current.exePath, { [key]: value });
  if (!res || !res.ok) {
    setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') }), 'status-bad');
    return;
  }
  fields = res.fields;
  setStatus(res.written.length
    ? (current.running ? t('Saved. A running game picks it up within a second.') : t('Saved. Applies the next time the game starts.'))
    : t('Nothing to change.'));
  render();
}

async function loadGame(exePath) {
  current = targets.find((g) => g.exePath === exePath) || null;
  fields = [];
  forced = {};
  isEmulator = false;
  $('#panel-helper-note').classList.add('hidden');

  if (!current) {
    render();
    setStatus(t('Pick a game.'));
    return;
  }

  const res = await window.api.dlssNrGet(current.exePath);
  if (!res || !res.ok) {
    render();
    setStatus(res && res.error === 'not-installed'
      ? t('OptiScaler is not installed for this game yet.')
      : t('Could not read the settings: {error}', { error: (res && res.error) || t('unknown') }), 'status-bad');
    return;
  }

  fields = res.fields || [];
  forced = res.forced || {};
  // inHelper means the ini being edited is the 64-bit helper's: the 32-bit case, and exactly the one
  // where the in-game panel is a picture of a panel rather than a panel.
  $('#panel-helper-note').classList.toggle('hidden', !res.inHelper);

  try {
    const route = await window.api.gameRoute(current.exePath, current.detectedPath);
    isEmulator = !!(route && route.emulator);
  } catch {
    // No route means no emulator block; the sliders below still work.
  }

  render();
  setStatus(current.running
    ? t('Game is running. Changes land within a second.')
    : t('Game is not running. Changes apply when it starts.'));
}

async function refreshTargets() {
  const res = await window.api.panelTargets();
  targets = (res && res.ok && Array.isArray(res.games)) ? res.games : [];

  const select = $('#panel-game');
  const previous = current ? current.exePath : null;
  select.innerHTML = '';

  if (targets.length === 0) {
    setStatus(t('No games added yet.'));
    render();
    return;
  }

  for (const game of targets) {
    const o = document.createElement('option');
    o.value = game.exePath;
    o.textContent = game.running ? t('{name} (running)', { name: game.name }) : game.name;
    select.appendChild(o);
  }

  // A running game wins, because that is the one being tuned; otherwise whatever was open before,
  // otherwise the first game that has anything to edit. Re-picked on every open, so the panel
  // follows the session rather than whatever was showing when it was last put away.
  const running = targets.find((g) => g.running);
  const keep = previous && targets.some((g) => g.exePath === previous) ? previous : null;
  const installed = targets.find((g) => g.installed);
  const chosen = (running && running.exePath) || keep || (installed && installed.exePath) || targets[0].exePath;
  select.value = chosen;
  await loadGame(chosen);
}

$('#panel-game').addEventListener('change', (e) => loadGame(e.target.value));
$('#panel-close').addEventListener('click', () => window.api.panelClose());

// The theme is one switch for the whole app: saving it here is what the main window reads too, so
// the two never disagree about which theme this app is in.
$('#panel-theme').addEventListener('click', async () => {
  settings.theme = settings.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  await window.api.saveSettings(settings);
});

$('#panel-reset').addEventListener('click', async () => {
  if (!current || fields.length === 0) return;
  const all = {};
  for (const f of fields) all[f.key] = null;
  const res = await window.api.dlssNrSet(current.exePath, all);
  if (!res || !res.ok) {
    setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') }), 'status-bad');
    return;
  }
  fields = res.fields;
  setStatus(current.running
    ? t('Everything back to default. A running game picks it up within a second.')
    : t('Everything back to default. Applies the next time the game starts.'));
  render();
});

// Escape closes, matching every other dismissible surface in this app.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.panelClose();
});

// Re-read on every open rather than only at startup: which game is running, what its ini says, and
// which theme and language the app is in are all likely to have changed since it was put away.
window.api.onPanelOpened(async () => {
  const data = await window.api.loadData();
  settings = data.settings || {};
  applyLanguage();
  applyTheme();
  I18N.applyStatic();
  await refreshTargets();
});

// The main window's Settings can change the theme or the language while the panel is open.
window.api.onSettingsChanged((next) => {
  settings = next || {};
  applyLanguage();
  applyTheme();
  I18N.applyStatic();
  render();
});

(async () => {
  const data = await window.api.loadData();
  settings = data.settings || {};
  applyLanguage();
  applyTheme();
  I18N.applyStatic();
  await applyVendor();
  await refreshTargets();
})();
