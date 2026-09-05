// Turning a discovered game folder into something this app can install into.
//
// library.js finds game FOLDERS (from Steam's libraryfolders.vdf, Epic and GOG registry entries,
// and optionally every fixed drive). This app installs against a specific game EXECUTABLE, because
// OptiScaler has to sit next to the binary that loads it. So something has to choose an exe, and
// that is the whole job of this file.
//
// It is deliberately a suggestion, never a decision. The scan proposes; the user confirms in the
// UI before anything is written. Picking the wrong exe in a folder with six of them is a normal
// outcome, not a bug, and the cost of being wrong is a file copied next to the wrong binary.

const fs = require('fs');
const path = require('path');

const { discover } = require('./library');

// Same list library.js uses to decide whether a folder holds a game at all. Repeated rather than
// exported from there so that file stays byte-identical to its upstream and can be refreshed from
// DLSS5-Swapper without a merge.
const NOT_A_GAME_EXE = /^(unins|setup|install|vcredist|dxsetup|dotnet|oalinst|crashpad|launcher_installer)/i;

// Things that are an executable in a game folder but are not the game: the launcher that starts it,
// the crash reporter that outlives it, the anti-cheat that wraps it. Installing beside any of these
// puts OptiScaler in a process that never renders a frame.
const NOT_THE_GAME = /(launcher|crashreport|crashhandler|redist|touchup|activation|eac|easyanticheat|battleye|be_service|steam_api|dxwebsetup|helper|updater|report|benchmark|editor|server|dedicated)/i;

// Where a game's real executable tends to live. Unreal buries it, so a bare top-level scan misses
// the ones most worth finding.
const GOOD_DIRS = /(?:^|[\\/])(binaries[\\/]win64|binaries[\\/]win32|bin[\\/]x64|bin[\\/]win64|bin|x64|win64|game)(?:[\\/]|$)/i;

function walkExes(root, maxDepth = 4) {
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
            } else if (entry.isDirectory() && depth > 0) {
                visit(full, depth - 1);
            }
        }
    };

    visit(root, maxDepth);
    return out;
}

// Higher is more likely to be the thing that actually renders.
function score(exePath, gameDir, gameName) {
    const rel = path.relative(gameDir, exePath).toLowerCase();
    const base = path.basename(exePath, '.exe').toLowerCase();

    if (NOT_A_GAME_EXE.test(base)) return -1000;

    let s = 0;

    // A launcher is usually at the top and named after the game, so it scores well on everything
    // else. This has to outweigh all of it.
    if (NOT_THE_GAME.test(base)) s -= 50;

    // The strongest signal there is: Deus Ex\bin\DeusEx.exe.
    const nameKey = String(gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseKey = base.replace(/[^a-z0-9]/g, '');

    if (nameKey && baseKey && (baseKey.includes(nameKey) || nameKey.includes(baseKey))) s += 20;

    if (GOOD_DIRS.test(rel)) s += 10;

    // Shallow beats deep, so a top-level Game.exe wins over Engine\Extras\Tool.exe.
    s -= (rel.split(/[\\/]/).length - 1) * 2;

    // Single-player build over the multiplayer one, matching DLSS5-Swapper's own preference: it is
    // the one people are usually trying to make look better.
    if (/(?:^|[\\/])singleplayer(?:[\\/]|$)/.test(rel)) s += 4;
    if (/(?:^|[\\/])(?:multiplayer|online)(?:[\\/]|$)/.test(rel)) s -= 4;

    // Biggest file as a weak tiebreak -- the shipping binary is rarely the small one.
    try {
        s += Math.min(fs.statSync(exePath).size / (32 * 1024 * 1024), 4);
    } catch {
        // Unreadable is not fatal; it just does not get the bonus.
    }

    return s;
}

// The exe this app would install into, plus the runners-up so the UI can offer a change.
function chooseExe(gameDir, gameName) {
    const candidates = walkExes(gameDir)
        .map((exe) => ({ exe, s: score(exe, gameDir, gameName) }))
        .filter((c) => c.s > -1000)
        .sort((a, b) => b.s - a.s);

    if (!candidates.length) return null;

    return {
        exePath: candidates[0].exe,
        alternatives: candidates.slice(1, 8).map((c) => c.exe)
    };
}

// One call for the UI: scan, choose an exe for each hit, and drop anything already known.
//
// knownExePaths is what the app already has, so a rescan does not offer duplicates of games the
// user added by hand months ago.
function scanForGames({ extraFolders = [], scanDrives = false, excludedRoots = [], knownExePaths = [] } = {}) {
    const { games, roots } = discover(extraFolders, scanDrives, excludedRoots);

    const known = new Set(knownExePaths.map((p) => String(p).toLowerCase()));
    const found = [];

    for (const game of games) {
        const picked = chooseExe(game.dir, game.name);

        // A folder with no runnable exe is not worth showing. It happens: a library entry for a
        // game that is listed but not installed, or a tool that is not a game at all.
        if (!picked) continue;

        if (known.has(picked.exePath.toLowerCase())) continue;

        found.push({
            name: game.name,
            exePath: picked.exePath,
            alternatives: picked.alternatives,
            dir: game.dir,
            launcher: game.launcher || 'My folders',

            // Steam's own app id, where there is one -- the banner cache can use it directly
            // instead of making the user search for the game by name.
            bannerAppId: game.launcher === 'Steam' ? String(game.id) : ''
        });
    }

    found.sort((a, b) => a.name.localeCompare(b.name));

    return { games: found, roots };
}

module.exports = { scanForGames, chooseExe };
