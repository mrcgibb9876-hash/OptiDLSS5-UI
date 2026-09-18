'use strict';
// Photographs the REAL renderer -- src/renderer/index.html, renderer.js, style.css -- in Chromium
// with window.api stubbed, so what lands in the README is the app's own markup and stylesheet
// rather than a drawing of one. The app proper cannot run here (its detection reads PE headers off
// real Windows game folders), so the stub answers what main.js would have.

const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = '/home/user/OptiDLSS5-UI/src/renderer';
const OUT = __dirname;

// Six games, one per card state the grid can show. The numbers are plausible rather than measured:
// these illustrate the layout, and every one of them is a state refreshCardState really produces.
const G = {
  cp:   'C:\\Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe',
  wf:   'C:\\Games\\Witchfire\\Witchfire\\Binaries\\Win64\\Witchfire-Win64-Shipping.exe',
  swtor:'C:\\Games\\SWTOR\\swtor.exe',
  ai:   'C:\\Games\\Alien Isolation\\AI.exe',
  rdr:  'C:\\Games\\Red Dead Redemption 2\\RDR2.exe',
  dol:  'D:\\Emulators\\Dolphin\\Dolphin.exe',
};

const GAMES = [
  { name: 'Cyberpunk 2077', exePath: G.cp,
    detectedPath: { engine: 'REDengine', apiBadge: 'DX12', recommend: 'optiscaler', reason: 'DX12 game, OptiScaler installs beside the exe' } },
  { name: 'Witchfire', exePath: G.wf,
    detectedPath: { engine: 'Unreal Engine', apiBadge: 'DX11', recommend: 'optiscaler', reason: 'Unreal, DX11 -- needs the Feeder for DLSS 5' } },
  { name: 'Star Wars: The Old Republic', exePath: G.swtor,
    detectedPath: { engine: 'HeroEngine', apiBadge: 'DX9', recommend: 'optiscaler', reason: 'DX9 through a wrapper' } },
  { name: 'Alien: Isolation', exePath: G.ai,
    detectedPath: { engine: 'CATHODE', apiBadge: 'DX11', recommend: 'optiscaler', reason: '32-bit DX11' } },
  { name: 'Red Dead Redemption 2', exePath: G.rdr,
    detectedPath: { engine: 'RAGE', apiBadge: 'DX12', recommend: 'optiscaler', reason: 'DX12 game', antiCheat: 'Arxan' } },
  { name: 'Dolphin', exePath: G.dol,
    detectedPath: { engine: 'Emulator', apiBadge: null, recommend: 'unknown', reason: 'not detected yet' } },
];

const STATUS = {
  [G.cp]:   { exeMissing: false, backends: { optiscaler: true,  leftovers: [] } },
  [G.wf]:   { exeMissing: false, backends: { optiscaler: false, leftovers: [] } },
  [G.swtor]:{ exeMissing: false, backends: { optiscaler: true,  leftovers: [] } },
  [G.ai]:   { exeMissing: false, backends: { optiscaler: true,  leftovers: [] } },
  [G.rdr]:  { exeMissing: false, backends: { optiscaler: false, leftovers: ['OptiScaler.ini'] }, hasIni: true },
  [G.dol]:  { exeMissing: true,  backends: { optiscaler: false, leftovers: [] } },
};

const route = (o) => Object.assign({ route: 'optiscaler', label: 'OptiScaler', complete: false, reason: '', reasonVars: {}, optiInstalled: false }, o);
const ROUTE = {
  [G.cp]:   route({ label: 'OptiScaler', complete: true, optiInstalled: true, effectiveApi: 'dx12', reason: 'Installed and complete.',
                    verified: { route: 'optiscaler', verified: '16 Sep', notes: 'DX12, Present route, 1200 frames clean' } }),
  [G.wf]:   route({ route: 'feeder', label: 'OptiScaler + Feeder', complete: false, effectiveApi: 'dx11', reason: 'Nothing installed here yet.' }),
  [G.swtor]:route({ route: 'feeder', label: 'OptiScaler + Feeder (DX9)', complete: false, optiInstalled: true, experimental: true, effectiveApi: 'dx9', reason: 'The Feeder stack is incomplete.' }),
  [G.ai]:   route({ route: 'feeder32', label: 'OptiScaler + Feeder (32-bit)', complete: true, optiInstalled: true, effectiveApi: 'dx11', reason: 'Installed and complete.' }),
  [G.rdr]:  route({ label: 'OptiScaler', complete: false, effectiveApi: 'dx12', reason: 'Leftovers from an older install are still here.' }),
  [G.dol]:  route({ route: 'unknown', label: 'Unknown', complete: false, reason: 'The exe is not where it was.' }),
};

const RUN = {
  [G.cp]:   { ran: true, verdict: 'nr-ran', at: Date.now() - 36e5, nrFrames: 1240, fps: 71, runtimeApi: 'dx12' },
  [G.ai]:   { ran: true, verdict: 'nr-ran', at: Date.now() - 72e5, nrFrames: 4180, fps: 58, runtimeApi: 'dx11' },
};

const HELP = {
  // helpShort() renders the card's one row from the code, so it has to be a code the table knows.
  [G.swtor]: { ok: true, status: 'fix', code: 'dlss-runtime-missing', vars: {}, fix: { id: 'reconfigure' },
               run: { ran: true, verdict: 'no-dlss', at: Date.now() - 18e5 } },
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 160)));

  await page.addInitScript((D) => {
    const empty = async () => ({});
    const over = {
      loadData: async () => ({ games: D.GAMES, settings: { releaseFolder: 'C:\\OptiScaler', nrDllPath: 'C:\\nvngx_dlssnr.dll', installedVersion: 'v2.1.0', nrStartDefault: 'game' } }),
      gpuInfo: async () => ({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5080', driver: '32.0.16.1692' }),
      // A MAP of exePath -> bool, which is what pollRunningGames reads.
      gamesRunning: async (paths) => ({ ok: true, running: Object.fromEntries(paths.map((p) => [p, p === D.RUNNING])) }),
      gameStatus: async (e) => D.STATUS[e] || { exeMissing: false, backends: { optiscaler: false } },
      gameRoute: async (e) => D.ROUTE[e] || { route: 'unknown', label: 'Unknown', complete: false, reason: '' },
      gameHelp: async (e) => D.HELP[e] || { ok: true, status: 'ok', run: D.RUN[e] || { ran: false } },
      lastRun: async (e) => D.RUN[e] || { ran: false },
      detectPathIfStale: async () => null,
      validateRelease: async () => ({ valid: true }),
      validateNrDll: async () => ({ valid: true, sizeMB: 165 }),
      steamSearchVersion: async () => 1,
      exeIconBanner: async () => null,
      cacheSteamBanner: async () => null,
      bundledEngine: async () => ({ ok: true, version: 'v2.1.0' }),
      managerUpdateState: async () => ({ state: 'idle' }),
      onManagerUpdate: () => {},
      // Nothing network-shaped should run: these are the two that raised a toast over the grid.
      checkUpdate: async () => ({ ok: true, upToDate: true }),
      autoFetchNrDll: async () => ({ ok: true }),
    };
    window.api = new Proxy({}, { get: (_t, p) => (p in over ? over[p] : empty) });
  }, { GAMES, STATUS, ROUTE, RUN, HELP, RUNNING: G.ai });
  const G_AI = G.ai;

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForTimeout(3000);
  // Any toast that still got through is app chrome, not part of what this is showing.
  await page.evaluate(() => document.querySelectorAll('.toast, #toast').forEach((el) => el.remove()));

  // The poll that notices a running game runs on a timer; this is the same function it calls,
  // so the Running card is the app's own rendering of that state rather than a mock of it.
  await page.evaluate((exe) => {
    const card = cardsByExe.get(exe);
    if (card) applyRunningState(card, true);
  }, G_AI);

  const grid = await page.$('#game-grid');
  await grid.screenshot({ path: path.join(OUT, 'manager-game-grid.png') });
  console.log('cards:', await page.$$eval('.card', (c) => c.length));

  // Game Help, on the game that has something to say. Opened through the card's own button, so the
  // dialog is filled by the app's own openHelp().
  const cards = await page.$$('.card');
  await cards[2].$eval('.btn-help', (b) => b.click());
  await page.waitForTimeout(1200);
  const help = await page.$('#help-modal .modal');
  if (help) await help.screenshot({ path: path.join(OUT, 'game-help.png') });
  else console.log('no help modal');
  await page.click('#help-close');
  await page.waitForTimeout(600);

  // Settings for one game: the Display group is all that is left here now that the DLSS 5 controls
  // live on the in-game panel.
  await cards[0].$eval('.btn-edit', (b) => b.click());
  await page.waitForTimeout(1200);
  // Display is the only group the dialog still renders per game -- everything to do with DLSS 5
  // moved to the in-game panel, where the change is visible on the frame it applies to.
  await page.evaluate(() => {
    const sec = document.querySelector('#game-display-section');
    if (sec) sec.classList.remove('hidden');
    document.querySelectorAll('.edit-group').forEach((g) => { g.open = g.id === 'edit-group-display'; });
  });
  await page.waitForTimeout(300);
  const edit = await page.$('#game-modal .modal');
  if (edit) await edit.screenshot({ path: path.join(OUT, 'edit-game.png') });
  else console.log('no edit modal');
  console.log('chips:', await page.$$eval('.card-recommend', (n) => n.map((x) => x.innerText.replace(/\n/g, ' | ')).join('   //   ')));
  await browser.close();
})();
