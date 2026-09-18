'use strict';
// Result text for Game Help's fixes that main.js runs (applyHelpFix), kept out of main.js so it can
// be tested without Electron.

const errText = (error) => (error && error.message ? error.message : String(error));

// 'reconfigure': the proxy move (migrateProxyIfNeeded) and the ini keys autoConfigureGame set.
//
// migrateError is a throw from the move -- a proxy DLL the running game holds open, say. It used to
// be swallowed, and with no ini change either the result read "nothing needed changing": the one
// answer that sends the user away from the problem Game Help had just named (review of 2026-09-18).
// So it is said, and the fix is reported as not done, since the move was the point of it.
function reconfigureSummary({ migration = null, migrateError = null, applied = [], reframeworkPlaced = false } = {}) {
  let moved = '';
  if (migrateError) moved = `could not move OptiScaler to the name this game loads: ${errText(migrateError)}`;
  else if (migration && !migration.skipped) moved = `moved OptiScaler from ${migration.from} to ${migration.to}`;
  else if (migration && migration.skipped) moved = `could not move OptiScaler from ${migration.from} to ${migration.to}: ${migration.skipped}`;
  const changed = (applied || []).map((e) => `${e.section}.${e.key}=${e.value}`);
  const refw = reframeworkPlaced ? ', REFramework placed' : '';
  const parts = [moved, changed.length ? `set ${changed.join(', ')}` : ''].filter(Boolean);
  return {
    done: !migrateError,
    text: parts.length ? `${parts.join('; ')}${refw}` : `nothing needed changing${refw}`,
  };
}

module.exports = { reconfigureSummary };
