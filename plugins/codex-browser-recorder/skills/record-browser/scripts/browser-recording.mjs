import { stat } from "node:fs/promises";
import {
  createFfmpegSink,
  parseScreencastFrame,
  startFramePump,
} from "./media-recorder.mjs";
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

class BrowserRecordingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserRecordingError";
    this.code = code;
  }
}

function cancellationFailure() {
  return new BrowserRecordingError(
    "recording_cancelled",
    "Recording was cancelled",
  );
}

function awaitAbortable(operation, signal, onLateSuccess) {
  const operationPromise = Promise.resolve(operation);
  if (signal === undefined) return operationPromise;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishLateSuccess = (value) => {
      if (typeof onLateSuccess !== "function") return;
      void Promise.resolve(onLateSuccess(value)).catch(() => {});
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      operationPromise.then(finishLateSuccess, () => {});
      reject(cancellationFailure());
    };

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operationPromise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function createFirstFrameDeadline(timeoutMs) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new BrowserRecordingError(
            "frame_stream_unavailable",
            "No screencast frame arrived before the timeout",
          ),
        ),
      timeoutMs,
    );
  });

  return {
    clear() {
      clearTimeout(timer);
    },
    promise,
  };
}

async function captureInitialPageFrame({ cdp, maxDecodedBytes, signal }) {
  try {
    const screenshot = await awaitAbortable(
      cdp.send("Page.captureScreenshot", {
        captureBeyondViewport: false,
        format: "jpeg",
        fromSurface: true,
        quality: RECORDING_JPEG_QUALITY,
      }),
      signal,
    );
    return parseScreencastFrame(
      {
        method: "Page.screencastFrame",
        params: {
          data: screenshot?.data,
          metadata: {},
          sessionId: 0,
        },
      },
      maxDecodedBytes,
    ).jpeg;
  } catch (error) {
    if (error?.code === "recording_cancelled") throw error;
    throw new BrowserRecordingError(
      "frame_stream_unavailable",
      "The initial page frame could not be captured",
    );
  }
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
    throw new BrowserRecordingError(
      "invalid_configuration",
      "Browser recording configuration is invalid",
    );
  }
}

export async function startBrowserRecording({
  approvedOrigin,
  cdp,
  ffmpegPath,
  firstFrameTimeoutMs = 5000,
  fps = RECORDING_FPS,
  getOutputSize = readOutputSize,
  maxDecodedBytes = RECORDING_MAX_DECODED_BYTES,
  maxDurationMs = RECORDING_HARD_LIMIT_MS,
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
    startupCancellation ??= new BrowserRecordingError(
      "recording_cancelled",
      "Recording was cancelled",
    );
  };
  signal?.addEventListener("abort", startupAbortListener, { once: true });
  if (signal?.aborted) startupAbortListener();

  function throwIfStartupCancelled() {
    if (startupCancellation !== null) throw startupCancellation;
  }

  async function awaitStartup(operation, onLateSuccess) {
    try {
      const result = await awaitAbortable(operation, signal, onLateSuccess);
      throwIfStartupCancelled();
      return result;
    } catch (error) {
      throw startupCancellation ?? error;
    }
  }

  let baseline;
  let mainFrameId;
  let screencastAttempted = false;
  let screencastPending = false;
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
      throw new BrowserRecordingError(
        "event_stream_invalid",
        "CDP event stream returned an invalid baseline",
      );
    }

    ({ frameId: mainFrameId } = await awaitStartup(
      inspectTopLevelFrame({ approvedOrigin, cdp }),
    ));
    screencastAttempted = true;
    screencastPending = true;
    const startScreencast = Promise.resolve(
      cdp.send("Page.startScreencast", {
        everyNthFrame: 1,
        format: "jpeg",
        maxHeight: RECORDING_MAX_HEIGHT,
        maxWidth: RECORDING_MAX_WIDTH,
        quality: RECORDING_JPEG_QUALITY,
      }),
    ).finally(() => {
      screencastPending = false;
    });
    await awaitStartup(
      startScreencast,
      () => cdp.send("Page.stopScreencast"),
    );
    sink = sinkFactory({ ffmpegPath, fps, maxOutputBytes, outputPath });
    throwIfStartupCancelled();
  } catch (error) {
    if (screencastAttempted && !screencastPending) {
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
  let startedAt = null;
  let initialFrameSeeded = false;
  let stopPromise = null;
  const acceptFrame = (jpeg) => {
    if (stopPromise !== null) return false;
    const frameAt = now();
    const accepted = sink.accept(jpeg);
    if (accepted !== false) startedAt ??= frameAt;
    return accepted;
  };
  const firstFrameDeadline = createFirstFrameDeadline(firstFrameTimeoutMs);
  const pump = startFramePump({
    cdp,
    initialCursor: baseline.cursor,
    mainFrameId,
    maxDecodedBytes,
    onFrame: async (frame) => {
      if (!initialFrameSeeded) {
        const screenshot = await Promise.race([
          captureInitialPageFrame({ cdp, maxDecodedBytes, signal }),
          firstFrameDeadline.promise,
        ]);
        try {
          await Promise.race([
            inspectTopLevelFrame({ approvedOrigin, cdp }),
            firstFrameDeadline.promise,
          ]);
        } catch (error) {
          if (error?.code === "origin_not_allowed") {
            throw new BrowserRecordingError(
              "origin_changed_during_recording",
              "The recording page left the approved origin",
            );
          }
          throw error;
        }
        if (acceptFrame(screenshot) === false) {
          throw new BrowserRecordingError(
            "frame_stream_unavailable",
            "The initial page frame could not be recorded",
          );
        }
        initialFrameSeeded = true;
        return true;
      }
      return acceptFrame(frame.jpeg);
    },
    onTopFrameNavigation(url) {
      if (originOf(url) !== approvedOrigin) {
        throw new BrowserRecordingError(
          "origin_changed_during_recording",
          "The recording page left the approved origin",
        );
      }
    },
    readTimeoutMs,
  });
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

  const recordingReady = Promise.race([
    pump.ready,
    firstFrameDeadline.promise,
  ]).finally(() => firstFrameDeadline.clear());

  let durationTimer = null;
  void recordingReady.then(
    () => {
      if (stopPromise !== null) return;
      durationTimer = setTimeout(() => {
        terminate(
          new BrowserRecordingError(
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
          new BrowserRecordingError(
            "recording_output_limit",
            "Recording exceeded the configured output size limit",
          ),
        );
        return;
      }
    } catch (error) {
      terminate(
        error instanceof BrowserRecordingError
          ? error
          : new BrowserRecordingError(
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
        new BrowserRecordingError("recording_cancelled", "Recording was cancelled"),
    );
  };
  signal?.addEventListener("abort", abortListener, { once: true });
  signal?.removeEventListener("abort", startupAbortListener);
  if (startupCancellation !== null || signal?.aborted) abortListener();
  if (typeof sink.completion?.then === "function") {
    void sink.completion.then(() => {
      if (stopPromise === null) {
        terminate(
          new BrowserRecordingError(
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
    ready: recordingReady.catch(
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
    throw new BrowserRecordingError(
      "invalid_configuration",
      "Top-level origin verification configuration is invalid",
    );
  }

  let frameTree;
  try {
    frameTree = await cdp.send("Page.getFrameTree");
  } catch {
    throw new BrowserRecordingError(
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
    throw new BrowserRecordingError(
      originOf(frame?.url) === null
        ? "origin_verification_failed"
        : "origin_not_allowed",
      "The recording page is outside the approved origin",
    );
  }
  return { frameId: frame.id };
}

export async function startBrowserRecordingForTab({
  approvedOrigin,
  signal,
  tab,
  ...options
}) {
  if (typeof tab?.capabilities?.get !== "function") {
    throw new BrowserRecordingError(
      "cdp_unavailable",
      "The selected Browser tab does not expose capabilities",
    );
  }

  const cdp = await awaitAbortable(tab.capabilities.get("cdp"), signal);
  if (
    typeof cdp?.readEvents !== "function" ||
    typeof cdp?.send !== "function"
  ) {
    throw new BrowserRecordingError(
      "cdp_unavailable",
      "Full CDP access is unavailable for the selected Browser tab",
    );
  }

  return startBrowserRecording({ ...options, approvedOrigin, cdp, signal });
}
