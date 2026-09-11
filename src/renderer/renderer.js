let games = [];
let settings = { releaseFolder: '', nrDllPath: '', installedVersion: '', streamlineVersion: 'latest' };
let editingGameId = null;
let pendingBanner = { appid: null, localPath: null };
let pendingUpdate = null;
let pendingManagerUpdate = null;

const $ = (sel) => document.querySelector(sel);

const grid = $('#game-grid');
const emptyState = $('#empty-state');
const settingsBanner = $('#settings-banner');

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
    let badgeText = 'Not installed';
    if (status.exeMissing) {
      badgeClass = 'badge-missing';
      badgeText = 'Exe missing';
    } else if (backends.optiscaler) {
      badgeClass = 'badge-installed';
      badgeText = 'OptiScaler';
    } else if (status.hasIni || status.hasNr) {
      badgeClass = 'badge-partial';
      badgeText = status.hasNr ? 'Missing OptiScaler files' : 'Missing NR file';
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
        <div class="card-path" title="${escapeHtml(game.exePath)}">${escapeHtml(game.exePath)}</div>
        <div class="card-path card-recommend" title="Which install path suits this game">Checking graphics API…</div>
        ${(status.warnings || []).map((w) => `<div class="card-warning" title="${escapeHtml(w.message)}">⚠ ${escapeHtml(w.message)}</div>`).join('')}
        <div class="card-actions">
          <button class="btn ${backends.optiscaler ? 'btn-danger' : 'btn-primary'} btn-install">${backends.optiscaler ? 'Remove OptiScaler' : 'Install OptiScaler'}</button>
          <button class="btn btn-ghost btn-setup" title="Optional -- the app already sets up the proxy DLL. Use this for OptiPatcher or spoofing options.">Setup script</button>
        </div>
        <div class="card-actions-row2">
          <button class="btn btn-ghost btn-open">Open Folder</button>
          <button class="btn btn-ghost btn-edit">Edit</button>
          <button class="btn btn-ghost btn-danger btn-remove">Remove</button>
        </div>
      </div>
      </div>
      <div class="card-face card-face-back">
        <div class="card-remove-title"></div>
        <div class="card-remove-detail"></div>
        <div class="card-remove-actions">
          <button class="btn btn-ghost btn-flip-cancel">Cancel</button>
          <button class="btn btn-danger btn-flip-confirm">Remove</button>
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
    } else if (!game.bannerLocalPath && !game.bannerAppId && !game.bannerSearchAttempted) {
      game.bannerSearchAttempted = true;
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

    card.querySelector('.btn-install').addEventListener('click', () => {
      if (backends.optiscaler) {
        flipToConfirm(card, {
          title: 'Remove OptiScaler?',
          detail: 'Removes the files this app installed and puts back anything it renamed. No terminal.',
          onConfirm: async () => {
            const res = await window.api.runUninstall(game.exePath);
            toast(res.ok ? describeUninstall(res) : `Couldn't remove OptiScaler: ${res.error}`);
            renderGrid();
          }
        });
      } else {
        installGame(game);
      }
    });
    card.querySelector('.btn-setup').addEventListener('click', () => runSetup(game));
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
  detected = detected || fresh || { recommend: 'unknown', reason: 'not detected yet' };

  if (!line) return;
  const canRecommendInstall = !backends.optiscaler;
  const badgeClass = detected.recommend === 'unsupported' ? 'engine-badge-unsupported'
    : detected.recommend === 'optiscaler' ? 'engine-badge-known'
    : 'engine-badge-unknown';
  const title = escapeHtml(detected.reason);
  const engineText = detected.engine || (detected.apiBadge ? null : (detected.badge || 'Unknown'));
  const chips = [];
  if (engineText) chips.push(`<span class="engine-badge ${badgeClass}" title="${title}">${escapeHtml(engineText)}</span>`);
  if (detected.apiBadge) chips.push(`<span class="engine-badge api-badge ${badgeClass}" title="${title}">${escapeHtml(detected.apiBadge)}</span>`);

  line.innerHTML = chips.join(' ');

  if (detected.recommend === 'unsupported') {
    install.classList.remove('btn-primary');
  } else if (canRecommendInstall) {
    install.classList.add('btn-primary');
  }
}
function flipToConfirm(card, { title, detail, onConfirm }) {
  card.querySelector('.card-remove-title').textContent = title;
  card.querySelector('.card-remove-detail').textContent = detail;
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
    toast(`Set up the OptiScaler release folder in Settings first (${valid.reason}).`);
    openSettingsModal();
    return;
  }
  const nrValid = await window.api.validateNrDll(settings.nrDllPath);
  if (!nrValid.valid) {
    toast(`DLSS NR file problem: ${nrValid.reason}`);
    openSettingsModal();
    return;
  }
  toast('Installing…');
  const res = await window.api.installGame({
    exePath: game.exePath,
    releaseFolder: settings.releaseFolder,
    nrDllPath: settings.nrDllPath
  });
  if (res.ok) {
    const mb = (res.nrDllBytes / 1024 / 1024).toFixed(0);
    const proxyNote = res.proxyUpdated ? ` Also refreshed the active ${res.proxyUpdated}.` : '';
    const configNote = res.autoConfigured && res.autoConfigured.length > 0
      ? ` Auto-configured for ${res.api || 'detected API'}: ${res.autoConfigured.map((e) => e.key).join(', ')}.`
      : '';
    const streamlineNote = res.streamline && res.streamline.deployed
      ? ` Deployed Streamline ${res.streamline.version || ''} for DLSS Frame Gen.`.replace('  ', ' ')
      : '';
    const reEngineNote = res.reEngine ? ' Detected RE Engine (Capcom).' : '';
    // Named so it's obvious why the upscaler wasn't touched and FrameGen was forced off --
    // the game already does its own DLSS (and DLSS-G where it has it); OptiScaler is only
    // adding Neural Rendering on top, not replacing anything.
    const profileNote = res.profile === 'dlss5-only'
      ? ' Native DLSS detected -- used the "DLSS 5 only" profile (Neural Rendering on the game’s own DLSS, upscaler/frame-gen untouched).'
      : '';

    // The rename is the step that actually hooks the game, so it gets said out loud -- and if it
    // could not happen, that is the difference between "installed" and "installed but inert".
    const proxyCreatedNote = res.proxy && res.proxy.created
      ? ` Hooked it up as ${res.proxy.proxy}${res.proxy.backedUp ? ` (backed up the original as ${res.proxy.backedUp})` : ''}.`
      : res.proxyError
        ? ` NOTE: could not set up the proxy DLL -- ${res.proxyError} Use "Run Setup" to do it by hand.`
        : '';

    // Worth naming rather than folding into a count: two of these are settings that crash the game
    // rather than settings that are merely suboptimal, and one of them was written by an older
    // version of this app, so "corrected" is the honest word for what happened.
    const hotfix = res.reEngineHotfix || [];
    const hotfixNote = hotfix.length
      ? ` Applied the RE Engine hotfix (${hotfix.map((h) => `${h.key}=${h.value}`).join(', ')}).`
      : '';
    // On the install path a REFramework failure now stops the install outright, so this only ever
    // reports the good cases. The error branch stays for the sync path, which patches an existing
    // install and must not pretend a missing prerequisite is fine.
    const reframeworkNote = res.reframework && res.reframework.installed
      ? ' Installed REFramework (required for OptiScaler on RE Engine).'
      : res.reframework && res.reframework.alreadyPresent ? ' REFramework already present.'
      : res.reframework && res.reframework.error
        ? ` WARNING: REFramework is missing (${res.reframework.error}) -- OptiScaler will not run on this game until it is there.`
        : '';
    // Only fires once REFramework has actually generated its config from a prior run of the game --
    // there is nothing to fix on a brand new install.
    const reframeworkConfigNote = res.reframeworkConfig && res.reframeworkConfig.length > 0
      ? ' Set REFramework’s menu key to Insert (it had drifted to Numpad0, unreachable on a laptop) and enlarged its overlay text.'
      : '';
    toast(`Installed. Copied nvngx_dlssnr.dll (${mb} MB) to ${res.dir}${proxyNote}${proxyCreatedNote}${configNote}${streamlineNote}${reEngineNote}${profileNote}${hotfixNote}${reframeworkNote}${reframeworkConfigNote}`);
  } else {
    toast(`Install failed: ${res.error}`);
  }
  renderGrid();
}

// Says what was actually done rather than what was started. The old flow could only report that a
// terminal had opened, which is why the badge and the folder could disagree.
function describeUninstall(res) {
  const removed = (res.removed || []).length ? ` Removed: ${res.removed.join(', ')}.` : ' Nothing left to remove.';
  const kept = (res.kept || []).length ? ` Left alone: ${res.kept.join('; ')}.` : '';
  return `OptiScaler removed.${removed}${kept}`;
}

// The escape hatch. Installing no longer needs this -- the app does the rename itself -- but the
// script also handles OptiPatcher and the spoofing questions, and someone who wants those, or who
// hits the backup refusal, still needs a way to run it.
async function runSetup(game) {
  const res = await window.api.runSetup(game.exePath);
  if (!res.ok) toast(res.error);
}

async function removeGame(game) {
  const choice = await window.api.confirmRemove(game.name);
  if (choice === 'cancel') return;

  if (choice === 'remove-and-forget') {
    const res = await window.api.runUninstall(game.exePath);
    toast(res.ok ? describeUninstall(res) : `Couldn't remove OptiScaler: ${res.error}. Removed from the list anyway.`);
  }

  games = games.filter((g) => g.id !== game.id);
  window.api.saveGames(games);
  renderGrid();
}
const gameModal = $('#game-modal');

async function openGameModal(game) {
  editingGameId = game ? game.id : null;
  $('#game-modal-title').textContent = game ? 'Edit Game' : 'Add Game';
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
  await loadEngineProfileStatus(game);
  await loadFrameGenSection(game);
  await loadInjectorSection(game);
  await loadFeederSection(game);
  await loadOptiFgSection(game);
  await loadLosslessSection(game);
  await loadLumaUeSection(game);
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
    el.textContent = 'OptiScaler has a known compatibility profile built in for this exe.';
  } else {
    el.className = 'status-line';
    el.textContent = 'No compiled-in compatibility profile for this exe -- default OptiScaler configuration.';
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
  status.textContent = `${state.dll}: currently ${state.currentVersion || 'unknown version'}` +
    (state.swapped ? ' (swapped by this app -- original backed up, Restore puts it back)' : '');
}

$('#btn-framegen-swap').addEventListener('click', async () => {
  if (!editingGameId) return;
  const version = $('#game-framegen-version').value;
  if (!version) return toast('Pick a version first.');
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-framegen-status');
  status.textContent = 'Applying…';
  const res = await window.api.frameGenSwap(game.exePath, version);
  if (res.ok && res.swapped) {
    toast(`Swapped ${res.dll} to ${version} (original backed up).`);
  } else {
    toast(res.ok ? `Could not swap: ${res.reason}` : `Swap failed: ${res.error}`);
  }
  loadFrameGenSection(game);
});

$('#btn-framegen-restore').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const res = await window.api.frameGenRestore(game.exePath);
  if (res.ok && res.restored) {
    toast(`Restored ${res.dll} to the game's original.`);
  } else {
    toast(res.ok ? `Nothing to restore: ${res.reason}` : `Restore failed: ${res.error}`);
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
  const feederStatus = await window.api.feederReadiness(game.exePath);
  if (feederStatus.needed) {
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
  toast('Launch option copied -- paste it into Steam → Properties → Launch Options.');
});

$('#btn-injector-launch-now').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-injector-status');
  status.textContent = 'Launching…';
  const res = await window.api.injectorLaunch(game.exePath, settings.releaseFolder);
  status.textContent = res.ok ? 'Launched through the injector.' : `Launch failed: ${res.error}`;
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
  if (!readiness.needed) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  if (!readiness.supported) {
    status.className = 'status-line';
    status.textContent = readiness.reason;
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
    readiness.addonInstalled ? null : 'Feeder add-on',
    readiness.fxInstalled ? null : 'DLSS5_Feed.fx',
    readiness.headersInstalled ? null : 'ReShade.fxh/ReShadeUI.fxh',
    readiness.dlssInstalled ? null : 'nvngx_dlss.dll',
    readiness.dlssnrInstalled ? null : 'nvngx_dlssnr.dll (install this yourself first)',
  ].filter(Boolean);

  status.className = 'status-line';
  updateBtn.classList.add('hidden');

  if (!readiness.complete) {
    status.textContent = `${missing.join(', ')} missing.`;
    return;
  }

  status.textContent = 'Feeder stack fully deployed. Checking for updates…';
  const update = await window.api.feederCheckUpdate(game.exePath);
  if (update.ok && update.checked && !update.upToDate) {
    status.textContent = `Feeder stack deployed (${update.currentVersion} -- ${update.latestVersion} available).`;
    updateBtn.classList.remove('hidden');
  } else if (update.ok && update.checked) {
    status.textContent = `Feeder stack up to date (${update.currentVersion}).`;
  } else {
    status.textContent = 'Feeder stack fully deployed.';
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
      status.textContent = 'Cancelled -- licence not confirmed.';
      return;
    }
  }

  status.textContent = force ? 'Updating…' : 'Deploying…';
  const res = await window.api.feederDeploy(game.exePath, providerId, { force, licenseConfirmed });
  if (res.ok) {
    toast(force
      ? 'Feeder stack updated.'
      : 'Feeder stack deployed. Install OptiScaler normally (Install button) to finish -- not the injector.');
  } else {
    toast(`${force ? 'Update' : 'Deploy'} failed: ${res.error}`);
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
    status.textContent = readiness.reason;
    return;
  }

  checkbox.disabled = false;
  checkbox.checked = !!readiness.enabled;
  status.className = 'status-line';
  status.textContent = readiness.enabled
    ? 'On -- applied to OptiScaler.ini.'
    : 'Off.';
}

$('#game-optifg-toggle').addEventListener('change', async (e) => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-optifg-status');
  status.textContent = 'Applying…';
  const res = await window.api.optiFgSet(game.exePath, e.target.checked);
  if (res.ok) {
    toast(e.target.checked ? 'OptiScaler Frame Generation (FSRFG) enabled.' : 'OptiScaler Frame Generation disabled.');
  } else {
    toast(`Could not change Frame Generation: ${res.error}`);
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
async function configureLossless(game, { frameGenMode = 'LSFG3', mode = 'FIXED', multiplier = 2, target = 120 } = {}) {
  const xmlText = await window.api.losslessReadSettings();
  if (!xmlText) {
    throw new Error("Lossless Scaling hasn't been run yet -- launch it once first, then try again.");
  }

  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error("Could not parse Lossless Scaling's settings file -- it may be from an unexpected version.");
  }

  const profilesEl = doc.querySelector('GameProfiles');
  if (!profilesEl) {
    throw new Error('Unexpected Lossless Scaling settings format (no GameProfiles section).');
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
    if (!template) throw new Error('No existing Lossless Scaling profile to use as a template.');
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

  // The parsed doc already carries its own <?xml ...?> declaration; XMLSerializer re-emits it
  // verbatim. Prepending another one here produced a file with two declarations -- invalid XML,
  // and the actual cause of a "could not parse" failure on the very next read. Found live.
  const newXml = new XMLSerializer().serializeToString(doc);
  const writeResult = await window.api.losslessWriteSettings(newXml);
  if (!writeResult.ok) throw new Error(writeResult.error || 'Failed to write Lossless Scaling settings.');

  return { isNew };
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
    status.innerHTML = 'Lossless Scaling was not found (checked your Steam library). ' +
      'A separate paid app you need to own yourself -- <a href="#" id="lossless-store-link">get it on Steam</a>.';
    const storeLink = $('#lossless-store-link');
    if (storeLink) storeLink.addEventListener('click', (e) => { e.preventDefault(); window.api.losslessOpenStorePage(); });
    configureBtn.disabled = true;
    launchBtn.classList.add('hidden');
    return;
  }
  if (!info.hasRunOnce) {
    status.textContent = "Installed, but hasn't been run yet -- launch it once first.";
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
      ? `Configured -- Adaptive Frame Generation, holding ${currentTarget || '?'} fps.`
      : `Configured -- ${currentMultiplier || '?'}x Frame Generation.`)
    : 'Not yet configured for this game.';
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
  status.textContent = 'Configuring…';
  try {
    const result = await configureLossless(game, { mode, multiplier, target });
    const info = await window.api.losslessDetect();
    if (info.installed) {
      const iniRes = await window.api.losslessSetExePathInGameIni(game.exePath, info.exePath, game.name, { mode, multiplier, target });
      if (!iniRes.ok) toast(`Profile saved, but the in-game panel link was not written: ${iniRes.error}`);
      else if (iniRes.deferred) toast('Profile saved. The in-game panel link will be written when OptiScaler is installed for this game.');
    }
    const what = mode === 'ADAPTIVE' ? `Adaptive Frame Generation, target ${target} fps` : `${multiplier}x Frame Generation`;
    toast(result.isNew
      ? `Added a Lossless Scaling profile for this game (${what}).`
      : `Updated this game's Lossless Scaling profile (${what}).`);

    // Only one frame generator at a time: two of them stack their generated frames. OptiScaler's
    // own FG is ours to switch off; the game's native DLSS Frame Generation is a game setting the
    // hint above (and the in-game panel) tells the user to turn off themselves.
    const optiFg = await window.api.optiFgReadiness(game.exePath);
    if (optiFg.supported && optiFg.enabled) {
      const off = await window.api.optiFgSet(game.exePath, false);
      toast(off.ok
        ? "Turned OptiScaler's own Frame Generation off for this game -- it can't run together with Lossless Scaling."
        : `Could not turn OptiScaler's own Frame Generation off: ${off.error}`);
      loadOptiFgSection(game);
    }
  } catch (error) {
    toast(`Could not configure Lossless Scaling: ${error.message}`);
  }
  loadLosslessSection(game);
});

$('#btn-lossless-launch').addEventListener('click', async () => {
  const res = await window.api.losslessLaunch();
  if (res.ok) {
    toast('Launched Lossless Scaling.');
  } else {
    toast(`Could not launch Lossless Scaling: ${res.error}`);
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

  knownIssue.textContent = readiness.knownIssue || '';
  licenseText.textContent = readiness.licenseSummary || '';
  deployBtn.disabled = !licenseCheckbox.checked;

  status.textContent = readiness.complete
    ? 'Deployed -- select DLSS in Luma\'s own overlay (Home key) in-game.'
    : `Not yet deployed (ReShade64.dll: ${readiness.reshadeInstalled ? 'yes' : 'no'}, ` +
      `addon: ${readiness.addonInstalled ? 'yes' : 'no'}, shaders: ${readiness.shadersInstalled ? 'yes' : 'no'}, ` +
      `nvngx_dlss.dll: ${readiness.dlssInstalled ? 'yes' : 'no'}).`;

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

$('#btn-lumaue-deploy').addEventListener('click', async () => {
  if (!editingGameId) return;
  const game = games.find((x) => x.id === editingGameId);
  const status = $('#game-lumaue-status');
  const licenseConfirmed = $('#game-lumaue-license-confirm').checked;
  if (!licenseConfirmed) return;
  status.textContent = 'Deploying…';
  try {
    const result = await window.api.lumaUeDeploy(game.exePath, { licenseConfirmed });
    if (!result.ok) throw new Error(result.error || 'Deploy failed');
    toast(result.deployed ? 'Deployed Luma UE for this game.' : 'Luma UE was already deployed.');
    if (!result.optiScalerInstalled) {
      toast('OptiScaler is not installed for this game yet -- click Install on its card; Luma only loads through OptiScaler.');
    } else if (result.autoConfigured && result.autoConfigured.some((e) => e.key === 'LoadReshade')) {
      toast('Set [Plugins] LoadReshade=true in OptiScaler.ini so OptiScaler loads Luma.');
    }
    if ($('#game-lumaue-amd-intel').checked) {
      const workaround = await window.api.lumaUeApplyAmdIntelWorkaround(game.exePath);
      if (workaround.ok) toast('Applied the AMD/Intel workaround to OptiScaler.ini.');
      else toast(`Could not apply the AMD/Intel workaround: ${workaround.error}`);
    }
  } catch (error) {
    toast(`Could not deploy Luma UE: ${error.message}`);
  }
  loadLumaUeSection(game);
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
  results.innerHTML = '<div class="steam-result-item">Searching...</div>';
  const items = await window.api.steamSearch(term);
  results.innerHTML = '';
  if (items.length === 0) {
    results.innerHTML = '<div class="steam-result-item">No matches found.</div>';
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
  if (!exePath) return toast('Pick the game .exe first.');
  if (!name) return toast('Give the game a name.');

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
  $('#settings-release-folder').value = settings.releaseFolder || '';
  $('#settings-nr-dll').value = settings.nrDllPath || '';
  $('#update-status').textContent = settings.installedVersion ? `Installed: ${settings.installedVersion}` : '';
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
    status.textContent = 'Checking what RHI has published…';
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
      status.textContent = `Newest available: ${res.versions[0]}`;
    } else {
      status.className = 'status-line';
      status.textContent = 'Could not reach the version list — "Latest" still works, it just resolves at install time.';
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

async function checkReleaseStatus() {
  const el = $('#release-status');
  if (!settings.releaseFolder) {
    el.textContent = '';
    return;
  }
  const res = await window.api.validateRelease(settings.releaseFolder);
  el.textContent = res.valid ? 'Looks good — setup_windows.bat found.' : `Not valid: ${res.reason}`;
  el.className = `status-line ${res.valid ? 'status-ok' : 'status-bad'}`;
}

async function checkNrDllStatus() {
  const el = $('#nr-dll-status');
  if (!settings.nrDllPath) {
    el.textContent = '';
    return;
  }
  const res = await window.api.validateNrDll(settings.nrDllPath);
  el.textContent = res.valid ? `Looks good — ${res.sizeMB} MB.` : `Not valid: ${res.reason}`;
  el.className = `status-line ${res.valid ? 'status-ok' : 'status-bad'}`;
}

$('#btn-settings').addEventListener('click', openSettingsModal);
$('#settings-banner-link').addEventListener('click', (e) => {
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
  const p = await window.api.pickFolder('Select the extracted OptiScaler_DLSSNR release folder');
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
  const failed = [];

  const releaseValid = settings.releaseFolder && (await window.api.validateRelease(settings.releaseFolder)).valid;
  for (const game of games) {
    if (!releaseValid) break;
    const res = await window.api.syncGameIfStale({ exePath: game.exePath, releaseFolder: settings.releaseFolder });
    if (!res.ok) {
      failed.push(`${game.name} (${res.error})`);
      continue;
    }
    if (res.updated) updated.push(game.name);
    if (res.autoConfigured && res.autoConfigured.length > 0) {
      configured.push(`${game.name} (${res.api || 'detected'}: ${res.autoConfigured.map((e) => e.key).join(', ')})`);
    }
    if (res.streamline && res.streamline.deployed) streamlined.push(game.name);
  }

  if (updated.length > 0) {
    toast(`Auto-updated OptiScaler in ${updated.length} game${updated.length > 1 ? 's' : ''}: ${updated.join(', ')}`);
  }
  if (configured.length > 0) {
    toast(`Auto-configured: ${configured.join('; ')}`);
  }
  if (streamlined.length > 0) {
    toast(`Deployed the Streamline SDK (needed for DLSS Frame Gen) to: ${streamlined.join(', ')}`);
  }
  if (failed.length > 0) {
    toast(`Could not auto-update: ${failed.join(', ')} — close the game and retry.`);
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
    toast(`Could not set up the bundled OptiScaler engine: ${res.error}`);
    return false;
  }
  settings.releaseFolder = res.folder;
  settings.installedVersion = bundled.tag;
  await window.api.saveSettings(settings);
  refreshBannerVisibility();
  checkReleaseStatus();
  toast(`OptiScaler engine ${bundled.tag} set up from the installer -- nothing to download.`);
  return true;
}

// The NR model used to be the one file people had to dig out of an NVIDIA driver archive by
// hand. RHI publishes it, so fetch it unless a valid copy is already set.
async function ensureNrModel({ force = false } = {}) {
  if (!force && settings.nrDllPath && (await window.api.validateNrDll(settings.nrDllPath)).valid) return false;
  toast('Fetching the DLSS NR model file (about 165 MB)…');
  const res = await window.api.autoFetchNrDll();
  if (!res.ok) {
    toast(`Could not fetch the DLSS NR model automatically: ${res.error}`);
    return false;
  }
  settings.nrDllPath = res.path;
  await window.api.saveSettings(settings);
  $('#settings-nr-dll').value = res.path;
  checkNrDllStatus();
  refreshBannerVisibility();
  toast(`DLSS NR model ${res.version} fetched (${res.sizeMB} MB).`);
  return true;
}

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
    toast(`Auto-update to ${res.tag} failed: ${installRes.error}`);
    return;
  }

  const hadRelease = !!settings.releaseFolder;
  settings.releaseFolder = installRes.folder;
  settings.installedVersion = res.tag;
  await window.api.saveSettings(settings);
  refreshBannerVisibility();
  checkReleaseStatus();
  toast(hadRelease ? `OptiScaler engine auto-updated to ${res.tag}.` : `Fetched the OptiScaler engine (${res.tag}) automatically.`);
  autoSyncStaleGames();
}
$('#btn-check-updates').addEventListener('click', async () => {
  const btn = $('#btn-check-updates');
  const statusEl = $('#update-status');
  const managerStatusEl = $('#manager-update-status');
  const mismatchEl = $('#manager-update-mismatch');
  btn.disabled = true;
  statusEl.className = 'status-line';
  statusEl.textContent = 'Checking…';
  managerStatusEl.textContent = '';
  mismatchEl.classList.add('hidden');
  $('#btn-install-update').classList.add('hidden');

  const [res, managerRes] = await Promise.all([window.api.checkUpdate(), window.api.checkManagerUpdate()]);
  btn.disabled = false;

  let engineNeedsUpdate = false;
  if (!res.ok) {
    statusEl.className = 'status-line status-bad';
    statusEl.textContent = `Check failed: ${res.error}`;
    pendingUpdate = null;
  } else {
    pendingUpdate = res;
    // Older than GitHub's latest, not merely different: a Manager whose bundle is ahead of the
    // latest release must not offer a downgrade.
    engineNeedsUpdate = !settings.installedVersion || compareTags(settings.installedVersion, res.tag) < 0;
    if (!engineNeedsUpdate) {
      statusEl.className = 'status-line status-ok';
      statusEl.textContent = `Engine up to date (${res.tag}).`;
    } else {
      statusEl.className = 'status-line';
      statusEl.textContent = settings.installedVersion
        ? `Engine update available: ${res.tag} (installed: ${settings.installedVersion})`
        : `Latest engine release: ${res.tag} — not installed yet.`;
    }
  }

  let managerNeedsUpdate = false;
  if (!managerRes.ok) {
    managerStatusEl.className = 'status-line status-bad';
    managerStatusEl.textContent = `Manager check failed: ${managerRes.error}`;
    pendingManagerUpdate = null;
  } else {
    pendingManagerUpdate = managerRes.upToDate ? null : managerRes;
    managerNeedsUpdate = !managerRes.upToDate;
    managerStatusEl.className = managerRes.upToDate ? 'status-line status-ok' : 'status-line';
    managerStatusEl.textContent = managerRes.upToDate
      ? `Manager up to date (v${managerRes.currentVersion}).`
      : `Manager update available: ${managerRes.latestVersion} (running v${managerRes.currentVersion}).`;

    // The real compatibility signal: does the engine actually installed right now match the one
    // THIS Manager build shipped with and was tested against -- not just "are both independently
    // latest", which two asynchronously-released repos don't guarantee. See update:checkManager's
    // own comment in main.js for why.
    // Only an engine OLDER than the one this Manager shipped with is a real mismatch -- newer is
    // the normal state after any engine release, since launch auto-updates past the bundle.
    if (managerRes.bundledEngineTag && settings.installedVersion && compareTags(settings.installedVersion, managerRes.bundledEngineTag) < 0) {
      mismatchEl.classList.remove('hidden');
      mismatchEl.textContent = `Version mismatch: this Manager (v${managerRes.currentVersion}) shipped tested with engine ` +
        `${managerRes.bundledEngineTag}, but the older ${settings.installedVersion} is installed. Update the engine above ` +
        `to bring them back in sync.`;
    }
  }

  // One button covers both from here -- see its own click handler for what "both" means when
  // only the Manager needs it (there's no self-replacing installer, so that half opens the
  // release page instead of downloading silently).
  const installBtn = $('#btn-install-update');
  if (engineNeedsUpdate || managerNeedsUpdate) {
    installBtn.classList.remove('hidden');
    installBtn.textContent = engineNeedsUpdate && managerNeedsUpdate ? 'Update Both'
      : managerNeedsUpdate ? 'Get New Manager'
      : 'Update Engine';
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
    statusEl.textContent = `Downloading ${pendingUpdate.tag}…`;

    const res = await window.api.installUpdate({
      downloadUrl: pendingUpdate.downloadUrl,
      assetName: pendingUpdate.assetName,
      tag: pendingUpdate.tag
    });

    btn.disabled = false;

    if (!res.ok) {
      statusEl.className = 'status-line status-bad';
      statusEl.textContent = `Update failed: ${res.error}`;
      return;
    }

    settings.releaseFolder = res.folder;
    settings.installedVersion = res.tag;
    await window.api.saveSettings(settings);
    $('#settings-release-folder').value = res.folder;
    statusEl.className = 'status-line status-ok';
    statusEl.textContent = `Installed ${res.tag}.`;
    checkReleaseStatus();
    refreshBannerVisibility();
    toast(`OptiScaler engine updated to ${res.tag}`);
    autoSyncStaleGames();
  }

  // No self-replacing installer for the Manager itself (deliberately -- see update:checkManager's
  // own comment in main.js) -- the closest this can do in one click is open the release page for
  // you rather than making you notice and click the separate status line yourself.
  if (pendingManagerUpdate) {
    await window.api.openManagerReleasePage();
    managerStatusEl.className = 'status-line';
    managerStatusEl.textContent = `Opened the release page for ${pendingManagerUpdate.latestVersion} -- install it and relaunch.`;
    toast(`Grab Manager ${pendingManagerUpdate.latestVersion} from the page that just opened, then relaunch.`);
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
  statusEl.textContent = scanDrives ? 'Scanning every drive -- this can take a while…' : 'Scanning…';
  resultsEl.innerHTML = '';
  $('#btn-add-scanned').classList.add('hidden');

  const res = await window.api.scanLibrary({
    scanDrives,
    knownExePaths: games.map((g) => g.exePath)
  });

  btn.disabled = false;

  if (!res.ok) {
    statusEl.className = 'status-line status-bad';
    statusEl.textContent = `Scan failed: ${res.error}`;
    return;
  }

  scanResults = res.games || [];
  scanSelections = {};
  scanResults.forEach((g, i) => { scanSelections[i] = g.exePath; });

  if (scanResults.length === 0) {
    statusEl.className = 'status-line';
    statusEl.textContent = 'No new games found.';
    return;
  }

  statusEl.className = 'status-line status-ok';
  statusEl.textContent = `Found ${scanResults.length} game${scanResults.length > 1 ? 's' : ''}.`;

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
        ${altOptions.length > 1 ? '<p class="field-hint" style="margin: 4px 0 0;">Picked wrong exe? Choose another below.</p>' : ''}
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
    toast(`Added ${added} game${added > 1 ? 's' : ''}.`);
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
  await refreshBannerVisibility();
  await renderGrid();
  await ensureBundledEngine();
  await autoUpdateOptiScalerRelease();
  autoSyncStaleGames();
  // Not awaited: a 165 MB download must not hold up the per-game sync that does not need it.
  ensureNrModel();
})();
