import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  assertTopLevelUrl,
  cleanupPreparedBrowserPoc,
  finalizeBrowserPoc,
  prepareBrowserPoc,
  runBrowserPocGate,
  startBrowserPocForTab,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "browser-poc-result-test-"));
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

test.after(() => {
  rmSync(temporaryRoot, { force: true, recursive: true });
});

function captureResult(overrides = {}) {
  return {
    backpressureDrops: 0,
    elapsedMs: 500,
    encoderExitCode: 0,
    framesAcknowledged: 5,
    framesDropped: 0,
    framesReceived: 5,
    invalidFrames: 0,
    lastFrameTimestamp: 123.5,
    outputSamples: 5,
    truncations: 0,
    visibilityChanges: 0,
    visibilityState: true,
    ...overrides,
  };
}

function sessionWithResult(overrides = {}) {
  return {
    async stop() {
      return captureResult(overrides);
    },
  };
}

function finalizePrepared(paths, session, overrides = {}) {
  return finalizeBrowserPoc({
    durationToleranceSeconds: 0.25,
    ffprobePath,
    maxHeight: 720,
    maxWidth: 1280,
    minBytes: 100,
    outputPath: paths.outputPath,
    resultPath: paths.resultPath,
    session,
    ...overrides,
  });
}

test("prepares unique private paths under the configured temporary root", async () => {
  const first = await prepareBrowserPoc({ temporaryRoot });
  const second = await prepareBrowserPoc({ temporaryRoot });

  assert.notEqual(first.directory, second.directory);
  assert.equal(dirname(first.outputPath), first.directory);
  assert.equal(dirname(first.resultPath), first.directory);
  assert.equal(basename(first.outputPath), "recording.webm");
  assert.equal(basename(first.resultPath), "result.json");
  assert.equal(first.directory.startsWith(`${temporaryRoot}/`), true);
  assert.equal(statSync(first.directory).mode & 0o077, 0);
});

test("removes a prepared recording directory as one cleanup unit", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "browser-recorder-cleanup-"));
  try {
    const paths = await prepareBrowserPoc({ temporaryRoot });
    writeFileSync(`${paths.outputPath}.partial`, "partial");

    await cleanupPreparedBrowserPoc(paths);
    assert.equal(existsSync(paths.directory), false);

    await cleanupPreparedBrowserPoc(paths);
    assert.equal(existsSync(paths.directory), false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("finalizes a valid capture into a sanitized private JSON result", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  execFileSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x180:d=0.5",
    "-an",
    "-c:v",
    "libvpx",
    "-pix_fmt",
    "yuv420p",
    "-y",
    paths.outputPath,
  ]);
  const session = sessionWithResult({
    backpressureDrops: 2,
    framesDropped: 1,
    outputPath: paths.outputPath,
    secretPageValue: "must-not-persist",
    visibilityChanges: 1,
    visibilityState: false,
  });
  const result = await finalizePrepared(paths, session);
  const rawResult = readFileSync(paths.resultPath, "utf8");
  const persisted = JSON.parse(rawResult);

  assert.deepEqual(persisted, result);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.status, "passed");
  assert.equal(result.failureCode, null);
  assert.equal(result.videoFile, "recording.webm");
  assert.equal(result.capture.framesReceived, 5);
  assert.equal(result.validation.width, 320);
  assert.equal(result.validation.height, 180);
  assert.equal(rawResult.includes(temporaryRoot), false);
  assert.equal(rawResult.includes("must-not-persist"), false);
  assert.equal(statSync(paths.resultPath).mode & 0o077, 0);
});

test("persists a sanitized failed result when video validation fails", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  const session = sessionWithResult({
    framesAcknowledged: 0,
    framesReceived: 0,
    lastFrameTimestamp: null,
    outputSamples: 0,
    visibilityState: null,
  });
  const result = await finalizePrepared(paths, session);
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.deepEqual(JSON.parse(rawResult), result);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "output_missing");
  assert.equal(result.validation, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
});

test("persists available counters without encoder diagnostics when capture fails", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  const session = {
    stats: {
      framePump: {
        framesAcknowledged: 3,
        framesDropped: 1,
        framesReceived: 3,
        invalidFrames: 0,
        lastFrameTimestamp: 456.5,
        truncations: 0,
        visibilityChanges: 1,
        visibilityState: true,
      },
      sink: {
        backpressureDrops: 2,
        encoderExitCode: 7,
        outputSamples: 4,
      },
    },
    async stop() {
      const error = new Error(`Encoder failed near ${temporaryRoot}`);
      error.code = "encoder_failed";
      error.diagnostic = `sensitive diagnostic from ${temporaryRoot}`;
      throw error;
    },
  };

  const result = await finalizePrepared(paths, session);
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.deepEqual(JSON.parse(rawResult), result);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "encoder_failed");
  assert.equal(result.capture.elapsedMs, null);
  assert.equal(result.capture.framesReceived, 3);
  assert.equal(result.capture.encoderExitCode, 7);
  assert.equal(result.validation, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
  assert.equal(rawResult.includes("sensitive diagnostic"), false);
});

test("persists sanitized resource-limit telemetry when capture is terminated", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  const session = {
    stats: {
      framePump: captureResult({ elapsedMs: undefined }),
      resources: {
        elapsedMs: 42,
        maxObservedOutputBytes: 2048,
        terminationReason: "recording_output_limit",
      },
      sink: {
        backpressureDrops: 0,
        encoderExitCode: 0,
        outputSamples: 3,
      },
    },
    async stop() {
      const error = new Error("Output limit reached");
      error.code = "recording_output_limit";
      throw error;
    },
  };

  const result = await finalizePrepared(paths, session);

  assert.equal(result.failureCode, "recording_output_limit");
  assert.equal(result.capture.elapsedMs, 42);
  assert.equal(result.capture.maxObservedOutputBytes, 2048);
  assert.equal(result.capture.terminationReason, "recording_output_limit");
});

test("preserves a sanitized readiness failure after stopping the session", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  const captureError = new Error(`No frames from ${temporaryRoot}`);
  captureError.code = "frame_stream_unavailable";
  const session = sessionWithResult({
    elapsedMs: 25,
    framesAcknowledged: 0,
    framesReceived: 0,
    lastFrameTimestamp: null,
    outputSamples: 0,
    visibilityState: null,
  });
  const result = await finalizePrepared(paths, session, { captureError });
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "frame_stream_unavailable");
  assert.equal(result.validation, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
});

test("persists the multiple-video-stream validation failure", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  execFileSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x90:d=0.5",
    "-map",
    "0:v:0",
    "-map",
    "1:v:0",
    "-an",
    "-c:v",
    "libvpx",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    "-y",
    paths.outputPath,
  ]);
  const result = await finalizePrepared(
    paths,
    sessionWithResult({ lastFrameTimestamp: 789.5 }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "video_stream_count_invalid");
  assert.equal(result.validation, null);
});

test("persists every strict media-contract failure code", async () => {
  const variants = [
    {
      code: "container_invalid",
      outputArguments: ["-an", "-c:v", "libvpx", "-f", "matroska"],
    },
    {
      code: "codec_invalid",
      outputArguments: ["-an", "-c:v", "libvpx-vp9"],
    },
    {
      code: "audio_stream_present",
      extraInput: ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono"],
      outputArguments: ["-t", "0.5", "-c:v", "libvpx", "-c:a", "libopus"],
    },
  ];

  for (const variant of variants) {
    const paths = await prepareBrowserPoc({ temporaryRoot });
    execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=0.5",
      ...(variant.extraInput ?? []),
      ...variant.outputArguments,
      "-pix_fmt",
      "yuv420p",
      "-y",
      paths.outputPath,
    ]);

    const result = await finalizePrepared(paths, sessionWithResult());
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, variant.code);
    assert.equal(result.validation, null);
  }
});

test("accepts only the exact approved top-level URL", async () => {
  const methods = [];
  const cdp = {
    async send(method) {
      methods.push(method);
      return {
        frameTree: { frame: { url: "https://example.com/" } },
      };
    },
  };

  assert.equal(
    await assertTopLevelUrl({
      cdp,
      expectedUrl: "https://example.com/",
    }),
    true,
  );
  assert.deepEqual(methods, ["Page.getFrameTree"]);
});

test("rejects a different URL without exposing it", async () => {
  const secretUrl = "https://example.com/?token=must-not-leak";
  const cdp = {
    async send() {
      return { frameTree: { frame: { url: secretUrl } } };
    },
  };

  await assert.rejects(
    assertTopLevelUrl({ cdp, expectedUrl: "https://example.com/" }),
    (error) =>
      error.code === "origin_not_allowed" &&
      !error.message.includes(secretUrl) &&
      !JSON.stringify(error).includes(secretUrl),
  );
});

test("maps missing or failed frame-tree inspection to a stable error", async () => {
  for (const send of [
    async () => ({}),
    async () => {
      throw new Error("raw CDP diagnostic");
    },
  ]) {
    await assert.rejects(
      assertTopLevelUrl({
        cdp: { send },
        expectedUrl: "https://example.com/",
      }),
      (error) =>
        error.code === "origin_verification_failed" &&
        !error.message.includes("raw CDP diagnostic"),
    );
  }
});

test("acquires a fresh CDP capability for every recording session", async () => {
  const acquired = [];
  const commandOrders = [];
  const createdCdps = [];
  const tab = {
    capabilities: {
      async get(name) {
        acquired.push(name);
        const methods = [];
        let reads = 0;
        const cdp = {
          async send(method) {
            methods.push(method);
            if (method === "Page.getFrameTree") {
              return {
                frameTree: { frame: { url: "https://example.com/" } },
              };
            }
          },
          async readEvents() {
            reads += 1;
            if (reads === 1) {
              return {
                cursor: 1,
                events: [],
                hasMore: false,
                truncated: false,
              };
            }
            if (reads === 2) {
              return {
                cursor: 2,
                events: [
                  {
                    method: "Page.screencastFrame",
                    params: {
                      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString(
                        "base64",
                      ),
                      metadata: { timestamp: 1 },
                      sessionId: 1,
                    },
                  },
                ],
                hasMore: false,
                truncated: false,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            return {
              cursor: 2,
              events: [],
              hasMore: false,
              truncated: false,
            };
          },
        };
        commandOrders.push(methods);
        createdCdps.push(cdp);
        return cdp;
      },
    },
  };

  for (let index = 0; index < 2; index += 1) {
    const session = await startBrowserPocForTab({
      expectedTopLevelUrl: "https://example.com/",
      ffmpegPath: "/unused/ffmpeg",
      fps: 10,
      maxDecodedBytes: 1024,
      outputPath: `/tmp/unused-${index}.webm`,
      readTimeoutMs: 1,
      sinkFactory: () => ({
        stats: {
          backpressureDrops: 0,
          encoderExitCode: null,
          outputSamples: 0,
        },
        accept() {
          this.stats.outputSamples += 1;
          return true;
        },
        async stop() {
          this.stats.encoderExitCode = 0;
          return this.stats;
        },
      }),
      tab,
    });
    await session.ready;
    await session.stop();
  }

  assert.deepEqual(acquired, ["cdp", "cdp"]);
  assert.notEqual(createdCdps[0], createdCdps[1]);
  assert.deepEqual(
    commandOrders.map((methods) => methods.slice(0, 3)),
    [
      ["Page.getFrameTree", "Page.enable", "Page.startScreencast"],
      ["Page.getFrameTree", "Page.enable", "Page.startScreencast"],
    ],
  );
});

test("runs a complete recording gate and writes a validated result", async () => {
  let reads = 0;
  const tab = {
    capabilities: {
      async get() {
        return {
          async send() {},
          async readEvents() {
            reads += 1;
            if (reads === 1) {
              return {
                cursor: 1,
                events: [],
                hasMore: false,
                truncated: false,
              };
            }
            if (reads === 2) {
              return {
                cursor: 2,
                events: [
                  {
                    method: "Page.screencastFrame",
                    params: {
                      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString(
                        "base64",
                      ),
                      metadata: { timestamp: 1 },
                      sessionId: 1,
                    },
                  },
                ],
                hasMore: false,
                truncated: false,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            return {
              cursor: 2,
              events: [],
              hasMore: false,
              truncated: false,
            };
          },
        };
      },
    },
  };

  const gate = await runBrowserPocGate({
    durationToleranceSeconds: 1,
    ffmpegPath,
    ffprobePath,
    fps: 10,
    maxDecodedBytes: 1024,
    maxHeight: 720,
    maxWidth: 1280,
    minBytes: 100,
    readTimeoutMs: 1,
    recordingDurationMs: 10,
    sinkFactory: ({ outputPath }) => ({
      stats: {
        backpressureDrops: 0,
        encoderExitCode: null,
        outputSamples: 1,
      },
      accept: () => true,
      async stop() {
        execFileSync(ffmpegPath, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=purple:s=320x180:d=0.2",
          "-an",
          "-c:v",
          "libvpx",
          "-pix_fmt",
          "yuv420p",
          "-y",
          outputPath,
        ]);
        this.stats.encoderExitCode = 0;
        return this.stats;
      },
    }),
    tab,
    temporaryRoot,
  });

  assert.equal(gate.result.status, "passed");
  assert.equal(gate.result.validation.codecName, "vp8");
  assert.equal(readFileSync(gate.paths.resultPath, "utf8").length > 0, true);
});

test("cancels the recording-window timer after an automatic limit", async () => {
  let reads = 0;
  const tab = {
    capabilities: {
      async get() {
        return {
          async send() {},
          async readEvents() {
            reads += 1;
            if (reads === 1) {
              return {
                cursor: 1,
                events: [],
                hasMore: false,
                truncated: false,
              };
            }
            if (reads === 2) {
              return {
                cursor: 2,
                events: [
                  {
                    method: "Page.screencastFrame",
                    params: {
                      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString(
                        "base64",
                      ),
                      metadata: { timestamp: 1 },
                      sessionId: 1,
                    },
                  },
                ],
                hasMore: false,
                truncated: false,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            return {
              cursor: 2,
              events: [],
              hasMore: false,
              truncated: false,
            };
          },
        };
      },
    },
  };
  const timeoutCount = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
  const before = timeoutCount();

  const gate = await runBrowserPocGate({
    durationToleranceSeconds: 1,
    ffmpegPath,
    ffprobePath,
    fps: 10,
    maxDecodedBytes: 1024,
    maxDurationMs: 15,
    maxHeight: 720,
    maxWidth: 1280,
    minBytes: 100,
    readTimeoutMs: 1,
    recordingDurationMs: 1000,
    sinkFactory: () => ({
      stats: {
        backpressureDrops: 0,
        encoderExitCode: null,
        outputSamples: 1,
      },
      accept: () => true,
      async stop() {
        this.stats.encoderExitCode = 0;
        return this.stats;
      },
    }),
    tab,
    temporaryRoot,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(gate.result.failureCode, "recording_duration_limit");
  assert.equal(timeoutCount(), before);
});
