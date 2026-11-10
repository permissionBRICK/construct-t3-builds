// T3's own composer controls (microphone button, recording pill, dictation shortcut) drive
// the Claude session through Construct's speech-input wrapper. Only the voiceInput RPCs,
// the microphone and the stores are faked; the composer is a plain textarea.
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import {
  ComposerSpeechButton,
  ComposerSpeechRecordingPill,
} from "../components/chat/ComposerSpeechButton";
import { useDictationShortcut } from "../speech/useDictationShortcut";
import { chooseAudioDestination } from "../speech/voiceConsent";
import { useEnvironmentSpeechInput } from "./constructSpeechInput";

type VoiceEvent =
  | { type: "listening" }
  | { type: "level"; value: number }
  | { type: "transcript"; text: string }
  | { type: "stopped"; reason: string };

const rpc = vi.hoisted(() => ({
  capabilities: {
    voiceInput: true,
    voiceInputClientAudio: true,
    voiceInputDefault: true,
  } as Record<string, boolean>,
  starts: [] as Array<{ environmentId: string; resume: boolean }>,
  stops: 0,
  holdFinal: false,
  emit: (_event: VoiceEvent) => {},
  endStream: () => {},
  audio: () => {},
  capturing: false,
  toasts: [] as unknown[],
}));

vi.mock("../speech/useEnvironmentSpeechInput", () => ({
  useEnvironmentSpeechInput: () => ({
    available: false,
    status: null,
    transcriptionEnvironmentId: null,
    transcriptionEnvironmentLabel: null,
    setup: { open: false },
    state: { phase: "idle", error: null, errorAction: null },
    preview: null,
    level: 0,
    preparing: false,
    blocksSubmission: false,
    freezesEditor: true,
    start: async () => {},
    submitAfterDictation: () => {},
    stop: async () => {},
    cancel: () => {},
    skipPostProcessing: () => {},
  }),
}));
vi.mock("../state/entities", () => ({
  useServerConfigs: () =>
    new Map([["vm", { environment: { label: "dev-vm", capabilities: rpc.capabilities } }]]),
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, unknown>) => unknown) =>
    select({ voiceInputSource: "client", voiceMicrophone: "", voiceShortcutMode: "auto" }),
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: (t: unknown) => rpc.toasts.push(t) },
}));
vi.mock("../state/voiceInput", () => ({
  startVoiceInput: { label: "start" },
  stopVoiceInput: { label: "stop" },
  sendVoiceAudio: { label: "audio" },
}));
vi.mock("../state/use-atom-command", () => {
  const commands = {
    start: (target: {
      environmentId: string;
      resume: boolean;
      onEvent: (event: VoiceEvent) => void;
    }) => {
      rpc.starts.push({ environmentId: target.environmentId, resume: target.resume });
      rpc.emit = target.onEvent;
      return new Promise((resolve) => {
        rpc.endStream = () => resolve(AsyncResult.success(undefined));
      });
    },
    stop: async () => {
      rpc.stops += 1;
      if (!rpc.holdFinal) {
        rpc.emit({ type: "stopped", reason: "user-stop" });
        rpc.endStream();
      }
      return AsyncResult.success({ stopped: true });
    },
    audio: async ({ chunk }: { chunk: Uint8Array }) =>
      AsyncResult.success({ accepted: true, nextSequence: chunk.length }),
  };
  return { useAtomCommand: (command: { label: keyof typeof commands }) => commands[command.label] };
});
vi.mock("./clientAudioCapture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clientAudioCapture")>()),
  canCaptureClientAudio: () => true,
  isSecureContext: () => true,
  startClientAudioCapture: ({ onChunk }: { onChunk: (chunk: Uint8Array) => void }) => {
    rpc.capturing = true;
    rpc.audio = () => onChunk(new Uint8Array(3200));
    return {
      stop: () => {
        rpc.capturing = false;
      },
      finish: async () => {
        rpc.capturing = false;
      },
    };
  },
}));

const AUDIO_KEY = "t3code:voice-audio-grant:v1";
const sends: string[] = [];

function Composer() {
  const [draft, setDraft] = useState("hello world");
  const promptRef = useRef(draft);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const speech = useEnvironmentSpeechInput({
    environmentId: "vm" as never,
    ownerKey: "thread",
    draftText: draft,
    disabled: false,
    readDraft: () => ({ text: draft, selection: { start: 0, end: 0 } }),
    commitDraft: () => {},
    construct: {
      promptRef,
      pendingAnswer: null,
      readComposerSnapshot: () => ({
        value: promptRef.current,
        expandedCursor: textarea.current?.selectionStart ?? 0,
      }),
      applyPromptReplacement: (start, end, replacement, { expectedText }) => {
        const current = promptRef.current;
        if (current.slice(start, end) !== expectedText) return false;
        promptRef.current = current.slice(0, start) + replacement + current.slice(end);
        setDraft(promptRef.current);
        return true;
      },
    },
  });
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  const submit = () => {
    if (speech.blocksSubmission) speech.submitAfterDictation(() => sends.push(promptRef.current));
    else sends.push(promptRef.current);
  };
  return (
    <form data-chat-composer-form="true">
      <textarea
        ref={textarea}
        aria-label="Composer"
        value={draft}
        disabled={speech.freezesEditor}
        onChange={(event) => {
          promptRef.current = event.target.value;
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          submit();
        }}
      />
      <output data-testid="phase">{speech.state.phase}</output>
      {speech.available ? (
        <>
          <ComposerSpeechRecordingPill
            state={speech.state}
            progress={null}
            level={speech.level}
            onStart={() => void speech.start()}
            onStop={() => void speech.stop()}
            onCancel={() => speech.cancel()}
            onSkipPostProcessing={() => speech.skipPostProcessing()}
          />
          <ComposerSpeechButton
            state={speech.state}
            progress={null}
            onStart={() => void speech.start()}
            onCancel={() => speech.cancel()}
          />
        </>
      ) : null}
    </form>
  );
}

/** A fresh device and fake server for one test; the stored voice choice goes with it. */
function freshDevice(capabilities: Record<string, boolean> = {}) {
  window.localStorage.clear();
  Object.assign(rpc, {
    capabilities: {
      voiceInput: true,
      voiceInputClientAudio: true,
      voiceInputDefault: true,
      ...capabilities,
    },
    starts: [],
    stops: 0,
    holdFinal: false,
    toasts: [],
  });
  sends.length = 0;
  // performance.now() measures how long the shortcut is held; tests advance it.
  const realNow = performance.now.bind(performance);
  let offset = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
  return {
    advance: (ms: number) => {
      offset += ms;
    },
    [Symbol.dispose]: () => {
      now.mockRestore();
      window.localStorage.clear();
    },
  };
}

const phase = (value: string) =>
  expect.poll(() => page.getByTestId("phase").element().textContent).toBe(value);
const draft = () => (page.getByLabelText("Composer").element() as HTMLTextAreaElement).value;
const placeCursor = (at: number) => {
  const element = page.getByLabelText("Composer").element() as HTMLTextAreaElement;
  element.focus();
  element.setSelectionRange(at, at);
};
const key = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
  page
    .getByLabelText("Composer")
    .element()
    .dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));

async function startLive() {
  await page.getByRole("button", { name: "Start voice input" }).click();
  await phase("preparing");
  rpc.emit({ type: "listening" });
  rpc.audio();
  await phase("recording");
}

it("chooses Claude on a connected Construct VM once, and never over another choice", async () => {
  using _device = freshDevice();
  await using screen = await render(<Composer />);
  await expect
    .poll(() => JSON.parse(window.localStorage.getItem(AUDIO_KEY) ?? "null"))
    .toMatchObject({
      destination: { kind: "claude-code", environmentId: "vm" },
    });
  await expect.element(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
  chooseAudioDestination(null);
  await screen.rerender(<Composer />);
  await expect
    .element(page.getByRole("button", { name: "Start voice input" }))
    .not.toBeInTheDocument();
  expect(window.localStorage.getItem(AUDIO_KEY)).toBe('"off"');
});

it("leaves a device without a Construct VM undecided", async () => {
  using _device = freshDevice({ voiceInputDefault: false });
  await using _screen = await render(<Composer />);
  // render() returns after effects ran, so a default would already be stored.
  expect(window.localStorage.getItem(AUDIO_KEY)).toBeNull();
});

it("streams the transcript into the editable draft at the cursor and stops with T3's pill", async () => {
  using _device = freshDevice();
  await using _screen = await render(<Composer />);
  placeCursor(5);
  await startLive();
  expect(rpc.starts).toEqual([{ environmentId: "vm", resume: false }]);
  rpc.emit({ type: "transcript", text: "spoken" });
  await expect.poll(draft).toBe("hello spoken world");
  rpc.emit({ type: "transcript", text: "spoken words" });
  await expect.poll(draft).toBe("hello spoken words world");
  expect(page.getByLabelText("Composer").element().hasAttribute("disabled")).toBe(false);
  await page.getByRole("button", { name: "Finish voice input" }).click();
  await phase("idle");
  expect(rpc.stops).toBe(1);
  expect(rpc.capturing).toBe(false);
  expect(sends).toEqual([]);
});

it("toggles with Alt+Q, stops a held Alt+Q on release, and leaves AltGr+Q alone", async () => {
  using device = freshDevice();
  await using _screen = await render(<Composer />);
  placeCursor(11);
  key("keydown", { key: "q", code: "KeyQ", altKey: true });
  await phase("preparing");
  key("keyup", { key: "q", code: "KeyQ" });
  rpc.emit({ type: "listening" });
  rpc.audio();
  await phase("recording");
  key("keydown", { key: "q", code: "KeyQ", altKey: true });
  await phase("idle");
  expect(rpc.stops).toBe(1);

  key("keydown", { key: "q", code: "KeyQ", altKey: true });
  await phase("preparing");
  device.advance(350);
  key("keyup", { key: "q", code: "KeyQ" });
  await phase("idle");
  expect(rpc.stops).toBe(2);

  const typed = key("keydown", {
    key: "@",
    code: "KeyQ",
    altKey: true,
    ctrlKey: true,
    modifierAltGraph: true,
  } as KeyboardEventInit);
  // T3's shortcut prevents the default of a key it handles; "@" is typed as usual.
  expect(typed).toBe(true);
});

it("sends once, after the final transcript, when Enter is pressed while recording", async () => {
  using _device = freshDevice();
  await using _screen = await render(<Composer />);
  placeCursor(11);
  await startLive();
  rpc.emit({ type: "transcript", text: "first" });
  await expect.poll(draft).toBe("hello world first");
  rpc.holdFinal = true;
  key("keydown", { key: "Enter", code: "Enter" });
  await phase("transcribing");
  key("keydown", { key: "Enter", code: "Enter" });
  expect(rpc.stops).toBe(1);
  expect(sends).toEqual([]);
  rpc.emit({ type: "transcript", text: "first words, final" });
  rpc.emit({ type: "stopped", reason: "user-stop" });
  rpc.endStream();
  await expect.poll(() => sends).toEqual(["hello world first words, final"]);
  await phase("idle");
  rpc.emit({ type: "stopped", reason: "user-stop" });
  expect(sends).toHaveLength(1);
});

it("cancels with Escape, keeping the text already written and sending nothing", async () => {
  using _device = freshDevice();
  await using _screen = await render(<Composer />);
  placeCursor(11);
  await startLive();
  rpc.emit({ type: "transcript", text: "kept" });
  await expect.poll(draft).toBe("hello world kept");
  rpc.holdFinal = true;
  key("keydown", { key: "Escape", code: "Escape" });
  await phase("idle");
  expect(rpc.stops).toBe(1);
  expect(rpc.capturing).toBe(false);
  rpc.emit({ type: "transcript", text: "late words" });
  expect(draft()).toBe("hello world kept");
  expect(sends).toEqual([]);
});
