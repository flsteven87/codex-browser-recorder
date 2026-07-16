import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecording,
  describeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";
import { getRecordingCleanupDetails } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";

const ACTIVE_RECORDING_KEY = Symbol.for("codex-browser-recorder.active");

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function settleWorkflow() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    advance(ms) {
      now += ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) return;
        const [id, timer] = due;
        timers.delete(id);
        timer.callback();
      }
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
  };
}

function createHarness({
  autoReady = true,
  autoStop = true,
  capture = { framesReceived: 12 },
  stopOutput = {
    paths: { directory: "/private/recording" },
    result: { failureCode: null, status: "passed" },
  },
} = {}) {
  const readyDeferred = deferred();
  const completionDeferred = deferred();
  const stopDeferred = deferred();
  const clock = createFakeClock();
  const calls = { startRecording: 0, stop: 0, tabClose: 0, tabNew: 0 };
  const paths = {
    directory: "/private/recording",
    outputPath: "/private/recording/recording.webm",
    resultPath: "/private/recording/result.json",
  };
  let rawRecordingOptions;
  let rawFinalizationOptions;
  let stopPromise;

  if (autoReady) readyDeferred.resolve(true);
  if (autoStop) stopDeferred.resolve(stopOutput);

  const inner = {
    completion: completionDeferred.promise,
    ready: readyDeferred.promise,
    stats: {
      framePump: capture,
      resources: {},
      sink: {},
    },
    status() {
      return { capture, state: "recording" };
    },
    stop() {
      stopPromise ??= (() => {
        calls.stop += 1;
        return stopDeferred.promise;
      })();
      return stopPromise;
    },
  };
  const freshTab = {
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {
      calls.tabClose += 1;
    },
    async goto() {},
  };
  const browser = {
    tabs: {
      async new() {
        calls.tabNew += 1;
        return freshTab;
      },
    },
  };

  return {
    browser,
    calls,
    clock,
    completionDeferred,
    dependencies: {
      clock,
      async cleanupRecordingArtifacts() {},
      async doctor() {
        return {
          blockingReasons: [],
          ffmpegPath: "/opt/ffmpeg",
          ffprobePath: "/opt/ffprobe",
          supported: true,
        };
      },
      async finalizeRecordingArtifacts(options) {
        rawFinalizationOptions = options;
        const { session } = options;
        const output = await session.stop();
        return output?.result ?? output;
      },
      async prepareRecordingArtifacts() {
        return paths;
      },
      async startBrowserRecordingForTab(options) {
        calls.startRecording += 1;
        rawRecordingOptions = options;
        return inner;
      },
    },
    inner,
    freshTab,
    readyDeferred,
    get rawRecordingOptions() {
      return rawRecordingOptions;
    },
    get rawFinalizationOptions() {
      return rawFinalizationOptions;
    },
    get recordingOptions() {
      if (rawRecordingOptions === undefined) return undefined;
      return {
        approvedOrigin: rawRecordingOptions.approvedOrigin,
        maxDurationMs: rawRecordingOptions.maxDurationMs,
      };
    },
    stopDeferred,
  };
}

function validOptions(overrides = {}) {
  const harness = createHarness();
  return {
    harness,
    options: {
      _dependencies: harness.dependencies,
      browser: harness.browser,
      targetUrl: "https://example.com/demo",
      ...overrides,
    },
  };
}

function assertPublicStatus(handle, expectedState) {
  const status = handle.status();
  assert.deepEqual(Object.keys(status).sort(), ["capture", "state"]);
  assert.equal(status.state, expectedState);
  return status;
}

async function assertSingletonReleased() {
  const next = validOptions();
  const handle = createRecording(next.options);
  await handle.ready;
  await handle.stop();
  assertPublicStatus(handle, "completed");
}

test.afterEach(() => {
  delete globalThis[ACTIVE_RECORDING_KEY];
});

test("returns a preparing handle and validates before allocating Browser resources", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    durationMs: 15_000,
    maxDecodedBytes: 1,
    maxOutputBytes: 1,
    maxWidth: 9_999,
    targetUrl: "https://example.com/demo",
    browser: harness.browser,
  });

  assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
  assert.deepEqual(assertPublicStatus(handle, "preparing"), {
    capture: null,
    state: "preparing",
  });
  assert.equal(harness.calls.startRecording, 0);

  await handle.ready;
  assert.deepEqual(harness.recordingOptions, {
    approvedOrigin: "https://example.com",
    maxDurationMs: 65_000,
  });
  assert.equal("maxDecodedBytes" in harness.rawRecordingOptions, false);
  assert.equal("maxOutputBytes" in harness.rawRecordingOptions, false);
  assert.equal("maxWidth" in harness.rawRecordingOptions, false);
  await handle.stop();
  assert.equal(harness.rawFinalizationOptions.maxWidth, 1280);
  assertPublicStatus(handle, "completed");
});

test("owns fresh-tab preflight and returns only the approved tab at readiness", async () => {
  const harness = createHarness();
  const calls = [];
  const preflightCdp = { readEvents() {}, send() {} };
  const freshTab = {
    capabilities: {
      async get(name) {
        calls.push(`capability:${name}`);
        return preflightCdp;
      },
    },
    async goto(url) {
      calls.push(`goto:${url}`);
    },
    async close() {
      calls.push("tab:close");
    },
  };
  const browser = {
    tabs: {
      async new() {
        calls.push("tab:new");
        return freshTab;
      },
    },
  };
  const handle = createRecording({
    _dependencies: {
      clock: harness.clock,
      async finalizeRecordingArtifacts(options) {
        calls.push("artifacts:finalize");
        assert.equal(options.outputPath, "/private/recording/recording.webm");
        assert.equal(options.ffprobePath, "/opt/ffprobe");
        await options.session.stop();
        return { failureCode: null, status: "passed" };
      },
      async prepareRecordingArtifacts() {
        calls.push("artifacts:prepare");
        return {
          directory: "/private/recording",
          outputPath: "/private/recording/recording.webm",
          resultPath: "/private/recording/result.json",
        };
      },
      async startBrowserRecordingForTab(options) {
        calls.push("capture:start");
        assert.equal(options.tab, freshTab);
        assert.equal(options.ffmpegPath, "/opt/ffmpeg");
        return harness.inner;
      },
      async doctor(options) {
        calls.push("doctor");
        assert.deepEqual(options, {
          cdpAvailable: true,
          outputDirectory: "/private/tmp",
        });
        return {
          blockingReasons: [],
          ffmpegPath: "/opt/ffmpeg",
          ffprobePath: "/opt/ffprobe",
          supported: true,
        };
      },
    },
    browser,
    durationMs: 5_000,
    targetUrl: "https://example.com/demo",
    temporaryRoot: "/private/tmp",
  });

  assert.equal(await handle.ready, freshTab);
  assert.deepEqual(calls, [
    "tab:new",
    "goto:https://example.com/demo",
    "capability:cdp",
    "doctor",
    "artifacts:prepare",
    "capture:start",
  ]);
  assert.deepEqual(await handle.stop(), {
    paths: {
      directory: "/private/recording",
      outputPath: "/private/recording/recording.webm",
      resultPath: "/private/recording/result.json",
    },
    result: { failureCode: null, status: "passed" },
  });
  assert.deepEqual(calls.slice(-2), ["artifacts:finalize", "tab:close"]);
});

test("rejects a malformed caller signal without retaining the singleton", async () => {
  const malformed = validOptions({ signal: {} });
  const handle = createRecording(malformed.options);

  assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
  assertPublicStatus(handle, "failed");
  await assert.rejects(handle.ready, (error) => {
    assert.equal(error.code, "invalid_configuration");
    assert.equal(
      error.message,
      describeRecordingFailure("invalid_configuration").summary,
    );
    assert.doesNotMatch(error.message, /TypeError|addEventListener/);
    return true;
  });
  assert.equal(malformed.harness.calls.startRecording, 0);

  await assertSingletonReleased();
});

for (const property of ["addEventListener", "removeEventListener", "aborted"]) {
  test(`uses native AbortSignal behavior when ${property} is shadowed`, async () => {
    const controller = new AbortController();
    const secret = `private shadowed ${property} diagnostic`;
    Object.defineProperty(controller.signal, property, {
      configurable: true,
      get() {
        throw new Error(secret);
      },
    });
    const configured = validOptions({ signal: controller.signal });

    const handle = createRecording(configured.options);
    assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
    await handle.ready;
    await handle.stop();
    assertPublicStatus(handle, "completed");

    await assertSingletonReleased();
  });
}

test("sanitizes a throwing signal accessor without retaining the singleton", async () => {
  const configured = validOptions();
  const options = { ...configured.options };
  Object.defineProperty(options, "signal", {
    get() {
      throw new Error("private signal accessor diagnostic");
    },
  });

  const handle = createRecording(options);
  assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
  assertPublicStatus(handle, "failed");
  await assert.rejects(handle.ready, (error) => {
    assert.equal(error.code, "invalid_configuration");
    assert.equal(
      error.message,
      describeRecordingFailure("invalid_configuration").summary,
    );
    assert.doesNotMatch(JSON.stringify(error), /private signal accessor/);
    return true;
  });
  assert.equal(configured.harness.calls.startRecording, 0);

  await assertSingletonReleased();
});

test("immediate stop cancels preparation and releases the singleton", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "https://example.com/",
    browser: harness.browser,
  });

  const stopped = handle.stop();
  await assert.rejects(
    stopped,
    (error) => error.code === "recording_cancelled",
  );
  await assert.rejects(
    handle.ready,
    (error) => error.code === "recording_cancelled",
  );
  assert.equal(harness.calls.startRecording, 0);
  assertPublicStatus(handle, "cancelled");
  await assertSingletonReleased();
});

test("cancels an in-flight environment check and closes its fresh tab", async () => {
  const harness = createHarness();
  const doctorDeferred = deferred();
  let doctorStarted = false;
  harness.dependencies.doctor = () => {
    doctorStarted = true;
    return doctorDeferred.promise;
  };
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "https://example.com/",
    browser: harness.browser,
  });

  await settleWorkflow();
  assert.equal(doctorStarted, true);
  await assert.rejects(handle.stop(), (error) => error.code === "recording_cancelled");
  assert.equal(harness.calls.tabClose, 1);
  assert.equal(harness.calls.startRecording, 0);
  doctorDeferred.resolve({ supported: true });
  await assertSingletonReleased();
});

test("rolls back late artifact preparation after cancellation", async () => {
  const harness = createHarness();
  const preparationDeferred = deferred();
  let preparationStarted = false;
  let cleanupStarted = false;
  harness.dependencies.prepareRecordingArtifacts = () => {
    preparationStarted = true;
    return preparationDeferred.promise;
  };
  harness.dependencies.cleanupRecordingArtifacts = async () => {
    cleanupStarted = true;
    throw new Error("private cleanup diagnostic");
  };
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "https://example.com/",
    browser: harness.browser,
  });

  await settleWorkflow();
  assert.equal(preparationStarted, true);
  const stopped = handle.stop();
  preparationDeferred.resolve({
    directory: "/private/late-recording",
    outputPath: "/private/late-recording/recording.webm",
    resultPath: "/private/late-recording/result.json",
  });
  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "recording_cancelled");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      cleanupIncomplete: true,
      directory: "/private/late-recording",
    });
    assert.doesNotMatch(JSON.stringify(error), /private cleanup diagnostic/);
    return true;
  });
  assert.equal(cleanupStarted, true);
  assert.equal(harness.calls.tabClose, 1);
  await assertSingletonReleased();
});

test("rejects invalid targets before lower-level allocation", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "file:///private/secret",
    browser: harness.browser,
  });

  let readyError;
  await assert.rejects(handle.ready, (error) => {
    readyError = error;
    assert.equal(error.code, "target_scheme_not_allowed");
    assert.equal(
      error.message,
      describeRecordingFailure("target_scheme_not_allowed").summary,
    );
    assert.doesNotMatch(JSON.stringify(error), /private|secret/);
    return true;
  });
  assert.equal(harness.calls.startRecording, 0);
  assertPublicStatus(handle, "failed");
  const firstStop = handle.stop();
  assert.equal(firstStop, handle.stop());
  await assert.rejects(firstStop, (error) => error === readyError);
  await assertSingletonReleased();
});

test("rejects caller-provided tabs instead of recording an existing tab", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    tab: {},
    targetUrl: "https://example.com/",
  });

  await assert.rejects(
    handle.ready,
    (error) => error.code === "invalid_configuration",
  );
  assert.equal(harness.calls.startRecording, 0);
  assert.equal(harness.calls.tabNew, 0);
  assertPublicStatus(handle, "failed");
  await assertSingletonReleased();
});

test("reports bounded Browser cleanup state when fresh-tab close fails", async () => {
  const harness = createHarness();
  harness.browser.tabs.new = async () => ({
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {
      throw new Error("private tab identifier");
    },
    async goto() {},
  });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  await assert.rejects(handle.stop(), (error) => {
    assert.equal(error.code, "integration_failed");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      browserTabCleanupIncomplete: true,
    });
    assert.doesNotMatch(JSON.stringify(error), /private tab identifier/);
    return true;
  });
  assertPublicStatus(handle, "failed");
  await assertSingletonReleased();
});

test("reports bounded cleanup when cancellation races with fresh-tab creation", async () => {
  const harness = createHarness();
  const tabDeferred = deferred();
  harness.browser.tabs.new = () => {
    harness.calls.tabNew += 1;
    return tabDeferred.promise;
  };
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await settleWorkflow();
  assert.equal(harness.calls.tabNew, 1);
  const stopped = handle.stop();
  tabDeferred.resolve({
    async close() {
      throw new Error("private late tab identifier");
    },
  });

  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "recording_cancelled");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      browserTabCleanupIncomplete: true,
    });
    assert.doesNotMatch(JSON.stringify(error), /private late tab identifier/);
    return true;
  });
  await assert.rejects(handle.ready, (error) => error.code === "recording_cancelled");
  assertPublicStatus(handle, "cancelled");
  await assertSingletonReleased();
});

test("bounds cancellation when fresh-tab creation never settles", async () => {
  const harness = createHarness();
  harness.browser.tabs.new = () => {
    harness.calls.tabNew += 1;
    return new Promise(() => {});
  };
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await settleWorkflow();
  const stopped = handle.stop();
  await settleWorkflow();
  harness.clock.advance(5_000);
  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "recording_cancelled");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      browserTabCleanupIncomplete: true,
    });
    return true;
  });
  assertPublicStatus(handle, "cancelled");
  await assertSingletonReleased();
});

test("bounds cancellation and cleanup when artifact preparation never settles", async () => {
  const harness = createHarness();
  harness.dependencies.prepareRecordingArtifacts = ({ onDirectoryCreated }) => {
    onDirectoryCreated("/private/hung-recording");
    return new Promise(() => {});
  };
  harness.dependencies.cleanupRecordingArtifacts = () =>
    new Promise(() => {});
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await settleWorkflow();
  const stopped = handle.stop();
  await settleWorkflow();
  harness.clock.advance(5_000);
  await settleWorkflow();
  harness.clock.advance(5_000);
  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "recording_cancelled");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      cleanupIncomplete: true,
      directory: "/private/hung-recording",
    });
    return true;
  });
  assert.equal(harness.calls.tabClose, 1);
  assertPublicStatus(handle, "cancelled");
  await assertSingletonReleased();
});

test("reports unknown late artifact creation and still attempts cleanup", async () => {
  const harness = createHarness();
  let notifyDirectoryCreated;
  let cleanupDirectory;
  harness.dependencies.prepareRecordingArtifacts = ({ onDirectoryCreated }) => {
    notifyDirectoryCreated = onDirectoryCreated;
    return new Promise(() => {});
  };
  harness.dependencies.cleanupRecordingArtifacts = async (paths) => {
    cleanupDirectory = paths.directory;
  };
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await settleWorkflow();
  const stopped = handle.stop();
  await settleWorkflow();
  harness.clock.advance(5_000);
  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "recording_cancelled");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      artifactCleanupIncomplete: true,
    });
    return true;
  });
  notifyDirectoryCreated("/private/very-late-recording");
  await settleWorkflow();
  assert.equal(cleanupDirectory, "/private/very-late-recording");
  await assertSingletonReleased();
});

test("bounds a hanging fresh-tab close during normal teardown", async () => {
  const harness = createHarness();
  harness.freshTab.close = () => new Promise(() => {});
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const stopped = handle.stop();
  await settleWorkflow();
  harness.clock.advance(5_000);
  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "integration_failed");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      browserTabCleanupIncomplete: true,
    });
    return true;
  });
  await assertSingletonReleased();
});

test("bounds a hanging artifact rollback after startup failure", async () => {
  const harness = createHarness();
  harness.dependencies.startBrowserRecordingForTab = async () => {
    throw Object.assign(new Error("private startup diagnostic"), {
      code: "frame_stream_unavailable",
    });
  };
  harness.dependencies.cleanupRecordingArtifacts = () =>
    new Promise(() => {});
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await settleWorkflow();
  harness.clock.advance(5_000);
  await assert.rejects(handle.ready, (error) => {
    assert.equal(error.code, "frame_stream_unavailable");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      cleanupIncomplete: true,
      directory: "/private/recording",
    });
    return true;
  });
  assert.equal(harness.calls.tabClose, 1);
  await assertSingletonReleased();
});

test("bounds a hanging finalization and releases the singleton", async () => {
  const harness = createHarness({ autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const stopped = handle.stop();
  await settleWorkflow();
  harness.clock.advance(10_000);
  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "integration_failed");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      cleanupIncomplete: true,
      directory: "/private/recording",
    });
    return true;
  });
  assert.equal(harness.calls.tabClose, 1);
  await assertSingletonReleased();
});

test("bounds readiness cleanup when lower-level stop never settles", async () => {
  const harness = createHarness({ autoReady: false, autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await settleWorkflow();
  harness.readyDeferred.reject(
    Object.assign(new Error("private readiness diagnostic"), {
      code: "frame_stream_unavailable",
    }),
  );
  await settleWorkflow();
  harness.clock.advance(10_000);

  await assert.rejects(handle.ready, (error) => {
    assert.equal(error.code, "frame_stream_unavailable");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      cleanupIncomplete: true,
      directory: "/private/recording",
    });
    return true;
  });
  assert.equal(harness.calls.tabClose, 1);
  await assertSingletonReleased();
});

test("preserves the primary failure when Browser cleanup also fails", async () => {
  const harness = createHarness({ autoStop: false });
  harness.browser.tabs.new = async () => ({
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {
      throw new Error("private close failure");
    },
    async goto() {},
  });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const stopped = handle.stop();
  harness.stopDeferred.reject(
    Object.assign(new Error("private artifact failure"), {
      code: "artifact_persistence_failed",
    }),
  );
  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "artifact_persistence_failed");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      browserTabCleanupIncomplete: true,
    });
    return true;
  });
});

test("preserves a failed capture outcome when Browser cleanup also fails", async () => {
  const harness = createHarness({
    stopOutput: {
      paths: {},
      result: { failureCode: "frame_ack_failed", status: "failed" },
    },
  });
  harness.freshTab.close = async () => {
    throw new Error("private close failure after capture");
  };
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  await assert.rejects(handle.stop(), (error) => {
    assert.equal(error.code, "frame_ack_failed");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      browserTabCleanupIncomplete: true,
    });
    assert.doesNotMatch(JSON.stringify(error), /private close failure/);
    return true;
  });
  assertPublicStatus(handle, "failed");
  await assertSingletonReleased();
});

test("retains Browser cleanup state on readiness failure", async () => {
  const harness = createHarness({ autoReady: false });
  harness.browser.tabs.new = async () => ({
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {
      throw new Error("private close failure");
    },
    async goto() {},
  });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await settleWorkflow();
  harness.readyDeferred.reject(
    Object.assign(new Error("private readiness failure"), {
      code: "frame_stream_unavailable",
    }),
  );

  await assert.rejects(handle.ready, (error) => {
    assert.equal(error.code, "frame_stream_unavailable");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      browserTabCleanupIncomplete: true,
    });
    return true;
  });
});

test("stops cleanly at the requested duration and memoizes finalization", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    durationMs: 5_000,
    targetUrl: "https://example.com/",
    browser: harness.browser,
  });

  assert.equal(harness.clock.pending, 0);
  await handle.ready;
  assertPublicStatus(handle, "recording");
  assert.equal(harness.rawRecordingOptions.signal.aborted, false);
  assert.equal(harness.clock.pending, 1);
  harness.clock.advance(5_000);
  const first = handle.stop();
  const second = handle.stop();
  assert.equal(first, second);
  await first;
  assert.equal(harness.rawRecordingOptions.signal.aborted, false);
  assert.equal(harness.calls.stop, 1);
  assert.equal(harness.clock.pending, 0);
  assertPublicStatus(handle, "completed");
});

test("reports awaiting-frame and stopping transitions with exact status shape", async () => {
  const harness = createHarness({ autoReady: false, autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "https://example.com/",
    browser: harness.browser,
  });

  await settleWorkflow();
  assertPublicStatus(handle, "awaiting_frame");
  harness.readyDeferred.resolve(true);
  await handle.ready;
  const stopped = handle.stop();
  await settleWorkflow();
  assertPublicStatus(handle, "stopping");
  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: null, status: "passed" },
  });
  await stopped;
  assertPublicStatus(handle, "completed");
});

test("reserves and releases the singleton across every terminal path", async () => {
  const firstOptions = validOptions();
  const first = createRecording(firstOptions.options);
  const concurrent = createRecording(validOptions().options);
  await assert.rejects(
    concurrent.ready,
    (error) => error.code === "recording_already_active",
  );
  assertPublicStatus(concurrent, "failed");

  await first.ready;
  await first.stop();
  assertPublicStatus(first, "completed");

  const nextOptions = validOptions();
  const next = createRecording(nextOptions.options);
  await next.ready;
  await next.stop();
  assertPublicStatus(next, "completed");
});

const terminalCases = [
  {
    expectedCode: "frame_stream_unavailable",
    expectedState: "failed",
    name: "readiness failure waits for cleanup and stays terminal",
    async run() {
      const harness = createHarness({ autoReady: false, autoStop: false });
      const handle = createRecording({
        _dependencies: harness.dependencies,
        targetUrl: "https://example.com/",
        browser: harness.browser,
      });
      await settleWorkflow();
      const secret = "private readiness diagnostic";
      harness.readyDeferred.reject(
        Object.assign(new Error(secret), { code: "frame_stream_unavailable" }),
      );
      const pendingReady = assert.rejects(
        handle.ready,
        (error) =>
          error.code === "frame_stream_unavailable" &&
          !error.message.includes(secret),
      );
      await settleWorkflow();
      const blocked = createRecording(validOptions().options);
      await assert.rejects(
        blocked.ready,
        (error) => error.code === "recording_already_active",
      );
      harness.stopDeferred.resolve({
        paths: {},
        result: {
          failureCode: "frame_stream_unavailable",
          status: "failed",
        },
      });
      await pendingReady;
      return { handle, harness };
    },
  },
  {
    expectedState: "failed",
    name: "lower-level terminal failure finalizes before release",
    async run() {
      const harness = createHarness({
        stopOutput: {
          paths: {},
          result: { failureCode: "frame_stream_stalled", status: "failed" },
        },
      });
      const handle = createRecording({
        _dependencies: harness.dependencies,
        targetUrl: "https://example.com/",
        browser: harness.browser,
      });
      await handle.ready;
      harness.completionDeferred.resolve({
        error: Object.assign(new Error("private capture failure"), {
          code: "frame_stream_stalled",
        }),
        result: null,
      });
      await harness.completionDeferred.promise;
      await settleWorkflow();
      return { handle, harness };
    },
  },
  {
    expectedState: "completed",
    name: "lower-level completion racing readiness cannot resurrect recording",
    async run() {
      const harness = createHarness({ autoReady: false });
      const handle = createRecording({
        _dependencies: harness.dependencies,
        targetUrl: "https://example.com/",
        browser: harness.browser,
      });
      await settleWorkflow();
      harness.completionDeferred.resolve({
        paths: {},
        result: { failureCode: null, status: "passed" },
      });
      await harness.completionDeferred.promise;
      await settleWorkflow();
      assertPublicStatus(handle, "awaiting_frame");
      harness.readyDeferred.resolve(true);
      assert.equal(await handle.ready, harness.freshTab);
      await handle.stop();
      assertPublicStatus(handle, "completed");
      assert.equal(harness.clock.pending, 0);
      return { handle, harness };
    },
  },
  {
    expectedCode: "recording_cancelled",
    expectedState: "cancelled",
    name: "abort during readiness cleans up before cancellation",
    async run() {
      const harness = createHarness({ autoReady: false, autoStop: false });
      const controller = new AbortController();
      const handle = createRecording({
        _dependencies: harness.dependencies,
        signal: controller.signal,
        targetUrl: "https://example.com/",
        browser: harness.browser,
      });
      await settleWorkflow();
      assert.notEqual(harness.rawRecordingOptions.signal, controller.signal);
      controller.abort();
      assert.equal(harness.rawRecordingOptions.signal.aborted, true);
      harness.readyDeferred.reject(
        Object.assign(new Error("private abort detail"), {
          code: "recording_cancelled",
        }),
      );
      const pendingReady = assert.rejects(
        handle.ready,
        (error) => error.code === "recording_cancelled",
      );
      await settleWorkflow();
      harness.stopDeferred.resolve({
        paths: {},
        result: { failureCode: "recording_cancelled", status: "failed" },
      });
      await pendingReady;
      return { handle, harness };
    },
  },
  {
    expectedCode: "artifact_persistence_failed",
    expectedState: "failed",
    name: "rejected finalization is sanitized and memoized",
    async run() {
      const harness = createHarness({ autoStop: false });
      const handle = createRecording({
        _dependencies: harness.dependencies,
        targetUrl: "https://example.com/",
        browser: harness.browser,
      });
      await handle.ready;
      const firstStop = handle.stop();
      assert.equal(firstStop, handle.stop());
      await settleWorkflow();
      assertPublicStatus(handle, "stopping");
      harness.stopDeferred.reject(
        Object.assign(new Error("private filesystem path"), {
          code: "artifact_persistence_failed",
        }),
      );
      await assert.rejects(firstStop, (error) => {
        assert.equal(error.code, "artifact_persistence_failed");
        assert.doesNotMatch(error.message, /private filesystem path/);
        return true;
      });
      return { handle, harness };
    },
  },
  {
    expectedState: "cancelled",
    name: "lower-level cancellation rejection maps to cancelled",
    async run() {
      const harness = createHarness({
        stopOutput: {
          paths: {},
          result: { failureCode: "recording_cancelled", status: "failed" },
        },
      });
      const handle = createRecording({
        _dependencies: harness.dependencies,
        targetUrl: "https://example.com/",
        browser: harness.browser,
      });
      await handle.ready;
      harness.completionDeferred.reject(
        Object.assign(new Error("private cancellation detail"), {
          code: "recording_cancelled",
        }),
      );
      await settleWorkflow();
      return { handle, harness };
    },
  },
];

test("keeps terminal states monotonic and releases every terminal reservation", async (t) => {
  for (const scenario of terminalCases) {
    await t.test(scenario.name, async () => {
      const { handle, harness } = await scenario.run();
      const status = assertPublicStatus(handle, scenario.expectedState);
      assert.equal(status.capture.framesReceived, 12);
      if (scenario.expectedCode !== undefined) {
        const stopped = handle.stop();
        await assert.rejects(
          stopped,
          (error) => error.code === scenario.expectedCode,
        );
        assert.equal(stopped, handle.stop());
      }
      harness.readyDeferred.resolve(true);
      await settleWorkflow();
      assertPublicStatus(handle, scenario.expectedState);
      await assertSingletonReleased();
    });
  }
});
