// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - this module is the
// callback boundary for a native recorder and the ws client; their lifetimes
// survive a subscriber disconnect for a bounded reconnection window.
import {
  VoiceInputError,
  type VoiceInputSource,
  type VoiceInputStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import WebSocket from "ws";
import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const VOICE_STREAM_URL = "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream";
const KEEP_ALIVE_MS = 8_000;
export const VOICE_RECONNECT_GRACE_MS = 30_000;
const AUDIO_TIMEOUT_MS = 35_000;
const MAX_RECORDING_MS = 300_000;
const CLOSE_GRACE_MS = 3_000;
const STOP_GRACE_MS = 10_000;
const PCM_BYTES_PER_MS = 32;
/** Continuous quiet audio after speech that closes the stream so the service finalizes it. */
export const VOICE_PAUSE_MS = 2_000;
/** Already sent audio replayed at the start of the next stream. */
export const VOICE_PREROLL_MS = 500;
const SILENCE_RMS_MIN = 0.01;
const SILENCE_NOISE_FACTOR = 3;
const LEVEL_INTERVAL_MS = 75;
export const FIRST_CLIENT_CHUNK_TIMEOUT_MS = 35_000;
export const NO_CLIENT_AUDIO_MESSAGE = "No microphone audio arrived from the client.";
export const HOST_BRIDGE_UNAVAILABLE_MESSAGE =
  "The host microphone bridge is unavailable. Enable microphone passthrough in Construct and keep its VS Code extension running.";
const KEYTERMS = [
  "VS Code",
  "IDE",
  "webview",
  "IntelliSense",
  "MCP",
  "symlink",
  "grep",
  "regex",
  "localhost",
  "codebase",
  "TypeScript",
  "JSON",
  "OAuth",
  "webhook",
  "gRPC",
  "dotfiles",
  "subagent",
  "worktree",
].join(",");

type VoiceSessionCallbacks = {
  readonly event: (event: VoiceInputStreamEvent) => void;
  readonly error: (error: VoiceInputError) => void;
  readonly complete: () => void;
};

/** How a source hands audio and failures back to the session that owns it. */
export type VoiceAudioSourceHandlers = {
  /** 16 kHz mono S16LE PCM headed for the transcription socket. */
  readonly audio: (chunk: Buffer) => void;
  /** Fatal: the session ends and the client is told why. */
  readonly fail: (message: string) => void;
};

/**
 * Where a session's microphone audio comes from. `start` runs once the
 * transcription socket is open, so a source never produces audio that would be
 * dropped on the floor.
 */
export interface VoiceAudioSource {
  readonly kind: VoiceInputSource;
  /** Whether the server derives the level ring from the audio it sees. */
  readonly emitsLevels: boolean;
  start(handlers: VoiceAudioSourceHandlers): void;
  stop(): void;
  /** Takes a chunk pushed by a client; false when this source has no use for it. */
  push(chunk: Uint8Array): boolean;
}

/** Records on the server through Construct's `rec` shim. */
class HostAudioSource implements VoiceAudioSource {
  readonly kind = "host" as const;
  readonly emitsLevels = true;
  private recorder: NodeChildProcess.ChildProcessByStdio<
    null,
    NodeStream.Readable,
    NodeStream.Readable
  > | null = null;
  private stopped = false;

  start(handlers: VoiceAudioSourceHandlers): void {
    const recorder = NodeChildProcess.spawn(
      "rec",
      [
        "-q",
        "--buffer",
        "1024",
        "-t",
        "raw",
        "-r",
        "16000",
        "-e",
        "signed",
        "-b",
        "16",
        "-c",
        "1",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.recorder = recorder;
    recorder.stdout.on("data", (chunk: Buffer) => handlers.audio(chunk));
    recorder.on("error", (error) =>
      handlers.fail(`Could not start the recorder: ${error.message}`),
    );
    recorder.on("exit", (code) => {
      if (!this.stopped && code !== 0) handlers.fail(HOST_BRIDGE_UNAVAILABLE_MESSAGE);
    });
  }

  stop(): void {
    this.stopped = true;
    this.recorder?.kill("SIGTERM");
    this.recorder = null;
  }

  push(): boolean {
    return false;
  }
}

/** Takes microphone audio the connected client captured and pushed over RPC. */
class ClientAudioSource implements VoiceAudioSource {
  readonly kind = "client" as const;
  readonly emitsLevels = false;
  private handlers: VoiceAudioSourceHandlers | null = null;
  private firstChunkTimer: NodeJS.Timeout | null = null;

  start(handlers: VoiceAudioSourceHandlers): void {
    this.handlers = handlers;
    // Allow the reconnect window before reporting missing microphone audio.
    this.firstChunkTimer = setTimeout(
      () => handlers.fail(NO_CLIENT_AUDIO_MESSAGE),
      FIRST_CLIENT_CHUNK_TIMEOUT_MS,
    );
  }

  stop(): void {
    if (this.firstChunkTimer) clearTimeout(this.firstChunkTimer);
    this.firstChunkTimer = null;
    this.handlers = null;
  }

  push(chunk: Uint8Array): boolean {
    // Chunks that race ahead of the transcription socket are dropped: the
    // client only starts pushing once it sees `listening`.
    const handlers = this.handlers;
    if (!handlers || chunk.byteLength === 0) return false;
    if (this.firstChunkTimer) {
      clearTimeout(this.firstChunkTimer);
      this.firstChunkTimer = null;
    }
    handlers.audio(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    return true;
  }
}

export function createVoiceAudioSource(source: VoiceInputSource | undefined): VoiceAudioSource {
  return source === "client" ? new ClientAudioSource() : new HostAudioSource();
}

function readClaudeAccessToken(): string {
  const configDirectory =
    process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(NodeOS.homedir(), ".claude");
  const credentialsPath = NodePath.join(configDirectory, ".credentials.json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(NodeFS.readFileSync(credentialsPath, "utf8"));
  } catch {
    throw new Error(
      `Claude credentials were not readable at ${credentialsPath}. Sign in with claude first.`,
    );
  }
  const token =
    typeof decoded === "object" &&
    decoded !== null &&
    "claudeAiOauth" in decoded &&
    typeof decoded.claudeAiOauth === "object" &&
    decoded.claudeAiOauth !== null &&
    "accessToken" in decoded.claudeAiOauth &&
    typeof decoded.claudeAiOauth.accessToken === "string"
      ? decoded.claudeAiOauth.accessToken.trim()
      : "";
  if (!token)
    throw new Error(
      "Claude OAuth credentials do not contain an access token. Sign in with claude first.",
    );
  return token;
}

// Let Claude own OAuth refresh and credential persistence, including its refresh lock.
// Several voice sessions can encounter the same expired token at once.
let claudeAuthRefresh: Promise<void> | null = null;
function refreshClaudeAuth(): Promise<void> {
  if (claudeAuthRefresh) return claudeAuthRefresh;
  claudeAuthRefresh = (async () => {
    const abort = new AbortController();
    let q: ReturnType<typeof claudeQuery> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      q = claudeQuery({
        // Initialization only: never submit a user message or run a model turn.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await new Promise<void>((resolve) => {
            if (abort.signal.aborted) resolve();
            else abort.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
        options: {
          pathToClaudeCodeExecutable: "claude",
          abortController: abort,
          persistSession: false,
          settingSources: [],
          settings: { disableAllHooks: true },
          allowedTools: [],
          mcpServers: {},
          strictMcpConfig: true,
          env: {
            ...process.env,
            ENABLE_CLAUDEAI_MCP_SERVERS: "false",
            FORCE_CODE_TERMINAL: undefined,
            CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
            CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
          },
          stderr: () => {},
        },
      });
      await Promise.race([
        q.initializationResult(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Claude authentication refresh timed out.")),
            15_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
      q?.close();
    }
  })().finally(() => {
    claudeAuthRefresh = null;
  });
  return claudeAuthRefresh;
}

function voiceStreamUrl(): string {
  const query = new URLSearchParams({
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    endpointing_ms: "300",
    utterance_end_ms: "1000",
    language: process.env.CLAUDE_CODE_VOICE_LANGUAGE?.trim() || "en",
    use_conversation_engine: "true",
    forward_interims: "typed",
  });
  return `${VOICE_STREAM_URL}?${query.toString()}`;
}

/**
 * One transcription WebSocket. The service only revises its transcript when a
 * stream is closed, so a session rotates to a fresh stream at every pause.
 */
type TranscriptStream = {
  socket: WebSocket | null;
  /** Audio waiting for the socket to open, oldest first. */
  pending: Buffer[];
  /** Audio routed to this stream, excluding the pre-roll it was seeded with. */
  audioBytes: number;
  closing: boolean;
  closeSent: boolean;
  done: boolean;
  closeTimer: NodeJS.Timeout | null;
  committed: string[];
  interim: string;
};

function newTranscriptStream(pending: Buffer[] = []): TranscriptStream {
  return {
    socket: null,
    pending,
    audioBytes: 0,
    closing: false,
    closeSent: false,
    done: false,
    closeTimer: null,
    committed: [],
    interim: "",
  };
}

function audioRms(chunk: Buffer): number {
  let sumSquares = 0;
  let sampleCount = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = chunk.readInt16LE(offset) / 32_768;
    sumSquares += sample * sample;
    sampleCount += 1;
  }
  return sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
}

export class VoiceSession {
  readonly id: string;
  private callbacks: VoiceSessionCallbacks | null = null;
  private detachTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private terminalError: VoiceInputError | null = null;
  private nextSequence = 0;
  private listening = false;
  private stopReason = "user-stop";
  private readonly source: VoiceAudioSource;
  /** In recording order; the last one receives live audio. */
  private streams: TranscriptStream[] = [];
  private keepAlive: NodeJS.Timeout | null = null;
  private audioTimer: NodeJS.Timeout | null = null;
  private maximumTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  /** The most recent audio, replayed into the next stream when rotating. */
  private preroll: Buffer[] = [];
  private prerollBytes = 0;
  private quietBytes = 0;
  private noiseFloor = 0;
  private lastLevelAt = 0;
  private stopping = false;
  private ended = false;

  constructor(id: string, source: VoiceAudioSource) {
    this.id = id;
    this.source = source;
  }

  attach(callbacks: VoiceSessionCallbacks): void {
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = null;
    this.callbacks = callbacks;
    if (this.fullTranscript())
      callbacks.event({ type: "transcript", text: this.fullTranscript(), final: this.ended });
    if (this.terminalError) callbacks.error(this.terminalError);
    else if (this.ended) {
      callbacks.event({ type: "stopped", reason: this.stopReason });
      callbacks.complete();
    } else if (this.listening) callbacks.event({ type: "listening" });
  }

  detach(callbacks: VoiceSessionCallbacks): void {
    // A late finalizer from an old socket must not detach its replacement.
    if (this.callbacks !== callbacks) return;
    this.callbacks = null;
    if (this.ended) return;
    this.detachTimer = setTimeout(() => {
      this.fail("Voice connection did not return within 30 seconds.", true);
    }, VOICE_RECONNECT_GRACE_MS);
  }

  /** Byte offsets provide ordered delivery and deduplicate lost acknowledgements. */
  pushAudio(chunk: Uint8Array, sequence: number): { accepted: boolean; nextSequence: number } {
    let accepted = false;
    if (!this.stopping && !this.ended && this.source.kind === "client") {
      if (sequence < this.nextSequence && sequence + chunk.byteLength <= this.nextSequence)
        accepted = true;
      // Once listening, audio is accepted even while a rotated stream connects.
      else if (sequence === this.nextSequence && this.listening) {
        accepted = this.source.push(chunk);
        if (accepted) this.nextSequence += chunk.byteLength;
      }
    }
    return { accepted, nextSequence: this.nextSequence };
  }

  start(): void {
    const stream = newTranscriptStream();
    this.streams.push(stream);
    this.connect(stream, false);
  }

  private connect(stream: TranscriptStream, authRetried: boolean): void {
    const token = readClaudeAccessToken();
    const socket = new WebSocket(voiceStreamUrl(), {
      handshakeTimeout: 15_000,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-app": "vscode",
        "anthropic-client-platform": "claude_code_vscode",
        "x-config-keyterms": KEYTERMS,
      },
    });
    stream.socket = socket;

    socket.on("open", () => {
      if (stream.socket !== socket || stream.done || this.ended) return;
      socket.send(JSON.stringify({ type: "KeepAlive" }));
      for (const chunk of stream.pending.splice(0)) socket.send(chunk);
      if (stream.closing) this.sendClose(stream);
      if (this.listening) return;
      this.listening = true;
      this.callbacks?.event({ type: "listening" });
      this.source.start({
        audio: (chunk) => this.routeAudio(chunk),
        fail: (message) => this.fail(message, true),
      });
      this.keepAlive = setInterval(() => {
        for (const active of this.streams) {
          if (!active.closeSent && active.socket?.readyState === WebSocket.OPEN)
            active.socket.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEP_ALIVE_MS);
      this.maximumTimer = setTimeout(() => this.stop("recording-limit"), MAX_RECORDING_MS);
      this.resetAudioTimer();
    });

    socket.on("message", (raw) => {
      if (stream.socket !== socket || stream.done) return;
      let message: { type?: string; data?: string; description?: string; message?: string };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.type === "TranscriptInterim" || message.type === "TranscriptText") {
        if (message.data) {
          stream.interim = message.data;
          this.callbacks?.event({ type: "transcript", text: this.fullTranscript(), final: false });
        }
        return;
      }
      if (message.type === "TranscriptEndpoint") {
        const segment = stream.interim.trim();
        if (segment) stream.committed.push(segment);
        stream.interim = "";
        this.callbacks?.event({ type: "transcript", text: this.fullTranscript(), final: true });
        return;
      }
      if (message.type === "TranscriptError") {
        this.fail(message.description || "Claude voice transcription failed.", true);
      } else if (message.type === "error") {
        this.fail(message.message || "Claude voice transcription failed.", true);
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      if (stream.socket !== socket || stream.done || this.ended) return;
      response.resume();
      if (response.statusCode !== 401 || authRetried) {
        this.fail(
          `Claude voice WebSocket error: Unexpected server response: ${response.statusCode}`,
          true,
        );
        return;
      }
      // Ignore the rejected socket's subsequent error/close while auth refreshes.
      stream.socket = null;
      socket.terminate();
      void (async () => {
        try {
          // Another Claude session may already have replaced the rejected token.
          if (readClaudeAccessToken() === token) await refreshClaudeAuth();
          if (!stream.done && !this.ended) this.connect(stream, true);
        } catch {
          if (!stream.done && !this.ended)
            this.fail(
              "Could not refresh Claude voice authentication. Sign in with claude and try again.",
              true,
            );
        }
      })();
    });
    socket.on("error", (error) => {
      if (stream.socket !== socket || stream.done) return;
      if (stream.closeSent) this.streamDone(stream);
      else this.fail(`Claude voice WebSocket error: ${error.message}`, true);
    });
    socket.on("close", (code) => {
      if (stream.socket !== socket || stream.done) return;
      if (stream.closeSent) this.streamDone(stream);
      else this.fail(`Transcription connection closed unexpectedly (code ${code}).`, true);
    });
  }

  stop(reason = "user-stop"): void {
    if (this.stopping || this.ended) return;
    this.stopping = true;
    this.stopReason = reason;
    this.source.stop();
    for (const stream of this.streams) {
      if (stream.closing || stream.done) continue;
      // A stream that never opened and never received audio has nothing to finalize.
      if (stream.socket?.readyState !== WebSocket.OPEN && stream.audioBytes === 0)
        this.streamDone(stream);
      else this.requestClose(stream);
    }
    // Bounds a rotated stream that is still connecting when recording stops.
    if (!this.ended) this.closeTimer = setTimeout(() => this.finish(), STOP_GRACE_MS);
  }

  failToStart(message: string): void {
    this.fail(message, true);
  }

  abort(): void {
    this.stopping = true;
    this.finish(false);
  }

  private fullTranscript(): string {
    return this.streams
      .flatMap((stream) => [...stream.committed, stream.interim.trim()])
      .filter(Boolean)
      .join(" ");
  }

  private routeAudio(chunk: Buffer): void {
    if (this.stopping || this.ended) return;
    this.resetAudioTimer();
    const rms = audioRms(chunk);
    if (this.source.emitsLevels) this.emitAudioLevel(rms);
    const stream = this.streams.at(-1)!;
    this.sendAudio(stream, chunk);
    this.rememberAudio(chunk);
    this.trackPause(stream, chunk.length, rms);
  }

  private sendAudio(stream: TranscriptStream, chunk: Buffer): void {
    stream.audioBytes += chunk.length;
    if (stream.pending.length === 0 && stream.socket?.readyState === WebSocket.OPEN)
      stream.socket.send(chunk);
    else stream.pending.push(chunk);
  }

  private rememberAudio(chunk: Buffer): void {
    // Client chunks are views into an RPC buffer; keep a private copy.
    this.preroll.push(Buffer.from(chunk));
    this.prerollBytes += chunk.length;
    while (this.prerollBytes - this.preroll[0]!.length >= VOICE_PREROLL_MS * PCM_BYTES_PER_MS)
      this.prerollBytes -= this.preroll.shift()!.length;
  }

  /**
   * Silence is measured in audio time, not wall time, so a burst of buffered
   * client audio after a reconnect is judged by what was actually recorded.
   */
  private trackPause(stream: TranscriptStream, bytes: number, rms: number): void {
    const quiet = rms < Math.max(SILENCE_RMS_MIN, this.noiseFloor * SILENCE_NOISE_FACTOR);
    // The floor drops to any quieter chunk at once and creeps up over about five seconds.
    this.noiseFloor =
      rms < this.noiseFloor
        ? rms
        : this.noiseFloor + (rms - this.noiseFloor) * Math.min(1, bytes / PCM_BYTES_PER_MS / 5_000);
    if (!quiet) {
      this.quietBytes = 0;
      return;
    }
    this.quietBytes += bytes;
    const hasText = stream.committed.length > 0 || stream.interim.trim() !== "";
    if (this.quietBytes >= VOICE_PAUSE_MS * PCM_BYTES_PER_MS && hasText) this.rotate();
  }

  /**
   * Closes the live stream so the service finalizes it, and continues on a new
   * one. Every chunk after the cut is queued for the new stream while it
   * connects, and the new stream starts with the last pre-roll of already sent
   * (quiet) audio, so speech beginning right at the cut reaches it in full.
   */
  private rotate(): void {
    const previous = this.streams.at(-1)!;
    const next = newTranscriptStream([...this.preroll]);
    this.quietBytes = 0;
    this.streams.push(next);
    this.requestClose(previous);
    try {
      this.connect(next, false);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error), true);
    }
  }

  private requestClose(stream: TranscriptStream): void {
    stream.closing = true;
    // A connecting stream sends CloseStream after flushing its queued audio.
    if (stream.socket?.readyState === WebSocket.OPEN && stream.pending.length === 0)
      this.sendClose(stream);
  }

  private sendClose(stream: TranscriptStream): void {
    if (stream.closeSent || !stream.socket) return;
    stream.closeSent = true;
    stream.socket.send(JSON.stringify({ type: "CloseStream" }));
    stream.closeTimer = setTimeout(() => this.streamDone(stream), CLOSE_GRACE_MS);
  }

  /** Keeps the stream's last text; the session ends once stopping and all streams are done. */
  private streamDone(stream: TranscriptStream): void {
    if (stream.done) return;
    stream.done = true;
    if (stream.closeTimer) clearTimeout(stream.closeTimer);
    stream.closeTimer = null;
    stream.pending = [];
    if (stream.socket && stream.socket.readyState !== WebSocket.CLOSED) stream.socket.terminate();
    stream.socket = null;
    if (this.stopping && this.streams.every((active) => active.done)) this.finish();
  }

  private emitAudioLevel(rms: number): void {
    const now = Date.now();
    if (now - this.lastLevelAt < LEVEL_INTERVAL_MS) return;
    this.lastLevelAt = now;
    const value = Math.min(1, Math.max(0, (rms - 0.006) * 10));
    this.callbacks?.event({ type: "level", value });
  }

  private resetAudioTimer(): void {
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.audioTimer = setTimeout(
      () => this.fail("Microphone audio stopped arriving for 35 seconds.", true),
      AUDIO_TIMEOUT_MS,
    );
  }

  private fail(message: string, fatal: boolean): void {
    if (this.ended) return;
    this.terminalError = new VoiceInputError({ message, fatal });
    void Effect.runFork(
      Effect.logWarning("Voice session stopped", { sessionId: this.id, reason: message }),
    );
    this.callbacks?.error(this.terminalError);
    this.abort();
  }

  private finish(notify = true): void {
    if (this.ended) return;
    this.ended = true;
    this.source.stop();
    for (const stream of this.streams) {
      stream.done = true;
      stream.pending = [];
      if (stream.closeTimer) clearTimeout(stream.closeTimer);
      stream.closeTimer = null;
      if (stream.socket && stream.socket.readyState !== WebSocket.CLOSED) stream.socket.terminate();
      stream.socket = null;
    }
    this.preroll = [];
    for (const timer of [
      this.keepAlive,
      this.audioTimer,
      this.maximumTimer,
      this.closeTimer,
      this.detachTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.keepAlive = this.audioTimer = this.maximumTimer = this.closeTimer = null;
    this.detachTimer = null;
    // Retain the final transcript/reason so a reconnect cannot restart a finished recording.
    this.retentionTimer = setTimeout(() => {
      if (activeVoiceSessions.get(this.id) === this) activeVoiceSessions.delete(this.id);
    }, VOICE_RECONNECT_GRACE_MS);
    this.retentionTimer.unref?.();
    if (notify) {
      void Effect.runFork(
        Effect.logInfo("Voice session stopped", { sessionId: this.id, reason: this.stopReason }),
      );
      this.callbacks?.event({ type: "stopped", reason: this.stopReason });
      this.callbacks?.complete();
    }
  }
}

const activeVoiceSessions = new Map<string, VoiceSession>();

/**
 * Routes one pushed chunk to its session. Unknown ids and host-source sessions
 * are rejected quietly: a client that pushes into a session it does not own
 * learns nothing beyond "not accepted".
 */
export function routeVoiceAudio(
  sessions: ReadonlyMap<
    string,
    {
      pushAudio: (
        chunk: Uint8Array,
        sequence: number,
      ) => { accepted: boolean; nextSequence: number };
    }
  >,
  sessionId: string,
  chunk: Uint8Array,
  sequence: number,
): { accepted: boolean; nextSequence: number } {
  return (
    sessions.get(sessionId)?.pushAudio(chunk, sequence) ?? { accepted: false, nextSequence: 0 }
  );
}

export function pushVoiceAudio(
  sessionId: string,
  chunk: Uint8Array,
  sequence: number,
): Effect.Effect<{ accepted: boolean; nextSequence: number }> {
  return Effect.sync(() => routeVoiceAudio(activeVoiceSessions, sessionId, chunk, sequence));
}

export function stopVoiceInput(sessionId: string): Effect.Effect<{ stopped: boolean }> {
  return Effect.sync(() => {
    const session = activeVoiceSessions.get(sessionId);
    session?.stop();
    return { stopped: session !== undefined };
  });
}

export function startVoiceInput(
  sessionId: string,
  source: VoiceInputSource | undefined,
  resume: boolean,
): Stream.Stream<VoiceInputStreamEvent, VoiceInputError> {
  return Stream.callback<VoiceInputStreamEvent, VoiceInputError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const callbacks: VoiceSessionCallbacks = {
          event: (event) => void Effect.runFork(Queue.offer(queue, event)),
          error: (error) => void Effect.runFork(Queue.fail(queue, error)),
          complete: () => void Effect.runFork(Queue.end(queue)),
        };
        let session = activeVoiceSessions.get(sessionId);
        if (!session && resume) {
          callbacks.error(
            new VoiceInputError({
              message: "The voice session expired. Start a new recording.",
              fatal: true,
            }),
          );
          return () => {};
        }
        if (session) session.attach(callbacks);
        else {
          for (const active of activeVoiceSessions.values())
            active.stop("replaced-by-new-recording");
          session = new VoiceSession(sessionId, createVoiceAudioSource(source));
          activeVoiceSessions.set(sessionId, session);
          session.attach(callbacks);
          try {
            session.start();
          } catch (error) {
            session.failToStart(error instanceof Error ? error.message : String(error));
          }
        }
        const attached = session;
        return () => attached.detach(callbacks);
      }),
      (detach) => Effect.sync(detach),
    ).pipe(Effect.forkScoped),
  );
}
