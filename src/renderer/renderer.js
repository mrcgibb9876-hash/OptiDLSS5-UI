let games = [];
// The store-search version this build carries, asked of the main process once (see steam:searchVersion).
let bannerSearchVersion = 1;
let bannerSearchVersionLoaded = false;
let settings = { releaseFolder: '', nrDllPath: '', installedVersion: '', streamlineVersion: 'latest' };
let editingGameId = null;
let pendingBanner = { appid: null, localPath: null };
let pendingUpdate = null;
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
      badgeText = 'OptiScaler';
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
        ${(status.warnings || []).map((w) => `<div class="card-warning" title="${escapeHtml(t(w.message, w.vars))}">⚠ ${escapeHtml(t(w.message, w.vars))}</div>`).join('')}
        ${(status.foreign || []).length ? `<button class="btn btn-danger btn-small btn-remove-foreign" style="margin: 2px 0 6px;">${escapeHtml(t('Remove the other DLSS 5 toolchain…'))}</button>` : ''}
        <div class="card-actions">
          <button class="btn ${backends.optiscaler || (backends.leftovers || []).length ? 'btn-danger' : 'btn-primary'} btn-install">${escapeHtml(backends.optiscaler ? t('Remove OptiScaler') : (backends.leftovers || []).length ? t('Remove leftovers') : t('Install OptiScaler'))}</button>
          <button class="btn btn-launch" title="${escapeHtml(t('Runs the game from its own folder -- for an Unreal game, the -Win64-Shipping.exe that OptiScaler is installed beside.'))}">&#9654; ${escapeHtml(t('Launch'))}</button>
        </div>
        <div class="card-actions-row2">
          <button class="btn btn-ghost btn-open">${escapeHtml(t('Open Folder'))}</button>
          <button class="btn btn-ghost btn-edit">${escapeHtml(t('Edit'))}</button>
          <button class="btn btn-ghost btn-support has-tip" data-tip="${escapeHtml(t('Packs this game\'s logs, settings and what this app knows about it into one zip on your Desktop, to attach when asking for help. Nothing is sent anywhere.'))}">${escapeHtml(t('Support bundle'))}</button>
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
    if (!game.bannerLocalPath && game.bannerAppId) {
      window.api.cacheSteamBanner(game.bannerAppId).then((localPath) => {
        if (localPath) {
          game.bannerLocalPath = localPath;
          window.api.saveGames(games);
          setBannerWithFallback(game, card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback'));
        }
      });
    } else if (!game.bannerLocalPath && !game.bannerAppId && (!game.bannerSearchAttempted || (game.bannerSearchVersion || 1) < bannerSearchVersion)) {
      // Once per search version: a card that missed under an older, dumber search tries again
      // after an update, and a card that still misses is not hammered on every render.
      game.bannerSearchAttempted = true;
      game.bannerSearchVersion = bannerSearchVersion;
      window.api.steamSearch(game.name).then(async (items) => {
        if (!items || items.length === 0) {
          window.api.saveGames(games);
          return;
        }
        const best = items[0];
        const localPath = await window.api.cacheSteamBanner(best.appid, best.tinyImage);
        game.bannerAppId = String(best.appid);
        if (localPath) game.bannerLocalPath = localPath;
        window.api.saveGames(games);
        setBannerWithFallback(game, card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback'));
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
    card.querySelector('.btn-support').addEventListener('click', async () => {
      const res = await window.api.supportBundle(game.exePath, game.detectedPath || null);
      if (!res.ok) { toast(t('Could not save the support bundle: {error}', { error: res.error })); return; }
      if (res.cancelled) return;
      toast(t('Support bundle saved: {path} ({count} files). Last run: {verdict}', { path: res.zipPath, count: res.files.length, verdict: describeRun(res.run) }));
      window.api.openPath(res.zipPath);
    });
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
  // Only a dated, human confirmation from the registry (src/verified-games.json) earns this.
  if (route.verified && route.verified.route === route.route) {
    chips.push(`<span class="engine-badge engine-badge-known" title="${escapeHtml(route.verified.notes || '')}">✓ ${escapeHtml(t('Verified {date}', { date: route.verified.verified }))}</span>`);
  }

  line.innerHTML = chips.join(' ');

  // What detection found beside the exe that the person should know before installing: none
  // of these block anything, all of them have bitten real installs.
  const detectWarnings = [];
  if (detected.antiCheat) detectWarnings.push(t('Anti-cheat present ({file}) -- OptiScaler is for single-player games; using it in a game that goes online risks a ban.', { file: detected.antiCheat }));
  if (detected.reshadeProxy) detectWarnings.push(t('ReShade is already installed here as {file}. Install replaces it with OptiScaler -- pick Launch mode: Injector in Edit to keep both.', { file: detected.reshadeProxy }));
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
const API_LABEL = { dx12: 'DX12', dx11: 'DX11', vulkan: 'Vulkan' };

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

async function installGame(game) {
  const valid = await window.api.validateRelease(settings.releaseFolder);
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
  if (route.route === 'feeder' && !route.feederDeployed) {
    toast(t('Deploying the DLSS5 Feeder first (ReShade, add-on, motion-vector shader, nvngx_dlss.dll)…'));
    const providers = await window.api.feederMvProviders();
    const provider = providers.find((p) => p.default && p.autoFetchable) || providers.find((p) => p.autoFetchable);
    const deployed = provider
      ? await window.api.feederDeploy(game.exePath, provider.id, { force: false, licenseConfirmed: false })
      : { ok: false, error: t('no auto-fetchable motion-vector provider') };
    if (!deployed.ok) {
      toast(t('Could not deploy the DLSS5 Feeder: {error}. OptiScaler was not installed -- without the Feeder it would have no DLSS call to hook. Retry once you are online.', { error: deployed.error }));
      renderGrid();
      return;
    }
    feederNote = ' ' + t('Deployed the DLSS5 Feeder first ({provider}).', { provider: provider.displayName });
  }

  toast(t('Installing…'));
  const res = await window.api.installGame({
    exePath: game.exePath,
    releaseFolder: settings.releaseFolder,
    nrDllPath: settings.nrDllPath
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
  } else {
    toast(t('Install failed: {error}', { error: res.error }));
  }
  renderGrid();
}

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
  for (const api of ['dx12', 'dx11', 'vulkan']) {
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
}

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

  const readiness = await window.api.injectorReadiness(settings.releaseFolder);
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
      const res = await window.api.injectorSteamOption(settings.releaseFolder);
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
  const res = await window.api.injectorLaunch(game.exePath, settings.releaseFolder);
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
    toast(t('Launched Lossless Scaling.'));
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
    const base = p.split(/[\\/]/).pop().replace(/\.exe$/i, '');
    const pretty = base.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
  $('#settings-release-folder').value = settings.releaseFolder || '';
  $('#settings-nr-dll').value = settings.nrDllPath || '';
  $('#update-status').textContent = settings.installedVersion ? t('Installed: {version}', { version: settings.installedVersion }) : '';
  $('#update-status').className = 'status-line';
  $('#btn-install-update').classList.add('hidden');
  pendingUpdate = null;
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

  const releaseValid = settings.releaseFolder && (await window.api.validateRelease(settings.releaseFolder)).valid;
  for (const game of games) {
    if (!releaseValid) break;
    const res = await window.api.syncGameIfStale({ exePath: game.exePath, releaseFolder: settings.releaseFolder, nrDllPath: settings.nrDllPath });
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

async function autoUpdateOptiScalerRelease() {
  const bundled = await window.api.bundledEngine();
  if (await usingCustomReleaseFolder(bundled.managedFolder)) return;
  const res = await window.api.checkUpdate();
  if (!res.ok || settings.installedVersion === res.tag) return;
  // Never step backwards from the bundled engine because GitHub's "latest" lags behind it.
  if (settings.installedVersion && compareTags(settings.installedVersion, res.tag) > 0) return;

  const installRes = await window.api.installUpdate({
    downloadUrl: res.downloadUrl,
    assetName: res.assetName,
    tag: res.tag
  });
  if (!installRes.ok) {
    toast(t('Auto-update to {tag} failed: {error}', { tag: res.tag, error: installRes.error }));
    return;
  }

  const hadRelease = !!settings.releaseFolder;
  settings.releaseFolder = installRes.folder;
  settings.installedVersion = res.tag;
  await window.api.saveSettings(settings);
  refreshBannerVisibility();
  checkReleaseStatus();
  toast(hadRelease ? t('OptiScaler engine auto-updated to {tag}.', { tag: res.tag }) : t('Fetched the OptiScaler engine ({tag}) automatically.', { tag: res.tag }));
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

  const [res, managerRes] = await Promise.all([window.api.checkUpdate(), window.api.checkManagerUpdate()]);
  btn.disabled = false;

  let engineNeedsUpdate = false;
  if (!res.ok) {
    statusEl.className = 'status-line status-bad';
    statusEl.textContent = t('Check failed: {error}', { error: res.error });
    pendingUpdate = null;
  } else {
    pendingUpdate = res;
    // Older than GitHub's latest, not merely different: a Manager whose bundle is ahead of the
    // latest release must not offer a downgrade.
    engineNeedsUpdate = !settings.installedVersion || compareTags(settings.installedVersion, res.tag) < 0;
    if (!engineNeedsUpdate) {
      statusEl.className = 'status-line status-ok';
      statusEl.textContent = t('Engine up to date ({tag}).', { tag: res.tag });
    } else {
      statusEl.className = 'status-line';
      statusEl.textContent = settings.installedVersion
        ? t('Engine update available: {tag} (installed: {installed})', { tag: res.tag, installed: settings.installedVersion })
        : t('Latest engine release: {tag} — not installed yet.', { tag: res.tag });
    }
  }

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

  if (pendingUpdate && settings.installedVersion !== pendingUpdate.tag) {
    btn.disabled = true;
    statusEl.className = 'status-line';
    statusEl.textContent = t('Downloading {tag}…', { tag: pendingUpdate.tag });

    const res = await window.api.installUpdate({
      downloadUrl: pendingUpdate.downloadUrl,
      assetName: pendingUpdate.assetName,
      tag: pendingUpdate.tag
    });

    btn.disabled = false;

    if (!res.ok) {
      statusEl.className = 'status-line status-bad';
      statusEl.textContent = t('Update failed: {error}', { error: res.error });
      return;
    }

    settings.releaseFolder = res.folder;
    settings.installedVersion = res.tag;
    await window.api.saveSettings(settings);
    $('#settings-release-folder').value = res.folder;
    statusEl.className = 'status-line status-ok';
    statusEl.textContent = t('Installed {tag}.', { tag: res.tag });
    checkReleaseStatus();
    refreshBannerVisibility();
    toast(t('OptiScaler engine updated to {tag}', { tag: res.tag }));
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
