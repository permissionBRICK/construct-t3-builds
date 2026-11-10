import {
  CLAUDE_SPEECH_MODEL_ID,
  EnvironmentId,
  VoiceTranscriptionDestination,
  type EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeVoiceDestinationOf,
  claudeVoiceInputState,
  claudeVoiceMigrationTarget,
  claudeVoiceOptionValue,
  claudeVoiceRoute,
  defaultClaudeVoiceDestination,
  pickDefaultClaudeVoiceEnvironment,
  shouldChooseClaudeVoiceDefault,
  usesClaudeSpeechModel,
} from "./claudeVoiceDestination";

const vm = EnvironmentId.make("vm");
const local = EnvironmentId.make("local");
const older = EnvironmentId.make("older");

// `vm` lists Claude as a transcription model; `older` predates it; `local` has no Claude voice.
const capabilitiesOf = (id: EnvironmentId) =>
  id === vm
    ? { voiceInput: true, voiceInputSpeechModel: true }
    : id === older
      ? { voiceInput: true }
      : undefined;
const on = (kind: "environment" | "claude-code", environmentId: EnvironmentId) => ({
  destination: { kind, environmentId },
});

describe("Claude voice destination", () => {
  it("is a destination T3 stores with its other voice choices", () => {
    const decode = Schema.decodeUnknownSync(VoiceTranscriptionDestination);
    const claude = decode({ kind: "claude-code", environmentId: "vm" });
    expect(claudeVoiceDestinationOf({ destination: claude })).toEqual(claude);
    expect(
      claudeVoiceDestinationOf({
        destination: decode({ kind: "environment", environmentId: "vm" }),
      }),
    ).toBeNull();
    expect(claudeVoiceDestinationOf("off")).toBeNull();
    expect(claudeVoiceDestinationOf(null)).toBeNull();
  });

  it("runs live Claude for a `claude-code` choice, or an environment that offers the Claude model", () => {
    expect(claudeVoiceRoute(on("environment", vm), capabilitiesOf)).toEqual({
      environmentId: vm,
      checkModel: true,
    });
    expect(claudeVoiceRoute(on("claude-code", older), capabilitiesOf)).toEqual({
      environmentId: older,
      checkModel: false,
    });
    expect(claudeVoiceRoute(on("environment", older), capabilitiesOf)).toBeNull();
    expect(claudeVoiceRoute(on("environment", local), capabilitiesOf)).toBeNull();
    expect(
      claudeVoiceRoute(
        { destination: { kind: "cloud", environmentId: vm, provider: "openai" } },
        capabilitiesOf,
      ),
    ).toBeNull();
    expect(claudeVoiceRoute("off", capabilitiesOf)).toBeNull();
  });

  it("uses the live session only while the environment's model is Claude", () => {
    const status = (modelId: string) =>
      ({ supported: true, modelId }) as unknown as EnvironmentSpeechStatus;
    expect(usesClaudeSpeechModel(status(CLAUDE_SPEECH_MODEL_ID))).toBe(true);
    expect(usesClaudeSpeechModel(status("local/whisper"))).toBe(false);
    expect(usesClaudeSpeechModel({ supported: false, reason: "unsupported" })).toBe(false);
    expect(usesClaudeSpeechModel(null)).toBe(false);
  });

  it("moves a `claude-code` choice to its environment once that server lists the Claude model", () => {
    expect(claudeVoiceMigrationTarget(on("claude-code", vm), capabilitiesOf)).toBe(vm);
    expect(claudeVoiceMigrationTarget(on("claude-code", older), capabilitiesOf)).toBeNull();
    expect(claudeVoiceMigrationTarget(on("environment", vm), capabilitiesOf)).toBeNull();
    expect(claudeVoiceMigrationTarget(null, capabilitiesOf)).toBeNull();
  });

  it("defaults to the VM itself, or to `claude-code` on a VM without the Claude model", () => {
    expect(defaultClaudeVoiceDestination(vm, true)).toEqual({
      kind: "environment",
      environmentId: vm,
    });
    expect(defaultClaudeVoiceDestination(older, false)).toEqual({
      kind: "claude-code",
      environmentId: older,
    });
  });

  it("uses picker values that cannot collide with T3's environment choices", () => {
    expect(claudeVoiceOptionValue(vm)).not.toBe(JSON.stringify(["environment", vm]));
    expect(claudeVoiceOptionValue(vm)).not.toBe(claudeVoiceOptionValue(local));
  });

  it("defaults only to a Construct VM, never to a Desktop app's own backend", () => {
    expect(
      pickDefaultClaudeVoiceEnvironment([
        { environmentId: local, capabilities: { voiceInput: true } },
        { environmentId: vm, capabilities: { voiceInput: true, voiceInputDefault: true } },
      ]),
    ).toBe(vm);
    expect(
      pickDefaultClaudeVoiceEnvironment([
        { environmentId: local, capabilities: { voiceInput: true } },
        { environmentId: vm, capabilities: undefined },
      ]),
    ).toBeNull();
    expect(
      pickDefaultClaudeVoiceEnvironment([
        { environmentId: vm, capabilities: { voiceInput: false, voiceInputDefault: true } },
      ]),
    ).toBeNull();
  });

  it("chooses Claude once, and never over an existing choice or Off", () => {
    expect(
      shouldChooseClaudeVoiceDefault({ alreadyDecided: false, choice: null, environmentId: vm }),
    ).toBe(true);
    expect(
      shouldChooseClaudeVoiceDefault({ alreadyDecided: true, choice: null, environmentId: vm }),
    ).toBe(false);
    expect(
      shouldChooseClaudeVoiceDefault({ alreadyDecided: false, choice: "off", environmentId: vm }),
    ).toBe(false);
    expect(
      shouldChooseClaudeVoiceDefault({
        alreadyDecided: false,
        choice: { destination: { kind: "environment", environmentId: local } },
        environmentId: vm,
      }),
    ).toBe(false);
    expect(
      shouldChooseClaudeVoiceDefault({ alreadyDecided: false, choice: null, environmentId: null }),
    ).toBe(false);
  });

  it("drives T3's voice controls without an error state of its own", () => {
    for (const phase of ["idle", "preparing", "recording", "transcribing"] as const) {
      expect(claudeVoiceInputState(phase)).toEqual({ phase, error: null, errorAction: null });
    }
  });
});
