// The SteamGridDB fallback: the art source a card reaches only after Steam has missed it.
//
// Two things are worth holding down here. One, it must not become a second way to put the wrong
// game's art on a card -- it reuses library.pickBannerMatch precisely so it cannot, and that is
// tested with the same kind of name that caused the original bug. Two, it must be invisible when no
// key is set: that is the state almost every install is in, and a fallback that throws or hangs
// there would break art for everyone.
//
// Offline: every reply here is the shape SteamGridDB's v2 API really returns.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const steamgrid = require(path.join(__dirname, '..', 'src', 'steamgrid'));

// A fetch stand-in built from a map of URL fragment -> body. Records what was asked for, so the
// tests can assert on the request as well as the answer.
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, opts) => {
    seen.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return { ok: true, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  };
  impl.seen = seen;
  return impl;
}

const found = (...games) => ({ success: true, data: games.map((name, i) => ({ id: 900 + i, name })) });
const grids = (...urls) => ({ success: true, data: urls.map((url, i) => ({ id: i, url })) });

test('no key means the step does not exist', async () => {
  // The common case. Nothing is sent, and null is the same answer the store search gives when it
  // misses -- so the card carries on to its exe icon exactly as before this existed.
  const fetchImpl = fakeFetch({});
  assert.equal(await steamgrid.resolve('Some Game', '', { fetchImpl }), null);
  assert.equal(await steamgrid.resolve('Some Game', undefined, { fetchImpl }), null);
  assert.equal(await steamgrid.resolve('Some Game', '   ', { fetchImpl }), null);
  assert.equal(fetchImpl.seen.length, 0, 'nothing is requested without a key');
});

test('the key is sent as a bearer token, and only the game name goes out', async () => {
  const fetchImpl = fakeFetch({
    '/search/autocomplete/': found('Gothic II'),
    '/grids/game/900': grids('https://cdn2.steamgriddb.com/grid/abc.png'),
  });
  const art = await steamgrid.resolve('Gothic II', 'key-123', { fetchImpl });
  assert.equal(art.imageUrl, 'https://cdn2.steamgriddb.com/grid/abc.png');
  assert.equal(art.gridId, 900);
  assert.equal(fetchImpl.seen[0].auth, 'Bearer key-123');
  assert.ok(fetchImpl.seen[0].url.includes('Gothic%20II'), 'the name is what is searched for');
});

test('it does not take the first answer, the same way the store search does not', async () => {
  // The rule that exists because Castlevania: Lords of Shadow wore Lords of Shadow 2's art, and the
  // reason this goes through library.pickBannerMatch rather than having a matcher of its own: a
  // second art source is otherwise a second chance to make exactly that mistake.
  const fetchImpl = fakeFetch({
    '/search/autocomplete/': found('Castlevania: Lords of Shadow 2', 'Castlevania: Lords of Shadow'),
    '/grids/game/901': grids('https://cdn2.steamgriddb.com/grid/first.png'),
  });
  const art = await steamgrid.resolve('Castlevania Lords of Shadow', 'k', { fetchImpl });
  assert.equal(art.name, 'Castlevania: Lords of Shadow', 'the extra "2" loses to the game itself');
});

test('the sequel still gets its own art when the sequel is what is asked for', async () => {
  const fetchImpl = fakeFetch({
    '/search/autocomplete/': found('Castlevania: Lords of Shadow 2', 'Castlevania: Lords of Shadow'),
    '/grids/game/900': grids('https://cdn2.steamgriddb.com/grid/sequel.png'),
  });
  const art = await steamgrid.resolve('Castlevania Lords of Shadow 2', 'k', { fetchImpl });
  assert.equal(art.name, 'Castlevania: Lords of Shadow 2');
});

test('a game whose name is nowhere in the answer is refused outright', async () => {
  // "re2" returning Red Dead Redemption 2 is the other half of that bug. No art beats wrong art.
  const fetchImpl = fakeFetch({
    '/search/autocomplete/': found('Red Dead Redemption 2'),
    '/grids/game/900': grids('https://cdn2.steamgriddb.com/grid/rdr2.png'),
  });
  assert.equal(await steamgrid.resolve('re2', 'k', { fetchImpl }), null);
});

test('header-shaped grids are asked for first, heroes only when there are none', async () => {
  const fetchImpl = fakeFetch({
    '/search/autocomplete/': found('Outcast'),
    '/heroes/game/900': grids('https://cdn2.steamgriddb.com/hero/wide.png'),
  });
  const art = await steamgrid.resolve('Outcast', 'k', { fetchImpl });
  assert.equal(art.imageUrl, 'https://cdn2.steamgriddb.com/hero/wide.png');
  const gridsAsk = fetchImpl.seen.find((r) => r.url.includes('/grids/game/'));
  assert.ok(gridsAsk, 'grids are tried');
  assert.ok(gridsAsk.url.includes('460x215'), 'in the shape the card is built around');
  assert.ok(gridsAsk.url.includes('types=static'), 'and never an animated one the card cannot show');
  assert.ok(fetchImpl.seen.indexOf(gridsAsk) < fetchImpl.seen.findIndex((r) => r.url.includes('/heroes/')),
    'grids before heroes');
});

test('a name it does not know as given is tried the way the store search spells it', async () => {
  // The same ladder as library.bannerSearchTerms: the edition words come off, and a dotted acronym
  // is collapsed. Here only the collapsed spelling is known.
  const fetchImpl = fakeFetch({
    '/search/autocomplete/STALKER': found('S.T.A.L.K.E.R.: Shadow of Chernobyl'),
    '/grids/game/900': grids('https://cdn2.steamgriddb.com/grid/stalker.png'),
  });
  const art = await steamgrid.resolve('S.T.A.L.K.E.R. Shadow of Chernobyl', 'k', { fetchImpl });
  assert.equal(art.imageUrl, 'https://cdn2.steamgriddb.com/grid/stalker.png');
});

test('a match with no usable art is this game\'s answer, not a reason to keep searching', async () => {
  // Another spelling would only find the same game again. The card falls through to its icon.
  const fetchImpl = fakeFetch({ '/search/autocomplete/': found('Gothic II') });
  assert.equal(await steamgrid.resolve('Gothic II', 'k', { fetchImpl }), null);
  assert.equal(fetchImpl.seen.filter((r) => r.url.includes('/search/')).length, 1,
    'the ladder stops once a game has been identified');
});

test('a failing key or a dead network is no art, never a crash', async () => {
  const throwing = async () => { throw new Error('ENOTFOUND'); };
  assert.equal(await steamgrid.resolve('Gothic II', 'k', { fetchImpl: throwing }), null);
  // 401 on a bad key: the body is never even read.
  const unauthorized = async () => ({ ok: false, status: 401, json: async () => { throw new Error('no body'); } });
  assert.equal(await steamgrid.resolve('Gothic II', 'bad-key', { fetchImpl: unauthorized }), null);
});
