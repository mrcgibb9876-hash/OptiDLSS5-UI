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

// The end of a log, for the things that are only interesting as "the latest one". readHead is the
// wrong tool for those: a long session writes past its 6 MB cap and the newest lines are exactly
// what falls outside it.
const TAIL_READ = 256 * 1024;

async function readTail(file, max = TAIL_READ) {
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch { return null; }
  try {
    const { size } = await fh.stat();
    if (size <= 0) return '';
    const take = Math.min(size, max);
    const buf = Buffer.allocUnsafe(take);
    const { bytesRead } = await fh.read(buf, 0, take, size - take);
    return buf.subarray(0, bytesRead).toString('latin1');
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// What the neural pass is costing right now, for the break-away panel's readout. The engine writes
// this every 600 frames (DlssNr_Dx12.cpp), which is the same number its own in-game panel shows as
// "Running - N ms per frame" -- Alien: Isolation read 16.43 there against GPU 16.49 in the log.
//
//   DLSS-NR heartbeat: 5400 frames run (0 model failures), 48 fps, GPU 16.49 ms | intensity ...
//   DLSS-NR cost: 16.38 ms total = 16.11 ms model + 0.27 ms ours (2% ours)
//
// GPU is not always a number: the engine says "n/a (timer unreliable)", "not read yet" or
// "n/a (no queue)" when it cannot trust the timestamp query, and those are passed through as a
// reason rather than turned into a fake 0.00 ms.
async function nrTiming(optiDir) {
  const file = path.join(optiDir, 'OptiScaler.log');
  let stat = null;
  try { stat = fs.statSync(file); } catch { return { ok: false, reason: 'no-log' }; }

  const tail = (await readTail(file)) || '';
  const beats = [...tail.matchAll(/DLSS-NR heartbeat: (\d+) frames run \((\d+) model failures\), ([\d.]+) fps, GPU ([^|]+?) \|/g)];
  if (beats.length === 0) return { ok: false, reason: 'no-heartbeat', atMs: stat.mtimeMs };

  const last = beats[beats.length - 1];
  const gpuText = last[4].trim();
  const gpuMs = /^([\d.]+) ms$/.exec(gpuText);

  // The cost line follows its heartbeat, so the last one in the tail belongs to the last beat.
  const costs = [...tail.matchAll(/DLSS-NR cost: ([\d.]+) ms total = ([\d.]+) ms model \+ ([\d.]+) ms ours/g)];
  const cost = costs.length ? costs[costs.length - 1] : null;

  return {
    ok: true,
    frames: Number(last[1]),
    failures: Number(last[2]),
    // Whole frames per second, like every other fps figure this app prints. The engine writes the
    // heartbeat with a decimal; a card that says "60.00 fps" reads like a measurement nobody asked
    // for, and the tenth is noise at this sample rate anyway.
    fps: Math.round(Number(last[3])),
    msPerFrame: gpuMs ? Number(gpuMs[1]) : null,
    gpuUnavailable: gpuMs ? null : gpuText,
    totalMs: cost ? Number(cost[1]) : null,
    modelMs: cost ? Number(cost[2]) : null,
    oursMs: cost ? Number(cost[3]) : null,
    atMs: stat.mtimeMs,
  };
}

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
//
// DXVK's D3D10/11 files count too, since DXVK can stand in for a 32-bit DirectX 10/11 game's own
// Direct3D (legacy.js dxvkReplacesNative, 2026-09-18) -- but only when the file really is DXVK:
// dxgi.dll is also the name the helper route's ReShade proxy and OptiScaler install under, and a
// fault in either of those is not a wrapper failing.
function wrapperFault(feed, dir) {
  const inGameFolder = (file) => path.resolve(path.dirname(file)).toLowerCase() === path.resolve(dir).toLowerCase();
  const m = /### EXCEPTION RECORDED ###[^\r\n]*? in ([A-Za-z]:[\\/][^\r\n;]*?[\\/](d3d8|d3d9|ddraw|d3dimm)\.dll)\s*;/i.exec(feed);
  if (m) return inGameFolder(m[1]) ? path.basename(m[1]) : null;
  const d = /### EXCEPTION RECORDED ###[^\r\n]*? in ([A-Za-z]:[\\/][^\r\n;]*?[\\/](d3d10core|d3d11|dxgi)\.dll)\s*;/i.exec(feed);
  if (!d || !inGameFolder(d[1])) return null;
  // Lazily, as detect.js does: most runs never get this far.
  const { identifyWrapper } = require('./translation');
  return identifyWrapper(path.join(dir, path.basename(d[1]))) === 'dxvk' ? path.basename(d[1]) : null;
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
    // A Feeder that stopped itself before the first frame (its `stopped:` line), or that found no
    // OptiScaler to route to, has still judged the run: with OptiScaler out of the loop there is no
    // OptiScaler.log to wait for, and waiting is how SWTOR's 18,000 DLAA frames read as "no run".
    const feedRan = !!wrapperCrash || /first frame fed|\bstopped: |OptiScaler: not present|is an OptiScaler build, but this game never loaded|DRIVER answered the NGX probe|is not the DLSS-NR fork/.test(feed);
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

  // The Feeder's own account of the neural consumer (its dlss5-feed.cpp DetectOptiScaler and the NGX
  // probe after it). On a Feeder game OptiScaler is not in the loop because it is installed: it is in
  // the loop when the game LOADED it (a proxy name the exe imports) and its nvngx redirect then took
  // the Feeder's NGX calls. Each line below is one way that fails, and each looked like plain "nothing
  // called DLSS" from OptiScaler's side, because OptiScaler's side never ran:
  //
  //   [feed] OptiScaler: not present                    -- no OptiScaler module in the process at all.
  //      Star Wars: The Old Republic (2026-09-16): OptiScaler sat beside the exe as dxgi.dll, a name
  //      nothing loads in a DXVK game, and the Feeder fed 18,000 frames of plain DLAA.
  //   winmm.dll is an OptiScaler build, but this game never loaded a DLL of that name
  //      -- the same, and the Feeder names the file it found under a name the game skipped.
  //   <module> is loaded but the DRIVER answered the NGX probe
  //      -- loaded, but [Inputs] EnableDlssInputs / [Hooks] HookOriginalNvngxOnly stop the redirect.
  //   this OptiScaler (<module>) is not the DLSS-NR fork  -- a stock build: upscales, no neural pass.
  //   NGX calls are routed through OptiScaler DLSS-NR (<module>) -- the healthy line.
  //   stopped: the Vulkan interop extensions are missing on this device
  //      -- the Feeder's vkCreateDevice hook never got its extensions onto the game's device (the
  //      README's fallback is its layer\run-with-feed-layer.bat); the lines above it say whether the
  //      hook was not installed or never called.
  const feedOptiRouted = /NGX calls are routed through OptiScaler DLSS-NR/.test(feed);
  const feedOptiMissing = /\[feed\] OptiScaler: not present/.test(feed);
  const feedOptiWrongName = (/([A-Za-z0-9_.-]+\.(?:dll|asi)) is an OptiScaler build, but this game never loaded a DLL of that name/i.exec(feed) || [])[1] || null;
  const feedOptiNotRouted = /is loaded but the DRIVER answered the NGX probe/.test(feed);
  const feedOptiNotFork = /is not the DLSS-NR fork/.test(feed);
  const feedVulkanInteropMissing = /the Vulkan interop extensions are missing on this device/.test(feed);
  const feedVulkanHookState = /vkCreateDevice hook was NOT installed/.test(feed) ? 'not-installed'
    : /vkCreateDevice hook was installed but never called/.test(feed) ? 'never-called' : null;

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
  // The Vulkan transport never opened: the Feeder itself stopped, before any consumer question.
  else if (feedVulkanInteropMissing) { verdict = 'feed-vulkan-interop'; detail = feedVulkanHookState; }
  // The neural consumer is not in the loop, in the Feeder's own words -- each of these outranks the
  // motion and depth verdicts, since no guide helps a pass that never runs, and outranks nr-ran only
  // in name: a run with OptiScaler out of the loop has no OptiScaler.log lines to count anyway.
  // Not when the same log also says NGX was routed through OptiScaler: the Feeder probes more than
  // once in a session (a late-loading proxy, a device re-created on a mode change), so an early "not
  // present" can be followed by the healthy line -- and the healthy line is the one that describes
  // the run. opti-not-routed below already had this guard; this branch lacked it (review, 2026-09-18).
  else if ((feedOptiMissing || feedOptiWrongName) && !feedOptiRouted) { verdict = 'opti-not-loaded'; detail = feedOptiWrongName; }
  else if (feedOptiNotFork) verdict = 'opti-not-fork';
  else if (feedOptiNotRouted && !feedOptiRouted) verdict = 'opti-not-routed';
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
    feedOptiRouted,
    feedOptiMissing,
    feedOptiWrongName,
    feedOptiNotRouted,
    feedOptiNotFork,
    feedVulkanInteropMissing,
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

// The run, as text, for the issue body -- the half of a report that used to be readable only by
// opening the attachment.
//
// A report reaches this project in two pieces: a body (what the app knows about the game) and the
// logs (a gist, or a zip the player drags in). Everything that decides a diagnosis is in the second
// piece, and neither the gist nor the attachment host is reachable from a scripted triage: both
// answer 403 to anything but a repository-scoped path. So the two SWTOR bundles and the Duke one
// (2026-09-16/17) could only be read by a human downloading them by hand, and until someone did,
// the issue said "no-hook (unknown)" and nothing else.
//
// This puts the decisive lines in the body itself: what analyzeRun concluded, and the sentences the
// Feeder wrote about its own run, quoted rather than paraphrased. Only what is true is printed, so a
// healthy run is four lines and a broken one says why. Plain `key: value` inside a fence, because
// this is read by a person and by a script, and a script should not have to parse prose.
//
// Redaction is the caller's: ghreport.sendReport redacts the whole body, this included.
function reportDigest(run, { mvProvider = null, vulkanFeeder = null, detected = null, route = null, feeder = null, timing = null, fpsTarget = null } = {}) {
  const lines = [];
  const add = (key, value) => { if (value !== null && value !== undefined && value !== '' && value !== false) lines.push(`${key}: ${value}`); };

  // Why this game is on the API it is on. Two reports of the SAME swtor.exe read DX9 on one machine
  // and DX11 on another (#44 and #50, 2026-09-17), and neither body said why, so the question could
  // only be guessed at. Detection already writes the sentence -- a DXVK wrapper beside the exe, a
  // D3D11 device in OptiScaler.log, a choice made in Edit -- it was simply never reported. The API
  // decides the route, and the route decides everything else, so this belongs at the top.
  if (detected) {
    if (detected.apiOverride) {
      add('api', `${detected.apiOverride} -- SET BY HAND in Edit (detection said ${detected.detectedApi || 'nothing'})`);
    } else {
      add('api', detected.api ? `${detected.api}${detected.reason ? ` -- ${detected.reason}` : ''}` : 'not detected');
    }
    if ((detected.apis || []).length > 1) add('apis seen', detected.apis.join(', '));
    add('bitness', detected.bitness ? `${detected.bitness}-bit` : null);
    add('engine', detected.engine);
    // The files beside the exe that change the answer above, and that no header line mentions.
    if (detected.vulkanWrapper) add('wrapper', `${detected.vulkanWrapper.file} beside the exe is ${detected.vulkanWrapper.kind}, so the game reaches the GPU through Vulkan`);
    if (detected.reshadeProxy) add('reshade', `loaded locally as ${detected.reshadeProxy} (not the Vulkan layer)`);
    // detect.js records ANY OptiScaler found under a proxy name, ours included -- matchesOurBuild
    // says which. Calling our own install "other optiscaler" sent a real report (#50) looking for a
    // rival build that was not there, so the two cases are named apart. The proxy name itself is
    // worth printing either way: it is the whole of what went wrong on the first SWTOR report.
    if (detected.optiScalerProxy && detected.optiScalerProxy.file) {
      add('optiscaler', detected.optiScalerProxy.matchesOurBuild === false
        ? `${detected.optiScalerProxy.file} -- NOT the build this app installed, and it is the one that answers the game's NGX calls`
        : `${detected.optiScalerProxy.file} (this app's own install)`);
    }
    if (detected.antiCheat) add('anti-cheat', detected.antiCheat);
  }
  // dgVoodoo2 turns DirectX 8/9 into D3D11 inside the game, which is itself a reason a DX9 game can
  // report DX11 -- and it is the wrapper this app's own legacy route places (legacy.js). route.legacy
  // is the PLAN (what the route calls for); dgVoodooDeployed is whether it is actually in the folder,
  // and only the second one may be stated as fact.
  if (route) {
    add('route', route.route);
    const plan = route.legacy;
    if (plan && plan.dgVoodoo) {
      add('dgvoodoo2', route.dgVoodooDeployed
        ? `${plan.dgVoodoo.arch} ${plan.dgVoodoo.dll} is in the folder -- DirectX 9 is being presented to the game as D3D11`
        : `this route wants ${plan.dgVoodoo.arch} ${plan.dgVoodoo.dll}, not deployed yet`);
    } else if (route.dgVoodooDeployed) {
      add('dgvoodoo2', 'deployed in this folder');
    }
    if (plan && plan.host32) add('32-bit route', 'the DLSS work runs in the Feeder\'s 64-bit helper in host64\\');
  }

  if (!run || !run.ran) {
    add('verdict', (run && run.verdict) || 'no-log');
    add('ran', 'no -- nothing has been logged in this folder yet');
  } else {
    add('verdict', run.verdict + (run.detail ? ` (${run.detail})` : ''));
    add('at', run.at);
    add('runtime api', run.runtimeApi ? `${run.runtimeApi} -- what OptiScaler actually saw in the process` : null);
    add('neural passes', run.nrFrames || run.nrDispatch || null);
    add('feeder frames', run.feedFrames || null);
    add('fps', run.fps);
    // What the neural pass costs (nrTiming, the engine's own heartbeat and cost lines), and the frame
    // rate the player is aiming for. Together they decide whether frame generation is worth suggesting
    // (fgsuggest.js), and a digest is where a report's version of that question gets answered.
    if (timing && timing.ok && (timing.totalMs || timing.msPerFrame)) {
      const ms = timing.totalMs || timing.msPerFrame;
      add('neural cost', `${ms} ms per frame${timing.modelMs ? ` (${timing.modelMs} ms model)` : ''}${timing.fps ? `, ${timing.fps} fps at the last heartbeat` : ''}`);
    }
    add('fps target', fpsTarget);
    add('dlss features created', run.dlssCreated || null);

    // The neural consumer, in the Feeder's own words (see the DetectOptiScaler block above).
    if (run.feedOptiRouted) add('optiscaler', 'NGX routed through it');
    if (run.feedOptiMissing) add('optiscaler', 'not present in the process at all');
    if (run.feedOptiWrongName) add('optiscaler', `${run.feedOptiWrongName} is an OptiScaler build this game never loaded`);
    if (run.feedOptiNotRouted) add('optiscaler', 'loaded, but the DRIVER answered the NGX probe');
    if (run.feedOptiNotFork) add('optiscaler', 'a stock build, not the DLSS-NR fork');
    if (run.feedVulkanInteropMissing) add('vulkan interop', 'the extensions are missing on this device');

    if (run.feedMvProblem) add('motion vectors', run.feedMvProblem);
    else if (run.feedNoMotion) add('motion vectors', 'every probe read (almost) none');
    if (run.feedDepthFlatMoving) add('depth', 'flat while the scene moved (wrong buffer)');
    else if (run.feedDepthFlat) add('depth', 'flat');

    // The fault stack rides in run.detail on this verdict, printed beside it above.
    if (run.feedEvaluateCrash) add('neural model', 'crashed in its evaluate, and the feed stopped');
    if (run.feedInvalidRedist) add('d3d12', 'every device create refused with INVALID_REDIST');
    if (run.srBackendFallback) add('upscaler', `DLSS could not be created${run.srCreateResult ? ` (${run.srCreateResult})` : ''}, fell back to ${run.srBackendFallback.to}`);
    if (run.upscaleSkipped) add('upscaler', `${run.upscaleSkipped} dispatches skipped (root signature)`);
    if (run.dlssRuntimeMissing) add('nvngx_dlss.dll', 'not beside the exe -- OptiScaler disabled DLSS');
    if (run.feedDriverOutdated !== null && run.feedDriverOutdated !== undefined) {
      add('driver', `reports feature 18 out of date${run.feedDriverOutdated ? `, needs ${run.feedDriverOutdated} or newer` : ''}`);
    }
    add('driver version', run.driverVersion);
    if (run.feedSmoothMotion) add('smooth motion', 'active in this process');
    if (run.wrapperCrash) add('wrapper crash', `${run.wrapperCrash}, as the game started`);
    if (run.crash && run.crash.message) add('unreal crash', String(run.crash.message).slice(0, 200));
    if (run.optiLogMissing) add('OptiScaler.log', 'absent -- the Feeder log is the whole run');
    if (!run.cleanExit) add('exit', 'no DLL_PROCESS_DETACH -- the process did not unload cleanly');
  }

  // State the body never carried, and both halves of a Feeder deploy that can look complete and feed
  // nothing: which motion-vector shader is set up, and whether ReShade's Vulkan layer is on this exe.
  // Whether the Feeder stack is actually all there. A "no-dlss" verdict on a Feeder game means
  // nothing ever made a DLSS call, and the first question is always which piece is missing -- the
  // add-on is a ReShade add-on, so a ReShade that did not load means no feed at all, and nothing in
  // the body said so (#50, 2026-09-17: route feeder, verdict no-dlss, and no way to tell why).
  if (feeder && feeder.supported) {
    const missing = [
      !feeder.reshadeInstalled && 'ReShade',
      !feeder.addonInstalled && 'the add-on',
      !feeder.fxInstalled && 'DLSS5_Feed.fx',
      !feeder.headersInstalled && 'the ReShade headers',
      // Named apart on purpose. These two differ by two characters, they sit next to each other in
      // the same folder, and a reporter on #50 (2026-09-17) read "missing nvngx_dlss.dll" off a
      // folder that held nvngx_dlssnr.dll and answered "THIS FILE IS PRESENT" -- which cost a
      // round trip and left the actual gap in place. The bare name is not enough to act on.
      !feeder.dlssInstalled && 'nvngx_dlss.dll (the DLSS runtime)',
      !feeder.dlssnrInstalled && 'nvngx_dlssnr.dll (the neural model)',
    ].filter(Boolean);
    add('feeder', missing.length
      ? `INCOMPLETE -- missing ${missing.join(', ')} (ReShade reaches this game ${feeder.reshadeMode})`
      : `complete (ReShade reaches this game ${feeder.reshadeMode})`);
  }
  if (mvProvider && mvProvider.id) {
    const bad = [
      mvProvider.broken && 'cannot work',
      mvProvider.shaderPresent === false && 'shader missing',
      (mvProvider.valueMismatch || mvProvider.techniqueMismatch) && 'preset and shader disagree',
    ].filter(Boolean);
    add('mv provider', `${mvProvider.displayName || mvProvider.id}${bad.length ? ` -- ${bad.join(', ')}` : ''}`);
  }
  if (vulkanFeeder) {
    add('reshade vulkan layer', [
      vulkanFeeder.layerRegistered ? 'registered' : 'NOT registered',
      vulkanFeeder.layerRegistered && (vulkanFeeder.layerAddon ? 'add-on build' : 'NO add-on support'),
      vulkanFeeder.appListed === false ? 'this exe is NOT on its app list' : vulkanFeeder.appListed === true ? 'this exe is listed' : null,
      vulkanFeeder.feederLogPresent ? 'feeder logged' : 'feeder wrote no log',
    ].filter(Boolean).join(', '));
  }

  return [DIGEST_MARKER, '', '```', ...lines, '```', '', '</details>'].join('\n');
}

// The folded block's first line, which is how a body that already carries a digest is recognised.
const DIGEST_MARKER = '<details><summary>Run digest (read from the logs by the app)</summary>';

// The digest belongs in every issue body, whichever way the report goes: "Send game failure" posts
// through main.js, but "Report on GitHub" (and the fallback when no GitHub app is configured) opens
// the browser with a body the renderer built, and a v1.80.0 report arrived that way with only the
// header lines (#50, the same SWTOR that the digest was added for). So the renderer appends the
// digest it got with Game Help, and the send path calls this rather than appending blindly: a body
// that already has the block keeps it, one from an older renderer gets it.
function withDigest(body, digest) {
  const text = String(body || '');
  if (!digest) return text;
  if (text.includes(DIGEST_MARKER)) return text;
  return `${text.trimEnd()}\n\n${digest}`;
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

module.exports = { analyzeRun, collectSupportBundle, gatherSupportFiles, reportDigest, withDigest, DIGEST_MARKER, unrealCrashNear, nrTiming };
