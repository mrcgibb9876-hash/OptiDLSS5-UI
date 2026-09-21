'use strict';
// Remove has to survive a file it cannot delete. Reported on GTA San Andreas (#96), in a game
// installed under C:\Program Files (x86)\:
//
//     Couldn't remove OptiScaler: EPERM: operation not permitted, unlink '...'
//
// uninstallEverything() strips a folder in about a dozen stages, and every deletion in it went
// through a bare `fsp.rm`. The first EPERM threw straight out of the function, so the removal
// stopped where it stood: the stages after it never ran, the user got the raw errno, and the folder
// was left half-stripped -- a proxy DLL still loading a payload that was partly gone.
//
// These cover the helper that now absorbs it (src/saferemove.js) and hold the call sites to using it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const saferemove = require('../src/saferemove');

// Read with the line endings normalised. CI checks out on Windows with autocrlf, so every source
// file there has CRLF, and a scan for '\n}\n' finds nothing -- which does not fail loudly, it just
// makes "the function body" mean the whole rest of the file. That is how the first version of these
// guards passed on Linux and reported nine unrelated fsp.rm calls on windows-latest.
const readSrc = (...rel) => fs.readFileSync(path.join(__dirname, '..', 'src', ...rel), 'utf8').replace(/\r\n/g, '\n');
const mainJs = readSrc('main.js');
const rendererJs = readSrc('renderer', 'renderer.js');
const translationJs = readSrc('translation.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5ui-remove-'));
}

// A stand-in for fs/promises that fails the first rm with `code` and then behaves. Enough of the
// surface for removePath: rm, lstat, readdir, chmod.
function fakeFs({ code = 'EPERM', failures = 1, tree = { kind: 'file' } } = {}) {
  const calls = { rm: 0, chmod: [], readdir: 0 };
  return {
    calls,
    async rm() {
      calls.rm += 1;
      if (calls.rm <= failures) { const e = new Error(`${code}: operation not permitted, unlink`); e.code = code; throw e; }
    },
    async lstat(p) {
      const isDir = tree.kind === 'dir' && !String(p).includes('.');
      return { isDirectory: () => isDir };
    },
    async readdir() { calls.readdir += 1; return tree.kind === 'dir' ? tree.names || [] : []; },
    async chmod(p, mode) { calls.chmod.push([String(p), mode]); },
  };
}

// ── the helper ───────────────────────────────────────────────────────────────────────────────

test('a read-only file is deleted: the attribute is cleared and the delete retried', async () => {
  const fsx = fakeFs({ code: 'EPERM', failures: 1 });
  const r = await saferemove.removePath('/games/x/OptiScaler.dll', { fs: fsx });
  assert.deepStrictEqual({ ok: r.ok, cleared: r.clearedReadOnly }, { ok: true, cleared: true });
  assert.strictEqual(fsx.calls.rm, 2, 'tried again after clearing');
  assert.deepStrictEqual(fsx.calls.chmod, [['/games/x/OptiScaler.dll', saferemove.FILE_MODE]]);
});

test('a file that stays undeletable is reported, not thrown', async () => {
  const fsx = fakeFs({ code: 'EPERM', failures: 99 });
  const r = await saferemove.removePath('/games/x/dxgi.dll', { fs: fsx });
  assert.deepStrictEqual(r, { ok: false, code: 'EPERM' });
});

test('the codes Windows produces for a locked, read-only or protected file are all absorbed', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']) {
    const r = await saferemove.removePath('/games/x/f.dll', { fs: fakeFs({ code, failures: 99 }) });
    assert.deepStrictEqual(r, { ok: false, code }, code);
  }
});

test('an error class this app has not thought about still throws -- it is not quietly collected', async () => {
  const fsx = fakeFs({ code: 'EIO', failures: 1 });
  await assert.rejects(() => saferemove.removePath('/games/x/f.dll', { fs: fsx }), /EIO/);
  assert.strictEqual(fsx.calls.rm, 1, 'no retry for an error the helper does not understand');
});

test('a directory keeps its execute bit when the read-only attribute is cleared', async () => {
  // 0o666 on a folder makes it untraversable, so the retry would fail on the walk rather than on
  // the file it is there to delete.
  const fsx = fakeFs({ code: 'EPERM', failures: 1, tree: { kind: 'dir', names: ['host64.dll'] } });
  await saferemove.removePath('/games/x/host64', { fs: fsx });
  const modes = Object.fromEntries(fsx.calls.chmod.map(([p, m]) => [path.basename(p), m]));
  assert.strictEqual(modes['host64'], saferemove.DIR_MODE, 'the folder stays traversable');
  assert.strictEqual(modes['host64.dll'], saferemove.FILE_MODE, 'and its contents lose read-only too');
});

test('a path that is already gone is a success, not a failure', async () => {
  const dir = tmpDir();
  const r = await saferemove.removePath(path.join(dir, 'never-existed.dll'));
  assert.deepStrictEqual(r, { ok: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

// On Windows this is the reported bug end to end: a read-only file answers unlink() with EPERM, so
// it passes only because removePath clears the attribute. On Linux the delete succeeds first try
// (unlink obeys the parent directory, not the file's own mode), which makes this a happy-path check
// there -- either way the file has to be gone.
test('a genuinely read-only file on disk is removed', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'OptiScaler.ini');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o444);
    const r = await saferemove.removePath(file);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.existsSync(file), false, 'the read-only file is gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the call sites ───────────────────────────────────────────────────────────────────────────

// Both ends are asserted. A -1 from either indexOf would otherwise slice to the end of the file and
// quietly turn every guard below into a scan of all of main.js.
function bodyIn(src, opener, what) {
  const start = src.indexOf(opener);
  assert.notStrictEqual(start, -1, `${what}: could not find ${opener}`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `${what}: could not find the end of the function`);
  return src.slice(start, end);
}

function bodyOf(name) {
  return bodyIn(mainJs, `async function ${name}(dir) {`, name);
}

test('the removal functions never delete with a bare fsp.rm -- every deletion can be survived', () => {
  for (const name of ['uninstallEverything', 'uninstallOptiScaler', 'removeSharedNrDllIfUnneeded']) {
    const body = bodyOf(name);
    const bare = body.match(/await fsp\.rm\(/g) || [];
    assert.deepStrictEqual(bare, [], `${name} still deletes with a bare fsp.rm, so one EPERM abandons the rest`);
    assert.match(body, /saferemove\.removePath\(/, `${name} should delete through saferemove`);
  }
});

test('what could not be deleted comes back to the caller, and is not also reported as removed', () => {
  const body = bodyOf('uninstallEverything');
  assert.match(body, /const failed = \[\]/, 'uninstallEverything collects failures');
  assert.match(body, /return \{ removed: .*failed \}/s, 'and returns them');
  // A file that is still there must not appear under "Removed:" -- the install marker can be one of
  // them, in which case the folder is still partly ours and the next Remove has to find it again.
  assert.match(body, /failedRels/, 'removed is filtered by what failed');
});

test('a stage that throws costs that stage, not the whole removal', () => {
  const body = bodyOf('uninstallEverything');
  // Each of these deletes a different stack, so the ones after it are still worth running. The
  // Feeder stage matters most here: #96 is a feeder32 route, where dgVoodoo2 and host64\ go first.
  for (const call of ['feeder.removeFeederStack', 'legacy.removeLegacy', 'lumaue.removeLumaStack', 'nrmodelonly.removeNrModelOnly']) {
    const at = body.indexOf(call);
    assert.notStrictEqual(at, -1, `${call} not found`);
    const line = body.slice(body.lastIndexOf('\n', at) + 1, body.indexOf('\n', at));
    assert.match(line, /stage\(/, `${call} runs unguarded: a throw there skips every stage after it`);
  }
});

test('a backup is never consumed when the file it would replace is still there', () => {
  // Deleting ours and renaming the .orig over it is two steps; if the delete fails and the rename
  // runs anyway, the original is gone for good. The backup has to stay a backup.
  const body = bodyOf('uninstallEverything');
  const fn = body.slice(body.indexOf('const restoreFromBackup'));
  const del = fn.indexOf('saferemove.removePath');
  const rename = fn.indexOf('fsp.rename');
  assert.ok(del !== -1 && rename !== -1 && del < rename, 'the delete is attempted before the rename');
  assert.match(fn.slice(del, rename), /if \(!r\.ok\)[\s\S]*return false/, 'a failed delete stops before the rename');
});

// ── the file that actually failed on #96 ─────────────────────────────────────────────────────

test('the translation manifest is deleted through saferemove, not a bare rm that throws', () => {
  // .dlss5ui-translation.json is the file #96 named, and its deletion was the ONE unguarded rm in
  // purgeTranslationLayer -- every other one in there already caught. It threw out of the purge and
  // out of uninstallEverything, which runs the purge as its second stage, so the layer's DLLs were
  // gone and every later stage never ran.
  const body = bodyIn(translationJs, 'async function purgeTranslationLayer', 'purgeTranslationLayer');
  assert.doesNotMatch(body, /await fsp\.rm\(path\.join\(dir, MANIFEST\)/, 'the manifest delete can still throw the purge away');
  assert.match(body, /saferemove\.removePath\(/, 'deletions in the purge go through saferemove');
});

test('a wrapper DLL that will not delete is reported, not dropped from every list', () => {
  // The purge's rm() returned false on failure and the caller pushed the file to neither `removed`
  // nor `skipped` -- so a wrapper left behind was invisible to the user and to the app.
  const at = translationJs.indexOf('  const rm = async (rel) => {');
  assert.notStrictEqual(at, -1, 'the purge\x27s rm helper');
  const end = translationJs.indexOf('  };', at);
  assert.notStrictEqual(end, -1, 'the end of the rm helper');
  const body = translationJs.slice(at, end);
  assert.match(body, /failed\.push/, 'a failure is recorded');
  assert.match(body, /skipped\.push/, 'and shows up in the list the caller already reads');
});

test('a manifest that was never on disk is not reported as removed', () => {
  // A legacy dgVoodoo2 deploy keeps its record in .dlss5ui-legacy.json and has no manifest of its
  // own, so rm() succeeds on a file that was never there. Claiming to have deleted it is how a
  // removal report stops being worth reading -- caught by dxvk-swap.test.js when this was written.
  const at = translationJs.indexOf('const wasThere = fs.existsSync(path.join(dir, MANIFEST))');
  assert.notStrictEqual(at, -1, 'the manifest removal checks the file was there first');
  assert.match(translationJs.slice(at, at + 200), /if \(gone && wasThere\) removed\.push\(MANIFEST\)/);
});

test('an undeletable manifest reaches the user: the app would otherwise still think the layer is in', () => {
  // The manifest surviving is not cosmetic. translation.js's own note: left in, the marker "would go
  // on saying dgVoodoo2 is deployed after its files were gone, and Install would put it straight
  // back over whatever replaced it."
  const body = bodyOf('uninstallEverything');
  const at = body.indexOf('purgeTranslationLayer');
  assert.notStrictEqual(at, -1);
  assert.match(body.slice(at, at + 600), /for \(const f of r\.failed \|\| \[\]\) failed\.push/, 'the purge\x27s failures join the removal\x27s');
});

test('the user is told which files are still there, and that closing the game is what fixes it', () => {
  const body = bodyIn(rendererJs, 'function describeUninstall', 'describeUninstall');
  assert.match(body, /res\.failed/, 'describeUninstall reads the failures');
  assert.match(body, /DLSS 5 partly removed\./, 'and does not claim a clean removal');
  assert.match(body, /Close the game/, 'and names the one thing the user can do about it');
});
