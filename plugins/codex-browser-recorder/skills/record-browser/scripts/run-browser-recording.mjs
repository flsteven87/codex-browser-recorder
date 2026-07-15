import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import {
  createFfmpegSink,
  startFramePump,
} from "./screencast-recorder.mjs";
import { validateVideo } from "./validate-video.mjs";

const SCREENCAST_EVENT_METHODS = [
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
];

export async function prepareBrowserPoc({ temporaryRoot }) {
  const directory = await mkdtemp(join(temporaryRoot, "codex-browser-recorder-"));
  await chmod(directory, 0o700);

  return {
    directory,
    outputPath: join(directory, "recording.webm"),
    resultPath: join(directory, "result.json"),
  };
}

const CAPTURE_RESULT_FIELDS = [
  "backpressureDrops",
  "elapsedMs",
  "encoderExitCode",
  "framesAcknowledged",
  "framesDropped",
  "framesReceived",
  "invalidFrames",
  "lastFrameTimestamp",
  "maxObservedOutputBytes",
  "outputSamples",
  "terminationReason",
  "truncations",
  "visibilityChanges",
  "visibilityState",
];

const VIDEO_VALIDATION_FAILURE_CODES = new Set([
  "audio_stream_present",
  "codec_invalid",
  "container_invalid",
  "dimensions_out_of_bounds",
  "duration_invalid",
  "duration_mismatch",
  "ffprobe_failed",
  "invalid_configuration",
  "output_missing",
  "output_too_small",
  "video_stream_count_invalid",
  "video_stream_missing",
]);

const CAPTURE_FAILURE_CODES = new Set([
  "cdp_unavailable",
  "encoder_failed",
  "encoder_finalize_failed",
  "encoder_shutdown_timeout",
  "event_stream_invalid",
  "frame_stream_stalled",
  "frame_stream_unavailable",
  "invalid_configuration",
  "origin_not_allowed",
  "origin_verification_failed",
  "output_monitor_failed",
  "recording_cancelled",
  "recording_duration_limit",
  "recording_output_limit",
]);

function sanitizeCaptureResult(capture) {
  return Object.fromEntries(
    CAPTURE_RESULT_FIELDS.map((field) => [field, capture[field] ?? null]),
  );
}

function captureFailureCode(error) {
  if (error == null) {
    return null;
  }
  return CAPTURE_FAILURE_CODES.has(error.code)
    ? error.code
    : "capture_failed";
}

export async function finalizeBrowserPoc({
  captureError,
  durationToleranceSeconds,
  ffprobePath,
  maxHeight,
  maxWidth,
  minBytes,
  outputPath,
  resultPath,
  session,
}) {
  let failureCode = captureFailureCode(captureError);
  let capture;
  try {
    capture = await session.stop();
  } catch (error) {
    capture = {
      ...session.stats?.framePump,
      ...session.stats?.resources,
      ...session.stats?.sink,
      elapsedMs: session.stats?.resources?.elapsedMs ?? null,
    };
    failureCode ??= captureFailureCode(error);
  }

  let validation = null;
  if (failureCode === null) {
    try {
      validation = await validateVideo({
        durationToleranceSeconds,
        expectedDurationSeconds: capture.elapsedMs / 1000,
        ffprobePath,
        maxHeight,
        maxWidth,
        minBytes,
        outputPath,
      });
    } catch (error) {
      if (!VIDEO_VALIDATION_FAILURE_CODES.has(error?.code)) {
        throw error;
      }
      failureCode = error.code;
    }
  }
  const result = {
    capture: sanitizeCaptureResult(capture),
    failureCode,
    schemaVersion: 2,
    status: failureCode === null ? "passed" : "failed",
    validation,
    videoFile: basename(outputPath),
  };

  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return result;
}

class PocError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PocError";
    this.code = code;
  }
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
  cdp,
  ffmpegPath,
  firstFrameTimeoutMs = 5000,
  fps,
  getOutputSize = readOutputSize,
  maxDecodedBytes,
  maxDurationMs = 20 * 60 * 1000,
  maxFrameStallMs = null,
  maxOutputBytes = 500 * 1024 * 1024,
  now = () => performance.now(),
  outputPath,
  readTimeoutMs,
  resourceCheckIntervalMs = 1000,
  signal,
  sinkFactory = createFfmpegSink,
}) {
  validateStartConfiguration({
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
  if (signal?.aborted) {
    throw new PocError("recording_cancelled", "Recording was cancelled");
  }

  const baseline = await cdp.readEvents({
    limit: 1,
    methods: SCREENCAST_EVENT_METHODS,
    timeoutMs: 0,
  });
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

  await cdp.send("Page.enable");
  await cdp.send("Page.startScreencast", {
    everyNthFrame: 1,
    format: "jpeg",
    maxHeight: 720,
    maxWidth: 1280,
    quality: 70,
  });

  let sink;
  try {
    sink = sinkFactory({ ffmpegPath, fps, maxOutputBytes, outputPath });
  } catch (error) {
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      // Preserve the encoder startup failure as the primary error.
    }
    throw error;
  }
  let lastFrameAt = null;
  const pump = startFramePump({
    cdp,
    initialCursor: baseline.cursor,
    maxDecodedBytes,
    onFrame: (frame) => {
      lastFrameAt = now();
      return sink.accept(frame.jpeg);
    },
    readTimeoutMs,
  });
  const startedAt = now();
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

  const durationTimer = setTimeout(() => {
    terminate(
      new PocError(
        "recording_duration_limit",
        "Recording reached the configured duration limit",
      ),
    );
  }, maxDurationMs);
  durationTimer.unref?.();

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
    terminate(new PocError("recording_cancelled", "Recording was cancelled"));
  };
  signal?.addEventListener("abort", abortListener, { once: true });
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

  async function finalize() {
    clearTimeout(durationTimer);
    clearInterval(resourceTimer);
    signal?.removeEventListener("abort", abortListener);
    let firstError = null;

    try {
      await cdp.send("Page.stopScreencast");
    } catch (error) {
      firstError = error;
    }

    try {
      await pump.stop();
    } catch (error) {
      firstError ??= error;
    }

    try {
      await sink.stop({
        discard: firstError !== null || terminationError !== null,
      });
    } catch (error) {
      firstError ??= error;
    } finally {
      resourceStats.maxObservedOutputBytes = Math.max(
        resourceStats.maxObservedOutputBytes,
        sink.stats?.outputBytes ?? 0,
      );
    }

    if (firstError !== null) {
      throw firstError;
    }
    if (terminationError !== null) {
      throw terminationError;
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
      resourceStats.elapsedMs = Math.max(0, stoppedAt - startedAt);
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

export async function assertTopLevelUrl({ cdp, expectedUrl }) {
  if (
    typeof cdp?.send !== "function" ||
    typeof expectedUrl !== "string" ||
    expectedUrl.length === 0
  ) {
    throw new PocError(
      "invalid_configuration",
      "Top-level URL verification configuration is invalid",
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

  const actualUrl = frameTree?.frameTree?.frame?.url;
  if (typeof actualUrl !== "string") {
    throw new PocError(
      "origin_verification_failed",
      "The recording page origin could not be verified",
    );
  }
  if (actualUrl !== expectedUrl) {
    throw new PocError(
      "origin_not_allowed",
      "The recording page is outside the approved fixed origin",
    );
  }
  return true;
}

export async function startBrowserPocForTab({
  expectedTopLevelUrl,
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

  if (expectedTopLevelUrl !== undefined) {
    await assertTopLevelUrl({ cdp, expectedUrl: expectedTopLevelUrl });
  }
  return startBrowserPoc({ ...options, cdp });
}

export async function createBrowserRecording({
  _dependencies = {
    finalizeBrowserPoc,
    prepareBrowserPoc,
    startBrowserPocForTab,
  },
  durationToleranceSeconds = 5,
  expectedTopLevelUrl,
  ffmpegPath,
  ffprobePath,
  firstFrameTimeoutMs = 5000,
  fps = 10,
  maxDecodedBytes = 5 * 1024 * 1024,
  maxDurationMs = 20 * 60 * 1000,
  maxFrameStallMs = 5000,
  maxHeight = 720,
  maxOutputBytes = 500 * 1024 * 1024,
  maxWidth = 1280,
  minBytes = 100,
  readTimeoutMs = 1000,
  resourceCheckIntervalMs = 1000,
  signal,
  tab,
  temporaryRoot = tmpdir(),
}) {
  const paths = await _dependencies.prepareBrowserPoc({ temporaryRoot });
  const session = await _dependencies.startBrowserPocForTab({
    expectedTopLevelUrl,
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

  let finalizationPromise = null;
  let readinessError = null;
  let state = "recording";
  const ready = Promise.resolve(session.ready).catch((error) => {
    readinessError = error;
    state = "failed";
    throw error;
  });
  if (typeof session.completion?.then === "function") {
    void session.completion.then(
      (outcome) => {
        if (outcome?.error) {
          readinessError ??= outcome.error;
          state = "failed";
        } else if (state === "recording") {
          state = "stopping";
        }
      },
      (error) => {
        readinessError ??= error;
        state = "failed";
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
      .finalizeBrowserPoc({
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
    return finalizationPromise;
  }

  return { ready, status, stop };
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

  const paths = await prepareBrowserPoc({ temporaryRoot });
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

  const result = await finalizeBrowserPoc({
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
