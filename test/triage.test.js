'use strict';
// tools/triage/triage.js: the labels .github/workflows/triage.yml puts on a new report, and when a
// needs-info issue is closed as stale. The report bodies are the two real formats: the app's hidden
// JSON line (src/reportinfo.js, built here by the real function) and a v1.80.x Game Help issue (#81).

const test = require('node:test');
const assert = require('node:assert/strict');
const triage = require('../tools/triage/triage');
const reportinfo = require('../src/reportinfo');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const LEGACY_81 = `**Game:** The Sims™ 4
**Exe:** TS4_x64.exe
**Engine / API:** DX11 / dx11
**Route:** OptiScaler
**Game Help finding:** no-hook (unknown)
**Last run verdict:** no-dlss
**GPU:** NVIDIA GeForce RTX 5090 Laptop GPU (pilote 32.0.16.1692)
**App:** v1.80.2`;

test('a current app report is read from its hidden JSON line', () => {
  const block = reportinfo.metaBlock({ game: 'RESIDENT EVIL 2', route: 'reengine', finding: 'nr-not-active', aftermath: [] });
  const r = triage.parseReport(`${block}\n\nmore text`, '[Game failure] [reengine] RESIDENT EVIL 2: nr-not-active');
  assert.equal(r.source, 'json');
  assert.equal(r.route, 'reengine');
  assert.equal(r.finding, 'nr-not-active');
  assert.equal(r.crash, false);
  assert.deepEqual(triage.labelsFor(r), ['game-help', 'route:reengine']);
});

test('a crash finding, or an attached Aftermath dump, adds the crash label', () => {
  const ue = triage.parseReport(`<!-- dlss5ui-report ${JSON.stringify({ route: 'optiscaler', finding: 'ue-crash' })} -->`);
  assert.deepEqual(triage.labelsFor(ue), ['game-help', 'route:optiscaler', 'crash']);
  const dump = triage.parseReport(`<!-- dlss5ui-report ${JSON.stringify({ route: 'feeder', finding: 'no-dlss', aftermath: ['a.nv-gpudmp'] })} -->`);
  assert.ok(triage.labelsFor(dump).includes('crash'));
});

test('an older Game Help issue is read from its markdown fields', () => {
  const r = triage.parseReport(LEGACY_81, '[Game Help] The Sims™ 4: no-hook');
  assert.equal(r.source, 'legacy');
  assert.equal(r.route, 'optiscaler');
  assert.equal(r.finding, 'no-hook');
  assert.equal(r.verdict, 'no-dlss');
  assert.deepEqual(triage.labelsFor(r), ['game-help', 'route:optiscaler']);
  // A multi-word route label becomes one slug.
  const feeder = triage.parseReport(LEGACY_81.replace('**Route:** OptiScaler', '**Route:** OptiScaler + Feeder (32-bit)'));
  assert.equal(feeder.route, 'optiscaler-feeder-32-bit');
});

test('an ordinary issue or feature request gets no labels', () => {
  assert.equal(triage.parseReport('Please add Italian', '[FR] Multilingual support'), null);
  assert.deepEqual(triage.labelsFor(null), []);
  // A broken JSON line falls back to the markdown fields, not a crash.
  assert.equal(triage.parseReport('<!-- dlss5ui-report {not json} -->', 'Something'), null);
});

test('needs-info closes only after 14 days of our question going unanswered', () => {
  const issue = { labels: [{ name: 'needs-info' }], user: 'reporter', createdAt: ago(30) };
  const asked = (days) => [{ user: 'reporter', authorAssociation: 'NONE', createdAt: ago(30) }, { user: 'owner', authorAssociation: 'OWNER', createdAt: ago(days) }];

  assert.equal(triage.staleDecision(issue, asked(15), { now: NOW }).close, true);
  assert.equal(triage.staleDecision(issue, asked(13), { now: NOW }).close, false, 'too soon');

  const replied = [...asked(20), { user: 'reporter', authorAssociation: 'NONE', createdAt: ago(16) }];
  assert.equal(triage.staleDecision(issue, replied, { now: NOW }).close, false, 'the reporter answered: our turn');

  assert.equal(triage.staleDecision(issue, [], { now: NOW }).close, false, 'nobody asked anything');
  assert.equal(triage.staleDecision({ ...issue, labels: ['bug'] }, asked(40), { now: NOW }).close, false, 'no needs-info');
});

test('fixed-in-next-release is never closed as stale, and waiting-for-reporter follows the 14-day rule', () => {
  const asked = [{ user: 'owner', authorAssociation: 'OWNER', createdAt: ago(60) }];
  const fixed = { labels: ['needs-info', 'fixed-in-next-release'], user: 'reporter' };
  assert.equal(triage.staleDecision(fixed, asked, { now: NOW }).close, false);

  const waiting = { labels: ['needs-info', 'waiting-for-reporter'], user: 'reporter' };
  assert.equal(triage.staleDecision(waiting, [{ user: 'owner', authorAssociation: 'OWNER', createdAt: ago(10) }], { now: NOW }).close, false);
  assert.equal(triage.staleDecision(waiting, asked, { now: NOW }).close, true);
});

test('the reporter being a collaborator does not make their own comment "ours"', () => {
  const issue = { labels: ['needs-info'], user: 'owner' };
  const own = [{ user: 'owner', authorAssociation: 'OWNER', createdAt: ago(30) }];
  assert.equal(triage.staleDecision(issue, own, { now: NOW }).close, false);
});

test('the triage workflow is wired to this module and closes with the friendly comment', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'triage.yml'), 'utf8');
  assert.match(yml, /tools\/triage\/triage\.js/);
  assert.match(yml, /labels: 'needs-info'/);
  assert.match(yml, /STALE_COMMENT/);
  assert.match(yml, /issues: write/);
  assert.match(triage.STALE_COMMENT, /reopen/);
});
