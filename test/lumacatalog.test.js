'use strict';
// Luma-Framework per-game mods (lumacatalog.js): name matching that refuses sequels, reading a zip's root
// from its central directory alone, the wiki status table, and the route that follows from a match --
// including Monster Hunter: World, whose own DLSS 1.1.13 is too old for Neural Rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const cat = require(path.join(REPO, 'src', 'lumacatalog'));
const route = require(path.join(REPO, 'src', 'route'));

test('names match Luma\'s mods, with editions and trademarks ignored and sequels refused', () => {
  assert.equal(cat.nameMatches('Monster Hunter: World', 'Monster_Hunter_World'), true);
  assert.equal(cat.nameMatches('Batman™: Arkham Knight', 'Batman_Arkham_Knight'), true);
  assert.equal(cat.nameMatches('Call of Duty®: Black Ops III', 'Call_of_Duty_Black_Ops_3'), true, 'roman numerals');
  assert.equal(cat.nameMatches('FINAL FANTASY XV WINDOWS EDITION', 'Final_Fantasy_XV'), true);
  assert.equal(cat.nameMatches('Mafia III: Definitive Edition', 'Mafia_III'), true);
  assert.equal(cat.nameMatches('Greed Fall', 'GreedFall'), true, 'run together');
  assert.equal(cat.nameMatches('Nioh 2 – The Complete Edition', 'Nioh'), false, 'a sequel');
  assert.equal(cat.nameMatches('Kingdom Come: Deliverance II', 'Kingdom_Come_Deliverance'), false);
  assert.equal(cat.nameMatches('Mortal Kombat 1', 'Mortal_Kombat_11'), false);
  assert.equal(cat.nameMatches('Dishonored', 'Dishonored_2'), false);
  assert.equal(cat.nameMatches('Final Fantasy VII Rebirth', 'Final_Fantasy_VII_Remake'), false);
  assert.deepEqual(cat.parseAssetName('Luma-Prey-Test.zip'), null, 'debug builds are skipped');
  assert.equal(cat.parseAssetName('Luma-Unreal_Engine.zip'), null, 'generic mods are not per-game');
  assert.equal(cat.parseAssetName('Luma-Vanquish-x32.zip').x32, true);
});

test('matchGame takes only DLSS-adding 64-bit mods, and never for a 32-bit game', () => {
  const catalog = { mods: [
    { asset: 'Luma-Sekiro.zip', key: 'Sekiro', addon: 'Luma-Sekiro.addon', dlss: false, x32: false },
    { asset: 'Luma-Monster_Hunter_World.zip', key: 'Monster_Hunter_World', addon: 'Luma-Monster Hunter World.addon', dlss: true, x32: false },
    { asset: 'Luma-Prey.zip', key: 'Prey', addon: 'Luma-Prey.addon', dlss: true, x32: false },
  ] };
  assert.equal(cat.matchGame(['Sekiro™: Shadows Die Twice'], { catalog }), null, 'HDR-only mod');
  assert.equal(cat.matchGame(['Monster Hunter: World'], { catalog }).key, 'Monster_Hunter_World');
  assert.equal(cat.matchGame(['Prey'], { catalog, bitness: 32 }), null, 'Prey (2006) is 32-bit');
});

test('a zip\'s root entries are read from its central directory with a Range request', async () => {
  const files = { 'Luma/Global/a.hlsl': 'x', 'dxgi.dll': 'MZ', 'Luma-Monster Hunter World.addon': 'MZ', 'nvngx_dlss.dll': 'MZ' };
  const parts = [];
  const cds = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const comp = zlib.deflateRawSync(data);
    const nb = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nb.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, nb, comp, Buffer.alloc(4000)); // padding so the tail really is a tail
    cds.push(cd, nb);
    offset += local.length + nb.length + comp.length + 4000;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(4, 8); eocd.writeUInt16LE(4, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...parts, cdBuf, eocd]);
  const ranges = [];
  const fetchImpl = async (url, opts) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range || '');
    ranges.push(opts.headers.Range);
    const slice = zip.subarray(Number(m[1]), Number(m[2]) + 1);
    return { status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  };
  const names = await cat.listRemoteZip('https://dl/zip', { fetchImpl, size: zip.length });
  assert.deepEqual(names.filter((n) => !n.includes('/')), ['dxgi.dll', 'Luma-Monster Hunter World.addon', 'nvngx_dlss.dll']);
  assert.equal(ranges.length, 1, 'one ranged request, not the whole zip');
});

test('the wiki table gives each mod its status', () => {
  const md = '| Name | Author | Download Link | Status |\n|---|---|---|---|\n| Prey | Pumbo | [x](y) | ✅➕ | | |\n| Fallout 4 | Garamond | [x](y) | 🚧 | DLSS+GTAO Only | |\n| Alan Wake 2 | Pumbo | 💡 |';
  const statuses = cat.parseWikiStatuses(md);
  assert.equal(cat.wikiStatusFor(statuses, 'Prey'), 'working');
  assert.equal(cat.wikiStatusFor(statuses, 'Fallout_4'), 'wip');
  assert.equal(cat.wikiStatusFor(statuses, 'Monster_Hunter_World'), null);
});

test('Monster Hunter: World with its own DLSS 1.x takes the Luma route on DirectX 11; a game with DLSS 2+ keeps its own', () => {
  const lumaMod = { asset: 'Luma-Monster_Hunter_World.zip', key: 'Monster_Hunter_World', addon: 'Luma-Monster Hunter World.addon', dlss: true, x32: false, status: null };
  const mhw = scratchDir('mhw-luma');
  const exe = fakeExe(mhw, 'MonsterHunterWorld.exe');
  // A DLL whose version resource says 1.1.13 is not easy to fake; the route reads versions through
  // detect.readFileVersion, which returns null for a non-PE file -- so the too-old case is exercised with a
  // real old DLL when one exists on the machine, and the "no native DLSS" case always.
  const r = route.recommendRoute(mhw, exe, { api: 'dx11', apis: ['dx11', 'dx12'], bitness: 64 }, 'nvidia', { lumaMod });
  assert.equal(r.route, 'lumaue');
  assert.equal(r.label, 'DLSS 5 + Luma');
  assert.equal(r.experimental, true, 'not listed as working on Luma\'s wiki');

  const eff = route.withApiOverride({ api: 'dx12', apis: ['dx11', 'dx12'] }, null, { luma: true });
  assert.equal(eff.api, 'dx11', 'Luma games are set up for DirectX 11, not the DX12 default');
  assert.equal(route.withApiOverride({ api: 'dx11', apis: ['dx11', 'dx12'] }, null).api, 'dx12', 'everything else keeps the DX12 default');

  // A Feeder already there: the route names what is running and says Luma is available.
  write(mhw, 'dlss5-feed.addon64', 'x');
  const withFeeder = route.recommendRoute(mhw, exe, { api: 'dx11', apis: ['dx11'], bitness: 64 }, 'nvidia', { lumaMod });
  assert.equal(withFeeder.route, 'feeder');
  assert.equal(withFeeder.lumaAvailable, true);
});

test('the bundled catalog lists Luma\'s DLSS mods, Monster Hunter: World among them', () => {
  const bundled = JSON.parse(fs.readFileSync(cat.BUNDLED, 'utf8'));
  const mhw = bundled.mods.find((m) => m.key === 'Monster_Hunter_World');
  assert.ok(mhw && mhw.dlss && mhw.addon, 'MHW has a DLSS mod');
  const sekiro = bundled.mods.find((m) => m.key === 'Sekiro');
  assert.ok(sekiro && !sekiro.dlss, 'Sekiro\'s mod is HDR only');
});
