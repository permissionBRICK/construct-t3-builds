import { assert, it } from "@effect/vitest";
import { constructWindowsProbe } from "./constructWindowsProbe.ts";

it("loads a Windows sidecar with the packaged Electron through Wine on Linux", () => {
  const probe = constructWindowsProbe("/tmp/app/T3 Code.exe", "/tmp/isolated tree/bin.mjs", "linux");
  assert.equal(probe.command, "sh");
  assert.include(probe.args[1]!, '<"$output.stdin" >"$output"');
  assert.deepEqual(probe.args.slice(2), [
    "construct-windows-probe", "/tmp/isolated tree/bin.mjs.construct-probe.log", "/tmp/app/T3 Code.exe", "--no-global-search-paths", "Z:\\tmp\\isolated tree\\bin.mjs", "--version",
  ]);
  assert.equal(probe.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(probe.env.ELECTRON_NO_ASAR, "1");
  assert.equal(probe.env.NODE_PATH, "");
  assert.equal(probe.env.NODE_OPTIONS, "");
});

it("keeps native Node execution on Windows without rewriting Windows paths", () => {
  const probe = constructWindowsProbe("C:\\app\\t3.exe", "C:\\isolated tree\\bin.mjs", "win32");
  assert.equal(probe.command, process.execPath);
  assert.deepEqual(probe.args, ["--no-global-search-paths", "C:\\isolated tree\\bin.mjs", "--version"]);
});
