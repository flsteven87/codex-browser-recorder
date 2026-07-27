import { runCodexInAppBrowserReleaseGate } from "./codex-in-app-browser-release-gate.mjs";

const VISIBILITY_POLL_INTERVAL_MS = 100;
const VISIBILITY_PROBE_TIMEOUT_MS = 10_000;

export const RUNTIME_UNSUPPORTED_EMBEDDED_FRAME = Object.freeze({
  limitation: "runtime_does_not_expose_embedded_frame_control",
  status: "runtime_unsupported",
});

export const DEFAULT_QUALIFICATION_FIXTURES = Object.freeze({
  crossOrigin: Object.freeze({
    linkName: "Mozilla",
    targetUrl: "https://www.w3.org/TR/pointerevents/",
  }),
  pointerHidden: Object.freeze({
    hiddenLinkName: "2. Conformance",
    sameOriginLinkName: "1. Introduction",
    targetUrl: "https://www.w3.org/TR/pointerevents/",
  }),
  sequential: Object.freeze({
    linkName: "3. Examples",
    targetUrl: "https://www.w3.org/TR/pointerevents/",
  }),
});

function qualificationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function invalidConfiguration(message) {
  return qualificationError("qualification_invalid_configuration", message);
}

function isLinkName(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateFixtures(fixtures) {
  const { crossOrigin, pointerHidden, sequential } = fixtures ?? {};
  if (
    !isHttpsUrl(crossOrigin?.targetUrl) ||
    !isLinkName(crossOrigin?.linkName) ||
    !isHttpsUrl(pointerHidden?.targetUrl) ||
    !isLinkName(pointerHidden?.sameOriginLinkName) ||
    !isLinkName(pointerHidden?.hiddenLinkName) ||
    pointerHidden.sameOriginLinkName === pointerHidden.hiddenLinkName ||
    !isHttpsUrl(sequential?.targetUrl) ||
    !isLinkName(sequential?.linkName)
  ) {
    throw invalidConfiguration("Release qualification fixtures are invalid");
  }
  return fixtures;
}

function clickLink(name) {
  return ({ tab }) =>
    tab.playwright.getByRole("link", { exact: true, name }).click();
}

function action(label, modality, perform) {
  return Object.freeze({ label, modality, perform });
}

async function hideBrowser(runtime) {
  const visibility = await runtime.browser?.capabilities?.get("visibility");
  if (typeof visibility?.set !== "function") {
    throw qualificationError(
      "qualification_visibility_unavailable",
      "The Codex In-app Browser visibility capability is unavailable",
    );
  }
  await visibility.set(false);
}

function waitForPollInterval(clock) {
  return new Promise((resolve) =>
    clock.setTimeout(resolve, VISIBILITY_POLL_INTERVAL_MS),
  );
}

async function settleVisibility(visibility, target, clock, timeoutMs) {
  const startedAt = clock.now();
  let requestRejected = false;
  try {
    await visibility.set(target);
  } catch {
    requestRejected = true;
  }
  let observations = 0;
  let observed = null;
  while (true) {
    observations += 1;
    try {
      observed = await visibility.get();
    } catch {
      return Object.freeze({
        elapsedMs: clock.now() - startedAt,
        observations,
        observed: null,
        readRejected: true,
        requestRejected,
        settled: false,
      });
    }
    if (observed === target) {
      return Object.freeze({
        elapsedMs: clock.now() - startedAt,
        observations,
        observed,
        readRejected: false,
        requestRejected,
        settled: true,
      });
    }
    if (clock.now() - startedAt >= timeoutMs) {
      return Object.freeze({
        elapsedMs: clock.now() - startedAt,
        observations,
        observed,
        readRejected: false,
        requestRejected,
        settled: false,
      });
    }
    await waitForPollInterval(clock);
  }
}

async function closeVisibilityProbeTab(browser, tab) {
  const tabId =
    typeof tab?.id === "string" && tab.id.length > 0 ? tab.id : null;
  try {
    await tab?.close();
    const tabs = await browser?.tabs?.list();
    if (
      tabId === null ||
      !Array.isArray(tabs) ||
      tabs.some(({ id }) => id === tabId)
    ) {
      throw qualificationError(
        "qualification_tab_cleanup_failed",
        "The Codex In-app Browser visibility probe tab remains open",
      );
    }
  } catch (error) {
    if (error?.code === "qualification_tab_cleanup_failed") throw error;
    throw qualificationError(
      "qualification_tab_cleanup_failed",
      "The Codex In-app Browser visibility probe tab could not be closed",
    );
  }
}

export function createQualificationFlows({
  fixtures = DEFAULT_QUALIFICATION_FIXTURES,
  runtime,
} = {}) {
  validateFixtures(fixtures);
  if (runtime === null || typeof runtime !== "object") {
    throw invalidConfiguration("Release qualification runtime is invalid");
  }
  return Object.freeze({
    crossOriginFlow: Object.freeze({
      actions: Object.freeze([
        action(
          "Follow the cross-origin link",
          "pointer",
          clickLink(fixtures.crossOrigin.linkName),
        ),
      ]),
      targetUrl: fixtures.crossOrigin.targetUrl,
    }),
    pointerHiddenFlow: Object.freeze({
      actions: Object.freeze([
        action(
          "Follow the same-origin section link",
          "pointer",
          clickLink(fixtures.pointerHidden.sameOriginLinkName),
        ),
        action("Hide the Codex In-app Browser", "programmatic", () =>
          hideBrowser(runtime),
        ),
        action(
          "Follow a section link while the Browser is hidden",
          "pointer",
          clickLink(fixtures.pointerHidden.hiddenLinkName),
        ),
      ]),
      targetUrl: fixtures.pointerHidden.targetUrl,
    }),
    sequentialFlow: Object.freeze({
      actions: Object.freeze([
        action(
          "Follow the section link",
          "pointer",
          clickLink(fixtures.sequential.linkName),
        ),
      ]),
      targetUrl: fixtures.sequential.targetUrl,
    }),
  });
}

export async function probeCodexInAppBrowserVisibility({
  _dependencies,
  acquireBrowser,
  timeoutMs = VISIBILITY_PROBE_TIMEOUT_MS,
}) {
  if (
    typeof acquireBrowser !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw invalidConfiguration("Visibility probe configuration is invalid");
  }
  const clock = { now: Date.now, setTimeout, ..._dependencies };
  const browser = await acquireBrowser();
  const tab = await browser?.tabs?.new();
  try {
    const visibility = await browser?.capabilities?.get("visibility");
    if (
      typeof visibility?.get !== "function" ||
      typeof visibility?.set !== "function"
    ) {
      return Object.freeze({
        capabilityAvailable: false,
        hide: null,
        show: null,
        status: "failed",
      });
    }
    const show = await settleVisibility(visibility, true, clock, timeoutMs);
    const hide = await settleVisibility(visibility, false, clock, timeoutMs);
    return Object.freeze({
      capabilityAvailable: true,
      hide,
      show,
      status: show.settled && hide.settled ? "passed" : "failed",
    });
  } finally {
    await closeVisibilityProbeTab(browser, tab);
  }
}

export function runCodexInAppBrowserReleaseQualification({
  acquireBrowser,
  approveQualification,
  browserPluginVersion,
  codexDesktopVersion,
  confirmPointerVisualEvidence,
  dependencies,
  embeddedFrame = RUNTIME_UNSUPPORTED_EMBEDDED_FRAME,
  fixtures = DEFAULT_QUALIFICATION_FIXTURES,
}) {
  if (typeof acquireBrowser !== "function") {
    throw invalidConfiguration(
      "Release qualification requires an acquireBrowser callback",
    );
  }
  const runtime = { browser: null };
  const flows = createQualificationFlows({ fixtures, runtime });
  return runCodexInAppBrowserReleaseGate({
    ...flows,
    acquireBrowser: async () => {
      const browser = await acquireBrowser();
      runtime.browser = browser;
      return browser;
    },
    approveQualification,
    browserPluginVersion,
    codexDesktopVersion,
    confirmPointerVisualEvidence,
    dependencies,
    embeddedFrame,
  });
}
