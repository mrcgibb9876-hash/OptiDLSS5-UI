// What happened the last time this game ran -- read from the logs our own stack writes beside
// the exe, so the card can say "NR ran" or name the failure instead of leaving the user to open
// OptiScaler.log. Every verdict here is a signature that was met on a real install:
//
//   duplicate-dlss     the Feeder's CreateFeature faulted with two DLSS DLLs loaded (Code Vein 2,
//                      Mortal Shell II: a Feeder on a game that ships DLSS in its plugin tree)
//   shutdown-fault     NVIDIA's own Shutdown1 faulted while the Feeder's private session was
//                      live (same folders, on the way down)
//   ue-crash           Unreal's crash reporter wrote a report within minutes of the run
//   feed-stopped       the Feeder gave up ("The feed stops here") -- its own diagnosis follows
//   nr-ran             the Neural Rendering pass dispatched; count and fps if the Feeder timed it
//   dlss-no-nr         a DLSS feature was created but NR never dispatched (a D3D11 feature on
//                      the native path: Dx11Upscaler must be dlss_12 -- Fallen Order + Luma)
//   init-no-feature    NGX initialised but no feature was ever created (Luma: DLSS not selected
//                      in its overlay; Feeder: its shader technique missing)
//   no-dlss            nothing called DLSS at all (nothing to hook, or the proxy did not load)
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
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
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

// optiDir: where OptiScaler (and its log) lives when that is not the game folder -- a 32-bit game's
// DLSS work runs in the Feeder's 64-bit helper, in host64\ beside it (legacy.js). The Feeder's own
// log stays beside the game.
async function analyzeRun(dir, { optiDir = dir } = {}) {
  const optiPath = path.join(optiDir, 'OptiScaler.log');
  let stat;
  try { stat = fs.statSync(optiPath); } catch { return { ran: false, verdict: 'no-log' }; }
  const opti = (await readHead(optiPath)) || '';
  const feed = (await readHead(path.join(dir, 'dlss5-feed.log'))) || '';

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

  const feedFrames = count(feed, /frame \d+ delivered/g);
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
  const feedNoMotion = /DLSS is getting \(almost\) no motion vectors/.test(feed);
  const feedDepthFlatMoving = /depth is FLAT while the scene moves/.test(feed);
  const feedDepthFlat = feedDepthFlatMoving || /sampled depth is flat/.test(feed);

  const crash = unrealCrashNear(dir, stat.mtimeMs);

  let verdict;
  let detail = null;
  if (feedCreateFault && feedTwoCopies) verdict = 'duplicate-dlss';
  else if (shutdownFault) verdict = 'shutdown-fault';
  else if (crash && !cleanExit) { verdict = 'ue-crash'; detail = crash.message; }
  // Before feed-stopped and before nr-ran: a session that never opened for this reason, and a
  // neural pass running on empty guides, both otherwise read as "no DLSS" or as a clean run.
  else if (feedInvalidRedist) verdict = 'feed-agility-redist';
  else if (feedMvProblem || feedNoMotion) { verdict = 'feed-no-motion'; detail = feedMvProblem; }
  else if (feedDepthFlatMoving) verdict = 'feed-depth-flat';
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
    nrComposition,
    dlssCreated,
    fps,
    feedFrames,
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
    verdict,
    detail,
  };
}

// Everything a helper needs to see, in one folder -> zip: our logs and inis, the newest Unreal
// crash report, a listing of the exe folder, and the detection/route/verdict the app itself
// holds. Nothing outside the game folder and the app's own data; no saves, no credentials.
async function collectSupportBundle(dir, { zipPath, extra = {}, execFileAsync }) {
  const staging = path.join(os.tmpdir(), `dlss5ui-support-${Date.now()}`);
  await fsp.mkdir(staging, { recursive: true });
  const copied = [];
  for (const name of ['OptiScaler.log', 'OptiScaler.ini', 'ReShade.log', 'ReShade.ini', 'ReShadePreset.ini', 'dlss5-feed.log', 'dlss5-feed.cfg', '.optiscaler-manager-install.json', '.dlss5ui-feeder-deploy.json', '.dlss5ui-lumaue-deploy.json', '.dlss5ui-api.json', '.dlss5ui-lossless.json']) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    await fsp.copyFile(src, path.join(staging, name));
    copied.push(name);
  }
  const run = await analyzeRun(dir);
  if (run.crash && run.crash.path) {
    for (const name of ['CrashContext.runtime-xml', 'CrashReportClient.ini']) {
      const src = path.join(run.crash.path, name);
      if (fs.existsSync(src)) { await fsp.copyFile(src, path.join(staging, 'UE-crash-' + name)); copied.push('UE-crash-' + name); }
    }
  }
  let listing = [];
  try {
    listing = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
      let size = '';
      let mtime = '';
      try { const st = fs.statSync(path.join(dir, e.name)); size = e.isDirectory() ? '<dir>' : String(st.size); mtime = st.mtime.toISOString(); } catch {}
      return `${mtime}  ${size.padStart(12)}  ${e.name}`;
    });
  } catch {}
  await fsp.writeFile(path.join(staging, 'folder-listing.txt'), `${dir}\n\n${listing.join('\n')}\n`, 'utf8');
  await fsp.writeFile(path.join(staging, 'app-view.json'), JSON.stringify({ generatedAt: new Date().toISOString(), dir, run, ...extra }, null, 2), 'utf8');
  copied.push('folder-listing.txt', 'app-view.json');

  await fsp.rm(zipPath, { force: true }).catch(() => {});
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:OSM_SRC "*") -DestinationPath $env:OSM_ZIP -Force',
  ], { env: { ...process.env, OSM_SRC: staging, OSM_ZIP: zipPath } });
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  return { zipPath, files: copied, run };
}

module.exports = { analyzeRun, collectSupportBundle, unrealCrashNear };
