===========================================
 OptiDLSS5-UI — Setup Guide
===========================================

WHAT THIS IS
------------
A desktop app for getting NVIDIA DLSS 5 Neural Rendering into your games
through OptiScaler (the DLSS Neural Rendering / DLSSNR build, with our DLSS
5 Developer Controls UI, from
github.com/mrcgibb9876-hash/OptiScaler_DLSSNR). Instead of manually copying
files into every game folder, you point the app at your games once and
click Install per game.

REQUIREMENTS
------------
- Windows 10/11 (64-bit)
- For DLSS Neural Rendering specifically: an NVIDIA RTX 50-series GPU and
  NVIDIA driver 616.56 or newer. (Older/other GPUs can still use OptiScaler
  for upscaling — the Neural Rendering feature is what needs an RTX 50 card.)
- Internet connection on first launch (for the DLSS NR model file, banner
  art, and update checks). The OptiScaler engine itself ships inside the
  installer, so it needs no download.

------------------------------------------
STEP 1 — Install the app
------------------------------------------
Run the "OptiDLSS5-UI Setup" installer and follow the prompts. This
installs the app and adds a shortcut to your Desktop and Start Menu.

(A "portable" .exe is also provided if you'd rather not install anything —
just run it directly from wherever you saved it. It stores its data in the
same per-user location either way, so both versions share the same game
list and settings.)

------------------------------------------
STEP 2 — The OptiScaler_DLSSNR engine (automatic)
------------------------------------------
Nothing to do. The engine build this app was released with ships inside
the installer, and the app unpacks it the first time it opens — no second
download, no second repo. After that, Settings > "Check for Updates" keeps
it current from GitHub (and the app also checks on its own at launch).

If you ever want a different build, the same zip is attached to this app's
GitHub release as OptiScaler_DLSSNR-<version>.zip: extract it anywhere and
point Settings > "OptiScaler (DLSSNR) release folder" at the folder that
directly contains setup_windows.bat.

------------------------------------------
STEP 3 — The NVIDIA DLSS NR model file (automatic)
------------------------------------------
This is a separate ~165 MB file called "nvngx_dlssnr.dll" that NVIDIA only
ships inside driver packages. The app fetches it for you on first launch
(you'll see a toast while it downloads) and sets it in Settings > "Nvidia
DLSS NR model file". Settings also has a "Fetch automatically" button if
you ever need to redo that.

Prefer your own copy? Browse to it instead. Watch out for a near-identical
filename trap: the OptiScaler release ships a small ~13 KB file called
"nvngx.dll_dlssnr.dll" (note the DIFFERENT dot placement) — that is NOT
the model and will not work. The real one is ~165 MB; the app checks the
size and warns if it looks wrong. To extract it from a driver yourself:
download the NVIDIA driver installer (.exe) without running it, open it
with 7-Zip, and look for nvngx_dlssnr.dll (usually under a Display.Driver
subfolder).

------------------------------------------
STEP 4 — Add your games
------------------------------------------
Easiest: click "Scan for Games". The app reads your Steam libraries (all of
them, on every drive), plus Epic and GOG, and works out which .exe in each
game folder is the one that actually renders — skipping launchers, crash
reporters and anti-cheat wrappers. Tick everything you want and click Add.

If a game lives somewhere it can't see, "Add a folder" points it at that
folder, and there's a "also scan my other drives" checkbox for a full sweep.
That one is off by default because on a big library it takes a while.

It suggests; you confirm. If it picks the wrong .exe for a game, the card
lets you switch to another one it found.

Still there if you prefer it: "+ Add Game", browse to the .exe yourself,
name it, and pick cover art (search Steam, or use a local image).

------------------------------------------
STEP 5 — Install into a game
------------------------------------------
On the game's card, click "Install / Update". This copies the OptiScaler
files and the NR model file into the game's folder. The badge on the card
will read:
  - "Installed"                → both OptiScaler and the NR file are present
  - "Missing NR file" / "Missing OptiScaler files" → one half didn't copy
  - "Not installed"            → nothing copied yet
  - "Exe missing"              → the game .exe path is no longer valid

Then click "Run Setup" — this opens the OptiScaler installer's own console
window in that game's folder. It asks its own configuration questions
directly in that window; answer them there. It will also tell you whether
Neural Rendering can actually run on your system.

By default, DLSS Neural Rendering is OFF even after install. Turn it on
either in the in-game panel or by setting Enabled=true under the [DlssNr]
section of the game's OptiScaler.ini.

Two panels, two keys, and both can be open at once:

  Insert     OptiScaler's own overlay
  Alt+Home   the DLSS 5 Developer Controls panel

Both are rebindable from the panel itself, which is worth doing if a game
already uses one of them for something.

(If you are on v1.0.0, the panel is on plain Home. It moved in v1.0.1
because Home is a key too many games already use.)

------------------------------------------
STEP 6 — Games OptiScaler can't reach
------------------------------------------
OptiScaler works by intercepting the game's own upscaler, so it needs the
game to have one: it covers DirectX 12, Vulkan, and DirectX 11. Older games
(DirectX 8, 9 or 10, or OpenGL) have nothing for it to hook, and this app
has no other backend for those — the card will say "Not supported" rather
than offer an install that can't work.

------------------------------------------
FRAME GENERATION FOR GAMES WITH NO DLSS OF THEIR OWN
------------------------------------------
Some games have no native DLSS at all — the app deploys the DLSS5 Feeder
for those (see the Edit Game screen; it explains itself there). OptiScaler's
own Frame Generation (FSRFG) can't run together with the Feeder — it
crashed on a real test, not a guess — and needs a D3D12 game either way.

For any game at all — Feeder games, DirectX 11 games, or simply where you
prefer it — the app can set you up with Lossless Scaling as the Frame
Generation source. Lossless Scaling is a SEPARATE PAID APP you need to
own yourself:

  https://store.steampowered.com/app/993090/Lossless_Scaling/

This app does not install it and does not include it — Steam is where
you get it. Once you own it, in the Edit Game screen under "Frame
Generation via Lossless Scaling":

  1. Pick a mode:
       Fixed multiplier  — every real frame becomes 2x/3x/4x frames.
       Adaptive          — set a target FPS; Lossless Scaling generates
                           only as many frames as it takes to hold it.
  2. Click "Configure for this game" — this sets up its per-game profile.
  3. Click "Launch Lossless Scaling" once, so it's running.

After that, the on/off toggle (and the amount, in Fixed mode) lives in
that game's own DLSS 5 Developer Controls panel (Alt+Home) — no need to
alt-tab out during play. In Adaptive mode the panel shows the target it
is holding; change the target here in the app.

Lossless Scaling needs the game running Borderless or Windowed, NOT
exclusive Fullscreen — it can't capture an exclusive-fullscreen window at
all, which is a limitation on its own side. A DirectX 12 game is usually
fine either way, since DirectX 12 doesn't have true exclusive fullscreen.

------------------------------------------
UPDATING OPTISCALER LATER
------------------------------------------
Settings > "Check for Updates" pulls the newest release automatically.
After updating, re-run "Install / Update" on any games you want the new
version copied into.

------------------------------------------
UNINSTALLING A GAME'S OPTISCALER FILES
------------------------------------------
Open the game's folder (the "Open Folder" button on its card) and run the
uninstaller batch file that OptiScaler's own setup generated there.

------------------------------------------
UNINSTALLING THE APP ITSELF
------------------------------------------
Windows Settings > Apps > "OptiDLSS5-UI" > Uninstall (or use the
uninstaller shortcut in its Start Menu folder). This only removes the
manager app — it does not touch any files already copied into your games.
