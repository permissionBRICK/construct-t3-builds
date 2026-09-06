import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createVoiceAudioSender, MAX_PENDING_VOICE_BYTES } from "./voiceAudioSender";

afterEach(() => vi.useRealTimers());
const setup = (send: Parameters<typeof createVoiceAudioSender>[0]["send"]) => {
  const onError = vi.fn();
  const onState = vi.fn();
  const sender = createVoiceAudioSender({ send, onError, onState });
  return { sender, onError, onState };
};

describe("reliable voice uploads", () => {
  it("buffers a three-second outage and drains all audio in order", async () => {
    vi.useFakeTimers();
    const received: number[] = [];
    const { sender } = setup(async (chunk, sequence) => {
      expect(sequence).toBe(received.length);
      received.push(...chunk);
      return { accepted: true, nextSequence: received.length };
    });
    for (let i = 0; i < 30; i++) sender.push(new Uint8Array([i]));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(received).toEqual([]);
    sender.setReady(true);
    await sender.drain();
    expect(received).toEqual(Array.from({ length: 30 }, (_, i) => i));
    sender.stop();
  });

  it("retries the exact batch after a lost acknowledgement, even as more audio arrives", async () => {
    vi.useFakeTimers();
    const attempts: Array<[number, number[]]> = [];
    const { sender } = setup(async (chunk, sequence) => {
      attempts.push([sequence, [...chunk]]);
      if (attempts.length === 1) throw new Error("reply lost");
      return { accepted: true, nextSequence: sequence + chunk.length };
    });
    sender.setReady(true);
    sender.push(new Uint8Array([1, 2]));
    await vi.advanceTimersByTimeAsync(1);
    sender.push(new Uint8Array([3, 4]));
    await vi.advanceTimersByTimeAsync(500);
    await sender.drain();
    expect(attempts).toEqual([
      [0, [1, 2]],
      [0, [1, 2]],
      [2, [3, 4]],
    ]);
    sender.stop();
  });

  it("does not mistake accepted:false for delivery", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { sender } = setup(async (chunk, sequence) => ({
      accepted: ++attempts > 1,
      nextSequence: sequence + chunk.length,
    }));
    sender.setReady(true);
    sender.push(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(501);
    await sender.drain();
    expect(attempts).toBe(2);
    sender.stop();
  });

  it("waits for buffered audio when stopped offline", async () => {
    vi.useFakeTimers();
    const { sender } = setup(async (chunk, sequence) => ({
      accepted: true,
      nextSequence: sequence + chunk.length,
    }));
    sender.push(new Uint8Array([1]));
    let finished = false;
    const drain = sender.drain().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(finished).toBe(false);
    sender.setReady(true);
    await drain;
    expect(finished).toBe(true);
    sender.stop();
  });

  it("bounds a hung upload and reports failure instead of silently dropping audio", async () => {
    vi.useFakeTimers();
    const { sender, onError, onState } = setup(() => new Promise(() => {}));
    sender.setReady(true);
    sender.push(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(30_250);
    expect(onError).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith(true);
    await expect(sender.drain()).rejects.toThrow("30 seconds");
  });

  it("reports a full buffer explicitly", () => {
    const { sender, onError } = setup(() => new Promise(() => {}));
    sender.push(new Uint8Array(MAX_PENDING_VOICE_BYTES));
    sender.push(new Uint8Array([1]));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("buffer is full"));
  });
});
