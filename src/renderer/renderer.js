let games = [];
// The store-search version this build carries, asked of the main process once (see steam:searchVersion).
let bannerSearchVersion = 1;
let bannerSearchVersionLoaded = false;
let settings = { releaseFolder: '', nrDllPath: '', installedVersion: '', streamlineVersion: 'latest', engine: 'dlssnr', engines: {} };
let editingGameId = null;
let pendingBanner = { appid: null, localPath: null };
// Filled in at init from gpu:info (see gpu.js). 'unknown' behaves like NVIDIA -- the app's
// behaviour before detection existed.
let gpu = { vendor: 'unknown', name: null, driverVersion: null };

function gpuLabel() {
  const vendorName = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[gpu.vendor] || t('Unknown vendor');
  const name = gpu.name || vendorName;
  return gpu.driverVersion ? t('{name} (driver {version})', { name, version: gpu.driverVersion }) : name;
}

const $ = (sel) => document.querySelector(sel);

// The driver warning, on the app's front page rather than inside one game's Game Help.
//
// The app already knew about this, but only after the fact: the Feeder's log carries the driver's
// own "feature 18 as OutOfDate ... updated to 616.56 or newer" line, runlog.js reads it, and Game
// Help shows it for that one game once it has been run. A machine below the floor cannot run the
// neural pass in ANY game, so waiting for a run to find out is the wrong order -- the user installs
// to game after game and every one of them quietly does nothing.
//
// Dismissal is remembered against the driver version it was shown for, so it comes back if the
// driver changes and stays gone otherwise. A banner that cannot be dismissed is one people learn
// to read past.
function driverBannerDismissed(branch) {
  try { return localStorage.getItem('driver-warning-dismissed') === branch; } catch { return false; }
}

function refreshDriverBanner() {
  const banner = $('#driver-banner');
  const text = $('#driver-banner-text');
  const d = gpu && gpu.driver;
  if (!d || !d.checked || !d.outdated || driverBannerDismissed(d.branch)) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  text.textContent = t(
    'NVIDIA driver {current} is too old for DLSS 5. Neural Rendering needs {minimum} or newer -- below that the driver reports the feature as out of date and the pass never runs, in any game.',
    { current: d.branch, minimum: d.minimum },
  );
}

$('#btn-driver-download').addEventListener('click', () => {
  window.api.openExternal('https://www.nvidia.com/Download/index.aspx');
});

$('#btn-driver-dismiss').addEventListener('click', () => {
  const branch = gpu && gpu.driver && gpu.driver.branch;
  try { if (branch) localStorage.setItem('driver-warning-dismissed', branch); } catch {}
  $('#driver-banner').classList.add('hidden');
});



const grid = $('#game-grid');
const emptyState = $('#empty-state');
const settingsBanner = $('#settings-banner');

// One floating tip for every [data-tip] element. Positioned above the element, centred on it,
// flipped below when there is no room above, and kept inside the viewport either way.
// The text goes through t() here, so a data-tip written in English in index.html shows in the
// chosen language (and follows a language change); one the renderer already translated when it
// built the element comes back unchanged, since a translation is not itself a key.
let tipEl = null;
function showTip(target) {
  const raw = target.getAttribute('data-tip');
  const text = raw && t(raw);
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'floating-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.classList.remove('show');
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const margin = 8;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  let top = r.top - h - margin;
  if (top < margin) top = r.bottom + margin;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
  tipEl.classList.add('show');
}
function hideTip() {
  if (tipEl) tipEl.classList.remove('show');
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t) showTip(t);
});
document.addEventListener('mouseout', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) hideTip();
});
document.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) showTip(t); });
document.addEventListener('focusout', hideTip);
document.addEventListener('click', hideTip, true);
window.addEventListener('scroll', hideTip, true);
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

// Every card can decide during a render that it has something to store -- art it just resolved, a
// detection it just refreshed -- and each one used to write the whole games list to disk on its own.
// Twenty cards meant twenty full writes of the same file, overlapping, while the grid was being
// built. They are the same array, so one write after the render settles says everything they had
// to say. Anything the user does deliberately still saves through window.api.saveGames directly.
let saveGamesTimer = null;
function saveGamesSoon() {
  clearTimeout(saveGamesTimer);
  saveGamesTimer = setTimeout(flushSaveGames, 400);
}
function flushSaveGames() {
  if (!saveGamesTimer) return;
  clearTimeout(saveGamesTimer);
  saveGamesTimer = null;
  window.api.saveGames(games);
}
// Closed inside the window: art just resolved would otherwise be looked up again next launch.
window.addEventListener('beforeunload', flushSaveGames);

function toFileUrl(p) {
  return `file:///${p.replace(/\\/g, '/')}`;
}

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}
function setBannerWithFallback(game, imgEl, fallbackEl) {
  if (game.bannerLocalPath) {
    imgEl.classList.remove('hidden');
    // A game's own icon is square: shown whole and centred, not cropped to a 460x215 banner.
    imgEl.classList.toggle('card-banner-icon', !!game.bannerIsIcon);
    if (fallbackEl) fallbackEl.classList.add('hidden');
    imgEl.onerror = () => {
      imgEl.classList.add('hidden');
      if (fallbackEl) fallbackEl.classList.remove('hidden');
    };
    imgEl.src = toFileUrl(game.bannerLocalPath);
  } else {
    imgEl.classList.add('hidden');
    imgEl.removeAttribute('src');
    if (fallbackEl) {
      fallbackEl.textContent = initials(game.name);
      fallbackEl.classList.remove('hidden');
    }
  }
}

async function refreshBannerVisibility() {
  const valid = await window.api.validateRelease(settings.releaseFolder);
  const configured = valid.valid && settings.nrDllPath;
  settingsBanner.classList.toggle('hidden', !!configured);
}

// ── Which games are actually running ──────────────────────────────────────────────────────────
//
// One process listing for the whole library, every few seconds, and only while this window has
// focus: nobody needs a card to light up while they are looking at something else, and the poll
// is the sort of background work this app has already had to take back out once.
const cardsByExe = new Map();
let runningGames = new Set();
let runningPollTimer = null;

// Running is a STATE of the card now, not a row of its own: the chip on the art says it. The card
// used to carry a live line, a last-run line and a Tune button all at once, which is three things
// saying one thing -- and Tune opened a second copy of the in-game panel, which is gone.
function applyRunningState(card, isRunning) {
  card.dataset.running = isRunning ? '1' : '';
  refreshCardState(card);
}

// What a background sync found that the card should say, by exe path, kept for the session so a
// re-render does not lose it. vulkan: the Feeder update's warning that ReShade's Vulkan layer will
// not load in this game (main.js updateFeederIfStale, warned rather than thrown since 2026-09-18) --
// the sync used to swallow it, so the game just ran without DLSS 5 and nothing said why.
// update: the game's exe changed since the last sync (main.js gameupdate.js, 2026-09-18) -- either
// just rechecked, or with files of ours deleted by the update, which needs a reinstall.
const syncNotices = new Map();
function syncNoticeFor(exePath) {
  const n = syncNotices.get(exePath);
  if (!n) return null;
  return (n.update && n.update.bad && n.update) || n.vulkan || n.update || null;
}
// A sync notice that is a real problem stands in for a diagnosis that is not one; a harmless one
// only fills a row that would otherwise be empty.
function withSyncNotice(state) {
  const notice = state.syncNotice;
  if (!notice || (state.problem && state.problem.bad)) return state;
  return notice.bad || !state.problem ? { ...state, problem: notice } : state;
}
// Takes one game's game:sync-if-stale result; returns the Vulkan warning when this sync raised one.
function noteSyncResult(game, res) {
  const n = { ...(syncNotices.get(game.exePath) || {}) };
  const fu = res && res.feederUpdated;
  let warning = null;
  if (fu && fu.warning) {
    warning = String(fu.warning);
    n.vulkan = { bad: true, text: t('ReShade\'s Vulkan layer will not load in this game'), title: warning };
  } else if (fu) {
    delete n.vulkan; // the Feeder re-deployed cleanly, so the layer is fine now
  }
  const gu = res && res.gameUpdated;
  if (gu && gu.needsReinstall) {
    n.update = {
      bad: true,
      text: t('Game updated and its update removed DLSS 5 files — reinstall'),
      title: t('Removed since the last check: {list}. Game updates and Steam\'s file verification delete files they do not know; reinstall to put them back.', { list: (gu.missing || []).join(', ') }),
      // The card's own Install button is Uninstall on an installed game, so this runs the install
      // itself. The next sync confirms the files are back; until then the notice is simply dropped.
      action: {
        label: t('Reinstall'),
        run: async () => {
          await installGame(game);
          const cur = syncNotices.get(game.exePath);
          if (cur) delete cur.update;
          renderGrid();
        },
      },
    };
  } else if (gu && gu.rechecked) {
    n.update = {
      bad: false,
      text: t('Game updated — rechecked'),
      title: gu.buildFrom && gu.buildTo
        ? t('Steam build {from} → {to}. Detection and the install were checked again.', { from: gu.buildFrom, to: gu.buildTo })
        : t('The game\'s exe changed since the last check. Detection and the install were checked again.'),
    };
  } else if (res && res.ok && n.update && n.update.bad) {
    delete n.update; // the files are back: reinstalled
  }
  syncNotices.set(game.exePath, n);
  const card = cardsByExe.get(game.exePath);
  if (card && card._state) {
    card._state.syncNotice = syncNoticeFor(game.exePath);
    refreshCardState(card);
  }
  return warning;
}

// The chip and the primary button, from whatever the card currently knows. Called by every source
// that changes the answer -- the run poll, the route, the diagnosis -- so the two never disagree.
//
// One chip and one primary action replace nine stacked rows and seven buttons. The rule is simply
// what the user should do next, in priority order: a missing exe is unusable, a game that is up
// wants none of this touched, a problem worth fixing outranks launching, an uninstalled game wants
// Install, and everything else wants Launch.
function refreshCardState(card) {
  const state = withSyncNotice(card._state || {});
  const chip = card.querySelector('.card-badge');
  const primary = card.querySelector('.btn-card-primary');
  const launch = card.querySelector('.btn-launch');
  if (!chip || !primary) return;
  const running = card.dataset.running === '1';

  let tone = 'badge-none';
  let label = t('Not installed');
  let issue = !running && card._exePath ? launchIssues.get(card._exePath) : null;
  // An early exit the failure ladder has taken on is shown by it (the problem row and the turned card),
  // not by the restore offer below.
  if (issue && card._failure && card._failure.code === 'early-exit') issue = null;
  if (state.exeMissing) { tone = 'badge-missing'; label = t('Exe missing'); }
  else if (issue) { tone = 'badge-attention'; label = issue.kind === 'never-started' ? t('Did not start') : t('Closed early'); }
  else if (running) { tone = 'badge-installed'; label = `\u25cf ${t('Running')}`; }
  else if (state.problem && state.problem.bad) { tone = 'badge-attention'; label = t('Needs attention'); }
  else if (state.working) { tone = 'badge-installed'; label = t('Working'); }
  else if (state.installed) { tone = 'badge-partial'; label = t('Set up'); }
  else if (state.leftovers) { tone = 'badge-partial'; label = t('Leftovers'); }
  chip.className = `card-badge ${tone}`;
  chip.textContent = label;

  // One row, and while the game is up it says the one thing worth saying then: how to reach the
  // panel. A problem still outranks it -- there is no point naming a hotkey for a pass that is
  // not running.
  const problemEl = card.querySelector('.card-problem');
  const shown = issue ? { bad: true, text: launchIssueText(issue, (card._game && card._game.name) || '') }
    : (state.problem && state.problem.bad) ? state.problem
    : running && state.panelHint ? { bad: false, text: state.panelHint.text, title: state.panelHint.title }
    : state.problem;
  if (problemEl) {
    problemEl.classList.toggle('hidden', !shown);
    problemEl.classList.toggle('card-problem-bad', !!(shown && shown.bad));
    if (shown) {
      const textEl = problemEl.querySelector('.card-problem-text');
      textEl.textContent = shown.text;
      textEl.title = shown.title || shown.text;
    }
  }

  // The primary delegates to a real button rather than duplicating its work, so there is still one
  // implementation of Install, Tune and Launch and one place their confirmations live.
  const delegate = (sel) => () => card.querySelector(sel)?.click();
  let text = t('Launch');
  // Launch reads green (2026-09-25); every other primary below sets its own class.
  let cls = 'btn btn-card-primary btn-card-launch';
  let onClick = delegate('.btn-launch');
  let hideLaunch = true;

  if (state.exeMissing) {
    text = t('Settings');
    onClick = delegate('.btn-edit');
  } else if (issue && issue.canRestore && card._game) {
    text = t('Restore originals');
    cls = 'btn btn-card-primary btn-attention';
    onClick = () => offerRestore(card, card._game, issue);
    hideLaunch = false;
  } else if (running) {
    // Ahead of Fix it deliberately: a fix moves DLLs the running game is holding open, so it would
    // fail on the file it most needs to replace. The panel is live over the frame anyway.
    text = t('Settings');
    onClick = delegate('.btn-edit');
  } else if (state.problem && state.problem.action) {
    text = state.problem.action.label;
    cls = state.problem.bad ? 'btn btn-card-primary btn-attention' : 'btn btn-card-primary';
    onClick = state.problem.action.run;
    hideLaunch = false;
  } else if (state.leftovers) {
    text = t('Remove leftovers');
    cls = 'btn btn-card-primary btn-danger';
    onClick = delegate('.btn-install');
  } else if (!state.installed) {
    text = state.installLabel || t('Install');
    cls = state.unsupported ? 'btn btn-card-primary' : 'btn btn-card-primary btn-primary';
    onClick = delegate('.btn-install');
  }

  if (text !== t('Launch')) cls = cls.replace(' btn-card-launch', '');
  primary.className = cls;
  primary.textContent = text;
  primary.onclick = onClick;
  if (launch) launch.classList.toggle('hidden', hideLaunch);
}

async function pollRunningGames() {
  if (games.length === 0) return;
  let res = null;
  try { res = await window.api.gamesRunning(games.map((g) => g.exePath)); } catch {}
  if (!res || !res.ok) return;
  const next = new Set(Object.entries(res.running).filter(([, v]) => v).map(([k]) => k));
  // Only touch the cards whose answer changed.
  for (const [exePath, card] of cardsByExe) {
    const was = runningGames.has(exePath);
    const now = next.has(exePath);
    if (was !== now) applyRunningState(card, now);
  }
  // A game that just closed, or one the last sync pass could not finish, is synced now: its DLLs are
  // no longer locked, and waiting for the next start-up is how a library ends up on two engines.
  // A retry that keeps failing is asked again at most once a minute, not on every 5-second poll.
  const at = Date.now();
  const due = games.filter((g) => !next.has(g.exePath)
    && (runningGames.has(g.exePath) || (syncRetry.has(g.exePath) && at - syncRetry.get(g.exePath) > 60000)));
  runningGames = next;
  if (due.length > 0 && !resyncInFlight) resyncGames(due);
}

// Games a sync pass left behind -- almost always because the game was running and its DLLs were
// locked -- with when it last failed. pollRunningGames retries them once it sees them closed.
const syncRetry = new Map();
let resyncInFlight = false;

async function resyncGames(due) {
  resyncInFlight = true;
  try { await runResync(due); } finally { resyncInFlight = false; }
}

async function runResync(due) {
  await autoSyncInFlight;
  const updated = [];
  for (const game of due) {
    const engineId = engineOf(game);
    const folder = engineFolder(engineId);
    if (!folder) continue;
    let res = null;
    try { res = await window.api.syncGameIfStale({ exePath: game.exePath, releaseFolder: folder, nrDllPath: settings.nrDllPath }); } catch {}
    if (!res || !res.ok) { syncRetry.set(game.exePath, Date.now()); continue; }
    syncRetry.delete(game.exePath);
    noteSyncResult(game, res);
    if (res.updated) updated.push(game.name);
  }
  if (updated.length > 0) {
    toast(updated.length > 1
      ? t('Auto-updated OptiScaler in {count} games: {list}', { count: updated.length, list: updated.join(', ') })
      : t('Auto-updated OptiScaler in 1 game: {list}', { list: updated.join(', ') }));
  }
}

function startRunningPoll() {
  if (runningPollTimer) return;
  pollRunningGames();
  runningPollTimer = setInterval(pollRunningGames, 5000);
}
function stopRunningPoll() {
  clearInterval(runningPollTimer);
  runningPollTimer = null;
}
window.addEventListener('focus', startRunningPoll);
window.addEventListener('blur', stopRunningPoll);

// renderGrid awaits per card, and is re-entered from window focus, settings close and
// install/uninstall completions -- two overlapping runs would each append their own set of cards.
// The newest run wins; older ones stop at their next await.
let renderGeneration = 0;

// Exe paths whose card "Fix it" is still running (applyRecommendation).
const cardFixesInFlight = new Set();

async function renderGrid() {
  if (!bannerSearchVersionLoaded) {
    try { bannerSearchVersion = (await window.api.steamSearchVersion()) || 1; } catch {}
    bannerSearchVersionLoaded = true;
  }
  const generation = ++renderGeneration;
  cardsByExe.clear();
  grid.innerHTML = '';
  emptyState.classList.toggle('hidden', games.length > 0);
  grid.classList.toggle('hidden', games.length === 0);

  // Asked for all at once rather than a card at a time: the main process answers them in turn
  // either way, but the renderer no longer waits out a full round trip before starting the next.
  const statuses = await Promise.all(games.map((game) => window.api.gameStatus(game.exePath).catch(() => ({ exeMissing: true }))));
  if (generation !== renderGeneration) return;

  for (const [index, game] of games.entries()) {
    const status = statuses[index];
    const card = document.createElement('div');
    card.className = 'card';

    const backends = status.backends || { optiscaler: false };
    // What the chip and the primary button are computed from. Filled in further by
    // applyRecommendation once the route and the diagnosis come back; refreshCardState renders it.
    // On an AMD card a lone nvngx_dlssnr.dll is the DLSS-NR-on-AMD layout, not a half-done
    // OptiScaler install, so it does not count as leftovers here. main.js's detectInstalledBackends
    // lists nvngx_dlssnr.dll among its leftovers regardless of vendor, which quietly defeated the
    // hasNr check (review of 2026-09-18) -- and the menu's "Remove leftovers" then ran the full
    // uninstall and deleted the AMD model. So on AMD the model file is taken out of the list, and
    // the chip, the menu label and the Remove handler all read this one filtered list.
    const leftoverFiles = (backends.leftovers || []).filter((n) => !(gpu.vendor === 'amd' && String(n).toLowerCase() === 'nvngx_dlssnr.dll'));
    const initialState = {
      exeMissing: !!status.exeMissing,
      installed: !!backends.optiscaler,
      leftovers: !backends.optiscaler && (leftoverFiles.length > 0 || status.hasIni || (status.hasNr && gpu.vendor !== 'amd')),
      working: false,
      problem: null,
      syncNotice: syncNoticeFor(game.exePath),
      installLabel: t('Install'),
    };

    card.innerHTML = `
      <div class="card-flipper">
      <div class="card-face card-face-front">
      <div class="card-banner-wrap">
        <img class="card-banner hidden" alt="${escapeHtml(game.name)}" />
        <span class="card-banner-fallback hidden"></span>
        <span class="card-badge badge-none"></span>
        <span class="card-mark hidden"></span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(game.name)}</div>
        <div class="card-path card-recommend hidden"></div>
        <div class="card-problem hidden"><span class="card-problem-text"></span></div>
        <div class="card-actions">
          <button class="btn btn-primary btn-card-primary"></button>
          <button class="btn btn-launch" title="${escapeHtml(t('Runs the game from its own folder -- for an Unreal game, the -Win64-Shipping.exe that OptiScaler is installed beside.'))}">&#9654; ${escapeHtml(t('Launch'))}</button>
          <button class="btn btn-ghost btn-card-menu" aria-label="${escapeHtml(t('More actions'))}" aria-expanded="false">&#8943;</button>
        </div>
        <div class="card-menu hidden">
          <button class="btn btn-ghost btn-edit">${escapeHtml(t('Settings'))}</button>
          <button class="btn btn-ghost btn-swap-layer hidden"></button>
          <button class="btn btn-ghost btn-neural-pass hidden"></button>
          <button class="btn btn-ghost btn-mv-provider hidden"></button>
          <button class="btn btn-ghost btn-addons">${escapeHtml(t('ReShade add-ons'))}</button>
          <button class="btn btn-ghost btn-open">${escapeHtml(t('Open folder'))}</button>
          <button class="btn btn-ghost btn-danger btn-install">${escapeHtml(backends.optiscaler ? t('Uninstall DLSS 5') : leftoverFiles.length ? t('Remove leftovers') : t('Install DLSS 5'))}</button>
          ${(status.foreign || []).length ? `<button class="btn btn-ghost btn-danger btn-remove-foreign">${escapeHtml(t('Remove the other DLSS 5 toolchain…'))}</button>` : ''}
          <button class="btn btn-ghost btn-danger btn-remove">${escapeHtml(t('Remove from list'))}</button>
        </div>
      </div>
      </div>
      <div class="card-face card-face-back">
        <div class="card-remove-title"></div>
        <div class="card-remove-detail"></div>
        <div class="card-remove-actions">
          <button class="btn btn-ghost btn-flip-cancel">${escapeHtml(t('Cancel'))}</button>
          <button class="btn btn-danger btn-flip-confirm">${escapeHtml(t('Remove'))}</button>
        </div>
        <div class="card-fail-actions hidden"></div>
        <div class="card-fail-status hidden"></div>
      </div>
      </div>
    `;

    setBannerWithFallback(game, card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback'));
    const bannerEls = () => [card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback')];
    // SteamGridDB art (source 'steamgriddb') carries no appid on purpose -- its ids are its own, and
    // bannerAppId is read elsewhere as "this game is on Steam". It is cached by its URL and lives on
    // as a local path, like art picked by hand -- except that this one WAS auto-found, so bannerIsIcon
    // stays false and it is shown cropped to fill like any other banner rather than centred like an icon.
    // Returns whether the card actually got art, so a download that fails still falls through to the icon.
    const applyResolved = async (found) => {
      if (found.source === 'steamgriddb') {
        const localPath = await window.api.cacheUrlBanner(found.gridId, found.imageUrl);
        if (!localPath) return false;
        game.bannerAppId = null;
        game.bannerLocalPath = localPath;
        game.bannerIsIcon = false;
        saveGamesSoon();
        setBannerWithFallback(game, ...bannerEls());
        return true;
      }
      const localPath = await window.api.cacheSteamBanner(found.appid, found.tinyImage);
      game.bannerAppId = String(found.appid);
      game.bannerLocalPath = localPath || null;
      game.bannerIsIcon = false;
      saveGamesSoon();
      setBannerWithFallback(game, ...bannerEls());
      return true;
    };
    // Nothing on the store knows this game, so fall back to what the game knows about itself.
    // Written once and then remembered like any other art; if that file later goes missing the
    // image's own onerror puts the initials back, the same as for a Steam banner.
    const applyExeIcon = async (g, els) => {
      const iconPath = await window.api.exeIconBanner(g.exePath);
      if (!iconPath) return false;
      g.bannerLocalPath = iconPath;
      g.bannerIsIcon = true;
      setBannerWithFallback(g, ...els());
      return true;
    };
    const autoFound = !!game.bannerSearchAttempted;
    const staleSearch = (game.bannerSearchVersion || 1) < bannerSearchVersion;
    if (game.bannerAppId && autoFound && staleSearch) {
      // Art an older search picked by name is looked up again, once per search version, and
      // replaced if the answer has changed. The Steam manifest beside the exe is exact and was
      // always allowed to overrule ("re2" had been given Red Dead Redemption 2); a new search
      // result now is too, because the search this app ran at the older version is precisely what
      // the bump says it no longer trusts -- Castlevania: Lords of Shadow was wearing Lords of
      // Shadow 2's art, and nothing but a fresh search can take it back off. Art the user chose
      // themselves was never auto-found, so none of this ever touches it.
      game.bannerSearchVersion = bannerSearchVersion;
      window.api.resolveBanner(game.exePath, game.name).then(async (found) => {
        // A SteamGridDB answer is never allowed to take over here: this card already has store art,
        // which is the better source, and the fallback only ran because the store missed this time.
        if (found && found.source !== 'steamgriddb' && String(found.appid) !== String(game.bannerAppId)) await applyResolved(found);
        else saveGamesSoon();
      });
    } else if (game.bannerIsIcon && autoFound && staleSearch) {
      // A card wearing its own exe icon is a card the search gave up on -- and that is exactly the
      // set a new art source exists for. Without this it would never look again: the icon fills in
      // bannerLocalPath, so every branch below reads the card as already having art and leaves it
      // alone for good. Once per search version, like the others. The icon stays if nothing is found,
      // and art the user picked by hand is not an icon and was never auto-found, so it is untouched.
      game.bannerSearchVersion = bannerSearchVersion;
      window.api.resolveBanner(game.exePath, game.name).then(async (found) => {
        if (found) await applyResolved(found);
        else saveGamesSoon();
      });
    } else if (!game.bannerLocalPath && !game.bannerAppId && autoFound && !staleSearch) {
      // Searched before and found nothing, and the search has not changed since: the store has
      // no more to say, so the icon is the answer rather than a blank card.
      applyExeIcon(game, bannerEls).then((ok) => { if (ok) saveGamesSoon(); });
    } else if (!game.bannerLocalPath && game.bannerAppId) {
      window.api.cacheSteamBanner(game.bannerAppId).then((localPath) => {
        if (localPath) {
          game.bannerLocalPath = localPath;
          saveGamesSoon();
          setBannerWithFallback(game, ...bannerEls());
        }
      });
    } else if (!game.bannerLocalPath && !game.bannerAppId && (!autoFound || staleSearch)) {
      // Once per search version: a card that missed under an older, dumber search tries again
      // after an update, and a card that still misses is not hammered on every render. The
      // Steam manifest beside the exe wins where there is one; the store search is for the rest.
      game.bannerSearchAttempted = true;
      game.bannerSearchVersion = bannerSearchVersion;
      window.api.resolveBanner(game.exePath, game.name).then(async (found) => {
        // Nothing found, or the art that was found could not be downloaded: either way the card
        // falls through to its own icon rather than staying blank.
        if (!found || !(await applyResolved(found))) {
          await applyExeIcon(game, bannerEls);
          saveGamesSoon();
        }
      });
    }

    card.querySelector('.btn-install').addEventListener('click', async () => {
      if (backends.optiscaler || leftoverFiles.length) {
        await confirmRemoveOnCard(card, game);
      } else if ((status.foreign || []).length) {
        // Another DLSS 5 toolchain is in the folder: installing on top of it is how a real
        // user's Fallen Order came to crash on launch. Said before the click lands.
        const list = status.foreign.map((f) => `${f.tool}: ${f.files.join(', ')}`).join('; ');
        flipToConfirm(card, {
          title: t('Another DLSS 5 toolchain is here'),
          detail: t('This folder already has {list}. Two stacks hooking the same DLSS call crash the game -- remove the other one with its own uninstaller first.', { list }),
          onConfirm: () => installGame(game),
          confirmLabel: t('Install anyway'),
          danger: true,
        });
      } else if (gpu.vendor === 'amd' || gpu.vendor === 'intel') {
        // Installs fine, renders nothing new: OptiScaler's NR pass needs NVIDIA's NGX runtime.
        // Said before the click lands, not after, so an "OptiScaler" badge never reads as NR working.
        flipToConfirm(card, {
          title: t('Install DLSS 5 on this GPU?'),
          detail: t('This is an {vendor} card: DLSS 5 installs and its upscaler swap works, but its Neural Rendering will not run here (needs NVIDIA).', { vendor: gpu.vendor === 'amd' ? 'AMD' : 'Intel' }) +
            (gpu.vendor === 'amd' ? ' ' + t('For NR on AMD, see "DLSS 5 Neural Rendering on AMD" under Edit.') : ''),
          onConfirm: () => installGame(game),
          confirmLabel: t('Install anyway'),
          danger: false,
        });
      } else {
        installGame(game);
      }
    });
    const removeForeignBtn = card.querySelector('.btn-remove-foreign');
    if (removeForeignBtn) {
      removeForeignBtn.addEventListener('click', () => {
        // Warning 1 of 2 on the card; main.js shows warning 2 of 2 natively with the exact list.
        const list = (status.foreign || []).map((f) => `${f.tool}: ${f.files.join(', ')}`).join('; ');
        flipToConfirm(card, {
          title: t('Delete the other toolchain\'s files? (1 of 2)'),
          detail: t('This deletes {list} and everything else that tool is known to place here, and puts back that tool\'s own backups where they belong to the game. If it modified game files in place without leaving a backup, those cannot be restored -- the game may break, and verifying the game files through its store fixes that. Your own OptiScaler install here is left as is. A second confirmation lists every file.', { list }),
          confirmLabel: t('Continue'),
          danger: true,
          onConfirm: async () => {
            const res = await window.api.removeForeign(game.exePath);
            if (!res.ok) { toast(t('Could not remove the other toolchain: {error}', { error: res.error })); return; }
            if (res.cancelled) return;
            const removed = res.removed.length ? t('Removed: {list}.', { list: res.removed.join(', ') }) : t('Nothing left to remove.');
            const restored = res.restored.length ? ' ' + t('Restored: {list}.', { list: res.restored.join(', ') }) : '';
            toast(`${t('Other DLSS 5 toolchain removed.')} ${removed}${restored} ${t('If the game now fails to start, verify its files through its store.')}`);
            renderGrid();
          },
        });
      });
    }
    // Game Help, Analyse game and Verify install left the ⋯ menu (2026-09-25): the card itself now says
    // what went wrong and what to try next (flipToFailure), and its problem row's Help / Show me button
    // still opens Game Help where there is more to read. analyseGame and verifyInstall have no caller
    // now; they and their IPC are left in place for the clean-up pass to decide on.
    card.querySelector('.btn-launch').addEventListener('click', async () => {
      const res = await window.api.launchGame(game.exePath, game.launcher);
      if (!res.ok) { toast(t('Could not launch {name}: {error}', { name: game.name, error: res.error })); return; }
      if (res.cancelled) { toast(t('Not launched.')); return; }
      const exe = res.target.split(/[\\/]/).pop();
      toast((res.via === 'steam'
        ? t('Launching {name} through Steam.', { name: game.name })
        : res.via === 'launcher'
          ? t('Started {name} through its launcher ({exe}). Sign in there; the game is watched once it starts.', { name: game.name, exe: String(res.launcher).split(/[\\/]/).pop() })
        // Said out loud on every launch, remembered choice or not: what started, and what it costs.
        : res.via === 'exe-no-anticheat'
          ? t('Launched {name} without {antiCheat} ({exe}) -- online play will not work while it is modded.', { name: game.name, antiCheat: res.antiCheat || t('anti-cheat'), exe })
          : t('Launched {name} ({exe}).', { name: game.name, exe }))
        + (res.antiCheatRisk ? ' ' + t('{antiCheat} is in this game\'s folder: it may refuse to start the game with OptiScaler installed, or close it soon after. This app will say so if it does.', { antiCheat: res.antiCheatRisk }) : ''));
    });

    // The overflow. Everything that is not the one next step lives behind it, which is what takes
    // the card from seven buttons to two. Closes on a click anywhere else so it cannot be left open
    // over the grid.
    card._state = initialState;
    card._exePath = game.exePath;
    card._game = game;
    const menu = card.querySelector('.card-menu');
    const menuBtn = card.querySelector('.btn-card-menu');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden');
      menuBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
      for (const other of grid.querySelectorAll('.card-menu')) if (other !== menu) other.classList.add('hidden');
    });
    menu.addEventListener('click', () => { menu.classList.add('hidden'); menuBtn.setAttribute('aria-expanded', 'false'); });
    refreshCardState(card);

    cardsByExe.set(game.exePath, card);
    applyRunningState(card, runningGames.has(game.exePath));
    card.querySelector('.btn-open').addEventListener('click', () => window.api.openFolder(game.exePath));
    card.querySelector('.btn-swap-layer').addEventListener('click', (e) => applyLayerSwap(game, e.currentTarget.dataset.fix));
    card.querySelector('.btn-neural-pass').addEventListener('click', (e) => switchNeuralPass(game, e.currentTarget.dataset.to));
    card.querySelector('.btn-edit').addEventListener('click', () => openGameModal(game));
    card.querySelector('.btn-mv-provider').addEventListener('click', () => openGameModal(game, { focus: 'legacy-mv' }));
    card.querySelector('.btn-addons').addEventListener('click', () => openAddonsModal(game));
    card.querySelector('.btn-remove').addEventListener('click', () => removeGame(game));
    card.querySelector('.btn-flip-cancel').addEventListener('click', () => card.classList.remove('flipped'));
    card.querySelector('.btn-flip-confirm').addEventListener('click', () => {
      card.classList.remove('flipped');
      card._onFlipConfirm?.();
    });

    applyRecommendation(game, card, backends, generation);

    grid.appendChild(card);
  }

}

async function applyRecommendation(game, card, backends, generation = renderGeneration) {
  // Every await below belongs to one render of one card. A newer render has already replaced the
  // card this is filling in, so the work behind it is thrown away rather than finished.
  const current = () => generation === renderGeneration;
  const line = card.querySelector('.card-recommend');
  const install = card.querySelector('.btn-install');
  let detected = game.detectedPath;

  // Re-detects when the cached result predates the current detection rules or was provisional.
  const fresh = await window.api.detectPathIfStale(game.exePath, detected);
  if (!current()) return;
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(detected)) {
    detected = fresh;
    game.detectedPath = fresh;
    saveGamesSoon();
  }
  detected = detected || fresh || { recommend: 'unknown', reason: t('not detected yet') };

  if (!line) return;
  const canRecommendInstall = !backends.optiscaler;
  const [route, diag] = await Promise.all([
    window.api.gameRoute(game.exePath, detected),
    window.api.gameHelp(game.exePath, game.detectedPath || null, helpTriedFor(game)),
  ]);
  if (!current()) return;

  // The chip line (engine, API, route, Experimental, Verified, Known good, Proven route/layer) is gone:
  // asked for 2026-09-25 as clutter. The card keeps three signals -- the DLSS 5 / Chicken mark on the
  // art, the status chip (Working, Needs attention...) and the one problem row -- and the detail that
  // used to sit in the chips (and the route text, removed from the card and Settings) is in Game Help.
  line.classList.add('hidden');


  // The DXVK <-> dgVoodoo2 swap, in the overflow as well as in Game Help and Edit (layerSwapFor).
  const swapBtn = card.querySelector('.btn-swap-layer');
  const swap = layerSwapFor(route);
  swapBtn.classList.toggle('hidden', !swap);
  if (swap) { swapBtn.textContent = swap.label; swapBtn.dataset.fix = swap.id; }

  // The 32-bit route's motion-vector provider, one click from the card: Assassin's Creed II
  // (2026-09-18) jumped on VORT, and the switch to LumeniteFX lived only in Edit.
  const mvBtn = card.querySelector('.btn-mv-provider');
  const lmv = route.route === 'feeder32' ? route.legacyMv : null;
  mvBtn.classList.toggle('hidden', !lmv);
  if (lmv) mvBtn.textContent = t('Motion vectors: {provider} — change…', { provider: shortMvName(lmv.displayName) || t('unknown') });

  // Which neural pass is live in the folder, at a glance, in the art's corner: a drumstick for Deep
  // Fried Chicken, this app's own logo for our engine. What is installed, not what is chosen in Edit
  // -- a choice not yet applied has its own "Press Install to switch" line.
  const mark = card.querySelector('.card-mark');
  const liveDfc = route.consumerHere === 'dfc';
  // backends.optiscaler as well as the route: a card reading "Set up" wore no mark when the route
  // lookup answered optiInstalled false for it (Yakuza 0, DOOM: The Dark Ages, 2026-09-25).
  const liveOurs = !liveDfc && (!!route.optiInstalled || !!backends.optiscaler);
  mark.classList.toggle('hidden', !liveDfc && !liveOurs);
  mark.classList.toggle('card-mark-dfc', liveDfc);
  if (liveDfc) {
    mark.innerHTML = `<span class="card-mark-icon">\u{1F357}</span><span>Chicken</span>`;
    mark.title = t('Deep Fried Chicken runs the neural pass here');
  } else if (liveOurs) {
    mark.innerHTML = '<img src="icon.png" alt=""><span>DLSS 5</span>';
    mark.title = t('DLSS 5 (this app\x27s engine)');
  }

  // Which add-on runs the neural pass on this Feeder game, and the one click that swaps it (dfc.js).
  // Named by what the folder has now, so the entry reads as a switch, not a setting.
  const passBtn = card.querySelector('.btn-neural-pass');
  const passOffered = !!(route.dfcSupport && route.dfcSupport.ok);
  passBtn.classList.toggle('hidden', !passOffered);
  if (passOffered) {
    const onDfc = route.consumerHere === 'dfc';
    passBtn.textContent = onDfc
      ? t('Neural pass: Deep Fried Chicken — switch back to DLSS 5')
      : t('Neural pass: DLSS 5 — switch to Deep Fried Chicken');
    passBtn.dataset.to = onDfc ? 'optiscaler' : 'dfc';
  }

  // What detection found beside the exe that the person should know before installing: none
  // of these block anything, all of them have bitten real installs. The card shows a few words
  // each; the full sentence is the hover text.
  const detectWarnings = [];
  const detectShort = [];
  if (detected.antiCheat) {
    detectWarnings.push(t('Anti-cheat present ({file}) -- OptiScaler is for single-player games; using it in a game that goes online risks a ban.', { file: detected.antiCheat }));
    detectShort.push(t('Anti-cheat: single-player only'));
  }
  // On the 32-bit route the ReShade beside the game is this app's own (legacy.js), not a conflict.
  if (detected.reshadeProxy && route.route !== 'feeder32') {
    detectWarnings.push(t('ReShade is already installed here as {file}. Install replaces it with OptiScaler -- pick Launch mode: Injector in Edit to keep both.', { file: detected.reshadeProxy }));
    detectShort.push(t('ReShade already here ({file})', { file: detected.reshadeProxy }));
  }
  // An emulator: which renderer to pick in it, always -- its renderer is a setting the route cannot
  // see or change, and on any other one DLSS 5 has nothing to hook (emulators.js, #106).
  const emuRenderer = route.emulatorRenderer || null;
  // A last run on another renderer is a problem, not advice: it is claimed below as one.
  if (emuRenderer && !emuRenderer.seen) {
    detectWarnings.push(emulatorRendererWords(emuRenderer));
    detectShort.push(emuRenderer.openglOnly ? t('OpenGL only: no in-game panel') : t('Set {name} to {renderer}', emuRenderer));
  }
  if (detected.oldShaderCompiler) {
    detectWarnings.push(t('{file} v{version} beside the exe predates Shader Model 5.1, so OptiScaler\'s shaders can silently fail to compile -- rename it and Windows\' own copy loads instead.', { file: detected.oldShaderCompiler.file, version: detected.oldShaderCompiler.version }));
    detectShort.push(t('Old shader compiler ({file})', { file: detected.oldShaderCompiler.file }));
  }

  // The verdict game:help already worked out, rather than a second analysis of the same logs.
  const run = diag && diag.ok ? diag.run : await window.api.lastRun(game.exePath);
  if (!current()) return;
  const ran = run && run.ran;
  const runBad = ran && ['duplicate-dlss', 'shutdown-fault', 'ue-crash', 'feed-stopped', 'feed-host-gone',
    'feed-no-motion', 'feed-depth-flat', 'feed-agility-redist', 'no-dlss'].includes(run.verdict);
  // Kept on the card so a launch that closes early later (setLaunchIssue) can be judged the same way.
  card._failCtx = { route, diag, run };
  const failure = failureEvidence(game, { route, diag, run, issue: launchIssues.get(game.exePath) || null });


  // One row, one state. The last run, Game Help's verdict, the route's unfinished step and what
  // detection found beside the exe were five stacked lines that a game in trouble showed at once,
  // three of them saying the same thing in different words. They compete for the single row here
  // in the order of what the person should deal with first, and the winner also decides the chip
  // and the primary button through refreshCardState.
  let problem = null;
  const claim = (p) => { if (!problem) problem = p; };

  // DLSS 5 failed here and there is no known fix: the card turns round to the next thing to try, and
  // the row says so in words instead of "no known fix" (flipToFailure).
  if (failure && !(diag && diag.ok && diag.status === 'fix')) {
    claim(failureProblem(card, game, failure));
    showFailure(card, game, failure, { route, diag, run });
  } else {
    card._failure = null;
  }

  // The game never asked for DLSS on its last run: a hint, not a failure and not "no known fix".
  if (diag && diag.ok && DLSS_NOT_ASKED.includes(diag.code) && diag.status !== 'fix') {
    const words = t('Last run did not use DLSS -- switch DLSS on in the game\'s graphics settings');
    claim({ bad: false, text: words, title: helpWords(diag) });
  }

  if (diag && diag.ok && ['fix', 'step', 'unavailable', 'unknown'].includes(diag.status)) {
    const bad = diag.status === 'unavailable' || diag.status === 'unknown';
    let action;
    if (diag.status === 'fix') {
      // Applied straight from the card. No dialog opens: the toast names what changed.
      // With modal:false applyHelpFix's busy() has no button to disable, so a double-click ran the
      // same fix twice at once -- two DLL swaps racing in one folder (review of 2026-09-18). The
      // in-flight set is keyed by exe rather than held on the card because the fix re-renders the
      // grid, which builds a fresh card for the same game.
      action = {
        label: t('Fix it'),
        run: async () => {
          if (cardFixesInFlight.has(game.exePath)) return;
          cardFixesInFlight.add(game.exePath);
          const btn = card.querySelector('.btn-card-primary');
          if (btn) btn.disabled = true;
          try {
            await applyHelpFix(game, diag, { modal: false });
          } finally {
            cardFixesInFlight.delete(game.exePath);
            if (btn) btn.disabled = false;
          }
        },
      };
    } else if (diag.code === 'pd-plugin-missing') {
      // The one file the app cannot fetch: its own popup, which finds the download afterwards.
      action = { label: t('Get plugin'), run: () => openPdPluginModal() };
    } else {
      action = { label: diag.status === 'step' ? t('Show me') : t('Help'), run: () => openHelp(game) };
    }
    claim({ bad, text: helpShort(diag), title: helpWords(diag), action });
  }

  // A bad run that the rule table had nothing to say about still has to reach the card.
  if (runBad) {
    claim({ bad: true, text: describeRun(run), title: describeRun(run), action: { label: t('Help'), run: () => openHelp(game) } });
  }

  // The neural pass chosen in Edit is not the one this folder is set up for: Install does the swap.
  // Claimed before "Next:", because a route that is complete for the OTHER consumer says nothing.
  if (route.dfcSupport && route.dfcSupport.ok && route.consumerHere && route.consumerHere !== chosenConsumer(game)) {
    const to = chosenConsumer(game) === 'dfc' ? t('Deep Fried Chicken') : t('DLSS 5');
    const words = t('Press Install to switch this game to {to}', { to });
    claim({ bad: true, text: words, title: words, action: { label: t('Install'), run: () => installGame(game) } });
  }

  // OptiScaler is in but the rest of its route is not (a Feeder game installed before the
  // one-click flow existed, or Luma UE still waiting on its licence confirmation).
  if (route.optiInstalled && !route.complete && route.nextStep) {
    const step = t('Next: {step}', { step: t(route.nextStep) });
    claim({ bad: true, text: step, title: step, action: { label: t('Show me'), run: () => openHelp(game) } });
  }

  if (emuRenderer && emuRenderer.seen) {
    const words = emulatorRendererWords(emuRenderer);
    claim({ bad: true, text: t('{name} ran on {seen} -- set {renderer}', emuRenderer), title: words, action: { label: t('Show me'), run: () => openHelp(game) } });
  }

  if (detectShort.length) {
    // Advisory, not broken: these keep the chip out of "Needs attention", because a game whose
    // only finding is "this has anti-cheat" is not a game with something to fix.
    claim({ bad: false, text: detectShort.map((w) => `\u26a0 ${w}`).join('  '), title: detectWarnings.join('\n') });
  }

  // How to reach the settings while the game is up, which is the one thing the card can usefully
  // say then -- and the only place the DLSS 5 controls live now that Settings no longer copies
  // them. The 32-bit route needs its own sentence: "press the hotkey" is what every other route
  // says and here it is not enough.
  card._state.panelHint = route.route === 'feeder32' && route.complete
    ? {
        text: t('Menus are in the helper: Home \u2192 Add-ons \u2192 DLSS 5 Feed \u2192 show the panel \u2192 Insert'),
        title: t('Expect nothing on screen in the game: no OptiScaler splash when it loads, and no menu on any key. A 32-bit game cannot run DLSS in its own process, so the neural pass runs in the 64-bit helper beside the game -- and OptiScaler runs there with it, in a process with no window to draw on. Press "Show the DLSS 5 panel in-game" in the add-on first; Insert then opens OptiScaler\'s menu inside it. Needs windowed or borderless. Game Help spells it out.'),
      }
    // With the pop-out panel switched off (or its hotkey taken by another program) naming that
    // hotkey sent people to a key that did nothing (review of 2026-09-18); Alt+Home is then the
    // only way in, so the card says just that.
    : route.optiInstalled && !popoutHotkeyUsable()
      ? {
          text: t('Press Insert in the game for the DLSS 5 panel'),
          title: t('The DLSS 5 panel, inside the game, with its controls live on the frame. Needs the game windowed or borderless if it does not show. The pop-out panel\'s hotkey is off or taken by another program -- see Settings.'),
        }
    : route.optiInstalled
      ? {
          text: t('{hotkey} opens the DLSS 5 panel', { hotkey: panelHotkey() }),
          title: t('The pop-out panel, over the game, with every DLSS 5 control live on the frame you are looking at -- which is why they are no longer copied into Settings. The DLSS 5 panel is on Insert inside the game, and OptiScaler\'s own menu on Alt+O. Both need the game windowed or borderless; Windows will not draw over exclusive fullscreen.'),
        }
      : null;

  card._state.problem = problem;
  card._state.working = !!(ran && run.verdict === 'nr-ran') || !!(route.complete && !(problem && problem.bad));
  card._state.installed = !!route.optiInstalled || card._state.installed;
  // The menu entry and the primary button say the same thing, because on an uninstalled game the
  // primary IS Install and pressing it is pressing that entry.
  if (canRecommendInstall && route.route === 'feeder' && !route.feederDeployed) install.textContent = t('Install DLSS 5 + Feeder');
  else if (canRecommendInstall && route.route === 'lumaue') install.textContent = t('Install DLSS 5 (then Luma UE)');
  if (canRecommendInstall) card._state.installLabel = install.textContent;
  // Nothing here can drive DLSS 5: Install stays available but stops being the green thing to press.
  card._state.unsupported = detected.recommend === 'unsupported' || route.route === 'unsupported';
  refreshCardState(card);

  // The route is only known now, and the poll may already have decided this card was running.
  if (runningGames.has(game.exePath)) applyRunningState(card, true);
}
const API_LABEL = { dx12: 'DX12', dx11: 'DX11', vulkan: 'Vulkan', opengl: 'OpenGL', dx10: 'DX10', dx9: 'DX9', dx8: 'DX8' };

// Remove, with the exact list first: Remove never surprises anyone with what it took. The card's own
// Remove and the early-exit offer below both come here, so there is one implementation of it.
async function confirmRemoveOnCard(card, game, { title = t('Remove DLSS 5?'), lead = '', confirmLabel } = {}) {
  const plan = await window.api.uninstallPlan(game.exePath);
  const clip = (arr) => (arr.length > 12 ? arr.slice(0, 12).join(', ') + ' \u2026(+' + (arr.length - 12) + ')' : arr.join(', '));
  const preview = plan && plan.ok
    ? ' ' + t('Will remove {count} item(s): {list}.', { count: plan.remove.length, list: clip(plan.remove) || t('nothing') }) +
      (plan.restore.length ? ' ' + t('Will restore: {list}.', { list: clip(plan.restore) }) : '') +
      (plan.kept.length ? ' ' + t('Left alone: {list}.', { list: plan.kept.join('; ') }) : '')
    : '';
  flipToConfirm(card, {
    title,
    detail: (lead ? lead + ' ' : '') + t('Removes everything this app put in the game folder -- DLSS 5, the Feeder or Luma UE, Streamline, REFramework, swapped DLLs, its markers -- and puts back anything it renamed or replaced. No terminal.') + preview,
    ...(confirmLabel ? { confirmLabel } : {}),
    onConfirm: async () => {
      const res = await window.api.runUninstall(game.exePath);
      if (res.ok) {
        await removeLosslessProfile(game);
        launchIssues.delete(game.exePath);
      }
      toast(res.ok ? describeUninstall(res) : t("Couldn't remove OptiScaler: {error}", { error: res.error }));
      renderGrid();
    }
  });
}

// ── A launch that went wrong (main.js watches it, launchwatch.js decides) ────────────────────
//
// Kept per game until the next launch runs cleanly or the files are restored, so a re-render of the
// grid does not lose it. Never acted on here: the card offers the restore, the user clicks it.
const launchIssues = new Map();

function launchIssueText(notice, name) {
  const ac = notice.antiCheat;
  if (notice.kind === 'never-started') {
    return t('{name} never started. {antiCheat} is in its folder and usually refuses to run a game with OptiScaler\'s DLL beside it -- often without any message. Use this app\'s Launch button (it starts the game without the anti-cheat where it can), or restore the original files to play online.', { name, antiCheat: ac });
  }
  const when = notice.firstRun
    ? t('{name} closed {seconds} s after starting -- its first run since this app installed to it.', { name, seconds: notice.upSeconds })
    : t('{name} closed {seconds} s after starting.', { name, seconds: notice.upSeconds });
  const why = ac
    ? ' ' + t('{antiCheat} is in its folder, and anti-cheat closing a modded game is the most likely reason.', { antiCheat: ac })
    : ' ' + t('If it did not do that before, what this app installed is the likely reason. Game Help can say more from its log; restoring the original files puts it back as it was.');
  return when + why;
}

function setLaunchIssue(notice) {
  const card = cardsByExe.get(notice.exePath);
  if (notice.kind === 'ok') {
    if (!launchIssues.delete(notice.exePath)) return;
  } else {
    launchIssues.set(notice.exePath, notice);
    // A game DLSS 5 is on that closed early is a failure for the ladder, judged as the render would.
    if (card && card._failCtx && card._game) {
      const ev = failureEvidence(card._game, { ...card._failCtx, issue: notice });
      if (ev && ev.code === 'early-exit') {
        card._state.problem = failureProblem(card, card._game, ev);
        showFailure(card, card._game, ev, card._failCtx);
      }
    }
  }
  if (card) refreshCardState(card);
}

function offerRestore(card, game, notice) {
  confirmRemoveOnCard(card, game, {
    title: t('Restore the original files?'),
    lead: launchIssueText(notice, game.name),
    confirmLabel: t('Restore originals'),
  });
}

window.api.onLaunchOutcome((notice) => {
  if (!notice || !notice.exePath) return;
  // Stamped here: it is what tells this early exit from the last one (failureEvidence's signature).
  notice.at = Date.now();
  setLaunchIssue(notice);
  if (notice.kind === 'ok') return;
  const game = games.find((g) => g.exePath === notice.exePath);
  toast(launchIssueText(notice, game ? game.name : String(notice.exePath).split(/[\\/]/).pop()));
});

// ── Antivirus took a file (defender.js) ───────────────────────────────────────────────────────
//
// Said as what happened and what to do about it, not as an install error: retrying does not help,
// and a second install would be taken the same way.
function quarantineText(report, fallbackFile) {
  const hits = report && Array.isArray(report.defender) ? report.defender : null;
  const named = hits && hits.length ? [...new Set(hits.map((h) => String(h.file).split(/[\\/]/).pop()))].join(', ') : '';
  const files = (report && report.missing && report.missing.length) ? report.missing.join(', ') : named || fallbackFile;
  if (hits && hits.length) {
    const threat = hits[0].threat || t('a detection');
    return t('Windows Defender removed {files} right after being placed ({threat}). These files are what this app installs, not something picked up elsewhere. Add an exclusion for this game\'s folder first -- Windows Security > Virus & threat protection > Manage settings > Exclusions -- then press Install again. That is the step that makes it stick. Protection history may also list the item under Actions > Allow, which saves re-copying it, but a detection whose name ends in !cl was made in the cloud and those are often deleted outright rather than held, so there may be nothing there to restore.', { files, threat });
  }
  if (hits) {
    return t('{files} disappeared right after being placed, and Windows Defender has no record of it -- another antivirus probably took it. Allow the file in that antivirus (or exclude this game\'s folder), then press Install again.', { files });
  }
  return t('{files} disappeared right after being placed -- that is what antivirus quarantine looks like. Exclude this game\'s folder in Windows Security (or your own antivirus), then press Install again. Restoring the file from Protection history is worth doing if the entry is there, but the exclusion is what stops it happening again.', { files });
}

async function showQuarantineNotice(report, fallbackFile) {
  const text = quarantineText(report, fallbackFile);
  toast(text);
  if (window.confirm(text + '\n\n' + t('Open Windows Security\'s protection history now?'))) {
    await window.api.openProtectionHistory();
  }
}

// Called after an install reports success: did something take its files a moment later?
async function checkQuarantineAfterInstall(game) {
  let report = null;
  try { report = await window.api.safetyCheckInstalled(game.exePath); } catch {}
  if (report && report.ok && report.missing && report.missing.length) {
    await showQuarantineNotice(report, report.missing.join(', '));
    renderGrid();
  }
}

function flipToConfirm(card, { title, detail, onConfirm, confirmLabel = t('Remove'), danger = true }) {
  // The back face is shared with the failure ladder below; a confirm always shows its own two buttons.
  card.querySelector('.card-remove-actions').classList.remove('hidden');
  card.querySelector('.card-fail-actions').classList.add('hidden');
  card.querySelector('.card-fail-status').classList.add('hidden');
  card.querySelector('.card-remove-title').textContent = title;
  card.querySelector('.card-remove-detail').textContent = detail;
  const confirmBtn = card.querySelector('.btn-flip-confirm');
  confirmBtn.textContent = confirmLabel;
  confirmBtn.classList.toggle('btn-danger', danger);
  confirmBtn.classList.toggle('btn-primary', !danger);
  card._onFlipConfirm = onConfirm;
  card.classList.add('flipped');
}

// ── A game DLSS 5 did not work on: the card turns round and says what to try next ────────────────
//
// The ladder, in order: DLSS 5 -> DXVK in front of it, where the game can take DXVK -> Deep Fried
// Chicken in place of it, where Chicken supports the game -> report it. Each rung is offered once;
// what was tried is remembered on the game (game.fallback), so the next failure moves down a rung
// instead of offering the same thing again. This replaced the card's "no known fix" lines: a player
// who hit one of those was left with nothing to press.
//
// What counts as failed: DLSS 5 is installed here (ours or Chicken) and either the last launch closed
// early, or the last run's log says it crashed or the pass never ran, or Game Help has no fix for what
// it found. A diagnosis WITH a fix keeps its own "Fix it" button: that is a known answer, not a dead end.
// Anti-cheat refusing the game is not DLSS 5 failing, so that keeps its restore offer.
// Crashes and a pass that could not run. NOT 'init-no-feature' or 'no-dlss': those mean the game never
// asked for DLSS on that run, which is nearly always DLSS switched off in the game's own settings -- DOOM:
// The Dark Ages read as failed while working (2026-09-25). Nor the Feeder's motion/depth quality
// verdicts: the game ran, it just looks rougher. Those keep their own hint rows.
const FAILED_RUN_VERDICTS = ['duplicate-dlss', 'shutdown-fault', 'ue-crash', 'wrapper-crash', 'feed-stopped', 'feed-host-gone',
  'feed-agility-redist', 'dlss-no-nr', 'nr-model-crash'];
// Game Help codes that are the same "DLSS was never switched on" as above, whatever status they carry.
const DLSS_NOT_ASKED = ['init-no-feature', 'no-dlss', 'no-hook'];

function fallbackOf(game) {
  return game.fallback || (game.fallback = { tried: [], at: 0, seen: null });
}

// The evidence for "it failed", or null. Only evidence newer than the last rung tried counts: after a
// switch to DXVK the old run's crash is about the old setup, and until the game runs again there is
// nothing to say about the new one.
function failureEvidence(game, { route, diag, run, issue }) {
  const installed = !!(route && (route.optiInstalled || route.consumerHere));
  if (!installed) return null;
  const since = fallbackOf(game).at || 0;
  if (issue && issue.kind === 'early-exit' && !issue.antiCheat && (issue.at || Date.now()) > since) {
    return { sig: `exit:${issue.at || ''}`, when: issue.at || Date.now(), text: launchIssueText(issue, game.name), code: 'early-exit' };
  }
  const runAt = run && run.at ? new Date(run.at).getTime() : 0;
  if (runAt && runAt <= since) return null;
  if (run && run.ran && FAILED_RUN_VERDICTS.includes(run.verdict)) {
    return { sig: `run:${run.at}:${run.verdict}`, when: runAt, text: describeRun(run), code: run.verdict };
  }
  // Game Help with no fix for what it found. No run is needed: an install it already knows cannot work
  // (a 32-bit game where the route has no pass, say) is a dead end the ladder should take over too.
  if (diag && diag.ok && (diag.status === 'unavailable' || diag.status === 'unknown') && !DLSS_NOT_ASKED.includes(diag.code)) {
    return { sig: `help:${(run && run.at) || 'norun'}:${diag.code}`, when: runAt, text: helpWords(diag), code: diag.code };
  }
  return null;
}

// The rungs still to try on this game, in ladder order.
function fallbackOffers(game, route) {
  const tried = new Set(fallbackOf(game).tried);
  if (route && route.dxvkDeployed) tried.add('dxvk');
  if (route && route.consumerHere === 'dfc') tried.add('dfc');
  const offers = [];
  const swap = layerSwapFor(route);
  if (swap && swap.id === 'swap-to-dxvk' && !tried.has('dxvk')) offers.push('dxvk');
  if (route && route.dfcSupport && route.dfcSupport.ok && route.consumerHere !== 'dfc' && !tried.has('dfc')) offers.push('dfc');
  return offers;
}

async function tryFallback(card, game, rung) {
  const fb = fallbackOf(game);
  card.classList.remove('flipped', 'card-spin');
  launchIssues.delete(game.exePath);
  const before = fb.tried.slice();
  if (!fb.tried.includes(rung)) fb.tried.push(rung);
  fb.at = Date.now();
  saveGamesSoon();
  if (rung === 'dxvk') {
    const res = await applyLayerSwap(game, 'swap-to-dxvk');
    if (res && res.ok && res.done) { toast(t('DXVK is in. Launch the game again to see if DLSS 5 works now.')); return; }
  } else {
    await switchNeuralPass(game, 'dfc');
    if (game.neuralConsumer === 'dfc') { toast(t('Deep Fried Chicken is in. Launch the game again to see if it works now.')); return; }
  }
  // Cancelled or refused: the rung is still there to try.
  fb.tried = before;
  fb.at = 0;
  saveGamesSoon();
  renderGrid();
}

function flipToFailure(card, game, { spin = false } = {}) {
  const f = card._failure;
  if (!f) return;
  const offers = fallbackOffers(game, f.route);
  card.querySelector('.card-remove-actions').classList.add('hidden');
  const box = card.querySelector('.card-fail-actions');
  const status = card.querySelector('.card-fail-status');
  status.classList.add('hidden');
  status.innerHTML = '';
  box.classList.remove('hidden');
  box.innerHTML = '';
  const button = (label, cls, run) => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', run);
    box.appendChild(b);
    return b;
  };
  card.querySelector('.card-remove-detail').textContent = f.text;
  card.querySelector('.card-remove-detail').title = f.text;
  if (offers.length) {
    card.querySelector('.card-remove-title').textContent = t('DLSS 5 did not work on {name}', { name: game.name });
    for (const rung of offers) {
      button(rung === 'dxvk' ? t('Try with DXVK') : t('Try with Deep Fried Chicken'), offers[0] === rung ? 'btn-primary' : 'btn-ghost', () => tryFallback(card, game, rung));
    }
  } else {
    const tried = fallbackOf(game).tried;
    card.querySelector('.card-remove-title').textContent = tried.length
      ? t('Nothing worked on {name} yet', { name: game.name })
      : t('DLSS 5 did not work on {name}', { name: game.name });
    const send = button(t('Report issue'), 'btn-primary', async () => {
      send.disabled = true;
      try {
        await sendGameFailure(game, { ...f.diag, code: (f.diag && f.diag.code) || f.code, run: f.run }, {
          setStatus: (html) => { status.innerHTML = html; status.classList.toggle('hidden', !html); },
          tried,
        });
      } finally { send.disabled = false; }
    });
    if (f.route && f.route.optiInstalled) {
      button(t('Restore the original files'), 'btn-ghost', () => { card.classList.remove('card-spin'); confirmRemoveOnCard(card, game, { title: t('Restore the original files?'), confirmLabel: t('Restore originals') }); });
    }
  }
  button(t('Not now'), 'btn-ghost', () => card.classList.remove('flipped', 'card-spin'));
  card.classList.toggle('card-spin', spin);
  card.classList.add('flipped');
}

// The front's problem row for a failure: short words, and the button that turns the card again.
function failureProblem(card, game, evidence) {
  const next = fallbackOffers(game, (card._failCtx || {}).route).length ? t('What to try next') : t('Report issue');
  return { bad: true, failure: true, text: t('DLSS 5 did not work here'), title: evidence.text, action: { label: next, run: () => flipToFailure(card, game) } };
}

// Turns the card for a failure it has not shown yet; one it already showed stays on the front, with the
// problem row's button to turn it again.
function showFailure(card, game, evidence, ctx) {
  card._failure = { ...evidence, ...ctx };
  const fb = fallbackOf(game);
  if (fb.seen === evidence.sig) return;
  fb.seen = evidence.sig;
  saveGamesSoon();
  // Only a failure from the last day turns the card on its own. Opening this build for the first time
  // would otherwise spin every card with an old crash in its log at once; those keep the row's button.
  if (!evidence.when || Date.now() - evidence.when > 24 * 3600 * 1000) return;
  // After the grid has painted, so the turn is seen rather than landing already turned.
  setTimeout(() => { if (card.isConnected) flipToFailure(card, game, { spin: true }); }, 350);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ── Game Help ─────────────────────────────────────────────────────────────────
// Tier one: the rule table in src/gamehelp.js, through game:help. Tier two: Ask AI, through
// game:help-ai, on the user's own key. Both end in words on this modal.
const helpModal = $('#help-modal');
let helpGame = null;
let helpFixesTried = [];
let helpDiag = null;
let helpPoll = null;
let helpLastRunAt = null;
// The fixes applied this session, per game, as { id, runAt } (see gamehelp.js): the modal and
// the card read the same list, so a card does not offer "Fix it" again for a fix that is only
// waiting on the next run.
const helpTriedByGame = new Map();
const helpTriedFor = (game) => helpTriedByGame.get(game.exePath) || [];

// A route key (route.js, routescore.js) as words, with its wrapper where it has one.
function routeName(route, via = null) {
  const names = {
    optiscaler: t('DLSS 5 on the game\'s own DLSS'), 'nr-model-only': t('the model file alone'),
    feeder: t('the DLSS5 Feeder'), feeder32: t('the 32-bit Feeder'), lumaue: t('Luma'),
    present: t('the Present route'), 'reframework-pd': t('the REFramework Present route'), amdnr: t('DLSS NR on AMD'),
  };
  const vias = { dgvoodoo: t('with dgVoodoo2'), dxvk: t('with DXVK'), native: t('on its own Direct3D') };
  const name = names[route] || String(route || '?');
  return via && vias[via] ? `${name} ${vias[via]}` : name;
}

// The one sentence about an emulator's renderer (route.emulatorRenderer, emulators.rendererAdvice),
// for the card's hover text, the install toast and Game Help.
function emulatorRendererWords(r) {
  if (r.openglOnly) return t('{name} only renders with OpenGL, and DLSS 5 cannot draw its panel over OpenGL. Use the pop-out panel to change DLSS 5 settings.', r);
  if (r.seen) return t('{name} last ran on {seen}, but DLSS 5 is set up for {renderer}. Set its renderer to {renderer} ({hint}) and start it again.', r);
  return t('Set {name}\'s renderer to {renderer} ({hint}) before you play. DLSS 5 is set up for {renderer}; on any other renderer it will not load.', r);
}

function helpWords(diag) {
  const v = diag.vars || {};
  switch (diag.code) {
    case 'dfc-hand-placed': return t('Deep Fried Chicken was copied into this folder by hand ({files}). Switch this game to Chicken from its ⋯ menu and the app takes it over, or delete those files to stay on DLSS 5.', v);
    case 'dfc-here': return v.state
      ? t('This game is switched to Deep Fried Chicken, so OptiScaler is not in the folder on purpose. Chicken last reported {state} (ARMED means it is running).', v)
      : t('This game is switched to Deep Fried Chicken, so OptiScaler is not in the folder on purpose. Chicken has not written a log yet: launch the game, press Home and open its tab.');
    case 'emulator-renderer': return t('{name} ran and nothing called DLSS. DLSS 5 is set up for {renderer}, so {name} has to render with it -- on any other renderer there is nothing for it to hook.', v);
    case 'emulator-renderer-mismatch': return emulatorRendererWords(v);
    case 'catalog-prefers': return t('What is known about this game points away from the route the app picked ({pick}): {why}. {route} has the better record here, and Fix it switches to it.', {
      pick: routeName(...String(v.pick || '').split(':')), route: routeName(v.route, v.via),
      why: v.why ? t(v.why, v.whyVars || {}) : t('it has failed here before'),
    });
    case 'bit32': return t('DLSS 5 is not currently available for this game: it is a 32-bit game, and OptiScaler and the NR model are 64-bit only.');
    case 'dgvoodoo-missing': return t('This DirectX 9 game needs dgVoodoo2 in front of it before the DLSS5 Feeder can work. Install puts it there.');
    case 'anticheat': return t('This game runs under {antiCheat}. It will very likely stop the DLL every DLSS 5 route relies on from loading at all -- often with no message -- so there is a good chance nothing happens. And going online with these files in place can get the account BANNED.\n\nThe app no longer decides this for you: Install is offered, single-player only, and Remove puts the game back exactly as it was. Your account, your call.', v);
    case 'anticheat-launch-direct': return t('Nothing has been logged, and on this game that is expected: Steam starts it through {stub}, which starts {antiCheat} first, and {antiCheat} will not let the game run with OptiScaler\'s DLL in the folder -- it fails without writing a single log. Use this app\'s own Launch button: it starts the game\'s exe directly, so {antiCheat} never loads. Single-player works; online play and matchmaking do not, and going online with these files can get the account banned -- Remove puts the game back before you do.', v);
    case 'unsupported': return t('DLSS 5 is not currently available for this game: {reason}', v);
    case 'foreign': return t('Another DLSS 5 toolchain is in this folder ({tool}). Two stacks hooking the same DLSS call crash the game. Remove it first.', v);
    case 'feeder-misdeployed': return t('The DLSS5 Feeder is deployed on a game that ships its own DLSS. Two DLSS DLLs load and the game crashes. Remove the Feeder; OptiScaler alone is the route here.');
    case 'luma-known-bad': return t('Luma UE is deployed here, and this game is known not to work with it ({reason}). Remove Luma UE.', v);
    case 'not-installed': return t('DLSS 5 is not installed on this game yet. Install it and the route\'s other steps follow.');
    case 'feeder-missing': return t('This game has no DLSS of its own, so OptiScaler alone has nothing to hook. Install deploys the DLSS5 Feeder first.');
    case 'luma-missing': return t('This game gets its DLSS call from Luma, which is not set up yet. Fix it sets up OptiScaler and Luma together (after you confirm Luma\'s licence). Luma runs on DirectX 11.');
    case 'reframework-missing': return t('This is an RE Engine game and REFramework is missing. OptiScaler does nothing there without it. Reconfigure fetches and places it.');
    case 'pd-temporal-on': return t('REFramework\'s TemporalUpscaler is still switched on from the old setup. DLSS 5 now runs on top of the game\'s own anti-aliasing, so that mod has to be off. Reconfigure switches it off.');
    case 'pd-build-missing': return t('This Resident Evil has no DLSS of its own, so it needs REFramework\'s pd-upscaler build and nvngx_dlss.dll beside the exe. Reconfigure fetches and places both.');
    case 'pd-plugin-missing': return t('One file this app cannot fetch: PureDark\'s Upscaler Base Plugin (PDPerfPlugin.dll), free on Nexus Mods. Take version 1.1.2 specifically -- the link opens it -- because 1.2.0 does not load the back-end properly and the upscaler then does nothing. Download it once, then press "I downloaded it" -- the app finds it in Downloads and puts it in every Resident Evil that needs it. REFramework\'s upscaler loads it and makes the DLSS call OptiScaler hooks.');
    case 'pd-enable-ingame': return t('Everything is in place but the last run made no DLSS call. In-game, press Insert for REFramework\'s menu, open TemporalUpscaler, tick Enabled and set Upscale Type to DLSS. Then play a minute and quit.');
    case 'needs-run': return t('No run to judge yet. Launch the game, reach actual gameplay (not a menu), play a minute, then quit. Come back here and it is checked.');
    case 'needs-run-after-fix': return t('"{fix}" was applied. The old log still says what it said, so launch the game, reach gameplay, play a minute, quit, and this is checked again.', { fix: helpFixLabel(v.fix) });
    case 'ok': return t('DLSS 5 is working here: Neural Rendering ran {count} passes on the last run{fps}{api}.', { count: v.count, fps: v.fps ? ' ' + t(' at {fps} fps', { fps: v.fps }) : '', api: v.api ? ' (' + v.api + ')' : '' });
    case 'ok-panel-in-helper': return t('DLSS 5 is working here: Neural Rendering ran {count} passes on the last run{fps}. A 32-bit game cannot run DLSS itself, so the neural pass and OptiScaler run in the 64-bit helper beside the game. Press Insert in the game for the DLSS 5 panel: the helper draws it, the game shows it over itself, and its controls take clicks there -- the same key as every other game.', { count: v.count, fps: v.fps ? ' ' + t(' at {fps} fps', { fps: v.fps }) : '' })
      // Assassin's Creed II (2026-09-18): the picture, UI included, jumped on VORT.
      + (v.otherMv ? ' ' + t('If the picture jumps or smears when things move, try LumeniteFX for motion vectors instead of {provider}: card menu > Motion vectors > change.', { provider: v.otherMv }) : '');
    case 'ok-exit-crash': return t('Neural Rendering ran ({count} passes). The game crashed only on the way out, inside NVIDIA\'s shutdown, which does not affect play.', v);
    case 'd3d11-native': return t('DLSS was created on the native D3D11 path, so the Neural Rendering pass never ran. Dx11Upscaler must be dlss_12. Reconfigure writes it.');
    case 'nr-disabled': return t('DLSS ran but Neural Rendering is switched off in OptiScaler.ini. Reconfigure turns it on.');
    case 'dlss-no-nr': return t('DLSS was created and Neural Rendering is on, yet the pass never ran. This is not a known case. Save the bundle to share, or ask the AI.');
    case 'foreign-optiscaler': return t('Another OptiScaler build is in this folder as {file}, and it is not the one this app installed. That copy is what the game loads and what answers the DLSS calls -- an upstream OptiScaler has no neural pass, so DLSS 5 can never run while it is there, however complete everything else looks. Delete {file} (it is not ours to remove for you), then press Install here.', v);
    case 'asi-optiscaler': return t('OptiScaler is here as {file}, an ASI loader\'s plugin. This app never installs it that way -- it always uses a proxy DLL name -- so that copy is not ours, and it is the one the game loads and the one that answers the DLSS calls. Whatever this app has put beside it makes no difference while it is there. Remove {file} (it is not ours to remove for you), then press Install here.', v);
    case 'dlss-runtime-missing': return t('OptiScaler switched DLSS off a second into the run, because nvngx_dlss.dll is not beside the game exe -- its log says so in as many words. Nothing this app builds can make a DLSS call without it: not the Feeder\x27s synthesised one, not REFramework\x27s upscaler on a Resident Evil, not a DLSS 5 only profile. On this route the deploy fetches and places it, so running that again puts it back.');
    case 'dlss-runtime-stub': return t('There is an nvngx_dlss.dll beside the game exe, but it is only {bytes} bytes -- far too small to be a DLL. It is a placeholder, a failed download, or a marker left by another DLSS tool. This is worse than the file being missing: OptiScaler checks the name, finds it, writes "Enabling DLSS" in its log and carries on, so everything downstream looks switched on while nothing can load it. Fix it deletes the placeholder and puts a real copy there.', v);
    case 'optiscaler-no-native-dlss': return t('This game was routed as one that ships its own DLSS, and the last run says no DLSS call came: OptiScaler loaded, saw the game draw, and no DLSS call ever came. That routing rests on a single {file} sitting beside the game exe, which any DLSS tool could have left there -- not on finding the game\'s own DLSS in its files. If this game really has DLSS or DLAA in its graphics settings, turn it on and run again. If it has no upscaler at all, {file} is not the game\'s: delete it (it is not ours to remove for you) and press Install again, and the app will set up the Feeder route instead, which gives OptiScaler a DLSS call to hook.', v);
    case 'feeder-incomplete': return t('The Feeder is deployed here, but not all of it arrived: {missing} still missing. The add-on cannot load without those, so nothing feeds DLSS and the game runs as if none of this were installed. Install again puts them back. If it keeps failing at the same piece, the download is being blocked rather than the game refusing it.', v);
    case 'feeder-technique': return t('DLSS initialised but the Feeder\'s shader technique was missing. Install again to redeploy the Feeder.');
    case 'luma-select-dlss': return t('Luma UE is deployed but no DLSS call happened. In-game, press Home for Luma\'s overlay and select DLSS as the upscaler, in gameplay. Then check again.');
    case 'init-no-feature': return t('DLSS initialised but no feature was ever created. This is not a known case. Save the bundle to share, or ask the AI.');
    case 'vulkan-layer-missing': return t('On Vulkan, the DLSS5 Feeder runs inside ReShade, and ReShade only reaches a Vulkan game as a layer installed for the whole PC. None is installed, so the Feeder never loaded and nothing called DLSS. Run ReShade\'s own installer (the version with add-on support), pick this exe, choose Vulkan, then Install here again. Or switch the emulator to Direct3D 11, if it has it, and pick DX11 in Edit: that needs no layer. Not OpenGL: DLSS 5 cannot draw its panel there.');
    case 'vulkan-layer-no-addon': return t('ReShade is installed as a Vulkan layer on this PC, but a build without add-on support, so the DLSS5 Feeder (an add-on) cannot load and nothing called DLSS. Reinstall ReShade with add-on support (its installer: "Enable loading of add-ons"), then Install here again.');
    case 'host32-opti-dll-gone': return t('OptiScaler\'s own file is missing from the helper folder. This app put it there -- its install record lists host64\\winmm.dll -- and it is not on disk now, so something removed it after the install. That is almost always antivirus: a 64-bit winmm.dll appearing beside a game exe looks exactly like a DLL hijack. Everything else is fine, which is why the Feeder\'s own window opens and the DLSS 5 overlay is not in it. Add an exclusion for this game\'s folder -- Windows Security > Virus & threat protection > Manage settings > Exclusions -- and then press Install here again. Do the exclusion first: without it, Install just puts the file back for it to be taken again. Protection history may also offer Allow for the item, but a cloud detection (a name ending in !cl) is often deleted rather than held, so do not count on finding one.');
    case 'host32-exe-gone': return t('The helper program is missing from the helper folder. This app put it there -- its install record lists host64\\dlss5-feed-host64.exe -- and it is not on disk now, so something removed it after the install. A 64-bit exe appearing beside a game is the same thing antivirus takes a 64-bit winmm.dll for. Without it there is no helper to start, so the game renders perfectly and DLSS 5 does nothing at all. Add an exclusion for this game\'s folder -- Windows Security > Virus & threat protection > Manage settings > Exclusions -- and then press Install here again. Do the exclusion first: without it, Install just puts the file back for it to be taken again.');
    case 'feed-host-gone': return t('The DLSS work for a 32-bit game runs in a second program, a 64-bit helper beside the game, and this run it went away -- so the game kept rendering normally and DLSS 5 stopped. The Feeder\'s own words for why: {why}. The helper writes its own log, host64\\dlss5-feed-host.log beside the game, and that names the reason; this app cannot see inside another program, so that file is the next thing to read rather than anything to guess at. Save the bundle to share -- it now carries that log -- or ask the AI.');
    case 'feed-host-startup': return t('The 64-bit helper that does the DLSS work for this game quit as it started: {why}. That is the add-on and the helper not being the same Feeder build, or a file missing from host64\\ -- both of which Install rebuilds from one download. Press Install here again, then launch.');
    case 'vulkan-layer-blacklisted': return t('{exe} refuses Vulkan layers. Its engine keeps a blacklist and ReShade is on it, so the layer is installed correctly, this exe is on its list, and it still never attaches -- nothing here is broken. Add {arg} to the game\'s launch arguments: in Steam, right-click the game > Properties > Launch Options; in a desktop shortcut, after the closing quote of the exe path. Then launch again.', { ...v, arg: '+r_allowBlackListedLayers 1' });
    case 'vulkan-layer-not-loaded': return t('ReShade\'s Vulkan layer with add-on support is installed, but it did not load in this program: the DLSS5 Feeder wrote no log at all. Run ReShade\'s installer once more for this exact exe and choose Vulkan (the layer only runs for programs it was set up for), check NVIDIA Smooth Motion is off for it, then launch again.');
    case 'vulkan-layer-app-not-listed': return t('ReShade\'s Vulkan layer with add-on support is installed, but {exe} is not on its app list (ReShadeApps.ini next to the layer), so the layer stays inert in this game: no overlay, no DLSS5 Feeder, no log. ReShade\'s own installer adds it -- run it, pick this exact exe, choose Vulkan and keep "Enable loading of add-ons" ticked -- then launch again.', v);
    case 'opti-proxy-name': return t('The DLSS5 Feeder ran and reported OptiScaler as not present: it is installed here as {from}, and nothing in this game loads a DLL of that name (a DirectX 9, Vulkan or OpenGL game never loads a dxgi.dll from its folder), so the Feeder fed plain DLAA with no neural pass. This game loads {to}. Reconfigure moves OptiScaler to that name.', v);
    case 'dxvk-blocked-game': return t('{game} is on DXVK, and on Windows DXVK makes this game\'s camera shake: the game passes a jumping camera matrix to every Direct3D 9 translator except dgVoodoo2 (DXVK issue #2249). Nothing in DXVK, ReShade or the Feeder can fix that, so the fix is to go back to dgVoodoo2.', v);
    case 'dgvoodoo-no-dlss': return t('The game ran and nothing called DLSS. On this route dgVoodoo2 is the layer that has to present a swapchain for OptiScaler to hook, so when a run has no DLSS in it at all -- including a game that runs but shows a black screen -- the wrapper is the first suspect, not the last. DXVK does the same job through Vulkan instead of Direct3D 11. Neither is better everywhere, and nothing here can tell which way it went until you run the game again.', v);
    case 'dxvk-no-dlss': return t('The game ran under DXVK and nothing called DLSS. DXVK was the other layer to try, and it did no better here, so dgVoodoo2 is worth having back -- or, if dgVoodoo2 could not draw this game either, Remove puts the folder back as it was. Nothing here can tell which layer suits a game until it is run.', v);
    case 'dxvk-crash-swap': return t('The game crashed as it started, inside DXVK\'s {dll}. dgVoodoo2 does the same job through Direct3D 11 instead of Vulkan; Fix it puts it back in DXVK\'s place, with whatever DXVK displaced handed back first.', v);
    // A 32-bit DirectX 10/11 game on DXVK: the other side of the bet is its own Direct3D, not dgVoodoo2.
    case 'dxvk-no-dlss-native': return t('The game ran under DXVK and nothing called DLSS. On a DirectX 10/11 game DXVK stands in for the game\'s own Direct3D, which the DLSS5 Feeder reaches directly through the game-folder ReShade, so native is worth having back. Nothing here can tell which suits a game until it is run.', v);
    case 'dxvk-crash-native': return t('The game crashed as it started, inside DXVK\'s {dll}. Fix it takes DXVK back out and returns the game to its own Direct3D, with whatever DXVK displaced -- and the game-folder ReShade -- handed back.', v);
    case 'dxvk-crash': return t('The game still crashes inside {dll} with either layer in front of it. Remove puts the folder back as it was.', v);
    case 'dxvk-layer-missing': return t('DXVK presents this game through Vulkan, so ReShade -- and the DLSS5 Feeder add-on that rides on it -- can only reach it as ReShade\'s 32-bit Vulkan layer. That layer is {why} for {exe}, so the add-on never loads and DLSS 5 cannot run. Fix it runs ReShade\'s own setup again (it asks for administrator permission and installs the layer for the whole PC, switched on for this game).', { ...v, why: v.why === 'no-addon' ? t('a build without add-on support') : v.why === 'not-listed' ? t('installed but not switched on') : t('not installed') });
    case 'dxvk-reshade-ini-missing': return t('DXVK presents this game through Vulkan, and ReShade\'s Vulkan layer only starts in a game whose folder has a ReShade.ini -- this one has none any more, so the DLSS5 Feeder add-on cannot load. Install puts the Feeder\'s files, ReShade.ini among them, back.');
    case 'dxvk-two-reshades': return t('{file} beside the game is ReShade again, while DXVK sends the game through ReShade\'s Vulkan layer too. Two ReShades in one game fight over the frame. Switch the game back off DXVK (More…), or move {file} out of the folder.', v);
    case 'dxvk-addon-not-loaded': return t('The game ran under DXVK and ReShade\'s Vulkan layer loaded (it wrote ReShade.log), but the DLSS5 Feeder add-on did not: dlss5-feed.log has not been written since the swap. Open ReShade\'s overlay in the game (Home) and look at its Add-ons tab for DLSS 5 Feed and any error beside it; ReShade.log in the game folder names add-ons it refused. If it is not there at all, switch the game back off DXVK.', v);
    // Worded for both routes DXVK serves: in place of dgVoodoo2 (DX8/9) or of native Direct3D (32-bit DX10/11).
    case 'dxvk-needs-run': return t('DXVK is in front of the game, and it has not been run since. Launch it, reach gameplay, play a minute and quit. If ReShade.log and dlss5-feed.log in the game folder are still older than the swap after that, ReShade\'s Vulkan layer did not attach to this game.');
    case 'dxvk-panel-fullscreen': return t('DLSS 5 is working here: Neural Rendering ran {count} passes on the last run. But the game was in exclusive fullscreen when the DLSS5 Feeder started its helper, so the helper has no window and the Insert panel has nothing to show -- under dgVoodoo2 this app held the game borderless, and DXVK has no such setting. Switch the game to borderless or windowed in its own options and restart it for the panel.', v);
    case 'nr-model-only': return t('The game never loaded OptiScaler ({file}), and it does not need to: this game ships its own DLSS, so Neural Rendering only wants the model file beside the exe -- the game\'s own Streamline loads it and the driver dispatches the pass. Taking OptiScaler out removes the one thing this app put into the game\'s loader, which is what a game that will not start with it needs. The cost is the in-game panel and the DLSS 5 controls that live on it; Install puts them back.', v);
    case 'opti-not-loaded': return t('The DLSS5 Feeder ran and reported OptiScaler as not present: the game never loaded {file}, so the Feeder\'s DLSS calls went to the driver and no neural pass ran. OptiScaler has to sit under a DLL name this exe imports at start (winmm.dll or version.dll suit most games; never dxgi.dll on a Vulkan, OpenGL or DirectX 9 game). Rename it in the game folder, then launch again -- or save the bundle so the name can be picked from the exe.', v);
    case 'opti-not-fork': return t('The DLSS5 Feeder found a stock OptiScaler in this game, not the DLSS-NR fork: it takes the DLSS calls and upscales, and no neural pass can ever run. Install puts the fork this app ships back in its place.');
    case 'opti-not-routed': return t('OptiScaler is loaded, but the driver answered the DLSS5 Feeder\'s NGX probe instead of it, so its neural pass never sees a frame. OptiScaler.ini decides that with two keys ([Inputs] EnableDlssInputs and [Hooks] HookOriginalNvngxOnly); Reconfigure sets both back to the values the redirect needs.');
    case 'feed-vulkan-interop': return (v.hook === 'not-installed'
      ? t('The DLSS5 Feeder stopped before its first frame: the Vulkan interop extensions it needs were not on the game\'s device, because its hook on vkCreateDevice could not be installed.')
      : v.hook === 'never-called'
        ? t('The DLSS5 Feeder stopped before its first frame: the Vulkan interop extensions it needs were not on the game\'s device -- its hook on vkCreateDevice was installed but this game creates its device some way the hook does not intercept.')
        : t('The DLSS5 Feeder stopped before its first frame: the Vulkan interop extensions it needs were not on the game\'s device.')) + ' ' +
      t('The Feeder\'s own fallback is its out-of-process layer: in its release zip, run layer\\run-with-feed-layer.bat with the path to this game\'s exe. This app does not deploy that layer; dlss5-feed.log has the driver\'s answer above the stop line.');
    case 'asi-loader-blind': return t('Nothing called DLSS on the last run -- but there is an ASI loader in this folder, with {count} plugin(s) beside the game: {files}. This app installs OptiScaler under a proxy DLL name and reads the folder by those names, so it cannot see what an ASI loader loads, and the findings here may be about the wrong files entirely. Check what your .asi plugins are doing first. If none of them is an upscaler, save the bundle to share, or ask the AI.', v);
    case 'no-hook': return t('Nothing called DLSS on the last run, so nothing was hooked. Check the game\'s own graphics settings have DLSS or DLAA selected. If they do, this is not a known case: save the bundle or ask the AI.');
    case 'ue-crash-luma': return t('The game crashed (Unreal crash report: {message}) with Luma UE deployed, and Luma is not verified on this game. Remove Luma UE and try the Feeder route.', { message: (v.message || '').slice(0, 120) });
    case 'ue-crash-feeder': return t('The game crashed (Unreal crash report: {message}) with the Feeder deployed. Remove the Feeder and check whether it runs clean.', { message: (v.message || '').slice(0, 120) });
    case 'ue-crash': return t('The game crashed (Unreal crash report: {message}). No rule covers this. Save the bundle to share, or ask the AI.', { message: (v.message || '').slice(0, 120) });
    case 'luma-available': return t('The DLSS5 Feeder is running this game, but Luma-Framework has a mod for it that adds real DLSS with the game\'s own motion vectors -- sharper in motion than the Feeder\'s estimate. Switching removes the Feeder and sets up Luma (after you confirm its licence). Luma runs on DirectX 11.');
    case 'luma-needs-dx11': return t('Luma is set up here, but the game last ran on DirectX 12, where Luma does not load. Switch the game to DirectX 11 in its own graphics settings, then launch again.');
    case 'driver-outdated': return (v.min
      ? t('Your NVIDIA driver is too old for DLSS 5: it reported Neural Rendering as out of date, and it needs {min} or newer.', v)
      : t('Your NVIDIA driver is too old for DLSS 5: it reported Neural Rendering as out of date.')) +
      (v.current ? ' ' + t('Installed: {current}.', v) : '') + ' ' +
      t('Nothing in the game folder can work around that -- plain DLSS may still start, but the neural model either never loads or crashes on its first frame. Update the driver from the NVIDIA app or nvidia.com, then launch the game again.');
    case 'nr-model-crash-emulator': return t('The DLSS 5 model crashed on its very first frame, inside NVIDIA\'s own code, and the Feeder stopped -- {name} carried on without it. It crashed on {name}\'s Direct3D 12 device, where the Feeder hands the model the emulator\'s own device. No ini setting changes that. What to try: in {name}, Graphics > Backend: Direct3D 11. On D3D11 the Feeder runs DLSS on a device of its own, the path that keeps working where this one crashes. Launch once and this app picks up the new API by itself.', v) +
      (v.smoothMotion ? ' ' + t('NVIDIA Smooth Motion was also on inside this process. Turn it off for this game in the NVIDIA app if the crash stays.') : '');
    case 'nr-model-crash': return t('The DLSS 5 model crashed on its very first frame, inside NVIDIA\'s own code ({stack}), and the Feeder stopped. The game carried on without it. No ini setting this app knows changes that. If the game has a Direct3D 11 mode, try it: the Feeder then runs DLSS on a device of its own. Otherwise save the bundle to share.', v) +
      (v.smoothMotion ? ' ' + t('NVIDIA Smooth Motion was also on inside this process. Turn it off for this game in the NVIDIA app if the crash stays.') : '');
    case 'feed-host-gone': return t('The 64-bit helper that does the DLSS work for this 32-bit game went away during the last run, so the feed stopped and the game carried on rendering by itself. host64\\dlss5-feed-host.log, beside the game, is its own account of why.');
    case 'feed-stopped': return t('The Feeder gave up on the last run. Reconfigure rewrites its ReShade settings; if it stops again, dlss5-feed.log has its own diagnosis.');
    case 'smooth-motion-stacked': return t('Two frame generators are running on this game. The DLSS5 Feeder saw NVIDIA Smooth Motion active in the process on the last run, and this app has {generator} set up here as well. Smooth Motion is frame generation done by the driver itself, after the frame leaves the game, so it does not replace the other one -- the two interleave their generated frames, which costs latency and shows as doubled motion artefacts. Turn one of them off: Smooth Motion is per game in the NVIDIA app, under Graphics -- Program Settings -- Driver Settings. Nothing here can switch it for you; NVIDIA publishes no setting for it that a program can read or write.', v);
    case 'wrapper-crash-swap': return t('The game crashed as it started, inside dgVoodoo2\'s {dll} -- before the DLSS5 Feeder or OptiScaler had done anything. No dgVoodoo2 setting is known to get past this: where it was first seen, every setting tried hung or crashed the same way. But dgVoodoo2 is not the only way to present DirectX 8/9 to a modern pipeline -- DXVK does the same job by a different route, and on one report the same game crashed under dgVoodoo2 on one machine while running through DXVK on another. Worth trying before giving up. Whatever dgVoodoo2 displaced is handed back first, so this can be undone; run the game afterwards and check here again.', v);
    case 'dgvoodoo-crash': return t('The game crashed as it started, inside dgVoodoo2\'s {dll} -- before the DLSS5 Feeder or OptiScaler had done anything. This DirectX 9 route cannot work without dgVoodoo2, and no dgVoodoo2 setting is known to get past this: where it was first seen, every setting tried hung or crashed the same way while the game ran fine without dgVoodoo2. The same fault can also show as a black screen that never responds, which leaves no log. Removing puts the game back exactly as it was.', v);
    case 'wrapper-crash': return t('The game crashed as it started, inside {dll} in its own folder -- a DirectX wrapper this app did not place. No rule covers this. Save the bundle to share, or ask the AI.', v);
    case 'feeder-mv-broken': return t('The Feeder is deployed here, but its motion-vector shader is {why} ({provider}). DLSS is then fed no motion at all: sharp standing still, smearing the moment you move. Re-deploying writes the provider, its shader and the preset from one answer -- the default is VORT now, which compiles on the ReShade this app installs.', v);
    case 'feed-no-motion': return t('The Feeder ran and DLSS got no motion vectors. The Feeder\'s own log says: {detail} Re-deploying rewrites the provider, its shader, both DLSS5_MV_PROVIDER levels and the preset together.', v);
    // The 32-bit route: the provider is switched in place (legacy:setMvProvider), not redeployed.
    case 'feed-no-motion-legacy': return (v.onLumenite
      ? t('The Feeder ran and DLSS got no motion vectors from LumeniteFX. The Feeder\'s own log says: {detail} Pick VORT under the card\'s Motion vectors entry to rule the shader out.', v)
      : t('The Feeder ran and DLSS got no motion vectors from {provider}. The Feeder\'s own log says: {detail} Try LumeniteFX, the provider the Feeder recommends: card menu > Motion vectors > change. It asks you to confirm its licence first.', v));
    case 'feed-depth-flat': return t('The Feeder ran, but depth read flat while the scene was moving: ReShade\'s Generic Depth is bound to the wrong buffer, so DLSS and the neural pass reconstruct from nothing. This is the usual Unity failure. The fix switches this game to the one Unity depth profile a contributor has verified end to end; if that is not it either, ReShade\'s own Add-ons > Generic Depth page lists the real buffers the running game has.');
    case 'feed-agility-redist': return t('Direct3D 12 refused every device create in this game\'s process with D3D12_ERROR_INVALID_REDIST -- the Feeder\'s own included -- so DLSS never started. The exe points Direct3D 12 at its own D3D12 folder (Unity games commonly do) and that redist cannot be loaded. The game itself never notices, because on D3D11 it creates no D3D12 device of its own. The fix moves that folder aside so Windows\' own Direct3D 12 runtime is used: reversible, and the game will tell you if it genuinely needed it.');
    case 'feed-agility-redist-elsewhere': return t('Direct3D 12 refused every device create in this game\'s process with D3D12_ERROR_INVALID_REDIST, so the Feeder could not open its device. There is no D3D12 folder beside the exe, so something else in the process is redirecting Direct3D 12 at a redist it cannot load -- a launcher, a mod loader, or an absolute path inside the exe. Verify the game\'s files through its launcher; nothing this app can do works around it.');
    case 'upscale-skipped': return t('The game ran and every single frame was dropped by the upscaler -- OptiScaler will not dispatch unless it can restore the root signature afterwards, and on this route it never can: the DLSS call arrives on PureDark\x27s own command list, which carries no root signature for it to track. Nothing is written to the output, so the game presents a black screen while running normally behind it. There is no setting here that fixes it: clearing the [Hotfix] restores lets the dispatch through and OptiScaler crashes inside it instead, on every build tested. This is a bug in OptiScaler\x27s handling of PureDark\x27s plugin, not something this app can configure around.');
    case 'sr-backend-debugger': return t('DLSS could not be created ({result}) and OptiScaler upscaled with {backend} instead, and {debugger} is sitting in the game folder ({debuggerFile}). A graphics debugger replaces Direct3D 12 with its own wrapper, and that wrapper carries none of the vendor paths DLSS and XeSS need -- which is why those two fail while FSR keeps working. This app cannot tell whether the game actually loaded it; some games ship one and never use it. Move the file out of the folder and launch again to find out.', v);
    case 'sr-backend-fallback': return v.why
      ? t('DLSS could not be created and OptiScaler silently upscaled with {backend} instead. The neural pass still ran on top of it, which is why this looks like a working run -- but the game is not running DLSS. NVIDIA\x27s own reason for refusing is {result}, {why}. One known cause worth ruling out first: a DLSS Override set for this game in the NVIDIA App makes the driver load its own DLSS out of C:\\ProgramData\\NVIDIA\\NGX\\models rather than the copy here, and when that one cannot be resolved DLSS refuses exactly like this. Turn the override off for the game and launch again. If it still refuses, send the report with nvngx.log -- NGX\x27s own log, beside the exe, and the only thing that says more than the code does.', v)
      : t('DLSS could not be created ({result}) and OptiScaler silently upscaled with {backend} instead. The neural pass still ran on top of it, which is why this looks like a working run -- but the game is not running DLSS. Check nvngx_dlss.dll is beside the exe and that the game\x27s own settings ask for DLSS; if both are right, OptiScaler.log has the NGX result for a bug report.', v);
    case 'fix-failed': return t('The fix "{fix}" was applied and the result did not change. DLSS 5 is not currently available for this game with what this app can do on its own. Save the bundle to share, or ask the AI.', v);
    default: return t('No rule covers this run ({verdict}). Save the bundle to share, or ask the AI.', { verdict: v.verdict || diag.code });
  }
}

// Game Help's headline: the card's line, plus the states the card never shows.
function helpHeadline(diag) {
  switch (diag.code) {
    case 'ok': case 'ok-panel-in-helper': case 'ok-exit-crash': return t('DLSS 5 is working');
    case 'needs-run': case 'needs-run-after-fix': return t('Play the game once, then check again');
    case 'driver-outdated': return t('NVIDIA driver too old for DLSS 5');
    default: return helpShort(diag);
  }
}

// What to do, as a few short numbered steps. The explanation behind each is helpWords, under Details.
// Users complained of walls of text (2026-09-15): these are what they actually read.
function helpSteps(diag) {
  const v = diag.vars || {};
  const launch = t('Launch the game and check again');
  const fixIt = (what) => [what, launch];
  const report = [t('Save the bundle (More…)'), t('Report it on GitHub (More…)')];
  switch (diag.code) {
    case 'driver-outdated': return [v.min ? t('Update the NVIDIA driver ({min} or newer)', v) : t('Update the NVIDIA driver'), t('Restart the PC'), launch];
    case 'dfc-here': return [t('Launch the game'), t('Press Home and open the Deep Fried Chicken tab')];
    case 'dfc-hand-placed': return [t('Open the game\'s ⋯ menu and pick Neural pass: switch to Deep Fried Chicken')];
    case 'emulator-renderer': case 'emulator-renderer-mismatch': return [t('In {name}: {hint}', v), t('Start {name} again', v)];
    case 'nr-model-crash-emulator': return [
      t('In {name}: Graphics > Backend > Direct3D 11', v),
      ...(v.smoothMotion ? [t('Turn off NVIDIA Smooth Motion for {name}', v)] : []),
      launch,
    ];
    case 'nr-model-crash': return [
      t("Switch the game to Direct3D 11 if it has that option"),
      ...(v.smoothMotion ? [t('Turn off NVIDIA Smooth Motion for this game')] : []),
      t('Still crashing? Save the bundle and report it'),
    ];
    case 'foreign': return fixIt(t('Press Fix it to remove {tool}', v));
    case 'foreign-optiscaler': return [t('Delete {file} from the game folder', v), t('Press Install')];
    case 'asi-optiscaler': return [t('Remove {file} from the ASI loader', v), t('Press Install')];
    case 'asi-loader-blind': return [t('Check the .asi plugins in the game folder: {files}', v), t('Save the bundle or ask the AI')];
    case 'feeder-misdeployed': case 'ue-crash-feeder': return fixIt(t('Press Fix it (removes the Feeder)'));
    case 'luma-known-bad': case 'ue-crash-luma': return fixIt(t('Press Fix it (removes Luma UE)'));
    case 'optiscaler-no-native-dlss': return [t('Turn DLSS or DLAA on in the game, if it has one', v), t('If it has none, delete {file} from the game folder', v), t('Press Install')];
    case 'feeder-incomplete': return [t('Press Install to fetch and place {missing}', v), launch];
    case 'not-installed': case 'feeder-missing': case 'dgvoodoo-missing': case 'feeder-technique': return [t('Press Install'), launch];
    case 'luma-missing': return [t('Press Fix it (sets up Luma)'), t('In the game: pick DirectX 11'), launch];
    case 'luma-available': return [t('Press Fix it (switches to Luma)'), t('In the game: pick DirectX 11'), launch];
    case 'catalog-prefers': return [t('Press Fix it (switches to {route})', { route: routeName(v.route, v.via) }), launch];
    case 'luma-needs-dx11': return [t('In the game\'s graphics settings: DirectX 11'), launch];
    case 'reframework-missing': case 'pd-temporal-on': case 'pd-build-missing': case 'd3d11-native':
    case 'nr-disabled': case 'dlss-runtime-missing': case 'dlss-runtime-stub': case 'feed-stopped':
      return fixIt(t('Press Fix it'));
    case 'feeder-mv-broken': case 'feed-no-motion': return fixIt(t('Press Fix it (redeploys the Feeder)'));
    case 'feed-no-motion-legacy': return [v.onLumenite ? t('Card menu > Motion vectors > change: pick VORT') : t('Card menu > Motion vectors > change: pick LumeniteFX'), launch];
    case 'feed-depth-flat': return fixIt(t('Press Fix it (switches the depth profile)'));
    case 'feed-agility-redist': return fixIt(t('Press Fix it (moves the D3D12 folder aside)'));
    case 'feed-agility-redist-elsewhere': return [t("Verify the game's files in its launcher"), launch];
    case 'pd-plugin-missing': return [t('Download PDPerfPlugin 1.1.2 from Nexus'), t('Press "I downloaded it"')];
    case 'pd-enable-ingame': return [t('In the game: Insert > TemporalUpscaler'), t('Tick Enabled, set Upscale Type to DLSS')];
    case 'anticheat-launch-direct': return [t("Start the game with this app's Launch button"), t('Single-player only -- stay offline')];
    // The app presets DLSS in Luma (v1.69.2), so a run with no DLSS is nearly always one that never reached
    // gameplay (Prey, a player's bundle 2026-09-15: 35 seconds, menus only). The overlay check comes second.
    case 'luma-select-dlss': return v.prey
      // Prey: Luma puts DLSS in place of the game's TAA / SMAA 2TX pass, so the game's own AA setting decides.
      ? [t("In Prey: Options > Display > Anti-Aliasing: TAA (or SMAA 2TX)"), t('Play a minute of actual gameplay, then quit'), launch]
      : [t('Play a minute of actual gameplay, then quit'), t("In the game: Home > Luma > select DLSS"), launch];
    case 'needs-run': case 'needs-run-after-fix': return [t('Launch the game'), t('Play a minute of actual gameplay, then quit'), t('Come back here')];
    // The pop-out line only when that panel can actually answer its hotkey (see popoutHotkeyUsable).
    // On the shared Insert the pop-out IS what Insert opens on this route (panelroute.js), so it is one
    // step, not "Insert for one panel, or Insert for the other".
    case 'ok-panel-in-helper': return [
      ...(popoutHotkeyUsable() && panelKeyIsShared()
        ? [t('{hotkey} opens the DLSS 5 panel', { hotkey: panelHotkey() })]
        : [t('Press Insert in the game for the DLSS 5 panel'), t('Its controls take clicks there, as in any other game'),
          ...(popoutHotkeyUsable() ? [t('Or press {hotkey} for the pop-out panel', { hotkey: panelHotkey() })] : [])]),
      ...(v.otherMv ? [t('Picture jumps or smears in motion? Card menu > Motion vectors > change: pick LumeniteFX')] : [])];
    case 'vulkan-layer-missing': return [t('Install ReShade with add-on support for this exe, choosing Vulkan'), t('Or switch the emulator to Direct3D 11, if it has it, and pick DX11 in Edit'), t('Press Install here again')];
    case 'vulkan-layer-no-addon': return [t('Reinstall ReShade with "Enable loading of add-ons"'), t('Press Install here again')];
    case 'vulkan-layer-not-loaded': return [t('Run ReShade\'s installer for this exe, choosing Vulkan'), t('Turn NVIDIA Smooth Motion off for it'), t('Launch again')];
    case 'vulkan-layer-app-not-listed': return [t('Run ReShade\'s installer for this exe, choosing Vulkan'), t('Keep "Enable loading of add-ons" ticked'), launch];
    case 'vulkan-layer-blacklisted': return [t('Add {arg} to the launch arguments', { arg: '+r_allowBlackListedLayers 1' }), t('Steam: Properties > Launch Options. A shortcut: after the exe path'), launch];
    case 'host32-opti-dll-gone': return [t('Windows Security > Exclusions: add this game\'s folder'), t('Press Install here again'), t('Protection history may also offer Allow -- but may show nothing')];
    case 'host32-exe-gone': return [t('Windows Security > Exclusions: add this game\'s folder'), t('Press Install here again'), t('Protection history may also offer Allow -- but may show nothing')];
    case 'feed-host-gone': return [t('Open host64\\dlss5-feed-host.log beside the game -- it names the reason'), t('Save the bundle to share: it carries that log')];
    case 'feed-host-startup': return fixIt(t('Press Install (rebuilds the helper and the add-on together)'));
    case 'opti-proxy-name': return fixIt(t('Press Fix it (moves OptiScaler to {to})', v));
    case 'opti-not-routed': return fixIt(t('Press Fix it (restores the NGX redirect keys)'));
    case 'dxvk-blocked-game': return [t('Press Fix it -- dgVoodoo2 goes back in where DXVK was'), launch];
    case 'dgvoodoo-no-dlss': return [t('Press Fix it -- DXVK goes in where dgVoodoo2 was'), launch, ...report];
    case 'dxvk-no-dlss': return [t('Press Fix it -- dgVoodoo2 goes back in where DXVK is'), launch, ...report];
    case 'dxvk-crash-swap': return [t('Press Fix it to swap DXVK back for dgVoodoo2'), launch];
    case 'dxvk-no-dlss-native': return [t('Press Fix it -- DXVK comes out and the game is back on its own Direct3D'), launch, ...report];
    case 'dxvk-crash-native': return [t('Press Fix it to take DXVK back out'), launch];
    case 'dxvk-layer-missing': return [t('Press Fix it and allow the administrator prompt'), launch];
    case 'dxvk-reshade-ini-missing': return [t('Press Install on the card'), launch];
    case 'dxvk-two-reshades': return [t('Switch the game back off DXVK (More…), or move the extra ReShade out'), launch];
    case 'dxvk-addon-not-loaded': return [t('In the game, press Home and check ReShade\'s Add-ons tab for DLSS 5 Feed'), t('Read ReShade.log in the game folder'), ...report];
    case 'dxvk-needs-run': return [t('Launch the game'), t('Play a minute of actual gameplay, then quit'), t('Come back here')];
    case 'dxvk-panel-fullscreen': return [t('Set the game to borderless or windowed in its own options'), t('Restart it and press Insert')];
    case 'nr-model-only': return [t('Press Fix it -- OptiScaler comes out and the model goes in'), t('Turn DLSS on in the game\'s own video settings'), launch, ...report];
    case 'opti-not-loaded': return [t('Rename OptiScaler in the game folder to a DLL this exe imports (winmm.dll or version.dll)'), launch, ...report];
    case 'feed-vulkan-interop': return [t('Launch through the Feeder\'s layer\\run-with-feed-layer.bat'), ...report];
    case 'ok': return [t('Tune it in Edit, or with Insert in the game')];
    case 'ok-exit-crash': return [t('Nothing to do -- it only crashes when quitting')];
    case 'smooth-motion-stacked': return [t('Open the NVIDIA app -- Graphics -- Program Settings, and pick this game'), t('Under Driver Settings, turn Smooth Motion off'), t('Or turn off {generator} in Settings here instead', v)];
    case 'wrapper-crash-swap': return [t('Press Fix it to swap dgVoodoo2 for DXVK'), t('Launch the game and reach gameplay'), t('Come back here -- if it still crashes, the next step is putting the game back')];
    case 'dgvoodoo-crash': return [t('Press Fix it (puts the game back as it was)')];
    case 'sr-backend-debugger': return [t('Move {debuggerFile} out of the game folder', v), t('Launch again and try DLSS'), ...report];
    case 'sr-backend-fallback': return [t('NVIDIA App > Graphics > this game > DLSS Override: turn it off'), t("Check the game's own settings ask for DLSS"), ...report];
    // Anti-cheat has steps now: it is a decision to take, not a door that is shut.
    case 'anticheat': return [t('Decide first: single-player only, and going online risks a ban'), t('Install if you accept that -- Remove puts the game back'), launch, ...report];
    case 'bit32': case 'unsupported': case 'upscale-skipped': return [];
    default: return report;
  }
}

// The card's one line: what is wrong, in a few words. The modal has the full sentence.
function helpShort(diag) {
  const v = diag.vars || {};
  switch (diag.code) {
    case 'bit32': return t('Not available: 32-bit game');
    case 'anticheat': return t('Anti-cheat ({antiCheat}) -- your call', v);
    case 'unsupported': return t('Not available here');
    case 'foreign': return t('Another DLSS 5 tool is in the folder');
    case 'anticheat-launch-direct': return t('Launch from here, not Steam');
    case 'feeder-misdeployed': return t('Feeder on a game with its own DLSS');
    case 'luma-known-bad': return t('Luma UE breaks this game');
    case 'not-installed': return t('Not installed yet');
    case 'feeder-missing': return t('Feeder not deployed yet');
    case 'dgvoodoo-missing': return t('dgVoodoo2 not in place yet');
    case 'luma-missing': return t('Luma not set up yet');
    case 'reframework-missing': return t('REFramework missing');
    case 'pd-temporal-on': return t('Switch REFramework\'s upscaler off');
    case 'pd-build-missing': return t('Needs the pd-upscaler REFramework');
    case 'pd-plugin-missing': return t('Get PDPerfPlugin.dll from Nexus');
    case 'pd-enable-ingame': return t('Enable DLSS in REFramework (Insert)');
    case 'd3d11-native': return t('Wrong D3D11 upscaler setting');
    case 'nr-disabled': return t('Neural Rendering is switched off');
    case 'foreign-optiscaler': return t('Another OptiScaler loads first');
    case 'asi-optiscaler': return t('Another OptiScaler loads as an .asi');
    case 'asi-loader-blind': return t('An ASI loader is in charge here');
    case 'dlss-runtime-missing': return t('nvngx_dlss.dll is missing');
    case 'dlss-runtime-stub': return t('nvngx_dlss.dll is not a real DLL');
    case 'optiscaler-no-native-dlss': return t('No DLSS call came from this game');
    case 'feeder-incomplete': return t('The Feeder is only half installed');
    case 'feeder-technique': return t('Feeder shader missing');
    case 'luma-select-dlss': return t('Select DLSS in Luma\'s overlay (Home)');
    case 'ue-crash-luma': return t('Crashed with Luma UE');
    case 'ue-crash-feeder': return t('Crashed with the Feeder');
    case 'ue-crash': return t('Crashed -- no known fix');
    case 'driver-outdated': return v.min ? t('Update the NVIDIA driver ({min} or newer)', v) : t('Update the NVIDIA driver');
    case 'luma-available': return t('Luma has a better mod for this game');
    case 'catalog-prefers': return t('Known to run better on {route}', { route: routeName(v.route, v.via) });
    case 'luma-needs-dx11': return t('Switch the game to DirectX 11 for Luma');
    case 'nr-model-crash-emulator': return t('DLSS 5 crashed on D3D12 -- switch to Direct3D 11');
    case 'dfc-here': return v.state ? t('Deep Fried Chicken: {state}', v) : t('Deep Fried Chicken runs the neural pass here');
    case 'dfc-hand-placed': return t('Chicken copied in by hand: switch to take it over');
    case 'emulator-renderer': return t('Set {name} to {renderer}', v);
    case 'emulator-renderer-mismatch': return t('{name} ran on {seen} -- set {renderer}', v);
    case 'nr-model-crash': return t('The DLSS 5 model crashed');
    case 'feed-host-gone': return t('The 64-bit helper went away');
    case 'feed-stopped': return t('The Feeder gave up');
    case 'smooth-motion-stacked': return t('Two frame generators: Smooth Motion and {generator}', v);
    case 'wrapper-crash-swap': return t('dgVoodoo2 crashes this game -- DXVK is worth a try');
    case 'dgvoodoo-crash': return t('dgVoodoo2 crashes this game');
    case 'wrapper-crash': return t('Crashed in {dll} -- no known fix', v);
    case 'feeder-mv-broken': return t('Motion-vector shader cannot work');
    case 'feed-no-motion': case 'feed-no-motion-legacy': return t('DLSS got no motion vectors');
    case 'feed-depth-flat': return t('Depth is flat -- wrong buffer');
    case 'feed-agility-redist': case 'feed-agility-redist-elsewhere': return t('D3D12 refused every device (redist)');
    case 'upscale-skipped': return t('Black screen: every frame dropped');
    case 'sr-backend-debugger': return t('Not DLSS -- {debugger} is in the folder', v);
    case 'sr-backend-fallback': return t('Not DLSS -- fell back to {backend}', v);
    case 'ok-panel-in-helper': return t('Working -- press Insert in the game for the panel');
    case 'vulkan-layer-missing': return t('ReShade\'s Vulkan layer is not installed');
    case 'vulkan-layer-no-addon': return t('ReShade\'s Vulkan layer has no add-on support');
    case 'vulkan-layer-not-loaded': return t('ReShade\'s Vulkan layer did not load here');
    case 'vulkan-layer-app-not-listed': return t('{exe} is not on ReShade\'s Vulkan app list', v);
    case 'opti-proxy-name': return t('DLSS 5 is under a name this game never loads ({from})', v);
    case 'nr-model-only': return t('DLSS 5 never loaded -- this game has its own DLSS');
    case 'dxvk-blocked-game': return t('DXVK shakes this game -- go back to dgVoodoo2');
    case 'dgvoodoo-no-dlss': return t('Nothing called DLSS -- dgVoodoo2 is the likely reason');
    case 'dxvk-no-dlss': return t('Nothing called DLSS under DXVK either -- try dgVoodoo2 again');
    case 'dxvk-crash-swap': return t('DXVK crashes this game -- dgVoodoo2 is worth another try');
    case 'dxvk-no-dlss-native': return t('Nothing called DLSS under DXVK -- try native Direct3D again');
    case 'dxvk-crash-native': return t('DXVK crashes this game -- go back to native Direct3D');
    case 'dxvk-crash': return t('Both layers crash this game');
    case 'dxvk-layer-missing': return t('ReShade\'s 32-bit Vulkan layer is missing for this game');
    case 'dxvk-reshade-ini-missing': return t('No ReShade.ini -- ReShade\'s Vulkan layer will not start');
    case 'dxvk-two-reshades': return t('Two ReShades in the game');
    case 'dxvk-addon-not-loaded': return t('ReShade loaded under DXVK, the DLSS5 Feeder did not');
    case 'dxvk-needs-run': return t('Run the game once under DXVK, then check again');
    case 'dxvk-panel-fullscreen': return t('Working -- but exclusive fullscreen hides the panel');
    case 'opti-not-loaded': return t('The game never loaded OptiScaler ({file})', v);
    case 'opti-not-fork': return t('A stock OptiScaler, not the DLSS-NR fork');
    case 'opti-not-routed': return t('The driver answered instead of OptiScaler');
    case 'feed-vulkan-interop': return t('Vulkan interop extensions missing -- the Feeder stopped');
    case 'fix-failed': return t('Fix did not help -- no known fix');
    case 'vulkan-layer-blacklisted': return t('{exe} blocks Vulkan layers -- add a launch argument', v);
    case 'host32-opti-dll-gone': return t('OptiScaler was removed from host64 -- check antivirus');
    case 'host32-exe-gone': return t('The 64-bit helper was removed from host64 -- check antivirus');
    case 'feed-host-gone': return t('The 64-bit helper went away -- its own log says why');
    case 'feed-host-startup': return t('The 64-bit helper quit at startup -- Install rebuilds it');
    case 'dlss-no-nr': case 'init-no-feature': case 'no-hook': default: return t('Not working -- no known fix');
  }
}

function helpFixLabel(id) {
  switch (id) {
    case 'nr-model-only': return t('Add Neural Rendering without OptiScaler');
    case 'swap-to-dxvk': return t('Try DXVK instead');
    case 'swap-to-dgvoodoo': return t('Try dgVoodoo2 instead');
    case 'swap-to-native': return t('Use native Direct3D 11');
    case 'remove-foreign': return t('Remove the other toolchain');
    case 'remove-feeder': return t('Remove the Feeder');
    case 'remove-luma': return t('Remove Luma UE');
    case 'redeploy-feeder': return t('Deploy the Feeder again');
    case 'feeder-depth-profile': return t('Try the verified Unity depth profile');
    case 'disable-agility-redist': return t('Move the game\'s D3D12 folder aside');
    case 'reconfigure': return t('Reconfigure');
    case 'remove-all': return t('Remove everything this app placed');
    case 'install': return t('Install DLSS 5');
    case 'place-dlss': return t('Put nvngx_dlss.dll beside the exe');
    case 'switch-to-luma': return t('Switch to Luma');
    default: return id;
  }
}

function renderHelp(diag) {
  helpDiag = diag;
  const body = $('#help-body');
  const status = $('#help-status');
  const cls = { ok: 'status-ok', fix: '', step: '', 'needs-run': '', unavailable: 'status-bad', unknown: 'status-bad' }[diag.status] || '';
  status.className = 'help-status ' + cls;
  status.textContent = {
    ok: t('Working'), fix: t('Fix available'), step: t('Your move'), 'needs-run': t('Needs a run'),
    unavailable: t('Not available'), unknown: t('No rule fits'),
  }[diag.status] || '';
  // A headline and a few numbered steps up front; the full explanation sits under Details.
  $('#help-headline').textContent = helpHeadline(diag);
  const stepsEl = $('#help-steps');
  const steps = helpSteps(diag);
  stepsEl.innerHTML = steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  stepsEl.classList.toggle('hidden', steps.length === 0);
  // A working game that Lossless Scaling applies to, and nobody has set it up: say so where players look.
  // Players never found it in Edit (v1.66.0 put it behind advanced options).
  let lsBtn = $('#help-lossless');
  if (!lsBtn) {
    lsBtn = document.createElement('button');
    lsBtn.id = 'help-lossless';
    lsBtn.className = 'btn btn-small hidden';
    lsBtn.textContent = t('Set up Lossless Scaling frame generation');
    lsBtn.addEventListener('click', () => { const g = helpGame; if (!g) return; closeHelp(); openGameModal(g); });
    stepsEl.insertAdjacentElement('afterend', lsBtn);
  }
  lsBtn.classList.add('hidden');
  // The frame-gen suggestion (main.js frameGenSuggestion, fgsuggest.js): with a measured frame rate it
  // decides whether frame generation is worth it and which one; without one the old prompt stands.
  const fg = diag.status === 'ok' ? diag.fg : null;
  if (fg && fg.suggest) {
    stepsEl.insertAdjacentHTML('beforeend', `<li>${escapeHtml(fgSuggestionText(fg))}</li>`);
    stepsEl.classList.remove('hidden');
    lsBtn.textContent = fg.generator === 'lossless' ? t('Set up Lossless Scaling frame generation') : t('Set up frame generation (Edit)');
    lsBtn.classList.remove('hidden');
  } else if (!fg && diag.status === 'ok' && helpGame && helpGame.exePath) {
    lsBtn.textContent = t('Set up Lossless Scaling frame generation');
    const game = helpGame;
    window.api.losslessEligibility(game.exePath).then(async (gate) => {
      if (!gate || !gate.eligible || helpGame !== game) return;
      const configured = await window.api.losslessReadSettings().then((xml) => String(xml || '').toLowerCase().includes(game.exePath.trim().toLowerCase())).catch(() => false);
      if (configured || helpGame !== game) return;
      stepsEl.insertAdjacentHTML('beforeend', `<li>${escapeHtml(t('Want more FPS? Add frame generation with Lossless Scaling (the game must run Borderless or Windowed)'))}</li>`);
      stepsEl.classList.remove('hidden');
      lsBtn.classList.remove('hidden');
    }).catch(() => {});
  }
  body.textContent = helpWords(diag);
  renderHelpWhy(diag);
  // A finding that sends the user to one page (the pd route's Nexus plugin) gets the link.
  let linkBtn = $('#help-link');
  if (!linkBtn) {
    linkBtn = document.createElement('button');
    linkBtn.id = 'help-link';
    linkBtn.className = 'btn btn-small';
    linkBtn.addEventListener('click', () => { if (helpDiag && helpDiag.vars && helpDiag.vars.url) window.api.openExternal(helpDiag.vars.url); });
    stepsEl.insertAdjacentElement('afterend', linkBtn);
  }
  const url = diag.vars && diag.vars.url;
  linkBtn.classList.toggle('hidden', !url);
  if (url) linkBtn.textContent = t('Open the download page');
  // PureDark's plugin: the popup that finds the download and places it everywhere.
  let pdBtn = $('#help-pdplugin');
  if (!pdBtn) {
    pdBtn = document.createElement('button');
    pdBtn.id = 'help-pdplugin';
    pdBtn.className = 'btn btn-small btn-primary';
    pdBtn.addEventListener('click', () => { closeHelp(); openPdPluginModal(); });
    linkBtn.insertAdjacentElement('afterend', pdBtn);
  }
  pdBtn.classList.toggle('hidden', diag.code !== 'pd-plugin-missing');
  pdBtn.textContent = t('I downloaded it -- set it up');
  const run = diag.run;
  $('#help-lastrun').textContent = run && run.ran ? t('Last run: {when} -- {verdict}', { when: new Date(run.at).toLocaleString(), verdict: describeRun(run) }) : t('Last run: none recorded');
  // The fix when there is one, or AI help when nothing fits. Launching, reporting and the other layers
  // moved onto the card (2026-09-25): it watches the launch and climbs DXVK -> Chicken -> report itself.
  const apply = $('#help-apply');
  const ai = $('#help-ai');
  apply.classList.toggle('hidden', diag.status !== 'fix');
  if (diag.fix) apply.textContent = t('Fix it') + ' -- ' + helpFixLabel(diag.fix.id);
  ai.classList.toggle('hidden', diag.status !== 'unknown');
  ai.textContent = settings.anthropicApiKey ? t('Ask AI') : t('Set up AI help…');
  ai.classList.toggle('btn-primary', diag.status === 'unknown');
  $('#help-ai-out').classList.add('hidden');
}

async function refreshHelp() {
  const diag = await window.api.gameHelp(helpGame.exePath, helpGame.detectedPath || null, helpFixesTried);
  if (!diag.ok) { toast(t('Game Help could not check this game: {error}', { error: diag.error })); return null; }
  renderHelp(diag);
  return diag;
}

// "Why this route?" under Details (routescore.js): the chosen route's reasons, and the runner-up's --
// what the app would try next and why it did not start there.
function renderHelpWhy(diag) {
  let el = $('#help-why');
  if (!el) {
    el = document.createElement('div');
    el.id = 'help-why';
    el.className = 'help-why';
    $('#help-body').insertAdjacentElement('afterend', el);
  }
  const s = diag.score;
  if (!s || !s.chosen) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  const reasons = (c) => (c.reasons || []).filter((x) => x.weight).map((x) => `<li>${escapeHtml(t(x.text, x.vars || {}))}</li>`).join('');
  const kg = diag.knownGood;
  const parts = [`<strong>${escapeHtml(t('Why this route?'))}</strong>`,
    `<div>${escapeHtml(routeName(s.chosen.route, s.chosen.via))}</div><ul>${reasons(s.chosen)}</ul>`];
  if (s.runnerUp) parts.push(`<div>${escapeHtml(t('Next best: {route}', { route: routeName(s.runnerUp.route, s.runnerUp.via) }))}</div><ul>${reasons(s.runnerUp)}</ul>`);
  if (kg && kg.status === 'works' && kg.route) parts.push(`<div>${escapeHtml(t('Proven on this game: {route}', { route: routeName(kg.route) }))}${kg.notes ? ` -- ${escapeHtml(kg.notes)}` : ''}</div>`);
  el.innerHTML = parts.join('');
  el.classList.remove('hidden');
}

// One line for a frame-generation suggestion (fgsuggest.js).
function fgSuggestionText(fg) {
  const v = { ...fg.vars, multiplier: fg.multiplier };
  switch (fg.code) {
    case 'fg-native': return t('Want more FPS? This game has its own DLSS Frame Generation: set it to {multiplier}x in Edit (about {reach} fps from {fps})', v);
    case 'fg-rtxmfg': return t('Want more FPS? Your RTX 40 runs the game\'s own frame generation at 2x; the RTX 40 multi-frame unlock in Edit takes it to {multiplier}x (about {reach} fps from {fps})', v);
    case 'fg-lossless': return t('Want more FPS? Add Lossless Scaling frame generation at {multiplier}x (about {reach} fps from {fps}); the game must run Borderless or Windowed', v);
    case 'fg-lossless-get': return t('Want more FPS? Lossless Scaling (on Steam) adds frame generation to any game: {multiplier}x would take {fps} fps to about {reach}', v);
    default: return '';
  }
}

function stopHelpPoll() { if (helpPoll) { clearInterval(helpPoll); helpPoll = null; } $('#help-waiting').classList.add('hidden'); }

async function openHelp(game) {
  helpGame = game;
  helpFixesTried = helpTriedFor(game);
  helpTriedByGame.set(game.exePath, helpFixesTried);
  $('#help-title').textContent = t('Game Help -- {name}', { name: game.name });
  $('#help-headline').textContent = t('Checking…');
  $('#help-steps').classList.add('hidden');
  $('#help-details').open = false;
  $('#help-body').textContent = '';
  $('#help-status').textContent = '';
  $('#help-ai-out').classList.add('hidden');
  $('#help-ai-out').textContent = '';
  helpModal.classList.remove('hidden');
  const diag = await refreshHelp();
  // Closed, or reopened on another game, while that ran: what follows belongs to that one now.
  if (helpGame !== game) return;
  helpLastRunAt = diag && diag.run && diag.run.at ? diag.run.at : null;

}

function closeHelp() { stopHelpPoll(); helpModal.classList.add('hidden'); helpGame = null; }

$('#help-close').addEventListener('click', closeHelp);
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });

// The one implementation of "apply the fix Game Help found". The modal's button calls it, and so
// does Fix it on the card -- which used to open the modal and press this button through a
// synthetic, un-awaited click, so the fix ran behind a dialog that had already re-diagnosed the
// game and was reporting "now run it" before the fix had finished. With modal:false there is no
// dialog: the toast says the one thing that changed and the grid re-render shows it.
async function applyHelpFix(game, diag, { modal = true } = {}) {
  if (!game || !diag || !diag.fix) return false;
  const id = diag.fix.id;
  // Recorded with the run it was judged against: until a newer run exists, the same rule reads
  // "needs a run", not "the fix failed" (gamehelp.js).
  const runAt = diag.run && diag.run.at ? diag.run.at : null;
  const tried = helpTriedFor(game);
  const markTried = () => { tried.push({ id, runAt }); helpTriedByGame.set(game.exePath, tried); };
  const busy = (on) => { if (modal) $('#help-apply').disabled = on; };

  if (id === 'install') {
    if (modal) closeHelp();
    await installGame(game);
    markTried();
    await renderGrid();
    if (modal) openHelp(game);
    return true;
  }
  // Luma replaces the Feeder: the deploy removes the Feeder itself, after the licence is confirmed here.
  if (id === 'switch-to-luma') {
    const readiness = await window.api.lumaUeReadiness(game.exePath);
    if (!(readiness.ok && readiness.supported)) { toast(t('Could not deploy Luma UE: {error}', { error: readiness.reason || readiness.error || '?' })); return false; }
    if (!window.confirm(t('This game gets its DLSS call from Luma. Download and set up Luma now?') + '\n\n' + (readiness.licenseSummary || ''))) return false;
    busy(true);
    const res = await window.api.lumaUeDeploy(game.exePath, { licenseConfirmed: true });
    busy(false);
    toast(res.ok ? t('Luma is set up with DLSS switched on.') : t('Could not deploy Luma UE: {error}', { error: res.error }));
    if (res.ok) markTried();
    renderGrid();
    if (modal) await refreshHelp();
    return !!res.ok;
  }
  busy(true);
  const res = await window.api.gameHelpApply(game.exePath, id);
  busy(false);
  if (!res.ok) { toast(t('The fix failed: {error}', { error: res.error })); return false; }
  toast(res.done ? t('Done: {text}', { text: res.text }) : t('Not done: {text}', { text: res.text }));
  if (res.done) markTried();
  renderGrid();
  // A fix that changes files changes the finding at once; one that changes settings only shows
  // on the next run, and the finding then says so and offers Launch.
  if (modal) await refreshHelp();
  return !!res.done;
}

$('#help-apply').addEventListener('click', () => applyHelpFix(helpGame, helpDiag, { modal: true }));

// The issue's title and body, for the card's Report issue (and its browser fallback).
async function buildGameReport(game, diag, { manual = false } = {}) {
  const run = diag.run;
  // The Manager's own version and the engine's, named apart: this line used to print the engine tag
  // under "App", so reports said "App: v1.0.30" from Manager 1.63.12.
  let appVersion = '';
  try { appVersion = ((await window.api.managerUpdateState()) || {}).currentVersion || ''; } catch {}
  const title = `[Game Help] ${game.name}: ${diag.code}`;
  // English on purpose: the issue is read by the maintainer, whatever language the app runs in.
  const body = [
    `**Game:** ${game.name}`,
    `**Exe:** ${game.exePath.split(/[\\/]/).pop()}`,
    `**Engine / API:** ${(game.detectedPath && game.detectedPath.badge) || '?'} / ${(game.detectedPath && game.detectedPath.api) || '?'}`,
    `**Route:** ${diag.route ? diag.route.label : '?'}`,
    `**Game Help finding:** ${diag.code} (${diag.status})`,
    `**Last run verdict:** ${run && run.ran ? `${run.verdict}${run.detail ? ` (${run.detail})` : ''}` : 'none'}`,
    `**GPU:** ${gpuLabel()}`,
    `**App:** ${appVersion ? 'v' + appVersion : '?'}`,
    `**Engine:** ${settings.installedVersion || '?'}`,
    // The run digest (main.js game:help, runlog.reportDigest): the log lines that decide the diagnosis,
    // folded. The zip and the gist cannot be read by a scripted triage, so this is what it works from;
    // a report opened in the browser used to leave it out. Ahead of the Logs line, which stays last
    // because the player pastes the zip after it.
    ...(diag.digest ? ['', diag.digest] : []),
    ...(manual ? ['', '**Logs:** press Ctrl+V on the next line to attach the zip (the app copied it). If nothing appears, drag it in from the folder that opened.', ''] : []),
  ].join('\n');
  return { title, body };
}

// ── Send game failure ─────────────────────────────────────────────────────────
// One button: signs in to GitHub the first time (a code to type on GitHub's own page), then posts the
// issue with the logs attached (main.js report:send, ghreport.js). Before the GitHub app is registered
// (no client ID in this build) it falls back to the two manual steps, done for the player in one go.
// The report exactly as main.js report:prepare will post it (redacted, cut); resolves true on Send.
// Shown as plain text: nothing from a log is ever put into the page as HTML.
function previewReport(prepared) {
  const modal = $('#report-preview-modal');
  $('#report-preview-title').textContent = prepared.title;
  $('#report-preview-body').textContent = prepared.body;
  const list = $('#report-preview-files');
  list.textContent = '';
  for (const f of prepared.files) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${f.name} (${Math.max(1, Math.round(f.bytes / 1024))} KB${f.cut ? `, ${t('start cut, the end is kept')}` : ''})`;
    const pre = document.createElement('pre');
    pre.className = 'report-preview-text';
    pre.textContent = f.text;
    details.append(summary, pre);
    list.append(details);
  }
  if (!prepared.files.length) list.textContent = t('None');
  const skipped = $('#report-preview-skipped');
  skipped.textContent = prepared.skipped && prepared.skipped.length
    ? t('Left out: {files}', { files: prepared.skipped.map((s) => `${s.name} (${s.why})`).join(', ') }) : '';
  skipped.classList.toggle('hidden', !skipped.textContent);
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (answer) => {
      modal.classList.add('hidden');
      $('#report-preview-send').removeEventListener('click', onSend);
      $('#report-preview-cancel').removeEventListener('click', onCancel);
      resolve(answer);
    };
    const onSend = () => done(true);
    const onCancel = () => done(false);
    $('#report-preview-send').addEventListener('click', onSend);
    $('#report-preview-cancel').addEventListener('click', onCancel);
  });
}

let reportSignInWaiter = null;
window.api.onReportSignIn((result) => {
  if (reportSignInWaiter) { reportSignInWaiter(result); reportSignInWaiter = null; }
});

// The whole send, from the card's "Report issue" once every other rung is
// tried. setStatus takes HTML (already escaped here) for wherever the progress is shown. `tried` names
// what the card's ladder already tried, so the report says it rather than the maintainer asking.
async function sendGameFailure(game, diag, { setStatus, tried = [] } = {}) {
  const triedLine = tried.length ? `**Also tried:** ${tried.map((r) => (r === 'dxvk' ? 'DXVK' : 'Deep Fried Chicken')).join(', ')}` : '';
  const withTried = (r) => (triedLine ? { ...r, body: `${r.body}\n${triedLine}` } : r);
  {
    const setSendStatus = setStatus;
    const status = await window.api.reportStatus();
    if (!status.configured) {
      // Not set up in this build: save the bundle and open the prefilled issue, together.
      const saved = await window.api.supportBundle(game.exePath, game.detectedPath || null);
      if (!saved.ok || saved.cancelled) { if (!saved.ok) toast(t('Could not save the support bundle: {error}', { error: saved.error })); return; }
      // The zip goes on the clipboard as a file: one Ctrl+V in GitHub's box attaches it. The folder still
      // opens with it selected, for a browser that does not take a pasted file.
      const copied = await window.api.copyZipToClipboard(saved.zipPath);
      window.api.openPath(saved.zipPath);
      const { title, body } = withTried(await buildGameReport(game, diag, { manual: true }));
      window.api.openExternal(`https://github.com/mrcgibb9876-hash/OptiDLSS5-UI-releases/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
      setSendStatus(escapeHtml(copied && copied.ok
        ? t('GitHub opened with the report filled in, and the log zip is copied. Click at the end of the report on GitHub, press Ctrl+V to attach the zip, then press Submit.')
        : t('GitHub opened with the report filled in. Drag the zip from the folder that opened onto it, then press Submit.')));
      return;
    }
    if (!status.signedIn) {
      const flow = await window.api.reportSignIn();
      if (!flow.ok) { toast(t('GitHub sign-in failed: {error}', { error: flow.error })); return; }
      try { await navigator.clipboard.writeText(flow.userCode); } catch {}
      setSendStatus(`${escapeHtml(t('Sign in once: on the GitHub page that opened, enter this code (it is already copied):'))} <strong class="help-send-code">${escapeHtml(flow.userCode)}</strong>`);
      const result = await new Promise((resolve) => { reportSignInWaiter = resolve; });
      if (!result.ok) { setSendStatus(escapeHtml(t('GitHub sign-in failed: {error}', { error: result.error }))); return; }
    }
    setSendStatus(escapeHtml(t('Gathering the report…')));
    const { title, body } = withTried(await buildGameReport(game, diag));
    const prepared = await window.api.reportPrepare({ exePath: game.exePath, detected: game.detectedPath || null, title, body, game: game.name, finding: diag.code });
    if (!prepared.ok) { setSendStatus(escapeHtml(t('Could not send: {error}', { error: prepared.error }))); return; }
    if (!(await previewReport(prepared))) { window.api.reportDiscard(prepared.id); setSendStatus(''); return; }
    setSendStatus(escapeHtml(t('Sending…')));
    const res = await window.api.reportSend(prepared.id);
    if (res.signedOut) { setSendStatus(escapeHtml(t('GitHub sign-in has expired -- press Send again to sign in.'))); return; }
    if (!res.ok) { setSendStatus(escapeHtml(t('Could not send: {error}', { error: res.error }))); return; }
    if (res.cancelled) { setSendStatus(''); return; }
    // An id per send: the status can be on a card as well as in Game Help, and both can be on screen.
    const linkId = `send-link-${Date.now()}`;
    setSendStatus(`${escapeHtml(t('Sent as issue #{number}. The maintainer will reply there.', { number: res.issueNumber }))} <a href="#" id="${linkId}">${escapeHtml(t('Open it'))}</a>`);
    const link = document.getElementById(linkId);
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(res.issueUrl); });
  }
}

window.api.onGameHelpAiText(({ exePath, text }) => {
  if (!helpGame || helpGame.exePath !== exePath) return;
  const out = $('#help-ai-out');
  out.classList.remove('hidden');
  out.textContent += (out.textContent ? '\n\n' : '') + text;
});

$('#help-ai').addEventListener('click', async () => {
  if (!helpGame) return;
  if (!settings.anthropicApiKey) { openSettingsModal(); $('#settings-advanced').classList.remove('hidden'); $('#settings-ai-key').focus(); return; }
  const game = helpGame;
  const btn = $('#help-ai');
  btn.disabled = true;
  btn.textContent = t('Asking…');
  const out = $('#help-ai-out');
  out.classList.remove('hidden');
  out.textContent = t('Sending this game\'s logs and the app\'s view to Claude ({model}). Each change it wants is confirmed with you first.', { model: settings.aiModel || 'claude-sonnet-5' });
  const res = await window.api.gameHelpAi(game.exePath, game.detectedPath || null, helpFixesTried);
  btn.disabled = false;
  btn.textContent = t('Ask AI');
  if (!res.ok) { out.textContent += '\n\n' + t('AI help failed: {error}', { error: res.error }); return; }
  const verdict = res.available === true ? t('AI verdict: DLSS 5 should work here now. Launch and reach gameplay to confirm.')
    : res.available === false ? t('AI verdict: DLSS 5 is not currently available for this game.')
    : t('AI ended without a clear verdict.');
  out.textContent += '\n\n' + verdict + (res.summary && !out.textContent.includes(res.summary) ? '\n\n' + res.summary : '');
  renderGrid();
  refreshHelp();
});

// ── Checks before Install, Analyse game, Verify install ───────────────────────
// One dialog for all three (src/preflight.js, src/probe.js, src/verify.js). Analyse and Verify start
// the game and close it again; nothing here focuses the game or sends it input, and the progress is
// written into this window whether it is in front or not.
const checksModal = $('#checks-modal');
let checksResolve = null;
let checksExe = null;

function closeChecks(result = false) {
  checksModal.classList.add('hidden');
  checksExe = null;
  const resolve = checksResolve;
  checksResolve = null;
  if (resolve) resolve(result);
}

function openChecks({ exePath, title, intro = '' }) {
  if (checksResolve) closeChecks(false);
  checksExe = exePath;
  $('#checks-title').textContent = title;
  $('#checks-intro').textContent = intro;
  $('#checks-list').textContent = '';
  $('#checks-status').textContent = '';
  const go = $('#checks-go');
  go.classList.add('hidden');
  go.classList.remove('btn-danger');
  go.disabled = false;
  go.onclick = null;
  checksModal.classList.remove('hidden');
}

function showChecksGo(label, onClick, { danger = false } = {}) {
  const go = $('#checks-go');
  go.textContent = label;
  go.classList.toggle('btn-danger', danger);
  go.classList.remove('hidden');
  go.disabled = false;
  go.onclick = onClick;
}

function addCheckItem(severity, text, { fix = null, exePath = null } = {}) {
  const li = document.createElement('li');
  li.className = `check-item check-${severity}`;
  const words = document.createElement('span');
  words.textContent = text;
  li.appendChild(words);
  if (fix && exePath) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-small';
    btn.textContent = fix.id === 'set-gpu-preference' ? t('Set High performance') : t('Open folder');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await window.api.preflightFix(exePath, fix);
      if (!res.ok) { toast(t('The fix failed: {error}', { error: res.error })); btn.disabled = false; return; }
      if (fix.id === 'set-gpu-preference' && res.done) {
        btn.textContent = t('Done');
        li.classList.add('check-resolved');
      } else {
        btn.disabled = false;
      }
    });
    li.appendChild(btn);
  }
  $('#checks-list').appendChild(li);
}

$('#checks-close').addEventListener('click', () => closeChecks(false));
checksModal.addEventListener('click', (e) => { if (e.target === checksModal) closeChecks(false); });

// Resolves true when Install should go ahead. A check that could not run never stands in the way,
// and information alone does not open the dialog.
async function preflightBeforeInstall(game) {
  let res;
  try { res = await window.api.preflight(game.exePath, game.detectedPath || null); } catch { return true; }
  if (!res || !res.ok || !res.checks.some((c) => c.severity !== 'info')) return true;
  const blocked = res.checks.some((c) => c.severity === 'block');
  openChecks({
    exePath: game.exePath,
    title: t('Before installing on {name}', { name: game.name }),
    intro: blocked
      ? t('Install is not offered for this game, for the reason below.')
      : t('Found on this PC or in the game folder, and each is known to break a DLSS 5 install. Deal with them first, or install anyway.'),
  });
  for (const c of res.checks) addCheckItem(c.severity, t(c.text, c.vars || {}), { fix: c.fix, exePath: game.exePath });
  if (!blocked) showChecksGo(t('Install anyway'), () => closeChecks(true));
  return new Promise((resolve) => { checksResolve = resolve; });
}

const PROBE_API_NAMES = { dx8: 'DirectX 8', dx9: 'DirectX 9', dx10: 'DirectX 10', dx11: 'DirectX 11', dx12: 'DirectX 12', vulkan: 'Vulkan', opengl: 'OpenGL' };
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

window.api.onProbeProgress((p) => {
  if (!p || p.exePath !== checksExe) return;
  const status = $('#checks-status');
  if (p.phase === 'launching') status.textContent = p.method === 'etw' ? t('Starting the game…') : t('Starting the game (watching without administrator rights)…');
  else if (p.phase === 'watching') status.textContent = t('Watching: {elapsed} of {seconds} s. Leave the game alone; it is closed by itself.', { elapsed: p.elapsed, seconds: p.seconds });
  else if (p.phase === 'closing') status.textContent = t('Closing the game…');
  else if (p.phase === 'reading') status.textContent = t('Reading what was seen…');
});

function analyseGame(game) {
  openChecks({
    exePath: game.exePath,
    title: t('Analyse game -- {name}', { name: game.name }),
    intro: t('Starts the game once, as it is, for about 25 seconds and writes down what it really loads: the graphics API, which DLLs from where, and which process hands off to which. Nothing is installed or changed, and the game is closed at the end. Leave it alone while it runs.'),
  });
  showChecksGo(t('Start'), async () => {
    $('#checks-go').classList.add('hidden');
    const res = await window.api.probeGame(game.exePath, game.launcher);
    if (checksExe !== game.exePath) return;
    const status = $('#checks-status');
    if (!res.ok) {
      status.textContent = res.cancelled ? t('Not launched.') : t('Analyse game failed: {error}', { error: res.error });
      return;
    }
    const s = res.summary || {};
    if (s.api) {
      addCheckItem('info', t('Graphics API: {api} ({evidence}).', { api: PROBE_API_NAMES[s.api] || s.api, evidence: s.apiEvidence || '' }));
    } else {
      addCheckItem('warn', t('No graphics API was seen. The game may not have reached its renderer in time -- a launcher waiting for a sign-in looks like this.'));
    }
    if (s.handoff && s.realExe) addCheckItem('info', t('The launch hands off to {exe}: that is the process that really runs the game.', { exe: baseName(s.realExe) }));
    if ((s.ignoredProxies || []).length) addCheckItem('warn', t('{files} sits beside the exe, but the game loaded Windows\' own copy instead.', { files: s.ignoredProxies.join(', ') }));
    if (res.proxyHint) addCheckItem('info', t('DLSS 5 goes in as {name} for this game.', { name: res.proxyHint }));
    if ((s.antiCheat || []).length) addCheckItem('warn', t('Anti-cheat seen: {list}.', { list: s.antiCheat.join(', ') }));
    if ((s.overlays || []).length) addCheckItem('warn', t('Overlays seen: {list}.', { list: s.overlays.join(', ') }));
    if (s.method === 'poll') addCheckItem('info', t('Watched without administrator rights, by listing modules once a second: a DLL that loads and unloads quickly, and most of a 32-bit game\'s modules, can be missed.'));
    status.textContent = t('Done. The card uses what was seen from now on, until the game is updated.');
    renderGrid();
  });
}

window.api.onVerifyProgress((p) => {
  if (!p || p.exePath !== checksExe) return;
  const status = $('#checks-status');
  if (p.phase === 'waiting') status.textContent = t('Waiting for the game to start…');
  else if (p.phase === 'running') status.textContent = t('Running: {elapsed} of {seconds} s. Leave the game alone; it is closed by itself.', { elapsed: p.elapsed, seconds: p.seconds });
  else if (p.phase === 'closing') status.textContent = t('Closing the game…');
  else if (p.phase === 'reading') status.textContent = t('Reading the logs…');
});

function verifyInstall(game) {
  openChecks({
    exePath: game.exePath,
    title: t('Verify install -- {name}', { name: game.name }),
    intro: t('Starts the game for about 30 seconds, reads its logs the way Game Help does, and closes it again. Leave the game alone while it runs.'),
  });
  showChecksGo(t('Start'), async () => {
    $('#checks-go').classList.add('hidden');
    const res = await window.api.verifyInstall(game.exePath, game.launcher, game.detectedPath || null);
    if (checksExe !== game.exePath) return;
    const status = $('#checks-status');
    if (!res.ok) {
      status.textContent = res.cancelled ? t('Not launched.') : t('Verify install failed: {error}', { error: res.error });
      return;
    }
    const v = res.verdict;
    status.textContent = '';
    switch (v.code) {
      case 'ran':
        addCheckItem('ok', t('DLSS 5 ran: {frames} frames in the log.', { frames: v.frames }));
        break;
      case 'not-started':
        addCheckItem('warn', t('The game never appeared within a minute. If a launcher is waiting for you, finish there and verify again.'));
        break;
      case 'exited':
        addCheckItem('warn', t('The game closed itself during the check -- often a launcher or a first-run prompt. Start it once by hand, then verify again.'));
        break;
      case 'no-log':
        addCheckItem('warn', t('The game ran but wrote no new log, so OptiScaler may not have loaded. Game Help can say why.'));
        showChecksGo(t('Game Help'), () => { closeChecks(); openHelp(game); });
        break;
      case 'diagnosis':
        addCheckItem('warn', v.diag ? helpWords(v.diag) : t('The game ran, and the logs say something is off.'));
        showChecksGo(t('Game Help'), () => { closeChecks(); openHelp(game); });
        break;
      case 'crash':
        // Offered, not done: the crash can have a cause that has nothing to do with the install, and
        // the files may be wanted for a report.
        addCheckItem('block', t('The game crashed during the check.') + (v.diag ? ' ' + helpWords(v.diag) : ''));
        showChecksGo(t('Uninstall DLSS 5'), async () => {
          if (!window.confirm(t('Remove everything this app put in the game folder?'))) return;
          $('#checks-go').disabled = true;
          const un = await window.api.runUninstall(game.exePath);
          if (un.ok) await removeLosslessProfile(game);
          toast(un.ok ? describeUninstall(un) : t("Couldn't remove OptiScaler: {error}", { error: un.error }));
          closeChecks();
          renderGrid();
        }, { danger: true });
        break;
      default:
        addCheckItem('warn', t('The game ran, and the logs say something is off.'));
    }
  });
}

async function installGame(game) {
  // Normally already on disk (bundled, then kept current); fetched here only if that failed.
  const engineId = engineOf(game);
  const ready = await ensureEngine(engineId);
  if (!ready.ok) {
    toast(t('Could not set up the {engine} build: {error}', { engine: engineLabel(engineId), error: ready.error }));
    return;
  }
  const releaseFolder = engineFolder(engineId);
  const valid = await window.api.validateRelease(releaseFolder);
  if (!valid.valid) {
    toast(t('Set up the OptiScaler release folder in Settings first ({reason}).', { reason: valid.reason }));
    openSettingsModal();
    return;
  }
  const nrValid = await window.api.validateNrDll(settings.nrDllPath);
  if (!nrValid.valid) {
    toast(t('DLSS NR file problem: {reason}', { reason: nrValid.reason }));
    openSettingsModal();
    return;
  }
  // A Feeder game gets its whole route from this one button: the Feeder first (so nvngx_dlss.dll
  // and dlss5-feed.addon64 are on disk when autoConfigureGame runs and picks the DLSS 5 only
  // profile with LoadReshade forced), then OptiScaler. Only the default motion-vector provider
  // is used here -- it is the auto-fetchable one, so no licence dialog; LumeniteFX stays a
  // deliberate choice in Edit. If the Feeder cannot be fetched the install stops: OptiScaler on
  // its own would report "Installed" with nothing to hook, which is the exact confusion this
  // route exists to prevent.
  let feederNote = '';
  // A game added seconds ago may not have its detection cached yet (the card fills it in
  // asynchronously); the route needs the API to know whether the Feeder can run here.
  if (!game.detectedPath) {
    game.detectedPath = await window.api.detectPath(game.exePath);
    window.api.saveGames(games);
  }
  if (!(await preflightBeforeInstall(game))) return;
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);
  // Which add-on runs the neural pass here (Edit / the card menu). When the folder is set up for the
  // other one, this Install is the swap.
  const consumer = chosenConsumer(game);
  const dfcOffered = !!(route.dfcSupport && route.dfcSupport.ok);
  const swapNeeded = dfcOffered && (route.consumerHere || 'optiscaler') !== consumer;

  // A 32-bit game on Chicken: its own companion route replaces this app's whole 32-bit stack, so the
  // switch happens here, before dgVoodoo2 or the helper below would go in. On the way back, the
  // switch takes Chicken out and the route below builds this app's stack again.
  if (route.route === 'feeder32' && dfcOffered && (swapNeeded || consumer === 'dfc')) {
    toast(!swapNeeded ? t('Deploying…') : consumer === 'dfc' ? t('Switching this game to Deep Fried Chicken…') : t('Switching this game back to DLSS 5…'));
    const sw = await window.api.dfcSwitch(game.exePath, consumer, settings.nrDllPath);
    if (!sw.ok) {
      toast(sw.code && String(sw.code).startsWith('dfc-') ? dfcUnsupportedWords(sw.code) : t('Could not switch this game: {error}', { error: sw.error }));
      renderGrid();
      return;
    }
    if (consumer === 'dfc') {
      toast(t('Installed with Deep Fried Chicken. Press Home in the game for its menu.'));
      renderGrid();
      return;
    }
    // Back to DLSS 5: this app's 32-bit route goes in below, from nothing, as on a first install.
    route.dgVoodooDeployed = false;
    route.dxvkDeployed = false;
  }

  // Experimental DirectX 8/9 routes: dgVoodoo2 goes in first. The main process fetches it without
  // asking and only offers a zip of the user's own if that fails; a cancel there stops the install
  // here with nothing placed.
  // DXVK chosen instead (card menu, Edit or Game Help) goes in at the same step, from the same handler.
  const dxvkChosen = route.wrapperPreference === 'dxvk' || route.dxvkDeployed;
  if (route.legacy && route.legacy.dgVoodoo && !route.dgVoodooDeployed && !route.dxvkDeployed) {
    toast(dxvkChosen ? t('Setting up DXVK first…') : t('Setting up dgVoodoo2 first…'));
    const dg = await window.api.legacyDgVoodoo(game.exePath, game.detectedPath);
    if (!dg.ok && dg.code === 'dgvoodoo-quarantined') {
      let report = null;
      try { report = await window.api.safetyDgVoodooQuarantine(game.exePath); } catch {}
      await showQuarantineNotice(report, 'dgVoodoo2');
      renderGrid();
      return;
    }
    if (!dg.ok) {
      toast(dxvkChosen
        ? t('DXVK could not be set up: {error}', { error: dg.error })
        : t('dgVoodoo2 could not be set up: {error}', { error: dg.error }));
      renderGrid();
      return;
    }
    if (dg.cancelled) {
      toast(t('Install stopped: this game\'s DirectX 8/9 route needs dgVoodoo2.'));
      return;
    }
  }

  // Experimental 32-bit route: everything goes through the Feeder's 64-bit helper (legacy.js), and
  // OptiScaler is installed there, not beside the game -- so the rest of this function does not apply.
  if (route.route === 'feeder32') {
    toast(t('Installing the experimental 32-bit route (Feeder, its 64-bit helper, OptiScaler)…'));
    const providers = await ensureFeederProviders();
    let provider = providers.find((p) => p.default && p.autoFetchable) || providers.find((p) => p.autoFetchable);
    // A re-install keeps the provider the player switched to (card menu > Motion vectors) rather
    // than quietly putting VORT back; LumeniteFX asks for its licence again, since it is fetched
    // again, and falls back to the default if that is declined.
    let licenseConfirmed = false;
    const lmv = await window.api.legacyMvProvider(game.exePath);
    const kept = lmv && lmv.host32 && lmv.id ? feederProvidersById[lmv.id] : null;
    if (kept && kept.selectable !== false && kept.id !== (provider && provider.id)) {
      if (kept.bringYourOwn ? lmv.immersePresent : kept.autoFetchable) provider = kept;
      else if (!kept.bringYourOwn && await confirmMvProviderLicense(kept.id)) { provider = kept; licenseConfirmed = true; }
    }
    const res32 = await window.api.legacyInstallHost32({
      exePath: game.exePath,
      detected: game.detectedPath,
      releaseFolder,
      nrDllPath: settings.nrDllPath,
      mvProviderId: provider ? provider.id : null,
      licenseConfirmed,
    });
    toast(!res32.ok
      ? t('Install failed: {error}', { error: res32.error })
      // Under DXVK, DLSS 5 needs ReShade's 32-bit Vulkan layer, which Install sets up last.
      : res32.dxvkLayer && res32.dxvkLayer.dxvkRefused
        ? t('Installed on the game\'s own Direct3D: DXVK could not be put in front of it ({error}). The choice is kept; Game Help can try again.', { error: res32.dxvkLayer.error })
      : res32.dxvkLayer && !res32.dxvkLayer.ok
        ? t('Installed, but ReShade\'s 32-bit Vulkan layer is not set up ({error}), so DLSS 5 cannot run under DXVK yet. Game Help can try again.', { error: res32.dxvkLayer.error })
        : t('Installed. No splash or menu appears in the game on this route -- Game Help shows how to reach it.'));
    renderGrid();
    return;
  }

  // Which add-on runs the neural pass here (Edit > Neural pass). When the folder is set up for the
  // other one, this Install is the swap: feeder:deploy does it whole (dfc.js), and Chicken ends the
  // install there -- OptiScaler going back in on top would put two neural passes in one folder.
  if (route.route === 'feeder' && (!route.feederDeployed || swapNeeded || consumer === 'dfc')) {
    toast(route.feederDeployed
      ? (!swapNeeded ? t('Deploying…') : consumer === 'dfc' ? t('Switching this game to Deep Fried Chicken…') : t('Switching this game back to DLSS 5…'))
      : t('Deploying the DLSS5 Feeder first (ReShade, add-on, motion-vector shader, nvngx_dlss.dll)…'));
    const providers = await window.api.feederMvProviders();
    const provider = providers.find((p) => p.default && p.autoFetchable) || providers.find((p) => p.autoFetchable);
    const deployed = provider
      ? await window.api.feederDeploy(game.exePath, provider.id, { force: false, licenseConfirmed: false, consumer, nrDllPath: settings.nrDllPath, swapOnly: route.feederDeployed })
      : { ok: false, error: t('no auto-fetchable motion-vector provider') };
    if (!deployed.ok && deployed.code === 'dfc-vulkan-layer') {
      // The app's own set-up of ReShade's Vulkan layer did not finish (the administrator prompt
      // declined, say): ReShade's installer is opened so the player can do it by hand.
      toast(t('Could not switch this game: {error}', { error: deployed.error }));
      const r = await window.api.feederOpenReShadeSetup();
      if (r && r.ok) toast(t('ReShade\'s installer is open: pick this game\'s exe, choose Vulkan, tick "Enable loading of add-ons". Then press Install again.'));
      renderGrid();
      return;
    }
    if (!deployed.ok && deployed.code && String(deployed.code).startsWith('dfc-')) {
      toast(dfcUnsupportedWords(deployed.code));
      renderGrid();
      return;
    }
    if (!deployed.ok && swapNeeded) {
      toast(t('Could not switch this game: {error}', { error: deployed.error }));
      renderGrid();
      return;
    }
    if (deployed.ok && consumer === 'dfc') {
      toast(t('Installed with Deep Fried Chicken. Press Home in the game for its menu.'));
      renderGrid();
      return;
    }
    if (!deployed.ok) {
      if (deployed.needsReShadeInstaller) {
        // Vulkan: ReShade's own installer registers the machine-wide layer; this app opens it.
        toast(t('Could not deploy the DLSS5 Feeder: {error}', { error: deployed.error }));
        const r = await window.api.feederOpenReShadeSetup();
        if (r.ok) toast(t('ReShade\'s installer is open: pick this game\'s exe, choose Vulkan, tick "Enable loading of add-ons". Then press Install again.'));
      } else {
        toast(t('Could not deploy the DLSS5 Feeder: {error}. OptiScaler was not installed -- without the Feeder it would have no DLSS call to hook. Retry once you are online.', { error: deployed.error }));
      }
      renderGrid();
      return;
    }
    if (!route.feederDeployed) feederNote = ' ' + t('Deployed the DLSS5 Feeder first ({provider}).', { provider: provider.displayName });
  } else if (route.route !== 'feeder' && dfcOffered && (swapNeeded || consumer === 'dfc')) {
    // A game with no Feeder (its own DLSS, plain OptiScaler route): Chicken 3.0 needs none on
    // Direct3D, so the swap is ReShade fetched in as the proxy, OptiScaler out, Chicken in.
    toast(!swapNeeded ? t('Deploying…') : consumer === 'dfc' ? t('Switching this game to Deep Fried Chicken…') : t('Switching this game back to DLSS 5…'));
    const sw = await window.api.dfcSwitch(game.exePath, consumer, settings.nrDllPath);
    if (!sw.ok) {
      toast(sw.code && String(sw.code).startsWith('dfc-') ? dfcUnsupportedWords(sw.code) : t('Could not switch this game: {error}', { error: sw.error }));
      renderGrid();
      return;
    }
    if (consumer === 'dfc') {
      toast(t('Installed with Deep Fried Chicken. Press Home in the game for its menu.'));
      renderGrid();
      return;
    }
    // A 32-bit Vulkan game has no DLSS 5 route of this app's own: taking Chicken out is all there is.
    if (route.route === 'unsupported') {
      toast(t('Deep Fried Chicken is out. DLSS 5 has no route of its own for this game.'));
      renderGrid();
      return;
    }
    // Back to DLSS 5: OptiScaler goes in below, as on any install.
  }

  toast(t('Installing…'));
  const res = await window.api.installGame({
    exePath: game.exePath,
    releaseFolder,
    nrDllPath: settings.nrDllPath,
    engine: engineId,
  });
  if (res.ok) {
    const mb = (res.nrDllBytes / 1024 / 1024).toFixed(0);
    const proxyNote = res.proxyUpdated ? ' ' + t('Also refreshed the active {file}.', { file: res.proxyUpdated }) : '';
    const configNote = res.autoConfigured && res.autoConfigured.length > 0
      ? ' ' + t('Auto-configured for {api}: {keys}.', { api: res.api || t('detected API'), keys: res.autoConfigured.map((e) => e.key).join(', ') })
      : '';
    const streamlineNote = res.streamline && res.streamline.deployed
      ? ' ' + t('Deployed Streamline {version} for DLSS Frame Gen.', { version: res.streamline.version || '' }).replace('  ', ' ')
      : '';
    const reEngineNote = res.reEngine ? ' ' + t('Detected RE Engine (Capcom).') : '';
    // Named so it's obvious why the upscaler wasn't touched and FrameGen was forced off --
    // the game already does its own DLSS (and DLSS-G where it has it); OptiScaler is only
    // adding Neural Rendering on top, not replacing anything.
    const profileNote = res.profile === 'dlss5-only'
      ? ' ' + t('Native DLSS detected -- used the "DLSS 5 only" profile (Neural Rendering on the game’s own DLSS, upscaler/frame-gen untouched).')
      : '';

    // The rename is the step that actually hooks the game, so it gets said out loud -- and if it
    // could not happen, that is the difference between "installed" and "installed but inert".
    const proxyCreatedNote = res.proxy && res.proxy.created
      ? ' ' + t('Hooked it up as {proxy}{backup}.', { proxy: res.proxy.proxy, backup: res.proxy.backedUp ? ' ' + t('(backed up the original as {file})', { file: res.proxy.backedUp }) : '' })
      : res.proxyError
        ? ' ' + t('NOTE: could not set up the proxy DLL -- {error} Use "Run Setup" to do it by hand.', { error: res.proxyError })
        : '';

    // Worth naming rather than folding into a count: two of these are settings that crash the game
    // rather than settings that are merely suboptimal, and one of them was written by an older
    // version of this app, so "corrected" is the honest word for what happened.
    const hotfix = res.reEngineHotfix || [];
    const hotfixNote = hotfix.length
      ? ' ' + t('Applied the RE Engine hotfix ({keys}).', { keys: hotfix.map((h) => `${h.key}=${h.value}`).join(', ') })
      : '';
    // On the install path a REFramework failure now stops the install outright, so this only ever
    // reports the good cases. The error branch stays for the sync path, which patches an existing
    // install and must not pretend a missing prerequisite is fine.
    const reframeworkNote = res.reframework && res.reframework.installed
      ? ' ' + t('Installed REFramework (required for OptiScaler on RE Engine).')
      : res.reframework && res.reframework.alreadyPresent ? ' ' + t('REFramework already present.')
      : res.reframework && res.reframework.error
        ? ' ' + t('WARNING: REFramework is missing ({error}) -- OptiScaler will not run on this game until it is there.', { error: res.reframework.error })
        : '';
    // Only fires once REFramework has actually generated its config from a prior run of the game --
    // there is nothing to fix on a brand new install.
    const reframeworkConfigNote = res.reframeworkConfig && res.reframeworkConfig.length > 0
      ? ' ' + t('Set REFramework’s menu key to Insert (it had drifted to Numpad0, unreachable on a laptop) and enlarged its overlay text.')
      : '';
    // Somebody else's OptiScaler was already in the proxy slot, so that is the build the game
    // loads -- ours sits beside it doing nothing. Said here because every other screen would show
    // a clean "Installed": this is the DOOM 3 BFG case (winmm.dll, an upstream build, no neural
    // pass). Nothing of theirs is deleted; the file is named so the choice stays theirs.
    const foreignProxyNote = res.foreignProxy
      ? ' ' + t('WARNING: {file} here is an OptiScaler this app did not install -- the game loads that one, not ours, so Neural Rendering will not run. Remove or rename {file} and install again.', { file: res.foreignProxy })
      : '';
    const proxyRefreshNote = res.proxyRefreshError
      ? ' ' + t('NOTE: the proxy DLL could not be refreshed ({error}) -- the game is still running the previous build.', { error: res.proxyRefreshError })
      : '';
    // A Luma game: offer Luma right here, with its licence in the question, instead of sending the user
    // to Edit for the one step Install cannot do without asking (lumaue.js LUMA_LICENSE_SUMMARY).
    let lumaNote = '';
    if (route.route === 'lumaue' && !route.lumaDeployed) {
      const readiness = await window.api.lumaUeReadiness(game.exePath);
      const agreed = readiness.ok && readiness.supported && !readiness.knownBad &&
        window.confirm(t('This game gets its DLSS call from Luma. Download and set up Luma now?') + '\n\n' + (readiness.licenseSummary || ''));
      if (agreed) {
        const deployed = await window.api.lumaUeDeploy(game.exePath, { licenseConfirmed: true });
        lumaNote = deployed.ok
          ? ' ' + t('Luma is set up with DLSS switched on.')
          : ' ' + t('Could not deploy Luma UE: {error}', { error: deployed.error });
      } else {
        lumaNote = ' ' + t('Next: open Edit and deploy Luma UE -- OptiScaler has no DLSS call to hook in this game until Luma supplies one.');
      }
    }
    // Users read a wall of text here as something having gone wrong (2026-09-15). The toast says
    // "Installed" plus only what needs doing; everything informational goes to the console.
    // An emulator's renderer is its own setting, and the install only works on the one it was set up
    // for (emulators.js, #106) -- said at the moment the player is about to launch it.
    const emuRenderer = route.emulatorRenderer || null;
    const emulatorNote = emuRenderer ? ' ' + emulatorRendererWords(emuRenderer) : '';
    const actionNotes = [
      res.proxyError ? proxyCreatedNote : '', foreignProxyNote, proxyRefreshNote,
      res.reframework && res.reframework.error ? reframeworkNote : '', lumaNote, emulatorNote,
    ].join('');
    console.info('[install]', game.name, `${feederNote} ${t('Copied nvngx_dlssnr.dll ({mb} MB) to {dir}', { mb, dir: res.dir })}${proxyNote}${proxyCreatedNote}${configNote}${streamlineNote}${reEngineNote}${profileNote}${hotfixNote}${reframeworkNote}${reframeworkConfigNote}`);
    toast(`${t('Installed.')}${actionNotes}`);
    checkQuarantineAfterInstall(game);
    // A Resident Evil on the pd route still missing PureDark's plugin: say so now, not on a card
    // line someone may not read. Once imported it is placed automatically, so this pops only once.
    const after = await window.api.gameRoute(game.exePath, game.detectedPath);
    const pluginStep = after.route === 'reframework-pd' ? (after.steps || []).find((s) => s.key === 'pd-plugin') : null;
    if (pluginStep && !pluginStep.done) openPdPluginModal();
  } else {
    toast(t('Install failed: {error}', { error: res.error }));
  }
  renderGrid();
}

// ── PureDark's Upscaler Base Plugin (Resident Evil pd route) ─────────────────
// See src/pdplugin.js. The popup points at Nexus, then finds the download in Downloads (re-checked
// whenever the window regains focus, i.e. when the user comes back from the browser) or takes a
// picked file, imports it once, and the main process places it in every game that needs it.
const pdPluginModal = $('#pdplugin-modal');
let pdPluginBusy = false;

function pdPluginSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function refreshPdPluginModal() {
  const st = await window.api.pdPluginStatus();
  const found = $('#pdplugin-found');
  found.innerHTML = '';
  if (st.cached) {
    const ok = document.createElement('div');
    ok.className = 'status-line status-ok';
    ok.textContent = t('Imported {file} -- it is placed in every Resident Evil that needs it.', { file: st.cached.from });
    found.appendChild(ok);
  }
  const fresh = (st.candidates || []).filter((c) => !st.cached || c.name !== st.cached.from);
  if (fresh.length === 0) {
    if (!st.cached) {
      const none = document.createElement('div');
      none.className = 'status-line';
      none.textContent = t('Nothing found in Downloads yet. After downloading, come back to this window -- it looks again.');
      found.appendChild(none);
    }
    return;
  }
  const label = document.createElement('div');
  label.className = 'field-label';
  label.textContent = t('Found in Downloads');
  found.appendChild(label);
  for (const c of fresh.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'field-row pdplugin-candidate';
    const name = document.createElement('span');
    name.className = 'pdplugin-candidate-name';
    name.textContent = `${c.name} (${pdPluginSize(c.size)}, ${new Date(c.mtimeMs).toLocaleString()})`;
    name.title = c.path;
    const use = document.createElement('button');
    use.className = 'btn btn-primary btn-small';
    use.textContent = t('Use this file');
    use.addEventListener('click', () => importPdPlugin(c.path));
    row.appendChild(name);
    row.appendChild(use);
    found.appendChild(row);
  }
}

async function importPdPlugin(sourcePath) {
  if (!sourcePath || pdPluginBusy) return;
  pdPluginBusy = true;
  const status = $('#pdplugin-status');
  status.className = 'status-line';
  status.textContent = t('Importing…');
  try {
    const res = await window.api.pdPluginImport(sourcePath);
    if (!res.ok) {
      status.className = 'status-line status-bad';
      status.textContent = t('Could not use that file: {error}', { error: res.error });
      return;
    }
    const parts = [];
    if (res.placed.length) parts.push(t('Placed in: {list}.', { list: res.placed.join(', ') }));
    if (res.waiting.length) parts.push(t('Goes in when installed: {list}.', { list: res.waiting.join(', ') }));
    for (const s of res.skipped) parts.push(t('{name}: left alone -- {reason}.', { name: s.name, reason: t(s.reason) }));
    status.className = 'status-line status-ok';
    status.textContent = [t('PDPerfPlugin.dll is ready.'), ...parts].join(' ');
    toast(t('PDPerfPlugin.dll is ready. In-game: Insert opens REFramework -> TemporalUpscaler -> Enabled, Upscale Type DLSS.'));
    await refreshPdPluginModal();
    renderGrid();
  } finally {
    pdPluginBusy = false;
  }
}

async function openPdPluginModal() {
  $('#pdplugin-status').textContent = '';
  pdPluginModal.classList.remove('hidden');
  await refreshPdPluginModal();
}

function closePdPluginModal() { pdPluginModal.classList.add('hidden'); }

$('#pdplugin-close').addEventListener('click', closePdPluginModal);
pdPluginModal.addEventListener('click', (e) => { if (e.target === pdPluginModal) closePdPluginModal(); });
$('#pdplugin-open-page').addEventListener('click', async () => {
  const st = await window.api.pdPluginStatus();
  window.api.openExternal(st.pageUrl);
});
$('#pdplugin-browse').addEventListener('click', async () => {
  const picked = await window.api.pdPluginPick();
  if (picked) importPdPlugin(picked);
});

// Says what was actually done rather than what was started. The old flow could only report that a
// terminal had opened, which is why the badge and the folder could disagree.
// One sentence per runlog.js verdict, with the numbers that matter.
// The same run as describeRun, with the words taken out: what the card shows beside the route,
// where the chip has already said it worked and only the numbers add anything.
function runEvidenceShort(run) {
  if (!run || !run.ran || run.verdict !== 'nr-ran') return '';
  const parts = [t('{count} passes', { count: run.nrFrames || run.nrDispatch })];
  if (run.fps) parts.push(t('{fps} fps', { fps: run.fps }));
  if (run.runtimeApi) parts.push(run.runtimeApi.toUpperCase());
  return parts.join(' \u00b7 ');
}

function describeRun(run) {
  if (!run || !run.ran) return t('not run yet');
  const api = run.runtimeApi ? run.runtimeApi.toUpperCase() : null;
  switch (run.verdict) {
    case 'nr-ran': return t('Neural Rendering ran ({count} passes{fps}{api})', { count: run.nrFrames || run.nrDispatch, fps: run.fps ? ', ' + run.fps + ' fps' : '', api: api ? ', ' + api : '' });
    case 'dlss-no-nr': return run.detail === 'd3d11-native'
      ? t('DLSS was created on the native D3D11 path, so Neural Rendering never ran -- Dx11Upscaler must be dlss_12; Install again to fix the ini')
      : t('DLSS was created but Neural Rendering never ran');
    case 'init-no-feature': return run.detail === 'feeder-technique-missing'
      ? t('DLSS initialised but the Feeder\'s shader technique was missing -- deploy the Feeder again')
      : t('DLSS initialised but no feature was ever created -- with Luma UE, select DLSS in its overlay (Home) in gameplay');
    case 'no-dlss': return t('nothing called DLSS -- nothing was hooked{api}', { api: api ? ' (' + api + ')' : '' });
    case 'duplicate-dlss': return t('crashed: two DLSS DLLs loaded (a Feeder on a game that ships DLSS) -- remove the Feeder');
    case 'shutdown-fault': return t('crashed on the way out inside NVIDIA\'s NGX shutdown (a Feeder on a game that ships DLSS) -- remove the Feeder');
    case 'ue-crash': return t('crashed (Unreal crash report: {message})', { message: (run.detail || '').slice(0, 120) || t('see the report') });
    case 'driver-outdated': return run.detail ? t('the NVIDIA driver is too old for DLSS 5 (needs {min} or newer)', { min: run.detail }) : t('the NVIDIA driver is too old for DLSS 5');
    case 'nr-model-crash': return t('the DLSS 5 model crashed on its first frame and the Feeder stopped');
    case 'feed-host-gone': return t('the 64-bit helper went away this run -- host64\\dlss5-feed-host.log says why');
    case 'feed-stopped': return t('the Feeder gave up this run -- see dlss5-feed.log for its own diagnosis');
    case 'feed-no-motion': return t('the feed ran but DLSS got no motion vectors -- sharp when still, smearing in motion; deploy the Feeder again');
    case 'feed-depth-flat': return t('the feed ran but depth read flat while the scene moved -- Generic Depth is on the wrong buffer');
    case 'feed-agility-redist': return t('Direct3D 12 refused every device create in the process (D3D12_ERROR_INVALID_REDIST) -- the game\'s own D3D12 redist folder blocks it');
    case 'wrapper-crash': return t('crashed as it started, inside {dll} (a DirectX wrapper in the game folder)', { dll: run.detail || '' });
    default: return t('not run yet');
  }
}

function describeUninstall(res) {
  const failedList = res.failed || [];
  const removed = (res.removed || []).length ? ' ' + t('Removed: {list}.', { list: res.removed.join(', ') }) : ' ' + t('Nothing left to remove.');
  const restored = (res.restored || []).length ? ' ' + t('Restored: {list}.', { list: res.restored.join(', ') }) : '';
  const kept = (res.kept || []).length ? ' ' + t('Left alone: {list}.', { list: res.kept.join('; ') }) : '';
  // Windows refuses to delete a file that is still mapped into a running process, so the first thing
  // to try is closing the game -- named before anything else, because it is the actionable part.
  const failed = failedList.length
    ? ' ' + t('Could not delete: {list}. Close the game and anything launched with it, then press Remove again -- or delete them by hand.', {
      list: failedList.map((f) => (f.code ? `${f.rel} (${f.code})` : f.rel)).join(', '),
    })
    : '';
  const head = failedList.length ? t('DLSS 5 partly removed.') : t('DLSS 5 removed.');
  return `${head}${failed}${removed}${restored}${kept}`;
}

// The escape hatch. Installing no longer needs this -- the app does the rename itself -- but the
// script also handles OptiPatcher and the spoofing questions, and someone who wants those, or who
// hits the backup refusal, still needs a way to run it.

async function removeGame(game) {
  const choice = await window.api.confirmRemove(game.name);
  if (choice === 'cancel') return;

  if (choice === 'remove-and-forget') {
    const res = await window.api.runUninstall(game.exePath);
    if (res.ok) await removeLosslessProfile(game);
    toast(res.ok ? describeUninstall(res) : t("Couldn't remove OptiScaler: {error}. Removed from the list anyway.", { error: res.error }));
  }

  games = games.filter((g) => g.id !== game.id);
  window.api.saveGames(games);
  renderGrid();
}
let lastPickedExe = null;
const gameModal = $('#game-modal');

// Edit's "Launch through": auto (a launcher.exe found near the game, else the exe), the exe directly, or
// a launcher someone picked. Stored on the game as launcher: 'auto' | 'direct' | a path.
async function loadLauncherChoice(game, chosen = game ? game.launcher : undefined) {
  const select = $('#game-launcher');
  const exePath = $('#game-exe').value.trim() || (game && game.exePath) || '';
  let found = null;
  try { found = exePath ? (await window.api.gameLauncher(exePath)).found : null; } catch {}
  const name = (p) => String(p).split(/[\\/]/).pop();
  select.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; select.appendChild(o);
  };
  add('auto', found ? t('Auto: {exe} found beside the game', { exe: name(found) }) : t('Auto: the game exe (no launcher found)'));
  add('direct', t('The game exe directly'));
  if (chosen && chosen !== 'auto' && chosen !== 'direct') add(chosen, t('Launcher: {exe}', { exe: chosen }));
  select.value = chosen && [...select.options].some((o) => o.value === chosen) ? chosen : 'auto';
}

$('#btn-browse-launcher').addEventListener('click', async () => {
  const res = await window.api.pickExe();
  if (!res) return;
  // The launcher is taken exactly as picked; no Unreal shipping-exe swap applies to it.
  const picked = res.picked || res.path;
  const game = games.find((g) => g.id === editingGameId) || null;
  await loadLauncherChoice(game, picked);
});

// opts.focus: 'legacy-mv' opens straight at the 32-bit route's motion-vector picker (the card's
// "Motion vectors" entry).
async function openGameModal(game, opts = {}) {
  editingGameId = game ? game.id : null;
  $('#game-modal-title').textContent = game ? t('Edit Game') : t('Add Game');
  $('#game-exe').value = game ? game.exePath : '';
  $('#game-name').value = game ? game.name : '';
  lastPickedExe = null;
  exeNote('');
  loadExeCandidates(game);
  loadLauncherChoice(game);
  pendingBanner = {
    appid: game ? game.bannerAppId || null : null,
    localPath: game ? game.bannerLocalPath || null : null
  };
  $('#steam-search-term').value = game ? game.name : '';
  $('#steam-results').innerHTML = '';
  updateBannerPreview();
  gameModal.classList.remove('hidden');
  await loadEngineSection(game);
  await loadLayerSection(game);
  await loadApiSection(game);
  await loadProxySection(game);
  await loadEngineProfileStatus(game);
  await loadFrameGenSection(game);
  await loadInjectorSection(game);
  await loadFeederSection(game);
  // Which add-on runs the neural pass: shown on every game Chicken is offered on (route.dfcSupport),
  // Feeder or not -- Chicken 3.0 needs no Feeder on Direct3D.
  await loadConsumerSection(game);
  await loadLegacyMvSection(game);
  await loadOptiFgSection(game);
  await loadDlssNrSection(game);
  await loadLosslessSection(game);
  await loadRelimiterSection(game);
  await loadAmdNrSection(game);
  await loadLumaUeSection(game);
  refreshEditGroups();
  if (opts.focus === 'legacy-mv' && !$('#game-legacy-mv-section').classList.contains('hidden')) {
    $('#edit-group-advanced').open = true;
    $('#game-legacy-mv-section').scrollIntoView({ block: 'center' });
    $('#game-legacy-mv-provider').focus();
  }
}

// The Edit dialog's groups (Game / DLSS 5 / Frame Generation / Advanced) hide themselves when none of
// their sections applies to this game, so a game with no Frame Generation shows no empty heading.
// Sections toggle their own `hidden` class as they load and after every action, so this follows them.
// Sections marked advanced-only (API, Feeder, launch mode, Frame Generation, Lossless...) only count --
// and only show (style.css, body.show-advanced) -- with Settings > Show advanced options on. Install
// already picks the right setup, so by default Edit is just the game and its DLSS 5 settings.
function refreshEditGroups() {
  const advanced = !!settings.showAdvanced;
  document.body.classList.toggle('show-advanced', advanced);
  for (const group of document.querySelectorAll('#game-modal details.edit-group')) {
    if (group.id === 'edit-group-game') continue;
    const blocks = [...group.children].filter((el) => el.tagName !== 'SUMMARY');
    const visible = blocks.some((el) => !el.classList.contains('hidden') && (advanced || !el.classList.contains('advanced-only')));
    group.classList.toggle('hidden', !visible);
  }
}
new MutationObserver(() => refreshEditGroups()).observe(document.querySelector('#game-modal'), { attributes: true, attributeFilter: ['class'], subtree: true });


// ── DLSS 5 settings ───────────────────────────────────────────────────────────────────────────
//
// The in-game panel's controls, generated from the field table in dlssnr.js rather than written
// out by hand, so the two cannot drift: a key added to the ini becomes a control here by being
// described there once. Values live in the game's own OptiScaler.ini -- host64\OptiScaler.ini on
// the 32-bit route -- and take effect on the next launch.
//
// A user with a working 32-bit install had no way to change any of this without reaching a panel
// that never appears over the game (2026-09-14). That is what this section is for.
let dlssNrFields = [];
// Keys this app holds to a value for this game, key -> why. Shown as held rather than offered.
let dlssNrForced = {};

function dlssNrValueOf(key) {
  const f = dlssNrFields.find((x) => x.key === key);
  if (!f) return null;
  return f.value === null ? f.default : f.value;
}

// A field whose dependsOn is not met is shown greyed rather than hidden: the setting still exists
// and is still written, and hiding it would make it look as though the app had lost it.
function dlssNrDependencyMet(field) {
  const d = field.dependsOn;
  if (!d) return true;
  // { all: [...] }: every condition, e.g. Adaptive resolution's "Frame rate" needs it on AND aimed at fps.
  if (Array.isArray(d.all)) return d.all.every((c) => dlssNrDependencyMet({ dependsOn: c }));
  // { any: [...] }: one condition is enough, e.g. Enlargement matters whenever the model runs small.
  if (Array.isArray(d.any)) return d.any.some((c) => dlssNrDependencyMet({ dependsOn: c }));
  const v = dlssNrValueOf(d.key);
  if (d.is !== undefined) return v === d.is;
  if (d.atLeast !== undefined) return Number(v) >= d.atLeast;
  if (d.above !== undefined) return Number(v) > d.above;
  if (d.below !== undefined) return Number(v) < d.below;
  return true;
}

async function loadDlssNrSection(game) {
  const section = $('#game-display-section');
  const status = $('#game-display-status');
  const helperNote = $('#game-display-helper-note');
  const host = $('#game-display-fields');
  if (!game || !game.exePath) { section.classList.add('hidden'); return; }

  const res = await window.api.dlssNrGet(game.exePath);
  if (!res || !res.ok) {
    // Not installed yet is the ordinary case, not an error worth a red line.
    section.classList.toggle('hidden', true);
    return;
  }
  section.classList.remove('hidden');
  helperNote.classList.toggle('hidden', !res.inHelper);
  dlssNrFields = res.fields;
  dlssNrForced = res.forced || {};
  status.textContent = '';
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);
  dlssNrEmulator = !!(route && route.emulator);
  renderDlssNrFields(game);
}

// ── Emulators: the model's resolution as a resolution ───────────────────────────────────────────
//
// An emulator's frame is its window, so DLSS 5 works at display size whatever internal resolution
// the emulator renders at: an RPCS3 user at 4K had to drop the desktop to 1440p to get the cost
// back (2026-09-14). WorkingScale already fixes that; this names it the way that user thinks of it.
let dlssNrEmulator = false;

const EMULATOR_MODEL_HEIGHTS = [2160, 1800, 1440, 1080, 900, 720];

// The monitor the app is on, in physical pixels -- the emulator's fullscreen size on that monitor.
function displayPixels() {
  const ratio = window.devicePixelRatio || 1;
  return { width: Math.round(window.screen.width * ratio), height: Math.round(window.screen.height * ratio) };
}

function renderDlssNrEmulator(game) {
  const block = $('#game-dlssnr-emulator');
  block.classList.toggle('hidden', !dlssNrEmulator);
  if (!dlssNrEmulator) return;

  const select = $('#game-dlssnr-emulator-res');
  const note = $('#game-dlssnr-emulator-note');
  const display = displayPixels();
  const scale = Number(dlssNrValueOf('WorkingScale')) || 1;
  const sizeAt = (s) => `${Math.round(display.width * s)}x${Math.round(display.height * s)}`;

  select.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; select.appendChild(o);
  };
  add('1', t('Display resolution ({size}) -- default', { size: `${display.width}x${display.height}` }));
  for (const h of EMULATOR_MODEL_HEIGHTS) {
    const s = h / display.height;
    if (s >= 0.999 || s < 0.25) continue;
    add(String(Math.round(s * 100) / 100), t('{h}p ({size}, {pct}% of the work area)', { h, size: sizeAt(s), pct: Math.round(s * 100) }));
  }
  // A value set elsewhere (the slider below, the in-game panel) that is none of the above.
  const current = String(Math.round(scale * 100) / 100);
  if (![...select.options].some((o) => o.value === current)) add(current, t('Custom: {pct}% ({size})', { pct: Math.round(scale * 100), size: sizeAt(scale) }));
  select.value = current;

  note.textContent = scale < 0.999
    ? t('The model works at {size}: about {pct}% of the display-resolution cost.', { size: sizeAt(scale), pct: Math.round(scale * scale * 100) })
    : '';
  select.onchange = () => applyDlssNr(game, 'WorkingScale', Number(select.value) >= 0.999 ? null : Number(select.value));
}

// CSS cannot read an input's value, so the filled part of a slider's track is a percentage this
// sets on the element (see input[type="range"] in style.css).
function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`);
}

// Paper white runs 0.25 to 2000. On a linear track its whole usable range is the first pixel, so
// those fields carry log: true and the slider is a 0..1000 position mapped onto the range instead
// -- the same thing the in-game panel does with them.
const sliderPos = (f, v) => Math.round((f.log ? Math.log(v / f.min) / Math.log(f.max / f.min) : (v - f.min) / (f.max - f.min)) * 1000);
const sliderVal = (f, pos) => (f.log ? f.min * Math.pow(f.max / f.min, pos / 1000) : f.min + (pos / 1000) * (f.max - f.min));

// Keyboard stepping. The sliders are positioned on a 0..1000 scale so a log range can be resolved
// at all, which means the browser's own arrow-key step is a thousandth of the range -- 0.002 of a
// Model pass, 0.175% of Model resolution -- and each field's declared step went unused. These move
// by that step instead, snapped to its grid so repeated presses land on round numbers (1.1, 1.2,
// 1.3) rather than drifting off them, with Page Up/Down for ten at a time and Home/End for the ends.
const STEP_DIR = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 };

function stepOf(field) {
  return Number(field.step) || (field.type === 'int' ? 1 : 0.05);
}

function steppedValue(field, value, dir, big) {
  const step = stepOf(field) * (big ? 10 : 1);
  const snapped = Math.round(value / step) * step;
  // Already on the grid, or snapping moved it the way we were going anyway.
  const next = Math.abs(snapped - value) > 1e-9 && Math.sign(snapped - value) === dir ? snapped : snapped + dir * step;
  const clamped = Math.min(field.max, Math.max(field.min, next));
  return field.type === 'int' ? Math.round(clamped) : Number(clamped.toFixed(6));
}

function showNumber(field, value) {
  if (field.percent) return `${Math.round(value * 100)}%`;
  if (field.type === 'int') return String(Math.round(value));
  if (field.log) return `${Number(value).toFixed(2)}x`;
  return String(Number(Number(value).toFixed(4)));
}

// The whole [DlssNr] table used to be laid out here, a second copy of the in-game panel that a
// player could set a value in while the panel had the same file open. Alt+Shift+Home is the panel,
// live, over the frame it changes -- so only the Window group survives here, because the window a
// game opens in is decided before there is a frame to see.
//
// It was called Display until the 2026-09-20 regroup, which split the game's window from the panel's
// own appearance. They had been one section, and merging them would have put Language and Font size
// in this dialog -- settings that mean nothing until there is a frame to look at.
const EDITABLE_GROUPS = ['Window'];

function renderDlssNrFields(game) {
  renderDlssNrEmulator(game);
  const host = $('#game-display-fields');
  host.innerHTML = '';
  {
    for (const field of dlssNrFields.filter((f) => EDITABLE_GROUPS.includes(f.group))) {
      const row = document.createElement('div');
      row.className = 'dlssnr-row';
      const heldReason = dlssNrForced[field.key] || null;
      const met = dlssNrDependencyMet(field) && !heldReason;
      row.classList.toggle('dlssnr-inactive', !met);

      const label = document.createElement('label');
      label.className = 'dlssnr-label has-tip';
      label.textContent = t(field.label);
      label.setAttribute('data-tip', heldReason ? t(heldReason) : t(field.help));
      row.appendChild(label);

      const shown = field.value === null ? field.default : field.value;
      let input;
      if (field.type === 'bool') {
        input = document.createElement('select');
        for (const [value, text] of [['auto', t('Default ({state})', { state: field.default ? t('on') : t('off') })], ['true', t('On')], ['false', t('Off')]]) {
          const o = document.createElement('option');
          o.value = value; o.textContent = text; input.appendChild(o);
        }
        input.value = field.value === null ? 'auto' : String(field.value);
      } else if (field.type === 'enum' || field.type === 'code') {
        input = document.createElement('select');
        const def = document.createElement('option');
        def.value = 'auto';
        const defOption = (field.options || []).find(([v]) => v === field.default);
        def.textContent = field.default === null ? t(field.type === 'code' ? 'Default (follow Windows)' : 'Default (follow pass 1)') : t('Default ({state})', { state: defOption ? t(defOption[1]) : String(field.default) });
        input.appendChild(def);
        for (const [value, text] of field.options || []) {
          const o = document.createElement('option');
          o.value = String(value); o.textContent = t(text); input.appendChild(o);
        }
        input.value = field.value === null ? 'auto' : String(field.value);
      } else {
        // Numbers get a slider and a readout, with "Default" as its own button rather than a
        // magic position on the track -- auto is a state, not a value.
        input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '1000';
        input.step = '1';
        input.value = String(sliderPos(field, Number(shown)));
        paintRange(input);
      }
      input.className = 'dlssnr-input';
      input.disabled = !met;
      row.appendChild(input);

      const readout = document.createElement('span');
      readout.className = 'dlssnr-readout';
      const describe = () => {
        if (heldReason) return t('held off');
        if (field.type === 'bool' || field.type === 'enum') return field.value === null ? t('default') : '';
        return field.value === null ? t('{n} (default)', { n: showNumber(field, shown) }) : showNumber(field, shown);
      };
      readout.textContent = describe();
      row.appendChild(readout);

      if (field.type === 'float' || field.type === 'int') {
        const reset = document.createElement('button');
        reset.className = 'btn btn-ghost btn-small';
        reset.textContent = t('Default');
        reset.disabled = !met;
        reset.addEventListener('click', () => applyDlssNr(game, field.key, null));
        row.appendChild(reset);
        input.addEventListener('input', () => { readout.textContent = showNumber(field, sliderVal(field, Number(input.value))); paintRange(input); });
        let pendingKey = null;
        input.addEventListener('keydown', (e) => {
          const dir = STEP_DIR[e.key];
          const ends = e.key === 'Home' || e.key === 'End';
          if (dir === undefined && !ends) return;
          e.preventDefault();
          const at = sliderVal(field, Number(input.value));
          const next = ends ? (e.key === 'Home' ? field.min : field.max)
                            : steppedValue(field, at, dir, e.key.startsWith('Page'));
          input.value = String(sliderPos(field, next));
          paintRange(input);
          readout.textContent = showNumber(field, next);
          clearTimeout(pendingKey);
          pendingKey = setTimeout(() => applyDlssNr(game, field.key, next), 180);
        });
        input.addEventListener('change', () => {
          const v = sliderVal(field, Number(input.value));
          applyDlssNr(game, field.key, field.type === 'int' ? Math.round(v) : Number(v.toFixed(4)));
        });
      } else {
        input.addEventListener('change', () => applyDlssNr(game, field.key, input.value === 'auto' ? null : input.value));
      }

      host.appendChild(row);
    }
  }
}

async function applyDlssNr(game, key, value) {
  const status = $('#game-display-status');
  const res = await window.api.dlssNrSet(game.exePath, { [key]: value });
  if (!res || !res.ok) {
    status.textContent = t('Could not save: {error}', { error: (res && res.error) || t('unknown') });
    return;
  }
  dlssNrFields = res.fields;
  status.textContent = res.written.length
    ? t('Saved. Applies the next time the game starts.')
    : t('Nothing to change.');
  renderDlssNrFields(game);
}

$('#btn-display-reset').addEventListener('click', async () => {
  const game = games.find((g) => g.id === editingGameId);
  if (!game) return;
  const all = {};
  // Only the keys this dialog shows: the rest belong to the in-game panel, and a Reset here that
  // silently threw away someone's tuning would be the worst kind of surprise.
  for (const f of dlssNrFields.filter((x) => EDITABLE_GROUPS.includes(x.group))) all[f.key] = null;
  const res = await window.api.dlssNrSet(game.exePath, all);
  const status = $('#game-display-status');
  if (!res || !res.ok) { status.textContent = t('Could not save: {error}', { error: (res && res.error) || t('unknown') }); return; }
  dlssNrFields = res.fields;
  status.textContent = t('Back to default. Applies the next time the game starts.');
  renderDlssNrFields(game);
});

// DLSS NR on AMD -- shown only on an AMD card (see amdnr.js for the whole picture and for why
// this section never downloads the tool itself).
async function loadAmdNrSection(game) {
  const section = $('#game-amdnr-section');
  const status = $('#game-amdnr-status');
  const latest = $('#game-amdnr-latest');
  const fetchBtn = $('#btn-amdnr-fetch-model');
  const runBtn = $('#btn-amdnr-run-setup');
  if (!game || !game.exePath || gpu.vendor !== 'amd') {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  latest.textContent = '';

  const api = game.detectedPath ? game.detectedPath.api : null;
  const st = await window.api.amdNrStatus(game.exePath, api);
  if (!st.ok) {
    status.className = 'status-line status-bad';
    status.textContent = st.error;
    fetchBtn.disabled = true;
    runBtn.classList.add('hidden');
    return;
  }

  runBtn.classList.toggle('hidden', !st.setupPresent);
  fetchBtn.disabled = false;
  fetchBtn.textContent = st.nrDllPresent && st.nrDllVersion && !st.nrDllVersion.startsWith(st.wantedNrModel)
    ? t('Replace nvngx_dlssnr.dll with {version} (backs up the current one)', { version: st.wantedNrModel })
    : t('Fetch nvngx_dlssnr.dll {version}', { version: st.wantedNrModel });
  fetchBtn.dataset.replace = st.nrDllPresent && st.nrDllVersion && !st.nrDllVersion.startsWith(st.wantedNrModel) ? '1' : '';

  const parts = [];
  if (!st.supported) parts.push(t(st.reason, st.reasonVars));
  parts.push(st.logPresent
    ? t('Its installer has run in this folder{hint}.', { hint: st.toolVersionHint ? ' ' + t('({version} per its log)', { version: st.toolVersionHint }) : '' })
    : st.setupPresent
      ? t('dlssnr_on_amd_setup.exe is in the folder but has not been run yet -- click "Run its installer".')
      : t("Not in this game's folder yet -- download dlssnr_on_amd_setup.exe from the release page and put it beside the game exe."));
  parts.push(st.nrDllPresent
    ? t('nvngx_dlssnr.dll: {version}{note}.', { version: st.nrDllVersion || t('unknown version'), note: st.nrDllVersion && !st.nrDllVersion.startsWith(st.wantedNrModel) ? ' ' + t('(the tool asks for {wanted}.0)', { wanted: st.wantedNrModel }) : '' })
    : t('nvngx_dlssnr.dll: missing -- the tool needs {wanted}.0 beside the exe.', { wanted: st.wantedNrModel }));
  const modelOk = st.nrDllPresent && (!st.nrDllVersion || st.nrDllVersion.startsWith(st.wantedNrModel));
  status.className = `status-line ${!st.supported ? 'status-bad' : st.logPresent && modelOk ? 'status-ok' : ''}`.trim();
  status.textContent = parts.join(' ');

  latest.textContent = t('Checking the latest release…');
  const rel = await window.api.amdNrLatest();
  if (!rel.ok) {
    latest.textContent = t('Could not check the latest release ({error}).', { error: rel.error });
    return;
  }
  const when = rel.publishedAt ? new Date(rel.publishedAt).toLocaleDateString() : '';
  const newer = st.toolVersionHint && rel.tag && st.toolVersionHint.replace(/^v/, '') !== rel.tag.replace(/^v/, '');
  latest.className = `status-line ${newer ? 'status-ok' : ''}`.trim();
  latest.textContent = t('Latest upstream release: {tag}{when}{newer}', {
    tag: rel.tag,
    when: when ? ` (${when})` : '',
    newer: newer ? ' ' + t('-- newer than the {installed} in this folder; re-run the new installer here (U to update).', { installed: st.toolVersionHint }) : '',
  });
}

$('#btn-amdnr-release-page').addEventListener('click', () => window.api.amdNrOpenReleasePage());

$('#btn-amdnr-fetch-model').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-amdnr-status');
  const replace = $('#btn-amdnr-fetch-model').dataset.replace === '1';
  status.textContent = t('Fetching the 310.8.0 DLSS NR model (about 165 MB)…');
  const res = await window.api.amdNrDeployNrModel(game.exePath, { replace });
  if (res.ok && res.deployed) {
    toast(t('Placed nvngx_dlssnr.dll {version} beside the game exe{backup}.', { version: res.version, backup: res.backedUp ? ' ' + t('(previous copy kept as {file})', { file: res.backedUp }) : '' }));
  } else {
    toast(res.ok ? t('Nothing changed: {reason}', { reason: res.reason }) : t('Could not fetch the model file: {error}', { error: res.error }));
  }
  loadAmdNrSection(game);
});

$('#btn-amdnr-run-setup').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const res = await window.api.amdNrRunSetup(game.exePath);
  toast(res.ok ? t('Opened its installer in a console -- follow its prompts, then reopen Edit to re-check.') : res.error);
});

// ── Translation layer: dgVoodoo2 or DXVK ─────────────────────────────────────────────────────────
//
// The swap between the two lived only in Game Help's More row, and players never found it -- while
// Assassin's Creed II (2026-09-18) cannot be drawn by dgVoodoo2 at all and needs DXVK from the start.
// So it is on the card's overflow and in Edit too, and all three go through the one main-process
// swap (game:help-apply 'swap-to-dxvk' / 'swap-to-dgvoodoo'): its confirm dialog, ReShade's 32-bit
// Vulkan layer and its administrator prompt, and -- on a game with nothing installed yet -- the
// recorded choice Install acts on.

// Which way the swap goes for this route, or null when DXVK has no place on it. Two places: instead
// of dgVoodoo2 on a DirectX 8/9 game, and instead of the game's own Direct3D on a 32-bit DirectX
// 10/11 game (legacy.js dxvkReplacesNative, 2026-09-18) -- 'native' marks the second, whose other
// side is "Direct3D 11 (native)" rather than dgVoodoo2.
// A translation layer's display name (route.layerChoice, catalog setup.via).
function layerName(via) {
  if (via === 'dxvk') return t('DXVK (Vulkan)');
  if (via === 'dgvoodoo') return t('dgVoodoo2 (Direct3D 11)');
  if (via === 'native') return t('native Direct3D');
  return String(via || '');
}

function layerSwapFor(route) {
  if (!(route && route.legacy && route.legacy.supported)) return null;
  if (route.consumerHere === 'dfc') return null;
  const plan = route.legacy;
  const native = !!(plan.host32 && !plan.dgVoodoo && (plan.api === 'dx10' || plan.api === 'dx11'));
  if (!route.legacy.dgVoodoo && !native) return null;
  const onDxvk = !!route.dxvkDeployed || route.wrapperPreference === 'dxvk';
  // The early Assassin's Creed games shake under DXVK on Windows (translation.js DXVK_BLOCKED): only the
  // way back is offered there.
  if (route.dxvkBlocked && !onDxvk) return null;
  if (native) {
    const d3d = plan.api === 'dx10' ? 'Direct3D 10' : 'Direct3D 11';
    return onDxvk
      ? { id: 'swap-to-native', label: t('Switch back to native {d3d}', { d3d }), current: 'dxvk', native: true, d3d }
      : { id: 'swap-to-dxvk', label: t('Try DXVK instead of native {d3d}', { d3d }), current: 'native', native: true, d3d };
  }
  return onDxvk
    ? { id: 'swap-to-dgvoodoo', label: t('Switch back to dgVoodoo2'), current: 'dxvk' }
    : { id: 'swap-to-dxvk', label: t('Try DXVK instead of dgVoodoo2'), current: 'dgvoodoo' };
}

async function applyLayerSwap(game, id) {
  if (!game || !['swap-to-dxvk', 'swap-to-dgvoodoo', 'swap-to-native'].includes(id)) return null;
  const res = await window.api.gameHelpApply(game.exePath, id);
  if (!res.ok) toast(t('The fix failed: {error}', { error: res.error }));
  else toast(res.done ? t('Done: {text}', { text: res.text }) : t('Not done: {text}', { text: res.text }));
  await renderGrid();
  return res;
}

// Which OptiScaler build this one game gets, overriding the Settings default. The marker is what
// carries it (engine:forGame / engine:setForGame in main), so a game keeps its build across a
// re-install, and Install is what actually moves the files.
async function loadEngineSection(game) {
  const section = $('#game-engine-section');
  const select = $('#game-engine-select');
  const status = $('#game-engine-status');
  if (!game || !game.exePath) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  const state = await window.api.engineForGame(game.exePath).catch(() => null);
  const id = engineIdOrDefault((state && state.marker && state.marker.engine) || game.engine || settings.engine);
  select.value = id;
  status.textContent = ENGINES_WITHOUT_PANEL.has(id) ? popoutPanelSentence('only') : '';
}

$('#game-engine-select').addEventListener('change', async (e) => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const id = engineIdOrDefault(e.target.value);
  const status = $('#game-engine-status');
  status.textContent = t('Saving…');
  // Fetch it before recording the choice: a build that is not on disk would make the next Install
  // stop to download it with no explanation.
  const ready = await ensureEngine(id);
  if (!ready.ok) {
    status.textContent = t('Could not fetch {engine}: {error}', { engine: engineLabel(id), error: ready.error });
    return;
  }
  const res = await window.api.engineSetForGame({ exePath: game.exePath, engine: id });
  if (!res || !res.ok) {
    status.textContent = t('Could not set the build: {error}', { error: (res && res.error) || '?' });
    return;
  }
  game.engine = id;
  window.api.saveGames(games);
  await loadEngineSection(game);
  await renderGrid();
});

async function loadLayerSection(game) {
  const section = $('#game-layer-section');
  const select = $('#game-layer-select');
  const status = $('#game-layer-status');
  if (!game || !game.exePath) { section.classList.add('hidden'); return; }
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);
  const swap = layerSwapFor(route);
  if (!swap) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  select.innerHTML = '';
  const choices = swap.native
    ? [['native', t('{d3d} (native)', { d3d: swap.d3d })], ['dxvk', t('DXVK (Vulkan)')]]
    : [['dgvoodoo', t('dgVoodoo2 (Direct3D 11)')], ['dxvk', t('DXVK (Vulkan)')]];
  // The layer the known-good catalog proves for this game (layerdefault.js) says so in the list.
  const layerChoice = route.layerChoice || null;
  const provenVia = layerChoice && layerChoice.proven ? layerChoice.proven.via : null;
  for (const [value, label] of choices) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value === provenVia ? `${label} — ${t('Proven layer')}` : label;
    select.appendChild(opt);
  }
  select.value = swap.current;
  // Each choice in a sentence (route-explain.js LAYERS), so the pick is informed before it is made.
  const layerText = route.layerExplain || {};
  $('#game-layer-explain').innerHTML = choices
    .filter(([value]) => layerText[value])
    .map(([value, label]) => `<div class="route-explain-row"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(t(layerText[value]))}</div>`)
    .join('');
  status.className = 'status-line';
  status.textContent = route.dxvkDeployed
    ? t('DXVK is in front of this game.')
    : route.wrapperPreference === 'dxvk' && layerChoice && layerChoice.from === 'proven'
      ? t('DXVK is proven on this game, so Install puts it in front of the game. Pick the other layer here to keep the usual one.')
    : route.wrapperPreference === 'dxvk'
      ? t('DXVK is chosen: Install puts it in front of the game.')
      : route.dgVoodooDeployed ? t('dgVoodoo2 is in front of this game.')
        : swap.native ? t('The game draws with its own {d3d}.', { d3d: swap.d3d }) : '';
}

$('#game-layer-select').addEventListener('change', async (e) => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const id = e.target.value === 'dxvk' ? 'swap-to-dxvk' : e.target.value === 'native' ? 'swap-to-native' : 'swap-to-dgvoodoo';
  $('#game-layer-status').textContent = t('Applying…');
  await applyLayerSwap(game, id);
  // A cancelled confirm leaves the layer as it was, so the select is re-read rather than trusted.
  await loadLayerSection(game);
});

// The per-game proxy DLL name -- see game:setProxyName in main.js. Advanced-only, because the
// automatic answer is right for nearly every game and a wrong choice here is a game where DLSS 5
// silently does nothing. It exists for the handful where the user knows better than detection:
// OptiScaler's wiki names a proxy for several games this app has no entry for, and until now there
// was no way to act on that (#132 -- a reporter went through every section of Edit looking for it).
async function loadProxySection(game) {
  const section = $('#game-proxy-section');
  const select = $('#game-proxy-select');
  const status = $('#game-proxy-status');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }
  const info = await window.api.proxyInfo(game.exePath);
  // The 32-bit route keeps OptiScaler in host64\ as winmm.dll, loaded by the helper: there is no
  // proxy beside the exe to name, so the row is hidden rather than shown and refused.
  if (!info.ok || !info.settable) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = info.automatic
    ? t('Automatic ({name})', { name: info.automatic })
    : t('Automatic');
  select.appendChild(auto);
  for (const name of info.names || []) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = info.chosen || '';

  // What is actually in the folder is worth saying next to what is chosen: the two differ while an
  // install is still to happen, and that difference is the whole question on a "no log at all" game.
  const installed = info.installed;
  status.className = `status-line ${info.chosen ? 'status-ok' : ''}`.trim();
  status.textContent = info.chosen
    ? t('Set by hand to {name}.', { name: info.chosen }) + (installed && installed.toLowerCase() !== info.chosen
      ? ' ' + t('OptiScaler is currently installed as {installed} and moves on the next Install or Reconfigure.', { installed })
      : '')
    : installed
      ? t('OptiScaler is installed as {installed}, chosen automatically.', { installed })
      : '';
}

$('#game-proxy-select').addEventListener('change', async (e) => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const proxy = e.target.value || null;
  const status = $('#game-proxy-status');
  status.textContent = t('Applying…');
  const res = await window.api.setProxyName(game.exePath, proxy);
  if (!res.ok) {
    toast(t('Could not set the proxy DLL name: {error}', { error: res.error }));
  } else {
    // A refused move is said, not swallowed: migrateProxyIfNeeded skips when the target name is
    // somebody else's file, and a silent skip would read as "renamed" while nothing moved.
    const moved = res.migration && res.migration.to && !res.migration.skipped
      ? ' ' + t('Moved OptiScaler from {from} to {to}.', { from: res.migration.from, to: res.migration.to })
      : res.migration && res.migration.skipped
        ? ' ' + t('Did NOT move it: {why}.', { why: res.migration.skipped })
        : '';
    toast((proxy ? t('OptiScaler will load as {name} for this game.', { name: proxy }) : t('Back to the automatic proxy DLL name.')) + moved);
  }
  await loadProxySection(game);
});

// The per-game graphics API choice -- see game:setApiOverride in main.js for what it drives.
// Offered for every game with an exe (detection can be wrong on a single-API game too), and
// called out when the game demonstrably ships more than one renderer.
async function loadApiSection(game) {
  const section = $('#game-api-section');
  const select = $('#game-api-select');
  const status = $('#game-api-status');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);
  // Shown for every game, DX12+DX11 ones included (2026-09-19): it used to hide there, on the grounds
  // that DX12 is always the answer -- and a game detected as both by mistake (The Godfather II, really
  // Direct3D 9) was left with no way to say what it is.
  section.classList.remove('hidden');

  const detectedLabel = (game.detectedPath && game.detectedPath.apiBadge) || t('not detected');
  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('Auto (detected: {api})', { api: detectedLabel });
  select.appendChild(auto);
  // An emulator renders with one of its own backends and there is no other (emulators.js), so only
  // those are offered: RPCS3 used to list DX12, DX10, DX9 and DX8, none of which it has had since
  // 2017, and picking one installed that route (2026-09-23). Every other game offers the lot --
  // detection can be wrong about a single-API game, which is the whole point of the override.
  const choices = (route.apiChoices || []).length
    ? route.apiChoices
    : ['dx12', 'dx11', 'vulkan', 'opengl', 'dx10', 'dx9', 'dx8'];
  for (const api of choices) {
    const opt = document.createElement('option');
    opt.value = api;
    opt.textContent = API_LABEL[api];
    select.appendChild(opt);
  }
  select.value = route.apiOverride || '';

  const multi = (route.detectedApis || []).length > 1;
  // A choice stored before the list was narrowed, or set outside the app: say it was refused rather
  // than let the dropdown quietly read Auto.
  const refused = route.apiOverrideRefused;
  status.className = `status-line ${refused ? 'status-warn' : route.apiOverride ? 'status-ok' : ''}`.trim();
  status.textContent = refused
    ? t('{api} is ignored: {name} has no such renderer, so nothing is installed for it. Its own are {apis}.', {
      api: API_LABEL[refused.api] || refused.api,
      name: refused.name || t('this emulator'),
      apis: (refused.apis || []).map((a) => API_LABEL[a] || a).join(', '),
    })
    : route.apiOverride
    ? t('Set to {api} -- everything API-dependent follows this, not the detected {detected}.', { api: API_LABEL[route.apiOverride], detected: detectedLabel })
    : multi
      ? t('This game ships {detected}: detection picked {picked}; choose the one you run if that is not it.', { detected: detectedLabel, picked: API_LABEL[route.detectedApi] || t('the first') })
      : '';
}

$('#game-api-select').addEventListener('change', async (e) => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const api = e.target.value || null;
  const status = $('#game-api-status');
  status.textContent = t('Applying…');
  const res = await window.api.setApiOverride(game.exePath, api);
  if (!res.ok) {
    toast(t('Could not set the graphics API: {error}', { error: res.error }));
  } else {
    const applied = res.applied && res.applied.length > 0 ? ' ' + t('Re-configured OptiScaler.ini: {keys}.', { keys: res.applied.map((x) => x.key).join(', ') }) : '';
    toast((api ? t('This game is now treated as {api}.', { api: API_LABEL[api] }) : t('Back to the detected graphics API.')) + applied);
  }
  // Every section below the choice depends on it.
  await loadApiSection(game);
  await loadProxySection(game);
  await loadInjectorSection(game);
  await loadFeederSection(game);
  await loadOptiFgSection(game);
  await loadDlssNrSection(game);
  await loadLosslessSection(game);
  await loadRelimiterSection(game);
  await loadAmdNrSection(game);
  renderGrid();
});

// The break-away panel, as the Panel row should describe it on this machine. route-explain.js says
// whether the route offers it ('fallback' beside its own in-game panel, 'only' when nothing is drawn in
// the game); this decides what to say about it, because only the renderer knows whether the hotkey
// works -- it can be switched off in Settings, and Windows can refuse it to a program already holding
// it. Naming it regardless is the 2026-09-18 bug renderer-dom.test.js guards against.
function popoutPanelSentence(popout) {
  if (!popout) return '';
  if (popoutHotkeyUsable()) {
    const vars = { hotkey: panelHotkey() };
    if (popout === 'only') return t('Nothing is drawn inside the game here: press {hotkey} for this app\'s own panel window, which changes the same settings while the game runs.', vars);
    // On the shared Insert, a game with its own panel keeps Insert for that panel, so pointing at
    // Insert as the fallback would be wrong; Settings' "Open it now" still is one.
    return panelKeyIsShared() ? '' : t('If the game will not show it, press {hotkey} for this app\'s own panel window, which needs nothing from the game.', vars);
  }
  // Off or refused. On 'fallback' the in-game panel is still the answer, so there is nothing to add;
  // on 'only' there is no other way in, and saying so beats silence.
  return popout === 'only'
    ? t('Nothing is drawn inside the game here, and the pop-out panel is switched off -- turn it on in Settings to change these settings while a game runs.')
    : '';
}


// Turns a "blind install" into an informed one: says whether OptiScaler_DLSSNR's own engine has
// a compiled-in compatibility entry for this exe (see engine-known-games.json's own header for
// what that does and doesn't mean) or is running on a completely default configuration. Doesn't
// change what gets installed -- visibility only, since this app doesn't know the actual quirk
// flags and shouldn't guess at them.
async function loadEngineProfileStatus(game) {
  const el = $('#game-engine-profile-status');
  if (!game || !game.exePath) {
    el.classList.add('hidden');
    return;
  }
  const res = await window.api.engineHasKnownProfile(game.exePath);
  el.classList.remove('hidden');
  // classList, not className: the element also carries advanced-only.
  if (res.known) {
    el.classList.add('status-ok');
    el.textContent = t('DLSS 5 has a known compatibility profile built in for this exe.');
  } else {
    el.classList.remove('status-ok');
    el.textContent = t('No compiled-in compatibility profile for this exe -- default OptiScaler configuration.');
  }
}

let frameGenVersionsLoaded = false;

// Populates and shows the per-game "DLSS Frame Generation version" control -- only meaningful
// for a game that already has an nvngx_dlssg.dll to version, so it stays hidden otherwise
// (including the "Add Game" case, where there's no game folder to check yet).
async function loadFrameGenSection(game) {
  const section = $('#game-framegen-section');
  // RTXMFG sits beside this section (not inside it) so it shows without advanced options; it has to
  // be hidden here too, or it would keep the previous game's state.
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    $('#game-rtxmfg-block').classList.add('hidden');
    return;
  }

  const state = await window.api.frameGenState(game.exePath);
  if (!state.hasFrameGen) {
    section.classList.add('hidden');
    $('#game-rtxmfg-block').classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const select = $('#game-framegen-version');
  const status = $('#game-framegen-status');

  if (!frameGenVersionsLoaded) {
    const res = await window.api.frameGenVersions();
    if (res && res.ok && res.versions.length > 0) {
      for (const v of res.versions) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
      }
      frameGenVersionsLoaded = true;
    }
  }
  select.value = '';
  status.className = 'status-line';
  // For an Unreal game the DLL lives under the plugin tree, not beside the exe -- say where.
  const where = state.relativeTo && state.relativeTo !== state.dll ? ` (${state.relativeTo})` : '';
  status.textContent = t('{dll}{where}: currently {version}', { dll: state.dll, where, version: state.currentVersion || t('unknown version') }) +
    (state.swapped ? ' ' + t('(swapped by this app -- original backed up, Restore puts it back)') : '');

  await loadFrameGenMultiplier(game);
  await loadRtxMfg(game);
}

// RTXMFG (rtxmfg.js in main): MFG for RTX 40 / 30. Only shown where it can matter -- the game has its
// own DLSS Frame Generation and the GPU is an RTX 40 or 30. An RTX 50 already has MFG, so the block
// stays hidden there unless a copy is already installed (then it can still be removed).
async function loadRtxMfg(game) {
  const block = $('#game-rtxmfg-block');
  const res = await window.api.rtxmfgState(game.exePath);
  const gpuOk = res && res.gpu && (res.gpu.status === 'supported' || res.gpu.status === 'experimental');
  if (!res || !res.hasFrameGen || (!gpuOk && !res.installed)) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  // Always offered on RTX 40 / 30 (the user's call): with advanced options off it is the only thing in
  // the Frame Generation group, so the group opens rather than hiding it behind a closed heading.
  if (!settings.showAdvanced) $('#edit-group-fg').open = true;
  block.dataset.projectPage = res.projectPage || '';
  const select = $('#game-rtxmfg-name');
  select.innerHTML = '';
  for (const name of res.names || []) {
    const taken = (res.occupied || []).includes(name);
    const opt = document.createElement('option');
    opt.value = name;
    opt.disabled = taken;
    opt.textContent = taken ? t('{name} (taken in this folder)', { name }) : name;
    select.appendChild(opt);
  }
  if (res.suggested) select.value = res.suggested;
  const status = $('#game-rtxmfg-status');
  const removeBtn = $('#btn-rtxmfg-remove');
  const installBtn = $('#btn-rtxmfg-install');
  removeBtn.classList.toggle('hidden', !res.installed);
  installBtn.textContent = res.installed ? t('Reinstall / update') : t('Install');
  status.className = res.installed ? 'status-line status-ok' : 'status-line';
  const gpuNote = res.gpu && res.gpu.status === 'experimental'
    ? ' ' + t('RTX 30: very early and DirectX 12 only.')
    : res.gpu && res.gpu.status === 'native' ? ' ' + t('This RTX 50 card has Multi Frame Generation already; RTXMFG is not needed.') : '';
  status.textContent = (res.installed
    ? t('Installed as {file} ({tag}). In the game: Frame Generation on, then Backspace. Leave the multiplier above on Game setting and pick it in RTXMFG\'s menu instead.', { file: res.marker.file, tag: res.marker.tag || '?' })
    : t('Not installed. It will go in as {file}.', { file: res.suggested || '?' })) + gpuNote;
  if (res.installed && !res.intact) status.textContent += ' ' + t('The file has changed since it was placed, so Remove will leave it alone.');
}

$('#btn-rtxmfg-install').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const btn = $('#btn-rtxmfg-install');
  btn.disabled = true;
  $('#game-rtxmfg-status').textContent = t('Fetching RTXMFG and checking its checksum…');
  try {
    const res = await window.api.rtxmfgInstall({ exePath: game.exePath, proxyName: $('#game-rtxmfg-name').value });
    toast(res.ok
      ? t('RTXMFG installed as {file}. Launch the game, turn Frame Generation on, press Backspace.', { file: res.marker.file })
      : t('RTXMFG could not be installed: {error}', { error: res.error }));
  } finally {
    btn.disabled = false;
  }
  loadRtxMfg(game);
});

$('#btn-rtxmfg-remove').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const res = await window.api.rtxmfgRemove(game.exePath);
  toast(res.ok
    ? t('RTXMFG removed.') + ((res.kept || []).length ? ' ' + t('Left alone: {list}.', { list: res.kept.join('; ') }) : '')
    : t('RTXMFG could not be removed: {error}', { error: res.error }));
  loadRtxMfg(game);
});

$('#rtxmfg-project-link').addEventListener('click', (e) => {
  e.preventDefault();
  const url = $('#game-rtxmfg-block').dataset.projectPage;
  if (url) window.api.openExternal(url);
});

// The multiplier of the game's OWN NVIDIA Frame Generation (2x/3x/4x or Dynamic) -- an override
// OptiScaler applies to every slDLSSGSetOptions the game makes, so the game's menu still turns FG
// on and off and this only changes how many frames it asks the driver for. Stored as a per-game
// marker that autoConfigureGame re-applies to the ini (see framegen:setMultiplier in main.js).
// Hidden on AMD/Intel: the game's DLSS-G never runs there in the first place.
async function loadFrameGenMultiplier(game) {
  const block = $('#game-framegen-multiplier-block');
  const res = await window.api.frameGenMultiplier(game.exePath);
  if (!res || !res.hasFrameGen || (res.gpuVendor && res.gpuVendor !== 'nvidia' && res.gpuVendor !== 'unknown')) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  const select = $('#game-framegen-multiplier');
  const status = $('#game-framegen-multiplier-status');
  const m = res.marker;
  select.value = m ? (m.dynamic ? 'dynamic' : (m.frames ? String(m.frames) : 'auto')) : 'auto';
  status.className = 'status-line';
  const iniFrames = res.ini && res.ini.frames && res.ini.frames !== 'auto' ? Number(res.ini.frames) : null;
  const iniDynamic = !!(res.ini && String(res.ini.dynamic).toLowerCase() === 'true');
  if (m) {
    status.textContent = m.dynamic
      ? t('Set by this app: Dynamic (driver picks the multiplier).')
      : t('Set by this app: {mult}x.', { mult: (m.frames || 1) + 1 });
    if (!res.iniPresent) status.textContent += ' ' + t('Applied once OptiScaler is installed.');
  } else if (iniDynamic) {
    status.textContent = t('Currently Dynamic, set from the in-game panel. Pick a value here to manage it from the app.');
  } else if (iniFrames) {
    status.textContent = t('Currently {mult}x, set from the in-game panel. Pick a value here to manage it from the app.', { mult: iniFrames + 1 });
  } else {
    status.textContent = t("Game setting -- the game's own Frame Generation menu decides.");
  }
}

$('#btn-framegen-multiplier-apply').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const v = $('#game-framegen-multiplier').value;
  const res = await window.api.frameGenSetMultiplier({
    exePath: game.exePath,
    frames: v === 'dynamic' || v === 'auto' ? null : Number(v),
    dynamic: v === 'dynamic',
  });
  if (!res || !res.ok) return toast(t('Could not set the multiplier: {error}', { error: res ? res.error : '?' }));
  if (res.cleared) toast(t("Frame Generation multiplier back to the game's own setting."));
  else if (res.deferred) toast(t('Saved -- applied once OptiScaler is installed for this game.'));
  else toast(t('Frame Generation multiplier applied. It takes effect on the next launch (or right away from the Insert panel).'));
  loadFrameGenMultiplier(game);
});

$('#btn-framegen-swap').addEventListener('click', async () => {
  if (!editingGameId) return;
  const version = $('#game-framegen-version').value;
  if (!version) return toast(t('Pick a version first.'));
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-framegen-status');
  status.textContent = t('Applying…');
  const res = await window.api.frameGenSwap(game.exePath, version);
  if (res.ok && res.swapped) {
    toast(t('Swapped {dll} to {version} (original backed up).', { dll: res.dll, version }));
  } else {
    toast(res.ok ? t('Could not swap: {reason}', { reason: res.reason }) : t('Swap failed: {error}', { error: res.error }));
  }
  loadFrameGenSection(game);
});

$('#btn-framegen-restore').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const res = await window.api.frameGenRestore(game.exePath);
  if (res.ok && res.restored) {
    toast(t("Restored {dll} to the game's original.", { dll: res.dll }));
  } else {
    toast(res.ok ? t('Nothing to restore: {reason}', { reason: res.reason }) : t('Restore failed: {error}', { error: res.error }));
  }
  loadFrameGenSection(game);
});

// Populates and shows the per-game "Launch mode" control -- hidden entirely if the
// injector isn't ready yet (no DLSS5Injector.exe / no OptiScaler.dll in the release
// folder), same "real reason, not a dead button" posture as injectorReadiness gives.
// A game is treated as a Steam game if it carries a Steam appid (either from a library
// scan or from picking Steam banner art) -- the app has no separate persisted
// "launcher" field to check, so this is the best available signal.
async function loadInjectorSection(game) {
  const section = $('#game-injector-section');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }

  // Never for a Feeder game -- the Feeder can only find OptiScaler when it proxy-installs
  // (LoadLibrary interception by name); injected under its own name, the Feeder logs "this
  // game never loaded a DLL of that name" and never finds it. Confirmed on a real deploy
  // (Batman: Arkham Knight, 2026-09-09). Proxy is the only supported mode there, so this
  // whole toggle would just be a way to break it.
  // Luma UE loads the same way (a plain ReShade64.dll that OptiScaler itself loads via
  // LoadReshade), so the same rule holds there; route.js already folds both cases in.
  const feederStatus = await window.api.feederReadiness(game.exePath);
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);
  if (feederStatus.needed || route.route === 'feeder' || route.route === 'lumaue') {
    section.classList.add('hidden');
    return;
  }

  const readiness = await window.api.injectorReadiness(engineFolder(engineOf(game)));
  const status = $('#game-injector-status');
  if (!readiness.ready) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const modeSelect = $('#game-launch-mode');
  modeSelect.value = game.launchMode === 'injector' ? 'injector' : 'proxy';

  const isSteamGame = !!game.bannerAppId;
  const steamBlock = $('#game-injector-steam');
  const directBlock = $('#game-injector-direct');

  const updateBlocks = async () => {
    const isInjector = modeSelect.value === 'injector';
    steamBlock.classList.toggle('hidden', !(isInjector && isSteamGame));
    directBlock.classList.toggle('hidden', !(isInjector && !isSteamGame));
    status.className = 'status-line';
    status.textContent = '';
    if (isInjector && isSteamGame) {
      const res = await window.api.injectorSteamOption(engineFolder(engineOf(game)));
      if (res.ok) {
        $('#game-injector-launch-option').value = res.launchOption;
      } else {
        status.textContent = res.error;
      }
    }
  };
  modeSelect.onchange = updateBlocks;
  await updateBlocks();
}

$('#btn-injector-copy').addEventListener('click', async () => {
  const value = $('#game-injector-launch-option').value;
  if (!value) return;
  await navigator.clipboard.writeText(value);
  toast(t('Launch option copied -- paste it into Steam → Properties → Launch Options.'));
});

$('#btn-injector-launch-now').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-injector-status');
  status.textContent = t('Launching…');
  const res = await window.api.injectorLaunch(game.exePath, engineFolder(engineOf(game)));
  status.textContent = res.ok ? t('Launched through the injector.') : t('Launch failed: {error}', { error: res.error });
});

let feederProvidersLoaded = false;
let feederProvidersById = {};

// The provider table (feeder.js MV_PROVIDERS), fetched once and shared by the 64-bit Feeder picker
// and the 32-bit route's.
async function ensureFeederProviders() {
  if (!feederProvidersLoaded) {
    for (const p of await window.api.feederMvProviders()) feederProvidersById[p.id] = p;
    feederProvidersLoaded = true;
  }
  return Object.values(feederProvidersById);
}

// immersePresent: false greys out iMMERSE, which is bring-your-own and refused without the
// player's copy in the folder (only the 32-bit picker knows that up front).
function fillMvProviderSelect(select, providers, { immersePresent = null } = {}) {
  select.innerHTML = '';
  for (const p of providers) {
    // A provider the app knows about but cannot use is left out of the picker rather than
    // offered and then refused: DRME is in the table only so an existing deploy that used it is
    // still recognised and cleaned up (feeder.js).
    if (p.selectable === false) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.bringYourOwn ? `${p.displayName} — ${t('your own install')}`
      : p.autoFetchable ? p.displayName : `${p.displayName} — ${p.license}`;
    if (p.bringYourOwn && immersePresent === false) opt.disabled = true;
    if (p.default) opt.selected = true;
    select.appendChild(opt);
  }
}

// "VORT (vortigern11)" -> "VORT": the card's menu line has room for the name only.
function shortMvName(displayName) {
  return displayName ? String(displayName).split(' (')[0] : '';
}

// The per-action licence question for a provider that has one (LumeniteFX), asked by the main
// process with the licence text itself -- never implied by the dropdown. True for a provider that
// needs no question.
async function confirmMvProviderLicense(providerId) {
  await ensureFeederProviders();
  const provider = feederProvidersById[providerId];
  if (!provider || provider.autoFetchable || provider.bringYourOwn) return true;
  return !!(await window.api.feederConfirmProviderLicense(providerId));
}

// The 32-bit route's motion-vector picker (index.html #game-legacy-mv-section), shown once the
// route is installed, with the provider the game is on selected.
async function loadLegacyMvSection(game) {
  const section = $('#game-legacy-mv-section');
  const status = game && game.exePath ? await window.api.legacyMvProvider(game.exePath) : null;
  if (!status || !status.ok || !status.host32) {
    section.classList.add('hidden');
    return null;
  }
  section.classList.remove('hidden');
  const select = $('#game-legacy-mv-provider');
  fillMvProviderSelect(select, await ensureFeederProviders(), { immersePresent: !!status.immersePresent });
  const current = status.id ? feederProvidersById[status.id] : null;
  if (current && current.selectable !== false) select.value = status.id;
  $('#game-legacy-mv-status').textContent = current
    ? t('In use: {provider} (DLSS5_MV_PROVIDER={value}).', { provider: current.displayName, value: current.mvProviderValue })
    : t('No motion-vector provider found in this game\'s ReShade preset.');
  return status;
}

// Switches the 32-bit game's provider in place (main.js legacy:setMvProvider), after the licence
// question when the provider has one. Refreshes this section and the card, whose menu names it.
async function applyLegacyMvProvider(game, providerId) {
  const statusEl = $('#game-legacy-mv-status');
  const btn = $('#btn-legacy-mv-apply');
  const provider = feederProvidersById[providerId];
  const licenseConfirmed = await confirmMvProviderLicense(providerId);
  if (!licenseConfirmed) {
    statusEl.textContent = t('Cancelled -- licence not confirmed. Nothing was changed.');
    return;
  }
  btn.disabled = true;
  statusEl.textContent = t('Switching the motion-vector shader…');
  const res = await window.api.legacySetMvProvider(game.exePath, providerId, { licenseConfirmed });
  btn.disabled = false;
  toast(res.ok
    ? t('Motion vectors now come from {provider}. Launch the game to see the difference.', { provider: provider ? provider.displayName : providerId })
    : t('Could not switch the motion-vector shader: {error}', { error: res.error }));
  await loadLegacyMvSection(game);
  if (res.ok) renderGrid();
}

$('#btn-legacy-mv-apply').addEventListener('click', () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  if (game) applyLegacyMvProvider(game, $('#game-legacy-mv-provider').value);
});

// Populates and shows the "Neural Rendering source: DLSS5 Feeder" control -- only for a game
// with no native DLSS (feeder:readiness reports needed:false otherwise, and this stays
// hidden). Unlike Frame Gen and Launch mode, this has one action (Deploy, which doubles as
// Update once something's deployed) rather than a swap/restore pair -- restore isn't
// implemented yet, see the Manager's own notes on this.
async function loadFeederSection(game) {
  const section = $('#game-feeder-section');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }

  const readiness = await window.api.feederReadiness(game.exePath);
  const status = $('#game-feeder-status');
  const updateBtn = $('#btn-feeder-update');
  const removeBtn = $('#btn-feeder-remove');
  if (!readiness.needed) {
    section.classList.add('hidden');
    return;
  }
  // An installed 32-bit route game: this is the 64-bit stack, which feeder:deploy refuses there, and
  // it would only list 64-bit files as missing. Its provider has its own picker
  // (#game-legacy-mv-section) -- Assassin's Creed II, 2026-09-18.
  const lmv = await window.api.legacyMvProvider(game.exePath);
  if (lmv && lmv.host32) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  // Remove is there whenever the add-on is on disk -- and is the ONLY control for a Feeder
  // that landed on a game that ships its own DLSS (misdeployed: the two crash together).
  removeBtn.classList.toggle('hidden', !(readiness.misdeployed || readiness.addonInstalled));

  if (!readiness.supported) {
    status.className = 'status-line';
    status.textContent = t(readiness.reason, readiness.reasonVars);
    $('#btn-feeder-deploy').disabled = true;
    updateBtn.classList.add('hidden');
    return;
  }
  $('#btn-feeder-deploy').disabled = false;

  // What the API adds on top (Vulkan: Smooth Motion off, and the ReShade layer state), with
  // ReShade's own installer one click away where the layer is the missing piece.
  let notesEl = $('#game-feeder-notes');
  if (!notesEl) {
    notesEl = document.createElement('div');
    notesEl.id = 'game-feeder-notes';
    notesEl.className = 'field-hint';
    status.insertAdjacentElement('afterend', notesEl);
  }
  notesEl.innerHTML = '';
  for (const note of readiness.notes || []) {
    const p = document.createElement('div');
    p.textContent = note;
    notesEl.appendChild(p);
  }
  if (readiness.reshadeMode === 'vulkan-layer' && !readiness.reshadeInstalled) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = t("Open ReShade's installer");
    btn.addEventListener('click', async () => {
      const r = await window.api.feederOpenReShadeSetup();
      toast(r.ok ? t('ReShade\'s installer is open: pick this game\'s exe, choose Vulkan, tick "Enable loading of add-ons". Then Deploy here.') : t('Could not open ReShade\'s installer: {error}', { error: r.error }));
    });
    notesEl.appendChild(btn);
  }
  notesEl.classList.toggle('hidden', notesEl.childElementCount === 0);

  const select = $('#game-feeder-mv-provider');
  if (!select.options.length) fillMvProviderSelect(select, await ensureFeederProviders());
  // The provider this game is actually on, not just the default -- someone opening Edit after a
  // deploy should see what is deployed.
  if (readiness.mvProvider && readiness.mvProvider.id && feederProvidersById[readiness.mvProvider.id]
      && feederProvidersById[readiness.mvProvider.id].selectable !== false) {
    select.value = readiness.mvProvider.id;
  }

  // Depth, for a game whose Feeder is in and whose depth may be the thing that is wrong. Only the
  // two profiles feeder.js defines: the engine default an install writes by itself, and the one
  // Unity profile a contributor verified end to end. Beyond those it is ReShade's own Generic
  // Depth page, which is the only thing that can see the running game's real buffers.
  let depthEl = $('#game-feeder-depth');
  if (!depthEl) {
    depthEl = document.createElement('div');
    depthEl.id = 'game-feeder-depth';
    depthEl.className = 'field-hint';
    notesEl.insertAdjacentElement('afterend', depthEl);
  }
  depthEl.innerHTML = '';
  if (readiness.addonInstalled) {
    const verified = readiness.depthProfile === 'unity-verified';
    const line = document.createElement('div');
    line.textContent = verified
      ? t('Depth: the contributor-verified Unity profile is in use. If depth still reads flat, open ReShade (Home) > Add-ons > Generic Depth in gameplay and pick the buffer that holds the scene.')
      : t('Depth: engine defaults. If the picture looks sharp when still and mushy in motion, or dlss5-feed.log says depth is flat, try the verified Unity profile.');
    depthEl.appendChild(line);
    if (!verified) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-small';
      btn.textContent = t('Use the verified Unity depth profile');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await window.api.gameHelpApply(game.exePath, 'feeder-depth-profile');
        btn.disabled = false;
        toast(res.ok ? (res.done ? t('Done: {text}', { text: res.text }) : t('Not done: {text}', { text: res.text }))
          : t('The fix failed: {error}', { error: res.error }));
        if (res.ok && res.done) loadFeederSection(game);
      });
      depthEl.appendChild(btn);
    }
  }
  depthEl.classList.toggle('hidden', depthEl.childElementCount === 0);

  const missing = [
    readiness.reshadeInstalled ? null : 'ReShade',
    readiness.addonInstalled ? null : t('Feeder add-on'),
    readiness.fxInstalled ? null : 'DLSS5_Feed.fx',
    readiness.headersInstalled ? null : 'ReShade.fxh/ReShadeUI.fxh',
    readiness.dlssInstalled ? null : 'nvngx_dlss.dll',
    readiness.dlssnrInstalled ? null : t('nvngx_dlssnr.dll (install this yourself first)'),
    // The motion-vector half: a deploy can have every file and still feed nothing (feeder.js's
    // feederProviderStatus). The notes above carry the full sentence; this keeps the status line
    // from reading "fully deployed" while it is true.
    readiness.mvProviderOk === false ? t('a working motion-vector shader') : null,
  ].filter(Boolean);

  status.className = 'status-line';
  updateBtn.classList.add('hidden');

  if (!readiness.complete) {
    status.textContent = t('{list} missing.', { list: missing.join(', ') });
    return;
  }

  status.textContent = t('Feeder stack fully deployed. Checking for updates…');
  const update = await window.api.feederCheckUpdate(game.exePath);
  if (update.ok && update.checked && !update.upToDate) {
    status.textContent = t('Feeder stack deployed ({current} -- {latest} available).', { current: update.currentVersion, latest: update.latestVersion });
    updateBtn.classList.remove('hidden');
  } else if (update.ok && update.checked) {
    status.textContent = t('Feeder stack up to date ({current}).', { current: update.currentVersion });
  } else {
    status.textContent = t('Feeder stack fully deployed.');
  }
}

// Deploys the selected provider, gating LumeniteFX (or any future non-auto-fetchable
// provider) behind a real, per-action confirmation of its actual licence text -- never
// silently, never just because it's selected in the dropdown. force=true is an update:
// re-fetches and overwrites everything rather than skipping what's already present.
// ── which neural consumer runs the pass ──────────────────────────────────────────────────────
//
// The Feeder manufactures a DLSS contract; exactly one add-on may consume it. Ours is this app's
// own engine; Deep Fried Chicken is the other one people use. The choice is stored on the game and
// acted on by feeder:deploy -- see src/dfc.js for why nothing here offers to download Chicken.
const CONSUMER_LABELS = {
  optiscaler: () => t('DLSS 5 (this app\x27s engine)'),
  dfc: () => t('Deep Fried Chicken (your copy)'),
};

// The card menu's swap: record the choice, and let Install do the swap whole. Chicken not added to
// the app yet is asked for right here, rather than sending the player off to find where.
async function switchNeuralPass(game, to) {
  // Said before anything happens, and said as what it is: one comes out, the other goes in.
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);
  const vulkan = route && route.effectiveApi === 'vulkan';
  let ask;
  if (to === 'dfc') {
    ask = t('Switch {game} to Deep Fried Chicken? This removes DLSS 5 from the game folder and installs Deep Fried Chicken in its place. Switch back from this menu at any time.', { game: game.name });
    if (vulkan) ask += '\n\n' + t('Windows asks once for administrator permission: ReShade\'s Vulkan layer is set up for this game.');
  } else if (route && route.route === 'unsupported') {
    ask = t('Take Deep Fried Chicken out of {game}? DLSS 5 has no route of its own for this game, so nothing goes in its place.', { game: game.name });
  } else {
    ask = t('Switch {game} back to DLSS 5? This removes Deep Fried Chicken from the game folder and installs DLSS 5 in its place. Your Chicken settings are kept for next time.', { game: game.name });
  }
  if (!window.confirm(ask)) return;
  if (to === 'dfc') {
    const st = await window.api.dfcStatus(null);
    if (!st || !st.supplied) {
      if (!window.confirm(t('Deep Fried Chicken is not added to this app yet. Pick the folder you unpacked it into now?'))) return;
      const res = await window.api.dfcSupply();
      if (!res || res.cancelled) return;
      if (!res.ok) { toast(t('That is not a Deep Fried Chicken download: {error}', { error: res.error })); return; }
    }
  }
  game.neuralConsumer = to === 'dfc' ? 'dfc' : 'optiscaler';
  window.api.saveGames(games);
  await installGame(game);
}

async function loadSettingsDfc() {
  const status = $('#settings-dfc-status');
  const btn = $('#btn-settings-dfc');
  const st = await window.api.dfcStatus(null);
  const info = st && st.supplied ? (st.suppliedInfo || {}) : null;
  btn.textContent = info ? t('Replace your Chicken copy…') : t('Add your Chicken copy…');
  if (!info) { status.textContent = t('Not added yet.'); return; }
  const when = info.addedAt ? new Date(info.addedAt).toLocaleDateString() : '';
  status.textContent = info.from
    ? t('Added from {from} on {date}. Switch a game to it from its ⋯ menu.', { from: info.from, date: when })
    : t('Added. Switch a game to it from its ⋯ menu.');
}

$('#btn-settings-dfc').addEventListener('click', async () => {
  const res = await window.api.dfcSupply();
  if (!res || res.cancelled) return;
  if (!res.ok) { toast(t('That is not a Deep Fried Chicken download: {error}', { error: res.error })); return; }
  // Say how many games followed the new copy, so replacing it is visibly a change to the games and
  // not just to a folder the player never sees.
  toast(res.updatedGames
    ? t('Your Deep Fried Chicken copy is saved, and {count} game(s) already using it were updated to it.', { count: res.updatedGames })
    : t('Your Deep Fried Chicken copy is saved. Every game can use it now.'));
  if (res.failedGames && res.failedGames.length) {
    toast(t('{count} game(s) could not be updated to the new copy -- close the game and add it again.', { count: res.failedGames.length }));
  }
  loadSettingsDfc();
  renderGrid();
});

function dfcUnsupportedWords(code) {
  if (code === 'dfc-vulkan-layer') return t('Chicken on Vulkan needs ReShade\'s Vulkan layer with add-on support, set up for this game.');
  if (code === 'dfc-32bit') return t('Not for this game yet: on 32-bit games Chicken is set up here for DirectX 9 to 11, OpenGL and Vulkan.');
  return t('Chicken is set up here for 64-bit DirectX 9 to 12 games only.');
}

function chosenConsumer(game) {
  const id = game && game.neuralConsumer;
  return CONSUMER_LABELS[id] ? id : 'optiscaler';
}

async function loadConsumerSection(game) {
  const select = $('#game-neural-consumer');
  const supplyBtn = $('#btn-dfc-supply');
  const status = $('#game-consumer-status');
  if (!select) return;

  const chosen = chosenConsumer(game);
  select.innerHTML = '';
  for (const id of Object.keys(CONSUMER_LABELS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = CONSUMER_LABELS[id]();
    if (id === chosen) opt.selected = true;
    select.appendChild(opt);
  }

  const info = await window.api.dfcStatus(game && game.exePath);
  // Not offered on this game's route at all (AMD/Intel, Luma, RE Engine's present route, ...).
  const offered = !!(info && info.ok && info.support);
  $('#game-consumer-section').classList.toggle('hidden', !offered);
  if (!offered) return;
  // The Add button only when it would do something: once a copy is supplied it is used for every
  // game, so a button offering to add it again on each card is noise.
  supplyBtn.classList.toggle('hidden', !!(info && info.supplied));

  const lines = [];
  if (!info || !info.ok) {
    status.textContent = '';
    return;
  }
  // Chicken is set up for 64-bit Direct3D 11/12 games only (dfc.supportedFor): elsewhere the option
  // says why instead of building a folder that cannot run.
  const support = info.support || { ok: true };
  const dfcOpt = select.querySelector('option[value="dfc"]');
  if (dfcOpt && !support.ok && chosen !== 'dfc') dfcOpt.disabled = true;
  if (!support.ok) lines.push(dfcUnsupportedWords(support.code));
  // What the folder is set up for against what the player chose: the gap is exactly what Install does.
  const here = info.ours ? 'dfc' : 'optiscaler';
  if (chosen === 'dfc' && support.ok) {
    if (!info.supplied) lines.push(t('No Deep Fried Chicken copy yet -- add yours, then press Install.'));
    else if (info.present && !info.ours) lines.push(t('Chicken is already here and this app did not place it. Delete its files to let this app manage it.'));
    else if (here !== 'dfc') lines.push(t('Press Install on the card to switch this game to Chicken.'));
  } else if (chosen === 'optiscaler' && here === 'dfc') {
    lines.push(t('Press Install on the card to switch this game back to DLSS 5.'));
  }
  if (info.state && info.state.ran && info.state.state) {
    lines.push(t('Chicken last reported: {state}.', { state: info.state.state }));
  }
  status.textContent = lines.join(' ');
  await loadDfcSettings(game);
}

// Chicken's own settings, drawn from whatever dfccfg.js offers rather than from markup, so adding
// a field there needs no change here. Each control writes straight to the cfg on change: Chicken
// re-reads the file itself, and a Save button would let the panel and the file disagree.
async function loadDfcSettings(game) {
  const box = $('#dfc-settings');
  const hint = $('#dfc-settings-hint');
  const fields = $('#dfc-settings-fields');
  if (!box) return;

  const chosen = chosenConsumer(game);
  if (chosen !== 'dfc' || !game || !game.exePath) { box.classList.add('hidden'); return; }
  const r = await window.api.dfcCfgRead(game.exePath);
  if (!r || !r.ok || !r.present) { box.classList.add('hidden'); return; }

  box.classList.remove('hidden');
  fields.innerHTML = '';
  if (r.tooNew) {
    // A cfg from a Chicken newer than the field table was read from. Shown, never written.
    hint.textContent = t('This deep-fried-chicken.cfg was written by a newer Chicken ({schema}) than this app knows ({known}), so it is shown but not changed here. Use Chicken\x27s own overlay.', { schema: r.schema, known: r.knownSchema });
    return;
  }
  // Said plainly, because it would otherwise read as all of Chicken's settings rather than a tenth.
  hint.textContent = t('{offered} of this file\x27s {total} settings are offered here -- the ones whose meaning is unambiguous. Everything else stays exactly as Chicken wrote it, and its own in-game overlay still has the full set.', { offered: r.offeredKeys, total: r.totalKeys });

  const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
  for (const f of r.fields) {
    if (!f.present) continue;
    const row = document.createElement('div');
    row.className = 'field-row';
    const label = document.createElement('label');
    label.textContent = t(f.label);
    if (f.help) label.title = t(f.help);
    const input = document.createElement('input');
    input.id = `dfc-field-${f.key}`;
    if (f.type === 'bool') {
      input.type = 'checkbox';
      input.checked = String(f.value).trim() !== '0';
    } else {
      input.type = 'number';
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
      if (f.step !== undefined) input.step = String(f.step);
      input.value = String(f.value);
    }
    // A field that only means anything while its switch is on says so by going dim, rather than
    // disappearing -- someone looking for it should find it where they left it.
    if (f.dependsOn && byKey[f.dependsOn] && String(byKey[f.dependsOn].value).trim() === '0') input.disabled = true;

    input.addEventListener('change', async () => {
      const value = f.type === 'bool' ? (input.checked ? 1 : 0) : Number(input.value);
      const res = await window.api.dfcCfgWrite(game.exePath, { [f.key]: value });
      if (!res.ok) { toast(t('Could not save that setting: {error}', { error: res.error })); return; }
      loadDfcSettings(game);
    });

    row.appendChild(label);
    row.appendChild(input);
    if (f.unit) { const u = document.createElement('span'); u.textContent = f.unit; row.appendChild(u); }
    fields.appendChild(row);
  }
}

$('#game-neural-consumer').addEventListener('change', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  if (!game) return;
  game.neuralConsumer = $('#game-neural-consumer').value;
  window.api.saveGames(games);
  await loadConsumerSection(game);
  toast(t('Saved. Press Install on the card to switch this game.'));
  renderGrid();
});

$('#btn-dfc-supply').addEventListener('click', async () => {
  const res = await window.api.dfcSupply();
  if (res.cancelled) return;
  if (!res.ok) { toast(t('That is not a Deep Fried Chicken download: {error}', { error: res.error })); return; }
  toast(t('Your Deep Fried Chicken copy is saved. Every game can use it now.'));
  if (!editingGameId) return;
  await loadConsumerSection(games.find((x) => x.id === editingGameId));
});

async function deployFeederStack(game, providerId, force) {
  const status = $('#game-feeder-status');
  const licenseConfirmed = await confirmMvProviderLicense(providerId);
  if (!licenseConfirmed) {
    status.textContent = t('Cancelled -- licence not confirmed.');
    return;
  }

  status.textContent = force ? t('Updating…') : t('Deploying…');
  const res = await window.api.feederDeploy(game.exePath, providerId, { force, licenseConfirmed, consumer: chosenConsumer(game), nrDllPath: settings.nrDllPath });
  if (res.ok) {
    toast(force
      ? t('Feeder stack updated.')
      : t('Feeder stack deployed. Install DLSS 5 normally (Install button) to finish -- not the injector.'));
  } else {
    toast(force ? t('Update failed: {error}', { error: res.error }) : t('Deploy failed: {error}', { error: res.error }));
    // Vulkan: the one step this app leaves to ReShade's own installer -- open it now, since
    // Deploy is what the user pressed.
    if (res.needsReShadeInstaller) {
      const r = await window.api.feederOpenReShadeSetup();
      if (r.ok) toast(t('ReShade\'s installer is open: pick this game\'s exe, choose Vulkan, tick "Enable loading of add-ons". Then Deploy here.'));
    }
  }
  loadFeederSection(game);
  loadConsumerSection(game);
}

$('#btn-feeder-deploy').addEventListener('click', () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  deployFeederStack(game, $('#game-feeder-mv-provider').value, false);
});

$('#btn-feeder-update').addEventListener('click', () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  deployFeederStack(game, $('#game-feeder-mv-provider').value, true);
});

$('#btn-feeder-remove').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  $('#game-feeder-status').textContent = t('Removing the DLSS5 Feeder…');
  const res = await window.api.feederRemove(game.exePath);
  if (res.ok) {
    toast(t('DLSS5 Feeder removed ({list}).', { list: res.removed.join(', ') }));
  } else {
    toast(t('Could not remove the DLSS5 Feeder: {error}', { error: res.error }));
  }
  // Everything that keyed off "Feeder game" changes with it: the route tag, OptiFG, Lossless.
  await loadFeederSection(game);
  await loadOptiFgSection(game);
  await loadDlssNrSection(game);
  await loadLosslessSection(game);
  await loadRelimiterSection(game);
  renderGrid();
});

// OptiScaler's own frame generation for this game (main.js optiFgReadiness). Shown on every game, with
// the reason when it cannot be had -- a D3D11 game, a Feeder game, one with DLSS-G of its own -- rather
// than hidden, because "why is there no frame generation option" is itself the question.
async function loadOptiFgSection(game) {
  const section = $('#game-optifg-section');
  const select = $('#game-optifg-generator');
  const startOn = $('#game-optifg-starton');
  const status = $('#game-optifg-status');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const readiness = await window.api.optiFgReadiness(game.exePath);
  status.className = 'status-line';
  if (!readiness.supported) {
    select.value = 'none';
    select.disabled = true;
    startOn.checked = false;
    startOn.disabled = true;
    status.textContent = t(readiness.reason, readiness.reasonVars);
    return;
  }

  select.disabled = false;
  for (const opt of select.options) {
    if (opt.value !== 'none') opt.disabled = !readiness.available[opt.value];
  }
  select.value = readiness.generator || 'none';
  startOn.checked = !!readiness.startOn;
  startOn.disabled = select.value === 'none';
  status.textContent = select.value === 'none'
    ? t('Off -- no frame generator is set up for this game.')
    : t('Applies on the game\'s next launch. Then switch it on and off from the DLSS 5 panel or the pop-out.');
}

async function saveOptiFg() {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const generator = $('#game-optifg-generator').value;
  const status = $('#game-optifg-status');
  status.textContent = t('Applying…');
  const res = await window.api.optiFgChoose(game.exePath, generator, $('#game-optifg-starton').checked);
  if (res.ok) {
    toast(generator === 'none'
      ? t('Frame generation removed for this game.')
      : t('Frame generation set to {name}. It applies on the next launch.', { name: generator === 'xefg' ? 'XeFG' : 'FSR FG' }));
  } else {
    toast(t('Could not change Frame Generation: {error}', { error: res.error }));
  }
  loadOptiFgSection(game);
}

$('#game-optifg-generator').addEventListener('change', saveOptiFg);
$('#game-optifg-starton').addEventListener('change', saveOptiFg);

// Edits Lossless Scaling's real Settings.xml in place: finds this game's <Profile> (by <Path>,
// falling back to a normalised <Title> match for a profile the user already created by hand
// through LS's own UI -- e.g. by typing a title before browsing for the exe, which leaves <Path>
// empty), or clones an existing profile as a schema-correct template if none exists yet. Only
// ever touches Title/Path/FrameGeneration/ScalingType; every other field -- and every other
// profile in the file -- passes through untouched. See lossless.js for why this file, not a
// hand-rolled default profile, is the safe source of truth for the rest of the schema.
// The reverse of configureLossless() for Remove: drops the profile this app created for the game
// (matched the same way, by Path then by normalised Title) and leaves every other profile and
// every root setting alone. Quiet when Lossless Scaling is not installed or has no profile.
async function removeLosslessProfile(game) {
  try {
    const xmlText = await window.api.losslessReadSettings();
    if (!xmlText) return false;
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return false;
    const profilesEl = doc.querySelector('GameProfiles');
    if (!profilesEl) return false;
    const exePathLower = (game.exePath || '').trim().toLowerCase();
    const normalizedTitle = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, '');
    const profiles = Array.from(profilesEl.querySelectorAll('Profile'));
    let profile = profiles.find((p) => { const el = p.querySelector('Path'); return el && el.textContent.trim().toLowerCase() === exePathLower; });
    if (!profile) profile = profiles.find((p) => { const el = p.querySelector('Title'); return el && normalizedTitle(el.textContent) === normalizedTitle(game.name); });
    if (!profile) return false;
    profilesEl.removeChild(profile);
    await window.api.losslessWriteSettings(new XMLSerializer().serializeToString(doc));
    return true;
  } catch {
    return false;
  }
}

async function configureLossless(game, { frameGenMode = 'LSFG3', mode = 'FIXED', multiplier = 2, target = 120 } = {}) {
  const xmlText = await window.api.losslessReadSettings();
  if (!xmlText) {
    throw new Error(t("Lossless Scaling hasn't been run yet -- launch it once first, then try again."));
  }

  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(t("Could not parse Lossless Scaling's settings file -- it may be from an unexpected version."));
  }

  const profilesEl = doc.querySelector('GameProfiles');
  if (!profilesEl) {
    throw new Error(t('Unexpected Lossless Scaling settings format (no GameProfiles section).'));
  }

  const profiles = Array.from(profilesEl.querySelectorAll('Profile'));
  const exePathLower = (game.exePath || '').trim().toLowerCase();
  const normalizedTitle = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, '');

  let profile = profiles.find((p) => {
    const el = p.querySelector('Path');
    return el && el.textContent.trim().toLowerCase() === exePathLower;
  });

  if (!profile) {
    profile = profiles.find((p) => {
      const el = p.querySelector('Title');
      return el && normalizedTitle(el.textContent) === normalizedTitle(game.name);
    });
  }

  let isNew = false;
  if (!profile) {
    const template = profiles[0];
    if (!template) throw new Error(t('No existing Lossless Scaling profile to use as a template.'));
    isNew = true;
    profile = template.cloneNode(true);
    profilesEl.appendChild(profile);
  }

  const setField = (name, value) => {
    let el = profile.querySelector(name);
    if (!el) {
      el = doc.createElement(name);
      profile.appendChild(el);
    }
    el.textContent = value;
  };

  setField('Title', game.name);
  setField('Path', game.exePath);
  setField('FrameGeneration', frameGenMode);
  setField('ScalingType', 'Off');
  // Explicit, not inherited from whatever profile served as the template: Lossless Scaling's
  // windowed-output option shows the game in a small centred window, and resize-before-scaling
  // shrinks the game's own window. Neither is wanted for frame generation only.
  setField('WindowedMode', 'false');
  setField('ResizeBeforeScaling', 'false');
  // FIXED multiplies every frame by LSFG3Multiplier; ADAPTIVE generates only what it takes to
  // hold LSFG3Target fps. Both fields are written either way so switching modes later is clean.
  setField('LSFG3Mode1', mode === 'ADAPTIVE' ? 'ADAPTIVE' : 'FIXED');
  setField('LSFG3Multiplier', String(multiplier));
  setField('LSFG3Target', String(target));
  // Without this, Lossless Scaling only applies the profile once the user manually selects this
  // game's window in its own UI -- AutoScale is what makes "just launch it" (the in-game checkbox's
  // whole point) actually turn Frame Generation on.
  setField('AutoScale', 'true');

  // Root-level (not per-profile) settings, so the in-game panel can drive Lossless Scaling without
  // its window ever appearing. Tray settings keep it out of sight; StartAsAdmin=false makes it run
  // at the game's own integrity level -- the in-game toggle hotkey works either way, but a medium-
  // integrity Lossless Scaling is also the one the panel can restart (to apply a live multiplier
  // change) and never has the game's synthesized input blocked by Windows' cross-integrity
  // protection. It still scales elevated games fine, since desktop-duplication capture doesn't care
  // about the captured window's integrity level.
  const settingsRoot = doc.documentElement; // <Settings>
  const setRootField = (name, value) => {
    let el = Array.from(settingsRoot.children).find((c) => c.tagName === name);
    if (!el) {
      el = doc.createElement(name);
      settingsRoot.insertBefore(el, profilesEl);
    }
    el.textContent = value;
  };
  setRootField('StartAsAdmin', 'false');
  setRootField('MinimizeToTray', 'true');
  setRootField('CloseToTray', 'true');

  // The parsed doc already carries its own <?xml ...?> declaration; XMLSerializer re-emits it
  // verbatim. Prepending another one here produced a file with two declarations -- invalid XML,
  // and the actual cause of a "could not parse" failure on the very next read. Found live.
  const newXml = new XMLSerializer().serializeToString(doc);
  const writeResult = await window.api.losslessWriteSettings(newXml);
  if (!writeResult.ok) throw new Error(writeResult.error || t('Failed to write Lossless Scaling settings.'));

  return { isNew, hotkey: readLosslessHotkey(doc) };
}

// Reads Lossless Scaling's own global Frame-Generation toggle chord out of Settings.xml
// (<Hotkey> is a WPF Key name like "S"; <HotkeyModifierKeys> is space-separated, e.g. "Alt Control")
// and turns it into the {mods, vk} the in-game panel synthesizes. Defaults to Ctrl+Alt+S -- Lossless
// Scaling's own default -- when the fields are missing or unrecognised.
function readLosslessHotkey(doc) {
  const root = doc.documentElement;
  const childText = (name) => {
    const el = Array.from(root.children).find((c) => c.tagName === name);
    return el ? el.textContent.trim() : '';
  };
  const keyName = childText('Hotkey') || 'S';
  const modText = childText('HotkeyModifierKeys') || 'Alt Control';

  let mods = 0;
  if (/\bControl\b/i.test(modText)) mods |= 1;
  if (/\bAlt\b/i.test(modText)) mods |= 2;
  if (/\bShift\b/i.test(modText)) mods |= 4;
  if (/\bWindows\b/i.test(modText)) mods |= 8;
  if (!mods) mods = 3; // Ctrl+Alt

  return { mods, vk: wpfKeyToVk(keyName) };
}

// Maps the common WPF Key enum names to Win32 virtual-key codes. Covers letters, digits (D0-D9 and
// NumPad0-9) and F1-F24 -- everything a Lossless Scaling toggle hotkey realistically uses; anything
// else falls back to 'S' (0x53), which with the Ctrl+Alt default reproduces its stock chord.
function wpfKeyToVk(name) {
  if (!name) return 0x53;
  if (/^[A-Z]$/i.test(name)) return name.toUpperCase().charCodeAt(0);
  let m;
  if ((m = /^D([0-9])$/.exec(name))) return 0x30 + Number(m[1]);
  if ((m = /^NumPad([0-9])$/i.exec(name))) return 0x60 + Number(m[1]);
  if ((m = /^F([1-9]|1[0-9]|2[0-4])$/i.exec(name))) return 0x70 + (Number(m[1]) - 1);
  return 0x53;
}

// Frame pacing (ReLimiter). Placed beside Frame Generation in the UI because it is a delivery
// setting -- it changes WHEN frames arrive, not how they look -- and grouping it under Speed vs
// quality would put it next to the model-resolution controls it is mutually exclusive with, which is
// the most confusing place it could possibly go.
async function loadRelimiterSection(game) {
  const section = $('#game-relimiter-section');
  const status = $('#game-relimiter-status');
  const installBtn = $('#btn-relimiter-install');
  const removeBtn = $('#btn-relimiter-remove');
  const targetBlock = $('#game-relimiter-target-block');
  if (!game || !game.exePath) { section.classList.add('hidden'); return; }

  const st = await window.api.relimiterStatus(game.exePath).catch(() => null);
  if (!st || !st.ok) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  // Vulkan cannot be set up from here at all: ReShade only runs there as a machine-wide implicit
  // layer, registered under HKLM by its own installer and attached only to exes in ReShadeApps.ini.
  // Said plainly rather than offering a button that cannot work.
  if (!st.automatic) {
    installBtn.classList.add('hidden');
    removeBtn.classList.toggle('hidden', !st.addon);
    targetBlock.classList.toggle('hidden', !st.addon);
    status.textContent = t("This game runs on Vulkan, where ReShade only loads as a machine-wide layer that its own installer registers -- this app cannot do that for you. Run ReShade's setup once for this exe, choosing Vulkan and \"Enable loading of add-ons\", and frame pacing can be set up here afterwards.");
    return;
  }

  installBtn.classList.toggle('hidden', st.complete);
  removeBtn.classList.toggle('hidden', !st.addon);
  targetBlock.classList.toggle('hidden', !st.addon);

  if (st.addonGone) {
    // Our marker lists it and the file is not there: the antivirus shape that cost Max Payne 2 a
    // whole diagnosis, so it is named rather than read as "not installed".
    status.textContent = t('Frame pacing was installed here and its file is gone from the folder, so something removed it after the fact -- almost always antivirus. Add an exclusion for this game folder first, then add it again.');
  } else if (st.complete) {
    status.textContent = t('Frame pacing is set up{version}.', { version: st.version ? ` (${st.version})` : '' });
  } else if (!st.reshade) {
    status.textContent = t('Needs ReShade beside the exe. Adding frame pacing sets that up too.');
  } else if (st.reshadeIsAddonBuild === false) {
    // Same version, same product name, and it never loads an add-on -- so the file being present is
    // not the same as it being usable.
    status.textContent = t('The ReShade in this folder is the plain build, which never loads add-ons. Adding frame pacing replaces it with the Add-on build.');
  } else {
    status.textContent = t('Ready to add.');
  }

  // Auto is target_fps = 0, which means "stay below the VRR ceiling" -- not "no limit" and not 0 fps.
  const auto = $('#game-relimiter-auto');
  const box = $('#game-relimiter-fps');
  const fixedRow = $('#game-relimiter-fixed-row');
  auto.checked = !(st.targetFps > 0);
  if (st.targetFps > 0) box.value = String(st.targetFps);
  fixedRow.classList.toggle('hidden', auto.checked);
}

async function loadLosslessSection(game) {
  const section = $('#game-lossless-section');
  const status = $('#game-lossless-status');
  const configureBtn = $('#btn-lossless-configure');
  const launchBtn = $('#btn-lossless-launch');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }

  // Offered only to games with no DLSS of their own (Feeder, Luma UE and plain no-DLSS games).
  // A native-DLSS game has NVIDIA's own Frame Generation in its video settings, versioned by the
  // "DLSS Frame Generation version" control above -- the gate lives in main.js
  // (losslessEligibility) so the marker/ini side enforces the same rule, not just this view.
  const gate = await window.api.losslessEligibility(game.exePath);
  if (!gate.eligible) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  // Shown without advanced options: players never found it behind the switch (v1.66.0-v1.72.0), so the
  // Frame Generation group opens for any game it applies to.
  if (!settings.showAdvanced) $('#edit-group-fg').open = true;
  // Back to defaults before this game's profile (if any) is read, so the last game's choices
  // never leak into an unconfigured one.
  $('#game-lossless-mode').value = 'FIXED';
  $('#game-lossless-multiplier').value = '2';
  $('#game-lossless-target').value = '120';
  syncLosslessModeInputs();

  const info = await window.api.losslessDetect();
  if (!info.installed) {
    status.innerHTML = t('Lossless Scaling was not found (checked your Steam library). A separate paid app you need to own yourself -- <a href="#" id="lossless-store-link">get it on Steam</a>.');
    const storeLink = $('#lossless-store-link');
    if (storeLink) storeLink.addEventListener('click', (e) => { e.preventDefault(); window.api.losslessOpenStorePage(); });
    configureBtn.disabled = true;
    launchBtn.classList.add('hidden');
    return;
  }
  if (!info.hasRunOnce) {
    status.textContent = t("Installed, but hasn't been run yet -- launch it once first.");
    configureBtn.disabled = true;
    launchBtn.classList.remove('hidden');
    return;
  }

  configureBtn.disabled = false;
  launchBtn.classList.remove('hidden');

  const xmlText = await window.api.losslessReadSettings();
  const exePathLower = game.exePath.trim().toLowerCase();
  let configured = false;
  let currentMultiplier = null;
  let currentMode = null;
  let currentTarget = null;
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const profile = Array.from(doc.querySelectorAll('GameProfiles > Profile')).find((p) => {
      const pathEl = p.querySelector('Path');
      return pathEl && pathEl.textContent.trim().toLowerCase() === exePathLower;
    });
    if (profile) {
      const text = (name) => {
        const el = profile.querySelector(name);
        return el ? el.textContent.trim() : '';
      };
      configured = !!text('FrameGeneration') && text('FrameGeneration') !== 'Off';
      currentMultiplier = text('LSFG3Multiplier') || null;
      currentMode = text('LSFG3Mode1') || null;
      currentTarget = text('LSFG3Target') || null;
    }
  } catch {}

  // Lossless Scaling's own UI allows multipliers this select does not offer (up to 20x); an
  // unmatched value would leave the select blank and read back as 0.
  if (['2', '3', '4'].includes(currentMultiplier)) $('#game-lossless-multiplier').value = currentMultiplier;
  if (currentMode) $('#game-lossless-mode').value = currentMode === 'ADAPTIVE' ? 'ADAPTIVE' : 'FIXED';
  if (currentTarget && Number(currentTarget) >= 30) $('#game-lossless-target').value = currentTarget;
  syncLosslessModeInputs();

  status.textContent = configured
    ? (currentMode === 'ADAPTIVE'
      ? t('Configured -- Adaptive Frame Generation, holding {target} fps.', { target: currentTarget || '?' })
      : t('Configured -- {multiplier}x Frame Generation.', { multiplier: currentMultiplier || '?' }))
    : t('Not yet configured for this game.');
}

function syncLosslessModeInputs() {
  const adaptive = $('#game-lossless-mode').value === 'ADAPTIVE';
  $('#game-lossless-multiplier').classList.toggle('hidden', adaptive);
  $('#game-lossless-target').classList.toggle('hidden', !adaptive);
}
$('#game-lossless-mode').addEventListener('change', syncLosslessModeInputs);

// Typed, not dragged. There was a slider beside this box; it went because the exact number is the
// whole point -- a fixed frame rate is for matching a figure chosen somewhere else (a 72 in the
// game's own limiter, a 141 under a 144 Hz ceiling), and a track from 30 to 1000 cannot land on one.
// The box carries ReLimiter's real range and nothing has to approximate.
function relimiterTargetInputs() {
  return { auto: $('#game-relimiter-auto'), box: $('#game-relimiter-fps') };
}

// What the box is worth once the user has finished typing. Clamped here rather than left to the
// input's own min/max, which a typed value ignores until the form is submitted -- and this form is
// never submitted. 0 is not reachable: Auto is the checkbox, not a number someone types.
function relimiterTypedFps(box) {
  const n = Math.round(Number(box.value));
  if (!Number.isFinite(n)) return 120;
  return Math.min(1000, Math.max(30, n));
}

async function saveRelimiterTarget() {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  if (!game || !game.exePath) return;
  const { auto, box } = relimiterTargetInputs();
  const fps = auto.checked ? 0 : relimiterTypedFps(box);
  // Show the value that was actually stored, so a 5 typed into the box does not sit there reading 5
  // while ReLimiter holds 30.
  if (!auto.checked) box.value = String(fps);
  const res = await window.api.relimiterSetTarget(game.exePath, fps).catch(() => null);
  const status = $('#game-relimiter-target-status');
  if (!res || !res.ok) { status.textContent = t('Could not write the frame rate.'); return; }
  status.textContent = auto.checked
    ? t('Set to stay below the VRR ceiling.')
    : t('Holding {fps} fps.', { fps: String(fps) });
}

$('#game-relimiter-auto').addEventListener('change', () => {
  const { auto } = relimiterTargetInputs();
  $('#game-relimiter-fixed-row').classList.toggle('hidden', auto.checked);
  saveRelimiterTarget();
});
$('#game-relimiter-fps').addEventListener('change', saveRelimiterTarget);
// Enter saves without leaving the field, which is how a number typed on purpose expects to behave.
$('#game-relimiter-fps').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveRelimiterTarget(); }
});
$('#btn-relimiter-install').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  if (!game || !game.exePath) return;
  const btn = $('#btn-relimiter-install');
  const status = $('#game-relimiter-status');
  btn.disabled = true;
  status.textContent = t('Adding frame pacing...');
  const res = await window.api.relimiterInstall(game.exePath).catch((e) => ({ ok: false, error: String(e) }));
  btn.disabled = false;
  if (!res || !res.ok) {
    await loadRelimiterSection(game);
    status.textContent = t('Could not add frame pacing: {error}', { error: (res && res.error) || '?' });
    return;
  }
  await loadRelimiterSection(game);
  // Only the fork's build exports the API the in-game panel uses, so say which one landed: with
  // upstream's, pacing works through ReLimiter's own overlay but the panel has no Pacing page.
  if (!res.hostApi) {
    status.textContent += ' ' + t("This is upstream ReLimiter, which the in-game panel cannot drive -- use ReLimiter's own overlay in the game, or the target below.");
  }
});
$('#btn-relimiter-remove').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  if (!game || !game.exePath) return;
  await window.api.relimiterRemove(game.exePath).catch(() => null);
  await loadRelimiterSection(game);
});

$('#btn-lossless-configure').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-lossless-status');
  const mode = $('#game-lossless-mode').value === 'ADAPTIVE' ? 'ADAPTIVE' : 'FIXED';
  const multiplier = [2, 3, 4].includes(Number($('#game-lossless-multiplier').value)) ? Number($('#game-lossless-multiplier').value) : 2;
  const target = Math.min(480, Math.max(30, Math.round(Number($('#game-lossless-target').value) || 120)));
  status.textContent = t('Configuring…');
  try {
    const result = await configureLossless(game, { mode, multiplier, target });
    const info = await window.api.losslessDetect();
    if (info.installed) {
      const hk = result.hotkey || { mods: 3, vk: 0x53 };
      const iniRes = await window.api.losslessSetExePathInGameIni(game.exePath, info.exePath, game.name, { mode, multiplier, target, hotkeyMods: hk.mods, hotkeyVk: hk.vk });
      if (!iniRes.ok) toast(t('Profile saved, but the in-game panel link was not written: {error}', { error: iniRes.error }));
      else if (iniRes.deferred) toast(t('Profile saved. The in-game panel link will be written when OptiScaler is installed for this game.'));
    }
    const what = mode === 'ADAPTIVE' ? t('Adaptive Frame Generation, target {target} fps', { target }) : t('{multiplier}x Frame Generation', { multiplier });
    toast(result.isNew
      ? t('Added a Lossless Scaling profile for this game ({what}).', { what })
      : t("Updated this game's Lossless Scaling profile ({what}).", { what }));

    // Lossless Scaling only reads profiles at startup, and a running one would later write its
    // stale copy back over the file -- so a running instance is restarted (to the tray) now.
    const restart = await window.api.losslessRestart();
    if (!restart.ok) toast(t('Lossless Scaling is running and could not be restarted, so it has not read the new profile yet: {error}', { error: restart.error }));
    else if (restart.restarted) toast(t('Restarted Lossless Scaling in the tray so it reads the new profile.'));

    // Only one frame generator at a time: two of them stack their generated frames. OptiScaler's
    // own FG is ours to switch off; the game's native DLSS Frame Generation is a game setting the
    // hint above (and the in-game panel) tells the user to turn off themselves.
    const optiFg = await window.api.optiFgReadiness(game.exePath);
    if (optiFg.supported && optiFg.enabled) {
      const off = await window.api.optiFgSet(game.exePath, false);
      toast(off.ok
        ? t("Turned OptiScaler's own Frame Generation off for this game -- it can't run together with Lossless Scaling.")
        : t("Could not turn OptiScaler's own Frame Generation off: {error}", { error: off.error }));
      loadOptiFgSection(game);
    }
  } catch (error) {
    toast(t('Could not configure Lossless Scaling: {error}', { error: error.message }));
  }
  loadLosslessSection(game);
});

$('#btn-lossless-launch').addEventListener('click', async () => {
  const res = await window.api.losslessLaunch();
  if (res.ok) {
    toast(res.alreadyRunning ? t('Lossless Scaling is already running (check the tray).') : t('Launched Lossless Scaling.'));
  } else {
    toast(t('Could not launch Lossless Scaling: {error}', { error: res.error }));
  }
  if (editingGameId) {
    const game = games.find((x) => x.id === editingGameId);
    loadLosslessSection(game);
  }
});

async function loadLumaUeSection(game) {
  const section = $('#game-lumaue-section');
  const status = $('#game-lumaue-status');
  const deployBtn = $('#btn-lumaue-deploy');
  const knownIssue = $('#game-lumaue-known-issue');
  const licenseText = $('#game-lumaue-license-text');
  const licenseCheckbox = $('#game-lumaue-license-confirm');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }

  const readiness = await window.api.lumaUeReadiness(game.exePath);
  if (!readiness.ok || !readiness.supported) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  knownIssue.textContent = t(readiness.knownIssue || '');
  licenseText.textContent = readiness.licenseSummary || '';
  deployBtn.disabled = !licenseCheckbox.checked;
  const prey = readiness.profile === 'prey';
  // The section's heading and first hint are written for the Unreal mod; Prey's mod is its own thing.
  const heading = section.querySelector('.field-label');
  if (heading) heading.textContent = prey ? t('Luma (adds DLSS to this game)') : t('Luma UE (adds DLSS to this game)');
  const ueHint = section.querySelector('p.field-hint:not(#game-lumaue-known-issue)');
  if (ueHint) ueHint.classList.toggle('hidden', prey);
  // Prey's note is a how-to, not Fallen Order's open bug: not in red.
  knownIssue.classList.toggle('status-bad', !prey);
  $('#btn-lumaue-howto').classList.toggle('hidden', prey);
  deployBtn.textContent = readiness.blockedByFeeder ? t('Deploy Luma UE (removes the Feeder first)')
    : prey ? t('Deploy Luma')
    : readiness.experimental ? t('Deploy Luma UE (experimental)') : t('Deploy Luma UE');
  $('#btn-lumaue-remove').classList.toggle('hidden', !readiness.addonInstalled);
  // The workaround used to be a blind question; now the GPU is known it is pre-answered, and
  // still a checkbox the user can untick.
  if (gpu.vendor === 'amd' || gpu.vendor === 'intel') $('#game-lumaue-amd-intel').checked = true;

  const yn = (v) => (v ? t('yes') : t('no'));
  status.textContent = readiness.complete
    ? t('Luma is set up with DLSS switched on.')
    : readiness.blockedByFeeder
      ? t(readiness.reason)
      : t('Not yet deployed (ReShade64.dll: {reshade}, addon: {addon}, shaders: {shaders}, nvngx_dlss.dll: {dlss}).', {
        reshade: yn(readiness.reshadeInstalled), addon: yn(readiness.addonInstalled), shaders: yn(readiness.shadersInstalled), dlss: yn(readiness.dlssInstalled),
      });

  // Unprompted, once per game: the deploy button alone turned out not to be enough -- a real
  // tester deployed nothing at all and the log showed no trace of Luma ever having run, which
  // reads the same as "waiting for the upscaler" from a completely different cause. Surfacing
  // the full instructions automatically the first time this section is seen for a game that
  // still needs them is meant to catch that before it happens again, not just be available for
  // someone who already knows to go looking for a "how to" button.
  // (Those instructions are Fallen Order's; Prey's steps are in the route text and Game Help.)
  if (!readiness.complete && !prey) {
    const seenKey = `lumaue-instructions-seen-${game.id}`;
    let alreadySeen = false;
    try { alreadySeen = localStorage.getItem(seenKey) === '1'; } catch {}
    if (!alreadySeen) {
      openLumaUeInstructionsModal();
      try { localStorage.setItem(seenKey, '1'); } catch {}
    }
  }
}

function openLumaUeInstructionsModal() {
  $('#lumaue-instructions-modal').classList.remove('hidden');
}

$('#btn-lumaue-howto').addEventListener('click', openLumaUeInstructionsModal);
$('#btn-close-lumaue-instructions').addEventListener('click', () => {
  $('#lumaue-instructions-modal').classList.add('hidden');
});

$('#game-lumaue-license-confirm').addEventListener('change', (e) => {
  $('#btn-lumaue-deploy').disabled = !e.target.checked;
});

$('#btn-lumaue-remove').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  $('#game-lumaue-status').textContent = t('Removing Luma UE…');
  const res = await window.api.lumaUeRemove(game.exePath);
  toast(res.ok ? t('Luma UE removed ({list}).', { list: res.removed.join(', ') }) : t('Could not remove Luma UE: {error}', { error: res.error }));
  await loadFeederSection(game);
  await loadLumaUeSection(game);
  await loadLosslessSection(game);
  await loadRelimiterSection(game);
  renderGrid();
});

$('#btn-lumaue-deploy').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-lumaue-status');
  const licenseConfirmed = $('#game-lumaue-license-confirm').checked;
  if (!licenseConfirmed) return;
  status.textContent = t('Deploying…');
  try {
    const result = await window.api.lumaUeDeploy(game.exePath, { licenseConfirmed });
    if (!result.ok) throw new Error(result.error || t('Deploy failed'));
    if (result.feederRemoved) toast(t('DLSS5 Feeder removed ({list}).', { list: result.feederRemoved.removed.join(', ') }));
    toast(result.deployed ? t('Deployed Luma UE for this game.') : t('Luma UE was already deployed.'));
    if (!result.optiScalerInstalled) {
      toast(t('DLSS 5 is not installed for this game yet -- click Install on its card; Luma only loads through it.'));
    } else if (result.autoConfigured && result.autoConfigured.some((e) => e.key === 'LoadReshade')) {
      toast(t('Set [Plugins] LoadReshade=true in OptiScaler.ini so OptiScaler loads Luma.'));
    }
    if ($('#game-lumaue-amd-intel').checked) {
      const workaround = await window.api.lumaUeApplyAmdIntelWorkaround(game.exePath);
      if (workaround.ok) toast(t('Applied the AMD/Intel workaround to OptiScaler.ini.'));
      else toast(t('Could not apply the AMD/Intel workaround: {error}', { error: workaround.error }));
    }
  } catch (error) {
    toast(t('Could not deploy Luma UE: {error}', { error: error.message }));
  }
  // The Feeder section, the route tag and Lossless all keyed off "Feeder game" -- refresh them.
  await loadFeederSection(game);
  await loadLumaUeSection(game);
  await loadLosslessSection(game);
  await loadRelimiterSection(game);
  renderGrid();
});

function closeGameModal() {
  gameModal.classList.add('hidden');
  editingGameId = null;
}

function updateBannerPreview() {
  const img = $('#banner-preview');
  const fallback = $('#banner-preview-fallback');
  setBannerWithFallback(
    { name: $('#game-name').value, bannerAppId: pendingBanner.appid, bannerLocalPath: pendingBanner.localPath },
    img,
    fallback
  );
}

$('#btn-add-game').addEventListener('click', () => openGameModal(null));
$('#btn-add-game-empty').addEventListener('click', () => openGameModal(null));
$('#btn-cancel-game').addEventListener('click', closeGameModal);

// The exes in this game's folder, as a list to choose from. Shown only when there is a real choice
// to make; the game's current exe is always the selected one, whatever the scoring thinks.
async function loadExeCandidates(game) {
  const select = $('#game-exe-candidates');
  select.innerHTML = '';
  select.classList.add('hidden');
  if (!game || !game.exePath) return;
  const res = await window.api.exeCandidates(game.exePath);
  const candidates = (res && res.candidates) || [];
  if (candidates.length < 2) return;
  for (const p of candidates) {
    const opt = document.createElement('option');
    opt.value = p;
    // The path relative to the game's folder reads better than a repeated absolute prefix.
    opt.textContent = res.root && p.toLowerCase().startsWith(res.root.toLowerCase())
      ? p.slice(res.root.length).replace(/^[\\/]+/, '')
      : p;
    select.appendChild(opt);
  }
  select.value = candidates.find((p) => p.toLowerCase() === game.exePath.toLowerCase()) || candidates[0];
  select.classList.remove('hidden');
  select.onchange = () => {
    $('#game-exe').value = select.value;
    exeNote(t('Save to use this exe -- the game is detected again for it.'));
  };
}

function exeNote(text) {
  const note = $('#game-exe-note');
  note.textContent = text || '';
  note.classList.toggle('hidden', !text);
}

$('#btn-browse-exe').addEventListener('click', async () => {
  const res = await window.api.pickExe();
  if (!res) return;
  const p = typeof res === 'string' ? res : res.path;
  $('#game-exe').value = p;
  // An Unreal launcher stub was swapped for the shipping exe it spawns. Said out loud, with the
  // original one click away -- the swap is right for a packaged Unreal game and wrong for anything
  // it misreads, and silently overruling the choice is what made this look broken.
  if (res && res.swapped) {
    exeNote(t('That exe only launches {shipping}, which is the process this app has to install beside -- so it was used instead. Click Browse again and pick the same file to keep {picked} anyway.',
      { shipping: p.split(/[\\/]/).pop(), picked: res.picked.split(/[\\/]/).pop() }));
    // A second identical pick means they meant it: honour the original next time round.
    if (lastPickedExe && lastPickedExe.toLowerCase() === res.picked.toLowerCase()) {
      $('#game-exe').value = res.picked;
      exeNote(t('Using {picked}, as picked.', { picked: res.picked.split(/[\\/]/).pop() }));
    }
    lastPickedExe = res.picked;
  } else {
    exeNote('');
    lastPickedExe = null;
  }
  if (!$('#game-name').value) {
    // The Steam manifest's name where the exe sits in a Steam library, else a folder or exe
    // name that says something -- "re2" as a name found Red Dead Redemption 2's art.
    const base = p.split(/[\\/]/).pop().replace(/\.exe$/i, '');
    const fallback = base.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const pretty = (await window.api.nameForExe(p)) || fallback;
    $('#game-name').value = pretty;
    $('#steam-search-term').value = pretty;
  }
});

$('#btn-browse-image').addEventListener('click', async () => {
  const p = await window.api.pickImage();
  if (!p) return;
  const localPath = await window.api.importLocalBanner(p);
  pendingBanner = { appid: null, localPath };
  updateBannerPreview();
});

$('#btn-steam-search').addEventListener('click', doSteamSearch);
$('#steam-search-term').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSteamSearch();
});

async function doSteamSearch() {
  const term = $('#steam-search-term').value.trim();
  if (!term) return;
  const results = $('#steam-results');
  results.innerHTML = `<div class="steam-result-item">${escapeHtml(t('Searching...'))}</div>`;
  const items = await window.api.steamSearch(term);
  results.innerHTML = '';
  if (items.length === 0) {
    results.innerHTML = `<div class="steam-result-item">${escapeHtml(t('No matches found.'))}</div>`;
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'steam-result-item';
    row.innerHTML = `<img src="${item.tinyImage || ''}" /> <span>${escapeHtml(item.name)}</span>`;
    row.addEventListener('click', async () => {
      row.style.opacity = '0.5';
      const localPath = await window.api.cacheSteamBanner(item.appid, item.tinyImage);
      pendingBanner = { appid: item.appid, localPath };
      updateBannerPreview();
    });
    results.appendChild(row);
  }
}

$('#btn-save-game').addEventListener('click', async () => {
  const exePath = $('#game-exe').value.trim();
  const name = $('#game-name').value.trim();
  if (!exePath) return toast(t('Pick the game .exe first.'));
  if (!name) return toast(t('Give the game a name.'));

  const launchMode = $('#game-launch-mode').value === 'injector' ? 'injector' : 'proxy';
  const launcher = $('#game-launcher').value || 'auto';

  if (editingGameId) {
    const g = games.find((x) => x.id === editingGameId);
    // A changed exe changes every answer about the game: its API, its engine, its route, whether it
    // ships DLSS. The stored detection belongs to the old exe, so it goes -- keeping it is what
    // left a card reading "unknown support" after someone corrected the exe by hand, since
    // detection only re-runs when it is missing or when DETECT_VERSION has moved on.
    const exeChanged = String(g.exePath || '').toLowerCase() !== exePath.toLowerCase();
    g.exePath = exePath;
    g.name = name;
    g.bannerAppId = pendingBanner.appid;
    g.bannerLocalPath = pendingBanner.localPath;
    g.launchMode = launchMode;
    g.launcher = launcher;
    if (exeChanged) {
      g.detectedPath = null;
      // Chosen by a person: nothing should quietly re-resolve it afterwards.
      g.exeLocked = true;
      await window.api.saveGames(games);
      // Detected now rather than on the next render, so the card is right the moment it reappears.
      g.detectedPath = await window.api.detectPath(exePath);
      toast(t('Now using {exe}. Detected again: {reason}', {
        exe: exePath.split(/[\\/]/).pop(),
        reason: (g.detectedPath && g.detectedPath.reason) || t('nothing conclusive -- Edit has a manual render-API override'),
      }));
    }
  } else {
    games.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      exePath,
      name,
      bannerAppId: pendingBanner.appid,
      bannerLocalPath: pendingBanner.localPath,
      launchMode,
      launcher
    });
  }
  await window.api.saveGames(games);
  closeGameModal();
  renderGrid();
});
const settingsModal = $('#settings-modal');

function openSettingsModal() {
  $('#settings-gpu-status').textContent = t('GPU: {gpu}', { gpu: gpuLabel() }) +
    (gpu.vendor === 'amd' ? ' ' + t("-- Neural Rendering here goes through DLSS-NR-on-AMD (see a game's Edit dialog), not OptiScaler.")
      : gpu.vendor === 'intel' ? ' ' + t('-- no Neural Rendering route on Intel; OptiScaler still installs for its upscaler swap.')
      : gpu.vendor === 'unknown' ? ' ' + t('-- could not identify the GPU; assuming NVIDIA.') : '');
  $('#settings-language').value = settings.language || 'auto';
  $('#settings-theme').value = settings.theme === 'light' ? 'light' : 'dark';
  $('#settings-show-advanced').checked = !!settings.showAdvanced;
  $('#settings-advanced').classList.toggle('hidden', !settings.showAdvanced);
  $('#settings-feeder-prerelease').checked = !!settings.feederPrerelease;
  $('#settings-engine').value = engineIdOrDefault(settings.engine);
  showEngineChoiceState();
  $('#settings-panel-enabled').checked = panelEnabled();
  $('#settings-panel-hotkey').value = panelHotkey();
  showPanelHotkeyState();
  $('#settings-ai-key').value = settings.anthropicApiKey || '';
  $('#settings-steamgrid-key').value = settings.steamGridDbKey || '';
  $('#settings-ai-model').value = settings.aiModel || 'claude-sonnet-5';
  $('#settings-nr-dll').value = settings.nrDllPath || '';
  checkNrDllStatus();
  loadStreamlineVersions();
  loadSettingsDfc();
  settingsModal.classList.remove('hidden');
}

let streamlineVersionsLoaded = false;

async function loadStreamlineVersions() {
  const select = $('#settings-streamline-version');
  const status = $('#streamline-version-status');
  const wanted = settings.streamlineVersion || 'latest';

  if (!streamlineVersionsLoaded) {
    status.className = 'status-line';
    status.textContent = t('Checking what RHI has published…');
    const res = await window.api.streamlineVersions();
    if (res && res.ok && res.versions.length > 0) {
      for (const v of res.versions) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
      }
      streamlineVersionsLoaded = true;
      status.className = 'status-line status-ok';
      status.textContent = t('Newest available: {version}', { version: res.versions[0] });
    } else {
      status.className = 'status-line';
      status.textContent = t('Could not reach the version list — "Latest" still works, it just resolves at install time.');
    }
  }

  if (wanted !== 'latest' && !Array.from(select.options).some((o) => o.value === wanted)) {
    const opt = document.createElement('option');
    opt.value = wanted;
    opt.textContent = wanted;
    select.appendChild(opt);
  }
  select.value = wanted;
}

$('#settings-streamline-version').addEventListener('change', async (e) => {
  settings.streamlineVersion = e.target.value || 'latest';
  await window.api.saveSettings(settings);
});

// UI language. 'auto' follows the OS (I18N.detect); a chosen language is stored and wins. Static
// text re-translates in place; everything drawn by code re-renders on the next grid/dialog pass.
function applyLanguage() {
  const wanted = settings.language && settings.language !== 'auto' ? settings.language : I18N.detect();
  I18N.setLocale(wanted);
}

$('#settings-ai-key').addEventListener('change', async (e) => {
  settings.anthropicApiKey = (e.target.value || '').trim();
  await window.api.saveSettings(settings);
});
$('#settings-ai-model').addEventListener('change', async (e) => {
  settings.aiModel = e.target.value || 'claude-sonnet-5';
  await window.api.saveSettings(settings);
});
// Saving a key is what makes the fallback exist, so the cards that gave up on art are sent back to
// look straight away rather than after the next version bump: forgetting the search they already
// did is exactly what "there is somewhere new to look" means. Only ever cards wearing an auto-found
// icon -- art picked by hand carries no bannerSearchAttempted and is not touched.
$('#settings-steamgrid-key').addEventListener('change', async (e) => {
  const key = (e.target.value || '').trim();
  const had = !!settings.steamGridDbKey;
  settings.steamGridDbKey = key;
  await window.api.saveSettings(settings);
  if (key && !had) {
    for (const g of games) if (g.bannerIsIcon && g.bannerSearchAttempted) g.bannerSearchVersion = 0;
    await window.api.saveGames(games);
    renderGrid();
  }
});

// One switch for everything most people never need: Settings' expert fields, and Edit's Frame
// Generation / Advanced sections (refreshEditGroups).
$('#settings-show-advanced').addEventListener('change', async (e) => {
  settings.showAdvanced = !!e.target.checked;
  await window.api.saveSettings(settings);
  $('#settings-advanced').classList.toggle('hidden', !settings.showAdvanced);
  refreshEditGroups();
});

// Deploy and the update check both read this from settings.json at call time, so a change here
// applies to the next deploy without a restart and without re-deploying anything now.
$('#settings-feeder-prerelease').addEventListener('change', async (e) => {
  settings.feederPrerelease = !!e.target.checked;
  await window.api.saveSettings(settings);
});

// Which build a game gets on its next Install. Says what is on disk for the chosen build, and repeats
// the thing a user most needs to know about the Pre-SR fork: Alt+Home draws nothing there.
function showEngineChoiceState() {
  const el = $('#settings-engine-status');
  if (!el) return;
  const id = engineIdOrDefault(settings.engine);
  const version = engineVersion(id);
  const ready = version
    ? t('{engine} {version} is ready.', { engine: engineLabel(id), version })
    : t('{engine} will be fetched the first time a game is installed with it.', { engine: engineLabel(id) });
  if (!ENGINES_WITHOUT_PANEL.has(id)) { el.textContent = ready; return; }
  // Naming the hotkey while the pop-out panel is switched off would send someone to a key that does
  // nothing -- the 2026-09-18 bug renderer-dom.test.js guards against. Off, the honest answer is to
  // say so, because on this build there is no other panel to fall back to.
  el.textContent = `${ready} ${popoutHotkeyUsable()
    ? t('No in-game panel on this build: press {hotkey} for the pop-out panel instead.', { hotkey: panelHotkey() })
    : t('No in-game panel on this build, and the pop-out panel is switched off -- turn it on above, or this build has no panel at all.')}`;
}

// Chosen here, fetched here: waiting until an Install would mean the first game on a new build sits
// through a download with no explanation. A failure leaves the choice saved and says why.
$('#settings-engine').addEventListener('change', async (e) => {
  settings.engine = engineIdOrDefault(e.target.value);
  await window.api.saveSettings(settings);
  showEngineChoiceState();
  const res = await ensureEngine(settings.engine);
  if (!res.ok) {
    $('#settings-engine-status').textContent = t('Could not fetch {engine}: {error}', { engine: engineLabel(settings.engine), error: res.error });
    return;
  }
  showEngineChoiceState();
  // The cards name the build and its panel key, so they are stale until they are drawn again.
  await renderGrid();
});

// The pop-out DLSS 5 panel (src/panelwindow.js). Its hotkey belongs to the OS rather than to this
// window, so saving the setting is what re-registers it; main.js does that on every settings save.
const DEFAULT_PANEL_HOTKEY = 'Insert';

// The pop-out's key as main.js reads it (panelwindow.accelerator): the player's own, else Insert. A
// saved Alt+Shift+Home is the old default an older build wrote, not a choice, so it reads as Insert.
function panelHotkey() {
  const value = typeof settings.panelHotkey === 'string' ? settings.panelHotkey.trim() : '';
  return !value || value.toLowerCase() === 'alt+shift+home' ? DEFAULT_PANEL_HOTKEY : value;
}

// On Insert the pop-out shares the in-game panel's key, and main.js hands it the key only while a game
// that needs it runs (32-bit, OpenGL, overlay off). Everywhere else Insert is the in-game panel, so
// "press {hotkey} for the pop-out" would be false there.
function panelKeyIsShared() {
  return panelHotkey().toLowerCase() === DEFAULT_PANEL_HOTKEY.toLowerCase();
}

function panelEnabled() {
  return settings.panelEnabled === undefined || !!settings.panelEnabled;
}

// What the last panelHotkeyState answer said: false once Windows refused the hotkey (another
// program holds it). Remembered rather than asked per card, since the card hint and Game Help's
// steps are built synchronously; null until the first answer, which counts as usable.
let panelHotkeyRegistered = null;

// Whether telling someone "press {hotkey} for the pop-out panel" is true right now. The card hint
// and Game Help both named the hotkey with the panel switched off (review of 2026-09-18).
function popoutHotkeyUsable() {
  return panelEnabled() && panelHotkeyRegistered !== false;
}

async function showPanelHotkeyState() {
  const el = $('#panel-hotkey-status');
  const state = await window.api.panelHotkeyState();
  panelHotkeyRegistered = state && !state.disabled ? !!state.ok : null;
  if (!state || state.disabled || !panelEnabled()) {
    el.textContent = t('The hotkey is off. The button above still opens it.');
    el.className = 'status-line';
    return;
  }
  el.textContent = state.ok
    ? (state.smart
      ? t('Insert opens this window while a 32-bit game, or one with no in-game panel, is running. On every other game Insert opens the DLSS 5 panel inside the game -- bind a different key here to have this window on every game.')
      : t('{key} opens and closes it, even while a game has focus.', { key: state.accelerator }))
    : t('Windows would not give this app {key} — another program already has it. Pick a different combination.', { key: state.accelerator });
  el.className = `status-line ${state.ok ? 'status-ok' : 'status-bad'}`;
}

// Typed by pressing the combination rather than spelling it out: an accelerator is Electron's own
// syntax, and a user who mistypes it gets a hotkey that silently never fires.
$('#settings-panel-hotkey').addEventListener('keydown', async (e) => {
  e.preventDefault();
  const key = e.key;
  if (key === 'Tab') return;
  if (key === 'Backspace' || key === 'Delete') {
    delete settings.panelHotkey;
    $('#settings-panel-hotkey').value = DEFAULT_PANEL_HOTKEY;
    await window.api.saveSettings(settings);
    showPanelHotkeyState();
    return;
  }
  // A bare modifier is the half-pressed state on the way to a real combination, not a choice.
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return;

  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  // A plain letter, digit or space on its own would be taken from every other program in the system,
  // so those need a modifier. A key nobody types text with -- Insert, the default, or Home, End, the
  // F-keys -- is fine bare.
  //
  // Numpad keys by their physical position (e.code), not e.key: with Num Lock on, the numpad's
  // 0/Ins key reports "0", which would bind the top-row 0. Electron names them num0..num9 and numdec.
  // They are fine bare too -- a laptop with no Insert of its own has it on numpad 0 (2026-09-23).
  const numpad = /^Numpad(\d)$/.exec(e.code || '');
  const numpadKey = numpad ? `num${numpad[1]}` : e.code === 'NumpadDecimal' ? 'numdec' : null;
  const bareOk = !!numpadKey || /^(Insert|Home|End|PageUp|PageDown|F([1-9]|1[0-9]|2[0-4]))$/.test(key);
  if (parts.length === 0 && !bareOk) {
    const el = $('#panel-hotkey-status');
    el.textContent = t('Hold Ctrl, Alt or Shift as well — a key on its own would be taken from every other program.');
    el.className = 'status-line status-bad';
    return;
  }

  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
  parts.push(numpadKey || named[key] || (key.length === 1 ? key.toUpperCase() : key));

  settings.panelHotkey = parts.join('+');
  $('#settings-panel-hotkey').value = settings.panelHotkey;
  await window.api.saveSettings(settings);
  showPanelHotkeyState();
});

$('#settings-panel-enabled').addEventListener('change', async (e) => {
  settings.panelEnabled = !!e.target.checked;
  await window.api.saveSettings(settings);
  showPanelHotkeyState();
});

$('#btn-panel-open').addEventListener('click', () => window.api.panelOpen());

// One switch for the whole app: the pop-out panel reads the same settings.json, and main.js tells
// whichever window did not make the change.
function applyTheme() {
  const light = settings.theme === 'light';
  document.body.classList.toggle('theme-light', light);
  document.documentElement.classList.toggle('theme-light', light);
}

$('#settings-theme').addEventListener('change', async (e) => {
  settings.theme = e.target.value === 'light' ? 'light' : 'dark';
  applyTheme();
  await window.api.saveSettings(settings);
});

window.api.onSettingsChanged((next) => {
  if (!next) return;
  settings.theme = next.theme;
  applyTheme();
});

$('#settings-language').addEventListener('change', async (e) => {
  settings.language = e.target.value || 'auto';
  await window.api.saveSettings(settings);
  applyLanguage();
  openSettingsModal();
  renderGrid();
});

async function checkNrDllStatus() {
  const el = $('#nr-dll-status');
  if (!settings.nrDllPath) {
    el.textContent = '';
    return;
  }
  const res = await window.api.validateNrDll(settings.nrDllPath);
  el.textContent = res.valid ? t('Looks good — {mb} MB.', { mb: res.sizeMB }) : t('Not valid: {reason}', { reason: res.reason });
  el.className = `status-line ${res.valid ? 'status-ok' : 'status-bad'}`;
}

$('#btn-settings').addEventListener('click', openSettingsModal);
// Delegated: the banner's inner HTML is re-rendered on a language change, so a listener bound to
// the link itself would be lost with the old element.
settingsBanner.addEventListener('click', (e) => {
  if (!e.target.closest('#settings-banner-link')) return;
  e.preventDefault();
  openSettingsModal();
});

async function persistNrDll(p) {
  settings.nrDllPath = p;
  $('#settings-nr-dll').value = p;
  await window.api.saveSettings(settings);
  checkNrDllStatus();
  refreshBannerVisibility();
}

$('#btn-browse-nr-dll').addEventListener('click', async () => {
  const p = await window.api.pickDll();
  if (p) persistNrDll(p);
});
$('#btn-fetch-nr-dll').addEventListener('click', async () => {
  const btn = $('#btn-fetch-nr-dll');
  btn.disabled = true;
  try {
    await ensureNrModel({ force: true });
  } finally {
    btn.disabled = false;
  }
});
$('#settings-nr-dll').addEventListener('change', (e) => persistNrDll(e.target.value.trim()));

$('#btn-close-settings').addEventListener('click', async () => {
  settingsModal.classList.add('hidden');
  renderGrid();
});
// Called from start-up, from a settings change and from the model fetch finishing, which can land
// close enough together to overlap. Two passes would copy the same files over each other and write
// the same ini twice, at twice the cost.
let autoSyncInFlight = null;
function autoSyncStaleGames() {
  if (!autoSyncInFlight) {
    autoSyncInFlight = runAutoSyncStaleGames().finally(() => { autoSyncInFlight = null; });
    autoSyncInFlight.catch(() => {});
  }
  return autoSyncInFlight;
}

async function runAutoSyncStaleGames() {
  if (games.length === 0) return;

  const updated = [];
  const configured = [];
  const streamlined = [];
  const nrRefreshed = [];
  const failed = [];
  const layerWarned = [];
  const gameRechecked = [];
  const gameBroken = [];

  // A build with no valid folder yet is skipped rather than fetched here -- Install does that.
  const validByEngine = {};
  for (const game of games) {
    const engineId = engineOf(game);
    if (validByEngine[engineId] === undefined) {
      const folder = engineFolder(engineId);
      validByEngine[engineId] = !!folder && (await window.api.validateRelease(folder)).valid;
    }
    if (!validByEngine[engineId]) continue;
    const res = await window.api.syncGameIfStale({ exePath: game.exePath, releaseFolder: engineFolder(engineId), nrDllPath: settings.nrDllPath });
    if (!res.ok) {
      failed.push(`${game.name} (${res.error})`);
      syncRetry.set(game.exePath, Date.now());
      continue;
    }
    syncRetry.delete(game.exePath);
    if (noteSyncResult(game, res)) layerWarned.push(game.name);
    if (res.gameUpdated) (res.gameUpdated.needsReinstall ? gameBroken : gameRechecked).push(game.name);
    if (res.updated) updated.push(game.name);
    if (res.nrUpdated) nrRefreshed.push(game.name);
    if (res.autoConfigured && res.autoConfigured.length > 0) {
      configured.push(`${game.name} (${res.api || t('detected')}: ${res.autoConfigured.map((e) => e.key).join(', ')})`);
    }
    if (res.streamline && res.streamline.deployed) streamlined.push(game.name);
  }

  if (updated.length > 0) {
    toast(updated.length > 1
      ? t('Auto-updated OptiScaler in {count} games: {list}', { count: updated.length, list: updated.join(', ') })
      : t('Auto-updated OptiScaler in 1 game: {list}', { list: updated.join(', ') }));
  }
  if (configured.length > 0) {
    toast(t('Auto-configured: {list}', { list: configured.join('; ') }));
  }
  if (streamlined.length > 0) {
    toast(t('Deployed the Streamline SDK (needed for DLSS Frame Gen) to: {list}', { list: streamlined.join(', ') }));
  }
  if (nrRefreshed.length > 0) {
    toast(t('DLSS NR model refreshed in: {list}.', { list: nrRefreshed.join(', ') }));
  }
  if (failed.length > 0) {
    toast(t('Could not auto-update: {list} — close the game and retry.', { list: failed.join(', ') }));
  }
  if (layerWarned.length > 0) {
    toast(t('Feeder updated, but ReShade\'s Vulkan layer will not load in: {list}. Hover the card for what to do.', { list: layerWarned.join(', ') }));
  }
  if (gameBroken.length > 0) {
    toast(t('A game update removed DLSS 5 files from: {list}. Reinstall to put them back.', { list: gameBroken.join(', ') }));
  } else if (gameRechecked.length > 0) {
    toast(t('Game updated — rechecked: {list}', { list: gameRechecked.join(', ') }));
  }
  // A new exe can mean a new route: the cards re-read detection (main.js dropped the cached answer).
  if (gameBroken.length > 0 || gameRechecked.length > 0) renderGrid();
}
// Numeric per segment; a suffix like "-hotfix" or "10a" counts as its leading number, so a
// suffixed tag is never mistaken for an older one.
function compareTags(a, b) {
  const parse = (t) => String(t || '').replace(/^v/i, '').split('.').map((s) => parseInt(s, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ── The OptiScaler build ──────────────────────────────────────────────────────
//
// Two builds (engines.js is the list in main): this project's own OptiScaler_DLSSNR fork, which ships
// inside the installer and is extracted on first launch, and wilsjo2's Pre-SR Multipass fork, fetched
// from its own releases the first time it is chosen. The choice was dropped in v1.64.0 and asked for
// again on 2026-09-19.
//
// The default build keeps its state where it always was (settings.releaseFolder / installedVersion);
// the other lives in settings.engines[id] = { folder, version }, so switching never mixes two releases'
// files. A game may name its own build (game.engine, from its .dlss5ui-engine.json marker); otherwise
// it follows settings.engine.
//
// The Pre-SR build draws no panel inside the game, so Alt+Home does nothing on it -- the break-away
// panel (Alt+Shift+Home) is what reaches its settings, because that one edits the ini instead of
// drawing. engines.js carries the fact as `panel`, and route-explain.js says it on the card.
const ENGINE_LABELS = {
  dlssnr: 'OptiScaler_DLSSNR',
  presr: 'OptiScaler-DLSSNR-PreSR-Multipass',
};
const DEFAULT_ENGINE_ID = 'dlssnr';
// Builds with no in-game panel of their own, by id -- mirrors engines.js `panel: false`.
const ENGINES_WITHOUT_PANEL = new Set(['presr']);

function engineIdOrDefault(id) {
  return Object.prototype.hasOwnProperty.call(ENGINE_LABELS, id) ? id : DEFAULT_ENGINE_ID;
}

function engineLabel(id) {
  return ENGINE_LABELS[engineIdOrDefault(id)];
}

function engineOf(game) {
  return engineIdOrDefault(game && game.engine ? game.engine : settings.engine);
}

function engineFolder(id) {
  id = engineIdOrDefault(id);
  if (id === DEFAULT_ENGINE_ID) return settings.releaseFolder || '';
  return ((settings.engines || {})[id] || {}).folder || '';
}

function engineVersion(id) {
  id = engineIdOrDefault(id);
  if (id === DEFAULT_ENGINE_ID) return settings.installedVersion || '';
  return ((settings.engines || {})[id] || {}).version || '';
}

function setEngineState(id, folder, version) {
  id = engineIdOrDefault(id);
  if (id === DEFAULT_ENGINE_ID) {
    settings.releaseFolder = folder;
    settings.installedVersion = version;
  } else {
    settings.engines = { ...(settings.engines || {}), [id]: { folder, version } };
  }
}

const normFolder = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
// The release root can be a folder nested inside the managed one (a zip with a top-level folder).
const insideFolder = (p, root) => normFolder(p) === normFolder(root) || normFolder(p).startsWith(normFolder(root) + '\\');

// Settings written by a build that is no longer shipped, or a release folder that is not the app's
// own (the hand-set folder, gone since v1.64.0). A choice naming a build this app still has is left
// alone -- while the Pre-SR build was gone this cleared them all, and re-adding it without narrowing
// this would silently throw the choice away on the next launch.
async function migrateEngineSettings(bundled) {
  let changed = false;
  const known = (id) => Object.prototype.hasOwnProperty.call(ENGINE_LABELS, id);
  if (settings.engine && !known(settings.engine)) { settings.engine = DEFAULT_ENGINE_ID; changed = true; }
  for (const id of Object.keys(settings.engines || {})) {
    if (!known(id)) { delete settings.engines[id]; changed = true; }
  }
  const managed = bundled && bundled.managedFolder;
  if (managed && settings.releaseFolder && !insideFolder(settings.releaseFolder, managed)) {
    settings.releaseFolder = '';
    settings.installedVersion = '';
    changed = true;
  }
  if (changed) await window.api.saveSettings(settings);
  let gamesChanged = false;
  for (const game of games) {
    if (game.engine && !known(game.engine)) { delete game.engine; gamesChanged = true; }
  }
  if (gamesChanged) window.api.saveGames(games);
}

// Makes sure the build is on disk: a valid folder is enough; otherwise its latest GitHub release is
// fetched into the managed folder. Returns { ok } or { ok: false, error }.
// One in-flight fetch per build, so choosing the second one does not cancel the first's.
const engineFetches = new Map();
async function ensureEngine(id = DEFAULT_ENGINE_ID) {
  id = engineIdOrDefault(id);
  const folder = engineFolder(id);
  if (folder && (await window.api.validateRelease(folder)).valid) return { ok: true };
  if (!engineFetches.has(id)) {
    engineFetches.set(id, (async () => {
      const res = await window.api.checkUpdate(id);
      if (!res.ok) return { ok: false, error: res.error };
      toast(t('Fetching {engine} {tag}…', { engine: engineLabel(id), tag: res.tag }));
      const installRes = await window.api.installUpdate({ downloadUrl: res.downloadUrl, assetName: res.assetName, tag: res.tag, engine: id, sha256Url: res.sha256Url, sha256: res.sha256 });
      if (!installRes.ok) return { ok: false, error: installRes.error };
      setEngineState(id, installRes.folder, res.tag);
      await window.api.saveSettings(settings);
      refreshBannerVisibility();
      toast(t('Fetched {engine} {tag}.', { engine: engineLabel(id), tag: res.tag }));
      return { ok: true };
    })().finally(() => { engineFetches.delete(id); }));
  }
  return engineFetches.get(id);
}

// The installer carries the engine zip it was released with. Extract it whenever there is no
// usable engine yet, or the one on disk is older than the bundle -- no network involved, so a
// fresh install works offline and never waits on GitHub. The online check still runs afterwards
// for anything newer.
async function ensureBundledEngine() {
  const bundled = await window.api.bundledEngine();
  await migrateEngineSettings(bundled);
  if (!bundled || !bundled.tag) return false;
  const releaseValid = !!settings.releaseFolder && (await window.api.validateRelease(settings.releaseFolder)).valid;
  if (releaseValid && settings.installedVersion && compareTags(settings.installedVersion, bundled.tag) >= 0) return false;

  const res = await window.api.installUpdate({ localZip: bundled.zipPath, tag: bundled.tag });
  if (!res.ok) {
    toast(t('Could not set up the bundled OptiScaler engine: {error}', { error: res.error }));
    return false;
  }
  settings.releaseFolder = res.folder;
  settings.installedVersion = bundled.tag;
  await window.api.saveSettings(settings);
  refreshBannerVisibility();
  toast(t('OptiScaler engine {tag} set up from the installer -- nothing to download.', { tag: bundled.tag }));
  return true;
}

// The NR model used to be the one file people had to dig out of an NVIDIA driver archive by
// hand. RHI publishes it, so fetch it unless a valid copy is already set.
async function ensureNrModel({ force = false } = {}) {
  if (!force && settings.nrDllPath && (await window.api.validateNrDll(settings.nrDllPath)).valid) {
    // A model this app fetched carries its manifest version in the cache file name; a user's own
    // copy from elsewhere does not and is left alone. Only a different published build refetches.
    const own = /[\\/]nvngx_dlssnr_[^\\/]+\.dll$/i.exec(settings.nrDllPath);
    let latest = null;
    try { latest = await window.api.nrModelLatest(); } catch {}
    if (!(own && latest && latest.ok && latest.cacheFile && !settings.nrDllPath.toLowerCase().endsWith(latest.cacheFile.toLowerCase()))) return false;
    toast(t('A newer DLSS NR model ({version}) is published -- fetching it…', { version: latest.version }));
  } else {
    toast(t('Fetching the DLSS NR model file (about 165 MB)…'));
  }
  const res = await window.api.autoFetchNrDll();
  if (!res.ok) {
    toast(t('Could not fetch the DLSS NR model automatically: {error}', { error: res.error }));
    return false;
  }
  settings.nrDllPath = res.path;
  await window.api.saveSettings(settings);
  $('#settings-nr-dll').value = res.path;
  checkNrDllStatus();
  refreshBannerVisibility();
  toast(t('DLSS NR model {version} fetched ({mb} MB).', { version: res.version, mb: res.sizeMB }));
  return true;
}

// The Manager's own update, as pushed by main.js (src/manager-update.js). The player decides
// (2026-09-25): the banner says a new version is there and offers Download; once it is on disk,
// Restart installs it. Nothing downloads or installs on its own, and "Not now" hides the banner
// for that version until the next launch.
let managerUpdateDismissed = null;
function renderManagerUpdate(state) {
  const banner = $('#manager-update-banner');
  const text = $('#manager-update-banner-text');
  const restartBtn = $('#btn-manager-restart');
  const downloadBtn = $('#btn-manager-download');
  const dismissBtn = $('#btn-manager-dismiss');
  downloadBtn.classList.add('hidden');
  dismissBtn.classList.add('hidden');
  if (!state || !state.supported) { banner.classList.add('hidden'); return; }
  if (state.phase === 'available') {
    if (managerUpdateDismissed === state.version) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    restartBtn.classList.add('hidden');
    downloadBtn.classList.remove('hidden');
    downloadBtn.disabled = false;
    dismissBtn.classList.remove('hidden');
    text.textContent = t('Manager v{version} is available.', { version: state.version || '?' });
  } else if (state.phase === 'downloading') {
    banner.classList.remove('hidden');
    restartBtn.classList.add('hidden');
    text.textContent = t('Downloading Manager v{version}… {percent}%', { version: state.version || '?', percent: state.percent || 0 });
  } else if (state.phase === 'downloaded') {
    banner.classList.remove('hidden');
    restartBtn.classList.remove('hidden');
    text.textContent = t('Manager v{version} is ready -- restart to update.', { version: state.version || '?' });
  } else {
    banner.classList.add('hidden');
  }
}

$('#btn-manager-download').addEventListener('click', async () => {
  $('#btn-manager-download').disabled = true;
  renderManagerUpdate(await window.api.managerUpdateDownload());
});
$('#btn-manager-dismiss').addEventListener('click', async () => {
  const st = await window.api.managerUpdateState();
  managerUpdateDismissed = st && st.version;
  $('#manager-update-banner').classList.add('hidden');
});

$('#btn-manager-restart').addEventListener('click', async () => {
  $('#btn-manager-restart').disabled = true;
  const ok = await window.api.managerUpdateRestart();
  if (!ok) { $('#btn-manager-restart').disabled = false; toast(t('The update is not ready yet.')); }
});

// Checks GitHub for a newer engine and installs it. Returns { ok, updated, tag } or
// { ok: false, error }. Shared by the launch/6-hour check and the top bar's Check for Updates.
// Every build worth checking: the default one always (it is bundled, so it is always on disk) and any
// other that has a folder here. A build nobody chose is never fetched just to check it for updates.
function enginesInUse() {
  return Object.keys(ENGINE_LABELS).filter((id) => id === DEFAULT_ENGINE_ID || !!engineFolder(id));
}

async function updateEngineIfNewer(id = DEFAULT_ENGINE_ID) {
  id = engineIdOrDefault(id);
  const res = await window.api.checkUpdate(id);
  if (!res.ok) return { ok: false, engine: id, error: res.error };
  const installed = engineVersion(id);
  // Never step backwards from the bundled engine because GitHub's "latest" lags behind it. The
  // offer is the engine this app version was tested with; a newer one is only mentioned.
  if (installed && compareTags(installed, res.tag) >= 0) return { ok: true, engine: id, updated: false, tag: installed, newerUntested: res.newerUntested };
  const hadRelease = !!engineFolder(id);
  const installRes = await window.api.installUpdate({
    downloadUrl: res.downloadUrl,
    assetName: res.assetName,
    tag: res.tag,
    engine: id,
    sha256Url: res.sha256Url,
    sha256: res.sha256,
  });
  if (!installRes.ok) return { ok: false, engine: id, error: installRes.error, tag: res.tag };
  setEngineState(id, installRes.folder, res.tag);
  await window.api.saveSettings(settings);
  refreshBannerVisibility();
  autoSyncStaleGames();
  return { ok: true, engine: id, updated: true, hadRelease, tag: res.tag, newerUntested: res.newerUntested };
}

// Sequential, not Promise.all: two builds updating at once would both write settings.json and race
// each other's engine state, and one download at a time is kinder to a slow connection anyway.
async function autoUpdateOptiScalerRelease() {
  for (const id of enginesInUse()) {
    const res = await updateEngineIfNewer(id);
    if (!res.ok) {
      if (res.tag) toast(t('Auto-update to {tag} failed: {error}', { tag: res.tag, error: res.error }));
      continue;
    }
    if (!res.updated) continue;
    toast(res.hadRelease
      ? t('{engine} auto-updated to {tag}.', { engine: engineLabel(id), tag: res.tag })
      : t('Fetched {engine} {tag} automatically.', { engine: engineLabel(id), tag: res.tag }));
  }
}
$('#btn-clean-folder').addEventListener('click', async () => {
  const statusEl = $('#clean-folder-status');
  const folder = await window.api.pickFolder(t('Select the game\'s exe folder to clean'));
  if (!folder) return;
  statusEl.className = 'status-line';
  statusEl.textContent = t('Cleaning…');
  const res = await window.api.cleanFolder(folder);
  if (!res.ok) { statusEl.className = 'status-line status-bad'; statusEl.textContent = t("Couldn't remove OptiScaler: {error}", { error: res.error }); return; }
  if (res.cancelled) { statusEl.textContent = ''; return; }
  const removed = [...(res.removed || []), ...((res.foreign && res.foreign.removed) || [])];
  const restored = [...(res.restored || []), ...((res.foreign && res.foreign.restored) || [])];
  const parts = [t('Cleaned {folder}.', { folder: res.folder })];
  parts.push(removed.length ? t('Removed: {list}.', { list: removed.join(', ') }) : t('Nothing left to remove.'));
  if (restored.length) parts.push(t('Restored: {list}.', { list: restored.join(', ') }));
  if ((res.kept || []).length) parts.push(t('Left alone: {list}.', { list: res.kept.join('; ') }));
  statusEl.className = 'status-line status-ok';
  statusEl.textContent = parts.join(' ');
  toast(parts.slice(0, 2).join(' '));
});

// Top bar: one button checks and updates everything the app keeps current by itself -- the engine,
// the NR model and the Manager. Nothing to choose: whatever is newer is installed (the Manager
// downloads in the background and asks for a restart through its banner).
const DISCORD_INVITE = 'https://discord.gg/HFZTDdSNmJ';
$('#btn-discord').addEventListener('click', () => window.api.openExternal(DISCORD_INVITE));

// Beside Discord in the top bar. main.js allowlists this URL the same way it does the other two it
// is willing to open -- openExternal refuses anything not on that list.
const BUY_ME_A_COFFEE = 'https://buymeacoffee.com/ripplingsnake';
$('#btn-coffee').addEventListener('click', () => window.api.openExternal(BUY_ME_A_COFFEE));

$('#btn-check-updates').addEventListener('click', async () => {
  const btn = $('#btn-check-updates');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('Checking…');
  const lines = [];
  // Asked for by a person: see what GitHub has right now, not what was remembered minutes ago.
  try { await window.api.githubGoLive(); } catch {}
  try {
    // Every build in use, not just the default: a game left on the Pre-SR build was never offered its
    // newer releases before this. One await for the whole sweep so the manager check runs alongside it.
    const [managerRes, engineResults] = await Promise.all([
      window.api.checkManagerUpdate().catch((e) => ({ ok: false, error: String(e && e.message || e) })),
      (async () => {
        const out = [];
        for (const id of enginesInUse()) {
          out.push(await updateEngineIfNewer(id).catch((e) => ({ ok: false, engine: id, error: String(e && e.message || e) })));
        }
        return out;
      })(),
    ]);

    for (const engineRes of engineResults) {
      const name = engineLabel(engineRes.engine);
      if (!engineRes.ok) lines.push(t('{engine} update failed: {error}', { engine: name, error: engineRes.error }));
      else if (engineRes.updated) lines.push(t('{engine} updated to {tag}.', { engine: name, tag: engineRes.tag }));
      else lines.push(t('{engine} up to date ({tag}).', { engine: name, tag: engineRes.tag || '?' }));
      if (engineRes.ok && engineRes.newerUntested) {
        lines.push(t('{engine} {tag} is out, but this app version was not tested with it -- it comes with the next app update.', { engine: name, tag: engineRes.newerUntested }));
      }
    }

    // Toasts for itself when it fetches; a newer model reaches the games through the sync.
    ensureNrModel().then((fetched) => { if (fetched) autoSyncStaleGames(); }).catch(() => {});

    if (!managerRes.ok) {
      lines.push(t('Manager check failed: {error}', { error: managerRes.error }));
    } else if (managerRes.upToDate) {
      lines.push(t('Manager up to date (v{version}).', { version: managerRes.currentVersion }));
    } else {
      const st = await window.api.managerUpdateState();
      if (st.supported) {
        // Found, not fetched: the banner offers Download (the player decides, 2026-09-25).
        managerUpdateDismissed = null;
        renderManagerUpdate(await window.api.managerUpdateCheck());
        lines.push(t('Manager v{version} is available -- press Download update in the banner at the top.', { version: managerRes.latestVersion }));
      } else {
        // Say WHY it did not just download it. The reason was sitting in the state and being thrown
        // away at the one moment someone is stood in front of the app wondering what changed -- so
        // the same behaviour on the portable build and on the installer looked like a regression,
        // and got reported as one. The reason comes from the main process, so it is passed through
        // t() as a value rather than a literal, the way the game status line at the top of this
        // file already does.
        await window.api.openManagerReleasePage();
        lines.push(t('Opened the release page for {version} -- install it and relaunch.', { version: managerRes.latestVersion }));
        if (st.reason) lines.push(t('It could not update itself: {reason}.', { reason: t(st.reason) }));
      }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
  toast(lines.join(' '));
});
const scanModal = $('#scan-modal');
let scanResults = [];
let scanSelections = {};

function openScanModal() {
  scanResults = [];
  scanSelections = {};
  $('#scan-results').innerHTML = '';
  $('#scan-status').textContent = '';
  $('#scan-status').className = 'status-line';
  $('#btn-add-scanned').classList.add('hidden');
  $('#scan-drives').checked = false;
  scanModal.classList.remove('hidden');
}

function closeScanModal() {
  scanModal.classList.add('hidden');
}

$('#btn-scan-games').addEventListener('click', openScanModal);
$('#btn-cancel-scan').addEventListener('click', closeScanModal);

$('#btn-run-scan').addEventListener('click', async () => {
  const btn = $('#btn-run-scan');
  const statusEl = $('#scan-status');
  const resultsEl = $('#scan-results');
  const scanDrives = $('#scan-drives').checked;

  btn.disabled = true;
  statusEl.className = 'status-line';
  statusEl.textContent = scanDrives ? t('Scanning every drive -- this can take a while…') : t('Scanning…');
  resultsEl.innerHTML = '';
  $('#btn-add-scanned').classList.add('hidden');

  const res = await window.api.scanLibrary({
    scanDrives,
    knownExePaths: games.map((g) => g.exePath)
  });

  btn.disabled = false;

  if (!res.ok) {
    statusEl.className = 'status-line status-bad';
    statusEl.textContent = t('Scan failed: {error}', { error: res.error });
    return;
  }

  scanResults = res.games || [];
  scanSelections = {};
  scanResults.forEach((g, i) => { scanSelections[i] = g.exePath; });

  if (scanResults.length === 0) {
    statusEl.className = 'status-line';
    statusEl.textContent = t('No new games found.');
    return;
  }

  statusEl.className = 'status-line status-ok';
  statusEl.textContent = scanResults.length > 1 ? t('Found {count} games.', { count: scanResults.length }) : t('Found 1 game.');

  scanResults.forEach((game, i) => {
    const row = document.createElement('div');
    row.className = 'scan-result-row';

    const altOptions = [game.exePath, ...(game.alternatives || [])];
    const altSelect = altOptions.length > 1
      ? `<select class="scan-result-alt">${altOptions.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}</select>`
      : '';

    row.innerHTML = `
      <input type="checkbox" checked />
      <div class="scan-result-info">
        <div class="scan-result-name">${escapeHtml(game.name)}</div>
        <div class="scan-result-source">${escapeHtml(game.launcher)}</div>
        <div class="scan-result-path">${escapeHtml(game.exePath)}</div>
        ${altOptions.length > 1 ? `<p class="field-hint" style="margin: 4px 0 0;">${escapeHtml(t('Picked wrong exe? Choose another below.'))}</p>` : ''}
        ${altSelect}
      </div>
    `;

    const pathEl = row.querySelector('.scan-result-path');
    const altSelectEl = row.querySelector('.scan-result-alt');
    if (altSelectEl) {
      altSelectEl.addEventListener('change', (e) => {
        scanSelections[i] = e.target.value;
        pathEl.textContent = e.target.value;
      });
    }

    const checkboxEl = row.querySelector('input[type="checkbox"]');
    checkboxEl.addEventListener('change', () => {
      row.style.opacity = checkboxEl.checked ? '1' : '0.5';
    });
    row.dataset.index = String(i);

    resultsEl.appendChild(row);
  });

  $('#btn-add-scanned').classList.remove('hidden');
});

$('#btn-add-scanned').addEventListener('click', async () => {
  const rows = $('#scan-results').querySelectorAll('.scan-result-row');
  let added = 0;

  rows.forEach((row) => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox.checked) return;

    const i = Number(row.dataset.index);
    const game = scanResults[i];
    const exePath = scanSelections[i] || game.exePath;

    games.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      exePath,
      name: game.name,
      bannerAppId: game.bannerAppId || null,
      bannerLocalPath: null
    });
    added++;
  });

  if (added > 0) {
    await window.api.saveGames(games);
    toast(added > 1 ? t('Added {count} games.', { count: added }) : t('Added 1 game.'));
    renderGrid();
  }

  closeScanModal();
});

// A card's overflow menu closes on a click anywhere that is not itself. Delegated once rather than
// per card, so twenty cards do not mean twenty listeners on the document.
document.addEventListener('click', (e) => {
  const inside = e.target.closest && e.target.closest('.card-actions, .card-menu');
  for (const menu of document.querySelectorAll('.card-menu:not(.hidden)')) {
    if (inside && menu.closest('.card') === inside.closest('.card')) continue;
    menu.classList.add('hidden');
    menu.closest('.card')?.querySelector('.btn-card-menu')?.setAttribute('aria-expanded', 'false');
  }
});

// Field hints show one line (style.css); a click opens the rest. Delegated, because Edit builds
// many of its hints on the fly. A click on a link inside a hint is the link, not the toggle.
document.addEventListener('click', (e) => {
  const hint = e.target.closest && e.target.closest('.field-hint');
  if (!hint || e.target.closest('a')) return;
  hint.classList.toggle('open');
});

// Focus arrives for every native dialog the app opens and closes as well as for the user coming
// back to the window, and each one used to rebuild the whole grid on the spot. Coalesced, so
// clicking through a dialog costs one render instead of one per dialog.
let focusRenderTimer = null;
window.addEventListener('focus', () => {
  clearTimeout(focusRenderTimer);
  focusRenderTimer = setTimeout(() => { focusRenderTimer = null; renderGrid(); }, 250);
  // Back from the browser with the plugin downloaded: look for it again.
  if (!pdPluginModal.classList.contains('hidden')) refreshPdPluginModal();
});

(async function init() {
  const data = await window.api.loadData();
  games = data.games || [];
  settings = data.settings || { releaseFolder: '', nrDllPath: '', installedVersion: '' };
  applyLanguage();
  applyTheme();
  document.body.classList.toggle('show-advanced', !!settings.showAdvanced);
  try { gpu = (await window.api.gpuInfo()) || gpu; } catch {}
  // Vendor colours: the default green is NVIDIA's; an AMD card gets AMD red (style.css, body.vendor-amd).
  document.body.classList.toggle('vendor-amd', gpu.vendor === 'amd');
  refreshDriverBanner();
  // Before the first grid so the cards' panel hint already knows whether the pop-out hotkey works.
  try { const hk = await window.api.panelHotkeyState(); panelHotkeyRegistered = hk && !hk.disabled ? !!hk.ok : null; } catch {}
  await refreshBannerVisibility();
  await renderGrid();
  await ensureBundledEngine();
  await autoUpdateOptiScalerRelease();
  autoSyncStaleGames();
  // Both halves keep themselves current while the app stays open: the engine re-checks its
  // releases every few hours (same path as the launch check), and the Manager's own updater
  // reports through the banner.
  setInterval(() => autoUpdateOptiScalerRelease().catch(() => {}), 6 * 60 * 60 * 1000);
  setInterval(() => ensureNrModel().then((fetched) => { if (fetched) autoSyncStaleGames(); }).catch(() => {}), 6 * 60 * 60 * 1000);
  window.api.onManagerUpdate(renderManagerUpdate);
  renderManagerUpdate(await window.api.managerUpdateState());
  // Not awaited: a 165 MB download must not hold up the per-game sync that does not need it.
  // A newer model, once in, is pushed into every installed game by the same sync.
  ensureNrModel().then((fetched) => { if (fetched) autoSyncStaleGames(); }).catch(() => {});
})();

// ── ReShade add-ons ───────────────────────────────────────────────────────────────────────────
//
// One list per game. Every route this app installs already puts ReShade in the folder, so the
// expensive part is done and this is only choosing what goes beside it.
//
// Two kinds of row, and the difference is worth showing rather than hiding: a shader pack lands
// in reshade-shaders\Shaders and takes a place in the effect order (preset-order.js re-sorts the
// preset on every install and removal), while an add-on is a DLL ReShade loads and has no
// technique at all. People conflate the two -- "install the motion-vector shader before the HDR
// one" is a statement about the first kind, and RenoDX, the thing most people mean by an HDR mod,
// is the second.

let addonsGame = null;

async function openAddonsModal(game) {
  addonsGame = game;
  $('#addons-modal').classList.remove('hidden');
  $('#addons-list').innerHTML = `<p class="field-hint">${escapeHtml(t('Looking at this game…'))}</p>`;
  $('#addons-status').textContent = '';
  await renderAddons();
}

async function renderAddons() {
  // A rejected invoke (a reply Electron cannot send, say) must say so, not leave "Looking…" up.
  const res = await window.api.addonsForGame(addonsGame.exePath)
    .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
  if (!res || !res.ok) {
    $('#addons-list').innerHTML = `<p class="field-hint status-bad">${escapeHtml(res && res.error ? res.error : t('Could not read this game.'))}</p>`;
    return;
  }

  const rows = res.catalogue.map((a) => {
    // RenoDX is the one row that is not always available: it is per-game, and a game with no mod
    // built for it gets told that plainly rather than offered a button that fails.
    const perGame = a.id === 'renodx';
    const match = res.renodx;
    const unavailable = perGame && !match;

    const bits = [];
    bits.push(`<div class="addon-name">${escapeHtml(a.displayName)}</div>`);
    bits.push(`<div class="field-hint">${escapeHtml(a.summary)}</div>`);

    if (perGame && match) {
      const who = (match.maintainers || []).join(', ') || t('the RenoDX project');
      // An engine-wide mod is a different offer from a bespoke one and must not be dressed up as
      // the same thing: it was written for the engine, not for this game, and no bespoke mod exists.
      const byEngine = match.how === 'engine' || match.how === 'engine-supersedes';
      if (byEngine) {
        bits.push(`<div class="field-hint">${escapeHtml(t('No mod is built for this game, but RenoDX has one for its whole engine: {title}, maintained by {who}.', { title: match.title, who }))}</div>`);
        if (match.how === 'engine-supersedes') {
          bits.push(`<div class="field-hint">${escapeHtml(t('This game does have its own mod, and RenoDX marks it superseded by the engine-wide one -- so the engine-wide one is what installs here.'))}</div>`);
        }
        bits.push(`<div class="field-hint status-warn">${escapeHtml(t('Matched on the engine, not on this game. RenoDX rates it "{compat}" for the engine, but nobody here has run it on this title -- if the picture looks wrong, take it back off.', { compat: match.compatibility }))}</div>`);
      } else {
        bits.push(`<div class="field-hint">${escapeHtml(t('For this game: {title} ({status}), maintained by {who}.', {
          title: match.title, status: match.status, who,
        }))}</div>`);
        // How the match was made, because the two are not the same claim. An appid came from Steam;
        // a title match is this app deciding two names are the same game, and it can be wrong.
        if (match.how === 'title') {
          bits.push(`<div class="field-hint status-warn">${escapeHtml(t('Matched by name, not by a Steam ID -- check the title above is really this game before installing.'))}</div>`);
        }
      }
    }
    if (unavailable) {
      bits.push(`<div class="field-hint">${escapeHtml(res.indexError
        ? t('The RenoDX list could not be fetched: {reason}.', { reason: res.indexError })
        : t('No RenoDX mod is built for this game yet. RenoFX below is the generic alternative.'))}</div>`);
    }
    if (a.warnWithNeuralRendering && res.neuralRendering) {
      bits.push(`<div class="field-hint status-warn">${escapeHtml(t('This and DLSS 5 both change the final picture, and the two have not been tested together here. Worth trying; if colours look wrong, take this back off first.'))}</div>`);
    }
    // Which of the two releases this came from. It is the difference between the in-game HDR page
    // appearing and not, so it is said plainly rather than left to be discovered.
    if (a.id === 'renodx' && match && res.renodxSource) {
      bits.push(res.renodxSource.hostApi
        ? `<div class="field-hint">${escapeHtml(t('From our build, which is the one the in-game DLSS 5 panel can show these settings on -- look for the HDR page in the overlay.'))}</div>`
        : `<div class="field-hint">${escapeHtml(t('From RenoDX\'s own release. It works, but only through its own overlay: the DLSS 5 panel can only show these settings on our build.'))}</div>`);
    }
    if (a.wants && a.wants.length && !res.catalogue.find((x) => a.wants.includes(x.id) && x.installed)) {
      bits.push(`<div class="field-hint status-warn">${escapeHtml(t('Needs an inverse tonemapper to do anything -- install the Lilium HDR shaders too.'))}</div>`);
    }
    // A swap, said before it happens rather than discovered afterwards. The button stays live.
    if (!a.installed && (a.replaces || []).length) {
      const other = res.catalogue.find((x) => x.id === a.replaces[0]);
      bits.push(`<div class="field-hint status-warn">${escapeHtml(t('Installing this replaces {other} -- both are ways of getting an HDR signal and only one can run. You can swap back any time.', { other: other ? other.displayName : a.replaces[0] }))}</div>`);
    }
    // The pack everyone assumes conflicts with RenoDX, and does not -- but half of it becomes
    // redundant, and saying which half is the difference between a useful pack and a wrong picture.
    if (a.id === 'lilium-hdr' && res.catalogue.find((x) => x.id === 'renodx' && x.installed)) {
      bits.push(`<div class="field-hint">${escapeHtml(t('RenoDX already gives this game native HDR, so leave this pack\'s inverse tonemapper switched off in ReShade. Its analysis shaders and its final tone mapping are still worth having -- that is what keeps highlights inside what your display can show.'))}</div>`);
    }
    // An ADD-ON brings its own host: the installer deploys ReShade's Add-on build, promotes it to the
    // game's proxy where nothing else would load it, and writes LoadReshade -- the same function frame
    // pacing goes through. So for those rows a missing or plain ReShade is a note about what is about
    // to be installed, not a refusal.
    //
    // A shader pack gets none of that: .fx files need a ReShade that is already there to load them,
    // so the refusal stands. Never on an installed row either way -- taking something back out does
    // not need ReShade, and a Remove that refused would trap the files in the folder.
    const bringsItsOwnReShade = a.kind === 'addon';
    if (a.blocker === 'no-reshade') {
      bits.push(bringsItsOwnReShade
        ? `<div class="field-hint">${escapeHtml(t('This game has no ReShade yet. Installing this puts ReShade\'s Add-on build in with it, the same way frame pacing does.'))}</div>`
        : `<div class="field-hint status-bad">${escapeHtml(t('This game has no ReShade, so nothing here can load. Install DLSS 5 or frame pacing on this game and ReShade comes with it, or put your own copy in the folder.'))}</div>`);
    } else if (a.blocker === 'plain-reshade') {
      bits.push(bringsItsOwnReShade
        ? `<div class="field-hint">${escapeHtml(t('The ReShade here is the plain build, which never loads an add-on. Installing this replaces it with the Add-on build.'))}</div>`
        : `<div class="field-hint status-bad">${escapeHtml(t('The ReShade here is the plain build, which never loads an add-on -- it carries the same version and name as the Add-on build, so this is not something you can see in the folder. The shader packs below still work.'))}</div>`);
    }
    const blocking = a.blocker && !bringsItsOwnReShade;
    bits.push(`<div class="field-hint">${escapeHtml(a.licence)} &middot; <a href="#" class="addon-home" data-url="${escapeHtml(a.homepage)}">${escapeHtml(t('project page'))}</a></div>`);

    const button = unavailable
      ? `<button class="btn btn-ghost" disabled>${escapeHtml(t('Not for this game'))}</button>`
      : blocking
        ? `<button class="btn btn-ghost" disabled>${escapeHtml(a.blocker === 'plain-reshade' ? t('Needs the Add-on build') : t('Needs ReShade'))}</button>`
        : `<button class="btn ${a.installed ? 'btn-ghost btn-danger' : 'btn-primary'} addon-act" data-id="${escapeHtml(a.id)}" data-installed="${a.installed ? '1' : ''}">${escapeHtml(a.installed ? t('Remove') : t('Install'))}</button>`;

    return `<div class="addon-row"><div class="addon-body">${bits.join('')}</div><div class="addon-action">${button}</div></div>`;
  });

  // The motion-vector providers, listed in the same place for the same reason: this is where
  // someone looks. Read-only here -- the Feeder deploy owns which one is in place, so changing it
  // is Settings' job -- but at least the list of what exists, and which one this game is on, is
  // no longer behind a dialog you have to know about.
  const mv = res.mvProviders || [];
  const current = mv.find((p) => p.id === res.mvProviderId);
  const mvRows = mv.map((p) => {
    const here = p.id === res.mvProviderId;
    const marks = [];
    if (p.isDefault) marks.push(t('default'));
    if (p.recommended) marks.push(t('recommended by the Feeder'));
    if (p.bringYourOwn) marks.push(t('your own copy -- its licence forbids us fetching it'));
    // One press per provider. The differences between these are in how each handles flames,
    // transparents and fast pans -- nobody can tell you which is best on your game, you look.
    // That is only worth offering if trying the next one is cheap, so the button switches it in
    // place rather than sending anyone back through a deploy.
    const button = here
      ? `<span class="addon-mv-here">${escapeHtml(t('in use'))}</span>`
      : `<button class="btn btn-ghost addon-mv-pick" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.displayName)}">${escapeHtml(t('Use this'))}</button>`;
    return `<li class="addon-mv-item"><div><span class="${here ? 'addon-mv-name-here' : ''}">${escapeHtml(p.displayName)}</span>${marks.length ? ` <span class="field-hint">&mdash; ${escapeHtml(marks.join(', '))}</span>` : ''}</div>${button}</li>`;
  }).join('');
  // Only a Feeder game has a provider to pick. A game on native DLSS (Shadow of the Tomb Raider)
  // hands DLSS its own vectors, so a row of dead "Use this" buttons there offered a choice that
  // does not exist -- the section is left out instead.
  const mvBlock = mv.length && current ? `
    <div class="addon-row"><div class="addon-body">
      <div class="addon-name">${escapeHtml(t('Motion vectors'))}</div>
      <div class="field-hint">${escapeHtml(t('DLSS 5 needs to know how things are moving, and that comes from one of these. They differ most on flames, glass and fast pans -- if a game looks wrong in motion, try the next one.'))}</div>
      <ul class="addon-mv-list">${mvRows}</ul>
    </div></div>` : '';

  $('#addons-list').innerHTML = mvBlock + rows.join('');
  for (const el of $('#addons-list').querySelectorAll('.addon-mv-pick')) {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const spec = mv.find((p) => p.id === id) || {};
      // The two providers whose licence needs real per-action consent get the same native dialog
      // the deploy uses. deployLumeniteFx refuses without it regardless, so skipping it here
      // cannot turn into a silent fetch -- this is what gets the answer, not what enforces it.
      let licenseConfirmed = false;
      if (/AGNYA/.test(spec.license || '')) {
        licenseConfirmed = await window.api.feederConfirmProviderLicense(id);
        if (!licenseConfirmed) return;
      }
      el.disabled = true;
      $('#addons-status').className = 'field-hint';
      $('#addons-status').textContent = t('Switching to {name}…', { name: el.dataset.name });
      const out = await window.api.addonsSetMvProvider(addonsGame.exePath, id, { licenseConfirmed });
      if (out && out.ok) {
        $('#addons-status').textContent = t('Motion vectors now come from {name}. Launch the game and see how it looks.', { name: el.dataset.name });
      } else {
        $('#addons-status').className = 'field-hint status-bad';
        $('#addons-status').textContent = (out && out.error) || t('That did not work.');
      }
      await renderAddons();
    });
  }

  for (const el of $('#addons-list').querySelectorAll('.addon-home')) {
    el.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(el.dataset.url); });
  }
  for (const el of $('#addons-list').querySelectorAll('.addon-act')) {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const removing = !!el.dataset.installed;
      el.disabled = true;
      $('#addons-status').className = 'field-hint';
      $('#addons-status').textContent = removing ? t('Removing…') : t('Fetching and placing…');
      const out = removing
        ? await window.api.addonsRemove(addonsGame.exePath, id)
        : await window.api.addonsInstall(addonsGame.exePath, id);
      if (out && out.ok) {
        const swapped = (out.swappedOut || []).map((sid) => {
          const s2 = res.catalogue.find((x) => x.id === sid);
          return s2 ? s2.displayName : sid;
        });
        $('#addons-status').textContent = removing
          ? t('Removed. {count} files taken back out.', { count: (out.removed || []).length })
          : swapped.length
            ? t('Installed, replacing {other}. {count} files placed, and the effect order was rewritten.', { other: swapped.join(', '), count: (out.files || []).length })
            : t('Installed. {count} files placed, and the effect order was rewritten.', { count: (out.files || []).length });
      } else {
        $('#addons-status').className = 'field-hint status-bad';
        // The refusals shared with frame pacing (ensureReShadeAddonHost) arrive worded for pacing, so the
        // ones with a code are said here about the add-on actually being installed.
        const spec = res.catalogue.find((x) => x.id === id);
        const name = (spec && spec.displayName) || id;
        const byCode = {
          'reshade-dlss-crash': t('{name} needs a newer DLSS 5 engine on this game: update DLSS 5 here first.', { name }),
          'optifg-armed': t('{name} can’t run beside frame generation on this game: switch frame generation off in Edit first, or to XeFG once DLSS 5 here is up to date.', { name }),
          'bitness-32': t('{name} needs a 64-bit game. This one is 32-bit.', { name }),
          'vulkan-layer': t('{name} on a Vulkan game needs ReShade’s own setup run for this game first.', { name }),
        };
        $('#addons-status').textContent = (out && byCode[out.code]) || (out && out.error) || t('That did not work.');
      }
      await renderAddons();
    });
  }
}

$('#btn-close-addons')?.addEventListener('click', () => {
  $('#addons-modal').classList.add('hidden');
  addonsGame = null;
});
