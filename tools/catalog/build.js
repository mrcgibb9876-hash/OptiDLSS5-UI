#!/usr/bin/env node
'use strict';
// Maintains data/known-good.json, the shipped known-good catalog (src/catalog.js).
//
//   node tools/catalog/build.js            validate every entry, sort them, write the sha256
//   node tools/catalog/build.js --check    validate and verify the sha256 only; exit 1 on any problem
//   node tools/catalog/build.js --digest <file> [--source "issue #N"] [--write] [...more files]
//                                          read a run digest (an issue body, or the digest block on its
//                                          own) into an entry; prints the result, --write merges it in
//
// The app refuses a catalog whose sha256 does not match its entries, so a hand edit only takes effect
// once this has been run over it -- which is also when the entry's shape gets checked.

const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../../src/catalog');
const { parseDigest } = require('../../src/digest');

const FILE = catalog.SHIPPED_FILE;

function readDoc(file = FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function problemsIn(entries) {
  const out = [];
  const seen = new Set();
  for (const [i, e] of entries.entries()) {
    for (const p of catalog.validateEntry(e)) out.push(`entries[${i}] ${e && e.exe}: ${p}`);
    const key = `${e && e.exe}|${JSON.stringify((e && e.match) || null)}`;
    if (seen.has(key)) out.push(`entries[${i}] ${e.exe}: duplicate entry`);
    seen.add(key);
  }
  return out;
}

// Entries in a stable order, so a diff of the file shows what changed and nothing else.
const sorted = (entries) => [...entries].sort((a, b) => a.exe.localeCompare(b.exe));

function build(doc) {
  const entries = sorted(doc.entries || []);
  return { _readme: doc._readme, version: doc.version || 1, sha256: catalog.entriesHash(entries), entries };
}

function write(doc, file = FILE) {
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function main(argv) {
  const args = argv.slice(2);
  const doc = readDoc();
  if (args[0] === '--check') {
    const problems = problemsIn(doc.entries || []);
    const v = catalog.verifyCatalog(doc);
    if (!v.ok) problems.push(v.reason);
    for (const p of problems) console.error(p);
    if (problems.length) return 1;
    console.log(`ok: ${doc.entries.length} entries, sha256 ${doc.sha256.slice(0, 12)}`);
    return 0;
  }
  if (args[0] === '--digest') {
    let source = null;
    let doWrite = false;
    const files = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--source') source = args[++i];
      else if (args[i] === '--write') doWrite = true;
      else files.push(args[i]);
    }
    let entries = doc.entries || [];
    for (const f of files) {
      const facts = parseDigest(fs.readFileSync(f, 'utf8'));
      const entry = catalog.entryFromDigest(facts, { source: source || path.basename(f) });
      if (!entry) { console.log(`${f}: says nothing either way (verdict ${facts.verdict || 'none'}, route ${facts.route || 'none'})`); continue; }
      console.log(`${f}: ${entry.status === 'works' ? 'works' : 'dead end'} -- ${JSON.stringify(entry)}`);
      entries = catalog.addReport(entries, entry);
    }
    if (!doWrite) return 0;
    const problems = problemsIn(entries);
    if (problems.length) { for (const p of problems) console.error(p); return 1; }
    write(build({ ...doc, entries }));
    console.log(`wrote ${FILE}`);
    return 0;
  }
  const problems = problemsIn(doc.entries || []);
  if (problems.length) { for (const p of problems) console.error(p); return 1; }
  const out = build(doc);
  write(out);
  console.log(`wrote ${FILE}: ${out.entries.length} entries, sha256 ${out.sha256.slice(0, 12)}`);
  // The entries that decide a game's translation layer (layerdefault.js). One that proves a layer other
  // than the route's standard one CHANGES what Install puts in front of that game -- said here, so it is
  // never a side effect nobody saw.
  for (const line of provenLayerLines(out.entries)) console.log(line);
  return 0;
}

function provenLayerLines(entries) {
  const lines = [];
  for (const e of entries) {
    const setup = e.setup || {};
    const proven = catalog.provenLayer(e, { route: setup.route });
    if (proven) lines.push(`proven layer: ${e.exe} ${setup.route}:${proven.via}${proven.via === 'dxvk' ? '  <- Install now defaults to DXVK for this game' : ''}`);
    for (const d of e.dead_ends || []) if (d.via) lines.push(`dead-end layer: ${e.exe} ${d.route}:${d.via}`);
  }
  return lines;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { build, problemsIn, main, provenLayerLines };
