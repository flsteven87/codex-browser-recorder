import { createBrowserRecording } from "./run-browser-recording.mjs";

export const EXAMPLE_PAGE_URL = "https://example.com/";
export const EXAMPLE_RECORDING_MAX_DURATION_MS = 20_000;

const ACTIVE_RECORDING_KEY = Symbol.for("codex-browser-recorder.active");

function recordingAlreadyActiveError() {
  return Object.assign(new Error("A recording is already active"), {
    code: "recording_already_active",
  });
}

export async function createExampleRecording({
  _dependencies = { createBrowserRecording },
  ffmpegPath,
  ffprobePath,
  signal,
  tab,
  temporaryRoot,
}) {
  if (globalThis[ACTIVE_RECORDING_KEY] != null) {
    throw recordingAlreadyActiveError();
  }

  const inner = await _dependencies.createBrowserRecording({
    expectedTopLevelUrl: EXAMPLE_PAGE_URL,
    ffmpegPath,
    ffprobePath,
    fps: 10,
    maxDecodedBytes: 5 * 1024 * 1024,
    maxDurationMs: EXAMPLE_RECORDING_MAX_DURATION_MS,
    maxFrameStallMs: 5_000,
    maxHeight: 720,
    maxOutputBytes: 500 * 1024 * 1024,
    maxWidth: 1280,
    signal,
    tab,
    temporaryRoot,
  });

  let stopPromise = null;
  const handle = {
    ready: inner.ready,
    status() {
      return inner.status();
    },
    stop() {
      stopPromise ??= Promise.resolve()
        .then(() => inner.stop())
        .finally(() => {
          if (globalThis[ACTIVE_RECORDING_KEY] === handle) {
            delete globalThis[ACTIVE_RECORDING_KEY];
          }
        });
      return stopPromise;
    },
  };

  globalThis[ACTIVE_RECORDING_KEY] = handle;
  void Promise.resolve(handle.ready)
    .catch(() => handle.stop())
    .catch(() => {
      // The caller observes readiness and finalization failures separately.
    });
  return handle;
}
