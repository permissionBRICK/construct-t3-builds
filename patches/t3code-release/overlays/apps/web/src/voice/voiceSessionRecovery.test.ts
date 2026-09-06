import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { recoverVoiceSubscription } from "./voiceSessionRecovery";
afterEach(() => vi.useRealTimers());

describe("voice subscription recovery", () => {
  it("reattaches an established recording after a transport failure", async () => {
    vi.useFakeTimers();
    let active = true;
    const resumed: boolean[] = [];
    const reconnecting = vi.fn();
    const run = recoverVoiceSubscription({
      isActive: () => active,
      onReconnecting: reconnecting,
      connect: async (resume, listening) => {
        resumed.push(resume);
        listening();
        if (resume) active = false;
        return { retryable: !resume };
      },
    });
    await vi.advanceTimersByTimeAsync(501);
    await run;
    expect(resumed).toEqual([false, true]);
    expect(reconnecting).toHaveBeenCalledOnce();
  });
  it("does not retry a fatal transcription or expired-session error", async () => {
    const connect = vi.fn(async () => ({ retryable: false, message: "Session expired" }));
    await expect(
      recoverVoiceSubscription({ connect, isActive: () => true, onReconnecting: vi.fn() }),
    ).rejects.toThrow("Session expired");
    expect(connect).toHaveBeenCalledOnce();
  });
  it("stops retrying after cancellation", async () => {
    vi.useFakeTimers();
    let active = true;
    const connect = vi.fn(async () => ({ retryable: true }));
    const run = recoverVoiceSubscription({
      connect,
      isActive: () => active,
      onReconnecting: () => {
        active = false;
      },
    });
    await vi.advanceTimersByTimeAsync(501);
    await run;
    expect(connect).toHaveBeenCalledOnce();
  });
  it("bounds repeated reconnect failures", async () => {
    vi.useFakeTimers();
    const run = recoverVoiceSubscription({
      connect: async () => ({ retryable: true }),
      isActive: () => true,
      onReconnecting: vi.fn(),
    });
    const assertion = expect(run).rejects.toThrow("30 seconds");
    await vi.advanceTimersByTimeAsync(30_500);
    await assertion;
  });
});
