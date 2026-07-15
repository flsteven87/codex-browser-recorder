import { spawn } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

class RecorderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecorderError";
    this.code = code;
  }
}

export function estimateDecodedBytes(base64) {
  if (base64.length === 0) {
    return 0;
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function parseScreencastFrame(event, maxDecodedBytes) {
  if (event?.method !== "Page.screencastFrame") {
    return null;
  }
  if (!Number.isInteger(maxDecodedBytes) || maxDecodedBytes <= 0) {
    throw new RecorderError(
      "invalid_configuration",
      "Decoded frame size limit is invalid",
    );
  }

  const { data, metadata, sessionId } = event.params ?? {};
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(data) ||
    !Number.isInteger(sessionId) ||
    sessionId < 0
  ) {
    throw new RecorderError("invalid_frame", "Invalid screencast frame payload");
  }

  if (estimateDecodedBytes(data) > maxDecodedBytes) {
    throw new RecorderError("frame_too_large", "Screencast frame exceeds limit");
  }

  return {
    jpeg: Buffer.from(data, "base64"),
    sessionId,
    timestamp: Number.isFinite(metadata?.timestamp) ? metadata.timestamp : null,
  };
}

const SCREENCAST_EVENT_METHODS = [
  "Page.frameNavigated",
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
];

function validateFramePumpConfiguration({
  cdp,
  initialCursor,
  mainFrameId,
  maxDecodedBytes,
  onFrame,
  onTopFrameNavigation,
  readTimeoutMs,
}) {
  if (
    typeof cdp?.readEvents !== "function" ||
    typeof cdp?.send !== "function" ||
    (initialCursor !== undefined &&
      (!Number.isInteger(initialCursor) || initialCursor < 0)) ||
    typeof mainFrameId !== "string" ||
    mainFrameId.length === 0 ||
    !Number.isInteger(maxDecodedBytes) ||
    maxDecodedBytes <= 0 ||
    typeof onFrame !== "function" ||
    typeof onTopFrameNavigation !== "function" ||
    !Number.isInteger(readTimeoutMs) ||
    readTimeoutMs < 0
  ) {
    throw new RecorderError(
      "invalid_configuration",
      "Frame pump configuration is invalid",
    );
  }
}

function validateEventBatch(batch, currentCursor) {
  if (
    batch === null ||
    typeof batch !== "object" ||
    !Number.isInteger(batch.cursor) ||
    batch.cursor < 0 ||
    (currentCursor !== undefined && batch.cursor < currentCursor) ||
    !Array.isArray(batch.events)
  ) {
    throw new RecorderError(
      "event_stream_invalid",
      "CDP event stream returned an invalid batch",
    );
  }
}

export function startFramePump({
  cdp,
  initialCursor,
  mainFrameId,
  onFrame,
  onTopFrameNavigation,
  maxDecodedBytes,
  readTimeoutMs,
}) {
  validateFramePumpConfiguration({
    cdp,
    initialCursor,
    mainFrameId,
    maxDecodedBytes,
    onFrame,
    onTopFrameNavigation,
    readTimeoutMs,
  });

  let stopped = false;
  let cursor = initialCursor;
  let loopError = null;
  let readySettled = false;
  let resolveReady;
  let rejectReady;

  const stats = {
    cursor: 0,
    framesAcknowledged: 0,
    framesDropped: 0,
    framesReceived: 0,
    invalidFrames: 0,
    lastFrameTimestamp: null,
    truncations: 0,
    visibilityChanges: 0,
    visibilityState: null,
  };

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {
    // Consumers may choose completion when readiness is no longer relevant.
  });

  async function handleEvent(event) {
    if (event?.method === "Page.frameNavigated") {
      const frame = event.params?.frame;
      if (
        frame?.id === mainFrameId &&
        !Object.hasOwn(frame, "parentId") &&
        typeof frame.url === "string"
      ) {
        await onTopFrameNavigation(frame.url);
      }
      return;
    }
    if (event?.method === "Page.screencastVisibilityChanged") {
      const visible = event.params?.visible;
      if (typeof visible === "boolean" && visible !== stats.visibilityState) {
        stats.visibilityState = visible;
        stats.visibilityChanges += 1;
      }
      return;
    }

    if (event?.method !== "Page.screencastFrame") {
      return;
    }

    stats.framesReceived += 1;
    const sessionId = event.params?.sessionId;
    if (Number.isInteger(sessionId) && sessionId >= 0) {
      await cdp.send("Page.screencastFrameAck", { sessionId });
      stats.framesAcknowledged += 1;
    }

    let frame;
    try {
      frame = parseScreencastFrame(event, maxDecodedBytes);
    } catch (error) {
      if (error instanceof RecorderError) {
        stats.invalidFrames += 1;
        return;
      }
      throw error;
    }

    const accepted = await onFrame(frame);
    if (accepted === false) {
      stats.framesDropped += 1;
    }
    stats.lastFrameTimestamp = frame.timestamp;
    if (!readySettled) {
      readySettled = true;
      resolveReady(true);
    }
  }

  const loop = (async () => {
    while (!stopped) {
      const batch = await cdp.readEvents({
        afterSequence: cursor,
        limit: 1000,
        methods: SCREENCAST_EVENT_METHODS,
        timeoutMs: readTimeoutMs,
      });

      validateEventBatch(batch, cursor);

      if (batch.truncated) {
        stats.truncations += 1;
        throw new RecorderError(
          "event_stream_invalid",
          "CDP event stream was truncated",
        );
      }
      cursor = batch.cursor;
      stats.cursor = cursor;

      for (const event of batch.events) {
        await handleEvent(event);
      }
    }
  })().catch((error) => {
    loopError = error;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
  });

  const completion = loop.then(() => ({ error: loopError }));

  return {
    completion,
    ready,
    stats,
    async stop() {
      stopped = true;
      await loop;
      if (loopError !== null) {
        throw loopError;
      }
      return stats;
    },
  };
}

export function createFfmpegSink({
  ffmpegPath,
  fps,
  maxOutputBytes = 500 * 1024 * 1024,
  outputPath,
  shutdownTimeoutMs = 5000,
}) {
  if (
    typeof ffmpegPath !== "string" ||
    ffmpegPath.length === 0 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    typeof outputPath !== "string" ||
    outputPath.length === 0 ||
    !Number.isInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs <= 0
  ) {
    throw new RecorderError(
      "invalid_configuration",
      "FFmpeg sink configuration is invalid",
    );
  }

  const workingOutputPath = `${outputPath}.partial`;

  const child = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "5",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "webm",
      "-y",
      workingOutputPath,
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );

  let latestFrame = null;
  let backpressured = false;
  let stopped = false;
  let stdinError = null;
  let processExited = false;
  let stopPromise = null;
  let timer = null;
  const stats = {
    backpressureDrops: 0,
    encoderExitCode: null,
    outputBytes: 0,
    outputSamples: 0,
  };

  const exited = new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        processExited = true;
        if (timer !== null) {
          clearInterval(timer);
        }
        resolve(result);
      }
    };
    child.once("error", (error) => settle({ code: null, error, signal: null }));
    child.once("close", (code, signal) =>
      settle({ code, error: null, signal }),
    );
  });

  child.stdin.on("drain", () => {
    backpressured = false;
  });
  child.stdin.on("error", (error) => {
    stdinError = error;
  });

  timer = setInterval(() => {
    if (stopped || processExited || latestFrame === null) {
      return;
    }

    if (backpressured) {
      stats.backpressureDrops += 1;
      return;
    }

    stats.outputSamples += 1;
    if (!child.stdin.write(latestFrame)) {
      backpressured = true;
    }
  }, 1000 / fps);

  return {
    accept(jpeg) {
      if (stopped || !Buffer.isBuffer(jpeg) || jpeg.length === 0) {
        return false;
      }
      latestFrame = Buffer.from(jpeg);
      return true;
    },
    completion: exited,
    stats,
    workingOutputPath,
    stop({ discard = false } = {}) {
      if (typeof discard !== "boolean") {
        return Promise.reject(
          new RecorderError(
            "invalid_configuration",
            "FFmpeg stop configuration is invalid",
          ),
        );
      }
      stopPromise ??= (async () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          child.stdin.end();
        }

        let timeout;
        const timedResult = await Promise.race([
          exited,
          new Promise((resolve) => {
            timeout = setTimeout(
              () => resolve({ shutdownTimedOut: true }),
              shutdownTimeoutMs,
            );
          }),
        ]);
        clearTimeout(timeout);

        if (timedResult.shutdownTimedOut) {
          child.kill("SIGKILL");
          let killTimer;
          await Promise.race([
            exited,
            new Promise((resolve) => {
              killTimer = setTimeout(resolve, shutdownTimeoutMs);
            }),
          ]);
          clearTimeout(killTimer);
          await rm(workingOutputPath, { force: true });
          throw new RecorderError(
            "encoder_shutdown_timeout",
            "FFmpeg did not stop within the configured timeout",
          );
        }

        const { code, error: processError, signal } = timedResult;
        stats.encoderExitCode = code;
        if (processError !== null || code !== 0 || stdinError !== null) {
          await rm(workingOutputPath, { force: true });
          throw new RecorderError(
            "encoder_failed",
            processError !== null
              ? "FFmpeg could not be started"
              : code !== 0
                ? `FFmpeg exited unsuccessfully (${signal ?? code})`
                : "FFmpeg input stream failed",
          );
        }

        try {
          stats.outputBytes = (await stat(workingOutputPath)).size;
        } catch {
          await rm(workingOutputPath, { force: true });
          throw new RecorderError(
            "encoder_finalize_failed",
            "Encoded output could not be inspected before finalization",
          );
        }
        if (stats.outputBytes > maxOutputBytes) {
          await rm(workingOutputPath, { force: true });
          throw new RecorderError(
            "recording_output_limit",
            "Encoded output exceeds the configured size limit",
          );
        }

        if (discard) {
          await rm(workingOutputPath, { force: true });
        } else {
          try {
            await rename(workingOutputPath, outputPath);
          } catch {
            await rm(workingOutputPath, { force: true });
            throw new RecorderError(
              "encoder_finalize_failed",
              "Encoded output could not be finalized atomically",
            );
          }
        }
        return stats;
      })();
      return stopPromise;
    },
  };
}
