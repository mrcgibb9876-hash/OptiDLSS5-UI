'use strict';
// Frame pacing and RenoDX both ride on a ReShade in the game folder (main.js ensureReShadeAddonHost).
// These go through main.js's own handlers and pin down who owns that ReShade, when it is placed, and
// when it is taken back:
//   - a ReShade the PLAYER put in a proxy slot is used where it is, or refused when it is the plain
//     build -- never claimed, replaced, or doubled (it used to be claimed, then deleted by Remove);
//   - the add-on is downloaded before the folder is touched, so a failed install leaves nothing;
//   - the unverified 'latest' fallback is never served from the cache;
//   - Remove is refused while the game runs, takes back the ReShade pacing placed, and puts
//     [Plugins] LoadReshade back to auto;
//   - two changes to one folder queue rather than race.
// ORDER MATTERS in this file: ghapi.js remembers GitHub API answers for 20 minutes in-process, so the
// tests that need GitHub to fail or refuse run before the first one that lets it answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { scratchDir, fakeExe, loadMain, listing, REPO } = require('./helpers');
const relimiter = require(path.join(REPO, 'src', 'relimiter'));
const addons = require(path.join(REPO, 'src', 'addons'));
const integrity = require(path.join(REPO, 'src', 'integrity'));

const NOTEPAD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
const onWindows = process.platform === 'win32' && fs.existsSync(NOTEPAD);

// ReShade as isReShadeProxy sees it: a real PE whose version resource says RESHADE.DLL. The Add-on
// build is told apart by its ReShadeRegisterAddon export (feeder.isAddonReShadeDll).
function realishReShade(dir, name, { addonBuild = true } = {}) {
  const buf = fs.readFileSync(NOTEPAD);
  const at = buf.indexOf(Buffer.from('NOTEPAD.EXE', 'utf16le'));
  Buffer.from('RESHADE.DLL', 'utf16le').copy(buf, at);
  const pad = Buffer.alloc(2 * 1024 * 1024, 0);
  pad.write(addonBuild ? 'ReShade ReShadeRegisterAddon' : 'ReShade plain', 64, 'latin1');
  fs.writeFileSync(path.join(dir, name), Buffer.concat([buf, pad]));
}

function addonBytes(tag = 'v1') {
  const buf = Buffer.alloc(200 * 1024, 7);
  buf.write('MZ', 0, 'latin1');
  buf.write('ReLimiter', 1024, 'latin1');
  buf.write('AddonInit', 4096, 'latin1');
  buf.write(`build ${tag}`, 8192, 'latin1');
  return buf;
}

function gameWith(tag) {
  const game = path.join(scratchDir(tag), 'game');
  const exe = fakeExe(game, 'Game.exe');
  return { game, exe };
}

const realFetch = global.fetch;
function stubFetch(fn) { global.fetch = fn; }
test.after(() => { global.fetch = realFetch; });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// A ReShade setup already in the app's cache (where ensureReShadeSetup looks first), so ReShade itself
// can be placed with no network: the setup is a zip, and deployReShade takes ReShade64.dll out of it.
function cacheReShadeSetup(userData) {
  const src = scratchDir('host-reshade-setup');
  realishReShade(src, 'ReShade64.dll');
  // Incompressible, so the setup clears cachedReShadeSetup's 1 MB floor once zipped.
  fs.appendFileSync(path.join(src, 'ReShade64.dll'), require('node:crypto').randomBytes(1536 * 1024));
  const cacheDir = path.join(userData, 'feeder-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(src, 'setup.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path $env:SRC -DestinationPath $env:DEST -Force'],
  { env: { ...process.env, SRC: path.join(src, 'ReShade64.dll'), DEST: zip } });
  fs.copyFileSync(zip, path.join(cacheDir, 'ReShade_Setup_user.exe'));
}

// ── GitHub unreachable: nothing is placed ──────────────────────────────────────────────────────────

// ReShade used to go in FIRST: with its setup cached and GitHub down, the folder was left with ReShade
// as the game's dxgi.dll and no pacing on it.
test('a pacing install that cannot fetch the add-on leaves the folder exactly as it was', { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-offline');
  const before = listing(game);
  stubFetch(async () => { throw new TypeError('fetch failed'); });
  const { invoke, userData } = loadMain();
  cacheReShadeSetup(userData);
  const r = await invoke('relimiter:install', exe);
  assert.equal(r.ok, false);
  assert.deepEqual(listing(game), before, 'no ReShade hooking the game for nothing');
});

// ── the unverified fallback ───────────────────────────────────────────────────────────────────────

test('the unverified latest-download fallback is fetched fresh every time, never reused from the cache', { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-unverified');
  realishReShade(game, 'dxgi.dll');
  let build = 'first';
  stubFetch(async (url) => {
    // A refusal that is not the hourly limit (calls left), so ghapi.js passes it through and
    // relimiter.resolveAddonAsset falls back to the plain /releases/latest/download link.
    if (url.startsWith('https://api.github.com/')) return json({ message: 'nope' }, 403, { 'x-ratelimit-remaining': '42' });
    if (url.includes('/releases/latest/download/relimiter.addon64')) return new Response(addonBytes(build));
    throw new Error('unexpected ' + url);
  });
  const { invoke } = loadMain();
  const a = await invoke('relimiter:install', exe);
  assert.equal(a.ok, true, a.error);
  assert.match(fs.readFileSync(path.join(game, 'relimiter.addon64'), 'latin1'), /build first/);
  build = 'second';
  const b = await invoke('relimiter:install', exe);
  assert.equal(b.ok, true, b.error);
  assert.match(fs.readFileSync(path.join(game, 'relimiter.addon64'), 'latin1'), /build second/, 'not the first download, frozen in the cache');
});

// ── from here on GitHub answers ───────────────────────────────────────────────────────────────────

const RELEASE_ASSET = 'https://github.com/mrcgibb9876-hash/ReLimiter/releases/download/v9.9.9/relimiter.addon64';
function githubAnswers({ gate = null } = {}) {
  const bytes = addonBytes('v9.9.9');
  stubFetch(async (url) => {
    if (url === 'https://api.github.com/repos/mrcgibb9876-hash/ReLimiter/releases/latest') {
      return json({ tag_name: 'v9.9.9', assets: [{ name: 'relimiter.addon64', browser_download_url: RELEASE_ASSET, digest: `sha256:${integrity.sha256(bytes)}` }] });
    }
    if (url === RELEASE_ASSET) { if (gate) await gate; return new Response(bytes); }
    throw new Error('unexpected ' + url);
  });
}

test('with no ReShade at all, pacing places one as the proxy, records it as ours, and Remove takes it back', { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-ours');
  const before = listing(game);
  githubAnswers();
  const { invoke } = loadMain();
  const r = await invoke('relimiter:install', exe);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.standalone, true);
  assert.equal(relimiter.isReShadeProxy(path.join(game, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), false);
  assert.equal(relimiter.ownsReShade(game), true, 'placed by this call, so ours');
  const rm = await invoke('relimiter:remove', exe);
  assert.equal(rm.ok, true, rm.error);
  assert.deepEqual(listing(game), before);
});

test("the player's own plain ReShade in a proxy slot is refused, and nothing is touched", { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-foreign-plain');
  realishReShade(game, 'dxgi.dll', { addonBuild: false });
  const before = listing(game);
  githubAnswers();
  const { invoke } = loadMain();
  const r = await invoke('relimiter:install', exe);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'foreign-plain-reshade');
  assert.deepEqual(listing(game), before);
});

test("the player's own Add-on ReShade as dxgi.dll is used where it is, and Remove leaves it", { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-foreign-addon');
  realishReShade(game, 'dxgi.dll');
  const theirs = fs.readFileSync(path.join(game, 'dxgi.dll'));
  githubAnswers();
  const { invoke } = loadMain();
  const r = await invoke('relimiter:install', exe);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.standalone, false, 'no proxy of ours');
  assert.equal(fs.existsSync(path.join(game, 'relimiter.addon64')), true);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), false, 'no second ReShade');
  assert.ok(fs.readFileSync(path.join(game, 'dxgi.dll')).equals(theirs), 'theirs, untouched');
  const m = relimiter.marker(game);
  assert.ok(!m.reshadePlaced && !m.reshadeProxy, 'nothing recorded as ours');
  assert.equal(relimiter.ownsReShade(game), false);
  assert.equal(relimiter.status(game, { api: 'dx12' }).complete, true, 'status judges the ReShade that loads it');

  const rm = await invoke('relimiter:remove', exe);
  assert.equal(rm.ok, true, rm.error);
  assert.ok(fs.readFileSync(path.join(game, 'dxgi.dll')).equals(theirs), 'Remove never took the player\'s ReShade');
  assert.equal(fs.existsSync(path.join(game, 'relimiter.addon64')), false);
});

test("the player's ReShade as d3d11.dll does not get a second ReShade as dxgi.dll", { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-foreign-d3d11');
  realishReShade(game, 'd3d11.dll');
  githubAnswers();
  const { invoke } = loadMain();
  const r = await invoke('relimiter:install', exe);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(path.join(game, 'dxgi.dll')), false);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), false);
});

// Without the queue, Remove (pressed while Install is still working) ran first on a folder with
// nothing in it, then Install placed pacing -- the opposite of the order they were pressed in.
test('two changes to one game folder run one after the other, in the order pressed', { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-queue');
  realishReShade(game, 'dxgi.dll');
  let release;
  githubAnswers({ gate: new Promise((r) => { release = r; }) });
  const { invoke } = loadMain();
  const install = invoke('relimiter:install', exe);
  const remove = invoke('relimiter:remove', exe);
  let removeDone = false;
  remove.then(() => { removeDone = true; });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(removeDone, false, 'Remove waits for the Install ahead of it');
  release();
  assert.equal((await install).ok, true);
  assert.equal((await remove).ok, true);
  assert.equal(fs.existsSync(path.join(game, 'relimiter.addon64')), false, 'Remove saw what Install placed');
});

// ── Remove ─────────────────────────────────────────────────────────────────────────────────────────

// The ReShade64.dll pacing placed beside OptiScaler, and the LoadReshade=true that loads it.
function pacingBesideOptiScaler(tag) {
  const { game, exe } = gameWith(tag);
  fs.writeFileSync(path.join(game, 'OptiScaler.ini'), '[Plugins]\nLoadReshade=true\n');
  realishReShade(game, 'ReShade64.dll');
  fs.writeFileSync(path.join(game, 'ReShade.ini'), '[ADDON]\nAddonPath=.\\\n');
  relimiter.writeMarker(game, { reshadePlaced: true });
  const src = path.join(scratchDir(tag + '-src'), 'relimiter.addon64');
  fs.writeFileSync(src, addonBytes());
  relimiter.deploy(game, src, { version: 'v1' });
  return { game, exe };
}

test('pacing\'s Remove takes back the ReShade it placed and puts LoadReshade back to auto', { skip: !onWindows }, async () => {
  const { game, exe } = pacingBesideOptiScaler('host-remove-ours');
  const { invoke } = loadMain();
  const r = await invoke('relimiter:remove', exe);
  assert.equal(r.ok, true, r.error);
  for (const f of ['ReShade64.dll', 'ReShade.ini', 'relimiter.addon64', relimiter.MARKER]) assert.equal(fs.existsSync(path.join(game, f)), false, f);
  assert.match(fs.readFileSync(path.join(game, 'OptiScaler.ini'), 'utf8'), /LoadReshade\s*=\s*auto/);
});

test('pacing\'s Remove keeps the ReShade, and the record that it is ours, while RenoDX uses it', { skip: !onWindows }, async () => {
  const { game, exe } = pacingBesideOptiScaler('host-remove-shared');
  fs.writeFileSync(path.join(game, 'renodx-game.addon64'), 'renodx');
  addons.writeMarker(game, { version: 1, installed: [{ id: 'renodx', kind: 'addon', files: ['renodx-game.addon64'] }] });
  const { invoke } = loadMain();
  const r = await invoke('relimiter:remove', exe);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), true);
  assert.equal(relimiter.ownsReShade(game), true, 'RenoDX\'s own Remove can still take it');
  assert.match(fs.readFileSync(path.join(game, 'OptiScaler.ini'), 'utf8'), /LoadReshade\s*=\s*true/);
});

test('Remove everything takes the ReShade64.dll pacing placed, and the plan says so first', { skip: !onWindows }, async () => {
  const { game, exe } = pacingBesideOptiScaler('host-uninstall');
  fs.rmSync(path.join(game, 'OptiScaler.ini'));
  const { invoke } = loadMain();
  const plan = await invoke('game:uninstallPlan', exe);
  assert.ok(plan.remove.includes('ReShade64.dll'), JSON.stringify(plan));
  assert.ok(!plan.kept.some((k) => /ReShade64/.test(k)), 'not listed as somebody else\'s');
  const un = await invoke('game:run-uninstall', exe);
  assert.equal(un.ok, true, un.error);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), false);
});

test('removing the Feeder keeps the ReShade frame pacing still runs on, and hands it to pacing', { skip: !onWindows }, async () => {
  const { game, exe } = gameWith('host-feeder-out');
  realishReShade(game, 'ReShade64.dll');
  fs.writeFileSync(path.join(game, 'dlss5-feed.addon64'), 'feeder');
  const src = path.join(scratchDir('host-feeder-out-src'), 'relimiter.addon64');
  fs.writeFileSync(src, addonBytes());
  relimiter.deploy(game, src, { version: 'v1' });
  assert.equal(relimiter.ownsReShade(game), false, 'the Feeder\'s, not pacing\'s');
  const { invoke } = loadMain();
  const r = await invoke('feeder:remove', exe);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(path.join(game, 'dlss5-feed.addon64')), false);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), true, 'pacing still loads through it');
  assert.equal(relimiter.ownsReShade(game), true, 'pacing\'s last Remove takes it now');
  const rm = await invoke('relimiter:remove', exe);
  assert.equal(rm.ok, true, rm.error);
  assert.equal(fs.existsSync(path.join(game, 'ReShade64.dll')), false);
});

// ── while the game runs ────────────────────────────────────────────────────────────────────────────

test('Remove is refused while the game is running, with nothing half-removed', { skip: !onWindows }, async (t) => {
  const { game } = gameWith('host-running');
  // A real process with the game's image name: node itself, copied to Game.exe, idling.
  const exe = path.join(game, 'Game.exe');
  fs.copyFileSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { child.kill(); } catch {} });
  for (let i = 0; i < 50; i++) {
    const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Game.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    if (/"game\.exe"/i.test(out)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const src = path.join(scratchDir('host-running-src'), 'relimiter.addon64');
  fs.writeFileSync(src, addonBytes());
  relimiter.deploy(game, src, { version: 'v1' });
  fs.writeFileSync(path.join(game, 'renodx-game.addon64'), 'renodx');
  addons.writeMarker(game, { version: 1, installed: [{ id: 'renodx', kind: 'addon', files: ['renodx-game.addon64'] }] });

  const { invoke } = loadMain();
  const a = await invoke('addons:remove', { exePath: exe, id: 'renodx' });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'game-running');
  assert.equal(fs.existsSync(path.join(game, 'renodx-game.addon64')), true);
  assert.deepEqual(addons.installedIds(game), ['renodx'], 'still recorded');
  const p = await invoke('relimiter:remove', exe);
  assert.equal(p.ok, false);
  assert.equal(p.code, 'game-running');
  assert.equal(relimiter.deployed(game), true);
  assert.ok(relimiter.marker(game), 'marker kept');
});
