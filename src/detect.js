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

const DETECT_VERSION = 2;

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
    if (!importRva) return [];

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

    const descOffset = rvaToOffset(importRva);
    if (descOffset < 0) return [];
    const descriptors = await readAt(descOffset, Math.min(importSize || 20 * 512, 20 * 512));
    const names = [];
    for (let i = 0; i + 20 <= descriptors.length; i += 20) {
      const nameRva = descriptors.readUInt32LE(i + 12);
      const firstThunk = descriptors.readUInt32LE(i + 16);
      if (!nameRva && !firstThunk) break;
      const nameOffset = rvaToOffset(nameRva);
      if (nameOffset < 0) continue;
      const raw = await readAt(nameOffset, 64);
      const end = raw.indexOf(0);
      names.push(raw.subarray(0, end < 0 ? raw.length : end).toString('latin1').toLowerCase());
    }
    return names;
  } catch {
    return [];
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Generic API evidence

const API_NEEDLES = [
  ...MODERN_APIS.map((api) => makeNeedle(api, API_DLL[api])),
  ...OLD_API_DLLS.flatMap(([api, dlls]) => dlls.map((dll, i) => makeNeedle(`${api}#${i}`, dll))),
];
const OPTISCALER_NEEDLE = makeNeedle('__optiscaler', 'OptiScaler');

function apisFromEvidence(imports, hits) {
  const modern = new Set();
  const old = new Set();
  for (const api of MODERN_APIS) {
    if (imports.includes(API_DLL[api]) || hits.has(api)) modern.add(api);
  }
  for (const [api, dlls] of OLD_API_DLLS) {
    if (dlls.some((dll, i) => imports.includes(dll) || hits.has(`${api}#${i}`))) old.add(api);
  }
  return { modern, old };
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

  // The game's own Agility SDK redistributable only ever ships with a DX12 renderer.
  if (fs.existsSync(path.join(dir, 'D3D12', 'D3D12Core.dll'))) {
    modern.add('dx12');
    sources.push('D3D12\\D3D12Core.dll');
  }
  if (entries.some((f) => /^vulkan-1\.dll$/i.test(f))) {
    modern.add('vulkan');
    sources.push('vulkan-1.dll');
  }
  return { modern, old, imports, sources };
}

async function genericApiDetection(dir, exePath, exe) {
  if (exe.modern.size > 0) {
    const api = pickModern(exe.modern, exe.imports);
    const linked = exe.imports.includes(API_DLL[api]);
    return {
      api, apis: [...exe.modern], old: [...exe.old],
      reason: `${API_LABEL[api]} -- ${linked ? 'linked by' : 'referenced in'} the executable`,
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
    return { engine: version ? `Unreal Engine ${version}` : 'Unreal Engine', id: 'unreal' };
  }
  if (fs.existsSync(path.join(dir, 'CrySystem.dll')) || hits.has('cryengine')) return { engine: 'CryEngine', id: 'cryengine' };
  if (hits.has('godot')) return { engine: 'Godot', id: 'godot' };
  if (hits.has('anvil')) return { engine: 'AnvilNext', id: 'anvil' };
  return { engine: null, id: null };
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
  if (!found) found = await genericApiDetection(dir, exePath, exe || (await scanExecutable(exePath)));

  const oldOnly = !found.api && found.old && found.old.length > 0;
  const apiLabel = found.api ? API_LABEL[found.api] : oldOnly ? API_LABEL[found.old[0]] : null;

  let recommend = 'unknown';
  let reason = found.reason;
  if (found.api) {
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
    apiBadge: apiLabel,
    badge: engine.engine || apiLabel || 'Unknown',
    recommend,
    reason,
    uncertain: !!found.uncertain,
    detectVersion: DETECT_VERSION,
  };
}

async function detectRenderApi(dir, exePath) {
  return (await detectGame(dir, exePath)).api;
}

function isDetectionStale(stored) {
  return !stored || stored.detectVersion !== DETECT_VERSION || !!stored.uncertain;
}

module.exports = { DETECT_VERSION, detectGame, detectRenderApi, isDetectionStale, isReEngineGame, peImports, scanFile };
