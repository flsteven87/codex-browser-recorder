import assert from "node:assert/strict";
import test from "node:test";

import {
  runCodexInAppBrowserReleaseGate,
} from "../scripts/codex-in-app-browser-release-gate.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const versions = {
  candidateRevision: revision,
  ffmpegVersion: "ffmpeg 8.1.2",
  ffprobeVersion: "ffprobe 8.1.2",
  recorderPluginVersion: "0.4.0",
};

function completed(path, { capture = {} } = {}) {
  return {
    cleanup: {},
    paths: { outputPath: path },
    result: {
      capture,
      failureCode: null,
      status: "passed",
    },
    status: "completed",
  };
}

function createHarness({
  approve = true,
  crossOriginOutcome = {
    cleanup: {},
    paths: null,
    result: {
      failureCode: "origin_changed_during_recording",
      status: "failed",
    },
    status: "failed",
  },
  embeddedFrame = {
    limitation: "runtime_does_not_expose_embedded_frame_control",
    status: "runtime_unsupported",
  },
  embeddedChildFrames = [
    {
      frame: {
        id: "qualification-child-frame",
        parentId: "qualification-main-frame",
        url: "https://example.com/embedded",
      },
    },
  ],
  embeddedChildFrameEventsCaptured = 1,
  exerciseActions = true,
  pointerCapture = {
    framesReceived: 12,
    visibilityChanges: 2,
    visibilityState: false,
  },
} = {}) {
  const calls = [];
  const deleted = [];
  let nextPreparation = 0;
  let currentUrl = "https://example.com/";
  let visible = true;
  const visibility = {
    async get() {
      calls.push(`visibility:get:${visible}`);
      return visible;
    },
    async set(nextVisible) {
      calls.push(`visibility:set:${nextVisible}`);
      visible = nextVisible;
    },
  };
  const cdp = {
    async send(method) {
      calls.push(`cdp:${method}`);
      assert.equal(method, "Page.getFrameTree");
      return {
        frameTree: {
          childFrames: embeddedChildFrames,
          frame: {
            id: "qualification-main-frame",
            url: currentUrl,
          },
        },
      };
    },
  };
  const tab = {
    capabilities: {
      async get(name) {
        assert.equal(name, "cdp");
        return cdp;
      },
    },
    async goto(url) {
      calls.push("tab:goto");
      currentUrl = url;
    },
    async url() {
      calls.push("tab:url");
      return currentUrl;
    },
  };
  const browser = {
    capabilities: {
      async get(name) {
        assert.equal(name, "visibility");
        return visibility;
      },
    },
    tabs: {
      async list() {
        calls.push("tabs:list");
        return [{ id: "unrelated-tab" }];
      },
    },
  };
  const dependencies = {
    async collectEnvironmentEvidence() {
      calls.push("versions");
      return versions;
    },
    async createTemporaryWorkspace() {
      calls.push("workspace:create");
      return "/private/owned-release-workspace";
    },
    async inspectPublishedVideo(outputPath) {
      calls.push(`media:${outputPath}`);
      return {
        audioStreams: 0,
        codecName: "h264",
        container: "mp4",
        durationSeconds: 1.2,
        framesPerSecond: 10,
        height: 720,
        pixelFormat: "yuv420p",
        width: 1280,
      };
    },
    async listWorkspaceEntries() {
      calls.push("workspace:list");
      return [];
    },
    async prepareRecording(options) {
      nextPreparation += 1;
      calls.push(`prepare:${options.recordingName}`);
      return {
        consent: { marker: options.recordingName },
        id: nextPreparation,
        options,
        status: "prepared",
      };
    },
    async recordApproved(prepared, { browser: selected, signal }) {
      assert.equal(selected, browser);
      calls.push(`record:${prepared.options.recordingName}`);
      if (
        exerciseActions &&
        prepared.options.recordingName !== "qualification-cross-origin" &&
        prepared.options.recordingName !== "qualification-cancellation"
      ) {
        currentUrl = prepared.options.targetUrl;
        visible = prepared.options.recordingMode !== "unattended";
        for (const action of prepared.options.actions) {
          await action.perform({ tab });
        }
      }
      if (prepared.options.recordingName === "qualification-pointer-hidden") {
        return completed("/private/owned-release-workspace/pointer.mp4", {
          capture: pointerCapture,
        });
      }
      if (prepared.options.recordingName === "qualification-sequential") {
        return completed("/private/owned-release-workspace/sequential.mp4");
      }
      if (prepared.options.recordingName === "qualification-cross-origin") {
        return crossOriginOutcome;
      }
      if (prepared.options.recordingName === "qualification-embedded-frame") {
        return completed(
          "/private/owned-release-workspace/embedded-frame.mp4",
          {
            capture: {
              cursorChildFrameEventsCaptured:
                embeddedChildFrameEventsCaptured,
            },
          },
        );
      }
      assert.equal(
        prepared.options.recordingName,
        "qualification-cancellation",
      );
      void prepared.options.actions[0].perform({ tab: {} });
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      return {
        cleanup: {},
        paths: null,
        result: { failureCode: "recording_cancelled", status: "failed" },
        status: "cancelled",
      };
    },
    async removePublishedRecording(path) {
      deleted.push(path);
      calls.push(`recording:delete:${path}`);
    },
    async removeTemporaryWorkspace() {
      calls.push("workspace:delete");
    },
  };

  return {
    browser,
    calls,
    deleted,
    dependencies,
    options: {
      acquireBrowser: async () => {
        calls.push("browser:acquire");
        return browser;
      },
      approveQualification: async ({ consents }) => {
        calls.push("approve");
        assert.equal(consents.length, embeddedFrame.status === "exercised" ? 5 : 4);
        assert.ok(consents.every((consent) => consent.marker != null));
        return approve;
      },
      browserPluginVersion: "26.721.31836",
      codexDesktopVersion: "26.721.31836 (5828)",
      confirmPointerVisualEvidence: async ({ outputPath }) => {
        calls.push(`visual:${outputPath}`);
        return {
          clickFeedbackVisible: true,
          pointerMovementVisible: true,
        };
      },
      crossOriginFlow: {
        actions: [
          {
            label: "Leave the approved site",
            modality: "programmatic",
            perform: async () => {},
          },
        ],
        targetUrl: "https://example.com/",
      },
      dependencies,
      embeddedFrame,
      pointerHiddenFlow: {
        actions: [
          {
            label: "Follow a same-site link",
            modality: "pointer",
            perform: ({ tab: selectedTab }) =>
              selectedTab.goto("https://example.com/qualified"),
          },
          {
            label: "Hide the Browser",
            modality: "programmatic",
            perform: () => visibility.set(false),
          },
          {
            label: "Click after hiding",
            modality: "pointer",
            perform: async () => {},
          },
        ],
        targetUrl: "https://example.com/",
      },
      sequentialFlow: {
        actions: [
          {
            label: "Click in the fresh session",
            modality: "pointer",
            perform: async () => {},
          },
        ],
        targetUrl: "https://example.com/",
      },
    },
    tab,
  };
}

test("rejects an incomplete gate configuration before local or Browser activity", async () => {
  await assert.rejects(
    runCodexInAppBrowserReleaseGate({}),
    (error) =>
      error.code === "release_gate_invalid_configuration" &&
      error.message === "Invalid release qualification callbacks",
  );
});

test("rejects the legacy no-op pointer-hidden false pass", async () => {
  const harness = createHarness({ exerciseActions: false });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "release_gate_action_evidence_failed",
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("rejects invoked pointer-hidden actions that do not change state", async () => {
  const harness = createHarness();
  harness.options.pointerHiddenFlow.actions = [
    {
      label: "No-op pointer navigation",
      modality: "pointer",
      perform: async () => {},
    },
    {
      label: "No-op hide",
      modality: "programmatic",
      perform: async () => {},
    },
    {
      label: "No-op hidden pointer",
      modality: "pointer",
      perform: async () => {},
    },
  ];

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "release_gate_action_evidence_failed",
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("fails closed for incomplete pointer-hidden runtime evidence", async (t) => {
  const cases = [
    {
      name: "missing Browser URL observer",
      mutate(harness) {
        harness.tab.url = undefined;
      },
    },
    {
      name: "invalid Browser URL observation",
      mutate(harness) {
        harness.tab.url = async () => "not-a-url";
      },
    },
    {
      name: "failed same-origin navigation action",
      mutate(harness) {
        harness.options.pointerHiddenFlow.actions[0].perform = async () => {
          throw new Error("private navigation failure");
        };
      },
    },
    {
      name: "missing Browser visibility observer",
      mutate(harness) {
        harness.browser.capabilities.get = async () => ({});
      },
    },
    {
      name: "failed Browser visibility observation",
      mutate(harness) {
        harness.browser.capabilities.get = async () => ({
          async get() {
            throw new Error("private visibility failure");
          },
          async set() {},
        });
      },
    },
    {
      name: "initially hidden Browser",
      mutate(harness) {
        harness.browser.capabilities.get = async () => ({
          async get() {
            return false;
          },
          async set() {},
        });
      },
    },
    {
      name: "failed Browser hide action",
      mutate(harness) {
        harness.options.pointerHiddenFlow.actions[1].perform = async () => {
          throw new Error("private hide failure");
        };
      },
    },
    {
      name: "Browser that remains visible",
      mutate(harness) {
        harness.options.pointerHiddenFlow.actions[1].perform = async () => {};
      },
    },
    {
      name: "failed hidden pointer action",
      mutate(harness) {
        harness.options.pointerHiddenFlow.actions[2].perform = async () => {
          throw new Error("private pointer failure");
        };
      },
    },
    {
      name: "Browser revealed by the hidden pointer action",
      mutate(harness) {
        harness.options.pointerHiddenFlow.actions[2].perform = async () => {
          const visibility =
            await harness.browser.capabilities.get("visibility");
          await visibility.set(true);
        };
      },
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const harness = createHarness();
      current.mutate(harness);

      await assert.rejects(
        runCodexInAppBrowserReleaseGate(harness.options),
        (error) => error.code === "release_gate_action_evidence_failed",
      );
      assert.equal(harness.calls.at(-1), "workspace:delete");
    });
  }
});

test("requires the exact pointer-hidden action sequence before Browser activity", async () => {
  const harness = createHarness();
  harness.options.pointerHiddenFlow.actions = [
    {
      label: "Hide too early",
      modality: "programmatic",
      perform: async () => {},
    },
    {
      label: "Pointer later",
      modality: "pointer",
      perform: async () => {},
    },
  ];

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "release_gate_invalid_configuration",
  );
  assert.equal(harness.calls.length, 0);
});

test("uses gate-owned visibility and action-bound frame evidence instead of Page visibility state", async () => {
  const harness = createHarness({
    pointerCapture: {
      framesReceived: 12,
      visibilityChanges: 1,
      visibilityState: true,
    },
  });

  const result = await runCodexInAppBrowserReleaseGate(harness.options);

  assert.equal(
    result.scenarios.pointerSameOriginHidden.actionEvidence
      .hiddenFrameContinuationObserved,
    true,
  );
  assert.equal(
    result.scenarios.pointerSameOriginHidden.actionEvidence
      .hiddenTransitionObserved,
    true,
  );
  assert.equal(
    result.scenarios.pointerSameOriginHidden.actionEvidence
      .pageVisibilityChanges,
    1,
  );
  assert.equal(
    result.scenarios.pointerSameOriginHidden.actionEvidence
      .pageVisibilityState,
    true,
  );
});

test("qualifies the sequential flow as an Unattended Recording", async () => {
  const harness = createHarness();
  const prepareRecording = harness.dependencies.prepareRecording;
  let sequentialMode;
  harness.options.dependencies = {
    ...harness.dependencies,
    async prepareRecording(options) {
      if (options.recordingName === "qualification-sequential") {
        sequentialMode = options.recordingMode;
      }
      return prepareRecording(options);
    },
  };

  const result = await runCodexInAppBrowserReleaseGate(harness.options);

  assert.equal(sequentialMode, "unattended");
  assert.deepEqual(result.scenarios.sequential.actionEvidence, {
    hiddenStartObserved: true,
  });
});

test("qualifies the production flow only after explicit approval and deletes all evidence", async () => {
  const harness = createHarness();

  const result = await runCodexInAppBrowserReleaseGate(harness.options);

  assert.ok(
    harness.calls.indexOf("approve") <
      harness.calls.indexOf("browser:acquire"),
  );
  assert.deepEqual(
    harness.calls.filter((call) => call.startsWith("record:")),
    [
      "record:qualification-pointer-hidden",
      "record:qualification-sequential",
      "record:qualification-cross-origin",
      "record:qualification-cancellation",
    ],
  );
  assert.deepEqual(harness.deleted, [
    "/private/owned-release-workspace/pointer.mp4",
    "/private/owned-release-workspace/sequential.mp4",
  ]);
  assert.deepEqual(result, {
    cleanup: {
      ownedRecordingsDeleted: 2,
      tabStateRestored: true,
      temporaryWorkspaceRemoved: true,
    },
    contractVersion: 2,
    evidence: {
      ...versions,
      browserPluginVersion: "26.721.31836",
      codexDesktopVersion: "26.721.31836 (5828)",
    },
    scenarios: {
      cancellation: {
        failureCode: "recording_cancelled",
        status: "passed",
      },
      crossOrigin: {
        failureCode: "origin_changed_during_recording",
        status: "passed",
      },
      embeddedFrame: {
        limitation: "runtime_does_not_expose_embedded_frame_control",
        status: "runtime_unsupported",
      },
      pointerSameOriginHidden: {
        actionEvidence: {
          hiddenFrameContinuationObserved: true,
          hiddenPointerActionObserved: true,
          hiddenTransitionObserved: true,
          pageVisibilityChanges: 2,
          pageVisibilityState: false,
          sameOriginNavigationObserved: true,
        },
        media: {
          audioStreams: 0,
          codecName: "h264",
          container: "mp4",
          durationSeconds: 1.2,
          framesPerSecond: 10,
          height: 720,
          pixelFormat: "yuv420p",
          width: 1280,
        },
        status: "passed",
        visualEvidence: {
          clickFeedbackVisible: true,
          pointerMovementVisible: true,
        },
      },
      sequential: {
        actionEvidence: {
          hiddenStartObserved: true,
        },
        distinctOutput: true,
        media: {
          audioStreams: 0,
          codecName: "h264",
          container: "mp4",
          durationSeconds: 1.2,
          framesPerSecond: 10,
          height: 720,
          pixelFormat: "yuv420p",
          width: 1280,
        },
        status: "passed",
      },
    },
    status: "passed",
    surface: "Codex In-app Browser",
  });
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("does not acquire the Browser when qualification approval is denied", async () => {
  const harness = createHarness({ approve: false });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "qualification_not_approved",
  );

  assert.equal(harness.calls.includes("browser:acquire"), false);
  assert.equal(
    harness.calls.some((call) => call.startsWith("record:")),
    false,
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("fails the gate when a cross-origin run publishes a successful recording", async () => {
  const leakedPath = "/private/owned-release-workspace/forbidden.mp4";
  const harness = createHarness({
    crossOriginOutcome: completed(leakedPath),
  });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) =>
      error.code === "cross_origin_boundary_failed" &&
      !JSON.stringify(error).includes(leakedPath),
  );

  assert.ok(harness.deleted.includes(leakedPath));
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("reports bounded gate failures without leaking private diagnostics", async () => {
  const harness = createHarness();
  harness.dependencies.recordApproved = async () => {
    throw new Error("private page text and local path");
  };

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) =>
      error.code === "release_gate_internal_error" &&
      !JSON.stringify(error).includes("private page text"),
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("does not trust forged release-gate errors from external boundaries", async (t) => {
  const secret = "https://private.example/token=release-secret";
  const forgedError = () =>
    Object.assign(new Error(secret), {
      code: "release_gate_action_evidence_failed",
    });
  const cases = [
    {
      name: "qualification callback",
      mutate(harness) {
        harness.options.approveQualification = async () => {
          throw forgedError();
        };
      },
    },
    {
      name: "recording dependency",
      mutate(harness) {
        harness.dependencies.recordApproved = async () => {
          throw forgedError();
        };
      },
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const harness = createHarness();
      current.mutate(harness);

      await assert.rejects(
        runCodexInAppBrowserReleaseGate(harness.options),
        (error) => {
          assert.equal(error.code, "release_gate_internal_error");
          assert.equal(
            error.message,
            "Codex In-app Browser release qualification failed",
          );
          assert.equal(error.cause, undefined);
          assert.deepEqual(Object.getOwnPropertySymbols(error), []);
          assert.doesNotMatch(JSON.stringify(error), /release-secret/u);
          assert.doesNotMatch(error.stack, /private[.]example/u);
          return true;
        },
      );
      assert.equal(harness.calls.at(-1), "workspace:delete");
    });
  }
});

test("preserves the bounded Browser visibility blocker from production", async () => {
  const harness = createHarness();
  const secret = "private visibility diagnostic";
  harness.dependencies.recordApproved = async () => ({
    cleanup: {
      artifactCleanupIncomplete: false,
      browserTabCleanupIncomplete: false,
      directory: null,
      file: null,
      resourceCleanupIncomplete: false,
    },
    failure: {
      code: "browser_visibility_unavailable",
      diagnostic: secret,
    },
    paths: null,
    result: null,
    status: "failed",
  });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) =>
      error.code === "browser_visibility_unavailable" &&
      error.scenario === "pointerSameOriginHidden" &&
      !JSON.stringify(error).includes(secret),
  );
  assert.equal(
    harness.calls.some((call) => call.startsWith("visual:")),
    false,
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("does not preserve a contradictory Browser visibility outcome", async () => {
  const harness = createHarness();
  harness.dependencies.recordApproved = async () => ({
    cleanup: {},
    failure: {
      code: "browser_visibility_unavailable",
    },
    paths: null,
    result: {
      failureCode: "origin_changed_during_recording",
      status: "failed",
    },
    status: "failed",
  });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) =>
      error.code === "release_gate_outcome_failed" &&
      error.scenario === undefined,
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("fails closed when independent media evidence contains audio", async () => {
  const harness = createHarness();
  harness.dependencies.inspectPublishedVideo = async () => ({
    audioStreams: 1,
    codecName: "h264",
    container: "mp4",
    durationSeconds: 1,
    framesPerSecond: 10,
    height: 720,
    pixelFormat: "yuv420p",
    width: 1280,
  });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "media_qualification_failed",
  );
  assert.deepEqual(harness.deleted, [
    "/private/owned-release-workspace/pointer.mp4",
  ]);
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("fails closed and deletes the recording when Browser tab state leaks", async () => {
  const harness = createHarness();
  let inventories = 0;
  harness.browser.tabs.list = async () => {
    inventories += 1;
    return inventories === 1
      ? [{ id: "unrelated-tab" }]
      : [{ id: "unrelated-tab" }, { id: "leaked-owned-tab" }];
  };

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "release_gate_tab_cleanup_failed",
  );
  assert.deepEqual(harness.deleted, [
    "/private/owned-release-workspace/pointer.mp4",
  ]);
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("records embedded-frame media when the Browser runtime exposes it", async () => {
  const harness = createHarness({
    embeddedFrame: {
      actions: [
        {
          label: "Use a control in the embedded frame",
          modality: "pointer",
          perform: async () => {},
        },
      ],
      status: "exercised",
      targetUrl: "https://example.com/",
    },
  });

  const result = await runCodexInAppBrowserReleaseGate(harness.options);

  assert.equal(result.scenarios.embeddedFrame.status, "passed");
  assert.deepEqual(result.scenarios.embeddedFrame.actionEvidence, {
    childFrameObserved: true,
    childFramePointerEventsCaptured: 1,
    childFramesObserved: 1,
  });
  assert.equal(result.scenarios.embeddedFrame.media.codecName, "h264");
  assert.ok(
    harness.deleted.includes(
      "/private/owned-release-workspace/embedded-frame.mp4",
    ),
  );
});

test("requires fresh production child-pointer evidence for the embedded action", async () => {
  const harness = createHarness({
    embeddedFrame: {
      actions: [
        {
          label: "Use a control in the embedded frame",
          modality: "pointer",
          perform: async () => {},
        },
      ],
      status: "exercised",
      targetUrl: "https://example.com/",
    },
  });
  const prepareRecording = harness.dependencies.prepareRecording;
  harness.options.dependencies = {
    ...harness.dependencies,
    async prepareRecording(options) {
      if (
        options.recordingName === "qualification-embedded-frame" &&
        options.actions[0].requiresChildFramePointerEvidence !== true
      ) {
        throw new Error("missing production child-frame requirement");
      }
      return prepareRecording(options);
    },
  };

  const result = await runCodexInAppBrowserReleaseGate(harness.options);

  assert.equal(result.scenarios.embeddedFrame.status, "passed");
});

test("accepts bounded child-pointer evidence with nested child frames", async () => {
  const harness = createHarness({
    embeddedChildFrames: [
      {
        childFrames: [
          {
            frame: {
              id: "qualification-nested-frame",
              parentId: "qualification-child-frame",
              url: "https://example.com/nested",
            },
          },
        ],
        frame: {
          id: "qualification-child-frame",
          parentId: "qualification-main-frame",
          url: "https://example.com/embedded",
        },
      },
    ],
    embeddedFrame: {
      actions: [
        {
          label: "Use a control in a nested frame tree",
          modality: "pointer",
          perform: async () => {},
        },
      ],
      status: "exercised",
      targetUrl: "https://example.com/",
    },
  });

  const result = await runCodexInAppBrowserReleaseGate(harness.options);

  assert.equal(
    result.scenarios.embeddedFrame.actionEvidence.childFramesObserved,
    2,
  );
});

test("rejects embedded-frame exercise without a captured child-frame pointer", async () => {
  const harness = createHarness({
    embeddedChildFrameEventsCaptured: 0,
    embeddedFrame: {
      actions: [
        {
          label: "Ordinary no-op pointer",
          modality: "pointer",
          perform: async () => {},
        },
      ],
      status: "exercised",
      targetUrl: "https://example.com/",
    },
  });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "embedded_frame_qualification_failed",
  );
  assert.ok(
    harness.deleted.includes(
      "/private/owned-release-workspace/embedded-frame.mp4",
    ),
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("rejects embedded-frame exercise when no child frame is observable", async () => {
  const harness = createHarness({
    embeddedChildFrames: [],
    embeddedFrame: {
      actions: [
        {
          label: "Pointer with no child frame",
          modality: "pointer",
          perform: async () => {},
        },
      ],
      status: "exercised",
      targetUrl: "https://example.com/",
    },
  });

  await assert.rejects(
    runCodexInAppBrowserReleaseGate(harness.options),
    (error) => error.code === "embedded_frame_qualification_failed",
  );
  assert.equal(harness.calls.at(-1), "workspace:delete");
});

test("fails closed for invalid embedded-frame runtime evidence", async (t) => {
  const cases = [
    {
      name: "missing CDP command interface",
      mutate(harness) {
        harness.tab.capabilities.get = async () => ({});
      },
    },
    {
      name: "missing main-frame identity",
      mutate(harness) {
        harness.tab.capabilities.get = async () => ({
          async send() {
            return { frameTree: { frame: {} } };
          },
        });
      },
    },
    {
      name: "invalid child-frame parent identity",
      mutate(harness) {
        harness.tab.capabilities.get = async () => ({
          async send() {
            return {
              frameTree: {
                childFrames: [
                  {
                    frame: {
                      id: "qualification-child-frame",
                      parentId: "wrong-parent",
                    },
                  },
                ],
                frame: { id: "qualification-main-frame" },
              },
            };
          },
        });
      },
    },
    {
      name: "failed embedded-frame pointer action",
      mutate(harness) {
        harness.options.embeddedFrame.actions[0].perform = async () => {
          throw new Error("private embedded-frame action failure");
        };
      },
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const harness = createHarness({
        embeddedFrame: {
          actions: [
            {
              label: "Use an embedded-frame control",
              modality: "pointer",
              perform: async () => {},
            },
          ],
          status: "exercised",
          targetUrl: "https://example.com/",
        },
      });
      current.mutate(harness);

      await assert.rejects(
        runCodexInAppBrowserReleaseGate(harness.options),
        (error) => error.code === "embedded_frame_qualification_failed",
      );
      assert.equal(harness.calls.at(-1), "workspace:delete");
    });
  }
});
