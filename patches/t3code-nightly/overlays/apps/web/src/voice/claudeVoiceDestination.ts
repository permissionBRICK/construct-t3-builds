/**
 * Claude as a destination in T3's voice picker (Settings → Voice): audio goes to the
 * chosen environment, which streams it to Claude Code's voice service through
 * `voiceInput.*` and returns a live transcript.
 */

import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, VoiceTranscriptionDestination } from "@t3tools/contracts";

export const CLAUDE_VOICE_KIND = "claude-code";

export type ClaudeVoiceDestination = Extract<
  VoiceTranscriptionDestination,
  { readonly kind: typeof CLAUDE_VOICE_KIND }
>;

/** The value of T3's saved choice: a grant, "off", or nothing chosen yet (null). */
type AudioChoice = { readonly destination: VoiceTranscriptionDestination } | "off" | null;

export function claudeVoiceDestinationOf(choice: AudioChoice): ClaudeVoiceDestination | null {
  if (choice === null || choice === "off") return null;
  return choice.destination.kind === CLAUDE_VOICE_KIND ? choice.destination : null;
}

/** The picker's option value; never equal to T3's own `["environment", …]` values. */
export function claudeVoiceOptionValue(environmentId: EnvironmentId): string {
  return JSON.stringify([CLAUDE_VOICE_KIND, environmentId]);
}

type Capabilities = {
  readonly voiceInput?: boolean | undefined;
  readonly voiceInputDefault?: boolean | undefined;
};

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

/**
 * Whether to choose Claude for this device now. It happens once: only while nothing was
 * ever chosen (an explicit "off" counts as a choice) and a Construct VM is connected.
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
