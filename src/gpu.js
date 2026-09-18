// Which GPU vendor this machine runs, from Electron's own GPU process -- app.getGPUInfo() --
// rather than wmic or a PowerShell query. Chromium already had to enumerate the adapters to
// draw the window, and it reports the PCI vendor/device IDs of each one, marking the one it
// actually renders on as active. The active one is NOT the one that matters, though: on a hybrid
// laptop Windows runs this app on the iGPU and the games on the discrete card, so the vendor is
// taken from the adapter games use (pickPrimary) and the active one is kept as renderAdapter.
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

// AMD APU graphics by PCI device ID -- Raven/Picasso, Renoir, Lucienne, Cezanne, Van Gogh, Rembrandt
// (680M), Raphael (the desktop Ryzen 7000 iGPU), Mendocino, Phoenix (780M/760M), Strix Point
// (890M/880M), Strix Halo. The name check below covers anything newer; this covers a machine whose
// Win32_VideoController query failed and left only Chromium's IDs.
const AMD_APU_DEVICE_IDS = new Set([0x15dd, 0x15d8, 0x1636, 0x164c, 0x1638, 0x163f, 0x1681, 0x164e, 0x1506, 0x15bf, 0x15c8, 0x150e, 0x1586]);

// Is this adapter the processor's graphics rather than a discrete card? `adapter` is its
// Win32_VideoController row when one matched, for the name.
function isIntegrated(device, adapter = null) {
  const vendor = vendorFromId(device && device.vendorId);
  const name = (adapter && adapter.name) || '';
  // Intel's discrete cards are Arc A-/B-series with a model number ("Intel(R) Arc(TM) A770
  // Graphics"); the Meteor Lake iGPU is plain "Intel(R) Arc(TM) Graphics". Everything else Intel,
  // and an Intel adapter with no name to read, is the iGPU -- which is what the old "first
  // non-Intel" rule assumed too.
  if (vendor === 'intel') return !/\bArc\b.*\b[AB]\d{3}\b/i.test(name);
  if (vendor === 'amd') {
    if (AMD_APU_DEVICE_IDS.has(Number(device.deviceId))) return true;
    // A discrete Radeon is always "RX" or "Pro"; an APU is "Radeon(TM) Graphics", "Radeon 780M",
    // "Radeon Vega 8 Graphics" or "Radeon 8060S". No name: not called integrated on a guess.
    if (!name || /\b(RX|Pro)\b/i.test(name)) return false;
    return /Radeon\s*(\(TM\))?\s*Graphics\s*$/i.test(name) ||
      /Radeon.*\b\d{3}M\b/i.test(name) ||
      /\bVega\s*\d*\s*(Mobile\s*)?Graphics/i.test(name) ||
      /Radeon.*\b\d{4}S\b/i.test(name);
  }
  return false;
}

// The Win32_VideoController row for a Chromium device: same vendor and device ID, or the only row
// of that vendor when the IDs could not be read.
function adapterFor(device, adapters) {
  if (!device || !Array.isArray(adapters)) return null;
  const sameVendor = adapters.filter((a) => a && a.vendorId === Number(device.vendorId));
  return sameVendor.find((a) => a.deviceId != null && a.deviceId === Number(device.deviceId)) ||
    (sameVendor.length === 1 ? sameVendor[0] : null);
}

// The adapter the GAMES will run on, which decides every route in this app -- not the one the
// app's own window renders on.
//
// User report, 2026-09-18: a laptop with an AMD iGPU and an RTX 4060 was treated as an AMD machine.
// Windows runs Electron on the iGPU, Chromium marks that adapter active, and this used to take the
// active one first -- so the vendor came back 'amd' and the whole app followed: the AMD NR route,
// "Neural Rendering needs NVIDIA" on every card, the Luma AMD/Intel pre-tick, body.vendor-amd, and
// no driver check. The old fallback ("first non-Intel") could not have saved it either, since the
// iGPU there is AMD. Intel iGPU + NVIDIA had the same problem whenever Chromium marked Intel active.
//
// So: any NVIDIA adapter wins (DLSS is the point of this app, and a machine that has one runs its
// games on it); then a discrete card over an integrated one (isIntegrated); only then the active
// one; then the first. `adapters` are Win32_VideoController's rows, for names -- and a machine where
// Chromium listed only the adapter it renders on still has its NVIDIA card found there.
function pickPrimary(devices, adapters = []) {
  const list = Array.isArray(devices) ? devices.filter((d) => d && d.vendorId != null) : [];
  const nvidia = list.filter((d) => vendorFromId(d.vendorId) === 'nvidia');
  if (nvidia.length) return nvidia.find((d) => d.active) || nvidia[0];
  const nvidiaRow = (Array.isArray(adapters) ? adapters : []).find((a) => a && vendorFromId(a.vendorId) === 'nvidia');
  if (nvidiaRow) return { vendorId: nvidiaRow.vendorId, deviceId: nvidiaRow.deviceId != null ? nvidiaRow.deviceId : null, active: false, driverVersion: nvidiaRow.driverVersion || null };
  if (list.length === 0) return null;
  const discrete = list.filter((d) => vendorFromId(d.vendorId) !== 'unknown' && !isIntegrated(d, adapterFor(d, adapters)));
  if (discrete.length) return discrete.find((d) => d.active) || discrete[0];
  return list.find((d) => d.active) || list[0];
}

// Display only, plus the names isIntegrated reads. Win32_VideoController names every adapter; match
// on the PCI vendor and device IDs that the PNPDeviceID carries (VEN_1002&DEV_15BF etc.) so a
// laptop's iGPU row is not mistaken for the dGPU.
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
      const d = /DEV_([0-9A-F]{4})/i.exec(a.PNPDeviceID || '');
      return { name: a.Name || null, driverVersion: a.DriverVersion || null, vendorId: m ? parseInt(m[1], 16) : null, deviceId: d ? parseInt(d[1], 16) : null };
    });
  } catch {
    return [];
  }
}

// NVIDIA's own version number, from the one Windows reports.
//
// Win32_VideoController gives "32.0.16.1692"; NVIDIA, its release notes and every error message a
// user will ever read call that 616.92. The two are the same number: drop the dots from the last
// two parts, take the final five digits, and put the point before the last two.
//
// Confirmed against two reports in this project rather than taken on trust. Issue #50: a card
// reported as "driver 32.0.16.1692" whose owner said "Game Ready Driver 616.92". And the Dolphin
// bundle of 2026-09-15, "driver 32.0.16.1664", whose dlss5-feed.log logged "driver 616.64".
function nvidiaDriverBranch(windowsVersion) {
  const parts = String(windowsVersion || '').split('.');
  if (parts.length < 4) return null;
  const digits = `${parts[2]}${parts[3]}`.replace(/\D/g, '');
  if (digits.length < 5) return null;
  const last5 = digits.slice(-5);
  return `${Number(last5.slice(0, 3))}.${last5.slice(3)}`;
}

// The floor for DLSS 5, and it is the DRIVER's own number, not one this app decided. When the
// driver is too old its requirements probe for feature 18 answers OutOfDate and names the version
// it wants, which the Feeder passes straight through (runlog.js reads it as feedDriverOutdated):
//
//   *** The installed NVIDIA driver reports feature 18 as OutOfDate. ... unavailable until the
//   driver is updated to 616.56 or newer. ***
//
// A machine below this does not get a degraded neural pass, it gets none: the model is either
// never created or crashes in its first evaluate, as on DOOM 3 BFG with 610.88 (2026-09-13).
// Until now the app only found out after a game had been run and its log read, one game at a time.
const MIN_NVIDIA_DRIVER = '616.56';

// Compares two NVIDIA branch numbers. Not a string compare and not parseFloat: "616.9" and "616.90"
// are the same release, and parseFloat makes 616.9 look older than 616.56.
function compareDriverBranch(a, b) {
  const part = (v) => {
    const [maj, min] = String(v).split('.');
    return [Number(maj) || 0, Number(String(min || '0').padEnd(2, '0').slice(0, 2)) || 0];
  };
  const [am, an] = part(a);
  const [bm, bn] = part(b);
  return am !== bm ? am - bm : an - bn;
}

// Is this machine's driver too old for DLSS 5? Only ever answered for an NVIDIA driver, and only when
// the version actually parses -- a silent unknown beats a false alarm on the app's front page.
//
// `adapters` is every adapter the machine has (Win32_VideoController's rows and Chromium's devices).
// Until 2026-09-18 only the primary was checked, and the primary was whatever this app's window drew
// on -- the iGPU on an Optimus laptop -- so the too-old-driver banner could never show on exactly the
// laptops whose games run on the NVIDIA card (an RTX 4060 Laptop behind an iGPU). pickPrimary now
// chooses the NVIDIA adapter itself; this fallback still finds one when the caller's vendor or
// version says otherwise, e.g. the primary's driver version could not be read.
function driverStatus({ vendor, driverVersion, adapters = [] } = {}) {
  const none = { checked: false, outdated: false, branch: null, minimum: MIN_NVIDIA_DRIVER };
  let version = vendor === 'nvidia' ? driverVersion : null;
  if (!nvidiaDriverBranch(version)) {
    const isNvidia = (a) => !!a && (a.vendor === 'nvidia' || vendorFromId(a.vendorId) === 'nvidia');
    const other = (Array.isArray(adapters) ? adapters : []).find((a) => isNvidia(a) && nvidiaDriverBranch(a.driverVersion));
    version = other ? other.driverVersion : null;
  }
  const branch = nvidiaDriverBranch(version);
  if (!branch) return none;
  return {
    checked: true,
    outdated: compareDriverBranch(branch, MIN_NVIDIA_DRIVER) < 0,
    branch,
    minimum: MIN_NVIDIA_DRIVER,
  };
}

async function detectGpu(app, execFileAsync) {
  let devices = [];
  try {
    const info = await app.getGPUInfo('basic');
    devices = Array.isArray(info && info.gpuDevice) ? info.gpuDevice : [];
  } catch (error) {
    return { vendor: 'unknown', vendorId: null, deviceId: null, name: null, driverVersion: null, devices: [], error: String(error && error.message ? error.message : error) };
  }
  // Names first: pickPrimary reads them to tell an APU from a discrete Radeon.
  const adapters = await describeAdapters(execFileAsync);
  const primary = pickPrimary(devices, adapters);
  const vendor = primary ? vendorFromId(primary.vendorId) : 'unknown';
  const described = adapterFor(primary, adapters);
  const driverVersion = described ? described.driverVersion : (primary && primary.driverVersion) || null;
  // The adapter this app's own window renders on (Chromium's active one) -- kept for display and
  // diagnosis; it is deliberately not what decides the vendor.
  const active = devices.find((d) => d && d.active) || null;
  const activeRow = adapterFor(active, adapters);

  return {
    vendor,
    vendorId: primary ? primary.vendorId : null,
    deviceId: primary ? primary.deviceId : null,
    name: described ? described.name : null,
    driverVersion,
    devices: devices.map((d) => ({ vendor: vendorFromId(d.vendorId), vendorId: d.vendorId, deviceId: d.deviceId, active: !!d.active })),
    renderAdapter: active
      ? { vendor: vendorFromId(active.vendorId), vendorId: active.vendorId, deviceId: active.deviceId, name: activeRow ? activeRow.name : null }
      : null,
    // The NVIDIA adapter's driver when there is one: pickPrimary picks NVIDIA whenever it is present,
    // and the adapters are the fallback when its own version could not be read (driverStatus).
    driver: driverStatus({ vendor, driverVersion, adapters: [...adapters, ...devices] }),
  };
}

module.exports = { vendorFromId, pickPrimary, isIntegrated, adapterFor, detectGpu, describeAdapters, nvidiaDriverBranch, compareDriverBranch, driverStatus, MIN_NVIDIA_DRIVER };
