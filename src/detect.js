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

const DETECT_VERSION = 5;

const MODERN_APIS = ['dx12', 'dx11', 'vulkan'];
const API_DLL = { dx12: 'd3d12.dll', dx11: 'd3d11.dll', vulkan: 'vulkan-1.dll' };
const OLD_API_DLLS = [
  ['dx9', ['d3d9.dll', 'd3d8.dll']],
  ['dx10', ['d3d10.dll', 'd3d10core.dll']],
  ['opengl', ['opengl32.dll']],
];
const API_LABEL = { dx12: 'DX12', dx11: 'DX11', vulkan: 'Vulkan', dx9: 'DX9', dx10: 'DX10', opengl: 'OpenGL' };

// Files this app, OptiScaler, ReShade, REFramework or the DLSS swaps place beside the exe. Every
// one of them mentions whichever APIs *it* supports, which says nothing about the game.
const MOD_PAYLOAD_DLL = /^(optiscaler.*|amd_fidelityfx_.*|amd_ags_x64|libxe(ss|ll).*|_?nvngx.*|sl\..*|dlssg_to_fsr3.*|fakenvapi.*|reshade.*|d3d12core|dstorage.*|nvapi64|dxgi|d3d11|d3d12|winmm|version|dbghelp|wininet|winhttp|dinput8|xinput1_[34]|ffx_.*)\.dll$/i;

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

// VS_FIXEDFILEINFO out of the RT_VERSION resource, "6.3.9600.16384" style -- ported from
// DLSS5-Swapper's pe.js. Synchronous and bounded (a few small reads); used for one file.
function readFileVersion(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const readAt = (offset, length) => {
      const b = Buffer.alloc(length);
      const n = fs.readSync(fd, b, 0, length, offset);
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
    const type = entriesOf(0).find((e) => (e.id & 0x7fffffff) === 16 && (e.offset & 0x80000000));
    if (!type) return null;
    const name = entriesOf(type.offset & 0x7fffffff)[0];
    if (!name || !(name.offset & 0x80000000)) return null;
    const lang = entriesOf(name.offset & 0x7fffffff)[0];
    if (!lang) return null;
    const data = readAt(base + lang.offset, 16);
    if (data.length < 16) return null;
    const dataOff = rvaToOffset(data.readUInt32LE(0));
    const dataSize = data.readUInt32LE(4);
    if (dataOff < 0 || !dataSize) return null;
    const blob = readAt(dataOff, Math.min(dataSize, 64 * 1024));
    const sig = blob.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
    if (sig < 0 || sig + 16 > blob.length) return null;
    const ms = blob.readUInt32LE(sig + 8);
    const ls = blob.readUInt32LE(sig + 12);
    const fixed = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
    return fixed === '0.0.0.0' ? null : fixed;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// ---------------------------------------------------------------------------------------------
// Generic API evidence

// Entry points a game asks for by name when it resolves Direct3D at runtime: a protected build
// (GTA V Enhanced) has no import and may keep the DLL name out of reach, but the function name
// it passes to GetProcAddress is still a plain string. D3D12SDKPath/D3D12SDKVersion are the
// Agility SDK exports -- a game that exports them renders with DX12, no ambiguity.
const ENTRY_POINTS = [
  ['dx12', 'D3D12CreateDevice'], ['dx11', 'D3D11CreateDevice'], ['vulkan', 'vkCreateInstance'],
  ['dx10', 'D3D10CreateDevice'], ['dx9', 'Direct3DCreate9'], ['opengl', 'wglCreateContext'],
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
const HOOK_DLLS = ['dxgi.dll', 'd3d12.dll', 'd3d11.dll', 'd3d9.dll', 'opengl32.dll', 'dinput8.dll'];
const HOOK_NEEDLES = ['DXVK', 'vkd3d', 'vkGetInstanceProcAddr', 'ReShade', 'OptiScaler'].map((t) => makeNeedle(t, t, { exactCase: true }));

async function inspectHookDlls(dir) {
  const out = { vulkanWrapper: null, reshadeProxy: null };
  for (const name of HOOK_DLLS) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const hits = await scanFile(file, HOOK_NEEDLES, { maxBytes: SIBLING_SCAN_MAX_BYTES });
    if (hits.has('OptiScaler')) continue;
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
const ANTI_CHEAT = /easyanticheat|battleye|eaanticheat|(?:^|[-_])(?:eac|be)launcher|start_protected_game|beservice|beclient|vanguard|xigncode|gameguard|nprotect|ace-base|anticheat/i;
// Where the climb stops: a folder that holds games rather than being one. A loose installer
// parked in D:\Games is not evidence about any game under it.
const LIBRARY_ROOT = /^(games?|my ?games|steamlibrary|steamapps|common|gog ?games|epic ?games|xbox ?games|origin ?games|ea ?games|repacks?|emulation|downloads|program files(?: \(x86\))?|[a-z]:\\?)$/i;

function antiCheatPresent(dir) {
  let current = dir;
  for (let up = 0; up <= 3; up++) {
    if (LIBRARY_ROOT.test(path.basename(current) || current)) break;
    let entries = [];
    try { entries = fs.readdirSync(current); } catch { entries = []; }
    const hit = entries.find((name) => ANTI_CHEAT.test(name));
    if (hit) return hit;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
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

function optiScalerLogStat(dir) {
  try { return fs.statSync(path.join(dir, 'OptiScaler.log')); } catch { return null; }
}

async function optiScalerRuntimeApi(dir) {
  let fh;
  try { fh = await fsp.open(path.join(dir, 'OptiScaler.log'), 'r'); } catch { return null; }
  let text;
  try {
    const buf = Buffer.alloc(RUNTIME_LOG_MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, RUNTIME_LOG_MAX_BYTES, 0);
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

// ---------------------------------------------------------------------------------------------
// Public

async function detectGame(dir, exePath) {
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
  if (!found) found = await genericApiDetection(dir, exePath, exe || (await scanExecutable(exePath)));
  if (engine.id === 'unreal') found = unrealStaticApi(dir, found, engine);

  const [bitness, hooks] = await Promise.all([peBitness(exePath), inspectHookDlls(dir)]);
  if (hooks.vulkanWrapper && found.api && found.api !== 'vulkan') {
    found = {
      ...found, api: 'vulkan', apis: [...new Set(['vulkan', ...(found.apis || [])])], uncertain: false,
      reason: `Vulkan -- ${hooks.vulkanWrapper.file} beside the executable is ${hooks.vulkanWrapper.kind}, which presents the game's Direct3D through Vulkan`,
    };
  }

  const runtime = await optiScalerRuntimeApi(dir);
  if (runtime) {
    found = {
      ...found,
      api: runtime.api,
      apis: [...new Set([runtime.api, ...(found.apis || [])])],
      reason: `${API_LABEL[runtime.api]} -- what OptiScaler saw this game create on its last run (${runtime.evidence})`,
      uncertain: false,
      runtimeApi: runtime.api,
    };
  }
  const logStat = optiScalerLogStat(dir);

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
  if (bitness === 32) {
    recommend = 'unsupported';
    reason = `32-bit executable -- OptiScaler and the DLSS5 Feeder add-on this app deploys are 64-bit only (${reason})`;
  } else if (found.api) {
    recommend = 'optiscaler';
    reason = `${reason} -- OptiScaler hooks this directly`;
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
    vulkanWrapper: hooks.vulkanWrapper,
    reshadeProxy: hooks.reshadeProxy,
    antiCheat: antiCheatPresent(dir),
    oldShaderCompiler: oldShaderCompiler(dir),
    runtimeApi: found.runtimeApi || null,
    // What OptiScaler.log looked like when this was decided -- a later run of the game is new
    // evidence, and isDetectionStale re-runs detection when the log has changed since.
    runtimeLogMtime: logStat ? logStat.mtimeMs : null,
    detectVersion: DETECT_VERSION,
  };
}

async function detectRenderApi(dir, exePath) {
  return (await detectGame(dir, exePath)).api;
}

function isDetectionStale(stored, dir) {
  if (!stored || stored.detectVersion !== DETECT_VERSION) return true;
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

module.exports = { DETECT_VERSION, detectGame, detectRenderApi, isDetectionStale, isReEngineGame, peImports, peBitness, readFileVersion, scanFile, optiScalerRuntimeApi, resolveUnrealShippingExe, inspectHookDlls, antiCheatPresent, oldShaderCompiler, apiFromFileName };
