# Notes for Claude

## The two repos are coupled

- **OptiDLSS5-UI** (this repo) is the Electron manager. Plain-script renderer, no bundler.
- **OptiScaler_DLSSNR** is the engine fork. Default branch `dlss5-developer-controls-ui`, not `master`.

A manager release **bundles the engine's newest release**, so the order is always: merge and
release the engine first, wait for its release to publish, then release the manager. Both use a
`workflow_dispatch` on `release.yml` whose tag must match the version already on the default branch.

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
- **A daily triage Routine** (`trig_017NQfzzUVqQoQbBq9hiwyur`, 07:00 UTC, fresh session per fire)
  reads issues updated in the last 30 hours, diagnoses them from that digest against
  `src/gamehelp.js`, and either opens a **draft** PR with a test or posts one diagnosis comment. It
  is forbidden from merging, releasing and pushing to master: the engine cannot be validated on a
  runner (no GPU, no game), and the manager updates itself through electron-updater, so a wrong
  automatic release installs itself on everyone. Set up 2026-09-17 at the user's request, after
  they chose "triage and draft PRs" over full automation.
