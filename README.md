# OptoRenoDXlss5

A Windows desktop app for getting NVIDIA's DLSS 5 Neural Rendering into your games, through
whichever of two backends a given game actually needs: the
[OptiScaler_DLSSNR](https://github.com/mrcgibb9876-hash/OptiScaler_DLSSNR) build of OptiScaler for
games it hooks directly, or a ReShade-based route (RenoDX, or Deep Fried Chicken via the
DLSS5-Feeder toolchain) for everything else.

Instead of copying files into every game folder by hand and running a setup script in each one, you
point the app at your games once and click Install.

> **Users:** [README-END-USER.txt](README-END-USER.txt) is the step-by-step setup guide, and it
> ships inside the installer as `README.txt`. This file is about how the app works and why.

## What it does

**Finds your games.** Reads Steam's `libraryfolders.vdf` (so every Steam library on every drive),
the Epic and GOG registry entries, and — on request — every fixed drive on the machine. You can add
folders by hand and exclude ones you never want walked. For each game folder it picks the executable
to install beside, scoring on name match, the directory a shipping binary tends to live in, and how
deep it sits, and penalising launchers, crash reporters, updaters and anti-cheat wrappers. It
proposes; you confirm before anything is written.

The drive scan is off by default. On a 4 TB library it takes real time, so it belongs behind a
checkbox you tick rather than on first run.

**Installs OptiScaler per game.** Copies the release files and your NR model file into the game
folder, tracks what's installed against what's current, and re-runs OptiScaler's own setup script
in a console you confirm yourself.

**Installs the DLSS 5 Feeder toolchain**, for games OptiScaler can't reach. See below.

## Two paths, and which game gets which

OptiScaler intercepts the game's own upscaler — NVNGX, FSR or XeSS — and hands the neural model a
properly labelled depth buffer, motion vectors, motion-vector scale, reset flag and pre-exposure
straight from the parameter block. It is the accurate path, and it covers **D3D12 natively, Vulkan
(natively and through the VkOnDx12 bridge), and D3D11 through the Dx11wDx12 bridge**. There is no
D3D9 or D3D10 code in OptiScaler and there isn't going to be — those APIs have nothing to
intercept.

[DLSS5-Feeder](https://github.com/jlrouzies-fr/DLSS5-Feeder) covers the rest by building a synthetic
DLAA contract from ReShade's depth buffer and estimated optical-flow motion vectors, on a private
D3D12 device. That is guesswork where OptiScaler has ground truth, and it is DLAA-only — but it
reaches **D3D8 and D3D9 through dgVoodoo2, D3D10 natively (32-bit), D3D11, D3D12, Vulkan and
OpenGL**.

So: OptiScaler where it fits, the Feeder where it doesn't.

**Never both in the same game.** If OptiScaler and the Feeder are both active in one process, both
apply the model to the same frame. Since OptiScaler v1.0.1 it refuses to start when it finds
`renodx-dlss5.addon64` or `dlss5-feed.addon64` already loaded, and says so in the panel — but that
is a backstop, not permission: pick one path per game and the app now tells you which.

## Dependencies: what the app fetches, and the one thing it won't

The Feeder ships its own `tools/Install-DLSS5Feeder.ps1`, and that script already fetches and wires
up everything: ReShade, the feeder add-on, LumeniteFX for motion vectors, the neural consumer,
dgVoodoo2, and the `.ini` files with the techniques enabled in the right order — merging rather than
replacing, backing up what it touches, and verifying at the end.

So the app drives that script instead of reimplementing it. Writing our own downloader for the same
set would mean owning a list of URLs its author changes whenever a dependency moves, and being
silently wrong about it inside your game folder.

It is pinned to the newest tagged release rather than whatever last landed on `main`, written to a
fresh directory, checked, hashed, and re-checked immediately before it runs. The hash is printed in
the log so you can say exactly what ran.

**The NVIDIA runtime is the exception.** That script sources `nvngx_dlssnr.dll` and `nvngx_dlss.dll`
from Discord CDN attachments. Those come out of a driver, they are NVIDIA's, and they are not ours
to redistribute — which is the same reason `package_release.ps1` leaves them out of the OptiScaler
release and the notes tell you to supply your own.

So the app passes `-DlssNrDll` / `-DlssDll` pointing at the copies you already gave it (the path in
Settings, or extracted from a Streamline zip). Handed local paths, the script uses them and never
reaches for Discord. **If you haven't supplied `nvngx_dlssnr.dll`, the app refuses to run the
install** rather than quietly fetching one on your behalf. When it can't supply `nvngx_dlss.dll` it
says so in the log instead of letting you find out later.

The RenoDX add-on is the same call for a different reason — closed-source and distributed over
Discord. The app will use a copy you point it at; it won't go and get one.

### When the installer changes under us

The newest release is re-resolved on every run, so the script can change between one install and the
next. The app reads the `param()` block of the copy it just downloaded and checks its arguments
against it. An argument that release no longer takes is dropped, with a warning. If `-GameExe` or
`-DlssNrDll` has been renamed or removed, the run is **refused** — silently losing `-DlssNrDll`
would mean the script going and fetching NVIDIA's DLL itself, which is the one outcome that must
not happen by accident.

## In-game keys

| | |
|---|---|
| **Insert** | OptiScaler's own overlay |
| **Alt+Home** | the DLSS 5 Developer Controls panel |

Both are rebindable, and both panels can be open at once. The panel moved off bare `Home` in
v1.0.1 because `Home` collided with too many games; v1.0.0 still uses it.

## Building

```
npm install
npm start          # run it
npm run dist       # NSIS installer + portable .exe, into dist/
```

Electron 33, Windows x64. No native modules.

## Credits and licensing

`src/library.js` is taken verbatim from [DLSS5-Swapper](https://github.com/rakanki911/DLSS5-Swapper)
— MIT, Copyright (c) 2026 Rakan Alkhaldi. The licence text is kept alongside it in
[LICENSE-DLSS5-Swapper.txt](LICENSE-DLSS5-Swapper.txt); keeping that notice is the whole of what MIT
asks. It is held byte-identical to its upstream so it can be refreshed without a merge — the
adaptation for this app lives in `src/discover.js` instead.

[DLSS5-Feeder](https://github.com/jlrouzies-fr/DLSS5-Feeder) by jlrouzies-fr, driven through its own
installer, not vendored.

[OptiScaler](https://github.com/optiscaler/OptiScaler) is the upstream this all rests on.
