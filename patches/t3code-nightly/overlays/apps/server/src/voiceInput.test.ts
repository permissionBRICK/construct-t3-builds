import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createVoiceAudioSource,
  FIRST_CLIENT_CHUNK_TIMEOUT_MS,
  NO_CLIENT_AUDIO_MESSAGE,
  routeVoiceAudio,
  VoiceSession,
  startVoiceInput,
  stopVoiceInput,
  VOICE_RECONNECT_GRACE_MS,
  type VoiceAudioSourceHandlers,
} from "./voiceInput.ts";

const handlers = () => {
  const audio: Array<Buffer> = [];
  const failures: Array<string> = [];
  return {
    audio,
    failures,
    handlers: {
      audio: (chunk) => audio.push(chunk),
      fail: (message) => failures.push(message),
    } satisfies VoiceAudioSourceHandlers,
  };
};

describe("voice audio sources", () => {
  it("defaults to the host recorder when the client did not pick a source", () => {
    expect(createVoiceAudioSource(undefined).kind).toBe("host");
    expect(createVoiceAudioSource("host").kind).toBe("host");
    expect(createVoiceAudioSource("client").kind).toBe("client");
  });

  it("emits server-side levels only for host audio", () => {
    expect(createVoiceAudioSource("host").emitsLevels).toBe(true);
    expect(createVoiceAudioSource("client").emitsLevels).toBe(false);
  });

  it("refuses pushed audio for a host session without starting the recorder", () => {
    // Recording happens on the server, so a pushed chunk has nowhere to go.
    expect(createVoiceAudioSource("host").push(new Uint8Array([1, 2]))).toBe(false);
  });

  it("drops client chunks that arrive before the transcription socket is open", () => {
    const source = createVoiceAudioSource("client");
    expect(source.push(new Uint8Array([1, 2]))).toBe(false);
  });

  it("forwards client chunks once the session is listening", () => {
    vi.useFakeTimers();
    try {
      const sink = handlers();
      const source = createVoiceAudioSource("client");
      source.start(sink.handlers);

      expect(source.push(new Uint8Array([1, 2, 3, 4]))).toBe(true);
      expect(sink.audio).toHaveLength(1);
      expect([...sink.audio[0]!]).toEqual([1, 2, 3, 4]);

      // The first chunk arrived, so the "no audio" watchdog must not fire.
      vi.advanceTimersByTime(FIRST_CLIENT_CHUNK_TIMEOUT_MS * 2);
      expect(sink.failures).toEqual([]);

      source.stop();
      expect(source.push(new Uint8Array([5]))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores empty client chunks", () => {
    const sink = handlers();
    const source = createVoiceAudioSource("client");
    source.start(sink.handlers);
    expect(source.push(new Uint8Array())).toBe(false);
    expect(sink.audio).toEqual([]);
    source.stop();
  });

  it("fails the session when no client audio arrives at all", () => {
    vi.useFakeTimers();
    try {
      const sink = handlers();
      const source = createVoiceAudioSource("client");
      source.start(sink.handlers);

      vi.advanceTimersByTime(FIRST_CLIENT_CHUNK_TIMEOUT_MS - 1);
      expect(sink.failures).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sink.failures).toEqual([NO_CLIENT_AUDIO_MESSAGE]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the watchdog when the session ends before any audio", () => {
    vi.useFakeTimers();
    try {
      const sink = handlers();
      const source = createVoiceAudioSource("client");
      source.start(sink.handlers);
      source.stop();
      vi.advanceTimersByTime(FIRST_CLIENT_CHUNK_TIMEOUT_MS * 2);
      expect(sink.failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("routeVoiceAudio", () => {
  it("rejects unknown session ids quietly", () => {
    const sessions = new Map<
      string,
      {
        pushAudio: (
          chunk: Uint8Array,
          sequence: number,
        ) => { accepted: boolean; nextSequence: number };
      }
    >();
    expect(routeVoiceAudio(sessions, "unknown", new Uint8Array([1]), 0)).toEqual({
      accepted: false,
      nextSequence: 0,
    });
  });

  it("hands the chunk to the session that owns the id", () => {
    const seen: Array<{ id: string; bytes: number }> = [];
    const session = (id: string, accepts: boolean) => ({
      pushAudio: (chunk: Uint8Array) => {
        seen.push({ id, bytes: chunk.byteLength });
        return { accepted: accepts, nextSequence: chunk.byteLength };
      },
    });
    const sessions = new Map([
      ["client-session", session("client-session", true)],
      ["host-session", session("host-session", false)],
    ]);

    expect(routeVoiceAudio(sessions, "client-session", new Uint8Array([1, 2]), 0)).toEqual({
      accepted: true,
      nextSequence: 2,
    });
    expect(routeVoiceAudio(sessions, "host-session", new Uint8Array([1, 2, 3]), 0)).toEqual({
      accepted: false,
      nextSequence: 3,
    });
    expect(seen).toEqual([
      { id: "client-session", bytes: 2 },
      { id: "host-session", bytes: 3 },
    ]);
  });
});

const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      sent: unknown[] = [];
      constructor() {
        super();
        sockets.push(this);
      }
      send(value: unknown) {
        this.sent.push(value);
      }
      terminate() {
        this.readyState = 3;
      }
    },
  };
});
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }),
}));

function sessionFixture() {
  vi.useFakeTimers();
  const session = new VoiceSession("test-session", createVoiceAudioSource("client"));
  const callbacks = { event: vi.fn(), error: vi.fn(), complete: vi.fn() };
  session.attach(callbacks);
  session.start();
  const socket = sockets.at(-1)!;
  socket.emit("open");
  return { session, callbacks, socket };
}

describe("voice sessions across client disconnects", () => {
  it("keeps transcription alive and replays the current text on reattach", () => {
    const { session, callbacks, socket } = sessionFixture();
    try {
      session.pushAudio(new Uint8Array([1, 2]), 0);
      session.detach(callbacks);
      vi.advanceTimersByTime(4_000);
      socket.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "hello world" }));
      const next = { event: vi.fn(), error: vi.fn(), complete: vi.fn() };
      session.attach(next);
      session.detach(callbacks); // delayed cleanup from the old subscriber
      vi.advanceTimersByTime(27_000);
      expect(next.error).not.toHaveBeenCalled();
      expect(next.event).toHaveBeenCalledWith({
        type: "transcript",
        text: "hello world",
        final: false,
      });
      expect(next.event).toHaveBeenCalledWith({ type: "listening" });
      expect(socket.readyState).toBe(1);
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });
  it("deduplicates a delivered chunk whose acknowledgement was lost and rejects gaps", () => {
    const { session, socket } = sessionFixture();
    try {
      const audio = new Uint8Array([1, 2]);
      expect(session.pushAudio(audio, 0)).toEqual({ accepted: true, nextSequence: 2 });
      expect(session.pushAudio(audio, 0)).toEqual({ accepted: true, nextSequence: 2 });
      expect(session.pushAudio(audio, 4)).toEqual({ accepted: false, nextSequence: 2 });
      expect(socket.sent.filter((item: unknown) => Buffer.isBuffer(item))).toHaveLength(1);
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });
  it("does not mistake delayed transcription for microphone silence", () => {
    const { session, callbacks } = sessionFixture();
    try {
      for (let i = 0; i < 20; i++) {
        session.pushAudio(new Uint8Array([1, 2]), i * 2);
        vi.advanceTimersByTime(1_000);
      }
      expect(callbacks.error).not.toHaveBeenCalled();
      expect(callbacks.complete).not.toHaveBeenCalled();
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });
  it("expires an abandoned recording and returns the reason on reconnect", () => {
    const { session, callbacks, socket } = sessionFixture();
    try {
      session.detach(callbacks);
      vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
      expect(socket.readyState).toBe(3);
      const next = { event: vi.fn(), error: vi.fn(), complete: vi.fn() };
      session.attach(next);
      expect(next.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("30 seconds") }),
      );
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });
  it("reports unexpected provider closure as failure, not a successful stop", () => {
    const { session, callbacks, socket } = sessionFixture();
    try {
      socket.emit("close", 1006);
      expect(callbacks.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("1006") }),
      );
      expect(callbacks.complete).not.toHaveBeenCalled();
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });
});

it("retains the session when the RPC stream scope is cancelled and reattaches without opening another provider socket", async () => {
  vi.useRealTimers();
  const before = sockets.length;
  const first = Effect.runFork(Stream.runDrain(startVoiceInput("rpc-recovery", "client", false)));
  await Effect.runPromise(Effect.sleep("20 millis"));
  expect(sockets.length).toBe(before + 1);
  const socket = sockets.at(-1)!;
  const count = sockets.length;
  socket.emit("open");
  await Effect.runPromise(Fiber.interrupt(first));
  await Effect.runPromise(Effect.sleep("20 millis"));
  expect(socket.readyState).toBe(1);
  const events: unknown[] = [];
  const second = Effect.runFork(
    startVoiceInput("rpc-recovery", "client", true).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
    ),
  );
  await Effect.runPromise(Effect.sleep("20 millis"));
  expect(sockets.length).toBe(count);
  expect(events).toContainEqual({ type: "listening" });
  await Effect.runPromise(stopVoiceInput("rpc-recovery"));
  socket.emit("message", JSON.stringify({ type: "TranscriptText", data: "final words" }));
  socket.emit("close", 1000);
  await Effect.runPromise(Effect.sleep("20 millis"));
  expect(events).toContainEqual({ type: "transcript", text: "final words", final: false });
  expect(events).toContainEqual({ type: "stopped", reason: "user-stop" });
  await Effect.runPromise(Fiber.interrupt(second));
  const finalEvents: unknown[] = [];
  await Effect.runPromise(
    startVoiceInput("rpc-recovery", "client", true).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          finalEvents.push(event);
        }),
      ),
    ),
  );
  expect(finalEvents).toContainEqual({ type: "transcript", text: "final words", final: true });
  expect(finalEvents).toContainEqual({ type: "stopped", reason: "user-stop" });
  expect(sockets.length).toBe(count);
  vi.useRealTimers();
});
