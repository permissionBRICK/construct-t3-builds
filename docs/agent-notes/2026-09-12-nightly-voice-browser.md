# Nightly voice browser test repair

The nightly publish job [103550850765](https://github.com/permissionBRICK/construct-t3-builds/actions/runs/34692767956/job/103550850765)
failed in `test/t3-voice-question.browser.test.mjs`, after compilation and voice
unit tests passed. Its esbuild invocation treated Vite's `?worker` import as an
ordinary module and rejected the default import in `DiffWorkerPoolProvider.tsx`.

The failure reproduced with installed dependencies on pristine upstream tag
`v0.0.41-nightly.20260912.1599`, commit
`b1e223e2b0d87124883b1410ab52dd6a1338e40d`, after applying the nightly inventory.
The second inventory application reported zero operations, 206 already present,
and zero optional skips.

The browser test now uses the checkout's Vite build API, with an in-memory entry
and browser assets. This handles worker imports and `import.meta.env` using the
upstream toolchain. The fixture also supplies the empty `contextRecords` map
required by nightly's composer. The real editor, voice callbacks, transport
helpers, and all existing assertions remain in the test.

## Reproduction and validation

Use Node 26.8.1 and pnpm 11.10.0. For each channel, clone the exact tag into
`work/upstream-$channel`, then run:

```sh
node bin/apply-t3code-source.mjs apply --source "work/upstream-$channel" \
  --manifest "patches/t3code-$channel/source-transforms.json" \
  --overlays "patches/t3code-$channel/overlays"
# Repeat the command to check idempotence.
pnpm -C "work/upstream-$channel" install --no-frozen-lockfile
npm install --prefix work/voice-test-tools --no-audit --no-fund esbuild@0.25.0 playwright@1.58.2
T3_TEST_SOURCE="$PWD/work/upstream-$channel" \
T3_TEST_TOOLS="$PWD/work/voice-test-tools" T3_TEST_CHANNEL="$channel" \
T3_TEST_CHROMIUM=/usr/bin/google-chrome node test/t3-voice-question.browser.test.mjs
```

Both the repaired editor test and `test/t3-voice-capture.browser.test.mjs` passed
against nightly and the latest stable tag `v0.0.40`, commit
`09e8de9c655ae85410bf6b00446f272a01da81c7`, using its release inventory.
Each channel also passed the publisher's `vp test run --project unit src/voice`
in `apps/web` (33 tests) and `vp test run src/voiceInput.test.ts` in `apps/server`
(16 tests).

The patched nightly passed `pnpm run build:desktop` after the recipe's
`scripts/update-release-package-versions.ts` command. Both server bundle patchers
applied successfully, and `apps/web` passed `tsc --noEmit`. Packaging with
`scripts/package-linux.mjs`, archiving the result, and running `scripts/smoke.py`
passed the extracted runtime, native file finder, native PTY, and HTTP web UI
checks.

Local Construct checks passed: source transformer, source contract, build cache,
T3 parking, capacity retry, update action, OpenCode monitor patch, build Node,
build disk check, and all seven publisher unit tests. This checkout has no
`extension/test/*.test.js` files; its applicable extension test is
`extension/test/t3-opencode-monitor-patch.test.mjs`.

## Ancillary check limitations

`test/t3-overlay.test.sh` passed its inventory checks and 144 overlay unit tests,
but its two typecheck commands expect `node_modules/.bin/tsgo`, which this
upstream no longer installs. Running upstream's `tsc --noEmit` directly passed
for web. Desktop reported `TS377057` on the existing `node:child_process` type
import in `ConstructUpdates.test.ts:2`. These checks are outside the failed
publisher step and the changed browser fixture. Windows installer packaging
was not rerun.
