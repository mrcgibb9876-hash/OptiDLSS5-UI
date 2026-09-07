'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, ipcMain } = require('electron');

const { ensureOptiScaler, install: installOptiScaler, checkConflicts } = require('./core/optiscaler');

// Existing helpers in main.js
const userDataDir = () => app.getPath('userData');
const gamesFile = () => path.join(userDataDir(), 'games.json');
const settingsFile = () => path.join(userDataDir(), 'settings.json');

// detectRenderApi function - detects the render API for a game
async function detectRenderApi(gameDir, exePath) {
  // TODO: Implement render API detection (DirectX 12, Vulkan, etc.)
  // Placeholder returns 'dx12' as default
  return 'dx12';
}

ipcMain.handle('game:install', async (_evt, { exePath, releaseFolder, nrDllPath }) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) throw new Error('Game .exe not found');

    // Prepare optiRoot by ensuring we have the pinned OptiScaler release cached
    const cacheRoot = userDataDir();
    const optiRoot = await ensureOptiScaler(cacheRoot);

    const effectiveReleaseFolder = (releaseFolder && fs.existsSync(releaseFolder))
      ? releaseFolder
      : optiRoot;

    // Build config for optiscaler.install
    const api = await detectRenderApi(path.dirname(exePath), exePath);
    const source = { payload: [] };
    // Find the model file in effectiveReleaseFolder (nvngx.dll_dlssnr.dll) and include into source.payload
    const modelPath = fs.existsSync(path.join(effectiveReleaseFolder, 'nvngx.dll_dlssnr.dll'))
      ? path.join(effectiveReleaseFolder, 'nvngx.dll_dlssnr.dll')
      : null;
    if (!modelPath && !nrDllPath) throw new Error('DLSS NR model not provided. Please select nvngx_dlssnr.dll in Settings.');
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

    try {
      checkConflicts(path.dirname(exePath), exePath, null, api);
    } catch (conflictErr) {
      if (conflictErr.code === 'errOptiConflict') {
        throw new Error(`Mod conflict detected: ${conflictErr.message}`);
      }
    }

    const logLines = [];
    const manifest = await installOptiScaler(config, (entry) => logLines.push(entry));

    return { ok: true, manifest, logs: logLines };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
