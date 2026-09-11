// Which GPU vendor this machine runs, from Electron's own GPU process -- app.getGPUInfo() --
// rather than wmic or a PowerShell query. Chromium already had to enumerate the adapters to
// draw the window, and it reports the PCI vendor/device IDs of each one, marking the one it
// actually renders on as active. That is the same adapter a game will run on, short of a
// laptop's per-app GPU preference, which is why the active flag wins over "the discrete one".
//
// Until this existed the app had no idea what GPU it was on (see the Luma AMD/Intel workaround
// checkbox, which asked the user because guessing was worse). What the vendor changes:
//   - OptiScaler_DLSSNR's Neural Rendering runs through NVIDIA's NGX runtime; on AMD or Intel
//     it installs fine and then does nothing. route.js tells the card so up front.
//   - AMD RX 7000/9000 have a separate route (amdnr.js).
//   - Luma's AMD/Intel ini workaround can be pre-ticked instead of asked.
//
// The vendor is the only thing decided here. The human-readable name and driver version are
// display-only extras, fetched best-effort from Win32_VideoController; failing to get them
// never blocks anything.

const VENDOR_BY_ID = {
  0x10de: 'nvidia',
  0x1002: 'amd',
  0x1022: 'amd',
  0x8086: 'intel',
};

function vendorFromId(vendorId) {
  return VENDOR_BY_ID[Number(vendorId)] || 'unknown';
}

// The adapter Chromium renders on if it says so; otherwise the first non-Intel one (a laptop
// with an iGPU plus a discrete card lists both, and the discrete one is what games use);
// otherwise whatever is first.
function pickPrimary(devices) {
  const list = Array.isArray(devices) ? devices.filter((d) => d && d.vendorId != null) : [];
  if (list.length === 0) return null;
  return list.find((d) => d.active) ||
    list.find((d) => vendorFromId(d.vendorId) !== 'intel') ||
    list[0];
}

// Display only. Win32_VideoController names every adapter; match on the PCI vendor ID that the
// PNPDeviceID carries (VEN_1002 etc.) so a laptop's iGPU row is not mistaken for the dGPU.
async function describeAdapters(execFileAsync) {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, PNPDeviceID | ConvertTo-Json -Compress',
    ], { timeout: 8000 });
    let parsed = JSON.parse(stdout || 'null');
    if (parsed && !Array.isArray(parsed)) parsed = [parsed];
    return (parsed || []).map((a) => {
      const m = /VEN_([0-9A-F]{4})/i.exec(a.PNPDeviceID || '');
      return { name: a.Name || null, driverVersion: a.DriverVersion || null, vendorId: m ? parseInt(m[1], 16) : null };
    });
  } catch {
    return [];
  }
}

async function detectGpu(app, execFileAsync) {
  let devices = [];
  try {
    const info = await app.getGPUInfo('basic');
    devices = Array.isArray(info && info.gpuDevice) ? info.gpuDevice : [];
  } catch (error) {
    return { vendor: 'unknown', vendorId: null, deviceId: null, name: null, driverVersion: null, devices: [], error: String(error && error.message ? error.message : error) };
  }
  const primary = pickPrimary(devices);
  const vendor = primary ? vendorFromId(primary.vendorId) : 'unknown';

  const adapters = await describeAdapters(execFileAsync);
  const described = primary ? adapters.find((a) => a.vendorId === Number(primary.vendorId)) : null;

  return {
    vendor,
    vendorId: primary ? primary.vendorId : null,
    deviceId: primary ? primary.deviceId : null,
    name: described ? described.name : null,
    driverVersion: described ? described.driverVersion : (primary && primary.driverVersion) || null,
    devices: devices.map((d) => ({ vendor: vendorFromId(d.vendorId), vendorId: d.vendorId, deviceId: d.deviceId, active: !!d.active })),
  };
}

module.exports = { vendorFromId, pickPrimary, detectGpu, describeAdapters };
