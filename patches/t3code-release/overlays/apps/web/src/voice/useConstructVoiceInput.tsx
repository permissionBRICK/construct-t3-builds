/**
 * Construct's voice input for the chat composer: the microphone control, the
 * Alt+Q shortcut, live transcript insertion into the draft or question answer,
 * and the send that waits for the final transcript.
 *
 * ChatComposer calls this hook once and passes everything it needs from the
 * composer explicitly, so the composer itself only places the returned controls
 * and lets `interceptSubmit` take a submit while voice input is active.
 */

import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn, randomUUID } from "../lib/utils";
import { useServerConfigs } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import {
  sendVoiceAudio as sendVoiceAudioCommand,
  startVoiceInput as startVoiceInputCommand,
  stopVoiceInput as stopVoiceInputCommand,
} from "../state/voiceInput";
import {
  canCaptureClientAudio,
  isSecureContext,
  resolveVoiceInputSource,
  startClientAudioCapture,
  type ClientAudioCapture,
} from "./clientAudioCapture";
import { createVoiceAudioSender, type VoiceAudioSender } from "./voiceAudioSender";
import { canReconnectVoiceInput, describeVoiceInputFailure } from "./voiceInputFailure";
import { recoverVoiceSubscription } from "./voiceSessionRecovery";

export interface ConstructVoiceInputOptions<SubmitArgs extends ReadonlyArray<unknown>> {
  readonly environmentId: EnvironmentId;
  /** Only whether it is set matters: an unavailable environment cannot record. */
  readonly environmentUnavailable: unknown;
  readonly composerDraftTargetKey: string;
  readonly isComposerApprovalState: boolean;
  readonly isChoiceOnlyPendingQuestion: boolean;
  readonly activePendingUserInput: { readonly requestId: string } | null;
  readonly activePendingProgress: {
    readonly customAnswer: string;
    readonly activeQuestion: { readonly id: string } | null;
  } | null;
  readonly activePendingIsResponding: boolean;
  /** The text the composer last wrote, including writes not rendered yet. */
  readonly promptRef: { current: string };
  readonly readComposerSnapshot: () => { readonly value: string; readonly expandedCursor: number };
  readonly applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options: { expectedText: string; focusEditorAfterReplace: boolean },
  ) => boolean;
  /**
   * Returns the composer's submit. A getter, because the composer declares its
   * submit after this hook: the submit calls `interceptSubmit` first.
   */
  readonly getSubmitComposer: () => (event: undefined, ...args: SubmitArgs) => void;
}

export interface ConstructVoiceInput<SubmitArgs extends ReadonlyArray<unknown>> {
  /** The control beside the send button; empty while a question is open. */
  readonly footerControl: ReactNode;
  /** The control in its own row under a question answer, which has no footer on mobile. */
  readonly questionControl: ReactNode;
  /**
   * Called first in the composer's submit: while voice input is active, Enter or
   * Send stops recording and the send happens once the final transcript is in
   * the draft. Returns whether it took the submit.
   */
  readonly interceptSubmit: (
    event: { preventDefault: () => void } | undefined,
    ...args: SubmitArgs
  ) => boolean;
}

/**
 * A live voice session's insertion window plus, for client-captured audio, the
 * microphone and the sender pushing it to the server.
 */
type VoiceInsertionState<SubmitArgs> = {
  sessionId: string;
  targetKey: string;
  prefix: string;
  suffix: string;
  rendered: string;
  lastSetInput: string;
  source: "client" | "host";
  capture: ClientAudioCapture | null;
  sender: VoiceAudioSender | null;
  cancelled: boolean;
  stopRequested: boolean;
  submitArgs?: SubmitArgs;
};

/** Idempotent, so every path that drops a session can call it. */
function releaseVoiceCapture(insertion: VoiceInsertionState<unknown> | null): void {
  if (!insertion) return;
  insertion.cancelled = true;
  insertion.capture?.stop();
  insertion.capture = null;
  insertion.sender?.stop();
  insertion.sender = null;
}

/**
 * Flushes the microphone and the queued audio, then asks the server to finish
 * until it confirms. `requestStop` resolves whether the server stopped the
 * session; a request that is lost while reconnecting is repeated for 30 seconds.
 */
async function finishVoiceSession(
  insertion: VoiceInsertionState<unknown>,
  requestStop: () => Promise<boolean>,
): Promise<void> {
  await insertion.capture?.finish();
  insertion.capture = null;
  await insertion.sender?.drain();
  if (insertion.cancelled) {
    void requestStop();
    return;
  }
  const deadline = Date.now() + 30_000;
  while (!insertion.cancelled) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      requestStop(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2_000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (stopped) return;
    if (Date.now() >= deadline) {
      throw new Error("Could not finish transcription after reconnecting.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}

export function useConstructVoiceInput<SubmitArgs extends ReadonlyArray<unknown>>(
  options: ConstructVoiceInputOptions<SubmitArgs>,
): ConstructVoiceInput<SubmitArgs> {
  const {
    environmentId,
    environmentUnavailable,
    composerDraftTargetKey,
    isComposerApprovalState,
    isChoiceOnlyPendingQuestion,
    activePendingUserInput,
    activePendingProgress,
    activePendingIsResponding,
    promptRef,
    readComposerSnapshot,
    applyPromptReplacement,
    getSubmitComposer,
  } = options;
  const serverConfigs = useServerConfigs();
  const supportsVoiceInput =
    serverConfigs.get(environmentId)?.environment.capabilities.voiceInput === true;
  const supportsClientVoiceAudio =
    serverConfigs.get(environmentId)?.environment.capabilities.voiceInputClientAudio === true;
  const voiceInputSourcePreference = useClientSettings((settings) => settings.voiceInputSource);
  const voiceInputSource = resolveVoiceInputSource({
    preference: voiceInputSourcePreference,
    canCaptureHere: canCaptureClientAudio(),
    serverAcceptsClientAudio: supportsClientVoiceAudio,
    secureContext: isSecureContext(),
  });
  const voiceSourceHint =
    voiceInputSource.source === "client"
      ? "records with this device's microphone"
      : voiceInputSource.source === "host"
        ? "records through the Construct host bridge"
        : voiceInputSource.reason;
  const runStartVoiceInput = useAtomCommand(startVoiceInputCommand, { reportFailure: false });
  const runStopVoiceInput = useAtomCommand(stopVoiceInputCommand, { reportFailure: false });
  const runSendVoiceAudio = useAtomCommand(sendVoiceAudioCommand, { reportFailure: false });

  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceLive, setVoiceLive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("Recording");
  const [voiceSubmission, setVoiceSubmission] = useState<{
    targetKey: string;
    args: SubmitArgs;
  } | null>(null);
  const sentVoiceSubmissionRef = useRef<typeof voiceSubmission>(null);
  const voiceInsertionRef = useRef<VoiceInsertionState<SubmitArgs> | null>(null);
  const voiceShortcutRef = useRef<{ started: boolean; downAt: number } | null>(null);

  const voiceInputDisabled =
    environmentUnavailable !== null ||
    isComposerApprovalState ||
    isChoiceOnlyPendingQuestion ||
    activePendingIsResponding ||
    (activePendingUserInput !== null && !activePendingProgress?.activeQuestion);

  // The question answer is a separate draft from the regular chat prompt.
  const voiceTargetKey = JSON.stringify([
    composerDraftTargetKey,
    activePendingUserInput?.requestId ?? null,
    activePendingProgress?.activeQuestion?.id ?? null,
    isComposerApprovalState,
    activePendingIsResponding,
    isChoiceOnlyPendingQuestion,
  ]);
  const voiceTargetRef = useRef(voiceTargetKey);
  useLayoutEffect(() => {
    voiceTargetRef.current = voiceTargetKey;
  });

  const stopVoiceRecording = useStableCallback(() => {
    setVoiceLevel(0);
    setVoiceLive(false);
    const insertion = voiceInsertionRef.current;
    if (!insertion || insertion.stopRequested) return;
    insertion.stopRequested = true;
    setVoiceStatus("Finishing transcription…");
    void finishVoiceSession(insertion, async () => {
      const result = await runStopVoiceInput({ environmentId, sessionId: insertion.sessionId });
      return AsyncResult.isSuccess(result) && result.value.stopped;
    }).catch((error: unknown) => {
      if (insertion.cancelled) return;
      console.warn("[voice] finishing failed", error);
      releaseVoiceCapture(insertion);
      if (voiceInsertionRef.current === insertion) {
        voiceInsertionRef.current = null;
        setIsVoiceRecording(false);
      }
      toastManager.add({
        type: "error",
        title: "Voice input stopped",
        description: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const startVoiceRecording = useStableCallback(() => {
    if (!supportsVoiceInput || voiceInsertionRef.current || voiceInputDisabled) return;
    if (voiceInputSource.source === null) {
      toastManager.add({
        type: "error",
        title: "Voice input unavailable",
        description: voiceInputSource.reason,
      });
      return;
    }
    const source = voiceInputSource.source;
    const snapshot = readComposerSnapshot();
    // A collapsed question can still expose an editor snapshot from the prior draft.
    const value = activePendingProgress?.customAnswer ?? snapshot.value;
    const cursor = snapshot.value === value ? snapshot.expandedCursor : value.length;
    const sessionId = randomUUID();
    const insertion: VoiceInsertionState<SubmitArgs> = {
      sessionId,
      targetKey: voiceTargetRef.current,
      prefix: value.slice(0, cursor),
      suffix: value.slice(cursor),
      rendered: "",
      lastSetInput: value,
      source,
      capture: null,
      sender: null,
      cancelled: false,
      stopRequested: false,
    };
    voiceInsertionRef.current = insertion;
    setVoiceStatus("Starting microphone…");
    setIsVoiceRecording(true);
    setVoiceLevel(0);
    setVoiceLive(false);
    // Red only once speech is kept: the transcription stream is open and the
    // microphone has delivered audio. Until then the control stays yellow.
    let streamOpen = false;
    let heard = false;
    let live = false;
    const markLive = () => {
      if (
        live ||
        !streamOpen ||
        !heard ||
        insertion.stopRequested ||
        voiceInsertionRef.current !== insertion
      ) {
        return;
      }
      live = true;
      setVoiceLive(true);
      setVoiceStatus((status) => (status === "Starting microphone…" ? "Recording" : status));
    };

    const failRecording = (message: string) => {
      if (insertion.cancelled || voiceInsertionRef.current !== insertion) return;
      console.warn("[voice] recording stopped", { sessionId, reason: message });
      releaseVoiceCapture(insertion);
      voiceInsertionRef.current = null;
      setIsVoiceRecording(false);
      setVoiceLevel(0);
      void runStopVoiceInput({ environmentId, sessionId });
      toastManager.add({ type: "error", title: "Voice input stopped", description: message });
    };
    if (source === "client") {
      insertion.sender = createVoiceAudioSender({
        send: async (chunk, sequence) => {
          const result = await runSendVoiceAudio({ environmentId, sessionId, chunk, sequence });
          if (AsyncResult.isFailure(result)) throw new Error("Audio upload interrupted");
          return result.value;
        },
        onState: (buffering) => {
          if (insertion.cancelled) return;
          setVoiceStatus(
            insertion.stopRequested
              ? "Finishing transcription…"
              : buffering
                ? "Reconnecting—still recording"
                : live
                  ? "Recording"
                  : "Starting microphone…",
          );
        },
        onError: failRecording,
      });
      insertion.capture = startClientAudioCapture({
        onChunk: (chunk) => {
          if (voiceInsertionRef.current !== insertion) return;
          insertion.sender?.push(chunk);
          heard = true;
          markLive();
        },
        onLevel: (level) => {
          if (voiceInsertionRef.current !== insertion) return;
          setVoiceLevel(level);
        },
        onError: failRecording,
      });
    }

    void recoverVoiceSubscription({
      isActive: () => !insertion.cancelled && voiceInsertionRef.current === insertion,
      onReconnecting: () => {
        insertion.sender?.setReady(false);
        setVoiceStatus(
          insertion.stopRequested ? "Finishing transcription…" : "Reconnecting—still recording",
        );
      },
      connect: async (resume, listening) => {
        const result = await runStartVoiceInput({
          environmentId,
          sessionId,
          source,
          resume,
          onEvent: (event) => {
            const active = voiceInsertionRef.current;
            if (!active || active.sessionId !== sessionId) return;
            if (event.type === "level") {
              setVoiceLevel(event.value);
              heard = true;
              markLive();
              return;
            }
            if (event.type === "listening") {
              listening();
              active.sender?.setReady(true);
              setVoiceStatus(
                active.stopRequested
                  ? "Finishing transcription…"
                  : live
                    ? "Recording"
                    : "Starting microphone…",
              );
              streamOpen = true;
              markLive();
              return;
            }
            if (event.type === "stopped") {
              console.info("[voice] recording stopped", { sessionId, reason: event.reason });
              if (event.reason !== "user-stop") {
                toastManager.add({
                  type: "info",
                  title: "Voice input stopped",
                  description:
                    event.reason === "recording-limit"
                      ? "The five-minute recording limit was reached."
                      : "Another recording was started.",
                });
              }
              if (
                active.submitArgs &&
                event.reason === "user-stop" &&
                voiceTargetRef.current === active.targetKey
              ) {
                setVoiceSubmission({ targetKey: active.targetKey, args: active.submitArgs });
              }
              releaseVoiceCapture(active);
              voiceInsertionRef.current = null;
              setIsVoiceRecording(false);
              setVoiceLevel(0);
              return;
            }
            if (event.type !== "transcript") return;
            // Rendered text can lag behind consecutive partials. Edits are allowed
            // while recording; only a target change cancels the session.
            if (voiceTargetRef.current !== active.targetKey) {
              stopVoiceRecording();
              releaseVoiceCapture(active);
              voiceInsertionRef.current = null;
              setIsVoiceRecording(false);
              return;
            }
            // Use the last requested replacement, including writes React/Lexical
            // has not displayed yet and before pending-answer ref synchronization.
            promptRef.current = active.lastSetInput;
            const transcript = event.text.trim();
            const leading = transcript && active.prefix && !/\s$/u.test(active.prefix) ? " " : "";
            const trailing = transcript && active.suffix && !/^\s/u.test(active.suffix) ? " " : "";
            const rendered = transcript ? `${leading}${transcript}${trailing}` : "";
            const nextInput = `${active.prefix}${rendered}${active.suffix}`;
            const applied = applyPromptReplacement(
              active.prefix.length,
              active.prefix.length + active.rendered.length,
              rendered,
              { expectedText: active.rendered, focusEditorAfterReplace: false },
            );
            if (!applied) {
              stopVoiceRecording();
              releaseVoiceCapture(active);
              voiceInsertionRef.current = null;
              setIsVoiceRecording(false);
              return;
            }
            active.rendered = rendered;
            active.lastSetInput = nextInput;
            // applyPromptReplacement already updates the controlled cursor. Calling
            // focusAt before the editor commits can echo its old text into the draft.
          },
        });
        return AsyncResult.isFailure(result)
          ? {
              retryable: canReconnectVoiceInput(result.cause),
              message: describeVoiceInputFailure(result.cause, source),
            }
          : { retryable: false };
      },
    })
      .then(() => {
        if (!insertion.cancelled && voiceInsertionRef.current === insertion) {
          failRecording("The voice stream ended unexpectedly.");
        }
      })
      .catch((error: unknown) =>
        failRecording(error instanceof Error ? error.message : String(error)),
      );
  });

  const toggleVoiceRecording = useStableCallback(() => {
    if (voiceInsertionRef.current) stopVoiceRecording();
    else startVoiceRecording();
  });

  const interceptSubmit = (
    event: { preventDefault: () => void } | undefined,
    ...args: SubmitArgs
  ): boolean => {
    const active = voiceInsertionRef.current;
    if (!active) return false;
    event?.preventDefault();
    if (!active.submitArgs) active.submitArgs = args;
    stopVoiceRecording();
    return true;
  };

  // Alt+Q mirrors Claude's tap/hold behavior: tap once to start, tap again to
  // stop, or hold the first press and recording stops when the key is released.
  // Ctrl+T still works where the browser does not keep it (the desktop app).
  useEffect(() => {
    if (!supportsVoiceInput) return;
    // Physical key, since macOS turns Option+Q into "œ". Without Ctrl, so AltGr+Q stays "@".
    const isAltQ = (event: KeyboardEvent) =>
      event.code === "KeyQ" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const isCtrlT = (event: KeyboardEvent) =>
      event.key.toLowerCase() === "t" && event.ctrlKey && !event.altKey && !event.metaKey;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAltQ(event) && !isCtrlT(event)) return;
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-chat-composer-form="true"]')
      )
        return;
      // Key repeats while holding must not type into the composer either.
      event.preventDefault();
      if (event.repeat) return;
      const wasRecording = voiceInsertionRef.current !== null;
      if (wasRecording) {
        stopVoiceRecording();
        voiceShortcutRef.current = { started: false, downAt: performance.now() };
      } else {
        startVoiceRecording();
        voiceShortcutRef.current = { started: true, downAt: performance.now() };
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // Releasing either key of a held Alt+Q ends the hold.
      const altQ = event.code === "KeyQ" || event.key === "Alt";
      if (!altQ && (event.key.toLowerCase() !== "t" || !event.ctrlKey)) return;
      const shortcut = voiceShortcutRef.current;
      voiceShortcutRef.current = null;
      if (shortcut?.started && performance.now() - shortcut.downAt >= 400) stopVoiceRecording();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
    };
  }, [startVoiceRecording, stopVoiceRecording, supportsVoiceInput]);

  useEffect(() => {
    const active = voiceInsertionRef.current;
    if (active && voiceTargetKey !== active.targetKey) {
      stopVoiceRecording();
      releaseVoiceCapture(active);
      voiceInsertionRef.current = null;
      setIsVoiceRecording(false);
      setVoiceLevel(0);
    }
  }, [voiceTargetKey, stopVoiceRecording]);

  useEffect(
    () => () => {
      const active = voiceInsertionRef.current;
      if (active) {
        releaseVoiceCapture(active);
        void runStopVoiceInput({ environmentId, sessionId: active.sessionId });
      }
    },
    [environmentId, runStopVoiceInput],
  );

  // Wait for the final transcript to reach the controlled draft and parent send callback.
  useEffect(() => {
    if (!voiceSubmission || sentVoiceSubmissionRef.current === voiceSubmission) return;
    sentVoiceSubmissionRef.current = voiceSubmission;
    if (voiceSubmission.targetKey !== voiceTargetKey || voiceInsertionRef.current) return;
    getSubmitComposer()(undefined, ...voiceSubmission.args);
  }, [getSubmitComposer, voiceSubmission, voiceTargetKey]);

  const voiceInputControl =
    supportsVoiceInput && !isComposerApprovalState && !isChoiceOnlyPendingQuestion ? (
      <>
        {isVoiceRecording ? (
          <span role="status" className="max-w-40 text-xs text-muted-foreground">
            {voiceStatus}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  "relative flex h-9 w-9 items-center justify-center rounded-full transition-[color,background-color,box-shadow,transform] duration-75 sm:h-8 sm:w-8",
                  isVoiceRecording && voiceLive
                    ? "bg-destructive text-white hover:bg-destructive/90"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={toggleVoiceRecording}
                style={
                  isVoiceRecording && voiceLive
                    ? {
                        transform: `scale(${1 + voiceLevel * 0.12})`,
                        boxShadow: `0 0 0 ${2 + voiceLevel * 7}px rgb(239 68 68 / ${0.2 + voiceLevel * 0.45})`,
                      }
                    : undefined
                }
                data-voice-level={isVoiceRecording ? voiceLevel.toFixed(3) : undefined}
                data-voice-live={isVoiceRecording ? String(voiceLive) : undefined}
                disabled={!isVoiceRecording && voiceInputDisabled}
                aria-pressed={isVoiceRecording}
                aria-label={isVoiceRecording ? "Stop voice input" : "Start voice input"}
              />
            }
          >
            {isVoiceRecording && voiceLive ? (
              <SquareIcon className="size-3.5" fill="currentColor" aria-hidden="true" />
            ) : (
              <MicIcon className="size-4" aria-hidden="true" />
            )}
            {/* Starting or finishing: a spinning arc on the edge instead of the recording look. */}
            {isVoiceRecording && !voiceLive ? (
              <span
                data-voice-pending
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 animate-spin rounded-full border-2 border-warning/25 border-t-warning"
              />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {`${isVoiceRecording ? "Stop voice input" : "Voice input"} (Alt+Q) — ${voiceSourceHint}`}
          </TooltipPopup>
        </Tooltip>
      </>
    ) : null;

  return {
    footerControl: activePendingUserInput ? null : voiceInputControl,
    questionControl:
      activePendingUserInput && voiceInputControl ? (
        <div
          data-question-voice-input
          className="flex items-center justify-end gap-2 px-3 pb-2 sm:px-4"
        >
          {voiceInputControl}
        </div>
      ) : null,
    interceptSubmit,
  };
}
