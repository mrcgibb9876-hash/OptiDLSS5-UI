// Shared scaffolding for the tests: a scratch folder per test file, a fake game exe, a fake
// OptiScaler release folder that passes game:install's own checks, and main.js loaded with
// electron stubbed so its ipcMain handlers can be called directly (the same trick the live
// verification harnesses used while these features were built).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..');

function scratchDir(name) {
  const dir = path.join(os.tmpdir(), 'optidlss5ui-test', `${name}-${process.pid}-${Date.now()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(base, rel, text = 'x') {
  const p = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

// A real PE file for detection to read. notepad.exe on Windows; elsewhere a minimal stub that
// peBitness/peImports simply refuse (tests that need a real PE skip off Windows).
function fakeExe(dir, name = 'Game.exe') {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  const src = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe') : null;
  if (src && fs.existsSync(src)) fs.copyFileSync(src, dest);
  else fs.writeFileSync(dest, 'MZ not a real exe');
  return dest;
}

// The shape game:install validates: setup_windows.bat, an ini with a [DlssNr] section, the DLL,
// the forwarder, and the payload folders the real release ships.
function fakeReleaseFolder(base) {
  const rel = path.join(base, 'release');
  write(rel, 'setup_windows.bat', 'echo setup');
  write(rel, 'setup_linux.sh', '#!/bin/sh');
  write(rel, '!! EXTRACT ALL FILES TO GAME FOLDER !!', '');
  write(rel, 'OptiScaler.ini', '[Upscalers]\nDx11Upscaler=auto\nDx12Upscaler=auto\nVulkanUpscaler=auto\n[FrameGen]\nEnabled=auto\n[Plugins]\nLoadReshade=auto\n[Log]\nLogToFile=auto\nLogLevel=auto\n[DlssNr]\nEnabled=auto\n');
  write(rel, 'OptiScaler.dll', 'fake optiscaler dll OptiScaler');
  write(rel, 'nvngx.dll_dlssnr.dll', 'fake forwarder');
  write(rel, 'OptiScaler/libxess.dll', 'x');
  write(rel, 'Licenses/DirectX_LICENSE.txt', 'x');
  write(rel, 'Licenses/FidelityFX_v2_LICENSE.md', 'x');
  write(rel, 'Licenses/RenoDX_ATTRIBUTION.txt', 'x');
  write(rel, 'Licenses/XeSS_LICENSE.txt', 'x');
  return rel;
}

function fakeNrModel(base) {
  return write(base, 'nvngx_dlssnr.dll', 'fake NR model ' + 'x'.repeat(1024));
}

// Loads src/main.js with electron replaced by stubs. Returns the ipcMain handlers by channel.
// main.js is loaded once per process (Node caches it); later calls only re-point the dialog
// answers, so a test file can confirm one removal and decline the next.
const shared = { handlers: null, userData: null, dialogResponse: 0, openDialogPaths: [] };

function loadMain({ userData, dialogResponse = 0, openDialogPaths = [] } = {}) {
  shared.dialogResponse = dialogResponse;
  shared.openDialogPaths = openDialogPaths;
  if (!shared.handlers) {
    shared.handlers = {};
    shared.userData = userData || scratchDir('userData');
    const stub = {
      app: {
        isPackaged: false,
        getPath: (k) => (k === 'userData' ? shared.userData : path.join(shared.userData, k)),
        getVersion: () => '0.0.0-test',
        whenReady: () => new Promise(() => {}),
        on: () => {}, once: () => {}, quit: () => {}, setAppUserModelId: () => {}, requestSingleInstanceLock: () => true,
      },
      BrowserWindow: class { static getAllWindows() { return []; } },
      ipcMain: { handle: (name, fn) => { shared.handlers[name] = fn; }, on: () => {} },
      dialog: {
        showMessageBox: async () => ({ response: shared.dialogResponse }),
        showOpenDialog: async () => ({ canceled: shared.openDialogPaths.length === 0, filePaths: shared.openDialogPaths }),
        showSaveDialog: async () => ({ canceled: true }),
      },
      shell: { openPath: () => {}, showItemInFolder: () => {}, openExternal: () => {} },
      nativeTheme: {}, Menu: { setApplicationMenu: () => {} },
    };
    const realResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      return request === 'electron' ? 'electron-stub' : realResolve.call(this, request, ...rest);
    };
    require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };
    require(path.join(REPO, 'src', 'main.js'));
  }
  return { handlers: shared.handlers, userData: shared.userData, invoke: (channel, payload) => shared.handlers[channel](null, payload) };
}

function listing(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      out.push(e.isDirectory() ? r + '/' : r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, '');
  return out.sort();
}

module.exports = { REPO, scratchDir, write, fakeExe, fakeReleaseFolder, fakeNrModel, loadMain, listing };
