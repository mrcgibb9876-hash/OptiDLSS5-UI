const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveGames: (games) => ipcRenderer.invoke('data:save-games', games),
  saveSettings: (settings) => ipcRenderer.invoke('data:save-settings', settings),

  pickExe: () => ipcRenderer.invoke('pick:exe'),
  pickFolder: (title) => ipcRenderer.invoke('pick:folder', title),
  pickDll: () => ipcRenderer.invoke('pick:dll'),
  pickZip: (title) => ipcRenderer.invoke('pick:zip', title),
  pickImage: () => ipcRenderer.invoke('pick:image'),

  // Finds installed games. scanDrives walks every fixed drive and is slow, so the UI keeps it
  // behind a checkbox that is off by default.
  scanLibrary: (options) => ipcRenderer.invoke('library:scan', options),

  steamSearch: (term) => ipcRenderer.invoke('steam:search', term),
  validateRelease: (folder) => ipcRenderer.invoke('release:validate', folder),
  validateNrDll: (filePath) => ipcRenderer.invoke('nrdll:validate', filePath),

  gameStatus: (exePath) => ipcRenderer.invoke('game:status', exePath),

  // Whether OptiScaler can hook this game, or "could not tell". Cached on the game record by the
  // renderer, since it reads the whole exe.
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
  installUpdate: (payload) => ipcRenderer.invoke('update:install', payload)
});
