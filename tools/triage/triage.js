// Issue triage for .github/workflows/triage.yml: what labels a new report gets, and whether a
// `needs-info` issue has gone quiet long enough to close. Pure functions, no GitHub calls, so the
// workflow stays a thin wrapper and this file is unit-tested (test/triage.test.js).
//
// Two report formats exist:
//   - the app's current reports (src/reportinfo.js): a hidden `<!-- dlss5ui-report {...} -->` JSON line;
//   - older Game Help issues (v1.80.x and before): markdown fields "**Route:** ..." and
//     "**Game Help finding:** code (...)", with a "[Game Help] <game>: <code>" title.
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 14;
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
// Labels that mean "the ball is in our court" or "done, waiting for a release": never auto-closed.
const NEVER_CLOSE = new Set(['fixed-in-next-release']);

function slug(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, ' ').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function parseHidden(body) {
  const m = /<!-- dlss5ui-report (\{.*\}) -->/.exec(String(body || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function field(body, name) {
  const re = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'mi');
  const m = re.exec(String(body || ''));
  return m ? m[1].trim() : null;
}

// { source, game, route, finding, verdict, crash } or null when the issue is not an app report.
function parseReport(body, title = '') {
  const hidden = parseHidden(body);
  if (hidden) {
    const finding = hidden.finding ? String(hidden.finding) : null;
    return {
      source: 'json',
      game: hidden.game || null,
      route: hidden.route ? slug(hidden.route) : null,
      finding: finding ? slug(finding.split(/[\s(]/)[0]) : null,
      verdict: null,
      crash: isCrash(finding) || (Array.isArray(hidden.aftermath) && hidden.aftermath.length > 0),
    };
  }
  const route = field(body, 'Route');
  const findingRaw = field(body, 'Game Help finding');
  const verdict = field(body, 'Last run verdict');
  const titled = /^\[(?:Game Help|Game failure)\]/i.test(String(title || ''));
  if (!route && !findingRaw && !titled) return null;
  const titleCode = /:\s*([\w-]+)\s*$/.exec(String(title || ''));
  const finding = findingRaw ? slug(findingRaw.split(/[\s(]/)[0]) : (titleCode ? slug(titleCode[1]) : null);
  return {
    source: 'legacy',
    game: field(body, 'Game'),
    route: route ? slug(route) : null,
    finding,
    verdict: verdict ? slug(verdict) : null,
    crash: isCrash(finding) || isCrash(verdict),
  };
}

function isCrash(text) {
  return /crash|tdr|device-?removed|gpu-?fault/i.test(String(text || ''));
}

// Labels for a parsed report. Route labels are created on the fly by the workflow.
function labelsFor(report) {
  if (!report) return [];
  const labels = ['game-help'];
  if (report.route) labels.push(`route:${report.route}`);
  if (report.crash) labels.push('crash');
  return labels;
}

// Should a `needs-info` issue be closed as stale?
//   issue: { labels: [names], user: login, createdAt }
//   comments: [{ user: login, authorAssociation, createdAt }], oldest first
// Closed only when: it has needs-info; nothing in NEVER_CLOSE; the last word is ours (a maintainer
// asked and the reporter has not answered); and that last maintainer comment is 14+ days old.
function staleDecision(issue, comments = [], { now = Date.now(), days = STALE_DAYS } = {}) {
  const labels = new Set((issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
  if (!labels.has('needs-info')) return { close: false, reason: 'not needs-info' };
  for (const l of NEVER_CLOSE) if (labels.has(l)) return { close: false, reason: `labelled ${l}` };
  const last = comments.length ? comments[comments.length - 1] : null;
  if (!last) return { close: false, reason: 'nobody has asked anything yet' };
  const fromMaintainer = MAINTAINER_ASSOCIATIONS.has(String(last.authorAssociation || '').toUpperCase()) && last.user !== issue.user;
  if (!fromMaintainer) return { close: false, reason: 'the reporter (or someone else) spoke last' };
  const age = now - new Date(last.createdAt).getTime();
  if (!(age >= days * DAY_MS)) return { close: false, reason: `asked ${Math.floor(age / DAY_MS)} day(s) ago` };
  return { close: true, reason: `no reply for ${Math.floor(age / DAY_MS)} days` };
}

const STALE_COMMENT =
  'Closing this for now since there has been no reply for two weeks. That is not a verdict on the ' +
  'report: if you try again, reopen this issue or file a new report from the app (Game Help → Send ' +
  'game failure) and it will pick up the run details. Thanks for reporting!';

module.exports = { STALE_DAYS, STALE_COMMENT, slug, parseReport, labelsFor, staleDecision, isCrash };
