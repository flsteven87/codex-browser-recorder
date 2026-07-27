import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_QUALIFICATION_FIXTURES,
  RUNTIME_UNSUPPORTED_EMBEDDED_FRAME,
  createQualificationFlows,
  probeCodexInAppBrowserVisibility,
  runCodexInAppBrowserReleaseQualification,
} from "../scripts/codex-in-app-browser-release-qualification.mjs";

const environmentEvidence = {
  candidateRevision: "0123456789abcdef0123456789abcdef01234567",
  ffmpegVersion: "ffmpeg 8.1.2",
  ffprobeVersion: "ffprobe 8.1.2",
  recorderPluginVersion: "0.4.0",
};

function createClock() {
  let current = 0;
  return {
    now: () => current,
    setTimeout: (callback, delay) => {
      current += delay;
      queueMicrotask(callback);
      return 0;
    },
  };
}

function createVisibility({
  observe = () => true,
  setRejects = false,
  getRejects = false,
} = {}) {
  const requested = [];
  return {
    capability: {
      get: async () => {
        if (getRejects) throw new Error("visibility.get rejected");
        return observe();
      },
      set: async (visible) => {
        requested.push(visible);
        if (setRejects) throw new Error("visibility.set rejected");
      },
    },
    requested,
  };
}

function createBrowser(capability) {
  return {
    capabilities: { get: async () => capability },
    tabs: {
      list: async () => [],
      new: async () => ({
        id: "visibility-probe-tab",
        close: async () => {},
      }),
    },
  };
}

function createTabDependentBrowser({
  closeLeavesTab = false,
  closeRejects = false,
} = {}) {
  const tabs = [];
  const visibility = createVisibility({
    observe: () =>
      tabs.length > 0 && visibility.requested.at(-1) === true,
  });
  const browser = {
    capabilities: { get: async () => visibility.capability },
    tabs: {
      list: async () => tabs.map(({ id }) => ({ id })),
      new: async () => {
        const tab = {
          id: "visibility-probe-tab",
          close: async () => {
            if (closeRejects) throw new Error("tab.close rejected");
            if (!closeLeavesTab) tabs.splice(tabs.indexOf(tab), 1);
          },
        };
        tabs.push(tab);
        return tab;
      },
    },
  };
  return { browser, visibility };
}

function createRuntime(capability) {
  return { browser: createBrowser(capability) };
}

test("builds the exact action shape the release gate requires", () => {
  const flows = createQualificationFlows({ runtime: { browser: null } });

  assert.deepEqual(
    flows.pointerHiddenFlow.actions.map(({ modality }) => modality),
    ["pointer", "programmatic", "pointer"],
  );
  assert.equal(flows.pointerHiddenFlow.actions.length, 3);
  assert.equal(flows.sequentialFlow.actions.length, 1);
  assert.equal(flows.sequentialFlow.actions[0].modality, "pointer");
  assert.equal(flows.crossOriginFlow.actions[0].modality, "pointer");
  assert.equal(
    flows.pointerHiddenFlow.targetUrl,
    DEFAULT_QUALIFICATION_FIXTURES.pointerHidden.targetUrl,
  );
  assert.ok(Object.isFrozen(flows.pointerHiddenFlow.actions));
});

test("declares embedded-frame coverage as runtime unsupported by default", () => {
  assert.equal(RUNTIME_UNSUPPORTED_EMBEDDED_FRAME.status, "runtime_unsupported");
  assert.equal(
    RUNTIME_UNSUPPORTED_EMBEDDED_FRAME.limitation,
    "runtime_does_not_expose_embedded_frame_control",
  );
});

test("hides the Browser through the runtime the gate acquired", async () => {
  const visibility = createVisibility();
  const runtime = createRuntime(visibility.capability);
  const flows = createQualificationFlows({ runtime });

  await flows.pointerHiddenFlow.actions[1].perform({});

  assert.deepEqual(visibility.requested, [false]);
});

test("fails the hide action when the runtime has no visibility capability", async () => {
  const flows = createQualificationFlows({ runtime: { browser: null } });

  await assert.rejects(
    flows.pointerHiddenFlow.actions[1].perform({}),
    (error) => error.code === "qualification_visibility_unavailable",
  );
});

test("clicks each fixture link by its exact accessible name", async () => {
  const clicked = [];
  const tab = {
    playwright: {
      getByRole: (role, options) => ({
        click: async () => clicked.push({ options, role }),
      }),
    },
  };
  const flows = createQualificationFlows({ runtime: { browser: null } });

  await flows.pointerHiddenFlow.actions[0].perform({ tab });
  await flows.crossOriginFlow.actions[0].perform({ tab });

  assert.deepEqual(clicked, [
    {
      options: {
        exact: true,
        name: DEFAULT_QUALIFICATION_FIXTURES.pointerHidden.sameOriginLinkName,
      },
      role: "link",
    },
    {
      options: {
        exact: true,
        name: DEFAULT_QUALIFICATION_FIXTURES.crossOrigin.linkName,
      },
      role: "link",
    },
  ]);
});

test("rejects fixtures that are not public HTTPS targets", () => {
  assert.throws(
    () =>
      createQualificationFlows({
        fixtures: {
          ...DEFAULT_QUALIFICATION_FIXTURES,
          crossOrigin: { linkName: "Mozilla", targetUrl: "http://example.com/" },
        },
        runtime: { browser: null },
      }),
    (error) => error.code === "qualification_invalid_configuration",
  );
});

test("rejects a pointer-hidden fixture that reuses one link for both actions", () => {
  assert.throws(
    () =>
      createQualificationFlows({
        fixtures: {
          ...DEFAULT_QUALIFICATION_FIXTURES,
          pointerHidden: {
            hiddenLinkName: "1. Introduction",
            sameOriginLinkName: "1. Introduction",
            targetUrl: "https://www.w3.org/TR/pointerevents/",
          },
        },
        runtime: { browser: null },
      }),
    (error) => error.code === "qualification_invalid_configuration",
  );
});

test("passes when the Browser can be shown and hidden on demand", async () => {
  const visibility = createVisibility({
    observe: () => visibility.requested.at(-1),
  });

  const probe = await probeCodexInAppBrowserVisibility({
    _dependencies: createClock(),
    acquireBrowser: async () => createBrowser(visibility.capability),
  });

  assert.equal(probe.status, "passed");
  assert.equal(probe.capabilityAvailable, true);
  assert.equal(probe.show.settled, true);
  assert.equal(probe.hide.settled, true);
  assert.deepEqual(visibility.requested, [true, false]);
});

test("uses a fresh tab to probe visibility in an empty Browser", async () => {
  const { browser, visibility } = createTabDependentBrowser();

  const probe = await probeCodexInAppBrowserVisibility({
    _dependencies: createClock(),
    acquireBrowser: async () => browser,
  });

  assert.equal(probe.status, "passed");
  assert.equal(probe.show.settled, true);
  assert.equal(probe.hide.settled, true);
  assert.deepEqual(visibility.requested, [true, false]);
  assert.deepEqual(await browser.tabs.list(), []);
});

test("fails when the owned visibility probe tab remains open", async () => {
  const { browser } = createTabDependentBrowser({ closeLeavesTab: true });

  await assert.rejects(
    probeCodexInAppBrowserVisibility({
      _dependencies: createClock(),
      acquireBrowser: async () => browser,
    }),
    (error) => error.code === "qualification_tab_cleanup_failed",
  );
});

test("bounds an owned visibility probe tab close failure", async () => {
  const { browser } = createTabDependentBrowser({ closeRejects: true });

  await assert.rejects(
    probeCodexInAppBrowserVisibility({
      _dependencies: createClock(),
      acquireBrowser: async () => browser,
    }),
    (error) => error.code === "qualification_tab_cleanup_failed",
  );
});

test("separates a missing capability from a capability that never agrees", async () => {
  const missing = await probeCodexInAppBrowserVisibility({
    _dependencies: createClock(),
    acquireBrowser: async () => createBrowser({}),
  });

  assert.equal(missing.capabilityAvailable, false);
  assert.equal(missing.status, "failed");
  assert.equal(missing.show, null);

  const neverVisible = createVisibility({ observe: () => false });
  const stuck = await probeCodexInAppBrowserVisibility({
    _dependencies: createClock(),
    acquireBrowser: async () => createBrowser(neverVisible.capability),
    timeoutMs: 1_000,
  });

  assert.equal(stuck.capabilityAvailable, true);
  assert.equal(stuck.status, "failed");
  assert.equal(stuck.show.settled, false);
  assert.equal(stuck.show.requestRejected, false);
  assert.ok(stuck.show.observations > 1);
  assert.ok(stuck.show.elapsedMs >= 1_000);
  assert.equal(stuck.hide.settled, true);
});

test("records a rejected request separately from a stuck observation", async () => {
  const rejecting = createVisibility({ observe: () => false, setRejects: true });

  const probe = await probeCodexInAppBrowserVisibility({
    _dependencies: createClock(),
    acquireBrowser: async () => createBrowser(rejecting.capability),
    timeoutMs: 500,
  });

  assert.equal(probe.show.requestRejected, true);
  assert.equal(probe.show.settled, false);
  assert.equal(probe.status, "failed");
});

test("reports an unreadable visibility capability", async () => {
  const unreadable = createVisibility({ getRejects: true });

  const probe = await probeCodexInAppBrowserVisibility({
    _dependencies: createClock(),
    acquireBrowser: async () => createBrowser(unreadable.capability),
  });

  assert.equal(probe.show.readRejected, true);
  assert.equal(probe.show.observed, null);
  assert.equal(probe.status, "failed");
});

test("satisfies the release gate and produces every qualification plan", async () => {
  const prepared = [];

  await assert.rejects(
    runCodexInAppBrowserReleaseQualification({
      acquireBrowser: async () => createBrowser(createVisibility().capability),
      approveQualification: async () => false,
      browserPluginVersion: "26.721.41059",
      codexDesktopVersion: "26.721.41059",
      confirmPointerVisualEvidence: async () => true,
      dependencies: {
        async collectEnvironmentEvidence() {
          return environmentEvidence;
        },
        async createTemporaryWorkspace() {
          return "/private/owned-release-workspace";
        },
        async prepareRecording(options) {
          prepared.push(options);
          return { consent: {}, options, status: "prepared" };
        },
      },
    }),
    (error) => error.code === "qualification_not_approved",
  );

  assert.deepEqual(
    prepared.map(({ recordingName }) => recordingName),
    [
      "qualification-pointer-hidden",
      "qualification-sequential",
      "qualification-cross-origin",
      "qualification-cancellation",
    ],
  );
  assert.deepEqual(
    prepared[0].actions.map(({ modality }) => modality),
    ["pointer", "programmatic", "pointer"],
  );
  assert.equal(prepared[1].recordingMode, "unattended");
  assert.notEqual(prepared[0].recordingMode, "unattended");
  assert.equal(
    prepared[0].targetUrl,
    DEFAULT_QUALIFICATION_FIXTURES.pointerHidden.targetUrl,
  );
});

test("rejects an invalid probe configuration before acquiring a Browser", async () => {
  let acquired = false;

  await assert.rejects(
    probeCodexInAppBrowserVisibility({
      acquireBrowser: async () => {
        acquired = true;
        return createBrowser({});
      },
      timeoutMs: 0,
    }),
    (error) => error.code === "qualification_invalid_configuration",
  );
  assert.equal(acquired, false);
});
