let games = [];
// The store-search version this build carries, asked of the main process once (see steam:searchVersion).
let bannerSearchVersion = 1;
let bannerSearchVersionLoaded = false;
let settings = { releaseFolder: '', nrDllPath: '', installedVersion: '', streamlineVersion: 'latest', engine: 'dlssnr', engines: {} };
let editingGameId = null;
let pendingBanner = { appid: null, localPath: null };
// One entry per engine build with a newer release than what is installed (see checkUpdate).
let pendingUpdates = [];
let pendingManagerUpdate = null;
// Filled in at init from gpu:info (see gpu.js). 'unknown' behaves like NVIDIA -- the app's
// behaviour before detection existed.
let gpu = { vendor: 'unknown', name: null, driverVersion: null };

function gpuLabel() {
  const vendorName = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[gpu.vendor] || t('Unknown vendor');
  const name = gpu.name || vendorName;
  return gpu.driverVersion ? t('{name} (driver {version})', { name, version: gpu.driverVersion }) : name;
}

const $ = (sel) => document.querySelector(sel);

const grid = $('#game-grid');
const emptyState = $('#empty-state');
const settingsBanner = $('#settings-banner');

// One floating tip for every [data-tip] element. Positioned above the element, centred on it,
// flipped below when there is no room above, and kept inside the viewport either way.
let tipEl = null;
function showTip(target) {
  const text = target.getAttribute('data-tip');
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

// renderGrid awaits per card, and is re-entered from window focus, settings close and
// install/uninstall completions -- two overlapping runs would each append their own set of cards.
// The newest run wins; older ones stop at their next await.
let renderGeneration = 0;

async function renderGrid() {
  if (!bannerSearchVersionLoaded) {
    try { bannerSearchVersion = (await window.api.steamSearchVersion()) || 1; } catch {}
    bannerSearchVersionLoaded = true;
  }
  const generation = ++renderGeneration;
  grid.innerHTML = '';
  emptyState.classList.toggle('hidden', games.length > 0);
  grid.classList.toggle('hidden', games.length === 0);

  for (const game of games) {
    const status = await window.api.gameStatus(game.exePath);
    if (generation !== renderGeneration) return;
    const card = document.createElement('div');
    card.className = 'card';

    const backends = status.backends || { optiscaler: false };
    let badgeClass = 'badge-none';
    let badgeText = t('Not installed');
    if (status.exeMissing) {
      badgeClass = 'badge-missing';
      badgeText = t('Exe missing');
    } else if (backends.optiscaler) {
      badgeClass = 'badge-installed';
      badgeText = status.engine === 'presr' ? 'OptiScaler Pre-SR' : 'OptiScaler';
    } else if (status.hasIni || (status.hasNr && gpu.vendor !== 'amd')) {
      // On an AMD card a lone nvngx_dlssnr.dll is the DLSS-NR-on-AMD layout, not a half-done
      // OptiScaler install -- the route chip carries that state; this badge stays "Not installed".
      badgeClass = 'badge-partial';
      badgeText = status.hasNr ? t('Missing OptiScaler files') : t('Missing NR file');
    }

    card.innerHTML = `
      <div class="card-flipper">
      <div class="card-face card-face-front">
      <div class="card-banner-wrap">
        <img class="card-banner hidden" alt="${escapeHtml(game.name)}" />
        <span class="card-banner-fallback hidden"></span>
        <span class="card-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(game.name)}</div>
        <div class="card-path card-recommend" title="${escapeHtml(t('Which install path suits this game'))}">${escapeHtml(t('Checking graphics API…'))}</div>
        <div class="card-warning card-route-next hidden"></div>
        <div class="card-warning card-detect-warning hidden"></div>
        <div class="card-path card-lastrun hidden"></div>
        <div class="card-help hidden"><span class="card-help-text"></span><button class="btn btn-small btn-primary btn-card-fix hidden"></button></div>
        ${(status.warnings || []).map((w) => `<div class="card-warning" title="${escapeHtml(t(w.message, w.vars))}">⚠ ${escapeHtml(t(w.message, w.vars))}</div>`).join('')}
        ${(status.foreign || []).length ? `<button class="btn btn-danger btn-small btn-remove-foreign" style="margin: 2px 0 6px;">${escapeHtml(t('Remove the other DLSS 5 toolchain…'))}</button>` : ''}
        <div class="card-actions">
          <button class="btn ${backends.optiscaler || (backends.leftovers || []).length ? 'btn-danger' : 'btn-primary'} btn-install">${escapeHtml(backends.optiscaler ? t('Remove OptiScaler') : (backends.leftovers || []).length ? t('Remove leftovers') : t('Install OptiScaler'))}</button>
          <button class="btn btn-launch" title="${escapeHtml(t('Runs the game from its own folder -- for an Unreal game, the -Win64-Shipping.exe that OptiScaler is installed beside.'))}">&#9654; ${escapeHtml(t('Launch'))}</button>
        </div>
        <div class="card-actions-row2">
          <button class="btn btn-ghost btn-open">${escapeHtml(t('Open Folder'))}</button>
          <button class="btn btn-ghost btn-edit">${escapeHtml(t('Edit'))}</button>
          <button class="btn btn-ghost btn-help has-tip" data-tip="${escapeHtml(t('Checks this game\'s setup and its last run, applies the fix when the app has one, tells you plainly when DLSS 5 is not available here, and can save a bundle to share or ask an AI.'))}">${escapeHtml(t('Game Help'))}</button>
          <button class="btn btn-ghost btn-danger btn-remove">${escapeHtml(t('Remove'))}</button>
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
      </div>
      </div>
    `;

    setBannerWithFallback(game, card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback'));
    const bannerEls = () => [card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback')];
    const applyResolved = async (found) => {
      const localPath = await window.api.cacheSteamBanner(found.appid, found.tinyImage);
      game.bannerAppId = String(found.appid);
      game.bannerLocalPath = localPath || null;
      window.api.saveGames(games);
      setBannerWithFallback(game, ...bannerEls());
    };
    const autoFound = !!game.bannerSearchAttempted;
    const staleSearch = (game.bannerSearchVersion || 1) < bannerSearchVersion;
    if (game.bannerAppId && autoFound && staleSearch) {
      // Art an older search picked by name is checked once against the Steam manifest beside
      // the exe, which is exact: "re2" had been given Red Dead Redemption 2. Art the user chose
      // themselves was never auto-found, so it is never touched here.
      game.bannerSearchVersion = bannerSearchVersion;
      window.api.resolveBanner(game.exePath, game.name).then(async (found) => {
        if (found && found.source === 'steam-manifest' && String(found.appid) !== String(game.bannerAppId)) await applyResolved(found);
        else window.api.saveGames(games);
      });
    } else if (!game.bannerLocalPath && game.bannerAppId) {
      window.api.cacheSteamBanner(game.bannerAppId).then((localPath) => {
        if (localPath) {
          game.bannerLocalPath = localPath;
          window.api.saveGames(games);
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
        if (!found) {
          window.api.saveGames(games);
          return;
        }
        await applyResolved(found);
      });
    }

    card.querySelector('.btn-install').addEventListener('click', async () => {
      if (backends.optiscaler || (backends.leftovers || []).length) {
        // The exact list first: Remove never surprises anyone with what it took.
        const plan = await window.api.uninstallPlan(game.exePath);
        const clip = (arr) => (arr.length > 12 ? arr.slice(0, 12).join(', ') + ' \u2026(+' + (arr.length - 12) + ')' : arr.join(', '));
        const preview = plan && plan.ok
          ? ' ' + t('Will remove {count} item(s): {list}.', { count: plan.remove.length, list: clip(plan.remove) || t('nothing') }) +
            (plan.restore.length ? ' ' + t('Will restore: {list}.', { list: clip(plan.restore) }) : '') +
            (plan.kept.length ? ' ' + t('Left alone: {list}.', { list: plan.kept.join('; ') }) : '')
          : '';
        flipToConfirm(card, {
          title: t('Remove OptiScaler?'),
          detail: t('Removes everything this app put in the game folder -- OptiScaler, the Feeder or Luma UE, Streamline, REFramework, swapped DLLs, its markers -- and puts back anything it renamed or replaced. No terminal.') + preview,
          onConfirm: async () => {
            const res = await window.api.runUninstall(game.exePath);
            if (res.ok) await removeLosslessProfile(game);
            toast(res.ok ? describeUninstall(res) : t("Couldn't remove OptiScaler: {error}", { error: res.error }));
            renderGrid();
          }
        });
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
          title: t('Install OptiScaler on this GPU?'),
          detail: t('This is an {vendor} card: OptiScaler installs and its upscaler swap works, but its Neural Rendering will not run here (needs NVIDIA).', { vendor: gpu.vendor === 'amd' ? 'AMD' : 'Intel' }) +
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
    card.querySelector('.btn-help').addEventListener('click', () => openHelp(game));
    card.querySelector('.btn-launch').addEventListener('click', async () => {
      const res = await window.api.launchGame(game.exePath);
      if (!res.ok) { toast(t('Could not launch {name}: {error}', { name: game.name, error: res.error })); return; }
      toast(res.via === 'steam'
        ? t('Launching {name} through Steam.', { name: game.name })
        : t('Launched {name} ({exe}).', { name: game.name, exe: res.target.split(/[\\/]/).pop() }));
    });
    card.querySelector('.btn-open').addEventListener('click', () => window.api.openFolder(game.exePath));
    card.querySelector('.btn-edit').addEventListener('click', () => openGameModal(game));
    card.querySelector('.btn-remove').addEventListener('click', () => removeGame(game));
    card.querySelector('.btn-flip-cancel').addEventListener('click', () => card.classList.remove('flipped'));
    card.querySelector('.btn-flip-confirm').addEventListener('click', () => {
      card.classList.remove('flipped');
      card._onFlipConfirm?.();
    });

    applyRecommendation(game, card, backends);

    grid.appendChild(card);
  }
}
async function applyRecommendation(game, card, backends) {
  const line = card.querySelector('.card-recommend');
  const install = card.querySelector('.btn-install');
  let detected = game.detectedPath;

  // Re-detects when the cached result predates the current detection rules or was provisional.
  const fresh = await window.api.detectPathIfStale(game.exePath, detected);
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(detected)) {
    detected = fresh;
    game.detectedPath = fresh;
    window.api.saveGames(games);
  }
  detected = detected || fresh || { recommend: 'unknown', reason: t('not detected yet') };

  if (!line) return;
  const canRecommendInstall = !backends.optiscaler;
  const badgeClass = detected.recommend === 'unsupported' ? 'engine-badge-unsupported'
    : detected.recommend === 'optiscaler' ? 'engine-badge-known'
    : 'engine-badge-unknown';
  const title = escapeHtml(detected.reason);
  // The route tag: which stack this game should get (OptiScaler alone, + Feeder, + Luma UE), and
  // whether it is all there yet -- decided in main.js (route.js) from the folder and the cached
  // detection above, so the card answers "what do I click" before the Edit dialog ever opens.
  // It also carries the user's per-game API choice, which the API chip shows in place of the guess.
  const route = await window.api.gameRoute(game.exePath, detected);

  const engineText = detected.engine || (detected.apiBadge ? null : (detected.badge || t('Unknown')));
  const chips = [];
  if (engineText) chips.push(`<span class="engine-badge ${badgeClass}" title="${title}">${escapeHtml(engineText)}</span>`);
  if (route.apiOverride) {
    const chosenTitle = escapeHtml(t('Set to {api} in Edit (detection said {detected})', { api: API_LABEL[route.apiOverride], detected: detected.apiBadge || t('unknown') }));
    chips.push(`<span class="engine-badge api-badge engine-badge-known" title="${chosenTitle}">${API_LABEL[route.apiOverride]} \u2713</span>`);
  } else if (detected.apiBadge) {
    chips.push(`<span class="engine-badge api-badge ${badgeClass}" title="${title}">${escapeHtml(detected.apiBadge)}</span>`);
  }

  const routeClass = route.route === 'unsupported' ? 'route-badge-unsupported'
    : route.route === 'unknown' ? 'route-badge-unknown'
    : route.complete ? 'route-badge-done'
    : 'route-badge-todo';
  const routeText = route.complete ? `\u2713 ${t(route.label)}` : t(route.label);
  const routeTitle = escapeHtml(route.nextStep && route.optiInstalled ? `${t(route.reason, route.reasonVars)} ${t('Next: {step}.', { step: t(route.nextStep) })}` : t(route.reason, route.reasonVars));
  chips.push(`<span class="engine-badge route-badge ${routeClass}" title="${routeTitle}">${escapeHtml(routeText)}</span>`);
  // Emulators, 32-bit games and DirectX 8/9: routes built from the Feeder's documented paths but not
  // yet run on a live game here (emulators.js, legacy.js).
  if (route.experimental) {
    chips.push(`<span class="engine-badge engine-badge-experimental" title="${escapeHtml(t('Experimental: built from the DLSS5 Feeder\'s documented route for this kind of game, but not yet confirmed on a real one. It may not work, and depth or motion can be rough.'))}">${escapeHtml(t('Experimental'))}</span>`);
  }
  // Only a dated, human confirmation from the registry (src/verified-games.json) earns this.
  if (route.verified && route.verified.route === route.route) {
    chips.push(`<span class="engine-badge engine-badge-known" title="${escapeHtml(route.verified.notes || '')}">✓ ${escapeHtml(t('Verified {date}', { date: route.verified.verified }))}</span>`);
  }

  line.innerHTML = chips.join(' ');

  // What detection found beside the exe that the person should know before installing: none
  // of these block anything, all of them have bitten real installs.
  const detectWarnings = [];
  if (detected.antiCheat) detectWarnings.push(t('Anti-cheat present ({file}) -- OptiScaler is for single-player games; using it in a game that goes online risks a ban.', { file: detected.antiCheat }));
  // On the 32-bit route the ReShade beside the game is this app's own (legacy.js), not a conflict.
  if (detected.reshadeProxy && route.route !== 'feeder32') detectWarnings.push(t('ReShade is already installed here as {file}. Install replaces it with OptiScaler -- pick Launch mode: Injector in Edit to keep both.', { file: detected.reshadeProxy }));
  if (detected.oldShaderCompiler) detectWarnings.push(t('{file} v{version} beside the exe predates Shader Model 5.1, so OptiScaler\'s shaders can silently fail to compile -- rename it and Windows\' own copy loads instead.', { file: detected.oldShaderCompiler.file, version: detected.oldShaderCompiler.version }));
  const warnEl = card.querySelector('.card-detect-warning');
  if (warnEl) {
    warnEl.classList.toggle('hidden', detectWarnings.length === 0);
    warnEl.textContent = detectWarnings.map((w) => `\u26a0 ${w}`).join('  ');
    warnEl.title = detectWarnings.join('\n');
  }

  // OptiScaler is in but the rest of its route is not (a Feeder game installed before the
  // one-click flow existed, or Luma UE still waiting on its licence confirmation): say so on
  // the card, where the "OptiScaler" badge would otherwise read as finished.
  // What the last run's logs say, in one line -- the card answers "did it work" itself.
  const lastRunEl = card.querySelector('.card-lastrun');
  if (lastRunEl) {
    const run = await window.api.lastRun(game.exePath);
    if (run && run.ran) {
      lastRunEl.classList.remove('hidden');
      lastRunEl.classList.toggle('status-ok', run.verdict === 'nr-ran');
      lastRunEl.classList.toggle('status-bad', ['duplicate-dlss', 'shutdown-fault', 'ue-crash', 'feed-stopped'].includes(run.verdict));
      const when = new Date(run.at);
      const stamp = isNaN(when) ? '' : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      lastRunEl.textContent = t('Last run {when}: {verdict}', { when: stamp, verdict: describeRun(run) });
      lastRunEl.title = lastRunEl.textContent;
    } else {
      lastRunEl.classList.add('hidden');
    }
  }

  // Game Help on the card itself: one line saying what is wrong, and one button that fixes it.
  // Nobody reads a README; the card has to do the telling.
  const helpEl = card.querySelector('.card-help');
  if (helpEl) {
    const diag = await window.api.gameHelp(game.exePath, game.detectedPath || null, helpTriedFor(game));
    const show = diag && diag.ok && ['fix', 'step', 'unavailable', 'unknown'].includes(diag.status);
    helpEl.classList.toggle('hidden', !show);
    if (show) {
      helpEl.classList.toggle('status-bad', diag.status === 'unavailable' || diag.status === 'unknown');
      const text = helpEl.querySelector('.card-help-text');
      text.textContent = helpShort(diag);
      text.title = helpWords(diag);
      const btn = helpEl.querySelector('.btn-card-fix');
      btn.classList.remove('hidden');
      if (diag.status === 'fix') {
        btn.textContent = t('Fix it');
        btn.onclick = () => openHelp(game, { autoFix: true });
      } else if (diag.code === 'pd-plugin-missing') {
        // The one file the app cannot fetch: its own popup, which finds the download afterwards.
        btn.textContent = t('Get plugin');
        btn.onclick = () => openPdPluginModal();
      } else {
        btn.textContent = diag.status === 'step' ? t('Show me') : t('Help');
        btn.onclick = () => openHelp(game);
      }
    }
  }

  const nextEl = card.querySelector('.card-route-next');
  if (nextEl) {
    const showNext = route.optiInstalled && !route.complete && route.nextStep;
    nextEl.classList.toggle('hidden', !showNext);
    if (showNext) nextEl.textContent = `\u26a0 ${t('Next: {step}', { step: t(route.nextStep) })}`;
  }

  if (canRecommendInstall && route.route === 'feeder' && !route.feederDeployed) {
    install.textContent = t('Install OptiScaler + Feeder');
  } else if (canRecommendInstall && route.route === 'lumaue') {
    install.textContent = t('Install OptiScaler (then Luma UE)');
  }

  if (detected.recommend === 'unsupported' || route.route === 'unsupported') {
    install.classList.remove('btn-primary');
  } else if (canRecommendInstall) {
    install.classList.add('btn-primary');
  }
}
const API_LABEL = { dx12: 'DX12', dx11: 'DX11', vulkan: 'Vulkan', opengl: 'OpenGL' };

function flipToConfirm(card, { title, detail, onConfirm, confirmLabel = t('Remove'), danger = true }) {
  card.querySelector('.card-remove-title').textContent = title;
  card.querySelector('.card-remove-detail').textContent = detail;
  const confirmBtn = card.querySelector('.btn-flip-confirm');
  confirmBtn.textContent = confirmLabel;
  confirmBtn.classList.toggle('btn-danger', danger);
  confirmBtn.classList.toggle('btn-primary', !danger);
  card._onFlipConfirm = onConfirm;
  card.classList.add('flipped');
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

function helpWords(diag) {
  const v = diag.vars || {};
  switch (diag.code) {
    case 'bit32': return t('DLSS 5 is not currently available for this game: it is a 32-bit game, and OptiScaler and the NR model are 64-bit only.');
    case 'dgvoodoo-missing': return t('This DirectX 9 game needs dgVoodoo2 in front of it before the DLSS5 Feeder can work. Install puts it there, asking first -- antivirus flags its download, so the choice is yours.');
    case 'anticheat': return t('DLSS 5 is not currently available for this game: it runs under {antiCheat}, which blocks the DLL this app relies on. Using it there can also get an account banned.', v);
    case 'unsupported': return t('DLSS 5 is not currently available for this game: {reason}', v);
    case 'foreign': return t('Another DLSS 5 toolchain is in this folder ({tool}). Two stacks hooking the same DLSS call crash the game. Remove it first.', v);
    case 'feeder-misdeployed': return t('The DLSS5 Feeder is deployed on a game that ships its own DLSS. Two DLSS DLLs load and the game crashes. Remove the Feeder; OptiScaler alone is the route here.');
    case 'luma-known-bad': return t('Luma UE is deployed here, and this game is known not to work with it ({reason}). Remove Luma UE.', v);
    case 'not-installed': return t('OptiScaler is not installed on this game yet. Install it and the route\'s other steps follow.');
    case 'feeder-missing': return t('This game has no DLSS of its own, so OptiScaler alone has nothing to hook. Install deploys the DLSS5 Feeder first.');
    case 'luma-missing': return t('This game\'s route is Luma UE, which is not deployed yet. Open Edit and deploy Luma UE (its licence is confirmed there), then launch.');
    case 'reframework-missing': return t('This is an RE Engine game and REFramework is missing. OptiScaler does nothing there without it. Reconfigure fetches and places it.');
    case 'pd-build-missing': return t('This Resident Evil has no DLSS of its own, so it needs REFramework\'s pd-upscaler build and nvngx_dlss.dll beside the exe. Reconfigure fetches and places both.');
    case 'pd-plugin-missing': return t('One file this app cannot fetch: PureDark\'s Upscaler Base Plugin (PDPerfPlugin.dll), free on Nexus Mods. Download it once, then press "I downloaded it" -- the app finds it in Downloads and puts it in every Resident Evil that needs it. REFramework\'s upscaler loads it and makes the DLSS call OptiScaler hooks.');
    case 'pd-enable-ingame': return t('Everything is in place but the last run made no DLSS call. In-game, press Insert for REFramework\'s menu, open TemporalUpscaler, tick Enabled and set Upscale Type to DLSS. Then play a minute and quit.');
    case 'needs-run': return t('No run to judge yet. Launch the game, reach actual gameplay (not a menu), play a minute, then quit. Come back here and it is checked.');
    case 'needs-run-after-fix': return t('"{fix}" was applied. The old log still says what it said, so launch the game, reach gameplay, play a minute, quit, and this is checked again.', { fix: helpFixLabel(v.fix) });
    case 'ok': return t('DLSS 5 is working here: Neural Rendering ran {count} passes on the last run{fps}{api}.', { count: v.count, fps: v.fps ? t(' at {fps} fps', { fps: v.fps }) : '', api: v.api ? ' (' + v.api + ')' : '' });
    case 'ok-exit-crash': return t('Neural Rendering ran ({count} passes). The game crashed only on the way out, inside NVIDIA\'s shutdown, which does not affect play.', v);
    case 'd3d11-native': return t('DLSS was created on the native D3D11 path, so the Neural Rendering pass never ran. Dx11Upscaler must be dlss_12. Reconfigure writes it.');
    case 'nr-disabled': return t('DLSS ran but Neural Rendering is switched off in OptiScaler.ini. Reconfigure turns it on.');
    case 'dlss-no-nr': return t('DLSS was created and Neural Rendering is on, yet the pass never ran. This is not a known case. Save the bundle to share, or ask the AI.');
    case 'feeder-technique': return t('DLSS initialised but the Feeder\'s shader technique was missing. Install again to redeploy the Feeder.');
    case 'luma-select-dlss': return t('Luma UE is deployed but no DLSS call happened. In-game, press Home for Luma\'s overlay and select DLSS as the upscaler, in gameplay. Then check again.');
    case 'init-no-feature': return t('DLSS initialised but no feature was ever created. This is not a known case. Save the bundle to share, or ask the AI.');
    case 'no-hook': return t('Nothing called DLSS on the last run, so nothing was hooked. Check the game\'s own graphics settings have DLSS or DLAA selected. If they do, this is not a known case: save the bundle or ask the AI.');
    case 'ue-crash-luma': return t('The game crashed (Unreal crash report: {message}) with Luma UE deployed, and Luma is not verified on this game. Remove Luma UE and try the Feeder route.', { message: (v.message || '').slice(0, 120) });
    case 'ue-crash-feeder': return t('The game crashed (Unreal crash report: {message}) with the Feeder deployed. Remove the Feeder and check whether it runs clean.', { message: (v.message || '').slice(0, 120) });
    case 'ue-crash': return t('The game crashed (Unreal crash report: {message}). No rule covers this. Save the bundle to share, or ask the AI.', { message: (v.message || '').slice(0, 120) });
    case 'feed-stopped': return t('The Feeder gave up on the last run. Reconfigure rewrites its ReShade settings; if it stops again, dlss5-feed.log has its own diagnosis.');
    case 'fix-failed': return t('The fix "{fix}" was applied and the result did not change. DLSS 5 is not currently available for this game with what this app can do on its own. Save the bundle to share, or ask the AI.', v);
    default: return t('No rule covers this run ({verdict}). Save the bundle to share, or ask the AI.', { verdict: v.verdict || diag.code });
  }
}

// The card's one line: what is wrong, in a few words. The modal has the full sentence.
function helpShort(diag) {
  const v = diag.vars || {};
  switch (diag.code) {
    case 'bit32': return t('Not available: 32-bit game');
    case 'anticheat': return t('Not available: anti-cheat ({antiCheat})', v);
    case 'unsupported': return t('Not available here');
    case 'foreign': return t('Another DLSS 5 tool is in the folder');
    case 'feeder-misdeployed': return t('Feeder on a game with its own DLSS');
    case 'luma-known-bad': return t('Luma UE breaks this game');
    case 'not-installed': return t('Not installed yet');
    case 'feeder-missing': return t('Feeder not deployed yet');
    case 'dgvoodoo-missing': return t('dgVoodoo2 not in place yet');
    case 'luma-missing': return t('Luma UE not deployed yet');
    case 'reframework-missing': return t('REFramework missing');
    case 'pd-build-missing': return t('Needs the pd-upscaler REFramework');
    case 'pd-plugin-missing': return t('Get PDPerfPlugin.dll from Nexus');
    case 'pd-enable-ingame': return t('Enable DLSS in REFramework (Insert)');
    case 'd3d11-native': return t('Wrong D3D11 upscaler setting');
    case 'nr-disabled': return t('Neural Rendering is switched off');
    case 'feeder-technique': return t('Feeder shader missing');
    case 'luma-select-dlss': return t('Select DLSS in Luma\'s overlay (Home)');
    case 'ue-crash-luma': return t('Crashed with Luma UE');
    case 'ue-crash-feeder': return t('Crashed with the Feeder');
    case 'ue-crash': return t('Crashed -- no known fix');
    case 'feed-stopped': return t('The Feeder gave up');
    case 'fix-failed': return t('Fix did not help -- no known fix');
    case 'dlss-no-nr': case 'init-no-feature': case 'no-hook': default: return t('Not working -- no known fix');
  }
}

function helpFixLabel(id) {
  switch (id) {
    case 'remove-foreign': return t('Remove the other toolchain');
    case 'remove-feeder': return t('Remove the Feeder');
    case 'remove-luma': return t('Remove Luma UE');
    case 'reconfigure': return t('Reconfigure');
    case 'install': return t('Install OptiScaler');
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
  body.textContent = helpWords(diag);
  // A finding that sends the user to one page (the pd route's Nexus plugin) gets the link.
  let linkBtn = $('#help-link');
  if (!linkBtn) {
    linkBtn = document.createElement('button');
    linkBtn.id = 'help-link';
    linkBtn.className = 'btn btn-small';
    linkBtn.addEventListener('click', () => { if (helpDiag && helpDiag.vars && helpDiag.vars.url) window.api.openExternal(helpDiag.vars.url); });
    body.insertAdjacentElement('afterend', linkBtn);
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
  // One big button that does the next right thing; the rest sits behind More.
  const apply = $('#help-apply');
  const launch = $('#help-launch');
  const ai = $('#help-ai');
  apply.classList.toggle('hidden', diag.status !== 'fix');
  if (diag.fix) apply.textContent = t('Fix it') + ' -- ' + helpFixLabel(diag.fix.id);
  launch.classList.toggle('hidden', !(diag.status === 'needs-run' || diag.status === 'step' || diag.status === 'ok'));
  launch.classList.toggle('btn-launch', diag.status !== 'fix');
  ai.classList.toggle('hidden', diag.status !== 'unknown');
  ai.textContent = settings.anthropicApiKey ? t('Ask AI') : t('Set up AI help…');
  ai.classList.toggle('btn-primary', diag.status === 'unknown');
  $('#help-more').classList.remove('hidden');
  $('#help-more-row').classList.add('hidden');
  $('#help-ai-out').classList.add('hidden');
}

async function refreshHelp() {
  const diag = await window.api.gameHelp(helpGame.exePath, helpGame.detectedPath || null, helpFixesTried);
  if (!diag.ok) { toast(t('Game Help could not check this game: {error}', { error: diag.error })); return null; }
  renderHelp(diag);
  return diag;
}

function stopHelpPoll() { if (helpPoll) { clearInterval(helpPoll); helpPoll = null; } $('#help-waiting').classList.add('hidden'); }

async function openHelp(game, { autoFix = false } = {}) {
  helpGame = game;
  helpFixesTried = helpTriedFor(game);
  helpTriedByGame.set(game.exePath, helpFixesTried);
  helpAutoFix = autoFix;
  $('#help-title').textContent = t('Game Help -- {name}', { name: game.name });
  $('#help-body').textContent = t('Checking…');
  $('#help-status').textContent = '';
  $('#help-ai-out').classList.add('hidden');
  $('#help-ai-out').textContent = '';
  helpModal.classList.remove('hidden');
  const diag = await refreshHelp();
  helpLastRunAt = diag && diag.run && diag.run.at ? diag.run.at : null;
  // "Fix it" on the card: the fix runs at once; the modal only reports.
  if (helpAutoFix && diag && diag.status === 'fix') { helpAutoFix = false; $('#help-apply').click(); }
}
let helpAutoFix = false;

$('#help-more').addEventListener('click', () => {
  $('#help-more-row').classList.toggle('hidden');
});

function closeHelp() { stopHelpPoll(); helpModal.classList.add('hidden'); helpGame = null; }

$('#help-close').addEventListener('click', closeHelp);
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });

$('#help-apply').addEventListener('click', async () => {
  if (!helpDiag || !helpDiag.fix || !helpGame) return;
  const id = helpDiag.fix.id;
  const game = helpGame;
  // Recorded with the run it was judged against: until a newer run exists, the same rule reads
  // "needs a run", not "the fix failed" (gamehelp.js).
  const tried = helpTriedFor(game);
  const markTried = () => { tried.push({ id, runAt: helpLastRunAt }); helpTriedByGame.set(game.exePath, tried); };
  if (id === 'install') {
    closeHelp();
    await installGame(game);
    markTried();
    await renderGrid();
    openHelp(game);
    return;
  }
  $('#help-apply').disabled = true;
  const res = await window.api.gameHelpApply(game.exePath, id);
  $('#help-apply').disabled = false;
  if (!res.ok) { toast(t('The fix failed: {error}', { error: res.error })); return; }
  toast(res.done ? t('Done: {text}', { text: res.text }) : t('Not done: {text}', { text: res.text }));
  if (res.done) markTried();
  renderGrid();
  // A fix that changes files changes the finding at once; one that changes settings only shows
  // on the next run, and the finding then says so and offers Launch.
  await refreshHelp();
});

$('#help-launch').addEventListener('click', async () => {
  if (!helpGame) return;
  const res = await window.api.launchGame(helpGame.exePath);
  if (!res.ok) { toast(t('Could not launch {name}: {error}', { name: helpGame.name, error: res.error })); return; }
  $('#help-waiting').classList.remove('hidden');
  $('#help-waiting').textContent = t('Launched. Reach gameplay, play a minute, quit -- this checks the new log by itself.');
  stopHelpPoll();
  const started = Date.now();
  // run.at is OptiScaler.log's mtime, which moves from the moment the game starts writing it.
  // A changed stamp alone would judge a half-written log seconds after launch ("nothing called
  // DLSS"), so the run counts once it is over: the log records a clean exit or a recognised
  // crash, or its stamp has stood still for a few polls after changing.
  const CRASHED = ['ue-crash', 'shutdown-fault', 'duplicate-dlss'];
  let seenAt = null;
  let stableTicks = 0;
  helpPoll = setInterval(async () => {
    if (!helpGame) return stopHelpPoll();
    const diag = await window.api.gameHelp(helpGame.exePath, helpGame.detectedPath || null, helpFixesTried);
    const run = diag && diag.ok && diag.run && diag.run.ran ? diag.run : null;
    const at = run && run.at ? run.at : null;
    if (at && at !== helpLastRunAt) {
      stableTicks = at === seenAt ? stableTicks + 1 : 0;
      seenAt = at;
      const proc = await window.api.gameRunning(helpGame.exePath);
      const stopped = proc && proc.running === false;
      const finished = run.cleanExit || CRASHED.includes(run.verdict) || (stopped && stableTicks >= 1) || stableTicks >= 6;
      if (finished) {
        helpLastRunAt = at;
        stopHelpPoll();
        renderHelp(diag);
        renderGrid();
        toast(t('New run checked: {verdict}', { verdict: describeRun(diag.run) }));
        return;
      }
      $('#help-waiting').textContent = t('The game is running. Reach gameplay, play a minute, quit -- the log is checked when it stops.');
    }
    if (Date.now() - started > 20 * 60 * 1000) stopHelpPoll();
  }, 8000);
});

$('#help-bundle').addEventListener('click', async () => {
  if (!helpGame) return;
  const game = helpGame;
  const res = await window.api.supportBundle(game.exePath, game.detectedPath || null);
  if (!res.ok) { toast(t('Could not save the support bundle: {error}', { error: res.error })); return; }
  if (res.cancelled) return;
  toast(t('Support bundle saved: {path} ({count} files). Last run: {verdict}', { path: res.zipPath, count: res.files.length, verdict: describeRun(res.run) }));
  window.api.openPath(res.zipPath);
});

$('#help-report').addEventListener('click', () => {
  if (!helpGame || !helpDiag) return;
  const run = helpDiag.run;
  const title = `[Game Help] ${helpGame.name}: ${helpDiag.code}`;
  const body = [
    `**Game:** ${helpGame.name}`,
    `**Exe:** ${helpGame.exePath.split(/[\\/]/).pop()}`,
    `**Engine / API:** ${(helpGame.detectedPath && helpGame.detectedPath.badge) || '?'} / ${(helpGame.detectedPath && helpGame.detectedPath.api) || '?'}`,
    `**Route:** ${helpDiag.route ? helpDiag.route.label : '?'}`,
    `**Game Help said:** ${helpWords(helpDiag)}`,
    `**Last run:** ${run && run.ran ? describeRun(run) : 'none'}`,
    `**App:** ${settings.installedVersion || ''}`,
    '',
    '_Attach the support bundle zip (Game Help > Save bundle to share) to this issue._',
  ].join('\n');
  window.api.openExternal(`https://github.com/mrcgibb9876-hash/OptiDLSS5-UI/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
});

window.api.onGameHelpAiText(({ exePath, text }) => {
  if (!helpGame || helpGame.exePath !== exePath) return;
  const out = $('#help-ai-out');
  out.classList.remove('hidden');
  out.textContent += (out.textContent ? '\n\n' : '') + text;
});

$('#help-ai').addEventListener('click', async () => {
  if (!helpGame) return;
  if (!settings.anthropicApiKey) { openSettingsModal(); $('#settings-ai-key').focus(); return; }
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

async function installGame(game) {
  // The build this game runs on (its own choice, else the Settings default). The Pre-SR fork is
  // fetched on first use rather than at launch, so choosing it costs nothing until a game needs it.
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
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);

  // Experimental DirectX 8/9 routes: dgVoodoo2 goes in first. The main process asks before any
  // download (antivirus flags it), so a cancel stops the install here with nothing placed.
  if (route.legacy && route.legacy.dgVoodoo && !route.dgVoodooDeployed) {
    toast(t('Setting up dgVoodoo2 first (it asks before downloading)…'));
    const dg = await window.api.legacyDgVoodoo(game.exePath, game.detectedPath);
    if (!dg.ok) {
      toast(t('dgVoodoo2 could not be set up: {error}', { error: dg.error }));
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
    const providers = await window.api.feederMvProviders();
    const provider = providers.find((p) => p.default && p.autoFetchable) || providers.find((p) => p.autoFetchable);
    const res32 = await window.api.legacyInstallHost32({
      exePath: game.exePath,
      detected: game.detectedPath,
      releaseFolder,
      nrDllPath: settings.nrDllPath,
      mvProviderId: provider ? provider.id : null,
    });
    toast(res32.ok
      ? t('Installed the experimental 32-bit route. In the game: Home opens ReShade -> Add-ons -> DLSS 5 Feed -> "Show the DLSS 5 panel in-game", then Alt+Home.')
      : t('Install failed: {error}', { error: res32.error }));
    renderGrid();
    return;
  }

  if (route.route === 'feeder' && !route.feederDeployed) {
    toast(t('Deploying the DLSS5 Feeder first (ReShade, add-on, motion-vector shader, nvngx_dlss.dll)…'));
    const providers = await window.api.feederMvProviders();
    const provider = providers.find((p) => p.default && p.autoFetchable) || providers.find((p) => p.autoFetchable);
    const deployed = provider
      ? await window.api.feederDeploy(game.exePath, provider.id, { force: false, licenseConfirmed: false })
      : { ok: false, error: t('no auto-fetchable motion-vector provider') };
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
    feederNote = ' ' + t('Deployed the DLSS5 Feeder first ({provider}).', { provider: provider.displayName });
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
    const lumaNote = route.route === 'lumaue' && !route.lumaDeployed
      ? ' ' + t('Next: open Edit and deploy Luma UE -- OptiScaler has no DLSS call to hook in this game until Luma supplies one.')
      : '';
    toast(`${t('Installed.')}${feederNote} ${t('Copied nvngx_dlssnr.dll ({mb} MB) to {dir}', { mb, dir: res.dir })}${proxyNote}${proxyCreatedNote}${configNote}${streamlineNote}${reEngineNote}${profileNote}${hotfixNote}${reframeworkNote}${reframeworkConfigNote}${lumaNote}`);
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
function describeRun(run) {
  if (!run || !run.ran) return t('not run yet');
  const api = run.runtimeApi ? run.runtimeApi.toUpperCase() : null;
  switch (run.verdict) {
    case 'nr-ran': return t('Neural Rendering ran ({count} passes{fps}{api})', { count: run.nrDispatch, fps: run.fps ? ', ' + run.fps + ' fps' : '', api: api ? ', ' + api : '' });
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
    case 'feed-stopped': return t('the Feeder gave up this run -- see dlss5-feed.log for its own diagnosis');
    default: return t('not run yet');
  }
}

function describeUninstall(res) {
  const removed = (res.removed || []).length ? ' ' + t('Removed: {list}.', { list: res.removed.join(', ') }) : ' ' + t('Nothing left to remove.');
  const restored = (res.restored || []).length ? ' ' + t('Restored: {list}.', { list: res.restored.join(', ') }) : '';
  const kept = (res.kept || []).length ? ' ' + t('Left alone: {list}.', { list: res.kept.join('; ') }) : '';
  return `${t('OptiScaler removed.')}${removed}${restored}${kept}`;
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
const gameModal = $('#game-modal');

async function openGameModal(game) {
  editingGameId = game ? game.id : null;
  $('#game-modal-title').textContent = game ? t('Edit Game') : t('Add Game');
  $('#game-exe').value = game ? game.exePath : '';
  $('#game-name').value = game ? game.name : '';
  pendingBanner = {
    appid: game ? game.bannerAppId || null : null,
    localPath: game ? game.bannerLocalPath || null : null
  };
  $('#steam-search-term').value = game ? game.name : '';
  $('#steam-results').innerHTML = '';
  updateBannerPreview();
  gameModal.classList.remove('hidden');
  await loadRouteStatus(game);
  await loadApiSection(game);
  await loadEngineProfileStatus(game);
  await loadEngineSection(game);
  await loadFrameGenSection(game);
  await loadInjectorSection(game);
  await loadFeederSection(game);
  await loadOptiFgSection(game);
  await loadLosslessSection(game);
  await loadAmdNrSection(game);
  await loadLumaUeSection(game);
}

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
  section.classList.remove('hidden');

  const detectedLabel = (game.detectedPath && game.detectedPath.apiBadge) || t('not detected');
  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('Auto (detected: {api})', { api: detectedLabel });
  select.appendChild(auto);
  for (const api of ['dx12', 'dx11', 'vulkan', 'opengl']) {
    const opt = document.createElement('option');
    opt.value = api;
    opt.textContent = API_LABEL[api];
    select.appendChild(opt);
  }
  select.value = route.apiOverride || '';

  const multi = (route.detectedApis || []).length > 1;
  status.className = `status-line ${route.apiOverride ? 'status-ok' : ''}`.trim();
  status.textContent = route.apiOverride
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
  await loadRouteStatus(game);
  await loadApiSection(game);
  await loadInjectorSection(game);
  await loadFeederSection(game);
  await loadOptiFgSection(game);
  await loadLosslessSection(game);
  await loadAmdNrSection(game);
  renderGrid();
});

// Which OptiScaler build this game runs on, and the Pre-SR fork's two knobs when it is that one.
async function loadEngineSection(game) {
  const section = $('#game-engine-section');
  const select = $('#game-engine-select');
  const status = $('#game-engine-status');
  const presrBlock = $('#game-presr-block');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  select.innerHTML = '';
  const follow = document.createElement('option');
  follow.value = '';
  follow.textContent = t('Settings default ({engine})', { engine: engineLabel(settings.engine) });
  select.appendChild(follow);
  for (const id of Object.keys(ENGINE_LABELS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id === 'presr' ? t('{engine} (wider Pre-SR coverage, no Alt+Home panel)', { engine: engineLabel(id) }) : t('{engine} (Alt+Home panel)', { engine: engineLabel(id) });
    select.appendChild(opt);
  }
  select.value = game.engine && ENGINE_LABELS[game.engine] ? game.engine : '';

  const effective = engineOf(game);
  const state = await window.api.engineForGame(game.exePath);
  const installedAs = state.marker && state.marker.engine ? engineIdOrDefault(state.marker.engine) : null;
  const installed = (await window.api.gameStatus(game.exePath)).backends || {};
  status.className = 'status-line';
  status.textContent = installed.optiscaler && installedAs && installedAs !== effective
    ? t('Installed with {installed}; press Install on the card to switch it to {engine}.', { installed: engineLabel(installedAs), engine: engineLabel(effective) })
    : installed.optiscaler && installedAs
      ? t('Installed with {engine}.', { engine: engineLabel(installedAs) })
      : '';

  // Both builds read RunBeforeSR and Passes. Once installed, the game's ini is the truth: the
  // in-game menus write it too, and "auto" there means off / one pass in both builds. Before an
  // install, show what Install will write.
  presrBlock.classList.remove('hidden');
  const marker = state.marker || {};
  const pendingEngine = installedAs && installedAs === effective ? installedAs : effective;
  const passesOk = (n) => [1, 2, 3].includes(n);
  if (state.iniPresent && state.ini && installedAs === effective) {
    $('#game-presr-before').checked = String(state.ini.runBeforeSR).toLowerCase() === 'true';
    const n = Number(state.ini.passes);
    $('#game-presr-passes').value = String(passesOk(n) ? n : 1);
    $('#game-presr-status').textContent = '';
  } else {
    $('#game-presr-before').checked = typeof marker.runBeforeSR === 'boolean' ? marker.runBeforeSR : pendingEngine === 'presr';
    $('#game-presr-passes').value = String(passesOk(Number(marker.passes)) ? Number(marker.passes) : 1);
    $('#game-presr-status').textContent = t('Applied on Install.');
  }
}

$('#game-engine-select').addEventListener('change', async (e) => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const chosen = e.target.value || null;
  game.engine = chosen;
  window.api.saveGames(games);
  const effective = engineOf(game);
  // The marker names the build this game should be on from now; the ini keys follow at once when
  // OptiScaler is already there. The DLL itself only changes with a re-Install, which is offered
  // rather than run silently -- it copies the release over the folder, ini included.
  const res = await window.api.setGameEngine({ exePath: game.exePath, engine: effective });
  if (!res.ok) toast(t('Could not set the build: {error}', { error: res.error }));
  const status = (await window.api.gameStatus(game.exePath)).backends || {};
  if (status.optiscaler) {
    toast(t('This game will use {engine}. Press Install on its card to switch the files over.', { engine: engineLabel(effective) }));
  } else {
    toast(t('This game will use {engine} when installed.', { engine: engineLabel(effective) }));
  }
  await loadEngineSection(game);
  await loadInjectorSection(game);
  renderGrid();
});

$('#btn-presr-apply').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-presr-status');
  status.textContent = t('Applying…');
  const res = await window.api.setGameEngine({
    exePath: game.exePath,
    engine: engineOf(game),
    runBeforeSR: $('#game-presr-before').checked,
    passes: Number($('#game-presr-passes').value),
  });
  if (!res.ok) {
    status.className = 'status-line status-bad';
    status.textContent = t('Could not apply: {error}', { error: res.error });
    return;
  }
  status.className = 'status-line status-ok';
  status.textContent = res.deferred ? t('Saved -- applied on Install.') : t('Applied to OptiScaler.ini ({keys}). Takes effect on the next launch.', { keys: (res.applied || []).map((x) => `${x.key}=${x.value}`).join(', ') || t('already set') });
});

// The same route the card tags, spelled out: which stack this game gets and what is still to do.
async function loadRouteStatus(game) {
  const el = $('#game-route-status');
  if (!game || !game.exePath) {
    el.classList.add('hidden');
    return;
  }
  const route = await window.api.gameRoute(game.exePath, game.detectedPath);
  el.classList.remove('hidden');
  el.className = `status-line ${route.route === 'unsupported' ? 'status-bad' : route.complete ? 'status-ok' : ''}`.trim();
  const progress = route.complete ? t('All set.') : route.nextStep ? t('Next: {step}.', { step: t(route.nextStep) }) : '';
  el.textContent = `${t('Recommended: {label}.', { label: t(route.label) })} ${t(route.reason, route.reasonVars)} ${progress}`.trim();
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
  if (res.known) {
    el.className = 'status-line status-ok';
    el.textContent = t('OptiScaler has a known compatibility profile built in for this exe.');
  } else {
    el.className = 'status-line';
    el.textContent = t('No compiled-in compatibility profile for this exe -- default OptiScaler configuration.');
  }
}

let frameGenVersionsLoaded = false;

// Populates and shows the per-game "DLSS Frame Generation version" control -- only meaningful
// for a game that already has an nvngx_dlssg.dll to version, so it stays hidden otherwise
// (including the "Add Game" case, where there's no game folder to check yet).
async function loadFrameGenSection(game) {
  const section = $('#game-framegen-section');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }

  const state = await window.api.frameGenState(game.exePath);
  if (!state.hasFrameGen) {
    section.classList.add('hidden');
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
}

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
  else toast(t('Frame Generation multiplier applied. It takes effect on the next launch (or right away from the Alt+Home panel).'));
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
  if (!feederProvidersLoaded) {
    const providers = await window.api.feederMvProviders();
    for (const p of providers) {
      feederProvidersById[p.id] = p;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.autoFetchable ? p.displayName : `${p.displayName} — ${p.license}`;
      if (p.default) opt.selected = true;
      select.appendChild(opt);
    }
    feederProvidersLoaded = true;
  }

  const missing = [
    readiness.reshadeInstalled ? null : 'ReShade',
    readiness.addonInstalled ? null : t('Feeder add-on'),
    readiness.fxInstalled ? null : 'DLSS5_Feed.fx',
    readiness.headersInstalled ? null : 'ReShade.fxh/ReShadeUI.fxh',
    readiness.dlssInstalled ? null : 'nvngx_dlss.dll',
    readiness.dlssnrInstalled ? null : t('nvngx_dlssnr.dll (install this yourself first)'),
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
async function deployFeederStack(game, providerId, force) {
  const status = $('#game-feeder-status');
  const provider = feederProvidersById[providerId];

  let licenseConfirmed = true;
  if (provider && !provider.autoFetchable) {
    licenseConfirmed = await window.api.feederConfirmProviderLicense(providerId);
    if (!licenseConfirmed) {
      status.textContent = t('Cancelled -- licence not confirmed.');
      return;
    }
  }

  status.textContent = force ? t('Updating…') : t('Deploying…');
  const res = await window.api.feederDeploy(game.exePath, providerId, { force, licenseConfirmed });
  if (res.ok) {
    toast(force
      ? t('Feeder stack updated.')
      : t('Feeder stack deployed. Install OptiScaler normally (Install button) to finish -- not the injector.'));
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
  await loadRouteStatus(game);
  await loadFeederSection(game);
  await loadOptiFgSection(game);
  await loadLosslessSection(game);
  renderGrid();
});

// Scoped to Feeder games for now -- that's the only case this was actually verified against
// (Bodycam, 2026-09-09: config read back correctly as FrameGen.FGOutput=FSRFG). A native-DLSS
// game already gets real DLSS-G from the game itself; nothing here is about that case.
async function loadOptiFgSection(game) {
  const section = $('#game-optifg-section');
  const checkbox = $('#game-optifg-toggle');
  const status = $('#game-optifg-status');
  if (!game || !game.exePath) {
    section.classList.add('hidden');
    return;
  }

  const feederStatus = await window.api.feederReadiness(game.exePath);
  if (!feederStatus.needed) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const readiness = await window.api.optiFgReadiness(game.exePath);
  if (!readiness.supported) {
    checkbox.checked = false;
    checkbox.disabled = true;
    status.className = 'status-line';
    status.textContent = t(readiness.reason, readiness.reasonVars);
    return;
  }

  checkbox.disabled = false;
  checkbox.checked = !!readiness.enabled;
  status.className = 'status-line';
  status.textContent = readiness.enabled
    ? t('On -- applied to OptiScaler.ini.')
    : t('Off.');
}

$('#game-optifg-toggle').addEventListener('change', async (e) => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-optifg-status');
  status.textContent = t('Applying…');
  const res = await window.api.optiFgSet(game.exePath, e.target.checked);
  if (res.ok) {
    toast(e.target.checked ? t('OptiScaler Frame Generation (FSRFG) enabled.') : t('OptiScaler Frame Generation disabled.'));
  } else {
    toast(t('Could not change Frame Generation: {error}', { error: res.error }));
  }
  loadOptiFgSection(game);
});

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
  deployBtn.textContent = readiness.blockedByFeeder ? t('Deploy Luma UE (removes the Feeder first)')
    : readiness.experimental ? t('Deploy Luma UE (experimental)') : t('Deploy Luma UE');
  $('#btn-lumaue-remove').classList.toggle('hidden', !readiness.addonInstalled);
  // The workaround used to be a blind question; now the GPU is known it is pre-answered, and
  // still a checkbox the user can untick.
  if (gpu.vendor === 'amd' || gpu.vendor === 'intel') $('#game-lumaue-amd-intel').checked = true;

  const yn = (v) => (v ? t('yes') : t('no'));
  status.textContent = readiness.complete
    ? t("Deployed -- select DLSS in Luma's own overlay (Home key) in-game.")
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
  if (!readiness.complete) {
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
  await loadRouteStatus(game);
  await loadFeederSection(game);
  await loadLumaUeSection(game);
  await loadLosslessSection(game);
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
      toast(t('OptiScaler is not installed for this game yet -- click Install on its card; Luma only loads through OptiScaler.'));
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
  await loadRouteStatus(game);
  await loadFeederSection(game);
  await loadLumaUeSection(game);
  await loadLosslessSection(game);
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

$('#btn-browse-exe').addEventListener('click', async () => {
  const p = await window.api.pickExe();
  if (!p) return;
  $('#game-exe').value = p;
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

  if (editingGameId) {
    const g = games.find((x) => x.id === editingGameId);
    g.exePath = exePath;
    g.name = name;
    g.bannerAppId = pendingBanner.appid;
    g.bannerLocalPath = pendingBanner.localPath;
    g.launchMode = launchMode;
  } else {
    games.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      exePath,
      name,
      bannerAppId: pendingBanner.appid,
      bannerLocalPath: pendingBanner.localPath,
      launchMode
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
  $('#settings-ai-key').value = settings.anthropicApiKey || '';
  $('#settings-ai-model').value = settings.aiModel || 'claude-sonnet-5';
  $('#settings-engine').value = engineIdOrDefault(settings.engine);
  $('#settings-release-folder').value = settings.releaseFolder || '';
  $('#settings-nr-dll').value = settings.nrDllPath || '';
  $('#update-status').textContent = installedEnginesText();
  $('#update-status').className = 'status-line';
  $('#btn-install-update').classList.add('hidden');
  pendingUpdates = [];
  refreshEngineSettingStatus();
  checkReleaseStatus();
  checkNrDllStatus();
  loadStreamlineVersions();
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

$('#settings-engine').addEventListener('change', async (e) => {
  const id = engineIdOrDefault(e.target.value);
  settings.engine = id;
  await window.api.saveSettings(settings);
  const statusEl = $('#settings-engine-status');
  statusEl.className = 'status-line';
  statusEl.textContent = engineFolder(id) ? '' : t('Fetching the {engine} build…', { engine: engineLabel(id) });
  const ready = await ensureEngine(id);
  if (!ready.ok) {
    statusEl.className = 'status-line status-bad';
    statusEl.textContent = t('Could not set up the {engine} build: {error}', { engine: engineLabel(id), error: ready.error });
    return;
  }
  refreshEngineSettingStatus();
  $('#update-status').textContent = installedEnginesText();
  toast(t('New installs use {engine}. Games already installed keep their build until you change it in Edit.', { engine: engineLabel(id) }));
});

$('#settings-language').addEventListener('change', async (e) => {
  settings.language = e.target.value || 'auto';
  await window.api.saveSettings(settings);
  applyLanguage();
  openSettingsModal();
  renderGrid();
});

async function checkReleaseStatus() {
  const el = $('#release-status');
  if (!settings.releaseFolder) {
    el.textContent = '';
    return;
  }
  const res = await window.api.validateRelease(settings.releaseFolder);
  el.textContent = res.valid ? t('Looks good — setup_windows.bat found.') : t('Not valid: {reason}', { reason: res.reason });
  el.className = `status-line ${res.valid ? 'status-ok' : 'status-bad'}`;
}

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

async function persistReleaseFolder(p) {
  settings.releaseFolder = p;
  $('#settings-release-folder').value = p;
  await window.api.saveSettings(settings);
  checkReleaseStatus();
  refreshBannerVisibility();
  autoSyncStaleGames();
}

async function persistNrDll(p) {
  settings.nrDllPath = p;
  $('#settings-nr-dll').value = p;
  await window.api.saveSettings(settings);
  checkNrDllStatus();
  refreshBannerVisibility();
}

$('#btn-browse-release').addEventListener('click', async () => {
  const p = await window.api.pickFolder(t('Select the extracted OptiScaler_DLSSNR release folder'));
  if (p) persistReleaseFolder(p);
});
$('#settings-release-folder').addEventListener('change', (e) => persistReleaseFolder(e.target.value.trim()));

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
async function autoSyncStaleGames() {
  if (games.length === 0) return;

  const updated = [];
  const configured = [];
  const streamlined = [];
  const nrRefreshed = [];
  const failed = [];

  // Each game syncs against the build it runs on; a build with no valid folder yet (the Pre-SR
  // fork before its first fetch) is skipped rather than fetched here -- Install does that.
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
      continue;
    }
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

// The installer carries the engine zip it was released with. Extract it whenever there is no
// usable engine yet, or the one on disk is older than the bundle -- no network involved, so a
// fresh install works offline and never waits on GitHub. The online check below still runs
// afterwards for anything newer.
// A valid release folder that is not the app's own managed one is the user's own build: the
// app reads from it and never replaces it -- neither with the bundle nor with a GitHub update.
async function usingCustomReleaseFolder(managedFolder) {
  if (!settings.releaseFolder) return false;
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  if (norm(settings.releaseFolder) === norm(managedFolder)) return false;
  return (await window.api.validateRelease(settings.releaseFolder)).valid;
}

// ── Which OptiScaler build a game runs on ─────────────────────────────────────
//
// engines.js (main) is the list. The default build keeps its state where it always was
// (settings.releaseFolder / installedVersion -- also what a user's own custom folder points at);
// every other build lives in settings.engines[id] = { folder, version }. A game may name its own
// build (game.engine); otherwise it follows settings.engine.
const ENGINE_LABELS = {
  dlssnr: 'OptiScaler_DLSSNR',
  presr: 'OptiScaler-DLSSNR-PreSR-Multipass',
};
const DEFAULT_ENGINE_ID = 'dlssnr';

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

// Every build that has a folder on disk -- the ones worth checking for updates.
function enginesInUse() {
  return Object.keys(ENGINE_LABELS).filter((id) => id === DEFAULT_ENGINE_ID || !!engineFolder(id));
}

function installedEnginesText() {
  const parts = enginesInUse().filter((id) => engineVersion(id)).map((id) => `${engineLabel(id)} ${engineVersion(id)}`);
  return parts.length ? t('Installed: {version}', { version: parts.join(', ') }) : '';
}

function refreshEngineSettingStatus() {
  const el = $('#settings-engine-status');
  const id = engineIdOrDefault(settings.engine);
  const folder = engineFolder(id);
  if (!folder) { el.className = 'status-line'; el.textContent = ''; return; }
  el.className = 'status-line status-ok';
  el.textContent = engineVersion(id) ? t('{engine} {version} is ready.', { engine: engineLabel(id), version: engineVersion(id) }) : t('{engine} is ready.', { engine: engineLabel(id) });
}

// Makes sure a build is on disk: a valid folder is enough; otherwise its latest GitHub release
// is fetched into that build's managed folder. Returns { ok } or { ok: false, error }.
const engineFetches = {};
async function ensureEngine(id) {
  id = engineIdOrDefault(id);
  const folder = engineFolder(id);
  if (folder && (await window.api.validateRelease(folder)).valid) return { ok: true };
  if (!engineFetches[id]) {
    engineFetches[id] = (async () => {
      const res = await window.api.checkUpdate(id);
      if (!res.ok) return { ok: false, error: res.error };
      toast(t('Fetching {engine} {tag}…', { engine: engineLabel(id), tag: res.tag }));
      const installRes = await window.api.installUpdate({ downloadUrl: res.downloadUrl, assetName: res.assetName, tag: res.tag, engine: id, sha256Url: res.sha256Url });
      if (!installRes.ok) return { ok: false, error: installRes.error };
      setEngineState(id, installRes.folder, res.tag);
      await window.api.saveSettings(settings);
      refreshBannerVisibility();
      checkReleaseStatus();
      toast(t('Fetched {engine} {tag}.', { engine: engineLabel(id), tag: res.tag }));
      return { ok: true };
    })().finally(() => { delete engineFetches[id]; });
  }
  return engineFetches[id];
}

async function ensureBundledEngine() {
  const bundled = await window.api.bundledEngine();
  if (!bundled || !bundled.tag) return false;
  if (await usingCustomReleaseFolder(bundled.managedFolder)) return false;
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
  checkReleaseStatus();
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

// The Manager's own update, as pushed by main.js (src/manager-update.js): a banner while it
// downloads, and "Restart to update" once it is on disk. Nothing to click for the download
// itself -- it happens on its own, and even an ignored banner installs on the next quit.
function renderManagerUpdate(state) {
  const banner = $('#manager-update-banner');
  const text = $('#manager-update-banner-text');
  const restartBtn = $('#btn-manager-restart');
  if (!state || !state.supported) { banner.classList.add('hidden'); return; }
  if (state.phase === 'downloading' || state.phase === 'available') {
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

$('#btn-manager-restart').addEventListener('click', async () => {
  $('#btn-manager-restart').disabled = true;
  const ok = await window.api.managerUpdateRestart();
  if (!ok) { $('#btn-manager-restart').disabled = false; toast(t('The update is not ready yet.')); }
});

// Every build in use gets the same treatment: the default one always, the Pre-SR fork once it
// has been fetched for some game.
async function autoUpdateOptiScalerRelease() {
  const bundled = await window.api.bundledEngine();
  let anyUpdated = false;
  for (const id of enginesInUse()) {
    if (id === DEFAULT_ENGINE_ID && (await usingCustomReleaseFolder(bundled.managedFolder))) continue;
    const res = await window.api.checkUpdate(id);
    const installed = engineVersion(id);
    if (!res.ok || installed === res.tag) continue;
    // Never step backwards from the bundled engine because GitHub's "latest" lags behind it.
    if (installed && compareTags(installed, res.tag) > 0) continue;

    const installRes = await window.api.installUpdate({
      downloadUrl: res.downloadUrl,
      assetName: res.assetName,
      tag: res.tag,
      engine: id,
      sha256Url: res.sha256Url,
    });
    if (!installRes.ok) {
      toast(t('Auto-update to {tag} failed: {error}', { tag: res.tag, error: installRes.error }));
      continue;
    }

    const hadRelease = !!engineFolder(id);
    setEngineState(id, installRes.folder, res.tag);
    await window.api.saveSettings(settings);
    toast(hadRelease
      ? t('{engine} auto-updated to {tag}.', { engine: engineLabel(id), tag: res.tag })
      : t('Fetched {engine} {tag} automatically.', { engine: engineLabel(id), tag: res.tag }));
    anyUpdated = true;
  }
  if (!anyUpdated) return;
  refreshBannerVisibility();
  checkReleaseStatus();
  autoSyncStaleGames();
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

$('#btn-check-updates').addEventListener('click', async () => {
  const btn = $('#btn-check-updates');
  const statusEl = $('#update-status');
  const managerStatusEl = $('#manager-update-status');
  const mismatchEl = $('#manager-update-mismatch');
  btn.disabled = true;
  statusEl.className = 'status-line';
  statusEl.textContent = t('Checking…');
  managerStatusEl.textContent = '';
  mismatchEl.classList.add('hidden');
  $('#btn-install-update').classList.add('hidden');

  // Every build in use is checked (the default always; the Pre-SR fork once fetched), so one
  // status line and one button cover them all.
  const ids = enginesInUse();
  const [managerRes, ...engineResults] = await Promise.all([window.api.checkManagerUpdate(), ...ids.map((id) => window.api.checkUpdate(id))]);
  btn.disabled = false;

  let engineNeedsUpdate = false;
  pendingUpdates = [];
  const lines = [];
  let anyFailed = false;
  ids.forEach((id, i) => {
    const res = engineResults[i];
    const installed = engineVersion(id);
    if (!res.ok) {
      anyFailed = true;
      lines.push(t('{engine}: check failed: {error}', { engine: engineLabel(id), error: res.error }));
      return;
    }
    // Older than GitHub's latest, not merely different: a Manager whose bundle is ahead of the
    // latest release must not offer a downgrade.
    const needs = !installed || compareTags(installed, res.tag) < 0;
    if (!needs) {
      lines.push(t('{engine} up to date ({tag}).', { engine: engineLabel(id), tag: res.tag }));
      return;
    }
    engineNeedsUpdate = true;
    pendingUpdates.push(res);
    lines.push(installed
      ? t('{engine} update available: {tag} (installed: {installed})', { engine: engineLabel(id), tag: res.tag, installed })
      : t('{engine}: latest release {tag} — not installed yet.', { engine: engineLabel(id), tag: res.tag }));
  });
  statusEl.className = anyFailed ? 'status-line status-bad' : engineNeedsUpdate ? 'status-line' : 'status-line status-ok';
  statusEl.textContent = lines.join(' ');

  let managerNeedsUpdate = false;
  if (!managerRes.ok) {
    managerStatusEl.className = 'status-line status-bad';
    managerStatusEl.textContent = t('Manager check failed: {error}', { error: managerRes.error });
    pendingManagerUpdate = null;
  } else {
    pendingManagerUpdate = managerRes.upToDate ? null : managerRes;
    managerNeedsUpdate = !managerRes.upToDate;
    managerStatusEl.className = managerRes.upToDate ? 'status-line status-ok' : 'status-line';
    managerStatusEl.textContent = managerRes.upToDate
      ? t('Manager up to date (v{version}).', { version: managerRes.currentVersion })
      : t('Manager update available: {latest} (running v{current}).', { latest: managerRes.latestVersion, current: managerRes.currentVersion });

    // The real compatibility signal: does the engine actually installed right now match the one
    // THIS Manager build shipped with and was tested against -- not just "are both independently
    // latest", which two asynchronously-released repos don't guarantee. See update:checkManager's
    // own comment in main.js for why.
    // Only an engine OLDER than the one this Manager shipped with is a real mismatch -- newer is
    // the normal state after any engine release, since launch auto-updates past the bundle.
    if (managerRes.bundledEngineTag && settings.installedVersion && compareTags(settings.installedVersion, managerRes.bundledEngineTag) < 0) {
      mismatchEl.classList.remove('hidden');
      mismatchEl.textContent = t('Version mismatch: this Manager (v{manager}) shipped tested with engine {bundled}, but the older {installed} is installed. Update the engine above to bring them back in sync.', {
        manager: managerRes.currentVersion, bundled: managerRes.bundledEngineTag, installed: settings.installedVersion,
      });
    }
  }

  // One button covers both from here -- see its own click handler for what "both" means when
  // only the Manager needs it (there's no self-replacing installer, so that half opens the
  // release page instead of downloading silently).
  const installBtn = $('#btn-install-update');
  if (engineNeedsUpdate || managerNeedsUpdate) {
    installBtn.classList.remove('hidden');
    installBtn.textContent = engineNeedsUpdate && managerNeedsUpdate ? t('Update Both')
      : managerNeedsUpdate ? t('Update Manager')
      : t('Update Engine');
  } else {
    installBtn.classList.add('hidden');
  }
});

$('#btn-install-update').addEventListener('click', async () => {
  const btn = $('#btn-install-update');
  const statusEl = $('#update-status');
  const managerStatusEl = $('#manager-update-status');

  const toInstall = pendingUpdates.filter((u) => engineVersion(u.engine) !== u.tag);
  if (toInstall.length) {
    btn.disabled = true;
    const done = [];
    for (const pending of toInstall) {
      const id = engineIdOrDefault(pending.engine);
      statusEl.className = 'status-line';
      statusEl.textContent = t('Downloading {engine} {tag}…', { engine: engineLabel(id), tag: pending.tag });

      const res = await window.api.installUpdate({
        downloadUrl: pending.downloadUrl,
        assetName: pending.assetName,
        tag: pending.tag,
        engine: id,
        sha256Url: pending.sha256Url,
      });

      if (!res.ok) {
        btn.disabled = false;
        statusEl.className = 'status-line status-bad';
        statusEl.textContent = t('Update failed: {error}', { error: res.error });
        return;
      }

      setEngineState(id, res.folder, res.tag);
      await window.api.saveSettings(settings);
      if (id === DEFAULT_ENGINE_ID) $('#settings-release-folder').value = res.folder;
      done.push(`${engineLabel(id)} ${res.tag}`);
    }
    btn.disabled = false;
    pendingUpdates = [];
    statusEl.className = 'status-line status-ok';
    statusEl.textContent = t('Installed {tag}.', { tag: done.join(', ') });
    checkReleaseStatus();
    refreshEngineSettingStatus();
    refreshBannerVisibility();
    toast(t('OptiScaler engine updated to {tag}', { tag: done.join(', ') }));
    autoSyncStaleGames();
  }

  // The Manager updates itself (src/manager-update.js) where it can -- the installer build. The
  // portable exe and a source checkout cannot replace themselves, so those still get the
  // release page.
  if (pendingManagerUpdate) {
    const st = await window.api.managerUpdateState();
    if (st.supported) {
      managerStatusEl.className = 'status-line';
      managerStatusEl.textContent = t('Downloading Manager {version} in the background -- you will be asked to restart when it is ready.', { version: pendingManagerUpdate.latestVersion });
      window.api.managerUpdateCheck();
    } else {
      await window.api.openManagerReleasePage();
      managerStatusEl.className = 'status-line';
      managerStatusEl.textContent = t('Opened the release page for {version} -- install it and relaunch.', { version: pendingManagerUpdate.latestVersion });
      toast(t('Grab Manager {version} from the page that just opened, then relaunch.', { version: pendingManagerUpdate.latestVersion }));
    }
  }

  btn.classList.add('hidden');
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

window.addEventListener('focus', () => {
  renderGrid();
  // Back from the browser with the plugin downloaded: look for it again.
  if (!pdPluginModal.classList.contains('hidden')) refreshPdPluginModal();
});

(async function init() {
  const data = await window.api.loadData();
  games = data.games || [];
  settings = data.settings || { releaseFolder: '', nrDllPath: '', installedVersion: '' };
  applyLanguage();
  try { gpu = (await window.api.gpuInfo()) || gpu; } catch {}
  // Vendor colours: the default green is NVIDIA's; an AMD card gets AMD red (style.css, body.vendor-amd).
  document.body.classList.toggle('vendor-amd', gpu.vendor === 'amd');
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
