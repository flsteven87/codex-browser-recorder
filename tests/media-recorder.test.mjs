import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
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
import { startBrowserRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

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

function createLiveCdp(operations = []) {
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
          events: [frameEvent()],
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
  const cdp = createQueuedCdp({ frameTree });
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
        outputPath: "/tmp/unused.webm",
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

test("samples the latest JPEG into a parseable fixed-rate WebM", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-test-"));
  const outputPath = join(directory, "sample.webm");

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
    assert.equal(probe.streams[0].codec_name, "vp8");
    assert.equal(probe.streams[0].width, 320);
    assert.equal(probe.streams[0].height, 180);
    assert.ok(Number.parseFloat(probe.format.duration) > 0);
    assert.equal(existsSync(`${outputPath}.partial`), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("discards the partial video instead of publishing a failed capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-discard-"));
  const outputPath = join(directory, "discarded.webm");

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
  const outputPath = join(directory, "oversized.webm");

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
      outputPath: join(directory, "unused.webm"),
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
      outputPath: join(directory, "unused.webm"),
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
    assert.equal(existsSync(join(directory, "unused.webm")), false);
    assert.equal(existsSync(join(directory, "unused.webm.partial")), false);
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
      outputPath: join(directory, "unused.webm"),
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
    outputPath: "/tmp/unused.webm",
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

test("kills an encoder that does not close within the shutdown timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-recorder-timeout-"));
  const slowProcessPath = join(directory, "slow-exit.sh");
  writeFileSync(slowProcessPath, "#!/bin/sh\nsleep 0.15\nexit 0\n");
  chmodSync(slowProcessPath, 0o755);

  try {
    const sink = createFfmpegSink({
      ffmpegPath: slowProcessPath,
      fps: 10,
      outputPath: join(directory, "unused.webm"),
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
      outputPath: "/tmp/unused.webm",
      readTimeoutMs: 1,
    }),
    (error) => error.code === "invalid_configuration",
  );
});

test("starts from a captured cursor and finalizes every recorder component", async () => {
  const operations = [];
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
          events: [frameEvent()],
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
    outputPath: "/tmp/unused.webm",
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
  assert.ok(
    operations.findIndex(([name]) => name === "Page.stopScreencast") <
      operations.findIndex(([name]) => name === "sink.stop"),
  );
  assert.equal(result.framesReceived, 1);
  assert.equal(result.framesAcknowledged, 1);
  assert.equal(result.outputSamples, 1);
  assert.equal(result.encoderExitCode, 0);
  assert.equal(result.maxObservedOutputBytes, 0);
  assert.equal(sinkFactoryOptions.maxOutputBytes, 500 * 1024 * 1024);
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
    outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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
      outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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
    outputPath: "/tmp/unused.webm",
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

test("stops when fresh source frames exceed the configured stall limit", async () => {
  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp: createLiveCdp(),
    ffmpegPath: "/unused/ffmpeg",
    fps: 10,
    maxDecodedBytes: 1024,
    maxFrameStallMs: 10,
    outputPath: "/tmp/unused.webm",
    readTimeoutMs: 1,
    resourceCheckIntervalMs: 5,
    sinkFactory: () => createMemorySink(),
  });

  await session.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));

  await assert.rejects(
    session.stop(),
    (error) => error.code === "frame_stream_stalled",
  );
});
