import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { readConstructVaultPending } from "../state/constructVaultPending";
import { useServerConfigs } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import {
  buildConstructVaultBanner,
  type ConstructVaultBanner,
  type ConstructVaultPendingReading,
} from "./constructVaultPending.logic";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";

const POLL_INTERVAL_MS = 3_000;
type VaultToastId = ReturnType<typeof toastManager.add>;
/** Requests whose banner the user closed: it stays away until another request waits. */
const hiddenVaultRequestKeys = new Set<string>();

/**
 * The key vault banner: while an agent's `construct secret …` waits for the user's
 * approval on a connected Construct VM, every open client (phone or PC) shows it,
 * with an Approve link to the approval page, or the hint to approve in the Companion
 * when there is no link. Every server that advertises `constructVaultPending` is asked
 * every 3 seconds while the page is visible. The banner only links: it never approves
 * anything and never sees a secret. It goes away by itself once nothing waits;
 * closing it hides the requests it showed.
 */
export function ConstructVaultPendingNotification() {
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const read = useAtomCommand(readConstructVaultPending, {
    reportFailure: false,
    reportDefect: false,
  });
  const environmentIds = [...serverConfigs]
    .filter(([, config]) => config.environment.capabilities.constructVaultPending === true)
    .map(([environmentId]) => environmentId);
  // A stable dependency: the effect below restarts only when the SET of servers changes.
  const environmentKey = environmentIds.join("\n");
  const labels = useMemo(
    () => new Map(environments.map((env) => [env.environmentId, env.label])),
    [environments],
  );
  // Read by the poll below without restarting it when a label changes.
  const labelsRef = useRef(labels);
  useEffect(() => {
    labelsRef.current = labels;
  }, [labels]);

  useEffect(() => {
    const ids = environmentKey === "" ? [] : (environmentKey.split("\n") as EnvironmentId[]);
    if (ids.length === 0) return;
    let cancelled = false;
    let polling = false;
    let closingBanner = false;
    let active: {
      readonly toastId: VaultToastId;
      readonly signature: string;
      readonly keys: ReadonlyArray<string>;
    } | null = null;
    const readings = new Map<EnvironmentId, ConstructVaultPendingReading>();

    const closeBanner = () => {
      if (active === null) return;
      const { toastId } = active;
      active = null;
      closingBanner = true;
      try {
        toastManager.close(toastId);
      } finally {
        closingBanner = false;
      }
    };

    const showBanner = (banner: ConstructVaultBanner) => {
      const description = <ConstructVaultBannerBody banner={banner} />;
      if (active !== null) {
        if (active.signature !== banner.signature) {
          toastManager.update(active.toastId, { title: banner.title, description });
        }
        active = { toastId: active.toastId, signature: banner.signature, keys: banner.keys };
        return;
      }
      const toastId: VaultToastId = toastManager.add({
        ...stackedThreadToast({
          type: "warning",
          title: banner.title,
          description,
          timeout: 0,
          data: {
            hideCopyButton: true,
            leadingIcon: <KeyRoundIcon aria-hidden="true" className="size-4 text-warning" />,
          },
        }),
        // Closed by the user (button or swipe): hide what it showed.
        onClose: () => {
          if (closingBanner || active?.toastId !== toastId) return;
          for (const key of active.keys) hiddenVaultRequestKeys.add(key);
          active = null;
        },
      });
      active = { toastId, signature: banner.signature, keys: banner.keys };
    };

    const refresh = async () => {
      // All servers at once: one slow server must not hold up the others.
      const results = await Promise.all(ids.map((environmentId) => read({ environmentId })));
      if (cancelled) return;
      const receivedAt = Date.now();
      results.forEach((result, index) => {
        const environmentId = ids[index];
        // An unreachable server keeps its last answer; its requests still expire on time.
        if (environmentId === undefined || AsyncResult.isFailure(result)) return;
        readings.set(environmentId, {
          environmentLabel: labelsRef.current.get(environmentId) ?? "Construct VM",
          pending: result.value,
          receivedAt,
        });
      });
      const banner = buildConstructVaultBanner(
        readings.values(),
        Date.now(),
        hiddenVaultRequestKeys,
      );
      if (banner === null) closeBanner();
      else showBanner(banner);
    };

    // One request round at a time, and none while the page is hidden.
    const poll = () => {
      if (polling || document.visibilityState === "hidden") return;
      polling = true;
      void refresh().finally(() => {
        polling = false;
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") poll();
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      closeBanner();
    };
  }, [environmentKey, read]);

  return null;
}

/** Inline elements only: the toast renders its description inside a paragraph. */
function ConstructVaultBannerBody({ banner }: { readonly banner: ConstructVaultBanner }) {
  return (
    <span className="mt-0.5 flex flex-col gap-1.5" data-slot="construct-vault-pending">
      {banner.items.map((item) => (
        <span className="flex items-start gap-2" key={item.key}>
          <span className="flex min-w-0 flex-1 flex-col">
            {banner.listed ? (
              <span className="font-medium text-foreground">{item.names}</span>
            ) : null}
            <span>{item.detail}</span>
          </span>
          {item.approveUrl !== null ? (
            <Button
              render={<a href={item.approveUrl} rel="noopener noreferrer" target="_blank" />}
              size="xs"
            >
              Approve
            </Button>
          ) : null}
        </span>
      ))}
      {banner.more !== null ? <span>{banner.more}</span> : null}
      {banner.companionHint !== null ? <span>{banner.companionHint}</span> : null}
    </span>
  );
}
