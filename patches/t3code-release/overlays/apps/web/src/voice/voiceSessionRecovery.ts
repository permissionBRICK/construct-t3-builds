/** Reattach a voice subscription without giving up its microphone or session id. */
export async function recoverVoiceSubscription(options: {
  readonly connect: (
    resume: boolean,
    listening: () => void,
  ) => Promise<{ retryable: boolean; message?: string }>;
  readonly isActive: () => boolean;
  readonly onReconnecting: () => void;
}): Promise<void> {
  let resume = false;
  let disconnectedAt = 0;
  while (options.isActive()) {
    const result = await options.connect(resume, () => {
      resume = true;
      disconnectedAt = 0;
    });
    if (!options.isActive()) return;
    if (!result.retryable) {
      if (result.message) throw new Error(result.message);
      return;
    }
    if (!disconnectedAt) disconnectedAt = Date.now();
    options.onReconnecting();
    if (Date.now() - disconnectedAt >= 30_000)
      throw new Error("Voice connection did not return within 30 seconds.");
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}
