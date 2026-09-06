/** Retain PCM until acknowledged. Offsets make retries safe after a lost reply. */
export const MAX_PENDING_VOICE_BYTES = 16_000 * 2 * 30;
const BATCH_BYTES = 32_000;
const RECOVERY_MS = 30_000;
export type VoiceAudioAck = { accepted: boolean; nextSequence: number };
export type VoiceAudioSender = {
  push(chunk: Uint8Array): void;
  setReady(ready: boolean): void;
  drain(): Promise<void>;
  stop(): void;
};

export function createVoiceAudioSender(options: {
  readonly send: (chunk: Uint8Array, sequence: number) => Promise<VoiceAudioAck>;
  readonly onState: (buffering: boolean) => void;
  readonly onError: (message: string) => void;
}): VoiceAudioSender {
  const pending: Uint8Array[] = [];
  let bytes = 0;
  let sequence = 0;
  let activeBatch: { data: Uint8Array; parts: number } | null = null;
  let ready = false;
  let stopped = false;
  let draining = false;
  let running = false;
  let recoverySince = Date.now();
  let failure: Error | null = null;
  let drainResolve: (() => void) | null = null;
  let drainReject: ((error: Error) => void) | null = null;
  let attemptTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelAttempt: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    clearInterval(watchdog);
    if (retryTimer) clearTimeout(retryTimer);
    cancelAttempt?.();
    pending.length = 0;
    bytes = 0;
  };
  const fail = (message: string) => {
    if (stopped) return;
    failure = new Error(message);
    stopped = true;
    cleanup();
    drainReject?.(failure);
    options.onError(message);
  };
  const watchdog = setInterval(() => {
    if (recoverySince && Date.now() - recoverySince >= RECOVERY_MS) {
      fail("Voice connection did not recover within 30 seconds. Recording stopped.");
    }
  }, 250);

  const pump = async () => {
    if (running || retryTimer || stopped || !ready || bytes === 0) return;
    running = true;
    // Batch accumulated chunks so catching up does not require one round trip per 100 ms.
    const parts: Uint8Array[] = [];
    let size = 0;
    for (const part of pending) {
      if (size && size + part.byteLength > BATCH_BYTES) break;
      parts.push(part);
      size += part.byteLength;
    }
    const builtBatch = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      builtBatch.set(part, offset);
      offset += part.byteLength;
    }
    activeBatch ??= { data: builtBatch, parts: parts.length };
    const batch = activeBatch.data;
    const expected = sequence + batch.byteLength;
    if (!recoverySince) recoverySince = Date.now();
    try {
      const ack = await Promise.race([
        Promise.resolve().then(() => options.send(batch, sequence)),
        new Promise<never>((_, reject) => {
          cancelAttempt = () => reject(new Error("Audio upload interrupted"));
          attemptTimer = setTimeout(() => reject(new Error("Audio upload timed out")), 2_000);
        }),
      ]);
      if (stopped) return;
      if (!ack.accepted || ack.nextSequence !== expected) throw new Error("Audio not acknowledged");
      pending.splice(0, activeBatch.parts);
      bytes -= batch.byteLength;
      activeBatch = null;
      sequence = expected;
      recoverySince = ready ? 0 : Date.now();
      options.onState(!ready);
      if (bytes === 0) drainResolve?.();
    } catch {
      if (!stopped) {
        options.onState(true);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void pump();
        }, 500);
      }
    } finally {
      if (attemptTimer) clearTimeout(attemptTimer);
      attemptTimer = null;
      cancelAttempt = null;
      running = false;
      if (!retryTimer && !stopped) void pump();
    }
  };

  return {
    push(chunk) {
      if (stopped || draining || chunk.byteLength === 0) return;
      if (bytes + chunk.byteLength > MAX_PENDING_VOICE_BYTES) {
        fail(
          "The 30-second voice buffer is full. Recording stopped because the connection is unavailable.",
        );
        return;
      }
      pending.push(chunk);
      bytes += chunk.byteLength;
      void pump();
    },
    setReady(value) {
      ready = value;
      if (!value && !recoverySince) recoverySince = Date.now();
      if (value && bytes === 0) recoverySince = 0;
      options.onState(!value);
      void pump();
    },
    drain() {
      draining = true;
      if (failure) return Promise.reject(failure);
      if (stopped) return Promise.reject(new Error("Recording was cancelled"));
      if (!bytes) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        drainResolve = resolve;
        drainReject = reject;
        void pump();
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cleanup();
      drainReject?.(new Error("Recording was cancelled"));
    },
  };
}
