import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

/**
 * What to tell the user when a voice session ends badly.
 *
 * The server explains its own failures ("The host microphone bridge is
 * unavailable ...", "No microphone audio arrived from the client.", a
 * transcription error from Claude), so its message wins. The per-source text
 * below is only for failures that carry no reason at all — a defect, an
 * interrupt, or a dropped connection.
 */
export const CLIENT_VOICE_FAILURE_DESCRIPTION =
  "Voice connection interrupted. Your existing transcript has been kept.";
export const HOST_VOICE_FAILURE_DESCRIPTION =
  "Could not transcribe the microphone. Check Claude sign-in and Construct microphone passthrough.";

export function describeVoiceInputFailure(
  cause: Cause.Cause<unknown>,
  source: "client" | "host",
): string {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    const failure = error.value;
    const message =
      typeof failure === "object" &&
      failure !== null &&
      "message" in failure &&
      typeof failure.message === "string"
        ? failure.message.trim()
        : "";
    if (message) return message;
  }
  return source === "client" ? CLIENT_VOICE_FAILURE_DESCRIPTION : HOST_VOICE_FAILURE_DESCRIPTION;
}

/** Only transport/session availability failures may restart the subscription. */
export function canReconnectVoiceInput(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) return false;
  const value = error.value;
  if (typeof value !== "object" || value === null || !("_tag" in value)) return false;
  return [
    "RpcClientError",
    "ConnectionTransientError",
    "EnvironmentRpcUnavailableError",
    "EnvironmentSessionUnavailableError",
  ].includes(String(value._tag));
}
