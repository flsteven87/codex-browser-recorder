import assert from "node:assert/strict";
import test from "node:test";

import {
  createExampleRecording,
  EXAMPLE_PAGE_URL,
  EXAMPLE_RECORDING_MAX_DURATION_MS,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/example-recording-gate.mjs";

const activeKey = Symbol.for("codex-browser-recorder.active");

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function waitForCondition(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not satisfied");
}

function createHarness({
  create,
  ready = Promise.resolve(),
  stopError,
} = {}) {
  const calls = { create: 0, stop: 0 };
  const stopped = deferred();
  let receivedOptions;
  const inner = {
    ready,
    status() {
      return { capture: {}, state: "recording" };
    },
    async stop() {
      calls.stop += 1;
      if (stopError !== undefined) {
        stopped.resolve({ error: stopError });
        throw stopError;
      }
      const result = { result: { status: "passed" } };
      stopped.resolve(result);
      return result;
    },
  };
  return {
    calls,
    dependencies: {
      async createBrowserRecording(options) {
        calls.create += 1;
        receivedOptions = options;
        if (create !== undefined) {
          return create(inner);
        }
        return inner;
      },
    },
    inner,
    stopped,
    terminate() {
      receivedOptions?._onTerminal?.();
    },
    get receivedOptions() {
      return receivedOptions;
    },
  };
}

test.afterEach(() => {
  delete globalThis[activeKey];
});

test("applies the complete fixed recording policy", async () => {
  const harness = createHarness();
  const tab = { id: "approved-tab" };
  const handle = await createExampleRecording({
    _dependencies: harness.dependencies,
    ffmpegPath: "/usr/local/bin/ffmpeg",
    ffprobePath: "/usr/local/bin/ffprobe",
    tab,
    temporaryRoot: "/private/tmp",
  });

  assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
  assert.equal(EXAMPLE_PAGE_URL, "https://example.com/");
  assert.equal(EXAMPLE_RECORDING_MAX_DURATION_MS, 20_000);
  assert.deepEqual(harness.receivedOptions, {
    _onTerminal: harness.receivedOptions._onTerminal,
    approvedOrigin: "https://example.com",
    ffmpegPath: "/usr/local/bin/ffmpeg",
    ffprobePath: "/usr/local/bin/ffprobe",
    fps: 10,
    maxDecodedBytes: 5 * 1024 * 1024,
    maxDurationMs: 20_000,
    maxFrameStallMs: 5_000,
    maxHeight: 720,
    maxOutputBytes: 500 * 1024 * 1024,
    maxWidth: 1280,
    signal: undefined,
    tab,
    temporaryRoot: "/private/tmp",
  });
  assert.equal(typeof harness.receivedOptions._onTerminal, "function");
});

test("rejects a concurrent recording before allocating another session", async () => {
  const harness = createHarness();
  await createExampleRecording({
    _dependencies: harness.dependencies,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tab: {},
  });

  await assert.rejects(
    createExampleRecording({
      _dependencies: harness.dependencies,
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      tab: {},
    }),
    (error) => error.code === "recording_already_active",
  );
  assert.equal(harness.calls.create, 1);
});

test("reserves the singleton while adapter creation is pending", async () => {
  const creation = deferred();
  const harness = createHarness({ create: () => creation.promise });
  const options = {
    _dependencies: harness.dependencies,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tab: {},
  };

  const first = createExampleRecording(options);
  const second = createExampleRecording(options);
  const allocationsBeforeResolve = harness.calls.create;
  creation.resolve(harness.inner);
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);

  assert.equal(allocationsBeforeResolve, 1);
  assert.equal(harness.calls.create, 1);
  assert.equal(firstResult.status, "fulfilled");
  assert.equal(secondResult.status, "rejected");
  assert.equal(secondResult.reason.code, "recording_already_active");

  const handle = firstResult.value;
  await handle.stop();
});

test("releases the singleton when adapter creation rejects", async () => {
  const failure = new Error("Adapter creation failed");
  const failingHarness = createHarness({
    create: async () => {
      throw failure;
    },
  });
  const options = {
    _dependencies: failingHarness.dependencies,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tab: {},
  };

  await assert.rejects(createExampleRecording(options), (error) => error === failure);

  const nextHarness = createHarness();
  const next = await createExampleRecording({
    ...options,
    _dependencies: nextHarness.dependencies,
  });
  await next.stop();
  assert.equal(failingHarness.calls.create, 1);
  assert.equal(nextHarness.calls.create, 1);
});

test("memoizes stop and releases the singleton in a finally path", async () => {
  const harness = createHarness();
  const options = {
    _dependencies: harness.dependencies,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tab: {},
  };
  const handle = await createExampleRecording(options);

  const firstStop = handle.stop();
  const secondStop = handle.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(harness.calls.stop, 1);

  const next = await createExampleRecording(options);
  await next.stop();
  assert.equal(harness.calls.create, 2);
});

test("memoizes a rejected stop and releases the singleton", async () => {
  const failure = new Error("Finalization failed");
  const harness = createHarness({ stopError: failure });
  const options = {
    _dependencies: harness.dependencies,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tab: {},
  };
  const handle = await createExampleRecording(options);

  const firstStop = handle.stop();
  const secondStop = handle.stop();
  assert.equal(firstStop, secondStop);
  await assert.rejects(firstStop, (error) => error === failure);
  assert.equal(harness.calls.stop, 1);

  const nextHarness = createHarness();
  const next = await createExampleRecording({
    ...options,
    _dependencies: nextHarness.dependencies,
  });
  await next.stop();
});

test("automatically stops and releases the singleton after readiness failure", async () => {
  const readiness = deferred();
  const harness = createHarness({ ready: readiness.promise });
  const options = {
    _dependencies: harness.dependencies,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tab: {},
  };
  const handle = await createExampleRecording(options);
  const failure = Object.assign(new Error("No frame"), {
    code: "frame_stream_unavailable",
  });

  readiness.reject(failure);
  await assert.rejects(handle.ready, (error) => error === failure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.stop, 1);

  const next = await createExampleRecording(options);
  await next.stop();
});

test("automatically finalizes and releases after an after-ready terminal failure", async () => {
  const harness = createHarness();
  const options = {
    _dependencies: harness.dependencies,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tab: {},
  };
  const handle = await createExampleRecording(options);
  await handle.ready;

  harness.terminate();
  const result = await harness.stopped.promise;

  assert.equal(result.result.status, "passed");
  assert.equal(harness.calls.stop, 1);
  await waitForCondition(() => globalThis[activeKey] == null);
  const next = await createExampleRecording(options);
  await next.stop();
  assert.equal(harness.calls.create, 2);
});
