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
// Voice input lives in its own hook; upstream's ChatComposer changes almost daily, so it
// only gets the import, one hook call, the submit interception and the two control spots.
for (const channel of ["release", "nightly"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "patches", `t3code-${channel}`, "source-transforms.json"), "utf8"));
  const composer = manifest.transforms.filter((t) => t.path === "apps/web/src/components/chat/ChatComposer.tsx");
  const hook = fs.readFileSync(path.join(repoRoot, "patches", `t3code-${channel}`, "overlays", "apps", "web", "src", "voice", "useConstructVoiceInput.tsx"), "utf8");
  ok(`voice input (${channel}): ChatComposer only imports the hook, calls it, lets it intercept submits and places its controls`,
    manifest.overlays.includes("apps/web/src/voice/useConstructVoiceInput.tsx") && composer.length === 5 &&
    composer.some((t) => /^import \{ useConstructVoiceInput \} from "\.\.\/\.\.\/voice\/useConstructVoiceInput";\n$/.test(t.import || "")) &&
    composer.some((t) => t.before === "const submitComposer =" && /= useConstructVoiceInput\(\{[^]*getSubmitComposer: \(\) => submitComposerStable,\n {2}\}\);\n$/.test(t.insert)) &&
    composer.some((t) => t.scope === "const submitComposer =" && t.after === ") => {" &&
      /^ {4}if \(constructVoiceInput\.interceptSubmit\(event, dispatchMode, submissionIntent\)\) return;\n$/.test(t.insert)) &&
    composer.some((t) => t.before === "<ComposerFooterPrimaryActions" && /^\s*\{constructVoiceInput\.footerControl\}\n$/.test(t.insert)) &&
    composer.some((t) => t.before === "<ComposerPromptLengthValidation" && /^\s*\{constructVoiceInput\.questionControl\}\n$/.test(t.insert)));
  ok(`voice input (${channel}): the hook keeps Alt+Q, the send after the final transcript and the pending ring`,
    /event\.code === "KeyQ" && event\.altKey && !event\.ctrlKey/.test(hook) &&
    /if \(!active\.submitArgs\) active\.submitArgs = args;/.test(hook) &&
    /getSubmitComposer\(\)\(undefined, \.\.\.voiceSubmission\.args\)/.test(hook) &&
    /data-voice-pending/.test(hook) && /border-t-warning/.test(hook) && /data-question-voice-input/.test(hook));
}
// Auto-link (plan §4.12 "T3 Desktop topology"): the Desktop app links every VM with a T3
// server on its own, through a hidden host script; the same in BOTH inventories.
for (const channel of ["release", "nightly"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "patches", `t3code-${channel}`, "source-transforms.json"), "utf8"));
  const inserts = manifest.transforms.map((t) => (t.insert || t.replace || "")).join("\n");
  const companionDesktopPath = "apps/desktop/src/updates/ConstructUpdates.ts";
  const companionRowPath = "apps/web/src/components/settings/ConstructProviderRow.tsx";
  const companionLogicPath = "apps/web/src/components/constructInstances.logic.ts";
  const channelOverlayRoot = path.join(repoRoot, "patches", `t3code-${channel}`, "overlays");
  const companionDesktop = fs.readFileSync(path.join(channelOverlayRoot, companionDesktopPath), "utf8");
  const companionRow = fs.readFileSync(path.join(channelOverlayRoot, companionRowPath), "utf8");
  const companionLogic = fs.readFileSync(path.join(channelOverlayRoot, companionLogicPath), "utf8");
  ok(`Companion (${channel}): both renderer overlays and the desktop overlay are inventoried`,
    [companionDesktopPath, companionRowPath, companionLogicPath].every(p => manifest.overlays.includes(p)));
  ok(`Companion (${channel}): one typed bridge activation method is wired through IPC`,
    /openConstructCompanion: \(instanceName: string \| null\) => Promise<boolean>/.test(inserts) &&
    /CONSTRUCT_OPEN_COMPANION_CHANNEL = "desktop:construct-open-companion"/.test(inserts) &&
    /ipcRenderer\.invoke\(IpcChannels\.CONSTRUCT_OPEN_COMPANION_CHANNEL, instanceName\)/.test(inserts) &&
    /yield\* ipc\.handle\(openConstructCompanion\)/.test(inserts) &&
    /ConstructUpdates\.openConstructCompanion\(instanceName,/.test(inserts));
  ok(`Companion (${channel}): installation status survives the update-state schema`,
    /ConstructUpdateInfoSchema = Schema\.Struct\(\{\s*companionInstalled: Schema\.Boolean,/.test(inserts));
  ok(`Companion (${channel}): activation keeps the shared CLI contract and detached argv launch`,
    /\["--panel"\]/.test(companionDesktop) &&
    /\["--settings", "--instance", instanceName\]/.test(companionDesktop) &&
    /detached: true, stdio: "ignore", shell: false/.test(companionDesktop) &&
    /child\.unref\(\)/.test(companionDesktop) &&
    /"Programs", "ConstructCompanion", "ConstructCompanion\.exe"/.test(companionDesktop) &&
    /"install\.json"/.test(companionDesktop));
  ok(`Companion (${channel}): host and named Settings buttons consume the installation plan`,
    /instanceName=\{null\}/.test(companionRow) &&
    /instanceName=\{row\.instanceName\} state=\{row\.settingsButton\}/.test(companionRow) &&
    /openConstructCompanion\(instanceName\)/.test(companionRow) &&
    /disabled=\{state\.disabled\}/.test(companionRow) &&
    /Install the Construct Companion \(Update Construct installs it\)/.test(companionLogic));
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
    /Flag\.[sS]tring\("scopes"\)/.test(inserts) && /\.value === "administrative"\n\s*\? AuthStandardClientScopes\n/.test(inserts));
}
const autoLink = fs.readFileSync(path.join(repoRoot, "patches", "t3code-release", "overlays", "apps", "web", "src", "components", "ConstructAutoLink.tsx"), "utf8");
ok("auto-link: the renderer links off the planner and never twice per session",
  /planConstructAutoLink\(/.test(autoLink) && /attemptedRef\.current\.add\(name\)/.test(autoLink) && /linkConstructInstance\(\{ bridge, name, connectPairing \}\)/.test(autoLink));
for (const channel of ["release", "nightly"]) {
  const components = path.join(repoRoot, "patches", `t3code-${channel}`, "overlays", "apps", "web", "src", "components");
  const relink = fs.readFileSync(path.join(components, "ConstructAutoLink.tsx"), "utf8");
  const relinkLink = fs.readFileSync(path.join(components, "constructInstances.link.ts"), "utf8");
  ok(`auto-link (${channel}): a VM whose session still has T3's old permissions is paired again once per session, in place`,
    /sessionHasLegacyPermissions\(session\.value\)/.test(relink) && /planConstructRelink\(\{/.test(relink) &&
    /relinkAttemptedRef\.current\.add\(plan\.name\)/.test(relink) &&
    /host: input\.baseUrl,\n\s*pairingCode: token,\n\s*expectedEnvironmentId: input\.environmentId,/.test(relinkLink));
  ok(`auto-link (${channel}): upstream's pair-again notice is dismissed by a layout effect for the VMs Construct re-links`,
    /useLayoutEffect\(\(\) => \{[^}]*setLocalStorageItem\(`t3code:permission-update:v1:\$\{environmentId\}`/.test(relink));
}
