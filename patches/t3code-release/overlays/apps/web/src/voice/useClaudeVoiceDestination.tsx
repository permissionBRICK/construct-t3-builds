/**
 * Claude in T3's voice picker (Settings → Voice → Transcribe with) and the one-time
 * default that picks it on a device connected to a Construct VM.
 */

import { ProviderDriverKind, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { SelectGroup, SelectGroupLabel, SelectItem } from "../components/ui/select";
import { chooseAudioDestination, useAudioChoice } from "../speech/voiceConsent";
import { useServerConfigs } from "../state/entities";
import { useEnvironments } from "../state/environments";
import {
  CLAUDE_VOICE_KIND,
  claudeVoiceDestinationOf,
  claudeVoiceOptionValue,
  pickDefaultClaudeVoiceEnvironment,
  shouldChooseClaudeVoiceDefault,
  type ClaudeVoiceDestination,
} from "./claudeVoiceDestination";

// Set once the default was applied or found unnecessary, so it never overrides a later choice.
const DEFAULT_DECIDED_KEY = "construct:t3-voice-claude-default:v1";

function readDefaultDecided(): boolean {
  try {
    return window.localStorage.getItem(DEFAULT_DECIDED_KEY) !== null;
  } catch {
    // Without storage the choice cannot be saved either.
    return true;
  }
}

function writeDefaultDecided(): void {
  try {
    window.localStorage.setItem(DEFAULT_DECIDED_KEY, "1");
  } catch {
    // The choice itself was saved through T3; only the marker is lost.
  }
}

/** The chosen Claude destination, or null while another destination (or none) is chosen. */
export function useClaudeVoiceDestination(): ClaudeVoiceDestination | null {
  return claudeVoiceDestinationOf(useAudioChoice());
}

/**
 * The first time this device is connected to a Construct VM without any voice choice,
 * choose Claude on that VM, as Construct's voice input worked before T3 had its own.
 */
export function useClaudeVoiceDefault(): void {
  const choice = useAudioChoice();
  const serverConfigs = useServerConfigs();
  const environmentId = pickDefaultClaudeVoiceEnvironment(
    [...serverConfigs].map(([id, config]) => ({
      environmentId: id,
      capabilities: config.environment.capabilities,
    })),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the one-time default into T3's stored voice choice once a Construct VM connects
  useEffect(() => {
    const alreadyDecided = readDefaultDecided();
    if (alreadyDecided) return;
    if (choice !== null) {
      writeDefaultDecided();
      return;
    }
    if (!shouldChooseClaudeVoiceDefault({ alreadyDecided, choice, environmentId })) return;
    chooseAudioDestination({ kind: CLAUDE_VOICE_KIND, environmentId: environmentId! });
    writeDefaultDecided();
  }, [choice, environmentId]);
}

function ClaudeLogo() {
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make("claudeAgent")}
      displayName="Claude"
      iconClassName="size-4"
    />
  );
}

export type ClaudeVoicePicker = {
  /** Whether Claude is the chosen destination. */
  readonly active: boolean;
  /** The picker value of the chosen Claude destination. */
  readonly value: string | null;
  /** Chooses Claude when `value` is one of its options; returns whether it was. */
  readonly choose: (value: string) => boolean;
  /** One option per environment that runs Claude voice input. */
  readonly options: ReactNode;
  /** What the picker shows while Claude is chosen. */
  readonly label: ReactNode;
};

/** Claude's options and selected label for the destination picker in Voice settings. */
export function useClaudeVoicePicker(): ClaudeVoicePicker {
  useClaudeVoiceDefault();
  const destination = useClaudeVoiceDestination();
  const { environments } = useEnvironments();
  const capable = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.voiceInput === true,
  );
  const chosen = destination
    ? environments.find((environment) => environment.environmentId === destination.environmentId)
    : undefined;
  const choose = (value: string) => {
    const environment = capable.find(
      (candidate) => claudeVoiceOptionValue(candidate.environmentId) === value,
    );
    if (!environment) return false;
    const environmentId: EnvironmentId = environment.environmentId;
    chooseAudioDestination({ kind: CLAUDE_VOICE_KIND, environmentId });
    return true;
  };
  return {
    active: destination !== null,
    value: destination ? claudeVoiceOptionValue(destination.environmentId) : null,
    choose,
    options:
      capable.length > 0 ? (
        <SelectGroup>
          <SelectGroupLabel>Claude Code, live</SelectGroupLabel>
          {capable.map((environment) => {
            const value = claudeVoiceOptionValue(environment.environmentId);
            return (
              <SelectItem key={value} value={value} aria-label={`Claude via ${environment.label}`}>
                <span className="flex items-center gap-2">
                  <ClaudeLogo />
                  Claude via {environment.label}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      ) : null,
    label: destination ? (
      <span className="flex min-w-0 items-center gap-2">
        <ClaudeLogo />
        <span className="truncate">
          Claude
          <span className="text-muted-foreground">
            {" via "}
            {chosen?.label ?? "unavailable environment"}
          </span>
        </span>
      </span>
    ) : null,
  };
}
