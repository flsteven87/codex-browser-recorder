import { spawn } from "node:child_process";

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
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
];

export function startFramePump({
  cdp,
  initialCursor,
  onFrame,
  maxDecodedBytes,
  readTimeoutMs,
}) {
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

  async function handleEvent(event) {
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

      if (batch.truncated) {
        stats.truncations += 1;
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

  return {
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

export function createFfmpegSink({ ffmpegPath, fps, outputPath }) {
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
      "-y",
      outputPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  let latestFrame = null;
  let backpressured = false;
  let stopped = false;
  let stderrTail = "";
  let stdinError = null;
  const stats = {
    backpressureDrops: 0,
    encoderExitCode: null,
    outputSamples: 0,
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-4096);
  });

  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.on("drain", () => {
    backpressured = false;
  });
  child.stdin.on("error", (error) => {
    stdinError = error;
  });

  const timer = setInterval(() => {
    if (stopped || latestFrame === null) {
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
    stats,
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        child.stdin.end();
      }

      const { code, signal } = await exited;
      stats.encoderExitCode = code;
      if (code !== 0 || stdinError !== null) {
        const error = new RecorderError(
          "encoder_failed",
          code !== 0
            ? `FFmpeg exited unsuccessfully (${signal ?? code})`
            : "FFmpeg input stream failed",
        );
        error.diagnostic = stderrTail;
        throw error;
      }
      return stats;
    },
  };
}
