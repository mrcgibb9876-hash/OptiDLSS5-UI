// "Send game failure": Game Help's one button that files the report on GitHub itself -- the issue, with
// the logs attached as a gist -- instead of asking a player to save a zip, open the issue page and attach
// it by hand (the user's call, 2026-09-15).
//
// How a desktop app may post to GitHub without holding a secret: GitHub's device flow. The first press
// shows a short code and opens github.com/login/device; the player signs in there and approves this app.
// GitHub then hands the app a user token, stored encrypted with Electron's safeStorage (DPAPI on
// Windows). Nothing secret ships inside the app: a device flow needs only the app's public client ID.
//
// The app registered for this is a GitHub App, not a classic OAuth App, so the token can do no more than
// it needs: Issues read/write on this project's repository (where the app is installed) and the player's
// Gists (account permission) for the logs. A classic OAuth token would have needed public_repo -- write
// access to every public repository the player owns. Registration, once, by the maintainer:
//   github.com/settings/apps/new
//     GitHub App name: OptiDLSS5-UI Reports     Homepage URL: this repository
//     Webhook: untick "Active"                  "Enable Device Flow": tick
//     "Expire user authorization tokens": untick (refreshing needs the client secret, which an app cannot hold)
//     Repository permissions > Issues: Read and write
//     Account permissions > Gists: Read and write
//     Where can this GitHub App be installed: Only on this account
//   then Install App > only the OptiDLSS5-UI-releases repository (REPO below: the public one, where the
//   issues live -- the source repo is private), and put the Client ID (Iv23...) in CLIENT_ID below.
//   Installed on the wrong repository, the issue POST answers 403 "Resource not accessible by
//   integration"; postReport turns that into a sentence naming this step.
//
// Privacy: the issue and the gist are public on GitHub. The files are the support bundle's (logs, inis,
// the game folder's listing, the app's own view of the game); the Windows user name is replaced wherever
// it appears in a path, and the player confirms before anything is sent.
'use strict';
const { netFetch } = require('./net');
// ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
// │ TODO(maintainer): paste the GitHub App's Client ID here, e.g. 'Iv23liAbCdEf0123456789'.       │
// │ Empty = this build falls back to "save the zip + open a prefilled issue" (renderer.js).       │
// │ The Client ID is public by design (device flow); there is NO client secret to add anywhere.   │
// └──────────────────────────────────────────────────────────────────────────────────────────────┘
const CLIENT_ID = 'Iv23liqJAyFQx13XQWET';
// The public releases repo, where issues live; the source repo is private.
const REPO = 'mrcgibb9876-hash/OptiDLSS5-UI-releases';
const API = 'https://api.github.com';
const MAX_FILE_BYTES = 900 * 1024; // GitHub truncates gist files over 1 MB
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;

const configured = () => !!CLIENT_ID;

// ---- redaction ---------------------------------------------------------------------------------

// C:\Users\Yathin\Desktop\... -> C:\Users\<user>\Desktop\..., in either slash style (JSON's doubled
// backslashes too), any drive; a home folder that is not under X:\Users the same way; and the bare user
// name and the PC's name wherever else they appear as words (OptiScaler.log and app-view.json print both).
function redact(text, {
  userName = process.env.USERNAME || '',
  homeDir = process.env.USERPROFILE || '',
  computerName = process.env.COMPUTERNAME || '',
} = {}) {
  let out = String(text || '');
  out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\/:*?"<>|\r\n]+)/gi, '$1<user>');
  if (homeDir) {
    for (const v of new Set([homeDir, homeDir.replace(/\\/g, '/'), homeDir.replace(/\\/g, '\\\\')])) out = out.split(v).join('<home>');
  }
  const word = (name, as) => {
    if (!name || name.length < 3 || /^(user|admin|administrator|public|default|guest|desktop|pc)$/i.test(name)) return;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), as);
  };
  // The PC's name first: it often contains the user name ("YATHIN-LAPTOP"), which would otherwise leave
  // "<user>-LAPTOP" behind.
  word(computerName, '<pc>');
  word(userName, '<user>');
  return out;
}

// The end of a log is where a failure is; keep the tail when a file is over the gist limit.
function tail(text, maxBytes = MAX_FILE_BYTES) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `[... ${buf.length - maxBytes} bytes cut from the start ...]\n` + buf.subarray(buf.length - maxBytes).toString('utf8');
}

// Gist file names cannot start with a dot or contain slashes.
const gistName = (name) => String(name).replace(/[\\/]/g, '_').replace(/^\.+/, '');

// ---- device flow -------------------------------------------------------------------------------

async function startDeviceFlow({ fetchImpl = netFetch } = {}) {
  if (!configured()) throw new Error('Game failure reports are not set up in this build yet');
  const res = await fetchImpl('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'OptiDLSS5-UI' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const data = await res.json();
  if (!res.ok || !data.device_code) throw new Error(data.error_description || data.error || `GitHub answered ${res.status}`);
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

// Polls until the player approves (returns the token), declines, or the code expires.
async function pollForToken(deviceCode, { interval = 5, expiresIn = 900, fetchImpl = netFetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + expiresIn * 1000;
  let wait = Math.max(1, interval);
  while (now() < deadline) {
    await sleep(wait * 1000);
    const res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'OptiDLSS5-UI' },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const data = await res.json();
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { wait += 5; continue; }
    throw new Error(data.error === 'access_denied' ? 'Sign-in was declined on GitHub' : data.error === 'expired_token' ? 'The sign-in code expired' : (data.error_description || data.error || 'GitHub sign-in failed'));
  }
  throw new Error('The sign-in code expired');
}

// ---- sending -----------------------------------------------------------------------------------

async function gh(token, method, url, body, fetchImpl) {
  const res = await fetchImpl(API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'OptiDLSS5-UI', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { const e = new Error('GitHub sign-in is no longer valid'); e.signedOut = true; throw e; }
  if (!res.ok) {
    const e = new Error(`GitHub ${method} ${url}: ${res.status} ${data.message || ''}`.trim());
    e.status = res.status;
    e.ghMessage = data.message || '';
    throw e;
  }
  return data;
}

// A user token of a GitHub App can only touch the repositories the App is INSTALLED on. When it is
// not installed on REPO, GitHub answers the issue POST with 403 "Resource not accessible by
// integration" -- which says nothing to a player and not much to the maintainer either.
function explainIssueError(e) {
  if (e && e.status === 403 && /not accessible by integration/i.test(e.ghMessage || e.message || '')) {
    const out = new Error(`GitHub refused to open the issue: the reports GitHub App is not installed on ${REPO}. The maintainer has to install it there (GitHub > Settings > Developer settings > GitHub Apps > Install App).`);
    out.code = 'app-not-installed';
    out.cause = e;
    return out;
  }
  return e;
}

const LOGS_PLACEHOLDER = '**Logs:** (link to the log gist, added when sent)';

// files: [{ name, text, maxBytes? }] (already read; maxBytes caps that file's tail below the gist limit).
// Everything that will leave the PC, redacted and cut, and nothing more: the player's preview shows
// exactly this object, and postReport sends exactly this object.
// Returns { title, body, files: [{ name, text, bytes, cut }], skipped: [{ name, why }] }.
function prepareReport({ title, body, files = [], redactOpts = {} }) {
  const out = [];
  const skipped = [];
  const used = new Set();
  let total = 0;
  for (const f of files) {
    const redacted = redact(f.text, redactOpts);
    const text = tail(redacted, Math.min(f.maxBytes || MAX_FILE_BYTES, MAX_FILE_BYTES));
    if (!text.trim()) { skipped.push({ name: f.name, why: 'empty' }); continue; }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (total + bytes > MAX_TOTAL_BYTES) { skipped.push({ name: f.name, why: 'over the size limit' }); continue; }
    total += bytes;
    let name = gistName(f.name);
    while (used.has(name)) name = '_' + name;
    used.add(name);
    out.push({ name, text, bytes, cut: text !== redacted });
  }
  return {
    title: redact(title, redactOpts),
    body: redact(body, redactOpts) + (out.length ? `\n\n${LOGS_PLACEHOLDER}` : '') + '\n\n_Sent from OptiDLSS5-UI Game Help._',
    files: out,
    skipped,
  };
}

// Posts a prepareReport() result as it stands: a secret gist with its files, then the issue linking it.
// Returns { issueUrl, issueNumber, gistUrl, sent: [names], cut: [names] }.
async function postReport({ token, prepared, fetchImpl = netFetch }) {
  const gistFiles = {};
  for (const f of prepared.files) gistFiles[f.name] = { content: f.text };
  const gist = prepared.files.length
    ? await gh(token, 'POST', '/gists', { description: `OptiDLSS5-UI game failure: ${prepared.title}`, public: false, files: gistFiles }, fetchImpl)
    : null;
  const body = gist ? prepared.body.replace(LOGS_PLACEHOLDER, `**Logs:** ${gist.html_url}`) : prepared.body;
  let issue;
  try {
    issue = await gh(token, 'POST', `/repos/${REPO}/issues`, { title: prepared.title, body }, fetchImpl);
  } catch (e) {
    // The gist exists only to be linked from this issue. Left behind, every retry of a failing send
    // would add another orphan to the player's account -- so it goes, best effort.
    if (gist && gist.id) {
      try { await gh(token, 'DELETE', `/gists/${gist.id}`, null, fetchImpl); } catch {}
    }
    throw explainIssueError(e);
  }
  return {
    issueUrl: issue.html_url, issueNumber: issue.number, gistUrl: gist ? gist.html_url : null,
    sent: prepared.files.map((f) => f.name), cut: prepared.files.filter((f) => f.cut).map((f) => f.name),
  };
}

// prepare + post in one go, without a preview.
async function sendReport({ token, title, body, files, fetchImpl = netFetch, redactOpts = {} }) {
  return postReport({ token, prepared: prepareReport({ title, body, files, redactOpts }), fetchImpl });
}

module.exports = { CLIENT_ID, REPO, configured, redact, tail, gistName, startDeviceFlow, pollForToken, prepareReport, postReport, sendReport };
