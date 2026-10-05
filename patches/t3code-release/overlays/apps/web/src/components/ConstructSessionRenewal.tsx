import { useEffect } from "react";

import { renewConstructSessions } from "../state/constructSessionRenewal";
import { useAtomCommand } from "../state/use-atom-command";

const RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Keeps this client's paired sessions alive while it is open. The browser's own
 * session is checked at once; saved connections renew when they connect, and every
 * six hours for those that stay connected.
 */
export function ConstructSessionRenewal() {
  const renew = useAtomCommand(renewConstructSessions, { reportFailure: false });
  useEffect(() => {
    void renew({ savedConnections: false });
    const timer = window.setInterval(
      () => void renew({ savedConnections: true }),
      RENEWAL_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [renew]);
  return null;
}
