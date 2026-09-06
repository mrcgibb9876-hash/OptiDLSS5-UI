
const fs = require('fs');
const path = require('path');

const { discover } = require('./library');const NOT_A_GAME_EXE = /^(unins|setup|install|vcredist|dxsetup|dotnet|oalinst|crashpad|launcher_installer)/i;const NOT_THE_GAME = /(launcher|crashreport|crashhandler|redist|touchup|activation|eac|easyanticheat|battleye|be_service|steam_api|dxwebsetup|helper|updater|report|benchmark|editor|server|dedicated)/i;const GOOD_DIRS = /(?:^|[\\/])(binaries[\\/]win64|binaries[\\/]win32|bin[\\/]x64|bin[\\/]win64|bin|x64|win64|game)(?:[\\/]|$)/i;

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
}function score(exePath, gameDir, gameName) {
    const rel = path.relative(gameDir, exePath).toLowerCase();
    const base = path.basename(exePath, '.exe').toLowerCase();

    if (NOT_A_GAME_EXE.test(base)) return -1000;

    let s = 0;    if (NOT_THE_GAME.test(base)) s -= 50;    const nameKey = String(gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseKey = base.replace(/[^a-z0-9]/g, '');

    if (nameKey && baseKey && (baseKey.includes(nameKey) || nameKey.includes(baseKey))) s += 20;

    if (GOOD_DIRS.test(rel)) s += 10;    s -= (rel.split(/[\\/]/).length - 1) * 2;    if (/(?:^|[\\/])singleplayer(?:[\\/]|$)/.test(rel)) s += 4;
    if (/(?:^|[\\/])(?:multiplayer|online)(?:[\\/]|$)/.test(rel)) s -= 4;    try {
        s += Math.min(fs.statSync(exePath).size / (32 * 1024 * 1024), 4);
    } catch {    }

    return s;
}function chooseExe(gameDir, gameName) {
    const candidates = walkExes(gameDir)
        .map((exe) => ({ exe, s: score(exe, gameDir, gameName) }))
        .filter((c) => c.s > -1000)
        .sort((a, b) => b.s - a.s);

    if (!candidates.length) return null;

    return {
        exePath: candidates[0].exe,
        alternatives: candidates.slice(1, 8).map((c) => c.exe)
    };
}function scanForGames({ extraFolders = [], scanDrives = false, excludedRoots = [], knownExePaths = [] } = {}) {
    const { games, roots } = discover(extraFolders, scanDrives, excludedRoots);

    const known = new Set(knownExePaths.map((p) => String(p).toLowerCase()));
    const found = [];

    for (const game of games) {
        const picked = chooseExe(game.dir, game.name);        if (!picked) continue;

        if (known.has(picked.exePath.toLowerCase())) continue;

        found.push({
            name: game.name,
            exePath: picked.exePath,
            alternatives: picked.alternatives,
            dir: game.dir,
            launcher: game.launcher || 'My folders',            bannerAppId: game.launcher === 'Steam' ? String(game.id) : ''
        });
    }

    found.sort((a, b) => a.name.localeCompare(b.name));

    return { games: found, roots };
}

module.exports = { scanForGames, chooseExe };
