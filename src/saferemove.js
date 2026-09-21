'use strict';
// Deleting a file can fail, and on Windows it fails in ways that have nothing to do with the file
// being important. Reported on GTA San Andreas (#96):
//
//     Couldn't remove OptiScaler: EPERM: operation not permitted, unlink
//     'C:\Program Files (x86)\Grand Theft Auto San Andreas\...'
//
// Three causes produce exactly that, and this app hits all three:
//
//   - the file carries the read-only attribute. Node's `rm(..., { force: true })` does NOT clear it
//     -- `force` only suppresses ENOENT -- and Windows answers unlink() on a read-only file with
//     EPERM. This is the one cause the app can fix by itself, so it does: clear the bit and retry.
//   - the DLL is still mapped into a process that has not exited (the game, or the Feeder's 64-bit
//     helper in host64\). Nothing to do but say so and name the file.
//   - the folder is one the user cannot delete from. Same: say so.
//
// What matters at the call site is that ONE such file must never abandon the rest of a removal.
// uninstallEverything() strips a folder in about a dozen stages; before this, the first EPERM threw
// straight out of it, so the folder was left half-stripped -- a proxy DLL still in place with the
// payload it loads half gone, which is a worse state than either finishing or never starting, and
// the user was told only the raw Node error.
//
// So: removePath never throws for these codes. It reports, and the caller carries on and collects.

const fspDefault = require('node:fs/promises');
const path = require('node:path');

// EPERM and EACCES are the two Windows produces for the causes above; EBUSY is what a file held
// open with no share-delete gives. ENOTEMPTY appears when something re-creates a file inside a
// folder while it is being walked.
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

// chmod is how Node spells the Windows read-only attribute: clearing the write bits sets it, adding
// them clears it. A directory needs its execute bit to stay traversable, so it cannot take 0o666.
const FILE_MODE = 0o666;
const DIR_MODE = 0o777;

// Depth-limited so a junction loop (or a game folder someone has nested absurdly) cannot spin here.
const MAX_DEPTH = 24;

async function clearReadOnly(target, fsp, depth = 0) {
  let st;
  try {
    st = await fsp.lstat(target);
  } catch {
    return; // gone, or unreadable: the retry will say which
  }
  if (st.isDirectory() && depth < MAX_DEPTH) {
    let names = [];
    try { names = await fsp.readdir(target); } catch { names = []; }
    for (const name of names) await clearReadOnly(path.join(target, name), fsp, depth + 1);
  }
  try { await fsp.chmod(target, st.isDirectory() ? DIR_MODE : FILE_MODE); } catch { /* the retry reports it */ }
}

// Removes a file or folder. Returns { ok: true } when it is gone (including when it was never
// there), or { ok: false, code } when it could not be deleted for one of the reasons above.
//
// Anything else -- an unexpected error class -- still throws, because a removal failing for a reason
// this app has not thought about should be loud rather than quietly collected.
async function removePath(target, opts = {}) {
  const fsp = opts.fs || fspDefault;
  try {
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    if (!RETRYABLE.has(err && err.code)) throw err;
    await clearReadOnly(target, fsp);
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return { ok: true, clearedReadOnly: true };
    } catch (again) {
      const code = (again && again.code) || err.code;
      if (!RETRYABLE.has(code)) throw again;
      return { ok: false, code };
    }
  }
}

// The sentence the user gets. Deliberately names the files: "some files could not be deleted" sends
// someone hunting through a game folder they did not fill.
function describeFailures(failed) {
  if (!failed || !failed.length) return '';
  return failed.map((f) => (f.code ? `${f.rel} (${f.code})` : f.rel)).join(', ');
}

module.exports = { removePath, clearReadOnly, describeFailures, RETRYABLE, FILE_MODE, DIR_MODE };
