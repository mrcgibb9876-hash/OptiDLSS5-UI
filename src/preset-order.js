// What order ReShade runs its techniques in, and why this app decides it rather than leaving it
// to whatever order things happened to be added.
//
// ReShade runs the techniques in TechniqueSorting top to bottom, each one reading the back buffer
// the one before it wrote. So the order is not cosmetic: it is the pipeline. Get it wrong and
// nothing errors -- every shader compiles, every technique runs, and the picture is quietly wrong.
// That is the failure this file exists to stop, and the project has already met it twice:
//
//   - A motion-vector shader that runs AFTER DLSS5_Feed feeds it last frame's vectors, so the
//     reconstruction smears (Bodycam, 2026-09-09: only DLSS5_Feed had ever been written into the
//     list, and the motion-vector technique was absent until ReShade itself corrected it at
//     runtime -- after the first launch had already looked broken).
//   - An inverse tonemapper that runs after the HDR output converter converts an image that has
//     already left SDR, which clips the highlights it was added to recover.
//
// feeder.js used to hold this as a two-element array ([mvTechnique, feedTechnique]). That was
// right for the two techniques it knew about and had nowhere to put a third, so every add-on this
// app learns to install would have appended to the end -- which is the wrong place for most of
// them. The rule is a rank table now: each band says what it must be able to see, and everything
// in a band keeps the relative order it already had.
//
// BANDS, in run order:
//
//   MV_PROVIDER     Motion vectors. Must be first: it writes the vector texture that DLSS5_Feed
//                   reads, and it wants the frame before anything else has drawn over it.
//   FEED            DLSS5_Feed. The Feeder's hand-off to DLSS. After its vectors, before the
//                   picture is altered -- the model should denoise the game, not the grade.
//   EFFECT          Everything else, including every technique this app did not put there. The
//                   user's own effects live here and are never reordered among themselves.
//   INVERSE_TONEMAP SDR -> HDR expansion (Lilium's inverse tonemappers). After the SDR effects
//                   it is expanding, before anything that assumes an HDR signal.
//   HDR_OUTPUT      The final scRGB / HDR10 converter. Last by definition: it is what hands the
//                   frame to the display, and a technique after it is operating on an encoded
//                   signal rather than on light.
//
// A technique this app does not know lands in EFFECT, which is the safe band: it keeps its place
// relative to the user's other effects, and the ranked ones move around it.
'use strict';

const { setIniKey, getIniKey } = require('./ini-merge');

const BAND = {
  MV_PROVIDER: 10,
  FEED: 20,
  EFFECT: 50,
  INVERSE_TONEMAP: 70,
  HDR_OUTPUT: 90,
};

// The default band for anything unrecognised. Named rather than inlined because "unknown goes in
// the middle, not at the end" is the decision, and it should be findable.
const DEFAULT_BAND = BAND.EFFECT;

// `Name@File.fx`, as ReShade writes it. Compared lower-case throughout: ReShade preserves the
// case the effect declared, and a preset written by hand (or by another tool) may not match.
function techniqueKey(name, file) {
  return `${name}@${file}`;
}

// Parse the comma-separated list ReShade keeps in Techniques / TechniqueSorting. Empty entries are
// dropped; everything else is kept verbatim, because the string is what goes back out.
function parseList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Order a technique list by band, keeping the order within each band.
//
// `ranks` is a Map of lower-cased `Name@File.fx` -> band. Anything absent gets DEFAULT_BAND.
// Array.prototype.sort is stable in Node, so equal ranks keep their input order -- that is what
// keeps a user's own effect list intact while the ranked techniques move around it.
function sortTechniques(list, ranks) {
  const rankOf = (t) => {
    const hit = ranks.get(String(t).toLowerCase());
    return hit === undefined ? DEFAULT_BAND : hit;
  };
  return [...list].sort((a, b) => rankOf(a) - rankOf(b));
}

// Apply an ordering to both keys ReShade reads, adding what must be there and removing what must
// not.
//
//   present  techniques that must appear (added at the end before sorting if missing)
//   absent   techniques that must not appear at all (a provider being replaced, an add-on removed)
//   ranks    Map of lower-cased key -> band
//
// Techniques and TechniqueSorting are treated the same way. They are not the same list in
// ReShade -- Techniques is what is switched on, TechniqueSorting is the order they are shown and
// run in -- but a technique this app installs should be both enabled and correctly placed, and a
// technique it removes should be gone from both. Writing the same membership to each is the
// honest reading of that, and it is what the Feeder deploy already did for its own two.
function applyOrder(text, { present = [], absent = [], ranks = new Map() } = {}) {
  const gone = new Set(absent.map((t) => String(t).toLowerCase()));
  let next = text;
  for (const key of ['Techniques', 'TechniqueSorting']) {
    let list = parseList(getIniKey(next, '', key)).filter((t) => !gone.has(t.toLowerCase()));
    const have = new Set(list.map((t) => t.toLowerCase()));
    for (const t of present) {
      if (!have.has(String(t).toLowerCase())) {
        list.push(t);
        have.add(String(t).toLowerCase());
      }
    }
    next = setIniKey(next, '', key, sortTechniques(list, ranks).join(','));
  }
  return next;
}

module.exports = { BAND, DEFAULT_BAND, techniqueKey, parseList, sortTechniques, applyOrder };
