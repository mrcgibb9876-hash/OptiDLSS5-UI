// deep-fried-chicken.cfg: read it, change the keys the panel offers, write it back unharmed.
//
// WHY THIS IS ALLOWED, since the rest of dfc.js is so careful about the opposite.
//
// Chicken's LICENSE.txt forbids copying, mirroring, bundling or modifying the Software, which is
// why nothing in this app ever ships its binaries. It separately and explicitly ALLOWS this:
//
//     You may: ... create and share your own Deep Fried Chicken configuration and preset files,
//     provided they do not contain or redistribute any part of the Software.
//
// A config file is not part of the Software. So a settings panel that writes this file is within
// the licence, while a downloader would not be.
//
// (An earlier note in this repo said Chicken's README told users not to edit the cfg. That was the
// DLSS5-Feeder README describing Chicken, not Alexander. Chicken's own README says the opposite:
// "Keep your existing deep-fried-chicken.cfg when updating." Preserving it across updates is the
// rule, which deployDfc already does -- editing it is not forbidden anywhere.)
//
// WHAT THIS MUST NEVER DO.
//
// The real file is 663 keys (CP376 Beta), flat `key=value`, no sections, with comment lines and one
// deliberately repeated key in the sibling transport config. This app understands perhaps a tenth
// of them. So the rule here is the same one the ini writer follows for OptiScaler: parse the whole
// file, change ONLY what was asked for, and write every other line back byte-for-byte -- comments,
// blank lines, ordering, unknown keys, duplicates and all. A key this app has never heard of is a
// key a newer Chicken added, and losing it would silently reset a setting the player chose in
// Chicken's own overlay.
//
// config_schema is the guard on that: CP376 writes 13. A file that says something higher was
// written by a Chicken newer than the one these defaults came from, and is left alone rather than
// rewritten from a stale idea of the format.

'use strict';

// The schema this app's field table was read from (CP376 Beta, 20 September 2026). Reading is fine
// at any version; writing stops above this, because a newer Chicken may have changed what a key
// means and this app would have no way to know.
const KNOWN_SCHEMA = 13;
const SCHEMA_KEY = 'config_schema';

// Parses into a line list that can be rebuilt exactly. Each line is either a raw passthrough
// (comment, blank, junk) or a key/value with its original spacing kept.
function parse(text) {
  const src = String(text == null ? '' : text);
  // Each line keeps its OWN terminator rather than the file keeping one flag. The shipped
  // dfc-universal-feed.cfg really is mixed -- 3 CRLF and 36 LF in CP376 Beta -- and normalising it
  // would rewrite every line in the file, which is the exact thing this module exists to avoid.
  const lines = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, body, eol] = m;
    if (body === '' && eol === '' ) break; // the empty match at the very end
    const km = /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*)$/.exec(body);
    lines.push(km ? { indent: km[1], key: km[2], sep: km[3], value: km[4], eol } : { raw: body, eol });
    if (eol === '') break;
    if (re.lastIndex >= src.length) break;
  }
  return { lines };
}

function serialise(doc) {
  return doc.lines.map((l) => (l.key === undefined ? l.raw : `${l.indent}${l.key}${l.sep}${l.value}`) + (l.eol === undefined ? '\n' : l.eol)).join('');
}

// The terminator a newly appended line should use: whatever the file mostly uses, so an addition
// does not stand out from its neighbours.
function dominantEol(doc) {
  let crlf = 0;
  let lf = 0;
  for (const l of doc.lines) {
    if (l.eol === '\r\n') crlf += 1;
    else if (l.eol === '\n') lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}

// Every key/value in the file, last occurrence winning -- which is what a program reading top to
// bottom into a map would land on, and so what Chicken itself almost certainly sees.
function toObject(doc) {
  const out = {};
  for (const l of doc.lines) if (l.key !== undefined) out[l.key] = l.value;
  return out;
}

function schemaOf(textOrDoc) {
  const doc = typeof textOrDoc === 'string' ? parse(textOrDoc) : textOrDoc;
  const raw = toObject(doc)[SCHEMA_KEY];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// Applies { key: value } to the text, touching nothing else.
//
// A key already in the file is edited in place, at EVERY occurrence -- the transport config ships
// `disable_motion_vectors` twice on purpose, and rewriting only the first would leave the second
// one contradicting it. A key not in the file is appended, because a Chicken older than the field
// table simply did not have it and appending is how its own writer grows the file.
//
// Returns { text, changed, skipped } rather than throwing: a panel that cannot write one field
// should still write the others and say which it could not.
function applyEdits(text, edits, { allowUnknownSchema = false } = {}) {
  const doc = parse(text);
  const schema = schemaOf(doc);
  if (schema !== null && schema > KNOWN_SCHEMA && !allowUnknownSchema) {
    return {
      text: String(text),
      changed: [],
      skipped: Object.keys(edits || {}),
      refused: `this deep-fried-chicken.cfg is ${SCHEMA_KEY}=${schema}, newer than the ${KNOWN_SCHEMA} this app knows -- left untouched`,
    };
  }

  const changed = [];
  for (const [key, raw] of Object.entries(edits || {})) {
    const value = formatValue(raw);
    let hit = false;
    for (const l of doc.lines) {
      if (l.key !== key) continue;
      hit = true;
      if (l.value !== value) { l.value = value; if (!changed.includes(key)) changed.push(key); }
    }
    if (!hit) {
      // Appended after the last key line, so it lands inside the file's body rather than after any
      // trailing comment block.
      const lastKey = doc.lines.reduce((acc, l, i) => (l.key !== undefined ? i : acc), -1);
      const line = { indent: '', key, sep: '=', value, eol: dominantEol(doc) };
      // A file whose last line had no terminator gets one, or the appended line would join it.
      const tail = doc.lines[doc.lines.length - 1];
      if (tail && tail.eol === '') tail.eol = line.eol;
      doc.lines.splice(lastKey + 1, 0, line);
      changed.push(key);
    }
  }
  return { text: serialise(doc), changed, skipped: [] };
}

// Chicken writes integers bare and floats to a fixed number of places (1.000, 0.650, 0.0015). The
// exact width varies per key in its own file, so this only guarantees a form it can parse; it never
// tries to reproduce a key's original precision.
function formatValue(v) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

// ── the fields the panel offers ──────────────────────────────────────────────────────────────
//
// A deliberate subset. The file has 663 keys and this app cannot run Chicken to learn what most of
// them do, so what is here is what its README, its own overlay vocabulary and the shipped defaults
// make unambiguous. Everything else stays readable and untouched, and a player who wants it uses
// Chicken's own overlay -- which is still there.
//
// Checked against Chicken 3.0's own menu on 2026-09-22 (its add-on's draw code: labels, widget types
// and slider ranges). Labels are his, so a player sees the same words here and in his overlay, and
// every range is the one his slider clamps to. Nothing is offered that his menu does not offer:
// `arm`, `layers`, `texture_boost*`, `preserve_native_tone_color*` and `frame_generation_coexistence`
// were here from the CP376 cfg and are gone -- his menu never shows them (the last is automatic now),
// and a setting that exists only in this app is one nobody can check against Chicken itself.
//
// Chicken keeps its settings in memory and saves the whole file after each change in its own menu,
// so an edit here reaches a game that is NOT running; a running game writes over it.
const FIELDS = [
  { key: 'enabled', type: 'bool', label: 'Enabled', help: 'Chicken\x27s own on/off switch. The game\x27s DLSS and frame-generation settings are not touched either way.' },
  // A decimal, not a count: Chicken blends the last pass in by the fraction.
  { key: 'passes', type: 'number', min: 1, max: 30, step: 0.1, label: 'Pass amount', help: 'How many neural passes run each frame, in tenths. 1.0 is the default; above about 10 the GPU and VRAM cost is heavy.' },
  { key: 'neural_work_percent', type: 'number', min: 10, max: 150, step: 1, unit: '%', label: 'Resolution scale', help: 'The resolution the neural pass works at, as a share of the game\x27s. In the game, Chicken\x27s own menu only applies a change after "Apply resolution".' },
  { key: 'clean_fry_enabled', type: 'bool', label: 'Clean Fry enabled' },
  { key: 'clean_fry_cleanup_strength', type: 'number', min: 0, max: 1, step: 0.05, label: 'Cleanup Strength', dependsOn: 'clean_fry_enabled', help: 'Higher is stricter. Clean Fry only works when two or more neural passes run.' },
  // Only Chicken's 32-bit menu shows this one; the key is live on both.
  { key: 'clean_fry_detail_retention', type: 'number', min: 0, max: 1, step: 0.05, label: 'Fine-detail retention', dependsOn: 'clean_fry_enabled', help: 'How much fine detail Clean Fry keeps. Chicken shows this in its 32-bit menu only.' },
  { key: 'motion_stability_enabled', type: 'bool', label: 'Motion Stability enabled' },
  { key: 'motion_stability_strength', type: 'number', min: 0, max: 1, step: 0.05, label: 'Settle Strength', dependsOn: 'motion_stability_enabled', help: 'Settles broad changes between passes within the current frame. It only works when two or more neural passes run.' },
  { key: 'motion_stability_detail_retention', type: 'number', min: 0, max: 1, step: 0.05, label: 'Detail retention', dependsOn: 'motion_stability_enabled' },
];

const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));

// What the panel draws: every offered field with the value this file actually holds, plus the
// counts the UI needs to explain itself. Values come back as strings exactly as stored, so nothing
// is reformatted on a read.
function readFields(text) {
  const doc = parse(text);
  const all = toObject(doc);
  const schema = schemaOf(doc);
  return {
    schema,
    knownSchema: KNOWN_SCHEMA,
    tooNew: schema !== null && schema > KNOWN_SCHEMA,
    fields: FIELDS.map((f) => ({ ...f, value: all[f.key], present: Object.prototype.hasOwnProperty.call(all, f.key) })),
    // Honesty in the UI: say how much of the file this panel does not cover, so nobody assumes
    // these are all of Chicken's settings.
    totalKeys: Object.keys(all).length,
    offeredKeys: FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(all, f.key)).length,
  };
}

module.exports = {
  KNOWN_SCHEMA, SCHEMA_KEY, FIELDS, FIELD_KEYS,
  parse, serialise, toObject, schemaOf, applyEdits, formatValue, readFields,
};
