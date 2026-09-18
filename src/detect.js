// Engine and graphics-API detection for a game folder.
//
// Everything here is evidence-based and tiered, because the one-liner heuristics this replaces
// produced real false positives on real libraries:
//
//   - "any *_vk.dll beside the exe means Vulkan" flagged Dragon's Dogma 2 (RE Engine, DX12) as
//     Vulkan, because OptiScaler's own amd_fidelityfx_vk.dll was sitting in the folder.
//   - An ASCII-only string scan never saw d3d12.dll in RE Engine, RED Engine or Unity binaries:
//     modern engines load their renderer through LoadLibraryW, so the name is stored as UTF-16.
//     RE Engine games came back as DX11 (its d3d11.dll import is the only ASCII hit) and Unity
//     games as Unknown.
//   - "Vulkan wins ties" is backwards for Windows: Unreal, Unity and most multi-API engines
//     mention vulkan-1.dll while defaulting to D3D. A game is Vulkan when that is the only
//     modern API it knows, or the only one it links statically.
//
// Bump DETECT_VERSION whenever the rules change so stored results get refreshed in the UI.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { findUnrealPluginFile } = require('./framegen');
const emulators = require('./emulators');
const rtxmfg = require('./rtxmfg');

// 11: KNOWN_RENDERERS names the API of games whose executable cannot say it (FIFA 16), so a stored
// "API not detected" for one of them is thrown away and the DLSS5 Feeder route is offered.
// 10: optiScalerProxy.matchesOurBuild reads the install journal instead of measuring an
// OptiScaler.dll that a finished install has already renamed away -- v1.57.5 stored false for
// every normal install, which reads as "somebody else's OptiScaler is here".
// 9: winmm.dll and version.dll are scanned as hook DLLs, so an OptiScaler or ReShade loading
// under either name is seen at last; detection carries optiScalerProxy with it.
// 8: anti-cheat beside the exe is seen for a game whose own folder is called Game (every
// FromSoftware title) -- a stored detection from before this said antiCheat: null for them.
// 7: DX8 told apart from DX9, emulators recognised, 32-bit and DX8/DX9 games offered the
// experimental Feeder routes (legacy.js) instead of "unsupported".
// 13: a DXVK this app deployed (translation.js manifest) no longer turns the game into a Vulkan
// game -- the swap made Assassin's Creed II "32-bit Vulkan, unsupported" (2026-09-18).
const DETECT_VERSION = 13;

const MODERN_APIS = ['dx12', 'dx11', 'vulkan'];
const API_DLL = { dx12: 'd3d12.dll', dx11: 'd3d11.dll', vulkan: 'vulkan-1.dll' };
const OLD_API_DLLS = [
  ['dx9', ['d3d9.dll']],
  ['dx8', ['d3d8.dll']],
  ['dx10', ['d3d10.dll', 'd3d10core.dll']],
  ['opengl', ['opengl32.dll']],
];
const API_LABEL = { dx12: 'DX12', dx11: 'DX11', vulkan: 'Vulkan', dx9: 'DX9', dx8: 'DX8', dx10: 'DX10', opengl: 'OpenGL' };

// Files this app, OptiScaler, ReShade, REFramework or the DLSS swaps place beside the exe. Every
// one of them mentions whichever APIs *it* supports, which says nothing about the game.
// dgVoodoo2's wrappers (d3d8/d3d9/ddraw/d3dimm) are in the list too: the legacy route places them.
const MOD_PAYLOAD_DLL = /^(optiscaler.*|amd_fidelityfx_.*|amd_ags_x64|libxe(ss|ll).*|_?nvngx.*|sl\..*|dlssg_to_fsr3.*|fakenvapi.*|reshade.*|d3d12core|dstorage.*|nvapi64|dxgi|d3d11|d3d12|winmm|version|dbghelp|wininet|winhttp|dinput8|xinput1_[34]|ffx_.*|d3d8|d3d9|ddraw|d3dimm)\.dll$/i;

const SIBLING_SCAN_MAX_BYTES = 300 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Byte-level scanning

// Each spelling in both the ASCII and UTF-16LE (LoadLibraryW) forms. DLL names get the casings
// engines actually use; proper nouns are searched exactly.
function needleVariants(text, { exactCase = false } = {}) {
  const forms = new Set([text]);
  if (!exactCase) {
    forms.add(text.toLowerCase());
    forms.add(text.toUpperCase());
    const dot = text.lastIndexOf('.');
    if (dot > 0) forms.add(text.slice(0, dot).toUpperCase() + text.slice(dot).toLowerCase());
  }
  const out = [];
  for (const f of forms) {
    out.push(Buffer.from(f, 'latin1'));
    out.push(Buffer.from(f, 'utf16le'));
  }
  return out;
}

function makeNeedle(id, text, opts) {
  return { id, variants: needleVariants(text, opts) };
}

const CHUNK_BYTES = 8 * 1024 * 1024;
const OVERLAP_BYTES = 512;

// Streams the file through a fixed buffer so a 250MB executable never has to be held in memory.
// Returns Map<needleId, Buffer window starting at the first hit> for every needle found.
async function scanFile(filePath, needles, { maxBytes = 0 } = {}) {
  const hits = new Map();
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return hits;
  }
  try {
    const st = await fh.stat();
    if (maxBytes && st.size > maxBytes) return hits;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES + OVERLAP_BYTES);
    const pending = new Set(needles);
    let carry = 0;
    let pos = 0;
    while (pos < st.size && pending.size > 0) {
      const { bytesRead } = await fh.read(buf, carry, CHUNK_BYTES, pos);
      if (bytesRead <= 0) break;
      const view = buf.subarray(0, carry + bytesRead);
      for (const needle of pending) {
        for (const variant of needle.variants) {
          const idx = view.indexOf(variant);
          if (idx < 0) continue;
          hits.set(needle.id, Buffer.from(view.subarray(idx, Math.min(view.length, idx + 256))));
          pending.delete(needle);
          break;
        }
      }
      pos += bytesRead;
      carry = Math.min(OVERLAP_BYTES, view.length);
      buf.copy(buf, 0, view.length - carry, view.length);
    }
  } catch {
  } finally {
    await fh.close();
  }
  return hits;
}

// Import directory of a PE file: the DLL names it links statically, lower-cased. Empty on
// anything unparseable -- a packed or odd binary just contributes no static evidence.
async function peImports(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const readAt = async (offset, length) => {
      const b = Buffer.alloc(length);
      const { bytesRead } = await fh.read(b, 0, length, offset);
      return b.subarray(0, bytesRead);
    };
    const dos = await readAt(0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return [];
    const peOffset = dos.readUInt32LE(60);
    const pe = await readAt(peOffset, 24 + 240);
    if (pe.length < 24 + 120 || pe.readUInt32LE(0) !== 0x4550) return [];
    const sectionCount = pe.readUInt16LE(6);
    const optionalSize = pe.readUInt16LE(20);
    const magic = pe.readUInt16LE(24);
    const dirBase = magic === 0x20b ? 24 + 112 : magic === 0x10b ? 24 + 96 : -1;
    if (dirBase < 0) return [];
    const importRva = pe.readUInt32LE(dirBase + 8);
    const importSize = pe.readUInt32LE(dirBase + 12);
    // Delay-load directory (index 13): plenty of games bind d3d12.dll that way, and it never
    // shows in the ordinary import table.
    const delayRva = pe.readUInt32LE(dirBase + 13 * 8);
    const delaySize = pe.readUInt32LE(dirBase + 13 * 8 + 4);
    if (!importRva && !delayRva) return [];

    const sectionBytes = await readAt(peOffset + 24 + optionalSize, sectionCount * 40);
    const sections = [];
    for (let i = 0; i + 40 <= sectionBytes.length; i += 40) {
      sections.push({
        va: sectionBytes.readUInt32LE(i + 12),
        size: Math.max(sectionBytes.readUInt32LE(i + 8), sectionBytes.readUInt32LE(i + 16)),
        raw: sectionBytes.readUInt32LE(i + 20),
      });
    }
    const rvaToOffset = (rva) => {
      for (const s of sections) {
        if (rva >= s.va && rva < s.va + s.size) return s.raw + (rva - s.va);
      }
      return -1;
    };

    const names = [];
    const readTable = async (rva, size, stride, nameField, thunkField) => {
      if (!rva) return;
      const descOffset = rvaToOffset(rva);
      if (descOffset < 0) return;
      const descriptors = await readAt(descOffset, Math.min(size || stride * 512, stride * 512));
      for (let i = 0; i + stride <= descriptors.length; i += stride) {
        const nameRva = descriptors.readUInt32LE(i + nameField);
        const thunk = descriptors.readUInt32LE(i + thunkField);
        if (!nameRva && !thunk) break;
        const nameOffset = rvaToOffset(nameRva);
        if (nameOffset < 0) continue;
        const raw = await readAt(nameOffset, 64);
        const end = raw.indexOf(0);
        names.push(raw.subarray(0, end < 0 ? raw.length : end).toString('latin1').toLowerCase());
      }
    };
    await readTable(importRva, importSize, 20, 12, 16);
    await readTable(delayRva, delaySize, 32, 4, 12);
    return [...new Set(names)];
  } catch {
    return [];
  } finally {
    await fh.close();
  }
}

// PE32 (0x10b) or PE32+ (0x20b) from the optional-header magic: a 32-bit game cannot load
// OptiScaler or the 64-bit Feeder add-on at all, so it is refused up front instead of failing
// at launch. null when the file is not a readable PE (a GDK-encrypted exe, say).
async function peBitness(filePath) {
  let fh;
  try { fh = await fsp.open(filePath, 'r'); } catch { return null; }
  try {
    const dos = Buffer.alloc(64);
    if ((await fh.read(dos, 0, 64, 0)).bytesRead < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(60);
    const pe = Buffer.alloc(26);
    if ((await fh.read(pe, 0, 26, peOffset)).bytesRead < 26 || pe.readUInt32LE(0) !== 0x4550) return null;
    const magic = pe.readUInt16LE(24);
    return magic === 0x20b ? 64 : magic === 0x10b ? 32 : null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// A reader over a PE file's resource directory -- ported from DLSS5-Swapper's pe.js and widened
// from "the version resource" to any type, because the same walk answers two questions this app
// asks: what a DLL was built as (RT_VERSION, 16) and what a game's own icon looks like
// (RT_GROUP_ICON, 14, and the RT_ICON images it names, 3).
//
// Returns { ids(type), get(type, id, max), close() }, or null if the file has no resources. The
// caller must close it. Synchronous and bounded: a few small reads per lookup.
function openPeResources(filePath) {
  let fd;
  // The descriptor the reads and close() use. Held separately from `fd`, which is only the flag
  // for "still this function's to close": the returned reader keeps reading after the function
  // has handed ownership over, so it cannot close over a variable this function then clears.
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    fd = descriptor;
    const readAt = (offset, length) => {
      const b = Buffer.alloc(length);
      const n = fs.readSync(descriptor, b, 0, length, offset);
      return b.subarray(0, n);
    };
    const dos = readAt(0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(60);
    const coff = readAt(peOffset, 24);
    if (coff.length < 24 || coff.readUInt32LE(0) !== 0x4550) return null;
    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    const opt = readAt(peOffset + 24, optionalSize);
    const magic = opt.readUInt16LE(0);
    const ddOff = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
    if (ddOff < 0 || opt.length < ddOff + 3 * 8) return null;
    const resRva = opt.readUInt32LE(ddOff + 2 * 8);
    if (!resRva) return null;
    const secTable = readAt(peOffset + 24 + optionalSize, sectionCount * 40);
    const sections = [];
    for (let i = 0; i + 40 <= secTable.length; i += 40) {
      sections.push({ va: secTable.readUInt32LE(i + 12), size: Math.max(secTable.readUInt32LE(i + 8), secTable.readUInt32LE(i + 16)), raw: secTable.readUInt32LE(i + 20) });
    }
    const rvaToOffset = (rva) => {
      for (const s of sections) if (rva >= s.va && rva < s.va + s.size) return s.raw + (rva - s.va);
      return -1;
    };
    const base = rvaToOffset(resRva);
    if (base < 0) return null;
    const entriesOf = (dirOff) => {
      const hdr = readAt(base + dirOff, 16);
      if (hdr.length < 16) return [];
      const count = hdr.readUInt16LE(12) + hdr.readUInt16LE(14);
      const raw = readAt(base + dirOff + 16, count * 8);
      const out = [];
      for (let i = 0; i + 8 <= raw.length; i += 8) out.push({ id: raw.readUInt32LE(i), offset: raw.readUInt32LE(i + 4) });
      return out;
    };
    const typeEntry = (typeId) => entriesOf(0).find((e) => (e.id & 0x7fffffff) === typeId && (e.offset & 0x80000000));

    // The resource ids present under a type, in directory order. Named (string) entries are
    // skipped: everything read here is numbered.
    const ids = (typeId) => {
      const type = typeEntry(typeId);
      if (!type) return [];
      return entriesOf(type.offset & 0x7fffffff).filter((e) => !(e.id & 0x80000000)).map((e) => e.id);
    };

    // One resource's bytes. id null takes the first, which is what a version resource has.
    const get = (typeId, id = null, max = 64 * 1024) => {
      const type = typeEntry(typeId);
      if (!type) return null;
      const names = entriesOf(type.offset & 0x7fffffff);
      const name = id === null ? names[0] : names.find((e) => e.id === id);
      if (!name || !(name.offset & 0x80000000)) return null;
      // The language sublevel: the first is the right one for every resource this app reads.
      const lang = entriesOf(name.offset & 0x7fffffff)[0];
      if (!lang) return null;
      const data = readAt(base + lang.offset, 16);
      if (data.length < 16) return null;
      const dataOff = rvaToOffset(data.readUInt32LE(0));
      const dataSize = data.readUInt32LE(4);
      if (dataOff < 0 || !dataSize) return null;
      return readAt(dataOff, Math.min(dataSize, max));
    };

    let open = true;
    const handle = { ids, get, close: () => { if (open) { open = false; try { fs.closeSync(descriptor); } catch {} } } };
    fd = undefined; // ownership passes to the caller's close(); the finally below leaves it alone
    return handle;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

// The RT_VERSION resource of a PE file, as bytes.
function versionResourceBlob(filePath) {
  const res = openPeResources(filePath);
  if (!res) return null;
  try { return res.get(RT_VERSION); } finally { res.close(); }
}

// VS_FIXEDFILEINFO out of that resource, "6.3.9600.16384" style.
function readFileVersion(filePath) {
  const blob = versionResourceBlob(filePath);
  if (!blob) return null;
  const sig = blob.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
  if (sig < 0 || sig + 16 > blob.length) return null;
  const ms = blob.readUInt32LE(sig + 8);
  const ls = blob.readUInt32LE(sig + 12);
  const fixed = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
  return fixed === '0.0.0.0' ? null : fixed;
}

// One StringFileInfo value out of the same resource. A String entry is wLength, wValueLength,
// wType, szKey (UTF-16, NUL-terminated), padding to a 4-byte boundary, then the value.
function peVersionString(filePath, key) {
  const blob = versionResourceBlob(filePath);
  if (!blob) return null;
  const needle = Buffer.from(key + '\0', 'utf16le');
  const at = blob.indexOf(needle);
  if (at < 0) return null;
  let p = at + needle.length;
  while (p % 4 !== 0) p += 2;
  let end = p;
  while (end + 1 < blob.length && blob.readUInt16LE(end) !== 0) end += 2;
  return blob.subarray(p, end).toString('utf16le').trim() || null;
}

// Which file a DLL was built as, whatever it has been renamed to. This is how the app tells its
// own OptiScaler apart from a game's real dxgi.dll: OptiScaler's OriginalFilename stays
// "OptiScaler.dll" under every proxy name. Read natively because the PowerShell that used to read
// it (Get-Item .VersionInfo) costs about 700 ms per game folder in process start-up alone -- with
// twenty installed games that was fifteen seconds of the main process, on every sync.
function peOriginalFilename(filePath) {
  return peVersionString(filePath, 'OriginalFilename');
}

// ---------------------------------------------------------------------------------------------
// Generic API evidence

// Entry points a game asks for by name when it resolves Direct3D at runtime: a protected build
// (GTA V Enhanced) has no import and may keep the DLL name out of reach, but the function name
// it passes to GetProcAddress is still a plain string. D3D12SDKPath/D3D12SDKVersion are the
// Agility SDK exports -- a game that exports them renders with DX12, no ambiguity.
const ENTRY_POINTS = [
  ['dx12', 'D3D12CreateDevice'], ['dx11', 'D3D11CreateDevice'], ['vulkan', 'vkCreateInstance'],
  ['dx10', 'D3D10CreateDevice'], ['dx9', 'Direct3DCreate9'], ['dx8', 'Direct3DCreate8'], ['opengl', 'wglCreateContext'],
];
const AGILITY_EXPORTS = ['D3D12SDKPath', 'D3D12SDKVersion'];

const API_NEEDLES = [
  ...MODERN_APIS.map((api) => makeNeedle(api, API_DLL[api])),
  ...OLD_API_DLLS.flatMap(([api, dlls]) => dlls.map((dll, i) => makeNeedle(`${api}#${i}`, dll))),
  ...ENTRY_POINTS.map(([api, fn]) => makeNeedle(`ep:${api}`, fn, { exactCase: true })),
  ...AGILITY_EXPORTS.map((fn, i) => makeNeedle(`agility#${i}`, fn, { exactCase: true })),
];
const OPTISCALER_NEEDLE = makeNeedle('__optiscaler', 'OptiScaler');

function apisFromEvidence(imports, hits) {
  const modern = new Set();
  const old = new Set();
  for (const api of MODERN_APIS) {
    if (imports.includes(API_DLL[api]) || hits.has(api) || hits.has(`ep:${api}`)) modern.add(api);
  }
  for (const [api, dlls] of OLD_API_DLLS) {
    if (dlls.some((dll, i) => imports.includes(dll) || hits.has(`${api}#${i}`)) || hits.has(`ep:${api}`)) old.add(api);
  }
  const agility = AGILITY_EXPORTS.some((_, i) => hits.has(`agility#${i}`));
  return { modern, old, agility };
}

// Some games ship one executable per renderer (farcry3_d3d11.exe, witcher3 in bin\\x64_dx12) --
// when the name itself says which API and the binary knows that API, the name wins the tie.
function apiFromFileName(exePath) {
  const name = path.basename(exePath).toLowerCase();
  if (/(?:^|[_-])(?:d3d|dx)12(?:[_-]|\.|$)/.test(name)) return 'dx12';
  if (/(?:^|[_-])(?:d3d|dx)11(?:[_-]|\.|$)/.test(name)) return 'dx11';
  if (/(?:^|[_-])vulkan(?:[_-]|\.|$)/.test(name)) return 'vulkan';
  return null;
}

// The Direct3D DLLs beside the exe, read once for three answers: a DXVK/vkd3d translation
// layer (the game asks for Direct3D, the frame is presented by Vulkan -- that is the renderer
// to report and install for), a ReShade proxy already living in the slot OptiScaler would take
// (Install would replace it -- Launch mode: Injector keeps both), and OptiScaler's own proxy,
// which is neither. Names only; the version resource is not consulted, the strings are enough.
// winmm.dll and version.dll earn their place here: both are proxy names OptiScaler and ReShade
// use, and ones this app picks itself for a Vulkan or OpenGL Feeder game. Without them an upstream
// OptiScaler loading as winmm.dll was invisible to every check in this file -- which is how a
// user's DOOM 3 BFG came to run somebody else's build, with no neural pass, while this app
// reported the route complete (2026-09-13).
const HOOK_DLLS = ['dxgi.dll', 'd3d12.dll', 'd3d11.dll', 'd3d9.dll', 'opengl32.dll', 'dinput8.dll', 'winmm.dll', 'version.dll'];
const HOOK_NEEDLES = ['DXVK', 'vkd3d', 'vkGetInstanceProcAddr', 'ReShade', 'OptiScaler'].map((t) => makeNeedle(t, t, { exactCase: true }));

// 'dxvk' when this app's translation manifest says it put DXVK in front of the game, else null.
// The manifest only -- a record, not a reading of the folder -- and read lazily so detection does
// not load translation.js for the games that have no wrapper at all.
function ourTranslationLayer(dir) {
  try {
    const m = require('./translation').readManifest(dir);
    return m && m.layer === 'dxvk' && !m.fromLegacyMarker ? 'dxvk' : null;
  } catch {
    return null;
  }
}

async function inspectHookDlls(dir) {
  const out = { vulkanWrapper: null, reshadeProxy: null, optiScalerProxy: null };
  // Which proxy, if any, is ours. The install journal is the authority: installProxy records the
  // name it creates, so a proxy-named OptiScaler the journal does not name is not this app's.
  //
  // Size was the first attempt and it was wrong on every normal install: installProxy *renames*
  // OptiScaler.dll into the proxy slot, so there is no OptiScaler.dll left to measure, ourSize
  // came out 0, and every install would have been accused of harbouring a rival build. Size is
  // kept only as a second opinion, for the hand-made setups that do still hold a copy.
  let ourProxy = '';
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(dir, '.optiscaler-manager-install.json'), 'utf8'));
    if (typeof journal.proxy === 'string') ourProxy = journal.proxy.toLowerCase();
  } catch {}
  let ourSize = 0;
  try { ourSize = fs.statSync(path.join(dir, 'OptiScaler.dll')).size; } catch {}
  // RTXMFG, placed by this app under a proxy name, carries the string "ReShade"; it is not a hook
  // anybody else put here (rtxmfg.js).
  const rtxmfgFile = (rtxmfg.ourFile(dir) || '').toLowerCase();
  for (const name of HOOK_DLLS) {
    if (name.toLowerCase() === rtxmfgFile) continue;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const hits = await scanFile(file, HOOK_NEEDLES, { maxBytes: SIBLING_SCAN_MAX_BYTES });
    if (hits.has('OptiScaler')) {
      // An OptiScaler under a proxy name. Usually ours -- that is how this app installs one -- but
      // a folder can hold somebody else's build under a different name, and THAT is the one that
      // loads and answers the game's NGX calls. A user's DOOM 3 BFG had an upstream OptiScaler as
      // winmm.dll beside our install; the Feeder found it, reported "upstream build, no neural
      // pass", and no neural pass ever ran while everything in this app said the route was
      // complete. Recorded here; whether it is a problem is for the caller to judge against what
      // this app installed.
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      const ours = (ourProxy && name.toLowerCase() === ourProxy) || (ourSize > 0 && size === ourSize);
      // A folder can hold two: ours in the slot we made, theirs in another. Whichever is NOT ours
      // is the one worth naming, and it is not necessarily the first in HOOK_DLLS order -- ours is
      // usually dxgi.dll, which comes first, and the DOOM 3 BFG build was at winmm.dll behind it.
      if (!out.optiScalerProxy || (out.optiScalerProxy.matchesOurBuild && !ours)) {
        out.optiScalerProxy = { file: name, size, matchesOurBuild: ours };
      }
      continue;
    }
    if (!out.vulkanWrapper && !hits.has('ReShade') && hits.has('vkGetInstanceProcAddr') && (hits.has('DXVK') || hits.has('vkd3d'))) {
      out.vulkanWrapper = { file: name, kind: hits.has('DXVK') ? 'DXVK' : 'vkd3d' };
    }
    if (!out.reshadeProxy && hits.has('ReShade')) out.reshadeProxy = name;
  }
  return out;
}

// Anti-cheat beside the exe or in the game root: never a block (single-player games ship it
// too), but OptiScaler's own banner says "do not use in multiplayer games", and a card that
// shows the risk is the honest thing. Direct children of the exe folder and up to three
// ancestors only -- the game root is at most that far up in every layout this app knows.
const ANTI_CHEAT = /easyanticheat|battleye|eaanticheat|(?:^|[-_])(?:eac|be)launcher|start_protected_game|beservice|beclient|vanguard|xigncode|gameguard|nprotect|ace-base|anticheat|ricochet/i;
// Where the climb stops: a folder that holds games rather than being one. A loose installer
// parked in D:\Games is not evidence about any game under it.
const LIBRARY_ROOT = /^(games?|my ?games|steamlibrary|steamapps|common|gog ?games|epic ?games|xbox ?games|origin ?games|ea ?games|repacks?|emulation|downloads|program files(?: \(x86\))?|[a-z]:\\?)$/i;
// Activision's Ricochet leaves no named file beside the exe: its kernel driver comes with the
// game's own launcher. The modern Call of Duty titles (Modern Warfare II and III, Black Ops 6,
// Warzone) all run through the one Call of Duty HQ exe, so that exe name is the evidence.
const RICOCHET_EXES = /^cod\.exe$/i;

function antiCheatPresent(dir, exePath = null) {
  if (exePath && RICOCHET_EXES.test(path.basename(exePath))) return 'Ricochet (Call of Duty HQ)';
  const scan = (folder) => {
    let entries = [];
    try { entries = fs.readdirSync(folder); } catch { entries = []; }
    return entries.find((name) => ANTI_CHEAT.test(name)) || null;
  };
  // The exe's own folder is always read, before the library-root guard gets a say. FromSoftware
  // ships every game as <Game Name>\Game\<exe> -- Elden Ring, Armored Core VI, Dark Souls III --
  // and LIBRARY_ROOT's `games?` alternative matches that folder's own name, so the climb used to
  // stop on its first step and see nothing. Both of those games have EasyAntiCheat and
  // start_protected_game.exe sitting right beside the exe, and the card showed no warning at all
  // (confirmed on both installs, 2026-09-13). The guard is about not blaming a game for a loose
  // installer in D:\Games, which is a statement about ancestors, never about the exe's own folder.
  const here = scan(dir);
  if (here) return here;
  let current = path.dirname(dir);
  for (let up = 0; up < 3; up++) {
    if (LIBRARY_ROOT.test(path.basename(current) || current)) break;
    const hit = scan(current);
    if (hit) return hit;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// The anti-cheat *stub*: a small launcher whose whole job is to start the anti-cheat service and
// then the game under it. It is the difference between "anti-cheat is here and nothing this app
// installs can ever run" and "anti-cheat is here, and the game's own exe starts without it".
//
// Why it earns its own answer: a launch through a stub fails in the most confusing way available.
// Steam runs the stub, the stub starts the anti-cheat, the anti-cheat refuses to start a game with
// an unsigned DLL beside it -- and nothing is written anywhere. No OptiScaler.log, no ReShade.log,
// no dlss5-feed.log, no crash report, so Game Help would answer "no run to judge yet" for ever.
// Confirmed on Armored Core VI (2026-09-13): a complete, correct install and not one byte of log.
// Launching the game's own exe skips the stub entirely.
//
// The stub conventions this covers are the anti-cheats' own, not any one studio's or engine's --
// Unity, Unreal and in-house games all ship the same two launchers:
//
//   start_protected_game.exe  EasyAntiCheat's own launcher, shipped with EAC rather than written
//                             per game: FromSoftware's titles (Elden Ring, Armored Core VI, Dark
//                             Souls III) and plenty of Unity and Unreal EAC games.
//   <Game>_BE.exe, BELauncher.exe
//                             BattlEye's: the stub starts BEService and then <Game>.exe. Here the
//                             stub's own name says which exe it fronts, so gameExe can name it.
//
// What this deliberately does not promise is that the game is worth playing this way. An
// online-only game will start and then fail to connect, because there the anti-cheat is the point.
// That is the user's call, which is why launching this way asks first and says what it costs. A
// game whose anti-cheat is only a service or a kernel driver, with no stub at all (Vanguard), has
// no door of this kind, and antiCheatPresent() remains the whole answer there.
const ANTI_CHEAT_STUBS = [
  { name: 'start_protected_game.exe', antiCheat: 'EasyAntiCheat' },
  { name: 'BELauncher.exe', antiCheat: 'BattlEye' },
  { name: 'EACLauncher.exe', antiCheat: 'EasyAntiCheat' },
  { match: /^(.+)_BE\.exe$/i, antiCheat: 'BattlEye' },
  { match: /^(.+)_EAC\.exe$/i, antiCheat: 'EasyAntiCheat' },
];

// Publishers that ship their own way past the anti-cheat for offline play, where skipping the stub
// breaks something else. GTA V Legacy: GTA5.exe started on its own needs Rockstar's launcher to
// have signed it in -- it ran once and then asked to be run through the Rockstar Games Launcher (a
// player's support bundle, 2026-09-15). Rockstar's switch for Story Mode is -nobattleye on the normal
// launch (Steam launch options, or PlayGTAV.exe), which keeps the launcher and drops BattlEye.
const ANTI_CHEAT_SWITCHES = [
  { stub: /^GTA5_BE\.exe$/i, launcher: 'PlayGTAV.exe', args: ['-nobattleye'] },
];

// { stub, antiCheat, gameExe } for the stub in this folder, or null. gameExe is set only when the
// stub's own name names the exe it fronts and that exe is really there: for EAC's generic launcher
// the name says nothing, and the game's own exe is the one the app already has on record. `launch`
// ({ exe, args }) is added when the publisher's own switch exists, and is the launch to use.
function antiCheatStub(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const rule of ANTI_CHEAT_STUBS) {
    for (const entry of entries) {
      if (rule.name) {
        if (entry.toLowerCase() !== rule.name.toLowerCase()) continue;
        return { stub: entry, antiCheat: rule.antiCheat, gameExe: null };
      }
      const hit = rule.match.exec(entry);
      if (!hit) continue;
      // Paired, or not a stub this app can route around: <Game>_BE.exe with no <Game>.exe beside
      // it would send the launch at a file that is not there.
      const paired = entries.find((e) => e.toLowerCase() === `${hit[1].toLowerCase()}.exe`);
      if (!paired) continue;
      const info = { stub: entry, antiCheat: rule.antiCheat, gameExe: paired };
      const sw = ANTI_CHEAT_SWITCHES.find((s) => s.stub.test(entry));
      const launcher = sw && entries.find((e) => e.toLowerCase() === sw.launcher.toLowerCase());
      if (launcher) info.launch = { exe: launcher, args: [...sw.args] };
      return info;
    }
  }
  return null;
}

// A D3DCompiler_47.dll beside the exe that predates Windows 10 (Spider-Man Remastered ships
// 6.3.9600 from Windows 8.1) is what the loader hands OptiScaler's D3DCompile, and Shader Model
// 5.1 is unknown to it: the pass then compiles to nothing while everything reports success.
function oldShaderCompiler(dir) {
  const file = path.join(dir, 'D3DCompiler_47.dll');
  if (!fs.existsSync(file)) return null;
  const version = readFileVersion(file);
  const major = /^(\d+)\./.exec(String(version || ''));
  if (!major || Number(major[1]) >= 10) return null;
  return { file: 'D3DCompiler_47.dll', version };
}

// Games whose renderer the executable scan cannot read, by exe name. FIFA 16's exe is protected, so
// neither its imports nor its strings show the D3D11 it renders with: detection said "API not
// detected", the route stopped at Undetermined, and the DLSS5 Feeder -- which the game needs, having
// no DLSS of its own -- was never offered (user report, 2026-09-16). An entry is the game's one fixed
// renderer, so it wins over the scan; a game with a renderer setting gets its own reader instead
// (rdr2Renderer below).
const KNOWN_RENDERERS = {
  'fifa16.exe': { api: 'dx11', name: 'FIFA 16' },
};

function knownRenderer(exePath) {
  const known = KNOWN_RENDERERS[path.basename(String(exePath || '')).toLowerCase()];
  if (!known) return null;
  return {
    api: known.api, apis: [known.api], old: [],
    reason: `${API_LABEL[known.api]} -- what ${known.name} renders with; its protected executable does not say so itself`,
  };
}

// RDR2's executable is byte-for-byte the same under DX12 and Vulkan; its own settings file is
// the only place the answer exists. One-way: only an explicit Vulkan setting moves the answer.
function rdr2Renderer() {
  const home = process.env.USERPROFILE || os.homedir();
  const rel = path.join('Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml');
  const roots = [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')];
  if (process.env.OneDrive) roots.push(path.join(process.env.OneDrive, 'Documents'));
  for (const root of roots) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    const setting = /<API[^>]*>([^<]*)<\/API>/i.exec(text);
    if (setting && /vulkan/i.test(setting[1])) return { api: 'vulkan', apis: ['vulkan', 'dx12'], old: [], reason: 'Vulkan -- what RDR2\'s own system.xml says it renders with' };
    if (setting) return { api: 'dx12', apis: ['dx12', 'vulkan'], old: [], reason: 'DX12 -- what RDR2\'s own system.xml says it renders with' };
  }
  return { api: 'dx12', apis: ['dx12', 'vulkan'], old: [], reason: 'DX12 -- RDR2\'s default renderer (its system.xml was not found)' };
}

function pickModern(modern, imports) {
  const vulkanLinked = imports.includes(API_DLL.vulkan);
  const d3dLinked = imports.includes(API_DLL.dx12) || imports.includes(API_DLL.dx11);
  if (modern.has('vulkan') && vulkanLinked && !d3dLinked) return 'vulkan';
  // An API the executable actually imports beats one that is merely a string inside it.
  // apisFromEvidence counts both, because a game that loads its renderer with LoadLibrary names it
  // nowhere else -- but that makes "d3d12.dll" appearing anywhere in the binary weigh as much as a
  // real import, and MODERN_APIS puts dx12 first, so any mention at all won the tie.
  //
  // GTA V Legacy, 2026-09-16: reported as DX12. It is a DX10/11 game -- the DX12 one is Enhanced,
  // a separate executable (gta5_enhanced.exe) -- and it imports d3d11.dll while only mentioning
  // d3d12.dll. The route built on that answer is the wrong one for the game.
  //
  // A game that imports both still resolves to dx12, exactly as before: this only breaks the tie
  // between something linked and something named. When the pick is a downgrade from a mention,
  // dx12 stays in `apis` so the override and the post-run re-check from OptiScaler.log can correct
  // it -- a renderer loaded purely through LoadLibrary is the case this cannot see.
  const linked = MODERN_APIS.find((api) => modern.has(api) && imports.includes(API_DLL[api]));
  if (linked) return linked;
  return MODERN_APIS.find((api) => modern.has(api)) || null;
}

// One pass over the executable serves both the API and the engine questions.
async function scanExecutable(exePath) {
  const [imports, hits] = await Promise.all([peImports(exePath), scanFile(exePath, [...API_NEEDLES, ...ENGINE_NEEDLES])]);
  return { imports, hits, ...apisFromEvidence(imports, hits) };
}

async function scanSiblingDlls(dir, exePath) {
  const modern = new Set();
  const old = new Set();
  const imports = [];
  const sources = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { modern, old, imports, sources };
  }
  const exeName = path.basename(exePath).toLowerCase();
  const dlls = entries.filter((f) => /\.dll$/i.test(f) && f.toLowerCase() !== exeName && !MOD_PAYLOAD_DLL.test(f));

  for (const name of dlls) {
    const file = path.join(dir, name);
    const [dllImports, hits] = await Promise.all([
      peImports(file),
      scanFile(file, [...API_NEEDLES, OPTISCALER_NEEDLE], { maxBytes: SIBLING_SCAN_MAX_BYTES }),
    ]);
    // A renamed OptiScaler proxy, or anything else carrying its name, is our payload -- skip it.
    if (hits.has('__optiscaler')) continue;
    const found = apisFromEvidence(dllImports, hits);
    if (found.modern.size === 0 && found.old.size === 0) continue;
    for (const api of found.modern) modern.add(api);
    for (const api of found.old) old.add(api);
    imports.push(...dllImports);
    sources.push(name);
  }

  for (const api of folderApiEvidence(dir)) {
    modern.add(api);
    sources.push(api === 'dx12' ? 'D3D12\\D3D12Core.dll' : 'vulkan-1.dll');
  }
  return { modern, old, imports, sources };
}

// What the game folder itself says, independent of any binary: its own Agility SDK redistributable
// only ever ships with a DX12 renderer (Where Winds Meet links DX11 in its exe and keeps its DX12
// path here), and a shipped Vulkan loader means a Vulkan path exists.
function folderApiEvidence(dir) {
  const found = new Set();
  if (agilitySdkPath(dir)) found.add('dx12');
  if (fs.existsSync(path.join(dir, 'vulkan-1.dll'))) found.add('vulkan');
  return found;
}

async function genericApiDetection(dir, exePath, exe) {
  if (exe.modern.size > 0) {
    const named = apiFromFileName(exePath);
    const api = named && exe.modern.has(named) ? named : pickModern(exe.modern, exe.imports);
    const linked = exe.imports.includes(API_DLL[api]);
    const how = named === api ? 'named by the executable\'s file name' : linked ? 'linked by the executable' : 'referenced in the executable';
    return {
      api, apis: [...new Set([api, ...exe.modern, ...folderApiEvidence(dir)])], old: [...exe.old], agility: exe.agility,
      reason: `${API_LABEL[api]} -- ${how}`,
    };
  }
  if (exe.old.size > 0) {
    const api = OLD_API_DLLS.map(([a]) => a).find((a) => exe.old.has(a));
    return { api: null, apis: [], old: [api], reason: `${API_LABEL[api]} -- the executable links nothing newer` };
  }

  const siblings = await scanSiblingDlls(dir, exePath);
  if (siblings.modern.size > 0) {
    const api = pickModern(siblings.modern, siblings.imports);
    return {
      api, apis: [...siblings.modern], old: [...siblings.old],
      reason: `${API_LABEL[api]} -- from ${siblings.sources.slice(0, 3).join(', ')} beside the executable`,
    };
  }
  if (siblings.old.size > 0) {
    const api = OLD_API_DLLS.map(([a]) => a).find((a) => siblings.old.has(a));
    return { api: null, apis: [], old: [api], reason: `${API_LABEL[api]} -- from ${siblings.sources.slice(0, 3).join(', ')} beside the executable` };
  }
  return { api: null, apis: [], old: [], reason: 'could not tell which graphics API this uses' };
}

// ---------------------------------------------------------------------------------------------
// Engines

function isReEngineGame(dir) {
  try {
    return fs.readdirSync(dir).some((f) => /^re_chunk_000\.pak$/i.test(f));
  } catch {
    return false;
  }
}

function unityDataDir(dir, exePath) {
  const base = path.basename(exePath, path.extname(exePath));
  const dataDir = path.join(dir, `${base}_Data`);
  return fs.existsSync(dataDir) ? dataDir : null;
}

function isUnityGame(dir, exePath) {
  return fs.existsSync(path.join(dir, 'UnityPlayer.dll')) || unityDataDir(dir, exePath) !== null;
}

// Unity writes the renderer it actually created to its own Player.log on every launch. That is
// the truth for a Unity game, and the only way to know it before running: UnityPlayer.dll
// mentions every API the engine can do, not the one this game's build settings pick.
async function unityRuntimeApi(dir, exePath) {
  const dataDir = unityDataDir(dir, exePath);
  if (!dataDir) return null;
  let company;
  let product;
  try {
    [company, product] = (await fsp.readFile(path.join(dataDir, 'app.info'), 'utf-8')).split(/\r?\n/).map((s) => s.trim());
  } catch {
    return null;
  }
  if (!company || !product) return null;
  const logDir = path.join(os.homedir(), 'AppData', 'LocalLow', company, product);
  for (const name of ['Player.log', 'Player-prev.log']) {
    let text;
    try {
      text = await fsp.readFile(path.join(logDir, name), 'utf-8');
    } catch {
      continue;
    }
    const d3d = text.match(/Version:\s+Direct3D (\d+)/);
    if (d3d) return d3d[1] === '12' ? 'dx12' : 'dx11';
    if (/Vulkan:\s*\r?\n\s*Version:/.test(text)) return 'vulkan';
    if (/Direct3D 12/.test(text)) return 'dx12';
    if (/Direct3D 11/.test(text)) return 'dx11';
  }
  return null;
}

async function detectUnity(dir, exePath) {
  const shipsDx12 = fs.existsSync(path.join(dir, 'D3D12', 'D3D12Core.dll'));
  const runtime = await unityRuntimeApi(dir, exePath);
  if (runtime) {
    return {
      api: runtime, apis: [...new Set([runtime, 'dx11', ...(shipsDx12 ? ['dx12'] : [])])],
      reason: `${API_LABEL[runtime]} -- what Unity's own Player.log says this game last ran with`,
      uncertain: false,
    };
  }
  return {
    api: 'dx11', apis: shipsDx12 ? ['dx11', 'dx12'] : ['dx11'],
    reason: `DX11 -- Unity's Windows default; ${shipsDx12 ? 'this game also ships DX12, so ' : ''}run it once and this is re-checked from its Player.log`,
    uncertain: true,
  };
}

// RED Engine loads its renderer without ever naming the DLL, so nothing on disk says which one
// short of the layout CD Projekt themselves use: Cyberpunk is DX12 only, The Witcher 3 keeps DX11
// and DX12 builds in sibling folders named for the API.
function detectRedEngine(dir, exePath) {
  const exe = path.basename(exePath).toLowerCase();
  if (exe === 'cyberpunk2077.exe') return { api: 'dx12', apis: ['dx12'], reason: 'DX12 -- Cyberpunk 2077 is DX12 only' };
  if (/dx12/i.test(path.basename(dir))) return { api: 'dx12', apis: ['dx12'], reason: `DX12 -- the ${path.basename(dir)} build` };
  if (/dx11/i.test(path.basename(dir))) return { api: 'dx11', apis: ['dx11'], reason: `DX11 -- the ${path.basename(dir)} build` };
  if (exe === 'witcher3.exe') return { api: 'dx11', apis: ['dx11'], reason: 'DX11 -- The Witcher 3 classic build (the DX12 one lives in bin\\x64_dx12)' };
  return null;
}

// Only names distinctive enough that their presence in an executable means the engine, not a
// word: a wrong engine tag is worse than none.
const ENGINE_NEEDLES = [
  makeNeedle('unreal', '++UE', { exactCase: true }),
  makeNeedle('red', 'REDengine'),
  makeNeedle('red2', 'CD PROJEKT'),
  makeNeedle('cryengine', 'CryEngine', { exactCase: true }),
  makeNeedle('godot', 'Godot Engine', { exactCase: true }),
  makeNeedle('anvil', 'AnvilNext', { exactCase: true }),
];

function unrealVersionFromWindow(window) {
  if (!window) return null;
  for (const encoding of ['latin1', 'utf16le']) {
    const m = window.toString(encoding).match(/\+\+UE(\d)\+Release-(\d+\.\d+)/);
    if (m) return m[2];
    const major = window.toString(encoding).match(/\+\+UE(\d)/);
    if (major) return major[1];
  }
  return null;
}

function looksLikeUnrealLayout(dir, exePath) {
  if (/-win(64|gdk)-shipping\.exe$/i.test(path.basename(exePath))) return true;
  const parts = dir.split(/[\\/]/).map((p) => p.toLowerCase());
  return parts.length >= 3 && parts[parts.length - 1] === 'win64' && parts[parts.length - 2] === 'binaries';
}

function engineFromEvidence(dir, exePath, hits) {
  if (hits.has('red') || hits.has('red2')) return { engine: 'RED Engine', id: 'red' };
  if (hits.has('unreal') || looksLikeUnrealLayout(dir, exePath)) {
    const version = unrealVersionFromWindow(hits.get('unreal'));
    return { engine: version ? `Unreal Engine ${version}` : 'Unreal Engine', id: 'unreal', version };
  }
  if (fs.existsSync(path.join(dir, 'CrySystem.dll')) || hits.has('cryengine')) return { engine: 'CryEngine', id: 'cryengine' };
  if (hits.has('godot')) return { engine: 'Godot', id: 'godot' };
  if (hits.has('anvil')) return { engine: 'AnvilNext', id: 'anvil' };
  return { engine: null, id: null };
}

// Unreal's executable names d3d12.dll whether or not the game ever uses it: the D3D12 RHI is
// compiled in from UE 4.2x on while the Windows default stayed DX11 through UE4 (UE5 flipped it
// to DX12). Fallen Order (UE 4.21, DX11 only) read as "DX12 primary" from the exe alone, which
// would have offered OptiScaler's D3D12-only Frame Generation on a D3D11 swapchain. So for an
// Unreal game the exe is only the list of candidates: the primary is the engine generation's
// default unless the folder proves otherwise (the Agility SDK redistributable D3D12\D3D12Core.dll
// ships only with a DX12 renderer), and either way it stays provisional until OptiScaler.log
// shows what the game really created (optiScalerRuntimeApi below).
// Unreal packages the Agility SDK as Binaries\Win64\D3D12\D3D12Core.dll (Code Vein 2) or
// D3D12\x64\D3D12Core.dll (Mortal Shell II, Halloween) -- both the game's own files, dated with
// the install. OptiScaler's own copy lives under OptiScaler\D3D12_OptiScaler\ and is never
// looked at here: it says what OptiScaler can do, not what the game does.
function agilitySdkPath(dir) {
  for (const rel of [['D3D12', 'D3D12Core.dll'], ['D3D12', 'x64', 'D3D12Core.dll']]) {
    const p = path.join(dir, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The same Agility SDK redirect read as a risk rather than as evidence of DX12 -- the one thing
// that can make an entire Feeder deploy silently do nothing, and a Unity report is what found it.
//
// An exe exporting D3D12SDKPath/D3D12SDKVersion tells Direct3D 12 to load its runtime from a
// game-local D3D12\ folder for EVERY device created in that process. If that folder is missing,
// empty, or holds a D3D12Core.dll of a version the exe did not ask for, every create in the
// process fails with 0x887E0003, D3D12_ERROR_INVALID_REDIST -- including the private D3D12 device
// the Feeder opens to run DLSS on. The Feeder's README documents this (its issues #61 and #81)
// and notes that Unity titles commonly carry those exports.
//
// What makes it invisible: a Unity game rendering D3D11 never creates a D3D12 device of its own,
// so a broken or absent redist costs the game nothing. The game runs, the Feeder deploys, the
// shaders compile -- and DLSS 5 never starts, with nothing in the game's own behaviour to hint at
// why. The fix the Feeder's README gives is to move that folder aside and relaunch.
//
// Only "the exports are there and no D3D12Core.dll can be found" is reported here. A version
// mismatch between what the exe asks for and what the folder holds would need the value of the
// exported UINT, a data export this app does not parse -- and that half is covered by evidence
// instead: the Feeder writes the code into its own log, which runlog.js reads.
function agilityRedistRisk(dir, detected = {}) {
  if (!detected.agility) return null;
  if (agilitySdkPath(dir)) return null;
  return { exports: true, folder: fs.existsSync(path.join(dir, 'D3D12')) ? 'D3D12' : null };
}

// DLSS Frame Generation only runs on a D3D12 (or Vulkan) swapchain, and Unreal never defaults
// to Vulkan on Windows -- so a UE game that ships nvngx_dlssg.dll / sl.dlss_g.dll (beside the exe
// like Aliens: Fireteam Elite 2, or in its plugin tree like Stellar Blade's
// SB\Plugins\Runtime\Nvidia\Streamline) renders with DX12 whatever generation of UE4 it is.
// Direct children of the exe folder only: the streamline\ subfolder beside the exe is this
// app's own Streamline deploy, and OptiScaler\streamline\ is OptiScaler's.
const DLSS_FG_FILES = ['nvngx_dlssg.dll', 'sl.dlss_g.dll'];

function dlssFrameGenPath(dir) {
  for (const name of DLSS_FG_FILES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return findUnrealPluginFile(dir, DLSS_FG_FILES);
}

function unrealStaticApi(dir, found, engine) {
  if (!found.api || found.api === 'vulkan') return found;
  const apis = found.apis || [];
  if (!(apis.includes('dx11') && apis.includes('dx12'))) return found;
  const dx12First = ['dx12', ...apis.filter((a) => a !== 'dx12')];
  if (found.agility) {
    return { ...found, api: 'dx12', apis: dx12First, reason: 'DX12 -- the executable exports the Agility SDK path/version (D3D12SDKPath/D3D12SDKVersion), which only a DX12 renderer does' };
  }
  const agility = agilitySdkPath(dir);
  if (agility) {
    return { ...found, api: 'dx12', apis: dx12First, reason: `DX12 -- ships the Agility SDK (${path.relative(dir, agility)}), which only a DX12 renderer uses` };
  }
  const fg = dlssFrameGenPath(dir);
  if (fg) {
    return { ...found, api: 'dx12', apis: dx12First, reason: `DX12 -- ships DLSS Frame Generation (${path.basename(fg)}), which needs a D3D12 swapchain` };
  }
  const major = engine.version ? parseInt(String(engine.version), 10) : null;
  const api = major === 4 ? 'dx11' : 'dx12';
  const reason = major === 4
    ? 'DX11 -- Unreal Engine 4\'s Windows default; the exe names DX12 too, so run it once and this is re-checked from OptiScaler.log'
    : 'DX12 -- Unreal Engine 5\'s Windows default; the exe names DX11 too, so run it once and this is re-checked from OptiScaler.log';
  return { ...found, api, apis: [api, ...apis.filter((a) => a !== api)], reason, uncertain: true };
}

// The truth, once the game has run with OptiScaler installed: its own log names the device and
// swapchain the game created (the same idea as Unity's Player.log above, for every engine).
// Markers are our fork's own log lines, checked against real logs (2026-09-11): a D3D11 game
// (Fallen Order, Batman) logs "creating Dx11 swapchain!" from the DXGI factory hook and
// "hkD3D11CreateDevice[AndSwapChain] Device captured"; a D3D12 game (Code Vein 2, Cyberpunk)
// logs only hkD3D12CreateDevice. Swapchain evidence outranks device evidence because a D3D11
// game with the DLSS5 Feeder also has one D3D12 device -- the Feeder's own private NGX session.
const RUNTIME_LOG_MAX_BYTES = 4 * 1024 * 1024;

// The executable as it was when a detection was made. A game patched by its store is a different
// program -- it can ship a renderer it did not ship before -- so a stored answer about it expires.
// Until v1.59.0 nothing needed this: autoConfigureGame re-scanned the exe on every sync and simply
// absorbed the cost. Now that it does not, this is what keeps a stored answer honest.
function exeStamp(exePath) {
  try { const st = fs.statSync(exePath); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
}

function optiScalerLogStat(dir) {
  try { return fs.statSync(path.join(dir, 'OptiScaler.log')); } catch { return null; }
}

async function optiScalerRuntimeApi(dir) {
  let fh;
  try { fh = await fsp.open(path.join(dir, 'OptiScaler.log'), 'r'); } catch { return null; }
  let text;
  try {
    // Sized to the log, not to the cap: Buffer.alloc(4 MB) per call zero-filled four megabytes
    // for a log that is usually a few dozen kilobytes.
    const size = Math.min((await fh.stat()).size, RUNTIME_LOG_MAX_BYTES);
    if (size <= 0) return null;
    const buf = Buffer.allocUnsafe(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    text = buf.subarray(0, bytesRead).toString('latin1');
  } catch {
    return null;
  } finally {
    await fh.close();
  }
  if (/Vulkan is creating swapchain/.test(text)) return { api: 'vulkan', evidence: 'a Vulkan swapchain' };
  if (/creating Dx11 swapchain!|hkD3D11CreateDeviceAndSwapChain Device captured|Created Dx11wDx12SC/.test(text)) return { api: 'dx11', evidence: 'a D3D11 swapchain' };
  const d3d11Device = /hkD3D11CreateDevice Device captured/.test(text);
  if (/hkD3D12CreateDevice/.test(text) && !d3d11Device) return { api: 'dx12', evidence: 'a D3D12 device' };
  if (d3d11Device) return { api: 'dx11', evidence: 'a D3D11 device' };
  return null;
}

// A UE game's root holds a launcher stub named like the game (CodeVein2.exe) that only spawns
// <Project>\Binaries\Win64\<Project>-Win64-Shipping.exe -- the process that actually renders,
// and the only folder where a proxy DLL, the ini and every check in this app mean anything.
// Pointed at the stub, the app would install beside a file that never loads dxgi.dll.
function resolveUnrealShippingExe(exePath) {
  if (!exePath || /-win(64|gdk)-shipping\.exe$/i.test(exePath)) return exePath;
  const root = path.dirname(exePath);
  if (!fs.existsSync(path.join(root, 'Engine'))) return exePath;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return exePath; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.toLowerCase() === 'engine') continue;
    const win64 = path.join(root, e.name, 'Binaries', 'Win64');
    let files = [];
    try { files = fs.readdirSync(win64); } catch { continue; }
    const shipping = files.find((f) => /-win64-shipping\.exe$/i.test(f));
    if (shipping) return path.join(win64, shipping);
  }
  return exePath;
}

// Other DLSS 5 toolchains that people layer into the same folder. Two stacks hooking the same
// NGX call -- two Feeders, a Feeder under Luma, two neural consumers -- crash the game, and the
// folder in a real user's report (2026-09-11) carried DLSS5oneclick's whole tree (Core\, docs\,
// INSTALL-DLSSNR.md, *.dlss5oneclick backups, nvngx_dlssnr_proxy.dll) under this app's own
// OptiScaler + Luma, with the other tool's Feeder crash dump sitting beside them. Marker files
// only, never guessed from generic names; the report names the tool and the files.
const FOREIGN_TOOLCHAINS = [
  // INSTALL-DLSSNR.md is deliberately NOT in this list, though DLSS5oneclick does place one: it is
  // also the name of a file in OptiScaler_DLSSNR's own repo, so this app's own installs have put it
  // in game folders. A user's DOOM 3 BFG (2026-09-13) was flagged as carrying a rival toolchain on
  // the strength of a file our own installer had journaled as `added` -- and the removal that
  // offers is the one below, which lists dlss5-feed.addon64. A marker has to be unambiguous, and
  // every other one here is: the .dlss5oneclick suffix, its Core\ layout, its streamline scripts.
  { tool: 'DLSS5oneclick', files: ['nvngx_dlssnr.dll.dlss5oneclick', '!! EXTRACT ALL FILES TO GAME FOLDER !!.dlss5oneclick', 'Core/dlss5-feed.addon64', 'Core/renodx-dlss5.addon64', 'get_streamline.ps1', 'get_streamline.bat', 'get_streamline.cmd'], pattern: /\.dlss5oneclick$/i },
  { tool: 'DLSS5-Swapper', files: ['_DLSS5_Backup/manifest.json', 'renodx-dlss5.addon64', 'host64/renodx-dlss5.addon64', 'dlss5-feed-host64.exe'] },
  { tool: 'DLSSNR-Cost-Scaler', files: ['nvngx_dlssnr_proxy.dll'] },
  // Anywhere in the name, not only at its start: ReShade loads every .addon64 whatever it is called, and
  // a renamed copy (SWTOR's "Xrenodx-dlss5.addon64", 2026-09-16) went unseen -- so its Streamline files
  // were read as the game's own DLSS and Install replaced the ReShade that loaded it.
  { tool: 'a RenoDX DLSS 5 add-on', pattern: /renodx-dlss.*\.addon(64|32)?$/i },
  // Deep Fried Chicken is not a rival installer like the ones above -- it is another neural add-on,
  // and a good one, which someone may be running on purpose. It is here because the clash with ours
  // is SILENT: its own documentation says never to install two neural add-ons, and that when it
  // finds a competing one "it does nothing at all for the whole session". OptiScaler's NR pass is a
  // competing one. Without this the user sees an install that reports success, a panel that opens,
  // and no picture change ever, with nothing anywhere saying why.
  { tool: 'Deep Fried Chicken', files: ['deep-fried-chicken.addon64', 'deep-fried-chicken-nvngx.dll', 'deep-fried-chicken.cfg'] },
];

// What each recognised tool is known to place -- the explicit "remove the other toolchain"
// action deletes exactly these (and only for a tool whose markers are present), restores that
// tool's own backups where the backed-up name is one a game can own, and reverses DLSS5-Swapper's
// manifest the way its own uninstall would. Nothing else in the folder is touched; a game file a
// tool patched in place without a backup is beyond reach, which the UI says twice.
const FOREIGN_REMOVALS = {
  DLSS5oneclick: {
    files: ['Core', 'docs', 'redist', 'INSTALL-DLSSNR.md', 'SHA256SUMS', 'README.md', 'LICENSE', 'dlss5-feed-crash.dmp',
      'dlss5-feed.addon64', 'dlss5-feed.addon32', 'dlss5-feed.cfg', 'dlss5-feed.log', 'dlss5-feed-host64.exe',
      'renodx-dlss5.addon64', 'renodx-dlss.addon64', 'nvngx_dlssnr_proxy.dll', 'host64'],
    patterns: [/^get_streamline\.[a-z0-9]+$/i, /^read ?me( - dlss neural rendering)?\.(txt|md)$/i, /^ReShade[_ ]?Setup.*\.exe$/i, /^ReShade\.exe$/i],
    backupSuffix: '.dlss5oneclick',
  },
  'DLSS5-Swapper': {
    files: ['renodx-dlss5.addon64', 'renodx-dlss.addon64', 'host64', 'dlss5-feed-host64.exe', 'dlss5-feed.addon64', 'dlss5-feed.addon32', 'dlss5-feed.cfg', 'dlss5-feed.log', 'reshade-shaders-original'],
    manifest: '_DLSS5_Backup',
  },
  'DLSSNR-Cost-Scaler': { files: ['nvngx_dlssnr_proxy.dll'], patterns: [/cost[_ -]?scaler/i] },
  'a RenoDX DLSS 5 add-on': { patterns: [/renodx-dlss.*\.addon(64|32)?$/i, /^renodx.*\.ini$/i] },
  // Only the three files Deep Fried Chicken ships. It places no backups and patches nothing, so
  // there is nothing to restore -- and the log it writes beside them goes too. Offered rather than
  // done: someone may be running it on purpose and want ours gone instead, which Remove already does.
  'Deep Fried Chicken': { files: ['deep-fried-chicken.addon64', 'deep-fried-chicken-nvngx.dll', 'deep-fried-chicken.cfg', 'deep-fried-chicken.log'] },
};
// A backed-up name a game could legitimately own comes back from the backup; anything else that
// only a DLSS 5 tool would put there is deleted along with its backup.
const NEVER_GAME_OWNED = /^(nvngx_dlssnr|nvngx\.dll_dlssnr|OptiScaler|!! EXTRACT|dlss5-feed|renodx|ReShade)/i;
// This app's own payload is never part of a foreign removal while its install is present here --
// another tool's backup of nvngx_dlssnr.dll must not take our NR model with it.
const OUR_PAYLOAD = ['nvngx_dlssnr.dll', 'nvngx.dll_dlssnr.dll', 'OptiScaler.ini', 'OptiScaler.dll', 'OptiScaler_OpticalFlow.dll', 'OptiScaler', '!! EXTRACT ALL FILES TO GAME FOLDER !!', 'setup_windows.bat', 'setup_linux.sh', 'Licenses'];

// Files this app put here itself, from its own install journal. Evidence that another tool was
// here cannot be a file we placed -- that is how a DOOM 3 BFG install came to be accused of
// carrying DLSS5oneclick on the strength of INSTALL-DLSSNR.md, which our own installer had
// extracted and journaled. The signature list is the first defence and this is the second, because
// the next collision will be with a filename nobody has thought about yet.
function filesWePlaced(dir) {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(dir, '.optiscaler-manager-install.json'), 'utf8'));
    const added = Array.isArray(journal.added) ? journal.added : [];
    return new Set(added.map((n) => String(n).toLowerCase()));
  } catch {
    return new Set();
  }
}

function foreignToolchains(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const ours = filesWePlaced(dir);
  const out = [];
  for (const t of FOREIGN_TOOLCHAINS) {
    if (t.unless && fs.existsSync(path.join(dir, t.unless))) continue;
    const found = new Set();
    for (const rel of t.files || []) {
      if (ours.has(rel.toLowerCase())) continue;
      if (fs.existsSync(path.join(dir, ...rel.split('/')))) found.add(rel);
    }
    if (t.pattern) for (const n of names) if (t.pattern.test(n) && !ours.has(n.toLowerCase())) found.add(n);
    if (found.size) out.push({ tool: t.tool, files: [...found] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public

async function detectGame(dir, exePath) {
  // An emulator (emulators.js): its renderer is a setting inside it, not something the exe can
  // say, so the profile names what it offers and which one is assumed until chosen in Edit.
  const emulator = emulators.profileFor(exePath);
  if (emulator) return detectEmulator(dir, exePath, emulator);

  let engine;
  let exe = null;
  if (isReEngineGame(dir)) engine = { engine: 'RE Engine', id: 're' };
  else if (isUnityGame(dir, exePath)) engine = { engine: 'Unity', id: 'unity' };
  else {
    exe = await scanExecutable(exePath);
    engine = engineFromEvidence(dir, exePath, exe.hits);
  }

  let found;
  if (engine.id === 'unity') found = await detectUnity(dir, exePath);
  else if (engine.id === 'red') found = detectRedEngine(dir, exePath);
  else if (/^rdr2\.exe$/i.test(path.basename(exePath))) found = rdr2Renderer();
  if (!found) found = knownRenderer(exePath);
  if (!found) found = await genericApiDetection(dir, exePath, exe || (await scanExecutable(exePath)));
  if (engine.id === 'unreal') found = unrealStaticApi(dir, found, engine);

  const [bitness, hooks] = await Promise.all([peBitness(exePath), inspectHookDlls(dir)]);
  // A DXVK this app put in front of the game (translation.js's manifest) is not evidence about the
  // game: it is the route the app chose for it, and the route has to be planned from the game's own
  // API, not from the wrapper's. Forcing 'vulkan' here turned Assassin's Creed II (32-bit DX9) into
  // "32-bit Vulkan, unsupported" the moment the DXVK swap finished (2026-09-18), which hid the route,
  // Game Help's buttons and with them any way back to dgVoodoo2. A DXVK the player placed by hand
  // still reads as Vulkan, as before. 32-bit only: there the Vulkan answer is a dead end ("32-bit
  // Vulkan is not supported"), while a 64-bit game under DXVK really is served by the 64-bit
  // Feeder's Vulkan path, which needs to be told Vulkan.
  const ourWrapper = hooks.vulkanWrapper && bitness === 32 ? ourTranslationLayer(dir) : null;
  if (hooks.vulkanWrapper && !ourWrapper && found.api && found.api !== 'vulkan') {
    found = {
      ...found, api: 'vulkan', apis: [...new Set(['vulkan', ...(found.apis || [])])], uncertain: false,
      reason: `Vulkan -- ${hooks.vulkanWrapper.file} beside the executable is ${hooks.vulkanWrapper.kind}, which presents the game's Direct3D through Vulkan`,
    };
  }

  const runtime = await optiScalerRuntimeApi(dir);
  if (runtime) {
    found = {
      ...found,
      // What the executable's own evidence said, before the runtime overwrote it. Kept because
      // `apis` below merges the two and no later reader can separate them again -- and with a
      // translation layer in front of the game the runtime API is the wrapper's, not the game's.
      exeApis: found.apis || [],
      api: runtime.api,
      apis: [...new Set([runtime.api, ...(found.apis || [])])],
      reason: `${API_LABEL[runtime.api]} -- what OptiScaler saw this game create on its last run (${runtime.evidence})`,
      uncertain: false,
      runtimeApi: runtime.api,
    };
  }
  const logStat = optiScalerLogStat(dir);

  // A game whose only API is OpenGL is a DLSS5 Feeder game: ReShade goes in as its opengl32.dll
  // and the Feeder evaluates on a private D3D12 device (its README: MX Bikes, KOTOR, Worms).
  if (!found.api && found.old && found.old[0] === 'opengl') {
    found = { ...found, api: 'opengl', apis: ['opengl'], reason: `OpenGL -- ${found.reason}; the DLSS5 Feeder route puts ReShade in as opengl32.dll` };
  }
  // DX9, DX8 and DX10 (EXPERIMENTAL, legacy.js). The Feeder's README has a path for each:
  // D3D9 and D3D8 through dgVoodoo2, which turns them into D3D11 (a 32-bit game, or a 64-bit
  // D3D9 one with dgVoodoo's x64 build -- there is no 64-bit D3D8), and D3D10 natively but only
  // in its 32-bit add-on. The primary API is set to it so the route can say which path applies.
  if (!found.api && found.old && found.old.length > 0) {
    const legacyApi = found.old[0];
    const reachable = legacyApi === 'dx9' || (bitness === 32 && (legacyApi === 'dx8' || legacyApi === 'dx10'));
    if (reachable) found = { ...found, api: legacyApi, apis: [legacyApi], legacy: true };
  }
  const oldOnly = !found.api && found.old && found.old.length > 0;
  // The tag names every API the game really runs on, primary first -- "DX11/DX12" for a game
  // that links DX11 but ships a DX12 path too. Vulkan is listed only when it is the primary:
  // Unreal and Unity name vulkan-1.dll without ever defaulting to it on Windows.
  const others = MODERN_APIS.filter((a) => a !== found.api && a !== 'vulkan' && (found.apis || []).includes(a));
  const apiLabel = found.api
    ? [found.api, ...others].map((a) => API_LABEL[a]).join('/')
    : oldOnly ? API_LABEL[found.old[0]] : null;

  let recommend = 'unknown';
  let reason = found.reason;
  // Experimental routes (legacy.js): a 32-bit game runs the DLSS work in the Feeder's 64-bit
  // helper process, since NVIDIA ships no 32-bit NGX; DX8/DX9 go through dgVoodoo2 first.
  const experimental = bitness === 32 || !!found.legacy;
  if (bitness === 32 && found.api === 'vulkan') {
    recommend = 'unsupported';
    reason = `32-bit Vulkan -- the Feeder supports it through DXVK and its own 32-bit Vulkan layer, which this app does not deploy yet (${reason})`;
  } else if (bitness === 32 && found.api) {
    recommend = 'optiscaler';
    reason = `32-bit executable -- experimental: the DLSS work runs in the Feeder's 64-bit helper beside the game${['dx8', 'dx9'].includes(found.api) ? ', with dgVoodoo2 turning ' + API_LABEL[found.api] + ' into D3D11' : ''} (${reason})`;
  } else if (bitness === 32) {
    recommend = 'unknown';
    reason = `32-bit executable, graphics API not detected -- choose it in Edit (${reason})`;
  } else if (found.api) {
    recommend = 'optiscaler';
    if (found.legacy) reason = `${reason} -- experimental: dgVoodoo2 turns it into D3D11, then the DLSS5 Feeder route`;
    else if (found.api !== 'opengl') reason = `${reason} -- OptiScaler hooks this directly`;
  } else if (oldOnly) {
    recommend = 'unsupported';
    reason = `${reason} -- OptiScaler has no hook here`;
  } else if (engine.id === 're' || engine.id === 'red') {
    recommend = 'optiscaler';
    reason = `${engine.engine} -- graphics API not detected, but OptiScaler is commonly used with this engine`;
  }
  if (engine.id === 're') reason = `RE Engine needs REFramework, which this app fetches automatically. ${reason}`;

  return {
    api: found.api,
    apis: found.apis || [],
    engine: engine.engine,
    engineId: engine.id,
    engineVersion: engine.version || null,
    apiBadge: apiLabel,
    badge: engine.engine || apiLabel || 'Unknown',
    recommend,
    reason,
    uncertain: !!found.uncertain,
    bitness,
    experimental,
    emulator: null,
    vulkanWrapper: hooks.vulkanWrapper,
    // 'dxvk' when that wrapper is one this app deployed (see ourTranslationLayer): the game's API
    // above is then its own, and the wrapper is part of the route rather than of the game.
    translatedBy: ourWrapper,
    reshadeProxy: hooks.reshadeProxy,
    // An OptiScaler loading under a proxy name that is not the build this app installed.
    optiScalerProxy: hooks.optiScalerProxy,
    antiCheat: antiCheatPresent(dir, exePath),
    // The door out of an anti-cheat stub, if there is one -- see antiCheatStub().
    protectedLauncher: antiCheatStub(dir),
    oldShaderCompiler: oldShaderCompiler(dir),
    runtimeApi: found.runtimeApi || null,
    // The legacy APIs the EXECUTABLE itself links (dx8/dx9/dx10), kept apart from `api` and `apis`
    // because a translation layer overwrites those. dgVoodoo2 presents D3D11 to a Direct3D 9 game,
    // OptiScaler's log then reports a D3D11 device, and the block above replaces the detected API
    // with it -- after which nothing downstream could tell that the game underneath is DX9. That is
    // how SWTOR (issue #50) was routed as a game that ships its own DLSS and left waiting for a
    // DLSS call a Direct3D 9 title can never make. This field survives that overwrite.
    legacyApis: found.old || [],
    // The modern APIs the executable itself links. Equal to `apis` unless a run of the game
    // overrode them, which is exactly the case that needs telling apart.
    exeApis: found.exeApis || found.apis || [],
    // What OptiScaler.log looked like when this was decided -- a later run of the game is new
    // evidence, and isDetectionStale re-runs detection when the log has changed since.
    runtimeLogMtime: logStat ? logStat.mtimeMs : null,
    // ... and what the exe itself looked like, so a game update expires this answer.
    exeStamp: exeStamp(exePath),
    detectVersion: DETECT_VERSION,
  };
}

// EXPERIMENTAL. No exe scan: an emulator links every API it can render with, and which one runs
// is a setting inside it. The profile's first API is assumed; once OptiScaler has run in it, its
// log says what was really created, and an API chosen in Edit overrides both (route.js).
async function detectEmulator(dir, exePath, emu) {
  const [bitness, hooks] = await Promise.all([peBitness(exePath), inspectHookDlls(dir)]);
  let api = emu.apis[0];
  let reason = `${emu.name} (${emu.system}) is an emulator, so its renderer is one of its own settings ` +
    `(${emu.hint}); ${API_LABEL[api]} is assumed until you choose in Edit`;
  const runtime = await optiScalerRuntimeApi(dir);
  if (runtime && emu.apis.includes(runtime.api)) {
    api = runtime.api;
    reason = `${emu.name} (${emu.system}) is an emulator; ${API_LABEL[api]} is what OptiScaler saw it create on its last run (${runtime.evidence})`;
  }
  const logStat = optiScalerLogStat(dir);
  const vulkan32 = bitness === 32 && api === 'vulkan';
  return {
    api,
    apis: [api, ...emu.apis.filter((a) => a !== api)],
    engine: `${emu.name} emulator`,
    engineId: 'emulator',
    engineVersion: null,
    apiBadge: API_LABEL[api],
    badge: `${emu.name} emulator`,
    recommend: vulkan32 ? 'unsupported' : 'optiscaler',
    reason: `Experimental: ${reason}${vulkan32 ? ' -- but 32-bit Vulkan is not supported by this app yet' : ''}`,
    uncertain: !runtime,
    bitness,
    experimental: true,
    emulator: { key: emu.key, name: emu.name, system: emu.system, hint: emu.hint, apis: emu.apis },
    vulkanWrapper: hooks.vulkanWrapper,
    reshadeProxy: hooks.reshadeProxy,
    // An OptiScaler loading under a proxy name that is not the build this app installed.
    optiScalerProxy: hooks.optiScalerProxy,
    antiCheat: null,
    protectedLauncher: null,
    oldShaderCompiler: oldShaderCompiler(dir),
    runtimeApi: runtime ? runtime.api : null,
    runtimeLogMtime: logStat ? logStat.mtimeMs : null,
    exeStamp: exeStamp(exePath),
    detectVersion: DETECT_VERSION,
  };
}

async function detectRenderApi(dir, exePath, opts) {
  return (await detectGameCached(dir, exePath, opts)).api;
}

// ── Detection cache ───────────────────────────────────────────────────────────────────────────
//
// detectGame scans the executable byte by byte when a string it looks for is absent, which on a
// big title means reading the whole file: measured on a real library, 11 s for Star Wars Outlaws,
// 10 s for Resident Evil Requiem, 52 s for twenty games. autoConfigureGame called it uncached, and
// autoConfigureGame runs for every installed game on every sync -- so one app start spent about a
// minute inside this function with the main process blocked, and every IPC call the grid made
// queued behind it. That was the lag.
//
// Cached per executable against a signature nothing has to remember: the rules' version, the exe,
// the game folder's own mtime (which NTFS moves when a file beside the exe is added, removed or
// renamed) and OptiScaler.log's mtime (a new run of the game is new evidence -- the same signal
// isDetectionStale already watched). A change this signature cannot see -- something deployed into
// a subfolder -- is dropped explicitly by whoever deployed it, through invalidateDetection().
const detectCache = new Map();
const DETECT_CACHE_MAX = 256;
// A provisional answer is waiting on evidence no signature here can watch: a Unity game's own
// Player.log, which lives under LocalLow and moves when the game is played, not when its folder
// changes. isDetectionStale re-ran those on every single grid render, which is what made a Unity
// game the most expensive card on the screen. Held briefly instead -- long enough that a render
// costs nothing, short enough that playing the game is still what settles the answer.
const PROVISIONAL_TTL_MS = 60 * 1000;

function detectSignature(dir, exePath) {
  const stamp = (p) => {
    try { const st = fs.statSync(p); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
  };
  return [DETECT_VERSION, stamp(exePath), stamp(dir), stamp(path.join(dir, 'OptiScaler.log'))].join('|');
}

// The half of a detection that comes from the game folder rather than the executable: what is
// sitting beside the exe right now. Cheap enough to redo whenever the folder changes, which is
// what lets a stored detection be reused for the expensive half -- the engine and API, which come
// out of the exe and do not change until the game is patched.
async function folderEvidence(dir, exePath) {
  const hooks = await inspectHookDlls(dir);
  const logStat = optiScalerLogStat(dir);
  return {
    vulkanWrapper: hooks.vulkanWrapper,
    translatedBy: hooks.vulkanWrapper ? ourTranslationLayer(dir) : null,
    reshadeProxy: hooks.reshadeProxy,
    optiScalerProxy: hooks.optiScalerProxy,
    antiCheat: antiCheatPresent(dir, exePath),
    protectedLauncher: antiCheatStub(dir),
    oldShaderCompiler: oldShaderCompiler(dir),
    runtimeLogMtime: logStat ? logStat.mtimeMs : null,
    exeStamp: exeStamp(exePath),
  };
}

// A stored detection plus fresh folder evidence. The exe scan is skipped; everything a file
// appearing beside the exe can change is read again, including the Vulkan-wrapper override that
// detectGame applies on top of its own answer.
async function detectFromStored(dir, exePath, stored) {
  const evidence = await folderEvidence(dir, exePath);
  let out = { ...stored, ...evidence };
  if (!(stored.bitness === 32 && evidence.translatedBy)) evidence.translatedBy = null;
  out.translatedBy = evidence.translatedBy;
  if (evidence.vulkanWrapper && !evidence.translatedBy && out.api && out.api !== 'vulkan') {
    out = {
      ...out, api: 'vulkan', apis: [...new Set(['vulkan', ...(out.apis || [])])], uncertain: false,
      reason: `Vulkan -- ${evidence.vulkanWrapper.file} beside the executable is ${evidence.vulkanWrapper.kind}, which presents the game's Direct3D through Vulkan`,
    };
  }
  return out;
}

// `stored`: the detection already saved for this game (games.json). When it is still current by
// isDetectionStale's own rules, the executable is not scanned again -- only the folder is re-read.
async function detectGameCached(dir, exePath, { stored = null } = {}) {
  const key = `${dir}\u0000${exePath}`;
  const signature = detectSignature(dir, exePath);
  const hit = detectCache.get(key);
  if (hit && hit.signature === signature && !(hit.expires && Date.now() > hit.expires)) return hit.promise;
  // The promise is cached, not the result: a grid render fires several calls for the same game at
  // once, and they have to share the one scan instead of each starting their own.
  const promise = stored && !isDetectionStale(stored, dir, exePath)
    ? detectFromStored(dir, exePath, stored)
    : detectGame(dir, exePath);
  const entry = { signature, promise, expires: 0 };
  detectCache.set(key, entry);
  promise.then(
    (found) => { if (found && found.uncertain && found.engineId !== 'unreal') entry.expires = Date.now() + PROVISIONAL_TTL_MS; },
    // A scan that threw must not be remembered as this signature's answer.
    () => { if (detectCache.get(key) === entry) detectCache.delete(key); }
  );
  if (detectCache.size > DETECT_CACHE_MAX) detectCache.delete(detectCache.keys().next().value);
  return promise;
}

// Call after changing a game folder in a way detectSignature cannot see: a DLL written into a
// subfolder, a plugin tree placed, a proxy renamed. No argument clears everything.
function invalidateDetection(dir) {
  if (!dir) { detectCache.clear(); return; }
  const prefix = `${dir}\u0000`;
  for (const key of [...detectCache.keys()]) if (key.startsWith(prefix)) detectCache.delete(key);
}

function isDetectionStale(stored, dir, exePath = null) {
  if (!stored || stored.detectVersion !== DETECT_VERSION) return true;
  // The game was patched since this was decided, so the exe it describes is not the exe on disk.
  // A stored answer from before exeStamp existed has nothing to compare and is left alone rather
  // than re-scanning every game in a library at once on the first launch after an update.
  if (exePath && stored.exeStamp && stored.exeStamp !== exeStamp(exePath)) return true;
  // A provisional Unity answer waits on Player.log, which nothing below tracks, so it re-runs
  // every time; a provisional Unreal answer waits on OptiScaler.log, tracked by mtime below --
  // re-scanning a 100 MB exe on every grid render would buy nothing until the game has run.
  if (!!stored.uncertain && stored.engineId !== 'unreal') return true;
  if (dir) {
    const logStat = optiScalerLogStat(dir);
    const mtime = logStat ? logStat.mtimeMs : null;
    if (mtime !== (stored.runtimeLogMtime === undefined ? null : stored.runtimeLogMtime)) return true;
  }
  return false;
}

// Plans the removal without doing it, so both confirmations can show the exact list. `ours`
// says whether this app's own ReShade-based stack (Feeder / Luma) is deployed here -- when it is
// not, the shared ReShade files (ini, preset, log, shader folder, a ReShade proxy in a hook slot)
// belong to the other toolchain and go too.
async function planForeignRemoval(dir, { ours = false } = {}) {
  const found = foreignToolchains(dir);
  const del = new Set();
  const restore = [];
  const notes = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { found, del: [], restore, notes }; }
  const exists = (rel) => fs.existsSync(path.join(dir, ...rel.split('/')));

  for (const f of found) {
    const spec = FOREIGN_REMOVALS[f.tool];
    if (!spec) continue;
    for (const rel of spec.files || []) if (exists(rel)) del.add(rel);
    for (const p of spec.patterns || []) for (const n of names) if (p.test(n)) del.add(n);
    if (spec.backupSuffix) {
      for (const n of names) {
        if (!n.endsWith(spec.backupSuffix)) continue;
        const original = n.slice(0, -spec.backupSuffix.length);
        if (NEVER_GAME_OWNED.test(original)) { del.add(n); del.add(original); }
        else restore.push({ backup: n, to: original });
      }
    }
    if (spec.manifest) {
      // DLSS5-Swapper journals from the game root, which for an Unreal game is above the exe.
      // A live manifest.json is reversed the way its own uninstall would (added -> delete,
      // replaced -> restore from originals/<backupPrefix>/<rel>). After its uninstall has run,
      // the journal is renamed manifest.json.done-<stamp> and only the folder is left to remove.
      let base = dir;
      for (let up = 0; up <= 3 && !fs.existsSync(path.join(base, spec.manifest)); up++) base = path.dirname(base);
      const backupRoot = path.join(base, spec.manifest);
      const manifestPath = path.join(backupRoot, 'manifest.json');
      if (fs.existsSync(backupRoot)) del.add(path.relative(dir, backupRoot));
      if (fs.existsSync(manifestPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const prefix = m.backupPrefix ? path.join(backupRoot, m.backupPrefix) : backupRoot;
          for (const rel of [...(m.added || []), ...(m.addedDirs || [])].filter((x) => typeof x === 'string')) {
            const abs = path.join(base, rel);
            if (fs.existsSync(abs)) del.add(path.relative(dir, abs));
          }
          for (const r of m.replaced || []) {
            const rel = typeof r === 'string' ? r : r && r.rel;
            if (!rel) continue;
            const backup = path.join(prefix, rel);
            if (fs.existsSync(backup)) restore.push({ backup: path.relative(dir, backup), to: path.relative(dir, path.join(base, rel)) });
          }
        } catch { notes.push(spec.manifest + '/manifest.json could not be read -- its journal was not reversed'); }
      }
    }
  }

  if (found.length && !ours) {
    for (const n of ['ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', 'reshade-shaders', 'ReShade64.dll']) if (exists(n)) del.add(n);
    const hooks = await inspectHookDlls(dir);
    if (hooks.reshadeProxy) del.add(hooks.reshadeProxy);
  }
  const oursInstalled = exists('.optiscaler-manager-install.json') || (exists('OptiScaler.ini') && exists('nvngx_dlssnr.dll'));
  if (oursInstalled) for (const n of OUR_PAYLOAD) del.delete(n);
  // And anything this app's own install journal claims. A name can belong to both projects --
  // INSTALL-DLSSNR.md does -- so when a real rival install IS present, the copy we put here is
  // still ours and stays.
  const placedByUs = filesWePlaced(dir);
  for (const n of [...del]) if (placedByUs.has(n.toLowerCase())) del.delete(n);
  // The Feeder stack, when this app's own deploy marker says the Feeder here is ours.
  //
  // Several of these names appear in another tool's removal list because that tool ships them too
  // -- DLSS5oneclick places a dlss5-feed.addon64 of its own. Deleting ours on the strength of that
  // takes out a working route, and the file it takes is the one the whole route depends on. Anything
  // this app journaled as its own is already protected above; this covers the deploy that keeps its
  // record in a different file.
  if (exists('.dlss5ui-feeder-deploy.json')) {
    for (const n of ['dlss5-feed.addon64', 'dlss5-feed.addon32', 'dlss5-feed.cfg', 'dlss5-feed.log',
      'ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', 'reshade-shaders']) del.delete(n);
  }
  if (exists('.dlss5ui-lumaue-deploy.json')) {
    for (const n of ['ReShade64.dll', 'ReShade.ini', 'ReShadePreset.ini', 'ReShade.log', 'reshade-shaders']) del.delete(n);
  }
  for (const r of restore) del.delete(r.backup);
  return { found, del: [...del].sort(), restore, notes };
}

module.exports = { DETECT_VERSION, exeStamp, openPeResources, RT_ICON, RT_GROUP_ICON, RT_VERSION, detectGame, detectGameCached, invalidateDetection, peOriginalFilename, peVersionString, detectRenderApi, isDetectionStale, isReEngineGame, isUnityGame, agilityRedistRisk, antiCheatStub, peImports, peBitness, readFileVersion, scanFile, optiScalerRuntimeApi, resolveUnrealShippingExe, inspectHookDlls, antiCheatPresent, oldShaderCompiler, apiFromFileName, pickModern, foreignToolchains, planForeignRemoval };
