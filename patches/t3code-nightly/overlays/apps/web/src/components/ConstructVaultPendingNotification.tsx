import type {
  ConstructVaultApproval,
  ConstructVaultApprovalsResult,
  ConstructVaultDecideResult,
  ConstructVaultDecision,
  DesktopBridge,
  EnvironmentId,
} from "@t3tools/contracts";
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
  type ConstructVaultRecentApproval,
  type ConstructVaultResultLine,
  isVaultApproveArmed,
  rememberVaultApprovals,
  settleVaultDecided,
  vaultDecisionResultText,
  vaultDecisionSettles,
} from "./constructVaultPending.logic";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";

const POLL_INTERVAL_MS = 3_000;
type VaultToastId = ReturnType<typeof toastManager.add>;
type CompanionBridge = Pick<DesktopBridge, "constructVaultApprovals" | "constructVaultDecide">;
/** Requests whose banner the user closed: it stays away until another request waits. */
const hiddenVaultRequestKeys = new Set<string>();

/** The Desktop app's way to the Construct Companion on this PC; null in a browser. */
function companionBridge(): CompanionBridge | null {
  const bridge = window.desktopBridge;
  if (
    bridge === undefined ||
    typeof bridge.constructVaultApprovals !== "function" ||
    typeof bridge.constructVaultDecide !== "function"
  ) {
    return null;
  }
  return bridge;
}

/**
 * The key vault banner: while an agent's `construct secret …` waits for the user's
 * approval on a connected Construct VM, every open client (phone or PC) shows it,
 * with an Approve link to the approval page, or the hint to approve in the Companion
 * when there is no link. Every server that advertises `constructVaultPending` is asked
 * every 3 seconds while the page is visible. In the Desktop app the Construct Companion
 * on this PC is asked as well: its approvals are listed with their dialog texts and
 * Deny / Approve buttons that answer them through the Companion, and a VM's note for
 * the same request is not shown a second time. Elsewhere the banner only links: it
 * never approves anything and never sees a secret. It goes away by itself once nothing
 * waits; closing it hides the requests it showed.
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
    const bridge = companionBridge();
    if (ids.length === 0 && bridge === null) return;
    let cancelled = false;
    let polling = false;
    let closingBanner = false;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    let active: {
      readonly toastId: VaultToastId;
      readonly signature: string;
      readonly keys: ReadonlyArray<string>;
    } | null = null;
    const readings = new Map<EnvironmentId, ConstructVaultPendingReading>();
    // The Companion's side (Desktop app only). `approvals` is always its last answer.
    let approvals: ReadonlyArray<ConstructVaultApproval> = [];
    let recent: ReadonlyMap<string, ConstructVaultRecentApproval> = new Map();
    let decided: ReadonlySet<string> = new Set();
    let busy = false;
    let resultLine: ConstructVaultResultLine | null = null;
    const shownSince = new Map<string, number>();

    const closeBanner = () => {
      shownSince.clear();
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

    const decide = (id: string, decision: ConstructVaultDecision) => {
      if (bridge === null || busy || cancelled || decided.has(id)) return;
      const approval = approvals.find((item) => item.id === id);
      if (approval === undefined) return;
      if (decision === "approve" && !isVaultApproveArmed(shownSince.get(id), Date.now())) return;
      // Gone at once; the items below move up, so their Approve arms again.
      busy = true;
      decided = new Set([...decided, id]);
      resultLine = {
        text: vaultDecisionResultText(approval, decision, "pending"),
        at: Date.now(),
        pending: true,
      };
      shownSince.clear();
      render();
      void bridge
        .constructVaultDecide(id, decision)
        .catch((): ConstructVaultDecideResult => ({ ok: false, reason: "error" }))
        .then((outcome) => {
          if (cancelled) return;
          busy = false;
          if (!vaultDecisionSettles(outcome)) {
            decided = new Set([...decided].filter((other) => other !== id));
          }
          resultLine = {
            text: vaultDecisionResultText(approval, decision, outcome),
            at: Date.now(),
            pending: false,
          };
          render();
        });
    };

    const showBanner = (banner: ConstructVaultBanner) => {
      const description = <ConstructVaultBannerBody banner={banner} onDecide={decide} />;
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
          resultLine = null;
          shownSince.clear();
        },
      });
      active = { toastId, signature: banner.signature, keys: banner.keys };
    };

    const render = () => {
      if (renderTimer !== null) clearTimeout(renderTimer);
      renderTimer = null;
      if (cancelled) return;
      const now = Date.now();
      const banner = buildConstructVaultBanner(
        readings.values(),
        now,
        hiddenVaultRequestKeys,
        bridge === null
          ? null
          : { approvals, recent, decided, shownSince, busy, result: resultLine },
      );
      if (banner === null) {
        closeBanner();
        return;
      }
      for (const item of banner.items) {
        if (item.kind === "approval" && !shownSince.has(item.id)) shownSince.set(item.id, now);
      }
      showBanner(banner);
      // Approve arms and the result line ends without waiting for the next poll.
      if (banner.nextChangeAt !== null) {
        renderTimer = setTimeout(render, Math.max(0, banner.nextChangeAt - now) + 20);
      }
    };

    const refresh = async () => {
      // All servers and the Companion at once: one slow answer must not hold up the others.
      const [results, listed] = await Promise.all([
        Promise.all(ids.map((environmentId) => read({ environmentId }))),
        bridge === null
          ? null
          : bridge
              .constructVaultApprovals()
              .catch((): ConstructVaultApprovalsResult => ({ available: false })),
      ]);
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
      if (listed !== null) {
        // Only what the Companion lists now: an approval answered anywhere else is gone.
        approvals = listed.available ? listed.approvals : [];
        recent = rememberVaultApprovals(recent, approvals, receivedAt);
        decided = settleVaultDecided(decided, approvals);
      }
      render();
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
      if (document.visibilityState !== "visible") return;
      // Coming back to the page shows the approvals anew: Approve arms again.
      shownSince.clear();
      poll();
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (renderTimer !== null) clearTimeout(renderTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      closeBanner();
    };
  }, [environmentKey, read]);

  return null;
}

/** Inline elements only: the toast renders its description inside a paragraph. */
function ConstructVaultBannerBody({
  banner,
  onDecide,
}: {
  readonly banner: ConstructVaultBanner;
  readonly onDecide: (id: string, decision: ConstructVaultDecision) => void;
}) {
  return (
    <span className="mt-0.5 flex flex-col gap-1.5" data-slot="construct-vault-pending">
      {banner.items.map((item) =>
        item.kind === "approval" ? (
          <span className="flex flex-col gap-1" data-slot="construct-vault-approval" key={item.key}>
            <span className="font-medium text-foreground">{item.title}</span>
            <span className="whitespace-pre-line break-words">{item.message}</span>
            <span>{item.detail}</span>
            <span className="flex justify-end gap-2">
              <Button
                disabled={banner.busy}
                onClick={() => onDecide(item.id, "deny")}
                size="xs"
                variant="outline"
              >
                {item.denyLabel}
              </Button>
              <Button
                disabled={banner.busy || !item.armed}
                onClick={() => onDecide(item.id, "approve")}
                size="xs"
              >
                {item.approveLabel}
              </Button>
            </span>
          </span>
        ) : (
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
        ),
      )}
      {banner.more !== null ? <span>{banner.more}</span> : null}
      {banner.companionHint !== null ? <span>{banner.companionHint}</span> : null}
      {banner.result !== null ? (
        <span className="text-foreground" data-slot="construct-vault-result" role="status">
          {banner.result}
        </span>
      ) : null}
    </span>
  );
}
