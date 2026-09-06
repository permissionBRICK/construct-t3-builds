const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const repoRoot = path.resolve(__dirname, '..');
const ok = (name, value) => { assert.ok(value, name); console.log('PASS '+name); };
const buildDriver = fs.readFileSync(path.join(repoRoot, "bin", "build-t3code.sh"), "utf8");
const buildRecipe = fs.readFileSync(path.join(repoRoot, "bin", "t3code-build-recipe.sh"), "utf8");
const sourceBuild = buildDriver + "\n" + buildRecipe;
const transformManifest = fs.readFileSync(path.join(repoRoot, "patches", "t3code-release", "source-transforms.json"), "utf8");
const overlayRoot = path.join(repoRoot, "patches", "t3code-release", "overlays");
const overlayText = fs.readdirSync(overlayRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")).join("\n");
const sourceRecipe = transformManifest + "\n" + overlayText;
ok("source build: resolves the selected npm channel to an exact Git tag",
  /npm view "t3@\$\{NPM_TAG\}" version/.test(sourceBuild) && /TAG="v\$\{VERSION\}"/.test(sourceBuild) && /git clone --depth 1 --branch "\$\{TAG\}"/.test(sourceBuild));
ok("source build: falls back to codeload and preserves the upstream commit",
  /GIT_TERMINAL_PROMPT=0 git clone/.test(sourceBuild) && /codeload\.github\.com\/pingdotgg\/t3code\/tar\.gz\/refs\/tags\/\$\{TAG\}/.test(sourceBuild) &&
  /api\.github\.com\/repos\/pingdotgg\/t3code\/commits\/\$\{TAG\}/.test(sourceBuild) && /\.construct-upstream-commit/.test(sourceBuild));
ok("source build: prunes superseded dependency trees before its free-space gate",
  /for stale_dir in "\$\{CACHE_ROOT\}"\/\*\//.test(sourceBuild) &&
  /t3_build_prune_candidates "\$\{stale_dir\}"/.test(sourceBuild) &&
  sourceBuild.indexOf("for stale_dir") < sourceBuild.indexOf('available_kb="$(df'));
ok("source build: cache is keyed by the T3 version + patch recipe; the Construct commit is recorded, not compared",
  /BUILD_HASH="\$\(printf '%s\\n' "\$\{VERSION\}" "\$\{CHANNEL\}" "\$\{PATCH_HASH\}" \| sha256sum/.test(sourceBuild) && !/cached_construct/.test(sourceBuild) &&
  /T3CODE_BUILD_KEY/.test(sourceBuild) && /constructVersion, buildHash/.test(sourceBuild));
ok("source build: hashes the artifact recipe independently of the provisioning driver",
  /t3_build_integration_hash "\$\{RECIPE\}"/.test(buildDriver) &&
  !/sha256sum "\$\{build_script\}"/.test(buildDriver));
ok("source build: one patched server bundle feeds the VM and Desktop package",
  /pnpm run build:desktop/.test(sourceBuild) && /node "\$\{T3PARK_PATCHER\}" apply --bundle/.test(sourceBuild) &&
  /build-desktop-artifact\.ts/.test(sourceBuild) && /ln -sfn "\$\{SOURCE_DIR\}\/apps\/server\/dist\/bin\.mjs" "\$\{LAUNCHER\}"/.test(sourceBuild));
ok("source build: Windows compiler/NSIS dependencies stay in the VM",
  /mingw-w64/.test(sourceBuild) && /wine32:i386/.test(sourceBuild) && /x86_64-pc-windows-gnu/.test(sourceBuild) && /--target nsis --arch x64/.test(sourceBuild));
ok("source transforms: voice RPC, live cursor-safe insertion, mic UI, and Construct updater are present",
  /voiceInput\.start/.test(sourceRecipe) && /active\.lastSetInput/.test(sourceRecipe) && /MicIcon/.test(sourceRecipe) &&
  /Ctrl\+T/.test(sourceRecipe) && !/Ctrl\+D/.test(sourceRecipe) && /Update-T3Code\.ps1/.test(sourceRecipe));
ok("source transforms: stream PCM amplitude into a live mic-button level effect",
  /readInt16LE/.test(sourceRecipe) && /Schema\.Literal\(\\?"level\\?"\)/.test(sourceRecipe) &&
  /data-voice-level/.test(sourceRecipe) && /boxShadow/.test(sourceRecipe));
// Auto-link (plan §4.12 "T3 Desktop topology"): the Desktop app links every VM with a T3
// server on its own, through a hidden host script; the same in BOTH inventories.
for (const channel of ["release", "nightly"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "patches", `t3code-${channel}`, "source-transforms.json"), "utf8"));
  const inserts = manifest.transforms.map((t) => (t.insert || t.replace || "")).join("\n");
  ok(`auto-link (${channel}): the overlay files are listed and mounted at the root`,
    manifest.overlays.includes("apps/web/src/components/ConstructAutoLink.tsx") &&
    manifest.overlays.includes("apps/web/src/components/constructInstances.link.ts") &&
    /<ConstructAutoLink \/>/.test(inserts));
  ok(`auto-link (${channel}): the bridge mints a link and records the marker (IPC both ways)`,
    /linkConstructInstance: \(name: string\) => Promise<ConstructPairingLinkResult>/.test(inserts) &&
    /recordConstructInstanceT3Link: \(name: string, link: ConstructT3LinkInfo\) => Promise<boolean>/.test(inserts) &&
    /CONSTRUCT_LINK_INSTANCE_CHANNEL/.test(inserts) && /CONSTRUCT_RECORD_T3_LINK_CHANNEL/.test(inserts) &&
    /ConstructUpdates\.runConstructPairingLink\(planned\.plan\)/.test(inserts) &&
    /ConstructUpdates\.recordConstructInstanceT3Link\(/.test(inserts));
  ok(`auto-link (${channel}): \`t3 auth pairing create --scopes administrative\` exists in the patched build`,
    /Flag\.string\("scopes"\)/.test(inserts) && /AuthAdministrativeScopes\n\s*: AuthStandardClientScopes/.test(inserts));
}
const autoLink = fs.readFileSync(path.join(repoRoot, "patches", "t3code-release", "overlays", "apps", "web", "src", "components", "ConstructAutoLink.tsx"), "utf8");
ok("auto-link: the renderer links off the planner and never twice per session",
  /planConstructAutoLink\(/.test(autoLink) && /attemptedRef\.current\.add\(name\)/.test(autoLink) && /linkConstructInstance\(\{ bridge, name, connectPairing \}\)/.test(autoLink));
