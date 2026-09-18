'use strict';
// Which translation layer a game's Install uses, when nobody has picked one: the standard one
// (dgVoodoo2 on DirectX 8/9, the game's own Direct3D on a 32-bit DirectX 10/11 game) unless the
// known-good catalog PROVES another layer for this exact game (catalog.js provenLayer). Never across
// the board: DXVK on a 32-bit game needs ReShade's machine-wide Vulkan layer and an administrator
// prompt, shook Assassin's Creed II (DXVK #2249), and no 32-bit DirectX 10/11 game had run on it when
// this was written (2026-09-19) -- so it becomes a game's default only once that game has run on it.
//
// Order, first that applies:
//   1. a layer picked by hand (card menu, Edit, Game Help: translation.js readPreference), including
//      the standard one picked back after a proven default -- that is why the swap-backs record it;
//   2. whatever is already installed (DXVK or dgVoodoo2 in the folder, or the 32-bit helper on the
//      game's own Direct3D) -- a proven default never swaps an installed game;
//   3. the catalog's proven layer for this route, unless DXVK is blocked or that layer is a dead end;
//   4. the standard layer.
//
// route.js and main.js both ask here, so the card, Edit and Install cannot disagree about it.

const catalog = require('./catalog');

// The route's standard layer for this legacy plan, or null when the route has no layer choice.
function standardLayer(route, plan) {
  if (!plan || !plan.supported) return null;
  if (plan.dgVoodoo) return 'dgvoodoo';
  if (route === 'feeder32' && (plan.api === 'dx10' || plan.api === 'dx11')) return 'native';
  return null;
}

// facts: { route ('feeder32' | 'feeder'), plan (legacy.planFor), handPick (readPreference),
//          installed ('dxvk' | 'dgvoodoo' | 'native' | null), dxvkBlocked, entry (catalog.lookup) }
// -> { layer, standard, from: 'hand' | 'installed' | 'proven' | 'standard', proven: {via, source} | null }
//    or null when the route has no layer choice.
function resolve({ route, plan, handPick = null, installed = null, dxvkBlocked = false, entry = null } = {}) {
  const standard = standardLayer(route, plan);
  if (!standard) return null;
  const allowed = new Set([standard, ...(dxvkBlocked ? [] : ['dxvk'])]);
  const proven = catalog.provenLayer(entry, { route, dxvkBlocked: !!dxvkBlocked });
  const provenHere = proven && allowed.has(proven.via) ? proven : null;
  if (handPick && allowed.has(handPick)) return { layer: handPick, standard, from: 'hand', proven: provenHere };
  if (installed) return { layer: installed, standard, from: 'installed', proven: provenHere };
  if (provenHere) return { layer: provenHere.via, standard, from: 'proven', proven: provenHere };
  return { layer: standard, standard, from: 'standard', proven: null };
}

module.exports = { standardLayer, resolve };
