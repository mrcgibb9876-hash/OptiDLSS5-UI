let games = [];
let settings = { releaseFolder: '', nrDllPath: '', installedVersion: '', renoDxAddonPath: '', streamlineZipPath: '' };
let editingGameId = null;
let pendingBanner = { appid: null, localPath: null };
let pendingUpdate = null;

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

// Banner art comes only from a locally cached file (downloaded by the main process via
// Steam's appdetails API — see main.js). Guessing fixed CDN paths like /apps/<id>/header.jpg
// does not work reliably: Steam has moved many listings to hash-versioned asset URLs, so those
// fixed paths now 404 for a lot of newer titles.
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

async function renderGrid() {
  grid.innerHTML = '';
  emptyState.classList.toggle('hidden', games.length > 0);
  grid.classList.toggle('hidden', games.length === 0);

  for (const game of games) {
    const status = await window.api.gameStatus(game.exePath);
    const card = document.createElement('div');
    card.className = 'card';

    let badgeClass = 'badge-none';
    let badgeText = 'Not installed';
    if (status.exeMissing) {
      badgeClass = 'badge-missing';
      badgeText = 'Exe missing';
    } else if (status.hasIni && status.hasNr) {
      badgeClass = 'badge-installed';
      badgeText = 'Installed';
    } else if (status.hasIni || status.hasNr) {
      badgeClass = 'badge-partial';
      badgeText = status.hasNr ? 'Missing OptiScaler files' : 'Missing NR file';
    }

    card.innerHTML = `
      <div class="card-banner-wrap">
        <img class="card-banner hidden" alt="${escapeHtml(game.name)}" />
        <span class="card-banner-fallback hidden"></span>
        <span class="card-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(game.name)}</div>
        <div class="card-path" title="${escapeHtml(game.exePath)}">${escapeHtml(game.exePath)}</div>
        <div class="card-path card-recommend" title="Which install path suits this game">Checking graphics API…</div>
        <div class="card-actions">
          <button class="btn btn-primary btn-install">Install / Update</button>
          <button class="btn btn-ghost btn-setup">Run Setup</button>
        </div>
        <div class="card-actions-row2">
          <button class="btn btn-ghost btn-open">Open Folder</button>
          <button class="btn btn-ghost btn-edit">Edit</button>
          <button class="btn btn-ghost btn-danger btn-remove">Remove</button>
        </div>
        <div class="card-actions-row2">
          <button class="btn btn-ghost btn-feeder">Install DLSS 5 Feeder</button>
        </div>
      </div>
    `;

    setBannerWithFallback(game, card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback'));

    // Backfill: games saved before local banner caching only have a Steam appid — cache it now.
    if (!game.bannerLocalPath && game.bannerAppId) {
      window.api.cacheSteamBanner(game.bannerAppId).then((localPath) => {
        if (localPath) {
          game.bannerLocalPath = localPath;
          window.api.saveGames(games);
          setBannerWithFallback(game, card.querySelector('.card-banner'), card.querySelector('.card-banner-fallback'));
        }
      });
    }

    card.querySelector('.btn-install').addEventListener('click', () => installGame(game));
    card.querySelector('.btn-setup').addEventListener('click', () => runSetup(game));
    card.querySelector('.btn-feeder').addEventListener('click', () => installFeeder(game));
    card.querySelector('.btn-open').addEventListener('click', () => window.api.openFolder(game.exePath));
    card.querySelector('.btn-edit').addEventListener('click', () => openGameModal(game));
    card.querySelector('.btn-remove').addEventListener('click', () => removeGame(game));

    applyRecommendation(game, card);

    grid.appendChild(card);
  }
}

// Say which of the two paths this game wants, and make the other one the quieter option.
//
// This is a recommendation, never a lock: the detection reads the exe's imports, and a bundled or
// packed game can hide them, so both buttons stay clickable. What changes is which one looks like
// the answer -- and when nothing could be determined, neither does, because a confident-looking
// wrong answer is worse than an honest "could not tell".
async function applyRecommendation(game, card) {
  const line = card.querySelector('.card-recommend');
  const install = card.querySelector('.btn-install');
  const feeder = card.querySelector('.btn-feeder');

  // Reading a multi-hundred-megabyte exe is not something to repeat on every render, so the answer
  // is kept on the game record.
  let detected = game.detectedPath;

  if (!detected) {
    detected = await window.api.detectPath(game.exePath);
    game.detectedPath = detected;
    window.api.saveGames(games);
  }

  if (!line) return;

  if (detected.recommend === 'optiscaler') {
    line.textContent = `OptiScaler — ${detected.reason}`;
    install.classList.add('btn-primary');
    feeder.classList.remove('btn-primary');
  } else if (detected.recommend === 'feeder') {
    line.textContent = `DLSS 5 Feeder — ${detected.reason}`;
    install.classList.remove('btn-primary');
    feeder.classList.add('btn-primary');
  } else {
    line.textContent = `Not sure — ${detected.reason}. Try OptiScaler first; use the Feeder if it does nothing.`;
    install.classList.add('btn-primary');
    feeder.classList.remove('btn-primary');
  }
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
    const streamlineNote = res.streamline && res.streamline.deployed ? ' Deployed the Streamline SDK for DLSS Frame Gen.' : '';
    toast(`Installed. Copied nvngx_dlssnr.dll (${mb} MB) to ${res.dir}${proxyNote}${configNote}${streamlineNote}`);
  } else {
    toast(`Install failed: ${res.error}`);
  }
  renderGrid();
}

async function runSetup(game) {
  const res = await window.api.runSetup(game.exePath);
  if (!res.ok) toast(res.error);
}

// Prepares local inputs for jlrouzies-fr/DLSS5-Feeder's own installer (a separate ReShade-addon
// toolchain from OptiScaler's own DLSS-NR hook) and copies the command to run it, rather than
// downloading or running the third-party script from this app.
// Runs the Feeder's own installer for this game and shows its output as it goes.
//
// The install takes a couple of minutes and elevates partway through, so a spinner with nothing
// behind it would read as a hang. Every line the script prints goes straight to the toast.
async function installFeeder(game) {
  if (!settings.nrDllPath && !settings.streamlineZipPath) {
    toast('Set your nvngx_dlssnr.dll (or a Streamline zip that contains it) in Settings first — this app will not download NVIDIA\'s DLL for you.');
    openSettingsModal();
    return;
  }

  const stop = window.api.onFeederProgress((update) => {
    if (update.exePath === game.exePath) toast(update.line);
  });

  toast(`Installing the DLSS 5 Feeder toolchain into ${game.name}…`);

  try {
    const res = await window.api.installFeeder({
      exePath: game.exePath,
      nrDllPath: settings.nrDllPath,
      streamlineZipPath: settings.streamlineZipPath,
      renoDxAddonPath: settings.renoDxAddonPath,
      consumer: settings.renoDxAddonPath ? 'RenoDX' : 'DFC'
    });

    if (res.ok) {
      toast(`${game.name}: Feeder toolchain installed.`);
      return;
    }

    // Falling back rather than just reporting: a failure here is often a declined UAC prompt or a
    // machine that will not run a downloaded script, and in both cases the manual route still
    // works. This writes the launcher into the game folder and opens it.
    toast(`Feeder install failed: ${res.error} — setting it up for you to run by hand instead.`);
    await prepareDlss5Feeder(game);
  } finally {
    // Without this every install leaves another listener on the channel, and the fifth install
    // would print every line five times.
    stop();
  }
}

// The manual route, still here for a machine where running a downloaded script from inside the app
// is not wanted, or where the automatic one failed and the user wants to drive it by hand.
async function prepareDlss5Feeder(game) {
  if (!settings.renoDxAddonPath) {
    toast('Set the RenoDX add-on path in Settings first.');
    openSettingsModal();
    return;
  }
  const res = await window.api.prepareDlss5Feeder({
    exePath: game.exePath,
    renoDxAddonPath: settings.renoDxAddonPath,
    streamlineZipPath: settings.streamlineZipPath
  });
  if (!res.ok) {
    toast(`Could not prepare: ${res.error}`);
    return;
  }
  // Command is also copied to the clipboard as a fallback, in case double-clicking the .bat
  // is inconvenient for some reason (e.g. it needs editing first).
  navigator.clipboard.writeText(res.command).catch(() => {});
  toast(res.note);
}

async function removeGame(game) {
  const choice = await window.api.confirmRemove(game.name);
  if (choice === 'cancel') return;

  if (choice === 'remove-and-forget') {
    const res = await window.api.runUninstall(game.exePath);
    if (!res.ok) {
      toast(`Couldn't start the uninstaller: ${res.error}. Removed from the list anyway.`);
    } else {
      toast('Uninstaller opened in a terminal -- confirm there to actually remove the files.');
    }
  }

  games = games.filter((g) => g.id !== game.id);
  window.api.saveGames(games);
  renderGrid();
}

// ---------- Add/Edit Game modal ----------

const gameModal = $('#game-modal');

function openGameModal(game) {
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
}

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

  if (editingGameId) {
    const g = games.find((x) => x.id === editingGameId);
    g.exePath = exePath;
    g.name = name;
    g.bannerAppId = pendingBanner.appid;
    g.bannerLocalPath = pendingBanner.localPath;
  } else {
    games.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      exePath,
      name,
      bannerAppId: pendingBanner.appid,
      bannerLocalPath: pendingBanner.localPath
    });
  }
  await window.api.saveGames(games);
  closeGameModal();
  renderGrid();
});

// ---------- Settings modal ----------

const settingsModal = $('#settings-modal');

function openSettingsModal() {
  $('#settings-release-folder').value = settings.releaseFolder || '';
  $('#settings-nr-dll').value = settings.nrDllPath || '';
  $('#settings-renodx-addon').value = settings.renoDxAddonPath || '';
  $('#settings-streamline-zip').value = settings.streamlineZipPath || '';
  $('#update-status').textContent = settings.installedVersion ? `Installed: ${settings.installedVersion}` : '';
  $('#update-status').className = 'status-line';
  $('#btn-install-update').classList.add('hidden');
  pendingUpdate = null;
  checkReleaseStatus();
  checkNrDllStatus();
  checkRenoDxAddonStatus();
  checkStreamlineZipStatus();
  settingsModal.classList.remove('hidden');
}

function checkRenoDxAddonStatus() {
  const el = $('#renodx-addon-status');
  el.textContent = settings.renoDxAddonPath ? 'Set.' : '';
  el.className = 'status-line status-ok';
}

function checkStreamlineZipStatus() {
  const el = $('#streamline-zip-status');
  el.textContent = settings.streamlineZipPath ? 'Set.' : '';
  el.className = 'status-line status-ok';
}

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
$('#settings-nr-dll').addEventListener('change', (e) => persistNrDll(e.target.value.trim()));

async function persistRenoDxAddon(p) {
  settings.renoDxAddonPath = p;
  $('#settings-renodx-addon').value = p;
  await window.api.saveSettings(settings);
  checkRenoDxAddonStatus();
}

async function persistStreamlineZip(p) {
  settings.streamlineZipPath = p;
  $('#settings-streamline-zip').value = p;
  await window.api.saveSettings(settings);
  checkStreamlineZipStatus();
}

$('#btn-browse-renodx-addon').addEventListener('click', async () => {
  const p = await window.api.pickAddon();
  if (p) persistRenoDxAddon(p);
});
$('#settings-renodx-addon').addEventListener('change', (e) => persistRenoDxAddon(e.target.value.trim()));

$('#btn-browse-streamline-zip').addEventListener('click', async () => {
  const p = await window.api.pickZip('Select a zip with nvngx_dlss.dll / nvngx_dlssnr.dll (and optionally Streamline sl.*.dll files)');
  if (p) persistStreamlineZip(p);
});
$('#settings-streamline-zip').addEventListener('change', (e) => persistStreamlineZip(e.target.value.trim()));

$('#btn-close-settings').addEventListener('click', async () => {
  settingsModal.classList.add('hidden');
  renderGrid();
});

// ---------- auto-sync stale installs ----------
// setup_windows.bat renames OptiScaler.dll to a per-game proxy file (dxgi.dll etc.) and deletes
// itself, so pointing Settings at a newer release does nothing for games already set up -- the
// proxy actually loaded by the game keeps running whatever version it was last renamed from.
// This finds and refreshes it directly, without needing setup_windows.bat re-run.
async function autoSyncStaleGames() {
  if (!settings.releaseFolder || games.length === 0) return;
  const valid = await window.api.validateRelease(settings.releaseFolder);
  if (!valid.valid) return;

  const updated = [];
  const configured = [];
  const streamlined = [];
  const failed = [];
  for (const game of games) {
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

// ---------- Check for updates ----------

$('#btn-check-updates').addEventListener('click', async () => {
  const btn = $('#btn-check-updates');
  const statusEl = $('#update-status');
  btn.disabled = true;
  statusEl.className = 'status-line';
  statusEl.textContent = 'Checking…';
  $('#btn-install-update').classList.add('hidden');

  const res = await window.api.checkUpdate();
  btn.disabled = false;

  if (!res.ok) {
    statusEl.className = 'status-line status-bad';
    statusEl.textContent = `Check failed: ${res.error}`;
    return;
  }

  pendingUpdate = res;
  if (settings.installedVersion === res.tag) {
    statusEl.className = 'status-line status-ok';
    statusEl.textContent = `Up to date (${res.tag}).`;
  } else {
    statusEl.className = 'status-line';
    statusEl.textContent = settings.installedVersion
      ? `Update available: ${res.tag} (installed: ${settings.installedVersion})`
      : `Latest release: ${res.tag} — not installed yet.`;
    $('#btn-install-update').classList.remove('hidden');
  }
});

$('#btn-install-update').addEventListener('click', async () => {
  if (!pendingUpdate) return;
  const btn = $('#btn-install-update');
  const statusEl = $('#update-status');
  btn.disabled = true;
  statusEl.className = 'status-line';
  statusEl.textContent = `Downloading ${pendingUpdate.tag}…`;

  const res = await window.api.installUpdate({
    downloadUrl: pendingUpdate.downloadUrl,
    assetName: pendingUpdate.assetName,
    tag: pendingUpdate.tag,
    targetFolder: settings.releaseFolder
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
  btn.classList.add('hidden');
  checkReleaseStatus();
  refreshBannerVisibility();
  toast(`OptiScaler updated to ${res.tag}`);
  autoSyncStaleGames();
});

// ---------- init ----------

(async function init() {
  const data = await window.api.loadData();
  games = data.games || [];
  settings = data.settings || { releaseFolder: '', nrDllPath: '', installedVersion: '', renoDxAddonPath: '', streamlineZipPath: '' };
  await refreshBannerVisibility();
  await renderGrid();
  autoSyncStaleGames();
})();
