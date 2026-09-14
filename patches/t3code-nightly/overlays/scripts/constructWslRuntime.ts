import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { build } from "vite-plus/pack";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { isExternalCliDependency } from "./lib/cli-external-packages.ts";

class ConstructWslBuildError extends Schema.TaggedError<ConstructWslBuildError>()(
  "ConstructWslBuildError", { step: Schema.String, cause: Schema.Unknown },
) {}

// Nightly installs a CLI archive in WSL. Embed Construct's prepared server with
// the build Node, preserving its runtime patches and the supplied Linux native.
export const constructWslRuntime = Effect.fn("constructWslRuntime")(function* (
  prebuild: string, version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const server = path.join(root, "apps/server");
  yield* fs.stat(prebuild);
  const output = yield* fs.makeTempDirectoryScoped({ prefix: "construct-wsl-" });
  const run = Effect.fn("constructWslRun")(function* (command: string, args: string[]) {
    const child = yield* spawner.spawn(ChildProcess.make(command, args, {
      cwd: root, stdout: "inherit", stderr: "inherit",
    }));
    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new ConstructWslBuildError({ step: command, cause: { args, exitCode } });
    }
  });
  // Flatten shared chunks from the prepared bundle. Recompiling source here
  // would lose the two Construct patches already applied to dist/bin.mjs.
  const bundled = path.join(output, "bundle");
  yield* Effect.tryPromise({
    try: () => build({
      config: false,
      entry: [path.join(server, "dist/bin.mjs")],
      outDir: bundled,
      format: "esm",
      platform: "node",
      deps: { neverBundle: isExternalCliDependency },
    }),
    catch: (cause) => new ConstructWslBuildError({ step: "bundle", cause }),
  });
  yield* fs.makeDirectory(path.join(server, "dist-exe"), { recursive: true });
  const config = path.join(output, "sea.json");
  yield* fs.writeFileString(config, yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    main: path.join(bundled, "bin.mjs"),
    output: path.join(server, "dist-exe/t3-linux-x64"),
    mainFormat: "module",
    useCodeCache: false,
    disableExperimentalSEAWarning: true,
  }));
  yield* run(process.execPath, ["--build-sea", config]);
  yield* run("cargo", ["build", "--locked", "--release", "--manifest-path",
    "native/resource-monitor/Cargo.toml"]);
  const monitor = path.join(output, "resource-monitor/linux-x64");
  yield* fs.makeDirectory(monitor, { recursive: true });
  yield* fs.copyFile(path.join(root, "native/resource-monitor/target/release/t3-resource-monitor"),
    path.join(monitor, "t3-resource-monitor"));
  yield* run(process.execPath, ["scripts/build-cli-archive.ts", "--platform", "linux",
    "--arch", "x64", "--version", version, "--output-dir", output,
    "--resource-monitor-dir", path.dirname(monitor)]);
  const stem = `t3-${version}-linux-x64`;
  const archive = path.join(output, `${stem}.tar.gz`);
  yield* run("tar", ["-xzf", archive, "-C", output]);
  yield* fs.copyFile(prebuild, path.join(output, stem, "node_modules/node-pty/build/Release/pty.node"));
  yield* run("tar", ["--hard-dereference", "-czf", archive, "-C", output, stem]);
  yield* run(process.execPath, ["scripts/smoke-cli-archive.ts", "--archive", archive,
    "--expect-version", serverPackageJson.version]);
  return archive;
});
