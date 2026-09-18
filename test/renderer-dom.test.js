'use strict';
// The renderer is a plain script with no bundler and no framework, so nothing checks that an id it
// reaches for actually exists in the markup. When one does not, `$('#missing').addEventListener`
// throws at module scope, the rest of renderer.js never runs, and the whole window is dead -- not
// the one feature that was edited. There is no build step to catch it and no test did either.
//
// Written while adding the neural-consumer dropdown, which is exactly the shape of change that
// causes it: a new select in index.html, a new handler bound at load in renderer.js, and a typo
// between them is invisible until someone opens the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REPO } = require('./helpers');

const renderer = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'index.html'), 'utf8');

function idsInMarkup(text) {
  return new Set([...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

test('every element the renderer binds a listener to at load exists in index.html', () => {
  // Only the direct `$('#id').addEventListener(` form. That is the one that runs while the script
  // is loading, so a miss takes the entire UI down rather than failing later inside a function.
  const bound = [...renderer.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)\.addEventListener/g)].map((m) => m[1]);
  assert.ok(bound.length > 50, `expected the renderer to bind many elements, found ${bound.length}`);

  const ids = idsInMarkup(html);
  const missing = [...new Set(bound)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `renderer.js binds ids that index.html does not define: ${missing.join(', ')}`);
});

test('the markup defines no duplicate ids', () => {
  // Two elements with one id means $() silently returns the first, and the second is unreachable
  // for the lifetime of the app.
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = [...new Set(all.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
  assert.deepEqual(dupes, [], `duplicate ids in index.html: ${dupes.join(', ')}`);
});

test('the neural-consumer dropdown is wired end to end', () => {
  // The three halves of one feature, each useless without the others: markup, the handler that
  // reads it, and the preload bridge it calls through.
  const ids = idsInMarkup(html);
  for (const id of ['game-neural-section', 'game-neural-select', 'game-neural-status']) {
    assert.ok(ids.has(id), `index.html is missing ${id}`);
  }
  assert.match(renderer, /\$\('#game-neural-select'\)\.addEventListener/, 'the select has a change handler');
  assert.match(renderer, /window\.api\.setNeuralConsumer\(/, 'and it calls through the bridge');
  assert.match(renderer, /await loadNeuralSection\(game\);/, 'and the section is loaded when the panel opens');

  const preload = fs.readFileSync(path.join(REPO, 'src', 'preload.js'), 'utf8');
  assert.match(preload, /setNeuralConsumer:/, 'preload exposes it');
  assert.match(preload, /'game:setNeuralConsumer'/, 'on the channel main.js handles');

  const main = fs.readFileSync(path.join(REPO, 'src', 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('game:setNeuralConsumer'/, 'and main.js handles it');
});
