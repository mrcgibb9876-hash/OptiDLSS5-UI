# OptiDLSS5-UI v2.0.0

This is a major release: the OptiScaler install core and RE‑Engine handling have been ported from rakanki911/DLSS5‑Swapper and integrated into OptiDLSS5‑UI. The port brings safer installs, conservative conflict detection, and better RE‑Engine handling.

## Highlights

- Ported OptiScaler install core into `src/core/optiscaler.js`:
  - `ensureOptiScaler` (download + verify + extract pinned OptiScaler zip)
  - `validatePayload`, `configure` (INI defaults), `copyPlan`, `checkConflicts`
  - `install(...)` entrypoint that performs tracked copy/manifest operations
- Vendored helper modules used by the installer:
  - `src/core/pe.js` — minimal PE reader (bitness/imports/version checks)
  - `src/core/runtime-components.js` — cached + fetchVerified download/verify helper
  - `src/core/apply.js` — minimal tracked-copy / file-journal helpers
- UI wiring:
  - main process game install flow now invokes the new optiscaler installer (`game:install` IPC)
  - removed automatic ReShade writes from the feeder install path
- Dependency:
  - Added `extract-zip` to extract pinned OptiScaler archives
- Version bump to `v2.0.0` (major) to reflect breaking/large change set

## Pinned OptiScaler release

- Default pinned release (can be changed later via Settings):
  - URL: https://github.com/Dagherbou/OptiScaler_DLSSNR/releases/download/v0.2.0-patch1/OptiScaler-DLSSNR-v0.2.0-onimusha-fix.zip
  - sha256: `5db547216fa8a7dbd8ab0a193da1e3bce0ea4bd71f91189afa4ed2ede8bb9561`

## Important notes & breaking changes

- ReShade is no longer installed automatically by the feeder path. ReShade installations/upgrades must be performed explicitly via the UI flow that runs the installer; this avoids silent/ReShade-based overwrites.
- The installer now uses a manifest-backed tracked-copy approach — manifests are stored in the game's backup folder and are used to restore originals.
- The port includes vendored helper code (minimal) to make the installer self-contained. We can refactor later to unify utilities.

## Testing / smoke checklist (please run before publishing widely)

1. `git fetch origin && git checkout feature/port-optiscaler-from-dlss5-swapper`
2. `npm install`
3. `npm run start`
4. Non-RE game: run OptiScaler install → verify files copied and OptiScaler.ini changes applied.
5. RE Engine game (VM / test folder): run install → confirm `RestoreComputeSignature` is NOT forced by default and REFramework is handled safely (REFramework cached/copied where needed).
6. Conflict detection: put a proxy-like `dxgi.dll` containing a ReShade marker into the exe folder and ensure the installer fails with a clear conflict error (no overwrite).
7. Feeder flows: verify DLSS5‑Feeder / Lumenite / DFC installs work for supported D3D/OpenGL titles.

## Security & safety

- This release writes binary payloads into game folders. Test installations on a VM or non-critical game folder first.
- The default policy is conservative to minimize hard crashes (e.g., `RestoreComputeSignature` is not forced).

## Attribution

- Parts of the installer were ported from rakanki911/DLSS5‑Swapper (MIT). Upstream code attribution/notice is included in the vendored files; please review them for license text.

## Changelog (summary)

- Added: `src/core/optiscaler.js`, `src/core/pe.js`, `src/core/runtime-components.js`, `src/core/apply.js`
- Changed: `src/main.js` (install IPC), `src/native-feeder/install.js` (removed auto ReShade)
- Updated: `package.json` (extract-zip, version 2.0.0)


---

Build & publish notes

To create a release using this file with the GitHub CLI:

- Merge the feature branch into `master` (or ensure `master` contains the commit to release):
  - `git fetch origin`
  - `git checkout master`
  - `git merge --no-ff origin/feature/port-optiscaler-from-dlss5-swapper`

- Tag and push the release tag:
  - `git tag -a v2.0.0 -m "OptiScaler port & RE‑Engine fixes (v2.0.0)"`
  - `git push origin v2.0.0`

- Create the release with the notes in this file:
  - `gh release create v2.0.0 --title "OptiDLSS5-UI v2.0.0" --notes-file src/core/RELEASE_NOTES.md`

Or paste this file into the web UI at: https://github.com/mrcgibb9876-hash/OptiDLSS5-UI/releases/new
