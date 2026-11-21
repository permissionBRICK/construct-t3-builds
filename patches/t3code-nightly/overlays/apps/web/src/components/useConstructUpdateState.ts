import type { ConstructVmUpdate, DesktopUpdateState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { readConstructVmUpdate, runConstructVmUpdate } from "../state/constructVmUpdate";
import { useServerConfigs } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { setConstructLinkedRemotes, setConstructVmUpdateRunner } from "./constructUpdate";
import { constructEnvironmentConnected, constructLinkedRemotes } from "./constructInstances.logic";
import { constructVmUpdateState, withConstructReprovisionOffer } from "./constructUpdate.logic";

const VM_POLL_MS = 5 * 60_000;
const VM_RUNNING_POLL_MS = 30_000;

/**
 * The state T3's update control at the bottom of the sidebar shows, with Construct's update
 * in it. In the Desktop app that is the main process's state (the device agent's one Update,
 * or the old Construct's scripts, with the VMs behind it that are linked here). In a browser,
 * where T3 shows no app update, it is the Construct update of the VM this page is served by,
 * when that VM's server offers one.
 */
export function useConstructUpdateState(desktop: DesktopUpdateState | null): DesktopUpdateState | null {
  const { environments } = useEnvironments();
  const remotes = useMemo(
    () =>
      isElectron
        ? constructLinkedRemotes(
            environments.map((environment) => ({
              environmentId: String(environment.environmentId),
              label: environment.label,
              displayUrl: environment.displayUrl,
              targetKind: environment.entry.target._tag,
              connected: constructEnvironmentConnected(environment),
            })),
          )
        : [],
    [environments],
  );
  // The control's Reprovision and T3 Code update target these connections.
  useEffect(() => {
    if (isElectron) setConstructLinkedRemotes(remotes);
  }, [remotes]);
  const vm = useConstructVmUpdate();
  return useMemo(
    () => (isElectron ? withConstructReprovisionOffer(desktop, remotes) : (constructVmUpdateState(vm, APP_VERSION) ?? desktop)),
    [desktop, remotes, vm],
  );
}

/** The primary environment's `construct.vmUpdate.status`, polled while it is offered (browser only). */
function useConstructVmUpdate(): ConstructVmUpdate | null {
  const primary = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const offered =
    !isElectron &&
    primary !== null &&
    serverConfigs.get(primary)?.environment.capabilities.constructVmUpdate === true;
  // A new function every render: the effects below read the latest through refs.
  const readCommand = useAtomCommand(readConstructVmUpdate, { reportFailure: false, reportDefect: false });
  const runCommand = useAtomCommand(runConstructVmUpdate, { reportFailure: false, reportDefect: false });
  const read = useRef(readCommand);
  const run = useRef(runCommand);
  read.current = readCommand;
  run.current = runCommand;
  const [vm, setVm] = useState<ConstructVmUpdate | null>(null);
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    if (!offered || primary === null) {
      setVm(null);
      setConstructVmUpdateRunner(null);
      return;
    }
    setConstructVmUpdateRunner(async () => {
      const result = await run.current({ environmentId: primary });
      setNudge((value) => value + 1);
      return AsyncResult.isSuccess(result)
        ? result.value
        : { started: false, message: "The VM could not be asked to update." };
    });
    return () => setConstructVmUpdateRunner(null);
  }, [offered, primary]);

  useEffect(() => {
    if (!offered || primary === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await read.current({ environmentId: primary });
      if (cancelled) return;
      // A failed read (an offline server, a stock one) has nothing to say.
      const next = AsyncResult.isSuccess(result) ? result.value : null;
      setVm(next);
      timer = setTimeout(() => void poll(), next?.running ? VM_RUNNING_POLL_MS : VM_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [offered, primary, nudge]);

  return offered ? vm : null;
}
