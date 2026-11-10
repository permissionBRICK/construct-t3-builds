import { it } from "@effect/vitest";
import {
  CLAUDE_SPEECH_MODEL_ID,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import {
  float32ToPcm16,
  makeClaudeSpeech,
  type ClaudeSpeechEngine,
} from "./constructClaudeSpeech.ts";
import * as SpeechService from "./SpeechService.ts";

const LOCAL = "local/whisper";
const OTHER = "local/parakeet";

function upstreamModel(id: string, installed: boolean, selected: string): EnvironmentSpeechModel {
  return {
    id,
    name: id,
    description: "",
    size: 1,
    languages: ["en"],
    accuracy: 1,
    speed: 1,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: false,
    active: installed && selected === id,
    state: installed ? "installed" : "downloadable",
  };
}

/** T3's service over in-memory settings: unknown ids fall back to `LOCAL`, as T3's do. */
function setup(input: { readonly selected: string; readonly installed: ReadonlyArray<string> }) {
  let settings: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, speechModelId: input.selected };
  const installed = new Set(input.installed);
  const calls: string[] = [];
  const fallback = () =>
    [LOCAL, OTHER].includes(settings.speechModelId) ? settings.speechModelId : LOCAL;
  const list = Effect.sync(() => ({
    models: [LOCAL, OTHER].map((id) => upstreamModel(id, installed.has(id), fallback())),
  }));
  const speech = SpeechService.SpeechService.of({
    status: Effect.sync(() => ({
      supported: true as const,
      state: installed.has(fallback()) ? ("ready" as const) : ("missing-model" as const),
      modelId: fallback(),
      model: fallback(),
      size: 1,
      supportsStreaming: false,
      supportsTranslation: false,
      acceleration: "auto" as const,
      benchmarkTier: "cpu" as const,
      modelUnloadTimeout: "never" as const,
      gpuDevices: [],
    })),
    models: () => list,
    downloadModel: (modelId) =>
      Effect.sync(() => installed.add(modelId)).pipe(Effect.andThen(list)),
    selectModel: (modelId) =>
      Effect.sync(() => {
        settings = { ...settings, speechModelId: modelId };
      }).pipe(Effect.andThen(list)),
    cancelDownload: () => list,
    removeModel: (modelId) =>
      Effect.sync(() => {
        installed.delete(modelId);
        if (fallback() === modelId) settings = { ...settings, speechModelId: OTHER };
      }).pipe(Effect.andThen(list)),
    prepareModel: Effect.sync(() => void calls.push("prepare")),
    transcribe: () => Effect.sync(() => (calls.push("local transcribe"), "local text")),
    startStream: () =>
      Effect.sync(() => {
        calls.push("local stream");
        return { feed: () => Effect.die("unused"), finish: Effect.succeed("local text") };
      }),
    updateAcceleration: () => Effect.die("unused"),
    updateModelUnloadTimeout: () => Effect.die("unused"),
  });
  const fed: Uint8Array[] = [];
  const engine: ClaudeSpeechEngine = {
    language: () => "de",
    start: () => ({
      feed: (chunk) => void fed.push(chunk),
      text: () => ({ committed: "Hallo", tentative: fed.length > 1 ? "Welt" : "" }),
      finish: async () => " Hallo Welt ",
      cancel: () => void calls.push("claude cancel"),
    }),
    transcribe: async (pcm) => {
      fed.push(pcm);
      return " Hallo Welt. ";
    },
  };
  const settingsService: Parameters<typeof makeClaudeSpeech>[0]["settings"] = {
    getSettings: Effect.sync(() => settings),
    updateSettings: (patch) =>
      Effect.sync(() => {
        if (patch.speechModelId !== undefined)
          settings = { ...settings, speechModelId: patch.speechModelId };
        return settings;
      }),
  };
  return {
    calls,
    fed,
    selected: () => settings.speechModelId,
    make: (defaultToClaude: boolean) =>
      makeClaudeSpeech({ speech, settings: settingsService, engine, defaultToClaude }),
  };
}

const modelIdOf = (status: EnvironmentSpeechStatus) => (status.supported ? status.modelId : null);
const float32 = (...samples: number[]) => new Uint8Array(new Float32Array(samples).buffer);
const active = (models: { readonly models: ReadonlyArray<EnvironmentSpeechModel> }) =>
  models.models.filter((model) => model.active).map((model) => model.id);

it("converts T3's Float32 PCM to the S16LE the voice service reads", () => {
  const pcm = float32ToPcm16(new Float32Array([-1, 0, 1, 0.5, 2]));
  const view = new DataView(pcm.buffer);
  expect([0, 2, 4, 6, 8].map((offset) => view.getInt16(offset, true))).toEqual([
    -32_768, 0, 32_767, 16_384, 32_767,
  ]);
});

it.effect("lists Claude as an installed model that replaces T3's selection while chosen", () =>
  Effect.gen(function* () {
    const fixture = setup({ selected: LOCAL, installed: [LOCAL] });
    const speech = yield* fixture.make(false);

    const before = yield* speech.models(false);
    expect(before.models[0]).toMatchObject({
      id: CLAUDE_SPEECH_MODEL_ID,
      name: "Claude",
      state: "installed",
      supportsStreaming: true,
      languages: ["de"],
      active: false,
    });
    expect(active(before)).toEqual([LOCAL]);

    expect(active(yield* speech.selectModel(CLAUDE_SPEECH_MODEL_ID))).toEqual([
      CLAUDE_SPEECH_MODEL_ID,
    ]);
    expect(yield* speech.status).toMatchObject({
      supported: true,
      state: "ready",
      modelId: CLAUDE_SPEECH_MODEL_ID,
      supportsStreaming: true,
    });
    yield* speech.prepareModel;
    expect(fixture.calls).toEqual([]);

    expect(active(yield* speech.selectModel(LOCAL))).toEqual([LOCAL]);
    expect(modelIdOf(yield* speech.status)).toBe(LOCAL);
  }),
);

it.effect(
  "keeps Claude chosen through T3's fallback, and removing it hands back to an installed model",
  () =>
    Effect.gen(function* () {
      const fixture = setup({ selected: CLAUDE_SPEECH_MODEL_ID, installed: [LOCAL, OTHER] });
      const speech = yield* fixture.make(false);

      // T3 falls back to LOCAL for an id it does not know and replaces it when it is removed.
      yield* speech.removeModel(LOCAL);
      expect(fixture.selected()).toBe(CLAUDE_SPEECH_MODEL_ID);

      expect(active(yield* speech.removeModel(CLAUDE_SPEECH_MODEL_ID))).toEqual([OTHER]);
      expect(fixture.selected()).toBe(OTHER);
    }),
);

it.effect("makes Claude a VM's model only while no installed model is selected", () =>
  Effect.gen(function* () {
    const empty = setup({ selected: LOCAL, installed: [] });
    expect(modelIdOf(yield* (yield* empty.make(true)).status)).toBe(CLAUDE_SPEECH_MODEL_ID);

    const local = setup({ selected: LOCAL, installed: [LOCAL] });
    expect(modelIdOf(yield* (yield* local.make(true)).status)).toBe(LOCAL);

    const desktop = setup({ selected: LOCAL, installed: [] });
    expect(modelIdOf(yield* (yield* desktop.make(false)).status)).toBe(LOCAL);
  }),
);

it.effect("transcribes recordings and T3's live stream with Claude only while it is chosen", () =>
  Effect.gen(function* () {
    const fixture = setup({ selected: LOCAL, installed: [LOCAL] });
    const speech = yield* fixture.make(false);
    const options = DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS;

    expect(yield* speech.transcribe(float32(0.5), options)).toBe("local text");
    yield* speech.selectModel(CLAUDE_SPEECH_MODEL_ID);
    expect(yield* speech.transcribe(float32(0.5, -0.5), options)).toBe("Hallo Welt.");
    expect([...fixture.fed[0]!]).toEqual([0x00, 0x40, 0x00, 0xc0]);

    const scope = yield* Scope.make();
    const stream = yield* speech.startStream(options).pipe(Scope.provide(scope));
    expect(yield* stream.feed(float32(0.1))).toEqual({
      revision: 1,
      text: { committed: "Hallo", tentative: "Welt" },
    });
    expect(yield* stream.feed(float32(0.1))).toEqual({ revision: 1, text: null });
    expect(yield* stream.finish).toBe("Hallo Welt");
    yield* Scope.close(scope, Exit.void);
    expect(fixture.calls).toEqual(["local transcribe", "claude cancel"]);

    const invalid = yield* speech.transcribe(float32(2), options).pipe(Effect.flip);
    expect(invalid).toBeInstanceOf(SpeechService.SpeechInvalidAudioError);
  }),
);
