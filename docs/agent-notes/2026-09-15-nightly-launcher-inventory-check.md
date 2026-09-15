# Nightly 20260915.1735 t3park report: the npm launcher, again

The upstream patch watch reported `construct-t3park-patch.mjs: anchors not
found exactly once` for `0.0.41-nightly.20260915.1735`. The report reproduces
against the npm package only, not against the source-built server — the same
finding as the September 14 note, which still stands.

The npm tarball's `package/dist/bin.mjs` remains the 27-line launcher that
resolves `@t3code/t3-<platform>-<arch>` and spawns its self-contained
executable. It carries no Claude or OpenCode adapter code, so neither runtime
patcher can anchor in it, regardless of the upstream version. The real patch
target is unchanged.

`construct-t3park-patch.mjs` now distinguishes this case: `status` on the
launcher adds `launcher: true` with a detail naming the source-built target,
and `apply` refuses with exit 2 and that explanation instead of an anchor
diagnosis that implies upstream adapter drift. Behaviour on a real server
bundle is untouched: the guard fires only for the launcher's
`require.resolve("@t3code/t3-" ...)` entry, which never appears in a bundle
that contains the anchors.

## Verification against v0.0.41-nightly.20260915.1735 (commit b5b29e7b8)

All work used isolated clones; no live installation was touched.

- The nightly inventory (46 overlays + 172 transforms) applied to the pristine
  tag with 218 operations, no optional skips. A second application reported
  zero operations, 218 already present, and SHA-256 comparisons of every
  source file confirmed byte-for-byte idempotence.
- After `pnpm install --no-frozen-lockfile` and
  `node scripts/update-release-package-versions.ts`, `pnpm run build:bundle`
  in `apps/server` produced `dist/bin.mjs` (8.33 MB). Both runtime patchers
  reported it compatible, applied, and reapplying both left the bundle
  byte-for-byte unchanged; `node --check` passed and the patched server
  reported `t3 v0.0.41-nightly.20260915.1735` for `--version`.
- The npm launcher check that produced the report still yields
  `compatible: false` — correctly. The external compatibility check must
  inspect the source-built bundle to validate this inventory (September 14
  note, "Initial verification"); until it does, every new nightly tag repeats
  this false alarm while the inventory itself remains compatible.

Construct checks passed on the branch:

- `node test/t3park-patch.test.mjs` (16, including the new launcher guard)
- `node test/t3-source-transform.test.mjs`, `node test/t3-source-contract.test.cjs`
- `node test/t3-build-cache.test.mjs`, `node test/t3-capacity-retry.test.mjs`
- `node extension/test/t3-opencode-monitor-patch.test.mjs`
- `bash test/t3-build-node.test.sh`, `bash test/t3-build-diskcheck.test.sh`
- `python3 -m unittest discover -s tests -v`

`construct-t3-opencode-monitor-patch.mjs` has the same launcher blindspot and
was deliberately left unchanged: the reported failure names the t3park patcher
and the monitor anchors are equally intact on the built bundle.
