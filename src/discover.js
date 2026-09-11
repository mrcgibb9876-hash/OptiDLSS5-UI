
const fs = require('fs');
const path = require('path');

const { discover } = require('./library');
const { resolveUnrealShippingExe } = require('./detect');
// Installers, launchers, anti-cheat helpers, script extenders: never the game itself.
const NOT_A_GAME_EXE = /^(unins|setup|install|vcredist|vc_redist|dxsetup|dxwebsetup|dotnet|dotnetfx|oalinst|crashpad|crashreport|crashhandler|launcher_installer|easyanticheat|eac|battleye|be_service|activation|patch|update|touchup|rapidcrc|autorun|autoplay|quicksfv|readme|config|cleanup|modorganizer|redlauncher|skse\d*_loader|steamerrorreporter|dgvoodoocpl|reshade_setup|gamelaunchhelper)/i;
const NOT_THE_GAME = /(launcher|crashreport|crashhandler|redist|touchup|activation|eac|easyanticheat|battleye|be_service|steam_api|dxwebsetup|helper|updater|report|benchmark|editor|server|dedicated)/i;
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

function walkExes(root, maxDepth = 8) {
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
            } else if (entry.isDirectory() && depth > 0 && !SKIP_DIRS.has(entry.name.toLowerCase())) {
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
    if (NOT_THE_GAME.test(base)) s -= 50;
    const nameKey = String(gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseKey = base.replace(/[^a-z0-9]/g, '');

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
function scanForGames({ extraFolders = [], scanDrives = false, excludedRoots = [], knownExePaths = [] } = {}) {
    const { games, roots } = discover(extraFolders, scanDrives, excludedRoots);

    const known = new Set(knownExePaths.map((p) => String(p).toLowerCase()));
    const found = [];

    for (const game of games) {
        const picked = chooseExe(game.dir, game.name);
        if (!picked) continue;

        if (known.has(picked.exePath.toLowerCase())) continue;

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

module.exports = { scanForGames, chooseExe };
