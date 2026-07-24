import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";
import {
  createRecordingFlow,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/record-browser-flow.mjs";
import { createRecordingArtifactTransaction } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs";
import {
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

const PASSED_OUTPUT = Object.freeze({
  paths: {
    outputPath: "/Users/example/Downloads/Codex Browser Recordings/demo.mp4",
  },
  result: {
    failureCode: null,
    status: "passed",
  },
});

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

function createControllableCodexInAppBrowser({ frame, targetUrl }) {
  const calls = {
    acknowledgements: 0,
    cdpAcquisitions: 0,
    cdpMethods: [],
    goto: [],
    tabClose: 0,
    tabsNew: 0,
  };
  let screencastStarted = false;
  let tabOpen = false;
  const cdp = {
    async readEvents({ afterSequence = 0, methods = [] } = {}) {
      const frameAvailable =
        screencastStarted &&
        afterSequence < 1 &&
        methods.includes("Page.screencastFrame");
      if (!frameAvailable) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return {
        cursor: screencastStarted ? 1 : 0,
        events: frameAvailable
          ? [
              {
                method: "Page.screencastFrame",
                params: {
                  data: frame.toString("base64"),
                  metadata: { timestamp: 1 },
                  sessionId: 1,
                },
                sequence: 1,
              },
            ]
          : [],
        hasMore: false,
        truncated: false,
      };
    },
    async send(method) {
      calls.cdpMethods.push(method);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: targetUrl },
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 1 };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: { value: { height: 180, width: 320 } },
        };
      }
      if (method === "Page.startScreencast") {
        screencastStarted = true;
      }
      if (method === "Page.screencastFrameAck") {
        calls.acknowledgements += 1;
      }
      return {};
    },
  };
  const tab = {
    capabilities: {
      async get(capability) {
        assert.equal(capability, "cdp");
        calls.cdpAcquisitions += 1;
        return cdp;
      },
    },
    async close() {
      calls.tabClose += 1;
      tabOpen = false;
    },
    async goto(url) {
      calls.goto.push(url);
    },
    id: "controllable-codex-in-app-browser-tab",
  };
  const browser = {
    tabs: {
      async list() {
        return tabOpen ? [tab] : [];
      },
      async new() {
        calls.tabsNew += 1;
        tabOpen = true;
        return tab;
      },
    },
  };
  return { browser, calls };
}

function createCoordinatorHarness({
  approvedOriginAttestation = async () => {},
  capture = { framesReceived: 12 },
  createArtifactTransaction,
  onStart,
} = {}) {
  const clock = createFakeClock();
  const calls = {
    assertApprovedOrigin: 0,
    tabClose: 0,
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
    id: "production-owned-fresh-tab",
  };
  const browser = {
    tabs: {
      async list() {
        return [];
      },
      async new() {
        return freshTab;
      },
    },
  };
  const sessionDependencies = {
    clock,
    async createRecordingArtifactTransaction(options) {
      if (createArtifactTransaction != null) {
        return createArtifactTransaction(options);
      }
      return {
        capturePath: "/private/recording/recording.mp4",
        async finalize(options) {
          return {
            paths:
              options.failureCode == null
                ? { outputPath: "/tmp/public-recording.mp4" }
                : {},
            result: {
              failureCode: options.failureCode,
              status: options.failureCode == null ? "passed" : "failed",
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
    async startBrowserRecordingForTab(options) {
      await onStart?.(options);
      return {
        async assertApprovedOrigin() {
          calls.assertApprovedOrigin += 1;
          return approvedOriginAttestation();
        },
        completion: new Promise(() => {}),
        ready: Promise.resolve(),
        stats: {
          cursor: {},
          framePump: capture,
          resources: {},
          sink: {},
        },
        async stop() {
          return { elapsedMs: 500, ...capture };
        },
      };
    },
  };
  const flow = createRecordingFlow({
    dependencies: {
      createSession(options) {
        return createRecording({
          ...options,
          _dependencies: sessionDependencies,
        });
      },
      async inspectLocalEnvironment() {
        return {
          blockingReasons: [],
          ffmpegH264Available: true,
          ffmpegMp4Available: true,
          ffprobeUsable: true,
          outputDirectoryWritable: true,
          platform: "darwin",
          supported: true,
        };
      },
    },
  });

  return {
    browser,
    calls,
    clock,
    flow,
  };
}

function createHarness({ environment, output = PASSED_OUTPUT } = {}) {
  const calls = {
    createSession: 0,
    inspect: 0,
    runAction: [],
    stop: 0,
  };
  const tab = { id: "owned-fresh-tab" };
  let sessionOptions;
  const session = {
    finished: Promise.resolve(output),
    ready: Promise.resolve(tab),
    async runAction(options) {
      calls.runAction.push(options);
      return options.perform();
    },
    async stop() {
      calls.stop += 1;
      return output;
    },
  };
  const flow = createRecordingFlow({
    dependencies: {
      createSession(options) {
        calls.createSession += 1;
        sessionOptions = options;
        return session;
      },
      async inspectLocalEnvironment() {
        calls.inspect += 1;
        return environment ?? {
          blockingReasons: [],
          ffmpegH264Available: true,
          ffmpegMp4Available: true,
          ffprobeUsable: true,
          outputDirectoryWritable: true,
          platform: "darwin",
          supported: true,
        };
      },
    },
  });

  return {
    calls,
    flow,
    session,
    tab,
    get sessionOptions() {
      return sessionOptions;
    },
  };
}

function recordingSpec(overrides = {}) {
  return {
    actions: [
      {
        label: "Open the standards section",
        modality: "pointer",
        async perform({ tab }) {
          return tab.id;
        },
      },
    ],
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    durationMs: 15_000,
    durationWasExplicit: false,
    now: new Date("2026-07-19T09:00:00+08:00"),
    recordingName: "demo",
    targetUrl: "https://example.com/demo?private=not-for-consent",
    ...overrides,
  };
}

test("prepares an opaque action-driven plan without Browser activity", async () => {
  const harness = createHarness();

  const prepared = await harness.flow.prepareRecording(recordingSpec());

  assert.equal(prepared.status, "prepared");
  assert.equal(harness.calls.inspect, 1);
  assert.equal(harness.calls.createSession, 0);
  assert.deepEqual(prepared.consent, {
    actions: [
      { label: "Open the standards section", modality: "pointer" },
    ],
    approvedOrigin: "https://example.com",
    browserSurface: "Codex In-app Browser",
    end: {
      hardLimitMs: 15_000,
      kind: "actions_complete",
    },
    output: {
      destinationDirectory:
        "/Users/example/Downloads/Codex Browser Recordings",
      outputFilename: "demo.mp4",
    },
    requirePointerEvents: true,
  });
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.consent), true);
  assert.equal(JSON.stringify(prepared).includes("private="), false);
});

test("rejects recording surface selection before local or Browser activity", async () => {
  const harness = createHarness();

  for (const browserSurface of ["chrome", "iab"]) {
    const prepared = await harness.flow.prepareRecording(
      recordingSpec({ browserSurface }),
    );

    assert.equal(prepared.status, "blocked");
    assert.equal(prepared.blockers[0].code, "invalid_configuration");
  }
  assert.equal(harness.calls.inspect, 0);
  assert.equal(harness.calls.createSession, 0);
});

test("reports every local blocker and never creates a Browser session", async () => {
  const harness = createHarness({
    environment: {
      blockingReasons: ["ffmpeg_missing", "ffprobe_missing"],
      ffmpegH264Available: false,
      ffmpegMp4Available: false,
      ffprobeUsable: false,
      outputDirectoryWritable: true,
      platform: "darwin",
      supported: false,
    },
  });

  const prepared = await harness.flow.prepareRecording(recordingSpec());

  assert.equal(prepared.status, "blocked");
  assert.deepEqual(
    prepared.blockers.map(({ code }) => code),
    ["ffmpeg_missing", "ffprobe_missing"],
  );
  assert.equal(harness.calls.createSession, 0);
});

test("returns a bounded local-only preflight report", async () => {
  const harness = createHarness();

  const report = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });

  assert.deepEqual(report, {
    environment: {
      ffmpegH264Available: true,
      ffmpegMp4Available: true,
      ffprobeUsable: true,
      outputDirectoryWritable: true,
      platform: "darwin",
      supported: true,
    },
    output: {
      destinationDirectory:
        "/Users/example/Downloads/Codex Browser Recordings",
      outputFilename: report.output.outputFilename,
    },
    status: "preflight_passed",
  });
  assert.match(
    report.output.outputFilename,
    /^browser-recording-\d{4}-\d{2}-\d{2}-\d{6}[.]mp4$/u,
  );
  assert.equal(harness.calls.createSession, 0);
});

test("executes the approved actions and returns one completed outcome", async () => {
  const harness = createHarness();
  const prepared = await harness.flow.prepareRecording(recordingSpec());

  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result, PASSED_OUTPUT.result);
  assert.equal(outcome.paths, PASSED_OUTPUT.paths);
  assert.deepEqual(outcome.cleanup, {
    artifactCleanupIncomplete: false,
    browserTabCleanupIncomplete: false,
    directory: null,
    file: null,
  });
  assert.equal(harness.calls.createSession, 1);
  assert.equal(harness.calls.runAction.length, 1);
  assert.equal(
    harness.calls.runAction[0].requiresPointerEvidence,
    true,
  );
  assert.equal(await harness.calls.runAction[0].perform(), harness.tab.id);
  assert.equal(harness.calls.stop, 1);
  assert.equal(harness.sessionOptions.requirePointerEvents, true);
});

test("produces a validated MP4 through a controllable Codex In-app Browser", async () => {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "browser-recorder-iab-happy-path-"),
  );
  const destinationDirectory = join(repositoryRoot, "saved");
  const temporaryRoot = join(repositoryRoot, "working");
  const targetUrl = "https://example.com/recording";
  await mkdir(destinationDirectory);
  await mkdir(temporaryRoot);
  const frame = execFileSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180",
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ]);
  const iab = createControllableCodexInAppBrowser({ frame, targetUrl });
  const flow = createRecordingFlow();

  try {
    const prepared = await flow.prepareRecording({
      actions: [
        {
          label: "Read the approved page",
          modality: "programmatic",
          async perform({ tab }) {
            assert.equal(
              tab.id,
              "controllable-codex-in-app-browser-tab",
            );
          },
        },
      ],
      destinationDirectory,
      durationWasExplicit: false,
      recordingName: "iab-production-happy-path",
      targetUrl,
      temporaryRoot,
    });

    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.consent.browserSurface, "Codex In-app Browser");
    assert.equal(iab.calls.tabsNew, 0);

    const outcome = await flow.recordApproved(prepared, {
      browser: iab.browser,
    });

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.result.status, "passed");
    assert.equal(outcome.result.media.codecName, "h264");
    assert.equal(outcome.result.media.width, 320);
    assert.equal(outcome.result.media.height, 180);
    await access(outcome.paths.outputPath);
    const probe = JSON.parse(
      execFileSync(
        ffprobePath,
        [
          "-v",
          "error",
          "-show_streams",
          "-of",
          "json",
          outcome.paths.outputPath,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(
      probe.streams.filter(({ codec_type }) => codec_type === "video").length,
      1,
    );
    assert.equal(
      probe.streams.filter(({ codec_type }) => codec_type === "audio").length,
      0,
    );
    assert.equal(iab.calls.tabsNew, 1);
    assert.deepEqual(iab.calls.goto, [targetUrl]);
    assert.equal(iab.calls.cdpAcquisitions, 2);
    assert.equal(iab.calls.acknowledgements, 1);
    assert.equal(iab.calls.tabClose, 1);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("keeps an explicit duration authoritative after approved actions", async () => {
  const harness = createHarness();
  const prepared = await harness.flow.prepareRecording(
    recordingSpec({ durationWasExplicit: true }),
  );

  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });

  assert.deepEqual(prepared.consent.end, {
    durationMs: 15_000,
    kind: "duration",
  });
  assert.equal(outcome.status, "completed");
  assert.equal(harness.calls.stop, 0);
});

test("derives the action-driven hard limit instead of trusting caller duration", async () => {
  const harness = createHarness();
  const prepared = await harness.flow.prepareRecording(
    recordingSpec({ durationMs: 60_000, durationWasExplicit: false }),
  );

  assert.deepEqual(prepared.consent.end, {
    hardLimitMs: 15_000,
    kind: "actions_complete",
  });
  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });
  assert.equal(outcome.status, "completed");
  assert.equal(harness.sessionOptions.durationMs, 15_000);
});

test("keeps completed media successful when Browser cleanup is incomplete", async () => {
  const output = {
    ...PASSED_OUTPUT,
    cleanup: { browserTabCleanupIncomplete: true },
  };
  const harness = createHarness({ output });
  const prepared = await harness.flow.prepareRecording(recordingSpec());

  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.paths.outputPath, PASSED_OUTPUT.paths.outputPath);
  assert.equal(outcome.cleanup.browserTabCleanupIncomplete, true);
});

test("rejects a malformed successful publication at the flow boundary", async () => {
  const harness = createHarness({
    output: {
      paths: {},
      result: { failureCode: null, status: "passed" },
    },
  });
  const prepared = await harness.flow.prepareRecording(recordingSpec());

  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.code, "integration_failed");
});

test("resolves cancellation and cleanup metadata as one terminal outcome", async () => {
  const harness = createHarness();
  const prepared = await harness.flow.prepareRecording(recordingSpec());
  const cancelled = sanitizeRecordingFailure(
    { code: "recording_cancelled" },
    { browserTabCleanupIncomplete: true },
  );
  const cleanupFailure = sanitizeRecordingFailure(
    { code: "cleanup_failed" },
    {
      artifactCleanupIncomplete: true,
      cleanupDirectory: "/private/recording",
    },
  );
  harness.session.ready = Promise.reject(cancelled);
  harness.session.stop = async () => {
    harness.calls.stop += 1;
    throw cleanupFailure;
  };

  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });

  assert.deepEqual(outcome, {
    cleanup: {
      artifactCleanupIncomplete: true,
      browserTabCleanupIncomplete: true,
      directory: "/private/recording",
      file: null,
    },
    failure: {
      code: "recording_cancelled",
      remediation: "Start again when you are ready and approve the requested scope",
      summary: "Recording was cancelled",
    },
    paths: null,
    result: null,
    status: "cancelled",
  });
  assert.equal(harness.calls.stop, 1);
});

test("rejects forged and already-consumed preparations before Browser activity", async () => {
  const harness = createHarness();
  const prepared = await harness.flow.prepareRecording(recordingSpec());
  const browser = { id: "selected-browser" };

  const forged = await harness.flow.recordApproved(
    { ...prepared },
    { browser },
  );
  const first = await harness.flow.recordApproved(prepared, { browser });
  const replay = await harness.flow.recordApproved(prepared, { browser });

  assert.equal(forged.status, "failed");
  assert.equal(forged.failure.code, "invalid_configuration");
  assert.equal(first.status, "completed");
  assert.equal(replay.status, "failed");
  assert.equal(replay.failure.code, "invalid_configuration");
  assert.equal(harness.calls.createSession, 1);
});

test("blocks the next public-flow action when the pointer tail leaves the approved origin", async () => {
  const capture = {
    cursorEventsCaptured: 0,
    cursorFramesObserved: 1,
    cursorLastEventEpochMs: null,
    framesReceived: 12,
  };
  let currentOrigin = "https://example.com";
  let secondActionPerformed = false;
  const harness = createCoordinatorHarness({
    approvedOriginAttestation: async () => {
      if (currentOrigin !== "https://example.com") {
        throw sanitizeRecordingFailure({
          code: "origin_changed_during_recording",
        });
      }
    },
    capture,
  });
  const prepared = await harness.flow.prepareRecording(
    recordingSpec({
      actions: [
        {
          label: "Click the approved control",
          modality: "pointer",
          async perform() {
            capture.cursorEventsCaptured = 1;
            capture.cursorLastEventEpochMs = harness.clock.now();
          },
        },
        {
          label: "Read the next approved state",
          modality: "programmatic",
          async perform() {
            secondActionPerformed = true;
          },
        },
      ],
      destinationDirectory: "/tmp/public-flow-origin-boundary",
    }),
  );

  const recording = harness.flow.recordApproved(prepared, {
    browser: harness.browser,
  });
  await settleWorkflow();
  currentOrigin = "https://other.example";
  harness.clock.advance(200);
  const outcome = await recording;

  assert.equal(secondActionPerformed, false);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.code, "origin_changed_during_recording");
  assert.equal(outcome.result.failureCode, "origin_changed_during_recording");
  assert.deepEqual(outcome.paths, {});
  assert.equal(harness.calls.assertApprovedOrigin, 3);
  assert.equal(harness.calls.tabClose, 1);
});

test("a terminal public-flow failure fences delayed validation from publication", async () => {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "browser-recorder-public-flow-fence-"),
  );
  const destinationDirectory = join(repositoryRoot, "saved");
  const temporaryRoot = join(repositoryRoot, "working");
  await mkdir(temporaryRoot);
  const finalizationStarted = deferred();
  const validationGate = deferred();
  let underlyingFinalization;

  try {
    const harness = createCoordinatorHarness({
      async createArtifactTransaction(options) {
        const transaction = await createRecordingArtifactTransaction({
          ...options,
          _dependencies: {
            async validateVideo() {
              await validationGate.promise;
              return {
                codecName: "h264",
                durationSeconds: 0.5,
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
            finalizationStarted.resolve();
            return underlyingFinalization;
          },
          rollback: transaction.rollback,
        };
      },
      async onStart({ outputPath }) {
        await writeFile(outputPath, Buffer.alloc(200, 1));
      },
    });
    const prepared = await harness.flow.prepareRecording(
      recordingSpec({
        actions: [
          {
            label: "Observe the approved page",
            modality: "programmatic",
            async perform() {},
          },
        ],
        destinationDirectory,
        recordingName: "public-flow-recording",
        temporaryRoot,
      }),
    );

    const recording = harness.flow.recordApproved(prepared, {
      browser: harness.browser,
    });
    await finalizationStarted.promise;
    assert.equal(typeof underlyingFinalization?.then, "function");

    harness.clock.advance(10_000);
    const outcome = await recording;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failure.code, "integration_failed");
    await assert.rejects(
      access(join(destinationDirectory, "public-flow-recording.mp4")),
    );

    validationGate.resolve();
    await assert.rejects(underlyingFinalization, {
      code: "recording_cancelled",
    });
    await assert.rejects(
      access(join(destinationDirectory, "public-flow-recording.mp4")),
    );
    assert.equal(harness.calls.tabClose, 1);
  } finally {
    validationGate.resolve();
    await settleWorkflow();
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});
