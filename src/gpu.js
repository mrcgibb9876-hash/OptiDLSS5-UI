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
// `adapters` is every adapter the machine has (Win32_VideoController's rows and Chromium's devices),
// because the primary one is not always the NVIDIA one. An Optimus laptop draws this app's window on
// the Intel iGPU, Chromium marks that adapter active, and `vendor` comes back 'intel' -- so until the
// review of 2026-09-18 the too-old-driver banner could never show on exactly the laptops whose games
// run on the NVIDIA card anyway (an RTX 4060 Laptop behind an iGPU, issue #50's machine shape).
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
    // Every adapter, not just the primary: see driverStatus for the Optimus case. Win32_VideoController's
    // rows come first; Chromium's own driverVersion is the fallback there, as it is for the primary.
    driver: driverStatus({
      vendor,
      driverVersion: described ? described.driverVersion : (primary && primary.driverVersion) || null,
      adapters: [...adapters, ...devices],
    }),
  };
}

module.exports = { vendorFromId, pickPrimary, detectGpu, describeAdapters, nvidiaDriverBranch, compareDriverBranch, driverStatus, MIN_NVIDIA_DRIVER };
