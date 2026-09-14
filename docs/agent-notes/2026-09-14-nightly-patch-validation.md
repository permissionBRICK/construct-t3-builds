# Nightly 1707 compatibility report

The reported `construct-t3park-patch.mjs` anchor failure reproduces against the
npm package for `0.0.41-nightly.20260914.1707`, but not against Construct's
source-built server. No production inventory repair is required for this tag.

The npm tarball's `package/dist/bin.mjs` is now a 1,350-byte launcher. It resolves
`@t3code/t3-<platform>-<arch>/package.json` and spawns the packaged native
executable. It contains neither the Claude adapter nor the OpenCode adapter.
Both patchers correctly report `compatible: false` for that file. Applying the
parking patch exits 2 without changing it or creating a backup.

Construct builds JavaScript from source, using `apps/server/dist/bin.mjs` as
the patch target. On this tag, that bundle still contains both parking anchors
exactly once and accepts both existing runtime patchers. Treating the npm
launcher as that bundle produces a false compatibility alarm. The external
compatibility check must inspect the source-built bundle to validate this
inventory. Accepting or skipping the launcher would not install the features.

## Verification

All work used an isolated clone of upstream tag
`v0.0.41-nightly.20260914.1707`, commit
`9375c779707fb95c06670db6da87441720b2d2e2`, with Node 26.8.1 and pnpm 11.10.0.
No live installation was changed.

The version 2 nightly manifest and overlays applied to the pristine tag with
206 operations and no optional skips. A second application reported zero
operations and 206 already present. SHA-256 comparisons of every source file
confirmed byte-for-byte idempotence.

After `pnpm install --no-frozen-lockfile`, `pnpm run build:bundle` in
`apps/server` succeeded. Both bundle patchers applied successfully. Reapplying
both left the bundle byte-for-byte unchanged, and `node --check` passed.
Token minting was disabled with `T3PARK_SKIP_TOKEN=true` during validation.

The recipe's `node scripts/update-release-package-versions.ts
0.0.41-nightly.20260914.1707` and `pnpm run build:desktop` also succeeded,
compiling the shared server, web, and Desktop JavaScript. Both patchers again
applied idempotently to the resulting server bundle; its syntax check and
isolated CLI `--version` check passed. Windows installer packaging was not run.

Passed Construct checks:

- `node test/t3-source-transform.test.mjs`
- `node test/t3-source-contract.test.cjs`
- `node test/t3-build-cache.test.mjs`
- `node test/t3park-patch.test.mjs`
- `node test/t3-capacity-retry.test.mjs`
- `node test/t3-update-action.test.mjs`, with `T3_TEST_TOOLS` pointing at the
  installed upstream dependency directory providing esbuild
- `node extension/test/t3-opencode-monitor-patch.test.mjs`
- `bash test/t3-build-node.test.sh`
- `bash test/t3-build-diskcheck.test.sh`
- `python3 -m unittest discover -s tests -v`, eight tests

This repository has no `extension/test/*.test.js` files.

Focused checks in the patched nightly checkout also passed:

- Claude adapter, 127 tests.
- Desktop Construct updates, 93 tests.
- Web Construct instance/update logic and voice suites, 84 tests.
- Server voice input, 16 tests.
- Web `pnpm exec tsc --noEmit`.

## Existing ancillary check failures

`bash test/t3-overlay.test.sh` inferred the release inventory from the pristine
tag's placeholder server package version, `0.0.40`, and failed to apply it. Its
typecheck commands also expect `tsgo`, which this upstream does not install.
The overlay suites above were run directly with `vp test run` against the
correctly patched nightly tree instead.

Desktop `pnpm exec tsc --noEmit` reports `TS377057` on the existing
`node:child_process` type import in `ConstructUpdates.test.ts:2`. This is the
same ancillary diagnostic recorded in the September 12 validation note.
These pre-existing check issues are separate from the reported bundle-anchor
failure; the nightly inventory and shared runtime patchers remain unchanged.
