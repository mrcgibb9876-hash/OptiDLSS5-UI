const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveGames: (games) => ipcRenderer.invoke('data:save-games', games),
  saveSettings: (settings) => ipcRenderer.invoke('data:save-settings', settings),

  pickExe: () => ipcRenderer.invoke('pick:exe'),
  pickFolder: (title) => ipcRenderer.invoke('pick:folder', title),
  pickDll: () => ipcRenderer.invoke('pick:dll'),
  pickImage: () => ipcRenderer.invoke('pick:image'),
  scanLibrary: (options) => ipcRenderer.invoke('library:scan', options),
  streamlineVersions: () => ipcRenderer.invoke('streamline:versions'),

  frameGenVersions: () => ipcRenderer.invoke('framegen:versions'),
  frameGenState: (exePath) => ipcRenderer.invoke('framegen:state', exePath),
  frameGenSwap: (exePath, version) => ipcRenderer.invoke('framegen:swap', { exePath, version }),
  frameGenRestore: (exePath) => ipcRenderer.invoke('framegen:restore', exePath),

  injectorReadiness: (releaseFolder) => ipcRenderer.invoke('injector:readiness', { releaseFolder }),
  injectorSteamOption: (releaseFolder) => ipcRenderer.invoke('injector:steamOption', { releaseFolder }),
  injectorLaunch: (exePath, releaseFolder) => ipcRenderer.invoke('injector:launch', { exePath, releaseFolder }),

  optiFgReadiness: (exePath) => ipcRenderer.invoke('optifg:readiness', exePath),
  optiFgSet: (exePath, enabled) => ipcRenderer.invoke('optifg:set', { exePath, enabled }),

  feederReadiness: (exePath) => ipcRenderer.invoke('feeder:readiness', exePath),
  feederMvProviders: () => ipcRenderer.invoke('feeder:mvProviders'),
  feederCheckUpdate: (exePath) => ipcRenderer.invoke('feeder:checkUpdate', exePath),
  feederConfirmProviderLicense: (providerId) => ipcRenderer.invoke('feeder:confirmProviderLicense', providerId),
  feederDeploy: (exePath, mvProviderId, options) => ipcRenderer.invoke('feeder:deploy', { exePath, mvProviderId, ...options }),

  lumaUeReadiness: (exePath) => ipcRenderer.invoke('lumaue:readiness', { exePath }),
  lumaUeDeploy: (exePath, options) => ipcRenderer.invoke('lumaue:deploy', { exePath, ...options }),
  lumaUeApplyAmdIntelWorkaround: (exePath) => ipcRenderer.invoke('lumaue:applyAmdIntelWorkaround', { exePath }),

  losslessDetect: () => ipcRenderer.invoke('lossless:detect'),
  losslessReadSettings: () => ipcRenderer.invoke('lossless:readSettings'),
  losslessWriteSettings: (xmlText) => ipcRenderer.invoke('lossless:writeSettings', xmlText),
  losslessLaunch: () => ipcRenderer.invoke('lossless:launch'),
  losslessOpenStorePage: () => ipcRenderer.invoke('lossless:openStorePage'),
  losslessSetExePathInGameIni: (exePath, losslessExePath, gameTitle) => ipcRenderer.invoke('lossless:setExePathInGameIni', { exePath, losslessExePath, gameTitle }),

  steamSearch: (term) => ipcRenderer.invoke('steam:search', term),
  validateRelease: (folder) => ipcRenderer.invoke('release:validate', folder),
  validateNrDll: (filePath) => ipcRenderer.invoke('nrdll:validate', filePath),

  gameStatus: (exePath) => ipcRenderer.invoke('game:status', exePath),
  detectPath: (exePath) => ipcRenderer.invoke('game:detect-path', exePath),
  installGame: (payload) => ipcRenderer.invoke('game:install', payload),
  syncGameIfStale: (payload) => ipcRenderer.invoke('game:sync-if-stale', payload),
  runSetup: (exePath) => ipcRenderer.invoke('game:run-setup', exePath),
  runUninstall: (exePath) => ipcRenderer.invoke('game:run-uninstall', exePath),
  openFolder: (exePath) => ipcRenderer.invoke('game:open-folder', exePath),

  confirmRemove: (gameName) => ipcRenderer.invoke('game:confirm-remove', gameName),

  cacheSteamBanner: (appid, fallbackImageUrl) => ipcRenderer.invoke('banner:cache-steam', { appid, fallbackImageUrl }),
  importLocalBanner: (sourcePath) => ipcRenderer.invoke('banner:import-local', sourcePath),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: (payload) => ipcRenderer.invoke('update:install', payload),
  checkManagerUpdate: () => ipcRenderer.invoke('update:checkManager'),
  openManagerReleasePage: () => ipcRenderer.invoke('update:openManagerReleasePage'),

  engineHasKnownProfile: (exePath) => ipcRenderer.invoke('engine:hasKnownProfile', { exePath })
});
