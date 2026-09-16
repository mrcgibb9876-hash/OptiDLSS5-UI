// The break-away DLSS 5 panel's renderer. Deliberately standalone rather than shared with the Edit
// dialog's copy: that one is wired to the Edit dialog's element ids and its module state, and the
// two windows want different layouts. What they do share is the part that matters -- dlssnr:get and
// dlssnr:set, so the meaning of a setting is defined once, in src/dlssnr.js.

const $ = (sel) => document.querySelector(sel);

let targets = [];
let current = null;   // { name, exePath }
let fields = [];
let forced = {};

function applyLanguage(settings) {
  const wanted = settings && settings.language && settings.language !== 'auto' ? settings.language : I18N.detect();
  I18N.setLocale(wanted);
}

function setStatus(text, kind) {
  const el = $('#panel-status');
  el.textContent = text;
  el.className = `status-line${kind ? ' ' + kind : ''}`;
}

// A field whose dependency is not met is shown greyed rather than hidden: a control that vanishes
// leaves the reader wondering whether they imagined it, and the tooltip explains the condition.
function dependencyMet(field) {
  if (!field.dependsOn) return true;
  const parent = fields.find((f) => f.key === field.dependsOn.key);
  if (!parent) return true;
  const value = parent.value === null ? parent.default : parent.value;
  return String(value) === String(field.dependsOn.value);
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
        input = document.createElement('input');
        input.type = 'range';
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step || (field.type === 'int' ? 1 : 0.05));
        input.value = String(shown);
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
        input.addEventListener('input', () => { readout.textContent = String(input.value); });
        input.addEventListener('change', () => apply(field.key, Number(input.value)));
      } else {
        input.addEventListener('change', () => apply(field.key, input.value === 'auto' ? null : input.value));
      }

      host.appendChild(row);
    }
  }
}

// The engine re-reads the ini while the game runs, so a change lands within about a second. That is
// the whole point of this window, and worth saying: the Edit dialog's own wording predates it.
async function apply(key, value) {
  if (!current) return;
  const res = await window.api.dlssNrSet(current.exePath, { [key]: value });
  if (!res || !res.ok) {
    setStatus(t('Could not save: {error}', { error: (res && res.error) || t('unknown') }), 'status-bad');
    return;
  }
  fields = res.fields;
  setStatus(res.written.length ? t('Saved. A running game picks it up within a second.') : t('Nothing to change.'));
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
      : t('Could not read the settings: {error}', { error: (res && res.error) || t('unknown') }), 'status-bad');
    return;
  }

  fields = res.fields || [];
  forced = res.forced || {};
  renderFields();
  // inHelper means the ini being edited is the 64-bit helper's, which is the 32-bit case -- exactly
  // the one where the in-game panel is a picture that cannot be clicked.
  setStatus(res.inHelper
    ? t('Editing the 64-bit helper this 32-bit game uses.')
    : current.running ? t('Game is running. Changes land within a second.') : t('Game is not running. Changes apply when it starts.'));
}

async function refreshTargets() {
  const res = await window.api.panelTargets();
  targets = (res && res.ok && Array.isArray(res.games)) ? res.games : [];

  const select = $('#panel-game');
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

  // A running game wins, because that is the one being tuned; otherwise whatever was open before,
  // otherwise the first game that has anything to edit. Re-picked on every open so the panel
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
  setStatus(t('Everything back to default. A running game picks it up within a second.'));
  renderFields();
});

// Escape closes, matching every other dismissible surface in this app.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.panelClose();
});

// Re-read on every open rather than only at startup: which game is running, and what its ini says,
// are both likely to have changed since the panel was last put away.
window.api.onPanelOpened(() => refreshTargets());

(async () => {
  const { settings } = await window.api.loadData();
  applyLanguage(settings);
  I18N.applyStatic();
  await refreshTargets();
})();
