'use strict';
// Reads a "Run digest" back into facts: the folded block runlog.reportDigest writes into every issue
// body since v1.80.0, plus the `**Key:** value` header lines the renderer puts above it
// (renderer.js buildGameReport). The daily triage routine reads the same block by eye; this is the
// script's half, used by tools/catalog/build.js (digests -> catalog entries) and by the frame-gen
// suggestion's tests (fgsuggest.js), which run on digests rather than on live logs.
//
// Deliberately tolerant: a body from before a key existed simply lacks it, and every field is null
// then -- never guessed. Only what the digest states is returned.

const DIGEST_MARKER = '<details><summary>Run digest';

function parseDigest(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const header = {};
  for (const m of src.matchAll(/^\*\*([^*:]+):\*\*\s*(.*)$/gm)) header[m[1].trim().toLowerCase()] = m[2].trim();

  // The fenced block after the marker; a bare fenced block of key: value lines is accepted too, so a
  // digest pasted on its own (without the <details> wrapper) still reads.
  let block = null;
  const at = src.indexOf(DIGEST_MARKER);
  const from = at >= 0 ? at : 0;
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(src.slice(from));
  if (fence) block = fence[1];
  const fields = {};
  for (const line of String(block || '').split('\n')) {
    const m = /^([a-z0-9][a-z0-9 ._-]*?):\s(.*)$/i.exec(line.trim());
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    (fields[key] = fields[key] || []).push(m[2].trim());
  }
  const one = (k) => (fields[k] ? fields[k][0] : null);
  const num = (s) => { const m = /(-?\d+(?:\.\d+)?)/.exec(String(s == null ? '' : s)); return m ? Number(m[1]) : null; };

  const verdictLine = one('verdict') || header['last run verdict'] || null;
  const vm = verdictLine ? /^([a-z0-9-]+)(?:\s*\((.*)\))?/i.exec(verdictLine) : null;
  const verdict = vm ? vm[1] : null;

  // "optiscaler: winmm.dll (this app's own install)" -- the proxy name, when the line names a file.
  const proxy = (fields.optiscaler || []).map((v) => (/^([A-Za-z0-9_.-]+\.(?:dll|asi))\b/i.exec(v) || [])[1]).find(Boolean) || null;
  const dg = one('dgvoodoo2');
  const wrapperLine = one('wrapper');
  const wrapper = dg && /is in the folder|deployed in this folder/i.test(dg) ? 'dgvoodoo'
    : wrapperLine && /dxvk/i.test(wrapperLine) ? 'dxvk' : null;
  // "neural cost: 16.38 ms per frame (16.11 ms model), 48 fps at the last heartbeat"
  const cost = one('neural cost');
  const costMs = cost ? num(cost) : null;
  const modelMs = cost ? num((/\(([\d.]+) ms model\)/.exec(cost) || [])[1]) : null;
  const heartbeatFps = cost ? num((/,\s*([\d.]+) fps/.exec(cost) || [])[1]) : null;
  const apiLine = one('api');
  const runtimeLine = one('runtime api');
  const firstWord = (s) => { const m = s ? /^([a-z0-9]+)/i.exec(s) : null; return m ? m[1].toLowerCase() : null; };

  return {
    game: header.game || null,
    exe: header.exe ? header.exe.toLowerCase() : null,
    app: header.app || null,
    gpu: header.gpu || null,
    hasDigest: !!block,
    fields,
    verdict,
    verdictDetail: vm && vm[2] ? vm[2] : null,
    route: one('route'),
    api: apiLine === 'not detected' ? null : firstWord(apiLine),
    apiByHand: !!(apiLine && /SET BY HAND/.test(apiLine)),
    runtimeApi: firstWord(runtimeLine),
    bitness: num(one('bitness')),
    neuralPasses: num(one('neural passes')),
    fps: num(one('fps')),
    neuralMs: costMs,
    modelMs,
    heartbeatFps,
    fpsTarget: num(one('fps target')),
    proxy,
    wrapper,
    mvProvider: one('mv provider') ? one('mv provider').split(' -- ')[0] : null,
    smoothMotion: !!one('smooth motion'),
    at: one('at'),
  };
}

module.exports = { parseDigest, DIGEST_MARKER };
