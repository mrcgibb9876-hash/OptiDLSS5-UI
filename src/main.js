'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { ensureOptiScaler, install: installOptiScaler } = require('./core/optiscaler');

// Existing helpers in main.js
const userDataDir = () => app.getPath('userData');
const gamesFile = () => path.join(userDataDir(), 'games.json');
const settingsFile = () => path.join(userDataDir(), 'settings.json');

ipcMain.handle('game:install', async (_evt, { exePath, releaseFolder, nrDllPath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');
    if (!releaseFolder || !fs.existsSync(releaseFolder)) throw new Error('OptiScaler release folder not set');

    // Prepare optiRoot by ensuring we have the pinned OptiScaler release cached
    const cacheRoot = userDataDir();
    const optiRoot = await ensureOptiScaler(cacheRoot);

    // Build config for optiscaler.install
    const api = await detectRenderApi(path.dirname(exePath), exePath);
    const source = { payload: [] };
    // Find the model file in releaseFolder (nvngx.dll_dlssnr.dll) and include into source.payload
    const modelPath = fs.existsSync(path.join(releaseFolder, 'nvngx.dll_dlssnr.dll'))
      ? path.join(releaseFolder, 'nvngx.dll_dlssnr.dll')
      : null;
    if (!modelPath && !nrDllPath) throw new Error('DLSS NR model not provided');
    if (modelPath) source.payload.push({ name: 'nvngx_dlssnr.dll', path: modelPath });
    if (nrDllPath) source.payload.push({ name: path.basename(nrDllPath), path: nrDllPath });

    const config = {
      gameDir: path.dirname(exePath),
      exePath,
      api,
      optiRoot,
      source,
      profile: {}
    };

    const logLines = [];
    const manifest = await installOptiScaler(config, (entry) => logLines.push(entry));

    return { ok: true, manifest, logs: logLines };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});