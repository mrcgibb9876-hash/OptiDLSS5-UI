// EXPERIMENTAL: 32-bit games and DirectX 8/9 games, through the DLSS5 Feeder's own documented paths
// (its README: "Install for a 32-bit game", "Install for a DirectX 9 game"), with OptiScaler_DLSSNR
// as the neural consumer the Feeder names ("Alternative: OptiScaler DLSS-NR").
//
// Confirmed on a live game 2026-09-14: Castlevania: Lords of Shadow (32-bit, DirectX 9), dgVoodoo2
// presenting it as Direct3D 11, VORT supplying motion vectors, 3976 frames delivered to
// host64\dlss5-feed-host64.exe with OptiScaler DLSS-NR attached as host64\winmm.dll. The add-on's
// own status panel was the evidence. Still marked Experimental: one game, one machine.
//
// Two separate pieces, which a game may need one or both of:
//
//   dgVoodoo2   D3D8 and D3D9 have no Feeder path of their own. dgVoodoo2 (Dege's wrapper) turns them
//               into D3D11 inside the game: its D3D8.dll / D3D9.dll beside the exe, with dgVoodoo.conf
//               set so it actually engages (DisableAndPassThru=false), outputs D3D11, has enough
//               emulated VRAM, and shows no watermark. x86 build for a 32-bit game; a 64-bit D3D9 game
//               takes the x64 D3D9.dll and then the ordinary 64-bit Feeder route. There is no 64-bit
//               D3D8. Pinned to one release and checked by sha256, as DLSS5-Swapper does.
//
//   host32      NVIDIA ships no 32-bit NGX, so a 32-bit game cannot run DLSS in its own process. The
//               Feeder's 32-bit add-on (dlss5-feed.addon32) sends the frame to dlss5-feed-host64.exe,
//               a 64-bit helper it starts from a host64\ folder beside the game, and the DLSS work --
//               and OptiScaler_DLSSNR with it -- happens there. Layout, per the Feeder's README:
//                 beside the exe   32-bit ReShade (as dxgi.dll, or opengl32.dll for OpenGL) with the
//                                  add-on, DLSS5_Feed.fx, the motion-vector shaders, ReShade.ini/preset
//                 host64\          dlss5-feed-host64.exe, a 64-bit ReShade dxgi.dll, the OptiScaler
//                                  release with OptiScaler.dll renamed winmm.dll ([DlssNr] Enabled=true,
//                                  ScanExposure=false, Dx12Upscaler=dlss), nvngx_dlssnr.dll, nvngx_dlss.dll
//
// Everything placed is recorded in one marker (.dlss5ui-legacy.json), and removeLegacy() takes back
// exactly that and restores anything it had to set aside.
//
// Parts of the approach, the dgVoodoo pin and its configuration values are ported from DLSS5-Swapper
// (src/core/apply.js, runtime-components.js, feeder-config.js; MIT, Copyright (c) 2026 Rakan
// Alkhaldi -- third_party/DLSS5-Swapper-LICENSE.txt).
//
// A note on dgVoodoo2 and antivirus: Windows Defender deletes the official dgVoodoo2 2.87.4 *zip*
// ("Trojan:Win32/Kepavll!rfn", a reputation-based "!rfn" detection) wherever it lands on disk -- a
// browser's Downloads as much as this app's cache. The files a route uses from it (x86/x64 D3D9.dll,
// D3D8.dll, dgVoodooCpl.exe, dgVoodoo.conf) are not flagged: written, read back and custom-scanned
// on 2026-09-14, no detection. So the archive is held in memory, checked against the pinned sha256,
// and only those files are cached. Nothing is excluded or disabled -- the antivirus scans each file
// as it is written, and if it does remove one, that is reported as quarantine, not retried.
'use strict';
const { netFetch } = require('./net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { openZip, findEntry, extractEntry } = require('./zip');
const os = require('node:os');
const { setIniKey, getIniKey } = require('./ini-merge');
const feeder = require('./feeder');
const { configureFeedCfg } = feeder;
const translation = require('./translation');

const MARKER = '.dlss5ui-legacy.json';
const HOST_DIR = 'host64';
const BACKUP_SUFFIX = '.dlss5ui-orig';
// The game-side ReShade proxy while DXVK is in front of a 32-bit game (parkReShadeProxy).
const PARK_SUFFIX = '.dlss5ui-parked';

const DGVOODOO = {
  version: '2.87.4',
  url: 'https://github.com/dege-diosg/dgVoodoo2/releases/download/v2.87.4/dgVoodoo2_87_4.zip',
  sha256: require('./integrity').pinFor('https://github.com/dege-diosg/dgVoodoo2/releases/download/v2.87.4/dgVoodoo2_87_4.zip'),
  fileName: 'dgVoodoo2_87_4.zip',
  cacheName: 'dgVoodoo2_87_4',
  userCacheName: 'dgVoodoo2-user',
  page: 'https://github.com/dege-diosg/dgVoodoo2/releases',
};

// The only parts of the release any route uses (planFor's arch/dll pairs, plus the config and its
// control panel). Required ones make a zip "a dgVoodoo2 release"; the rest are taken when present.
const DG_FILES = [
  { rel: 'MS/x86/D3D9.dll', required: true },
  { rel: 'MS/x86/D3D8.dll', required: false },
  { rel: 'MS/x64/D3D9.dll', required: false },
  { rel: 'dgVoodoo.conf', required: true },
  { rel: 'dgVoodooCpl.exe', required: true },
];
const DG_MANIFEST = 'files.json';

// Zip entry names: the Feeder's release uses backslashes (host64\dlss5-feed-host64.exe).
const sep = '[\\\\/]';
const ENTRY = {
  addon32: new RegExp(`(^|${sep})dlss5-feed\\.addon32$`, 'i'),
  host64: new RegExp(`(^|${sep})dlss5-feed-host64\\.exe$`, 'i'),
  feedFx: new RegExp(`(^|${sep})DLSS5_Feed\\.fx$`, 'i'),
  reshade32: /^ReShade32\.dll$/i,
  reshade64: /^ReShade64\.dll$/i,
};

// ---------------------------------------------------------------------------------------------
// What a game needs

// detected: the detection result (bitness, api). Returns the plan or { supported: false, reason }.
function planFor(detected) {
  const bitness = detected && detected.bitness;
  const api = detected && detected.api;
  if (bitness === 32) {
    if (api === 'vulkan') return { supported: false, reason: '32-bit Vulkan is not supported by this app yet' };
    if (!['dx8', 'dx9', 'dx10', 'dx11', 'dx12', 'opengl'].includes(api)) return { supported: false, reason: 'graphics API not detected' };
    return {
      supported: true,
      host32: true,
      api,
      dgVoodoo: api === 'dx8' ? { arch: 'x86', dll: 'D3D8.dll' } : api === 'dx9' ? { arch: 'x86', dll: 'D3D9.dll' } : null,
      reshadeName: api === 'opengl' ? 'opengl32.dll' : 'dxgi.dll',
    };
  }
  if (bitness === 64 && api === 'dx9') {
    return { supported: true, host32: false, api, dgVoodoo: { arch: 'x64', dll: 'D3D9.dll' }, reshadeName: null };
  }
  return { supported: false, reason: 'not a legacy game' };
}

// A 32-bit DirectX 10/11 plan, where DXVK can stand in for the game's own Direct3D rather than for
// dgVoodoo2. It used to be refused outright, because the helper route's ReShade is this game's
// dxgi.dll -- the name DXVK's D3D11 set needs (the 2.2.3 review, 2026-09-18). The DX9 swap has since
// learned to park that proxy and run ReShade as its 32-bit Vulkan layer instead, which is all a
// DX10/11 game needs too, so the refusal had nothing left to protect. EasyAIO DLSS5 3.0.1 puts the
// full DXVK x86 set on every 32-bit route; here it is opt-in and dgVoodoo2 stays the DX8/9 default.
function dxvkReplacesNative(plan) {
  return !!(plan && plan.supported && plan.host32 && !plan.dgVoodoo && (plan.api === 'dx10' || plan.api === 'dx11'));
}

// ---------------------------------------------------------------------------------------------
// Marker

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
}

function writeMarker(dir, marker) {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2), 'utf8');
}

// The OptiScaler DLL inside the helper, under the name the helper imports (deployHost32 renames
// OptiScaler.dll to this). Nothing else in host64\ makes OptiScaler load: the ini configures it, the
// model is what it runs, the forwarder is what it calls -- this is the module itself.
const HOST_OPTISCALER_DLL = 'winmm.dll';

// The helper itself, the process the 32-bit add-on starts and hands frames to.
const HOST_EXE = 'dlss5-feed-host64.exe';

function status(dir) {
  const marker = readMarker(dir);
  const host = path.join(dir, HOST_DIR);
  // hostOptiScaler used to ask for OptiScaler.ini and nvngx_dlssnr.dll and stop there, which are the
  // two files that are still present when the one that matters is gone. Max Payne 2, 2026-09-24: the
  // helper's window opened, the Feeder cast worked, and the DLSS 5 overlay was never in it -- because
  // host64\winmm.dll was not on disk. The install marker listed it, so this app had written it; the
  // game lives under Downloads in a repack folder, and a 64-bit winmm.dll appearing beside an exe
  // there is the exact shape antivirus quarantines. Everything reported complete and nothing said why.
  const optiDll = fs.existsSync(path.join(host, HOST_OPTISCALER_DLL));
  // Placed by us and now absent is not the same as never installed: re-running Install rewrites a file
  // that something is removing, which is a loop rather than a fix. Named separately so Game Help can
  // say so (gamehelp 'host32-opti-dll-gone').
  const claimed = !!(marker && (marker.files || []).some((f) => String(f).toLowerCase() === `${HOST_DIR}/${HOST_OPTISCALER_DLL}`.toLowerCase()));
  // The same shape, one file over, and worse: the helper EXE itself. Without winmm.dll the helper
  // still runs and the feed works without a neural pass; without the exe there is no helper at all,
  // the Feeder reports "the 64-bit host went away", and the game renders on as though nothing were
  // installed. Two things make it worth telling apart from a plain incomplete install: a 64-bit exe
  // appearing beside a game is the same antivirus bait winmm.dll is, and `feeder32` below goes false
  // when it is gone -- so without this the route reads as "not installed yet" and Game Help offers
  // Install, which writes the file straight back into whatever is removing it.
  const hostExe = fs.existsSync(path.join(host, HOST_EXE));
  const exeClaimed = !!(marker && (marker.files || []).some((f) => String(f).toLowerCase() === `${HOST_DIR}/${HOST_EXE}`.toLowerCase()));
  return {
    deployed: !!marker,
    host32: !!(marker && marker.host32),
    dgVoodoo: !!(marker && marker.dgVoodoo),
    hostOptiScaler: optiDll && fs.existsSync(path.join(host, 'OptiScaler.ini')) && fs.existsSync(path.join(host, 'nvngx_dlssnr.dll')),
    hostOptiScalerDll: optiDll,
    hostOptiScalerDllGone: claimed && !optiDll,
    feeder32: fs.existsSync(path.join(dir, 'dlss5-feed.addon32')) && hostExe,
    hostExeGone: exeClaimed && !hostExe,
    marker,
  };
}

// ---------------------------------------------------------------------------------------------
// dgVoodoo2

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const dgEntry = (zip, rel) => findEntry(zip, new RegExp(`^${rel.split('/').map((s) => s.replace(/\./g, '\\.')).join(sep)}$`, 'i'));

// bufOrPath: a zip on disk (a file the user picked) or one held in memory (the download).
function isDgVoodooZip(bufOrPath) {
  try {
    const zip = openZip(bufOrPath);
    return DG_FILES.every((f) => !f.required || dgEntry(zip, f.rel));
  } catch {
    return false;
  }
}

// A cache folder is usable when its manifest names every required file and each one on disk still
// hashes to what was unpacked -- so a file a scanner took, or a half-written unpack, reads as absent.
function readDgFolder(folder) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(folder, DG_MANIFEST), 'utf8')); } catch { return null; }
  if (!manifest || typeof manifest.files !== 'object') return null;
  for (const f of DG_FILES) if (f.required && !manifest.files[f.rel]) return null;
  for (const [rel, hash] of Object.entries(manifest.files)) {
    try {
      if (sha256(fs.readFileSync(path.join(folder, ...rel.split('/')))) !== hash) return null;
    } catch {
      return null;
    }
  }
  return manifest;
}

// Writes the files a route uses out of a dgVoodoo2 zip held in memory into cacheDir/<name>, via a
// .partial folder so a failed unpack never looks complete, then checks they are all still there.
async function unpackDgVoodoo(buf, cacheDir, name, source) {
  if (!isDgVoodooZip(buf)) throw new Error('not a dgVoodoo2 release zip (no MS\\x86\\D3D9.dll, dgVoodoo.conf and dgVoodooCpl.exe)');
  const zip = openZip(buf);
  const dest = path.join(cacheDir, name);
  const partial = `${dest}.partial`;
  await fsp.rm(partial, { recursive: true, force: true });
  const files = {};
  for (const f of DG_FILES) {
    const entry = dgEntry(zip, f.rel);
    if (!entry) continue;
    const data = extractEntry(zip, entry);
    const out = path.join(partial, ...f.rel.split('/'));
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, data);
    files[f.rel] = sha256(data);
  }
  await fsp.writeFile(path.join(partial, DG_MANIFEST), JSON.stringify({ source, zipSha256: sha256(buf), files }, null, 2), 'utf8');
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.rename(partial, dest);
  await quarantineCheck(dest);
  return dest;
}

// The pinned release, verified, as a folder of the files a route uses. Separate errors for "the
// download was bad" and "it was verified, written, and then gone" -- the second is antivirus
// quarantine, and retrying does not help.
async function ensureDgVoodoo(cacheDir, { fetchImpl = netFetch, headers = {} } = {}) {
  const cached = cachedDgVoodoo(cacheDir);
  if (cached) return cached;
  await fsp.mkdir(cacheDir, { recursive: true });
  // A zip an older build cached (and that survived): unpack it rather than download again, then
  // drop it -- the archive is the one thing Defender deletes.
  const oldZip = path.join(cacheDir, DGVOODOO.fileName);
  let buf = null;
  try {
    const b = fs.readFileSync(oldZip);
    if (sha256(b) === DGVOODOO.sha256) buf = b;
  } catch {}
  if (!buf) {
    const res = await fetchImpl(DGVOODOO.url, { headers });
    if (!res.ok) throw Object.assign(new Error(`dgVoodoo2 download failed: HTTP ${res.status}`), { code: 'dgvoodoo-network' });
    buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== DGVOODOO.sha256) {
      throw Object.assign(new Error(`dgVoodoo2 download did not match its checksum (expected ${DGVOODOO.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`), { code: 'dgvoodoo-checksum' });
    }
  }
  const dest = await unpackDgVoodoo(buf, cacheDir, DGVOODOO.cacheName, `official ${DGVOODOO.version}`);
  await fsp.rm(oldZip, { force: true });
  return dest;
}

// A security tool removes or locks a file a moment after it is written.
async function quarantineCheck(folder) {
  const wait = Number(process.env.LEGACY_QUARANTINE_WAIT_MS ?? 1500);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (!readDgFolder(folder)) {
    throw Object.assign(new Error(
      'dgVoodoo2 was downloaded and verified, then one of its files was removed or blocked on this PC -- that is what ' +
      'antivirus quarantine looks like. Check Windows Security\'s protection history.'), { code: 'dgvoodoo-quarantined' });
  }
}

// A dgVoodoo2 zip the user picked: must be dgVoodoo's layout. Not held to the pinned hash -- it may
// be another version they trust -- and unpacked the same way, into its own cache folder.
async function importDgVoodooZip(sourcePath, cacheDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('the picked file does not exist');
  const buf = fs.readFileSync(sourcePath);
  if (!isDgVoodooZip(buf)) throw new Error(`${path.basename(sourcePath)} is not a dgVoodoo2 release zip (no MS\\x86\\D3D9.dll, dgVoodoo.conf and dgVoodooCpl.exe)`);
  await fsp.mkdir(cacheDir, { recursive: true });
  return unpackDgVoodoo(buf, cacheDir, DGVOODOO.userCacheName, path.basename(sourcePath));
}

function cachedDgVoodoo(cacheDir) {
  for (const name of [DGVOODOO.cacheName, DGVOODOO.userCacheName]) {
    const p = path.join(cacheDir, name);
    if (readDgFolder(p)) return p;
  }
  return null;
}

// dgVoodoo.conf as the Feeder's README and DLSS5-Swapper set it. VRAM: dgVoodoo enforces its emulated
// 256 MB, and a DirectX 9 game at a modern resolution runs out in seconds (DLSS5-Swapper measured SWTOR
// failing at 1024 MB); the number is a ceiling, not an allocation.
//
// windowed (the 32-bit helper route): dgVoodoo2 presents the game as a borderless, screen-sized
// window whatever the game asks for. In exclusive fullscreen the game loses focus the moment the
// Feeder starts its 64-bit helper, minimises, and a game that pauses while inactive never comes back:
// Castlevania: Lords of Shadow - Mirror of Fate HD (2026-09-14) sat in a Sleep loop inside its own
// window procedure, "not responding", with one frame fed. Set to windowed -- by its own config or by
// these three keys, with its config still saying fullscreen -- it ran at 170 fps with DLSS 5 on. The
// Feeder's in-game panel needs windowed or borderless anyway.
const DG_WINDOWED = [
  ['General', 'FullScreenMode', 'false'],
  ['DirectX', 'AppControlledScreenMode', 'false'],
  ['GeneralExt', 'WindowedAttributes', 'borderless, fullscreensize'],
];

// Every dgVoodoo2 route, 32-bit or not: the game's image fills the screen, keeping its shape. A DirectX
// 8/9 game starts at its own default resolution (often 640x480 or 800x600) until it is changed in its
// menus, and with dgVoodoo2's ScalingMode left at "unspecified" that showed as a small picture -- inside
// the screen-sized window "fullscreensize" makes, whose image scaling follows ScalingMode (dgVoodoo.conf's
// own notes) -- too small to read the settings menu that fixes it (user report, 2026-09-15). The
// rendering resolution itself is left to the game ([DirectX] Resolution stays unforced): forcing it
// breaks the 2D layout of some games, while scaling only makes what is drawn bigger. "fullscreensize"
// also covers a game that opens its own small window on the 64-bit route.
//
// ColorSpace: NOT SET, and never write "argb8888_srgb" here again. It is not a valid value in
// dgVoodoo 2.87.4 -- the parser takes only 'appdriven', 'argb8888_sdr', 'argb2101010_sdr_wcg' and
// 'argb16161616_hdr' -- even though dgVoodoo's OWN shipped dgVoodoo.conf comments still document the
// old name. The value was renamed and the documentation was not, which is where this app got it.
//
// A rejected value makes dgVoodoo ABANDON THE REST OF THE FILE. ColorSpace sits in [GeneralExt] at
// about line 121; [DirectX] starts at 186. So writing it silently threw away VRAM, VideoCard,
// AppControlledScreenMode, dgVoodooWatermark and DisableAndPassThru on every game that got it.
//
// That one string caused both of Assassin's Creed II's long-standing symptoms (root-caused
// 2026-09-21 with a dgVoodoo DEBUG build + dbgviewcli; the release build logs nothing):
//
//   * The crash. VRAM=4096 never applied, so the emulated card stayed at its 256MB default. The game
//     fills it, CreateTexture returns NULL, and AC2 dereferences NULL -- 0xC0000005 at 00BE89B7 is
//     literally "cmp eax,0 / jne / xor eax,eax / jmp" into "mov ecx,[eax]" loading a vtable. Two days
//     of eliminating ReShade, the hook point, the output API, fullscreen and RenoDX were all correct
//     and all beside the point.
//   * The black screen. "argb8888_srgb fixed the black screen" was wrong. What fixed it was the parse
//     error switching off the keys BELOW it -- WindowedAttributes and AppControlledScreenMode. Give
//     ColorSpace a valid value and the black screen comes back, because those start applying again.
//
// It also explains the old "dgVoodoo applies our settings inconsistently" note, and the watermark
// that would not turn off.
//
// The lesson is general, not about one game: dgVoodoo reports a rejected value only to a debug build,
// so a wrong string here disables everything after it in silence. Anything added to this file must be
// a value the shipped binary actually accepts -- check the log of a debug build, not the .conf
// comments. configureDgVoodoo repairs the bad value wherever it is still on disk.
const DG_DISPLAY = [
  ['General', 'ScalingMode', 'stretched_ar'],
  ['GeneralExt', 'WindowedAttributes', 'borderless, fullscreensize'],
];

// The invalid value this app used to write, kept only so an install that still carries it is repaired.
// 'appdriven' is dgVoodoo's own shipped default, so this puts the file back to stock and, far more
// importantly, lets the rest of it parse.
// What the 2.87.4 BINARY accepts, taken from its own rejection message, not from the .conf comments
// (which still list the pre-rename 'argb8888_srgb' and 'argb2101010_sdr'). Anything else in this key
// -- ours or a value someone copied out of those comments -- silently voids the rest of the file, so
// it is repaired to dgVoodoo's own default rather than left to break the install quietly.
const DG_COLORSPACE_VALID = new Set(['appdriven', 'argb8888_sdr', 'argb2101010_sdr_wcg', 'argb16161616_hdr']);
const DG_COLORSPACE_STOCK = 'appdriven';

// Returns the conf with a rejected ColorSpace put back to stock. A key that is absent, empty or
// already valid is left exactly as it is: unspecified is a legitimate state, and a valid value is
// somebody's choice.
function repairColourSpace(text) {
  const colour = getIniKey(text, 'GeneralExt', 'ColorSpace');
  if (colour === null) return text;
  const value = String(colour).trim();
  if (value === '' || DG_COLORSPACE_VALID.has(value.toLowerCase())) return text;
  return setIniKey(text, 'GeneralExt', 'ColorSpace', DG_COLORSPACE_STOCK);
}

// Games whose picture the presentation keys break get OutputAPI and VRAM and NOTHING else -- no
// ScalingMode, no WindowedAttributes and no forced windowing -- because
// stock-plus-those-two is the exact configuration proven to work, and this is not the place to guess
// which individual key a game dislikes.
//
// Assassin's Creed II (proven 2026-09-21): stock + OutputAPI=d3d11_fl11_0 + VRAM=4096 gives a picture
// and 600+ DLSS 5 frames at 56.6 fps. Add the forced-window trio and the screen goes black.
//
// It is feeder.js's FULLSCREEN_ONLY_EXES because the same fact drives the other half of the decision
// there -- a game left in exclusive fullscreen needs host_window=3 and cast_mode=1 to have a panel at
// all. One list, so the two halves cannot drift apart.
const needsMinimalDgVoodoo = feeder.needsFullscreenHost;

// [DirectXExt] AdapterIDType: which vendor's PCI ids and driver-version format the DX API layer
// reports to the game. dgVoodoo leaves it undefined and answers as its own virtual card, and an old
// game that recognises nobody takes its worst path.
//
// Fallout New Vegas, 2026-09-21. The game crashed every time the world loaded, at
// FalloutNV+0x757aa9, reading address 0:
//
//     call 0x755560          ; BSShaderManager::GetShader(29)
//     mov  esi,eax           ; -> NULL
//     mov  eax,[esi]         ; c0000005
//
// GetShader builds a shader only behind a global byte that was 0, so slot 29 of its cache stayed
// null and the game dereferenced it without a check. That byte is off because the game had picked
// its Shader Model 2.0 path, which its own RendererInfo.txt states:
//
//     NVIDIA GeForce RTX 5070 Ti Laptop (dgVoodoo DX API Layer)
//     RenderPath   : BSSM_SV_2_0        3.0 Support    : yes
//     3.0 Lighting : no                 Shader Package : 2
//
// "3.0 Support: yes" one line above "3.0 Lighting: no" is the whole diagnosis: the caps were never
// the problem. The game can do Shader Model 3.0 and refuses to, because it does not recognise who
// it is talking to. bAllow30Shaders=1 in both of its inis changed nothing; this key did.
//
// The real vendor, never a fixed string. Reporting NVIDIA on an AMD machine would buy the same
// recognition and then send a game down a vendor-specific path the GPU underneath cannot answer.
// An unknown vendor writes no key at all, which is where dgVoodoo already was.
//
// Only meaningful with VideoCard=internal3D (dgVoodoo: "Can be defined only for SVGA and Internal3D
// card types") -- the line right above it below -- so it belongs there, past the minimal return.
const DG_ADAPTER_ID_TYPES = new Set(['nvidia', 'amd', 'intel']);

function configureDgVoodoo(text, { windowed = false, minimal = false, vendor = null } = {}) {
  let out = String(text || '');

  // First, always. Left in place a rejected value voids every key below it, including the VRAM line
  // two sections down, so this has to happen whatever else does.
  out = repairColourSpace(out);

  // The two that earn their place on every dgVoodoo2 route. OutputAPI pins the D3D11 output the
  // Feeder's add-on attaches to; VRAM raises the emulated card off its 256MB default, which a modern
  // resolution exhausts -- and a game that runs out gets a NULL from CreateTexture, which is a crash
  // in anything written when 256MB was a lot.
  out = setIniKey(out, 'General', 'OutputAPI', 'd3d11_fl11_0');
  out = setIniKey(out, 'DirectX', 'VRAM', '4096');

  // These two are safe on a minimal game as well. CaptureMouse sat ABOVE the poisoned ColorSpace line
  // all along, so it is the one key here already proven not to disturb AC2; the watermark is an
  // overlay rather than a presentation mode. Without it a minimal game would be the only one showing
  // dgVoodoo's banner -- which it avoided before only by accident, when the whole file was voided.
  out = setIniKey(out, 'General', 'CaptureMouse', 'false');
  out = setIniKey(out, 'DirectX', 'dgVoodooWatermark', 'false');
  if (minimal) return out;

  out = setIniKey(out, 'DirectX', 'DisableAndPassThru', 'false');
  out = setIniKey(out, 'DirectX', 'VideoCard', 'internal3D');
  if (DG_ADAPTER_ID_TYPES.has(vendor)) out = setIniKey(out, 'DirectXExt', 'AdapterIDType', vendor);
  for (const [section, key, value] of DG_DISPLAY) out = setIniKey(out, section, key, value);
  if (windowed) for (const [section, key, value] of DG_WINDOWED) out = setIniKey(out, section, key, value);
  return out;
}

// Brings an existing install's dgVoodoo.conf up to the current display settings: the scaled image on
// every dgVoodoo2 route, and the borderless window on the 32-bit route (installs made before either
// existed). Returns true when the file changed.
function ensureDgVoodooWindowed(dir, { vendor = null } = {}) {
  const marker = readMarker(dir);
  if (!marker || !marker.dgVoodoo) return false;
  const confPath = path.join(dir, 'dgVoodoo.conf');
  let text;
  try { text = fs.readFileSync(confPath, 'utf8'); } catch { return false; }
  let next = text;

  // The repair comes first and applies to every install: while a rejected value is in the file,
  // nothing below it in the file is being read at all.
  next = repairColourSpace(next);

  // An install made before the VRAM line could take effect still has the 256MB default written -- or
  // nothing at all -- so bring it up here too. This is the line that stops the CreateTexture crash.
  next = setIniKey(next, 'General', 'OutputAPI', 'd3d11_fl11_0');
  next = setIniKey(next, 'DirectX', 'VRAM', '4096');

  if (!needsMinimalDgVoodoo(dir))
  {
    // Installs from before the vendor was reported at all (DG_ADAPTER_ID_TYPES): a game that picked
    // its worst render path off dgVoodoo's virtual card keeps that path until this line lands.
    if (DG_ADAPTER_ID_TYPES.has(vendor)) next = setIniKey(next, 'DirectXExt', 'AdapterIDType', vendor);
    for (const [section, key, value] of DG_DISPLAY) next = setIniKey(next, section, key, value);
    if (marker.host32) for (const [section, key, value] of DG_WINDOWED) next = setIniKey(next, section, key, value);
  }
  if (next === text) return false;
  fs.writeFileSync(confPath, next, 'utf8');
  return true;
}

// host64\ReShade.ini: the helper's own ReShade must never put its overlay on screen. That ReShade is
// plumbing -- it exists so the helper can load the add-on chain -- and the helper's window is what
// the game shows as the DLSS 5 panel, so anything ReShade draws there lands on top of the panel and
// is all the player sees. Alt+Home did exactly that on Alien: Isolation (2026-09-16): the cast came
// up showing ReShade's Add-ons tab, with OptiScaler's panel behind it.
//
// KeyOverlay is [INPUT] KeyOverlay = key,ctrl,shift,alt, and ReShade's is_key_pressed returns false
// outright for key 0 (input.cpp: `if (keycode == 0) return false`), so a zero disables the hotkey
// rather than binding something. The game's own ReShade.ini is untouched -- there the overlay is a
// real feature the player may want.
const HOST_RESHADE_KEYS = [
  ['INPUT', 'KeyOverlay', '0,0,0,0'],
];

// Gives an existing 32-bit install the Alt+Home key for the in-game panel (installs made before the
// deploy set it). Only for this route: a cast_key on any other route would toggle a picture of a
// host process that is not running there. Returns true when the file changed.
function ensureCastKey(dir) {
  const marker = readMarker(dir);
  if (!marker || !marker.host32) return false;

  let changed = false;
  try { changed = configureFeedCfg(dir).configured; } catch { /* the Feeder writes its own on first save */ }

  // The same upgrade for the helper's ReShade overlay key (HOST_RESHADE_KEYS).
  const hostIniPath = path.join(dir, HOST_DIR, 'ReShade.ini');
  try {
    const text = fs.readFileSync(hostIniPath, 'utf8');
    let next = text;
    for (const [section, key, value] of HOST_RESHADE_KEYS) next = setIniKey(next, section, key, value);
    if (next !== text) { fs.writeFileSync(hostIniPath, next, 'utf8'); changed = true; }
  } catch { /* no helper ini yet */ }

  return changed;
}

// The Feeder's three files on an installed 32-bit game, brought up to the given release zip. Sync
// used to return before the Feeder for this route, so a game kept whatever Feeder it was installed
// with: Castlevania LoS2 sat on 1.16.0-beta.5 after beta.6 fixed the in-game panel's cursor, and the
// mouse froze with the panel open (2026-09-22).
//
// All or nothing. The add-on and the helper refuse each other across an IPC version change, so a
// half-done refresh -- the helper exe locked by a running game, say -- would break a working install.
// Every file is read first; if any write fails, the ones already written are put back.
async function refreshFeeder32(dir, feederZip) {
  const marker = readMarker(dir);
  if (!marker || !marker.host32 || !feederZip || !fs.existsSync(feederZip)) return { updated: false };
  const zip = openZip(feederZip);
  const files = [
    [path.join(dir, 'dlss5-feed.addon32'), ENTRY.addon32],
    [path.join(dir, HOST_DIR, 'dlss5-feed-host64.exe'), ENTRY.host64],
    [path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'), ENTRY.feedFx],
  ];
  const plan = [];
  for (const [dest, re] of files) {
    const entry = findEntry(zip, re);
    if (!entry || !fs.existsSync(dest)) return { updated: false, reason: `${path.basename(dest)} missing` };
    const next = extractEntry(zip, entry);
    const prev = fs.readFileSync(dest);
    if (!prev.equals(next)) plan.push({ dest, prev, next });
  }
  if (plan.length === 0) return { updated: false };
  const done = [];
  try {
    for (const step of plan) {
      await fsp.writeFile(step.dest, step.next);
      done.push(step);
    }
  } catch (error) {
    for (const step of done) await fsp.writeFile(step.dest, step.prev).catch(() => {});
    throw error;
  }
  return { updated: true, files: plan.map((s) => path.relative(dir, s.dest)) };
}

// LEGACY_QUARANTINE_WAIT_MS lets tests skip the pause a real security scanner needs.
async function stillThere(file) {
  const wait = Number(process.env.LEGACY_QUARANTINE_WAIT_MS ?? 1500);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try { fs.accessSync(file, fs.constants.R_OK); fs.readFileSync(file).subarray(0, 2); return true; } catch { return false; }
}

function fileMentions(file, text) {
  try { return fs.readFileSync(file).includes(Buffer.from(text, 'latin1')); } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Placing files, recorded

function recorder(dir, marker) {
  const rel = (p) => path.relative(dir, p).split(path.sep).join('/');
  return {
    // Before writing dest: a file of someone else's under that name is kept aside for Remove.
    async claim(dest, { ours = () => false } = {}) {
      const r = rel(dest);
      if (marker.files.includes(r) || marker.backups.some((b) => b.rel === r)) return;
      if (fs.existsSync(dest) && !ours(dest)) {
        const backup = dest + BACKUP_SUFFIX;
        if (!fs.existsSync(backup)) await fsp.rename(dest, backup);
        marker.backups.push({ rel: r, backup: rel(backup) });
      } else {
        marker.files.push(r);
      }
    },
    async write(dest, buf, opts) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await this.claim(dest, opts);
      await fsp.writeFile(dest, buf);
    },
    async copy(src, dest, opts) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await this.claim(dest, opts);
      await fsp.copyFile(src, dest);
    },
  };
}

function emptyMarker(existing) {
  return existing && Array.isArray(existing.files)
    ? { ...existing, backups: existing.backups || [] }
    : { version: 1, files: [], backups: [], dirs: [] };
}

// Games whose renderer can never pick up a d3d8.dll/d3d9.dll placed beside the exe, because Windows
// has already loaded its own copy by the time the renderer asks: a module of the same name already
// loaded is what LoadLibrary returns, whatever folder it came from.
//
// Max Payne 1 and 2 run a DxDiag probe at startup (dxdiagn.dll, which loads C:\Windows\system32\
// d3d8.dll by full path) before e2driver\e2_d3d8_driver_mfc.dll calls LoadLibraryA("d3d8.dll") -- so
// dgVoodoo's D3D8.dll was never loaded, and nothing on the route ran (2026-09-23, confirmed from the
// running process's module list). No switch skips the probe (-skipstartup and -nodialog both tried).
// The renderer is pointed at a name nothing else loads instead: the lowercase name it LOADS is
// rewritten in place, same length, and dgVoodoo's DLL is placed under that name as well. The original
// renderer goes through the recorder's backup, so Remove puts it back.
//
// Only the lowercase one. The renderer also names D3D8.DLL in upper case, and that is its DirectX
// version check -- it reads that file's version. Renamed too, it read dgVoodoo's version (2.87), and
// the game refused to start: "requires a Microsoft DirectX 9.0 compatible display adapter". Left
// pointing at Windows' own file, the check passes and the rendering still goes through dgVoodoo.
//
// registry: a setting of the game's own that has to change for the panel to be usable. Max Payne 2
// minimises the moment it loses focus -- which the pop-out has to take, or the game keeps the mouse
// clipped to its window -- unless Advanced Settings\AllowTaskSwitching is 1. What was there before is
// recorded and put back by Remove.
const RENDERER_RENAMES = [
  {
    exe: /^maxpayne2\.exe$/i,
    file: 'e2driver/e2_d3d8_driver_mfc.dll',
    wrapper: 'D3D8.dll',
    as: 'dgd8.dll',
    replace: [['d3d8.dll', 'dgd8.dll']],
    registry: { key: 'HKCU\\Software\\Remedy Entertainment\\Max Payne 2\\Advanced Settings', name: 'AllowTaskSwitching', value: 1 },
  },
  {
    exe: /^maxpayne\.exe$/i,
    file: 'e2driver/e2_d3d8_driver_mfc.dll',
    wrapper: 'D3D8.dll',
    as: 'dgd8.dll',
    replace: [['d3d8.dll', 'dgd8.dll']],
  },
];

// reg.exe rather than a native module: a DWORD read and written once per install. Returns the value
// that was there (null when there was none) so Remove can put it back. OPTIDLSS5_NO_REGISTRY=1 keeps
// tests off the machine's real registry.
function setGameRegistryDword({ key, name, value }) {
  if (process.platform !== 'win32' || process.env.OPTIDLSS5_NO_REGISTRY === '1') return { skipped: true };
  const { execFileSync } = require('node:child_process');
  let before = null;
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', name], { windowsHide: true, encoding: 'utf8' });
    const m = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(out);
    if (m) before = parseInt(m[1], 16);
  } catch { /* no such value yet */ }
  if (before === value) return { before, changed: false };
  execFileSync('reg.exe', ['add', key, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'], { windowsHide: true });
  return { before, changed: true };
}

function restoreGameRegistryDword({ key, name, before }) {
  if (process.platform !== 'win32' || process.env.OPTIDLSS5_NO_REGISTRY === '1') return;
  const { execFileSync } = require('node:child_process');
  try {
    if (before === null || before === undefined) execFileSync('reg.exe', ['delete', key, '/v', name, '/f'], { windowsHide: true });
    else execFileSync('reg.exe', ['add', key, '/v', name, '/t', 'REG_DWORD', '/d', String(before), '/f'], { windowsHide: true });
  } catch { /* the game's key has gone with the game */ }
}

function rendererRenameFor(dir, dll) {
  let exes = [];
  try { exes = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f)); } catch { return null; }
  return RENDERER_RENAMES.find((r) => r.wrapper.toLowerCase() === String(dll).toLowerCase()
    && exes.some((e) => r.exe.test(e))
    && fs.existsSync(path.join(dir, ...r.file.split('/')))) || null;
}

// Every occurrence of each ASCII pair swapped in place. Same length both ways, so nothing moves.
function swapAscii(buf, pairs) {
  const out = Buffer.from(buf);
  let count = 0;
  for (const [from, to] of pairs) {
    const a = Buffer.from(from, 'latin1');
    const b = Buffer.from(to, 'latin1');
    if (a.length !== b.length) throw new Error(`renderer rename ${from} -> ${to} changes the length`);
    for (let i = out.indexOf(a); i !== -1; i = out.indexOf(a, i + a.length)) {
      b.copy(out, i);
      count++;
    }
  }
  return { buf: out, count };
}

async function applyRendererRename(dir, rule, dllBytes, rec) {
  const target = path.join(dir, ...rule.file.split('/'));
  const backup = target + BACKUP_SUFFIX;
  // Patched from the game's own file: the backup when one is already set aside, so a second Install
  // never patches a patched copy (and an old hand-made backup counts as the original too).
  const original = fs.readFileSync(fs.existsSync(backup) ? backup : target);
  const { buf, count } = swapAscii(original, rule.replace);
  if (count === 0) {
    // Already renamed by hand, or a different build of the renderer: nothing to rewrite, and writing
    // the wrapper under the new name would do no good either.
    return { renamed: false, reason: `${rule.file} names no ${rule.replace[0][0]}` };
  }
  await rec.write(path.join(dir, rule.as), dllBytes, { ours: (p) => translation.identifyWrapper(p) === 'dgvoodoo' });
  await rec.write(target, buf, { ours: () => false });
  let registry = null;
  if (rule.registry) {
    try {
      const r = setGameRegistryDword(rule.registry);
      if (!r.skipped) registry = { key: rule.registry.key, name: rule.registry.name, before: r.before };
    } catch { /* the game's own setting is a convenience; the route works without it */ }
  }
  return { renamed: true, file: rule.file, as: rule.as, occurrences: count, registry };
}

// The same rename for DXVK in dgVoodoo2's place -- the layer that actually works on Max Payne 2
// (2026-09-23: DLSS 5 over 4,500 frames, ReShade as its Vulkan layer). dgVoodoo2 cannot: it creates its
// D3D11 device past ReShade's hooks, so nothing is ever drawn and the Feeder has no frames.
//
// DXVK's d3d8.dll imports d3d9.dll, and by then Windows' own D3D9.DLL is loaded too (the same DxDiag
// probe), so a d3d9.dll beside the exe would lose exactly as d3d8.dll did. One level further down, then:
// dgd8.dll is DXVK's d3d8 with that import renamed to dgd9.dll, and dgd9.dll is DXVK's d3d9. The
// renderer is patched as on the dgVoodoo2 route, so switching layers swaps only what dgd8 is.
// dxvkArchDir: the DXVK release's x32 folder.
async function applyRendererRenameForDxvk(dir, dxvkArchDir) {
  const rule = rendererRenameFor(dir, 'D3D8.dll');
  if (!rule) return null;
  let d3d8;
  let d3d9;
  try {
    d3d8 = fs.readFileSync(path.join(dxvkArchDir, 'd3d8.dll'));
    d3d9 = fs.readFileSync(path.join(dxvkArchDir, 'd3d9.dll'));
  } catch {
    return { renamed: false, reason: 'this DXVK release has no x32 d3d8.dll/d3d9.dll' };
  }
  const { buf: d8, count } = swapAscii(d3d8, [['d3d9.dll', 'dgd9.dll']]);
  if (count === 0) return { renamed: false, reason: 'DXVK\'s d3d8.dll names no d3d9.dll' };

  const prior = readMarker(dir) || {};
  const priorRegistry = prior.rendererRegistry || ((prior.dgVoodoo || {}).rendererRename || {}).registry || null;
  const marker = emptyMarker(prior);
  const rec = recorder(dir, marker);
  const renamed = await applyRendererRename(dir, rule, d8, rec);
  if (!renamed.renamed) return renamed;
  await rec.write(path.join(dir, 'dgd9.dll'), d3d9, { ours: () => true });
  marker.rendererRegistry = priorRegistry || renamed.registry || null;
  writeMarker(dir, marker);
  return { ...renamed, dxvk: true, alsoAs: 'dgd9.dll' };
}

// source: a cache folder from ensureDgVoodoo/importDgVoodooZip.
async function deployDgVoodoo(dir, plan, source, { vendor = null } = {}) {
  if (!plan || !plan.dgVoodoo) throw new Error('this game does not need dgVoodoo2');
  if (!readDgFolder(source)) throw new Error('dgVoodoo2 is not in the cache (or one of its files has gone) -- press Install again');
  const read = (rel) => {
    try { return fs.readFileSync(path.join(source, ...rel.split('/'))); } catch { return null; }
  };
  const dllRel = `MS/${plan.dgVoodoo.arch}/${plan.dgVoodoo.dll}`;
  const dll = read(dllRel);
  const conf = read('dgVoodoo.conf');
  const cpl = read('dgVoodooCpl.exe');
  if (!dll || !conf || !cpl) throw new Error(`the dgVoodoo2 files have no ${dllRel.replace(/\//g, '\\')}`);

  // Through the same gate as DXVK (translation.js canDeploy), so the two layers can never share the
  // folder. This deploy used to go straight in: on a game swapped to DXVK, Install -- or the
  // 'dgvoodoo-missing' rule behind it -- put dgVoodoo2's D3D9.dll over DXVK's, backed DXVK up as "the
  // game's own", and left a DXVK manifest claiming a layer that was no longer live. A layer this app
  // placed is purged first; one the player placed is refused.
  const gate = translation.canDeploy(dir, 'dgvoodoo');
  if (!gate.ok) throw Object.assign(new Error(gate.reason), { code: 'translation-conflict' });
  if (gate.purgeFirst && gate.conflict && gate.conflict !== 'dgvoodoo') {
    await translation.purgeTranslationLayer(dir, { layer: gate.conflict });
  }
  // DXVK out means ReShade's dxgi.dll proxy is what presents the Feeder again.
  await unparkReShadeProxy(dir);

  const marker = emptyMarker(readMarker(dir));
  const rec = recorder(dir, marker);
  // By contents in both encodings: dgVoodoo2's D3D9.dll names itself only in UTF-16 (its version
  // resource), so a latin1 search never recognised it (Assassin's Creed II's D3D9.dll, 2026-09-18).
  const isDg = (p) => translation.identifyWrapper(p) === 'dgvoodoo';
  await rec.write(path.join(dir, plan.dgVoodoo.dll), dll, { ours: isDg });
  // A renderer that could never load that file under its own name gets pointed at another one.
  const renameRule = rendererRenameFor(dir, plan.dgVoodoo.dll);
  // The registry value from BEFORE this app first changed it: a second Install reads back the value it
  // wrote itself, and recording that would leave Remove restoring our setting as the player's.
  const priorRegistry = (((readMarker(dir) || {}).dgVoodoo || {}).rendererRename || {}).registry || null;
  const renamed = renameRule ? await applyRendererRename(dir, renameRule, dll, rec) : null;
  const keptRegistry = (r) => priorRegistry || (r && r.registry) || null;
  await rec.write(path.join(dir, 'dgVoodooCpl.exe'), cpl, { ours: isDg });
  const confPath = path.join(dir, 'dgVoodoo.conf');
  const base = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : conf.toString('utf8');
  await rec.write(confPath,
                  Buffer.from(configureDgVoodoo(base, { windowed: !!plan.host32, minimal: needsMinimalDgVoodoo(dir), vendor }), 'utf8'),
                  { ours: () => true });
  marker.dgVoodoo = { arch: plan.dgVoodoo.arch, dll: plan.dgVoodoo.dll, source: path.basename(source),
    ...(renamed && renamed.renamed ? { rendererRename: { file: renamed.file, as: renamed.as, registry: keptRegistry(renamed) } } : {}) };
  marker.placedAt = new Date().toISOString();
  writeMarker(dir, marker);
  // And the translation manifest, so activeLayer answers from a record for dgVoodoo2 just as it does
  // for DXVK. Only dgVoodoo2's own names: the rest of the marker is the helper route's.
  const dgNames = [plan.dgVoodoo.dll, 'dgVoodooCpl.exe', 'dgVoodoo.conf'];
  translation.writeManifest(dir, translation.newManifest({
    layer: 'dgvoodoo',
    arch: plan.dgVoodoo.arch,
    source: path.basename(source),
    files: dgNames.filter((n) => marker.files.includes(n)),
    backups: marker.backups.filter((b) => dgNames.includes(b.rel)),
  }));
  // Antivirus can take the wrapper out of the game folder just as it can out of the cache.
  if (!(await stillThere(path.join(dir, plan.dgVoodoo.dll)))) {
    throw Object.assign(new Error(
      `${plan.dgVoodoo.dll} (dgVoodoo2) was placed beside the game and then removed or blocked -- that is what antivirus ` +
      'quarantine looks like. Check Windows Security\'s protection history.'), { code: 'dgvoodoo-quarantined' });
  }
  return { deployed: true, dll: plan.dgVoodoo.dll, arch: plan.dgVoodoo.arch, rendererRename: renamed };
}

// deps (all required):
//   feederZip      path to the Feeder release zip (addon32, host64 exe, DLSS5_Feed.fx)
//   reshadeSetup   path to ReShade's add-on setup exe (a zip with ReShade32.dll and ReShade64.dll)
//   releaseFolder  the OptiScaler_DLSSNR release folder
//   nrDllPath      nvngx_dlssnr.dll
//   deployShaders(dir)          headers, motion-vector provider, ReShade.ini and preset beside the exe:
//                               deployLegacyShaders' result, or a plain list of the files it created
//   deployNvngxDlss(hostDir)    nvngx_dlss.dll into the helper folder
// Keys in host64\OptiScaler.ini that the ENGINE writes, not this app. [DlssNr] PanelShownOnce: the
// DLSS 5 panel auto-opens once in the Feeder helper and the engine then sets it true, so it stays
// shut on later launches (2026-09-18). Every other writer here edits single lines (setIniKey,
// ensureIniKey, dlssnr.writeSettings), which never drops a key; the one thing that does is a
// re-install copying the release's OptiScaler.ini over the file, so deployHost32 reads these first
// and puts them back. Without it every re-install would pop the panel open again.
const ENGINE_OWNED_HOST_KEYS = [['DlssNr', 'PanelShownOnce']];

function readEngineOwnedKeys(iniPath) {
  let text;
  try { text = fs.readFileSync(iniPath, 'utf8'); } catch { return []; }
  const kept = [];
  for (const [section, key] of ENGINE_OWNED_HOST_KEYS) {
    const value = getIniKey(text, section, key);
    if (value !== null && value !== undefined && String(value).trim() !== '') kept.push([section, key, String(value).trim()]);
  }
  return kept;
}

async function deployHost32(dir, plan, deps) {
  if (!plan || !plan.host32) throw new Error('this game does not take the 32-bit helper route');
  for (const k of ['feederZip', 'reshadeSetup', 'releaseFolder', 'nrDllPath']) {
    if (!deps[k] || !fs.existsSync(deps[k])) throw new Error(`missing ${k}: ${deps[k] || '(not set)'}`);
  }
  const hostDir = path.join(dir, HOST_DIR);
  const existing = readMarker(dir);
  if (fs.existsSync(hostDir) && !(existing && existing.host32)) {
    throw new Error(`${HOST_DIR}\\ already exists beside the game and was not made by this app -- another Feeder install? Remove it first.`);
  }
  const marker = emptyMarker(existing);
  const rec = recorder(dir, marker);
  if (!marker.dirs.includes(HOST_DIR)) marker.dirs.push(HOST_DIR);

  const feederZip = openZip(deps.feederZip);
  const reshadeZip = openZip(deps.reshadeSetup);
  const need = (zip, re, what) => {
    const e = findEntry(zip, re);
    if (!e) throw new Error(`${what} not found in ${path.basename(zip === feederZip ? deps.feederZip : deps.reshadeSetup)}`);
    return extractEntry(zip, e);
  };
  const isReShade = (p) => fileMentions(p, 'ReShade');

  // Beside the 32-bit game. While DXVK is in front of it the proxy stays parked (parkReShadeProxy):
  // a re-install refreshes the parked copy rather than bringing a second ReShade back beside the
  // Vulkan layer's.
  const parkedProxy = (marker.parked || []).find((p) => p.rel === plan.reshadeName);
  if (parkedProxy && fs.existsSync(path.join(dir, parkedProxy.parked))) {
    await fsp.writeFile(path.join(dir, parkedProxy.parked), need(reshadeZip, ENTRY.reshade32, 'ReShade32.dll'));
  } else {
    await rec.write(path.join(dir, plan.reshadeName), need(reshadeZip, ENTRY.reshade32, 'ReShade32.dll'), { ours: isReShade });
  }
  await rec.write(path.join(dir, 'dlss5-feed.addon32'), need(feederZip, ENTRY.addon32, 'dlss5-feed.addon32'), { ours: () => true });
  await rec.write(path.join(dir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx'), need(feederZip, ENTRY.feedFx, 'DLSS5_Feed.fx'), { ours: () => true });
  if (!marker.dirs.includes('reshade-shaders')) marker.dirs.push('reshade-shaders');
  for (const f of ['ReShade.ini', 'ReShadePreset.ini']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) marker.files.includes(f) || marker.files.push(f);
  }
  // Which provider was here before, read before deployShaders rewrites the preset: a re-install that
  // changes it has to take the old one's files back out, the same as legacy:setMvProvider does.
  const outgoingMv = currentMvProvider(dir);
  const shaders = await deps.deployShaders(dir);
  if (Array.isArray(shaders) || !shaders) {
    for (const f of shaders || []) if (!marker.files.includes(f)) marker.files.push(f);
  } else {
    await adoptMvProvider(dir, marker, shaders, outgoingMv.id);
  }

  // The 64-bit helper.
  await fsp.mkdir(hostDir, { recursive: true });
  await rec.write(path.join(hostDir, 'dlss5-feed-host64.exe'), need(feederZip, ENTRY.host64, 'dlss5-feed-host64.exe'), { ours: () => true });
  await rec.write(path.join(hostDir, 'dxgi.dll'), need(reshadeZip, ENTRY.reshade64, 'ReShade64.dll'), { ours: () => true });
  let hostIni = fs.existsSync(path.join(hostDir, 'ReShade.ini')) ? fs.readFileSync(path.join(hostDir, 'ReShade.ini'), 'utf8') : '';
  hostIni = setIniKey(hostIni, 'ADDON', 'AddonPath', '.\\');
  if (!getIniKey(hostIni, 'OVERLAY', 'TutorialProgress')) hostIni = setIniKey(hostIni, 'OVERLAY', 'TutorialProgress', '4');
  for (const [section, key, value] of HOST_RESHADE_KEYS) hostIni = setIniKey(hostIni, section, key, value);
  await rec.write(path.join(hostDir, 'ReShade.ini'), Buffer.from(hostIni, 'utf8'), { ours: () => true });

  // Keys the engine itself writes into host64\OptiScaler.ini, read before the release's template
  // replaces the file below so a re-install does not undo them (ENGINE_OWNED_HOST_KEYS).
  const engineKept = readEngineOwnedKeys(path.join(hostDir, 'OptiScaler.ini'));

  // OptiScaler_DLSSNR, the release as it ships, with OptiScaler.dll as winmm.dll (the helper imports it).
  for (const entry of await fsp.readdir(deps.releaseFolder, { withFileTypes: true })) {
    const src = path.join(deps.releaseFolder, entry.name);
    if (/^setup_(windows\.bat|linux\.sh)$/i.test(entry.name)) continue;
    const destName = /^OptiScaler\.dll$/i.test(entry.name) ? 'winmm.dll' : entry.name;
    const dest = path.join(hostDir, destName);
    if (entry.isDirectory()) {
      await fsp.cp(src, dest, { recursive: true, force: true });
    } else {
      await rec.copy(src, dest, { ours: () => true });
    }
  }
  const optiIni = path.join(hostDir, 'OptiScaler.ini');
  if (fs.existsSync(optiIni)) {
    let ini = fs.readFileSync(optiIni, 'utf8');
    for (const [section, key, value] of [
      ['DlssNr', 'Enabled', 'true'],
      ['DlssNr', 'ScanExposure', 'false'],
      // Neural Rendering before Super Resolution: off, for the same reason it is off on every
      // other Feeder game (FEEDER_PRE_SR_OFF in main.js) -- Pre-SR runs the pass on the game's own
      // pre-upscale colour, and a Feeder game has no such frame: the "upscaler input" is a
      // synthetic contract the Feeder builds out of ReShade's capture, so the placement the
      // setting asks for is not there to use. On Armored Core VI it faulted inside the model every
      // run. That guard lives in autoConfigureGame, which writes the ini beside the exe -- and on
      // this route OptiScaler reads host64\OptiScaler.ini instead, which nothing was writing it
      // to. Found on a live Alien: Isolation install running with it on (2026-09-14).
      ['DlssNr', 'RunBeforeSR', 'false'],
      ['Upscalers', 'Dx12Upscaler', 'dlss'],
      ['Plugins', 'LoadReshade', 'false'],
      ['Log', 'LogToFile', 'true'],
      ['Log', 'LogLevel', '2'],
    ]) ini = setIniKey(ini, section, key, value);
    for (const [section, key, value] of engineKept) ini = setIniKey(ini, section, key, value);
    fs.writeFileSync(optiIni, ini, 'utf8');
  }
  await rec.copy(deps.nrDllPath, path.join(hostDir, 'nvngx_dlssnr.dll'), { ours: () => true });
  if (deps.deployNvngxDlss) {
    const had = fs.existsSync(path.join(hostDir, 'nvngx_dlss.dll'));
    await deps.deployNvngxDlss(hostDir);
    if (!had && fs.existsSync(path.join(hostDir, 'nvngx_dlss.dll'))) marker.files.push(`${HOST_DIR}/nvngx_dlss.dll`);
  }

  // Alt+Home shows the helper's panel inside the game. This is the only route where that takes a
  // key at all -- on every other route OptiScaler draws the panel in the game's own process and
  // owns Alt+Home itself, while here the panel lives in host64\ and the game shows a cast of it,
  // which the Feeder only puts on screen when its cast_key is pressed. That key ships as "none".
  // Directly, not through ensureCastKey: the marker that would tell it this is a host32 install is
  // written a few lines below, so on a fresh deploy that check has nothing to find yet.
  configureFeedCfg(dir);

  marker.host32 = { api: plan.api, reshadeName: plan.reshadeName };
  marker.placedAt = new Date().toISOString();
  writeMarker(dir, marker);
  return { deployed: true, hostDir, reshadeName: plan.reshadeName };
}

// ---------------------------------------------------------------------------------------------
// The motion-vector provider on the 32-bit route
//
// This route was hard-wired to VORT, the only provider that needed no question asked. On Assassin's
// Creed II (2026-09-18, DXVK + ReShade's 32-bit Vulkan layer) the whole screen, UI included, jumped
// with VORT, and the Feeder's README recommends LumeniteFX. So any provider the 64-bit Edit picker
// offers can be used here too: VORT fetched as ever, LumeniteFX live from its official repo only
// with the licence confirmed in the same dialog (feeder.js deployLumeniteFx refuses otherwise), and
// iMMERSE only when the player's own copy is already there. The shaders go beside the exe either
// way: the 32-bit ReShade reads the game folder whether it came in as the dxgi.dll proxy or as the
// Vulkan layer (the layer takes the exe's folder as its base, see parkReShadeProxy below).
//
// What the provider wrote is journaled as marker.mvProvider = { id, files } and in marker.files, so
// a later switch takes exactly those back out and Remove still cleans everything.

// A game-relative path a provider's deploy would have written, for an install made before the
// marker recorded mvProvider (every 32-bit install up to 2026-09-18 -- VORT, with its includes,
// textures and licence in folders of their own).
function providerOwnsPath(provider, rel) {
  if (!provider || !rel.startsWith('reshade-shaders/')) return false;
  const r = rel.slice('reshade-shaders/'.length);
  for (const item of provider.layout || []) {
    if (item.fromDir ? (r.startsWith(`${item.to}/`) && (!item.match || item.match.test(r))) : r === item.to) return true;
  }
  return (provider.files || []).some((f) => r === `Shaders/${f}`);
}

// Which provider this game is set up for: the marker's record, else what the preset compiles
// DLSS5_Feed for (the per-effect section wins, as it does in ReShade).
function currentMvProvider(dir) {
  const marker = readMarker(dir);
  const recorded = marker && marker.mvProvider && feeder.MV_PROVIDERS[marker.mvProvider.id];
  if (recorded) return { id: recorded.id, source: 'marker' };
  let preset = '';
  try { preset = fs.readFileSync(path.join(dir, 'ReShadePreset.ini'), 'utf8'); } catch {}
  for (const section of ['DLSS5_Feed.fx', '']) {
    const hit = /DLSS5_MV_PROVIDER\s*=\s*(\d+)/i.exec(getIniKey(preset, section, 'PreprocessorDefinitions') || '');
    if (!hit) continue;
    const byValue = Object.values(feeder.MV_PROVIDERS).find((p) => p.mvProviderValue === Number(hit[1]));
    if (byValue) return { id: byValue.id, source: 'preset' };
  }
  return { id: null, source: null };
}

// The files the provider `id` has here that this app placed: the recorded list, or for an older
// marker, the marker's own files that belong to that provider.
function mvProviderFiles(marker, id) {
  if (!marker || !id) return [];
  if (marker.mvProvider && marker.mvProvider.id === id && Array.isArray(marker.mvProvider.files)) return marker.mvProvider.files;
  const provider = feeder.MV_PROVIDERS[id];
  return (marker.files || []).filter((rel) => providerOwnsPath(provider, rel));
}

function listShaderTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(`reshade-shaders/${r}`);
    }
  };
  walk(path.join(dir, 'reshade-shaders'), '');
  return out;
}

// Headers, the provider's shaders, ReShade.ini and the preset beside a 32-bit game, reusing the
// 64-bit Feeder's own steps. Every refusal happens before anything is written, so saying no to the
// licence leaves the game on the provider it had. fetchImpl is for tests only.
//
// Returns { created, written, mvProvider: { id } }: created is every file new under reshade-shaders\
// (the journal takes those), written is what the provider step itself wrote, game-relative.
async function deployLegacyShaders(dir, providerId, { cacheDir = null, ghHeaders = {}, licenseConfirmed = false, fetchImpl = null } = {}) {
  const provider = feeder.MV_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown motion-vector provider: ${providerId}`);
  if (provider.selectable === false) throw new Error(`${provider.displayName} cannot be used: ${provider.unsupportedReason}`);
  if (provider.bringYourOwn && !feeder.mvProviderPresent(dir, providerId)) {
    throw new Error(`${provider.displayName}: ${provider.techniqueFile} is not in this game's reshade-shaders\\Shaders folder. ` +
      'Install it there yourself (this app cannot redistribute it), or pick VORT or LumeniteFX.');
  }
  if (!provider.autoFetchable && !provider.bringYourOwn && !licenseConfirmed) {
    throw new Error(`${provider.displayName} needs its licence confirmed before it can be fetched -- nothing was changed.`);
  }
  const fetchOpt = fetchImpl ? { fetchImpl } : {};
  const before = new Set(listShaderTree(dir).map((f) => f.toLowerCase()));
  await feeder.deployReShadeCommonHeaders(dir, ghHeaders, { cacheDir, ...fetchOpt });
  let wrote = [];
  if (provider.bringYourOwn) wrote = [];
  else if (provider.autoFetchable) wrote = (await feeder.deployMvProvider(dir, providerId, cacheDir, ghHeaders)).files || [];
  else wrote = (await feeder.deployLumeniteFx(dir, ghHeaders, { licenseConfirmed, providerId, ...fetchOpt })).files || [];
  feeder.configureReShadeIni(dir, {});
  feeder.configurePreset(dir, providerId);
  return {
    created: listShaderTree(dir).filter((f) => !before.has(f.toLowerCase())),
    written: wrote.map((r) => `reshade-shaders/${r}`),
    mvProvider: { id: providerId },
  };
}

// Journals a deployLegacyShaders result into `marker` (not written here) and takes the outgoing
// provider's files back out. Compared without case: on Windows VORT's Shaders\Includes and
// LumeniteFX's Shaders\include are one folder, so a listing can spell a new file either way.
async function adoptMvProvider(dir, marker, res, outgoingId) {
  const low = (s) => s.toLowerCase();
  const ours = new Set(marker.files.map(low));
  for (const f of res.created || []) {
    if (!ours.has(low(f))) { marker.files.push(f); ours.add(low(f)); }
  }
  const incoming = (res.written || []).filter((f) => ours.has(low(f)));
  const keep = new Set((res.written || []).map(low));
  const removed = [];
  const outgoing = outgoingId ? feeder.MV_PROVIDERS[outgoingId] : null;
  // Never a bring-your-own provider's files: those are the player's own iMMERSE install.
  if (outgoing && outgoingId !== res.mvProvider.id && !outgoing.bringYourOwn) {
    for (const rel of mvProviderFiles(marker, outgoingId)) {
      if (keep.has(low(rel)) || !ours.has(low(rel))) continue;
      await fsp.rm(path.join(dir, ...rel.split('/')), { force: true });
      marker.files = marker.files.filter((f) => low(f) !== low(rel));
      removed.push(rel);
    }
    // Folders the old provider brought (VORT's Includes, Textures, Licenses) once nothing is left in
    // them; reshade-shaders itself still holds DLSS5_Feed.fx.
    pruneEmptyDirs(path.join(dir, 'reshade-shaders'));
  }
  marker.mvProvider = { id: res.mvProvider.id, files: incoming, at: new Date().toISOString() };
  return removed;
}

// Switches an installed 32-bit game to another provider without reinstalling anything else.
// opts: { cacheDir, ghHeaders, licenseConfirmed, fetchImpl } as for deployLegacyShaders.
async function setMvProvider(dir, providerId, opts = {}) {
  const marker = readMarker(dir);
  if (!marker || !marker.host32) throw new Error('the 32-bit route is not installed in this game -- press Install first');
  const outgoing = currentMvProvider(dir);
  const res = await deployLegacyShaders(dir, providerId, opts);
  const next = emptyMarker(marker);
  const removed = await adoptMvProvider(dir, next, res, outgoing.id);
  writeMarker(dir, next);
  return {
    from: outgoing.id, to: providerId, removed, added: next.mvProvider.files,
    mvProviderValue: feeder.MV_PROVIDERS[providerId].mvProviderValue,
  };
}

// ---------------------------------------------------------------------------------------------
// DXVK in front of a 32-bit game: the ReShade that carries the Feeder has to change shape
//
// On the helper route the 32-bit Feeder add-on rides on ReShade, and ReShade gets into the game as
// its dxgi.dll proxy -- which works because dgVoodoo2 turns Direct3D 9 into Direct3D 11 and so
// loads dxgi.dll. DXVK turns it into Vulkan instead, nothing loads dxgi.dll any more, and the Feeder
// silently never starts: DLSS 5 just stops, with nothing in any log. Assassin's Creed II
// (2026-09-18) is the game this was worked out on -- dgVoodoo2 cannot draw it, DXVK can.
//
// Under Vulkan ReShade can only be its Vulkan layer, and for a 32-bit game that means the 32-bit
// layer. So the swap does three things, all recorded here and all undone by Remove:
//
//   1. the dxgi.dll proxy is parked under another name, so a DXVK dxgi.dll or a later wrapper can
//      never load a second ReShade next to the layer's (and ReShade's own setup refuses to install
//      the layer while a ReShade proxy sits beside the exe);
//   2. ReShade's own setup registers the 32-bit Vulkan layer and puts this exe on its app list
//      (setUpVulkanLayer32), elevated, because both live under HKLM and C:\ProgramData;
//   3. whether this app added the exe to that list is journaled, so Remove takes the exe off again
//      -- and only that: the layer itself is machine-wide and may serve other games.
//
// What the layer then loads is still this folder's: ReShade's DllMain, when loaded as a layer (a
// module not named d3d*/dxgi/opengl32), takes the EXECUTABLE's folder as its base path and only
// initialises when a ReShade.ini exists there (source/dll_main.cpp get_base_path and the "not
// enabled" check, v6.8.0). So the game-folder ReShade.ini, dlss5-feed.addon32 and reshade-shaders\
// are what it uses, exactly as the proxy did. The 32-bit add-on supports this transport itself: its
// own description reads "32-bit D3D10, D3D11, OpenGL and Vulkan (DXVK) games".

async function parkReShadeProxy(dir) {
  const marker = readMarker(dir);
  if (!marker || !marker.host32) return { parked: null, reason: 'not a 32-bit helper install' };
  const name = marker.host32.reshadeName || 'dxgi.dll';
  const cur = path.join(dir, name);
  if (!fs.existsSync(cur)) return { parked: null, reason: `${name} is not there` };
  if (translation.identifyWrapper(cur) !== 'reshade') return { parked: null, reason: `${name} is not ReShade` };
  const parked = `${name}${PARK_SUFFIX}`;
  await fsp.rm(path.join(dir, parked), { force: true });
  await fsp.rename(cur, path.join(dir, parked));
  marker.parked = [...(marker.parked || []).filter((p) => p.rel !== name), { rel: name, parked }];
  writeMarker(dir, marker);
  return { parked: name, as: parked };
}

// Puts a parked proxy back under its own name. A name something else has taken since is left as it
// is and the record kept, rather than overwriting a file this app cannot account for.
async function unparkReShadeProxy(dir) {
  const marker = readMarker(dir);
  if (!marker || !Array.isArray(marker.parked) || !marker.parked.length) return { restored: [], kept: [] };
  const restored = [];
  const kept = [];
  for (const p of marker.parked) {
    const bak = path.join(dir, p.parked);
    const cur = path.join(dir, p.rel);
    if (!fs.existsSync(bak)) continue;
    if (fs.existsSync(cur)) { kept.push(p); continue; }
    await fsp.rename(bak, cur);
    restored.push(p.rel);
  }
  marker.parked = kept;
  if (!kept.length) delete marker.parked;
  writeMarker(dir, marker);
  return { restored, kept };
}

// DXVK in front of a 32-bit DirectX 10/11 game on the helper route (dxvkReplacesNative), in the order
// that route needs: the ReShade dxgi.dll proxy parked first, because DXVK's dxgi.dll takes its name,
// then DXVK's d3d10core/d3d11/dxgi through deployDxvk (all or nothing; a game-owned file under one of
// those names is backed up in its manifest). A refusal puts the proxy straight back, so a failed swap
// leaves the folder as it found it. ReShade's 32-bit Vulkan layer is the caller's next step, exactly
// as on the DX9 swap (main.js dxvkHost32LayerStep).
//
// deploy(): runs translation.deployDxvk and returns its { ok, deployed, backedUp, refused, text }.
async function swapNativeToDxvk(dir, plan, deploy) {
  if (!dxvkReplacesNative(plan)) throw new Error('DXVK replaces native Direct3D only on a 32-bit DirectX 10/11 game');
  const parked = await parkReShadeProxy(dir);
  const r = await deploy();
  if (!r || !r.ok) {
    const back = parked.parked ? await unparkReShadeProxy(dir) : null;
    return { ...(r || {}), ok: false, parked: null, unparked: back ? back.restored : [] };
  }
  return { ...r, ok: true, parked: parked.parked ? parked : null };
}

// The way back from swapNativeToDxvk: DXVK purged by its own manifest (only files it can prove are
// DXVK's or that the manifest says it placed; the game's own d3d11.dll comes back from its backup),
// then the parked ReShade proxy back under its name so the game's Direct3D reaches the Feeder
// again. ReShade's Vulkan layer stays registered: it is machine-wide, and a game without Vulkan in
// it never loads it.
async function swapDxvkToNative(dir) {
  const purge = await translation.purgeTranslationLayer(dir, { layer: 'dxvk' });
  const unparked = await unparkReShadeProxy(dir);
  return { ...purge, unparked: unparked.restored, stillParked: unparked.kept };
}

const RESHADE_COMMON_DIR = () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'ReShade');

// ReShade's own setup, run headless and elevated, registering its Vulkan layer for this exe.
//
// The command line, from setup/MainWindow.xaml.cs (v6.8.0):
//
//   ReShade_Setup_<ver>_Addon.exe "<game exe>" --api vulkan --headless --elevated
//
//   "<game exe>"   any argument naming an existing file is the target
//   --api vulkan   skips its own API analysis and goes straight to the install
//   --headless     no window; Environment.Exit(0) on success and 1 on any failure
//   --elevated     it already has admin, so it does not relaunch itself -- a relaunch drops
//                  --headless and does not wait, which is why this is started elevated
//                  (elevate.js) rather than left to elevate itself
//
// It installs BOTH layers into C:\ProgramData\ReShade (ReShade32/64.dll + .json), registers
// ReShade32.json under HKLM\Software\Wow6432Node\Khronos\Vulkan\ImplicitLayers on 64-bit Windows,
// and adds the exe's full path to Apps= in C:\ProgramData\ReShade\ReShadeApps.ini.
//
// Two of its own refusals shape what happens around the run. A headless Vulkan install stops with
// "Existing ReShade installation found" when a ReShade.ini already sits beside the exe -- and ours
// does, holding the add-on path and the overlay keys -- so it is held aside for the run and put back
// byte for byte afterwards (the setup writes a default one of its own). And any ReShade-branded
// d3d9/dxgi/... proxy beside the exe makes it refuse, or delete it, which parkReShadeProxy has
// already dealt with.
//
// deps: setupPath (the cached ReShade setup), runElevated(file, args) -> { ok, code, cancelled,
// output }, layerStatus() -> feeder.vulkanLayerStatus({ bitness: 32, exePath }).
async function setUpVulkanLayer32(dir, exePath, { setupPath, runElevated, layerStatus }) {
  const before = await layerStatus();
  const good = (s) => !!(s && s.registered && s.addon && s.appListed !== false);
  let ran = null;
  if (!good(before) || before.appListed !== true) {
    if (!setupPath || !fs.existsSync(setupPath)) return { ok: false, error: 'ReShade\'s setup is not in the cache', before };
    const iniPath = path.join(dir, 'ReShade.ini');
    const held = `${iniPath}.dlss5ui-hold`;
    let iniText = null;
    if (fs.existsSync(iniPath)) {
      iniText = fs.readFileSync(iniPath);
      await fsp.rm(held, { force: true });
      await fsp.rename(iniPath, held);
    }
    try {
      ran = await runElevated(setupPath, [exePath, '--api', 'vulkan', '--headless', '--elevated']);
    } finally {
      if (iniText !== null) {
        try {
          fs.writeFileSync(iniPath, iniText);
          await fsp.rm(held, { force: true });
        } catch {
          // The setup's own ini could not be overwritten: put ours back by name instead.
          try { await fsp.rm(iniPath, { force: true }); await fsp.rename(held, iniPath); } catch {}
        }
      }
    }
  }
  const after = await layerStatus();
  const marker = readMarker(dir);
  if (marker) {
    const prev = marker.vulkanLayer || {};
    marker.vulkanLayer = {
      exe: exePath,
      appsPath: after.appsPath || prev.appsPath || path.join(RESHADE_COMMON_DIR(), 'ReShadeApps.ini'),
      // Sticky: once this app has put the exe on the list, Remove owes taking it off.
      listedByUs: !!prev.listedByUs || (before.appListed !== true && after.appListed === true),
      layerInstalledByUs: !!prev.layerInstalledByUs || (!before.registered && !!after.registered),
      at: new Date().toISOString(),
    };
    writeMarker(dir, marker);
  }
  if (good(after)) return { ok: true, ran: !!ran, before, after };
  let error;
  if (ran && ran.cancelled) error = 'the administrator prompt was declined';
  else if (!after.registered) error = `the 32-bit layer is not registered${ran && !ran.ok ? ` (ReShade's setup exited with ${ran.code === null ? 'an error' : `code ${ran.code}`})` : ''}`;
  else if (!after.addon) error = `the registered 32-bit layer (${after.dllPath || after.manifestPath}) is a build without add-on support`;
  else error = `${path.basename(exePath)} is not on the layer's app list (${after.appsPath})`;
  return { ok: false, error, ran: !!ran, before, after };
}

function vulkanLayerRecord(dir) {
  const marker = readMarker(dir);
  return marker && marker.vulkanLayer ? marker.vulkanLayer : null;
}

// Takes one exe off ReShade's Vulkan app list and nothing else: the layer stays registered, since it
// is machine-wide and may be serving other games. The file is admin-owned (the setup creates it
// elevated in C:\ProgramData), so a plain write is tried first and an elevated copy is the fallback.
async function unlistVulkanLayerApp(record, { runElevatedPowerShell = null } = {}) {
  if (!record || !record.exe) return { ok: true, changed: false };
  const appsPath = record.appsPath || path.join(RESHADE_COMMON_DIR(), 'ReShadeApps.ini');
  let text;
  try { text = fs.readFileSync(appsPath, 'utf8'); } catch { return { ok: true, changed: false }; }
  const want = path.resolve(record.exe).replace(/[\\/]+$/, '').toLowerCase();
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  let changed = false;
  const lines = text.split(/\r?\n/).map((line) => {
    const m = /^(\uFEFF?\s*Apps\s*=)(.*)$/i.exec(line);
    if (!m) return line;
    const apps = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    const keep = apps.filter((a) => a.replace(/[\\/]+$/, '').toLowerCase() !== want);
    if (keep.length === apps.length) return line;
    changed = true;
    return `${m[1]}${keep.join(',')}`;
  });
  if (!changed) return { ok: true, changed: false };
  const next = lines.join(eol);
  try {
    fs.writeFileSync(appsPath, next, 'utf8');
    return { ok: true, changed: true, elevated: false };
  } catch (error) {
    if (!runElevatedPowerShell) return { ok: false, changed: false, error: error.message };
    const tmp = path.join(os.tmpdir(), `dlss5ui-ReShadeApps-${process.pid}-${Date.now()}.ini`);
    fs.writeFileSync(tmp, next, 'utf8');
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const r = await runElevatedPowerShell(`Copy-Item -LiteralPath ${q(tmp)} -Destination ${q(appsPath)} -Force`);
    try { fs.rmSync(tmp, { force: true }); } catch {}
    let now = '';
    try { now = fs.readFileSync(appsPath, 'utf8'); } catch {}
    const done = now === next;
    return done
      ? { ok: true, changed: true, elevated: true }
      : { ok: false, changed: false, elevated: true, error: r && r.cancelled ? 'the administrator prompt was declined' : (r && r.output) || 'the elevated copy did not take' };
  }
}

// ---------------------------------------------------------------------------------------------
// Removing

function removalPlan(dir) {
  const marker = readMarker(dir);
  if (!marker) return { remove: [], restore: [] };
  const remove = [...(marker.files || [])].filter((rel) => fs.existsSync(path.join(dir, ...rel.split('/'))));
  // A proxy parked while DXVK was in front of the game is ours too; Remove puts it back and then
  // takes it with the rest, so the preview names it under its own name.
  for (const p of marker.parked || []) {
    if (fs.existsSync(path.join(dir, p.parked)) && !remove.includes(p.rel)) remove.push(p.rel);
  }
  for (const d of marker.dirs || []) if (d === HOST_DIR && fs.existsSync(path.join(dir, d))) remove.push(`${d}/`);
  const restore = (marker.backups || []).filter((b) => fs.existsSync(path.join(dir, ...b.backup.split('/')))).map((b) => b.rel);
  return { remove, restore };
}

// Removes root and every folder under it that holds no file, deepest first.
function pruneEmptyDirs(root) {
  const dirs = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    dirs.push(d);
    for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name));
  };
  walk(root);
  for (const d of dirs.reverse()) {
    try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch {}
  }
}

async function removeLegacy(dir) {
  const marker = readMarker(dir);
  const removed = [];
  const restored = [];
  if (!marker) return { removed, restored };
  // The parked ReShade proxy goes back under its name first, so the file list below takes it like
  // any other file it placed. One whose name something else took meanwhile is ours all the same.
  const unparked = await unparkReShadeProxy(dir);
  for (const p of unparked.kept) {
    await fsp.rm(path.join(dir, p.parked), { force: true });
    removed.push(p.parked);
  }
  // dgVoodoo2's translation manifest describes files this marker also lists and is about to remove.
  const tl = translation.readManifest(dir);
  if (tl && tl.layer === 'dgvoodoo' && !tl.fromLegacyMarker) await fsp.rm(path.join(dir, translation.MANIFEST), { force: true });
  for (const rel of marker.files || []) {
    const p = path.join(dir, ...rel.split('/'));
    if (fs.existsSync(p)) { await fsp.rm(p, { force: true }); removed.push(rel); }
  }
  // A game setting a renderer rename changed (Max Payne 2's AllowTaskSwitching) goes back to what it was.
  const renameRegistry = marker.rendererRegistry || ((marker.dgVoodoo || {}).rendererRename || {}).registry;
  if (renameRegistry) restoreGameRegistryDword(renameRegistry);
  for (const b of marker.backups || []) {
    const cur = path.join(dir, ...b.rel.split('/'));
    const bak = path.join(dir, ...b.backup.split('/'));
    if (!fs.existsSync(bak)) continue;
    await fsp.rm(cur, { force: true });
    await fsp.rename(bak, cur);
    restored.push(b.rel);
  }
  // The helper folder is entirely ours (deployHost32 refuses to use one it did not create).
  if ((marker.dirs || []).includes(HOST_DIR) && fs.existsSync(path.join(dir, HOST_DIR))) {
    await fsp.rm(path.join(dir, HOST_DIR), { recursive: true, force: true });
    removed.push(`${HOST_DIR}/`);
  }
  for (const rel of ['dlss5-feed.cfg', 'dlss5-feed.log', 'ReShade.log', 'dgVoodoo.log']) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { await fsp.rm(p, { force: true }); removed.push(rel); }
  }
  // Folders the shaders brought (VORT adds Shaders\Includes, Textures, Licenses) go once they are
  // empty, deepest first; anything still holding a file of someone else's stays. Castlevania: Lords
  // of Shadow 2 kept four empty folders after Remove when only Shaders\include was checked.
  pruneEmptyDirs(path.join(dir, 'reshade-shaders'));
  await fsp.rm(path.join(dir, MARKER), { force: true });
  return { removed, restored };
}

module.exports = {
  HOST_OPTISCALER_DLL,
  MARKER, HOST_DIR, DGVOODOO, PARK_SUFFIX, planFor, dxvkReplacesNative, status, readMarker, ensureDgVoodoo, importDgVoodooZip, cachedDgVoodoo,
  isDgVoodooZip, configureDgVoodoo, DG_COLORSPACE_VALID, ensureDgVoodooWindowed, ensureCastKey, refreshFeeder32, deployDgVoodoo, deployHost32, removalPlan, removeLegacy,
  parkReShadeProxy, unparkReShadeProxy, swapNativeToDxvk, swapDxvkToNative, setUpVulkanLayer32, vulkanLayerRecord, unlistVulkanLayerApp,
  currentMvProvider, deployLegacyShaders, setMvProvider, swapAscii, rendererRenameFor, RENDERER_RENAMES, applyRendererRenameForDxvk,
};
