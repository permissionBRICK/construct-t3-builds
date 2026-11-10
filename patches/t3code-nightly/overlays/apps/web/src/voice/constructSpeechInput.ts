/**
 * The chat composer's speech input: T3's own, or a live Claude session that writes into
 * the draft while the chosen environment transcribes with Claude. ChatComposer imports this
 * in place of T3's, so its one microphone button, shortcut and send-after-dictation drive both.
 */

import { getEnvironmentSpeechStatus } from "@t3tools/client-runtime/voice-input";

import { useStableCallback } from "../hooks/useStableCallback";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import {
  useEnvironmentSpeechInput as useT3SpeechInput,
  useVoiceTranscriptionDestination,
} from "../speech/useEnvironmentSpeechInput";
import { useAudioChoice } from "../speech/voiceConsent";
import { useServerConfigs } from "../state/entities";
import { claudeVoiceRoute, usesClaudeSpeechModel } from "./claudeVoiceDestination";
import { useClaudeVoiceChoice } from "./useClaudeVoiceDestination";
import { useConstructVoiceInput, type ConstructComposerAccess } from "./useConstructVoiceInput";

type SpeechInput = ReturnType<typeof useT3SpeechInput>;

export function useEnvironmentSpeechInput(
  input: Parameters<typeof useT3SpeechInput>[0] & { readonly construct: ConstructComposerAccess },
): SpeechInput {
  useClaudeVoiceChoice();
  const t3 = useT3SpeechInput(input);
  const { prepared } = useVoiceTranscriptionDestination();
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
  // The environment's model can change on any device, so it is read again for each recording.
  const start = useStableCallback(async () => {
    if (!claude) return t3.start();
    if (!route?.checkModel) return claude.start();
    const status = prepared
      ? await runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared)).catch(() => null)
      : null;
    return usesClaudeSpeechModel(status) ? claude.start() : t3.start();
  });
  if (!claude || !route) return t3;
  if (route.checkModel && claude.state.phase === "idle") return { ...t3, start };
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
