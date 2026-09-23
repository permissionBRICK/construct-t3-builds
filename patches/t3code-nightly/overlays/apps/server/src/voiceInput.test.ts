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
  VOICE_PAUSE_MS,
  VOICE_PREROLL_MS,
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

const auth = vi.hoisted(() => ({
  initialize: vi.fn(),
  close: vi.fn(),
  query: vi.fn(),
  token: "test-token",
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: unknown) => {
    auth.query(input);
    return { initializationResult: auth.initialize, close: auth.close };
  },
}));

const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      sent: unknown[] = [];
      constructor(
        readonly url: string,
        readonly options: any,
      ) {
        super();
        sockets.push(this);
      }
      override emit(event: string, ...args: unknown[]) {
        if (event === "open") this.readyState = 1;
        if (event === "close") this.readyState = 3;
        return super.emit(event, ...args);
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
  readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: auth.token } }),
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

describe("voice stream rotation at pauses", () => {
  const CHUNK_MS = 100;
  const pcm = (value: number, id = 0) => {
    const chunk = Buffer.alloc(CHUNK_MS * 32);
    for (let offset = 0; offset < chunk.length; offset += 2) chunk.writeInt16LE(value, offset);
    // Mark the first sample so each chunk is identifiable in socket output.
    chunk.writeInt16LE(value === 0 ? id % 16 : value + id, 0);
    return chunk;
  };
  const speech = (id: number) => pcm(8_000, id);
  const silence = (id: number) => pcm(0, id);
  const audioSent = (socket: any) =>
    Buffer.concat(socket.sent.filter((item: unknown) => Buffer.isBuffer(item)));
  const control = (socket: any) =>
    socket.sent
      .filter((item: unknown) => typeof item === "string")
      .map((item: string) => JSON.parse(item).type);

  function recorder() {
    const { session, callbacks, socket } = sessionFixture();
    let sequence = 0;
    const pushed: Buffer[] = [];
    const push = (chunk: Buffer) => {
      pushed.push(chunk);
      const result = session.pushAudio(new Uint8Array(chunk), sequence);
      expect(result.accepted).toBe(true);
      sequence = result.nextSequence;
    };
    return { session, callbacks, socket, push, pushed };
  }

  it("finalizes the stream after a pause and continues on a new one without losing audio", () => {
    const { session, callbacks, socket, push, pushed } = recorder();
    try {
      const count = sockets.length;
      for (let i = 0; i < 10; i++) push(speech(i));
      socket.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "hello wold" }));
      for (let i = 0; i < VOICE_PAUSE_MS / CHUNK_MS - 1; i++) push(silence(i));
      expect(sockets).toHaveLength(count);
      push(silence(99));
      expect(sockets).toHaveLength(count + 1);
      expect(control(socket)).toContain("CloseStream");
      const next = sockets.at(-1)!;

      // Speech that starts right at the cut is queued while the new stream connects.
      for (let i = 0; i < 5; i++) push(speech(20 + i));
      expect(audioSent(next).length).toBe(0);
      next.emit("open");

      const before = audioSent(socket);
      expect(Buffer.concat(pushed).subarray(0, before.length).equals(before)).toBe(true);
      const preroll = VOICE_PREROLL_MS * 32;
      const after = audioSent(next);
      expect(after.subarray(0, preroll).equals(before.subarray(before.length - preroll))).toBe(true);
      expect(after.subarray(preroll).equals(Buffer.concat(pushed).subarray(before.length))).toBe(true);

      next.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "second part" }));
      expect(callbacks.event).toHaveBeenLastCalledWith({
        type: "transcript",
        text: "hello wold second part",
        final: false,
      });
      socket.emit("message", JSON.stringify({ type: "TranscriptText", data: "Hello world." }));
      socket.emit("message", JSON.stringify({ type: "TranscriptEndpoint" }));
      socket.emit("close", 1000);
      expect(callbacks.event).toHaveBeenLastCalledWith({
        type: "transcript",
        text: "Hello world. second part",
        final: true,
      });
      expect(callbacks.error).not.toHaveBeenCalled();
      expect(callbacks.complete).not.toHaveBeenCalled();
      const listening = callbacks.event.mock.calls.filter(([e]) => e.type === "listening");
      expect(listening).toHaveLength(1);
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });

  it("does not rotate on silence before any words or while speech continues", () => {
    const { session, socket, push } = recorder();
    try {
      const count = sockets.length;
      for (let i = 0; i < 40; i++) push(silence(i));
      socket.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "words" }));
      for (let i = 0; i < 60; i++) push(i % 10 === 0 ? speech(i) : silence(i));
      expect(sockets).toHaveLength(count);
      expect(control(socket)).not.toContain("CloseStream");
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });

  it("treats steady background noise as quiet", () => {
    const { session, socket, push } = recorder();
    try {
      const count = sockets.length;
      for (let i = 0; i < 30; i++) push(pcm(1_000, i));
      push(speech(1));
      socket.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "words" }));
      for (let i = 0; i < VOICE_PAUSE_MS / CHUNK_MS; i++) push(pcm(1_000, i));
      expect(sockets).toHaveLength(count + 1);
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });

  it("finishes queued audio of a connecting stream when stopped", () => {
    const { session, callbacks, socket, push } = recorder();
    try {
      push(speech(0));
      socket.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "one" }));
      for (let i = 0; i < VOICE_PAUSE_MS / CHUNK_MS; i++) push(silence(i));
      const next = sockets.at(-1)!;
      push(speech(1));
      session.stop();
      socket.emit("message", JSON.stringify({ type: "TranscriptText", data: "One." }));
      socket.emit("close", 1000);
      expect(callbacks.complete).not.toHaveBeenCalled();
      next.emit("open");
      expect(control(next).at(-1)).toBe("CloseStream");
      expect(audioSent(next).length).toBe(VOICE_PREROLL_MS * 32 + CHUNK_MS * 32);
      next.emit("message", JSON.stringify({ type: "TranscriptText", data: "Two." }));
      next.emit("close", 1000);
      expect(callbacks.event).toHaveBeenCalledWith({ type: "transcript", text: "One. Two.", final: false });
      expect(callbacks.event).toHaveBeenLastCalledWith({ type: "stopped", reason: "user-stop" });
      expect(callbacks.complete).toHaveBeenCalledTimes(1);
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });

  it("keeps the last text of a finalizing stream that does not answer in time", () => {
    const { session, callbacks, socket, push } = recorder();
    try {
      push(speech(0));
      socket.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "kept" }));
      for (let i = 0; i < VOICE_PAUSE_MS / CHUNK_MS; i++) push(silence(i));
      const next = sockets.at(-1)!;
      next.emit("open");
      vi.advanceTimersByTime(3_000);
      expect(socket.readyState).toBe(3);
      next.emit("message", JSON.stringify({ type: "TranscriptInterim", data: "more" }));
      expect(callbacks.event).toHaveBeenLastCalledWith({
        type: "transcript",
        text: "kept more",
        final: false,
      });
      expect(callbacks.error).not.toHaveBeenCalled();
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

describe("voice authentication recovery", () => {
  function pendingSession() {
    const session = new VoiceSession("auth-test", createVoiceAudioSource("client"));
    const callbacks = { event: vi.fn(), error: vi.fn(), complete: vi.fn() };
    session.attach(callbacks);
    session.start();
    return { session, callbacks, socket: sockets.at(-1)! };
  }
  function reject(socket: any, statusCode = 401) {
    socket.emit("unexpected-response", {}, { statusCode, resume: vi.fn() });
    socket.emit("error", new Error("handshake rejected"));
    socket.emit("close", 1006);
  }
  async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  it("shares initialization, rereads the token, and retries each handshake only once", async () => {
    let done!: () => void;
    auth.initialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    auth.query.mockClear();
    const a = pendingSession();
    const b = pendingSession();
    try {
      reject(a.socket);
      reject(b.socket);
      expect(auth.query).toHaveBeenCalledTimes(1);
      expect(a.callbacks.error).not.toHaveBeenCalled();
      expect(b.callbacks.error).not.toHaveBeenCalled();
      const input = auth.query.mock.calls[0]![0];
      expect(input.options.persistSession).toBe(false);
      expect(input.options.settings.disableAllHooks).toBe(true);
      const prompt = input.prompt.next();
      auth.token = "refreshed-token";
      done();
      await settle();
      expect(await prompt).toEqual({ done: true, value: undefined });
      const retries = sockets.slice(-2);
      for (const socket of retries) {
        expect(socket.options.headers.Authorization).toBe("Bearer refreshed-token");
        reject(socket);
      }
      expect(a.callbacks.error).toHaveBeenCalledTimes(1);
      expect(b.callbacks.error).toHaveBeenCalledTimes(1);
      expect(auth.query).toHaveBeenCalledTimes(1);
    } finally {
      a.session.abort();
      b.session.abort();
      auth.token = "test-token";
    }
  });
  it("uses credentials already refreshed by another Claude session", async () => {
    auth.query.mockClear();
    const { session, callbacks, socket } = pendingSession();
    try {
      auth.token = "other-session-token";
      reject(socket);
      await settle();
      expect(auth.query).not.toHaveBeenCalled();
      expect(sockets.at(-1)!.options.headers.Authorization).toBe("Bearer other-session-token");
      sockets.at(-1)!.emit("open");
      expect(callbacks.event).toHaveBeenCalledWith({ type: "listening" });
    } finally {
      session.abort();
      auth.token = "test-token";
    }
  });
  it("does not reconnect after the user stops during refresh", async () => {
    let done!: () => void;
    auth.initialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    const { session, socket } = pendingSession();
    reject(socket);
    const count = sockets.length;
    session.stop();
    done();
    await settle();
    expect(sockets).toHaveLength(count);
    session.abort();
  });
  it("reports refresh failures without exposing SDK error details", async () => {
    auth.initialize.mockRejectedValueOnce(new Error("sensitive provider detail"));
    const { session, callbacks, socket } = pendingSession();
    try {
      reject(socket);
      await settle();
      expect(callbacks.error).toHaveBeenCalledTimes(1);
      expect(callbacks.error.mock.calls[0]![0].message).toBe(
        "Could not refresh Claude voice authentication. Sign in with claude and try again.",
      );
    } finally {
      session.abort();
    }
  });
  it("bounds refresh time and closes the initialization process", async () => {
    vi.useFakeTimers();
    auth.initialize.mockImplementationOnce(() => new Promise(() => {}));
    auth.close.mockClear();
    const { session, callbacks, socket } = pendingSession();
    try {
      reject(socket);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(callbacks.error).toHaveBeenCalledTimes(1);
      expect(auth.close).toHaveBeenCalledTimes(1);
    } finally {
      session.abort();
      vi.useRealTimers();
    }
  });
  it("does not refresh for other HTTP failures", async () => {
    auth.query.mockClear();
    const { session, callbacks, socket } = pendingSession();
    try {
      reject(socket, 503);
      await settle();
      expect(auth.query).not.toHaveBeenCalled();
      expect(callbacks.error).toHaveBeenCalledTimes(1);
    } finally {
      session.abort();
    }
  });
});
