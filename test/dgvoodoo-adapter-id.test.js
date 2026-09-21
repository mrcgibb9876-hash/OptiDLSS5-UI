'use strict';
// dgVoodoo2 names the real GPU vendor to the game ([DirectXExt] AdapterIDType), because an old game
// that recognises nobody takes its worst render path.
//
// Fallout New Vegas, 2026-09-21. Crashed every time the world loaded, at FalloutNV+0x757aa9 reading
// address 0: BSShaderManager::GetShader(29) returned NULL and the game dereferenced it without a
// check. GetShader builds a shader only behind a global byte that was 0, because the game had picked
// its Shader Model 2.0 path. Its own RendererInfo.txt named the culprit and the symptom together:
//
//     NVIDIA GeForce RTX 5070 Ti Laptop (dgVoodoo DX API Layer)
//     RenderPath   : BSSM_SV_2_0        3.0 Support    : yes
//     3.0 Lighting : no                 Shader Package : 2
//
// "3.0 Support: yes" directly above "3.0 Lighting: no": the caps were never the problem, the identity
// was. bAllow30Shaders=1 in both of the game's inis changed nothing. AdapterIDType = nvidia fixed it.
//
// Two rules follow. Only a vendor dgVoodoo's parser accepts is ever written -- a rejected value makes
// it abandon the rest of the file, which is the lesson dgvoodoo-colorspace.test.js exists for. And
// the vendor written is the one actually in the machine, never a fixed string: reporting NVIDIA on an
// AMD box buys the same recognition and then sends a game down a path its GPU cannot answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratchDir, write } = require('./helpers');
const legacy = require('../src/legacy');

const MARKER = JSON.stringify({
  version: 1, files: ['D3D9.dll', 'dgVoodoo.conf'], backups: [],
  dgVoodoo: { arch: 'x86', dll: 'D3D9.dll' },
});
const BASE = '[General]\n\n[GeneralExt]\n\n[DirectX]\n\n[DirectXExt]\nAdapterIDType                       = \n';

test('the machine\'s own vendor is what the game is told', () => {
  for (const vendor of ['nvidia', 'amd', 'intel']) {
    const conf = legacy.configureDgVoodoo(BASE, { vendor });
    assert.match(conf, new RegExp(`AdapterIDType\\s*=\\s*${vendor}\\b`), `${vendor} not written`);
  }
});

test('an unknown vendor writes no key at all -- where dgVoodoo already was', () => {
  for (const vendor of [null, undefined, '', 'unknown', 'Nvidia Corporation']) {
    const conf = legacy.configureDgVoodoo(BASE, { vendor });
    assert.match(conf, /AdapterIDType\s*=\s*\r?\n/, `left a value for ${JSON.stringify(vendor)}`);
  }
});

// AdapterIDType is only read for the SVGA and Internal3D card types, and VideoCard=internal3D is
// written in the same branch. If one ever moves without the other the key goes silently dead.
test('the key is only written where VideoCard=internal3D is', () => {
  const conf = legacy.configureDgVoodoo(BASE, { vendor: 'nvidia' });
  assert.match(conf, /VideoCard\s*=\s*internal3D/);
  const minimal = legacy.configureDgVoodoo(BASE, { vendor: 'nvidia', minimal: true });
  assert.doesNotMatch(minimal, /AdapterIDType\s*=\s*nvidia/, 'a minimal game gets no VideoCard either');
});

test('a game installed before this shipped is brought up on sync', () => {
  const game = scratchDir('legacy-adapter-id-sync');
  write(game, legacy.MARKER, MARKER);
  write(game, 'dgVoodoo.conf',
        '[General]\nOutputAPI = d3d11_fl11_0\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = appdriven\n'
        + 'WindowedAttributes = borderless, fullscreensize\n\n[DirectX]\nVRAM = 4096\n\n[DirectXExt]\nAdapterIDType = \n');
  assert.equal(legacy.ensureDgVoodooWindowed(game, { vendor: 'nvidia' }), true);
  const conf = fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8');
  assert.match(conf, /AdapterIDType\s*=\s*nvidia/);
  assert.equal(legacy.ensureDgVoodooWindowed(game, { vendor: 'nvidia' }), false, 'already set: no rewrite');
});

// A sync that could not read the vendor must not undo one already on disk, and must not rewrite the
// file for nothing -- ensureDgVoodooWindowed runs for every dgVoodoo2 game on every sync.
test('a sync with no vendor leaves a value already there alone', () => {
  const game = scratchDir('legacy-adapter-id-keep');
  write(game, legacy.MARKER, MARKER);
  write(game, 'dgVoodoo.conf',
        '[General]\nOutputAPI = d3d11_fl11_0\nScalingMode = stretched_ar\n\n[GeneralExt]\nColorSpace = appdriven\n'
        + 'WindowedAttributes = borderless, fullscreensize\n\n[DirectX]\nVRAM = 4096\n\n[DirectXExt]\nAdapterIDType = amd\n');
  legacy.ensureDgVoodooWindowed(game, { vendor: 'amd' });
  assert.equal(legacy.ensureDgVoodooWindowed(game, {}), false, 'nothing to do, so nothing written');
  assert.match(fs.readFileSync(path.join(game, 'dgVoodoo.conf'), 'utf8'), /AdapterIDType\s*=\s*amd/);
});
