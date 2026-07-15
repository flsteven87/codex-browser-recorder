import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  cleanupRecordingArtifacts,
  finalizeRecordingArtifacts,
  prepareRecordingArtifacts,
  sanitizeCaptureResult,
  sanitizeRecordingFailure,
} from "./recording-artifacts.mjs";
import {
  createFfmpegSink,
  startFramePump,
} from "./screencast-recorder.mjs";
import {
  originOf,
  RECORDING_FPS,
  RECORDING_HARD_LIMIT_MS,
  RECORDING_JPEG_QUALITY,
  RECORDING_MAX_DECODED_BYTES,
  RECORDING_MAX_HEIGHT,
  RECORDING_MAX_OUTPUT_BYTES,
  RECORDING_MAX_WIDTH,
} from "./recording-policy.mjs";

const SCREENCAST_EVENT_METHODS = [
  "Page.frameNavigated",
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
];

class PocError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PocError";
    this.code = code;
  }
}

function sanitizeStartupError(error) {
  return sanitizeRecordingFailure({
    code: typeof error?.code === "string" ? error.code : "integration_failed",
  });
}

function waitForFirstFrame(ready, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new PocError(
            "frame_stream_unavailable",
            "No screencast frame arrived before the timeout",
          ),
        ),
      timeoutMs,
    );
  });

  return Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
}

async function readOutputSize(outputPath) {
  try {
    return (await stat(outputPath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function validateStartConfiguration({
  approvedOrigin,
  cdp,
  firstFrameTimeoutMs,
  fps,
  getOutputSize,
  maxDecodedBytes,
  maxDurationMs,
  maxFrameStallMs,
  maxOutputBytes,
  now,
  outputPath,
  readTimeoutMs,
  resourceCheckIntervalMs,
  signal,
  sinkFactory,
}) {
  if (
    originOf(approvedOrigin) !== approvedOrigin ||
    typeof cdp?.readEvents !== "function" ||
    typeof cdp?.send !== "function" ||
    !Number.isInteger(firstFrameTimeoutMs) ||
    firstFrameTimeoutMs <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    typeof getOutputSize !== "function" ||
    !Number.isInteger(maxDecodedBytes) ||
    maxDecodedBytes <= 0 ||
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs <= 0 ||
    (maxFrameStallMs !== null &&
      (!Number.isInteger(maxFrameStallMs) || maxFrameStallMs <= 0)) ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    typeof now !== "function" ||
    typeof outputPath !== "string" ||
    outputPath.length === 0 ||
    !Number.isInteger(readTimeoutMs) ||
    readTimeoutMs < 0 ||
    !Number.isInteger(resourceCheckIntervalMs) ||
    resourceCheckIntervalMs <= 0 ||
    (signal !== undefined &&
      (typeof signal?.addEventListener !== "function" ||
        typeof signal?.removeEventListener !== "function")) ||
    typeof sinkFactory !== "function"
  ) {
    throw new PocError(
      "invalid_configuration",
      "Browser recording configuration is invalid",
    );
  }
}

export async function startBrowserPoc({
  approvedOrigin,
  cdp,
  ffmpegPath,
  firstFrameTimeoutMs = 5000,
  fps = RECORDING_FPS,
  getOutputSize = readOutputSize,
  maxDecodedBytes = RECORDING_MAX_DECODED_BYTES,
  maxDurationMs = RECORDING_HARD_LIMIT_MS,
  maxFrameStallMs = null,
  maxOutputBytes = RECORDING_MAX_OUTPUT_BYTES,
  now = () => performance.now(),
  outputPath,
  readTimeoutMs,
  resourceCheckIntervalMs = 1000,
  signal,
  sinkFactory = createFfmpegSink,
}) {
  validateStartConfiguration({
    approvedOrigin,
    cdp,
    firstFrameTimeoutMs,
    fps,
    getOutputSize,
    maxDecodedBytes,
    maxDurationMs,
    maxFrameStallMs,
    maxOutputBytes,
    now,
    outputPath,
    readTimeoutMs,
    resourceCheckIntervalMs,
    signal,
    sinkFactory,
  });
  let startupCancellation = null;
  const startupAbortListener = () => {
    startupCancellation ??= new PocError(
      "recording_cancelled",
      "Recording was cancelled",
    );
  };
  signal?.addEventListener("abort", startupAbortListener, { once: true });
  if (signal?.aborted) startupAbortListener();

  function throwIfStartupCancelled() {
    if (startupCancellation !== null) throw startupCancellation;
  }

  async function awaitStartup(operation) {
    try {
      const result = await operation;
      throwIfStartupCancelled();
      return result;
    } catch (error) {
      throw startupCancellation ?? error;
    }
  }

  let baseline;
  let mainFrameId;
  let screencastAttempted = false;
  let sink;
  try {
    throwIfStartupCancelled();
    await awaitStartup(cdp.send("Page.enable"));
    baseline = await awaitStartup(
      cdp.readEvents({
        limit: 1,
        methods: SCREENCAST_EVENT_METHODS,
        timeoutMs: 0,
      }),
    );
    if (
      baseline === null ||
      typeof baseline !== "object" ||
      !Number.isInteger(baseline.cursor) ||
      baseline.cursor < 0
    ) {
      throw new PocError(
        "event_stream_invalid",
        "CDP event stream returned an invalid baseline",
      );
    }

    ({ frameId: mainFrameId } = await awaitStartup(
      inspectTopLevelFrame({ approvedOrigin, cdp }),
    ));
    screencastAttempted = true;
    await awaitStartup(
      cdp.send("Page.startScreencast", {
        everyNthFrame: 1,
        format: "jpeg",
        maxHeight: RECORDING_MAX_HEIGHT,
        maxWidth: RECORDING_MAX_WIDTH,
        quality: RECORDING_JPEG_QUALITY,
      }),
    );
    sink = sinkFactory({ ffmpegPath, fps, maxOutputBytes, outputPath });
    throwIfStartupCancelled();
  } catch (error) {
    if (screencastAttempted) {
      try {
        await cdp.send("Page.stopScreencast");
      } catch {
        // Preserve the bounded startup failure as primary.
      }
    }
    if (sink !== undefined) {
      try {
        await sink.stop({ discard: true });
      } catch {
        // Preserve the bounded startup failure as primary.
      }
    }
    signal?.removeEventListener("abort", startupAbortListener);
    throw startupCancellation ?? error;
  }
  let lastFrameAt = null;
  let startedAt = null;
  const pump = startFramePump({
    cdp,
    initialCursor: baseline.cursor,
    mainFrameId,
    maxDecodedBytes,
    onFrame: (frame) => {
      const frameAt = now();
      lastFrameAt = frameAt;
      const accepted = sink.accept(frame.jpeg);
      if (accepted !== false) startedAt ??= frameAt;
      return accepted;
    },
    onTopFrameNavigation(url) {
      if (originOf(url) !== approvedOrigin) {
        throw new PocError(
          "origin_changed_during_recording",
          "The recording page left the approved origin",
        );
      }
    },
    readTimeoutMs,
  });
  let stopPromise = null;
  let resolveCompletion;
  let terminationError = null;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  let resourceCheckRunning = false;
  const resourceStats = {
    elapsedMs: null,
    maxObservedOutputBytes: 0,
    terminationReason: null,
  };

  let durationTimer = null;
  void pump.ready.then(
    () => {
      if (stopPromise !== null) return;
      durationTimer = setTimeout(() => {
        terminate(
          new PocError(
            "recording_duration_limit",
            "Recording reached the configured duration limit",
          ),
        );
      }, maxDurationMs);
      durationTimer.unref?.();
    },
    () => {
      // Pump completion propagates the same failure into termination.
    },
  );

  const resourceTimer = setInterval(async () => {
    if (stopPromise !== null || resourceCheckRunning) {
      return;
    }
    resourceCheckRunning = true;
    try {
      const outputBytes = await getOutputSize(
        sink.workingOutputPath ?? outputPath,
      );
      if (!Number.isFinite(outputBytes) || outputBytes < 0) {
        throw new Error("Output size monitor returned an invalid value");
      }
      resourceStats.maxObservedOutputBytes = Math.max(
        resourceStats.maxObservedOutputBytes,
        outputBytes,
      );
      if (outputBytes > maxOutputBytes) {
        terminate(
          new PocError(
            "recording_output_limit",
            "Recording exceeded the configured output size limit",
          ),
        );
        return;
      }
      if (
        maxFrameStallMs !== null &&
        lastFrameAt !== null &&
        now() - lastFrameAt > maxFrameStallMs
      ) {
        terminate(
          new PocError(
            "frame_stream_stalled",
            "Fresh screencast frames stopped arriving",
          ),
        );
      }
    } catch (error) {
      terminate(
        error instanceof PocError
          ? error
          : new PocError(
              "output_monitor_failed",
              "Recording output could not be monitored",
            ),
      );
    } finally {
      resourceCheckRunning = false;
    }
  }, resourceCheckIntervalMs);
  resourceTimer.unref?.();

  const abortListener = () => {
    terminate(
      startupCancellation ??
        new PocError("recording_cancelled", "Recording was cancelled"),
    );
  };
  signal?.addEventListener("abort", abortListener, { once: true });
  signal?.removeEventListener("abort", startupAbortListener);
  if (startupCancellation !== null || signal?.aborted) abortListener();
  if (typeof sink.completion?.then === "function") {
    void sink.completion.then(() => {
      if (stopPromise === null) {
        terminate(
          new PocError(
            "encoder_failed",
            "FFmpeg exited before recording was stopped",
          ),
        );
      }
    });
  }
  void pump.completion.then(({ error }) => {
    if (error !== null && stopPromise === null) terminate(error);
  });

  async function finalize() {
    clearTimeout(durationTimer);
    clearInterval(resourceTimer);
    signal?.removeEventListener("abort", abortListener);
    let cleanupError = null;
    let pumpError = null;

    try {
      await cdp.send("Page.stopScreencast");
    } catch (error) {
      cleanupError = error;
    }

    try {
      await pump.stop();
    } catch (error) {
      pumpError = error;
    }

    try {
      await sink.stop({
        discard:
          cleanupError !== null ||
          pumpError !== null ||
          terminationError !== null,
      });
    } catch (error) {
      cleanupError ??= error;
    } finally {
      resourceStats.maxObservedOutputBytes = Math.max(
        resourceStats.maxObservedOutputBytes,
        sink.stats?.outputBytes ?? 0,
      );
    }

    if (terminationError !== null) {
      throw terminationError;
    }
    if (pumpError !== null) {
      throw pumpError;
    }
    if (cleanupError !== null) {
      throw cleanupError;
    }

    return {
      ...pump.stats,
      ...sink.stats,
      ...resourceStats,
      outputPath,
    };
  }

  return {
    completion,
    ready: waitForFirstFrame(pump.ready, firstFrameTimeoutMs).catch(
      async (error) => {
        terminationError ??= error;
        resourceStats.terminationReason =
          error?.code ?? "frame_stream_unavailable";
        try {
          await stop();
        } catch {
          // Preserve the readiness failure as the primary error.
        }
        throw error;
      },
    ),
    stats: {
      framePump: pump.stats,
      resources: resourceStats,
      sink: sink.stats,
    },
    stop,
  };

  function stop() {
    if (stopPromise === null) {
      const stoppedAt = now();
      resourceStats.elapsedMs =
        startedAt === null ? null : Math.max(0, stoppedAt - startedAt);
      stopPromise = finalize();
      void stopPromise.then(
        (result) => resolveCompletion({ error: null, result }),
        (error) => resolveCompletion({ error, result: null }),
      );
    }
    return stopPromise;
  }

  function terminate(error) {
    if (terminationError === null && stopPromise === null) {
      terminationError = error;
      resourceStats.terminationReason = error.code;
      void stop().catch(() => {
        // The caller observes the same failure through session.stop().
      });
    }
  }
}

export async function inspectTopLevelFrame({ approvedOrigin, cdp }) {
  if (
    typeof cdp?.send !== "function" ||
    originOf(approvedOrigin) !== approvedOrigin
  ) {
    throw new PocError(
      "invalid_configuration",
      "Top-level origin verification configuration is invalid",
    );
  }

  let frameTree;
  try {
    frameTree = await cdp.send("Page.getFrameTree");
  } catch {
    throw new PocError(
      "origin_verification_failed",
      "The recording page origin could not be verified",
    );
  }

  const frame = frameTree?.frameTree?.frame;
  if (
    typeof frame?.id !== "string" ||
    frame.id.length === 0 ||
    originOf(frame.url) !== approvedOrigin
  ) {
    throw new PocError(
      originOf(frame?.url) === null
        ? "origin_verification_failed"
        : "origin_not_allowed",
      "The recording page is outside the approved origin",
    );
  }
  return { frameId: frame.id };
}

export async function startBrowserPocForTab({
  approvedOrigin,
  tab,
  ...options
}) {
  if (typeof tab?.capabilities?.get !== "function") {
    throw new PocError(
      "cdp_unavailable",
      "The selected Browser tab does not expose capabilities",
    );
  }

  const cdp = await tab.capabilities.get("cdp");
  if (
    typeof cdp?.readEvents !== "function" ||
    typeof cdp?.send !== "function"
  ) {
    throw new PocError(
      "cdp_unavailable",
      "Full CDP access is unavailable for the selected Browser tab",
    );
  }

  return startBrowserPoc({ ...options, approvedOrigin, cdp });
}

export async function createBrowserRecording({
  _dependencies = {
    cleanupRecordingArtifacts,
    finalizeRecordingArtifacts,
    prepareRecordingArtifacts,
    startBrowserPocForTab,
  },
  _onTerminal,
  approvedOrigin,
  durationToleranceSeconds = 5,
  ffmpegPath,
  ffprobePath,
  firstFrameTimeoutMs = 5000,
  fps = RECORDING_FPS,
  maxDecodedBytes = RECORDING_MAX_DECODED_BYTES,
  maxDurationMs = RECORDING_HARD_LIMIT_MS,
  maxFrameStallMs = 5000,
  maxHeight = RECORDING_MAX_HEIGHT,
  maxOutputBytes = RECORDING_MAX_OUTPUT_BYTES,
  maxWidth = RECORDING_MAX_WIDTH,
  minBytes = 100,
  readTimeoutMs = 1000,
  resourceCheckIntervalMs = 1000,
  signal,
  tab,
  temporaryRoot = tmpdir(),
}) {
  const paths = await _dependencies.prepareRecordingArtifacts({
    temporaryRoot,
  });
  let session;
  try {
    session = await _dependencies.startBrowserPocForTab({
      approvedOrigin,
      ffmpegPath,
      firstFrameTimeoutMs,
      fps,
      maxDecodedBytes,
      maxDurationMs,
      maxFrameStallMs,
      maxOutputBytes,
      outputPath: paths.outputPath,
      readTimeoutMs,
      resourceCheckIntervalMs,
      signal,
      tab,
    });
  } catch (error) {
    try {
      await _dependencies.cleanupRecordingArtifacts(paths);
    } catch {
      // Preserve the bounded startup failure as the primary error.
    }
    throw sanitizeStartupError(error);
  }

  let finalizationPromise = null;
  let readinessError = null;
  let rejectCompletion;
  let resolveCompletion;
  let state = "recording";
  let terminalNotified = false;
  const completion = new Promise((resolve, reject) => {
    rejectCompletion = reject;
    resolveCompletion = resolve;
  });
  void completion.catch(() => {});
  const ready = Promise.resolve(session.ready).catch((error) => {
    readinessError = error;
    state = "failed";
    throw error;
  });
  function notifyTerminal() {
    if (terminalNotified) return;
    terminalNotified = true;
    try {
      _onTerminal?.();
    } catch {
      // Internal lifecycle notification must not replace finalization.
    }
  }

  if (typeof session.completion?.then === "function") {
    void session.completion.then(
      (outcome) => {
        if (outcome?.error) {
          readinessError ??= outcome.error;
          state = "failed";
        } else if (state === "recording") {
          state = "stopping";
        }
        void stop().then(notifyTerminal, notifyTerminal);
      },
      (error) => {
        readinessError ??= error;
        state = "failed";
        void stop().then(notifyTerminal, notifyTerminal);
      },
    );
  }

  function status() {
    return {
      capture: sanitizeCaptureResult({
        ...session.stats?.framePump,
        ...session.stats?.resources,
        ...session.stats?.sink,
      }),
      state,
    };
  }

  function stop() {
    if (finalizationPromise !== null) return finalizationPromise;
    if (state !== "failed") state = "stopping";

    finalizationPromise = _dependencies
      .finalizeRecordingArtifacts({
        captureError: readinessError,
        durationToleranceSeconds,
        ffprobePath,
        maxHeight,
        maxWidth,
        minBytes,
        outputPath: paths.outputPath,
        resultPath: paths.resultPath,
        session,
      })
      .then(
        (result) => {
          state = result.status === "passed" ? "completed" : "failed";
          return { paths, result };
        },
        (error) => {
          state = "failed";
          throw error;
        },
      );
    void finalizationPromise.then(resolveCompletion, rejectCompletion);
    return finalizationPromise;
  }

  return { completion, ready, status, stop };
}

function createRecordingWindow(durationMs, signal) {
  let timer;
  const abortListener = () => {
    clearTimeout(timer);
    rejectWindow(
      new PocError("recording_cancelled", "Recording was cancelled"),
    );
  };
  let rejectWindow;
  const promise = new Promise((resolve, reject) => {
    rejectWindow = reject;
    timer = setTimeout(resolve, durationMs);
    signal?.addEventListener("abort", abortListener, { once: true });
  });
  return {
    cancel() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
    },
    promise,
  };
}

function emptyCaptureSession() {
  const result = {
    backpressureDrops: 0,
    elapsedMs: 0,
    encoderExitCode: null,
    framesAcknowledged: 0,
    framesDropped: 0,
    framesReceived: 0,
    invalidFrames: 0,
    lastFrameTimestamp: null,
    maxObservedOutputBytes: 0,
    outputSamples: 0,
    terminationReason: null,
    truncations: 0,
    visibilityChanges: 0,
    visibilityState: null,
  };
  return {
    stats: {},
    async stop() {
      return result;
    },
  };
}

/**
 * Historical Phase 0 end-to-end regression harness.
 *
 * The installed skill uses createExampleRecording(); this helper remains only
 * to preserve the original complete capture-window regression coverage.
 */
export async function runBrowserPocGate({
  durationToleranceSeconds,
  ffmpegPath,
  ffprobePath,
  fps,
  maxDecodedBytes,
  maxHeight,
  maxWidth,
  minBytes,
  recordingDurationMs,
  signal,
  tab,
  temporaryRoot,
  ...recordingOptions
}) {
  if (!Number.isInteger(recordingDurationMs) || recordingDurationMs <= 0) {
    throw new PocError(
      "invalid_configuration",
      "Recording gate duration is invalid",
    );
  }

  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  let captureError = null;
  let session;
  try {
    session = await startBrowserPocForTab({
      ...recordingOptions,
      ffmpegPath,
      fps,
      maxDecodedBytes,
      outputPath: paths.outputPath,
      signal,
      tab,
    });
    await session.ready;
    const recordingWindow = createRecordingWindow(recordingDurationMs, signal);
    let outcome;
    try {
      outcome = await Promise.race([
        recordingWindow.promise.then(() => null),
        session.completion,
      ]);
    } finally {
      recordingWindow.cancel();
    }
    if (outcome?.error) {
      throw outcome.error;
    }
  } catch (error) {
    captureError = error;
    session ??= emptyCaptureSession();
  }

  const result = await finalizeRecordingArtifacts({
    captureError,
    durationToleranceSeconds,
    ffprobePath,
    maxHeight,
    maxWidth,
    minBytes,
    outputPath: paths.outputPath,
    resultPath: paths.resultPath,
    session,
  });
  return { paths, result };
}
