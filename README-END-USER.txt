===========================================
 OptiScaler Manager — Setup Guide
===========================================

WHAT THIS IS
------------
A desktop app for installing OptiScaler (the DLSS Neural Rendering / DLSSNR
build, with our DLSS 5 Developer Controls UI, from
github.com/mrcgibb9876-hash/OptiScaler_DLSSNR) into your games. Instead
of manually copying files into every game folder, you point the app at your
games once and click Install per game.

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
Run "OptiScaler Manager Setup.exe" and follow the prompts. This installs the
app and adds a shortcut to your Desktop and Start Menu.

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
Click "+ Add Game", browse to the game's .exe, give it a name, and either
search Steam for matching cover art or use a local image. Click Save.

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
either in the OptiScaler in-game overlay ("DLSS Neural Rendering" toggle)
or by setting Enabled=true under the [DlssNr] section of the game's
OptiScaler.ini.

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
Windows Settings > Apps > "OptiScaler Manager" > Uninstall (or use the
uninstaller shortcut in its Start Menu folder). This only removes the
manager app — it does not touch any files already copied into your games.
