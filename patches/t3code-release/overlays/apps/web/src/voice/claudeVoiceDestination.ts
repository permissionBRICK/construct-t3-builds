/**
 * Claude voice input in T3's voice settings. A Construct server lists Claude among its
 * transcription models; while an environment uses it, this client transcribes live into
 * the draft through `voiceInput.*` instead of T3's own recording flow. Servers from before
 * that model existed are offered as a separate destination kind, `claude-code`.
 */

import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import {
  CLAUDE_SPEECH_MODEL_ID,
  type EnvironmentId,
  type EnvironmentSpeechStatus,
  type VoiceTranscriptionDestination,
} from "@t3tools/contracts";

export const CLAUDE_VOICE_KIND = "claude-code";

export type ClaudeVoiceDestination = Extract<
  VoiceTranscriptionDestination,
  { readonly kind: typeof CLAUDE_VOICE_KIND }
>;

/** The value of T3's saved choice: a grant, "off", or nothing chosen yet (null). */
type AudioChoice = { readonly destination: VoiceTranscriptionDestination } | "off" | null;

type Capabilities = {
  readonly voiceInput?: boolean | undefined;
  readonly voiceInputDefault?: boolean | undefined;
  readonly voiceInputSpeechModel?: boolean | undefined;
};

type CapabilitiesOf = (environmentId: EnvironmentId) => Capabilities | undefined;

export function claudeVoiceDestinationOf(choice: AudioChoice): ClaudeVoiceDestination | null {
  if (choice === null || choice === "off") return null;
  return choice.destination.kind === CLAUDE_VOICE_KIND ? choice.destination : null;
}

/** The picker's option value; never equal to T3's own `["environment", …]` values. */
export function claudeVoiceOptionValue(environmentId: EnvironmentId): string {
  return JSON.stringify([CLAUDE_VOICE_KIND, environmentId]);
}

/** The server lists Claude among T3's transcription models. */
export function offersClaudeSpeechModel(capabilities: Capabilities | undefined): boolean {
  return capabilities?.voiceInput === true && capabilities.voiceInputSpeechModel === true;
}

export function usesClaudeSpeechModel(status: EnvironmentSpeechStatus | null): boolean {
  return status?.supported === true && status.modelId === CLAUDE_SPEECH_MODEL_ID;
}

/**
 * Where this client's live Claude session may run for the saved choice. An environment
 * destination needs a check of that environment's model before each recording.
 */
export function claudeVoiceRoute(
  choice: AudioChoice,
  capabilitiesOf: CapabilitiesOf,
): { readonly environmentId: EnvironmentId; readonly checkModel: boolean } | null {
  if (choice === null || choice === "off") return null;
  const { destination } = choice;
  if (destination.kind === CLAUDE_VOICE_KIND) {
    return { environmentId: destination.environmentId, checkModel: false };
  }
  if (destination.kind !== "environment") return null;
  return offersClaudeSpeechModel(capabilitiesOf(destination.environmentId))
    ? { environmentId: destination.environmentId, checkModel: true }
    : null;
}

/** A saved `claude-code` choice whose server now lists Claude as a model moves to that environment. */
export function claudeVoiceMigrationTarget(
  choice: AudioChoice,
  capabilitiesOf: CapabilitiesOf,
): EnvironmentId | null {
  const legacy = claudeVoiceDestinationOf(choice);
  return legacy && offersClaudeSpeechModel(capabilitiesOf(legacy.environmentId))
    ? legacy.environmentId
    : null;
}

/**
 * The environment a device that has never chosen a destination starts with: the first
 * connected Construct VM (it advertises `voiceInputDefault`). A Desktop app's own local
 * backend can record too, but it never becomes the default on its own.
 */
export function pickDefaultClaudeVoiceEnvironment(
  environments: Iterable<{
    readonly environmentId: EnvironmentId;
    readonly capabilities: Capabilities | undefined;
  }>,
): EnvironmentId | null {
  for (const { environmentId, capabilities } of environments) {
    if (capabilities?.voiceInput === true && capabilities.voiceInputDefault === true) {
      return environmentId;
    }
  }
  return null;
}

/** That default: the VM itself (which picks Claude as its model), or `claude-code` on older VMs. */
export function defaultClaudeVoiceDestination(
  environmentId: EnvironmentId,
  offersModel: boolean,
): VoiceTranscriptionDestination {
  return offersModel
    ? { kind: "environment", environmentId }
    : { kind: CLAUDE_VOICE_KIND, environmentId };
}

/**
 * Whether to choose the default for this device now. It happens once: only while nothing
 * was ever chosen (an explicit "off" counts as a choice) and a Construct VM is connected.
 */
export function shouldChooseClaudeVoiceDefault(input: {
  readonly alreadyDecided: boolean;
  readonly choice: AudioChoice;
  readonly environmentId: EnvironmentId | null;
}): boolean {
  return !input.alreadyDecided && input.choice === null && input.environmentId !== null;
}

/** Where a Claude session is; `idle` while no session runs. */
export type ClaudeVoicePhase = "idle" | "preparing" | "recording" | "transcribing";

/**
 * T3's voice controls render from this state. `preparing` until the stream is open and
 * the microphone delivered audio, `transcribing` once Stop waits for the final text.
 */
export function claudeVoiceInputState(phase: ClaudeVoicePhase): VoiceInputState {
  return { phase, error: null, errorAction: null };
}
