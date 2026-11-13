/**
 * The chat composer's speech input: T3's own, or a live Claude session that writes into
 * the draft while the chosen environment transcribes with Claude. ChatComposer imports this
 * in place of T3's, so its one microphone button, shortcut and send-after-dictation drive both.
 */

import { CLAUDE_SPEECH_MODEL_ID } from "@t3tools/contracts";

import { useEnvironmentSpeechInput as useT3SpeechInput } from "../speech/useEnvironmentSpeechInput";
import { useAudioChoice } from "../speech/voiceConsent";
import { useServerConfigs } from "../state/entities";
import { claudeVoiceRoute } from "./claudeVoiceDestination";
import { useClaudeVoiceChoice } from "./useClaudeVoiceDestination";
import { useConstructVoiceInput, type ConstructComposerAccess } from "./useConstructVoiceInput";

type SpeechInput = ReturnType<typeof useT3SpeechInput>;

export function useEnvironmentSpeechInput(
  input: Parameters<typeof useT3SpeechInput>[0] & { readonly construct: ConstructComposerAccess },
): SpeechInput {
  useClaudeVoiceChoice();
  const t3 = useT3SpeechInput(input);
  const serverConfigs = useServerConfigs();
  const route = claudeVoiceRoute(
    useAudioChoice(),
    (id) => serverConfigs.get(id)?.environment.capabilities,
  );
  const claude = useConstructVoiceInput({
    ...input.construct,
    ownerKey: input.ownerKey,
    disabled: input.disabled === true,
    environmentId: route?.environmentId ?? null,
  });
  // The environment's model is a server setting pushed to every client, so the button knows
  // where to record without asking. A running recording keeps its route if the model changes.
  const usesClaude =
    route !== null &&
    (!route.checkModel ||
      serverConfigs.get(route.environmentId)?.settings.speechModelId === CLAUDE_SPEECH_MODEL_ID);
  if (!claude || (!usesClaude && claude.state.phase === "idle")) return t3;
  return {
    ...t3,
    ...claude,
    // The transcript is written into the draft as it arrives, which stays editable.
    preview: null,
    freezesEditor: false,
    preparing: false,
    status: null,
    skipPostProcessing: () => {},
  };
}
