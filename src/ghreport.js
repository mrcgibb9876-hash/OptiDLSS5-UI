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
//   then Install App > only the OptiDLSS5-UI repository, and put the Client ID (Iv23...) in CLIENT_ID below.
//
// Privacy: the issue and the gist are public on GitHub. The files are the support bundle's (logs, inis,
// the game folder's listing, the app's own view of the game); the Windows user name is replaced wherever
// it appears in a path, and the player confirms before anything is sent.
'use strict';

const CLIENT_ID = '';
const REPO = 'mrcgibb9876-hash/OptiDLSS5-UI';
const API = 'https://api.github.com';
const MAX_FILE_BYTES = 900 * 1024; // GitHub truncates gist files over 1 MB
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;

const configured = () => !!CLIENT_ID;

// ---- redaction ---------------------------------------------------------------------------------

// C:\Users\Yathin\Desktop\... -> C:\Users\<user>\Desktop\..., in either slash style, any drive, and the
// bare user name wherever else it appears as a word.
function redact(text, { userName = process.env.USERNAME || '', homeDir = process.env.USERPROFILE || '' } = {}) {
  let out = String(text || '');
  out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\/:*?"<>|\r\n]+)/gi, '$1<user>');
  if (homeDir) out = out.split(homeDir).join('C:\\Users\\<user>');
  if (userName && userName.length >= 3 && !/^(user|admin|public|default)$/i.test(userName)) {
    const esc = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), '<user>');
  }
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

async function startDeviceFlow({ fetchImpl = fetch } = {}) {
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
async function pollForToken(deviceCode, { interval = 5, expiresIn = 900, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
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
  if (!res.ok) throw new Error(`GitHub ${method} ${url}: ${res.status} ${data.message || ''}`.trim());
  return data;
}

// files: [{ name, text }] (already read). Creates a secret gist with the redacted files, then the issue
// linking it. Returns { issueUrl, issueNumber, gistUrl, sent: [names], cut: [names] }.
async function sendReport({ token, title, body, files, fetchImpl = fetch, redactOpts = {} }) {
  const gistFiles = {};
  const sent = [];
  const cut = [];
  let total = 0;
  for (const f of files) {
    let text = redact(f.text, redactOpts);
    const trimmed = tail(text);
    if (trimmed !== text) cut.push(f.name);
    text = trimmed;
    const size = Buffer.byteLength(text, 'utf8');
    if (!text.trim() || total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    let name = gistName(f.name);
    while (gistFiles[name]) name = '_' + name;
    gistFiles[name] = { content: text };
    sent.push(f.name);
  }
  const gist = Object.keys(gistFiles).length
    ? await gh(token, 'POST', '/gists', { description: `OptiDLSS5-UI game failure: ${title}`, public: false, files: gistFiles }, fetchImpl)
    : null;
  const issueBody = redact(body, redactOpts) + (gist ? `\n\n**Logs:** ${gist.html_url}` : '') + '\n\n_Sent from OptiDLSS5-UI Game Help._';
  const issue = await gh(token, 'POST', `/repos/${REPO}/issues`, { title: redact(title, redactOpts), body: issueBody }, fetchImpl);
  return { issueUrl: issue.html_url, issueNumber: issue.number, gistUrl: gist ? gist.html_url : null, sent, cut };
}

module.exports = { CLIENT_ID, REPO, configured, redact, tail, gistName, startDeviceFlow, pollForToken, sendReport };
