import { runCodexInAppBrowserReleaseGate } from "./codex-in-app-browser-release-gate.mjs";
import { confirmEncodedPointerVisualEvidence } from "./confirm-pointer-visual-evidence.mjs";

const VISIBILITY_POLL_INTERVAL_MS = 100;
const VISIBILITY_PROBE_CLEANUP_TIMEOUT_MS = 5_000;
const VISIBILITY_PROBE_TIMEOUT_MS = 10_000;
const POINTER_VISUAL_SETTLE_MS = 500;

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
    hiddenLinkName: "pointer",
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

async function hideBrowser(runtime, tab) {
  const visibility = await runtime.browser?.capabilities?.get("visibility");
  if (typeof visibility?.set !== "function") {
    throw qualificationError(
      "qualification_visibility_unavailable",
      "The Codex In-app Browser visibility capability is unavailable",
    );
  }
  if (typeof tab?.playwright?.waitForTimeout !== "function") {
    throw qualificationError(
      "qualification_pointer_settle_unavailable",
      "The release qualification cannot settle pointer visual evidence",
    );
  }
  await visibility.set(false);
  await tab.playwright.waitForTimeout(POINTER_VISUAL_SETTLE_MS);
}

function waitForPollInterval(clock) {
  return new Promise((resolve) =>
    clock.setTimeout(resolve, VISIBILITY_POLL_INTERVAL_MS),
  );
}

function settleWithin(operation, timeoutMs, clock) {
  const operationPromise = Promise.resolve().then(operation);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (settlement) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      resolve(settlement);
    };
    timer = clock.setTimeout(
      () => finish({ status: "timed_out" }),
      timeoutMs,
    );
    operationPromise.then(
      () => finish({ status: "fulfilled" }),
      () => finish({ status: "rejected" }),
    );
  });
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

async function closeVisibilityProbeTab(
  browser,
  tab,
  { cleanupTimeoutMs, clock },
) {
  const tabId =
    typeof tab?.id === "string" && tab.id.length > 0 ? tab.id : null;
  let requiresClose = true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const settlement = await settleWithin(
      async () => {
        if (requiresClose) {
          await tab?.close();
          requiresClose = false;
        }
        const tabs = await browser?.tabs?.list();
        if (
          tabId === null ||
          !Array.isArray(tabs) ||
          tabs.some((candidate) => candidate?.id === tabId)
        ) {
          requiresClose = true;
          throw new Error("Owned visibility probe tab remains open");
        }
      },
      cleanupTimeoutMs,
      clock,
    );
    if (settlement.status === "fulfilled") return;
    if (settlement.status === "timed_out") {
      throw qualificationError(
        "qualification_tab_cleanup_failed",
        "The Codex In-app Browser visibility probe timed out while closing its fresh tab",
      );
    }
  }
  throw qualificationError(
    "qualification_tab_cleanup_failed",
    "The Codex In-app Browser visibility probe tab could not be closed",
  );
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
        action("Hide the Codex In-app Browser", "programmatic", ({ tab }) =>
          hideBrowser(runtime, tab),
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
  cleanupTimeoutMs = VISIBILITY_PROBE_CLEANUP_TIMEOUT_MS,
  timeoutMs = VISIBILITY_PROBE_TIMEOUT_MS,
}) {
  if (
    typeof acquireBrowser !== "function" ||
    !Number.isInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw invalidConfiguration("Visibility probe configuration is invalid");
  }
  const clock = { clearTimeout, now: Date.now, setTimeout, ..._dependencies };
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
    await closeVisibilityProbeTab(browser, tab, {
      cleanupTimeoutMs,
      clock,
    });
  }
}

export function runCodexInAppBrowserReleaseQualification({
  acquireBrowser,
  approveQualification,
  browserPluginVersion,
  codexDesktopVersion,
  confirmPointerVisualEvidence = confirmEncodedPointerVisualEvidence,
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
