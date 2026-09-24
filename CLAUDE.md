# Notes for Claude

## The two repos are coupled

- **OptiDLSS5-UI** (this repo) is the Electron manager. Plain-script renderer, no bundler.
- **OptiScaler_DLSSNR** is the engine fork. Default branch `dlss5-developer-controls-ui`, not `master`.

A manager release **bundles the exact engine release pinned in `package.json` → `engineVersion`**
(e.g. `"v1.0.41"`), never "latest", so the same commit always builds the same manager + engine pair.
To ship a new engine with the manager:

1. Release the engine first (its own `release.yml`) and wait for the release and its `.zip` to publish.
2. Bump `engineVersion` in `package.json` to that exact tag, in the same commit as (or before) the
   manager version bump. `test/engine-pin.test.js` rejects anything that is not an exact `vX.Y.Z` tag.
3. Release the manager. Both use a `workflow_dispatch` on `release.yml` whose tag must match the
   version already on the default branch.

The manager workflow's `engine_tag` input overrides the pin for a one-off build. The workflow fails
if the pinned tag has no `.zip` asset or resolves to a different tag. It never falls back to
"latest". A draft engine release is not visible to the workflow, so publish it (or mark it a
pre-release) before pinning to it.

The running app's engine updater (`update:check` in `main.js`, `engines.js`) follows the same pin: it
offers `engineVersion`, and only *reports* a newer "latest" as untested with this app version.

## Downloads are checked (src/integrity.js)

Every file the app downloads and places is checked against a sha256 before use:

- **Fixed URLs** (the ReShade installer, VORT, the ReShade headers, LumeniteFX, dgVoodoo2, DXVK)
  are pinned in `PINS`. The text files are fetched from a pinned **commit**, not a branch.
- **GitHub release assets** are checked against the `digest` GitHub publishes for them.

Bumping any pinned download means re-hashing it in `integrity.js`. `test/integrity.test.js` fails if a
fixed URL loses its pin. Tests that serve or cache a stand-in for a pinned URL use `pinFixture()` from
`test/helpers.js`.

## Issue triage

`.github/workflows/triage.yml` labels new reports (`game-help`, `route:<id>`, `crash`) and closes a
`needs-info` issue once our last question has gone 14 days unanswered. It never closes
`fixed-in-next-release`. The logic is in `tools/triage/triage.js`, tested in `test/triage.test.js`.

## Frame pacing (ReLimiter) is one or the other with our FPS targeting

`src/relimiter.js` places ReLimiter, a frame-pacing ReShade add-on for VRR displays
(RankFTW/ReLimiter; Mat, Laz, Rank). It is **MIT**, which is the only reason this app may carry and
place a third-party binary at all -- Deep Fried Chicken, LumeniteFX, the AMD installer and ReShade
itself each forbid exactly that, and the MIT notice travels with the binary.

- **ReShade is not optional and must not be forked out.** ReLimiter is *driven* by ReShade's events
  (`init_device`, `init_swapchain`, `set_fullscreen_state`, and `present`, which is the limiter's
  heartbeat); its `DoInit` returns false outright with no ReShade module in the process. The
  arrangement is `feeder.js`'s, unchanged: OptiScaler keeps the proxy slot, ReShade goes down as a
  plain non-proxying `ReShade64.dll`, and `[Plugins] LoadReshade=true` makes OptiScaler load it. That
  condition in `autoConfigureGame` is no longer Feeder-only. It is deliberately **separate** from
  `dlss5Only`: a frame pacer is not an upscaler, and turning on pacing must not cost the user theirs.
- **ReShade + any add-on + OptiScaler upscaling on the game's own device = crash** (Shadow of the Tomb
  Raider, 2026-09-24: 0xC0000005 in ReShade64.dll under `DLSSFeatureDx12::InitDLSS`). OptiScaler
  captures the D3D12 device beneath ReShade, DLSS records raw-device resources into ReShade's wrapped
  command list, and ReShade's add-on descriptor tracking dies on them. No add-on = no crash; Generic
  Depth alone crashes too; `CreateD3D12DeviceForLuma` and ReShade's standard build do not help. The
  Feeder never meets it because its DLSS runs on a private device. So:
- **Where pacing goes** (`relimiter:install`): a Feeder game (plain `ReShade64.dll` + `LoadReshade=true`);
  a game with no OptiScaler (ReShade becomes the game's own proxy: `dxgi.dll`, `d3d9.dll` on DX9;
  `promoteToStandalone`, recorded as `reshadeProxy`); a Chicken game. A non-Feeder game WITH OptiScaler
  is refused (`reshade-dlss-crash`), and `game:install` on a game with pacing removes pacing there
  (`pacingRemoved`) -- on a Feeder game it demotes the standalone ReShade instead. The Chicken swap
  calls `demoteStandaloneReShade` first so two proxies never meet;
  Chicken -> the add-on joins Chicken's ReShade (`dfc.reshadeProxyOf`), which pacing never moves or
  deletes. A `ReShade64.dll` pacing placed is recorded (`reshadePlaced`) so `switchToDfc` takes it over
  like the Feeder's (`reshadeIsOurs`). Proxy files are identified by PE OriginalFilename
  (`isReShadeProxy`), never `feeder.isReShadeDll` -- OptiScaler.dll contains the string "ReShade" too.
- **The binary comes from the fork's latest release first** (only its build exports `ReLimiterGetApi`,
  without which the engine's Pacing page stays hidden), then upstream RankFTW/ReLimiter.
- **`[DlssNr] AutoScale` with `AutoScaleMode=2` and ReLimiter together destroy the image.** Mode 2
  ("Aim at -> Frame rate") is a closed loop that moves the NR model's working resolution to reach an
  FPS target; ReLimiter holds FPS by sleeping, so the target never reads as met and the model sheds
  resolution forever. Neither feature looks broken. `relimiter.nrConflict` detects that exact pair
  and `autoConfigureGame` turns `AutoScale` off as a forced setting. Modes 0 and 1 are **cost**
  budgets, not FPS chasing, and are left alone. The engine's Pacing page carries the same note.
- **Vulkan is refused, not guessed.** ReShade runs there only as a machine-wide implicit layer that
  its own installer registers under HKLM, attaching only to exes in `ReShadeApps.ini`, and this app
  can write neither -- so `missing()` returns `vulkan-layer-registration` however many files are in
  the folder.
- The add-on is identified by **content** (a PE header, over a size floor, carrying both `ReLimiter`
  and `AddonInit`), never by file name, the same rule `isAddonReShadeDll` follows. "Complete" needs
  the **Add-on** build of ReShade: the plain build carries the same version and product name and
  simply never loads an add-on. Remove takes back the add-on and our marker and leaves ReShade alone.
- The engine reads the add-on through the host API on the fork
  (`mrcgibb9876-hash/ReLimiter`, `ReLimiterGetApi`, vendored as `dlssnr/ReLimiter_Api.h`), and the
  Pacing page draws itself from `describe_setting` rather than a table -- so a new add-on setting
  appears in the overlay with no engine change. That API has **not** been offered upstream yet.

## Keep the library fast

`test/perf-library.test.js` syncs a 50-game fake library three times and fails if a pass exceeds its
time budget, if a later pass re-reads any game exe (detection not served from `detectGameCached`), or
if any process is started per game folder. Those are the two v1.59.0 regressions (uncached
`detectGame`, a `powershell.exe` per folder). If it fails, fix the per-game work rather than raising
the budget.

## Do not ship a guessed D3D12 resource state as a default

Worth reading before touching the NR pass's barriers, because this already went wrong once.

The NR pass has to assume the target texture's arrival state, since D3D12 cannot be asked for it.
Engine **v1.0.21 changed that default to `RENDER_TARGET` on the Feeder route**, reasoning that the
resource comes from ReShade. It was a guess, made from an inference in jlrouzies-fr/DLSS5-Feeder#104
that the Feeder's author had explicitly not claimed to have proven, and it shipped in manager
v1.58.0.

It was wrong, and it **broke a Feeder game that had been working**: Batman: Arkham Knight then
failed `Close()` with `E_INVALIDARG` on the first frame after SR and the Feeder stopped. Engine
commit `d66cc0f` put the default back: NGX writes its output as a UAV on every route. The same
build ran 1,200 frames clean with `OutputResourceBarrier=8`, and on auto after the revert.

Two lessons:

- A wrong `StateBefore` does not fail locally. It poisons the **caller's** command list, so the
  symptom lands on whoever owns the frame, not on the code that guessed.
- `[Hotfix] OutputResourceBarrier` is where a hypothesis about this belongs. It overrides the
  default without a rebuild, so a theory can be tested on one machine before it becomes everyone's
  default.

Armored Core VI, the game behind #104, no longer uses the Feeder at all: it takes the engine's
Present route now.

## Open: permission to fetch the AMD installer

**danielblnc/DLSS-NR-on-AMD#151** asks whether the manager may fetch that installer live from the
release page, and for a silent-install switch. Still open, **no reply as of 2026-09-16**.

The GitHub API is blocked for that repo in these sessions, so read it with WebFetch. Any scheduled
check-in for it is bound to the session that created it and dies with that session, so re-arm one if
it still matters.

Until there is an answer the app must not download it. Its licence forbids bundling and
redistribution, so the manager only links to the release page and fetches the model file.

## Gotchas that have already cost time

- **A wrapper can fail without crashing, and the rule table used to miss that.** Assassin's Creed II
  (2026-09-18) black-screened under dgVoodoo2 with the game still **running** -- nothing faulted, so
  `wrapper-crash` could never fire, and `no-dlss` on a legacy route fell through to "no known fix".
  The answer was DXVK: Vulkan instead of Direct3D 11, and OptiScaler hooks that. Two things came out
  of it -- `gamehelp.js` now offers the swap when dgVoodoo2 is ours and a run had no DLSS in it at
  all, and Game Help's More row has a **Try DXVK instead** button, because the swap had been
  reachable *only* from the crash verdict. A feeder32 route still has to be `complete` before any
  run-based rule is reached (`gamehelp.js:83`), which is right: an unfinished stack explains "no
  DLSS" better than the wrapper does.
- **An ASI loader makes every proxy-DLL finding a guess.** This app installs OptiScaler under a
  proxy DLL name (`HOOK_DLLS`) and reads a game folder by those names, so it cannot see a thing an
  `.asi` loads. S.T.A.L.K.E.R. GAMMA (#108, 2026-09-22) cost a whole diagnosis before the reporter
  said he loads ReShade and OptiScaler as `.asi` and that the `dxgi.dll` the app had fixed on was
  leftover clutter from a reinstall. `detect.inspectAsiPlugins` now lists `*.asi` in the folder,
  `plugins/` and `scripts/`, and names any that carry the OptiScaler or ReShade string;
  `DETECT_VERSION` went to 17 so stored detections do not keep the blind answer. An OptiScaler in an
  `.asi` is never ours -- the app has no code that installs one that way -- so it is the same finding
  as `foreign-optiscaler`, under the code `asi-optiscaler`. Where there is a loader but no upscaler
  in it, `no-hook` becomes `asi-loader-blind`: an honest "this app cannot see what they load" beats
  a confident verdict about the wrong file. Actually *supporting* an ASI install (deploying our
  OptiScaler as a plugin, and reading one back as ours) is not done and was promised only as a
  "if we can".

- **reshade.me publishes only ReShade's CURRENT version, so one pinned URL is a time bomb.**
  `/downloads/ReShade_Setup_<ver>_Addon.exe` stops existing the day the next version ships. A single
  pin meant every *fresh* Feeder install on every machine would 404 at the same step at once, while
  machines that had already deployed once carried on from cache and noticed nothing -- invisible to
  us, total for anyone new. `feeder.RESHADE_SETUPS` is therefore a **list** of known versions, each
  hash-pinned in `integrity.js`; `ensureReShadeSetup()` tries the cache, then a copy the user
  supplied, then each known version. Adding the next version is one line plus its sha256. A hash
  that does not match is still refused -- resilience never means installing something unidentified.
  `importReShadeSetup()` takes a user's own setup and validates it by the **export table** of the
  ReShade64.dll inside (`isAddonReShadeDll`), never by its file name: the plain and Add-on builds
  carry the same version and product name, and the plain one deploys cleanly and then never loads
  the Feeder.
  **The mirror question is closed -- do not reopen it.** Checked 2026-09-22: `crosire/reshade`
  publishes **no releases and no binary assets** (source only), so there is no official second host.
  reshade.me's own terms are *"do not redistribute binaries or shader packs"* -- point people at a
  legitimate download page. Third-party archives exist (reshade.mudrunner.net mirrors 40 add-on
  builds with checksums; FileHorse, Uptodown; and the SEO clones reshade.cc / reshade.dev /
  reshade.pro), but each redistributes against that, and an unofficial rehost of an injector DLL is
  the obvious place to plant a modified one -- the pin would catch that, but it would not make the
  dependency right. Same position as Deep Fried Chicken and the AMD installer. The user-supplied
  copy is the only correct fallback.
  Also note what the version list can and cannot do: reshade.me drops a version the moment the next
  ships, so an **older pin is no safer than the current one**. The list makes our fix a one-line
  release; it does not rescue a client already in the field. Only the cache and a user's own copy
  do that.
  **The handoff when a download fails** (`ensureReShadeSetupOrAsk` in main.js): say which host failed
  and why, point at `https://reshade.me/` with a Copy button, and then **find what they downloaded**
  in Downloads or on the Desktop (`findDownloadedReShadeSetups` / `adoptDownloadedReShadeSetup`),
  check it is the Add-on build and carry on. The user clicks a link and saves a file; no path to
  type, nothing to place. A **browser** usually succeeds where this app's fetch does not, because
  Node ignores the system proxy a VPN or DPI-bypass tool sets up. Same shape as `pdplugin.js`'s
  handoff for PureDark's plugin -- copy that, do not invent a new one.
  Test trap: a fixture setup .exe must be filled with **random** bytes. A zip of zeros deflates to
  a couple of KB and falls under the 1MB floor that rejects a part-finished download, so the
  fixture silently tests nothing.
- **`fetch failed` is Node's, not ours, and it hides everything.** undici throws that bare string for
  DNS, a reset, a refused connection or a timeout, with the real reason in `error.cause`.
  `feeder.describeFetchFailure()` unwraps it and names the host. A Fallout: New Vegas user
  (2026-09-22) burned a day on those two words. The proxy half of that is fixed too -- see the
  `src/net.js` note above -- so a VPN or bypass tool now applies whether it is a TUN adapter or a
  local proxy; before that it only ever worked as a TUN adapter.
- **Revo Uninstaller's "additional folders" sweep can empty `%APPDATA%\OptiDLSS5-UI\feeder-cache`.**
  `downloadToCache` returns a cached file with **no network at all**, so a wiped cache turns a
  marginal network into a total install failure. A user can drop the right file into that folder by
  hand and the hash check will accept it.

- **Every download goes through `src/net.js` (`netFetch`), not Node's `fetch`.** Node's fetch ignores
  the Windows system proxy entirely -- no `ProxyAgent`, nothing reads `HTTPS_PROXY` -- so a VPN or
  DPI-bypass tool that works as a **proxy** rather than a virtual adapter does nothing for this app
  while the user's browser sails through. Electron's `net.fetch` runs on Chromium's stack, which
  reads the system proxy (PAC and WPAD included) and the OS certificate store. `test/net-proxy.test.js`
  fails if any downloader goes back to `fetchImpl = fetch` or a bare `await fetch(`.
  **The trap that cost an hour:** `require('electron')` must sit behind a `process.versions.electron`
  guard and never at module scope. Outside Electron the package is still on disk as a devDependency,
  and requiring it both returns a useless path *string* and poisons Node's per-(parent, request)
  resolution cache -- after which `test/helpers.js`'s electron stub stops being reachable and every
  `loadMain` throws on `ipcMain`. Seven tests went red on that, and making the require lazy was not
  enough: the first download in a file still triggered it.
- **The release title is derived from the tag.** It used to be a *required* `workflow_dispatch`
  input whose default was the literal `"OptiScaler Manager v1.1.0"`, and since nobody ever passed
  one, every release inherited it -- v2.3.23 shipped under that title, on the GitHub release page
  and on the Discord card. Leave the `title` input empty and the release is named after the tag; a
  title naming a *different* version is refused outright. A version written by hand in a second
  place is a version that goes stale.

- **Nexus Mods is blocked by the egress proxy**, so a mod page's comments -- often the richest source
  on a specific game -- cannot be read from a session. The OptiScaler wiki and its issues can.
  **discord.com is blocked too** (confirmed 2026-09-21), which matters more than it sounds: several
  tools in this space are handed out only through Discord, so a link to a message there is unreadable
  from a session no matter how relevant. Ask the user to paste the contents.
- **Deep Fried Chicken: no public download, and its licence forbids the app shipping it.** It is
  Alexander's neural consumer, the alternative to our OptiScaler in the Feeder's "exactly one neural
  consumer" slot, and it is distributed through its author's Discord only -- no repository, no release
  URL, so nothing for `integrity.js` to pin. Its `LICENSE.txt` (in the release, copyright 2026
  Alexander) forbids copying, rehosting, mirroring, redistributing or bundling it without prior
  written permission, so this is a licence term and not merely an unknown. `src/dfc.js` therefore takes a copy the USER supplies and
  caches it, the way `importDgVoodooZip` does for dgVoodoo2; it never fetches, and a test fails if a
  fetch appears. Same position as the AMD installer above. A permission request went to its author on
  2026-09-21 (asked for: may the app fetch it, and is there a documented `deep-fried-chicken.cfg`
  schema), with full credit offered -- **no reply yet**.
- **Writing `deep-fried-chicken.cfg` IS allowed; shipping Chicken is not.** Its `LICENSE.txt` grants
  "create and share your own Deep Fried Chicken configuration and preset files, provided they do not
  contain or redistribute any part of the Software", and separately forbids copying, mirroring,
  bundling or modifying the Software without **prior written permission**. So `dfccfg.js` writes the
  config and `dfc.js` still never fetches a byte. An earlier note here said the README forbade editing
  the cfg -- that was the *Feeder's* README describing Chicken. Chicken's own says the opposite: "Keep
  your existing deep-fried-chicken.cfg when updating."
- **The cfg is 663 flat `key=value` lines with `config_schema=13` (CP376 Beta).** `dfccfg.js` rewrites
  only the keys asked for and returns every other byte untouched, refuses a file whose schema is newer
  than it knows, and keeps **per-line** endings -- `dfc-universal-feed.cfg` really is mixed (3 CRLF, 36
  LF) and a file-wide flag rewrote all of it. Round-tripping the real files is what caught that; the
  hand-written fixture was uniform and passed happily.
- **A Chicken release ships two trees.** `64-bit/` is the drop-in consumer for our Feeder route.
  `32-bit/` is Chicken's OWN transport (`deep-fried-chicken.addon32`, `dfc-universal-feed.cfg`,
  `host64\dfc-universal-host64.exe` + its own `dxgi.dll`, `DFC_Universal_Feed.fx`) and does not use
  jlrouzies' Feeder at all. Its README: "Use the folder matching the GAME's bitness, not Windows'."
  Only the 64-bit tree is deployed today.
- The user's Chicken archives are 7z **AES-encrypted with encrypted headers**; the password is
  `chicken`, given 2026-09-21 and stated in the release's own README.txt.

- **`readdir` is sorted on Windows and unordered on Linux, and a test can ride on that.** A new
  test put the app's cache *inside* the folder it then asked `dfc.importDfcSource` to scan.
  `findPayloadDir` descends two levels, so the cache looks like a payload: `dest` is deleted and
  then copied from itself, `files` comes back empty and nothing throws. Windows met the cache first
  every time (case-insensitive order) and failed; Linux met it second by luck and passed. Never put
  a cache or output folder inside a tree a test asks the code to search.
- **CI now says WHICH test failed.** `node --test` prints `not ok <n> - <name>` inline, so on a
  700-test suite the failures sit in the middle of a very long log, and reading a run from outside
  the runner means reading the tail -- which held only `# fail 1`. `.github/workflows/test.yml` has
  a `if: failure()` step that repeats the failing names and their assertion blocks at the end. The
  failure above cost hours to locate and was named by that step on its first run.
- **A clone goes stale fast.** This repo moved about 180 commits in the first half of September
  alone. Always `git fetch origin master` and rebase before writing a patch, and re-check that a
  problem still exists before fixing it.
- **Version bumps**: `package.json` and `package-lock.json` both carry the version, and the lock has
  drifted behind before. Set both.
- The engine's **build workflow fails at the SignPath step** ("Input required and not supplied:
  api-token") on every PR, because the fork has no signing token. The compile above it is what
  matters; scan the log for `error C` rather than trusting the red tick.
- The engine's **Formatting Check is yours now, and it will catch you.** It used to be permanently
  red on files nobody here writes -- 96 of them, 93% generated or vendored -- so it was ignorable.
  `clang-format.yml` has since been narrowed to hand-written code (its `exclude-regex` drops
  `external/`, `include/`, `precompile/`, the FidelityFX SDK, the opticalflow shaders and
  `DlssNr_I18n_Tables.cpp`), so a red tick now means a file the change touched. PR #10 cost a whole
  extra commit to that assumption.
  Reproduce it exactly rather than guessing: `pip install clang-format==20.1.7` puts the binary the
  workflow pins on PATH in a sandbox, and `clang-format --dry-run -Werror <file>` is what the action
  runs. Format only the files the branch touched -- the rest of the tree is already clean, so a
  whole-tree run is noise in the diff. Raw string literals are safe: `.clang-format` sets no
  `RawStringFormats`, so HLSL held in `R"( ... )"` is left alone (check it anyway, by comparing the
  bodies before and after).
- `test/legacy.test.js` "emulator profiles" **fails on Linux only**: `emulators.profileFor()` uses
  `path.basename()`, which does not treat `\` as a separator off Windows. CI runs on
  `windows-latest`, where it passes. Not a real bug. `test/feeder.test.js` "crashes inside dgVoodoo2"
  is the same story (its regex wants a drive-letter path).
- **A third `npm test` failure in a sandboxed session is the network, not a regression.**
  `test/feeder.test.js` "switching away from a provider deployed before mvFiles existed" downloads
  the VORT shader pack and dies on `HTTP 503 for https://codeload.github.com/...` when the egress
  proxy is refusing. It is intermittent: it failed on 2026-09-17 and passed on 2026-09-18 in the
  same sandbox. So the baseline here is **two or three** failures, not two -- get master's own count
  before judging a branch, rather than reading this one as something you broke.
- **A user's support bundle can be read when they attach it to the chat**, even though a session
  cannot fetch one from GitHub. The SWTOR bundle on #50 (2026-09-17) settled two questions the
  digest could not: `OptiScaler.log` was clean end to end while BugSplat's `MFA: d3d9!00065af0` and
  the adapter name `(dgVoodoo DX API Layer)` put the crash in dgVoodoo2, and `folder-listing.txt`
  showed `nvngx_dlssnr.dll` and a renamed `xnvngx_dlss.dll` but no `nvngx_dlss.dll`. Ask for the zip
  in the chat when the digest runs out. `folder-listing.txt` and `app-view.json` in that bundle are
  the two most useful files and neither is a log.
- **The support bundle does not collect the wrapper's own log.** `BUNDLE_FILES` in runlog.js has no
  `swtor_d3d9.log` / `dgVoodoo.log` / `dxvk.log`, so on a dgVoodoo2 or DXVK route the one log that
  would name the faulting layer is the one missing. Worth adding.
- **On a Feeder game, OptiScaler.log is the wrong log to start from.** `dlss5-feed.log` says whether
  OptiScaler was even in the process (`OptiScaler: not present`, `... never loaded a DLL of that
  name`, `the DRIVER answered the NGX probe`, `not the DLSS-NR fork`); runlog.js turns those into
  verdicts. SWTOR (2026-09-16) fed 18,000 frames with OptiScaler installed as dxgi.dll beside DXVK.
- **ReShade's Vulkan layer only attaches to exes on its own list**, `Apps=` in
  `C:\ProgramData\ReShade\ReShadeApps.ini` (its setup writes it). A registered add-on layer that
  skips the game looks exactly like "the layer did not load". The Feeder's DXVK route also wants
  `dxvk.allowFse = False` in `dxvk.conf`; feeder.js writes it on deploy and takes it back on Remove.
- **A user's logs cannot be read from a session, by any route.** `github.com/user-attachments/...`
  (a dragged-in zip) and `api.github.com/gists/...` (what "Send game failure" posts) both answer
  403, repo-scoped paths only; `gist.githubusercontent.com` is refused by the egress policy. So
  triage works from the **issue body**, which since v1.80.0 carries a folded "Run digest" block --
  `runlog.reportDigest`, the verdict and the Feeder's own sentences as `key: value` lines. Reports
  from before v1.80.0 have only the header lines; say so rather than guessing at the rest.
- **A daily triage Routine** (`trig_01Rzks92LWzZgHpmzGrn91tM`, 07:00 UTC, bound to
  `session_01RQaLiUKYFXVtsJ1rjiHUCw`) reads issues updated in the last 30 hours, diagnoses them
  from that digest against `src/gamehelp.js`, and either opens a **draft** PR with a test or posts
  one diagnosis comment. It is forbidden from merging, releasing and pushing to master: the engine
  cannot be validated on a runner (no GPU, no game), and the manager updates itself through
  electron-updater, so a wrong automatic release installs itself on everyone. Set up 2026-09-17,
  after the user chose "triage and draft PRs" over full automation. Its prompt is kept in
  `docs/routines/daily-triage.md`. An earlier copy (`trig_014oKuLCuUn3CwLDnqEqxUR8`, bound to
  the SWTOR session) is disabled, not deleted. A session-bound Routine dies with its session,
  which the user does not want; the way out is a Routine created from the claude.ai Routines UI
  with both repositories attached, and that file is the prompt to paste there.
- **A Routine that spawns a fresh session cannot reach GitHub here**, so that one is bound to an
  existing session instead. A trigger-fired session gets Bash/Read/Write/Edit/Glob/Grep/Agent and
  no MCP tools at all: `git clone` works, every `api.github.com` call is refused with "GitHub access
  to this repository is not enabled for this session. Use add_repo to request access", and
  `add_repo` is not there to call. `create_trigger`'s `connectors` parameter is rejected for this
  organisation ("not available"), and this session's GitHub tooling comes from the environment
  rather than from a passable connector grant, so it cannot be handed on. Proven by firing one
  (2026-09-17), and the `connectors` rejection re-confirmed the same day. A fresh-session
  Routine that needs GitHub has to be created from the claude.ai Routines UI, where the
  repository and its access can be attached.
- **DXVK on the 32-bit helper route needs ReShade's 32-bit Vulkan layer, and the app installs it.**
  Assassin's Creed II (2026-09-18): under DXVK nothing loads the game-folder ReShade dxgi.dll, so
  the Feeder add-on never starts. The swap parks that proxy (legacy.js parkReShadeProxy) and runs
  ReShade's own setup elevated: `ReShade_Setup_6.8.0_Addon.exe "<exe>" --api vulkan --headless
  --elevated` (setup/MainWindow.xaml.cs, v6.8.0). Two traps from that source: a headless Vulkan
  install refuses while a ReShade.ini sits beside the exe, so ours is held aside for the run; and
  the setup's own elevation relaunch drops `--headless` and does not wait, so it has to be started
  elevated (elevate.js). At runtime the layer takes the EXE's folder as its base and only starts
  when a ReShade.ini is there (source/dll_main.cpp) -- the Apps= list is what the setup maintains.
  Remove takes the exe off Apps= and never uninstalls the machine-wide layer.
  Since 2026-09-18 a **32-bit DirectX 10/11** game can take DXVK too, in place of its own Direct3D
  (`legacy.dxvkReplacesNative`, fix ids `swap-to-dxvk` / `swap-to-native`). The order differs from
  DX9: the proxy is parked *before* DXVK goes in, because DXVK's dxgi.dll takes its name
  (`legacy.swapNativeToDxvk`, which un-parks on a refusal). The set is d3d10core + d3d11 + dxgi for
  both APIs; DXVK 3.x ships no d3d10.dll/d3d10_1.dll. Whether the Feeder add-on actually runs under
  the Vulkan layer on a DX11-via-DXVK game is not yet proven on a real game.
