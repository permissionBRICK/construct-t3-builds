/**
 * The one-time Claude default on a device connected to a Construct VM, the move of saved
 * `claude-code` choices to the environment's Claude model, and the `claude-code` options
 * for servers that predate that model (Settings → Voice → Transcribe with).
 */

import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  getEnvironmentSpeechStatus,
  selectEnvironmentSpeechModel,
} from "@t3tools/client-runtime/voice-input";
import { CLAUDE_SPEECH_MODEL_ID, ProviderDriverKind, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, type ReactNode } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { SelectGroup, SelectGroupLabel, SelectItem } from "../components/ui/select";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { chooseAudioDestination, useAudioChoice } from "../speech/voiceConsent";
import { useServerConfigs } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { usePreparedConnection } from "../state/session";
import {
  CLAUDE_VOICE_KIND,
  claudeVoiceDestinationOf,
  claudeVoiceMigrationTarget,
  claudeVoiceOptionValue,
  defaultClaudeVoiceDestination,
  offersClaudeSpeechModel,
  pickDefaultClaudeVoiceEnvironment,
  shouldChooseClaudeVoiceDefault,
  usesClaudeSpeechModel,
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

/** The chosen `claude-code` destination, or null while another destination (or none) is chosen. */
export function useClaudeVoiceDestination(): ClaudeVoiceDestination | null {
  return claudeVoiceDestinationOf(useAudioChoice());
}

const migrating = new Set<EnvironmentId>();

/** Makes Claude the environment's model, then moves the saved choice to that environment. */
async function migrateClaudeVoiceChoice(
  environmentId: EnvironmentId,
  connection: PreparedConnection,
): Promise<void> {
  if (migrating.has(environmentId)) return;
  migrating.add(environmentId);
  try {
    const status = await runEnvironmentSpeech(getEnvironmentSpeechStatus(connection));
    if (!usesClaudeSpeechModel(status)) {
      await runEnvironmentSpeech(selectEnvironmentSpeechModel(connection, CLAUDE_SPEECH_MODEL_ID));
    }
    chooseAudioDestination({ kind: "environment", environmentId });
  } catch (error) {
    // The saved `claude-code` choice keeps working; the next visit tries again.
    console.warn("[voice] could not move the Claude choice to the environment's model", error);
  } finally {
    migrating.delete(environmentId);
  }
}

/**
 * The first time this device is connected to a Construct VM without any voice choice,
 * choose that VM, which transcribes with Claude unless another model was installed there.
 * A saved `claude-code` choice moves to its environment once that server lists Claude.
 */
export function useClaudeVoiceChoice(): void {
  const choice = useAudioChoice();
  const serverConfigs = useServerConfigs();
  const capabilitiesOf = (id: EnvironmentId) => serverConfigs.get(id)?.environment.capabilities;
  const environmentId = pickDefaultClaudeVoiceEnvironment(
    [...serverConfigs].map(([id, config]) => ({
      environmentId: id,
      capabilities: config.environment.capabilities,
    })),
  );
  const offersModel =
    environmentId !== null && offersClaudeSpeechModel(capabilitiesOf(environmentId));
  const migrateFrom = claudeVoiceMigrationTarget(choice, capabilitiesOf);
  const migrationConnection = Option.getOrNull(usePreparedConnection(migrateFrom));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the one-time default into T3's stored voice choice once a Construct VM connects
  useEffect(() => {
    const alreadyDecided = readDefaultDecided();
    if (alreadyDecided) return;
    if (choice !== null) {
      writeDefaultDecided();
      return;
    }
    if (!shouldChooseClaudeVoiceDefault({ alreadyDecided, choice, environmentId })) return;
    chooseAudioDestination(defaultClaudeVoiceDestination(environmentId!, offersModel));
    writeDefaultDecided();
  }, [choice, environmentId, offersModel]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves a saved choice once its environment is connected and lists Claude as a model
  useEffect(() => {
    if (migrateFrom && migrationConnection)
      void migrateClaudeVoiceChoice(migrateFrom, migrationConnection);
  }, [migrateFrom, migrationConnection]);
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

/**
 * The `claude-code` options and selected label for the destination picker in Voice settings.
 * Servers that list Claude as a model need no option: picking the environment uses it.
 */
export function useClaudeVoicePicker(): ClaudeVoicePicker {
  useClaudeVoiceChoice();
  const destination = useClaudeVoiceDestination();
  const { environments } = useEnvironments();
  const capable = environments.filter((environment) => {
    const capabilities = environment.serverConfig?.environment.capabilities;
    return capabilities?.voiceInput === true && !offersClaudeSpeechModel(capabilities);
  });
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
