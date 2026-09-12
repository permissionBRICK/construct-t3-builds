# Construct T3 Code builds

This public repository owns the stable and nightly patches, source transforms,
overlays, runtime patchers, build recipe, tests, and binary releases for
[The Construct](https://github.com/permissionBRICK/The-Construct)'s patched T3 Code.
Builds never read Construct main. Patch repairs and feature changes belong here.
The inventories target only the latest tag of their own channel, following
[the patch rules](patches/README.md).

## Build and publish

Pushes to main, manual dispatch, and the :17/:47 upstream poll run independent
stable and nightly jobs. Each resolves its npm tag (`latest` or `nightly`), checks
its own inventory against that exact upstream tag, and builds a matched Linux
server / Windows desktop pair. Stable never borrows the nightly inventory.
Complete releases with the same version and recipe identity are reused. Failed
validation or builds leave the last published pair available.

The builder compiles shared JavaScript once, packages a Linux runtime with pinned
Node and its native dependencies, and cross-compiles the Windows NSIS installer
using Wine. It smoke-tests Linux CLI, native PTY and HTTP serving, checks Windows
PE/NSIS structure, uploads to a draft, downloads and verifies every asset, and
only then publishes. Windows installation UI is not exercised by Linux CI.

Stable releases become GitHub's **latest**. Nightly releases are **prereleases**
and never replace latest. Consumers select a complete published nightly release
from the releases API. Both channels then use immutable asset URLs from the
manifest and verify size/SHA-256. No published asset is overwritten.

Assets: `T3Code-Construct-Setup.exe`, `t3code-server-linux-x64.tar.gz`,
`manifest.json`, `SHA256SUMS`. Tags: `t3-<version>-<full build hash>`.
Stable discovery: `/releases/latest/download/manifest.json`.
Nightly discovery: `/repos/permissionBRICK/construct-t3-builds/releases`, filter
non-draft prereleases with a nightly identity and all four assets.

The Desktop app discovers Construct updates from the published release manifest, the same as the control panel.

## Identity and local builds

The selected inventory, transformer, two runtime patchers and artifact recipe
form `sourcePatchHash`. Publisher packaging/config inputs contribute to
`patchHash`; upstream version and channel additionally identify `buildHash`.
Commit IDs are provenance, not cache keys. Docs/workflow/test changes alone do
not rebuild binaries. Manifests record `buildRepositoryCommit` and upstream commit.

Construct defaults to prebuilt pairs for both channels. Explicit local builds
fetch main at one resolved commit into `/var/cache/construct/t3code-builds/<sha>`.
The server manifest records that commit; deferred Windows packaging uses the
same checkout even if main advances. `bin/build-t3code.sh` here is the real builder;
Construct's corresponding script is only its provisioning entry point.

Jarvis Lite polls both npm channels every 15 minutes. Only changed versions start
patch validation and, on conflict, a repair PR in this repository. Merging the PR
triggers publication. Claude/OpenCode repairs still belong to Construct.

No cross-repository credentials or dispatch secrets are needed. Publishing uses
this repository's `GITHUB_TOKEN`; the build step receives no token. The stable
job's monthly activity marker prevents GitHub's schedule inactivity cutoff.

## Verification

```sh
python3 -m unittest discover -s tests -v
node test/t3-source-transform.test.mjs
node test/t3-source-contract.test.cjs
node test/t3-build-cache.test.mjs
node test/t3park-patch.test.mjs
node test/t3-capacity-retry.test.mjs
node extension/test/t3-opencode-monitor-patch.test.mjs
bash test/t3-build-node.test.sh
bash test/t3-build-diskcheck.test.sh
python3 scripts/publisher.py plan --channel stable
python3 scripts/publisher.py plan --channel nightly --work work-nightly
```

The browser-driven checks (`test/*.browser.test.mjs`: the update popup, the
composer's voice callbacks with mocked audio and transcription, the microphone
capture shim) are manual and not part of the build. Run one for an inventory with
`T3_TEST_SOURCE` pointing at its patched upstream checkout with installed
dependencies, `T3_TEST_TOOLS` at a package directory providing esbuild and
Playwright, and `T3_TEST_CHANNEL=release|nightly`, for example
`node test/t3-update-notification.browser.test.mjs`. Set `T3_TEST_CHROMIUM` to use
an existing Chromium executable. The build itself verifies the patch application
and runs the overlays' unit suites (`vp test run`) only.

Plans and builds use isolated paths and never restart the live T3 service.
Build with `bash scripts/build.sh <absolute work directory>` on Ubuntu 24.04
as root with the pinned Node from `.node-version`. Publication is a separate
`python3 scripts/publisher.py publish --work <directory>` step.
