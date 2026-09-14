// Wine's default Z: drive exposes the build host's filesystem. Pass the isolated
// entry as a Windows path so Electron does not resolve it beneath its C: drive.
export function constructWindowsProbe(executable: string, entry: string, hostPlatform: string) {
  const wine = hostPlatform === "linux";
  const args = [
      "--no-global-search-paths",
      wine ? `Z:${entry.replaceAll("/", "\\")}` : entry,
      "--version",
  ];
  return {
    command: wine ? "sh" : process.execPath,
    // Electron under Wine cannot use Node's socket-backed stdio pipes. Give it
    // real files for stdin and output, then relay the diagnostic output and preserve its exit code.
    // Paths are positional arguments, never interpolated into shell code.
    args: wine ? [
      "-c", 'output=$1; shift; : >"$output.stdin"; wine "$@" <"$output.stdin" >"$output" 2>&1; result=$?; cat "$output"; exit "$result"',
      "construct-windows-probe", `${entry}.construct-probe.log`, executable, ...args,
    ] : args,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ASAR: "1",
      NODE_PATH: "",
      NODE_OPTIONS: "",
    },
  };
}
