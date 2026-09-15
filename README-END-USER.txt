===========================================
 OptiDLSS5-UI -- Setup Guide
===========================================

WHAT THIS IS
------------
An app that puts NVIDIA DLSS 5 Neural Rendering into your games. Add your
games, press Install, play. The app works out what each game needs.

YOU NEED
--------
- Windows 10/11, 64-bit
- An NVIDIA RTX card (20 to 50 series) and driver 616.56 or newer
- Internet on first launch (the NR model file and cover art)

------------------------------------------
1. INSTALL THE APP
------------------------------------------
Run "OptiDLSS5-UI Setup". (A portable .exe also works; both share the same
game list.) Everything else -- the OptiScaler engine and the ~165 MB DLSS NR
model file -- is set up automatically, and kept current on its own.
"Check for Updates" in the top bar checks right away.

------------------------------------------
2. ADD YOUR GAMES
------------------------------------------
Click "Scan for Games": it finds Steam (every library), Epic and GOG games
and picks the right .exe for each. Tick the ones you want, click Add.
Or "+ Add Game" and browse to the .exe yourself.

------------------------------------------
3. INSTALL INTO A GAME
------------------------------------------
Click "Install" on the card. That's it -- the app sets up whatever that
game needs (for a game without DLSS of its own, that includes the DLSS5
Feeder). Games with both DX12 and DX11 are set up for DX12.

Then "Launch", play a minute of actual gameplay, and quit. The card shows
what the run did.

------------------------------------------
4. IN THE GAME
------------------------------------------
  Alt+Home   DLSS 5 panel (move it by dragging, resize from an edge)
  Insert     OptiScaler's own menu (Alt+O on Resident Evil / RE Engine games)
  Home       ReShade (games using the Feeder)

32-bit games show no menu over the game: press Home > Add-ons >
DLSS 5 Feed > "Show the DLSS 5 panel in-game", then Insert. Or change the
same settings in the app: Edit > DLSS 5.

------------------------------------------
5. IF SOMETHING ISN'T RIGHT
------------------------------------------
Click "Game Help" on the card. It reads the game's logs and tells you what
to do in a few steps -- often one "Fix it" button. Common ones:
  - "NVIDIA driver too old for DLSS 5": update the driver, restart.
  - "Another DLSS 5 tool is in the folder": Fix it removes it.
  - "Play the game once": launch, reach gameplay, quit, check again.

Still stuck: Game Help > More... > "Save bundle to share", then
"Report on GitHub" and attach the zip.

------------------------------------------
FRAME GENERATION
------------------------------------------
- Games with DLSS Frame Generation: Edit > Frame Generation.
  RTX 40/30 cards get RTXMFG there (3x-6x); press Backspace in game.
- Games without DLSS: Lossless Scaling (a separate paid Steam app) can be
  configured per game. Turn on Settings > "Show advanced options" to see it.
  It needs borderless or windowed mode.

------------------------------------------
REMOVING
------------------------------------------
"Remove" on a card takes out everything the app put in that game and
restores anything it replaced.

Anti-cheat games: the app starts them without their anti-cheat, so play
offline only, and press Remove before going online.

Uninstall the app: Windows Settings > Apps > OptiDLSS5-UI. That leaves your
games as they are -- press Remove on each game first if you want them clean.
