#!/usr/bin/env node
// Regenerates src/ue-extended-games.json -- UE-Extended's GameSettings table, which the app reads for
// the blue "RenoDX UE+" card tag and for which games need Unreal's own HDR switched on (Engine.ini).
// See src/ueextended.js for why it is a shipped file and not read at run time.
//
//   node tools/gen-ue-extended-table.js                       # from the fork, ref feat/ue-extended
//   node tools/gen-ue-extended-table.js --ref master          # another ref of the fork
//   node tools/gen-ue-extended-table.js --file path/to/addon.cpp --ref <label>
//
// Run it again whenever the fork's src/games/ue-extended changes (upstream-watch lists those commits).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseGameSettings } = require('../src/ueextended');

const REPO = 'mrcgibb9876-hash/renodx';
const FILE = 'src/games/ue-extended/addon.cpp';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const ref = arg('--ref', 'feat/ue-extended');
  const local = arg('--file');
  let cpp;
  let commit = null;
  if (local) {
    cpp = fs.readFileSync(local, 'utf8');
  } else {
    const headers = { 'User-Agent': 'OptiDLSS5-UI-gen', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const c = await fetch(`https://api.github.com/repos/${REPO}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(FILE)}&per_page=1`, { headers });
    if (c.ok) commit = ((await c.json())[0] || {}).sha || null;
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(commit || ref)}/${FILE}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${FILE}@${ref}`);
    cpp = await res.text();
  }
  const games = parseGameSettings(cpp);
  const keys = Object.keys(games);
  if (keys.length < 10) throw new Error(`only ${keys.length} entries parsed -- has the table's shape changed?`);
  const out = {
    source: { repo: REPO, file: FILE, ref, commit },
    generated: new Date().toISOString().slice(0, 10),
    count: keys.length,
    games: Object.fromEntries(keys.sort((a, b) => a.localeCompare(b)).map((k) => [k, games[k]])),
  };
  const dest = path.join(__dirname, '..', 'src', 'ue-extended-games.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`${keys.length} entries (${keys.filter((k) => games[k].nativeHdr).length} native-HDR) -> ${dest}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
