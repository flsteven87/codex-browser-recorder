import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFfmpegSink,
  estimateDecodedBytes,
  parseScreencastFrame,
  startFramePump,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/media-recorder.mjs";
import { startBrowserRecording as startBrowserRecordingProduction } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

async function createTestCursorCapture({ now }) {
  const startedAt = now();
  let stopPromise;
  return {
    completion: new Promise(() => {}),
    stats: { cursorEventsCaptured: 0, cursorFramesObserved: 1 },
    stop() {
      stopPromise ??= Promise.resolve({
        durationMs: Math.max(1, now() - startedAt),
        events: [],
        viewport: { height: 720, width: 1280 },
      });
      return stopPromise;
    },
  };
}

async function renderTestCursor({ inputPath, outputPath }) {
  let outputBytes = 0;
  if (existsSync(inputPath)) {
    rmSync(outputPath, { force: true });
    renameSync(inputPath, outputPath);
    outputBytes = statSync(outputPath).size;
  }
  return { outputBytes, outputPath };
}

function startBrowserRecording(options) {
  return startBrowserRecordingProduction({
    ...options,
    cursorCaptureFactory:
      options.cursorCaptureFactory ?? createTestCursorCapture,
    cursorRenderer: options.cursorRenderer ?? renderTestCursor,
  });
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function frameEvent(overrides = {}) {
  return {
    method: "Page.screencastFrame",
    sequence: 1,
    params: {
      data: jpeg.toString("base64"),
      metadata: { timestamp: 123.5 },
      sessionId: 7,
      ...overrides,
    },
  };
}

function createLiveCdp(operations = [], streamedFrame = jpeg) {
  let reads = 0;
  return {
    async send(method) {
      operations.push(method);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/start" },
          },
        };
      }
    },
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 1, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) {
        return {
          cursor: 2,
          events: [
            frameEvent({ data: streamedFrame.toString("base64") }),
          ],
          hasMore: false,
          truncated: false,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { cursor: 2, events: [], hasMore: false, truncated: false };
    },
  };
}

function createQueuedCdp({
  frameTree = {
    frameTree: {
      frame: { id: "main-frame", url: "https://example.com/start" },
    },
  },
  operations = [],
} = {}) {
  const events = [];
  let deliveredSequence = 0;
  let sequence = 0;

  return {
    async flush() {
      const target = sequence;
      while (deliveredSequence < target) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    publish(event) {
      sequence += 1;
      events.push({ ...event, sequence });
    },
    async readEvents({ afterSequence = 0, methods } = {}) {
      let pending = events.filter(
        (event) =>
          event.sequence > afterSequence &&
          (methods === undefined || methods.includes(event.method)),
      );
      if (pending.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        pending = events.filter(
          (event) =>
            event.sequence > afterSequence &&
            (methods === undefined || methods.includes(event.method)),
        );
      }
      deliveredSequence = Math.max(deliveredSequence, sequence);
      return {
        cursor: sequence,
        events: pending,
        hasMore: false,
        truncated: false,
      };
    },
    async send(method, params) {
      operations.push([method, params]);
      if (method === "Page.getFrameTree") return frameTree;
      if (method === "Page.captureScreenshot") {
        return { data: jpeg.toString("base64") };
      }
    },
  };
}

function createMemorySink(operations = []) {
  return {
    stats: { backpressureDrops: 0, encoderExitCode: null, outputSamples: 0 },
    accept() {
      this.stats.outputSamples += 1;
      return true;
    },
    async stop() {
      operations.push("sink.stop");
      this.stats.encoderExitCode = 0;
      return this.stats;
    },
  };
}

function createNavigationSessionHarness({
  approvedOrigin,
  frameTree,
  stopScreencastError,
}) {
  const operations = [];
  const cdp = createQueuedCdp({ frameTree, operations });
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (
      method === "Page.stopScreencast" &&
      stopScreencastError !== undefined
    ) {
      throw stopScreencastError;
    }
    return send(method, params);
  };
  const sinkStopOptions = {};
  const sink = createMemorySink();
  sink.stop = async (options) => {
    Object.assign(sinkStopOptions, options);
    sink.stats.encoderExitCode = 0;
    return sink.stats;
  };

  return {
    cdp,
    flush: () => cdp.flush(),
    operations,
    publishFrame() {
      cdp.publish(frameEvent());
    },
    publishNavigation(frame) {
      cdp.publish({ method: "Page.frameNavigated", params: { frame } });
    },
    sink,
    sinkStopOptions,
    start() {
      return startBrowserRecording({
        approvedOrigin,
        cdp,
        ffmpegPath: "/unused/ffmpeg",
        fps: 10,
        maxDecodedBytes: 1024,
        maxDurationMs: 50,
        outputPath: "/tmp/unused.mp4",
        readTimeoutMs: 0,
        sinkFactory: () => sink,
      });
    },
  };
}

test("estimates decoded base64 byte length", () => {
  assert.equal(estimateDecodedBytes(jpeg.toString("base64")), jpeg.length);
});

test("parses a valid screencast frame", () => {
  const parsed = parseScreencastFrame(frameEvent(), 1024);

  assert.deepEqual(parsed.jpeg, jpeg);
  assert.equal(parsed.sessionId, 7);
  assert.equal(parsed.timestamp, 123.5);
});

test("ignores non-frame events", () => {
  assert.equal(
    parseScreencastFrame({ method: "Page.loadEventFired", params: {} }, 1024),
    null,
  );
});

test("rejects a frame without a numeric session ID", () => {
  assert.throws(
    () => parseScreencastFrame(frameEvent({ sessionId: undefined }), 1024),
    (error) => error.code === "invalid_frame",
  );
});

test("rejects malformed base64 without exposing its contents", () => {
  const secretPayload = "not*base64*secret";

  assert.throws(
    () => parseScreencastFrame(frameEvent({ data: secretPayload }), 1024),
    (error) =>
      error.code === "invalid_frame" && !error.message.includes(secretPayload),
  );
});

test("rejects a frame exceeding the decoded size limit", () => {
  const oversized = Buffer.alloc(32, 1).toString("base64");

  assert.throws(
    () => parseScreencastFrame(frameEvent({ data: oversized }), 16),
    (error) => error.code === "frame_too_large",
  );
});

test("rejects an invalid decoded frame size limit", () => {
  assert.throws(
    () => parseScreencastFrame(frameEvent(), Number.NaN),
    (error) => error.code === "invalid_configuration",
  );
});

test("reports top-frame navigation through the frame pump", async () => {
  const navigations = [];
  const cdp = createQueuedCdp();
  const pump = startFramePump({
    cdp,
    initialCursor: 0,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame: async () => true,
    onTopFrameNavigation(url) {
      navigations.push(url);
    },
    readTimeoutMs: 0,
  });

  cdp.publish({
    method: "Page.frameNavigated",
    params: {
      frame: {
        id: "child-frame",
        parentId: "main-frame",
        url: "https://other.example/",
      },
    },
  });
  cdp.publish({
    method: "Page.frameNavigated",
    params: { frame: { id: "main-frame", url: "https://example.com/next" } },
  });
  await cdp.flush();
  await pump.stop();

  assert.deepEqual(navigations, ["https://example.com/next"]);
});

test("enforces navigation for a replacement top-frame id", async () => {
  const navigations = [];
  const cdp = createQueuedCdp();
  const pump = startFramePump({
    cdp,
    initialCursor: 0,
    maxDecodedBytes: 1024,
    onFrame: async () => true,
    onTopFrameNavigation(url) {
      navigations.push(url);
    },
    readTimeoutMs: 0,
  });

  cdp.publish({
    method: "Page.frameNavigated",
    params: {
      frame: {
        id: "replacement-main",
        url: "https://other.example/",
      },
    },
  });
  await cdp.flush();
  await pump.stop();

  assert.deepEqual(navigations, ["https://other.example/"]);
});

test("exposes a frame-pump policy failure through completion", async () => {
  const cdp = createQueuedCdp();
  const policyError = Object.assign(new Error("Origin changed"), {
    code: "origin_changed_during_recording",
  });
  const pump = startFramePump({
    cdp,
    initialCursor: 0,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame: async () => true,
    onTopFrameNavigation() {
      throw policyError;
    },
    readTimeoutMs: 0,
  });

  cdp.publish({
    method: "Page.frameNavigated",
    params: { frame: { id: "main-frame", url: "https://other.example/" } },
  });

  assert.deepEqual(await pump.completion, { error: policyError });
  await assert.rejects(pump.stop(), (error) => error === policyError);
});

test("enforces navigation policy before the first frame consumer", async () => {
  const cdp = createQueuedCdp();
  const firstFrameAccepted = deferred();
  const firstFrameReceived = deferred();
  const operations = [];
  const pump = startFramePump({
    cdp,
    initialCursor: 0,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    async onFrame() {
      operations.push("frame");
      firstFrameReceived.resolve();
      await firstFrameAccepted.promise;
      operations.push("frame-accepted");
      return true;
    },
    onTopFrameNavigation() {
      operations.push("navigation");
    },
    readTimeoutMs: 0,
  });

  cdp.publish({
    method: "Page.frameNavigated",
    params: { frame: { id: "main-frame", url: "https://example.com/next" } },
  });
  cdp.publish(frameEvent());
  await firstFrameReceived.promise;
  const operationsBeforeFrameAcceptance = [...operations];
  firstFrameAccepted.resolve();
  await pump.ready;
  await pump.stop();

  assert.deepEqual(operationsBeforeFrameAcceptance, ["navigation", "frame"]);
  assert.deepEqual(operations, ["navigation", "frame", "frame-accepted"]);
});

test("acknowledges a frame before handing it to the consumer", async () => {
  const operations = [];
  const reads = [];
  let readCount = 0;
  const cdp = {
    async send(method, params) {
      operations.push([method, params.sessionId]);
    },
    async readEvents(options) {
      reads.push(options);
      readCount += 1;
      if (readCount === 1) {
        return {
          cursor: 2,
          events: [
            frameEvent(),
            {
              method: "Page.screencastVisibilityChanged",
              params: { visible: false },
              sequence: 2,
            },
          ],
          hasMore: false,
          truncated: false,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 2));
      return { cursor: 2, events: [], hasMore: false, truncated: false };
    },
  };

  const pump = startFramePump({
    cdp,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame(frame) {
      operations.push(["onFrame", frame.sessionId]);
      return false;
    },
    onTopFrameNavigation() {},
    readTimeoutMs: 1,
  });

  await pump.ready;
  await pump.stop();

  assert.deepEqual(operations.slice(0, 2), [
    ["Page.screencastFrameAck", 7],
    ["onFrame", 7],
  ]);
  assert.equal(pump.stats.framesReceived, 1);
  assert.equal(pump.stats.framesAcknowledged, 1);
  assert.equal(pump.stats.framesDropped, 1);
  assert.equal(pump.stats.visibilityState, false);
  assert.equal(pump.stats.visibilityChanges, 1);
  assert.equal(reads[0].afterSequence, undefined);
});

test("fails closed before processing any event from a truncated batch", async () => {
  let framesProcessed = 0;
  let reads = 0;
  const cdp = {
    async send() {},
    async readEvents() {
      reads += 1;
      if (reads > 1) return { cursor: "invalid", events: null };
      return {
        cursor: 3,
        events: [frameEvent()],
        hasMore: true,
        truncated: true,
      };
    },
  };

  const pump = startFramePump({
    cdp,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame() {
      framesProcessed += 1;
      return true;
    },
    onTopFrameNavigation() {},
    readTimeoutMs: 1,
  });

  await assert.rejects(
    pump.ready,
    (error) => error.code === "event_stream_invalid",
  );
  await assert.rejects(
    pump.stop(),
    (error) => error.code === "event_stream_invalid",
  );

  assert.equal(framesProcessed, 0);
  assert.equal(pump.stats.cursor, 0);
  assert.equal(pump.stats.truncations, 1);
});

test("starts reading after a cursor captured before screencast startup", async () => {
  const reads = [];
  let readCount = 0;
  const cdp = {
    async send() {},
    async readEvents(options) {
      reads.push(options);
      readCount += 1;
      if (readCount === 1) {
        return {
          cursor: 12,
          events: [frameEvent()],
          hasMore: false,
          truncated: false,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { cursor: 12, events: [], hasMore: false, truncated: false };
    },
  };

  const pump = startFramePump({
    cdp,
    initialCursor: 11,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame: () => true,
    onTopFrameNavigation() {},
    readTimeoutMs: 1,
  });

  await pump.ready;
  await pump.stop();

  assert.equal(reads[0].afterSequence, 11);
});

test("acknowledges an oversized frame before dropping it", async () => {
  const acknowledgements = [];
  let readCount = 0;
  const cdp = {
    async send(_method, params) {
      acknowledgements.push(params.sessionId);
    },
    async readEvents() {
      readCount += 1;
      if (readCount === 1) {
        return {
          cursor: 1,
          events: [frameEvent({ data: Buffer.alloc(32).toString("base64") })],
          hasMore: false,
          truncated: false,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { cursor: 1, events: [], hasMore: false, truncated: false };
    },
  };

  const pump = startFramePump({
    cdp,
    mainFrameId: "main-frame",
    maxDecodedBytes: 16,
    onFrame: () => true,
    onTopFrameNavigation() {},
    readTimeoutMs: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 2));
  await pump.stop();

  assert.deepEqual(acknowledgements, [7]);
  assert.equal(pump.stats.invalidFrames, 1);
  assert.equal(pump.stats.framesAcknowledged, 1);
});

test("normalizes an odd Browser frame into a parseable H.264 MP4", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-test-"));
  const outputPath = join(directory, "sample.mp4");

  try {
    const validJpeg = execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=319x179:d=0.1",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-f",
      "image2pipe",
      "pipe:1",
    ]);
    const sink = createFfmpegSink({
      ffmpegPath,
      fps: 10,
      outputPath,
    });

    assert.equal(sink.accept(validJpeg), true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const finalExistsDuringCapture = existsSync(outputPath);
    const stats = await sink.stop();
    const probe = JSON.parse(
      execFileSync(
        ffprobePath,
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          outputPath,
        ],
        { encoding: "utf8" },
      ),
    );

    assert.ok(stats.outputSamples >= 2);
    assert.equal(finalExistsDuringCapture, false);
    assert.equal(sink.workingOutputPath, `${outputPath}.partial`);
    assert.equal(stats.encoderExitCode, 0);
    assert.equal(probe.streams.length, 1);
    assert.equal(probe.streams[0].codec_name, "h264");
    assert.equal(probe.streams[0].pix_fmt, "yuv420p");
    assert.match(probe.format.format_name, /(?:^|,)mp4(?:,|$)/u);
    assert.equal(probe.streams[0].width, 318);
    assert.equal(probe.streams[0].height, 178);
    assert.ok(Number.parseFloat(probe.format.duration) > 0);
    assert.equal(existsSync(`${outputPath}.partial`), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("publishes one accepted frame even when the encoder stops immediately", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-immediate-"));
  const outputPath = join(directory, "immediate.mp4");

  try {
    const validJpeg = execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=0.1",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-f",
      "image2pipe",
      "pipe:1",
    ]);
    const sink = createFfmpegSink({ ffmpegPath, fps: 10, outputPath });

    assert.equal(sink.accept(validJpeg), true);
    const stats = await sink.stop();
    const probe = JSON.parse(
      execFileSync(
        ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,pix_fmt:format=duration",
          "-of",
          "json",
          outputPath,
        ],
        { encoding: "utf8" },
      ),
    );

    assert.equal(stats.outputSamples, 1);
    assert.equal(stats.encoderExitCode, 0);
    assert.equal(probe.streams[0].codec_name, "h264");
    assert.equal(probe.streams[0].pix_fmt, "yuv420p");
    assert.ok(Number.parseFloat(probe.format.duration) > 0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("bounds an oversized JPEG frame within the MP4 contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-large-"));
  const outputPath = join(directory, "bounded.mp4");

  try {
    const screenshot = execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=1919x1079:d=0.1",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-f",
      "image2pipe",
      "pipe:1",
    ]);
    const sink = createFfmpegSink({
      ffmpegPath,
      fps: 10,
      maxHeight: 9_999,
      maxWidth: 9_999,
      outputPath,
    });

    assert.equal(sink.accept(screenshot), true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await sink.stop();
    const probe = JSON.parse(
      execFileSync(
        ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height",
          "-of",
          "json",
          outputPath,
        ],
        { encoding: "utf8" },
      ),
    );

    assert.deepEqual(probe.streams, [{ height: 720, width: 1280 }]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("discards the partial video instead of publishing a failed capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-discard-"));
  const outputPath = join(directory, "discarded.mp4");

  try {
    const validJpeg = execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=0.1",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-f",
      "image2pipe",
      "pipe:1",
    ]);
    const sink = createFfmpegSink({ ffmpegPath, fps: 10, outputPath });
    sink.accept(validJpeg);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await sink.stop({ discard: true });

    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(`${outputPath}.partial`), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("enforces the output limit again before publishing the final video", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-size-cap-"));
  const outputPath = join(directory, "oversized.mp4");

  try {
    const validJpeg = execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=0.1",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-f",
      "image2pipe",
      "pipe:1",
    ]);
    const sink = createFfmpegSink({
      ffmpegPath,
      fps: 10,
      maxOutputBytes: 1,
      outputPath,
    });
    sink.accept(validJpeg);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await assert.rejects(
      sink.stop(),
      (error) => error.code === "recording_output_limit",
    );

    assert.equal(sink.stats.outputBytes > 1, true);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(`${outputPath}.partial`), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("does not enqueue more samples until FFmpeg stdin drains", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-pipe-"));
  const slowProcessPath = join(directory, "slow-process.sh");
  writeFileSync(
    slowProcessPath,
    "#!/bin/sh\nfor last do :; done\nsleep 0.2\ncat >/dev/null\n: > \"$last\"\nexit 0\n",
  );
  chmodSync(slowProcessPath, 0o755);

  try {
    const sink = createFfmpegSink({
      ffmpegPath: slowProcessPath,
      fps: 100,
      outputPath: join(directory, "unused.mp4"),
    });
    sink.accept(Buffer.alloc(1024 * 1024));

    await new Promise((resolve) => setTimeout(resolve, 35));
    const samplesBeforeStop = sink.stats.outputSamples;
    await sink.stop();

    assert.equal(samplesBeforeStop, 1);
    assert.ok(sink.stats.backpressureDrops >= 1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("reports encoder failure when the process exits before consuming frames", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-exit-"));
  const failingProcessPath = join(directory, "failing-process.sh");
  writeFileSync(
    failingProcessPath,
    "#!/bin/sh\nfor last do :; done\n: > \"$last\"\nprintf 'sensitive encoder diagnostic\\n' >&2\nexit 7\n",
  );
  chmodSync(failingProcessPath, 0o755);

  try {
    const sink = createFfmpegSink({
      ffmpegPath: failingProcessPath,
      fps: 100,
      outputPath: join(directory, "unused.mp4"),
    });
    sink.accept(Buffer.alloc(1024 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 25));

    let observedError;
    await assert.rejects(sink.stop(), (error) => {
      observedError = error;
      return error.code === "encoder_failed";
    });
    assert.equal("diagnostic" in observedError, false);
    assert.doesNotMatch(
      JSON.stringify(observedError),
      /sensitive encoder diagnostic/,
    );
    assert.equal(existsSync(join(directory, "unused.mp4")), false);
    assert.equal(existsSync(join(directory, "unused.mp4.partial")), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("contains an asynchronous encoder spawn failure until stop observes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-spawn-"));
  const timeoutCount = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
  const timeoutsBeforeSpawn = timeoutCount();

  try {
    const sink = createFfmpegSink({
      ffmpegPath: join(directory, "missing-ffmpeg"),
      fps: 10,
      outputPath: join(directory, "unused.mp4"),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const timeoutsAfterFailure = timeoutCount();
    await assert.rejects(
      sink.stop(),
      (error) => error.code === "encoder_failed",
    );
    assert.equal(timeoutsAfterFailure, timeoutsBeforeSpawn);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("terminates the Browser session when the encoder exits early", async () => {
  const operations = [];
  let resolveEncoderCompletion;
  const sink = createMemorySink(operations);
  sink.completion = new Promise((resolve) => {
    resolveEncoderCompletion = resolve;
  });
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(operations),
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => sink,
  });

  await session.ready;
  resolveEncoderCompletion({ code: 7, error: null, signal: null });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    session.stop(),
    (error) => error.code === "encoder_failed",
  );
  assert.equal(
    operations.filter((operation) => operation === "Page.stopScreencast")
      .length,
    1,
  );
});

test("fails closed when an approved pointer flow captures no pointer event", async () => {
  const operations = [];
  const sink = createMemorySink(operations);
  let renderCalls = 0;
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(operations),
    cursorRenderer: async () => {
      renderCalls += 1;
      return { outputBytes: 1, outputPath: "/tmp/unused.mp4" };
    },
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    requirePointerEvents: true,
    sinkFactory: () => sink,
  });

  await session.ready;
  await assert.rejects(
    session.stop(),
    (error) => error.code === "cursor_recording_failed",
  );
  assert.equal(renderCalls, 0);
});

test("kills an encoder that does not close within the shutdown timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-timeout-"));
  const slowProcessPath = join(directory, "slow-exit.sh");
  writeFileSync(slowProcessPath, "#!/bin/sh\nsleep 0.15\nexit 0\n");
  chmodSync(slowProcessPath, 0o755);

  try {
    const sink = createFfmpegSink({
      ffmpegPath: slowProcessPath,
      fps: 10,
      outputPath: join(directory, "unused.mp4"),
      shutdownTimeoutMs: 20,
    });

    await assert.rejects(
      sink.stop(),
      (error) => error.code === "encoder_shutdown_timeout",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects malformed CDP event batches with a stable failure code", async () => {
  const pump = startFramePump({
    cdp: {
      async readEvents() {
        return { cursor: "not-a-cursor", events: null };
      },
      async send() {},
    },
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame: () => true,
    onTopFrameNavigation() {},
    readTimeoutMs: 1,
  });

  await assert.rejects(
    pump.ready,
    (error) => error.code === "event_stream_invalid",
  );
  await assert.rejects(
    pump.stop(),
    (error) => error.code === "event_stream_invalid",
  );
});

test("rejects a CDP event cursor that moves backwards", async () => {
  let reads = 0;
  const pump = startFramePump({
    cdp: {
      async readEvents() {
        reads += 1;
        if (reads === 1) {
          return {
            cursor: 2,
            events: [frameEvent()],
            hasMore: false,
            truncated: false,
          };
        }
        return {
          cursor: 1,
          events: [],
          hasMore: false,
          truncated: false,
        };
      },
      async send() {},
    },
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame: () => true,
    onTopFrameNavigation() {},
    readTimeoutMs: 1,
  });

  await pump.ready;
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    pump.stop(),
    (error) => error.code === "event_stream_invalid",
  );
});

test("validates the CDP boundary before starting a recording", async () => {
  await assert.rejects(
    startBrowserRecording({
      approvedOrigin: "https://example.com",
      cdp: {},
      ffmpegPath: "/unused/ffmpeg",
      fps: 10,
      maxDecodedBytes: 1024,
      outputPath: "/tmp/unused.mp4",
      readTimeoutMs: 1,
    }),
    (error) => error.code === "invalid_configuration",
  );
});

test("starts from a captured cursor and finalizes every recorder component", async () => {
  const operations = [];
  const streamedFrame = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  let acceptedFrame;
  let reads = 0;
  const cdp = {
    async send(method, params) {
      operations.push([method, params]);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/start" },
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        throw new Error("recording must consume the screencast frame directly");
      }
    },
    async readEvents(options) {
      reads += 1;
      operations.push(["readEvents", options]);
      if (reads === 1) {
        return { cursor: 41, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) {
        return {
          cursor: 42,
          events: [
            frameEvent({ data: streamedFrame.toString("base64") }),
          ],
          hasMore: false,
          truncated: false,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { cursor: 42, events: [], hasMore: false, truncated: false };
    },
  };
  const sink = {
    stats: { backpressureDrops: 0, encoderExitCode: null, outputSamples: 0 },
    accept(buffer) {
      operations.push(["accept", buffer.length]);
      acceptedFrame = Buffer.from(buffer);
      this.stats.outputSamples += 1;
      return true;
    },
    async stop() {
      operations.push(["sink.stop"]);
      this.stats.encoderExitCode = 0;
      return this.stats;
    },
  };
  let sinkFactoryOptions;

  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: (options) => {
      sinkFactoryOptions = options;
      return sink;
    },
  });

  await session.ready;
  const result = await session.stop();

  assert.equal(operations[0][0], "Page.enable");
  assert.equal(operations[1][0], "readEvents");
  assert.equal(operations[2][0], "Page.getFrameTree");
  assert.deepEqual(operations[3], [
    "Page.startScreencast",
    {
      everyNthFrame: 1,
      format: "jpeg",
      maxHeight: 720,
      maxWidth: 1280,
      quality: 70,
    },
  ]);
  assert.equal(
    operations.some(([name]) => name === "Page.captureScreenshot"),
    false,
  );
  assert.ok(
    operations.findIndex(([name]) => name === "Page.stopScreencast") <
      operations.findIndex(([name]) => name === "sink.stop"),
  );
  assert.equal(result.framesReceived, 1);
  assert.equal(result.framesAcknowledged, 1);
  assert.deepEqual(acceptedFrame, streamedFrame);
  assert.equal(result.outputSamples, 1);
  assert.equal(result.encoderExitCode, 0);
  assert.equal(result.maxObservedOutputBytes, 0);
  assert.equal(sinkFactoryOptions.maxOutputBytes, 500 * 1024 * 1024);
});

test("does not acknowledge buffered frames after shutdown begins", async () => {
  const bufferedFrame = deferred();
  const bufferedReadStarted = deferred();
  const operations = [];
  let reads = 0;
  let screencastStopped = false;
  const cdp = {
    async send(method, params) {
      operations.push([method, params]);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/start" },
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: jpeg.toString("base64") };
      }
      if (method === "Page.stopScreencast") {
        screencastStopped = true;
      }
      if (method === "Page.screencastFrameAck" && screencastStopped) {
        throw new Error("Cannot acknowledge a stopped screencast");
      }
    },
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 41, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) {
        return {
          cursor: 42,
          events: [frameEvent()],
          hasMore: false,
          truncated: false,
        };
      }
      if (reads === 3) {
        bufferedReadStarted.resolve();
        await bufferedFrame.promise;
        return {
          cursor: 43,
          events: [frameEvent({ sessionId: 8 })],
          hasMore: false,
          truncated: false,
        };
      }
      return { cursor: 43, events: [], hasMore: false, truncated: false };
    },
  };
  const sink = createMemorySink(operations);

  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => sink,
  });

  await session.ready;
  await bufferedReadStarted.promise;
  const stopped = session.stop();
  bufferedFrame.resolve();
  const result = await stopped;

  assert.equal(result.framesReceived, 1);
  assert.equal(result.framesAcknowledged, 1);
  assert.equal(
    operations.filter(([method]) => method === "Page.screencastFrameAck")
      .length,
    1,
  );
});

test("still enforces a buffered top-frame navigation during shutdown", async () => {
  const bufferedBatch = deferred();
  const bufferedReadStarted = deferred();
  const policyError = Object.assign(new Error("Origin changed"), {
    code: "origin_changed_during_recording",
  });
  let reads = 0;
  const pump = startFramePump({
    cdp: {
      async readEvents() {
        reads += 1;
        if (reads === 1) {
          return {
            cursor: 1,
            events: [frameEvent()],
            hasMore: false,
            truncated: false,
          };
        }
        bufferedReadStarted.resolve();
        return bufferedBatch.promise;
      },
      async send() {},
    },
    maxDecodedBytes: 1024,
    onFrame: () => true,
    onTopFrameNavigation() {
      throw policyError;
    },
    readTimeoutMs: 1,
  });

  await pump.ready;
  await bufferedReadStarted.promise;
  const stopping = pump.stop();
  bufferedBatch.resolve({
    cursor: 2,
    events: [
      {
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: "replacement-main",
            url: "https://other.example/",
          },
        },
      },
    ],
    hasMore: false,
    truncated: false,
  });

  await assert.rejects(stopping, (error) => error === policyError);
});

test("keeps recording after same-origin top-frame navigation", async () => {
  const harness = createNavigationSessionHarness({
    approvedOrigin: "https://example.com",
    frameTree: {
      frameTree: {
        frame: { id: "main", url: "https://example.com/start" },
      },
    },
  });
  const session = await harness.start();
  harness.publishFrame();
  await session.ready;
  harness.publishNavigation({ id: "main", url: "https://example.com/next" });
  harness.publishFrame();
  await harness.flush();

  const result = await session.stop();
  assert.equal(result.framesReceived, 2);
});

test("discards output after cross-origin top-frame navigation", async () => {
  const harness = createNavigationSessionHarness({
    approvedOrigin: "https://example.com",
    frameTree: {
      frameTree: {
        frame: { id: "main", url: "https://example.com/start" },
      },
    },
  });
  const session = await harness.start();
  harness.publishFrame();
  await session.ready;
  harness.publishNavigation({ id: "main", url: "https://other.example/" });

  const outcome = await session.completion;
  assert.equal(outcome.error.code, "origin_changed_during_recording");
  await assert.rejects(
    session.stop(),
    (error) => error.code === "origin_changed_during_recording",
  );
  assert.equal(harness.sinkStopOptions.discard, true);
});

test("rejects cross-origin navigation before accepting the first streamed frame", async () => {
  const harness = createNavigationSessionHarness({
    approvedOrigin: "https://example.com",
    frameTree: {
      frameTree: {
        frame: { id: "main", url: "https://example.com/start" },
      },
    },
  });
  const session = await harness.start();
  harness.publishNavigation({ id: "main", url: "https://other.example/" });
  harness.publishFrame();

  await assert.rejects(
    session.ready,
    (error) => error.code === "origin_changed_during_recording",
  );
  await assert.rejects(
    session.stop(),
    (error) => error.code === "origin_changed_during_recording",
  );
  assert.equal(
    harness.operations.filter(([method]) => method === "Page.captureScreenshot")
      .length,
    0,
  );
  assert.equal(harness.sinkStopOptions.discard, true);
});

test("rejects cross-origin navigation before a later streamed frame", async () => {
  const frameTree = {
    frameTree: {
      frame: { id: "main", url: "https://example.com/start" },
    },
  };
  const cdp = createQueuedCdp({ frameTree });
  let framesAccepted = 0;
  const sink = createMemorySink();
  sink.accept = () => {
    framesAccepted += 1;
    return true;
  };
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 0,
    sinkFactory: () => sink,
  });
  cdp.publish(frameEvent());
  await session.ready;
  frameTree.frameTree.frame.url = "https://other.example/";
  cdp.publish({
    method: "Page.frameNavigated",
    params: { frame: { id: "main", url: "https://other.example/" } },
  });
  cdp.publish(frameEvent({ sessionId: 8 }));

  const outcome = await session.completion;
  assert.equal(outcome.error.code, "origin_changed_during_recording");
  await assert.rejects(
    session.stop(),
    (error) => error.code === "origin_changed_during_recording",
  );
  assert.equal(framesAccepted, 1);
});

test("reverifies the top-level origin before successful finalization", async () => {
  const frameTree = {
    frameTree: {
      frame: { id: "main", url: "https://example.com/start" },
    },
  };
  const harness = createNavigationSessionHarness({
    approvedOrigin: "https://example.com",
    frameTree,
  });
  const session = await harness.start();
  harness.publishFrame();
  await session.ready;
  frameTree.frameTree.frame = {
    id: "replacement-main",
    url: "https://other.example/",
  };

  await assert.rejects(
    session.stop(),
    (error) => error.code === "origin_changed_during_recording",
  );
  assert.equal(harness.sinkStopOptions.discard, true);
});

test("preserves cross-origin failure when screencast cleanup also fails", async () => {
  const cleanupSecret = "private stop-screencast diagnostic";
  const harness = createNavigationSessionHarness({
    approvedOrigin: "https://example.com",
    frameTree: {
      frameTree: {
        frame: { id: "main", url: "https://example.com/start" },
      },
    },
    stopScreencastError: new Error(cleanupSecret),
  });
  const session = await harness.start();
  harness.publishFrame();
  await session.ready;
  harness.publishNavigation({ id: "main", url: "https://other.example/" });

  const outcome = await session.completion;
  assert.equal(outcome.error.code, "origin_changed_during_recording");
  assert.doesNotMatch(
    `${outcome.error.message}\n${JSON.stringify(outcome.error)}`,
    /private stop-screencast diagnostic/,
  );
  await assert.rejects(
    session.stop(),
    (error) => error.code === "origin_changed_during_recording",
  );
  assert.equal(harness.sinkStopOptions.discard, true);
});

test("fails readiness when no screencast frame arrives before the timeout", async () => {
  const operations = [];
  let reads = 0;
  const cdp = {
    async send(method) {
      operations.push(method);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/start" },
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: jpeg.toString("base64") };
      }
    },
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 5, events: [], hasMore: false, truncated: false };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { cursor: 5, events: [], hasMore: false, truncated: false };
    },
  };
  const sink = {
    stats: { backpressureDrops: 0, encoderExitCode: null, outputSamples: 0 },
    accept: () => true,
    async stop(options) {
      operations.push(["sink.stop.options", options]);
      operations.push("sink.stop");
      this.stats.encoderExitCode = 0;
      return this.stats;
    },
  };
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 5,
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => sink,
  });

  try {
    await assert.rejects(
      session.ready,
      (error) => error.code === "frame_stream_unavailable",
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      operations.filter((operation) => operation === "Page.stopScreencast")
        .length,
      1,
    );
    assert.deepEqual(
      operations.find(
        (operation) =>
          Array.isArray(operation) && operation[0] === "sink.stop.options",
      ),
      ["sink.stop.options", { discard: true }],
    );
    assert.equal(
      operations.filter((operation) => operation === "sink.stop").length,
      1,
    );
  } finally {
    await assert.rejects(
      session.stop(),
      (error) => error.code === "frame_stream_unavailable",
    );
  }
});

test("does not depend on a separate page screenshot for readiness", async () => {
  const cdp = createLiveCdp();
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (method === "Page.captureScreenshot") {
      throw new Error("Page.captureScreenshot must not be called");
    }
    return send(method, params);
  };
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 20,
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => createMemorySink(),
  });

  await session.ready;
  const result = await session.stop();
  assert.equal(result.framesReceived, 1);
});

test("excludes startup wait from capture time with a monotonic clock", async () => {
  const clockValues = [100, 120, 160];
  let reads = 0;
  const cdp = {
    async send(method) {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/start" },
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: jpeg.toString("base64") };
      }
    },
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 1, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) {
        return {
          cursor: 2,
          events: [frameEvent()],
          hasMore: false,
          truncated: false,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { cursor: 2, events: [], hasMore: false, truncated: false };
    },
  };
  const sink = {
    stats: { backpressureDrops: 0, encoderExitCode: null, outputSamples: 1 },
    accept: () => true,
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.stats.encoderExitCode = 0;
      return this.stats;
    },
  };
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    now: () => clockValues.shift(),
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => sink,
  });

  await session.ready;
  const result = await session.stop();

  assert.equal(result.elapsedMs, 20);
});

test("stops screencasting when encoder startup fails", async () => {
  const operations = [];
  const startupError = new Error("Encoder startup failed");
  const cdp = {
    async readEvents() {
      return { cursor: 8, events: [], hasMore: false, truncated: false };
    },
    async send(method) {
      operations.push(method);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/start" },
          },
        };
      }
    },
  };

  await assert.rejects(
    startBrowserRecording({
      approvedOrigin: "https://example.com",
      cdp,
      ffmpegPath: "/unused/ffmpeg",
      fps: 10,
      maxDecodedBytes: 1024,
      outputPath: "/tmp/unused.mp4",
      readTimeoutMs: 1,
      sinkFactory: () => {
        throw startupError;
      },
    }),
    (error) => error === startupError,
  );

  assert.deepEqual(operations, [
    "Page.enable",
    "Page.getFrameTree",
    "Page.startScreencast",
    "Page.stopScreencast",
  ]);
});

test("retains cancellation while Page.enable startup is pending", async () => {
  const abortController = new AbortController();
  const enableGate = deferred();
  const operations = [];
  let reads = 0;
  let sinkCreations = 0;
  const starting = startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: {
      async readEvents() {
        reads += 1;
        if (reads === 1) {
          return { cursor: 1, events: [], hasMore: false, truncated: false };
        }
        return {
          cursor: 2,
          events: [frameEvent()],
          hasMore: false,
          truncated: false,
        };
      },
      async send(method) {
        operations.push(method);
        if (method === "Page.enable") await enableGate.promise;
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/start" },
            },
          };
        }
      },
    },
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 10,
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    signal: abortController.signal,
    sinkFactory: () => {
      sinkCreations += 1;
      return createMemorySink(operations);
    },
  });

  await Promise.resolve();
  assert.deepEqual(operations, ["Page.enable"]);
  abortController.abort();

  let leakedSession;
  try {
    assert.equal(
      await Promise.race([
        starting.then(
          () => "resolved",
          (error) => error.code,
        ),
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]),
      "recording_cancelled",
    );
    await assert.rejects(
      starting,
      (error) => error.code === "recording_cancelled",
    );
  } finally {
    enableGate.resolve();
    leakedSession = await starting.catch(() => null);
    const leakedReady = leakedSession?.ready.catch(() => {});
    await leakedSession?.stop();
    await leakedReady;
  }
  assert.equal(sinkCreations, 0);
  assert.deepEqual(operations, ["Page.enable"]);
});

test("keeps cancellation primary after screencast startup cleanup fails", async () => {
  const abortController = new AbortController();
  const screencastGate = deferred();
  const cleanupSecret = "private cancelled-startup cleanup diagnostic";
  const operations = [];
  let sinkCreations = 0;
  const starting = startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: {
      async readEvents() {
        return { cursor: 1, events: [], hasMore: false, truncated: false };
      },
      async send(method) {
        operations.push(method);
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/start" },
            },
          };
        }
        if (method === "Page.startScreencast") {
          await screencastGate.promise;
        }
        if (method === "Page.stopScreencast") {
          throw new Error(cleanupSecret);
        }
      },
    },
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 10,
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    signal: abortController.signal,
    sinkFactory: () => {
      sinkCreations += 1;
      return createMemorySink(operations);
    },
  });

  while (!operations.includes("Page.startScreencast")) await Promise.resolve();
  abortController.abort();
  screencastGate.resolve();

  let leakedSession;
  try {
    await assert.rejects(starting, (error) => {
      assert.equal(error.code, "recording_cancelled");
      assert.doesNotMatch(
        `${error.message}\n${JSON.stringify(error)}`,
        /private cancelled-startup cleanup diagnostic/,
      );
      return true;
    });
  } finally {
    leakedSession = await starting.catch(() => null);
    const leakedReady = leakedSession?.ready.catch(() => {});
    await leakedSession?.stop().catch(() => {});
    await leakedReady;
  }
  assert.equal(sinkCreations, 0);
  assert.equal(
    operations.filter((operation) => operation === "Page.stopScreencast")
      .length,
    1,
  );
});

test("discards a created sink when cancellation lands during startup handoff", async () => {
  const abortController = new AbortController();
  const operations = [];
  const sinkStopOptions = [];
  const sink = createMemorySink(operations);
  sink.stop = async (options) => {
    sinkStopOptions.push(options);
    operations.push("sink.stop");
    sink.stats.encoderExitCode = 0;
    return sink.stats;
  };
  const starting = startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(operations),
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 10,
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    signal: abortController.signal,
    sinkFactory: () => {
      abortController.abort();
      return sink;
    },
  });

  let leakedSession;
  try {
    await assert.rejects(
      starting,
      (error) => error.code === "recording_cancelled",
    );
  } finally {
    leakedSession = await starting.catch(() => null);
    const leakedReady = leakedSession?.ready.catch(() => {});
    await leakedSession?.stop();
    await leakedReady;
  }
  assert.equal(
    operations.filter((operation) => operation === "Page.stopScreencast")
      .length,
    1,
  );
  assert.equal(
    operations.filter((operation) => operation === "sink.stop").length,
    1,
  );
  assert.deepEqual(sinkStopOptions, [{ discard: true }]);
});

test("cancels and cleans up an active recording through AbortSignal", async () => {
  const operations = [];
  const abortController = new AbortController();
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(operations),
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    signal: abortController.signal,
    sinkFactory: () => createMemorySink(operations),
  });

  await session.ready;
  abortController.abort();

  await assert.rejects(
    session.stop(),
    (error) => error.code === "recording_cancelled",
  );
  assert.equal(
    operations.filter((operation) => operation === "Page.stopScreencast")
      .length,
    1,
  );
  assert.equal(
    operations.filter((operation) => operation === "sink.stop").length,
    1,
  );
});

test("stops a recording at the configured duration limit", async () => {
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(),
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    maxDurationMs: 15,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => createMemorySink(),
  });

  await session.ready;
  await new Promise((resolve) => setTimeout(resolve, 25));

  await assert.rejects(
    session.stop(),
    (error) => error.code === "recording_duration_limit",
  );
});

test("arms the duration limit only after the first frame is ready", async () => {
  const cdp = createQueuedCdp();
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 100,
    fps: 10,
    maxDecodedBytes: 1024,
    maxDurationMs: 20,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 0,
    sinkFactory: () => createMemorySink(),
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  cdp.publish(frameEvent());
  await session.ready;
  const earlyOutcome = await Promise.race([
    session.completion.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("recording"), 10)),
  ]);

  assert.equal(earlyOutcome, "recording");
  const outcome = await session.completion;
  assert.equal(outcome.error.code, "recording_duration_limit");
});

test("stops when the configured output size limit is exceeded", async () => {
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(),
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    getOutputSize: async () => 101,
    maxDecodedBytes: 1024,
    maxOutputBytes: 100,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    resourceCheckIntervalMs: 5,
    sinkFactory: () => createMemorySink(),
  });

  await session.ready;
  await new Promise((resolve) => setTimeout(resolve, 15));

  await assert.rejects(
    session.stop(),
    (error) => error.code === "recording_output_limit",
  );
  assert.equal(session.stats.resources.maxObservedOutputBytes, 101);
});

test("keeps recording a static page after its first screencast frame", async () => {
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(),
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    resourceCheckIntervalMs: 5,
    sinkFactory: () => createMemorySink(),
  });

  await session.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = await session.stop();

  assert.equal(result.encoderExitCode, 0);
  assert.equal(result.framesReceived, 1);
  assert.equal(result.terminationReason, null);
});

test("seeds a static recording from the first streamed frame", async () => {
  const streamedFrame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const acceptedFrames = [];
  const sink = createMemorySink();
  sink.accept = (frame) => {
    acceptedFrames.push(frame);
    sink.stats.outputSamples += 1;
    return true;
  };
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp([], streamedFrame),
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => sink,
  });

  await session.ready;
  await session.stop();

  assert.deepEqual(acceptedFrames.at(-1), streamedFrame);
});

test("passes every acknowledged screencast frame directly to the sink", async () => {
  const firstFrame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const laterFrame = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0xff, 0xd9]);
  const laterFrameAcknowledged = deferred();
  const laterFrameAccepted = deferred();
  const acknowledgements = [];
  const acceptedFrames = [];
  const cdp = createQueuedCdp();
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (method === "Page.screencastFrameAck") {
      acknowledgements.push(params.sessionId);
      if (params.sessionId === 8) laterFrameAcknowledged.resolve();
    }
    return send(method, params);
  };
  const sink = createMemorySink();
  sink.accept = (frame) => {
    acceptedFrames.push(frame);
    sink.stats.outputSamples += 1;
    if (acceptedFrames.length === 2) laterFrameAccepted.resolve();
    return true;
  };
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => sink,
  });

  cdp.publish(
    frameEvent({ data: firstFrame.toString("base64"), sessionId: 7 }),
  );
  cdp.publish(
    frameEvent({ data: laterFrame.toString("base64"), sessionId: 8 }),
  );
  await session.ready;
  await laterFrameAcknowledged.promise;
  await laterFrameAccepted.promise;
  await session.stop();

  assert.deepEqual(acknowledgements, [7, 8]);
  assert.deepEqual(acceptedFrames, [firstFrame, laterFrame]);
});

test("fails closed when the first streamed frame is malformed", async () => {
  const privateDiagnostic = "private-frame-diagnostic";
  const cdp = createQueuedCdp();
  const stopOptions = [];
  const sink = createMemorySink();
  sink.stop = async (options) => {
    stopOptions.push(options);
    sink.stats.encoderExitCode = 0;
    return sink.stats;
  };
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 5,
    fps: 10,
    maxDecodedBytes: 1024,
    outputPath: "/tmp/unused.mp4",
    readTimeoutMs: 1,
    sinkFactory: () => sink,
  });
  cdp.publish(frameEvent({ data: privateDiagnostic }));

  await assert.rejects(session.ready, (error) => {
    assert.equal(error.code, "frame_stream_unavailable");
    assert.doesNotMatch(
      `${error.message}\n${JSON.stringify(error)}`,
      /private-frame-diagnostic/,
    );
    return true;
  });
  await assert.rejects(
    session.stop(),
    (error) => error.code === "frame_stream_unavailable",
  );
  assert.deepEqual(stopOptions, [{ discard: true }]);
});
