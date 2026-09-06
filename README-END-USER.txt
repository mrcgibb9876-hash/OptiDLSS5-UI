===========================================
 OptoRenoDXlss5 — Setup Guide
===========================================

WHAT THIS IS
------------
A desktop app for getting NVIDIA DLSS 5 Neural Rendering into your games
through whichever backend a game actually needs: OptiScaler (the DLSS
Neural Rendering / DLSSNR build, with our DLSS 5 Developer Controls UI,
from github.com/mrcgibb9876-hash/OptiScaler_DLSSNR) for games it hooks
directly, or a ReShade-based route (RenoDX, or Deep Fried Chicken via the
DLSS5-Feeder toolchain) for everything else. Instead of manually copying
files into every game folder, you point the app at your games once and
click Install per game.

REQUIREMENTS
------------
- Windows 10/11 (64-bit)
- For DLSS Neural Rendering specifically: an NVIDIA RTX 50-series GPU and
  NVIDIA driver 616.56 or newer. (Older/other GPUs can still use OptiScaler
  for upscaling — the Neural Rendering feature is what needs an RTX 50 card.)
- Internet connection (for pulling the OptiScaler release, banner art, and
  update checks)

------------------------------------------
STEP 1 — Install the app
------------------------------------------
Run the "OptoRenoDXlss5 Setup" installer and follow the prompts. This
installs the app and adds a shortcut to your Desktop and Start Menu.

(A "portable" .exe is also provided if you'd rather not install anything —
just run it directly from wherever you saved it. It stores its data in the
same per-user location either way, so both versions share the same game
list and settings.)

------------------------------------------
STEP 2 — Get the OptiScaler_DLSSNR files
------------------------------------------
Open the app, click "Settings", then either:

  A) Click "Check for Updates" — this downloads the latest release directly
     from the GitHub repo and sets everything up automatically. Easiest
     option, and how you should also pull future updates.

  OR

  B) Manually download the release zip yourself from:
       github.com/mrcgibb9876-hash/OptiScaler_DLSSNR/releases
     Extract it anywhere, then click "Browse" next to "OptiScaler (DLSSNR)
     release folder" and point it at the extracted folder (the one that
     directly contains setup_windows.bat).

------------------------------------------
STEP 3 — Get the NVIDIA DLSS NR model file
------------------------------------------
This is a separate ~165 MB file called "nvngx_dlssnr.dll" that NVIDIA does
NOT include in the OptiScaler release — it comes from an NVIDIA driver
package, and the OptiScaler project's own setup script is explicit that you
have to supply it yourself.

Watch out for a near-identical filename trap the project itself warns
about: the OptiScaler release ships a small ~13 KB file called
"nvngx.dll_dlssnr.dll" (note the DIFFERENT dot placement) — that is NOT the
same file and will not work if used in place of the real one. The real
model file is ~165 MB. The app checks the file size when you set it in
Settings and will warn you if it looks like the wrong one.

Extracting nvngx_dlssnr.dll from an NVIDIA driver package (exact folder
layout can shift between driver versions, so treat this as a starting
point, not gospel):
  1. Download the relevant NVIDIA driver installer (.exe) — don't run it.
  2. Extract it with an archive tool such as 7-Zip (right-click > 7-Zip >
     Extract to...). Driver installers are just archives internally.
  3. Look through the extracted contents for a file named
     "nvngx_dlssnr.dll" (roughly 165 MB). It's typically nested under a
     Display.Driver-type subfolder.
  4. If you get stuck, check the OptiScaler_DLSSNR repo's release notes or
     discussion threads — the maintainer documents current extraction
     steps there, and that guidance is more current than this file.

Once you have it, in the app go to Settings > "Nvidia DLSS NR model file"
and browse to it.

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
have nothing for it to hook.

For those, the card has "Install DLSS 5 Feeder". It runs the DLSS5-Feeder
project's own installer for you and fetches what that needs — ReShade, the
feeder add-on, LumeniteFX, the neural consumer, dgVoodoo2 for the really old
APIs — and writes the settings files in the right order. Progress appears in
the app as it goes.

What it will NOT download is nvngx_dlssnr.dll. That file is NVIDIA's and is
not ours to hand out, so the app passes it the copy YOU supplied in Step 3
and refuses to run if you haven't set one. Same for the RenoDX add-on: point
the app at a copy and it will use it; it won't go and get one.

Coverage this way is DirectX 8, 9, 10, 11, 12, Vulkan and OpenGL — but it is
DLAA only, and the image quality is a step below the OptiScaler path, which
gets real depth and motion data from the game instead of estimating it. Use
OptiScaler where it works and this where it doesn't.

IMPORTANT: never both in the same game -- both would apply the model to the
same frame and the picture will be wrong. From v1.0.1 OptiScaler refuses to
start if it finds the Feeder's add-on already loaded and tells you so in the
panel, but don't rely on that: pick one per game. The app now says which one
each game wants, based on the graphics API it detected.

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
Windows Settings > Apps > "OptoRenoDXlss5" > Uninstall (or use the
uninstaller shortcut in its Start Menu folder). This only removes the
manager app — it does not touch any files already copied into your games.
