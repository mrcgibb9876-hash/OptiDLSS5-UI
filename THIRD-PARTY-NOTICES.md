# Third-party notices

OptiDLSS5-UI itself is proprietary -- see [LICENSE](LICENSE). The components below are the work of
others and stay under their own licences; nothing in OptiDLSS5-UI's licence limits the rights they
grant.

## Included in OptiDLSS5-UI

### DLSS5-Swapper -- MIT

`src/library.js` is taken verbatim from [DLSS5-Swapper](https://github.com/rakanki911/DLSS5-Swapper),
and the app's original install core was ported from it; so were the emulator profile table
(`src/emulators.js`), the 32-bit helper layout and the dgVoodoo2 pin and settings (`src/legacy.js`).
Copyright (c) 2026 Rakan Alkhaldi. Full licence text:
[third_party/DLSS5-Swapper-LICENSE.txt](third_party/DLSS5-Swapper-LICENSE.txt).

DLSS5-Swapper's emulator table is in turn based on the MIT-licensed detection table in
[DLSS5-Autopilot](https://github.com/Kizzuwatnaa/DLSS5-Autopilot) (core/emulators.py) by Kizzuwatnaa.

### Electron and its dependencies

The installer is built with [Electron](https://www.electronjs.org/) (MIT), which bundles Chromium
and Node.js. Their licence texts ship with the installed app (`LICENSE.electron.txt`,
`LICENSES.chromium.html`). npm dependencies packaged into the app, such as `electron-updater`
(MIT), carry their licence files inside the package.

## Downloaded or bundled as separate programs

### OptiScaler_DLSSNR -- GNU GPL v3.0

The OptiScaler engine the app installs into games, bundled beside the app and kept current from
its releases. It is a separate program under the GPL-3.0. Every release at
https://github.com/mrcgibb9876-hash/OptiScaler_DLSSNR-releases/releases carries its complete
corresponding source as `OptiScaler_DLSSNR-<tag>-source.zip` (the engine bundled with an app release
is the one named by that release's `OptiScaler_DLSSNR-<tag>.zip` asset). It is built on
[OptiScaler](https://github.com/optiscaler/OptiScaler).

Its Present route and depth tracker (DLSS 5 on games with no DLSS call) follow the design of
[DXL (DLSS eXtended Loader)](https://github.com/LCPD15/DXL) by LCPD15, AGPL-3.0; the engine carries
the attribution in `Licenses/DXL_ATTRIBUTION.txt`.

### Fetched at runtime, never shipped

Each is downloaded from its own official source when a game needs it, under its own terms, as
listed in the README's credits table: RHI's manifest and packages (Streamline, DLSS, the DLSS NR
model), REFramework (MIT), the DLSS5 Feeder (MIT), ReShade (BSD 3-Clause), motion-vector shaders,
Luma-Framework, dashdogy's RTXMFG (MIT, only when Install is pressed for a game), and dgVoodoo2 (Dege's
freeware, from its official GitHub release, only after the user agrees). PureDark's
Upscaler Base Plugin is never downloaded or shipped by the app, and since the engine's Present route
it is no longer placed into games either.
