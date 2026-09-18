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
- **Nexus Mods is blocked by the egress proxy**, so a mod page's comments -- often the richest source
  on a specific game -- cannot be read from a session. The OptiScaler wiki and its issues can.

- **A clone goes stale fast.** This repo moved about 180 commits in the first half of September
  alone. Always `git fetch origin master` and rebase before writing a patch, and re-check that a
  problem still exists before fixing it.
- **Version bumps**: `package.json` and `package-lock.json` both carry the version, and the lock has
  drifted behind before. Set both.
- The engine's **build workflow fails at the SignPath step** ("Input required and not supplied:
  api-token") on every PR, because the fork has no signing token. The compile above it is what
  matters; scan the log for `error C` rather than trusting the red tick.
- The engine's **Formatting Check** is red on files unrelated to a given change. clang-format 20 is
  what CI uses.
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
