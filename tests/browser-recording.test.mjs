import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  describeRecordingFailure,
  getRecordingCleanupDetails,
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";
import {
  inspectTopLevelFrame,
  startBrowserRecordingForTab as startBrowserRecordingForTabProduction,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs";
import { createRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";

async function createTestCursorCapture({ now }) {
  const startedAt = now();
  return {
    completion: new Promise(() => {}),
    stats: { cursorEventsCaptured: 0, cursorFramesObserved: 1 },
    async stop() {
      return {
        durationMs: Math.max(1, now() - startedAt),
        events: [],
        viewport: { height: 720, width: 1280 },
      };
    },
  };
}

function startBrowserRecordingForTab(options) {
  return startBrowserRecordingForTabProduction({
    ...options,
    cursorCaptureFactory:
      options.cursorCaptureFactory ?? createTestCursorCapture,
    cursorRenderer:
      options.cursorRenderer ??
      (async ({ outputPath }) => ({ outputBytes: 0, outputPath })),
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

function createHarness({
  cleanupError,
  completion,
  finalizeGate,
  finalResult,
  ready = Promise.resolve(),
  startError,
} = {}) {
  const calls = {
    cleanup: 0,
    finalize: 0,
    prepare: 0,
    sessionStop: 0,
    start: 0,
  };
  const finalized = deferred();
  const paths = {
    outputPath: "/Users/example/Downloads/recording.mp4",
  };
  const workingDirectory = "/private/temporary/recording";
  const capturePath = `${workingDirectory}/recording.mp4`;
  const session = {
    completion,
    ready,
    stats: {
      cursor: {
        cursorEventsCaptured: 0,
        cursorFramesObserved: 1,
      },
      framePump: {
        framesAcknowledged: 8,
        framesDropped: 1,
        framesReceived: 9,
        invalidFrames: 0,
        lastFrameTimestamp: 123.5,
        rawFrame: "must-not-leak",
        truncations: 0,
        visibilityChanges: 1,
        visibilityState: false,
      },
      resources: {
        elapsedMs: 900,
        maxObservedOutputBytes: 4096,
        outputPath: capturePath,
        terminationReason: null,
      },
      sink: {
        backpressureDrops: 2,
        encoderExitCode: null,
        ffmpegStderr: "must-not-leak",
        outputSamples: 7,
      },
    },
    async stop() {
      calls.sessionStop += 1;
      return { elapsedMs: 900 };
    },
  };
  let cleanupPaths;
  let finalizeError = null;
  let finalizedOptions;

  return {
    calls,
    dependencies: {
      async createRecordingArtifactTransaction(options) {
        calls.prepare += 1;
        return {
          capturePath,
          async finalize(finalizationOptions) {
            calls.finalize += 1;
            finalizedOptions = finalizationOptions;
            await finalizeGate?.promise;
            if (finalizeError) {
              finalized.resolve({ error: finalizeError });
              throw finalizeError;
            }
            const result =
              finalResult ?? {
                failureCode: null,
                status: "passed",
                outputFile: "recording.mp4",
              };
            finalized.resolve(result);
            return { paths, result };
          },
          async rollback() {
            calls.cleanup += 1;
            cleanupPaths = { directory: workingDirectory };
            if (cleanupError) {
              throw sanitizeRecordingFailure(
                { code: "cleanup_failed" },
                { cleanupDirectory: workingDirectory },
              );
            }
          },
        };
      },
      async startBrowserRecordingForTab() {
        calls.start += 1;
        if (startError) throw startError;
        return session;
      },
    },
    get cleanupPaths() {
      return cleanupPaths;
    },
    get finalizedOptions() {
      return finalizedOptions;
    },
    finalized,
    paths,
    session,
    setFinalizeError(error) {
      finalizeError = error;
    },
  };
}

async function createHandle(harness) {
  const tab = {
    id: "owned-recording-tab",
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {},
    async goto() {},
  };
  return createRecording({
    _dependencies: {
      ...harness.dependencies,
      clock: { clearTimeout, setTimeout },
      async doctor() {
        return {
          blockingReasons: [],
          ffmpegPath: "/usr/local/bin/ffmpeg",
          ffprobePath: "/usr/local/bin/ffprobe",
          supported: true,
        };
      },
    },
    browser: {
      tabs: {
        async list() {
          return [];
        },
        async new() {
          return tab;
        },
      },
    },
    targetUrl: "https://example.com/",
    temporaryRoot: "/private/temporary",
  });
}

test("cleans the prepared directory when session startup fails", async () => {
  const secret = "Bearer startup-secret-must-not-leak";
  const startupError = Object.assign(new Error(secret), {
    code: "cdp_unavailable",
    diagnostic: secret,
  });
  const harness = createHarness({ startError: startupError });

  const handle = await createHandle(harness);
  await assert.rejects(handle.ready, (error) => {
    assert.notEqual(error, startupError);
    assert.equal(error.code, "cdp_unavailable");
    assert.equal(
      error.message,
      describeRecordingFailure("cdp_unavailable").summary,
    );
    assert.equal(error.summary, error.message);
    assert.equal(
      error.remediation,
      describeRecordingFailure("cdp_unavailable").remediation,
    );
    assert.equal("cause" in error, false);
    assert.equal("diagnostic" in error, false);
    assert.doesNotMatch(
      `${error.message}\n${JSON.stringify(error)}`,
      /startup-secret/,
    );
    return true;
  });

  assert.equal(harness.calls.prepare, 1);
  assert.equal(harness.calls.start, 1);
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.finalize, 0);
  assert.deepEqual(harness.cleanupPaths, {
    directory: "/private/temporary/recording",
  });
});

test("external abort cancels capability acquisition and cleans late startup", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "capability-abort-test-"));
  const capability = deferred();
  const controller = new AbortController();
  const methods = [];
  let acquisitionStarted = false;
  const starting = createRecording({
    _dependencies: {
      clock: { clearTimeout, setTimeout },
      async doctor() {
        return {
          blockingReasons: [],
          ffmpegPath: "/unused/ffmpeg",
          ffprobePath: "/unused/ffprobe",
          supported: true,
        };
      },
    },
    browser: { tabs: { async new() { return {
      capabilities: {
        async get() {
          acquisitionStarted = true;
          return capability.promise;
        },
      },
      async close() {},
      async goto() {},
    }; } } },
    signal: controller.signal,
    targetUrl: "https://example.com/",
    temporaryRoot,
  });

  try {
    while (!acquisitionStarted) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    assert.equal(
      await Promise.race([
        starting.ready.then(
          () => "resolved",
          (error) => error.code,
        ),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
      ]),
      "recording_cancelled",
    );
    assert.deepEqual(readdirSync(temporaryRoot), []);

    capability.resolve({
      async readEvents() {
        return { cursor: 0, events: [], truncated: false };
      },
      async send(method) {
        methods.push(method);
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(methods, []);
  } finally {
    capability.resolve(null);
    await starting.ready.catch(() => {});
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("public stop cancels a pending Page.enable and releases its artifacts", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "page-enable-stop-test-"));
  const enable = deferred();
  const methods = [];
  let enableStarted = false;
  const handle = createRecording({
    _dependencies: {
      clock: { clearTimeout, setTimeout },
      async doctor() {
        return {
          blockingReasons: [],
          ffmpegPath: "/unused/ffmpeg",
          ffprobePath: "/unused/ffprobe",
          supported: true,
        };
      },
    },
    browser: { tabs: { async new() { return {
      capabilities: {
        async get() {
          return {
            async readEvents() {
              return { cursor: 0, events: [], truncated: false };
            },
            async send(method) {
              methods.push(method);
              if (method === "Page.enable") {
                enableStarted = true;
                await enable.promise;
              }
            },
          };
        },
      },
      async close() {},
      async goto() {},
    }; } } },
    ffmpegPath: "/unused/ffmpeg",
    ffprobePath: "/unused/ffprobe",
    targetUrl: "https://example.com/",
    temporaryRoot,
  });

  try {
    while (!enableStarted) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const stopped = handle.stop();
    await assert.rejects(
      stopped,
      (error) => error.code === "recording_cancelled",
    );
    await assert.rejects(
      handle.ready,
      (error) => error.code === "recording_cancelled",
    );
    assert.deepEqual(readdirSync(temporaryRoot), []);
    assert.equal(
      globalThis[Symbol.for("codex-browser-recorder.active")],
      undefined,
    );

    enable.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(methods, ["Page.enable"]);
  } finally {
    enable.resolve();
    await handle.stop().catch(() => {});
    delete globalThis[Symbol.for("codex-browser-recorder.active")];
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("preserves the startup error when directory cleanup also fails", async () => {
  const startupError = Object.assign(
    new Error("private primary startup secret"),
    { code: "cdp_unavailable" },
  );
  const harness = createHarness({
    cleanupError: new Error("private cleanup diagnostic"),
    startError: startupError,
  });

  let publicError;
  const handle = await createHandle(harness);
  await assert.rejects(handle.ready, (error) => {
    publicError = error;
    assert.notEqual(error, startupError);
    assert.equal(error.code, "cdp_unavailable");
    assert.equal(
      error.message,
      describeRecordingFailure("cdp_unavailable").summary,
    );
    assert.doesNotMatch(
      `${error.message}\n${JSON.stringify(error)}`,
      /private primary startup secret|private cleanup diagnostic|private\/temporary/,
    );
    return true;
  });
  assert.equal(harness.calls.cleanup, 1);
  assert.deepEqual(harness.cleanupPaths, {
    directory: "/private/temporary/recording",
  });
  assert.deepEqual(getRecordingCleanupDetails(publicError), {
    cleanupIncomplete: true,
    directory: "/private/temporary/recording",
  });
  assert.equal(Object.keys(publicError).includes("cleanupIncomplete"), false);
  assert.equal(Object.keys(publicError).includes("directory"), false);
});

test("returns the public handle before first-frame readiness resolves", async () => {
  const firstFrame = deferred();
  const harness = createHarness({ ready: firstFrame.promise });
  const handle = await createHandle(harness);

  assert.deepEqual(Object.keys(handle).sort(), [
    "finished",
    "ready",
    "runAction",
    "stop",
  ]);
  assert.equal(typeof handle.finished.then, "function");

  firstFrame.resolve();
  await handle.ready;
  assert.equal(harness.calls.prepare, 1);
  assert.equal(harness.calls.start, 1);
  await handle.stop();
});

test("keeps capture diagnostics behind the Recording Session interface", async () => {
  const harness = createHarness();
  const handle = await createHandle(harness);
  await handle.ready;

  assert.equal("status" in handle, false);
  await handle.stop();
});

test("stop memoizes one finalization promise and completes once", async () => {
  const harness = createHarness();
  const handle = await createHandle(harness);
  await handle.ready;

  const firstStop = handle.stop();
  const secondStop = handle.stop();

  assert.equal(firstStop, secondStop);
  assert.equal(firstStop, handle.finished);
  assert.deepEqual(await firstStop, {
    paths: harness.paths,
    result: {
      failureCode: null,
      status: "passed",
      outputFile: "recording.mp4",
    },
  });
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.calls.sessionStop, 1);
});
test("accepts a top-level frame on the approved origin", async () => {
  const methods = [];
  const cdp = {
    async send(method) {
      methods.push(method);
      return {
        frameTree: {
          frame: { id: "main-frame", url: "https://example.com/next" },
        },
      };
    },
  };

  assert.deepEqual(
    await inspectTopLevelFrame({
      approvedOrigin: "https://example.com",
      cdp,
    }),
    { frameId: "main-frame" },
  );
  assert.deepEqual(methods, ["Page.getFrameTree"]);
});

test("rejects invalid top-level origin verification configuration", async () => {
  for (const variant of [
    { approvedOrigin: "https://example.com", cdp: {} },
    { approvedOrigin: "", cdp: { async send() {} } },
    { approvedOrigin: "https://example.com/path", cdp: { async send() {} } },
  ]) {
    await assert.rejects(
      inspectTopLevelFrame(variant),
      (error) =>
        error.code === "invalid_configuration" &&
        error.message ===
          "Top-level origin verification configuration is invalid",
    );
  }
});

test("rejects a different origin without exposing it", async () => {
  const secretUrl = "https://other.example/?token=must-not-leak";
  const cdp = {
    async send() {
      return { frameTree: { frame: { id: "main-frame", url: secretUrl } } };
    },
  };

  await assert.rejects(
    inspectTopLevelFrame({
      approvedOrigin: "https://example.com",
      cdp,
    }),
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
      inspectTopLevelFrame({
        approvedOrigin: "https://example.com",
        cdp: { send },
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
          frameUrl: "https://example.com/start",
          async send(method) {
            methods.push(method);
            if (method === "Page.getFrameTree") {
              return {
                frameTree: {
                  frame: {
                    id: "main-frame",
                    url: cdp.frameUrl,
                  },
                },
              };
            }
            if (method === "Page.captureScreenshot") {
              return {
                data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString(
                  "base64",
                ),
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
    const session = await startBrowserRecordingForTab({
      approvedOrigin: "https://example.com",
      ffmpegPath: "/unused/ffmpeg",
      fps: 10,
      maxDecodedBytes: 1024,
      outputPath: `/tmp/unused-${index}.mp4`,
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
    assert.deepEqual(await session.assertApprovedOrigin(), {
      frameId: "main-frame",
    });
    if (index === 0) {
      createdCdps[index].frameUrl =
        "https://other.example/?token=must-not-leak";
      await assert.rejects(
        session.assertApprovedOrigin(),
        (error) =>
          error.code === "origin_changed_during_recording" &&
          !JSON.stringify(error).includes("must-not-leak"),
      );
      createdCdps[index].frameUrl = "https://example.com/restored";
    }
    await session.stop();
  }

  assert.deepEqual(acquired, ["cdp", "cdp"]);
  assert.notEqual(createdCdps[0], createdCdps[1]);
  assert.deepEqual(
    commandOrders.map((methods) => methods.slice(0, 3)),
    [
      ["Page.enable", "Page.getFrameTree", "Page.startScreencast"],
      ["Page.enable", "Page.getFrameTree", "Page.startScreencast"],
    ],
  );
});

test("discards the session when the event stream truncates after readiness", async () => {
  const stopCalls = [];
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
        return {
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
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
                data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
                metadata: { timestamp: 1 },
                sessionId: 1,
              },
            },
          ],
          hasMore: false,
          truncated: false,
        };
      }
      if (reads > 3) return { cursor: "invalid", events: null };
      return {
        cursor: 3,
        events: [
          {
            method: "Page.screencastFrame",
            params: {
              data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
              metadata: { timestamp: 2 },
              sessionId: 2,
            },
          },
        ],
        hasMore: false,
        truncated: true,
      };
    },
  };

  const session = await startBrowserRecordingForTab({
    approvedOrigin: "https://example.com",
    ffmpegPath: "/unused/ffmpeg",
    maxDecodedBytes: 1024,
    outputPath: "/tmp/must-not-publish.mp4",
    readTimeoutMs: 1,
    resourceCheckIntervalMs: 60_000,
    sinkFactory: () => ({
      stats: { outputBytes: 4, outputSamples: 0 },
      accept() {
        this.stats.outputSamples += 1;
        return true;
      },
      async stop(options) {
        stopCalls.push(options);
        return this.stats;
      },
    }),
    tab: { capabilities: { async get() { return cdp; } } },
  });

  await session.ready;
  const outcome = await session.completion;
  assert.equal(outcome.error?.code, "event_stream_invalid");
  await assert.rejects(
    session.stop(),
    (error) => error.code === "event_stream_invalid",
  );
  assert.deepEqual(stopCalls, [{ discard: true }]);
  assert.equal(session.stats.sink.outputSamples, 1);
});

test("reports a stable failure when a screencast frame cannot be acknowledged", async () => {
  const privateDiagnostic = "private frame acknowledgment diagnostic";
  const stopCalls = [];
  let acknowledgementAttempts = 0;
  let reads = 0;
  const frame = (sessionId, timestamp) => ({
    method: "Page.screencastFrame",
    params: {
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
      metadata: { timestamp },
      sessionId,
    },
  });
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
        return {
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
        };
      }
      if (method === "Page.screencastFrameAck") {
        acknowledgementAttempts += 1;
        if (acknowledgementAttempts === 2) {
          throw new Error(privateDiagnostic);
        }
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
      return {
        cursor: reads,
        events: [frame(reads - 1, reads - 1)],
        hasMore: false,
        truncated: false,
      };
    },
  };

  const session = await startBrowserRecordingForTab({
    approvedOrigin: "https://example.com",
    ffmpegPath: "/unused/ffmpeg",
    maxDecodedBytes: 1024,
    outputPath: "/tmp/must-not-publish.mp4",
    readTimeoutMs: 1,
    resourceCheckIntervalMs: 60_000,
    sinkFactory: () => ({
      stats: { outputBytes: 4, outputSamples: 0 },
      accept() {
        this.stats.outputSamples += 1;
        return true;
      },
      async stop(options) {
        stopCalls.push(options);
        return this.stats;
      },
    }),
    tab: { capabilities: { async get() { return cdp; } } },
  });

  await session.ready;
  const outcome = await session.completion;
  assert.equal(outcome.error?.code, "frame_ack_failed");
  assert.equal(session.stats.framePump.framesReceived, 2);
  assert.equal(session.stats.framePump.framesAcknowledged, 1);
  await assert.rejects(session.stop(), (error) => {
    assert.equal(error.code, "frame_ack_failed");
    assert.doesNotMatch(error.message, /private frame acknowledgment/);
    return true;
  });
  assert.deepEqual(stopCalls, [{ discard: true }]);
});

test("stop returns the finalized output through the Recording Session lifecycle", async () => {
  const harness = createHarness();
  const handle = await createHandle(harness);
  await handle.ready;

  assert.deepEqual(Object.keys(handle).sort(), [
    "finished",
    "ready",
    "runAction",
    "stop",
  ]);
  const stopped = handle.stop();
  assert.deepEqual(await stopped, {
    paths: harness.paths,
    result: {
      failureCode: null,
      outputFile: "recording.mp4",
      status: "passed",
    },
  });
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.calls.sessionStop, 1);
});

test("readiness failure is retained as the primary cleanup error", async () => {
  const readinessError = Object.assign(new Error("No source frame"), {
    code: "frame_stream_unavailable",
  });
  const harness = createHarness({
    finalResult: {
      failureCode: readinessError.code,
      status: "failed",
      outputFile: "recording.mp4",
    },
    ready: Promise.reject(readinessError),
  });
  const handle = await createHandle(harness);

  await assert.rejects(
    handle.ready,
    (error) =>
      error !== readinessError && error.code === readinessError.code,
  );
  await assert.rejects(
    handle.finished,
    (error) => error.code === readinessError.code,
  );
  assert.equal(handle.stop(), handle.finished);
  assert.equal(
    harness.finalizedOptions.failureCode,
    readinessError.code,
  );
  assert.equal(harness.calls.sessionStop, 1);
});

test("an automatic capture failure finalizes without an explicit stop", async () => {
  const completed = deferred();
  const harness = createHarness({
    completion: completed.promise,
    finalResult: {
      failureCode: "frame_stream_stalled",
      status: "failed",
      outputFile: "recording.mp4",
    },
  });
  const handle = await createHandle(harness);
  await handle.ready;

  completed.resolve({
    error: Object.assign(new Error("Fresh frames stalled"), {
      code: "frame_stream_stalled",
    }),
    result: null,
  });
  await completed.promise;
  const result = await harness.finalized.promise;
  const output = await handle.finished;

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "frame_stream_stalled");
  assert.equal(output.result, result);
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.calls.sessionStop, 1);
});

test("automatic terminal completion stays pending until finalization finishes", async () => {
  const captured = deferred();
  const finalizeGate = deferred();
  const harness = createHarness({
    completion: captured.promise,
    finalizeGate,
    finalResult: {
      failureCode: "frame_stream_stalled",
      status: "failed",
      outputFile: "recording.mp4",
    },
  });
  const handle = await createHandle(harness);
  await handle.ready;

  captured.resolve({
    error: Object.assign(new Error("Fresh frames stalled"), {
      code: "frame_stream_stalled",
    }),
    result: null,
  });
  await captured.promise;
  while (harness.calls.finalize === 0) await Promise.resolve();
  const stopped = handle.stop();
  assert.equal(
    await Promise.race([
      stopped.then(() => "completed"),
      Promise.resolve("pending"),
    ]),
    "pending",
  );

  finalizeGate.resolve();
  const output = await stopped;
  assert.equal(output.result.status, "failed");
  assert.equal(output.result.failureCode, "frame_stream_stalled");
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.calls.sessionStop, 1);
});

test("sanitizes every pre-handle Browser and CDP startup failure after rollback", async () => {
  const variants = [
    {
      code: "integration_failed",
      name: "capability acquisition",
      tab(secret) {
        return {
          capabilities: {
            async get() {
              throw Object.assign(new Error(secret), {
                code: "cdp_unavailable",
                diagnostic: secret,
              });
            },
          },
        };
      },
    },
    {
      code: "integration_failed",
      name: "event baseline",
      tab(secret) {
        return {
          capabilities: {
            async get() {
              return {
                async readEvents() {
                  throw new Error(secret);
                },
                async send() {},
              };
            },
          },
        };
      },
    },
    {
      code: "integration_failed",
      name: "Page.enable",
      tab(secret) {
        return {
          capabilities: {
            async get() {
              return {
                async readEvents() {
                  return { cursor: 0 };
                },
                async send(method) {
                  if (method === "Page.enable") throw new Error(secret);
                },
              };
            },
          },
        };
      },
    },
    {
      code: "integration_failed",
      name: "Page.startScreencast",
      tab(secret, methods) {
        return {
          capabilities: {
            async get() {
              return {
                async readEvents() {
                  return { cursor: 0 };
                },
                async send(method) {
                  methods.push(method);
                  if (method === "Page.getFrameTree") {
                    return {
                      frameTree: {
                        frame: {
                          id: "main-frame",
                          url: "https://example.com/start",
                        },
                      },
                    };
                  }
                  if (method === "Page.startScreencast") {
                    throw new Error(secret);
                  }
                },
              };
            },
          },
        };
      },
    },
  ];

  for (const variant of variants) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "startup-privacy-test-"));
    const secret = `secret-${variant.name}-must-not-leak`;
    const methods = [];
    try {
      const tab = variant.tab(secret, methods);
      tab.goto = async () => {};
      tab.close = async () => {};
      const handle = createRecording({
          _dependencies: {
            clock: { clearTimeout, setTimeout },
            async doctor() {
              return {
                blockingReasons: [],
                ffmpegPath: "unused",
                ffprobePath: "unused",
                supported: true,
              };
            },
            startBrowserRecordingForTab,
          },
          browser: { tabs: { async new() { return tab; } } },
          targetUrl: "https://example.com/",
          temporaryRoot,
        });
      await assert.rejects(
        handle.ready,
        (error) => {
          assert.equal(error.code, variant.code);
          assert.equal(
            error.message,
            describeRecordingFailure(variant.code).summary,
          );
          assert.equal("cause" in error, false);
          assert.equal("diagnostic" in error, false);
          assert.doesNotMatch(
            `${error.message}\n${JSON.stringify(error)}`,
            /secret-.*-must-not-leak/,
          );
          return true;
        },
        variant.name,
      );
      assert.deepEqual(readdirSync(temporaryRoot), []);
      if (variant.name === "Page.startScreencast") {
        assert.deepEqual(methods, [
          "Page.enable",
          "Page.getFrameTree",
          "Page.startScreencast",
          "Page.stopScreencast",
        ]);
      }
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }
});

test("finalization failure is memoized and leaves the handle failed", async () => {
  const harness = createHarness();
  const finalizationError = Object.assign(
    new Error("private result persistence diagnostic"),
    { code: "artifact_persistence_failed" },
  );
  harness.setFinalizeError(finalizationError);
  const handle = await createHandle(harness);
  await handle.ready;

  const firstStop = handle.stop();
  const secondStop = handle.stop();
  await assert.rejects(
    firstStop,
    (error) =>
      error !== finalizationError &&
      error.code === "artifact_persistence_failed" &&
      !error.message.includes("private result persistence diagnostic"),
  );
  assert.equal(firstStop, secondStop);
  assert.equal(firstStop, handle.finished);
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.calls.sessionStop, 1);
});
