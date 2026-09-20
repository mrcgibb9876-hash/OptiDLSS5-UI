// SteamGridDB: art for the games the Steam store cannot name.
//
// The chain a card's art already walks is Steam manifest -> Steam store search -> the game's own exe
// icon (exeicon.js). The gap is in the middle: an old game, a console port, a title that was never on
// Steam or was delisted from it, gets no store hit and drops straight to its icon. SteamGridDB is a
// community art database that covers exactly those -- so it slots in as the last network step, after
// the store search has missed and before the icon fallback.
//
// It needs a key, and the key is the user's own: SteamGridDB issues one per account, free, at
// steamgriddb.com/profile/preferences/api. Nothing here ships a key, and with no key set this module is
// never called at all -- the chain is exactly what it was. Same posture as the Anthropic key in
// Settings: the user's own credential, pasted by them, used only for what they asked for.
//
// Choosing between its answers is NOT this module's own idea of a match. It reuses library's
// bannerSearchTerms ladder and pickBannerMatch rule, so a SteamGridDB result has to clear the same bar
// a Steam result does: every identity-carrying word present, fewest extra words wins, and a title that
// does not contain the query is refused outright. Wrong art is worse than no art on this card, and a
// second art source is a second chance to get it wrong (see test/banner.test.js for why that rule
// exists at all).
//
// Which image: SteamGridDB's "grids" include the two Steam header shapes, 460x215 and 920x430, which is
// the shape this app's cards are already built around -- so those are asked for first and drop in with
// no layout change. Its "heroes" (a much wider banner) are the fallback, and a vertical capsule is
// never taken: it would be cropped to a strip of somebody's cover art.
'use strict';
const library = require('./library');

const API = 'https://www.steamgriddb.com/api/v2';

// The Steam header shapes, in the order a card wants them: 920x430 is the same picture at twice the
// resolution, so ask for both and let SteamGridDB return whatever it has.
const HEADER_DIMENSIONS = '460x215,920x430';

// Static art only. An animated grid is a .webm that neither the card nor the banner cache can show.
const STILL_TYPES = 'static';

function keyIsSet(key) {
  return typeof key === 'string' && key.trim().length > 0;
}

async function apiGet(pathAndQuery, key, fetchImpl) {
  const res = await fetchImpl(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${String(key).trim()}`, 'User-Agent': 'OptiDLSS5-UI' },
  });
  // 401/403 is a key problem and 404 is "no art of that shape". Neither is worth throwing over: the
  // caller's answer for all of them is the same, carry on to the next fallback.
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.success ? data.data : null;
}

// What SteamGridDB knows by that name. Returns the shape pickBannerMatch reads: objects with a .name.
async function search(term, key, fetchImpl = fetch) {
  const data = await apiGet(`/search/autocomplete/${encodeURIComponent(term)}`, key, fetchImpl);
  if (!Array.isArray(data)) return [];
  return data.slice(0, 8).map((item) => ({ gridId: item.id, name: item.name }));
}

// The best still image for a game id, header-shaped if there is one. `url` is the full-size file and
// `thumb` a smaller copy of the same picture; the full size is what the banner cache stores.
async function artFor(gridId, key, fetchImpl = fetch) {
  const ladder = [
    `/grids/game/${gridId}?dimensions=${HEADER_DIMENSIONS}&types=${STILL_TYPES}&nsfw=false`,
    `/heroes/game/${gridId}?types=${STILL_TYPES}&nsfw=false`,
  ];
  for (const query of ladder) {
    const data = await apiGet(query, key, fetchImpl);
    if (!Array.isArray(data) || data.length === 0) continue;
    const first = data.find((item) => item && typeof item.url === 'string' && item.url);
    if (first) return first.url;
  }
  return null;
}

// The whole fallback in one call: a name in, an image URL out, or null.
//
// Walks the same term ladder as the store search -- a name SteamGridDB does not know as given may be
// known without its edition words or with its acronym collapsed, exactly as on Steam. The first term
// with a result that survives pickBannerMatch wins; a term whose results are all refused carries on
// down the ladder rather than ending it, because being refused means that spelling found the wrong
// game, not that the right one is absent.
async function resolve(name, key, { fetchImpl = fetch } = {}) {
  if (!keyIsSet(key) || !name) return null;
  for (const term of library.bannerSearchTerms(name)) {
    let items = [];
    try {
      items = await search(term, key, fetchImpl);
    } catch {
      // A network or key failure ends the attempt for this card, not the app: no art beats a crash,
      // and the exe icon is still waiting below.
      return null;
    }
    if (!items.length) continue;
    const best = library.pickBannerMatch(term, items);
    if (!best) continue;
    let imageUrl = null;
    try {
      imageUrl = await artFor(best.gridId, key, fetchImpl);
    } catch {
      return null;
    }
    // The name matched but SteamGridDB holds no still art of a usable shape for it. That is this
    // game's answer -- another spelling would only find the same game again.
    if (!imageUrl) return null;
    return { gridId: best.gridId, name: best.name, imageUrl };
  }
  return null;
}

module.exports = { search, artFor, resolve, keyIsSet, HEADER_DIMENSIONS };
