import assert from "node:assert/strict";
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
        if (finalizeError) throw finalizeError;
        return (
          finalResult ?? {
            failureCode: null,
            status: "passed",
            videoFile: "recording.webm",
          }
        );
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
  const startupError = Object.assign(new Error("CDP startup failed"), {
    code: "cdp_unavailable",
  });
  const harness = createHarness({ startError: startupError });

  await assert.rejects(createHandle(harness), (error) => error === startupError);

  assert.equal(harness.calls.prepare, 1);
  assert.equal(harness.calls.start, 1);
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.finalize, 0);
  assert.equal(harness.cleanupPaths, harness.paths);
});

test("preserves the startup error when directory cleanup also fails", async () => {
  const startupError = Object.assign(new Error("Primary startup failure"), {
    code: "cdp_unavailable",
  });
  const harness = createHarness({
    cleanupError: new Error("private cleanup diagnostic"),
    startError: startupError,
  });

  await assert.rejects(createHandle(harness), (error) => error === startupError);
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

test("an automatic capture failure updates status before explicit stop", async () => {
  const completed = deferred();
  const harness = createHarness({ completion: completed.promise });
  const handle = await createHandle(harness);
  await handle.ready;

  completed.resolve({
    error: Object.assign(new Error("Fresh frames stalled"), {
      code: "frame_stream_stalled",
    }),
    result: null,
  });
  await completed.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handle.status().state, "failed");
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
