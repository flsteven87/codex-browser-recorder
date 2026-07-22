import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRecording,
  describeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";
import {
  createRecordingArtifactTransaction,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs";
import {
  getRecordingCleanupDetails,
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";

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
    now() {
      return now;
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
  approvedOriginAttestation = async () => {},
  autoReady = true,
  autoStop = true,
  capture = { framesReceived: 12 },
  stopOutput = {
    paths: { outputPath: "/Users/example/Downloads/recording.mp4" },
    result: { failureCode: null, status: "passed" },
  },
} = {}) {
  const readyDeferred = deferred();
  const completionDeferred = deferred();
  const stopDeferred = deferred();
  const clock = createFakeClock();
  const calls = {
    assertApprovedOrigin: 0,
    startRecording: 0,
    stop: 0,
    tabClose: 0,
    tabNew: 0,
  };
  const paths = {
    directory: "/private/recording",
    outputPath: "/private/recording/recording.mp4",
    resultPath: "/private/recording/result.json",
  };
  let rawRecordingOptions;
  let rawFinalizationOptions;
  let stopPromise;

  if (autoReady) readyDeferred.resolve(true);
  if (autoStop) stopDeferred.resolve(stopOutput);

  const inner = {
    async assertApprovedOrigin() {
      calls.assertApprovedOrigin += 1;
      return approvedOriginAttestation();
    },
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
        return Promise.resolve({ elapsedMs: 500, ...capture });
      })();
      return stopPromise;
    },
  };
  const freshTab = {
    id: "fresh-recording-tab",
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
      async list() {
        return [];
      },
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
      async createRecordingArtifactTransaction() {
        return {
          capturePath: paths.outputPath,
          async finalize(finalizationOptions) {
            rawFinalizationOptions = finalizationOptions;
            return stopDeferred.promise;
          },
          async rollback() {},
        };
      },
      async doctor() {
        return {
          blockingReasons: [],
          ffmpegPath: "/opt/ffmpeg",
          ffprobePath: "/opt/ffprobe",
          supported: true,
        };
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
        requirePointerEvents: rawRecordingOptions.requirePointerEvents,
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

async function assertSingletonReleased() {
  const next = validOptions();
  const handle = createRecording(next.options);
  await handle.ready;
  const stopped = handle.stop();
  assert.equal(stopped, handle.finished);
  await stopped;
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
    requirePointerEvents: true,
    targetUrl: "https://example.com/demo",
    browser: harness.browser,
  });

  assert.deepEqual(Object.keys(handle).sort(), [
    "finished",
    "ready",
    "runAction",
    "stop",
  ]);
  assert.equal(typeof handle.finished?.then, "function");
  assert.equal(harness.calls.startRecording, 0);

  await handle.ready;
  assert.deepEqual(harness.recordingOptions, {
    approvedOrigin: "https://example.com",
    maxDurationMs: 65_000,
    requirePointerEvents: true,
  });
  assert.equal("maxDecodedBytes" in harness.rawRecordingOptions, false);
  assert.equal("maxOutputBytes" in harness.rawRecordingOptions, false);
  assert.equal("maxWidth" in harness.rawRecordingOptions, false);
  await handle.stop();
  assert.equal("maxWidth" in harness.rawFinalizationOptions, false);
  assert.equal(harness.rawFinalizationOptions.capture.framesReceived, 12);
});

test("owns fresh-tab preflight and returns only the approved tab at readiness", async () => {
  const harness = createHarness();
  const calls = [];
  const preflightCdp = { readEvents() {}, send() {} };
  const freshTab = {
    id: "fresh-recording-tab",
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
      async list() {
        calls.push("tabs:list");
        return [];
      },
      async new() {
        calls.push("tab:new");
        return freshTab;
      },
    },
  };
  const handle = createRecording({
    _dependencies: {
      clock: harness.clock,
      async createRecordingArtifactTransaction(options) {
        calls.push("artifacts:prepare");
        assert.equal(
          options.destinationDirectory,
          "/Users/example/Downloads/Codex Browser Recordings",
        );
        return {
          capturePath: "/private/recording/recording.mp4",
          async finalize(finalization) {
            calls.push("artifacts:finalize");
            assert.equal(finalization.ffprobePath, "/opt/ffprobe");
            return {
              paths: {
                outputPath:
                  "/Users/example/Downloads/Codex Browser Recordings/browser-recording.mp4",
              },
              result: { failureCode: null, status: "passed" },
            };
          },
          async rollback() {},
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
          outputDirectory:
            "/Users/example/Downloads/Codex Browser Recordings",
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
    homeDirectory: "/Users/example",
    targetUrl: "https://example.com/demo",
    temporaryRoot: "/private/tmp",
  });

  assert.equal(await handle.ready, freshTab);
  assert.deepEqual(calls, [
    "artifacts:prepare",
    "tab:new",
    "goto:https://example.com/demo",
    "capability:cdp",
    "doctor",
    "capture:start",
  ]);
  assert.deepEqual(await handle.stop(), {
    paths: {
      outputPath:
        "/Users/example/Downloads/Codex Browser Recordings/browser-recording.mp4",
    },
    result: { failureCode: null, status: "passed" },
  });
  assert.deepEqual(calls.slice(-3), [
    "artifacts:finalize",
    "tab:close",
    "tabs:list",
  ]);
});

test("runs a pointer action only after fresh evidence crosses its boundary", async () => {
  const capture = {
    cursorEventsCaptured: 0,
    cursorFramesObserved: 1,
    cursorLastEventEpochMs: null,
    framesReceived: 12,
  };
  const harness = createHarness({ capture });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    requirePointerEvents: true,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  let actionsPerformed = 0;
  const action = handle.runAction({
    perform() {
      actionsPerformed += 1;
      capture.cursorEventsCaptured = 1;
      capture.cursorLastEventEpochMs = harness.clock.now();
      return "clicked";
    },
    requiresPointerEvidence: true,
  });
  await settleWorkflow();
  harness.clock.advance(200);
  const result = await action;

  assert.equal(result, "clicked");
  assert.equal(actionsPerformed, 1);
  await handle.stop();
});

test("re-attests the approved origin before a sequential action may continue", async () => {
  const attestation = deferred();
  const harness = createHarness({
    approvedOriginAttestation: () => attestation.promise,
    autoStop: false,
  });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  let secondActionPerformed = false;
  const sequence = (async () => {
    await handle.runAction({
      perform: () => "first action",
      requiresPointerEvidence: false,
    });
    return handle.runAction({
      perform() {
        secondActionPerformed = true;
      },
      requiresPointerEvidence: false,
    });
  })();
  void sequence.catch(() => {});
  await settleWorkflow();

  assert.equal(harness.calls.assertApprovedOrigin, 1);
  assert.equal(secondActionPerformed, false);

  attestation.reject(
    Object.assign(new Error("private foreign-origin diagnostic"), {
      code: "origin_changed_during_recording",
    }),
  );
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "origin_changed_during_recording",
  );
  harness.stopDeferred.resolve({
    paths: {},
    result: {
      failureCode: "origin_changed_during_recording",
      status: "failed",
    },
  });

  await assert.rejects(sequence, (error) => {
    assert.equal(error.code, "origin_changed_during_recording");
    assert.doesNotMatch(JSON.stringify(error), /foreign-origin diagnostic/);
    return true;
  });
  assert.equal(secondActionPerformed, false);
  assert.deepEqual((await handle.stop()).paths, {});
});

test("waits for fresh pointer evidence within the bounded grace period", async () => {
  const capture = {
    cursorEventsCaptured: 0,
    cursorFramesObserved: 1,
    cursorLastEventEpochMs: null,
    framesReceived: 12,
  };
  const harness = createHarness({ capture });
  harness.clock.advance(1_000);
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    requirePointerEvents: true,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform: () => "clicked",
    requiresPointerEvidence: true,
  });
  await settleWorkflow();
  harness.clock.advance(50);
  capture.cursorEventsCaptured = 1;
  capture.cursorLastEventEpochMs = harness.clock.now();
  await settleWorkflow();
  harness.clock.advance(250);

  assert.equal(await action, "clicked");
  await handle.stop();
});

test("fails closed when the recording deadline cuts off the pointer tail", async () => {
  const capture = {
    cursorEventsCaptured: 0,
    cursorFramesObserved: 1,
    cursorLastEventEpochMs: null,
    framesReceived: 12,
  };
  const harness = createHarness({ autoStop: false, capture });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    durationMs: 5_000,
    requirePointerEvents: true,
    targetUrl: "https://example.com/",
  });
  await handle.ready;
  harness.clock.advance(4_900);

  const action = handle.runAction({
    perform() {
      capture.cursorEventsCaptured = 1;
      capture.cursorLastEventEpochMs = harness.clock.now();
      return "clicked";
    },
    requiresPointerEvidence: true,
  });
  void action.catch(() => {});
  await settleWorkflow();
  harness.clock.advance(100);
  await settleWorkflow();

  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "cursor_recording_failed",
  );
  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "cursor_recording_failed", status: "failed" },
  });
  await assert.rejects(action, { code: "cursor_recording_failed" });
  assert.equal(
    (await handle.finished).result.failureCode,
    "cursor_recording_failed",
  );
});

test("rejects delayed old pointer evidence without publishing", async () => {
  const capture = {
    cursorEventsCaptured: 4,
    cursorFramesObserved: 1,
    cursorLastEventEpochMs: 900,
    framesReceived: 12,
  };
  const harness = createHarness({ autoStop: false, capture });
  harness.clock.advance(1_000);
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    requirePointerEvents: true,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  let actionSettled = false;
  const action = handle.runAction({
    perform() {
      capture.cursorEventsCaptured = 5;
      capture.cursorLastEventEpochMs = 999;
    },
    requiresPointerEvidence: true,
  });
  void action.then(
    () => {
      actionSettled = true;
    },
    () => {
      actionSettled = true;
    },
  );

  await settleWorkflow();
  assert.equal(actionSettled, false, "evidence receives a bounded grace period");
  harness.clock.advance(1_000);
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "cursor_recording_failed",
  );
  assert.equal(
    actionSettled,
    false,
    "the action failure waits for recording cleanup",
  );

  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "cursor_recording_failed", status: "failed" },
  });
  await assert.rejects(action, { code: "cursor_recording_failed" });
  const output = await handle.stop();
  assert.deepEqual(output.paths, {});
  assert.equal(output.result.failureCode, "cursor_recording_failed");
});

test("sanitizes an action failure before cleanup and publication", async () => {
  const harness = createHarness({ autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform() {
      throw new Error("private Browser action diagnostic");
    },
    requiresPointerEvidence: false,
  });
  void action.catch(() => {});
  await settleWorkflow();
  assert.equal(harness.rawFinalizationOptions.failureCode, "recording_failed");

  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "recording_failed", status: "failed" },
  });
  await assert.rejects(action, (error) => {
    assert.equal(error.code, "recording_failed");
    assert.doesNotMatch(JSON.stringify(error), /private Browser action/);
    return true;
  });
  assert.deepEqual((await handle.stop()).paths, {});
});

test("preserves bounded cleanup metadata on an action failure", async () => {
  const harness = createHarness({ autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform() {
      throw new Error("private action failure");
    },
    requiresPointerEvidence: false,
  });
  void action.catch(() => {});
  await settleWorkflow();
  harness.stopDeferred.resolve({
    paths: { cleanupDirectory: "/private/action-cleanup" },
    result: { failureCode: "recording_failed", status: "failed" },
  });

  await assert.rejects(action, (error) => {
    assert.equal(error.code, "recording_failed");
    assert.deepEqual(getRecordingCleanupDetails(error), {
      cleanupIncomplete: true,
      directory: "/private/action-cleanup",
    });
    assert.doesNotMatch(JSON.stringify(error), /private action failure/);
    return true;
  });
  assert.deepEqual((await handle.stop()).paths, {
    cleanupDirectory: "/private/action-cleanup",
  });
});

test("maps an action-time Browser approval denial to cancellation", async () => {
  const harness = createHarness({ autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform() {
      throw new Error(
        "Browser Use rejected this action due to browser security policy. Reason: The user has requested that Chrome should not be used on this site. Do not attempt to circumvent this restriction or suggest alternative browser-control mechanisms.",
      );
    },
    requiresPointerEvidence: false,
  });
  void action.catch(() => {});
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "recording_cancelled",
  );

  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "recording_cancelled", status: "failed" },
  });
  await assert.rejects(action, { code: "cancelled" });
  assert.equal((await handle.finished).result.failureCode, "recording_cancelled");
});

test("fails closed when an action contradicts the session pointer policy", async () => {
  const harness = createHarness({ autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    requirePointerEvents: false,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform() {
      assert.fail("a contradictory action must not run");
    },
    requiresPointerEvidence: true,
  });
  void action.catch(() => {});
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "invalid_configuration",
  );

  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "invalid_configuration", status: "failed" },
  });
  await assert.rejects(action, { code: "invalid_configuration" });
  assert.deepEqual((await handle.stop()).paths, {});
});

test("cannot publish when stop races an in-flight action", async () => {
  const harness = createHarness({ autoStop: false });
  const performDeferred = deferred();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform: () => performDeferred.promise,
    requiresPointerEvidence: false,
  });
  void action.catch(() => {});
  await settleWorkflow();
  const stopping = handle.stop();
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "integration_failed",
  );

  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "integration_failed", status: "failed" },
  });
  const output = await stopping;
  assert.deepEqual(output.paths, {});
  await assert.rejects(action, { code: "integration_failed" });

  performDeferred.resolve("late success");
  await settleWorkflow();
  assert.equal((await handle.finished).result.failureCode, "integration_failed");
});

test("cannot publish when capture completion races an in-flight action", async () => {
  const harness = createHarness({ autoStop: false });
  const performDeferred = deferred();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform: () => performDeferred.promise,
    requiresPointerEvidence: false,
  });
  void action.catch(() => {});
  await settleWorkflow();
  harness.completionDeferred.resolve({ error: null });
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "integration_failed",
  );

  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "integration_failed", status: "failed" },
  });
  assert.deepEqual((await handle.stop()).paths, {});
  await assert.rejects(action, { code: "integration_failed" });

  performDeferred.resolve("late success");
  await settleWorkflow();
  assert.equal((await handle.finished).result.failureCode, "integration_failed");
});

test("preserves a capture failure that interrupts an in-flight action", async () => {
  const harness = createHarness({ autoStop: false });
  const performDeferred = deferred();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const action = handle.runAction({
    perform: () => performDeferred.promise,
    requiresPointerEvidence: false,
  });
  void action.catch(() => {});
  await settleWorkflow();
  harness.completionDeferred.resolve({
    error: { code: "origin_changed_during_recording" },
  });
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "origin_changed_during_recording",
  );

  harness.stopDeferred.resolve({
    paths: {},
    result: {
      failureCode: "origin_changed_during_recording",
      status: "failed",
    },
  });
  await assert.rejects(action, { code: "origin_changed_during_recording" });
  assert.deepEqual((await handle.stop()).paths, {});

  performDeferred.resolve("late success");
  await settleWorkflow();
  assert.equal(
    (await handle.finished).result.failureCode,
    "origin_changed_during_recording",
  );
});

test("rejects overlapping actions as one failed session", async () => {
  const harness = createHarness({ autoStop: false });
  const firstPerform = deferred();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });
  await handle.ready;

  const firstAction = handle.runAction({
    perform: () => firstPerform.promise,
    requiresPointerEvidence: false,
  });
  void firstAction.catch(() => {});
  await settleWorkflow();
  let secondPerformed = false;
  const secondAction = handle.runAction({
    perform() {
      secondPerformed = true;
    },
    requiresPointerEvidence: false,
  });
  void secondAction.catch(() => {});
  await settleWorkflow();

  assert.equal(secondPerformed, false);
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "integration_failed",
  );
  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "integration_failed", status: "failed" },
  });
  await assert.rejects(firstAction, { code: "integration_failed" });
  await assert.rejects(secondAction, { code: "integration_failed" });

  firstPerform.resolve("late success");
  await settleWorkflow();
  assert.deepEqual((await handle.stop()).paths, {});
});

test("rejects a malformed caller signal without retaining the singleton", async () => {
  const malformed = validOptions({ signal: {} });
  const handle = createRecording(malformed.options);

  assert.deepEqual(Object.keys(handle).sort(), [
    "finished",
    "ready",
    "runAction",
    "stop",
  ]);
  assert.equal(handle.finished, handle.stop());
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
    assert.deepEqual(Object.keys(handle).sort(), [
      "finished",
      "ready",
      "runAction",
      "stop",
    ]);
    await handle.ready;
    await handle.stop();

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
  assert.deepEqual(Object.keys(handle).sort(), [
    "finished",
    "ready",
    "runAction",
    "stop",
  ]);
  assert.equal(handle.finished, handle.stop());
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
  harness.dependencies.createRecordingArtifactTransaction = () => {
    preparationStarted = true;
    return preparationDeferred.promise;
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
    async rollback() {
      cleanupStarted = true;
      throw sanitizeRecordingFailure(
        { code: "cleanup_failed" },
        { cleanupDirectory: "/private/late-recording" },
      );
    },
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
  assert.equal(harness.calls.tabClose, 0);
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
  await assertSingletonReleased();
});

test("preserves a Saved Recording when fresh-tab close fails", async () => {
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
  const output = await handle.stop();
  assert.deepEqual(output, {
    cleanup: { browserTabCleanupIncomplete: true },
    paths: { outputPath: "/Users/example/Downloads/recording.mp4" },
    result: { failureCode: null, status: "passed" },
  });
  assert.doesNotMatch(JSON.stringify(output), /private tab identifier/);
  await assertSingletonReleased();
});

test("recovers from one transient close failure for the exact owned tab", async () => {
  const harness = createHarness();
  harness.freshTab.close = async () => {
    harness.calls.tabClose += 1;
    if (harness.calls.tabClose === 1) {
      throw new Error("transient Browser close failure");
    }
  };
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const output = await handle.stop();

  assert.equal(output.result.status, "passed");
  assert.equal(harness.calls.tabClose, 2);
  assert.equal(output, await handle.finished);
  await assertSingletonReleased();
});

test("retries a fulfilled close while the exact owned tab remains listed", async () => {
  const harness = createHarness();
  let tabOpen = true;
  harness.freshTab.id = "owned-recording-tab";
  harness.freshTab.close = async () => {
    harness.calls.tabClose += 1;
    if (harness.calls.tabClose === 2) tabOpen = false;
  };
  harness.browser.tabs.list = async () =>
    tabOpen ? [{ id: harness.freshTab.id }] : [];
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const output = await handle.stop();

  assert.equal(output.result.status, "passed");
  assert.equal(harness.calls.tabClose, 2);
  assert.equal(output.cleanup, undefined);
  await assertSingletonReleased();
});

test("reports cleanup incomplete when fulfilled closes leave the tab listed", async () => {
  const harness = createHarness();
  harness.freshTab.id = "owned-recording-tab";
  harness.freshTab.close = async () => {
    harness.calls.tabClose += 1;
  };
  harness.browser.tabs.list = async () => [{ id: harness.freshTab.id }];
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const output = await handle.stop();

  assert.equal(output.result.status, "passed");
  assert.equal(harness.calls.tabClose, 2);
  assert.deepEqual(output.cleanup, { browserTabCleanupIncomplete: true });
  await assertSingletonReleased();
});

test("reports cleanup incomplete when the exact tab identity is unavailable", async () => {
  const harness = createHarness();
  delete harness.freshTab.id;
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const output = await handle.stop();

  assert.equal(harness.calls.tabClose, 2);
  assert.deepEqual(output.cleanup, { browserTabCleanupIncomplete: true });
  await assertSingletonReleased();
});

test("reports cleanup incomplete when Browser tab inventory is unavailable", async () => {
  const harness = createHarness();
  delete harness.browser.tabs.list;
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const output = await handle.stop();

  assert.equal(harness.calls.tabClose, 2);
  assert.deepEqual(output.cleanup, { browserTabCleanupIncomplete: true });
  await assertSingletonReleased();
});

test("retries verified tab cleanup when cancellation races with creation", async () => {
  const harness = createHarness();
  const tabDeferred = deferred();
  let tabOpen = true;
  harness.browser.tabs.new = () => {
    harness.calls.tabNew += 1;
    return tabDeferred.promise;
  };
  harness.freshTab.close = async () => {
    harness.calls.tabClose += 1;
    if (harness.calls.tabClose === 2) tabOpen = false;
  };
  harness.browser.tabs.list = async () =>
    tabOpen ? [{ id: harness.freshTab.id }] : [];
  const handle = createRecording({
    _dependencies: harness.dependencies,
    browser: harness.browser,
    targetUrl: "https://example.com/",
  });

  await settleWorkflow();
  const stopped = handle.stop();
  tabDeferred.resolve(harness.freshTab);

  await assert.rejects(stopped, (error) => {
    assert.equal(error.code, "recording_cancelled");
    assert.equal(getRecordingCleanupDetails(error), null);
    return true;
  });
  assert.equal(harness.calls.tabClose, 2);
  await assert.rejects(handle.ready, (error) => error.code === "recording_cancelled");
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
  let lateTabCloseCalls = 0;
  tabDeferred.resolve({
    id: "late-recording-tab",
    async close() {
      lateTabCloseCalls += 1;
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
  assert.equal(lateTabCloseCalls, 2);
  await assert.rejects(handle.ready, (error) => error.code === "recording_cancelled");
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
  await assertSingletonReleased();
});

test("bounds cancellation and cleanup when artifact preparation never settles", async () => {
  const harness = createHarness();
  harness.dependencies.createRecordingArtifactTransaction = () =>
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
      artifactCleanupIncomplete: true,
    });
    return true;
  });
  assert.equal(harness.calls.tabClose, 0);
  await assertSingletonReleased();
});

test("bounds a hanging fresh-tab close without downgrading saved media", async () => {
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
  assert.deepEqual(await stopped, {
    cleanup: { browserTabCleanupIncomplete: true },
    paths: { outputPath: "/Users/example/Downloads/recording.mp4" },
    result: { failureCode: null, status: "passed" },
  });
  await assertSingletonReleased();
});

test("bounds a hanging artifact rollback after startup failure", async () => {
  const harness = createHarness();
  const createTransaction =
    harness.dependencies.createRecordingArtifactTransaction;
  harness.dependencies.createRecordingArtifactTransaction = async (options) => ({
    ...(await createTransaction(options)),
    rollback: () => new Promise(() => {}),
  });
  harness.dependencies.startBrowserRecordingForTab = async () => {
    throw Object.assign(new Error("private startup diagnostic"), {
      code: "frame_stream_unavailable",
    });
  };
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
      artifactCleanupIncomplete: true,
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
      artifactCleanupIncomplete: true,
    });
    return true;
  });
  assert.equal(harness.calls.tabClose, 1);
  await assertSingletonReleased();
});

test("a timed-out finalization cannot publish after its capture resolves late", async () => {
  const clock = createFakeClock();
  const lateCapture = deferred();
  let finalization;
  let published = false;
  const handle = createRecording({
    _dependencies: {
      clock,
      async createRecordingArtifactTransaction() {
        return {
          capturePath: "/private/recording/recording.mp4",
          async finalize(options) {
            finalization = options;
            published = options.failureCode === null;
            return {
              paths: {},
              result: {
                failureCode: options.failureCode,
                status: options.failureCode === null ? "passed" : "failed",
              },
            };
          },
          async rollback() {},
        };
      },
      async doctor() {
        return {
          blockingReasons: [],
          ffmpegPath: "/opt/ffmpeg",
          ffprobePath: "/opt/ffprobe",
          supported: true,
        };
      },
      async startBrowserRecordingForTab() {
        return {
          completion: new Promise(() => {}),
          ready: Promise.resolve(),
          stats: { framePump: {}, resources: {}, sink: {} },
          status() {
            return { capture: null };
          },
          stop() {
            return lateCapture.promise;
          },
        };
      },
    },
    browser: {
      tabs: {
        async new() {
          return {
            capabilities: {
              async get() {
                return { readEvents() {}, send() {} };
              },
            },
            async close() {},
            async goto() {},
          };
        },
      },
    },
    targetUrl: "https://example.com/",
  });

  await handle.ready;
  const stopping = handle.stop();
  await settleWorkflow();
  clock.advance(10_000);
  await assert.rejects(stopping, { code: "integration_failed" });

  lateCapture.resolve({ elapsedMs: 100, framesReceived: 1 });
  await settleWorkflow();
  assert.equal(finalization.failureCode, "recording_cancelled");
  assert.equal(published, false);
});

test("a timed-out artifact finalization cannot publish after validation resolves late", async () => {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "browser-recorder-finalization-fence-"),
  );
  const destinationDirectory = join(repositoryRoot, "saved");
  const temporaryRoot = join(repositoryRoot, "working");
  await mkdir(temporaryRoot);
  const validationGate = deferred();
  const clock = createFakeClock();
  let underlyingFinalization;

  try {
    const handle = createRecording({
      _dependencies: {
        clock,
        async createRecordingArtifactTransaction(options) {
          const transaction = await createRecordingArtifactTransaction({
            ...options,
            _dependencies: {
              async validateVideo() {
                await validationGate.promise;
                return {
                  codecName: "h264",
                  durationSeconds: 0.1,
                  height: 720,
                  sizeBytes: 200,
                  width: 1280,
                };
              },
            },
          });
          return {
            capturePath: transaction.capturePath,
            finalize(options) {
              underlyingFinalization = transaction.finalize(options);
              return underlyingFinalization;
            },
            rollback: transaction.rollback,
          };
        },
        async doctor() {
          return {
            blockingReasons: [],
            ffmpegPath: "/opt/ffmpeg",
            ffprobePath: "/opt/ffprobe",
            supported: true,
          };
        },
        async startBrowserRecordingForTab({ outputPath }) {
          await writeFile(outputPath, Buffer.alloc(200, 1));
          return {
            completion: new Promise(() => {}),
            ready: Promise.resolve(),
            stats: { cursor: {}, framePump: {}, resources: {}, sink: {} },
            async stop() {
              return { elapsedMs: 100, framesReceived: 1 };
            },
          };
        },
      },
      browser: {
        tabs: {
          async new() {
            return {
              capabilities: {
                async get() {
                  return { readEvents() {}, send() {} };
                },
              },
              async close() {},
              async goto() {},
            };
          },
        },
      },
      destinationDirectory,
      recordingName: "recording",
      targetUrl: "https://example.com/",
      temporaryRoot,
    });

    await handle.ready;
    const stopping = handle.stop();
    await settleWorkflow();
    clock.advance(10_000);
    await assert.rejects(stopping, { code: "integration_failed" });
    await assert.rejects(access(join(destinationDirectory, "recording.mp4")));

    validationGate.resolve();
    await assert.rejects(underlyingFinalization, {
      code: "recording_cancelled",
    });
    await assert.rejects(access(join(destinationDirectory, "recording.mp4")));
  } finally {
    validationGate.resolve();
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("an external abort cannot publish after earlier pointer evidence", async () => {
  const harness = createHarness({
    autoStop: false,
    capture: {
      cursorEventsCaptured: 4,
      cursorFramesObserved: 1,
      cursorLastEventEpochMs: 1_000,
      framesReceived: 12,
    },
  });
  const actionAbortController = new AbortController();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    signal: actionAbortController.signal,
    targetUrl: "https://example.com/",
    browser: harness.browser,
  });
  await handle.ready;

  actionAbortController.abort();
  const stopping = handle.stop();
  await settleWorkflow();
  assert.equal(
    harness.rawFinalizationOptions.failureCode,
    "recording_cancelled",
  );
  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: "recording_cancelled", status: "failed" },
  });

  const output = await stopping;
  assert.deepEqual(output.paths, {});
  assert.equal(output.result.status, "failed");
  assert.equal(output.result.failureCode, "recording_cancelled");
  assert.equal(output, await handle.finished);
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
      artifactCleanupIncomplete: true,
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
  const output = await handle.stop();
  assert.deepEqual(output, {
    cleanup: { browserTabCleanupIncomplete: true },
    paths: {},
    result: { failureCode: "frame_ack_failed", status: "failed" },
  });
  assert.doesNotMatch(JSON.stringify(output), /private close failure/);
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
  assert.equal(harness.rawRecordingOptions.signal.aborted, false);
  assert.equal(harness.clock.pending, 1);
  const naturallyFinished = handle.finished;
  let finished = false;
  void naturallyFinished.then(() => {
    finished = true;
  });
  harness.clock.advance(4_999);
  await settleWorkflow();
  assert.equal(finished, false);
  assert.equal(harness.calls.stop, 0);
  harness.clock.advance(1);
  const naturalOutput = await naturallyFinished;
  const first = handle.stop();
  const second = handle.stop();
  assert.equal(first, second);
  assert.equal(first, naturallyFinished);
  assert.deepEqual(await first, naturalOutput);
  assert.equal(harness.rawRecordingOptions.signal.aborted, false);
  assert.equal(harness.calls.stop, 1);
  assert.equal(harness.clock.pending, 0);
});

test("finished stays pending through readiness and finalization", async () => {
  const harness = createHarness({ autoReady: false, autoStop: false });
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "https://example.com/",
    browser: harness.browser,
  });

  let finished = false;
  void handle.finished.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await settleWorkflow();
  assert.equal(finished, false);
  harness.readyDeferred.resolve(true);
  await handle.ready;
  const stopped = handle.stop();
  assert.equal(stopped, handle.finished);
  await settleWorkflow();
  assert.equal(finished, false);
  harness.stopDeferred.resolve({
    paths: {},
    result: { failureCode: null, status: "passed" },
  });
  assert.deepEqual(await stopped, {
    paths: {},
    result: { failureCode: null, status: "passed" },
  });
  assert.equal(finished, true);
});

test("reserves and releases the singleton across every terminal path", async () => {
  const firstOptions = validOptions();
  const first = createRecording(firstOptions.options);
  const concurrent = createRecording(validOptions().options);
  await assert.rejects(
    concurrent.ready,
    (error) => error.code === "recording_already_active",
  );
  await assert.rejects(
    concurrent.finished,
    (error) => error.code === "recording_already_active",
  );

  await first.ready;
  assert.equal(first.stop(), first.finished);
  await first.finished;

  const nextOptions = validOptions();
  const next = createRecording(nextOptions.options);
  await next.ready;
  assert.equal(next.stop(), next.finished);
  await next.finished;
});

const terminalCases = [
  {
    expectedCode: "frame_stream_unavailable",
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
    expectedFailureCode: "frame_stream_stalled",
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
    expectedFailureCode: null,
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
      let finished = false;
      void handle.finished.then(() => {
        finished = true;
      });
      await settleWorkflow();
      assert.equal(finished, false);
      harness.readyDeferred.resolve(true);
      assert.equal(await handle.ready, harness.freshTab);
      await handle.finished;
      assert.equal(finished, true);
      assert.equal(harness.clock.pending, 0);
      return { handle, harness };
    },
  },
  {
    expectedCode: "recording_cancelled",
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
      assert.equal(firstStop, handle.finished);
      await settleWorkflow();
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
    expectedFailureCode: "recording_cancelled",
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

test("keeps terminal outcomes stable and releases every terminal reservation", async (t) => {
  for (const scenario of terminalCases) {
    await t.test(scenario.name, async () => {
      const { handle, harness } = await scenario.run();
      if (scenario.expectedCode !== undefined) {
        await assert.rejects(
          handle.finished,
          (error) => error.code === scenario.expectedCode,
        );
      } else {
        const output = await handle.finished;
        assert.equal(
          output.result.status,
          scenario.expectedFailureCode == null ? "passed" : "failed",
        );
        assert.equal(output.result.failureCode, scenario.expectedFailureCode);
      }
      assert.equal(handle.finished, handle.stop());
      assert.equal(harness.rawFinalizationOptions.capture.framesReceived, 12);
      harness.readyDeferred.resolve(true);
      await settleWorkflow();
      assert.equal(handle.finished, handle.stop());
      await assertSingletonReleased();
    });
  }
});
