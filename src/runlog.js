// What happened the last time this game ran -- read from the logs our own stack writes beside
// the exe, so the card can say "NR ran" or name the failure instead of leaving the user to open
// OptiScaler.log. Every verdict here is a signature that was met on a real install:
//
//   duplicate-dlss     the Feeder's CreateFeature faulted with two DLSS DLLs loaded (Code Vein 2,
//                      Mortal Shell II: a Feeder on a game that ships DLSS in its plugin tree)
//   shutdown-fault     NVIDIA's own Shutdown1 faulted while the Feeder's private session was
//                      live (same folders, on the way down)
//   ue-crash           Unreal's crash reporter wrote a report within minutes of the run
//   driver-outdated    the NVIDIA driver reports DLSS 5 (feature 18) as OutOfDate; the Feeder names
//                      the minimum version (DOOM 3 BFG on 610.88, needs 616.56)
//   nr-model-crash     the neural model crashed inside the Feeder's evaluate, which then stopped
//                      (Dolphin on DX12, same device; Armored Core VI before it)
//   feed-stopped       the Feeder gave up ("The feed stops here") -- its own diagnosis follows
//   nr-ran             the Neural Rendering pass dispatched; count and fps if the Feeder timed it
//   dlss-no-nr         a DLSS feature was created but NR never dispatched (a D3D11 feature on
//                      the native path: Dx11Upscaler must be dlss_12 -- Fallen Order + Luma)
//   init-no-feature    NGX initialised but no feature was ever created (Luma: DLSS not selected
//                      in its overlay; Feeder: its shader technique missing)
//   no-dlss            nothing called DLSS at all (nothing to hook, or the proxy did not load)
//   wrapper-crash      the game crashed inside a DirectX 8/9 wrapper in its own folder as it started
//                      (dgVoodoo2's D3D9.dll on Castlevania: Lords of Shadow 2)
//
// Bounded reads (first few MB of each log) so a card render never stalls on a huge log.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { optiScalerRuntimeApi } = require('./detect');

const MAX_READ = 6 * 1024 * 1024;

async function readHead(file, max = MAX_READ) {
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch { return null; }
  try {
    // Sized to the log, not to the cap. Buffer.alloc(6 MB) zero-filled six megabytes on every
    // call for a log that is usually a few dozen kilobytes, and this runs for every card.
    const size = Math.min((await fh.stat()).size, max);
    if (size <= 0) return '';
    const buf = Buffer.allocUnsafe(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead).toString('latin1');
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

const count = (text, re) => (text.match(re) || []).length;

// Unreal's crash reporter writes under %LOCALAPPDATA%\<Project>\Saved\Crashes\; the project is
// the folder two above Binaries\Win64. Only a report from around the last run counts.
function unrealCrashNear(dir, whenMs) {
  const parts = dir.split(/[\\/]/);
  const i = parts.findIndex((p) => /^binaries$/i.test(p));
  if (i < 1) return null;
  const project = parts[i - 1];
  const crashes = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), project, 'Saved', 'Crashes');
  let dirs = [];
  try { dirs = fs.readdirSync(crashes, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return null; }
  let best = null;
  for (const e of dirs) {
    const p = path.join(crashes, e.name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (Math.abs(st.mtimeMs - whenMs) > 15 * 60 * 1000) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
  }
  if (!best) return null;
  let message = null;
  try {
    const xml = fs.readFileSync(path.join(best.path, 'CrashContext.runtime-xml'), 'latin1');
    const m = /<ErrorMessage>([^<]{0,300})/.exec(xml);
    if (m) message = m[1].trim();
  } catch {}
  return { path: best.path, at: new Date(best.mtimeMs).toISOString(), message };
}

// The Feeder records the first access violation in the process with the module it happened in:
//
//   ### EXCEPTION RECORDED ###  exception 0xC0000005 (reading address 00000000) at 69611E10 in
//   D:\Games\Castlevania Lords of Shadow 2\bin\d3d9.dll; this add-on was last doing: nothing yet
//
// A fault inside a DirectX 8/9 wrapper DLL sitting in the game folder -- dgVoodoo2's D3D8.dll or
// D3D9.dll on the legacy route -- is the wrapper failing as the game starts, before the Feeder or
// OptiScaler has done anything (Castlevania: Lords of Shadow 2, 2026-09-14: a null D3D11 device
// inside Direct3DCreate9). Only a DLL in the game folder counts; System32's d3d9.dll is Windows'.
function wrapperFault(feed, dir) {
  const m = /### EXCEPTION RECORDED ###[^\r\n]*? in ([A-Za-z]:[\\/][^\r\n;]*?[\\/](d3d8|d3d9|ddraw|d3dimm)\.dll)\s*;/i.exec(feed);
  if (!m) return null;
  if (path.resolve(path.dirname(m[1])).toLowerCase() !== path.resolve(dir).toLowerCase()) return null;
  return path.basename(m[1]);
}

// Every MV and depth probe the Feeder wrote, reduced to "did this run ever see real motion / real
// depth". Menu frames read as neither, so a single bad probe proves nothing; one good one proves
// the pipeline works.
//
//   [feed] MV probe (centre 64x64, frame 600): mean |mv| 23.771 px, max 50.39 px, 96% non-zero
//   [feed] Depth probe (4x 32x32, frame 600): min 0.979905, max 0.996492, mean 0.987, variance 4.91e-05
//
// The thresholds sit above what a still scene measures and well below real movement. Standing in a
// 3D scene without moving read 0.36 px mean / 2.12 px max on Tomb Raider I-III; walking read 23.8 /
// 50.4. Depth in that game spans ~0.017 between near and far geometry while a menu reads exactly
// flat, so any spread at all is the signal -- the absolute values are meaningless, since a
// perspective z-buffer crowds everything against 1.0.
const MOTION_MEAN_PX = 1.0;
const MOTION_MAX_PX = 4.0;
const DEPTH_SPREAD = 1e-4;

function probeReadings(feed) {
  const motion = [...String(feed).matchAll(/MV probe[^\r\n]*?mean \|mv\| ([\d.]+) px, max ([\d.]+) px/g)];
  const depth = [...String(feed).matchAll(/Depth probe[^\r\n]*?min ([\d.eE+-]+), max ([\d.eE+-]+)/g)];
  return {
    sawMotion: motion.some((m) => Number(m[1]) >= MOTION_MEAN_PX || Number(m[2]) >= MOTION_MAX_PX),
    sawDepth: depth.some((m) => Math.abs(Number(m[2]) - Number(m[1])) >= DEPTH_SPREAD),
  };
}

// optiDir: where OptiScaler (and its log) lives when that is not the game folder -- a 32-bit game's
// DLSS work runs in the Feeder's 64-bit helper, in host64\ beside it (legacy.js). The Feeder's own
// log stays beside the game.
async function analyzeRun(dir, { optiDir = dir } = {}) {
  const optiPath = path.join(optiDir, 'OptiScaler.log');
  const feedPath = path.join(dir, 'dlss5-feed.log');
  const feed = (await readHead(feedPath)) || '';
  const wrapperCrash = wrapperFault(feed, dir);
  let stat = null;
  try { stat = fs.statSync(optiPath); } catch {}
  let feedStat = null;
  try { feedStat = fs.statSync(feedPath); } catch {}
  if (!stat) {
    // No OptiScaler.log is not the same as no run. A wrapper that crashes the game at startup leaves
    // none (on the 32-bit route the helper that would write it never starts), and neither does an
    // OptiScaler whose ini never had LogToFile switched on -- a DOOM 3 BFG install (2026-09-13) whose
    // Feeder log held a whole run, the crash and the reason, while Game Help waited for "a run". When
    // the Feeder actually fed frames (or a wrapper in the game folder faulted), its log is the run.
    const feedRan = !!wrapperCrash || /first frame fed/.test(feed);
    if (!feedStat || !feedRan) return { ran: false, verdict: 'no-log' };
    stat = feedStat;
  } else if (feedStat && feedStat.mtimeMs > stat.mtimeMs) {
    // The Feeder's log is rewritten every launch; the helper's OptiScaler.log is not, so after a
    // crash it can be the older of the two. The run is as recent as the newer one.
    stat = feedStat;
  }
  const opti = (await readHead(optiPath)) || '';

  const runtime = await optiScalerRuntimeApi(optiDir);
  const nrDispatch = count(opti, /DlssNr_(?:Dx12|Vk)::Dispatch DLSS-NR (?:running|composition)/g);
  const nrComposition = count(opti, /DLSS-NR composition:/g);
  const dlssCreated = count(opti, /NVSDK_NGX_D3D1[12]_CreateFeature Creating new DLSS feature|NVSDK_NGX_VULKAN_CreateFeature Creating new DLSS feature|TryCreateOptiFeature Creating OptiScaler feature/g);
  const dlssInit = /NVSDK_NGX_(?:D3D1[12]|VULKAN)_Init/.test(opti);
  const d3d11NativeFeature = /DLSSFeatureDx11::InitInternal/.test(opti);
  // OptiScaler's own load-time check, one line into the log: no nvngx_dlss.dll beside the exe, so
  // it turns DLSS off for the whole session before the game has drawn anything. Every route this
  // app builds needs that file there -- the Feeder's synthetic call, REFramework's pd-upscaler
  // (PureDark's plugin loads the runtime from the game folder), and a DLSS-5-only profile alike.
  // Seen in the wild on a Resident Evil 2 install whose log otherwise looked healthy.
  const dlssRuntimeMissing = /nvngx_dlss\.dll not found, disabling DLSS/.test(opti);
  const cleanExit = /DLL_PROCESS_DETACH/.test(opti);
  const shutdownFault = /faulted inside its own NVSDK_NGX_D3D12_Shutdown1/.test(opti);
  const logLevel = (/Log\.LogLevel: (\d)/.exec(opti) || [])[1];

  // OptiScaler could not create the upscaler it was configured for and quietly used another. Two
  // [E] lines it always writes, whatever the log level -- the NGX result, then the substitution:
  //
  //   [E] DLSSFeatureDx12::InitDLSS _CreateFeature result: BAD0000B
  //   [E] TryCreateOptiFeature Feature 'DLSS' initialization failed falling back to FSR 2.1.2
  //
  // This matters because the neural pass runs either way: DLSS-NR dispatches on top of whatever
  // upscaled, so the run reads as a clean "DLSS 5 ran" while the game is not running DLSS at all.
  // On Resident Evil 2 (REFramework + PureDark's plugin, 2026-09-13) DLSS creation failed on every
  // launch, every OptiScaler build tried, and the FSR fallback it landed on is the path that then
  // crashed -- none of which was visible anywhere in this app.
  const srFallback = /TryCreateOptiFeature Feature '([^']+)' initialization failed falling back to ([^\r\n]+)/.exec(opti);
  const srBackendFallback = srFallback ? { from: srFallback[1], to: srFallback[2].trim() } : null;
  // The NGX result behind it, kept verbatim: BAD0000B is FAIL_UnableToInitializeFeature, and the
  // code is the one thing a bug report upstream needs.
  const srCreateResult = (/_CreateFeature result: ([0-9A-Fa-f]{8})/.exec(opti) || [])[1] || null;
  // Every frame handed to the upscaler was dropped on the floor. OptiScaler refuses to dispatch
  // when it cannot put the root signature back (D3D12_Hooks.cpp CanRestoreRootSignature), which on
  // the pd-upscaler route is always: the DLSS call arrives on PureDark's own command list, which
  // never carries a root signature for it to track. The output texture is never written, so the
  // game presents a black frame while running normally behind it. LOG_DEBUG, so it is only in the
  // log at LogLevel 0 or 1 -- absence here is not evidence of absence.
  const upscaleSkipped = count(opti, /Skipping upscaling because can't restore root signature/g);

  // How far the run got. Both logs print a line per build and a milestone every 600 frames, so
  // counting lines measured log volume, not work: a Grid 2 run with 1,800 neural frames read as
  // "10 passes" (2026-09-15). The highest milestone is the real figure.
  const maxNumber = (text, re) => [...text.matchAll(re)].reduce((m, x) => Math.max(m, Number(x[1]) || 0), 0);
  const nrFrames = maxNumber(opti, /DLSS-NR heartbeat: (\d+) frames run/g);
  const feedFrames = maxNumber(feed, /frame (\d+) delivered/g);
  const feedCreateFault = /CreateFeature raised 0xC0000005/.test(feed);
  const feedTwoCopies = /two copies of the DLSS NGX module are loaded/.test(feed);
  const feedStopped = /The feed stops here/.test(feed);
  const feedTechniqueMissing = /effects: .*technique MISSING/.test(feed) && !/technique found/.test(feed);
  const fpsMatch = [...feed.matchAll(/frame interval [\d.]+ ms \(([\d.]+) fps\)/g)].pop();
  const fps = fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : null;

  // The Feeder's own diagnoses, lifted from its log rather than re-derived here. Each is a line
  // the add-on writes itself (its dlss5-feed.cpp: the MV/depth probes every 600 frames, the
  // motion-vector problem warning, and the Agility SDK report on a failed device create), and
  // each describes a run where everything looks installed and DLSS still gets nothing:
  //
  //   invalidRedist  D3D12_ERROR_INVALID_REDIST (0x887E0003). A game whose exe exports
  //                  D3D12SDKPath/D3D12SDKVersion -- which Unity titles commonly do -- points
  //                  Direct3D 12 at its own D3D12\ redist folder for EVERY device created in the
  //                  process, including the Feeder's private one. If that folder is empty or
  //                  holds the wrong version, the create fails and no session ever opens, while
  //                  the game itself (on D3D11) never notices. The Feeder's README calls the
  //                  rename test: move D3D12\ aside and relaunch.
  //   mvProblem      The Feeder's own sentence for the four motion-vector failures: the provider
  //                  is not installed, it failed to compile, it is installed but disabled, or a
  //                  different one is enabled than DLSS5_MV_PROVIDER selects. Kept verbatim --
  //                  it names the provider and quotes ReShade's compile error.
  //   noMotion       The MV probe measured under 2% non-zero vectors: DLSS is reconstructing
  //                  from a still image, which looks sharp until you move.
  //   depthFlat      The depth probe read flat. Flat while the vectors show the scene moving is a
  //                  real diagnosis (Generic Depth is bound to the wrong buffer -- the usual
  //                  Unity failure); flat on its own can just be a menu.
  const feedInvalidRedist = /D3D12_ERROR_INVALID_REDIST|0x887E0003/i.test(feed);
  const feedMvProblem = (/\[feed\] ((?:DLSS5_Feed\.fx is compiled for motion-vector provider|motion-vector provider )[^\r\n]+)/.exec(feed) || [])[1] || null;
  // Both annotations are written the moment a single probe reads low, and the Feeder takes its
  // first probe at frame 600 -- which in almost every game is the main menu, where nothing moves
  // and nothing has depth. Taken at face value they made "DLSS is getting no motion vectors" the
  // verdict for any session that started at a menu, which is every session.
  //
  // Tomb Raider I-III Remastered, 2026-09-16: reported feed-no-motion on a run whose own probes
  // measured 23.8 px mean and 50.4 px max once the player was actually moving. So a probe that
  // ever saw real motion settles it -- the annotation only stands if none did.
  const probes = probeReadings(feed);
  const feedNoMotion = /DLSS is getting \(almost\) no motion vectors/.test(feed) && !probes.sawMotion;
  const feedDepthFlatMoving = /depth is FLAT while the scene moves/.test(feed);
  const feedDepthFlat = feedDepthFlatMoving || (/sampled depth is flat/.test(feed) && !probes.sawDepth);
  // The neural model crashed inside the Feeder's evaluate and the Feeder stopped feeding:
  //
  //   [feed] evaluate raised 0xC0000005 (reading address FFFFFFFFFFFFFFFF) (caught; nothing submitted)
  //   [feed] evaluate fault stack, by module (innermost first): D3D12Core.dll <- nvngx_dlssnr.dll <- ...
  //   stopped: the DLSS evaluate crashed (...)
  //
  // OptiScaler.log stops at "white point meter up" with DLSS created and no neural pass, which read as
  // the unexplained dlss-no-nr (Dolphin, DX12, RTX 5070 Ti, driver 616.64, 2026-09-15). The same
  // signature on Armored Core VI was the driver refusing to launch the model's CUDA kernel
  // (NvAPI_Status=-1) on the game's own D3D12 device.
  const feedEvaluateCrash = /\[feed\] evaluate raised 0x[0-9A-F]{8}|stopped: the DLSS evaluate crashed/i.test(feed);
  const feedFaultStack = (/evaluate fault stack, by module \(innermost first\): ([^\r\n]+)/.exec(feed) || [])[1] || null;
  const feedSameDevice = /transport same-device D3D12/.test(feed);
  // The driver itself says DLSS 5 cannot run: the Feeder's requirements probe for feature 18 came
  // back OutOfDate, and the Feeder names the minimum version.
  //
  //   *** The installed NVIDIA driver reports feature 18 as OutOfDate. ... unavailable until the
  //   driver is updated to 616.56 or newer. ***
  //
  // Nothing else in a run like that means anything: the model is either never created or, as on
  // DOOM 3 BFG with driver 610.88 (2026-09-13), crashes in its first evaluate.
  const driverMatch = /feature 18 as OutOfDate[^\r\n]*?updated to ([\d.]+)/.exec(feed);
  const feedDriverOutdated = driverMatch ? driverMatch[1] : (/feature 18[^\r\n]*0xBAD0000C \(OutOfDate\)/.test(feed) ? '' : null);
  const driverVersion = (/\bdriver (\d{3}\.\d{2})\b/.exec(feed) || [])[1] || null;
  // NVIDIA Smooth Motion in the game process: the Feeder warns about it itself.
  const feedSmoothMotion = /NVIDIA Smooth Motion is active in this process/.test(feed);

  const crash = unrealCrashNear(dir, stat.mtimeMs);

  let verdict;
  let detail = null;
  // First: a game that died in its own DirectX wrapper as it started ran nothing else worth judging,
  // whatever an older OptiScaler.log still says.
  if (wrapperCrash) { verdict = 'wrapper-crash'; detail = wrapperCrash; }
  // A driver too old for DLSS 5 explains every other symptom in the run, so it is named first.
  else if (feedDriverOutdated !== null) { verdict = 'driver-outdated'; detail = feedDriverOutdated || null; }
  else if (feedCreateFault && feedTwoCopies) verdict = 'duplicate-dlss';
  else if (shutdownFault) verdict = 'shutdown-fault';
  else if (crash && !cleanExit) { verdict = 'ue-crash'; detail = crash.message; }
  // Before feed-stopped and before nr-ran: a session that never opened for this reason, and a
  // neural pass running on empty guides, both otherwise read as "no DLSS" or as a clean run.
  else if (feedInvalidRedist) verdict = 'feed-agility-redist';
  else if (feedMvProblem || feedNoMotion) { verdict = 'feed-no-motion'; detail = feedMvProblem; }
  else if (feedDepthFlatMoving) verdict = 'feed-depth-flat';
  // Before feed-stopped: the Feeder gave up because the model crashed, and saying which is the point.
  else if (feedEvaluateCrash) { verdict = 'nr-model-crash'; detail = feedFaultStack; }
  else if (feedStopped) verdict = 'feed-stopped';
  // Both of these outrank nr-ran deliberately. The neural pass dispatching says the plumbing is
  // intact; it does not say the frame reached the screen, or that DLSS did the upscaling. A run
  // that skipped every upscale is the black screen, and a run on a substituted backend is not the
  // thing the user installed -- calling either of them "DLSS 5 ran" is how this went unseen.
  else if (upscaleSkipped > 0) { verdict = 'upscale-skipped'; detail = String(upscaleSkipped); }
  else if (srBackendFallback) { verdict = 'sr-backend-fallback'; detail = srBackendFallback.to; }
  else if (nrDispatch > 0) verdict = 'nr-ran';
  else if (dlssCreated > 0) { verdict = 'dlss-no-nr'; detail = d3d11NativeFeature ? 'd3d11-native' : null; }
  else if (dlssInit) { verdict = 'init-no-feature'; detail = feedTechniqueMissing ? 'feeder-technique-missing' : null; }
  else verdict = 'no-dlss';

  return {
    ran: true,
    at: stat.mtime.toISOString(),
    runtimeApi: runtime ? runtime.api : null,
    nrDispatch,
    nrFrames,
    nrComposition,
    dlssCreated,
    fps,
    feedFrames,
    feedEvaluateCrash,
    feedSameDevice,
    feedSmoothMotion,
    feedDriverOutdated,
    driverVersion,
    optiLogMissing: !opti,
    cleanExit,
    logLevel: logLevel ? Number(logLevel) : null,
    crash,
    dlssRuntimeMissing,
    srBackendFallback,
    srCreateResult,
    upscaleSkipped,
    feedInvalidRedist,
    feedMvProblem,
    feedNoMotion,
    feedDepthFlat,
    feedDepthFlatMoving,
    wrapperCrash,
    verdict,
    detail,
  };
}

const BUNDLE_FILES = ['OptiScaler.log', 'OptiScaler.ini', 'ReShade.log', 'ReShade.ini', 'ReShadePreset.ini', 'dlss5-feed.log', 'dlss5-feed.cfg', '.optiscaler-manager-install.json', '.dlss5ui-feeder-deploy.json', '.dlss5ui-lumaue-deploy.json', '.dlss5ui-api.json', '.dlss5ui-lossless.json', '.dlss5ui-legacy.json'];

function folderListing(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
      let size = '';
      let mtime = '';
      try { const st = fs.statSync(path.join(dir, e.name)); size = e.isDirectory() ? '<dir>' : String(st.size); mtime = st.mtime.toISOString(); } catch {}
      return `${mtime}  ${size.padStart(12)}  ${e.name}`;
    });
  } catch {
    return [];
  }
}

// Everything a helper needs to see, in one folder -> zip: our logs and inis, the newest Unreal
// crash report, a listing of the exe folder, and the detection/route/verdict the app itself
// holds. Nothing outside the game folder and the app's own data; no saves, no credentials.
//
// optiDir: where OptiScaler actually lives, when that is not the game folder. On the 32-bit route
// it is host64\ beside the game (legacy.js), and everything OptiScaler writes -- its log and its
// ini, the two files any diagnosis starts from -- is in there. Without this the bundle for the one
// route hardest to reason about contained no OptiScaler log at all, and its own app-view.json
// reported "no-log" while the helper's log was full of neural passes. Found while answering a user
// whose DX9 game ran correctly and showed no in-game menu, 2026-09-14: the feature for "send me
// your logs" was blind in exactly the case it was needed for.
// The bundle's contents without writing anything: [{ name, source }] for files on disk and
// [{ name, text }] for what the app composes (folder listing, its own view). Shared by the zip below and
// by "Send game failure" (ghreport.js), which posts the same files as text.
async function gatherSupportFiles(dir, { extra = {}, optiDir = dir } = {}) {
  const files = [];
  for (const name of BUNDLE_FILES) {
    const src = path.join(dir, name);
    if (fs.existsSync(src)) files.push({ name, source: src });
  }
  // The helper's own copies, named for where they came from so nobody has to guess which
  // OptiScaler.log they are reading.
  const hostPrefix = path.basename(optiDir);
  if (path.resolve(optiDir) !== path.resolve(dir)) {
    for (const name of BUNDLE_FILES) {
      const src = path.join(optiDir, name);
      if (fs.existsSync(src)) files.push({ name: `${hostPrefix}-${name}`, source: src });
    }
  }
  const run = await analyzeRun(dir, { optiDir });
  if (run.crash && run.crash.path) {
    for (const name of ['CrashContext.runtime-xml', 'CrashReportClient.ini']) {
      const src = path.join(run.crash.path, name);
      if (fs.existsSync(src)) files.push({ name: 'UE-crash-' + name, source: src });
    }
  }
  let listingText = `${dir}\n\n${folderListing(dir).join('\n')}\n`;
  if (path.resolve(optiDir) !== path.resolve(dir)) {
    listingText += `\n${optiDir}\n\n${folderListing(optiDir).join('\n')}\n`;
  }
  files.push({ name: 'folder-listing.txt', text: listingText });
  files.push({ name: 'app-view.json', text: JSON.stringify({ generatedAt: new Date().toISOString(), dir, optiDir, run, ...extra }, null, 2) });
  return { files, run };
}

async function collectSupportBundle(dir, { zipPath, extra = {}, execFileAsync, optiDir = dir }) {
  const staging = path.join(os.tmpdir(), `dlss5ui-support-${Date.now()}`);
  await fsp.mkdir(staging, { recursive: true });
  const { files, run } = await gatherSupportFiles(dir, { extra, optiDir });
  const copied = [];
  for (const f of files) {
    if (f.source) await fsp.copyFile(f.source, path.join(staging, f.name));
    else await fsp.writeFile(path.join(staging, f.name), f.text, 'utf8');
    copied.push(f.name);
  }

  await fsp.rm(zipPath, { force: true }).catch(() => {});
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:OSM_SRC "*") -DestinationPath $env:OSM_ZIP -Force',
  ], { env: { ...process.env, OSM_SRC: staging, OSM_ZIP: zipPath } });
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  return { zipPath, files: copied, run };
}

module.exports = { analyzeRun, collectSupportBundle, gatherSupportFiles, unrealCrashNear };
