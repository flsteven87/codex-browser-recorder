import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
  "outputSamples",
  "truncations",
  "visibilityChanges",
  "visibilityState",
];

const VIDEO_VALIDATION_FAILURE_CODES = new Set([
  "dimensions_out_of_bounds",
  "duration_invalid",
  "duration_mismatch",
  "ffprobe_failed",
  "output_missing",
  "output_too_small",
  "video_stream_count_invalid",
  "video_stream_missing",
]);

const CAPTURE_FAILURE_CODES = new Set([
  "encoder_failed",
  "frame_stream_unavailable",
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
      ...session.stats?.sink,
      elapsedMs: null,
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
    schemaVersion: 1,
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

export async function startBrowserPoc({
  cdp,
  ffmpegPath,
  firstFrameTimeoutMs = 5000,
  fps,
  maxDecodedBytes,
  outputPath,
  readTimeoutMs,
  sinkFactory = createFfmpegSink,
}) {
  const baseline = await cdp.readEvents({
    limit: 1,
    methods: SCREENCAST_EVENT_METHODS,
    timeoutMs: 0,
  });

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
    sink = sinkFactory({ ffmpegPath, fps, outputPath });
  } catch (error) {
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      // Preserve the encoder startup failure as the primary error.
    }
    throw error;
  }
  const pump = startFramePump({
    cdp,
    initialCursor: baseline.cursor,
    maxDecodedBytes,
    onFrame: (frame) => sink.accept(frame.jpeg),
    readTimeoutMs,
  });
  const startedAt = Date.now();
  let stopPromise = null;

  async function finalize() {
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
      await sink.stop();
    } catch (error) {
      firstError ??= error;
    }

    if (firstError !== null) {
      throw firstError;
    }

    return {
      elapsedMs: Date.now() - startedAt,
      ...pump.stats,
      ...sink.stats,
      outputPath,
    };
  }

  return {
    ready: waitForFirstFrame(pump.ready, firstFrameTimeoutMs),
    stats: {
      framePump: pump.stats,
      sink: sink.stats,
    },
    stop() {
      stopPromise ??= finalize();
      return stopPromise;
    },
  };
}
