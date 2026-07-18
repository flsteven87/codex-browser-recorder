import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordingFlow,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/record-browser-flow.mjs";
import {
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";

const PASSED_OUTPUT = Object.freeze({
  paths: {
    outputPath: "/Users/example/Downloads/Codex Browser Recordings/demo.mp4",
  },
  result: {
    failureCode: null,
    status: "passed",
  },
});

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
    browserSurface: "chrome",
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

test("fails closed on the unsupported in-app Browser surface", async () => {
  const harness = createHarness();

  const prepared = await harness.flow.prepareRecording(
    recordingSpec({ browserSurface: "iab" }),
  );

  assert.equal(prepared.status, "blocked");
  assert.equal(prepared.blockers[0].code, "browser_surface_unsupported");
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
