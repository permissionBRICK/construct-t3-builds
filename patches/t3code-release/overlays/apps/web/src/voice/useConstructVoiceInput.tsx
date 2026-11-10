/**
 * Claude voice input behind T3's own voice controls, while Claude is the chosen voice
 * destination. The transcript streams into the editable draft at the cursor as it is
 * spoken; Enter or Send stops recording and sends once the final text is in the draft.
 */

import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { randomUUID } from "../lib/utils";
import { useServerConfigs } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import {
  sendVoiceAudio as sendVoiceAudioCommand,
  startVoiceInput as startVoiceInputCommand,
  stopVoiceInput as stopVoiceInputCommand,
} from "../state/voiceInput";
import { claudeVoiceInputState, type ClaudeVoicePhase } from "./claudeVoiceDestination";
import {
  canCaptureClientAudio,
  isSecureContext,
  resolveVoiceInputSource,
  startClientAudioCapture,
  type ClientAudioCapture,
} from "./clientAudioCapture";
import { useClaudeVoiceDestination } from "./useClaudeVoiceDestination";
import { createVoiceAudioSender, type VoiceAudioSender } from "./voiceAudioSender";
import { canReconnectVoiceInput, describeVoiceInputFailure } from "./voiceInputFailure";
import { recoverVoiceSubscription } from "./voiceSessionRecovery";

/** What the composer lends the session to write the transcript into its draft. */
export interface ConstructComposerAccess {
  /** The text the composer last wrote, including writes not rendered yet. */
  readonly promptRef: { current: string };
  /**
   * The open question's typed answer, which the transcript extends. Null without a
   * question. A collapsed question can still expose the chat draft's editor snapshot.
   */
  readonly pendingAnswer: string | null;
  readonly readComposerSnapshot: () => { readonly value: string; readonly expandedCursor: number };
  readonly applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options: { expectedText: string; focusEditorAfterReplace: boolean },
  ) => boolean;
}

export interface ConstructVoiceInputOptions extends ConstructComposerAccess {
  /** The draft or question answer being written; a change cancels the session. */
  readonly ownerKey: string;
  readonly disabled: boolean;
}

/** The parts of T3's speech input that the Claude session provides instead. */
export interface ClaudeSpeechInput {
  readonly available: boolean;
  readonly state: ReturnType<typeof claudeVoiceInputState>;
  readonly level: number;
  readonly blocksSubmission: boolean;
  readonly transcriptionEnvironmentId: EnvironmentId;
  readonly transcriptionEnvironmentLabel: string | null;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly cancel: () => void;
  /** Stops recording and calls `submit` once the final transcript is in the draft. */
  readonly submitAfterDictation: (submit: (text: string) => void) => void;
}

/**
 * A live voice session's insertion window plus, for client-captured audio, the
 * microphone and the sender pushing it to the server.
 */
type VoiceInsertionState = {
  sessionId: string;
  environmentId: EnvironmentId;
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
  submit?: (text: string) => void;
};

/** Idempotent, so every path that drops a session can call it. */
function releaseVoiceCapture(insertion: VoiceInsertionState | null): void {
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
  insertion: VoiceInsertionState,
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

/** Null while Claude is not the chosen voice destination. */
export function useConstructVoiceInput(
  options: ConstructVoiceInputOptions,
): ClaudeSpeechInput | null {
  const {
    ownerKey,
    disabled,
    promptRef,
    pendingAnswer,
    readComposerSnapshot,
    applyPromptReplacement,
  } = options;
  const destination = useClaudeVoiceDestination();
  const environmentId = destination?.environmentId ?? null;
  const serverConfigs = useServerConfigs();
  const serverConfig = environmentId ? serverConfigs.get(environmentId) : undefined;
  const supportsVoiceInput = serverConfig?.environment.capabilities.voiceInput === true;
  const supportsClientVoiceAudio =
    serverConfig?.environment.capabilities.voiceInputClientAudio === true;
  const voiceInputSourcePreference = useClientSettings((settings) => settings.voiceInputSource);
  const microphoneId = useClientSettings((settings) => settings.voiceMicrophone);
  const voiceInputSource = resolveVoiceInputSource({
    preference: voiceInputSourcePreference,
    canCaptureHere: canCaptureClientAudio(),
    serverAcceptsClientAudio: supportsClientVoiceAudio,
    secureContext: isSecureContext(),
  });
  const runStartVoiceInput = useAtomCommand(startVoiceInputCommand, { reportFailure: false });
  const runStopVoiceInput = useAtomCommand(stopVoiceInputCommand, { reportFailure: false });
  const runSendVoiceAudio = useAtomCommand(sendVoiceAudioCommand, { reportFailure: false });

  const [phase, setPhase] = useState<ClaudeVoicePhase>("idle");
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceSubmission, setVoiceSubmission] = useState<{
    targetKey: string;
    submit: (text: string) => void;
  } | null>(null);
  const sentVoiceSubmissionRef = useRef<typeof voiceSubmission>(null);
  const voiceInsertionRef = useRef<VoiceInsertionState | null>(null);

  // A different draft, question or destination ends the session.
  const voiceTargetKey = JSON.stringify([ownerKey, disabled, environmentId]);
  const voiceTargetRef = useRef(voiceTargetKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed target to the session's asynchronous transcript callbacks
  useLayoutEffect(() => {
    voiceTargetRef.current = voiceTargetKey;
  });

  const stopVoiceRecording = useStableCallback(() => {
    setVoiceLevel(0);
    const insertion = voiceInsertionRef.current;
    if (!insertion || insertion.stopRequested) return;
    insertion.stopRequested = true;
    setPhase("transcribing");
    void finishVoiceSession(insertion, async () => {
      const result = await runStopVoiceInput({
        environmentId: insertion.environmentId,
        sessionId: insertion.sessionId,
      });
      return AsyncResult.isSuccess(result) && result.value.stopped;
    }).catch((error: unknown) => {
      if (insertion.cancelled) return;
      console.warn("[voice] finishing failed", error);
      releaseVoiceCapture(insertion);
      if (voiceInsertionRef.current === insertion) {
        voiceInsertionRef.current = null;
        setPhase("idle");
      }
      toastManager.add({
        type: "error",
        title: "Voice input stopped",
        description: error instanceof Error ? error.message : String(error),
      });
    });
  });

  /** Ends the session at once and keeps the text it already wrote; nothing is sent. */
  const cancelVoiceRecording = useStableCallback(() => {
    const insertion = voiceInsertionRef.current;
    if (!insertion) return;
    releaseVoiceCapture(insertion);
    voiceInsertionRef.current = null;
    setPhase("idle");
    setVoiceLevel(0);
    void runStopVoiceInput({
      environmentId: insertion.environmentId,
      sessionId: insertion.sessionId,
    });
  });

  const startVoiceRecording = useStableCallback(() => {
    if (!environmentId || !supportsVoiceInput || voiceInsertionRef.current || disabled) return;
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
    const value = pendingAnswer ?? snapshot.value;
    const cursor = snapshot.value === value ? snapshot.expandedCursor : value.length;
    const sessionId = randomUUID();
    const insertion: VoiceInsertionState = {
      sessionId,
      environmentId,
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
    setPhase("preparing");
    setVoiceLevel(0);
    // Recording only once speech is kept: the transcription stream is open and the
    // microphone has delivered audio. Until then the controls show it preparing.
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
      setPhase((current) => (current === "preparing" ? "recording" : current));
    };

    const failRecording = (message: string) => {
      if (insertion.cancelled || voiceInsertionRef.current !== insertion) return;
      console.warn("[voice] recording stopped", { sessionId, reason: message });
      releaseVoiceCapture(insertion);
      voiceInsertionRef.current = null;
      setPhase("idle");
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
        // Recording continues while the connection returns; the controls keep showing it.
        onState: () => {},
        onError: failRecording,
      });
      insertion.capture = startClientAudioCapture({
        ...(microphoneId ? { microphoneId } : {}),
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
                active.submit &&
                event.reason === "user-stop" &&
                voiceTargetRef.current === active.targetKey
              ) {
                setVoiceSubmission({ targetKey: active.targetKey, submit: active.submit });
              }
              releaseVoiceCapture(active);
              voiceInsertionRef.current = null;
              setPhase("idle");
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
              setPhase("idle");
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
              setPhase("idle");
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

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
    const active = voiceInsertionRef.current;
    if (!active) {
      submit(promptRef.current);
      return;
    }
    // Repeated submits while finishing send only once.
    if (!active.submit) active.submit = submit;
    stopVoiceRecording();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the server session and microphone when the draft, question or destination changes
  useEffect(() => {
    const active = voiceInsertionRef.current;
    if (active && voiceTargetKey !== active.targetKey) {
      stopVoiceRecording();
      releaseVoiceCapture(active);
      voiceInsertionRef.current = null;
      setPhase("idle");
      setVoiceLevel(0);
    }
  }, [voiceTargetKey, stopVoiceRecording]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone and the server session on unmount
  useEffect(
    () => () => {
      const active = voiceInsertionRef.current;
      if (active) {
        releaseVoiceCapture(active);
        void runStopVoiceInput({
          environmentId: active.environmentId,
          sessionId: active.sessionId,
        });
      }
    },
    [runStopVoiceInput],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends only after the final transcript has committed to the controlled draft
  useEffect(() => {
    if (!voiceSubmission || sentVoiceSubmissionRef.current === voiceSubmission) return;
    sentVoiceSubmissionRef.current = voiceSubmission;
    if (voiceSubmission.targetKey !== voiceTargetKey || voiceInsertionRef.current) return;
    voiceSubmission.submit(promptRef.current);
  }, [promptRef, voiceSubmission, voiceTargetKey]);

  const start = useStableCallback(async () => startVoiceRecording());
  const stop = useStableCallback(async () => stopVoiceRecording());

  if (!environmentId) return null;
  return {
    available: supportsVoiceInput,
    state: claudeVoiceInputState(phase),
    level: voiceLevel,
    blocksSubmission: phase !== "idle",
    transcriptionEnvironmentId: environmentId,
    transcriptionEnvironmentLabel: serverConfig
      ? `Claude via ${serverConfig.environment.label}`
      : null,
    start,
    stop,
    cancel: cancelVoiceRecording,
    submitAfterDictation,
  };
}
