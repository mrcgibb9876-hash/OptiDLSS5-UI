
const fs = require('fs');
const path = require('path');

const { discover } = require('./library');
const { resolveUnrealShippingExe } = require('./detect');
// Installers, launchers, anti-cheat helpers, script extenders: never the game itself.
// start_protected_game.exe is EasyAntiCheat's own launcher (detect.js's antiCheatStub): it starts
// the anti-cheat and then the real exe, so it is never the game and never what this app installs
// beside -- it was showing up as a candidate for every FromSoftware game.
const NOT_A_GAME_EXE = /^(unins|setup|install|vcredist|vc_redist|dxsetup|dxwebsetup|dotnet|dotnetfx|oalinst|crashpad|crashreport|crashhandler|launcher_installer|easyanticheat|eac|battleye|be_service|start_protected_game|belauncher|eaclauncher|activation|patch|update|touchup|rapidcrc|autorun|autoplay|quicksfv|readme|config|cleanup|modorganizer|redlauncher|skse\d*_loader|steamerrorreporter|dgvoodoocpl|reshade_setup|gamelaunchhelper)/i;
// A companion tool shipped beside the game: an editor, a dedicated server, a workshop uploader.
// uploader/workshop come from a real report (Duke Nukem 3D: 20th Anniversary World Tour,
// 2026-09-17): the folder holds duke3d.exe and DukeWorkshopUploader.exe, neither name matches
// the game's, so both scored 0 and the only tie-break left was size -- and the uploader is the
// bigger file by 850 KB. The card was built on a wxWidgets tool that renders nothing, which is
// exactly why detection then reported "graphics API not detected".
const NOT_THE_GAME = /(launcher|crashreport|crashhandler|redist|touchup|activation|eac|easyanticheat|battleye|be_service|steam_api|dxwebsetup|helper|updater|uploader|workshop|report|benchmark|editor|server|dedicated)/i;
const GOOD_DIRS = /(?:^|[\\/])(binaries[\\/]win64|binaries[\\/]win32|bin[\\/]x64|bin[\\/]win64|bin|x64|win64|game)(?:[\\/]|$)/i;

// Asset trees hold tens of thousands of files and never the exe; installers, redistributables
// and anti-cheat folders hold exes that are never the game; backups hold copies nobody should
// install into. Skipping them is what lets a packaged Unreal game be walked deep enough to
// reach <Project>\Binaries\Win64 without every library refresh crawling its Content folder.
const SKIP_DIRS = new Set([
    'content', 'paks', 'movies', 'screenshots', 'saved', 'logs', 'mods', 'downloads', 'overwrite', 'profiles',
    '_redist', 'prerequisites', 'directx', 'redist', 'redistributable', 'redistributables', '_commonredist', 'dotnet',
    'installer_resources', 'installer', 'installers', 'support', '_support', 'vcredist', 'directx_redist',
    'eaanticheat', 'easyanticheat', 'battleye',
    'backup', 'backups', '_backup', 'bak', 'old', 'original', 'originals',
    '_dlss5_backup', 'reshade-shaders', 'node_modules', '.git',
]);

// A Microsoft Store / Xbox install keeps the game itself under Content\ -- which is the one folder
// name SKIP_DIRS exists to skip, because in an Unreal tree Content\ is nothing but assets. The two
// meanings collided and the Store won nothing: walkExes could not see an Xbox game's executable at
// all, so a Store game fell back to whatever was in its root -- gamelaunchhelper.exe, the Store's
// stub, or nothing -- and the install landed beside a process that never renders.
//
// Microsoft Flight Simulator 2024 under C:\XboxGames is the report (#93, 2026-09-21): the app ended
// up with the Content FOLDER itself recorded as the exe, put its dxgi.dll in the package root, could
// not detect an API at all, and nothing ever loaded. The user reasonably read that as "DLSS 5 makes
// no difference".
//
// MicrosoftGame.config is the authority when it is readable (xboxDeclaredExe), but a Store folder's
// permissions can hide it, so the walker has to be able to find the exe on its own too.
function isXboxInstall(dir) {
    const hasConfig = (d) => {
        try { return fs.readdirSync(d).some((f) => f.toLowerCase() === 'microsoftgame.config'); }
        catch { return false; }
    };
    if (hasConfig(dir) || hasConfig(path.join(dir, 'Content'))) return true;
    // The folder may be unreadable; the location still says what it is.
    return /[\\/](?:xboxgames|windowsapps|modifiablewindowsapps)[\\/]/i.test(String(dir) + path.sep);
}

// keepContent defaults to "this looks like a Store install", so every existing caller -- the library
// scan, Edit's candidate list -- gets the fix without being changed.
function walkExes(root, maxDepth = 8, { keepContent = isXboxInstall(root) } = {}) {
    const out = [];

    const visit = (dir, depth) => {
        let entries;

        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const full = path.join(dir, entry.name);

            if (entry.isFile() && /\.exe$/i.test(entry.name)) {
                out.push(full);
            } else if (entry.isDirectory() && depth > 0
                       && !(SKIP_DIRS.has(entry.name.toLowerCase())
                            && !(keepContent && entry.name.toLowerCase() === 'content'))) {
                visit(full, depth - 1);
            }
        }
    };

    visit(root, maxDepth);
    return out;
}

// A Microsoft Store / Xbox app install names its executable in MicrosoftGame.config, and the
// exe itself may be encrypted past what any PE reader can see -- the manifest is the
// authority there. gamelaunchhelper.exe is the Store's own stub, never the game.
function xboxDeclaredExe(gameDir) {
    for (const dir of [gameDir, path.join(gameDir, 'Content')]) {
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { continue; }
        const config = entries.find((f) => f.toLowerCase() === 'microsoftgame.config');
        if (!config) continue;
        let text;
        try { text = fs.readFileSync(path.join(dir, config), 'utf8'); } catch { continue; }
        for (const match of text.matchAll(/<Executable\b([^>]*)\/?\s*>/gi)) {
            const name = /\bName\s*=\s*["']([^"']+)["']/i.exec(match[1]);
            if (!name || /^gamelaunchhelper\.exe$/i.test(path.basename(name[1]))) continue;
            const full = path.resolve(dir, name[1].replace(/[\\/]/g, path.sep));
            if (fs.existsSync(full)) return full;
        }
    }
    return null;
}
function score(exePath, gameDir, gameName) {
    const rel = path.relative(gameDir, exePath).toLowerCase();
    const base = path.basename(exePath, '.exe').toLowerCase();

    if (NOT_A_GAME_EXE.test(base)) return -1000;

    let s = 0;
    const nameKey = String(gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseKey = base.replace(/[^a-z0-9]/g, '');

    // An exe named exactly the game is the game, whatever word its title happens to contain --
    // Workshop Simulator's own exe must not be read as somebody's workshop tool. Exact only: a
    // FarmingSimulatorEditor.exe beside FarmingSimulator.exe is still the editor.
    if (NOT_THE_GAME.test(base) && baseKey !== nameKey) s -= 50;

    if (nameKey && baseKey && (baseKey.includes(nameKey) || nameKey.includes(baseKey))) s += 20;

    if (GOOD_DIRS.test(rel)) s += 10;
    // The Unreal shipping exe is the process that renders; the root stub named like the game
    // only spawns it. Everything this app does has to land beside the shipping exe.
    if (/-win(64|gdk)-shipping$/i.test(base)) s += 15;
    s -= (rel.split(/[\\/]/).length - 1) * 2;
    if (/(?:^|[\\/])singleplayer(?:[\\/]|$)/.test(rel)) s += 4;
    if (/(?:^|[\\/])(?:multiplayer|online)(?:[\\/]|$)/.test(rel)) s -= 4;
    try {
        s += Math.min(fs.statSync(exePath).size / (32 * 1024 * 1024), 4);
    } catch {
    }

    return s;
}
function chooseExe(gameDir, gameName) {
    const declared = xboxDeclaredExe(gameDir);
    if (declared) {
        return { exePath: resolveUnrealShippingExe(declared), alternatives: walkExes(gameDir).filter((e) => e !== declared).slice(0, 7) };
    }
    const candidates = walkExes(gameDir)
        .map((exe) => ({ exe, s: score(exe, gameDir, gameName) }))
        .filter((c) => c.s > -1000)
        .sort((a, b) => b.s - a.s);

    if (!candidates.length) return null;

    return {
        exePath: resolveUnrealShippingExe(candidates[0].exe),
        alternatives: candidates.slice(1, 8).map((c) => c.exe)
    };
}
// An exe someone picked by hand in Add Game / Edit (main.js pick:exe). The library scan never
// proposes gamelaunchhelper.exe (NOT_A_GAME_EXE), but Browse took it as picked: a Game Pass /
// Microsoft Store folder shows it as the obvious exe, and the card was then built on the Store's
// stub -- named "Gamelaunchhelper", OptiScaler installed beside a process that never renders, and
// "nothing has been logged in this folder yet" (#65, 2026-09-18). So the helper is replaced by the
// exe this folder's own scan would pick, MicrosoftGame.config first. Anything else only gets the
// launcher-stub swap it always had.
function resolvePickedExe(picked) {
    // Never hand back something that is not an executable. The picker filters to .exe, but this is
    // also reached with paths from elsewhere, and a directory recorded as the exe is exactly the #93
    // failure: everything downstream then installs next to a folder and quietly does nothing.
    const inside = repairExePath(picked);
    if (inside !== picked) return inside;
    if (picked && /^gamelaunchhelper\.exe$/i.test(path.basename(picked))) {
        const chosen = chooseExe(path.dirname(picked), '');
        if (chosen && chosen.exePath && !/^gamelaunchhelper\.exe$/i.test(path.basename(chosen.exePath))) return chosen.exePath;
    }
    return resolveUnrealShippingExe(picked);
}
function scanForGames({ extraFolders = [], scanDrives = false, excludedRoots = [], knownExePaths = [] } = {}) {
    const { games, roots } = discover(extraFolders, scanDrives, excludedRoots);

    const known = new Set(knownExePaths.map((p) => String(p).toLowerCase()));
    // A game already on the grid is skipped by its folder, not only by the exact exe this scan
    // would pick for it. Matching the exe alone re-proposed a game whose exe someone had changed
    // by hand in Edit: the scan picked its own candidate again, that path was not "known", and the
    // same game came back as a second card pointing at the exe they had just moved away from.
    const knownExeDirs = [...known]
        .map((p) => path.dirname(p).toLowerCase() + path.sep)
        .filter((d) => d.length > 1);
    const alreadyOnTheGrid = (dir) => {
        const root = path.resolve(String(dir)).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
        // Either direction: the known exe sits inside this game's folder (an Unreal game's
        // Binaries\Win64), or this game's folder is itself inside the known exe's folder.
        return knownExeDirs.some((d) => d.startsWith(root) || root.startsWith(d));
    };
    const found = [];

    for (const game of games) {
        const picked = chooseExe(game.dir, game.name);
        if (!picked) continue;

        if (known.has(picked.exePath.toLowerCase())) continue;
        if (alreadyOnTheGrid(game.dir)) continue;

        found.push({
            name: game.name,
            exePath: picked.exePath,
            alternatives: picked.alternatives,
            dir: game.dir,
            launcher: game.launcher || 'My folders',
            bannerAppId: game.launcher === 'Steam' ? String(game.id) : ''
        });
    }

    found.sort((a, b) => a.name.localeCompare(b.name));

    return { games: found, roots };
}

// Turns a stored exe path that is not an executable back into one, and leaves a good path alone.
// Used when the library is loaded, so a game recorded wrongly by an older build repairs itself
// instead of sitting there installing into the wrong folder forever (#93).
//
// A path that simply does not exist is left exactly as it is: the game may be on a drive that is not
// plugged in, and the card already says so. Only a path that exists and is NOT an .exe is rewritten.
function repairExePath(exePath) {
    if (!exePath) return exePath;
    let stat;
    try { stat = fs.statSync(exePath); } catch { return exePath; }
    if (stat.isFile() && /\.exe$/i.test(exePath)) return exePath;
    const dir = stat.isDirectory() ? exePath : path.dirname(exePath);
    let chosen = null;
    try { chosen = chooseExe(dir, path.basename(dir)); } catch { return exePath; }
    return chosen && chosen.exePath ? chosen.exePath : exePath;
}

// The other folder of a Microsoft Store / Xbox (GDK) install, or null. Such an install is two
// folders: the package root (C:\XboxGames\<Game>\) and Content\ inside it, where the exe,
// MicrosoftGame.config and gamelaunchhelper.exe live. This app's files belong in Content\ only,
// but a card that recorded the Content FOLDER as its exe (#93, fixed in 2.3.14) installed into
// the root, and a Remove from the repaired card never looked there again -- the "new files in the
// main folder" and the leftovers of #123. So Remove asks for this folder too. Given either one,
// returns the other; never a library folder (C:\XboxGames itself) and never anything else.
const STORE_LIBRARY = /^(xboxgames|windowsapps|modifiablewindowsapps)$/i;
function xboxPairedDir(dir) {
    if (!dir || !isXboxInstall(dir)) return null;
    const here = path.resolve(dir);
    if (path.basename(here).toLowerCase() === 'content') {
        const root = path.dirname(here);
        if (root === here || STORE_LIBRARY.test(path.basename(root))) return null;
        return root;
    }
    if (STORE_LIBRARY.test(path.basename(here))) return null;
    const content = path.join(here, 'Content');
    try { if (fs.statSync(content).isDirectory()) return content; } catch { /* no Content\ here */ }
    return null;
}

module.exports = { scanForGames, chooseExe, walkExes, resolvePickedExe, repairExePath, isXboxInstall, xboxPairedDir };
