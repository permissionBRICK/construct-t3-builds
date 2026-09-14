# Nightly WSL packaging repair

The failed [Actions job](https://github.com/permissionBRICK/construct-t3-builds/actions/runs/34853701570/job/104007730418)
used upstream `v0.0.41-nightly.20260914.1707`, commit
`9375c779707fb95c06670db6da87441720b2d2e2`. Its server build and voice tests
passed. Windows packaging exited with `Unrecognized flag: --wsl-prebuild`.

The same command failed locally after cloning that tag, applying the nightly
inventory and installing dependencies with `pnpm install --no-frozen-lockfile`:

```sh
node scripts/build-desktop-artifact.ts \
  --platform win --target nsis --arch x64 --skip-build \
  --build-version 0.0.41-nightly.20260914.1707-construct.repro \
  --output-dir ../repro --wsl-prebuild unused
```

Nightly now expects a Linux CLI archive for WSL. Its inventory accepts Construct's
required prebuild input and builds that archive from the prepared server bundle.
It flattens the bundle's shared chunks, retaining the parking and OpenCode monitor
patches, then embeds the result using the same Node executable as the native build.
The archive contains the web client, Linux resource monitor and runtime dependency
closure, with Construct's supplied `pty.node`. Upstream's standalone CLI smoke test
must pass before Desktop packaging receives the archive. Temporary files belong to
the packaging Effect scope. Upstream's Windows payload checks remain enabled.

The full build exposed a second failure after installer creation. Upstream tried
loading the Windows sidecar with Linux Node and failed on
`@yuuang/ffi-rs-linux-x64-gnu`. The nightly probe now uses the packaged Windows
Electron through Wine on Linux. It still executes the extracted, isolated server
with global module lookup and Node startup overrides disabled. Electron under
Wine needs real file handles for stdin and output. The probe supplies an empty
input file, captures an output file and relays its contents and exit status. Native Windows builds retain their Node
probe. Neither the dependency check nor its timeout is skipped.

The upstream unit fixtures contain plain JavaScript and a fake Electron file.
They continue testing real isolated Node resolution through a mocked command
selector. Separate selector tests cover Wine arguments and environment isolation;
a real Wine/Electron check loaded the complete patched Windows sidecar, including
its Windows FFI native, and rejected a deliberately missing package.

The overlay test runner now checks each inventory's exact file list independently
and invokes each upstream app's declared typecheck command. Nightly's companion
launch test derives its spawn type from the function under test, avoiding a Node
module import rejected by the upstream Effect diagnostics.

## Validation

- A pristine checkout of the target tag accepted the manifest-v2 inventory. A
  second application reported zero changes and 220 operations already present.
- `pnpm run build:desktop` passed, followed by both bundle patchers.
- Upstream `scripts/build-desktop-artifact.test.ts` and the Windows probe tests:
  73 tests passed.
- Upstream `apps/web/src/voice`: 33 tests passed; server `voiceInput.test.ts`:
  16 tests passed.
- Upstream Desktop WSL tests: 82 tests passed. Missing native input rejects
  the new archive build.
- Scripts typecheck passed with the new packaging overlay.
- `T3_SOURCE_DIR=<nightly-checkout> bash test/t3-overlay.test.sh`: 8/8 checks
  passed, including Desktop/web typechecks, 93 Desktop tests and 51 web tests.
- Publisher contracts, source-transform and source-contract tests, build-cache,
  parking, capacity-retry, OpenCode monitor, build-Node and disk-space tests passed.
  `t3-update-action.test.mjs` passed for both inventories with esbuild resolved
  from the installed upstream dependencies.
- Full `scripts/build.sh` validation of the pinned pair passed with exit 0.
  This included the packaged Linux native file-finder, PTY and HTTP checks,
  standalone WSL smoke test, Windows dependency probe through Wine, Windows
  payload validation with 48 files and 17 sidecar natives, PE header check,
  `7z t`, and publisher manifest finalization. The output contains the 189 MiB
  Windows installer and 92 MiB Linux runtime, plus the manifest and SHA256SUMS.
- Inspection of the WSL executable confirmed the parking, OpenCode monitoring,
  voice, Omniloop and disk-space integrations. Its PTY native matched the prepared
  server's bytes. The NSIS include-path regression test passed.

The final build used a verification plan pinned to the tag above and the current
publisher/inventory hashes. Local evidence is under `.repair/retry-ci`, with the
full log in `.repair/retry-build.log`. The build command was:

```sh
T3PARK_SKIP_TOKEN=true \
T3CODE_NODE_ROOT="$PWD/.repair/toolchains" \
T3CODE_COMPILER_CACHE="$PWD/.repair/ci/compiler" \
bash scripts/build.sh "$PWD/.repair/retry-ci"
```

An earlier identical run hit an HTTP 504 fetching Electron's checksum metadata.
The endpoint recovered, its published checksum verified the cached runtime, and
this unchanged retry completed. No checksum verification was bypassed.

The shared test runner was also checked against pristine stable `v0.0.40`, commit
`09e8de9c655ae85410bf6b00446f272a01da81c7`, with its own unchanged release inventory
and installed dependencies. Source application, web typecheck, 93 Desktop tests
and 51 web tests passed. Desktop typecheck failed with `TS377057` at the existing
`ConstructUpdates.test.ts` type-only `node:child_process` import. Running the
original test runner from the repair branch's base commit reproduced the same
error. This stable inventory issue is left for its own channel repair.

No release inventory, shared artifact recipe or live installation was changed.
