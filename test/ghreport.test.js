'use strict';
// "Send game failure" (ghreport.js): the Windows user name never reaches GitHub, big logs keep their tail,
// the device-flow sign-in waits on "pending" and gives up cleanly, and a send creates the logs gist first
// and links it from the issue.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { REPO, scratchDir, write, fakeExe } = require('./helpers');
const gh = require(path.join(REPO, 'src', 'ghreport'));
const runlog = require(path.join(REPO, 'src', 'runlog'));

test('the Windows user name is hidden in every path and as a bare word', () => {
  const text = 'Setting DllPath to C:\\Users\\Yathin\\Desktop\\Games\\Dolphin-x64\\OptiScaler\nhost: c:/users/Yathin/AppData\nsigned in as Yathin today';
  const out = gh.redact(text, { userName: 'Yathin', homeDir: 'C:\\Users\\Yathin' });
  assert.doesNotMatch(out, /Yathin/i);
  assert.match(out, /C:\\Users\\<user>\\Desktop\\Games\\Dolphin-x64/);
  assert.match(out, /c:\/users\/<user>\/AppData/);
  // A generic account name is not scrubbed out of ordinary words.
  assert.equal(gh.redact('user settings', { userName: 'user', homeDir: '' }), 'user settings');
});

test('a log over the gist limit keeps its end, where a failure is', () => {
  const big = 'START\n' + 'x'.repeat(2 * 1024 * 1024) + '\nstopped: the DLSS evaluate crashed';
  const out = gh.tail(big);
  assert.match(out, /^\[\.\.\. \d+ bytes cut from the start \.\.\.\]/);
  assert.match(out, /stopped: the DLSS evaluate crashed$/);
  assert.ok(Buffer.byteLength(out) < 1024 * 1024);
  assert.equal(gh.gistName('.dlss5ui-api.json'), 'dlss5ui-api.json');
  assert.equal(gh.gistName('host64/OptiScaler.log'), 'host64_OptiScaler.log');
});

test('device-flow polling waits on pending, slows down when told, and stops on a decline', async () => {
  const answers = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'ghu_token' }];
  const waits = [];
  const fetchImpl = async () => ({ json: async () => answers.shift() });
  const token = await gh.pollForToken('dev', { interval: 5, expiresIn: 900, fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(token, 'ghu_token');
  assert.deepEqual(waits, [5000, 5000, 10000], 'slow_down adds five seconds');

  await assert.rejects(gh.pollForToken('dev', { fetchImpl: async () => ({ json: async () => ({ error: 'access_denied' }) }), sleep: async () => {} }), /declined/);
});

test('a send posts the redacted logs as a secret gist, then the issue linking them', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, auth: opts.headers.Authorization });
    if (url.endsWith('/gists')) return { ok: true, status: 201, json: async () => ({ html_url: 'https://gist.github.com/abc' }) };
    if (url.endsWith('/issues')) return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/mrcgibb9876-hash/OptiDLSS5-UI/issues/142', number: 142 }) };
    throw new Error('unexpected ' + url);
  };
  const out = await gh.sendReport({
    token: 'ghu_x',
    title: '[Game Help] Dolphin: nr-model-crash',
    body: '**Game:** Dolphin at C:\\Users\\Yathin\\Desktop',
    files: [{ name: 'OptiScaler.log', text: 'DllPath C:\\Users\\Yathin\\Desktop' }, { name: '.dlss5ui-api.json', text: '{}' }, { name: 'empty.log', text: '   ' }],
    fetchImpl,
    redactOpts: { userName: 'Yathin', homeDir: 'C:\\Users\\Yathin' },
  });
  assert.equal(calls[0].url, 'https://api.github.com/gists');
  assert.equal(calls[0].body.public, false);
  assert.deepEqual(Object.keys(calls[0].body.files).sort(), ['OptiScaler.log', 'dlss5ui-api.json'], 'empty files are skipped, dot names fixed');
  assert.doesNotMatch(JSON.stringify(calls), /Yathin/, 'no user name anywhere');
  assert.equal(calls[1].url, 'https://api.github.com/repos/mrcgibb9876-hash/OptiDLSS5-UI-releases/issues');
  assert.match(calls[1].body.body, /\*\*Logs:\*\* https:\/\/gist\.github\.com\/abc/);
  assert.equal(calls[1].auth, 'Bearer ghu_x');
  assert.equal(out.issueNumber, 142);

  // A revoked sign-in says so instead of failing vaguely.
  const revoked = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) });
  await assert.rejects(gh.sendReport({ token: 'old', title: 't', body: 'b', files: [{ name: 'a.log', text: 'x' }], fetchImpl: revoked }), (e) => e.signedOut === true);
});

test('the bundle\'s files can be gathered without writing a zip', async () => {
  const dir = scratchDir('gather-files');
  fakeExe(dir, 'Game.exe');
  write(dir, 'OptiScaler.log', 'log');
  write(dir, 'dlss5-feed.log', 'feed');
  const { files } = await runlog.gatherSupportFiles(dir, { extra: { appVersion: 'x' } });
  const names = files.map((f) => f.name);
  assert.ok(names.includes('OptiScaler.log') && names.includes('dlss5-feed.log') && names.includes('folder-listing.txt') && names.includes('app-view.json'));
  assert.ok(files.find((f) => f.name === 'app-view.json').text.includes('"appVersion": "x"'));
});

// An issue POST that fails after the gist was made used to leave the gist behind, one per retry; and
// the App not being installed on the releases repo came back as GitHub's own "Resource not accessible
// by integration", which names nothing anyone can act on.
test('a failed issue takes its gist back and names the missing App install', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(`${opts.method} ${url}`);
    if (opts.method === 'POST' && url.endsWith('/gists')) return { ok: true, status: 201, json: async () => ({ id: 'g123', html_url: 'https://gist.github.com/g123' }) };
    if (opts.method === 'POST' && url.endsWith('/issues')) return { ok: false, status: 403, json: async () => ({ message: 'Resource not accessible by integration' }) };
    if (opts.method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
    throw new Error('unexpected ' + url);
  };
  await assert.rejects(
    gh.sendReport({ token: 'ghu_x', title: 't', body: 'b', files: [{ name: 'a.log', text: 'x' }], fetchImpl }),
    (e) => e.code === 'app-not-installed' && e.message.includes(gh.REPO),
  );
  assert.deepEqual(calls, [
    'POST https://api.github.com/gists',
    `POST https://api.github.com/repos/${gh.REPO}/issues`,
    'DELETE https://api.github.com/gists/g123',
  ]);

  // Any other failure is passed through as it was, and the gist still goes.
  calls.length = 0;
  const other = async (url, opts) => {
    calls.push(`${opts.method} ${url}`);
    if (url.endsWith('/gists')) return { ok: true, status: 201, json: async () => ({ id: 'g9', html_url: 'x' }) };
    if (url.endsWith('/issues')) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
    return { ok: true, status: 204, json: async () => ({}) };
  };
  await assert.rejects(gh.sendReport({ token: 'ghu_x', title: 't', body: 'b', files: [{ name: 'a.log', text: 'x' }], fetchImpl: other }), /500 boom/);
  assert.ok(calls.includes('DELETE https://api.github.com/gists/g9'));
});
