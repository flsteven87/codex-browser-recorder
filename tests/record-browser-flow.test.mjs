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
    focusChanges: 0,
    goto: [],
    tabClose: 0,
    tabsNew: 0,
    visibilityAcquisitions: 0,
    visibilityGets: 0,
    visibilitySets: [],
  };
  const events = [];
  let browserVisible = false;
  let sequence = 0;
  let tabOpen = false;
  function publish(method, params) {
    sequence += 1;
    events.push({ method, params, sequence });
  }
  function publishFrame(sessionId) {
    publish("Page.screencastFrame", {
      data: frame.toString("base64"),
      metadata: { timestamp: sessionId },
      sessionId,
    });
  }
  const cdp = {
    async readEvents({ afterSequence = 0, methods = [] } = {}) {
      let pending = events.filter(
        (event) =>
          event.sequence > afterSequence && methods.includes(event.method),
      );
      if (pending.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        pending = events.filter(
          (event) =>
            event.sequence > afterSequence && methods.includes(event.method),
        );
      }
      return {
        cursor: sequence,
        events: pending,
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
        publishFrame(1);
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
      assert.equal(browserVisible, true);
      calls.goto.push(url);
    },
    id: "controllable-codex-in-app-browser-tab",
  };
  const browser = {
    capabilities: {
      async get(capability) {
        assert.equal(capability, "visibility");
        calls.visibilityAcquisitions += 1;
        return {
          async get() {
            calls.visibilityGets += 1;
            return browserVisible;
          },
          async set(visible) {
            calls.visibilitySets.push(visible);
            browserVisible = visible;
          },
        };
      },
    },
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
  return {
    browser,
    calls,
    async switchToAnotherCodexView() {
      calls.focusChanges += 1;
      browserVisible = false;
      publish("Page.screencastVisibilityChanged", { visible: false });
      publishFrame(2);
      const deadline = Date.now() + 1000;
      while (calls.acknowledgements < 2) {
        assert.ok(
          Date.now() < deadline,
          "hidden continuation frame was not acknowledged",
        );
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
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
    artifactRollback: 0,
    browserVisibilitySet: 0,
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
    capabilities: {
      async get(name) {
        assert.equal(name, "visibility");
        return {
          async get() {
            return true;
          },
          async set(visible) {
            assert.equal(visible, true);
            calls.browserVisibilitySet += 1;
          },
        };
      },
    },
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
        async rollback() {
          calls.artifactRollback += 1;
        },
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

function createHarness({
  environment,
  flowDependencies = {},
  output = PASSED_OUTPUT,
} = {}) {
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
      ...flowDependencies,
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

function createSetupBrowser() {
  const calls = {
    cdpReadEvents: 0,
    cdpSend: 0,
    tabClose: 0,
    tabsList: 0,
    tabsNew: 0,
  };
  const unrelatedTab = {
    async close() {
      assert.fail("setup check must not close an unrelated tab");
    },
    id: "unrelated-tab",
  };
  let diagnosticOpen = false;
  const cdp = {
    async readEvents() {
      calls.cdpReadEvents += 1;
    },
    async send() {
      calls.cdpSend += 1;
    },
  };
  const diagnosticTab = {
    capabilities: {
      async get(name) {
        assert.equal(name, "cdp");
        return cdp;
      },
    },
    async close() {
      calls.tabClose += 1;
      diagnosticOpen = false;
    },
    id: "owned-setup-diagnostic-tab",
  };
  const browser = {
    tabs: {
      async list() {
        calls.tabsList += 1;
        return diagnosticOpen
          ? [unrelatedTab, diagnosticTab]
          : [unrelatedTab];
      },
      async new() {
        calls.tabsNew += 1;
        diagnosticOpen = true;
        return diagnosticTab;
      },
    },
  };
  return { browser, calls, unrelatedTab };
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
    contentWarning:
      "The complete approved page viewport may include private, authenticated, or sensitive content. Continue only if you are authorized to record it and will handle the local file appropriately.",
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

test("proceeds with an authenticated private flow after authorization", async () => {
  const harness = createHarness();
  let actionPerformed = false;

  const prepared = await harness.flow.prepareRecording(
    recordingSpec({
      actions: [
        {
          label: "Open the authenticated private message thread",
          modality: "programmatic",
          async perform({ tab }) {
            actionPerformed = true;
            return tab.id;
          },
        },
      ],
    }),
  );

  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.consent.actions, [
    {
      label: "Open the authenticated private message thread",
      modality: "programmatic",
    },
  ]);
  assert.match(prepared.consent.contentWarning, /complete approved page viewport/iu);
  assert.match(prepared.consent.contentWarning, /private, authenticated, or sensitive/iu);
  assert.match(prepared.consent.contentWarning, /authorized to record/iu);
  assert.match(prepared.consent.contentWarning, /handle the local file/iu);
  assert.equal(harness.calls.createSession, 0);

  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(actionPerformed, true);
  assert.equal(harness.calls.createSession, 1);
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

for (const code of [
  "unsupported_platform",
  "ffmpeg_missing",
  "ffmpeg_h264_unavailable",
  "ffmpeg_mp4_unavailable",
  "ffprobe_missing",
  "ffprobe_unusable",
  "output_directory_not_writable",
]) {
  test(`stops the setup request at the ${code} Technical Blocker`, async () => {
    const harness = createHarness({
      environment: {
        blockingReasons: [code],
        ffmpegH264Available: ![
          "ffmpeg_missing",
          "ffmpeg_h264_unavailable",
        ].includes(code),
        ffmpegMp4Available: ![
          "ffmpeg_missing",
          "ffmpeg_mp4_unavailable",
        ].includes(code),
        ffprobeUsable: ![
          "ffprobe_missing",
          "ffprobe_unusable",
        ].includes(code),
        outputDirectoryWritable:
          code !== "output_directory_not_writable",
        platform: code === "unsupported_platform" ? "linux" : "darwin",
        supported: false,
      },
    });

    const report = await harness.flow.prepareRecording({
      destinationDirectory:
        "/Users/example/Downloads/Codex Browser Recordings",
      preflightOnly: true,
    });

    assert.equal(report.status, "blocked");
    assert.deepEqual(
      report.blockers.map(({ code: blockerCode }) => blockerCode),
      [code],
    );
    assert.equal(harness.calls.createSession, 0);
  });
}

test("checks complete setup readiness without starting a recording", async () => {
  const harness = createHarness();
  const setup = createSetupBrowser();

  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  assert.equal(preparation.status, "preflight_prepared");
  assert.equal(setup.calls.tabsNew, 0);

  const report = await harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => setup.browser,
  });
  assert.deepEqual(report, {
    environment: {
      codexInAppBrowserAvailable: true,
      ffmpegH264Available: true,
      ffmpegMp4Available: true,
      ffprobeUsable: true,
      fullCdpAvailable: true,
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
  assert.equal(setup.calls.tabsNew, 1);
  assert.equal(setup.calls.tabClose, 1);
  assert.equal(setup.calls.tabsList, 1);
  assert.equal(setup.calls.cdpSend, 0);
  assert.equal(setup.calls.cdpReadEvents, 0);
});

test("reports a Codex In-app Browser Technical Blocker when a diagnostic tab cannot be created", async () => {
  const harness = createHarness();
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });

  const report = await harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => ({
      tabs: {
        async new() {
          throw new Error("private Browser diagnostic");
        },
      },
    }),
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["browser_plugin_unavailable"],
  );
  assert.match(report.blockers[0].summary, /Codex In-app Browser/u);
  assert.doesNotMatch(JSON.stringify(report), /private Browser diagnostic/u);
  assert.equal(harness.calls.createSession, 0);
});

for (const variant of [
  {
    expectedCode: "browser_plugin_unavailable",
    name: "Browser acquisition failure",
    async setup() {
      throw new Error("private acquisition diagnostic");
    },
  },
  {
    expectedCode: "browser_plugin_unavailable",
    name: "missing diagnostic-tab API",
    async setup() {
      return { tabs: {} };
    },
  },
  {
    expectedCode: "cdp_unavailable",
    name: "missing CDP capability API",
    tab: { capabilities: {} },
  },
  {
    expectedCode: "cdp_unavailable",
    name: "CDP acquisition failure",
    tab: {
      capabilities: {
        async get() {
          throw new Error("private CDP diagnostic");
        },
      },
    },
  },
  {
    expectedCode: "cdp_unavailable",
    name: "missing CDP command interface",
    tab: {
      capabilities: {
        async get() {
          return { readEvents() {} };
        },
      },
    },
  },
  {
    expectedCode: "cdp_unavailable",
    name: "missing CDP event interface",
    tab: {
      capabilities: {
        async get() {
          return { send() {} };
        },
      },
    },
  },
]) {
  test(`reports ${variant.name} as ${variant.expectedCode}`, async () => {
    const harness = createHarness();
    const preparation = await harness.flow.prepareRecording({
      destinationDirectory:
        "/Users/example/Downloads/Codex Browser Recordings",
      preflightOnly: true,
    });
    let closeCalls = 0;
    const tab =
      variant.tab == null
        ? null
        : {
            ...variant.tab,
            async close() {
              closeCalls += 1;
            },
            id: `owned-${variant.name}`,
          };
    const acquireBrowser =
      variant.setup ??
      (async () => ({
        tabs: {
          async list() {
            return [{ id: "unrelated-tab" }];
          },
          async new() {
            return tab;
          },
        },
      }));

    const report = await harness.flow.checkSetup(preparation, {
      acquireBrowser,
    });

    assert.equal(report.status, "blocked");
    assert.deepEqual(
      report.blockers.map(({ code }) => code),
      [variant.expectedCode],
    );
    assert.doesNotMatch(
      JSON.stringify(report),
      /private (?:acquisition|CDP) diagnostic/u,
    );
    assert.equal(closeCalls, tab == null ? 0 : 1);
    assert.equal(harness.calls.createSession, 0);
  });
}

test("cancels a setup check before acquiring the Codex In-app Browser", async () => {
  const harness = createHarness();
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const cancellation = new AbortController();
  cancellation.abort();

  const report = await harness.flow.checkSetup(preparation, {
    async acquireBrowser() {
      assert.fail("cancelled setup must not acquire the Browser");
    },
    signal: cancellation.signal,
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_cancelled"],
  );
  assert.equal(report.blockers[0].summary, "Setup check was cancelled");
  assert.equal(harness.calls.createSession, 0);
});

test("cancels a pending CDP probe and closes only its owned diagnostic tab", async () => {
  const harness = createHarness();
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const pendingCdp = deferred();
  const cancellation = new AbortController();
  const calls = { tabClose: 0 };
  let diagnosticOpen = false;
  const diagnosticTab = {
    capabilities: {
      async get() {
        return pendingCdp.promise;
      },
    },
    async close() {
      calls.tabClose += 1;
      diagnosticOpen = false;
    },
    id: "cancelled-owned-diagnostic-tab",
  };
  const browser = {
    tabs: {
      async list() {
        return diagnosticOpen
          ? [{ id: "unrelated-tab" }, diagnosticTab]
          : [{ id: "unrelated-tab" }];
      },
      async new() {
        diagnosticOpen = true;
        return diagnosticTab;
      },
    },
  };

  const outcome = harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => browser,
    signal: cancellation.signal,
  });
  await settleWorkflow();
  cancellation.abort();
  const report = await outcome;

  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_cancelled"],
  );
  assert.equal(calls.tabClose, 1);
  assert.equal(diagnosticOpen, false);
  assert.equal(harness.calls.createSession, 0);
});

test("preserves cancellation while finishing owned diagnostic-tab cleanup", async () => {
  const harness = createHarness();
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const cancellation = new AbortController();
  const closing = deferred();
  let closeStarted = false;
  const diagnosticTab = {
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {
      closeStarted = true;
      return closing.promise;
    },
    id: "cancelled-during-cleanup-tab",
  };
  const browser = {
    tabs: {
      async list() {
        return [{ id: "unrelated-tab" }];
      },
      async new() {
        return diagnosticTab;
      },
    },
  };

  const outcome = harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => browser,
    signal: cancellation.signal,
  });
  while (!closeStarted) await settleWorkflow();
  cancellation.abort();
  closing.resolve();
  const report = await outcome;

  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_cancelled"],
  );
});

test("bounds a setup check when Codex In-app Browser acquisition does not settle", async () => {
  const harness = createHarness({
    flowDependencies: { setupOperationTimeoutMs: 5 },
  });
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });

  const report = await Promise.race([
    harness.flow.checkSetup(preparation, {
      acquireBrowser: async () => new Promise(() => {}),
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve({ status: "test_deadline" }), 100);
    }),
  ]);

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_timeout"],
  );
  assert.equal(
    report.blockers[0].summary,
    "Setup check timed out while testing the Codex In-app Browser",
  );
  assert.equal(harness.calls.createSession, 0);
});

test("bounds cleanup observation when diagnostic-tab creation never settles", async () => {
  const harness = createHarness({
    flowDependencies: {
      setupCleanupTimeoutMs: 5,
      setupOperationTimeoutMs: 5,
    },
  });
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });

  const report = await Promise.race([
    harness.flow.checkSetup(preparation, {
      acquireBrowser: async () => ({
        tabs: {
          async list() {
            return [{ id: "unrelated-tab" }];
          },
          async new() {
            return new Promise(() => {});
          },
        },
      }),
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve({ status: "test_deadline" }), 100);
    }),
  ]);

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_timeout", "browser_tab_cleanup_failed"],
  );
});

test("times out a pending CDP probe and closes only its owned diagnostic tab", async () => {
  const harness = createHarness({
    flowDependencies: { setupOperationTimeoutMs: 5 },
  });
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const calls = { tabClose: 0 };
  let diagnosticOpen = false;
  const diagnosticTab = {
    capabilities: {
      async get() {
        return new Promise(() => {});
      },
    },
    async close() {
      calls.tabClose += 1;
      diagnosticOpen = false;
    },
    id: "timed-out-owned-diagnostic-tab",
  };
  const browser = {
    tabs: {
      async list() {
        return diagnosticOpen
          ? [{ id: "unrelated-tab" }, diagnosticTab]
          : [{ id: "unrelated-tab" }];
      },
      async new() {
        diagnosticOpen = true;
        return diagnosticTab;
      },
    },
  };

  const report = await harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => browser,
  });

  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_timeout"],
  );
  assert.equal(calls.tabClose, 1);
  assert.equal(diagnosticOpen, false);
  assert.equal(harness.calls.createSession, 0);
});

test("cleans up only the owned diagnostic tab when tab creation finishes after setup timeout", async () => {
  const harness = createHarness({
    flowDependencies: {
      setupCleanupTimeoutMs: 100,
      setupOperationTimeoutMs: 5,
    },
  });
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const lateTab = deferred();
  const calls = { tabClose: 0, tabsList: 0 };
  const unrelatedTab = {
    async close() {
      assert.fail("late setup cleanup must not close an unrelated tab");
    },
    id: "existing-unrelated-tab",
  };
  let diagnosticOpen = false;
  const diagnosticTab = {
    capabilities: {
      async get() {
        assert.fail("timed-out setup must not acquire CDP from a late tab");
      },
    },
    async close() {
      calls.tabClose += 1;
      diagnosticOpen = false;
    },
    id: "late-owned-diagnostic-tab",
  };
  const browser = {
    tabs: {
      async list() {
        calls.tabsList += 1;
        return diagnosticOpen
          ? [unrelatedTab, diagnosticTab]
          : [unrelatedTab];
      },
      async new() {
        diagnosticOpen = true;
        return lateTab.promise;
      },
    },
  };
  setTimeout(() => lateTab.resolve(diagnosticTab), 20);

  const report = await harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => browser,
  });
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_timeout"],
  );

  assert.equal(calls.tabClose, 1);
  assert.equal(calls.tabsList, 1);
  assert.equal(diagnosticOpen, false);
});

test("reports cleanup incomplete when a late-created diagnostic tab cannot close", async () => {
  const harness = createHarness({
    flowDependencies: {
      setupCleanupTimeoutMs: 100,
      setupOperationTimeoutMs: 5,
    },
  });
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const lateTab = deferred();
  const calls = { tabClose: 0 };
  const unrelatedTab = {
    async close() {
      assert.fail("late setup cleanup must not close an unrelated tab");
    },
    id: "existing-unrelated-tab",
  };
  const diagnosticTab = {
    capabilities: {
      async get() {
        assert.fail("timed-out setup must not acquire CDP from a late tab");
      },
    },
    async close() {
      calls.tabClose += 1;
      throw new Error("private late close failure");
    },
    id: "late-owned-tab-with-failed-close",
  };
  const browser = {
    tabs: {
      async list() {
        return [unrelatedTab, diagnosticTab];
      },
      async new() {
        return lateTab.promise;
      },
    },
  };
  setTimeout(() => lateTab.resolve(diagnosticTab), 20);

  const report = await harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => browser,
  });

  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_timeout", "browser_tab_cleanup_failed"],
  );
  assert.equal(calls.tabClose, 1);
  assert.doesNotMatch(JSON.stringify(report), /private late close failure/u);
});

test("bounds cleanup when a late-created diagnostic tab never finishes closing", async () => {
  const harness = createHarness({
    flowDependencies: {
      setupCleanupTimeoutMs: 25,
      setupOperationTimeoutMs: 1,
    },
  });
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const lateTab = deferred();
  const calls = { tabClose: 0, tabsList: 0 };
  const unrelatedTab = {
    async close() {
      assert.fail("late setup cleanup must not close an unrelated tab");
    },
    id: "existing-unrelated-tab",
  };
  const diagnosticTab = {
    capabilities: {
      async get() {
        assert.fail("timed-out setup must not acquire CDP from a late tab");
      },
    },
    async close() {
      calls.tabClose += 1;
      return new Promise(() => {});
    },
    id: "late-owned-tab-with-stalled-close",
  };
  const browser = {
    tabs: {
      async list() {
        calls.tabsList += 1;
        return [unrelatedTab, diagnosticTab];
      },
      async new() {
        return lateTab.promise;
      },
    },
  };
  setTimeout(() => lateTab.resolve(diagnosticTab), 5);

  const report = await Promise.race([
    harness.flow.checkSetup(preparation, {
      acquireBrowser: async () => browser,
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve({ status: "test_deadline" }), 100);
    }),
  ]);

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["setup_timeout", "browser_tab_cleanup_failed"],
  );
  assert.equal(calls.tabClose, 1);
  assert.equal(calls.tabsList, 0);
});

test("bounds owned diagnostic-tab cleanup and reports an actionable blocker", async () => {
  const harness = createHarness({
    flowDependencies: {
      setupCleanupTimeoutMs: 5,
      setupOperationTimeoutMs: 5,
    },
  });
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const diagnosticTab = {
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {
      return new Promise(() => {});
    },
    id: "owned-tab-with-stalled-close",
  };

  const report = await Promise.race([
    harness.flow.checkSetup(preparation, {
      acquireBrowser: async () => ({
        tabs: {
          async list() {
            return [diagnosticTab];
          },
          async new() {
            return diagnosticTab;
          },
        },
      }),
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve({ status: "test_deadline" }), 100);
    }),
  ]);

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["browser_tab_cleanup_failed"],
  );
  assert.match(report.blockers[0].summary, /diagnostic tab/u);
  assert.match(report.blockers[0].remediation, /close.*manually/iu);
});

test("reports CDP and owned-tab cleanup Technical Blockers together", async () => {
  const harness = createHarness();
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const diagnosticTab = {
    capabilities: {
      async get() {
        return { send() {} };
      },
    },
    async close() {
      throw new Error("private close failure");
    },
    id: "owned-setup-tab",
  };

  const report = await harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => ({
      tabs: {
        async list() {
          return [diagnosticTab, { id: "unrelated-tab" }];
        },
        async new() {
          return diagnosticTab;
        },
      },
    }),
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["cdp_unavailable", "browser_tab_cleanup_failed"],
  );
  assert.doesNotMatch(JSON.stringify(report), /private close failure/u);
});

test("fails closed when the owned setup tab has no verifiable identity", async () => {
  const harness = createHarness();
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  let closeCalls = 0;
  const diagnosticTab = {
    capabilities: {
      async get() {
        return { readEvents() {}, send() {} };
      },
    },
    async close() {
      closeCalls += 1;
    },
  };

  const report = await harness.flow.checkSetup(preparation, {
    acquireBrowser: async () => ({
      tabs: {
        async list() {
          return [{ id: "unrelated-tab" }];
        },
        async new() {
          return diagnosticTab;
        },
      },
    }),
  });

  assert.deepEqual(
    report.blockers.map(({ code }) => code),
    ["browser_tab_cleanup_failed"],
  );
  assert.equal(closeCalls, 1);
});

test("consumes an opaque setup preparation exactly once", async () => {
  const harness = createHarness();
  const setup = createSetupBrowser();
  const preparation = await harness.flow.prepareRecording({
    destinationDirectory:
      "/Users/example/Downloads/Codex Browser Recordings",
    preflightOnly: true,
  });
  const options = {
    acquireBrowser: async () => setup.browser,
  };

  const first = await harness.flow.checkSetup(preparation, options);
  const second = await harness.flow.checkSetup(preparation, options);
  const forged = await harness.flow.checkSetup(
    Object.freeze({ ...preparation }),
    options,
  );

  assert.equal(first.status, "preflight_passed");
  assert.deepEqual(
    second.blockers.map(({ code }) => code),
    ["invalid_configuration"],
  );
  assert.deepEqual(
    forged.blockers.map(({ code }) => code),
    ["invalid_configuration"],
  );
  assert.equal(setup.calls.tabsNew, 1);
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
    resourceCleanupIncomplete: false,
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

test("forwards child-frame pointer requirements without exposing them in consent", async () => {
  const harness = createHarness();
  const action = recordingSpec().actions[0];
  const prepared = await harness.flow.prepareRecording(
    recordingSpec({
      actions: [
        {
          ...action,
          requiresChildFramePointerEvidence: true,
        },
      ],
    }),
  );

  assert.deepEqual(prepared.consent.actions, [
    {
      label: "Open the standards section",
      modality: "pointer",
    },
  ]);
  const outcome = await harness.flow.recordApproved(prepared, {
    browser: { id: "selected-browser" },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(
    harness.calls.runAction[0].requiresChildFramePointerEvidence,
    true,
  );
  assert.equal(
    harness.calls.runAction[0].requiresPointerEvidence,
    true,
  );
});

test("returns a deterministic visibility blocker before approved actions and cleans up", async () => {
  const harness = createCoordinatorHarness();
  const secret = "private Browser visibility diagnostic";
  harness.browser.capabilities.get = async () => {
    throw new Error(secret);
  };
  let actionPerformed = false;
  const prepared = await harness.flow.prepareRecording(
    recordingSpec({
      actions: [
        {
          label: "Read the approved page",
          modality: "programmatic",
          async perform() {
            actionPerformed = true;
          },
        },
      ],
    }),
  );

  const outcome = await harness.flow.recordApproved(prepared, {
    browser: harness.browser,
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.code, "browser_visibility_unavailable");
  assert.equal(
    outcome.failure.summary,
    "The Codex In-app Browser could not be shown",
  );
  assert.doesNotMatch(JSON.stringify(outcome), /private Browser visibility/u);
  assert.equal(actionPerformed, false);
  assert.equal(harness.calls.artifactRollback, 1);
  assert.equal(harness.calls.tabClose, 1);
});

test("publishes a valid MP4 after the user switches away from the Browser", async () => {
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
  let hiddenActionCompleted = false;

  try {
    const prepared = await flow.prepareRecording({
      actions: [
        {
          label: "Read the approved page and switch Codex views",
          modality: "programmatic",
          async perform({ tab }) {
            assert.equal(
              tab.id,
              "controllable-codex-in-app-browser-tab",
            );
            await iab.switchToAnotherCodexView();
          },
        },
        {
          label: "Continue the approved flow",
          modality: "programmatic",
          async perform({ tab }) {
            assert.equal(
              tab.id,
              "controllable-codex-in-app-browser-tab",
            );
            assert.equal(iab.calls.focusChanges, 1);
            hiddenActionCompleted = true;
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
    assert.equal(iab.calls.visibilityAcquisitions, 1);
    assert.deepEqual(iab.calls.visibilitySets, [true]);
    assert.equal(iab.calls.visibilityGets, 1);
    assert.deepEqual(iab.calls.goto, [targetUrl]);
    assert.equal(iab.calls.cdpAcquisitions, 2);
    assert.equal(iab.calls.focusChanges, 1);
    assert.equal(hiddenActionCompleted, true);
    assert.equal(iab.calls.acknowledgements, 2);
    assert.equal(outcome.result.capture.framesAcknowledged, 2);
    assert.equal(outcome.result.capture.framesReceived, 2);
    assert.equal(outcome.result.capture.visibilityChanges, 1);
    assert.equal(outcome.result.capture.visibilityState, false);
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
    {
      browserTabCleanupIncomplete: true,
      resourceCleanupIncomplete: true,
    },
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
      resourceCleanupIncomplete: true,
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
