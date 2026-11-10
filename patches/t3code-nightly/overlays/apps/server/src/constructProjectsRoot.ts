// @effect-diagnostics nodeBuiltinImport:off - the folder belongs to the executing VM.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const readConstructConfig = () => NodeFS.readFileSync("/etc/construct/config.env", "utf8");

/**
 * Where "New project" creates its folders on a Construct VM: the VM's `WORKSPACE_ROOT`
 * (`/root/repos` by default), beside the checked-out repos instead of in T3's data directory.
 * Only the VM's own T3 server (default T3 home) uses it; test and isolated servers keep
 * `<baseDir>/projects`, and so does every server without Construct's config (Desktop, WSL).
 */
export function constructNamedProjectsRoot(
  baseDir: string,
  readConfig: () => string = readConstructConfig,
  homeDir: string = NodeOS.homedir(),
): string | undefined {
  if (NodePath.resolve(baseDir) !== NodePath.join(homeDir, ".t3")) return undefined;
  try {
    const match = /^WORKSPACE_ROOT=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s'"\r\n]+))$/m.exec(
      readConfig(),
    );
    const root = match?.[1] ?? match?.[2] ?? match?.[3];
    return root !== undefined && NodePath.isAbsolute(root) ? NodePath.resolve(root) : undefined;
  } catch {
    return undefined;
  }
}
