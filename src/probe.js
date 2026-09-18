// Watched launch ("Analyse game"): start the game once, untouched, for about 25 seconds and write
// down what the process tree really does -- which DLLs it loads and from where, which process hands
// off to which, and which graphics API it creates. Nothing is injected; nothing in the game folder
// changes. The game is closed at the end.
//
// Why: route choice was built on guesses from the exe on disk (detect.js: PE imports, engine rules)
// and on logs from earlier runs (runlog.js). The support issues that cost the most came from three
// guesses going wrong, and each is a fact a watched run simply observes:
//   - which proxy DLL the exe really loads. RDR2 (2026-09-16) stopped loading a dxgi.dll from its
//     own folder, so a dxgi.dll proxy sat there unused with no log at all; winmm.dll was the answer
//     (main.js PROXY_OVERRIDES). A watched run shows dxgi.dll coming from System32 while a copy sits
//     beside the exe -- `ignoredProxies` below.
//   - launcher stubs: Space Marine 2's launcher, gamelaunchhelper.exe (triage #65). The process that
//     loads a graphics API is the real game; the one the card points at may only start it.
//   - the real API: a game that links d3d11 and d3d12 creates one of them.
//
// Two ways to watch, picked at run time:
//   etw   An ETW session on Microsoft-Windows-Kernel-Process with the PROCESS (0x10) and IMAGE (0x40)
//         keywords, started with logman.exe and converted with tracerpt.exe -- both in System32, so
//         nothing to install. Sees every image load, including a DLL that is loaded and unloaded
//         between two polls, and every process start with its parent. Needs an administrator
//         token (logman -ets refuses otherwise). Checked on this project's dev machine
//         (2026-09-18) against a tiny self-made node.exe "launcher + game" pair: the trace had the
//         hand-off, the winmm.dll loaded from the game folder and d3d11.dll from System32
//         (test/fixtures/probe/etw-fakegame.xml is that trace, trimmed).
//   poll  The fallback without admin: one PowerShell loop listing the tree's processes and their
//         modules once a second. Misses a module that comes and goes between two ticks, and a 64-bit
//         PowerShell cannot enumerate a 32-bit process's own modules (.NET's Process.Modules on a
//         WOW64 target returns only the 64-bit loader's), so for a 32-bit game it can see the
//         processes and the hand-off but not much of the API. Said in the result (`method`).
// Both run together when ETW is available: the poller is also what tracks which processes are
// alive, so the game can be closed at the end.
//
// PRECEDENCE, when the facts are used (main.js effectiveDetection -> applyProbe, route.js preferDx12,
// main.js proxyNameForGame / wantedProxyFor -> proxyHint):
//   1. An API chosen in Edit (route.js withApiOverride) -- a person's statement about their game.
//   2. The newest OBSERVATION: the probe, or OptiScaler.log's runtime API (detect.js runtimeApi),
//      whichever is more recent. Both watched the game run; the newer one has seen the current
//      settings (an emulator's renderer is a setting that can change between the two).
//   3. Static analysis of the exe (detect.js).
// "Fresh" means the exe on disk is the exe that was watched: same path, size and mtime
// (detect.exeStamp). A game update expires the facts, exactly as it expires a stored detection.
// Two cases keep the static answer even with fresh facts: a DXVK/vkd3d the PLAYER put beside the exe
// (detect.js turns that game into Vulkan for the Feeder's sake, and the probe would report the
// Direct3D the game asks the wrapper for), and an emulator whose profile does not list the API seen.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PROBE_VERSION = 1;
const PROBE_SECONDS = 25;
const ETW_SESSION = 'OptiDLSS5UI-probe';
// PROCESS | IMAGE keywords of Microsoft-Windows-Kernel-Process (its manifest: WINEVENT_KEYWORD_PROCESS
// 0x10, WINEVENT_KEYWORD_IMAGE 0x40). Event 1 ProcessStart, 2 ProcessStop, 5 ImageLoad, 6 ImageUnload.
const ETW_PROVIDER = 'Microsoft-Windows-Kernel-Process';
const ETW_KEYWORDS = '0x50';

const API_LABEL = { dx8: 'DirectX 8', dx9: 'DirectX 9', dx10: 'DirectX 10', dx11: 'DirectX 11', dx12: 'DirectX 12', vulkan: 'Vulkan', opengl: 'OpenGL' };

// The DLL whose presence says an API is in use. d3d12.dll alone is not enough -- plenty of DX11 games
// link it, and it loads at start as a static import -- but D3D12Core.dll is only pulled in when a
// D3D12 device is actually created (or an Agility SDK is), so it is the DX12 signal.
const API_DLLS = {
  'd3d12core.dll': 'dx12',
  'vulkan-1.dll': 'vulkan',
  'd3d11.dll': 'dx11',
  'd3d10.dll': 'dx10',
  'd3d10_1.dll': 'dx10',
  'd3d9.dll': 'dx9',
  'd3d8.dll': 'dx8',
  'opengl32.dll': 'opengl',
};
// The GPU vendor's user-mode driver for each API: it is loaded when a device is created, not when a
// DLL is merely linked. That is what separates "creates a D3D9 device" from "imports d3d9.dll for
// D3DPERF_BeginEvent", which Unreal's D3D11 renderer does.
const UMD = {
  d3d9: /^(nvd3dumx?|aticfx(32|64)|igdumdim(32|64))\.dll$/i,
  dxgi: /^(nvwgf2umx?|atidxx(32|64)|igd10iumd(32|64)|igd12umd(32|64))\.dll$/i,
  icd: /^(nvoglv(32|64)|amdvlk(32|64)|igvk(32|64)|atio6axx|atioglxx|ig\d+icd(32|64))\.dll$/i,
};

// Names OptiScaler, ReShade and the wrappers are installed under (main.js PROXY_CANDIDATES plus the
// Direct3D and input names a wrapper or ReShade can take).
const PROXY_NAMES = ['dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d9.dll', 'd3d8.dll', 'd3d10core.dll', 'opengl32.dll', 'winmm.dll',
  'version.dll', 'dinput8.dll', 'dbghelp.dll', 'wininet.dll', 'winhttp.dll', 'xinput1_3.dll', 'xinput1_4.dll'];
// Proxy names a Vulkan/OpenGL/DX9 game loads at start (main.js EARLY_PROXY_CANDIDATES).
const EARLY_PROXIES = ['winmm.dll', 'version.dll', 'dbghelp.dll', 'wininet.dll', 'winhttp.dll'];

const ANTI_CHEAT_MODULES = [
  { re: /^easyanticheat.*\.(dll|exe)$|^eac(_launcher|launcher)?\.exe$|^start_protected_game\.exe$/i, name: 'EasyAntiCheat' },
  { re: /^beclient(_x64)?\.dll$|^beservice(_x64)?\.exe$|^belauncher\.exe$|_be\.exe$/i, name: 'BattlEye' },
  { re: /^eaanticheat.*$/i, name: 'EA AntiCheat' },
  { re: /^x3\.xem$|^xigncode/i, name: 'XIGNCODE3' },
  { re: /^npgg|^gameguard/i, name: 'nProtect GameGuard' },
  { re: /^pbcl\.dll$|^pbsvc/i, name: 'PunkBuster' },
  { re: /^equ8/i, name: 'EQU8' },
  { re: /^ace-/i, name: 'ACE' },
];

// Things that hook the game from outside and are worth naming next to a DLSS 5 route (preflight.js
// reads these too).
const OVERLAY_MODULES = [
  { re: /^rtsshooks(64)?\.dll$/i, name: 'RivaTuner Statistics Server' },
  { re: /^specialk(32|64)\.dll$/i, name: 'Special K' },
  { re: /^reshade(32|64)?\.dll$/i, name: 'ReShade' },
  { re: /^gameoverlayrenderer(64)?\.dll$/i, name: 'Steam overlay' },
  { re: /^discordhook(64)?\.dll$|^discord_overlay/i, name: 'Discord overlay' },
  { re: /^nvspcap(64)?\.dll$/i, name: 'NVIDIA overlay (ShadowPlay)' },
  { re: /^windhawk\.dll$/i, name: 'Windhawk' },
  { re: /^dlssg_to_fsr3.*\.dll$/i, name: "Nukem's DLSSG-to-FSR3" },
];

// ── Paths ─────────────────────────────────────────────────────────────────────────────────────────
// ETW names images by NT device path (\Device\HarddiskVolume3\Games\X\a.dll), the poller by DOS path
// (D:\Games\X\a.dll). Comparisons use the path with its volume taken off, lower case: two games in
// the same folder on different drives would collide, which is not a layout anyone has.
function pathKey(p) {
  let s = String(p || '').replace(/\//g, '\\');
  s = s.replace(/^\\\\\?\\/, '');
  s = s.replace(/^\\Device\\[^\\]+/i, '');
  s = s.replace(/^[A-Za-z]:/, '');
  s = s.replace(/^\\SystemRoot(?=\\)/i, '\\Windows');
  return s.toLowerCase();
}

function underDir(p, dir) {
  const k = pathKey(p);
  const d = pathKey(dir).replace(/\\+$/, '') + '\\';
  return !!dir && k.startsWith(d);
}

// A device path turned back into a drive path where the drive can be known: the game's own drive for
// anything under its folder, the system drive for anything under \Windows.
function dosPath(p, { gameRoot = null, systemDrive = 'C:' } = {}) {
  const s = String(p || '');
  if (!/^\\Device\\/i.test(s)) return s;
  const rest = s.replace(/^\\Device\\[^\\]+/i, '');
  if (gameRoot && underDir(s, gameRoot)) return `${String(gameRoot).slice(0, 2)}${rest}`;
  if (/^\\windows\\/i.test(rest)) return `${systemDrive}${rest}`;
  return s;
}

function where(p, { gameDir, gameRoot }) {
  const k = pathKey(p);
  if (/^\\windows\\(system32|syswow64|winsxs)\\/.test(k)) return 'system';
  if (gameDir && underDir(p, gameDir)) return 'game';
  if (gameRoot && underDir(p, gameRoot)) return 'game-root';
  return 'other';
}

// The folder a game's processes live under: the Steam library folder when there is one (a launcher
// at the root and the real exe under Binaries\Win64 are both in it), else the folder above an Unreal
// Binaries tree, else the exe's own folder.
function gameRootFor(exePath) {
  const p = String(exePath || '');
  const common = /^(.*?[\\/]steamapps[\\/]common[\\/][^\\/]+)/i.exec(p);
  if (common) return common[1];
  const bin = /^(.*?)[\\/](?:[^\\/]+[\\/])?Binaries[\\/](?:Win64|Win32|WinGDK)[\\/][^\\/]+$/i.exec(p);
  if (bin) return bin[1];
  return path.win32.dirname(p);
}

// ── ETW trace (tracerpt XML) ──────────────────────────────────────────────────────────────────────
function decodeText(buf) {
  if (typeof buf === 'string') return buf;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] || m;
  });
}

// tracerpt's XML, one <Event> per record. Only the fields used are read; everything else in the
// file (other providers, rendering info) is skipped. Events come out in time order.
function parseEtwXml(text) {
  const src = decodeText(text);
  const processes = new Map();
  const loads = [];
  const re = /<Event[\s>][\s\S]*?<\/Event>/g;
  let m;
  let seq = 0;
  while ((m = re.exec(src))) {
    const ev = m[0];
    if (!/Name="Microsoft-Windows-Kernel-Process"/.test(ev)) continue;
    const idm = /<EventID>(\d+)<\/EventID>/.exec(ev);
    if (!idm) continue;
    const id = Number(idm[1]);
    if (id !== 1 && id !== 2 && id !== 5) continue;
    const data = {};
    const dre = /<Data Name="([^"]+)">([^<]*)<\/Data>/g;
    let d;
    while ((d = dre.exec(ev))) data[d[1]] = unescapeXml(d[2]).trim();
    const tm = /<TimeCreated SystemTime="([^"]+)"/.exec(ev);
    const pid = Number(data.ProcessID);
    if (!Number.isFinite(pid)) continue;
    if (id === 1) {
      processes.set(pid, {
        pid, ppid: Number(data.ParentProcessID) || null, image: data.ImageName || null,
        startedAt: data.CreateTime || (tm && tm[1]) || null, exitCode: null, exited: false,
      });
    } else if (id === 2) {
      const p = processes.get(pid);
      // A stop for a process that started before the trace is none of the game's business.
      if (p) { p.exited = true; p.exitCode = data.ExitCode != null && data.ExitCode !== '' ? Number(data.ExitCode) : null; }
    } else if (id === 5 && data.ImageName) {
      loads.push({ pid, image: data.ImageName, seq: seq++ });
    }
  }
  return { processes: [...processes.values()], loads };
}

// ── Poller (PowerShell, both modes) ───────────────────────────────────────────────────────────────
// One JSON line per tick: { t, procs: [{ pid, ppid, image, name, modules: [...] }], exits: [{ pid, exitCode }] }.
// The tree is every process whose exe is under the game root (or is named in -Names), plus their
// descendants. A handle is held on each process seen, so its exit code can still be read after it
// is gone.
const POLL_SCRIPT = `param([string]$Root, [int]$Seconds = 25, [int]$IntervalMs = 1000, [int]$Modules = 1, [string]$Names = '')
$ErrorActionPreference = 'SilentlyContinue'
$rootKey = $Root.TrimEnd('\\').ToLowerInvariant() + '\\'
$nameSet = @{}
foreach ($n in ($Names -split '\\|')) { if ($n) { $nameSet[$n.ToLowerInvariant()] = $true } }
$held = @{}
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,Name)
  $tree = @{}
  foreach ($p in $all) {
    $exe = [string]$p.ExecutablePath
    if (($exe -and $exe.ToLowerInvariant().StartsWith($rootKey)) -or $nameSet.ContainsKey(([string]$p.Name).ToLowerInvariant())) { $tree[[int]$p.ProcessId] = $p }
  }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) {
      if (-not $tree.ContainsKey([int]$p.ProcessId) -and $tree.ContainsKey([int]$p.ParentProcessId)) { $tree[[int]$p.ProcessId] = $p; $grew = $true }
    }
  }
  $out = @()
  foreach ($id in @($tree.Keys)) {
    $p = $tree[$id]
    if (-not $held.ContainsKey($id)) {
      try { $h = [System.Diagnostics.Process]::GetProcessById($id); [void]$h.Handle; $held[$id] = $h } catch { $held[$id] = $null }
    }
    $mods = @()
    if ($Modules -eq 1 -and $held[$id]) {
      try { $held[$id].Refresh(); $mods = @($held[$id].Modules | ForEach-Object { $_.FileName }) } catch {}
    }
    $out += [pscustomobject]@{ pid = $id; ppid = [int]$p.ParentProcessId; image = [string]$p.ExecutablePath; name = [string]$p.Name; modules = $mods }
  }
  $exits = @()
  foreach ($id in @($held.Keys)) {
    if (-not $tree.ContainsKey($id)) {
      $h = $held[$id]; $code = $null
      if ($h) { try { if ($h.HasExited) { $code = $h.ExitCode } } catch {} }
      $exits += [pscustomobject]@{ pid = $id; exitCode = $code }
      $held.Remove($id)
    }
  }
  $line = [pscustomobject]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); procs = $out; exits = $exits } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
`;

// Folds the poller's ticks into the same shape parseEtwXml returns. Modules are first-seen order,
// which within one tick is the loader's own list order.
function collectPoll(lines) {
  const processes = new Map();
  const loads = [];
  const seen = new Set();
  let seq = 0;
  const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
  for (const raw of lines) {
    let tick;
    try { tick = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!tick) continue;
    for (const p of arr(tick.procs)) {
      const pid = Number(p.pid);
      if (!Number.isFinite(pid)) continue;
      if (!processes.has(pid)) {
        processes.set(pid, { pid, ppid: Number(p.ppid) || null, image: p.image || p.name || null, startedAt: tick.t ? new Date(tick.t).toISOString() : null, exitCode: null, exited: false, lastSeen: tick.t || null });
      } else {
        processes.get(pid).lastSeen = tick.t || null;
      }
      for (const mod of arr(p.modules)) {
        const key = `${pid}|${String(mod).toLowerCase()}`;
        if (!mod || seen.has(key)) continue;
        seen.add(key);
        loads.push({ pid, image: String(mod), seq: seq++ });
      }
    }
    for (const e of arr(tick.exits)) {
      const p = processes.get(Number(e.pid));
      if (p) { p.exited = true; p.exitCode = e.exitCode == null ? null : Number(e.exitCode); }
    }
  }
  return { processes: [...processes.values()], loads };
}

// ETW has the complete load list and exit codes; the poller has DOS paths and knows which processes
// are still up. Merged per pid: ETW's loads when it has any for that process, else the poller's.
function mergeTraces(etw, poll) {
  if (!etw) return poll || { processes: [], loads: [] };
  if (!poll) return etw;
  const procs = new Map(etw.processes.map((p) => [p.pid, { ...p }]));
  for (const p of poll.processes) {
    const e = procs.get(p.pid);
    if (!e) procs.set(p.pid, { ...p });
    else {
      if (p.image && /^[A-Za-z]:/.test(p.image)) e.image = p.image;
      if (!e.exited && p.exited) { e.exited = true; e.exitCode = p.exitCode; }
    }
  }
  const etwPids = new Set(etw.loads.map((l) => l.pid));
  const loads = [...etw.loads, ...poll.loads.filter((l) => !etwPids.has(l.pid)).map((l) => ({ ...l, seq: l.seq + 1e9 }))];
  return { processes: [...procs.values()], loads };
}

// ── Facts ─────────────────────────────────────────────────────────────────────────────────────────
// Every process started from the game's folder (or named in `names`), and everything they started.
function treePids(processes, { gameRoot, names = [] }) {
  const nameSet = new Set(names.map((n) => String(n).toLowerCase()));
  const tree = new Set();
  for (const p of processes) {
    const base = path.win32.basename(String(p.image || '')).toLowerCase();
    if ((p.image && gameRoot && underDir(p.image, gameRoot)) || nameSet.has(base)) tree.add(p.pid);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of processes) {
      if (!tree.has(p.pid) && p.ppid != null && tree.has(p.ppid)) { tree.add(p.pid); grew = true; }
    }
  }
  return tree;
}

// The graphics API from a process's modules, in load order. Returns { api, apis, evidence, uncertain }.
function apiFromModules(mods, { gameDir = null, gameRoot = null } = {}) {
  const names = mods.map((m) => path.win32.basename(String(m.image || m)).toLowerCase());
  const index = (n) => names.indexOf(n);
  const has = (n) => index(n) >= 0;
  const hasUmd = (re) => names.some((n) => re.test(n));
  const seen = [...new Set(names.map((n) => API_DLLS[n]).filter(Boolean))];
  const out = (api, evidence, uncertain = false) => ({ api, apis: api ? [api, ...seen.filter((a) => a !== api)] : seen, evidence, uncertain });
  if (!seen.length) return out(null, 'no graphics API DLL was loaded', true);

  // An API DLL loaded from the game's own folder is a wrapper or a hook (dgVoodoo2, DXVK, ReShade,
  // an OptiScaler proxy under that name). Whatever it turns the calls into, the game itself asked for
  // the API that DLL is named after -- the earliest one is the game's.
  const inFolder = mods.find((m) => API_DLLS[path.win32.basename(String(m.image || m)).toLowerCase()] &&
    ((gameDir && underDir(m.image || m, gameDir)) || (gameRoot && underDir(m.image || m, gameRoot))));
  if (inFolder) {
    const n = path.win32.basename(String(inFolder.image || inFolder)).toLowerCase();
    return out(API_DLLS[n], `${n} loaded from the game folder (a wrapper or hook takes the game's ${API_LABEL[API_DLLS[n]]} calls)`);
  }

  const firstModern = Math.min(...['d3d11.dll', 'd3d12core.dll', 'vulkan-1.dll'].map(index).filter((i) => i >= 0), Infinity);
  // A Direct3D 9/8 device loads the vendor's D3D9 driver. Loaded before any modern API, with that
  // driver present, it is the game's renderer; loaded later it is a video player or an overlay.
  for (const legacyDll of ['d3d9.dll', 'd3d8.dll']) {
    if (has(legacyDll) && index(legacyDll) < firstModern && hasUmd(UMD.d3d9)) {
      return out(API_DLLS[legacyDll], `${legacyDll} with the Direct3D 9 driver, before any newer API`);
    }
  }
  if (has('d3d12core.dll')) return out('dx12', 'D3D12Core.dll loaded (a Direct3D 12 device was created)');
  const icd = hasUmd(UMD.icd);
  if (has('vulkan-1.dll') && icd && !(has('opengl32.dll') && index('opengl32.dll') < index('vulkan-1.dll'))) {
    return out('vulkan', 'vulkan-1.dll and a Vulkan driver loaded', has('opengl32.dll'));
  }
  if (has('d3d11.dll')) return out('dx11', `d3d11.dll loaded${hasUmd(UMD.dxgi) ? ' with the Direct3D driver' : ''}`, !hasUmd(UMD.dxgi));
  if (has('d3d10.dll') || has('d3d10_1.dll')) return out('dx10', 'd3d10.dll loaded', !hasUmd(UMD.dxgi));
  if (has('opengl32.dll') && icd) return out('opengl', 'opengl32.dll and an OpenGL driver loaded');
  if (has('d3d9.dll')) return out('dx9', 'd3d9.dll loaded', !hasUmd(UMD.d3d9));
  if (has('d3d8.dll')) return out('dx8', 'd3d8.dll loaded', true);
  if (has('vulkan-1.dll')) return out('vulkan', 'vulkan-1.dll loaded, but no Vulkan driver was seen', true);
  return out('opengl', 'opengl32.dll loaded, but no OpenGL driver was seen', true);
}

function matchAll(names, table) {
  const out = new Set();
  for (const n of names) for (const r of table) if (r.re.test(n)) out.add(r.name);
  return [...out];
}

// trace: { processes, loads } (parseEtwXml / collectPoll / mergeTraces).
// folderFiles: the names beside the exe right now, lower case -- to tell a proxy the game ignored
// (present in the folder, loaded from System32) from one that simply is not there.
function analyzeTrace(trace, { exePath, gameDir = null, gameRoot = null, method = 'etw', capturedAt = null, durationMs = null, folderFiles = [], systemDrive = 'C:' } = {}) {
  gameDir = gameDir || path.win32.dirname(String(exePath || ''));
  gameRoot = gameRoot || gameRootFor(exePath);
  const exeName = path.win32.basename(String(exePath || '')).toLowerCase();
  const tree = treePids(trace.processes, { gameRoot, names: exeName ? [exeName] : [] });
  const procs = trace.processes.filter((p) => tree.has(p.pid));
  const byPid = new Map();
  for (const l of [...trace.loads].sort((a, b) => a.seq - b.seq)) {
    if (!tree.has(l.pid)) continue;
    const list = byPid.get(l.pid) || [];
    const k = pathKey(l.image);
    if (!list.some((x) => pathKey(x.image) === k)) list.push(l);
    byPid.set(l.pid, list);
  }
  const dos = (p) => dosPath(p, { gameRoot, systemDrive });
  const isApiDll = (l) => !!API_DLLS[path.win32.basename(String(l.image)).toLowerCase()];

  // The renderer: the process that loaded a graphics API -- the most modules wins a tie, and a
  // process from the game folder beats a helper somewhere else.
  const candidates = procs.filter((p) => (byPid.get(p.pid) || []).some(isApiDll));
  const score = (p) => ((p.image && underDir(p.image, gameRoot)) ? 1e6 : 0) + (byPid.get(p.pid) || []).length;
  // No API seen (the poller missed it, or the window closed first): the process that outlived the
  // rest is the game -- a launcher is the one that exits after starting it.
  const survivors = procs.filter((p) => !p.exited);
  const renderer = candidates.sort((a, b) => score(b) - score(a))[0] ||
    (survivors.length ? survivors : procs).slice().sort((a, b) => score(b) - score(a))[0] || null;
  const mods = renderer ? byPid.get(renderer.pid) || [] : [];
  const api = apiFromModules(mods, { gameDir: renderer && renderer.image ? path.win32.dirname(dos(renderer.image)) : gameDir, gameRoot });

  // Proxy candidates the renderer loaded, in load order, and where from.
  const rendererDir = renderer && renderer.image ? path.win32.dirname(dos(renderer.image)) : gameDir;
  const proxies = [];
  mods.forEach((l, i) => {
    const name = path.win32.basename(String(l.image)).toLowerCase();
    if (!PROXY_NAMES.includes(name)) return;
    const from = underDir(l.image, rendererDir) ? 'game' : where(l.image, { gameDir: rendererDir, gameRoot });
    proxies.push({ name, from, path: dos(l.image), order: i });
  });
  const present = new Set(folderFiles.map((n) => String(n).toLowerCase()));
  // In the folder, loaded from somewhere else: the game resolved that name past its own folder.
  const ignoredProxies = proxies.filter((p) => p.from !== 'game' && present.has(p.name)).map((p) => p.name);
  const gameFolderDlls = mods
    .filter((l) => /\.(dll|asi)$/i.test(String(l.image)) && underDir(l.image, gameRoot))
    .map((l) => dos(l.image));

  const allNames = [];
  for (const p of procs) allNames.push(path.win32.basename(String(p.image || '')).toLowerCase());
  for (const list of byPid.values()) for (const l of list) allNames.push(path.win32.basename(String(l.image)).toLowerCase());

  // The chain from the first process of the game to the renderer, by parent links.
  const chain = [];
  const procByPid = new Map(procs.map((p) => [p.pid, p]));
  for (let p = renderer; p && chain.length < 8; p = procByPid.get(p.ppid)) {
    chain.unshift({ pid: p.pid, exe: dos(p.image || ''), exitCode: p.exited ? p.exitCode : null });
    if (!tree.has(p.ppid)) break;
  }
  const realExe = renderer && renderer.image ? dos(renderer.image) : null;
  const handoff = !!realExe && pathKey(realExe) !== pathKey(exePath);

  return {
    version: PROBE_VERSION,
    method,
    capturedAt: capturedAt || new Date().toISOString(),
    durationMs,
    exePath,
    processes: procs.map((p) => ({ pid: p.pid, ppid: p.ppid, exe: dos(p.image || ''), exited: !!p.exited, exitCode: p.exited ? p.exitCode : null, modules: (byPid.get(p.pid) || []).length })),
    started: procs.length > 0,
    realExe,
    handoff,
    chain,
    api: api.api,
    apis: api.apis,
    apiEvidence: api.evidence,
    apiUncertain: api.uncertain,
    proxies,
    ignoredProxies,
    gameFolderDlls,
    antiCheat: matchAll(allNames, ANTI_CHEAT_MODULES),
    overlays: matchAll(allNames, OVERLAY_MODULES),
    moduleCount: mods.length,
  };
}

// ── Store ─────────────────────────────────────────────────────────────────────────────────────────
// One file in the app's data folder, keyed by lower-case exe path, each entry stamped with the
// exe's size:mtime (detect.exeStamp) at the time it was watched.
function exeStamp(exePath) {
  try { const st = fs.statSync(exePath); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
}

const storeCache = { file: null, mtimeMs: null, data: {} };
function readStore(file) {
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return {}; }
  if (storeCache.file === file && storeCache.mtimeMs === mtimeMs) return storeCache.data;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  Object.assign(storeCache, { file, mtimeMs, data });
  return data;
}

function writeFacts(file, exePath, facts, { stamp = exeStamp(exePath) } = {}) {
  const data = { ...readStore(file) };
  data[String(exePath).toLowerCase()] = { stamp, facts };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  storeCache.file = null;
  return data;
}

// The facts for this exe, or null when there are none or the exe has changed since.
function freshFacts(file, exePath, { stamp = exeStamp(exePath) } = {}) {
  if (!exePath) return null;
  const entry = readStore(file)[String(exePath).toLowerCase()];
  if (!entry || !entry.facts || entry.facts.version !== PROBE_VERSION) return null;
  if (!stamp || entry.stamp !== stamp) return null;
  return entry.facts;
}

// What rides along on the detection for the card and Game Help, without the module lists.
function summary(facts) {
  if (!facts) return null;
  return {
    capturedAt: facts.capturedAt, method: facts.method, api: facts.api, apiEvidence: facts.apiEvidence,
    apiUncertain: !!facts.apiUncertain, realExe: facts.realExe, handoff: !!facts.handoff,
    ignoredProxies: facts.ignoredProxies || [], antiCheat: facts.antiCheat || [], overlays: facts.overlays || [],
  };
}

// ── Precedence (see the header) ───────────────────────────────────────────────────────────────────
function applyProbe(detected, facts) {
  const d = detected || {};
  if (!facts) return d;
  const probe = summary(facts);
  const keep = (why) => ({ ...d, probe: { ...probe, applied: false, why } });
  if (!facts.api) return keep('no-api-seen');
  if (d.vulkanWrapper && !d.translatedBy) return keep('player-wrapper');
  if (d.emulator && !(d.emulator.apis || []).includes(facts.api)) return keep('emulator-profile');
  const probeAt = Date.parse(facts.capturedAt || '') || 0;
  if (d.runtimeApi && d.runtimeLogMtime && d.runtimeLogMtime > probeAt) return keep('optiscaler-log-newer');
  const api = facts.api;
  if (d.api === api && !d.uncertain) return { ...d, probeApi: api, probe: { ...probe, applied: true, agreed: true } };

  const legacyApi = ['dx8', 'dx9', 'dx10'].includes(api);
  const bitness = d.bitness || 64;
  const apis = [api, ...(d.apis || []).filter((a) => a !== api)];
  let recommend = d.recommend;
  if (!d.emulator) {
    if (bitness === 32) recommend = api === 'vulkan' ? 'unsupported' : 'optiscaler';
    else recommend = legacyApi && api !== 'dx9' ? 'unsupported' : 'optiscaler';
  }
  const others = ['dx12', 'dx11'].filter((a) => a !== api && apis.includes(a));
  return {
    ...d,
    api,
    apis,
    apiBadge: [api, ...others].map((a) => API_LABEL[a]).join('/'),
    recommend,
    reason: `${API_LABEL[api]} -- what a watched launch saw the game load (${facts.apiEvidence})`,
    uncertain: !!facts.apiUncertain,
    legacy: legacyApi && recommend !== 'unsupported',
    legacyApis: legacyApi ? [...new Set([api, ...(d.legacyApis || [])])] : (d.legacyApis || []),
    experimental: bitness === 32 || legacyApi || !!d.experimental,
    staticApi: d.api || null,
    probeApi: api,
    probe: { ...probe, applied: true },
  };
}

// The proxy name the facts argue for, or null when dxgi.dll (the default) is fine or they say nothing.
// Only two findings count: dxgi.dll was never loaded at all (a Vulkan/OpenGL/D3D9 game), or it was in
// the folder and the game loaded System32's instead (RDR2). Either way the answer is the earliest
// early-loading name the game really loaded.
function proxyHint(facts) {
  if (!facts || !Array.isArray(facts.proxies) || !facts.started || !facts.moduleCount) return null;
  const dxgi = facts.proxies.find((p) => p.name === 'dxgi.dll');
  const ignored = new Set(facts.ignoredProxies || []);
  if (dxgi && !ignored.has('dxgi.dll')) return null;
  const early = facts.proxies.filter((p) => EARLY_PROXIES.includes(p.name) && !ignored.has(p.name)).sort((a, b) => a.order - b.order)[0];
  return early ? early.name : null;
}

// ── Running it ────────────────────────────────────────────────────────────────────────────────────
function quotePs(s) { return `'${String(s).replace(/'/g, "''")}'`; }

async function startEtw({ execFileAsync, etlPath, session = ETW_SESSION }) {
  // A session left behind by a crashed run would make `start` fail with "already exists".
  try { await execFileAsync('logman.exe', ['stop', session, '-ets'], { windowsHide: true }); } catch {}
  try { fs.rmSync(etlPath, { force: true }); } catch {}
  await execFileAsync('logman.exe', ['start', session, '-p', ETW_PROVIDER, ETW_KEYWORDS, '0x4', '-o', etlPath, '-bs', '256', '-nb', '16', '256', '-ets'], { windowsHide: true });
}

async function stopEtw({ execFileAsync, session = ETW_SESSION }) {
  try { await execFileAsync('logman.exe', ['stop', session, '-ets'], { windowsHide: true }); return true; } catch { return false; }
}

async function convertEtl({ execFileAsync, etlPath, xmlPath }) {
  await execFileAsync('tracerpt.exe', [etlPath, '-o', xmlPath, '-of', 'XML', '-y'], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  return fsp.readFile(xmlPath);
}

// Starts the PowerShell poller; `onTick(tick)` for every line. Returns { done: Promise<lines[]>, stop() }.
function startPoller({ root, seconds, modules = true, names = [], intervalMs = 1000, workDir = os.tmpdir(), spawnImpl = spawn, onTick = null }) {
  const scriptPath = path.join(workDir, `dlss5ui-poll-${process.pid}.ps1`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(scriptPath, POLL_SCRIPT, 'utf8');
  const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-Root', root, '-Seconds', String(seconds), '-IntervalMs', String(intervalMs), '-Modules', modules ? '1' : '0', '-Names', names.join('|')],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      lines.push(line);
      if (onTick) { try { onTick(JSON.parse(line)); } catch {} }
    }
  });
  const done = new Promise((resolve) => {
    child.once('exit', () => { if (buf.trim()) lines.push(buf.trim()); resolve(lines); });
    child.once('error', () => resolve(lines));
  });
  return { done, stop: () => { try { child.kill(); } catch {} }, child };
}

// Asks each process to close (WM_CLOSE to its main window: no focus change, no keys), then kills
// whatever is still there after `graceMs`. Processes without a window are killed straight away at
// the end of the grace. Returns what happened, for the result screen.
async function closeTree(pids, { execFileAsync, graceMs = 10000 } = {}) {
  const list = [...new Set(pids)].filter((p) => Number.isFinite(p) && p > 0);
  if (!list.length) return { asked: 0, killed: 0 };
  const ids = list.join(',');
  const script = `$ids = @(${ids}); $asked = 0; $killed = 0
foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { if ($p.CloseMainWindow()) { $asked++ } } }
$deadline = (Get-Date).AddMilliseconds(${Math.max(0, graceMs)})
while ((Get-Date) -lt $deadline) { if (-not (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { try { $p.Kill(); $killed++ } catch {} } }
"$asked $killed"`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: graceMs + 20000 });
    const [asked, killed] = String(stdout).trim().split(/\s+/).map(Number);
    return { asked: asked || 0, killed: killed || 0 };
  } catch (e) {
    return { asked: 0, killed: 0, error: String(e && e.message ? e.message : e) };
  }
}

// The whole watched launch. `launch()` starts the game the way the card's Launch button does (main.js
// launchGame); everything else is injected so tests can drive it without a game.
async function runProbe({
  exePath, launch, execFileAsync, seconds = PROBE_SECONDS, workDir = os.tmpdir(), onProgress = () => {},
  useEtw = true, startPollerImpl = startPoller, closeTreeImpl = closeTree, now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), systemDrive = (process.env.SystemDrive || 'C:'),
}) {
  const gameDir = path.dirname(exePath);
  const gameRoot = gameRootFor(exePath);
  fs.mkdirSync(workDir, { recursive: true });
  const etlPath = path.join(workDir, 'dlss5ui-probe.etl');
  const xmlPath = path.join(workDir, 'dlss5ui-probe.xml');
  let method = 'poll';
  let etwError = null;
  if (useEtw) {
    try { await startEtw({ execFileAsync, etlPath }); method = 'etw'; } catch (e) { etwError = String((e && (e.stdout || e.stderr || e.message)) || e).trim(); }
  }
  onProgress({ phase: 'launching', method, etwError });
  const startedAt = now();
  const alive = new Set();
  const seenPids = new Set();
  let closing = false;
  const poller = startPollerImpl({
    root: gameRoot, seconds: seconds + 5, modules: true, names: [path.basename(exePath)], workDir,
    onTick: (tick) => {
      const procs = Array.isArray(tick.procs) ? tick.procs : tick.procs ? [tick.procs] : [];
      alive.clear();
      for (const p of procs) { alive.add(Number(p.pid)); seenPids.add(Number(p.pid)); }
      if (!closing) onProgress({ phase: 'watching', elapsed: Math.round((now() - startedAt) / 1000), seconds, processes: procs.map((p) => p.name || path.basename(String(p.image || ''))) });
    },
  });
  let launched;
  try {
    launched = await launch();
  } catch (e) {
    launched = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  if (!launched || launched.ok === false || launched.cancelled) {
    poller.stop();
    if (method === 'etw') await stopEtw({ execFileAsync });
    return { ok: false, error: (launched && launched.error) || (launched && launched.cancelled ? 'cancelled' : 'launch failed'), cancelled: !!(launched && launched.cancelled) };
  }
  while (now() - startedAt < seconds * 1000) await sleep(500);
  closing = true;
  onProgress({ phase: 'closing' });
  const closed = await closeTreeImpl([...seenPids], { execFileAsync });
  poller.stop();
  const lines = await poller.done;
  let etw = null;
  if (method === 'etw') {
    await stopEtw({ execFileAsync });
    onProgress({ phase: 'reading' });
    try { etw = parseEtwXml(await convertEtl({ execFileAsync, etlPath, xmlPath })); } catch (e) { etwError = String(e && e.message ? e.message : e); method = 'poll'; }
    try { fs.rmSync(etlPath, { force: true }); fs.rmSync(xmlPath, { force: true }); } catch {}
  }
  let folderFiles = [];
  try { folderFiles = fs.readdirSync(gameDir).map((n) => n.toLowerCase()); } catch {}
  const trace = mergeTraces(etw, collectPoll(lines));
  const facts = analyzeTrace(trace, { exePath, gameDir, gameRoot, method, capturedAt: new Date(startedAt).toISOString(), durationMs: now() - startedAt, folderFiles, systemDrive });
  return { ok: true, facts, closed, etwError, launched };
}

module.exports = {
  PROBE_VERSION, PROBE_SECONDS, API_LABEL, PROXY_NAMES, POLL_SCRIPT,
  pathKey, underDir, dosPath, gameRootFor, parseEtwXml, collectPoll, mergeTraces, treePids, apiFromModules, analyzeTrace,
  readStore, writeFacts, freshFacts, summary, applyProbe, proxyHint, exeStamp,
  startEtw, stopEtw, convertEtl, startPoller, closeTree, runProbe,
};
