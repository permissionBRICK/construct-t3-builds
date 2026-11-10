/**
 * Construct: Claude as one more model of T3's own speech service, so every T3 client (the
 * stock mobile app included) can pick and use it. Recordings and T3's live stream go to
 * Claude's voice service through this machine's Claude Code sign-in.
 */

import {
  CLAUDE_SPEECH_MODEL_ID,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  claudeVoiceLanguage,
  constructVoiceInputEnabled,
  startClaudeTranscription,
  transcribeClaudeRecording,
  type ClaudeTranscription,
} from "../voiceInput.ts";
import { DEFAULT_SPEECH_MODEL_ID } from "./model.ts";
import * as SpeechService from "./SpeechService.ts";

type Speech = SpeechService.SpeechService["Service"];
type SpeechModels = Effect.Success<ReturnType<Speech["models"]>>;

export interface ClaudeSpeechEngine {
  readonly language: () => string;
  readonly start: () => ClaudeTranscription;
  /** 16 kHz mono S16LE in, final transcript out. */
  readonly transcribe: (pcm: Uint8Array, signal: AbortSignal) => Promise<string>;
}

const claudeSpeechEngine: ClaudeSpeechEngine = {
  language: claudeVoiceLanguage,
  start: startClaudeTranscription,
  transcribe: transcribeClaudeRecording,
};

export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32_768 : sample * 32_767), true);
  }
  return pcm;
}

export function claudeSpeechModel(active: boolean, language: string): EnvironmentSpeechModel {
  return {
    id: CLAUDE_SPEECH_MODEL_ID,
    name: "Claude",
    description:
      "Anthropic's speech-to-text through this machine's Claude Code sign-in. Nothing to download; recordings are sent to Anthropic.",
    size: 0,
    languages: [language],
    accuracy: 0,
    speed: 0,
    recommended: false,
    supportsStreaming: true,
    supportsLanguageDetection: false,
    supportsTranslation: false,
    active,
    state: "installed",
  };
}

/** The speech service with Claude added to its models; Claude can also become the default. */
export const makeClaudeSpeech = Effect.fn("ConstructClaudeSpeech.make")(function* (input: {
  readonly speech: Speech;
  readonly settings: Pick<
    ServerSettings.ServerSettingsService["Service"],
    "getSettings" | "updateSettings"
  >;
  readonly engine: ClaudeSpeechEngine;
  /** Construct VMs: Claude becomes the model when no installed model is selected. */
  readonly defaultToClaude: boolean;
}) {
  const { speech, settings, engine } = input;
  const operationError = (operation: string) => (cause: unknown) =>
    new SpeechService.SpeechOperationError({ operation, cause });
  const readSettings = (operation: string) =>
    settings.getSettings.pipe(Effect.mapError(operationError(operation)));
  const selectModelId = (operation: string, speechModelId: string) =>
    settings
      .updateSettings({ speechModelId })
      .pipe(Effect.mapError(operationError(operation)), Effect.asVoid);
  const ensureDefault = input.defaultToClaude
    ? yield* Effect.cached(
        Effect.gen(function* () {
          const current = yield* readSettings("model default");
          if (current.speechModelId === CLAUDE_SPEECH_MODEL_ID) return;
          const status = yield* speech.status;
          if (status.supported && status.state !== "missing-model") return;
          yield* selectModelId("model default", CLAUDE_SPEECH_MODEL_ID);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not make Claude the default speech model", { cause }),
          ),
        ),
      )
    : Effect.void;
  const usesClaude = (operation: string) =>
    ensureDefault.pipe(
      Effect.andThen(readSettings(operation)),
      Effect.map((current) => current.speechModelId === CLAUDE_SPEECH_MODEL_ID),
    );

  const withClaude = (list: SpeechModels, active: boolean): SpeechModels => ({
    models: [
      claudeSpeechModel(active, engine.language()),
      ...(active ? list.models.map((model) => ({ ...model, active: false })) : list.models),
    ],
  });
  const models = (includeBenchmarks: boolean) =>
    usesClaude("model listing").pipe(
      Effect.flatMap((active) =>
        speech.models(includeBenchmarks).pipe(Effect.map((list) => withClaude(list, active))),
      ),
    );

  const status = Effect.gen(function* () {
    if (!(yield* usesClaude("status"))) return yield* speech.status;
    const current = yield* readSettings("status");
    return {
      supported: true,
      state: "ready",
      modelId: CLAUDE_SPEECH_MODEL_ID,
      model: "Claude",
      size: 0,
      supportsStreaming: true,
      supportsBufferedStreaming: true,
      supportsTranslation: false,
      acceleration: current.speechAcceleration,
      benchmarkTier: "accelerated",
      modelUnloadTimeout: current.speechModelUnloadTimeout,
      gpuDevices: [],
    } satisfies EnvironmentSpeechStatus;
  });

  const isInvalidAudio = Schema.is(SpeechService.SpeechInvalidAudioError);
  const decode = (pcmBytes: Uint8Array) =>
    Effect.try({
      try: () => SpeechService.decodeSpeechPcm(pcmBytes),
      catch: (cause) => (isInvalidAudio(cause) ? cause : operationError("transcription")(cause)),
    });

  const transcribeWithClaude = (pcmBytes: Uint8Array) =>
    decode(pcmBytes).pipe(
      Effect.flatMap((samples) =>
        Effect.tryPromise({
          try: (signal) => engine.transcribe(float32ToPcm16(samples), signal),
          catch: operationError("transcription"),
        }),
      ),
      Effect.map((text) => text.trim()),
    );

  const streamWithClaude = Effect.acquireRelease(
    Effect.try({ try: () => engine.start(), catch: operationError("live transcription") }),
    (transcription) => Effect.sync(() => transcription.cancel()),
  ).pipe(
    Effect.map((transcription): SpeechService.SpeechStream => {
      let received = 0;
      let revision = 0;
      // Nothing is shown before the first words arrive.
      let shown = "\n";
      return {
        // Untraced: it runs for every audio chunk of a live recording.
        feed: Effect.fnUntraced(function* (bytes: Uint8Array) {
          if (
            bytes.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES ||
            received + bytes.byteLength > SpeechService.MAX_SPEECH_BYTES
          )
            return yield* new SpeechService.SpeechInvalidAudioError({
              byteLength: bytes.byteLength,
              message: "Speech stream audio limit exceeded.",
            });
          const samples = yield* decode(bytes);
          received += bytes.byteLength;
          transcription.feed(float32ToPcm16(samples));
          const text = transcription.text();
          const key = `${text.committed}\n${text.tentative}`;
          if (key === shown) return { revision, text: null };
          shown = key;
          revision += 1;
          return { revision, text };
        }),
        finish: Effect.tryPromise({
          try: () => transcription.finish(),
          catch: operationError("live transcription"),
        }).pipe(Effect.map((text) => text.trim())),
      };
    }),
  );

  return SpeechService.SpeechService.of({
    status,
    models,
    prepareModel: Effect.flatMap(usesClaude("model preparation"), (active) =>
      active ? Effect.void : speech.prepareModel,
    ),
    transcribe: Effect.fn("ConstructClaudeSpeech.transcribe")(function* (pcmBytes, options) {
      return (yield* usesClaude("transcription"))
        ? yield* transcribeWithClaude(pcmBytes)
        : yield* speech.transcribe(pcmBytes, options);
    }),
    startStream: Effect.fn("ConstructClaudeSpeech.startStream")(function* (options) {
      return (yield* usesClaude("live transcription"))
        ? yield* streamWithClaude
        : yield* speech.startStream(options);
    }),
    downloadModel: Effect.fn("ConstructClaudeSpeech.downloadModel")(function* (modelId) {
      if (modelId === CLAUDE_SPEECH_MODEL_ID) yield* selectModelId("model selection", modelId);
      else yield* speech.downloadModel(modelId);
      return yield* models(false);
    }),
    selectModel: Effect.fn("ConstructClaudeSpeech.selectModel")(function* (modelId) {
      if (modelId === CLAUDE_SPEECH_MODEL_ID) yield* selectModelId("model selection", modelId);
      else yield* speech.selectModel(modelId);
      return yield* models(false);
    }),
    cancelDownload: Effect.fn("ConstructClaudeSpeech.cancelDownload")(function* (modelId) {
      if (modelId !== CLAUDE_SPEECH_MODEL_ID) yield* speech.cancelDownload(modelId);
      return yield* models(false);
    }),
    removeModel: Effect.fn("ConstructClaudeSpeech.removeModel")(function* (modelId) {
      const active = yield* usesClaude("model removal");
      if (modelId !== CLAUDE_SPEECH_MODEL_ID) {
        yield* speech.removeModel(modelId);
        // T3 picks a replacement when it removes its fallback model; Claude stays chosen.
        if (active && !(yield* usesClaude("model removal")))
          yield* selectModelId("model removal", CLAUDE_SPEECH_MODEL_ID);
      } else if (active) {
        // Claude has nothing to delete; removing it hands dictation back to an installed model.
        const installed = (yield* speech.models(false)).models.find(
          (model) => model.state === "installed",
        );
        yield* selectModelId("model removal", installed?.id ?? DEFAULT_SPEECH_MODEL_ID);
      }
      return yield* models(false);
    }),
    updateAcceleration: Effect.fn("ConstructClaudeSpeech.updateAcceleration")(
      function* (acceleration) {
        yield* speech.updateAcceleration(acceleration);
        return yield* status;
      },
    ),
    updateModelUnloadTimeout: Effect.fn("ConstructClaudeSpeech.updateModelUnloadTimeout")(
      function* (timeout) {
        yield* speech.updateModelUnloadTimeout(timeout);
        return yield* status;
      },
    ),
  });
});

/** Wraps T3's speech service layer; servers without Claude voice input keep it unchanged. */
export const withConstructClaudeSpeech = <E, R>(
  upstream: Layer.Layer<SpeechService.SpeechService, E, R>,
) =>
  Layer.effect(
    SpeechService.SpeechService,
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const flag = (yield* HostProcess.Environment).CONSTRUCT_T3_VOICE_INPUT;
      const config = yield* ServerConfig.ServerConfig;
      if (!constructVoiceInputEnabled(flag, config.mode)) return speech;
      return yield* makeClaudeSpeech({
        speech,
        settings: yield* ServerSettings.ServerSettingsService,
        engine: claudeSpeechEngine,
        defaultToClaude: flag === "true",
      });
    }),
  ).pipe(Layer.provide(upstream));
