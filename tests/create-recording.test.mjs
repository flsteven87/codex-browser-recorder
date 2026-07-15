import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecording,
  describeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";

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
  const calls = { createBrowserRecording: 0, stop: 0 };
  let rawRecordingOptions;
  let stopPromise;

  if (autoReady) readyDeferred.resolve(true);
  if (autoStop) stopDeferred.resolve(stopOutput);

  const inner = {
    completion: completionDeferred.promise,
    ready: readyDeferred.promise,
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

  return {
    calls,
    clock,
    completionDeferred,
    dependencies: {
      clock,
      async createBrowserRecording(options) {
        calls.createBrowserRecording += 1;
        rawRecordingOptions = options;
        return inner;
      },
    },
    inner,
    readyDeferred,
    get rawRecordingOptions() {
      return rawRecordingOptions;
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
      targetUrl: "https://example.com/demo",
      tab: {},
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
    tab: {},
  });

  assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
  assert.deepEqual(assertPublicStatus(handle, "preparing"), {
    capture: null,
    state: "preparing",
  });
  assert.equal(harness.calls.createBrowserRecording, 0);

  await handle.ready;
  assert.deepEqual(harness.recordingOptions, {
    approvedOrigin: "https://example.com",
    maxDurationMs: 65_000,
  });
  assert.equal("maxDecodedBytes" in harness.rawRecordingOptions, false);
  assert.equal("maxOutputBytes" in harness.rawRecordingOptions, false);
  assert.equal("maxWidth" in harness.rawRecordingOptions, false);
  assertPublicStatus(handle, "recording");
  await handle.stop();
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
  assert.equal(malformed.harness.calls.createBrowserRecording, 0);

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
  assert.equal(configured.harness.calls.createBrowserRecording, 0);

  await assertSingletonReleased();
});

test("immediate stop cancels preparation and releases the singleton", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "https://example.com/",
    tab: {},
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
  assert.equal(harness.calls.createBrowserRecording, 0);
  assertPublicStatus(handle, "cancelled");
  await assertSingletonReleased();
});

test("rejects invalid targets before lower-level allocation", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "file:///private/secret",
    tab: {},
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
  assert.equal(harness.calls.createBrowserRecording, 0);
  assertPublicStatus(handle, "failed");
  const firstStop = handle.stop();
  assert.equal(firstStop, handle.stop());
  await assert.rejects(firstStop, (error) => error === readyError);
  await assertSingletonReleased();
});

test("stops cleanly at the requested duration and memoizes finalization", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    durationMs: 5_000,
    targetUrl: "https://example.com/",
    tab: {},
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
    tab: {},
  });

  await Promise.resolve();
  await Promise.resolve();
  assertPublicStatus(handle, "awaiting_frame");
  harness.readyDeferred.resolve(true);
  await handle.ready;
  const stopped = handle.stop();
  await Promise.resolve();
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
        tab: {},
      });
      await Promise.resolve();
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
      await Promise.resolve();
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
      const harness = createHarness();
      const handle = createRecording({
        _dependencies: harness.dependencies,
        targetUrl: "https://example.com/",
        tab: {},
      });
      await handle.ready;
      harness.completionDeferred.resolve({
        paths: {},
        result: { failureCode: "frame_stream_stalled", status: "failed" },
      });
      await harness.completionDeferred.promise;
      await Promise.resolve();
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
        tab: {},
      });
      await Promise.resolve();
      harness.completionDeferred.resolve({
        paths: {},
        result: { failureCode: null, status: "passed" },
      });
      await harness.completionDeferred.promise;
      await Promise.resolve();
      assertPublicStatus(handle, "completed");
      harness.readyDeferred.resolve(true);
      await handle.ready;
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
        tab: {},
      });
      await Promise.resolve();
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
      await Promise.resolve();
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
        tab: {},
      });
      await handle.ready;
      const firstStop = handle.stop();
      assert.equal(firstStop, handle.stop());
      await Promise.resolve();
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
      const harness = createHarness();
      const handle = createRecording({
        _dependencies: harness.dependencies,
        targetUrl: "https://example.com/",
        tab: {},
      });
      await handle.ready;
      harness.completionDeferred.reject(
        Object.assign(new Error("private cancellation detail"), {
          code: "recording_cancelled",
        }),
      );
      await Promise.resolve();
      return { handle, harness };
    },
  },
];

test("keeps terminal states monotonic and releases every terminal reservation", async (t) => {
  for (const scenario of terminalCases) {
    await t.test(scenario.name, async () => {
      const { handle, harness } = await scenario.run();
      const status = assertPublicStatus(handle, scenario.expectedState);
      assert.deepEqual(status.capture, { framesReceived: 12 });
      if (scenario.expectedCode !== undefined) {
        const stopped = handle.stop();
        await assert.rejects(
          stopped,
          (error) => error.code === scenario.expectedCode,
        );
        assert.equal(stopped, handle.stop());
      }
      harness.readyDeferred.resolve(true);
      await Promise.resolve();
      assertPublicStatus(handle, scenario.expectedState);
      await assertSingletonReleased();
    });
  }
});
