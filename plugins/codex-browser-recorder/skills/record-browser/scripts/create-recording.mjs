import { createBrowserRecording } from "./run-browser-recording.mjs";
import {
  describeRecordingFailure,
  sanitizeRecordingFailure,
} from "./recording-artifacts.mjs";
import {
  RECORDING_HARD_LIMIT_MS,
  validateRecordingRequest,
} from "./recording-policy.mjs";

export { describeRecordingFailure };

const ACTIVE_RECORDING_KEY = Symbol.for("codex-browser-recorder.active");
const TERMINAL_STATES = new Set(["cancelled", "completed", "failed"]);

function stateForFailureCode(code) {
  return ["cancelled", "recording_cancelled"].includes(code)
    ? "cancelled"
    : "failed";
}

export function createRecording(options) {
  const dependencies = options?._dependencies ?? {
    clock: { clearTimeout, setTimeout },
    createBrowserRecording,
  };
  let state = "preparing";
  let inner;
  let durationTimer;
  let stopPromise;
  let terminal = false;
  const reservation = {};

  if (globalThis[ACTIVE_RECORDING_KEY] != null) {
    const error = sanitizeRecordingFailure({
      code: "recording_already_active",
    });
    const failure = Promise.reject(error);
    void failure.catch(() => {});
    return {
      ready: failure,
      status: () => ({ capture: null, state: "failed" }),
      stop: () => failure,
    };
  }
  globalThis[ACTIVE_RECORDING_KEY] = reservation;

  let handle;
  let ready;

  function release() {
    if (
      globalThis[ACTIVE_RECORDING_KEY] === reservation ||
      globalThis[ACTIVE_RECORDING_KEY] === handle
    ) {
      delete globalThis[ACTIVE_RECORDING_KEY];
    }
  }

  function setTerminalState(output) {
    dependencies.clock.clearTimeout(durationTimer);
    if (terminal) return;
    terminal = true;
    state =
      output?.result?.status === "passed"
        ? "completed"
        : stateForFailureCode(output?.result?.failureCode);
    release();
  }

  function setTerminalFailure(error) {
    dependencies.clock.clearTimeout(durationTimer);
    if (terminal) return;
    terminal = true;
    state = stateForFailureCode(error?.code);
    release();
  }

  function status() {
    return { capture: inner?.status().capture ?? null, state };
  }

  function stop() {
    stopPromise ??= ready
      .then(async () => {
        dependencies.clock.clearTimeout(durationTimer);
        if (!TERMINAL_STATES.has(state)) state = "stopping";
        try {
          const output = await inner.stop();
          setTerminalState(output);
          return output;
        } catch (error) {
          const publicError = sanitizeRecordingFailure(error);
          setTerminalFailure(publicError);
          throw publicError;
        }
      })
      .finally(release);
    void stopPromise.catch(() => {});
    return stopPromise;
  }

  ready = Promise.resolve()
    .then(async () => {
      const request = validateRecordingRequest(options);
      inner = await dependencies.createBrowserRecording({
        approvedOrigin: request.approvedOrigin,
        ffmpegPath: options.ffmpegPath,
        ffprobePath: options.ffprobePath,
        maxDurationMs: RECORDING_HARD_LIMIT_MS,
        signal: options.signal,
        tab: options.tab,
        temporaryRoot: options.temporaryRoot,
      });
      state = "awaiting_frame";
      void inner.completion.then(
        setTerminalState,
        (error) => setTerminalFailure(error),
      );
      await inner.ready;
      if (terminal) return true;
      state = "recording";
      durationTimer = dependencies.clock.setTimeout(() => {
        void stop().catch(() => {});
      }, request.durationMs);
      return true;
    })
    .catch(async (error) => {
      dependencies.clock.clearTimeout(durationTimer);
      if (inner != null) {
        try {
          await inner.stop();
        } catch {
          // Preserve the bounded readiness failure after cleanup completes.
        }
      }
      const publicError = sanitizeRecordingFailure(error);
      setTerminalFailure(publicError);
      release();
      throw publicError;
    });
  void ready.catch(() => {});

  handle = { ready, status, stop };
  globalThis[ACTIVE_RECORDING_KEY] = handle;
  return handle;
}
