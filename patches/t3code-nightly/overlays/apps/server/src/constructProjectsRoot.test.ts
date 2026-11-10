import { describe, expect, it } from "@effect/vitest";
import { constructNamedProjectsRoot } from "./constructProjectsRoot.ts";

const home = "/root";
const vmHome = "/root/.t3";
const config = (text: string) => () => text;
const root = (text: string, baseDir = vmHome) =>
  constructNamedProjectsRoot(baseDir, config(text), home);

describe("Construct new-project root", () => {
  it("uses the VM's workspace root for the VM's own T3 server", () => {
    expect(root("AGENT_NAME=vm\nWORKSPACE_ROOT=/root/repos\nT3CODE=true\n")).toBe("/root/repos");
    expect(root('WORKSPACE_ROOT="/srv/work space"\n')).toBe("/srv/work space");
    expect(root("WORKSPACE_ROOT='/srv/repos'\n")).toBe("/srv/repos");
    expect(root("WORKSPACE_ROOT=/root/repos/\n", "/root/.t3/")).toBe("/root/repos");
  });

  it("keeps upstream's folder without a usable Construct workspace root", () => {
    for (const text of [
      "",
      "AGENT_NAME=vm\n",
      "WORKSPACE_ROOT=\n",
      "WORKSPACE_ROOT=repos\n",
      "# WORKSPACE_ROOT=/root/repos\n",
      "WORKSPACE_ROOT=/root/repos extra\n",
    ]) {
      expect(root(text)).toBeUndefined();
    }
    expect(
      constructNamedProjectsRoot(
        vmHome,
        () => {
          throw new Error("ENOENT");
        },
        home,
      ),
    ).toBeUndefined();
  });

  it("never applies to a server with its own T3 home, such as a test or isolated server", () => {
    let reads = 0;
    const readConfig = () => {
      reads++;
      return "WORKSPACE_ROOT=/root/repos\n";
    };
    for (const baseDir of [
      "/tmp/t3-test-abc",
      "/root/.t3-dev",
      "/root/.t3/userdata",
      "/home/other/.t3",
    ]) {
      expect(constructNamedProjectsRoot(baseDir, readConfig, home)).toBeUndefined();
    }
    expect(reads).toBe(0);
  });
});
