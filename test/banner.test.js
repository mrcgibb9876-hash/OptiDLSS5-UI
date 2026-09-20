// Picking a game's art by name. Every row here is a name a real card carried, or the answer the
// store really gave for it -- wrong art is the one mistake on a card that a user cannot help
// reading as "this app has no idea what game this is", so refusing is a valid answer and is
// tested as one. Offline: the store's replies are the ones recorded from it on 2026-09-14.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const library = require(path.join(__dirname, '..', 'src', 'library'));

const items = (...names) => names.map((name, i) => ({ appid: 100 + i, name, tinyImage: null }));
const pick = (query, ...names) => {
  const best = library.pickBannerMatch(query, items(...names));
  return best ? best.name : null;
};

test('the first result is not the answer just because it is first', () => {
  // The report: Castlevania: Lords of Shadow wore Lords of Shadow 2's art, because the sequel is
  // what Steam's search ranks first for the first game's name.
  assert.equal(
    pick('Castlevania Lords of Shadow', 'Castlevania: Lords of Shadow 2', 'Castlevania: Lords of Shadow – Ultimate Edition'),
    'Castlevania: Lords of Shadow – Ultimate Edition',
    'the extra "2" is a word the search never asked for, so the sequel loses'
  );
  // ... and the sequel still gets its own art when it is the sequel being asked for.
  assert.equal(
    pick('Castlevania Lords of Shadow 2', 'Castlevania: Lords of Shadow 2', 'Castlevania: Lords of Shadow – Ultimate Edition'),
    'Castlevania: Lords of Shadow 2'
  );
});

test('a title that does not contain what was searched for is refused, not ranked', () => {
  // A real card: the folder was called "re2" and the store's first answer was Red Dead Redemption 2.
  assert.equal(pick('re2', 'Red Dead Redemption 2', 'Resident Evil 2'), null);
  assert.equal(pick('Bodycam', 'Body Cam Simulator', 'Bodycam'), 'Bodycam');
});

test('edition and packaging words are noise on both sides', () => {
  assert.equal(pick('Shadow of the Tomb Raider', 'Shadow of the Tomb Raider: Definitive Edition'), 'Shadow of the Tomb Raider: Definitive Edition');
  assert.equal(pick('The Witcher 3 Wild Hunt Complete Edition', 'The Witcher 3: Wild Hunt'), 'The Witcher 3: Wild Hunt');
  assert.equal(pick('Stellar Blade', 'Stellar Blade™'), 'Stellar Blade™', 'trademark marks never decide a match');
});

test('small words cannot sink a match, and cannot carry one either', () => {
  assert.equal(pick('God of War', 'God of War'), 'God of War');
  assert.equal(pick('Prince of Persia The Sands of Time', 'Prince of Persia®: The Sands of Time'), 'Prince of Persia®: The Sands of Time');
  // Nothing but weak words: there is no identity to match on, so no art rather than a guess.
  assert.equal(pick('the of', 'The Last of Us'), null);
});

test('an exact title beats a longer one that merely contains it', () => {
  assert.equal(pick('DOOM', 'DOOM Eternal', 'DOOM', 'DOOM VFR'), 'DOOM');
  assert.equal(pick('Batman Arkham Knight', 'Batman™: Arkham Knight'), 'Batman™: Arkham Knight');
});

test('the term ladder reaches the spellings the store actually knows', () => {
  const has = (name, term) => library.bannerSearchTerms(name).includes(term);
  // The dash Steam's search cannot cope with.
  assert.ok(has('Star Wars Jedi - Fallen Order', 'Star Wars Jedi Fallen Order'));
  // A folder name written with dots.
  assert.ok(has('Aliens.Fireteam.Elite.2', 'Aliens Fireteam Elite 2'));
  // A dotted acronym, collapsed the way the store writes it.
  assert.ok(has('S.T.A.L.K.E.R. Shadow of Chernobyl', 'STALKER Shadow of Chernobyl'));
  // The "1" someone adds to tell the first game from its sequel, which no store title carries.
  assert.ok(has('Castlevania Lords of shadow 1', 'Castlevania Lords of shadow'));
  // Dropping trailing words, for when the full name finds nothing: "DOOM 3 BFG" -> "DOOM 3".
  assert.ok(has('DOOM 3 BFG', 'DOOM 3'));
  // The name as given is always tried first, so a game really called Battlefield 1 is found as
  // itself before the trailing-"1" spelling is ever reached.
  assert.equal(library.bannerSearchTerms('Battlefield 1')[0], 'Battlefield 1');
});

test('a version number in a folder name is dropped rather than left to match nothing', () => {
  // The name as given is tried first and the punctuation-only spelling after it, both faithful to
  // what is on disk; the version is stripped only once those have missed, so a game whose title
  // really does carry digits (Aliens.Fireteam.Elite.2) is never robbed of them first.
  const terms = library.bannerSearchTerms('Some Game v1.2.3');
  assert.ok(terms.includes('Some Game'), `expected a clean "Some Game" in ${JSON.stringify(terms)}`);
  assert.ok(terms.indexOf('Some Game') > terms.indexOf('Some Game v1.2.3'));
  assert.ok(library.bannerSearchTerms('Aliens.Fireteam.Elite.2').includes('Aliens Fireteam Elite 2'));
});

test('a curly apostrophe is the same name as a straight one', () => {
  // A store title carries "Director’s Cut" and a folder carries "Director's Cut"; after the
  // punctuation pass it is "Director S Cut". All three have to tokenise alike, or the same game
  // scores as three different ones.
  const want = ['ghost', 'of', 'tsushima'];
  assert.deepEqual(library.titleTokens("Ghost of Tsushima DIRECTOR'S CUT"), want);
  assert.deepEqual(library.titleTokens('Ghost of Tsushima DIRECTOR’S CUT'), want);
  assert.deepEqual(library.titleTokens('Ghost of Tsushima DIRECTOR S CUT'), want);
  assert.equal(
    pick("Ghost of Tsushima Director's Cut", 'Ghost of Tsushima DIRECTOR’S CUT'),
    'Ghost of Tsushima DIRECTOR’S CUT'
  );
});

test('a dotted acronym is the same name on both sides of the comparison', () => {
  // The term ladder collapses "S.T.A.L.K.E.R." to "STALKER" so the store can find the game -- but
  // the store answers with its own dotted spelling, and titleTokens was breaking that into seven
  // single letters. Every identity word of the query then looked absent and the right game was
  // refused, leaving the card with no art at all (found 2026-09-20).
  assert.deepEqual(library.titleTokens('S.T.A.L.K.E.R.: Shadow of Chernobyl'), ['stalker', 'shadow', 'of', 'chernobyl']);
  assert.equal(
    pick('STALKER Shadow of Chernobyl', 'S.T.A.L.K.E.R.: Shadow of Chernobyl'),
    'S.T.A.L.K.E.R.: Shadow of Chernobyl'
  );
  // And the sequel is still told apart from the first game, dots or no dots.
  assert.equal(
    pick('STALKER 2 Heart of Chornobyl', 'S.T.A.L.K.E.R.: Shadow of Chernobyl', 'S.T.A.L.K.E.R. 2: Heart of Chornobyl'),
    'S.T.A.L.K.E.R. 2: Heart of Chornobyl'
  );
});

test('nothing to choose from is answered, not thrown', () => {
  // pickBannerMatch is exported; a caller handing it an empty or absent result must get "no
  // match" rather than an exception that takes the whole render down.
  assert.equal(library.pickBannerMatch('anything', null), null);
  assert.equal(library.pickBannerMatch('anything', undefined), null);
  assert.equal(library.pickBannerMatch('anything', []), null);
  assert.equal(library.pickBannerMatch('anything', [{ name: null }]), null);
});
