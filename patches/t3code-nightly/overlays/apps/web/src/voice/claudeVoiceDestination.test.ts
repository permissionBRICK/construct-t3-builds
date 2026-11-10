import { EnvironmentId, VoiceTranscriptionDestination } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeVoiceDestinationOf,
  claudeVoiceInputState,
  claudeVoiceOptionValue,
  pickDefaultClaudeVoiceEnvironment,
  shouldChooseClaudeVoiceDefault,
} from "./claudeVoiceDestination";

const vm = EnvironmentId.make("vm");
const local = EnvironmentId.make("local");

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
