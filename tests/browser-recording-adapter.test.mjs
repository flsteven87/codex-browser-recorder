import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBrowserRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs";

const captureFields = [
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
    directory: "/private/temporary/recording",
    outputPath: "/private/temporary/recording/recording.webm",
    resultPath: "/private/temporary/recording/result.json",
  };
  const session = {
    completion,
    ready,
    stats: {
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
        outputPath: paths.outputPath,
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
      return {};
    },
  };
  let cleanupPaths;
  let finalizeError = null;
  let finalizedOptions;

  return {
    calls,
    dependencies: {
      async cleanupPreparedBrowserPoc(preparedPaths) {
        calls.cleanup += 1;
        cleanupPaths = preparedPaths;
        if (cleanupError) throw cleanupError;
      },
      async finalizeBrowserPoc(options) {
        calls.finalize += 1;
        finalizedOptions = options;
        await options.session.stop();
        if (finalizeError) {
          finalized.resolve({ error: finalizeError });
          throw finalizeError;
        }
        const result =
          finalResult ?? {
            failureCode: null,
            status: "passed",
            videoFile: "recording.webm",
          };
        finalized.resolve(result);
        return result;
      },
      async prepareBrowserPoc() {
        calls.prepare += 1;
        return paths;
      },
      async startBrowserPocForTab() {
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
  return createBrowserRecording({
    _dependencies: harness.dependencies,
    ffmpegPath: "/usr/local/bin/ffmpeg",
    ffprobePath: "/usr/local/bin/ffprobe",
    tab: { secretTabState: "must-not-leak" },
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

  await assert.rejects(createHandle(harness), (error) => {
    assert.notEqual(error, startupError);
    assert.equal(error.code, "cdp_unavailable");
    assert.equal(error.message, "Recording startup failed");
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
  assert.equal(harness.cleanupPaths, harness.paths);
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

  await assert.rejects(createHandle(harness), (error) => {
    assert.notEqual(error, startupError);
    assert.equal(error.code, "cdp_unavailable");
    assert.equal(error.message, "Recording startup failed");
    assert.doesNotMatch(
      `${error.message}\n${JSON.stringify(error)}`,
      /private primary startup secret|private cleanup diagnostic/,
    );
    return true;
  });
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.cleanupPaths, harness.paths);
});

test("returns the public handle before first-frame readiness resolves", async () => {
  const firstFrame = deferred();
  const harness = createHarness({ ready: firstFrame.promise });
  const handle = await createHandle(harness);

  assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
  assert.equal(handle.status().state, "recording");

  firstFrame.resolve();
  await handle.ready;
  assert.equal(harness.calls.prepare, 1);
  assert.equal(harness.calls.start, 1);
});

test("status exposes only bounded sanitized capture fields", async () => {
  const harness = createHarness();
  const handle = await createHandle(harness);
  await handle.ready;

  const status = handle.status();
  assert.deepEqual(Object.keys(status).sort(), ["capture", "state"]);
  assert.equal(status.state, "recording");
  assert.deepEqual(Object.keys(status.capture).sort(), captureFields.sort());
  assert.equal(status.capture.framesReceived, 9);
  assert.equal(status.capture.outputSamples, 7);
  assert.doesNotMatch(JSON.stringify(status), /must-not-leak|\/private\//);
});

test("stop memoizes one finalization promise and completes once", async () => {
  const harness = createHarness();
  const handle = await createHandle(harness);
  await handle.ready;

  const firstStop = handle.stop();
  const secondStop = handle.stop();

  assert.equal(firstStop, secondStop);
  assert.equal(handle.status().state, "stopping");
  assert.deepEqual(await firstStop, {
    paths: harness.paths,
    result: {
      failureCode: null,
      status: "passed",
      videoFile: "recording.webm",
    },
  });
  assert.equal(handle.status().state, "completed");
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
      videoFile: "recording.webm",
    },
    ready: Promise.reject(readinessError),
  });
  const handle = await createHandle(harness);

  await assert.rejects(handle.ready, (error) => error === readinessError);
  assert.equal(handle.status().state, "failed");
  await handle.stop();
  assert.equal(harness.finalizedOptions.captureError, readinessError);
  assert.equal(harness.calls.sessionStop, 1);
  assert.equal(handle.status().state, "failed");
});

test("an automatic capture failure finalizes without an explicit stop", async () => {
  const completed = deferred();
  const harness = createHarness({
    completion: completed.promise,
    finalResult: {
      failureCode: "frame_stream_stalled",
      status: "failed",
      videoFile: "recording.webm",
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

  assert.equal(handle.status().state, "failed");
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "frame_stream_stalled");
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.calls.sessionStop, 1);
});

test("sanitizes every pre-handle Browser and CDP startup failure after rollback", async () => {
  const variants = [
    {
      code: "cdp_unavailable",
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
      await assert.rejects(
        createBrowserRecording({
          ffmpegPath: "unused",
          ffprobePath: "unused",
          tab: variant.tab(secret, methods),
          temporaryRoot,
        }),
        (error) => {
          assert.equal(error.code, variant.code);
          assert.equal(error.message, "Recording startup failed");
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
  const finalizationError = new Error("Result persistence failed");
  harness.setFinalizeError(finalizationError);
  const handle = await createHandle(harness);
  await handle.ready;

  const firstStop = handle.stop();
  const secondStop = handle.stop();
  await assert.rejects(firstStop, (error) => error === finalizationError);

  assert.equal(firstStop, secondStop);
  assert.equal(handle.status().state, "failed");
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.calls.sessionStop, 1);
});
