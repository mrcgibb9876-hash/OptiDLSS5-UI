// Checks before Install: what on this machine or in this folder is known to break a DLSS 5 install,
// said before the files go in rather than diagnosed from a log afterwards.
//
// Each finding: { id, severity, text, vars, fix }.
//   id        stable, for the renderer's wording and for tests. Never renamed.
//   severity  'block' (Install is not offered), 'warn' (Install anyway is offered), 'info'.
//   text      the English sentence, {placeholders} filled from vars by the renderer's t().
//   fix       null, or one of the two actions this module is allowed to take:
//               { id: 'set-gpu-preference', exes: [...] }  writes Windows' own per-app GPU choice
//               { id: 'open-folder', path }                 opens a folder for the user to act in
//             Nothing else here changes the system; every other finding is words.
//
// The IO lives in gather() (registry, process list, folder listing) and is injected, so evaluate() is
// a pure function of what was gathered and every check has a test with stubbed facts.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const gpu = require('./gpu');
// For gpuSeries only: "NVIDIA GeForce RTX 3080" -> 30. fgsuggest.js reads it from here too.
const rtxmfg = require('./rtxmfg');

const GPU_PREF_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const DPI_KEY = 'HKCU\\Control Panel\\Desktop\\WindowMetrics';

// ── Parsers for what gather() reads ───────────────────────────────────────────────────────────────
// `reg query <key>` lists "    <name>    REG_SZ    <data>". The name is an exe path and may hold
// spaces, so the split is on the type column.
function parseRegValues(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line) || /^\s{2,}(.+?)\s{2,}(REG_\w+)\s*$/.exec(line);
    if (m) out.set(m[1].toLowerCase(), { name: m[1], type: m[2], data: (m[3] || '').trim() });
  }
  return out;
}

// "GpuPreference=2;SwapEffectUpgradeEnable=1;" -> 2. 0 means "let Windows decide", which is what no
// entry means too.
function gpuPreferenceOf(data) {
  const m = /(?:^|;)\s*GpuPreference=(\d+)/i.exec(String(data || ''));
  return m ? Number(m[1]) : 0;
}

// The same string with GpuPreference set, everything else in it kept (Windows keeps other per-app
// graphics settings, such as SwapEffectUpgradeEnable, in the same value).
function withGpuPreference(data, pref = 2) {
  const parts = String(data || '').split(';').map((s) => s.trim()).filter(Boolean).filter((s) => !/^GpuPreference=/i.test(s));
  return [`GpuPreference=${pref}`, ...parts].join(';') + ';';
}

// AppliedDPI is a REG_DWORD, "0x90" = 144 dpi = 150 %. 96 dpi is 100 %.
function scaleFromDpi(data) {
  const s = String(data || '').trim();
  const n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? Math.round((n / 96) * 100) : null;
}

function parseTasklist(stdout) {
  const names = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

// ── The machine: hybrid graphics ──────────────────────────────────────────────────────────────────
// An NVIDIA card plus the processor's own graphics. gpu.isIntegrated decides "integrated" the same
// way the vendor pick does.
function isHybrid(gpuInfo) {
  const devices = (gpuInfo && gpuInfo.devices) || [];
  const hasNvidia = devices.some((d) => d.vendor === 'nvidia' || gpu.vendorFromId(d.vendorId) === 'nvidia');
  const hasIgpu = devices.some((d) => gpu.vendorFromId(d.vendorId) !== 'nvidia' && gpu.vendorFromId(d.vendorId) !== 'unknown' && gpu.isIntegrated(d));
  return hasNvidia && hasIgpu;
}

// ── Checks ────────────────────────────────────────────────────────────────────────────────────────
// facts: {
//   exePath, dir, exes: [exe paths the game runs as -- the launch target, and the probe's real exe],
//   gpuInfo (main.js getGpuInfo), gpuPrefs: Map(lower exe -> data) | null (null = could not read),
//   running: Set(lower image names) | null, folderFiles: [names beside the exe],
//   detected (effective detection), route (route.js), run (runlog.analyzeRun) | null,
//   antiCheat: string|null, antiCheatStub: {...}|null, displayScale: percent|null,
//   ourReShade: bool (a Feeder or Luma deploy of ours owns the ReShade here), probe: probe summary|null,
// }
function evaluate(f) {
  const out = [];
  const add = (id, severity, text, vars = {}, fix = null) => out.push({ id, severity, text, vars, fix });
  const files = (f.folderFiles || []).map((n) => String(n));
  const lower = files.map((n) => n.toLowerCase());
  const running = f.running || new Set();
  const overlaysSeen = new Set((f.probe && f.probe.overlays) || []);

  // a. Hybrid laptop, no per-app GPU choice. Assassin's Creed II (2026-09-18): Intel iGPU + RTX 5070
  // Ti laptop, no preference set -- the game can come up on the iGPU, where NVIDIA's NGX (and so
  // every DLSS route here) does not exist. Windows' own setting (Settings > Display > Graphics) is
  // the registry value this writes; GpuPreference=2 is "High performance".
  if (isHybrid(f.gpuInfo) && f.gpuPrefs) {
    const missing = (f.exes || []).filter((exe) => gpuPreferenceOf(f.gpuPrefs.get(String(exe).toLowerCase()) && f.gpuPrefs.get(String(exe).toLowerCase()).data) !== 2);
    if (missing.length) {
      add('gpu-preference', 'warn',
        'This laptop has an NVIDIA GPU and integrated graphics, and Windows has no graphics preference set for {exe}. It can start on the integrated GPU, where DLSS does not exist. Setting it to High performance makes Windows run it on the NVIDIA GPU.',
        { exe: missing.map((e) => path.win32.basename(e)).join(', ') },
        { id: 'set-gpu-preference', exes: missing });
    }
  }

  // b. Other hooks on the same swapchain.
  // RivaTuner's hooks sit on Present, as ReShade and OptiScaler do; its own guidance for such games
  // is an application profile with detection off.
  if (running.has('rtss.exe') || overlaysSeen.has('RivaTuner Statistics Server')) {
    add('overlay-rtss', 'warn',
      'RivaTuner Statistics Server is running. It hooks the same Present call as OptiScaler and ReShade, and the two stacks together are a known source of crashes at start. Close it, or give {exe} a profile in RTSS with Application detection level set to None.',
      { exe: path.win32.basename(f.exePath || '') });
  }
  if (running.has('msiafterburner.exe')) {
    add('overlay-afterburner', 'info',
      'MSI Afterburner is running. Its on-screen display goes through RivaTuner Statistics Server -- if the game crashes at start, close both and try again.');
  }
  const skFiles = files.filter((n) => /^specialk(32|64)\.dll$/i.test(n));
  if (skFiles.length) {
    add('overlay-specialk', 'warn',
      'Special K is in this game folder ({files}). It replaces the same swapchain OptiScaler hooks; remove it before installing, or the two fight over every frame.',
      { files: skFiles.join(', ') }, { id: 'open-folder', path: f.dir });
  } else if (running.has('skif.exe') || overlaysSeen.has('Special K')) {
    add('overlay-specialk-global', 'warn',
      'Special K is running with global injection (SKIF). Add {exe} to its blacklist, or stop the injection service, before playing with DLSS 5.',
      { exe: path.win32.basename(f.exePath || '') });
  }
  // ReShade that is not ours: a ReShade proxy or ReShade64/32.dll with no Feeder or Luma deploy of
  // this app behind it. Ours is part of the route and is not a finding.
  if (!f.ourReShade) {
    const reshadeFiles = files.filter((n) => /^reshade(32|64)?\.dll$/i.test(n));
    const proxy = f.detected && f.detected.reshadeProxy;
    const list = [...new Set([...(proxy ? [proxy] : []), ...reshadeFiles])];
    if (list.length) {
      add('reshade-foreign', 'warn',
        'Another ReShade is installed in this folder ({files}). This app brings its own where the route needs it; two copies make one of them load late or not at all. Remove the other one first.',
        { files: list.join(', ') }, { id: 'open-folder', path: f.dir });
    }
  }
  const nukem = files.filter((n) => /^dlssg_to_fsr3/i.test(n));
  if (nukem.length) {
    add('dlssg-to-fsr3', 'warn',
      "Nukem's DLSSG-to-FSR3 mod is in this folder ({files}). It replaces DLSS Frame Generation with its own, which collides with OptiScaler's frame-generation handling. Remove its files before installing.",
      { files: nukem.join(', ') }, { id: 'open-folder', path: f.dir });
  }
  // NVIDIA Smooth Motion is frame generation done by the driver: a per-profile setting that only
  // NVAPI's driver-settings interface can read, which this app does not link. The one place it is
  // visible is inside the game, where the Feeder reports it (runlog.js feedSmoothMotion) -- so this
  // fires only after a Feeder run has seen it, and says nothing otherwise.
  if (f.run && f.run.feedSmoothMotion) {
    add('smooth-motion', 'warn',
      'The last run had NVIDIA Smooth Motion on. It generates frames in the driver on top of anything the game does; turn it off for this game in the NVIDIA App before using DLSS 5.');
  }

  // c. Anti-cheat. With a stub to step around (detect.js antiCheatStub) it is the launch that changes
  // and online play that goes; without one, nothing this app installs will load.
  if (f.antiCheat) {
    if (f.antiCheatStub) {
      add('anti-cheat-stub', 'warn',
        '{antiCheat} is part of this game. After Install, Launch starts the game without it (through {stub}\'s own exe) -- single-player only: online play will not work, and going online with these files in place can get the account banned.',
        { antiCheat: f.antiCheat, stub: f.antiCheatStub.stub });
    } else {
      add('anti-cheat', 'block',
        '{antiCheat} protects this game and there is no way to start it without it. It blocks the DLL every DLSS 5 route here relies on, and using one can get the account banned.',
        { antiCheat: f.antiCheat });
    }
  }

  // d. Display scaling above 100 % on the dgVoodoo2 route. Assassin's Creed II (2026-09-18) at 150 %:
  // dgVoodoo2 sized the picture wrong. Words only -- the known fact, not a fix nobody has proven.
  const r = f.route || {};
  const d = f.detected || {};
  const onDgVoodoo = !!(r.legacy && r.legacy.dgVoodoo) && !r.dxvkDeployed && r.wrapperPreference !== 'dxvk';
  const oldApi = ['dx8', 'dx9'].includes(d.api) || (d.legacyApis || []).some((a) => a === 'dx8' || a === 'dx9');
  if (onDgVoodoo && oldApi && f.displayScale && f.displayScale > 100) {
    add('dpi-dgvoodoo', 'warn',
      'Windows display scaling is {scale}%. On the dgVoodoo2 route this has drawn the picture at the wrong size: Assassin\'s Creed II at 150% (2026-09-18). If that happens, set scaling to 100% while playing, or try DXVK instead from Game Help.',
      { scale: String(f.displayScale) });
  }

  // e. Driver too old for DLSS 5 (gpu.js driverStatus: the driver's own floor).
  const drv = f.gpuInfo && f.gpuInfo.driver;
  if (drv && drv.checked && drv.outdated) {
    add('driver-old', 'warn',
      'The NVIDIA driver is {branch}; DLSS 5 needs {minimum} or newer. OptiScaler installs, but Neural Rendering will not start until the driver is updated.',
      { branch: drv.branch, minimum: drv.minimum });
  }

  // f. What the neural pass will cost on this card. Nothing here blocks it, and nothing needs to:
  // the model this app deploys is ShortFuse's 310.8.SF-v2, which supports RTX 20/30/40 (amdnr.js
  // documents that choice), and the engine's NR path has no architecture check at all. So an RTX 30
  // installs and runs -- it is the frame rate that is the problem, and only NVIDIA's model knows why.
  // The numbers are other people's, from public reports rather than measured here, so the text says so.
  // Split at the 40 series because the collapse reported on Ampere is a different order of magnitude
  // from the cost on Ada; claiming one figure for both would be wrong in both directions.
  const card = f.gpuInfo && f.gpuInfo.vendor === 'nvidia' ? (f.gpuInfo.name || '') : '';
  const series = card ? rtxmfg.gpuSeries(card) : null;
  if (series && series <= 30) {
    add('nr-cost-pre-ada', 'warn',
      'Neural Rendering does run on a {card} -- the model this app installs supports RTX 20/30/40 -- but the '
      + 'neural pass costs far more on a card this old than on an RTX 50, which is what the model was built for. '
      + 'An RTX 3080 has been publicly reported dropping from 138 FPS to 4 with it on. Nothing here stops you: '
      + 'install it, and judge it on your own frame rate.',
      { card });
  } else if (series === 40) {
    add('nr-cost-ada', 'info',
      'Neural Rendering runs on a {card}, but the neural pass costs more than it does on an RTX 50, which is '
      + 'what the model was built for. Expect to give up some frame rate for it.',
      { card });
  }

  const rank = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── IO ────────────────────────────────────────────────────────────────────────────────────────────
async function readGpuPrefs(execFileAsync) {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', GPU_PREF_KEY], { windowsHide: true });
    return parseRegValues(stdout);
  } catch (e) {
    // No key at all is "nothing set" (exit code 1, "unable to find"), not "could not read".
    if (/unable to find|ERROR: The system was unable/i.test(String((e && (e.stderr || e.stdout)) || ''))) return new Map();
    return null;
  }
}

async function readDisplayScale(execFileAsync) {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', DPI_KEY, '/v', 'AppliedDPI'], { windowsHide: true });
    const v = parseRegValues(stdout).get('applieddpi');
    return v ? scaleFromDpi(v.data) : null;
  } catch { return null; }
}

async function readRunning(execFileAsync) {
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/NH', '/FO', 'CSV'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return parseTasklist(stdout);
  } catch { return null; }
}

// Gathers everything evaluate() reads. `ctx` comes from main.js (paths, detection, route, GPU, run).
async function gather(ctx, { execFileAsync, detect }) {
  const [gpuPrefs, displayScale, running] = await Promise.all([
    readGpuPrefs(execFileAsync), readDisplayScale(execFileAsync), readRunning(execFileAsync),
  ]);
  let folderFiles = [];
  try { folderFiles = fs.readdirSync(ctx.dir); } catch {}
  return {
    ...ctx,
    gpuPrefs, displayScale, running, folderFiles,
    antiCheat: detect.antiCheatPresent(ctx.dir, ctx.exePath),
    antiCheatStub: detect.antiCheatStub(ctx.dir),
  };
}

async function setGpuPreference(exes, { execFileAsync, prefs = null }) {
  const current = prefs || (await readGpuPrefs(execFileAsync)) || new Map();
  const done = [];
  for (const exe of exes) {
    const existing = current.get(String(exe).toLowerCase());
    const data = withGpuPreference(existing && existing.data, 2);
    await execFileAsync('reg.exe', ['add', GPU_PREF_KEY, '/v', exe, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true });
    done.push({ exe, data });
  }
  return done;
}

module.exports = {
  GPU_PREF_KEY, parseRegValues, gpuPreferenceOf, withGpuPreference, scaleFromDpi, parseTasklist, isHybrid,
  evaluate, gather, readGpuPrefs, readDisplayScale, readRunning, setGpuPreference,
};
