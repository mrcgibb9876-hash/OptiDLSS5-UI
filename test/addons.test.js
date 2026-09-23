'use strict';
// The curated ReShade add-on catalogue (addons.js) and the technique ordering it depends on
// (preset-order.js). Both are about the same failure: a ReShade effect chain in the wrong order
// compiles, runs, and produces a quietly wrong picture, so nothing here can be checked by "did it
// error".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const addons = require('../src/addons');
const order = require('../src/preset-order');
const integrity = require('../src/integrity');

function scratchDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dlss5ui-${name}-`));
}

// ── ordering ──────────────────────────────────────────────────────────────────────────────────

test('the bands run motion vectors first and the HDR output converter last', () => {
  assert.ok(order.BAND.MV_PROVIDER < order.BAND.FEED, 'vectors exist before the feed reads them');
  assert.ok(order.BAND.FEED < order.BAND.EFFECT, 'the model sees the game, not the grade');
  assert.ok(order.BAND.EFFECT < order.BAND.INVERSE_TONEMAP, 'SDR effects happen before SDR is expanded');
  assert.ok(order.BAND.INVERSE_TONEMAP < order.BAND.HDR_OUTPUT, 'the converter hands off the finished frame');
  // Unknown is EFFECT, not last. A technique this app has never heard of is almost always the
  // player's own, and putting it after an HDR output converter would break their preset for them.
  assert.equal(order.DEFAULT_BAND, order.BAND.EFFECT);
});

test('sorting is stable, so a player\'s own effects keep the order they chose', () => {
  const ranks = new Map([
    ['vort_motioneffects@vort_motion.fx', order.BAND.MV_PROVIDER],
    ['dlss5_feed@dlss5_feed.fx', order.BAND.FEED],
    ['lilium_itm@lilium__inverse_tone_mapping.fx', order.BAND.INVERSE_TONEMAP],
  ]);
  const list = [
    'Zebra@Zebra.fx', 'Lilium_ITM@lilium__inverse_tone_mapping.fx', 'Alpha@Alpha.fx',
    'DLSS5_Feed@DLSS5_Feed.fx', 'Mango@Mango.fx', 'vort_MotionEffects@vort_Motion.fx',
  ];
  assert.deepEqual(order.sortTechniques(list, ranks), [
    'vort_MotionEffects@vort_Motion.fx',
    'DLSS5_Feed@DLSS5_Feed.fx',
    // Zebra, Alpha, Mango are all unranked: they keep their INPUT order, not alphabetical and
    // not reversed. Sorting them would be this app rearranging someone's preset behind their back.
    'Zebra@Zebra.fx', 'Alpha@Alpha.fx', 'Mango@Mango.fx',
    'Lilium_ITM@lilium__inverse_tone_mapping.fx',
  ]);
});

test('applyOrder adds what must be there, drops what must not, and writes both keys', () => {
  const ini = 'Techniques=Mine@Mine.fx\nTechniqueSorting=Mine@Mine.fx,Old@Old.fx\n';
  const ranks = new Map([['mv@mv.fx', order.BAND.MV_PROVIDER]]);
  const out = order.applyOrder(ini, { present: ['MV@mv.fx'], absent: ['old@old.fx'], ranks });
  // Case-insensitive on the way in (ReShade keeps the case the effect declared, a hand-written
  // preset may not), and the caller's spelling on the way out.
  assert.match(out, /Techniques=MV@mv\.fx,Mine@Mine\.fx/);
  assert.match(out, /TechniqueSorting=MV@mv\.fx,Mine@Mine\.fx/);
  assert.doesNotMatch(out, /Old@Old\.fx/, 'the removed technique is gone from both keys');
});

test('a technique already present is not added twice', () => {
  const ini = 'Techniques=A@a.fx\nTechniqueSorting=A@a.fx\n';
  const out = order.applyOrder(ini, { present: ['a@A.FX'], ranks: new Map() });
  assert.equal((out.match(/a\.fx/gi) || []).length, 2, 'once in each key, not twice');
});

// ── the catalogue ─────────────────────────────────────────────────────────────────────────────

test('every catalogue entry names its licence and a homepage, and every fetchable one is pinned', () => {
  for (const a of addons.catalogue()) {
    assert.ok(a.licence, `${a.id} states its licence`);
    assert.ok(/^https:\/\//.test(a.homepage), `${a.id} links its own project`);
    assert.ok(a.summary && a.summary.length > 40, `${a.id} says what it is for`);
    assert.ok(['addon', 'shaders'].includes(a.kind));
    if (a.kind === 'shaders') {
      // A shader pack declares a band, because installing one re-sorts the preset and a pack
      // with no band would land in EFFECT by accident rather than by decision.
      assert.notEqual(a.band, undefined, `${a.id} declares the band its techniques belong in`);
      assert.ok(integrity[a.source.shaKey], `${a.id}'s files are hash-pinned in integrity.js`);
      assert.ok(integrity.URLS[a.source.baseKey], `${a.id} has a pinned base URL`);
    }
  }
});

test('every pinned shader file has a place to go and a hash to be checked against', () => {
  for (const a of addons.catalogue().filter((x) => x.kind === 'shaders')) {
    const files = addons.packFiles(a);
    assert.ok(files.length > 0, `${a.id} has files`);
    for (const rel of files) {
      assert.ok(addons.destForPackFile(rel), `${a.id}: ${rel} maps into reshade-shaders`);
      assert.match(integrity[a.source.shaKey][rel], /^[0-9a-f]{64}$/, `${a.id}: ${rel} is pinned`);
      assert.equal(integrity.PINS[integrity.URLS[a.source.baseKey] + rel], integrity[a.source.shaKey][rel],
        `${a.id}: ${rel}'s pin is registered against its real URL`);
    }
  }
});

test('a file outside Shaders/ or Textures/ is refused rather than scattered into the game folder', () => {
  assert.equal(addons.destForPackFile('README.md'), null);
  assert.equal(addons.destForPackFile('LICENSE'), null);
  assert.equal(addons.destForPackFile('Shaders/x.fx'), path.join('reshade-shaders', 'Shaders', 'x.fx'));
  assert.equal(addons.destForPackFile('Textures/y.png'), path.join('reshade-shaders', 'Textures', 'y.png'));
});

// ── reading techniques out of a shader ────────────────────────────────────────────────────────

test('technique names are read from the shader, and a commented-out one is not a technique', () => {
  const fx = [
    'technique Alpha { pass {} }',
    'technique Beta < ui_label = "Beta"; > { pass {} }',
    '// technique Ghost',
    '/* technique AlsoGhost */',
    'technique   Gamma',
    '{ pass {} }',
  ].join('\n');
  assert.deepEqual(addons.techniquesIn(fx), ['Alpha', 'Beta', 'Gamma']);
});

// ── matching a game to a RenoDX add-on ────────────────────────────────────────────────────────

const INDEX = {
  games: [
    {
      id: 'cyberpunk2077',
      title: 'Cyberpunk 2077',
      aliases: ['Cyberpunk'],
      steam_appid: 1091500,
      mods: [
        { id: 'cp2077-old', title: 'Archive', status: 'beta', artifacts: [{ name: 'renodx-cp2077-old.addon64', arch: 'x64' }] },
        { id: 'cyberpunk2077', title: 'Cyberpunk 2077', status: 'stable', artifacts: [{ name: 'renodx-cyberpunk2077.addon64', arch: 'x64' }] },
      ],
    },
    {
      id: 'terraria',
      title: 'Terraria',
      deploy: { steam_appid: 105600 },
      mods: [{ id: 'terraria', status: 'stable', artifacts: [{ name: 'renodx-terraria.addon32', arch: 'x86' }] }],
    },
    // In the index but with nothing built for it: must never be offered.
    { id: 'nothingbuilt', title: 'Nothing Built', steam_appid: 999, mods: [{ id: 'nothingbuilt', artifacts: [] }] },
  ],
};

test('a game matches its RenoDX add-on by Steam appid, and says that is what it matched on', () => {
  const hit = addons.matchRenodx(INDEX, { steamAppid: 1091500, bitness: 64 });
  assert.equal(hit.artifact, 'renodx-cyberpunk2077.addon64');
  assert.equal(hit.how, 'steam-appid');
  // Two mods target this game; the stable one wins over the beta Archive variant, rather than
  // whichever the index happened to list first.
  assert.equal(hit.modId, 'cyberpunk2077');
});

test('without an appid it falls back to the title, and says so -- a name match is a weaker claim', () => {
  // Punctuation and case are noise: a library name comes from a folder or a store, not from
  // whatever the index author typed.
  const hit = addons.matchRenodx(INDEX, { title: 'cyberpunk 2077', bitness: 64 });
  assert.equal(hit.how, 'title');
  assert.equal(hit.artifact, 'renodx-cyberpunk2077.addon64');
  assert.equal(addons.matchRenodx(INDEX, { title: 'CYBERPUNK' }).how, 'title', 'aliases count too');
  assert.equal(addons.matchRenodx(INDEX, { title: 'Some Other Game' }), null);
});

test('the add-on matches the GAME\'s bitness, and a 32-bit game is never given a 64-bit build', () => {
  assert.equal(addons.matchRenodx(INDEX, { steamAppid: 105600, bitness: 32 }).artifact, 'renodx-terraria.addon32');
  // Terraria has only an x86 build. A 64-bit request must come back empty rather than be handed
  // the 32-bit one -- the wrong bitness does not load, and "installed but nothing happened" is
  // the single hardest thing to diagnose from a support report.
  assert.equal(addons.matchRenodx(INDEX, { steamAppid: 105600, bitness: 64 }), null);
});

test('a game with no artifact built is not offered at all', () => {
  assert.equal(addons.matchRenodx(INDEX, { steamAppid: 999, bitness: 64 }), null);
});

test('the download URL is built from the pinned tag, not from the index\'s relative paths', () => {
  const url = addons.releaseAssetUrl('renodx-terraria.addon32');
  assert.equal(url, `https://github.com/${addons.RENODX_REPO}/releases/download/${addons.RENODX_TAG}/renodx-terraria.addon32`);
  assert.match(addons.renodxIndexUrl(), /games-index\.json$/);
});

// ── install and remove ────────────────────────────────────────────────────────────────────────

// Enough of a fake pack to exercise the whole path without a network. fetchBuffer stands in for
// the app's downloader, which has already applied the integrity check by the time it returns.
function fakeCtx(bodies) {
  const asked = [];
  return {
    asked,
    fetchBuffer: async (url) => {
      asked.push(url);
      const rel = Object.keys(bodies).find((k) => url.endsWith(k));
      if (!rel) throw new Error(`nothing fake for ${url}`);
      return Buffer.from(bodies[rel]);
    },
    resolveRelease: async () => ({ tag_name: 'v1', assets: [{ name: 'autohdr.addon64', browser_download_url: 'https://example.invalid/autohdr.addon64' }] }),
  };
}

test('installing a shader pack places it, reads its techniques, and records what it wrote', async () => {
  const dir = scratchDir('addons-install');
  const files = addons.packFiles(addons.addonById('renofx'));
  const bodies = {};
  for (const rel of files) bodies[rel] = `technique ${path.basename(rel, '.fx').replace(/[^A-Za-z0-9_]/g, '')} { }`;
  const ctx = fakeCtx(bodies);

  const res = await addons.installAddon(dir, 'renofx', ctx);

  for (const rel of files) {
    assert.ok(fs.existsSync(path.join(dir, 'reshade-shaders', ...rel.split('/'))), `${rel} is in place`);
  }
  assert.equal(res.techniques.length, files.length, 'one technique per .fx, read from the file');
  assert.match(res.techniques[0], /@RenoFX/, 'a technique key is Name@File.fx');

  // The marker is the record Remove reads. Without it the app would be guessing at whose files
  // these are, which is the thing it must never do.
  const marker = addons.readMarker(dir);
  assert.equal(marker.installed.length, 1);
  assert.equal(marker.installed[0].id, 'renofx');
  assert.equal(marker.installed[0].band, addons.addonById('renofx').band);
  assert.deepEqual(addons.installedIds(dir), ['renofx']);

  // And those techniques come back with their band, which is what feeder.js sorts the preset by.
  const bands = addons.installedTechniqueBands(dir);
  assert.equal(bands.length, files.length);
  assert.ok(bands.every((b) => b.band === addons.addonById('renofx').band));
});

test('installing RenoDX writes the matched artifact and nothing else', async () => {
  const dir = scratchDir('addons-renodx');
  const match = addons.matchRenodx(INDEX, { steamAppid: 1091500, bitness: 64 });
  const ctx = fakeCtx({ 'renodx-cyberpunk2077.addon64': 'MZ fake addon' });

  const res = await addons.installAddon(dir, 'renodx', ctx, { match });

  assert.deepEqual(res.files, ['renodx-cyberpunk2077.addon64']);
  assert.ok(fs.existsSync(path.join(dir, 'renodx-cyberpunk2077.addon64')));
  // An add-on is a DLL ReShade loads, not an effect: it declares no technique and must never be
  // written into the preset's lists.
  assert.deepEqual(res.techniques, []);
  assert.deepEqual(addons.installedTechniqueBands(dir), []);
  assert.equal(addons.readMarker(dir).installed[0].renodxMod, 'cyberpunk2077');
});

test('remove takes back exactly what was placed, and forgets the claim', async () => {
  const dir = scratchDir('addons-remove');
  const files = addons.packFiles(addons.addonById('renofx'));
  const bodies = {};
  for (const rel of files) bodies[rel] = 'technique T { }';
  await addons.installAddon(dir, 'renofx', fakeCtx(bodies));

  // A file the app did NOT place, sitting in the same folder.
  const theirs = path.join(dir, 'reshade-shaders', 'Shaders', 'TheirOwn.fx');
  fs.writeFileSync(theirs, 'technique TheirOwn { }');

  const res = await addons.removeAddon(dir, 'renofx');

  assert.equal(res.removed.length, files.length);
  for (const rel of files) assert.ok(!fs.existsSync(path.join(dir, 'reshade-shaders', ...rel.split('/'))));
  assert.ok(fs.existsSync(theirs), 'a file this app did not place is not this app\'s to delete');
  // Nothing left installed, so the marker goes rather than sitting there empty.
  assert.equal(addons.readMarker(dir), null);
});

test('RenoDX is flagged as untested alongside neural rendering, and AutoHDR names what it needs', () => {
  // Both touch the final picture and nobody here has a GPU to watch them run together. The
  // combination is allowed -- it is what people want -- but the app says so once rather than
  // leaving the first person whose colours go strange to work it out.
  assert.equal(addons.addonById('renodx').warnWithNeuralRendering, true);
  // AutoHDR with no inverse tonemapper gives a washed-out picture, which reads as "HDR is
  // broken" rather than "nothing is expanding the range".
  assert.deepEqual(addons.addonById('lilium-autohdr').wants, ['lilium-hdr']);
});

// ── the HDR source is exclusive, and swapping is how you change it ─────────────────────────────

test('RenoDX and AutoHDR are the exclusive pair, and the Lilium shader pack is deliberately not in it', () => {
  assert.deepEqual(addons.EXCLUSIVE_GROUPS['hdr-source'], ['renodx', 'lilium-autohdr']);
  // Both upgrade the swap chain, which is the actual conflict -- RenoDX gives the game native
  // HDR, AutoHDR makes an SDR game's chain HDR so an inverse tonemapper can expand into it.
  assert.equal(addons.addonById('renodx').exclusiveGroup, 'hdr-source');
  assert.equal(addons.addonById('lilium-autohdr').exclusiveGroup, 'hdr-source');
  // The pack everyone assumes conflicts with RenoDX. It does not: its analysis shaders are how
  // you check a RenoDX result, and its final tone mapping is what stops a native-HDR game
  // blowing past the display's peak brightness. Only its inverse tonemapper is redundant, and
  // that is a technique you switch off in ReShade, not a reason to refuse the pack.
  assert.equal(addons.addonById('lilium-hdr').exclusiveGroup, undefined);
  assert.equal(addons.addonById('renofx').exclusiveGroup, undefined);
});

test('installing the other HDR source swaps it -- no lockout, and nothing is fetched before the old one goes', async () => {
  const dir = scratchDir('addons-swap');
  const ctx = fakeCtx({
    'renodx-cyberpunk2077.addon64': 'MZ renodx',
    'autohdr.addon64': 'MZ autohdr',
  });
  const match = addons.matchRenodx(INDEX, { steamAppid: 1091500, bitness: 64 });

  await addons.installAddon(dir, 'renodx', ctx, { match });
  assert.deepEqual(addons.installedIds(dir), ['renodx']);
  // With RenoDX here, AutoHDR reports what it would replace -- so the UI can say so up front
  // rather than the other row silently flipping afterwards.
  assert.deepEqual(addons.conflictsFor(dir, 'lilium-autohdr'), ['renodx']);

  const res = await addons.installAddon(dir, 'lilium-autohdr', ctx, { bitness: 64 });

  assert.deepEqual(res.swappedOut, ['renodx'], 'the swap is reported, not silent');
  assert.deepEqual(addons.installedIds(dir), ['lilium-autohdr']);
  assert.ok(!fs.existsSync(path.join(dir, 'renodx-cyberpunk2077.addon64')), 'the old one is gone');
  assert.ok(fs.existsSync(path.join(dir, 'autohdr.addon64')));

  // And back again: this is a swap, not a one-way door.
  const back = await addons.installAddon(dir, 'renodx', ctx, { match });
  assert.deepEqual(back.swappedOut, ['lilium-autohdr']);
  assert.deepEqual(addons.installedIds(dir), ['renodx']);

  // A pack outside the group is untouched by any of it.
  assert.deepEqual(addons.conflictsFor(dir, 'lilium-hdr'), []);
  assert.deepEqual(addons.conflictsFor(dir, 'renofx'), []);
});

test('Lilium\'s final tone mapping runs last, not with the inverse tonemappers it ships beside', () => {
  const spec = addons.addonById('lilium-hdr');
  // Its job is to clamp the finished frame to what the display can show, so anything after it
  // would push the picture back past that ceiling.
  assert.equal(spec.bandFor('lilium__tone_mapping.fx'), order.BAND.HDR_OUTPUT);
  // The inverse tonemapper is the opposite end of the same pack and keeps the pack's own band.
  assert.equal(spec.bandFor('lilium__inverse_tone_mapping.fx'), order.BAND.INVERSE_TONEMAP);
  assert.equal(spec.bandFor('lilium__hdr_and_sdr_analysis.fx'), order.BAND.INVERSE_TONEMAP);
});

test('a pack\'s per-technique bands survive into what the preset is sorted by', async () => {
  const dir = scratchDir('addons-bands');
  const files = addons.packFiles(addons.addonById('lilium-hdr'));
  const bodies = {};
  for (const rel of files) bodies[rel] = /\.fx$/i.test(rel) ? `technique T_${path.basename(rel, '.fx')} { }` : 'x';
  await addons.installAddon(dir, 'lilium-hdr', fakeCtx(bodies));

  const bands = addons.installedTechniqueBands(dir);
  const last = bands.find((b) => /tone_mapping\.fx$/i.test(b.technique) && !/inverse/i.test(b.technique));
  const inverse = bands.find((b) => /inverse_tone_mapping\.fx$/i.test(b.technique));
  assert.equal(last.band, order.BAND.HDR_OUTPUT);
  assert.equal(inverse.band, order.BAND.INVERSE_TONEMAP);
  assert.ok(last.band > inverse.band, 'and so it sorts after it');
});
