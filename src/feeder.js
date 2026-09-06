// Driving DLSS5-Feeder's own installer, rather than reimplementing it.
//
// The Feeder ships tools/Install-DLSS5Feeder.ps1, which already fetches and wires up every piece:
// ReShade, the feeder add-on, LumeniteFX for motion vectors, the neural consumer, the NVIDIA
// runtimes, dgVoodoo2 for Direct3D 8/9, and the .ini files with the techniques enabled in the right
// order. It merges rather than replaces, backs up what it touches, and finishes with a verification
// pass.
//
// Writing our own downloader for the same set would mean owning a list of URLs that the Feeder's
// author changes whenever a dependency moves -- and being wrong about it silently, in someone's
// game folder. So this shells out and reads the output back.
//
// -------------------------------------------------------------------------------------------
// One deliberate departure, and it is the important one.
//
// That script sources four files from Discord CDN attachments: nvngx_dlssnr.dll, nvngx_dlss.dll,
// the RenoDX add-on and Deep Fried Chicken. The first two are NVIDIA's, out of a driver, and not
// redistributable -- which is exactly why this project's own release excludes them and tells people
// to supply their own, and why package_release.ps1 leaves them out of the zip.
//
// So we pass -DlssNrDll / -DlssDll / -RenoDxAddon explicitly, pointing at whatever the user has
// already given this app. When the script is handed a local path it uses it and never reaches for
// Discord. Everything from a real source -- ReShade from reshade.me, LumeniteFX and dgVoodoo2 from
// GitHub -- is left to the script, because those are fine to fetch.
//
// If the user has not supplied nvngx_dlssnr.dll, this refuses rather than letting the script fall
// back to the Discord copy. That is a decision about redistribution, and it is not one to make
// quietly on someone's behalf.
// -------------------------------------------------------------------------------------------

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const INSTALLER_REPO = 'jlrouzies-fr/DLSS5-Feeder';
const INSTALLER_PATH = 'tools/Install-DLSS5Feeder.ps1';

const rawUrl = (ref) =>
    `https://raw.githubusercontent.com/${INSTALLER_REPO}/${encodeURIComponent(ref)}/${INSTALLER_PATH}`;

const INSTALLER_URL = rawUrl('main');
const INSTALLER_SOURCE = `${INSTALLER_REPO} (${INSTALLER_PATH})`;

// Only these reach the script as parameter values. Everything here arrives from the renderer, and
// PowerShell reads a value that starts with "-" as the next parameter name -- so an unchecked
// string does not become a security problem, but it does become an unintelligible binding error in
// the middle of an install. An allow-list is cheaper than explaining that.
// Taken from the script's own ValidateSet, not from what this app calls things elsewhere: "D3D"
// covers Direct3D 10/11/12, and 8 and 9 are separate because they go through dgVoodoo2.
const APIS = ['Auto', 'D3D', 'Vulkan', 'OpenGL', 'D3D9', 'D3D8'];
const CONSUMERS = ['Ask', 'DFC', 'RenoDX'];

// 3 = LumeniteFX, 4 = QuantMotion. The script's own numbering.
const MV_PROVIDERS = [3, 4];

// Fetches the installer and returns where it landed, with the bytes' hash.
//
// Pinned to the newest tagged release where there is one. Kept as a file we downloaded rather than
// piped straight into PowerShell, so that the exact script about to run is on disk and can be read,
// diffed or handed to support. Piping a remote script directly into a shell is how people end up
// unable to say what ran.
//
// Written to a fresh random directory each time: this file is executed, and the install elevates
// partway through, so a predictable path in %APPDATA% is a window in which anything else running as
// the user could swap the script and ride the UAC prompt the user is about to approve.
async function fetchInstaller(cacheRoot) {
    await fsp.mkdir(cacheRoot, { recursive: true });

    const dir = await fsp.mkdtemp(path.join(cacheRoot, 'run-'));
    const dest = path.join(dir, 'Install-DLSS5Feeder.ps1');

    const { ref, pinned, why } = await resolveRef();

    const res = await fetch(rawUrl(ref), {
        headers: { 'User-Agent': 'OptoRenoDXlss5' },

        // Node's fetch has no timeout of its own. A proxy that accepts the connection and then says
        // nothing would otherwise leave the IPC call pending forever, which the user sees as a
        // spinner that never stops and cannot be cancelled.
        signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) throw new Error(`Could not download the Feeder installer: HTTP ${res.status}`);

    const type = res.headers.get('content-type') || '';

    if (/^text\/html/i.test(type))
        throw new Error('Got an HTML page instead of the Feeder installer -- check for a proxy or captive portal');

    // Kept as bytes rather than round-tripped through a string. .text() strips a UTF-8 BOM, and a
    // BOM-less .ps1 is read by Windows PowerShell as the ANSI code page, which turns any accented
    // character in the script into mojibake or a parse error. Hashing the bytes also means the
    // sha256 below is the one you get from the file in the repo.
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');

    // A truncated download, a rate-limit body or a 404 page would otherwise be run as a script.
    if (!/param\s*\(/i.test(text) || bytes.length < 2000)
        throw new Error('The downloaded Feeder installer does not look like the expected script');

    await fsp.writeFile(dest, bytes);

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    return { path: dest, dir, bytes: bytes.length, sha256, ref, pinned, why, text };
}

// Prefer a tagged release over the default branch. Running someone else's script on a user's
// machine off whatever landed on main an hour ago is a different proposition from running the
// version its author decided was ready.
//
// Every release so far is marked prerelease, so releases/latest can legitimately 404 -- read the
// full list instead. GitHub orders that list by the tagged commit's date, not by when the release
// was published, so a hotfix cut from an older commit sorts below an earlier one. Sort explicitly.
async function resolveRef() {
    try {
        const res = await fetch(`https://api.github.com/repos/${INSTALLER_REPO}/releases?per_page=30`, {
            headers: { 'User-Agent': 'OptoRenoDXlss5', Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(15000)
        });

        if (!res.ok)
            return {
                ref: 'main',
                pinned: false,
                why: `GitHub answered HTTP ${res.status} for the release list${res.status === 403 ? ' (rate limit)' : ''}`
            };

        const releases = await res.json();

        if (Array.isArray(releases)) {
            const usable = releases
                .filter((r) => r && !r.draft && r.tag_name)
                .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

            if (usable.length) return { ref: usable[0].tag_name, pinned: true, why: '' };

            return { ref: 'main', pinned: false, why: 'no tagged release' };
        }
    } catch (error) {
        return { ref: 'main', pinned: false, why: `could not reach GitHub (${error.message})` };
    }

    return { ref: 'main', pinned: false, why: 'unexpected answer from GitHub' };
}

// Which parameters the downloaded script actually declares.
//
// This re-resolves the newest release on every run, so the script can change under us between one
// install and the next. If the author renames or drops a parameter, passing the old name gets a
// PowerShell binding error that surfaces as an unintelligible wall of text -- and, far worse, a
// renamed -DlssNrDll would mean the script quietly falls back to its own Discord copy of NVIDIA's
// DLL, which is the one thing this whole file exists to prevent. So read the param() block and
// check before running anything.
function declaredParams(scriptText) {
    // The param block runs to its matching close paren; nested parens appear in attributes like
    // [ValidateSet(...)], so count rather than stopping at the first ")".
    const start = scriptText.search(/(^|\n)\s*param\s*\(/i);
    if (start < 0) return null;

    const open = scriptText.indexOf('(', start);
    let depth = 0;
    let end = -1;

    for (let i = open; i < scriptText.length; i++) {
        if (scriptText[i] === '(') depth++;
        else if (scriptText[i] === ')' && --depth === 0) {
            end = i;
            break;
        }
    }

    if (end < 0) return null;

    const block = scriptText.slice(open, end);
    const names = new Set();

    for (const m of block.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1].toLowerCase());

    return names.size ? names : null;
}

// Parameters we must be able to pass, or we do not run at all. -GameExe because without it the
// script would prompt or pick something itself; -DlssNrDll because without it the script fetches
// NVIDIA's DLL from Discord instead of using the user's.
const REQUIRED_PARAMS = ['gameexe', 'dlssnrdll'];

// Checks the args we are about to pass against what this version of the script understands.
// Returns the args to actually use, plus anything worth telling the user.
function reconcileArgs(args, declared) {
    if (!declared) return { args, warnings: [], missingRequired: [] };

    const missingRequired = REQUIRED_PARAMS.filter((name) => !declared.has(name));

    // Everything up to and including the script path belongs to powershell.exe, not the script.
    const scriptAt = args.indexOf('-File') + 1;
    const kept = args.slice(0, scriptAt + 1);
    const dropped = [];

    for (let i = scriptAt + 1; i < args.length; i++) {
        const arg = args[i];
        const isSwitch = /^-[A-Za-z]/.test(arg);
        const value = i + 1 < args.length && !/^-[A-Za-z]/.test(args[i + 1]) ? args[i + 1] : null;

        if (isSwitch && !declared.has(arg.slice(1).toLowerCase())) {
            dropped.push(arg);
            if (value !== null) i++;
            continue;
        }

        kept.push(arg);
        if (value !== null) {
            kept.push(value);
            i++;
        }
    }

    const warnings = dropped.length
        ? [
              `This version of the installer no longer takes ${dropped.join(', ')} -- ` +
                  'skipped so the run does not fail on it. If something looks wrong afterwards, the ' +
                  'installer has changed and this app needs updating.'
          ]
        : [];

    return { args: kept, warnings, missingRequired };
}

// Builds the argument list. Split out so it can be tested without running anything.
function buildArgs(scriptPath, options) {
    const {
        exePath,
        api = 'Auto',
        consumer = 'DFC',
        mvProvider = 3,
        nrDllPath,
        dlssDllPath,
        renoDxAddonPath,
        downloadsDir
    } = options;

    const args = [
        '-NoProfile',

        // No console to answer a prompt at: this runs behind a UI, and a Read-Host or a -Confirm on
        // an error branch would block on a stdin pipe that is never written, with no exit and no
        // output. -NonInteractive makes that an error instead of a hang.
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',

        // -File and not -Command: it passes values through without a second round of PowerShell
        // parsing, and it propagates the script's own exit code, which the close handler reads.
        '-File',
        scriptPath,
        '-GameExe',
        exePath,

        // The script's own unattended switches.
        '-Yes',
        '-NoPause'
    ];

    if (api && api !== 'Auto') {
        if (!APIS.includes(api)) throw new Error(`Unknown graphics API "${api}"`);
        args.push('-Api', api);
    }

    if (consumer) {
        if (!CONSUMERS.includes(consumer)) throw new Error(`Unknown consumer "${consumer}"`);
        args.push('-Consumer', consumer);
    }

    if (mvProvider != null) {
        if (!MV_PROVIDERS.includes(Number(mvProvider)))
            throw new Error(`Unknown motion-vector provider "${mvProvider}"`);
        args.push('-MvProvider', String(Number(mvProvider)));
    }

    if (downloadsDir) args.push('-Downloads', downloadsDir);

    // The point of the whole exercise: hand it the files we already have so it does not fetch the
    // non-redistributable ones from Discord.
    if (nrDllPath) args.push('-DlssNrDll', nrDllPath);
    if (dlssDllPath) args.push('-DlssDll', dlssDllPath);
    if (renoDxAddonPath) args.push('-RenoDxAddon', renoDxAddonPath);

    return args;
}

// Turns pipe chunks into whole lines. Chunks break at arbitrary byte offsets, so splitting each one
// on newlines by itself cuts words in half, and toString() on a boundary mangles any multi-byte
// character. Decode incrementally, keep the unterminated remainder, flush it at the end.
function lineReader(onLine) {
    const decoder = new StringDecoder('utf8');
    let pending = '';

    return {
        push(buf) {
            pending += decoder.write(buf);
            const parts = pending.split(/\r?\n/);
            pending = parts.pop();
            for (const line of parts) onLine(line);
        },
        flush() {
            pending += decoder.end();
            if (pending) onLine(pending);
            pending = '';
        }
    };
}

// Runs the installer for one game, streaming progress lines back through onProgress.
async function installForGame(options, onProgress = () => {}) {
    const { exePath, nrDllPath, dlssDllPath } = options;

    if (!exePath || !fs.existsSync(exePath)) throw new Error('That game executable no longer exists');

    // Refusing here rather than letting the script reach for the Discord copy. See the note at the
    // top of this file -- this is the redistribution decision, and it belongs to the user.
    if (!nrDllPath || !fs.existsSync(nrDllPath))
        throw new Error(
            "Set the path to your own nvngx_dlssnr.dll first (or point this app at a Streamline zip that " +
                "contains it). It is NVIDIA's, it comes out of a driver, and this app will not download a " +
                'copy of it on your behalf.'
        );

    const cacheRoot = options.cacheDir || path.join(os.tmpdir(), 'optorenodxlss5-feeder');
    const installer = await fetchInstaller(cacheRoot);

    onProgress({
        kind: 'info',
        line:
            `Using ${INSTALLER_SOURCE} @ ${installer.ref}` +
            `${installer.pinned ? '' : ` (unpinned: ${installer.why})`}, ` +
            `${installer.bytes} bytes, sha256 ${installer.sha256.slice(0, 16)}`
    });

    // Said plainly rather than left to be discovered: nvngx_dlss.dll is NVIDIA's too, and without a
    // local copy the script will go and get one itself.
    if (!dlssDllPath)
        onProgress({
            kind: 'warn',
            line:
                'No local nvngx_dlss.dll was supplied, so the installer will fetch its own copy. Point this ' +
                'app at a Streamline zip if you would rather it used yours.'
        });

    let args = buildArgs(installer.path, options);

    // The release we just resolved may not be the one this app was written against.
    const declared = declaredParams(installer.text);

    if (!declared)
        onProgress({
            kind: 'warn',
            line: 'Could not read the installer\'s parameter list, so its arguments are unchecked. Watch the output.'
        });

    const reconciled = reconcileArgs(args, declared);

    if (reconciled.missingRequired.length)
        throw new Error(
            `The Feeder installer at ${installer.ref} no longer takes ` +
                `${reconciled.missingRequired.map((n) => '-' + n).join(' and ')}. ` +
                'Refusing to run it: without those it would go and fetch its own copy of NVIDIA\'s DLL ' +
                'rather than use yours. This app needs updating for that release.'
        );

    for (const warning of reconciled.warnings) onProgress({ kind: 'warn', line: warning });

    args = reconciled.args;

    // Re-checked immediately before running it, against the hash of what was validated. Closes the
    // gap between writing the file and handing it to a shell that elevates.
    const onDisk = crypto.createHash('sha256').update(await fsp.readFile(installer.path)).digest('hex');

    if (onDisk !== installer.sha256)
        throw new Error('The downloaded installer changed on disk before it could run -- refusing to execute it');

    return new Promise((resolve) => {
        const child = spawn('powershell.exe', args, { windowsHide: true });

        // Nothing is ever written to it, and an open stdin is the other way a prompt turns into a
        // silent hang.
        child.stdin.end();

        let tail = '';

        const reader = (kind) =>
            lineReader((line) => {
                const trimmed = line.trimEnd();
                if (kind === 'err') tail = (tail + trimmed + '\n').slice(-4000);
                if (trimmed.trim()) onProgress({ kind, line: trimmed });
            });

        const out = reader('out');
        const err = reader('err');

        child.stdout.on('data', (b) => out.push(b));
        child.stderr.on('data', (b) => err.push(b));

        child.on('error', (error) => resolve({ ok: false, error: error.message }));

        child.on('close', (code) => {
            out.flush();
            err.flush();

            // The script elevates for parts of the install, so a non-zero code is worth surfacing
            // verbatim -- it is usually a declined UAC prompt rather than a real failure.
            resolve(
                code === 0
                    ? { ok: true, code, script: installer.path, ref: installer.ref, sha256: installer.sha256 }
                    : { ok: false, code, error: tail.trim() || `Installer exited with ${code}` }
            );
        });
    });
}

module.exports = {
    installForGame,
    buildArgs,
    declaredParams,
    reconcileArgs,
    fetchInstaller,
    resolveRef,
    lineReader,
    APIS,
    CONSUMERS,
    MV_PROVIDERS,
    INSTALLER_URL,
    INSTALLER_SOURCE
};
