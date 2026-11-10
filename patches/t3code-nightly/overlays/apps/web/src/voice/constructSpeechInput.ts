/**
 * The chat composer's speech input: T3's own, or the live Claude session while Claude is
 * the chosen voice destination. ChatComposer imports this in place of T3's, so its one
 * microphone button, shortcut and send-after-dictation drive whichever is chosen.
 */

import { useEnvironmentSpeechInput as useT3SpeechInput } from "../speech/useEnvironmentSpeechInput";
import { useClaudeVoiceDefault } from "./useClaudeVoiceDestination";
import { useConstructVoiceInput, type ConstructComposerAccess } from "./useConstructVoiceInput";

type SpeechInput = ReturnType<typeof useT3SpeechInput>;

export function useEnvironmentSpeechInput(
  input: Parameters<typeof useT3SpeechInput>[0] & { readonly construct: ConstructComposerAccess },
): SpeechInput {
  useClaudeVoiceDefault();
  const t3 = useT3SpeechInput(input);
  const claude = useConstructVoiceInput({
    ...input.construct,
    ownerKey: input.ownerKey,
    disabled: input.disabled === true,
  });
  if (!claude) return t3;
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
