import {
  createFfmpegSink,
  startFramePump,
} from "./screencast-recorder.mjs";

const SCREENCAST_EVENT_METHODS = [
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
